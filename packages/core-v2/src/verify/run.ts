/**
 * Verification runner (M1.3 R3 — docs/pi-task-v2.md FR-6).
 *
 * Completion is a fact, not a claim: a spec's verification commands are
 * plain bash run sequentially against a workspace path; each command is
 * bounded by its own timeout, and the whole suite by a wall clock with
 * BOUNDED GRACE: when the wall expires while a command is in flight, that
 * command gets up to `graceMs` beyond the remaining wall to finish (a
 * suite about to complete is never killed mid-run); commands started
 * after the wall expiry do not run at all.
 *
 * Zero LLM, zero network — deterministic over real bash. Every captured
 * output field is capped by a named constant so a chatty suite cannot
 * bloat the result.
 */

import { execFile } from "node:child_process";

import type { VerificationCommandResult, VerificationResult } from "../contracts/index.ts";
import { capTail } from "../guards/artifacts.ts";

// ─── Named limits ────────────────────────────────────────────────────

/** Default per-command budget for one verification command (~15m, v1 parity). */
export const DEFAULT_VERIFY_COMMAND_TIMEOUT_MS = 15 * 60_000;
/** Default wall-clock budget for the whole verification suite (~20m). */
export const DEFAULT_VERIFY_WALL_TIMEOUT_MS = 20 * 60_000;
/** Extra time granted to the in-flight command when the wall expires (~10m). */
export const DEFAULT_VERIFY_GRACE_MS = 10 * 60_000;
/** Max chars kept of a command's stdout/stderr (tail — the error is at the end). */
export const VERIFY_OUTPUT_TAIL_CHARS = 2048;
/** Conventional exit code for a timed-out command (matches `timeout(1)`). */
export const VERIFY_TIMEOUT_EXIT_CODE = 124;

/** Injectable execution — the EnvironmentDriver seam (FR-5/FR-6). When
 *  provided, commands run through it instead of a hardcoded /bin/bash, so
 *  every lane gets the environment ladder AND full runner semantics
 *  (wall/grace/tails) from one implementation. */
export type VerifyExec = (
	command: string,
	args: string[],
	options: { cwd: string; timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;

export interface VerifyOptions {
	/** Working directory the commands run in (the merged workspace). */
	cwd: string;
	/** Execution backend. Default: direct /bin/bash on the host. */
	exec?: VerifyExec | undefined;
	/** Per-command budget in ms. Default {@link DEFAULT_VERIFY_COMMAND_TIMEOUT_MS}. */
	commandTimeoutMs?: number;
	/** Wall-clock budget for the whole suite in ms. Default {@link DEFAULT_VERIFY_WALL_TIMEOUT_MS}. */
	wallTimeoutMs?: number;
	/** Bounded grace for the in-flight command when the wall expires. Default {@link DEFAULT_VERIFY_GRACE_MS}. */
	graceMs?: number;
}

/**
 * Run one bash command with a hard timeout. Resolves (never rejects):
 * timeouts surface as `timedOut: true` with exit code 124.
 */
function runBash(command: string, cwd: string, timeoutMs: number): Promise<Omit<VerificationCommandResult, "command">> {
	const startedAtMs = Date.now();
	return new Promise((resolve) => {
		execFile(
			"/bin/bash",
			["-c", command],
			{ cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout, stderr) => {
				// Node reports execFile timeouts as killed=true + signal=SIGTERM
				// (code null) on newer versions, ETIMEDOUT on older/other platforms.
				const err = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
				const timedOut = err?.code === "ETIMEDOUT" || (err?.killed === true && err.signal === "SIGTERM");
				const exitCode = !err
					? 0
					: timedOut
						? VERIFY_TIMEOUT_EXIT_CODE
						: typeof err.code === "number"
							? err.code
							: 1;
				resolve({
					exitCode,
					stdoutTail: capTail(stdout, VERIFY_OUTPUT_TAIL_CHARS),
					stderrTail: capTail(stderr, VERIFY_OUTPUT_TAIL_CHARS),
					durationMs: Date.now() - startedAtMs,
					timedOut,
				});
			},
		);
	});
}

/**
 * Run the verification commands sequentially and aggregate failures
 * (every command that starts runs; failures never stop the suite — only
 * the wall does).
 *
 * Bounded-grace semantics: a command that starts before the wall expires
 * gets `min(commandTimeoutMs, remainingWall + graceMs)`; once the wall has
 * expired, no further command starts. An empty command list passes
 * vacuously.
 */
export async function runVerification(commands: string[], options: VerifyOptions): Promise<VerificationResult> {
	const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_VERIFY_COMMAND_TIMEOUT_MS;
	const wallTimeoutMs = options.wallTimeoutMs ?? DEFAULT_VERIFY_WALL_TIMEOUT_MS;
	const graceMs = options.graceMs ?? DEFAULT_VERIFY_GRACE_MS;
	const startedAtMs = Date.now();

	const executed: VerificationCommandResult[] = [];
	for (const command of commands) {
		const remainingWallMs = wallTimeoutMs - (Date.now() - startedAtMs);
		if (remainingWallMs <= 0) break; // wall expired between commands — no new work starts
		const timeoutMs = Math.min(commandTimeoutMs, remainingWallMs + graceMs);
		let result: { exitCode: number; stdout: string; stderr: string; timedOut: boolean };
		if (options.exec) {
			const r = await options.exec("/bin/bash", ["-c", command], { cwd: options.cwd, timeoutMs });
			result = { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut === true };
		} else {
			const r = await runBash(command, options.cwd, timeoutMs);
			result = {
				exitCode: r.exitCode,
				stdout: r.stdoutTail,
				stderr: r.stderrTail,
				timedOut: r.timedOut,
			};
		}
		executed.push({
			command,
			exitCode: result.exitCode,
			stdoutTail: capTail(result.stdout, VERIFY_OUTPUT_TAIL_CHARS),
			stderrTail: capTail(result.stderr, VERIFY_OUTPUT_TAIL_CHARS),
			durationMs: 0,
			timedOut: result.timedOut,
		});
	}

	const failures = executed.filter((c) => c.exitCode !== 0);
	return {
		passed: executed.length === commands.length && failures.length === 0,
		commands: executed,
	};
}
