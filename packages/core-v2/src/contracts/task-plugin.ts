/**
 * Seam 5/6 — Lifecycle & trigger plugins (subsystems §3; FR-2/FR-11).
 *
 * The buildability contract, specified BEFORE any plugin code exists:
 * a plugin is one file, one default export implementing TaskPlugin,
 * loaded by path from config (no discovery magic); every plugin has one
 * hermetic test exercising its REAL path; no shared mutable state — all
 * interaction with the engine goes through the gateway and typed
 * transform hooks below.
 *
 * The lifecycle event vocabulary itself lives in
 * contracts/gateway-events.ts — versioned, additive-only, discriminated.
 */

import type {
	EventPattern,
	TaskLifecycleEvent,
	Unsubscribe,
} from "./gateway-events.ts";
import type { ExecutionBundle, HandoffBundle } from "./payloads.ts";

export type { EventPattern, TaskLifecycleEvent, Unsubscribe };
export {
	TASK_LIFECYCLE_EVENTS,
	eventMatchesPattern,
	eventTypeOf,
} from "./gateway-events.ts";
export type { TaskLifecycleEventType } from "./gateway-events.ts";

/** A minimal typed surface of the ledger's `tasks` table (ledger DDL §4). */
export interface TaskLedgerRow {
	id: string;
	status:
		| "queued"
		| "planning"
		| "executing"
		| "awaiting_child"
		| "preparing"
		| "awaiting_execution"
		| "resumable"
		| "verifying"
		| "reviewing"
		| "completed"
		| "failed"
		| "escalated";
	goal: string;
	parentBranch: string | null;
	planMode: "prewalk" | "bundle" | "fork" | "cold" | null;
	retryCount: number;
	maxRetries: number;
	createdAt: string;
	updatedAt: string;
}

/** Typed run-manifest surface (contract NFR-3). M0 defines the minimal
 *  slice the gateway exposes; the full phase vocabulary ports with the v1
 *  metrics machinery in M1. `detail` carries capped structural metadata
 *  assembled from LEDGER ROWS — never transcripts. */
export interface RunManifest {
	taskId: string;
	runId: string;
	totals: {
		costUsd: number;
		durationMs: number;
		inputTokens: number;
		outputTokens: number;
	};
	verifyPassed: boolean;
	detail?: {
		sessions?: Array<{
			id: string;
			role: "worker" | "reviewer";
			status: "active" | "yielded" | "exhausted" | "crashed";
		}>;
	};
}

/** The one interaction channel plugins get: events in, narrow reads out.
 *  Reads are typed rows — never transcripts. */
export interface TaskGateway {
	emit(event: TaskLifecycleEvent): void;
	on(
		pattern: EventPattern,
		handler: (event: TaskLifecycleEvent) => void,
	): Unsubscribe;
	getTaskState(taskId: string): Promise<TaskLedgerRow>;
	getManifest(taskId: string): Promise<RunManifest>;
}

/** Trigger hook contract (subsystems §3). */
export interface TaskPlugin {
	name: string;
	registerTriggers?(gateway: TaskGateway): void;
	transformExecutionBundle?(bundle: ExecutionBundle): Promise<ExecutionBundle>;
	transformHandoff?(handoff: HandoffBundle): Promise<HandoffBundle>;
	onLifecycleEvent?(event: TaskLifecycleEvent): void;
}
