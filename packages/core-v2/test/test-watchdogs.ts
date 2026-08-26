/**
 * Hermetic tests for the pure watchdog decision functions (M1.3 R1 —
 * docs/pi-task-v2.md FR-7/FR-8; semantics ported from v1's "Hang
 * protection" taxonomy in docs/pi-task-design.md).
 *
 * Every watchdog is a PURE function of observed events + elapsed time:
 * no I/O, no clocks, no timers, no side effects — it returns a typed
 * action (`nudge` | `abort(reason)` | `continue`) and nothing else.
 *
 *   (a) settle-without-yield — nudge once on settle with no yield; fail
 *       on a second settle still without one
 *   (b) no-progress — abort when no activity within the window; an
 *       in-flight tool counts as progress
 *   (c) wall clock — hard cap, abort names the limit
 *   (d) per-tool timeout — abort names the tool
 *
 * Standalone: npx tsx packages/core-v2/test/test-watchdogs.ts
 */

import { pathToFileURL } from "node:url";

import {
	DEFAULT_SETTLE_NUDGE_TEXT,
	decideNoProgressAction,
	decideSettleAction,
	decideToolTimeoutAction,
	decideWallAction,
	formatDurationMs,
	noProgressMessage,
	settledWithoutYieldMessage,
	toolTimeoutMessage,
	wallTimeoutMessage,
} from "../src/guards/watchdogs.ts";
import type {
	WatchdogAction,
	WatchedEventType,
} from "../src/guards/watchdogs.ts";

const EVENT_TYPES: readonly WatchedEventType[] = [
	"turnStart",
	"toolStart",
	"toolEnd",
	"settled",
	"yielded",
	"error",
];

function isAbort(
	action: WatchdogAction,
): action is Extract<WatchdogAction, { kind: "abort" }> {
	return action.kind === "abort";
}

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// ─── (a) settle-without-yield ────────────────────────────────────
	{
		// Non-settle events never trigger the settle watchdog.
		for (const eventType of EVENT_TYPES) {
			if (eventType === "settled") continue;
			const first = decideSettleAction(eventType, false, false);
			const second = decideSettleAction(eventType, false, true);
			check(
				first.kind === "continue" && second.kind === "continue",
				`non-settle event "${eventType}" never nudges/aborts`,
			);
		}

		// A settle WITH a captured yield is always fine, any number of times.
		for (const nudged of [false, true]) {
			const withYield = decideSettleAction("settled", true, nudged);
			check(
				withYield.kind === "continue",
				`settled + yielded → continue (nudged=${nudged})`,
			);
		}

		// First settle without yield → nudge (exactly once).
		const first = decideSettleAction("settled", false, false);
		check(
			first.kind === "nudge",
			`first settle without yield → nudge, got ${first.kind}`,
		);
		check(
			first.kind === "nudge" &&
				first.text === DEFAULT_SETTLE_NUDGE_TEXT &&
				first.text.length > 0,
			"nudge carries the reminder text",
		);

		// Second settle still without yield → fail, typed reason.
		const second = decideSettleAction("settled", false, true);
		check(
			second.kind === "abort",
			`second settle without yield → abort, got ${second.kind}`,
		);
		check(
			isAbort(second) && second.reason === "settled_without_yield",
			"second-settle abort names the settled_without_yield reason",
		);
		check(
			isAbort(second) &&
				second.message === settledWithoutYieldMessage() &&
				second.message.includes("yield"),
			"second-settle abort message names the missing yield",
		);
	}

	// ─── (b) no-progress ─────────────────────────────────────────────
	{
		const windowMs = 600_000;
		const base = { lastActivityMs: 1_000, windowMs, inFlightTool: false };

		const below = decideNoProgressAction({
			...base,
			nowMs: 1_000 + windowMs - 1,
		});
		check(below.kind === "continue", "activity inside the window → continue");

		const atBoundary = decideNoProgressAction({
			...base,
			nowMs: 1_000 + windowMs,
		});
		check(
			isAbort(atBoundary),
			"silence of exactly the window → abort (inclusive boundary)",
		);
		check(
			isAbort(atBoundary) && atBoundary.reason === "no_progress",
			"no-progress abort names its reason",
		);

		const beyond = decideNoProgressAction({
			...base,
			nowMs: 1_000 + windowMs * 3,
		});
		check(isAbort(beyond), "silence past the window → abort");

		// An in-flight tool counts as progress: a long silent bash/test is
		// legitimate. Only the per-tool watchdog may abort it.
		const inTool = decideNoProgressAction({
			...base,
			nowMs: 1_000 + windowMs * 99,
			inFlightTool: true,
		});
		check(
			inTool.kind === "continue",
			"in-flight tool suppresses the no-progress abort",
		);

		// The abort message names the cause and the window.
		const message = noProgressMessage(windowMs);
		check(
			isAbort(beyond) && beyond.message === message,
			"abort message comes from the pure builder",
		);
		check(
			message.includes(String(windowMs)) &&
				message.includes(formatDurationMs(windowMs)),
			"no-progress message names the window (ms + human-readable)",
		);
	}

	// ─── (c) wall clock ──────────────────────────────────────────────
	{
		const wallTimeoutMs = 2_700_000;
		const base = { startedAtMs: 5_000, wallTimeoutMs };

		const below = decideWallAction({
			...base,
			nowMs: 5_000 + wallTimeoutMs - 1,
		});
		check(below.kind === "continue", "inside the wall budget → continue");

		const atBoundary = decideWallAction({
			...base,
			nowMs: 5_000 + wallTimeoutMs,
		});
		check(
			isAbort(atBoundary),
			"exactly the wall budget → abort (inclusive boundary)",
		);
		check(
			isAbort(atBoundary) && atBoundary.reason === "wall_timeout",
			"wall abort names its reason",
		);

		const beyond = decideWallAction({
			...base,
			nowMs: 5_000 + wallTimeoutMs * 2,
		});
		check(
			isAbort(beyond) && beyond.message === wallTimeoutMessage(wallTimeoutMs),
			"past the wall → abort",
		);
		check(
			wallTimeoutMessage(wallTimeoutMs).includes(String(wallTimeoutMs)) &&
				wallTimeoutMessage(wallTimeoutMs).includes(
					formatDurationMs(wallTimeoutMs),
				),
			"wall message names the limit (ms + human-readable)",
		);
	}

	// ─── (d) per-tool timeout ────────────────────────────────────────
	{
		const timeoutMs = 900_000;
		const base = { startedAtMs: 42_000, timeoutMs, toolName: "bash" };

		const below = decideToolTimeoutAction({
			...base,
			nowMs: 42_000 + timeoutMs - 1,
		});
		check(below.kind === "continue", "tool inside its bound → continue");

		const atBoundary = decideToolTimeoutAction({
			...base,
			nowMs: 42_000 + timeoutMs,
		});
		check(
			isAbort(atBoundary),
			"tool at exactly its bound → abort (inclusive boundary)",
		);
		check(
			isAbort(atBoundary) && atBoundary.reason === "tool_timeout",
			"tool abort names its reason",
		);

		const hung = decideToolTimeoutAction({
			...base,
			nowMs: 42_000 + timeoutMs * 5,
			toolName: "edit",
		});
		check(
			isAbort(hung) && hung.message === toolTimeoutMessage(timeoutMs, "edit"),
			"past the bound → abort",
		);
		check(
			toolTimeoutMessage(timeoutMs, "edit").includes("edit") &&
				toolTimeoutMessage(timeoutMs, "edit").includes(String(timeoutMs)),
			"tool-timeout message names the tool AND the bound",
		);
	}

	// ─── duration formatting (shared by every message builder) ───────
	{
		check(
			formatDurationMs(0) === "0ms",
			`0ms formats, got ${formatDurationMs(0)}`,
		);
		check(formatDurationMs(999) === "999ms", "sub-second stays ms");
		check(formatDurationMs(1_500) === "1s", "seconds floor");
		check(formatDurationMs(65_000) === "1m 5s", "minutes + remainder seconds");
		check(
			formatDurationMs(120_000) === "2m",
			"exact minutes drop the remainder",
		);
		check(formatDurationMs(3_600_000) === "1h", "exact hours");
		check(formatDurationMs(3_660_000) === "1h 1m", "hours + remainder minutes");
	}

	// ─── purity / determinism ────────────────────────────────────────
	{
		const samples: WatchdogAction[] = [
			decideSettleAction("settled", false, false),
			decideSettleAction("settled", false, true),
			decideNoProgressAction({
				nowMs: 10,
				lastActivityMs: 0,
				windowMs: 5,
				inFlightTool: false,
			}),
			decideWallAction({ nowMs: 10, startedAtMs: 0, wallTimeoutMs: 5 }),
			decideToolTimeoutAction({
				nowMs: 10,
				startedAtMs: 0,
				timeoutMs: 5,
				toolName: "bash",
			}),
		];
		const replay: WatchdogAction[] = [
			decideSettleAction("settled", false, false),
			decideSettleAction("settled", false, true),
			decideNoProgressAction({
				nowMs: 10,
				lastActivityMs: 0,
				windowMs: 5,
				inFlightTool: false,
			}),
			decideWallAction({ nowMs: 10, startedAtMs: 0, wallTimeoutMs: 5 }),
			decideToolTimeoutAction({
				nowMs: 10,
				startedAtMs: 0,
				timeoutMs: 5,
				toolName: "bash",
			}),
		];
		check(
			JSON.stringify(samples) === JSON.stringify(replay),
			"identical inputs decide identically",
		);
	}

	if (errors.length > 0) {
		throw new Error("test-watchdogs failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log(
		"✓ watchdogs: settle/no-progress/wall/tool-timeout pure decisions, messages, determinism",
	);
	return Promise.resolve();
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
