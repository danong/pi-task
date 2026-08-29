/**
 * Gateway lifecycle events — subsystems §3 / R1.
 *
 * The kernel's event stream crossing the TaskGateway: a versioned,
 * ADDITIVE-ONLY discriminated union. Evolution rule: a new version may
 * only ADD a discriminant case — renaming or removing a case is a
 * breaking change and must not compile against consumers' exhaustive
 * switches (`eventTypeOf` below enforces this at the type level;
 * test-gateway.ts anchors it to checked values so the strict tsc gate
 * actually exercises it).
 *
 * Payloads are narrow and typed by construction (taskId, attempt/session
 * ids where relevant, a typed status or verdict) — never transcripts.
 * Anything variable per attempt (timestamps, session ids, usage numbers)
 * lives ledger-side; the event carries only capped, structural detail.
 */

import { z } from "zod";
import type { VerificationEvidence } from "./verification-driver.ts";
import type { SettlementSource } from "./settlement.ts";

/** The event vocabulary (subsystems §3 initial set). Additive-only. */
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
	"permission.requested",
	"child.queued",
	"child.claimed",
	"child.resumable",
	"child.blocked",
	"child.completed",
	"child.failed",
	"child.escalated",
	"continuation.checkpointed",
	"continuation.resumed",
] as const;

export type TaskLifecycleEventType = (typeof TASK_LIFECYCLE_EVENTS)[number];

/** Structural failure location; details remain in bounded failure artifacts. */
export const TASK_FAILURE_STAGES = [
	"setup",
	"context",
	"session",
	"workspace",
	"verification",
	"acceptance",
	"delivery",
	"workflow",
	"budget",
	"internal",
] as const;
export type TaskFailureStage = (typeof TASK_FAILURE_STAGES)[number];

/** Stable provider-neutral failure classification for traces and reports. */
export const TASK_FAILURE_CODES = [
	"invalid_input",
	"context_failed",
	"session_failed",
	"session_timed_out",
	"budget_exceeded",
	"worker_failed",
	"merge_failed",
	"verification_failed",
	"artifact_rejected",
	"delivery_failed",
	"dependency_failed",
	"internal_error",
	"unclassified",
] as const;
export type TaskFailureCode = (typeof TASK_FAILURE_CODES)[number];

export interface TaskFailureDetail {
	cause: string;
	/** Optional for additive compatibility; core producers always supply it. */
	stage?: TaskFailureStage;
	/** Optional for additive compatibility; core producers always supply it. */
	code?: TaskFailureCode;
}

/** The receipt verdicts a terminal task.* event can carry (payloads.ts). */
export type TaskVerdict = "ship" | "escalate" | "failed";
export type ChildRelationship = "continuation";

/** Bounded relationship metadata shared by additive child events. */
export type ChildLifecycleStatus =
	| "ready" | "claimed" | "resumable" | "blocked"
	| "completed" | "failed" | "escalated";

/** IDs in a gateway event are logical identities, never paths, refs, attempts,
 * timestamps, or host locations. Artifact identities are content addressed. */
const gatewayId = z.string().min(1).max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
	.refine((value) => !/(?:^|[-_.])attempt(?:[-_.]|$)/i.test(value))
	.refine((value) => !/^\d{4}-\d{2}-\d{2}/.test(value));
const gatewayArtifactId = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const ChildLifecycleDetailSchema = z.object({
	parentTaskId: gatewayId,
	childTaskId: gatewayId,
	relationship: z.literal("continuation"),
	ordinal: z.number().int().positive().max(1),
	status: z.enum(["ready", "claimed", "resumable", "blocked", "completed", "failed", "escalated"]),
	handoffArtifactId: gatewayArtifactId.optional(),
	checkpointArtifactId: gatewayArtifactId.optional(),
	resultArtifactId: gatewayArtifactId.optional(),
	receiptArtifactId: gatewayArtifactId.optional(),
	traceArtifactId: gatewayArtifactId.optional(),
}).strict();
export type ChildLifecycleDetail = z.infer<typeof ChildLifecycleDetailSchema>;

const CHILD_EVENT_TYPES = [
	"child.queued", "child.claimed", "child.resumable", "child.blocked",
	"child.completed", "child.failed", "child.escalated",
	"continuation.checkpointed", "continuation.resumed",
] as const;
export const ChildLifecycleEventSchema = z.object({
	type: z.enum(CHILD_EVENT_TYPES),
	taskId: gatewayId,
	detail: ChildLifecycleDetailSchema,
}).strict().superRefine((event, ctx) => {
	const expected: Record<typeof event.type, ChildLifecycleStatus> = {
		"child.queued": "ready", "child.claimed": "claimed",
		"child.resumable": "resumable", "child.blocked": "blocked",
		"child.completed": "completed", "child.failed": "failed",
		"child.escalated": "escalated", "continuation.checkpointed": "resumable",
		"continuation.resumed": "claimed",
	};
	if (event.detail.status !== expected[event.type])
		ctx.addIssue({ code: "custom", path: ["detail", "status"], message: "event status does not match event type" });
	const taskMustBeParent = event.type === "child.queued";
	if (event.taskId !== (taskMustBeParent ? event.detail.parentTaskId : event.detail.childTaskId))
		ctx.addIssue({ code: "custom", path: ["taskId"], message: "event taskId does not match its relationship endpoint" });
	if (event.type === "child.queued" && event.detail.handoffArtifactId === undefined)
		ctx.addIssue({ code: "custom", path: ["detail", "handoffArtifactId"], message: "queued child requires its handoff reference" });
	if ((event.type === "child.resumable" || event.type === "continuation.checkpointed" || event.type === "continuation.resumed") && event.detail.checkpointArtifactId === undefined)
		ctx.addIssue({ code: "custom", path: ["detail", "checkpointArtifactId"], message: "continuation event requires its checkpoint reference" });
	// A terminal event is included in the trace that its traceArtifactId would
	// identify. Requiring that identity here would make the evidence hash
	// circular. The result and receipt are causal inputs; the trace is linked
	// by the atomic settlement record, outside the event payload.
	if (["child.completed", "child.failed", "child.escalated"].includes(event.type) &&
		(event.detail.resultArtifactId === undefined || event.detail.receiptArtifactId === undefined))
		ctx.addIssue({ code: "custom", path: ["detail"], message: "terminal child event requires result and receipt references" });
});

/** Validate before gateway retention and before trace projection. */
export function admitTaskLifecycleEvent(event: TaskLifecycleEvent): TaskLifecycleEvent {
	if ((CHILD_EVENT_TYPES as readonly string[]).includes(event.type))
		return ChildLifecycleEventSchema.parse(event) as TaskLifecycleEvent;
	return event;
}

/**
 * One lifecycle event crossing the gateway. Diagnostics only — never a
 * transcript. Every variant narrows its payload to exactly the fields
 * its pipeline point can honestly supply; variable envelope data
 * (timestamps, usage, transcripts) stays ledger-side.
 */
export type TaskLifecycleEvent =
	| { type: "task.queued"; taskId: string }
	| {
			type: "task.routed";
			taskId: string;
			detail: { planMode: "cold" | "prewalk" | "bundle" | "fork" };
	  }
	| { type: "session.spawned"; taskId: string; sessionId: string }
	| { type: "session.yielded"; taskId: string; sessionId: string }
	| { type: "session.exhausted"; taskId: string; sessionId: string }
	| {
			type: "verify.completed";
			taskId: string;
			detail: { passed: boolean; evidence?: VerificationEvidence };
	  }
	| {
			type: "review.completed";
			taskId: string;
			detail: { verdict: "ship" | "fix" | "escalate" };
	  }
	| { type: "merge.completed"; taskId: string; detail: { commitId: string } }
	| {
			type: "merge.conflict";
			taskId: string;
			detail: { conflicts: readonly string[] };
	  }
	| {
			type: "permission.requested";
			taskId: string;
			sessionId: string;
			requestId: string;
			action: string;
			detail: string;
	  }
	| {
			type: "task.completed";
			taskId: string;
			sessionId?: string;
			detail: {
				verdict: Extract<TaskVerdict, "ship">;
				/** Additive; omitted by older model-yield lifecycle producers. */
				settlementSource?: SettlementSource;
			};
	  }
	| {
			type: "task.failed";
			taskId: string;
			sessionId?: string;
			detail: TaskFailureDetail;
	  }
	| {
			type: "task.escalated";
			taskId: string;
			sessionId?: string;
			detail: { verdict: Extract<TaskVerdict, "escalate"> };
	  }
	| { type: "child.queued"; taskId: string; detail: ChildLifecycleDetail }
	| { type: "child.claimed"; taskId: string; detail: ChildLifecycleDetail }
	| { type: "child.resumable"; taskId: string; detail: ChildLifecycleDetail }
	| { type: "child.blocked"; taskId: string; detail: ChildLifecycleDetail }
	| { type: "child.completed"; taskId: string; detail: ChildLifecycleDetail }
	| { type: "child.failed"; taskId: string; detail: ChildLifecycleDetail }
	| { type: "child.escalated"; taskId: string; detail: ChildLifecycleDetail }
	| { type: "continuation.checkpointed"; taskId: string; detail: ChildLifecycleDetail }
	| { type: "continuation.resumed"; taskId: string; detail: ChildLifecycleDetail };

/** Event-name pattern for on() subscriptions: an exact type ("task.routed"),
 *  a family wildcard ("task.*"), or the catch-all ("*"). */
export type EventPattern = string;

/** Function returned by on(); calling it removes that one subscription. */
export type Unsubscribe = () => void;

/**
 * Compile-time additivity guard: an EXHAUSTIVE switch over the union
 * with every discriminant literal pinned. Both evolution directions
 * fail to compile under the strict type gate:
 *   - REMOVING a case from the union leaves a stale `case "…"` label,
 *     and a literal no longer comparable to the narrowed union is a
 *     type error;
 *   - ADDING a case without extending this switch falls into the
 *     default arm, where the assignment to `never` is a type error.
 */
export function eventTypeOf(event: TaskLifecycleEvent): TaskLifecycleEventType {
	switch (event.type) {
		case "task.queued":
		case "task.routed":
		case "session.spawned":
		case "session.yielded":
		case "session.exhausted":
		case "verify.completed":
		case "review.completed":
		case "merge.completed":
		case "merge.conflict":
		case "task.completed":
		case "task.failed":
		case "task.escalated":
		case "permission.requested":
		case "child.queued":
		case "child.claimed":
		case "child.resumable":
		case "child.blocked":
		case "child.completed":
		case "child.failed":
		case "child.escalated":
		case "continuation.checkpointed":
		case "continuation.resumed":
			return event.type;
		default: {
			const exhaustive: never = event;
			return exhaustive;
		}
	}
}

/**
 * Pure pattern matcher over DOT SEGMENTS: an exact type ("task.routed"),
 * a family wildcard whose segments are all literal except a trailing ".*"
 * ("task.*"), or the catch-all ("*"). Anything else — empty patterns,
 * embedded wildcards ("ta*"), bare prefixes without a dot ("task") or
 * trailing-dot forms ("task.") — is malformed and matches NOTHING rather
 * than silently widening into a raw-prefix match.
 */
export function eventMatchesPattern(
	type: TaskLifecycleEventType,
	pattern: EventPattern,
): boolean {
	if (pattern === "*") return true;
	const segments = pattern.split(".");
	if (!pattern.includes(".")) return false; // malformed: family match needs a dot
	if (segments.some((s) => s.length === 0)) return false; // malformed: empty segment ("task." / ".queued" / "..")
	const last = segments[segments.length - 1]!;
	if (last !== "*" && segments.slice(0, -1).includes("*")) return false; // malformed: non-trailing wildcard
	if (last !== "*") return pattern === type; // exact match only
	const typeSegments = type.split(".");
	if (typeSegments.length < segments.length - 1) return false;
	for (let i = 0; i < segments.length - 1; i++) {
		if (segments[i] !== typeSegments[i]) return false;
	}
	// A trailing wildcard consumes exactly one remaining dot-segment.
	return typeSegments.length === segments.length;
}
