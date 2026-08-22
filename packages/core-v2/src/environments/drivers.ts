/**
 * Environment drivers — M2.b (subsystems §1 seam 2, contract FR-5).
 *
 * HostEnvironmentDriver: bare-host exec, the fallback rung of the FR-5
 * ladder. MiseEnvironmentDriver: same exec wrapped in `mise exec --` so
 * commands see the project's pinned tool versions; unsupported when the
 * `mise` binary is absent (capability detection, NFR-2).
 *
 * Shared semantics: every command is bounded by a hard timeout (killed,
 * exit code 124, timedOut=true — matching the verification runner's
 * convention), output tails are capped, and resolvePath is identity for
 * host-rung drivers (inContainer=false).
 */

import { execFile } from "node:child_process";

import type {
	EnvironmentDriver,
	ExecOptions,
	ExecResult,
	PathResolution,
} from "../contracts/index.ts";
import type { WorkspaceContext } from "../contracts/index.ts";

/** Output tails are capped per stream; full streams belong to artifacts. */
export const ENV_OUTPUT_TAIL_CHARS = 4096;

/** Default per-command timeout (~10m) when ExecOptions omits one. */
export const DEFAULT_ENV_COMMAND_TIMEOUT_MS = 10 * 60_000;

/** Exit code a killed (timed-out) command reports, matching verify/run.ts. */
export const ENV_TIMEOUT_EXIT_CODE = 124;

function cap(value: string): string {
	return value.length > ENV_OUTPUT_TAIL_CHARS ? value.slice(-ENV_OUTPUT_TAIL_CHARS) : value;
}

/** Shared bash execution: `bash -c "<command> <args…>"` under a timeout. */
function execBash(command: string, args: string[], options: ExecOptions | undefined, cwd: string): Promise<ExecResult> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_ENV_COMMAND_TIMEOUT_MS;
	const fullCommand = [command, ...args].join(" ");
	return new Promise((resolve) => {
		execFile(
			"/bin/bash",
			["-c", fullCommand],
			{
				cwd,
				timeout: timeoutMs,
				maxBuffer: 16 * 1024 * 1024,
				env: options?.env === undefined ? undefined : { ...process.env, ...options.env },
			},
			(error, stdout, stderr) => {
				// Node reports execFile timeouts as killed + SIGTERM.
				const timedOut = error !== null && (error as { killed?: boolean }).killed === true;
				resolve({
					exitCode: timedOut ? ENV_TIMEOUT_EXIT_CODE : (error?.code as number ?? 0),
					stdout: cap(stdout.toString()),
					stderr: cap(stderr.toString()),
					timedOut,
				});
			},
		);
	});
}

/** Bare-host fallback rung: commands run directly on the host. */
export class HostEnvironmentDriver implements EnvironmentDriver {
	readonly name = "host";

	async resolvePath(context: WorkspaceContext): Promise<PathResolution> {
		return { effectivePath: context.hostPath, inContainer: false };
	}

	async exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
		return execBash(command, args, options, options?.cwd ?? process.cwd());
	}
}

/** True when the mise binary is available on PATH. */
export async function isMiseAvailable(): Promise<boolean> {
	return new Promise((resolve) => {
		execFile("/bin/bash", ["-c", "command -v mise"], (_error, stdout) => {
			resolve(stdout.toString().trim().length > 0);
		});
	});
}

/**
 * Mise-managed host rung: wraps every command in `mise exec --` so tools
 * resolve to the project's `.mise.toml`-pinned versions. Unsupported where
 * the binary is absent — construct via {@link createMiseDriverIfAvailable}.
 */
export class MiseEnvironmentDriver implements EnvironmentDriver {
	readonly name = "mise";
	readonly #envDir: string | undefined;

	constructor(envDir?: string) {
		this.#envDir = envDir;
	}

	async resolvePath(context: WorkspaceContext): Promise<PathResolution> {
		return { effectivePath: context.hostPath, inContainer: false };
	}

	async exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
		return execBash("mise", ["exec", "--", command, ...args], options, options?.cwd ?? this.#envDir ?? process.cwd());
	}
}

/** Capability-detected constructor (NFR-2): mise when present, else null. */
export async function createMiseDriverIfAvailable(): Promise<MiseEnvironmentDriver | null> {
	return (await isMiseAvailable()) ? new MiseEnvironmentDriver() : null;
}
