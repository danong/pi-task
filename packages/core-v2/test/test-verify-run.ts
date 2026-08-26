/**
 * Hermetic tests for the verification runner (M1.3 R3 — FR-6).
 *
 * Real bash over fast commands only (true / false / exit 3 / sleep) —
 * zero LLM, zero network, deterministic:
 *   - passing suite (true) and vacuous pass on an empty command list
 *   - failing commands captured with exit codes (false → 1, exit 3 → 3),
 *     all commands run, failures aggregated in order
 *   - per-command timeout kills a hung sleep → timedOut + exit 124
 *   - stdout/stderr tails capped at VERIFY_OUTPUT_TAIL_CHARS
 *   - wall clock: once expired, no further command starts
 *   - bounded grace: a command in flight when the wall expires gets its
 *     grace window and completes instead of being killed mid-suite
 *
 * Standalone: npx tsx packages/core-v2/test/test-verify-run.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	runVerification,
	VERIFY_OUTPUT_TAIL_CHARS,
	VERIFY_TIMEOUT_EXIT_CODE,
} from "../src/verify/run.ts";

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-task-v2-verify-"));
	try {
		// ─── Passing + vacuous ────────────────────────────────────────
		{
			const pass = await runVerification(["true"], { cwd: dir });
			check(
				pass.passed &&
					pass.commands.length === 1 &&
					pass.commands[0]?.exitCode === 0,
				`"true" passes with one recorded command, got ${JSON.stringify(pass)}`,
			);

			const empty = await runVerification([], { cwd: dir });
			check(
				empty.passed && empty.commands.length === 0,
				"empty command list passes vacuously",
			);
		}

		// ─── Failures: exit codes, aggregation, order ─────────────────
		{
			const result = await runVerification(["true", "exit 3", "false"], {
				cwd: dir,
			});
			check(!result.passed, "a failing command fails the suite");
			check(
				result.commands.length === 3,
				"every command runs — failures do not stop the suite",
			);
			const failed = result.commands.filter((c) => c.exitCode !== 0);
			check(
				failed.length === 2,
				`two failures aggregated, got ${failed.length}`,
			);
			check(
				failed[0]?.command === "exit 3" && failed[0]?.exitCode === 3,
				"failures keep command order with correct exit codes",
			);
			check(
				failed[1]?.command === "false" && failed[1]?.exitCode === 1,
				'"false" exits 1',
			);
		}

		// ─── Output tails captured + capped ───────────────────────────
		{
			const noisy = await runVerification(
				["echo out-marker; echo err-marker 1>&2; exit 7"],
				{ cwd: dir },
			);
			const cmd = noisy.commands[0];
			check(
				(cmd?.stdoutTail ?? "").includes("out-marker"),
				"stdout tail captured",
			);
			check(
				(cmd?.stderrTail ?? "").includes("err-marker"),
				"stderr tail captured",
			);

			const flood = `printf '${"x".repeat(VERIFY_OUTPUT_TAIL_CHARS * 4)}'; exit 1`;
			const capped = await runVerification([flood], { cwd: dir });
			check(
				capped.commands[0]?.stdoutTail.length === VERIFY_OUTPUT_TAIL_CHARS,
				`stdout tail capped at ${VERIFY_OUTPUT_TAIL_CHARS}, got ${capped.commands[0]?.stdoutTail.length}`,
			);
			check(
				capped.commands[0]?.stderrTail.length === 0,
				"empty stderr stays empty",
			);
		}

		// ─── Per-command timeout: hung sleep killed ───────────────────
		{
			const hung = await runVerification(["sleep 30"], {
				cwd: dir,
				commandTimeoutMs: 200,
			});
			const cmd = hung.commands[0];
			check(cmd?.timedOut === true, "hung sleep reports timedOut");
			check(
				cmd?.exitCode === VERIFY_TIMEOUT_EXIT_CODE,
				`timeout exits ${VERIFY_TIMEOUT_EXIT_CODE}`,
			);
			check(!hung.passed, "timed-out command fails the suite");
		}

		// ─── Wall clock: no new command starts after expiry ───────────
		{
			const walled = await runVerification(["true", "true", "true"], {
				cwd: dir,
				wallTimeoutMs: 0, // already expired at entry
				commandTimeoutMs: 5_000,
			});
			check(walled.commands.length === 0, "expired wall runs nothing");
			check(!walled.passed, "an incomplete suite never passes");
		}

		// ─── Bounded grace: in-flight command finishes past the wall ──
		{
			const graced = await runVerification(["sleep 0.4; true"], {
				cwd: dir,
				wallTimeoutMs: 50, // expires while sleep is in flight
				graceMs: 10_000, // generous grace lets it finish
				commandTimeoutMs: 5_000,
			});
			const cmd = graced.commands[0];
			check(
				cmd !== undefined && cmd.exitCode === 0 && !cmd.timedOut,
				"in-flight command gets its grace window and finishes cleanly",
			);
			check(graced.passed, "suite completed within grace passes");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		throw new Error("test-verify-run failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log(
		"✓ verify/run: pass/vacuous, exit-code aggregation, output caps, per-command timeout, wall, grace",
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		});
}
