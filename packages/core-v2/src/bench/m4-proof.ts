/** Minimal real-trace proof gate for the M4 context lifecycle. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { TraceArtifactSchema, type TraceArtifact } from "../contracts/trace.ts";
import {
	contextEvaluationRecord,
	type ContextEvaluationRecord,
} from "./context-evaluation.ts";

export const M4ProofEvidenceSchema = z
	.object({
		version: z.literal(1),
		trials: z
			.array(
				z
					.object({
						caseId: z.string().min(1).max(128),
						modelId: z.string().min(1).max(256),
						variant: z.enum(["raw", "managed"]),
						tracePath: z.string().min(1).max(4096),
					})
					.strict(),
			)
			.min(2)
			.max(64),
	})
	.strict();
export type M4ProofEvidence = z.infer<typeof M4ProofEvidenceSchema>;

export interface M4ProofTrial {
	caseId: string;
	modelId: string;
	variant: "raw" | "managed";
	trace: TraceArtifact;
	record: ContextEvaluationRecord;
}

export interface M4ProofResult {
	trials: M4ProofTrial[];
	pairs: number;
}

function assignedModel(trace: TraceArtifact): string | undefined {
	const value = trace.events.find((event) => event.type === "model.assigned")
		?.detail?.modelId;
	return typeof value === "string" ? value : undefined;
}

function validateRealTrial(trial: M4ProofTrial): void {
	if (trial.trace.usage?.status !== "measured")
		throw new Error(
			`${trial.caseId}/${trial.variant}: measured usage is required`,
		);
	if (!trial.trace.events.some((event) => event.type === "session.spawned"))
		throw new Error(
			`${trial.caseId}/${trial.variant}: session spawn evidence is required`,
		);
	if (!trial.trace.events.some((event) => event.type === "turn.started"))
		throw new Error(
			`${trial.caseId}/${trial.variant}: observed turn evidence is required`,
		);
	if (assignedModel(trial.trace) !== trial.modelId)
		throw new Error(
			`${trial.caseId}/${trial.variant}: assigned model does not match evidence`,
		);
	if (trial.variant === "raw" && trial.record.providerId !== "raw")
		throw new Error(`${trial.caseId}/raw: trace is not the raw baseline`);
	if (
		trial.variant === "managed" &&
		(trial.record.providerId === "raw" || trial.record.providerId === "unknown")
	)
		throw new Error(`${trial.caseId}/managed: trace has no managed provider`);
}

export function validateM4Proof(
	evidence: M4ProofEvidence,
	loadTrace: (path: string) => unknown,
): M4ProofResult {
	const checked = M4ProofEvidenceSchema.parse(evidence);
	const seen = new Set<string>();
	const trials = checked.trials.map((entry): M4ProofTrial => {
		const key = `${entry.caseId}\0${entry.modelId}\0${entry.variant}`;
		if (seen.has(key)) throw new Error(`duplicate M4 proof trial: ${key}`);
		seen.add(key);
		const trace = TraceArtifactSchema.parse(loadTrace(entry.tracePath));
		const trial = {
			...entry,
			trace,
			record: contextEvaluationRecord(trace),
		};
		validateRealTrial(trial);
		return trial;
	});
	const groups = new Map<string, Set<string>>();
	for (const trial of trials) {
		const key = `${trial.caseId}\0${trial.modelId}`;
		groups.set(key, new Set([...(groups.get(key) ?? []), trial.variant]));
	}
	for (const [key, variants] of groups) {
		if (!variants.has("raw") || !variants.has("managed"))
			throw new Error(`unmatched M4 proof group: ${key}`);
	}
	return { trials, pairs: groups.size };
}

export function renderM4Proof(result: M4ProofResult): string {
	const lines = [
		"# M4 matched context proof",
		"",
		"This report records matched execution evidence; it does not infer an advantage.",
		"",
		"| case | model | variant | provider | accepted | turns | context tokens | cache-read tokens | cost | epochs | trace |",
		"|---|---|---|---|---:|---:|---:|---:|---:|---:|---|",
	];
	for (const trial of [...result.trials].sort((a, b) =>
		`${a.caseId}\0${a.variant}`.localeCompare(`${b.caseId}\0${b.variant}`),
	)) {
		const row = trial.record;
		lines.push(
			`| ${trial.caseId} | ${trial.modelId} | ${trial.variant} | ${row.providerId} | ${row.accepted ? "yes" : "no"} | ${row.turns} | ${row.contextTokens ?? "unavailable"} | ${row.providerCacheReadTokens ?? "unavailable"} | ${row.costUsd ?? "unavailable"} | ${row.epochs} | ${row.sourceTraceId} |`,
		);
	}
	return `${lines.join("\n")}\n`;
}

function loadEvidence(path: string): M4ProofResult {
	const evidencePath = resolve(path);
	const evidence = M4ProofEvidenceSchema.parse(
		JSON.parse(readFileSync(evidencePath, "utf8")),
	);
	const evidenceDir = dirname(evidencePath);
	return validateM4Proof(evidence, (tracePath) =>
		JSON.parse(readFileSync(resolve(evidenceDir, tracePath), "utf8")),
	);
}

function main(argv: readonly string[]): void {
	const evidencePath = argv[0];
	if (evidencePath === undefined)
		throw new Error("usage: mise run m4-proof -- <evidence.json> [report.md]");
	const report = renderM4Proof(loadEvidence(evidencePath));
	const outputPath = argv[1];
	if (outputPath === undefined) process.stdout.write(report);
	else writeFileSync(resolve(outputPath), report, "utf8");
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
