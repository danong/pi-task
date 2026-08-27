/** Durable, bounded working checkpoints for context-pressure recovery. */
import { createHash } from "node:crypto";
import {
	ContextPlanSchema,
	ImmutableArtifactReferenceSchema,
	WorkingCheckpointSchema,
	type ContextPlan,
	type ImmutableArtifactReference,
	type WorkingCheckpoint,
} from "../contracts/context-lifecycle.ts";
import { stableStringify } from "../contracts/serialize.ts";
import type { ContextArtifactStore } from "./artifact-store.ts";

export interface CheckpointRequirement {
	id: string;
	status: "unknown" | "open" | "satisfied" | "blocked";
	evidenceIds?: readonly string[];
}
export interface CheckpointSummary {
	decisions?: readonly string[];
	openQuestions?: readonly string[];
	nextActions?: readonly string[];
}
export interface WorkingCheckpointInput {
	epochId: string;
	workspaceRevision: string;
	plan: ImmutableArtifactReference;
	evidence?: readonly ImmutableArtifactReference[];
	requirements?: readonly CheckpointRequirement[];
	summary?: CheckpointSummary;
	verification?: {
		status: "not-run" | "passed" | "failed" | "unknown";
		evidenceIds?: readonly string[];
	};
	artifactIds?: readonly string[];
}
function declarative(values: readonly string[] | undefined): string[] {
	return (values ?? [])
		.map((value) => value.trim())
		.filter(Boolean)
		.slice(0, 16)
		.map((value) => value.slice(0, 512));
}
function idFor(value: unknown): string {
	return `checkpoint-${createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24)}`;
}

export function createWorkingCheckpoint(
	input: WorkingCheckpointInput,
): WorkingCheckpoint {
	const plan = validateReference(input.plan, "plan");
	const evidence = [...(input.evidence ?? [])]
		.slice(0, 64)
		.map((ref) => validateReference(ref, "evidence"));
	const requirements = (input.requirements ?? []).slice(0, 128).map((item) => ({
		id: item.id,
		status: item.status,
		evidenceIds: [...(item.evidenceIds ?? [])].slice(0, 64),
	}));
	const summary = {
		decisions: declarative(input.summary?.decisions),
		openQuestions: declarative(input.summary?.openQuestions),
		nextActions: declarative(input.summary?.nextActions),
	};
	const verification = input.verification ?? {
		status: "not-run" as const,
		evidenceIds: [],
	};
	const body = {
		version: 1 as const,
		epochId: input.epochId,
		workspaceRevision: input.workspaceRevision,
		plan,
		evidence,
		requirements,
		summary,
		verification: {
			status: verification.status,
			evidenceIds: [...(verification.evidenceIds ?? [])].slice(0, 64),
		},
		artifactIds: [...(input.artifactIds ?? [])].slice(0, 64),
	};
	return WorkingCheckpointSchema.parse({ ...body, id: idFor(body) });
}
function validateReference(
	ref: ImmutableArtifactReference,
	expectedKind: "plan" | "evidence",
): ImmutableArtifactReference {
	const parsed = ImmutableArtifactReferenceSchema.parse(ref);
	if (expectedKind === "plan" && parsed.kind !== "plan")
		throw new Error("checkpoint plan must reference a plan artifact");
	return parsed;
}
export function persistWorkingCheckpoint(
	store: ContextArtifactStore,
	checkpoint: WorkingCheckpoint,
): ImmutableArtifactReference {
	const checked = WorkingCheckpointSchema.parse(checkpoint);
	return store.putJson(checked, {
		namespace: "checkpoint",
		kind: "checkpoint",
		mediaType: "application/json",
		sensitivity: "internal",
		sourceRevision: checked.workspaceRevision,
	});
}
export function loadWorkingCheckpoint(
	store: ContextArtifactStore,
	reference: ImmutableArtifactReference,
): WorkingCheckpoint | undefined {
	const bytes = store.get(reference);
	if (bytes === undefined) return undefined;
	return WorkingCheckpointSchema.parse(JSON.parse(bytes.toString("utf8")));
}
export function checkpointForPlan(
	plan: ContextPlan,
	planReference: ImmutableArtifactReference,
	input: Omit<WorkingCheckpointInput, "plan">,
): WorkingCheckpoint {
	ContextPlanSchema.parse(plan);
	return createWorkingCheckpoint({ ...input, plan: planReference });
}
