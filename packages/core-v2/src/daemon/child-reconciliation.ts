/** Boot-time validity checks for claimed sequential child edges.
 *
 * This module is deliberately provider-neutral: the kernel only asks the
 * declared continuation capability to validate its opaque target. It never
 * interprets a provider token or its workspace/VCS representation.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
	ChildHandoffSchema,
	buildChildHandoff,
} from "../contracts/payloads.ts";
import {
	ContextPlanSchema,
	ImmutableArtifactReferenceSchema,
	WorkingCheckpointSchema,
	type ImmutableArtifactReference,
} from "../contracts/context-lifecycle.ts";
import { TaskReceiptSchema } from "../contracts/payloads.ts";
import type { WorkspaceDriver } from "../contracts/workspace-driver.ts";
import { workspaceContinuationOf, isWorkspaceContinuationError } from "../contracts/workspace-driver.ts";
import { ContextArtifactStore } from "../context/artifact-store.ts";
import type { LedgerStore, TaskEdgeRow, SequentialEdgeConfig } from "../ledger/store.ts";
import { stableStringify } from "../contracts/serialize.ts";
import { parseTaskSpec } from "./task-runner.ts";

export type ChildBootEvidenceCode =
	| "missing"
	| "corrupt"
	| "stale"
	| "revision_mismatch"
	| "incompatible";

export interface ChildBootEvidence {
	edgeId: string;
	code: ChildBootEvidenceCode;
	/** Stable dependency class, not an exception/provider message. */
	dependency:
		| "handoff"
		| "checkpoint"
		| "plan"
		| "ingress-manifest"
		| "child-spec"
		| "parent-receipt"
		| "continuation-ownership"
		| "provider-capability"
		| "provider-target"
		| "validator";
}

export type ChildBootValidation =
	| { valid: true }
	| { valid: false; evidence: ChildBootEvidence };

export interface ChildBootValidationOptions {
	artifactStore?: ContextArtifactStore;
	workspaceDriver?: WorkspaceDriver;
	model?: string;
}

const ChildSpecRecordSchema = z.object({
	version: z.literal(1),
	kind: z.literal("sequential-child-spec"),
	markdown: z.string().min(1),
}).strict();

function sameReference(left: ImmutableArtifactReference, right: ImmutableArtifactReference): boolean {
	return stableStringify(left) === stableStringify(right);
}
function digest(value: string): string {
	// The source revision carried by a handoff is the content identity of the
	// provider revision. Avoid importing provider/VCS code for this invariant.
	// This is intentionally the same encoding used by sequential.ts.
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function failure(edgeId: string, code: ChildBootEvidenceCode, dependency: ChildBootEvidence["dependency"]): ChildBootValidation {
	return { valid: false, evidence: { edgeId, code, dependency } };
}

/** Validate all immutable bytes and provider compatibility before boot can
 * mark a claimed edge resumable. Providers may also expose a read-only target
 * probe; every failure is reduced to stable typed evidence.
 */
export async function validateChildEdgeOnBoot(
	ledger: LedgerStore,
	edge: TaskEdgeRow,
	options: ChildBootValidationOptions,
): Promise<ChildBootValidation> {
	if (edge.childTaskId === null || edge.checkpointArtifactId === null)
		return failure(edge.edgeId, "missing", "ingress-manifest");
	if (ledger.getTask(edge.parentTaskId) === null || ledger.getTask(edge.childTaskId) === null)
		return failure(edge.edgeId, "missing", "ingress-manifest");
	if (edge.workspaceContinuationId === null)
		return failure(edge.edgeId, "missing", "continuation-ownership");
	if (options.artifactStore === undefined || options.model === undefined || options.workspaceDriver === undefined)
		return failure(edge.edgeId, "incompatible", "validator");

	let config: SequentialEdgeConfig | null;
	try { config = ledger.getSequentialEdgeConfig(edge.edgeId); }
	catch { return failure(edge.edgeId, "corrupt", "ingress-manifest"); }
	if (config === null) return failure(edge.edgeId, "missing", "ingress-manifest");
	if (config.edgeId !== edge.edgeId || config.modelIdentity !== options.model)
		return failure(edge.edgeId, "incompatible", "ingress-manifest");

	const references: Array<[ChildBootEvidence["dependency"], string, ImmutableArtifactReference]> = [
		["handoff", "handoff", config.handoffReference], ["checkpoint", "checkpoint", config.checkpointReference],
		["child-spec", "child-spec", config.childSpecReference], ["plan", "plan", config.planReference],
		["ingress-manifest", "ingress-config", config.ingressConfigReference], ["parent-receipt", "parent-receipt", config.parentReceiptReference],
	];
	if (new Set(references.map(([, , ref]) => ref.id)).size !== references.length)
		return failure(edge.edgeId, "incompatible", "ingress-manifest");
	if (references.some(([, , ref]) => ref.sourceRevision !== config!.sourceRevision))
		return failure(edge.edgeId, "revision_mismatch", "ingress-manifest");
	if (config.handoffReference.id !== edge.handoffArtifactId || config.checkpointReference.id !== edge.checkpointArtifactId)
		return failure(edge.edgeId, "incompatible", "ingress-manifest");

	const bytes = new Map<ChildBootEvidence["dependency"], Buffer>();
	for (const [dependency, , reference] of references) {
		try { ImmutableArtifactReferenceSchema.parse(reference); }
		catch { return failure(edge.edgeId, "corrupt", dependency); }
		// The sequential config is the authoritative immutable ingress manifest.
		// Task-artifact rows are an index and may lag after an interrupted manifest
		// refresh; consulting them here would reject valid bytes that the next
		// resume is explicitly meant to claim. The content-addressed read below
		// is the validity check and cannot consume or alter the continuation.
		const read = options.artifactStore.read(reference);
		if (read.status === "absent" || read.status === "invalidated") return failure(edge.edgeId, "missing", dependency);
		if (read.status === "corrupt") return failure(edge.edgeId, "corrupt", dependency);
		bytes.set(dependency, read.bytes);
	}

	const json = (dependency: ChildBootEvidence["dependency"]): unknown => {
		try { return JSON.parse(bytes.get(dependency)!.toString("utf8")); }
		catch { throw failure(edge.edgeId, "corrupt", dependency); }
	};
	let handoff: z.infer<typeof ChildHandoffSchema>;
	let checkpoint: z.infer<typeof WorkingCheckpointSchema>;
	let plan: z.infer<typeof ContextPlanSchema>;
	let childSpec: z.infer<typeof ChildSpecRecordSchema>;
	let parentReceipt: z.infer<typeof TaskReceiptSchema>;
	let ingress: {
		version: 1; parentTaskId: string; childTaskId: string; modelIdentity: string;
		sourceRevision: string; capabilityIdentity: string; capabilityVersion: string;
		handoffReference: ImmutableArtifactReference; checkpointReference: ImmutableArtifactReference;
		childSpecReference: ImmutableArtifactReference; planReference: ImmutableArtifactReference;
	};
	try {
		handoff = buildChildHandoff(ChildHandoffSchema.parse(json("handoff")));
		checkpoint = WorkingCheckpointSchema.parse(json("checkpoint"));
		plan = ContextPlanSchema.parse(json("plan"));
		childSpec = ChildSpecRecordSchema.parse(json("child-spec"));
		parentReceipt = TaskReceiptSchema.parse(json("parent-receipt"));
		ingress = z.object({
			version: z.literal(1), parentTaskId: z.string().min(1), childTaskId: z.string().min(1),
			modelIdentity: z.string().min(1), sourceRevision: z.string().min(1),
			capabilityIdentity: z.string().min(1), capabilityVersion: z.string().min(1),
			handoffReference: ImmutableArtifactReferenceSchema, checkpointReference: ImmutableArtifactReferenceSchema,
			childSpecReference: ImmutableArtifactReferenceSchema, planReference: ImmutableArtifactReferenceSchema,
		}).strict().parse(json("ingress-manifest"));
		parseTaskSpec(childSpec.markdown);
	} catch (error) {
		if (typeof error === "object" && error !== null && "valid" in error) return error as ChildBootValidation;
		return failure(edge.edgeId, "corrupt", "ingress-manifest");
	}

	const child = ledger.getTask(edge.childTaskId);
	if (child === null || child.goal !== parseTaskSpec(childSpec.markdown).goal)
		return failure(edge.edgeId, "incompatible", "child-spec");
	if (parentReceipt.taskId !== edge.parentTaskId || parentReceipt.verdict !== "ship")
		return failure(edge.edgeId, "incompatible", "parent-receipt");
	if (ingress.parentTaskId !== edge.parentTaskId || ingress.childTaskId !== edge.childTaskId ||
		ingress.modelIdentity !== config.modelIdentity || ingress.sourceRevision !== config.sourceRevision ||
		ingress.capabilityIdentity !== config.capabilityIdentity || ingress.capabilityVersion !== config.capabilityVersion ||
		!sameReference(ingress.handoffReference, config.handoffReference) ||
		!sameReference(ingress.checkpointReference, config.checkpointReference) ||
		!sameReference(ingress.childSpecReference, config.childSpecReference) ||
		!sameReference(ingress.planReference, config.planReference))
		return failure(edge.edgeId, "incompatible", "ingress-manifest");
	if (plan.sourceRevision !== checkpoint.workspaceRevision || plan.cache.modelId !== options.model ||
		checkpoint.plan.id !== config.planReference.id || checkpoint.plan.sourceRevision !== plan.sourceRevision ||
		config.sourceRevision !== checkpoint.workspaceRevision || handoff.parentTaskId !== edge.parentTaskId ||
		handoff.childTaskId !== edge.childTaskId || handoff.checkpointId !== config.checkpointReference.id ||
		handoff.planId !== config.planReference.id || handoff.sourceRevision !== digest(checkpoint.workspaceRevision))
		return failure(edge.edgeId, "revision_mismatch", "checkpoint");

	const owner = ledger.getChildPreparationOwnershipByEdge(edge.edgeId);
	let ownerReceiptMatches = true;
	if (owner?.parentReceiptJson !== null && owner?.parentReceiptJson !== undefined) {
		try { ownerReceiptMatches = stableStringify(JSON.parse(owner.parentReceiptJson)) === stableStringify(parentReceipt); }
		catch { ownerReceiptMatches = false; }
	}
	if (owner === null || owner.status !== "ready" || owner.parentRevision === null || owner.parentRevision.length === 0 || owner.parentTaskId !== edge.parentTaskId || owner.plannedChildTaskId !== edge.childTaskId ||
		owner.capabilityIdentity !== config.capabilityIdentity || owner.capabilityVersion !== config.capabilityVersion || !ownerReceiptMatches)
		return failure(edge.edgeId, "incompatible", "continuation-ownership");
	const continuation = ledger.getWorkspaceContinuation(edge.workspaceContinuationId);
	if (continuation === null || continuation.taskId !== edge.childTaskId ||
		continuation.driver.length === 0 || continuation.capabilityIdentity !== config.capabilityIdentity ||
		continuation.capabilityVersion !== config.capabilityVersion || continuation.providerVersion !== config.capabilityVersion ||
		continuation.revision !== checkpoint.workspaceRevision)
		return failure(edge.edgeId, "incompatible", "continuation-ownership");
	let capability: ReturnType<typeof workspaceContinuationOf>;
	try { capability = workspaceContinuationOf(options.workspaceDriver); }
	catch { return failure(edge.edgeId, "incompatible", "provider-capability"); }
	const identity = capability.identity ?? capability.capabilityIdentity;
	const version = capability.version ?? capability.capabilityVersion;
	if (identity !== config.capabilityIdentity || version !== config.capabilityVersion ||
		continuation.driver !== options.workspaceDriver.name)
		return failure(edge.edgeId, "incompatible", "provider-capability");
	if (capability.validateContinuation !== undefined) try {
		// This is explicitly a read-only provider probe. Never call
		// resumeContinuation here: that operation is the single claim made by
		// resumeSequentialChild after the edge has been classified.
		await capability.validateContinuation(edge.childTaskId, {
			opaqueToken: continuation.opaqueToken,
			revision: continuation.revision,
		});
	} catch (error) {
		if (isWorkspaceContinuationError(error)) {
			const code: ChildBootEvidenceCode = error.code === "stale" || error.code === "revision_mismatch"
				? error.code : error.code === "missing" ? "missing" : "incompatible";
			return failure(edge.edgeId, code, "provider-target");
		}
		return failure(edge.edgeId, "incompatible", "provider-target");
	}
	return { valid: true };
}

export async function validateChildEdgesOnBoot(
	ledger: LedgerStore,
	edges: readonly TaskEdgeRow[],
	options: ChildBootValidationOptions,
): Promise<ReadonlyMap<string, ChildBootValidation>> {
	const entries = await Promise.all(edges.map(async (edge) => [
		edge.edgeId, await validateChildEdgeOnBoot(ledger, edge, options),
	] as const));
	return new Map(entries);
}
