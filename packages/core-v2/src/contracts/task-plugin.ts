/**
 * Seam 5/6 — Lifecycle & trigger plugins (subsystems §3; FR-2/FR-11).
 *
 * The buildability contract, specified BEFORE any plugin code exists:
 * a plugin is one file, one default export implementing TaskPlugin,
 * loaded by path from config (no discovery magic); every plugin has one
 * hermetic test exercising its REAL path; no shared mutable state — all
 * interaction with the engine goes through the gateway and typed
 * transform hooks below.
 */

import type { ExecutionBundle, HandoffBundle } from "./payloads.ts";

/** Event vocabulary (initial set; additive-only evolution, versioned). */
export const TASK_LIFECYCLE_EVENTS = [
	"task.queued",
	"task.routed",
	"session.spawned",
	"session.yielded",
	"session.exhausted",
	"verify.completed",
	"review.completed",
	"merge.completed",
	"merge.conflict",
	"task.completed",
	"task.failed",
	"task.escalated",
] as const;
export type TaskLifecycleEventType = (typeof TASK_LIFECYCLE_EVENTS)[number];

/** A lifecycle event crossing the gateway. Diagnostics only — never a
 *  transcript. */
export interface TaskLifecycleEvent {
	type: TaskLifecycleEventType;
	taskId: string;
	/** ms epoch; event metadata is ledger-side, never prompt-bound. */
	atMs: number;
	/** Capped, structural detail (e.g. affected session id). */
	detail?: Record<string, unknown> | undefined;
}

/** Event-name pattern for on() subscriptions ("task.*", "merge.*", "*"). */
export type EventPattern = string;

export type Unsubscribe = () => void;

/** A minimal typed surface of the ledger's `tasks` table (ledger DDL §4). */
export interface TaskLedgerRow {
	id: string;
	status:
		| "queued"
		| "planning"
		| "executing"
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
 *  metrics machinery in M1. */
export interface RunManifest {
	taskId: string;
	runId: string;
	totals: { costUsd: number; durationMs: number; inputTokens: number; outputTokens: number };
	verifyPassed: boolean;
}

/** The one interaction channel plugins get: events in, narrow reads out.
 *  Reads are typed rows — never transcripts. */
export interface TaskGateway {
	emit(event: TaskLifecycleEvent): void;
	on(pattern: EventPattern, handler: (event: TaskLifecycleEvent) => void): Unsubscribe;
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