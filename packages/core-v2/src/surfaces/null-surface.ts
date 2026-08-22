/**
 * Null/headless ControlSurface adapter — subsystems §3b (M4a/M4b).
 *
 * The correct default surface for this milestone: witnesses the
 * TaskGateway event stream without owning sessions and without claiming
 * interactivity. `connect(sessionId, level)` subscribes to the gateway at
 * the requested QoS level via on(pattern, handler) and yields typed
 * SurfaceStream events — a coarsening view of the SAME stream
 * (delta ⊃ digest ⊃ receipts):
 *
 *   - receipts: Receipt / Escalation / StatusSnapshot   (cron, CI)
 *   - digest:   receipts + ToolActivity / PermissionRequest (Discord-like)
 *   - delta:    digest + TurnDelta                       (TUI-like)
 *
 * PermissionRequest protocol from the SDK session host is routed THROUGH
 * the gateway as an additive `permission.requested` event (the vocabulary
 * is add-only by contract); this adapter narrows it defensively and only
 * forwards it when the session ids match. The headless surface declares
 * interactivePermissions=false in capabilities() — it observes permission
 * requests at delta/digest but never claims to answer them interactively.
 *
 * Imports stay at the seam: gateway + contracts only — no daemon
 * internals.
 */

import type {
	ControlSurface,
	SurfaceCapabilities,
	SurfaceCommand,
	SurfaceEvent,
	SurfaceStream,
	SubscriptionLevel,
} from "../contracts/control-surface.ts";
import type { TaskGateway } from "../contracts/task-plugin.ts";
import type { TaskLifecycleEvent } from "../contracts/gateway-events.ts";
import type { TaskReceipt } from "../contracts/payloads.ts";

/** Which surface-event discriminants each QoS level delivers (a partition
 *  of the single SurfaceEvent union: delta ⊃ digest ⊃ receipts). */
export const SURFACE_LEVEL_EVENTS: Record<SubscriptionLevel, readonly string[]> = {
	delta: ["TurnDelta", "ToolActivity", "PermissionRequest", "Receipt", "Escalation", "StatusSnapshot"],
	digest: ["ToolActivity", "PermissionRequest", "Receipt", "Escalation", "StatusSnapshot"],
	receipts: ["Receipt", "Escalation", "StatusSnapshot"],
};

/**
 * Additive permission-protocol event crossing the gateway. Rides the
 * gateway's versioned add-only event channel until the kernel vocabulary
 * absorbs it; the adapter narrows structurally so it compiles against the
 * frozen TaskLifecycleEvent union.
 */
export interface PermissionRequestEvent {
	type: "permission.requested";
	taskId: string;
	sessionId: string;
	requestId: string;
	action: string;
	detail: string;
}

function isPermissionRequest(event: unknown): event is PermissionRequestEvent {
	return (
		typeof event === "object" &&
		event !== null &&
		(event as { type?: unknown }).type === "permission.requested"
	);
}

/** Gateway subscription pattern per QoS level: receipts cares about the
 *  task family only; digest/delta take the full stream. */
function patternFor(level: SubscriptionLevel): string {
	return level === "receipts" ? "task.*" : "*";
}

/**
 * Pure projection: gateway lifecycle event → zero or more SurfaceEvents,
 * filtered by subscription level. Exported for hermetic testing of the
 * mapping independent of the streaming machinery.
 */
export function projectLifecycleEvent(
	event: TaskLifecycleEvent,
	sessionId: string,
	level: SubscriptionLevel,
): SurfaceEvent[] {
	const allowed = new Set(SURFACE_LEVEL_EVENTS[level]);
	const push = (out: SurfaceEvent[], e: SurfaceEvent): void => {
		if (allowed.has(e.type)) out.push(e);
	};

	const out: SurfaceEvent[] = [];

	// Session-scoped events are filtered to the subscribed session.
	if ("sessionId" in event && event.sessionId !== sessionId) return out;

	switch (event.type) {
		case "task.completed":
			push(out, { type: "Receipt", receipt: emptyUsageReceipt(event.taskId, event.detail.verdict) });
			break;
		case "task.failed":
			push(out, { type: "Escalation", taskId: event.taskId, reason: event.detail.cause, detail: event.detail.cause });
			break;
		case "task.escalated":
			push(out, { type: "Escalation", taskId: event.taskId, reason: event.detail.verdict, detail: event.detail.verdict });
			push(out, { type: "Receipt", receipt: emptyUsageReceipt(event.taskId, event.detail.verdict) });
			break;
		case "session.spawned":
		case "session.yielded":
		case "session.exhausted": {
			// Digest-grade tool activity: phase derives from the lifecycle
			// point (spawned = start, yielded/exhausted = done).
			push(out, {
				type: "ToolActivity",
				tool: "session",
				argsPreview: event.sessionId,
				phase: event.type === "session.spawned" ? "start" : "done",
			});
			break;
		}
		default:
			// queued/routed/verify/review/merge: liveness snapshot only —
			// receipts-level subscribers get a heartbeat without volume.
			push(out, { type: "StatusSnapshot", model: "unknown", tier: "unknown", activeTasks: 1 });
			break;
	}
	return out;
}

/**
 * Verdict-level receipt for the surface stream. Usage counters (turns/
 * tokens/cost/cor) live ledger-side per the deterministic-envelope rule;
 * they are zeroed here rather than guessed — an interactive surface can
 * enrich via gateway.getTaskState/getManifest reads.
 */
function emptyUsageReceipt(taskId: string, verdict: "ship" | "escalate" | "failed"): TaskReceipt {
	return {
		taskId,
		verdict,
		filesChanged: 0,
		commitIds: [],
		turns: 0,
		costUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cor: 0,
		bundleHit: null,
	};
}

export interface NullSurfaceOptions {
	gateway: TaskGateway;
	/** Advertised name (defaults to "null"). */
	name?: string;
}

/** Headless ControlSurface over a TaskGateway. */
export class NullSurface implements ControlSurface {
	readonly name: string;
	private readonly gateway: TaskGateway;

	constructor(options: NullSurfaceOptions) {
		this.name = options.name ?? "null";
		this.gateway = options.gateway;
	}

	capabilities(): SurfaceCapabilities {
		return {
			// Headless: observes permission requests as protocol but cannot
			// render interactive modals, carry attachments, or demand low
			// latency — the daemon may batch freely up to this bound.
			interactivePermissions: false,
			attachments: false,
			latencyToleranceMs: 1000,
		};
	}

	connect(sessionId: string, level: SubscriptionLevel): SurfaceStream {
		const allowed = new Set(SURFACE_LEVEL_EVENTS[level]);
		const queue: SurfaceEvent[] = [];
		let wake: (() => void) | null = null;
		let closed = false;

		const deliver = (event: SurfaceEvent): void => {
			if (!allowed.has(event.type)) return;
			queue.push(event);
			if (wake !== null) {
				const w = wake;
				wake = null;
				w();
			}
		};

		const handle = (raw: unknown): void => {
			if (isPermissionRequest(raw)) {
				if (raw.sessionId !== sessionId) return;
				deliver({
					type: "PermissionRequest",
					requestId: raw.requestId,
					action: raw.action,
					detail: raw.detail,
				});
				return;
			}
			const event = raw as TaskLifecycleEvent;
			for (const mapped of projectLifecycleEvent(event, sessionId, level)) deliver(mapped);
		};

		const unsubscribe = this.gateway.on(patternFor(level), handle);

		return {
			events: {
				[Symbol.asyncIterator](): AsyncIterator<SurfaceEvent> {
					return {
						async next(): Promise<IteratorResult<SurfaceEvent>> {
							while (true) {
								if (queue.length > 0) {
									return { value: queue.shift()!, done: false };
								}
								if (closed) return { value: undefined as never, done: true };
								await new Promise<void>((resolve) => {
									wake = resolve;
								});
							}
						},
					};
				},
			},
			send(_command: SurfaceCommand): void {
				// Headless: upstream commands are intentionally inert. An
				// interactive surface forwards Approve/UserMessage/etc. to
				// the hosting daemon instead.
			},
			close(): void {
				if (closed) return;
				closed = true;
				unsubscribe();
				if (wake !== null) {
					const w = wake;
					wake = null;
					w();
				}
			},
		};
	}
}

/** Convenience factory: a named headless surface over `gateway`. */
export function createNullSurface(gateway: TaskGateway, name = "null"): ControlSurface {
	return new NullSurface({ gateway, name });
}
