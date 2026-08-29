/**
 * Seam 1/6 — Workspace isolation (subsystems §1, contract FR-4).
 *
 * v1's jj ladder ports VERBATIM behind this interface: AI-authored task
 * base, atomic revset-union squash tracked by CHANGE id, per-file union
 * resolution, assertMerged consistency gate, preserved workspaces +
 * recovery-guide failure artifacts, bounded execJj timeouts, and
 * --ignore-working-copy for read-only calls.
 */

import { z } from "zod";

/** A live worker workspace. No shared mutable state — the driver owns it. */
export interface WorkspaceContext {
	taskId: string;
	/** Path on the host where the workspace's working copy lives. */
	hostPath: string;
	/** In-container path, for env drivers that exec inside a container. */
	containerPath?: string;
	branchName: string;
	/** Mirrors the ledger `workspaces` status enum; see ledger/store.ts. */
	status:
		| "provisioning"
		| "active"
		| "merging"
		| "cleaning_up"
		| "released"
		| "orphaned";
}

/** How finished worker work integrates back (config-selected). */
export type IntegrationMode = "task-base" | "feature-branch";

/**
 * Provider-neutral continuation handle. Its value is opaque to the kernel and
 * must be stored as ledger state, not interpreted or rendered in a prompt.
 * A continuation contains no workspace path or VCS name as a contract field.
 */
export interface WorkspaceContinuation {
	readonly opaqueToken: string;
	/** Provider-observed revision used to validate a later resume. */
	readonly revision: string;
}

/** Result of the provider-owned, idempotent preparation boundary.  The
 * preparation identity is durable ledger data; the returned context is only
 * used by the coordinator to record provider facts. */
export interface WorkspaceContinuationPreparation {
	readonly context: WorkspaceContext;
	readonly continuation: WorkspaceContinuation;
}

/** Runtime-safe shape for values crossing the kernel/provider boundary. */
export type WorkspaceContinuationErrorCode =
	| "unsupported"
	| "missing"
	| "stale"
	| "revision_mismatch"
	| "malformed_token";

export interface WorkspaceContinuationFailure {
	readonly ok: false;
	readonly code: WorkspaceContinuationErrorCode;
	readonly message: string;
}

/** Typed failure used by optional continuation providers. */
export class WorkspaceContinuationError extends Error {
	readonly code: WorkspaceContinuationErrorCode;
	constructor(
		code: WorkspaceContinuationErrorCode,
		message: string,
	) {
		super(message);
		this.name = "WorkspaceContinuationError";
		this.code = code;
	}
}

export function isWorkspaceContinuationError(
	error: unknown,
): error is WorkspaceContinuationError {
	return error instanceof WorkspaceContinuationError;
}

/** Optional capability implemented by drivers that can preserve and resume. */
export interface WorkspaceContinuationCapability {
	readonly supported: boolean;
	/** Provider-declared compatibility identity and version. These values are
	 * persisted with a continuation; the daemon never invents them. */
	readonly identity?: string;
	readonly version?: string;
	/** Explicit aliases for adapters that use capability terminology. */
	readonly capabilityIdentity?: string;
	readonly capabilityVersion?: string;
	/** Discover or create the provider workspace owned by preparationId.  It
	 * must be safe to call again after a process restart. */
	prepareContinuation?(
		taskId: string,
		preparationId: string,
	): Promise<WorkspaceContinuationPreparation>;
	/** Read-only provider target check for boot reconciliation. It must not
	 * claim, consume, snapshot, clean, or otherwise mutate the continuation. */
	validateContinuation?(
		taskId: string,
		continuation: WorkspaceContinuation,
	): Promise<void>;
	preserveContinuation(
		context: WorkspaceContext,
	): Promise<WorkspaceContinuation>;
	resumeContinuation(
		taskId: string,
		continuation: WorkspaceContinuation,
	): Promise<WorkspaceContext>;
}

/** Runtime-validated provider evidence. Provider-neutral identities are
 * nonempty strings; repository path safety is enforced by content acceptance. */
const EvidencePathListSchema = z.array(z.string().min(1));

/** Engine-owned evidence for one finalized worker workspace. */
export const WorkspaceFinalizationSchema = z
	.object({
		/** Stable provider change identity for the committed worker tip. */
		changeId: z.string().min(1),
		/** Authoritative provider commit identity for the committed worker tip. */
		commitId: z.string().min(1),
		/** Paths changed from the task base, including deletions. */
		changedPaths: EvidencePathListSchema,
		hasChanges: z.boolean(),
		presentFiles: EvidencePathListSchema.optional(),
		deletedFiles: EvidencePathListSchema.optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.hasChanges !== (value.changedPaths.length > 0))
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "hasChanges disagrees with changedPaths",
			});
	});
export type WorkspaceFinalization = z.infer<typeof WorkspaceFinalizationSchema>;

/** Result of an atomic combine across all workers' workspaces. */
export const CombineOutcomeSchema = z
	.object({
		commitId: z.string().min(1),
		conflicts: EvidencePathListSchema,
		filesChanged: z.number().int().nonnegative(),
		changedPaths: EvidencePathListSchema.optional(),
		presentFiles: EvidencePathListSchema.optional(),
		deletedFiles: EvidencePathListSchema.optional(),
	})
	.strict();
export type CombineOutcome = z.infer<typeof CombineOutcomeSchema>;

export interface WorkspaceDriver {
	name: string;
	/** The one optional provider-neutral continuation capability. */
	readonly continuation?: WorkspaceContinuationCapability;
	/** The driver's integration mode when it declares one (task-base |
	 *  feature-branch); undefined = single-workspace driver. */
	readonly integrationMode?: IntegrationMode | undefined;
	/** Probe the host for this driver's requirements (e.g. a jj binary). */
	isSupported(): Promise<boolean>;
	/** Fetch remotes / pre-flight checks before provisioning. Non-fatal
	 *  failures must not throw (local-only repos are supported). */
	prepare?(): Promise<void>;
	/** Provision an isolated workspace off `parentBranch` (default = base). */
	createWorkspace(
		taskId: string,
		parentBranch?: string,
	): Promise<WorkspaceContext>;
	/**
	 * Deterministic merge of the workspace's changes back into the task
	 * base. On success `conflicts` is empty; a residual-LM or human
	 * escalation path is signalled via `conflicts` when the union
	 * resolution cannot auto-resolve. Failed merges PRESERVE the workspace.
	 */
	/** Finalize worker edits and return provider-owned VCS evidence. Providers
	 *  that support this seam snapshot/commit edits without requiring model VCS
	 *  commands; callers must not infer evidence from the worker yield. */
	finalizeWorkspace?(
		context: WorkspaceContext,
		baseChangeId: string,
	): Promise<WorkspaceFinalization>;
	mergeWorkspace(
		context: WorkspaceContext,
	): Promise<{ success: boolean; conflicts?: string[] }>;
	/** Remove the workspace after a verifiably-complete merge. */
	cleanupWorkspace(context: WorkspaceContext): Promise<void>;
	/** AI-authored empty integration base; returns its CHANGE id
	 *  (task-base mode). Optional: single-workspace drivers may not need it. */
	prepareIntegrationBase?(goal: string): Promise<string>;
	/** ONE atomic operation combining every worker's commits into the base
	 *  (v1 ladder R1 — never per-workspace incremental squashes). */
	combine?(
		baseChangeId: string,
		contexts: readonly WorkspaceContext[],
	): Promise<CombineOutcome>;
	/** feature-branch mode: leave each worker's tip under a named bookmark
	 *  for human review; returns the created bookmark names. */
	publishBookmarks?(contexts: readonly WorkspaceContext[]): Promise<string[]>;
}

/**
 * A driver may omit continuation entirely. Kernel callers use this guard
 * rather than inferring provider behavior from a driver name.
 */
export function workspaceContinuationOf(
	driver: WorkspaceDriver,
): WorkspaceContinuationCapability {
	const continuation = driver.continuation;
	if (continuation?.supported !== true)
		throw new WorkspaceContinuationError(
			"unsupported",
			"workspace provider does not support continuation",
		);
	return continuation;
}

/**
 * A driver supporting the task-base integration flow (contract FR-4/FR-6):
 * AI-authored base, atomic combine, and MATERIALIZE — place the main
 * working copy on the integrated tree so FR-6's gate runs on merged work.
 * runParallelTask requires this shape for task-base runs and fails typed
 * otherwise (a silently-skipped materialize would verify an empty tree).
 */
export interface TaskBaseWorkspaceDriver extends WorkspaceDriver {
	integrationMode: IntegrationMode;
	prepareIntegrationBase(goal: string): Promise<string>;
	combine(
		baseChangeId: string,
		contexts: readonly WorkspaceContext[],
	): Promise<CombineOutcome>;
	/** Materialize the integrated tree at projectDir. */
	materialize(baseChangeId: string): Promise<void>;
}
