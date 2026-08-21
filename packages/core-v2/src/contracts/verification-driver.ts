/**
 * Seam 4/6 — Verification (subsystems §1, contract FR-6).
 *
 * Completion is a fact, not a claim: a task completes only when its
 * spec's bash commands exit zero, executed on the merged tree
 * post-merge, each bounded by a per-command timeout. The gate never
 * trusts model assertions.
 */

import type { WorkspaceContext } from "./workspace-driver.ts";

export interface VerificationCommandResult {
	command: string;
	exitCode: number;
	stdoutTail: string;
	stderrTail: string;
	durationMs: number;
	timedOut: boolean;
}

export interface VerificationResult {
	passed: boolean;
	commands: VerificationCommandResult[];
}

export interface VerificationDriver {
	name: string;
	runVerification(context: WorkspaceContext, commands: string[]): Promise<VerificationResult>;
}