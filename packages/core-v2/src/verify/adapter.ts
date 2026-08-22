/**
 * EnvironmentVerificationDriver — M2 review M6/C8: the adapter giving BOTH
 * lanes full FR-5+FR-6 semantics from one implementation.
 *
 * runVerification's runner semantics (per-command timeout, suite wall,
 * bounded grace, capped tails) execute THROUGH an EnvironmentDriver's
 * exec — so the parallel lane gains wall/grace/tails it was dropping, and
 * the single lane gains the environment ladder it was bypassing.
 */

import type {
	EnvironmentDriver,
	VerificationDriver,
	VerificationResult,
	WorkspaceContext,
} from "../contracts/index.ts";
import { runVerification, type VerifyOptions } from "./run.ts";

export class EnvironmentVerificationDriver implements VerificationDriver {
	readonly name: string;
	readonly #env: EnvironmentDriver;

	constructor(env: EnvironmentDriver) {
		this.#env = env;
		this.name = `verify-${env.name}`;
	}

	async runVerification(context: WorkspaceContext, commands: string[]): Promise<VerificationResult> {
		const resolved = await this.#env.resolvePath(context);
		return runVerification(commands, {
			cwd: resolved.effectivePath,
			exec: (command, args, execOptions) =>
				this.#env.exec(command, args, { cwd: execOptions.cwd, timeoutMs: execOptions.timeoutMs }),
		});
	}
}

/** Convenience path with caller-set bounds (same semantics as the class). */
export async function verifyThroughEnvironment(
	env: EnvironmentDriver,
	cwd: string,
	commands: string[],
	options?: Pick<VerifyOptions, "commandTimeoutMs" | "wallTimeoutMs" | "graceMs">,
): Promise<VerificationResult> {
	const resolved = await env.resolvePath({
		taskId: "verify",
		hostPath: cwd,
		branchName: "verify",
		status: "active",
	});
	return runVerification(commands, {
		cwd: resolved.effectivePath,
		exec: (command, args, execOptions) =>
			env.exec(command, args, { cwd: execOptions.cwd, timeoutMs: execOptions.timeoutMs }),
		...(options ?? {}),
	});
}
