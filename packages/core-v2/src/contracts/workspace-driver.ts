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

export interface WorkspaceDriver {
	name: string;
	/** Probe the host for this driver's requirements (e.g. a jj binary). */
	isSupported(): Promise<boolean>;
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
}