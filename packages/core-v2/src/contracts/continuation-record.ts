/**
 * M5.5 continuation-record contracts (ADR docs/adr/m5.5-linear-recovery.md).
 *
 * Passive, versioned, provider-neutral recovery state for a standalone run:
 * the immutable task/spec and artifact-policy authority, complete visible
 * tool-call/result pairs, bounded visible context, and typed failure
 * evidence. This milestone ships ONLY the contracts — capture wiring,
 * deterministic compilation, cap-policy application and pruning land in
 * later milestones (seam 1 → seams 2/3 of the ADR).
 *
 * Strict and additive: no model calls, no ledger, no CLI, no watchdog.
 * Serialization is deterministic (sorted keys via stableStringify) so
 * identical semantic records hash to identical bytes; records never carry
 * hidden reasoning, transcripts, host paths, credentials, or opaque
 * provider details.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { stableStringify } from "./serialize.ts";

/** Current continuation-record schema version. Additive readers may accept an
 *  explicitly supported older version; unsupported versions fail closed. */
export const CONTINUATION_RECORD_VERSION = 1 as const;

/** Stable factual blocker vocabulary for recovery state that fails closed
 *  (missing, hash/length-invalid/corrupt, expired, incompatible, over-budget,
 *  or otherwise blocked) before any workspace restore or session spawn. */
export const ContinuationBlockerSchema = z.enum([
	"continuation_missing",
	"corrupt",
	"expired",
	"incompatible",
	"over_budget",
	"blocked",
]);
export type ContinuationBlocker = z.infer<typeof ContinuationBlockerSchema>;
export function isContinuationBlocker(
	value: unknown,
): value is ContinuationBlocker {
	return ContinuationBlockerSchema.safeParse(value).success;
}

/** Versioned cap-policy identity (e.g. `cap-v1-core-default`). Records carry
 *  only the policy reference; the policy body itself lives in versioned
 *  configuration, never inside the record. */
export const CapPolicyIdSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^cap-v[0-9]+-[a-z0-9][a-z0-9-]*$/);
export type CapPolicyId = z.infer<typeof CapPolicyIdSchema>;

/** Cap policy referenced by `capPolicyId`: UTF-8 byte cap, deterministic
 *  token estimate/cap, entry/pair caps, per-entry byte cap, and expiry.
 *  Applied twice (R4): at compiler admission/pruning and again at store
 *  `validate`/`read` — both default to DEFAULT_CONTINUATION_CAP_POLICY
 *  with an optional supplied override. */
export const ContinuationCapPolicySchema = z
	.object({
		maxBytes: z.number().int().positive(),
		maxTokens: z.number().int().positive(),
		maxPairs: z.number().int().positive(),
		maxContextEntries: z.number().int().positive(),
		maxBytesPerEntry: z.number().int().positive(),
		expiryMs: z.number().int().positive(),
	})
	.strict();
export type ContinuationCapPolicy = z.infer<typeof ContinuationCapPolicySchema>;

export const DEFAULT_CONTINUATION_CAP_POLICY_ID =
	"cap-v1-core-default" as const;

/** Default cap policy for the compiler/pruner and store admission gate. */
export const DEFAULT_CONTINUATION_CAP_POLICY: ContinuationCapPolicy =
	Object.freeze({
		maxBytes: 512 * 1024,
		maxTokens: 128_000,
		maxPairs: 256,
		maxContextEntries: 512,
		maxBytesPerEntry: 4_096,
		expiryMs: 7 * 24 * 60 * 60 * 1000,
	});

/** One complete visible tool-call/result pair: the call ID plus the terminal
 *  result (including a typed error result) as one unit. A pair is retained
 *  whole or omitted whole — never split. */
export const ContinuationToolPairSchema = z
	.object({
		callId: z.string().min(1).max(256),
		sequence: z.number().int().nonnegative(),
		toolName: z.string().min(1).max(256),
		args: z.unknown(),
		result: z.unknown(),
		isError: z.boolean(),
		timestamp: z.string().datetime(),
	})
	.strict();
export type ContinuationToolPair = z.infer<typeof ContinuationToolPairSchema>;

/** One selected visible task-context entry (bounded text, stable order).
 *  Retained mechanically — never semantically summarized or ranked. */
export const ContinuationContextEntrySchema = z
	.object({
		id: z.string().min(1).max(256),
		sequence: z.number().int().nonnegative(),
		kind: z.enum(["message", "context", "evidence"]),
		text: z.string().max(4_000),
		timestamp: z.string().datetime(),
	})
	.strict();
export type ContinuationContextEntry = z.infer<
	typeof ContinuationContextEntrySchema
>;

/** Typed engine failure and verification evidence — mandatory authority for
 *  any resumable record. Factual only: no transcript, no hidden reasoning. */
export const ContinuationFailureEvidenceSchema = z
	.object({
		kind: z.enum([
			"provider",
			"process",
			"tool",
			"budget",
			"verification",
			"settlement",
			"unknown",
		]),
		summary: z.string().min(1).max(4_000),
		verificationStatus: z.enum(["not-run", "passed", "failed", "unknown"]),
		timestamp: z.string().datetime(),
	})
	.strict();
export type ContinuationFailureEvidence = z.infer<
	typeof ContinuationFailureEvidenceSchema
>;

const sha256Reference = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Versioned passive continuation record. The authoritative authority fields
 *  (taskGoal + artifactPolicy + workspaceRef + failureEvidence) are mandatory
 *  and can never be pruned or overridden. toolPairs keep complete pairs,
 *  contextEntries bound the selected visible context, and checkpointRefs
 *  reference existing M4 context/checkpoint artifacts (bodies stay in their
 *  own stores). Provider-neutral: no host paths, tokens, or workspace
 *  internals. */
export const ContinuationRecordSchema = z
	.object({
		version: z.literal(CONTINUATION_RECORD_VERSION),
		compilerVersion: z.string().min(1).max(128),
		capPolicyId: CapPolicyIdSchema,
		createdAt: z.string().datetime(),
		expiresAt: z.string().datetime(),
		engineVersion: z.string().min(1).max(128),
		workspaceCapabilityId: z.string().min(1).max(256),
		PiJsonVersion: z.string().min(1).max(128),
		taskId: z.string().min(1).max(256),
		specHash: sha256Reference,
		artifactPolicyHash: sha256Reference,
		taskGoal: z.string().min(1).max(8_000),
		artifactPolicy: z.string().min(1).max(16_000),
		workspaceRef: z.string().min(1).max(512),
		failureEvidence: ContinuationFailureEvidenceSchema,
		toolPairs: z.array(ContinuationToolPairSchema).max(1_024),
		contextEntries: z.array(ContinuationContextEntrySchema).max(2_048),
		checkpointRefs: z.array(sha256Reference).max(256),
	})
	.strict();
export type ContinuationRecord = z.infer<typeof ContinuationRecordSchema>;

/** True when the record has passed its declared expiry. Expired state is
 *  never resumable, so malformed or unparseable expiry fails closed. */
export function isExpired(
	record: ContinuationRecord,
	now: number | Date | string = Date.now(),
): boolean {
	const referenceMs =
		typeof now === "number"
			? now
			: now instanceof Date
				? now.getTime()
				: Date.parse(now);
	const expiryMs = Date.parse(record.expiresAt);
	if (!Number.isFinite(expiryMs) || !Number.isFinite(referenceMs)) return true;
	return expiryMs <= referenceMs;
}

/** Canonical bytes of an arbitrary record element (tool pair, context entry)
 *  or any value: sorted-key JSON plus a trailing newline. Per-entry/byte-cap
 *  measurement uses the same canonicalization as full-record hashing so all
 *  byte math is consistent across compiler, store, and hash. */
export function canonicalBytes(value: unknown): Buffer {
	return Buffer.from(`${stableStringify(value)}\n`, "utf8");
}

/** Canonical bytes of a full record — the single deterministic byte form used
 *  for cap measurement, storage, and hashing. */
export function canonicalContinuationBytes(record: ContinuationRecord): Buffer {
	return canonicalBytes(ContinuationRecordSchema.parse(record));
}

/** Deterministic content identity: sha256 over the canonical sorted-key JSON
 *  bytes (stableStringify + trailing newline). Identical semantic records —
 *  regardless of construction key order — hash identically. */
export function hashRecord(record: ContinuationRecord): string {
	const bytes = canonicalContinuationBytes(record);
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
