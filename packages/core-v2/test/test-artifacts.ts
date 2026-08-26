/**
 * Hermetic tests for failure artifacts (M1.3 R4 — FR-8).
 *
 * Temp-dir fs only — zero LLM, zero network:
 *   - happy-path write: `<artifactsDir>/<runId>.failure.json` with the
 *     exact { cause, lastEvent?, lastTool?, stderrTail? } shape
 *   - every field capped at its named constant (tail kept, head dropped)
 *   - SessionHostEvent serialized into `lastEvent` (capped)
 *   - optional fields omitted when absent
 *   - never throws: an unwritable artifacts dir reports to stderr and
 *     returns undefined (no temp file left behind)
 *
 * Standalone: npx tsx packages/core-v2/test/test-artifacts.ts
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	FAILURE_CAUSE_MAX_CHARS,
	FAILURE_LAST_EVENT_MAX_CHARS,
	FAILURE_LAST_TOOL_MAX_CHARS,
	FAILURE_STDERR_TAIL_CHARS,
	capTail,
	writeFailureArtifact,
} from "../src/guards/artifacts.ts";

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const root = join(
		tmpdir(),
		"pi-task-v2-artifacts-" + process.pid + "-" + Date.now(),
	);
	try {
		// ─── Happy path: exact shape + atomic write ──────────────────
		{
			const artifactsDir = join(root, "nested", "artifacts"); // created on demand
			const event = {
				type: "toolStart",
				toolName: "bash",
				toolCallId: "c1",
			} as const;
			const path = writeFailureArtifact({
				artifactsDir,
				runId: "run-1",
				cause: "wall_timeout",
				lastEvent: event,
				lastTool: "bash — npx tsc --noEmit",
				stderrTail: "Error: boom\n",
			});
			check(path !== undefined && existsSync(path), "artifact written to disk");
			check(
				path === join(artifactsDir, "run-1.failure.json"),
				`path is <dir>/<runId>.failure.json, got ${path}`,
			);

			const parsed = JSON.parse(readFileSync(path!, "utf-8")) as Record<
				string,
				unknown
			>;
			check(parsed.cause === "wall_timeout", "cause round-trips");
			check(
				typeof parsed.lastEvent === "string" &&
					parsed.lastEvent.includes("bash"),
				"lastEvent serialized from the host event",
			);
			check(
				parsed.lastTool === "bash — npx tsc --noEmit",
				"lastTool round-trips",
			);
			check(parsed.stderrTail === "Error: boom\n", "stderrTail round-trips");
		}

		// ─── Caps: tail kept, head dropped ───────────────────────────
		{
			const artifactsDir = join(root, "caps");
			const path = writeFailureArtifact({
				artifactsDir,
				runId: "run-2",
				cause: "c".repeat(FAILURE_CAUSE_MAX_CHARS * 3),
				lastEvent: "e".repeat(FAILURE_LAST_EVENT_MAX_CHARS * 3),
				lastTool: "t".repeat(FAILURE_LAST_TOOL_MAX_CHARS * 3),
				stderrTail: "s".repeat(FAILURE_STDERR_TAIL_CHARS * 3),
			});
			const parsed = JSON.parse(readFileSync(path!, "utf-8")) as Record<
				string,
				string | undefined
			>;
			check(
				parsed.cause?.length === FAILURE_CAUSE_MAX_CHARS,
				`cause capped to ${FAILURE_CAUSE_MAX_CHARS}, got ${parsed.cause?.length}`,
			);
			check(
				parsed.lastEvent!.length === FAILURE_LAST_EVENT_MAX_CHARS,
				`lastEvent capped to ${FAILURE_LAST_EVENT_MAX_CHARS}, got ${parsed.lastEvent!.length}`,
			);
			check(
				parsed.lastTool!.length === FAILURE_LAST_TOOL_MAX_CHARS,
				`lastTool capped to ${FAILURE_LAST_TOOL_MAX_CHARS}, got ${parsed.lastTool!.length}`,
			);
			check(
				parsed.stderrTail!.length === FAILURE_STDERR_TAIL_CHARS,
				`stderrTail capped to ${FAILURE_STDERR_TAIL_CHARS}, got ${parsed.stderrTail!.length}`,
			);

			// Tails keep the END of the string.
			check(
				capTail("abcdef", 3) === "def",
				"capTail keeps the tail characters",
			);

			// Object events cap too.
			const bigEvent = {
				type: "error",
				message: "m".repeat(FAILURE_LAST_EVENT_MAX_CHARS * 5),
				code: "prompt_failed",
			} as const;
			const cappedPath = writeFailureArtifact({
				artifactsDir,
				runId: "run-2b",
				cause: "x",
				lastEvent: bigEvent,
			});
			const cappedParsed = JSON.parse(
				readFileSync(cappedPath!, "utf-8"),
			) as Record<string, string | undefined>;
			check(
				cappedParsed.lastEvent!.length === FAILURE_LAST_EVENT_MAX_CHARS,
				"object lastEvent capped after serialization",
			);
		}

		// ─── Optional fields omitted when absent ─────────────────────
		{
			const artifactsDir = join(root, "minimal");
			const path = writeFailureArtifact({
				artifactsDir,
				runId: "run-3",
				cause: "settled_without_yield",
			});
			const parsed = JSON.parse(readFileSync(path!, "utf-8")) as Record<
				string,
				unknown
			>;
			check(
				Object.keys(parsed).join(",") === "cause",
				`only cause present when no diagnostics supplied, got ${Object.keys(parsed).join(",")}`,
			);
		}

		// ─── Never throws: unwritable dir → stderr + undefined ───────
		{
			mkdirSync(join(root, "blocked"), { recursive: true });
			// A FILE where the directory should be makes mkdir/write fail.
			const blockerPath = join(root, "blocked", "not-a-dir");
			const { writeFileSync } = await import("node:fs");
			writeFileSync(blockerPath, "i am a file", "utf-8");

			let reported = "";
			const originalError = console.error;
			console.error = (msg: unknown) => {
				reported = String(msg);
			};
			let result: string | undefined;
			try {
				result = writeFailureArtifact({
					artifactsDir: blockerPath, // a file — mkdirSync must fail
					runId: "run-4",
					cause: "no_progress",
				});
			} finally {
				console.error = originalError;
			}
			check(
				result === undefined,
				"write failure returns undefined instead of throwing",
			);
			check(
				reported.includes("failed to write failure artifact"),
				`write failure reported to stderr, got: ${reported}`,
			);
			check(
				!existsSync(blockerPath + ".tmp"),
				"temp file cleaned up on failure",
			);
		}

		// ─── Long runId is bounded in the filename ───────────────────
		{
			const artifactsDir = join(root, "runid");
			const path = writeFailureArtifact({
				artifactsDir,
				runId: "r".repeat(500),
				cause: "x",
			});
			const fileName = path!.split(/[\\/]/).pop()!;
			check(
				fileName.length <= 128 + ".failure.json".length,
				`runId segment bounded, got ${fileName.length}`,
			);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		throw new Error("test-artifacts failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log(
		"✓ guards/artifacts: shape, per-field caps, optional fields, never-throw, runId bound",
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
