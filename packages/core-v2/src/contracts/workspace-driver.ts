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
	status: "provisioning" | "active" | "merging" | "cleaning_up" | "released" | "orphaned";
}

/** How finished worker work integrates back (config-selected). */
export type IntegrationMode = "task-base" | "feature-branch";

/** Result of an atomic combine across all workers' workspaces. */
export interface CombineOutcome {
	/** The merged base's COMMIT id (post-squash). */
	commitId: string;
	/** Repo-relative paths still conflicted after deterministic union. */
	conflicts: string[];
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
	createWorkspace(taskId: string, parentBranch?: string): Promise<WorkspaceContext>;
	/**
	 * Deterministic merge of the workspace's changes back into the task
	 * base. On success `conflicts` is empty; a residual-LM or human
	 * escalation path is signalled via `conflicts` when the union
	 * resolution cannot auto-resolve. Failed merges PRESERVE the workspace.
	 */
	mergeWorkspace(context: WorkspaceContext): Promise<{ success: boolean; conflicts?: string[] }>;
	/** Remove the workspace after a verifiably-complete merge. */
	cleanupWorkspace(context: WorkspaceContext): Promise<void>;
	/** AI-authored empty integration base; returns its CHANGE id
	 *  (task-base mode). Optional: single-workspace drivers may not need it. */
	prepareIntegrationBase?(goal: string): Promise<string>;
	/** ONE atomic operation combining every worker's commits into the base
	 *  (v1 ladder R1 — never per-workspace incremental squashes). */
	combine?(baseChangeId: string, contexts: readonly WorkspaceContext[]): Promise<CombineOutcome>;
	/** feature-branch mode: leave each worker's tip under a named bookmark
	 *  for human review; returns the created bookmark names. */
	publishBookmarks?(contexts: readonly WorkspaceContext[]): Promise<string[]>;
}