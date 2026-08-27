/** Deterministic, budget-enforcing prompt assembly from a kernel ContextPlan. */
import { createHash } from "node:crypto";

import {
	ContextPlanSchema,
	PromptAssemblySchema,
	PromptSegmentSchema,
	type ContextPlan,
	type PromptAssembly,
	type PromptSegment,
	type WorkingCheckpoint,
} from "../contracts/context-lifecycle.ts";
import { stableStringify } from "../contracts/serialize.ts";

export interface ContextAssemblyInput {
	plan: ContextPlan;
	checkpoint?: WorkingCheckpoint;
}

function hash(value: unknown): string {
	return `seg-${createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24)}`;
}

function boundedText(value: string, max: number): string {
	return value.trim().slice(0, max);
}

function estimateTokens(value: string): number {
	return value.length === 0
		? 0
		: Math.ceil(Buffer.byteLength(value, "utf8") / 4);
}

function segment(
	kind: PromptSegment["kind"],
	stable: boolean,
	value: string,
	itemIds: string[],
	artifactIds: string[],
): PromptSegment {
	const text = boundedText(value, 4_000);
	return PromptSegmentSchema.parse({
		version: 1,
		id: hash({ kind, stable, text, itemIds, artifactIds }),
		kind,
		stable,
		text,
		itemIds,
		artifactIds,
	});
}

function itemLine(item: ContextPlan["selected"][number]): string {
	return `- ${item.id} ${item.kind} ${item.sourcePath ?? item.label} [${item.provenance.source}; ${item.freshness.state}; ${item.sensitivity}; ${item.requirementIds.join(",") || "unlinked"}]${item.artifact === undefined ? "" : ` artifact=${item.artifact.id}`}`;
}

function checkpointSegment(checkpoint: WorkingCheckpoint): PromptSegment {
	const summary = checkpoint.summary;
	const text = [
		"## Working checkpoint",
		...summary.decisions.map((value) => `decision: ${boundedText(value, 512)}`),
		...summary.openQuestions.map((value) => `open: ${boundedText(value, 512)}`),
		...summary.nextActions.map((value) => `next: ${boundedText(value, 512)}`),
		`workspace revision: ${checkpoint.workspaceRevision}`,
	].join("\n");
	return segment(
		"checkpoint",
		false,
		text,
		[],
		[checkpoint.plan.id, ...checkpoint.evidence.map((ref) => ref.id)],
	);
}

export function assembleContext(input: ContextAssemblyInput): PromptAssembly {
	const plan = ContextPlanSchema.parse(input.plan);
	const tokenLimit = Math.max(
		0,
		plan.budgets.window.maxTokens - plan.budgets.window.reserveTokens,
	);
	const omitted = new Set(plan.omissions.map((entry) => entry.candidateId));
	const checkpointCandidate =
		input.checkpoint === undefined
			? undefined
			: checkpointSegment(input.checkpoint);
	const checkpointCandidateTokens =
		checkpointCandidate === undefined
			? 0
			: estimateTokens(checkpointCandidate.text);
	const checkpoint =
		checkpointCandidate !== undefined && checkpointCandidateTokens <= tokenLimit
			? checkpointCandidate
			: undefined;
	const checkpointTokens =
		checkpoint === undefined ? 0 : checkpointCandidateTokens;
	let remainingTokens = Math.max(0, tokenLimit - checkpointTokens);
	let evidenceCharacters = "## Progressive context handles".length;
	const selectedLines: string[] = [];
	const selectedIds: string[] = [];
	const artifactIds: string[] = [];

	for (const item of plan.selected) {
		const line = itemLine(item);
		const lineTokens = estimateTokens(
			selectedLines.length === 0
				? `## Progressive context handles\n${line}`
				: `\n${line}`,
		);
		if (
			lineTokens > remainingTokens ||
			evidenceCharacters + 1 + line.length > 4_000
		) {
			omitted.add(item.id);
			continue;
		}
		selectedLines.push(line);
		evidenceCharacters += 1 + line.length;
		selectedIds.push(item.id);
		if (item.artifact !== undefined) artifactIds.push(item.artifact.id);
		remainingTokens -= lineTokens;
	}

	const segments: PromptSegment[] = [];
	if (selectedLines.length > 0) {
		segments.push(
			segment(
				"evidence",
				true,
				["## Progressive context handles", ...selectedLines].join("\n"),
				selectedIds,
				artifactIds,
			),
		);
	}
	if (checkpoint !== undefined) {
		segments.push(checkpoint);
	}

	const prompt = segments.map((entry) => entry.text).join("\n\n");
	const actualTokens = estimateTokens(prompt);
	const identity = `assembly-${createHash("sha256")
		.update(
			stableStringify({
				plan: plan.id,
				segments,
				omitted: [...omitted].sort(),
			}),
		)
		.digest("hex")
		.slice(0, 24)}`;
	return PromptAssemblySchema.parse({
		version: 1,
		identity,
		planId: plan.id,
		segments,
		prompt,
		tokens: actualTokens,
		omittedItemIds: [...omitted].sort(),
		cache: plan.cache,
	});
}

export const assembleContextPlan = assembleContext;

export function renderContextAssembly(assembly: PromptAssembly): string {
	return PromptAssemblySchema.parse(assembly).prompt;
}
