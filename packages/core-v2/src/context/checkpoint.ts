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
export const MAX_WORKING_CHECKPOINT_BYTES = 64 * 1024;

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
function assertSafeIdentity(value: string, label: string): void {
	if (
		value.length === 0 ||
		/[\\/\u0000-\u001f]/.test(value) ||
		/^(?:[A-Za-z]:|\\\\|refs(?:\/|$))/i.test(value)
	)
		throw new Error(`${label} must be a provider-neutral identity`);
}

function assertSafeDeclarative(value: string): void {
	// This is a lexical defence-in-depth check. The kernel is the trusted
	// producer of summaries; free-form session output is never an input here.
	if (
		/(?:private\s+reasoning|chain[- ]of[- ]thought|transcript|stdout|stderr|command\s+output|hostpath|host\s+path)/i.test(
			value,
		) ||
		/(?:^|\s)(?:[A-Za-z]:[\\/]|\\\\|\/tmp\/|\/home\/|\/Users\/)/.test(value) ||
		/(?:refs\/heads|refs\/tags)\//i.test(value)
	)
		throw new Error("checkpoint summary contains prohibited session or host data");
}

function declarative(values: readonly string[] | undefined): string[] {
	return (values ?? [])
		.map((value) => {
			const trimmed = value.trim();
			assertSafeDeclarative(trimmed);
			return trimmed;
		})
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
	const requirements = (input.requirements ?? []).slice(0, 128).map((item) => {
		assertSafeIdentity(item.id, "checkpoint requirement id");
		return {
			id: item.id,
			status: item.status,
			evidenceIds: [...(item.evidenceIds ?? [])].slice(0, 64),
		};
	});
	const summary = {
		decisions: declarative(input.summary?.decisions),
		openQuestions: declarative(input.summary?.openQuestions),
		nextActions: declarative(input.summary?.nextActions),
	};
	const verification = input.verification ?? {
		status: "not-run" as const,
		evidenceIds: [],
	};
	assertSafeIdentity(input.epochId, "checkpoint epochId");
	assertSafeIdentity(input.workspaceRevision, "checkpoint workspaceRevision");
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
	assertSafeIdentity(parsed.sourceRevision, `${expectedKind} sourceRevision`);
	return parsed;
}
export function persistWorkingCheckpoint(
	store: ContextArtifactStore,
	checkpoint: WorkingCheckpoint,
): ImmutableArtifactReference {
	const checked = validatePersistableCheckpoint(checkpoint);
	const encoded = Buffer.from(`${stableStringify(checked)}\n`, "utf8");
	if (encoded.byteLength > MAX_WORKING_CHECKPOINT_BYTES)
		throw new RangeError(
			`working checkpoint exceeds ${MAX_WORKING_CHECKPOINT_BYTES} byte limit`,
		);
	const reference = store.putJson(checked, {
		namespace: "checkpoint",
		kind: "checkpoint",
		mediaType: "application/json",
		sensitivity: "internal",
		sourceRevision: checked.workspaceRevision,
	});
	// The event/caller may claim a checkpoint only after the immutable bytes
	// can be read back and validate as the exact checkpoint we accepted.
	const persisted = store.read(reference);
	if (persisted.status !== "present")
		throw new Error(`checkpoint storage did not succeed: ${persisted.status}`);
	const roundTrip = WorkingCheckpointSchema.parse(
		JSON.parse(persisted.bytes.toString("utf8")),
	);
	if (stableStringify(roundTrip) !== stableStringify(checked))
		throw new Error("checkpoint storage returned different content");
	return Object.freeze({ ...reference });
}
function validatePersistableCheckpoint(
	checkpoint: WorkingCheckpoint,
): WorkingCheckpoint {
	const checked = WorkingCheckpointSchema.parse(checkpoint);
	const { id: checkpointId, ...checkpointBody } = checked;
	if (checkpointId !== idFor(checkpointBody))
		throw new Error("working checkpoint id does not match its content");
	return checked;
}

export function loadWorkingCheckpoint(
	store: ContextArtifactStore,
	reference: ImmutableArtifactReference,
): WorkingCheckpoint | undefined {
	const checkedReference = ImmutableArtifactReferenceSchema.parse(reference);
	if (checkedReference.kind !== "checkpoint" || checkedReference.namespace !== "checkpoint")
		throw new Error("checkpoint reference must point to checkpoint storage");
	const bytes = store.get(checkedReference);
	if (bytes === undefined) return undefined;
	const checkpoint = validatePersistableCheckpoint(
		JSON.parse(bytes.toString("utf8")),
	);
	if (checkpoint.workspaceRevision !== checkedReference.sourceRevision)
		throw new Error("checkpoint reference revision does not match its content");
	return checkpoint;
}
export function checkpointForPlan(
	plan: ContextPlan,
	planReference: ImmutableArtifactReference,
	input: Omit<WorkingCheckpointInput, "plan">,
): WorkingCheckpoint {
	ContextPlanSchema.parse(plan);
	return createWorkingCheckpoint({ ...input, plan: planReference });
}
