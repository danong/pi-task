/**
 * Seam 2/6 — Project environment execution (subsystems §1, contract FR-5).
 *
 * The daemon runs any project without hosting its toolchain. Every
 * command executes through an EnvironmentDriver inside the project's own
 * runtime. Ladder, cheapest first: bare host (fallback) →
 * mise-managed host (project-pinned tool versions, no containers) →
 * ephemeral container (recommended where available). Capability
 * detection selects the best available; the daemon itself stays
 * toolchain-free.
 */

import type { WorkspaceContext } from "./workspace-driver.ts";

/** Where a path resolves for execution (host vs. container). */
export interface PathResolution {
	/** The effective path the driver will exec against (host or container). */
	effectivePath: string;
	/** True when execution happens inside a container (containerPath set). */
	inContainer: boolean;
}

export interface ExecOptions {
	/** Working directory; defaults to the resolved workspace path. */
	cwd?: string;
	/** Extra process environment for this exec. */
	env?: Record<string, string>;
	/** Per-command timeout; a hung suite must not hang the daemon (FR-6). */
	timeoutMs?: number;
	/** Read-only calls: allow the driver's locked-down/cheaper path. */
	readOnly?: boolean;
}

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface EnvironmentDriver {
	name: string;
	resolvePath(context: WorkspaceContext): Promise<PathResolution>;
	exec(
		command: string,
		args: string[],
		options?: ExecOptions,
	): Promise<ExecResult>;
}
