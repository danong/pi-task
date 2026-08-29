/**
 * M5.5 deterministic continuation compiler + cap-policy pruner
 * (ADR docs/adr/m5.5-linear-recovery.md, seams 2/3).
 *
 * Pure and deterministic: inputs in, either a bounded ContinuationRecord or a
 * typed ContinuationBlockerResult out. No model calls, no I/O, no wall clock.
 * All ordering is stable over input metadata — (sequence, callId) for tool
 * pairs and (sequence, id) for context entries — so identical semantic input
 * compiles to identical bytes and hash regardless of construction key order.
 *
 * Invariants (R2/R3):
 *  - every retained tool pair is complete (callId + result present; isError
 *    is allowed); a half pair, a sensitive/host-path/token-unsafe pair, or an
 *    over-cap pair is dropped WHOLE, never half.
 *  - thinking/hidden/compaction/private-reasoning fields are never accepted:
 *    the caller must not supply them — if one appears the compiler asserts
 *    (throws) instead of silently admitting or dropping it.
 *  - mandatory task authority (taskGoal + artifactPolicy + workspaceRef +
 *    failureEvidence) is never pruned; if even the minimal record cannot fit
 *    the hard caps the compile is blocked (`over_budget`), never truncated.
 *  - pruning order is fixed: (a) mandatory authority rejection, (b) drop
 *    observability-only evidence chatter, (c) drop oldest visible
 *    message/context entries, (d) drop complete optional tool pairs
 *    oldest-first, never splitting a pair — retaining the newest eligible
 *    state only when both the UTF-8 byte cap and the deterministic token cap
 *    (estimateTokens = ceil(bytes/4), matching the grounding heuristic) and
 *    the pair/entry/per-entry caps all hold.
 */
import {
	canonicalBytes,
	canonicalContinuationBytes,
	ContinuationContextEntrySchema,
	ContinuationFailureEvidenceSchema,
	CONTINUATION_RECORD_VERSION,
	ContinuationRecordSchema,
	ContinuationToolPairSchema,
	DEFAULT_CONTINUATION_CAP_POLICY,
	isContinuationBlocker,
	type CapPolicyId,
	type ContinuationBlocker,
	type ContinuationCapPolicy,
	type ContinuationContextEntry,
	type ContinuationFailureEvidence,
	type ContinuationRecord,
	type ContinuationToolPair,
} from "../contracts/continuation-record.ts";
import { stableStringify } from "../contracts/serialize.ts";

/** Identity of this deterministic compiler; stored on every record. */
export const CONTINUATION_COMPILER_VERSION = "compiler-v1" as const;

/** Deterministic token estimate shared by compiler admission/pruning and the
 *  store gate. Mirrors task-runner.ts estimateGroundingTokens (4 bytes ≈ 1
 *  token) so recovery-state budgets are comparable with grounding budgets.
 *  Pure byte math — never a model call. */
export function estimateContinuationTokens(bytes: number): number {
	return Math.ceil(bytes / 4);
}

/** Typed failure result of compilation. A compiler never happily returns a
 *  truncated/over-cap record: when maximal pruning still cannot meet the caps
 *  it returns a blocker, never partial data. */
export interface ContinuationBlockerResult {
	status: "blocked";
	blocker: ContinuationBlocker;
	reason: string;
}

/** True when `value` is a typed compile blocker result. */
export function isContinuationBlockerResult(
	value: unknown,
): value is ContinuationBlockerResult {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as ContinuationBlockerResult).status === "blocked" &&
		isContinuationBlocker((value as ContinuationBlockerResult).blocker)
	);
}

/** Observed (possibly incomplete) tool-call/result pair before compilation.
 *  callId/result are optional precisely so an unpaired call or a missing
 *  result can be represented and then dropped whole by the compiler. */
export interface ObservedToolPair {
	callId?: string;
	sequence: number;
	toolName?: string;
	args?: unknown;
	result?: unknown;
	isError?: boolean;
	timestamp: string;
	[key: string]: unknown;
}

/** Observed (possibly incomplete) visible context entry before compilation.*/
export interface ObservedContextEntry {
	id?: string;
	sequence: number;
	kind: "message" | "context" | "evidence";
	text?: string;
	timestamp: string;
	[key: string]: unknown;
}

export interface ContinuationCompileInput {
	/** Immutable task authority — mandatory, never pruned or overridden. */
	taskGoal: string;
	artifactPolicy: string;
	workspaceRef: string;
	failureEvidence: ContinuationFailureEvidence;
	/** Observed complete-or-incomplete tool-call/result pairs. */
	observedToolPairs: readonly ObservedToolPair[];
	/** Observed visible context entries (message/context/evidence kinds). */
	observedContextEntries: readonly ObservedContextEntry[];
	/** References to existing M4 context/checkpoint artifacts (bodies stay in
	 *  their own stores). Non-prunable by construction. */
	checkpointRefs: readonly string[];
	taskId: string;
	specHash: string;
	artifactPolicyHash: string;
	compilerVersion: string;
	engineVersion: string;
	workspaceCapabilityId: string;
	PiJsonVersion: string;
	capPolicyId: CapPolicyId;
	/** ISO-8601 timestamp; expiresAt = createdAt + capPolicy.expiryMs. The
	 *  compiler is pure — it never reads the wall clock. */
	createdAt: string;
}

export interface ContinuationCompileOptions {
	/** Cap-policy override applied for admission + pruning. Defaults to
	 *  DEFAULT_CONTINUATION_CAP_POLICY (shared with the store gate). */
	capPolicy?: ContinuationCapPolicy;
}

/** Field names the record contract never carries. If a caller supplies any of
 *  these on a pair/entry the compiler asserts (throws) — it neither admits
 *  hidden state nor silently drops it. */
const FORBIDDEN_FIELD = /(thinking|hidden|compaction|privateReasoning|transcript)/i;

/** Secret-bearing JSON field names (matched as `"key":`), not arbitrary text. */
const SENSITIVE_FIELD =
	/"(?:authorization|bearer|api[_-]?key|access[_-]?key|secret|password|passwd|credential|private[_-]?key|session[_-]?id|client[_-]?secret|cookie|auth)"\s*:/i;

/** Value-level secret fingerprints (tokens/keys/paths embedded in content). */
const SECRET_VALUE =
	/(?:Bearer\s+[A-Za-z0-9._~+/=]{12,}|\bsk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9]{10,}|-----BEGIN\s+[A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16})/;

/** Deterministic host-path fingerprints: windows drive, UNC share, rooted
 *  system directories, and home short-hands. Relative repo paths (e.g.
 *  `packages/a/file.ts`) are ordinary tool arguments and are NOT treated as
 *  host paths. */
function isHostPathText(text: string): boolean {
	if (/[A-Za-z]:[/\\]/.test(text)) return true;
	if (/\\\\[\w.-]+\\/.test(text)) return true;
	if (/(^|[^\w/])\/(etc|home|Users|tmp|var|opt|usr|bin|srv|root|dev|proc)\//i.test(text))
		return true;
	if (/(^|[^\w/])~[/\\]/.test(text)) return true;
	return false;
}

/** A pair is sensitive/host-path/token-bearing when its canonical form carries
 *  secret field names, secret values, or absolute host paths — drop whole. */
function isSensitivePair(pair: ObservedToolPair): boolean {
	const serialized = stableStringify(pair) ?? "";
	return (
		SENSITIVE_FIELD.test(serialized) ||
		SECRET_VALUE.test(serialized) ||
		isHostPathText(serialized)
	);
}

function assertNoForbiddenFields(
	value: Record<string, unknown>,
	where: string,
): void {
	for (const key of Object.keys(value)) {
		if (FORBIDDEN_FIELD.test(key)) {
			throw new Error(
				`continuation compiler rejects forbidden ${where} field "${key}" (hidden/thinking/compaction content is never accepted)`,
			);
		}
	}
}

/** Deterministic ordering of context entries: ascending (sequence, id).
 *  Ties within a sequence resolve on id so "newest wins" is stable — never
 *  wall-clock timing. */
function compareContextEntry(
	a: ContinuationContextEntry,
	b: ContinuationContextEntry,
): number {
	return a.sequence - b.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Deterministic ordering of tool pairs: ascending (sequence, callId). */
function compareToolPair(
	a: ContinuationToolPair,
	b: ContinuationToolPair,
): number {
	return (
		a.sequence - b.sequence ||
		(a.callId < b.callId ? -1 : a.callId > b.callId ? 1 : 0)
	);
}

/** A context entry is dropped whole unless it carries id + kind + text.
 *  Entries that fail the record's own schema (e.g. text beyond the schema
 *  cap) are also dropped whole — visible context is retained mechanically
 *  and never half-included. */
function completeContextEntry(
	raw: ObservedContextEntry,
): ContinuationContextEntry | undefined {
	if (
		typeof raw.id !== "string" ||
		raw.id.length === 0 ||
		typeof raw.text !== "string"
	) {
		return undefined;
	}
	try {
		return ContinuationContextEntrySchema.parse(raw);
	} catch {
		return undefined;
	}
}

/** A tool pair is complete only when callId AND result are present. Missing
 *  either leaves a half pair, which is dropped whole. Pairs that fail the
 *  record's schema (malformed timestamp, empty tool name, unknown keys) are
 *  likewise dropped whole. */
function completeToolPair(
	raw: ObservedToolPair,
): ContinuationToolPair | undefined {
	if (
		typeof raw.callId !== "string" ||
		raw.callId.length === 0 ||
		!("result" in raw) ||
		raw.result === undefined
	) {
		return undefined;
	}
	try {
		return ContinuationToolPairSchema.parse(raw);
	} catch {
		return undefined;
	}
}

/** Observability-only chatter: kind=evidence entries whose text is
 *  operational/telemetry noise (log levels, heartbeats, metrics, status
 *  pings) rather than visible task context. Dropped first in pruning. */
function isObservabilityChatter(entry: ContinuationContextEntry): boolean {
	if (entry.kind !== "evidence") return false;
	const text = entry.text;
	return (
		/^\s*\[(?:info|debug|warn|warning|error|trace|verbose)\]/i.test(text) ||
		/\b(?:heartbeat|healthz?|telemetry|observability|metrics?)\b/i.test(text) ||
		/\b(?:status|progress|elapsed|latency)\s*[:-]/i.test(text) ||
		/\btoken\s+usage\b/i.test(text) ||
		/\b(?:ping|tick)\b/i.test(text)
	);
}

interface EntryState {
	entry: ContinuationContextEntry;
	observability: boolean;
}

/** Per-element canonical byte length (shared with the store gate). */
function elementBytes(value: unknown): number {
	return canonicalBytes(value).byteLength;
}

interface WorkingRecord {
	base: Omit<ContinuationRecord, "toolPairs" | "contextEntries">;
	toolPairs: ContinuationToolPair[];
	contextEntries: ContinuationContextEntry[];
}

function materialize(working: WorkingRecord): ContinuationRecord {
	const record = {
		...working.base,
		toolPairs: working.toolPairs,
		contextEntries: working.contextEntries,
	};
	return ContinuationRecordSchema.parse(record);
}

function overBudget(
	working: WorkingRecord,
	cap: ContinuationCapPolicy,
): boolean {
	const bytes = canonicalContinuationBytes(materialize(working));
	return (
		bytes.byteLength > cap.maxBytes ||
		estimateContinuationTokens(bytes.byteLength) > cap.maxTokens
	);
}

function addMillis(iso: string, ms: number): string {
	const msValue = Date.parse(iso);
	if (!Number.isFinite(msValue)) {
		throw new Error(`continuation compiler: invalid createdAt timestamp "${iso}"`);
	}
	return new Date(msValue + ms).toISOString();
}

function blocked(
	blocker: ContinuationBlocker,
	reason: string,
): ContinuationBlockerResult {
	return { status: "blocked", blocker, reason };
}

/**
 * Compile passively observed visible state into a bounded, deterministic
 * ContinuationRecord — or a typed blocker when the irreducible authority
 * cannot fit the caps or maximal pruning still exceeds them.
 *
 * Pure: no model call, no prompt, no ledger/CLI side effects, no wall clock.
 * Throws (asserts) when a caller supplies hidden/thinking/compaction fields.
 */
export function compileContinuationRecord(
	input: ContinuationCompileInput,
	options: ContinuationCompileOptions = {},
): ContinuationRecord | ContinuationBlockerResult {
	const cap = options.capPolicy ?? DEFAULT_CONTINUATION_CAP_POLICY;
	const createdAt = addMillis(input.createdAt, 0);
	const expiresAt = addMillis(input.createdAt, cap.expiryMs);

	// ── (1) admit observed pairs: complete + safe, drop half/unsafe whole ──
	const admittedPairs: ContinuationToolPair[] = [];
	for (const raw of input.observedToolPairs) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
		assertNoForbiddenFields(raw, "tool-pair");
		const complete = completeToolPair(raw);
		if (complete === undefined) continue; // half pair — dropped whole
		if (isSensitivePair(raw)) continue; // sensitive/host-path — dropped whole
		if (elementBytes(complete) > cap.maxBytesPerEntry) continue; // token-unsafe
		admittedPairs.push(complete);
	}
	admittedPairs.sort(compareToolPair);

	// ── (2) admit observed context entries, drop incomplete/oversized whole ──
	const admittedEntries: EntryState[] = [];
	for (const raw of input.observedContextEntries) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
		assertNoForbiddenFields(raw, "context-entry");
		const complete = completeContextEntry(raw);
		if (complete === undefined) continue; // incomplete — dropped whole
		if (elementBytes(complete) > cap.maxBytesPerEntry) continue; // oversized
		admittedEntries.push({ entry: complete, observability: isObservabilityChatter(complete) });
	}
	admittedEntries.sort((a, b) => compareContextEntry(a.entry, b.entry));

	// ── (3) base record — mandatory authority can never be pruned ──────
	const baseFields = {
		version: CONTINUATION_RECORD_VERSION,
		compilerVersion: input.compilerVersion,
		capPolicyId: input.capPolicyId,
		createdAt,
		expiresAt,
		engineVersion: input.engineVersion,
		workspaceCapabilityId: input.workspaceCapabilityId,
		PiJsonVersion: input.PiJsonVersion,
		taskId: input.taskId,
		specHash: input.specHash,
		artifactPolicyHash: input.artifactPolicyHash,
		taskGoal: input.taskGoal,
		artifactPolicy: input.artifactPolicy,
		workspaceRef: input.workspaceRef,
		failureEvidence: ContinuationFailureEvidenceSchema.parse(
			input.failureEvidence,
		),
		checkpointRefs: [...input.checkpointRefs],
	};
	const base: ContinuationRecord = ContinuationRecordSchema.parse({
		...baseFields,
		toolPairs: [],
		contextEntries: [],
	});
	const baseBytes = canonicalContinuationBytes(base);
	if (
		baseBytes.byteLength > cap.maxBytes ||
		estimateContinuationTokens(baseBytes.byteLength) > cap.maxTokens
	) {
		return blocked(
			"over_budget",
			`mandatory authority cannot fit continuation caps (${cap.maxBytes} bytes / ${cap.maxTokens} tokens)`,
		);
	}

	// ── (4) fixed ADR pruning order, always toward the newest state ────
	const working: WorkingRecord = {
		base: baseFields,
		toolPairs: admittedPairs,
		contextEntries: admittedEntries.map((state) => state.entry),
	};

	// (4b) drop observability-only evidence chatter first, always.
	working.contextEntries = admittedEntries
		.filter((state) => !state.observability)
		.map((state) => state.entry);

	// (4c) drop oldest visible message/context entries until byte+token caps
	// and the context-entry count cap hold.
	while (
		(overBudget(working, cap) ||
			working.contextEntries.length > cap.maxContextEntries) &&
		working.contextEntries.some(
			(entry) => entry.kind === "message" || entry.kind === "context",
		)
	) {
		const droppableIndex = working.contextEntries.findIndex(
			(entry) => entry.kind === "message" || entry.kind === "context",
		);
		if (droppableIndex < 0) break;
		working.contextEntries.splice(droppableIndex, 1);
	}

	// (4d) drop complete optional tool pairs oldest-first (never splitting a
	// pair) until byte+token caps and the pair-count cap hold.
	while (
		(overBudget(working, cap) || working.toolPairs.length > cap.maxPairs) &&
		working.toolPairs.length > 0
	) {
		working.toolPairs.shift();
	}

	// ── (5) final admit: regenerate, re-measure, fail closed ───────────
	const record = materialize(working);
	const finalBytes = canonicalContinuationBytes(record);
	if (
		finalBytes.byteLength > cap.maxBytes ||
		estimateContinuationTokens(finalBytes.byteLength) > cap.maxTokens
	) {
		return blocked(
			"over_budget",
			`record exceeds continuation caps after maximal pruning (${finalBytes.byteLength} bytes / ${estimateContinuationTokens(finalBytes.byteLength)} tokens)`,
		);
	}
	return record;
}

/** Successful runs add zero extra inference from M5.5: only non-completed /
 *  non-shipped terminal outcomes retain a continuation record. Pure signal,
 *  no side effects. */
export function shouldPersistContinuationRecord(status: string): boolean {
	return status !== "completed" && status !== "ship";
}
