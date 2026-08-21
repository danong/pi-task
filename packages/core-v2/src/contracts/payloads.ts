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
 * Retry handoff (FR-7). payload timeout/capFixOutput semantics apply per
 * failure: uncommittedDiffSummary is capped, tails are capped. The
 * attempt-carrying compensation fields are ledger-only and removed from
 * the serialized shape (deterministic-prefix / NFR-4 rule).
 */
export const HandoffBundleSchema = z.object({
	taskId: z.string(),
	uncommittedDiffSummary: z.string().max(60_000),
	filesTouched: z.array(z.string()),
	verificationFailures: z.array(VerificationFailureSchema),
	attemptNumber: z.number().int().min(1),
});
export type HandoffBundle = z.infer<typeof HandoffBundleSchema>;

/** Typed worker completion (yield tool contract; FR-9 closure). */
export const YieldSchema = z.object({
	files_changed: z.array(z.string()),
	summary: z.string(),
	commit_ids: z.array(z.string()),
	// empty when none; feeds fork_deviation_rate telemetry (§5.4).
	deviations: z.array(z.string()),
});
export type Yield = z.infer<typeof YieldSchema>;

/**
 * ≈150-token receipt so a spec-authoring session survives many tasks
 * (§5.6). turns/costUsd/bundleHit are router feedback (FR-9/FR-10).
 */
export const TaskReceiptSchema = z.object({
	taskId: z.string(),
	verdict: z.enum(["ship", "escalate", "failed"]),
	filesChanged: z.number(),
	commitIds: z.array(z.string()),
	turns: z.number(),
	costUsd: z.number(),
	/** mode-(b) telemetry: null = bundle not used. */
	bundleHit: z.boolean().nullable(),
});
export type TaskReceipt = z.infer<typeof TaskReceiptSchema>;

/** Fields that vary per attempt, carried on runtime records but never
 *  prompt-bound (deterministic-serialization rule). The ledger is the
 *  sole owner; serialize.ts strips them via the schema. */
export interface LedgerEnvelopeFields {
	createdAt?: string;
	sessionId?: string;
	runId?: string;
	precedingSessionId?: string;
}

/** A prompt-bound payload together with its ledger-only envelope. */
export type WithLedgerFields<T extends object> = T & LedgerEnvelopeFields;

/** A HandoffBundle as carried from the retried attempt: ledger-only
 *  precedingSessionId rides along but serializes onto nothing. */
export type HandoffBundleRecord = WithLedgerFields<HandoffBundle>;