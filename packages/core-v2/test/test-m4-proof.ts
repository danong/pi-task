/** Hermetic M4 matched-proof validation; zero model/network calls. */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { TraceCollector } from "../src/contracts/trace.ts";
import {
	M4ProofEvidenceSchema,
	renderM4Proof,
	validateM4Proof,
	type M4ProofEvidence,
} from "../src/bench/m4-proof.ts";

function trace(id: string, provider: "raw" | "symbol-tree", measured = true) {
	let tick = 0;
	const collector = new TraceCollector(id, id, () =>
		new Date(tick++ * 1000).toISOString(),
	);
	collector.record({
		type: "model.assigned",
		phase: "model",
		taskId: id,
		detail: { modelId: "cheap/model" },
	});
	collector.record({ type: "session.spawned", phase: "session", taskId: id });
	collector.record({ type: "turn.started", phase: "turn", taskId: id });
	collector.record({
		type: "context.selected",
		phase: "context",
		taskId: id,
		provider,
		config: "1",
		detail: {
			selectedCount: provider === "raw" ? 0 : 1,
			estimatedTokens: provider === "raw" ? 0 : 20,
		},
	});
	collector.record({
		type: "context.injected",
		phase: "context",
		taskId: id,
		provider,
		config: "1",
		detail: { estimatedTokens: provider === "raw" ? 0 : 20 },
	});
	collector.record({
		type: "epoch.started",
		phase: "recovery",
		taskId: id,
		detail: { epochId: `epoch:${id}` },
	});
	collector.setUsage({
		status: measured ? "measured" : "unavailable",
		costUsd: measured ? 0.001 : 0,
		inputTokens: measured ? 100 : 0,
		outputTokens: measured ? 10 : 0,
		cacheReadTokens: measured ? 50 : 0,
		cacheWriteTokens: 0,
	});
	return collector.finish("ship");
}

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (value: boolean, message: string): void => {
		if (!value) errors.push(message);
	};
	const traces = new Map<string, unknown>([
		["raw.json", trace("raw-run", "raw")],
		["managed.json", trace("managed-run", "symbol-tree")],
	]);
	const evidence: M4ProofEvidence = {
		version: 1,
		trials: [
			{
				caseId: "case",
				modelId: "cheap/model",
				variant: "raw",
				tracePath: "raw.json",
			},
			{
				caseId: "case",
				modelId: "cheap/model",
				variant: "managed",
				tracePath: "managed.json",
			},
		],
	};
	const result = validateM4Proof(evidence, (path) => traces.get(path));
	const report = renderM4Proof(result);
	check(result.pairs === 1, "matched raw/managed trials form one proof pair");
	check(
		report.includes("cache-read tokens") &&
			report.includes("raw-run") &&
			report.includes("managed-run"),
		"report preserves measured cache activity and source trace identities",
	);
	check(
		!/winner|wins|improv/i.test(report),
		"proof report does not infer an advantage",
	);
	let unmatchedRejected = false;
	try {
		validateM4Proof(
			{
				version: 1,
				trials: [
					evidence.trials[0]!,
					{ ...evidence.trials[0]!, caseId: "other" },
				],
			},
			(path) => traces.get(path),
		);
	} catch {
		unmatchedRejected = true;
	}
	check(unmatchedRejected, "unmatched variants are rejected");
	let dryRejected = false;
	try {
		validateM4Proof(
			{
				...evidence,
				trials: evidence.trials.map((trial) => ({
					...trial,
					tracePath: `${trial.variant}-dry.json`,
				})),
			},
			(path) =>
				path.startsWith("raw")
					? trace("raw-dry", "raw", false)
					: trace("managed-dry", "symbol-tree", false),
		);
	} catch {
		dryRejected = true;
	}
	check(
		dryRejected,
		"unmeasured dry-only evidence is rejected by the real-proof gate",
	);
	const fixtureRoot = new URL("./fixtures/m4-proof/", import.meta.url);
	const measuredEvidence = M4ProofEvidenceSchema.parse(
		JSON.parse(readFileSync(new URL("evidence.json", fixtureRoot), "utf8")),
	);
	const measured = validateM4Proof(measuredEvidence, (tracePath) =>
		JSON.parse(readFileSync(new URL(tracePath, fixtureRoot), "utf8")),
	);
	check(
		measured.pairs > 0 &&
			measured.trials.every((trial) => trial.record.costStatus === "measured"),
		"committed cheap smoke evidence remains schema-valid and measured",
	);
	if (errors.length > 0)
		throw new Error(`test-m4-proof failed:\n  ✗ ${errors.join("\n  ✗ ")}`);
	console.log("✓ m4-proof: matched measured evidence gate and neutral report");
	return Promise.resolve();
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
