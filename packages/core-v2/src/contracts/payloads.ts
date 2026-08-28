/**
 * Boundary payload schemas (subsystems §2, contract FR-3).
 *
 * Exactly five artifact types may cross a context-ownership boundary:
 * Spec (a spec paragraph, see v1's schemas/spec.ts), ExecutionBundle,
 * Yield, HandoffBundle, TaskReceipt.
 *
 * Deterministic-serialization rule (NFR-4 / NFR-3): fields that vary per
 * attempt (timestamps, session ids, run ids) are ledger-only and NEVER
 * enter prompt serialization. The zod schemas below are therefore the
 * PROMPT-BOUND shape; ledger-only envelope fields deliberately have no
 * slot here (see WithLedgerFields and serialize.ts). A bundle serialized
 * with an identical serialized prefix always yields identical bytes, so
 * retries stay cache-affine.
 */

import { z } from "zod";

/** Model routing for a task (FR-10): per-role defaults overridden by the
 *  bundle author. Ledger-only per-role model config lives in task.toml. */
export const ModelAssignmentSchema = z.object({
	/** Overrides the per-role default execute model for this task. */
	model: z.string().optional(),
	/** Lane: interactive (default), flex (latency-tolerant), batch. */
	lane: z.enum(["interactive", "flex", "batch"]).optional(),
});
export type ModelAssignment = z.infer<typeof ModelAssignmentSchema>;

/** One exec file inside an ExecutionBundle (FR-9, layer 4). */
export const TargetFileSchema = z.object({
	/** Host path the worker must work or read. */
	hostPath: z.string(),
	/** ≈200 tokens of symbol outline; the compressor caps at 800 chars. */
	astOutline: z.string().max(800),
	/** True when the outline was cut at a continuation page. */
	outlineTruncated: z.boolean(),
	/** Continuation cursor when outlineTruncated; null otherwise. */
	outlineCursor: z.string().nullable(),
});
export type TargetFile = z.infer<typeof TargetFileSchema>;

/** Bundle-mode grounding (FR-9 layer 4; planning mode (b) in §5.3). */
export const ExecutionBundleSchema = z.object({
	taskId: z.string(),
	goal: z.string(),
	targetFiles: z.array(TargetFileSchema).max(50),
	requirements: z.array(z.string()),
	verificationCommands: z.array(z.string()),
	modelAssignment: ModelAssignmentSchema.optional(),
});
export type ExecutionBundle = z.infer<typeof ExecutionBundleSchema>;

/** One failed verification command in a HandoffBundle (FR-7/FR-8). */
export const VerificationFailureSchema = z.object({
	command: z.string(),
	reason: z.string().optional(),
	stderrTail: z.string(),
});
export type VerificationFailure = z.infer<typeof VerificationFailureSchema>;

/**
 * Retry handoff (FR-7). Payload timeout/capFixOutput semantics apply per
 * failure: uncommittedDiffSummary is capped, tails are capped.
 *
 * DETERMINISTIC-PREFIX RULE: nothing in this schema varies per attempt —
 * attemptNumber and precedingSessionId ride the LEDGER ENVELOPE
 * (LedgerEnvelopeFields), never the prompt-bound payload, so a retried
 * handoff appends byte-identical content to an identical prefix (NFR-4).
 */
export const HandoffBundleSchema = z.object({
	taskId: z.string(),
	uncommittedDiffSummary: z.string().max(60_000),
	filesTouched: z.array(z.string()),
	verificationFailures: z.array(VerificationFailureSchema),
});
export type HandoffBundle = z.infer<typeof HandoffBundleSchema>;

/** Typed worker completion (yield tool contract; FR-9 closure). */
export const YieldSchema = z.object({
	files_changed: z.array(z.string()),
	summary: z.string(),
	/** Optional model claim retained for legacy/fake session compatibility.
	 *  Engine-owned VCS evidence is supplied by the workspace finalizer. */
	commit_ids: z.array(z.string()).default([]),
	// empty when none; feeds fork_deviation_rate telemetry (§5.4).
	deviations: z.array(z.string()),
});
export type Yield = z.infer<typeof YieldSchema>;

/**
 * ≈150-token receipt so a spec-authoring session survives many tasks
 * (§5.6). turns/costUsd/bundleHit are router feedback (FR-9/FR-10).
 *
 * Measured efficiency (NFR-3): costUsd and the token counters come from
 * the pi SDK session stats (`SessionHandle.stats()`) — the SDK prices
 * usage, the runner only records it. `cor` is the grounding ratio:
 * groundingTokens ÷ totalInputTokens, where groundingTokens approximates
 * the fixed grounding prefix as ceil(utf8Bytes(systemPrompt + spec)/4)
 * (the manifest phase data NFR-3 names does not exist yet) and
 * totalInputTokens = input + cacheRead + cacheWrite — everything billed
 * as prompt, cached or not. When stats are unavailable (or no session
 * ever spawned) every field below is 0 — accounting never fails a run.
 */
export const TaskReceiptSchema = z.object({
	taskId: z.string(),
	verdict: z.enum(["ship", "escalate", "failed"]),
	filesChanged: z.number(),
	commitIds: z.array(z.string()),
	turns: z.number(),
	costUsd: z.number(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheReadTokens: z.number(),
	/** groundingTokens ÷ totalInputTokens (0 when nothing was billed). */
	cor: z.number(),
	/** Numeric zero remains compatible with older consumers; this field says
	 * whether zero means measured zero or unavailable usage. */
	usageStatus: z.enum(["measured", "unavailable"]).optional(),
	/** mode-(b) telemetry: null = bundle not used. */
	bundleHit: z.boolean().nullable(),
});
export type TaskReceipt = z.infer<typeof TaskReceiptSchema>;

// ─── Sequential child continuation (M5) ─────────────────────────────

/** Version of the prompt-bound child continuation vocabulary. */
export const CHILD_CONTINUATION_VERSION = 1 as const;
/** Hard UTF-8 budget for the complete canonical prompt payload. */
export const CHILD_MAX_SERIALIZED_BYTES = 32_768;
export const CHILD_MAX_ITEMS = 32;
export const CHILD_MAX_TEXT_CHARS = 256;
export const CHILD_MAX_REFERENCES = 32;

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.-]+)?Z?$/;
const ATTEMPT_ID = /(?:^|[-_.])(?:attempt|a\d+)(?:[-_.]|$)/i;
const FORBIDDEN_TEXT = /(?:transcript|private[ _-]*reasoning|chain[ _-]*of[ _-]*thought|(?:^|[ _-])(?:stdout|stderr|command[ _-]*output|source[ _-]*body)(?:$|[ _-]))/i;

/** Prompt identities are logical ids, never paths, refs, timestamps or attempts. */
const childIdentity = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
	.refine((value) => !ISO_TIMESTAMP.test(value), "timestamps are ledger-only")
	.refine((value) => !ATTEMPT_ID.test(value), "attempt ids are ledger-only");

/** This is a lexical guard, not semantic reasoning detection. The kernel only
 * admits declarations from a trusted producer; arbitrary prose/source is not
 * made safe by this schema. Explicit sensitive markers are rejected as a
 * useful fail-closed check for accidental carriage. */
const childText = z
	.string()
	.min(1)
	.max(CHILD_MAX_TEXT_CHARS)
	.refine((value) => !FORBIDDEN_TEXT.test(value), "sensitive session content is not declarative state");

const relativePath = z
	.string()
	.min(1)
	.max(256)
	.refine(
		(value) =>
			!value.startsWith("/") &&
			!value.startsWith("\\\\") &&
			!/^[A-Za-z]:[\\/]/.test(value) &&
			!value.includes("\\") &&
			!value.split("/").some((part) => part === ".." || part === "." || part === "") &&
			!value.includes(":") &&
			!/^refs(?:\/|$)|^(?:heads|tags|remotes)(?:\/|$)/i.test(value),
		"changed paths must be canonical repository-relative POSIX paths",
	);

const contentAddressedIdentity = z
	.string()
	.regex(SHA256, "identity must be a sha256 content address");

/** A content-addressed reference; the content itself never crosses this boundary. */
export const ChildArtifactReferenceSchema = z
	.object({
		version: z.literal(CHILD_CONTINUATION_VERSION),
		id: z.string().regex(SHA256),
		namespace: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/),
		kind: z.enum([
			"context", "source-view", "checkpoint", "plan", "tool-result",
			"handoff", "result", "receipt", "trace", "verification", "failure",
		]),
		mediaType: z.string().min(1).max(128).regex(/^[\w.+-]+\/[\w.+-]+$/),
		sizeBytes: z.number().int().nonnegative().max(CHILD_MAX_SERIALIZED_BYTES),
		sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
		sourceRevision: contentAddressedIdentity,
	})
	.strict();
export type ChildArtifactReference = z.infer<typeof ChildArtifactReferenceSchema>;

/** Declarative requirement progress, never a model conversation transcript. */
export const ChildRequirementStateSchema = z.object({
	id: childIdentity,
	status: z.enum(["pending", "in-progress", "complete", "blocked"]),
	summary: childText,
}).strict();
export type ChildRequirementState = z.infer<typeof ChildRequirementStateSchema>;

export const ChildChangedPathSchema = z.object({
	path: relativePath,
	change: z.enum(["added", "modified", "deleted", "unchanged"]),
	evidenceReferences: z.array(ChildArtifactReferenceSchema).max(8),
}).strict();
export type ChildChangedPath = z.infer<typeof ChildChangedPathSchema>;

export const ChildVerificationSchema = z.object({
	status: z.enum(["not-run", "passed", "failed", "blocked"]),
	evidenceReferences: z.array(ChildArtifactReferenceSchema).max(16),
}).strict();
export type ChildVerification = z.infer<typeof ChildVerificationSchema>;

const childStateArrays = {
	requirementState: z.array(ChildRequirementStateSchema).max(CHILD_MAX_ITEMS),
	decisions: z.array(childText).max(CHILD_MAX_ITEMS),
	openQuestions: z.array(childText).max(CHILD_MAX_ITEMS),
	nextActions: z.array(childText).max(CHILD_MAX_ITEMS),
	changedPaths: z.array(ChildChangedPathSchema).max(CHILD_MAX_ITEMS),
	artifactReferences: z.array(ChildArtifactReferenceSchema).max(CHILD_MAX_REFERENCES),
};

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
			`${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
function sortCanonical<T>(values: readonly T[]): T[] {
	return [...values].sort((a, b) => {
		const left = canonicalJson(a);
		const right = canonicalJson(b);
		return left < right ? -1 : left > right ? 1 : 0;
	});
}
function uniqueCanonical<T>(values: readonly T[]): T[] {
	const result: T[] = [];
	const seen = new Set<string>();
	for (const value of sortCanonical(values)) {
		const key = canonicalJson(value);
		if (!seen.has(key)) { seen.add(key); result.push(value); }
	}
	return result;
}
function freezeCanonical<T>(value: T, seen = new Set<object>()): T {
	if (value !== null && typeof value === "object" && !seen.has(value as object)) {
		seen.add(value as object);
		for (const nested of Object.values(value as Record<string, unknown>)) freezeCanonical(nested, seen);
		Object.freeze(value);
	}
	return value;
}

/**
 * The prompt boundary is a kernel/trusted-producer admission boundary. It
 * mechanically enforces shape, lexical unsafe-value guards, canonical order,
 * and a hard serialized UTF-8 budget. It does not claim to semantically detect
 * hidden reasoning or source prose; producers must construct declarative state
 * and this function is the sole ingress builder before a session is spawned.
 */
export const ChildHandoffSchema = z.object({
	version: z.literal(CHILD_CONTINUATION_VERSION),
	parentTaskId: childIdentity,
	childTaskId: childIdentity,
	relationship: z.literal("continuation"),
	checkpointId: contentAddressedIdentity,
	planId: contentAddressedIdentity,
	sourceRevision: contentAddressedIdentity,
	...childStateArrays,
	verification: ChildVerificationSchema,
}).strict().superRefine((value, ctx) => {
	try {
		const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
		if (bytes > CHILD_MAX_SERIALIZED_BYTES) ctx.addIssue({ code: "too_big", maximum: CHILD_MAX_SERIALIZED_BYTES, inclusive: true, origin: "string", message: "child handoff exceeds serialized byte budget" });
	} catch { ctx.addIssue({ code: "custom", message: "child handoff must be serializable" }); }
});
export type ChildHandoff = z.infer<typeof ChildHandoffSchema>;

/** Canonical builder and sole prompt-ingress admission function. */
export function buildChildHandoff(input: unknown): ChildHandoff {
	const parsed = ChildHandoffSchema.parse(input);
	const canonical: ChildHandoff = {
		...parsed,
		requirementState: uniqueCanonical(parsed.requirementState),
		decisions: uniqueCanonical(parsed.decisions),
		openQuestions: uniqueCanonical(parsed.openQuestions),
		nextActions: uniqueCanonical(parsed.nextActions),
		changedPaths: uniqueCanonical(parsed.changedPaths.map((entry) => ({
			...entry,
			evidenceReferences: uniqueCanonical(entry.evidenceReferences),
		}))),
		artifactReferences: uniqueCanonical(parsed.artifactReferences),
		verification: { ...parsed.verification, evidenceReferences: uniqueCanonical(parsed.verification.evidenceReferences) },
	};
	return freezeCanonical(ChildHandoffSchema.parse(canonical));
}

/** Bounded, provider-neutral child return state and its immutable evidence. */
export const ChildResultSchema = z.object({
	version: z.literal(CHILD_CONTINUATION_VERSION),
	parentTaskId: childIdentity,
	childTaskId: childIdentity,
	status: z.enum(["completed", "failed", "blocked", "escalated"]),
	summary: childText,
	requirementState: z.array(ChildRequirementStateSchema).max(CHILD_MAX_ITEMS),
	changedPaths: z.array(ChildChangedPathSchema).max(CHILD_MAX_ITEMS),
	verification: ChildVerificationSchema,
	artifactReferences: z.array(ChildArtifactReferenceSchema).max(CHILD_MAX_REFERENCES),
}).strict();
export type ChildResult = z.infer<typeof ChildResultSchema>;

/** Convenient names for consumers that call these records references/results. */
export const ChildResultReferenceSchema = ChildArtifactReferenceSchema;
export type ChildResultReference = ChildArtifactReference;

/** Fields that vary per attempt, carried on runtime records but never
 *  prompt-bound (deterministic-serialization rule). The ledger is the
 *  sole owner; serialize.ts strips them via the schema. */
export interface LedgerEnvelopeFields {
	createdAt?: string;
	sessionId?: string;
	runId?: string;
	precedingSessionId?: string;
	/** Which retry attempt produced this record — ledger-only; never
	 *  prompt-bound (varies per attempt, deterministic-prefix rule). */
	attemptNumber?: number;
}

/** A prompt-bound payload together with its ledger-only envelope. */
export type WithLedgerFields<T extends object> = T & LedgerEnvelopeFields;

/** A HandoffBundle as carried from the retried attempt: ledger-only
 *  precedingSessionId rides along but serializes onto nothing. */
export type HandoffBundleRecord = WithLedgerFields<HandoffBundle>;
