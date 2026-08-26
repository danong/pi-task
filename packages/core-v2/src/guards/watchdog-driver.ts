/**
 * Watchdog driver — the thin stateful layer that consumes session-host
 * events + timers and APPLIES the pure decisions (M1.3 R2; FR-8).
 *
 * The pure watchdogs (watchdogs.ts) decide; this driver carries the
 * side effects. It owns exactly the mutable state those decisions need:
 * the run's start time, the last-activity time, the set of in-flight
 * tools (oldest = the one the per-tool watchdog times out), the
 * already-nudged flag, and the captured-yield flag. It never decides on
 * its own — every abort/nudge comes from a pure function.
 *
 * Both the clock and the re-evaluation timer are injected through
 * {@link WatchdogTimerSource}, so hermetic tests drive it deterministically:
 * a FakeTimerSource advances the clock and fires ticks on demand. The
 * system source (`systemTimerSource`) wraps Node's real setInterval.
 *
 * Wiring to a live session handle is provided by {@link attachWatchdogs}
 * (R2: "abort propagates to the session handle"); callers who already
 * hold a handle.subscribe subscription can drive the driver directly.
 */

import type { SessionHandle, SessionHostEvent } from "../sessions/host.ts";
import {
	decideNoProgressAction,
	decideSettleAction,
	decideToolTimeoutAction,
	decideWallAction,
	DEFAULT_SETTLE_NUDGE_TEXT,
	DEFAULT_WATCHDOG_NO_PROGRESS_TIMEOUT_MS,
	DEFAULT_WATCHDOG_TICK_INTERVAL_MS,
	DEFAULT_WATCHDOG_TOOL_TIMEOUT_MS,
	DEFAULT_WATCHDOG_WALL_TIMEOUT_MS,
} from "./watchdogs.ts";
import type { WatchdogAction } from "./watchdogs.ts";

/** Render a bound as a raw error message that names the tool. */
export type WatchdogTimerHandle = unknown;

/**
 * The timing surface a driver needs: a readable clock and a single
 * re-evaluating timer. Injection points for hermetic determinism.
 */
export interface WatchdogTimerSource {
	/** Monotonic-ish clock in milliseconds. */
	now(): number;
	/** Schedule `callback` every `intervalMs`; returns a handle. */
	setInterval(callback: () => void, intervalMs: number): WatchdogTimerHandle;
	/** Cancel a scheduled interval. */
	clearInterval(handle: WatchdogTimerHandle): void;
}

/** Real wall-clock + real repeating timer (produces the live watchdogs). */
export const systemTimerSource: WatchdogTimerSource = {
	now: () => Date.now(),
	setInterval: (callback, intervalMs) => {
		const handle = setInterval(callback, intervalMs);
		handle.unref?.();
		return handle;
	},
	clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/** Time-based watchdog bounds; each defaults to a named constant. */
export interface WatchdogLimits {
	wallTimeoutMs: number;
	noProgressTimeoutMs: number;
	toolTimeoutMs: number;
	tickIntervalMs: number;
}

export interface WatchdogDriverOptions {
	limits?: Partial<WatchdogLimits>;
	/** Injectable timer source (defaults to {@link systemTimerSource}). */
	timers?: WatchdogTimerSource;
	/** Side-effect sink: called on every applied action (primarily for
	 *  tests and for callers composing abort handling with attachWatchdogs). */
	onAction?: (action: WatchdogAction) => void;
	/** Overrides the nudge text the pure settle decision would carry. */
	nudgeText?: string;
}

/** Ends: a driver that has latched a terminal abort action. */
export type WatchdogEnd = Extract<WatchdogAction, { kind: "abort" }>;

interface InFlightTool {
	toolName: string;
	startedAtMs: number;
}

/**
 * Observable, event-driven watchdog state machine. Feed it
 * {@link SessionHostEvent}s via {@link onEvent} and re-evaluate the
 * time-based watchdogs via {@link tick} (the injected timer calls tick on
 * the tick interval; a fake can call it manually). Actions reach the
 * the caller via the onAction callback; abort latches the driver (a terminal,
 * no further events or ticks act) and clears the timer.
 */
export class WatchdogDriver {
	readonly #timers: WatchdogTimerSource;
	readonly #onAction: ((action: WatchdogAction) => void) | undefined;
	readonly #nudgeText: string;
	readonly limits: WatchdogLimits;

	#startedAtMs = 0;
	#lastActivityMs = 0;
	#running = false;
	#hasYielded = false;
	#nudged = false;
	readonly #inFlight = new Map<string, InFlightTool>();
	#terminal: WatchdogEnd | undefined;
	#lastEvent: SessionHostEvent | undefined;
	// The timers seam is deliberately opaque (its handle type is unknown);
	// `| undefined` distinguishes "no scheduled tick" from a live handle.
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	#timerHandle: WatchdogTimerHandle | undefined;
	#cleanups: Array<() => void> = [];

	constructor(options: WatchdogDriverOptions = {}) {
		this.limits = {
			wallTimeoutMs:
				options.limits?.wallTimeoutMs ?? DEFAULT_WATCHDOG_WALL_TIMEOUT_MS,
			noProgressTimeoutMs:
				options.limits?.noProgressTimeoutMs ??
				DEFAULT_WATCHDOG_NO_PROGRESS_TIMEOUT_MS,
			toolTimeoutMs:
				options.limits?.toolTimeoutMs ?? DEFAULT_WATCHDOG_TOOL_TIMEOUT_MS,
			tickIntervalMs:
				options.limits?.tickIntervalMs ?? DEFAULT_WATCHDOG_TICK_INTERVAL_MS,
		};
		this.#timers = options.timers ?? systemTimerSource;
		this.#onAction = options.onAction;
		this.#nudgeText = options.nudgeText ?? DEFAULT_SETTLE_NUDGE_TEXT;
	}

	/** Whether the watchdog is armed. */
	get running(): boolean {
		return this.#running;
	}

	/** The abort that latched this driver, if it has ended. */
	get terminal(): WatchdogEnd | undefined {
		return this.#terminal;
	}

	/** The last observed session event (feed to failure artifacts). */
	get lastEvent(): SessionHostEvent | undefined {
		return this.#lastEvent;
	}

	/** Whether a yield has been captured on this run. */
	get hasYielded(): boolean {
		return this.#hasYielded;
	}

	/** Register a cleanup to run at dispose (e.g. an unsubscriber). */
	onCleanup(cleanup: () => void): void {
		this.#cleanups.push(cleanup);
	}

	/** Arm the run: record the start time and start the tick timer.
	 *  Idempotent — a second call after an abort is a no-op. */
	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#startedAtMs = this.#timers.now();
		this.#lastActivityMs = this.#startedAtMs;
		this.#timerHandle = this.#timers.setInterval(
			() => this.tick(),
			this.limits.tickIntervalMs,
		);
	}

	/** Feed one session-host event.
	 *
	 * Any event counts as activity (resets the no-progress clock),
	 * including errors. toolStart/toolEnd track the in-flight stack; a
	 * settled event runs the settle-without-yield decision.
	 */
	onEvent(event: SessionHostEvent): void {
		if (this.#terminal || !this.#running) return;
		this.#lastEvent = event;
		this.#lastActivityMs = this.#timers.now();
		switch (event.type) {
			case "toolStart":
				this.#inFlight.set(event.toolCallId, {
					toolName: event.toolName,
					startedAtMs: this.#lastActivityMs,
				});
				break;
			case "toolEnd":
				this.#inFlight.delete(event.toolCallId);
				break;
			case "yielded":
				this.#hasYielded = true;
				break;
			case "turnStart":
			case "error":
				// Activity-only events: lastEvent/activity updated above.
				break;
			case "settled": {
				const action = decideSettleAction(
					event.type,
					this.#hasYielded,
					this.#nudged,
				);
				if (action.kind === "nudge") {
					this.#nudged = true;
					this.#emit({ kind: "nudge", text: this.#nudgeText });
				} else if (action.kind === "abort") {
					this.#latch(action);
				}
				break;
			}
			default:
				break;
		}
	}

	/** Re-evaluate the time-based watchdogs (wall, no-progress, per-tool).
	 *  The injected timer drives this on the tick interval; hermetic tests
	 *  drive it after advancing a fake clock. Abort latches the driver. */
	tick(): void {
		if (this.#terminal || !this.#running) return;
		const nowMs = this.#timers.now();

		const wall = decideWallAction({
			nowMs,
			startedAtMs: this.#startedAtMs,
			wallTimeoutMs: this.limits.wallTimeoutMs,
		});
		if (wall.kind === "abort") return this.#latch(wall);

		const progress = decideNoProgressAction({
			nowMs,
			lastActivityMs: this.#lastActivityMs,
			windowMs: this.limits.noProgressTimeoutMs,
			inFlightTool: this.#inFlight.size > 0,
		});
		if (progress.kind === "abort") return this.#latch(progress);

		if (this.#inFlight.size > 0) {
			const oldest = this.#inFlight.values().next().value;
			if (oldest !== undefined) {
				const tool = decideToolTimeoutAction({
					nowMs,
					startedAtMs: oldest.startedAtMs,
					timeoutMs: this.limits.toolTimeoutMs,
					toolName: oldest.toolName,
				});
				if (tool.kind === "abort") return this.#latch(tool);
			}
		}
	}

	/** Stop the timer and run registered cleanups. Idempotent. */
	dispose(): void {
		if (
			!this.#running &&
			this.#timerHandle === undefined &&
			this.#cleanups.length === 0
		) {
			return;
		}
		this.#running = false;
		this.#stopTimer();
		const cleanups = this.#cleanups.splice(0);
		for (const cleanup of cleanups) {
			cleanup();
		}
	}

	#stopTimer(): void {
		if (this.#timerHandle !== undefined) {
			this.#timers.clearInterval(this.#timerHandle);
			this.#timerHandle = undefined;
		}
	}

	/** Terminal actions fire once and then stop the run. */
	#latch(action: Extract<WatchdogAction, { kind: "abort" }>): void {
		if (this.#terminal) return;
		this.#terminal = action;
		this.#stopTimer();
		this.#emit(action);
	}

	#emit(action: WatchdogAction): void {
		this.#onAction?.(action);
	}
}

/** The live wiring returned by {@link attachWatchdogs}. */
export interface WatchdogHandle {
	readonly driver: WatchdogDriver;
	/** Unsubscribe from the session and stop the watchdogs. */
	dispose(): void;
}

/**
 * Attach a {@link WatchdogDriver} to a real session handle (R2: abort
 * propagates to the session handle).
 *
 * Wires the handle's event stream into the driver, subscribes the driver's
 * own timer source on the tick interval, and carries out the side effects
 * the pure decisions requested: a nudge issues a reminder prompt on the
 * handle, an abort calls `handle.abort()`. Callers may still observe every
 * action via `options.onAction` (for diagnostics / failure artifacts).
 *
 * Session-managing aspects that end in an abort or a nudge are inherently
 * best-effort: if the session is already closed the underlying promise
 * rejects, which surfaces as a host `error` event rather than a crash.
 */
export function attachWatchdogs(
	handle: SessionHandle,
	options: WatchdogDriverOptions = {},
): WatchdogHandle {
	const userOnAction = options.onAction;
	const driver = new WatchdogDriver({
		...options,
		onAction: (action) => {
			if (action.kind === "nudge") {
				void handle.prompt(action.text).catch(() => {
					/* A rejected nudge prompt already surfaces as a host error event. */
				});
			} else if (action.kind === "abort") {
				void handle.abort().catch(() => {
					/* Abort races a session shutdown; the host emits its own error. */
				});
			}
			userOnAction?.(action);
		},
	});
	const unsubscribe = handle.subscribe((event) => driver.onEvent(event));
	driver.onCleanup(unsubscribe);
	driver.start();
	return {
		driver,
		dispose: () => driver.dispose(),
	};
}
