/**
 * Seam 1/6 — Workspace isolation (subsystems §1, contract FR-4).
 *
 * v1's jj ladder ports VERBATIM behind this interface: AI-authored task
 * base, atomic revset-union squash tracked by CHANGE id, per-file union
 * resolution, assertMerged consistency gate, preserved workspaces +
 * recovery-guide failure artifacts, bounded execJj timeouts, and
 * --ignore-working-copy for read-only calls.
 */

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

/** Engine-owned evidence for one finalized worker workspace. */
export interface WorkspaceFinalization {
	/** Stable jj change id for the committed worker tip. */
	changeId: string;
	/** Authoritative jj commit id for the committed worker tip. */
	commitId: string;
	/** Repository-relative paths changed from the task base, including deletions. */
	changedPaths: readonly string[];
	/** Whether the worker produced any tree changes relative to the task base. */
	hasChanges: boolean;
	/** Provider-observed paths present in the finalized worker tree. */
	presentFiles?: readonly string[];
	/** Provider-observed paths deleted by the worker. */
	deletedFiles?: readonly string[];
}

/** Result of an atomic combine across all workers' workspaces. */
export interface CombineOutcome {
	/** The merged base's COMMIT id (post-squash). */
	commitId: string;
	/** Repo-relative paths still conflicted after deterministic union. */
	conflicts: string[];
	/** Files the combine changed vs the pre-merge base — the honest
	 *  filesChanged for aggregate receipts (review M4). */
	filesChanged: number;
	/** Provider-observed integrated paths, including deletions. */
	changedPaths?: readonly string[];
	/** Provider-observed paths present in the integrated tree. */
	presentFiles?: readonly string[];
	/** Provider-observed paths deleted from the integration base. */
	deletedFiles?: readonly string[];
}

export interface WorkspaceDriver {
	name: string;
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
