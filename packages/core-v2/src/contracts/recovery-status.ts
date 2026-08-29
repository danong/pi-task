/**
 * M5.5 recovery ledger status contracts (ADR docs/adr/m5.5-linear-recovery.md).
 *
 * Provider-neutral, strict, additive status vocabulary surfaced by the
 * standalone recovery ledger: lifecycle phase, typed blocker, and factual
 * run-lineage identities. A status read is a pure ledger fact — it never
 * restores a workspace, never claims, and never resumes. Only identities and
 * references are carried here, never bodies.
 */
import { z } from "zod";
import { CapPolicyIdSchema } from "./continuation-record.ts";

/** Lifecycle phase of one standalone run (R1 vocabulary). */
export const RecoveryPhaseSchema = z.enum([
	"failed",
	"resumable",
	"blocked",
	"claimed",
	"completed",
]);
export type RecoveryPhase = z.infer<typeof RecoveryPhaseSchema>;

/** Stable factual blocker vocabulary. Null means no blocker; a non-null
 *  blocker means the run is not resumable and states why (fail closed). */
export const RecoveryBlockerSchema = z.enum([
	"continuation_missing",
	"corrupt",
	"expired",
	"incompatible",
	"over_budget",
	"blocked",
]);
export type RecoveryBlocker = z.infer<typeof RecoveryBlockerSchema>;
export function isRecoveryBlocker(value: unknown): value is RecoveryBlocker {
	return RecoveryBlockerSchema.safeParse(value).success;
}

const runIdentity = z.string().min(1).max(256);
const sha256Reference = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Factual recovery status for one run lineage: the requested run resolved to
 *  the latest member of its successor chain. `resumeAllowed` is a ledger
 *  fact, not a promise; `blockedReason` is null unless the run is blocked. */
export const RecoveryStatusSchema = z
	.object({
		runId: runIdentity,
		taskId: runIdentity,
		specHash: sha256Reference,
		predecessorRunId: runIdentity.nullable(),
		successorRunId: runIdentity.nullable(),
		phase: RecoveryPhaseSchema,
		resumeAllowed: z.boolean(),
		blockedReason: RecoveryBlockerSchema.nullable(),
		workspaceStateId: runIdentity.nullable(),
		continuationRecordId: runIdentity.nullable(),
		capPolicyId: CapPolicyIdSchema,
		createdAt: z.string(),
		expiresAt: z.string(),
		engineVersion: z.string().min(1).max(128),
		workspaceCapabilityId: runIdentity.nullable(),
	})
	.strict();
export type RecoveryStatus = z.infer<typeof RecoveryStatusSchema>;

/** Zero additional inference on success: only non-completed/non-shipped
 * terminal outcomes retain recovery state. */
export function shouldPersistRecovery(taskStatus: string): boolean {
	return taskStatus !== "completed" && taskStatus !== "ship";
}

/** True when the recovery record has passed its declared expiry.
 * Malformed or unparseable expiry fails closed (treated as expired). */
export function isRecoveryExpired(
	status: Pick<RecoveryStatus, "expiresAt">,
	now: number | Date | string = Date.now(),
): boolean {
	const referenceMs =
		typeof now === "number"
			? now
			: now instanceof Date
				? now.getTime()
				: Date.parse(String(now));
	const expiryMs = Date.parse(status.expiresAt);
	if (!Number.isFinite(expiryMs) || !Number.isFinite(referenceMs)) return true;
	return expiryMs <= referenceMs;
}

/** Factual CLI-facing rendering for `status <run-id>`: deterministic fields
 * including lifecycle phase, resume eligibility, stable blocker reason and
 * successor run identity. No workspace restore, no claim. */
export function renderRecoveryStatus(status: RecoveryStatus): string {
	const parts: string[] = [
		`runId=${status.runId}`,
		`taskId=${status.taskId}`,
		`phase=${status.phase}`,
		`resume_allowed=${String(status.resumeAllowed)}`,
	];
	parts.push(`blocked_reason=${status.blockedReason ?? "none"}`);
	parts.push(`successor_run_id=${status.successorRunId ?? "none"}`);
	parts.push(`predecessor_run_id=${status.predecessorRunId ?? "none"}`);
	parts.push(`expiresAt=${status.expiresAt}`);
	parts.push(`continuationRecordId=${status.continuationRecordId ?? "none"}`);
	parts.push(`workspaceStateId=${status.workspaceStateId ?? "none"}`);
	return parts.join(" ");
}

/** Alias for renderRecoveryStatus — both names are supported by the contract. */
export function formatRecoveryStatus(status: RecoveryStatus): string {
	return renderRecoveryStatus(status);
}

/** Deterministic pruning order comparator: expiry asc, then terminal
 * settlement (completed/blocked) before resumable, then superseded lineage
 * (has successor) before leaf. */
export function compareRecoveryForPruning(
	a: RecoveryStatus,
	b: RecoveryStatus,
): number {
	const expiryA = Date.parse(a.expiresAt);
	const expiryB = Date.parse(b.expiresAt);
	const finiteA = Number.isFinite(expiryA) ? expiryA : Number.MAX_SAFE_INTEGER;
	const finiteB = Number.isFinite(expiryB) ? expiryB : Number.MAX_SAFE_INTEGER;
	if (finiteA !== finiteB) return finiteA - finiteB;
	const terminalScore = (s: RecoveryStatus): number => {
		if (s.phase === "completed") return 0;
		if (s.phase === "blocked" || s.phase === "claimed") return 1;
		return 2;
	};
	const ta = terminalScore(a);
	const tb = terminalScore(b);
	if (ta !== tb) return ta - tb;
	const succA = a.successorRunId !== null ? 0 : 1;
	const succB = b.successorRunId !== null ? 0 : 1;
	if (succA !== succB) return succA - succB;
	return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}

/** Stable factual blocker mapping: every blocker implies resume_allowed=false. */
export function blockedRecoveryStatus(
	status: RecoveryStatus,
	blocker: RecoveryBlocker,
): RecoveryStatus {
	return {
		...status,
		phase: "blocked",
		resumeAllowed: false,
		blockedReason: blocker,
	};
}
