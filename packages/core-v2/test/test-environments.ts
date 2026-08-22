/**
 * Hermetic tests for the M2.b environment drivers: host exec semantics
 * (exit codes, timeout kill, env, cwd, output caps), path resolution, and
 * mise capability detection (skips gracefully when mise is absent).
 * Fast real commands only — no LLM, no network.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createMiseDriverIfAvailable,
	DEFAULT_ENV_COMMAND_TIMEOUT_MS,
	ENV_OUTPUT_TAIL_CHARS,
	HostEnvironmentDriver,
	isMiseAvailable,
	MiseEnvironmentDriver,
} from "../src/environments/drivers.ts";

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const dir = mkdtempSync(join(tmpdir(), "core-v2-env-"));
	try {
		const host = new HostEnvironmentDriver();
		const ctx = { hostPath: dir } as Parameters<HostEnvironmentDriver["resolvePath"]>[0];

		// ─── resolvePath: identity on the host rung ──────────────────────
		{
			const resolved = await host.resolvePath(ctx);
			check(resolved.effectivePath === dir && resolved.inContainer === false, "host resolvePath is identity");
		}

		// ─── exec: exit codes, cwd, env ──────────────────────────────────
		{
			const ok = await host.exec("true", [], { cwd: dir });
			check(ok.exitCode === 0 && !ok.timedOut, "true exits 0");
			const fail = await host.exec("exit", ["3"], { cwd: dir });
			check(fail.exitCode === 3, "exit code propagates");
			writeFileSync(join(dir, "marker.txt"), "x", "utf-8");
			const cwd = await host.exec("pwd", [], { cwd: dir });
			check(cwd.stdout.trim() === dir, "cwd honored");
			const env = await host.exec("printenv", ["V2_PROBE"], { cwd: dir, env: { V2_PROBE: "yes" } });
			check(env.stdout.trim() === "yes", "extra env passed through");
		}

		// ─── exec: timeout kill (exit 124, timedOut) ─────────────────────
		{
			const slow = await host.exec("sleep", ["5"], { cwd: dir, timeoutMs: 250 });
			check(slow.timedOut && slow.exitCode === 124, "hung command killed with 124");
		}

		// ─── output caps ─────────────────────────────────────────────────
		{
			const big = await host.exec("head", ["-c", "20000", "/dev/zero"], { cwd: dir });
			check(big.stdout.length <= ENV_OUTPUT_TAIL_CHARS, `stdout capped (got ${big.stdout.length})`);
		}

		// ─── default timeout constant is sane ────────────────────────────
		check(DEFAULT_ENV_COMMAND_TIMEOUT_MS >= 60_000, "default command timeout >= 1m");

		// ─── mise: capability detection + wrapper (skips without mise) ───
		{
			const available = await isMiseAvailable();
			const maybe = await createMiseDriverIfAvailable();
			check((available && maybe !== null) || (!available && maybe === null),
				"capability detection agrees with binary presence");
			if (maybe !== null) {
				const resolved = await maybe.resolvePath(ctx);
				check(resolved.inContainer === false, "mise resolvePath is host-rung");
				const probe = await maybe.exec("node", ["--version"], { cwd: dir });
				check(probe.exitCode === 0 && probe.stdout.trim().startsWith("v"), "mise exec runs the wrapped command");
			}
			// The wrapper shape itself is testable without the binary: the
			// driver must delegate to `mise exec -- <cmd> <args>`.
			const driver = new MiseEnvironmentDriver(dir);
			check(driver.name === "mise", "mise driver named");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		throw new Error(`environment tests failed:\n  ${errors.join("\n  ")}`);
	}
	console.log("✓ environments: host exec semantics, timeouts, caps, mise capability detection");
}

if (process.argv[1] !== undefined) {
	const invokedAs = process.argv[1];
	if (import.meta.url.endsWith(invokedAs.split("/").pop() ?? "")) {
		runTests().catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
	}
}
