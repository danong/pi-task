/**
 * In-memory TaskGateway — subsystems §3 / R3.
 *
 * Usable by tests AND the daemon without owning a SQLite file: reads are
 * backed by whatever LedgerStore instance the caller supplies (a temp-dir
 * store in tests, the daemon's live store in production), or by a small
 * rows double for stores-free hermetic tests. Reads touch ONLY ledger
 * tables (tasks / micro_sessions / routing_feedback where relevant) —
 * never any in-memory transcript.
 *
 * Thread-safety-by-construction (R3): the only mutable state is the
 * append-only event list and the handler set; handlers run synchronously
 * on emit in subscription order; unsubscribe removes exactly its own
 * handler (idempotent, safe during dispatch).
 *
 * Dispatch isolation (R4's M4b rule): a throwing handler is caught per
 * call, reported through the configured sink (console.error by default),
 * and later subscribers still receive the event.
 */

import type {
	TaskGateway,
	TaskLedgerRow,
	RunManifest,
} from "../contracts/task-plugin.ts";
import type {
	EventPattern,
	TaskLifecycleEvent,
	Unsubscribe,
} from "../contracts/gateway-events.ts";
import {
	eventMatchesPattern,
	eventTypeOf,
} from "../contracts/gateway-events.ts";
import type { LedgerStore } from "../ledger/store.ts";
import { GatewayError } from "./errors.ts";

interface Subscription {
	readonly pattern: EventPattern;
	readonly handler: (event: TaskLifecycleEvent) => void;
}

export interface InMemoryTaskGatewayOptions {
	/** The ledger backing the narrow reads (tasks/micro_sessions rows). */
	store?: LedgerStore | undefined;
	/**
	 * Store-less hermetic mode: supply the read table directly. Mutually
	 * exclusive with `store` — constructing with both fails typed.
	 */
	rows?: { tasks: Map<string, TaskLedgerRow> } | undefined;
	/** Sink for handler-failure logs (defaults to console.error). */
	onHandlerError?: ((err: unknown) => void) | undefined;
}

export class InMemoryTaskGateway implements TaskGateway {
	private readonly events: TaskLifecycleEvent[] = [];
	private readonly subscriptions = new Set<Subscription>();

	constructor(private readonly options: InMemoryTaskGatewayOptions = {}) {
		if (options.rows !== undefined && options.store !== undefined) {
			throw new GatewayError(
				"unknown_task",
				"InMemoryTaskGateway: supply either rows or store, not both",
			);
		}
	}

	// ─── events ────────────────────────────────────────────────────────

	emit(event: TaskLifecycleEvent): void {
		// eventTypeOf doubles as the exhaustive-switch guard: an unknown
		// discriminant cannot reach here (add-only versioning, R1).
		void eventTypeOf(event);
		this.events.push(event);
		for (const sub of [...this.subscriptions]) {
			if (!eventMatchesPattern(event.type, sub.pattern)) continue;
			try {
				sub.handler(event);
			} catch (err) {
				const sink =
					this.options.onHandlerError ??
					((e: unknown) => console.error("gateway: handler failed", e));
				sink(err);
			}
		}
	}

	on(
		pattern: EventPattern,
		handler: (event: TaskLifecycleEvent) => void,
	): Unsubscribe {
		const sub: Subscription = { pattern, handler };
		this.subscriptions.add(sub);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			this.subscriptions.delete(sub);
		};
	}

	/** Snapshot of every emitted event, oldest first (audit use). */
	listEvents(): readonly TaskLifecycleEvent[] {
		return this.events;
	}

	// ─── narrow ledger-only reads (never transcripts) ──────────────────

	getTaskState(taskId: string): Promise<TaskLedgerRow> {
		if (this.options.rows !== undefined) {
			const row = this.options.rows.tasks.get(taskId);
			if (row === undefined) {
				throw new GatewayError(
					"unknown_task",
					`getTaskState: unknown taskId "${taskId}"`,
				);
			}
			return Promise.resolve(structuredClone(row));
		}
		const task = this.requireStore().getTask(taskId);
		if (task === null) {
			throw new GatewayError(
				"unknown_task",
				`getTaskState: unknown taskId "${taskId}"`,
			);
		}
		return Promise.resolve(structuredClone(task));
	}

	getManifest(taskId: string): Promise<RunManifest> {
		const store = this.requireStore();
		const task = store.getTask(taskId);
		if (task === null) {
			throw new GatewayError(
				"unknown_task",
				`getManifest: unknown taskId "${taskId}"`,
			);
		}
		// Manifest assembly reads micro_sessions metadata only (status/
		// turnCount) — the yield_payload transcript column is deliberately
		// never selected.
		const sessions = store.listSessions(taskId);
		return Promise.resolve({
			taskId: task.id,
			runId: task.id,
			totals: { costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
			verifyPassed: task.status === "completed",
			detail: {
				sessions: sessions.map((s) => ({
					id: s.id,
					role: s.role,
					status: s.status,
				})),
			},
		});
	}

	private requireStore(): LedgerStore {
		if (this.options.store === undefined) {
			throw new GatewayError(
				"unknown_task",
				"InMemoryTaskGateway: constructed with rows — ledger-backed reads need a store",
			);
		}
		return this.options.store;
	}
}
