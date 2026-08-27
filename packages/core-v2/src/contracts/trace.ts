/** Canonical v2 execution trace (M1–M3 observability contract).
 *
 * Traces contain structural execution evidence only. Payloads are capped and
 * never contain transcripts or private chain-of-thought. The vocabulary is
 * intentionally provider-neutral; adapters translate gateway/session events
 * into these events rather than scraping rendered output.
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { stableStringify } from "./serialize.ts";

export const TRACE_VERSION = 1;
export const TRACE_MAX_EVENTS = 2_000;
export const TRACE_MAX_DETAIL_CHARS = 4_000;
export const TRACE_MAX_TEXT_CHARS = 1_000;
const TRACE_MAX_ID_CHARS = 256;
const TRACE_MAX_PROVIDER_CHARS = 256;

export const TraceEventTypeSchema = z.enum([
	"task.queued", "task.routed", "session.spawned", "session.ended",
	"turn.started", "turn.ended", "tool.started", "tool.ended",
	"context.selected", "context.injected", "context.omitted",
	"model.assigned", "model.changed", "usage.observed",
	"verification.completed", "artifact.accepted", "artifact.rejected",
	"receipt.delivered", "trace.delivered", "failure", "recovery.referenced",
	"task.completed", "task.failed", "task.escalated",
]);
export type TraceEventType = z.infer<typeof TraceEventTypeSchema>;

const identity = z.string().min(1).max(TRACE_MAX_ID_CHARS);
const artifactIdentity = identity.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const providerValue = z.string().min(1).max(TRACE_MAX_PROVIDER_CHARS);
const timestamp = z.string().min(1).max(128);

const FORBIDDEN_DETAIL_KEY = /(?:transcript|chain[_. -]*of[_. -]*thought|private[_. -]*reasoning|(?:^|[_. -])reasoning(?:$|[_. -])|(?:^|[_. -])thoughts?(?:$|[_. -]))/i;

function containsForbiddenDetail(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsForbiddenDetail);
	if (value !== null && typeof value === "object") {
		return Object.entries(value as Record<string, unknown>).some(
			([key, nested]) => FORBIDDEN_DETAIL_KEY.test(key) || containsForbiddenDetail(nested),
		);
	}
	return false;
}

function isJsonDetailValue(value: unknown, seen = new Set<object>()): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.every((item) => isJsonDetailValue(item, seen));
	return Object.entries(value as Record<string, unknown>).every(([key, nested]) =>
		typeof key === "string" && isJsonDetailValue(nested, seen),
	);
}

function encodedDetailLength(value: Record<string, unknown>): number | undefined {
	if (!isJsonDetailValue(value)) return undefined;
	try {
		const encoded = JSON.stringify(value);
		return encoded === undefined ? undefined : encoded.length;
	} catch {
		return undefined;
	}
}

function freezeTraceValue(value: unknown, seen = new Set<object>()): void {
	if (value === null || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) freezeTraceValue(item, seen);
	} else {
		for (const nested of Object.values(value)) freezeTraceValue(nested, seen);
	}
	Object.freeze(value);
}

/** Structural detail is JSON data, not an escape hatch for session content. */
export const TraceDetailSchema = z.record(z.string(), z.unknown()).superRefine((detail, ctx) => {
	if (containsForbiddenDetail(detail)) {
		ctx.addIssue({ code: "custom", message: "trace detail cannot contain transcripts or private reasoning" });
	}
	const length = encodedDetailLength(detail);
	if (length === undefined) {
		ctx.addIssue({ code: "custom", message: "trace detail must be JSON serializable" });
	} else if (length > TRACE_MAX_DETAIL_CHARS) {
		ctx.addIssue({ code: "too_big", maximum: TRACE_MAX_DETAIL_CHARS, inclusive: true, origin: "string", message: `trace detail exceeds ${TRACE_MAX_DETAIL_CHARS} encoded characters` });
	}
});
export type TraceDetail = z.infer<typeof TraceDetailSchema>;

export const TraceEventSchema = z.object({
	version: z.literal(TRACE_VERSION),
	sequence: z.number().int().positive(),
	at: timestamp,
	taskId: identity,
	runId: identity,
	sessionId: identity.optional(),
	phase: z.enum(["task", "session", "turn", "tool", "context", "model", "usage", "verification", "artifact", "failure", "recovery"]),
	type: TraceEventTypeSchema,
	provider: providerValue.optional(),
	config: providerValue.optional(),
	detail: TraceDetailSchema.optional(),
}).strict();
export type TraceEvent = z.infer<typeof TraceEventSchema>;

export const TraceUsageSchema = z.object({
	status: z.enum(["measured", "unavailable"]),
	costUsd: z.number().finite().nonnegative(),
	inputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
	cacheReadTokens: z.number().int().nonnegative(),
	cacheWriteTokens: z.number().int().nonnegative(),
}).strict();
export type TraceUsage = z.infer<typeof TraceUsageSchema>;

export const TraceArtifactSchema = z.object({
	version: z.literal(TRACE_VERSION),
	runId: artifactIdentity,
	taskId: identity,
	startedAt: timestamp,
	endedAt: timestamp,
	events: z.array(TraceEventSchema).max(TRACE_MAX_EVENTS),
	usage: TraceUsageSchema.optional(),
	outcome: z.enum(["ship", "failed", "escalate"]).optional(),
}).strict().superRefine((artifact, ctx) => {
	let expected = 1;
	for (const [index, event] of artifact.events.entries()) {
		if (event.sequence !== expected) {
			ctx.addIssue({ code: "custom", path: ["events", index, "sequence"], message: "trace event sequences must be contiguous and ordered" });
		}
		expected += 1;
		if (event.runId !== artifact.runId || event.taskId !== artifact.taskId) {
			ctx.addIssue({ code: "custom", path: ["events", index], message: "trace event identity does not match its artifact" });
		}
	}
});
export type TraceArtifact = z.infer<typeof TraceArtifactSchema>;

/** Cap a structural string without ever returning more than max characters. */
export function capTraceText(value: string, max = TRACE_MAX_TEXT_CHARS): string {
	if (max <= 0) return "";
	return value.length <= max ? value : value.slice(-max);
}

function boundedSummary(max: number): Record<string, unknown> {
	const marker = "[detail capped]";
	return { summary: capTraceText(marker, max) };
}

/**
 * Cap detail before it enters a trace. Oversized, circular, or private detail
 * is represented by a safe marker rather than retaining a partial transcript.
 */
export function boundedDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (detail === undefined) return undefined;
	if (containsForbiddenDetail(detail)) return boundedSummary(TRACE_MAX_DETAIL_CHARS);
	const length = encodedDetailLength(detail);
	if (length !== undefined && length <= TRACE_MAX_DETAIL_CHARS) return detail;
	return boundedSummary(TRACE_MAX_DETAIL_CHARS);
}

/** Mutable only inside this collector; callers receive immutable snapshots. */
export class TraceCollector {
	readonly #events: TraceEvent[] = [];
	readonly #startedAt: string;
	#sequence = 0;
	#endedAt: string;
	#usage: TraceUsage | undefined;
	constructor(
		readonly runId: string,
		readonly taskId: string,
		private readonly now: () => string = () => new Date().toISOString(),
	) {
		artifactIdentity.parse(runId);
		identity.parse(taskId);
		this.#startedAt = timestamp.parse(now());
		this.#endedAt = this.#startedAt;
	}
	record(input: Omit<TraceEvent, "version" | "sequence" | "at" | "runId">): TraceEvent {
		if (input.taskId !== this.taskId) throw new Error("trace event taskId does not match collector taskId");
		if (this.#events.length >= TRACE_MAX_EVENTS) return this.#events[this.#events.length - 1]!;
		const at = timestamp.parse(this.now());
		const event = TraceEventSchema.parse({
			...input,
			version: TRACE_VERSION,
			sequence: this.#sequence + 1,
			at,
			runId: this.runId,
			detail: boundedDetail(input.detail),
		});
		this.#sequence = event.sequence;
		this.#endedAt = event.at;
		freezeTraceValue(event);
		this.#events.push(event);
		return event;
	}
	setUsage(usage: TraceUsage): void {
		this.#usage = TraceUsageSchema.parse(usage);
		this.record({ type: "usage.observed", phase: "usage", taskId: this.taskId, detail: this.#usage });
	}
	finish(outcome?: TraceArtifact["outcome"]): TraceArtifact {
		return TraceArtifactSchema.parse({
			version: TRACE_VERSION,
			runId: this.runId,
			taskId: this.taskId,
			startedAt: this.#startedAt,
			endedAt: this.#endedAt,
			events: this.#events.map((event) => ({ ...event, ...(event.detail === undefined ? {} : { detail: { ...event.detail } }) })),
			...(this.#usage === undefined ? {} : { usage: this.#usage }),
			...(outcome === undefined ? {} : { outcome }),
		});
	}
}

function phaseForTraceType(type: TraceEventType): TraceEvent["phase"] {
	if (type.startsWith("session")) return "session";
	if (type.startsWith("turn")) return "turn";
	if (type.startsWith("tool")) return "tool";
	if (type.startsWith("context")) return "context";
	if (type.startsWith("model")) return "model";
	if (type.startsWith("usage")) return "usage";
	if (type.startsWith("verification")) return "verification";
	if (type.startsWith("artifact") || type.endsWith(".delivered")) return "artifact";
	if (type === "failure") return "failure";
	if (type.startsWith("recovery")) return "recovery";
	return "task";
}

/** Project every gateway lifecycle variant into the canonical vocabulary. */
export function traceEventFromGateway(event: import("./gateway-events.ts").TaskLifecycleEvent, _runId: string): Omit<TraceEvent, "version" | "sequence" | "at" | "runId"> {
	let type: TraceEventType;
	let detail: Record<string, unknown> | undefined;
	switch (event.type) {
		case "task.queued": type = "task.queued"; break;
		case "task.routed": type = "task.routed"; detail = { planMode: event.detail.planMode }; break;
		case "session.spawned": type = "session.spawned"; break;
		case "session.yielded": type = "session.ended"; detail = { outcome: "yielded" }; break;
		case "session.exhausted": type = "session.ended"; detail = { outcome: "exhausted" }; break;
		case "verify.completed": type = "verification.completed"; detail = { passed: event.detail.passed }; break;
		case "review.completed": type = "artifact.accepted"; detail = { verdict: event.detail.verdict }; break;
		case "merge.completed": type = "artifact.accepted"; detail = { commitId: capTraceText(event.detail.commitId) }; break;
		case "merge.conflict": type = "artifact.rejected"; detail = { conflicts: event.detail.conflicts.map((conflict) => capTraceText(conflict)) }; break;
		case "permission.requested":
			type = "failure";
			detail = { requestId: capTraceText(event.requestId), action: capTraceText(event.action), description: capTraceText(event.detail) };
			break;
		case "task.completed": type = "task.completed"; detail = { verdict: event.detail.verdict }; break;
		case "task.failed": type = "task.failed"; detail = { cause: capTraceText(event.detail.cause) }; break;
		case "task.escalated": type = "task.escalated"; detail = { verdict: event.detail.verdict }; break;
	}
	const sessionId = "sessionId" in event ? event.sessionId : undefined;
	return {
		taskId: event.taskId,
		...(sessionId === undefined ? {} : { sessionId }),
		phase: phaseForTraceType(type),
		type,
		...(detail === undefined ? {} : { detail: boundedDetail(detail) }),
	};
}

export interface TraceWriteSuccess {
	ok: true;
	path: string;
	error?: string;
}
export interface TraceWriteFailure {
	ok: false;
	path?: string;
	error: string;
}
export type TraceWriteResult = TraceWriteSuccess | TraceWriteFailure;

/** Atomically write a validated trace and report every delivery failure. */
export function writeTraceArtifact(trace: TraceArtifact, artifactsDir: string): TraceWriteResult {
	let temporary: string | undefined;
	if (typeof trace?.runId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(trace.runId)) {
		temporary = join(artifactsDir, `${trace.runId}.trace.json.tmp`);
	}
	try {
		const checked = TraceArtifactSchema.parse(trace);
		const path = join(artifactsDir, `${checked.runId}.trace.json`);
		temporary = `${path}.tmp`;
		mkdirSync(artifactsDir, { recursive: true });
		writeFileSync(temporary, `${stableStringify(checked)}\n`, "utf8");
		renameSync(temporary, path);
		return { ok: true, path };
	} catch (error) {
		const failure = error instanceof Error ? error.message : String(error);
		if (temporary !== undefined) {
			try {
				unlinkSync(temporary);
			} catch (cleanupError) {
				if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
					return { ok: false, error: `${failure}; temporary trace cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}` };
				}
			}
		}
		return { ok: false, error: failure };
	}
}
