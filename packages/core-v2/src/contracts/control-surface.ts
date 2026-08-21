/**
 * Seam 6/6 — ControlSurface (subsystems §3b; FR-2).
 *
 * Control surfaces (pi TUI, Discord bridge, CLI, CI/cron) are protocol
 * adapters over hosted sessions — never session owners. Separate from
 * TaskPlugin because the lifecycle differs: long-lived bidirectional
 * streaming vs task-scoped hooks.
 *
 * Multi-surface multiplexing falls out of daemon hosting: broadcast
 * events to all subscribers of a session, serialize inputs
 * first-writer-wins per turn.
 */

import type { TaskReceipt } from "./payloads.ts";

/** QoS level — a coarsening view of the SAME stream (delta ⊃ digest ⊃
 *  receipts). */
export type SubscriptionLevel = "delta" | "digest" | "receipts";

export interface SurfaceCapabilities {
	/** Can render interactive PermissionRequests (TUI: yes; cron: no). */
	interactivePermissions: boolean;
	/** Can carry file/image attachments on UserMessage. */
	attachments: boolean;
	/** Tolerated event latency — guides daemon batching. */
	latencyToleranceMs: number;
}

/** Downstream event union a surface may receive per level. */
export type SurfaceEvent =
	| { type: "TurnDelta"; text: string }
	| { type: "ToolActivity"; tool: string; argsPreview: string; phase: "start" | "done"; durationMs?: number }
	| { type: "PermissionRequest"; requestId: string; action: string; detail: string }
	| { type: "Receipt"; receipt: TaskReceipt }
	| { type: "Escalation"; taskId: string; reason: string; detail: string }
	| { type: "StatusSnapshot"; model: string; tier: string; activeTasks: number };

/** Upstream command union a surface may publish. */
export type SurfaceCommand =
	| { type: "UserMessage"; text: string; attachments?: string[] }
	| { type: "Approve"; requestId: string; grant: boolean }
	| { type: "Interrupt"; scope: "turn" | "task" }
	| { type: "InvokeCommand"; name: string; args?: Record<string, unknown> };

/** A live subscription: typed events downstream, commands upstream. */
export interface SurfaceStream {
	events: AsyncIterable<SurfaceEvent>;
	send(command: SurfaceCommand): void;
	close(): void;
}

export interface ControlSurface {
	name: string;
	/** Subscribe to a hosted session's event stream at a QoS level:
	 *  "delta" (token-level, TUI), "digest" (coarse, Discord),
	 *  "receipts" (escalations + verdicts only, cron/CI). */
	connect(sessionId: string, level: SubscriptionLevel): SurfaceStream;
	capabilities(): SurfaceCapabilities;
}