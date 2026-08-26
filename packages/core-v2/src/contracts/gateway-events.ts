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
] as const;

export type TaskLifecycleEventType = (typeof TASK_LIFECYCLE_EVENTS)[number];

/** The receipt verdicts a terminal task.* event can carry (payloads.ts). */
export type TaskVerdict = "ship" | "escalate" | "failed";

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
	| { type: "verify.completed"; taskId: string; detail: { passed: boolean } }
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
			detail: { verdict: Extract<TaskVerdict, "ship"> };
	  }
	| {
			type: "task.failed";
			taskId: string;
			sessionId?: string;
			detail: { cause: string };
	  }
	| {
			type: "task.escalated";
			taskId: string;
			sessionId?: string;
			detail: { verdict: Extract<TaskVerdict, "escalate"> };
	  };

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
