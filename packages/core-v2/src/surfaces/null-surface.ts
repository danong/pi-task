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
 *   - receipts: Receipt / Escalation   (cron, CI)
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
	SurfaceEvent,
	SurfaceStream,
	SubscriptionLevel,
} from "../contracts/control-surface.ts";
import type { TaskGateway } from "../contracts/task-plugin.ts";
import type { TaskLifecycleEvent } from "../contracts/gateway-events.ts";
import type { TaskReceipt } from "../contracts/payloads.ts";

/** Which surface-event discriminants each QoS level delivers (a partition
 *  of the single SurfaceEvent union: delta ⊃ digest ⊃ receipts). */
export const SURFACE_LEVEL_EVENTS: Record<
	SubscriptionLevel,
	readonly SurfaceEvent["type"][]
> = {
	delta: [
		"TurnDelta",
		"ToolActivity",
		"PermissionRequest",
		"Receipt",
		"Escalation",
	],
	digest: ["ToolActivity", "PermissionRequest", "Receipt", "Escalation"],
	receipts: ["Receipt", "Escalation"],
};

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

	// Session scoping (review M4 P0-2): events carrying a session id must
	// match the subscribed session, and terminal task.* verdicts must CARRY
	// the subscribed session's id — the emitting runner stamps it on the
	// event, so a receipts listener on s1 never sees another concurrent
	// task's outcome, nor an unscoped aggregate row.
	const isTerminalTask =
		event.type === "task.completed" ||
		event.type === "task.failed" ||
		event.type === "task.escalated";
	if (
		("sessionId" in event ? event.sessionId !== sessionId : false) ||
		(isTerminalTask && !("sessionId" in event))
	) {
		return out;
	}

	switch (event.type) {
		case "task.completed":
		case "task.failed":
		// Terminal verdict → Receipt carrying that verdict (review M4 P2-4):
		// task.failed is TERMINAL — it maps to Receipt(verdict:"failed"),
		// never to Escalation, so a cron surface distinguishes give-up from
		// needs-a-human by event type alone.
		case "task.escalated": {
			const receipt = emptyUsageReceipt(
				event.taskId,
				event.type === "task.completed"
					? event.detail.verdict
					: event.type === "task.failed"
						? "failed"
						: event.detail.verdict,
			);
			push(out, { type: "Receipt", receipt });
			if (event.type === "task.escalated") {
				// Only task.escalated is retryable/needs-human → Escalation.
				push(out, {
					type: "Escalation",
					taskId: event.taskId,
					reason: event.detail.verdict,
				});
			}
			break;
		}
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
		case "permission.requested": {
			// Session-scoped protocol event (now part of the typed vocabulary):
			// surfaced as a digest/delta-grade PermissionRequest. The generic
			// sessionId filter above already dropped other sessions.
			push(out, {
				type: "PermissionRequest",
				requestId: event.requestId,
				action: event.action,
				detail: event.detail,
			});
			break;
		}
		case "task.queued":
		case "task.routed":
		case "verify.completed":
		case "review.completed":
		case "merge.completed":
		case "merge.conflict":
			// queued/routed/verify/review/merge: no surface event. StatusSnapshot
			// is daemon state (model/tier/activeTasks); projecting it from a
			// lifecycle point would fabricate values (review M4 P2-3), so the
			// headless adapter stays silent until real daemon state has an
			// emission path.
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
function emptyUsageReceipt(
	taskId: string,
	verdict: "ship" | "escalate" | "failed",
): TaskReceipt {
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
		// Waiter QUEUE (review M4 P2-2): overlapping next() calls each get
		// their own resolver so none starves the other — a single wake slot
		// let a second concurrent next() orphan the first.
		const waiters: Array<() => void> = [];
		let closed = false;

		const deliver = (event: SurfaceEvent): void => {
			if (!allowed.has(event.type)) return;
			queue.push(event);
			while (waiters.length > 0) {
				waiters.shift()!();
			}
		};

		const handle = (raw: unknown): void => {
			const event = raw as TaskLifecycleEvent;
			for (const mapped of projectLifecycleEvent(event, sessionId, level))
				deliver(mapped);
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
									waiters.push(resolve);
								});
							}
						},
					};
				},
			},
			send(): void {
				// Headless: upstream commands are intentionally inert. An
				// interactive surface forwards Approve/UserMessage/etc. to
				// the hosting daemon instead.
			},
			close(): void {
				if (closed) return;
				closed = true;
				unsubscribe();
				while (waiters.length > 0) {
					waiters.shift()!();
				}
			},
		};
	}
}

/** Convenience factory: a named headless surface over `gateway`. */
export function createNullSurface(
	gateway: TaskGateway,
	name = "null",
): ControlSurface {
	return new NullSurface({ gateway, name });
}
