/**
 * Hermetic tests for the watchdog driver (M1.3 R2 — docs/pi-task-v2.md
 * FR-8). Consumes session-host events + timers, applies the pure
 * watchdog decisions, and routes side effects (nudge → handle.prompt,
 * abort → handle.abort) through attachWatchdogs (R2: "abort propagates
 * to the session handle").
 *
 * Fully deterministic: a FakeTimerSource advances an in-memory clock and
 * fires the injected tick timer on demand — no wall-clock sleeps.
 *
 * Standalone: npx tsx packages/core-v2/test/test-watchdog-driver.ts
 */

import { pathToFileURL } from "node:url";

import {
	attachWatchdogs,
	WatchdogDriver,
} from "../src/guards/watchdog-driver.ts";
import type {
	WatchdogTimerSource,
	WatchdogTimerHandle,
} from "../src/guards/watchdog-driver.ts";
import type { WatchdogAction } from "../src/guards/watchdogs.ts";
import type {
	SessionHandle,
	SessionHostEvent,
	SessionHostEventListener,
} from "../src/sessions/host.ts";
import type { Yield } from "../src/contracts/index.ts";

const YIELDED_EVENT: SessionHostEvent = {
	type: "yielded",
	payload: {
		files_changed: [],
		summary: "done",
		commit_ids: [],
		deviations: [],
	} satisfies Yield,
};

/**
 * Deterministic timer source: an in-memory clock and a single-tick
 * re-evaluation. `advance(ms)` moves the clock and fires every registered
 * interval once at the new time — enough because decisions, not the tick
 * count, drive behavior.
 */
class FakeTimers implements WatchdogTimerSource {
	nowMs = 0;
	#scheduled = new Map<number, () => void>();
	#nextId = 1;

	now(): number {
		return this.nowMs;
	}
	setInterval(callback: () => void): WatchdogTimerHandle {
		const id = this.#nextId++;
		this.#scheduled.set(id, callback);
		return id;
	}
	clearInterval(handle: WatchdogTimerHandle): void {
		this.#scheduled.delete(handle as number);
	}
	advance(ms: number): void {
		this.nowMs += ms;
		for (const cb of [...this.#scheduled.values()]) cb();
	}
	get activeTimers(): number {
		return this.#scheduled.size;
	}
}

/** Bulk driver limits with a long tool bound, so only the probe under test trips. */
interface FakeRig {
	handle: SessionHandle;
	prompts: string[];
	aborts: { count: number };
	actions: WatchdogAction[];
	emit: (event: SessionHostEvent) => void;
}

/** A session handle stub that records prompts/aborts it is asked to perform. */
function makeFakeHandle(): FakeRig {
	const listeners = new Set<SessionHostEventListener>();
	const prompts: string[] = [];
	const actions: WatchdogAction[] = [];
	const aborts = { count: 0 };
	const handle: SessionHandle = {
		role: "fake",
		model: { provider: "p", modelId: "m" },
		result: undefined,
		stats: () => Promise.reject(new Error("no stats in watchdog tests")),
		setModel: () => {
			throw new Error("setModel not expected in watchdog tests");
		},
		prompt: (text: string) => {
			prompts.push(text);
			return Promise.resolve();
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		abort: () => {
			aborts.count += 1;
			return Promise.resolve();
		},
		close: () => {},
	};
	return {
		handle,
		prompts,
		aborts,
		actions,
		emit: (event) => {
			for (const listener of [...listeners]) listener(event);
		},
	};
}

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// ─── Settle-without-yield: nudge once, abort on the second settle ──
	{
		const timers = new FakeTimers();
		const actions: WatchdogAction[] = [];
		const driver = new WatchdogDriver({
			timers,
			onAction: (a) => actions.push(a),
		});
		driver.start();

		driver.onEvent({ type: "turnStart" });
		driver.onEvent({ type: "settled" });
		check(
			actions.length === 1 && actions[0]?.kind === "nudge",
			`first settle → one nudge, got ${JSON.stringify(actions)}`,
		);

		driver.onEvent({ type: "turnStart" });
		driver.onEvent({ type: "settled" });
		check(
			actions.length === 2 &&
				actions[1]?.kind === "abort" &&
				actions[1].kind === "abort" &&
				actions[1].reason === "settled_without_yield",
			`second settle → abort(settled_without_yield), got ${JSON.stringify(actions[1])}`,
		);
		check(
			driver.terminal?.kind === "abort" &&
				driver.terminal.reason === "settled_without_yield",
			"driver latches the terminal abort",
		);

		// Latched: further events and ticks act no more.
		driver.onEvent({ type: "turnStart" });
		driver.onEvent({ type: "settled" });
		timers.advance(100_000);
		check(
			actions.length === 2,
			"after streaming becomes 2 actions, not resettled",
		);
		driver.dispose();
	}

	// ─── Settled + captured yield is never nagged ─────────────────────
	{
		const timers = new FakeTimers();
		const actions: WatchdogAction[] = [];
		const driver = new WatchdogDriver({
			timers,
			onAction: (a) => actions.push(a),
		});
		driver.start();

		driver.onEvent({ type: "settled" });
		check(
			actions.length === 1 && actions[0]?.kind === "nudge",
			"first settle nudges",
		);
		driver.onEvent(YIELDED_EVENT);
		driver.onEvent({ type: "settled" });
		check(
			actions.length === 1,
			`yielded run → no second nudge/abort, got ${actions.length}`,
		);
		check(driver.hasYielded === true, "driver records the captured yield");
		driver.dispose();
	}

	// ─── No-progress: any event resets the clock; none trips it ────────
	{
		const timers = new FakeTimers();
		const actions: WatchdogAction[] = [];
		const driver = new WatchdogDriver({
			timers,
			onAction: (a) => actions.push(a),
			limits: { noProgressTimeoutMs: 300 },
		});
		driver.start();

		// Activity every 200ms within the 300ms window → stays alive.
		for (let i = 0; i < 10; i++) {
			timers.advance(200);
			driver.onEvent({ type: "turnStart" });
		}
		check(
			driver.running && actions.every((a) => a.kind !== "abort"),
			"repeated activity inside the window never trips no-progress",
		);

		// Go quiet past the window → abort.
		timers.advance(400);
		check(
			actions.length === 1 &&
				actions[0]?.kind === "abort" &&
				actions[0].kind === "abort" &&
				actions[0].reason === "no_progress",
			`silence past the window aborts no_progress, got ${JSON.stringify(actions[0])}`,
		);
		driver.dispose();
	}

	// ─── In-flight tool: no-progress sleeps, per-tool watchdog watches ──
	{
		const timers = new FakeTimers();
		const actions: WatchdogAction[] = [];
		const driver = new WatchdogDriver({
			timers,
			onAction: (a) => actions.push(a),
			limits: {
				noProgressTimeoutMs: 100,
				toolTimeoutMs: 500,
				wallTimeoutMs: 3_600_000,
				tickIntervalMs: 1_000,
			},
		});
		driver.start();

		driver.onEvent({ type: "toolStart", toolName: "bash", toolCallId: "c1" });
		timers.advance(200); // past no-progress (100), inside tool bound (500)
		check(
			driver.running && actions.length === 0,
			`in-flight tool suppresses the no-progress abort, got ${JSON.stringify(actions)}`,
		);

		// Past the per-tool bound → abort naming the tool.
		timers.advance(400); // cumulative 600 > tool bound 500
		check(
			actions.length === 1 &&
				actions[0]?.kind === "abort" &&
				actions[0].kind === "abort" &&
				actions[0].reason === "tool_timeout" &&
				actions[0].kind === "abort" &&
				actions[0].message.includes("bash"),
			`hung in-flight tool aborts tool_timeout naming the tool, got ${JSON.stringify(actions[0])}`,
		);
		check(driver.terminal?.kind === "abort", "driver terminal latched");
		driver.dispose();
	}

	// ─── Tool ending before its bound clears the per-tool watchdog ─────
	{
		const timers = new FakeTimers();
		const actions: WatchdogAction[] = [];
		const driver = new WatchdogDriver({
			timers,
			onAction: (a) => actions.push(a),
			limits: {
				noProgressTimeoutMs: 100,
				toolTimeoutMs: 500,
				wallTimeoutMs: 3_600_000,
				tickIntervalMs: 1_000,
			},
		});
		driver.start();

		driver.onEvent({ type: "toolStart", toolName: "bash", toolCallId: "c1" });
		driver.onEvent({
			type: "toolEnd",
			toolName: "bash",
			toolCallId: "c1",
			isError: false,
		});
		timers.advance(90_000);
		check(
			actions.length === 1 &&
				actions[0]?.kind === "abort" &&
				actions[0].kind === "abort" &&
				actions[0].reason === "no_progress",
			`a returned tool stops masking the no-progress watchdog, got ${JSON.stringify(actions[0])}`,
		);
		driver.dispose();
	}

	// ─── Wall clock: hard cap wins even with the tool in flight ────────
	{
		const timers = new FakeTimers();
		const actions: WatchdogAction[] = [];
		const driver = new WatchdogDriver({
			timers,
			onAction: (a) => actions.push(a),
			limits: {
				noProgressTimeoutMs: 3_600_000,
				toolTimeoutMs: 3_600_000,
				wallTimeoutMs: 500,
				tickIntervalMs: 1_000,
			},
		});
		driver.start();
		driver.onEvent({ type: "toolStart", toolName: "bash", toolCallId: "c1" });
		timers.advance(600);
		check(
			actions.length === 1 &&
				actions[0]?.kind === "abort" &&
				actions[0].kind === "abort" &&
				actions[0].reason === "wall_timeout",
			`wall expiry aborts wall_timeout even with the tool in flight, got ${JSON.stringify(actions[0])}`,
		);
		driver.dispose();
	}

	// ─── attachWatchdogs propagates abort to the session handle ───────
	{
		const timers = new FakeTimers();
		const rig = makeFakeHandle();
		const attached = attachWatchdogs(rig.handle, {
			timers,
			limits: {
				noProgressTimeoutMs: 3_600_000,
				toolTimeoutMs: 3_600_000,
				wallTimeoutMs: 500,
				tickIntervalMs: 1_000,
			},
			onAction: (a) => rig.actions.push(a),
		});

		rig.emit({ type: "settled" });
		check(
			rig.prompts.length === 1 && rig.actions.some((a) => a.kind === "nudge"),
			"settle nudge reaches the handle as a reminder prompt",
		);
		rig.emit({ type: "settled" });
		check(
			rig.aborts.count === 1,
			"second settle propagates a handle.abort() to the session handle",
		);
		check(
			rig.actions.filter((a) => a.kind === "abort").length === 1,
			"abort action observable to the caller",
		);

		// Latched: nothing further reaches the handle.
		rig.emit({ type: "turnStart" });
		timers.advance(100_000);
		check(
			rig.aborts.count === 1 && rig.prompts.length === 1,
			"post-abort events/timers no longer reach the handle",
		);

		attached.dispose();
		rig.emit({ type: "settled" });
		timers.advance(10_000);
		check(
			rig.prompts.length === 1 && rig.aborts.count === 1,
			"dispose unsubscribes and stops the timer",
		);
	}

	// ─── Engine settlement observes settle without another prompt ─────
	{
		const timers = new FakeTimers();
		const rig = makeFakeHandle();
		const attached = attachWatchdogs(rig.handle, {
			timers,
			settledAction: "observe",
			onAction: (action) => rig.actions.push(action),
		});
		rig.emit({ type: "settled" });
		check(
			rig.prompts.length === 0 && rig.actions.length === 0,
			"observe-only settlement issues no nudge or extra model prompt",
		);
		attached.dispose();
	}

	// ─── Deterministic purity at the driver seam ──────────────────────
	// (The driver is only as good as the pure functions it consults; those
	// are covered exhaustively in test-watchdogs.ts. Here we just confirm a
	// non-terminal events stream never surprised the driver from a cold start.)
	{
		const timers = new FakeTimers();
		const actions: WatchdogAction[] = [];
		const driver = new WatchdogDriver({
			timers,
			onAction: (a) => actions.push(a),
		});
		driver.start();
		driver.onEvent({ type: "error", message: "boom", code: "prompt_failed" });
		driver.onEvent({
			type: "toolEnd",
			toolName: "write",
			toolCallId: "x",
			isError: true,
		});
		check(
			actions.length === 0 && driver.running,
			"errors/unknown toolEnd idempotent from a cold state",
		);
		driver.dispose();
	}

	if (errors.length > 0) {
		return Promise.reject(
			new Error("test-watchdog-driver failed:\n  ✗ " + errors.join("\n  ✗ ")),
		);
	}
	console.log(
		"✓ watchdog-driver: settle/nudge, no-progress, per-tool, wall, abort propagation, dispose",
	);
	return Promise.resolve();
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests()
		.then(() => process.exit(0))
		.catch((err: unknown) => {
			console.error(err instanceof Error ? err.message : err);
			process.exit(1);
		});
}
