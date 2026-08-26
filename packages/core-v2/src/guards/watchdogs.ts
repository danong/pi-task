/**
 * Watchdogs — pure decision functions over observed session events +
 * elapsed time (M1.3 R1; contract FR-7/FR-8).
 *
 * These are PURE functions of the observed event stream and the
 * elapsed clock: no I/O, no timers, no side effects. Each returns a
 * typed action (`continue` | `nudge(text)` | `abort(reason, message)`)
 * and nothing else — the driver (watchdog-driver.ts) is the only
 * module allowed to carry out side effects from those actions.
 *
 * The taxonomy is a clean-room port of v1's "Hang protection" section
 * (docs/pi-task-design.md) for the session-host stream:
 *
 *   - settle-without-yield — the agent finished but never captured a
 *     yield: nudge once; a second settle still without one fails.
 *   - no-progress — no activity (turn/tool/error events all reset the
 *     clock) within the window aborts. An in-flight tool counts as
 *     progress, because a long silent bash/test tool is legitimate.
 *   - wall clock — the hard total cap, naming the limit.
 *   - per-tool timeout — a single tool execution past its own bound
 *     aborts, naming the tool (the hung tool the no-progress watchdog
 *     cannot see, since in-flight tools count as progress).
 *
 * Every limit is a named constant so bounds are readable configuration,
 * not inline magic.
 */

import type { SessionHostEvent } from "../sessions/host.ts";

/** The event vocabulary the watchdogs observe (verbatim host stream). */
export type WatchedEventType = SessionHostEvent["type"];

/** Discriminated reasons an abort can be raised. */
export type WatchdogAbortReason =
	"wall_timeout" | "no_progress" | "tool_timeout" | "settled_without_yield";

/**
 * A typed decision with no side effects. The driver turns `nudge` into
 * a reminder prompt, `abort` into a handle abort, and `continue` into a
 * no-op — the functions never touch the session themselves.
 */
export type WatchdogAction =
	| { readonly kind: "continue" }
	| { readonly kind: "nudge"; readonly text: string }
	| {
			readonly kind: "abort";
			readonly reason: WatchdogAbortReason;
			readonly message: string;
	  };

/** The `continue` singleton (no reason/message payload to carry). */
const CONTINUE: WatchdogAction = { kind: "continue" };

// ─── Named limits (defaults; overridable via the driver) ────────────

/** Hard wall-clock cap for a guarded session (~45m, v1 parity). */
export const DEFAULT_WATCHDOG_WALL_TIMEOUT_MS = 45 * 60_000;
/** No-progress window — deliberately far shorter than the wall budget so
 *  a hung session fails fast instead of burning the whole run (~10m). */
export const DEFAULT_WATCHDOG_NO_PROGRESS_TIMEOUT_MS = 10 * 60_000;
/** Per-tool-call budget bound for a single execution (~15m, v1 parity). */
export const DEFAULT_WATCHDOG_TOOL_TIMEOUT_MS = 15 * 60_000;
/** How often the timer-driven driver re-evaluates the time-based
 *  watchdogs (the settle watchdog is event-driven and never waits). */
export const DEFAULT_WATCHDOG_TICK_INTERVAL_MS = 10_000;
/** The reminder sent on a settle without a captured yield. */
export const DEFAULT_SETTLE_NUDGE_TEXT =
	"You finished your turn without calling the `yield` tool. If your work is " +
	"complete, call `yield` now to finalize; otherwise continue working.";

/**
 * Human-readable duration for watchdog messages (e.g. "45m", "1h 1m").
 * Pure — shared by every message builder so the reason text is stable.
 */
export function formatDurationMs(ms: number): string {
	if (ms < 1_000) return `${ms}ms`;
	const totalSeconds = Math.floor(ms / 1_000);
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 1) return `${totalSeconds}s`;
	const totalHours = Math.floor(totalMinutes / 60);
	if (totalHours < 1)
		return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
	const remainMinutes = totalMinutes % 60;
	return remainMinutes > 0
		? `${totalHours}h ${remainMinutes}m`
		: `${totalHours}h`;
}

/** Abort message for the wall-clock watchdog: names the limit. */
export function wallTimeoutMessage(timeoutMs: number): string {
	return (
		`Session wall-timeout: the run reached its full wall-clock budget of ` +
		`${formatDurationMs(timeoutMs)} (${timeoutMs} ms) without finishing.`
	);
}

/** Abort message for the no-progress watchdog: names the cause + window. */
export function noProgressMessage(windowMs: number): string {
	return (
		`Session aborted: no progress — no activity (turns, tool calls, or events) ` +
		`for ${formatDurationMs(windowMs)} (${windowMs} ms). The session appears hung; ` +
		`an in-flight tool call counts as progress, so only the per-tool watchdog ` +
		`can catch a tool that never returns.`
	);
}

/** Abort message for the per-tool watchdog: names the tool + bound. */
export function toolTimeoutMessage(
	timeoutMs: number,
	toolName: string,
): string {
	return (
		`Session aborted: tool "${toolName}" exceeded its per-tool-call budget of ` +
		`${formatDurationMs(timeoutMs)} (${timeoutMs} ms) — a hung tool the no-progress ` +
		`watchdog cannot see.`
	);
}

/** Abort message for the settle-without-yield watchdog. */
export function settledWithoutYieldMessage(): string {
	return (
		`Session aborted: settled twice without capturing a yield. The agent finished ` +
		`its turn but never called the \`yield\` tool, even after a reminder.`
	);
}

/**
 * (a) Settle-without-yield decision (pure).
 *
 * A non-settle event is a no-op. A settle with a captured yield needs no
 * reminder. The first settle without one nudges; the second still without
 * one aborts with the `settled_without_yield` reason.
 */
export function decideSettleAction(
	eventType: WatchedEventType,
	hasYielded: boolean,
	alreadyNudged: boolean,
): WatchdogAction {
	if (eventType !== "settled") return CONTINUE;
	if (hasYielded) return CONTINUE;
	if (alreadyNudged) {
		return {
			kind: "abort",
			reason: "settled_without_yield",
			message: settledWithoutYieldMessage(),
		};
	}
	return { kind: "nudge", text: DEFAULT_SETTLE_NUDGE_TEXT };
}

/**
 * (b) No-progress decision (pure): abort once the session has emitted no
 * activity at all for the full window. Any event resets the clock (the
 * driver owns that); an in-flight tool also counts as progress — a long
 * tool call may legitimately stream nothing, so only a session idle
 * BETWEEN tool calls can be deemed hung.
 */
export function decideNoProgressAction(opts: {
	nowMs: number;
	lastActivityMs: number;
	windowMs: number;
	/** Whether at least one tool is currently in flight. */
	inFlightTool: boolean;
}): WatchdogAction {
	if (opts.inFlightTool) return CONTINUE;
	if (opts.nowMs - opts.lastActivityMs >= opts.windowMs) {
		return {
			kind: "abort",
			reason: "no_progress",
			message: noProgressMessage(opts.windowMs),
		};
	}
	return CONTINUE;
}

/**
 * (c) Wall-clock decision (pure): abort when the run reaches its hard
 * budget. This is the total cap; the no-progress window is deliberately
 * shorter so a hung session fails fast before burning the whole wall.
 */
export function decideWallAction(opts: {
	nowMs: number;
	startedAtMs: number;
	wallTimeoutMs: number;
}): WatchdogAction {
	if (opts.nowMs - opts.startedAtMs >= opts.wallTimeoutMs) {
		return {
			kind: "abort",
			reason: "wall_timeout",
			message: wallTimeoutMessage(opts.wallTimeoutMs),
		};
	}
	return CONTINUE;
}

/**
 * (d) Per-tool timeout decision (pure): abort when the OLDEST in-flight
 * tool has been running for the full single-tool budget. The caller feeds
 * the oldest tool's start time; both no-progress (in-flight counts) and
 * the settle watchdog treat a hung tool as busy, so only this watchdog
 * catches a tool that never returns.
 */
export function decideToolTimeoutAction(opts: {
	nowMs: number;
	startedAtMs: number;
	timeoutMs: number;
	toolName: string;
}): WatchdogAction {
	if (opts.nowMs - opts.startedAtMs >= opts.timeoutMs) {
		return {
			kind: "abort",
			reason: "tool_timeout",
			message: toolTimeoutMessage(opts.timeoutMs, opts.toolName),
		};
	}
	return CONTINUE;
}
