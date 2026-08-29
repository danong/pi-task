/**
 * Hermetic regressions for the M5.5 deterministic continuation compiler and
 * the cap-policy-enforcing store gate (R2–R7).
 *
 *   - deterministic bytes/hash for identical input regardless of key order
 *   - complete-pair invariant (half pairs, sensitive/host-path pairs, and
 *     incomplete entries are dropped WHOLE; never half)
 *   - task-authority non-prunable rejection (mandatory over-budget → blocked)
 *   - strict byte + token cap compliance (estimateTokens = ceil(bytes/4))
 *   - over-budget after maximal pruning → typed `over_budget` blocker, never a
 *     truncated record
 *   - exact ADR pruning order: observability chatter → oldest visible context
 *     → oldest tool pairs; newest retained; newest-wins tie-break
 *   - hostile/malformed/corrupt/incompatible/expired records map to typed
 *     blockers at store.validate (read may still throw on corrupt)
 *   - shouldPersistContinuationRecord stays TRUE for non-shipping outcomes
 *
 * Zero LLM, zero network, zero wall-clock dependence (timestamps are inputs).
 * At least one assertion here fails on the pre-change tree because
 * continuation-compiler.ts does not exist there.
 *
 * Standalone: npx tsx packages/core-v2/test/test-continuation-compiler.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	canonicalContinuationBytes,
	ContinuationToolPairSchema,
	DEFAULT_CONTINUATION_CAP_POLICY,
	hashRecord,
	type ContinuationCapPolicy,
	type ContinuationRecord,
	type ContinuationToolPair,
} from "../src/contracts/continuation-record.ts";
import {
	compileContinuationRecord,
	estimateContinuationTokens,
	isContinuationBlockerResult,
	shouldPersistContinuationRecord,
	type ContinuationBlockerResult,
	type ContinuationCompileInput,
	type ObservedContextEntry,
	type ObservedToolPair,
} from "../src/context/continuation-compiler.ts";
import {
	ContinuationAdmissionError,
	createContinuationStore,
	type ContinuationStore,
} from "../src/context/continuation-store.ts";

// Fixed input clock — the compiler never reads the wall clock, and this suite
// must be deterministic across runs.
const NOW = "2026-08-29T12:00:00.000Z";

/** Generous policy used to probe baseline record sizes without pruning bites. */
const GENEROUS: ContinuationCapPolicy = {
	maxBytes: 1024 * 1024,
	maxTokens: 1_000_000,
	maxPairs: 512,
	maxContextEntries: 1_024,
	maxBytesPerEntry: 16 * 1024,
	expiryMs: 7 * 24 * 60 * 60 * 1000,
};

const DEFAULT_FAILURE = {
	kind: "process" as const,
	summary: "worker process exited before yield",
	verificationStatus: "not-run" as const,
	timestamp: NOW,
};

function makeInput(
	overrides: Partial<ContinuationCompileInput> = {},
): ContinuationCompileInput {
	return {
		taskGoal: "Ship the rewind feature.",
		artifactPolicy: '{"accept":{"maxBytes":1024}}',
		workspaceRef: "opaque-workspace-continuation:rev-1",
		failureEvidence: { ...DEFAULT_FAILURE, timestamp: NOW },
		observedToolPairs: [
			{
				callId: "call-1",
				sequence: 0,
				toolName: "read",
				args: { path: "a.ts" },
				result: { lines: 3 },
				isError: false,
				timestamp: NOW,
			},
		],
		observedContextEntries: [
			{
				id: "ctx-1",
				sequence: 1,
				kind: "message",
				text: "disk layout settled",
				timestamp: NOW,
			},
		],
		checkpointRefs: ["sha256:" + "3".repeat(64)],
		taskId: "task-1",
		specHash: "sha256:" + "1".repeat(64),
		artifactPolicyHash: "sha256:" + "2".repeat(64),
		compilerVersion: "compiler-v1",
		engineVersion: "engine-v1",
		workspaceCapabilityId: "workspace.jj.v1",
		PiJsonVersion: "pi-json-v1",
		capPolicyId: "cap-v1-core-default",
		createdAt: NOW,
		...overrides,
	};
}

function compile(
	input: ContinuationCompileInput,
	capPolicy: ContinuationCapPolicy = DEFAULT_CONTINUATION_CAP_POLICY,
): ContinuationRecord | ContinuationBlockerResult {
	return compileContinuationRecord(input, { capPolicy });
}

function isRecord(value: ContinuationRecord | ContinuationBlockerResult): value is ContinuationRecord {
	return !isContinuationBlockerResult(value);
}

function record(a: ContinuationRecord | ContinuationBlockerResult): ContinuationRecord {
	if (!isRecord(a))
		throw new Error(`expected a record, got blocker ${a.blocker}: ${a.reason}`);
	return a;
}

function blocked(
	a: ContinuationRecord | ContinuationBlockerResult,
): ContinuationBlockerResult {
	if (isContinuationBlockerResult(a)) return a;
	throw new Error("expected a blocker, got a record");
}

function recordBytes(r: ContinuationRecord): number {
	return canonicalContinuationBytes(r).byteLength;
}

/** Probe the canonical size of a semantically-identical record so budgets in
 *  pruning tests are derived from the same serialization the gate measures. */
function probeBytes(
	input: ContinuationCompileInput,
	capPolicy: ContinuationCapPolicy = GENEROUS,
): number {
	const result = compile(input, capPolicy);
	if (!isRecord(result)) {
		throw new Error(`probe unexpectedly blocked: ${result.blocker}: ${result.reason}`);
	}
	return recordBytes(result);
}

function pair(
	callId: string,
	sequence: number,
	extra: Partial<ContinuationToolPair> = {},
): ObservedToolPair {
	return {
		callId,
		sequence,
		toolName: "read",
		args: {},
		result: { ok: `pair-${callId}` },
		isError: false,
		timestamp: NOW,
		...extra,
	};
}

function entry(
	id: string,
	sequence: number,
	kind: "message" | "context" | "evidence",
	text: string,
): ObservedContextEntry {
	return { id, sequence, kind, text, timestamp: NOW };
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// ─── Determinism: identical input → identical bytes/hash, key-order free ──
	{
		const inputA = makeInput({
			observedToolPairs: [
				pair("call-1", 2, { timestamp: NOW }),
				pair("call-2", 0, { timestamp: NOW }),
			],
			observedContextEntries: [
				entry("ctx-b", 8, "message", "b"),
				entry("ctx-a", 7, "message", "a"),
				entry("ctx-c", 8, "context", "c"),
			],
		});
		// Rebuild the same semantic input with every object's keys reversed.
		const reorder = (value: unknown): unknown => {
			if (Array.isArray(value)) return value.map(reorder);
			if (value !== null && typeof value === "object") {
				const source = value as Record<string, unknown>;
				const out: Record<string, unknown> = {};
				for (const key of Object.keys(source).reverse()) out[key] = reorder(source[key]);
				return out;
			}
			return value;
		};
		const inputB = reorder(inputA) as ContinuationCompileInput;
		const a = record(compile(inputA));
		const b = record(compile(inputB));
		const aAgain = record(compile(inputA));
		check(
			canonicalContinuationBytes(a).toString("hex") ===
				canonicalContinuationBytes(b).toString("hex"),
			"identical semantic input compiles to identical bytes regardless of key order",
		);
		check(
			hashRecord(a) === hashRecord(b) && hashRecord(a) === hashRecord(aAgain),
			"identical semantic input hashes identically across key orders",
		);
		check(
			a.toolPairs.map((p) => p.callId).join(",") === "call-2,call-1" &&
				ContinuationToolPairSchema.parse(a.toolPairs[0]!).callId === "call-2",
			"stable sort orders tool pairs by (sequence, callId), not input order",
		);
		check(
			a.contextEntries.map((e) => e.id).join(",") === "ctx-a,ctx-b,ctx-c",
			"stable sort orders context entries by (sequence, id), not input order",
		);
	}

	// ─── Complete-pair invariant: half/sensitive/host-path/incomplete dropped
	//     WHOLE, plus compiler asserts on hidden/thinking fields ─────────────
	{
		const input = makeInput({
			observedToolPairs: [
				pair("good", 5),
				// half pair — result missing
				{ callId: "half-result", sequence: 3, toolName: "bash", args: { cmd: "true" }, timestamp: NOW },
				// half pair — callId missing
				{ sequence: 4, toolName: "read", result: { lines: 2 }, timestamp: NOW },
				// sensitive (volume 300 pairs keeps budget loose) — secret key in args
				{ ...pair("secret", 2), args: { apiKey: "sk-proj-0123456789abcdef" } },
				// host path embedded in result
				{ ...pair("hostpath", 1), result: { file: "C:\\Users\\me\\secret.txt" } },
			],
			observedContextEntries: [
				entry("ok-ctx", 6, "message", "fine"),
				// incomplete entry — id missing
				{ sequence: 9, kind: "message", text: "orphan text", timestamp: NOW },
				// incomplete entry — text missing
				{ id: "no-text", sequence: 10, kind: "context", timestamp: NOW },
			],
		});
		const result = record(compile(input));
		check(
			result.toolPairs.length === 1 &&
				result.toolPairs[0]!.callId === "good",
			"half and sensitive/host-path pairs are dropped whole; only the complete safe pair survives",
		);
		check(
			!result.toolPairs.some(
				(p) =>
					p.callId === "secret" ||
					p.callId === "hostpath" ||
					p.callId === "half-result",
			) &&
				result.toolPairs.every((p) => p.callId === "good"),
			"no half/secret pair leaks any field (never half-retained)",
		);
		check(
			result.contextEntries.length === 1 &&
				result.contextEntries[0]!.id === "ok-ctx",
			"incomplete context entries are dropped whole",
		);

		let threwThinking = false;
		try {
			compile(
				makeInput({
					observedToolPairs: [{ ...pair("t", 0), thinking: "not allowed" }],
				}),
			);
		} catch {
			threwThinking = true;
		}
		check(threwThinking, "compiler asserts when a caller supplies thinking fields");
		let threwHidden = false;
		try {
			compile(
				makeInput({
					observedContextEntries: [
						{ ...entry("h", 0, "message", "x"), hidden: true },
					],
				}),
			);
		} catch {
			threwHidden = true;
		}
		check(threwHidden, "compiler asserts when a caller supplies hidden fields");
		let threwCompaction = false;
		try {
			compile(
				makeInput({
					observedContextEntries: [
						{ ...entry("c", 0, "message", "x"), compaction: "evict-3" },
					],
				}),
			);
		} catch {
			threwCompaction = true;
		}
		check(
			threwCompaction,
			"compiler asserts when a caller supplies compaction fields",
		);
	}

	// ─── Mandatory authority is non-prunable: over-budget → blocked ────────
	{
		const tiny: ContinuationCapPolicy = {
			maxBytes: 32,
			maxTokens: 8,
			maxPairs: 1,
			maxContextEntries: 1,
			maxBytesPerEntry: 4_096,
			expiryMs: 60_000,
		};
		const result = blocked(compile(makeInput(), tiny));
		check(
			result.status === "blocked" && result.blocker === "over_budget",
			"mandatory authority that cannot fit hard caps is rejected over_budget",
		);
	}

	// ─── Strict byte + token cap compliance (estimateTokens = ceil(bytes/4)) ──
	{
		const empty = makeInput({ observedToolPairs: [], observedContextEntries: [] });
		const baseBytes = probeBytes(empty);
		const baseTokens = estimateContinuationTokens(baseBytes);

		// Token-driven pruning: byte cap enormous, token cap just above base.
		const tokenTight: ContinuationCapPolicy = {
			...GENEROUS,
			maxBytes: 1024 * 1024,
			maxTokens: baseTokens + 24,
		};
		const tokenInput = makeInput({
			observedToolPairs: [
				pair("p1", 0),
				pair("p2", 1),
				pair("p3", 2),
				pair("p4", 3),
			],
			observedContextEntries: [
				entry("e1", 1, "message", "goal: " + "ship the feature, carefully"),
				entry("e2", 2, "context", "spec excerpt " + "about invariants".repeat(3)),
				entry("e3", 3, "message", "plan the next integration step"),
				entry("e4", 4, "message", "final verification checklist"),
			],
		});
		const tokenResult = record(compile(tokenInput, tokenTight));
		const tokenBytes = recordBytes(tokenResult);
		const tokensOut = estimateContinuationTokens(tokenBytes);
		check(
			tokenBytes <= tokenTight.maxBytes && tokensOut <= tokenTight.maxTokens,
			`token cap held: ${tokenBytes}B / ${tokensOut} est. tokens ≤ ${tokenTight.maxTokens}`,
		);
		check(
			tokenResult.contextEntries.length + tokenResult.toolPairs.length < 8,
			"token-tight policy forced pruning before admission",
		);

		// Byte-driven pruning: token cap enormous, byte cap just above base.
		const byteTight: ContinuationCapPolicy = {
			...GENEROUS,
			maxBytes: baseBytes + 2_400,
			maxTokens: 1_000_000,
		};
		const byteResult = record(compile(tokenInput, byteTight));
		const byteOut = recordBytes(byteResult);
		check(
			byteOut <= byteTight.maxBytes &&
				estimateContinuationTokens(byteOut) <= byteTight.maxTokens,
			`byte cap held: ${byteOut}B ≤ ${byteTight.maxBytes} and token cap held`,
		);

		// A compiled (record) result always satisfies EVERY cap dimension.
		const strict = record(compile(tokenInput));
		check(
			recordBytes(strict) <= DEFAULT_CONTINUATION_CAP_POLICY.maxBytes &&
				estimateContinuationTokens(recordBytes(strict)) <=
					DEFAULT_CONTINUATION_CAP_POLICY.maxTokens &&
				strict.toolPairs.length <= DEFAULT_CONTINUATION_CAP_POLICY.maxPairs &&
				strict.contextEntries.length <=
					DEFAULT_CONTINUATION_CAP_POLICY.maxContextEntries,
			"default cap policy is fully respected by the compiler",
		);
	}

	// ─── Over-budget after maximal pruning → typed blocker, never a
	//     truncated record (non-droppable evidence retention) ───────────────
	{
		const baseOnly = makeInput({ observedToolPairs: [], observedContextEntries: [] });
		const baseSize = probeBytes(baseOnly);
		// Cap fits the base alone but not base + the retained evidence entry.
		const evTight: ContinuationCapPolicy = {
			...GENEROUS,
			maxBytes: baseSize,
			maxTokens: 1_000_000,
		};
		const input = makeInput({
			observedToolPairs: [],
			observedContextEntries: [
				// NOT observability chatter (kind=evidence, plain factual text) →
				// never droppable, so maximal pruning still cannot fit.
				entry("ev-keep", 1, "evidence", "verification gate was reached"),
			],
		});
		const result = blocked(compile(input, evTight));
		check(
			result.status === "blocked" && result.blocker === "over_budget",
			"over-budget after maximal pruning returns a typed blocker, not a truncated record",
		);
	}

	// ─── ADR pruning order: observability → oldest context → oldest pairs,
	//     newest retained; newest wins ties ─────────────────────────────────
	{
		const obsA = entry("obs-a", 1, "evidence", "[info] worker started");
		const oldMsg = entry("old-msg", 2, "message", "initial goal statement");
		const midCtx = entry("mid-ctx", 3, "context", "spec excerpt");
		const newMsg = entry("new-msg", 4, "message", "final integration plan");
		const obsB = entry("obs-b", 5, "evidence", "telemetry: attempt 1 complete");
		const p0 = pair("p0", 0);
		const p1 = pair("p1", 1);
		const p2 = pair("p2", 2);

		// Scenario A: budget fits the newest message + every pair, but not the
		// older context or any observability entry.
		const aProbe = makeInput({
			observedToolPairs: [p0, p1, p2],
			observedContextEntries: [newMsg],
		});
		const aCap = { ...GENEROUS, maxBytes: probeBytes(aProbe) };
		const aInput = makeInput({
			observedToolPairs: [p0, p1, p2],
			observedContextEntries: [obsA, oldMsg, midCtx, newMsg, obsB],
		});
		const aRecord = record(compile(aInput, aCap));
		check(
			aRecord.contextEntries.map((e) => e.id).join(",") === "new-msg" &&
				!aRecord.contextEntries.some(
					(e) => e.kind === "evidence" && (e.id === "obs-a" || e.id === "obs-b"),
				),
			"observability chatter dropped first, oldest context dropped, newest message retained",
		);
		check(
			aRecord.toolPairs.map((p) => p.callId).join(",") === "p0,p1,p2",
			"tool pairs untouched while any visible context can still be pruned",
		);

		// Scenario B: budget fits only the newest pair → all visible context is
		// pruned BEFORE any tool pair, then pairs drop oldest-first.
		const bProbe = makeInput({
			observedToolPairs: [p2],
			observedContextEntries: [],
		});
		const bCap = { ...GENEROUS, maxBytes: probeBytes(bProbe) };
		const bInput = makeInput({
			observedToolPairs: [p0, p1, p2],
			observedContextEntries: [oldMsg, midCtx, newMsg],
		});
		const bRecord = record(compile(bInput, bCap));
		check(
			bRecord.contextEntries.length === 0 &&
				bRecord.toolPairs.map((p) => p.callId).join(",") === "p2",
			"pairs are the last resort: all context pruned first, newest pair retained",
		);

		// Newest-wins tie-break on context: same sequence, higher id retained.
		const tieCProbe = makeInput({
			observedToolPairs: [],
			observedContextEntries: [entry("tie-b", 7, "message", "newer id")],
		});
		const tieCCap = { ...GENEROUS, maxBytes: probeBytes(tieCProbe) };
		const tieC = record(
			compile(
				makeInput({
					observedToolPairs: [],
					observedContextEntries: [
						entry("tie-a", 7, "message", "older id"),
						entry("tie-b", 7, "message", "newer id"),
					],
				}),
				tieCCap,
			),
		);
		check(
			tieC.contextEntries.length === 1 &&
				tieC.contextEntries[0]!.id === "tie-b" &&
				tieC.contextEntries[0]!.sequence === 7,
			"context tie broken by (sequence, id): newest id wins",
		);

		// Newest-wins tie-break on pairs: same sequence, higher callId retained.
		const tiePProbe = makeInput({
			observedToolPairs: [pair("pb", 9)],
			observedContextEntries: [],
		});
		const tiePCap = { ...GENEROUS, maxBytes: probeBytes(tiePProbe) };
		const tieP = record(
			compile(
				makeInput({
					observedToolPairs: [pair("pa", 9), pair("pb", 9)],
					observedContextEntries: [],
				}),
				tiePCap,
			),
		);
		check(
			tieP.toolPairs.length === 1 && tieP.toolPairs[0]!.callId === "pb",
			"pair tie broken by (sequence, callId): newest callId wins",
		);
	}

	// ─── Store gate: compiler output passes; hostile/malformed/non-canonical/
	//     incompatible/expired/over-budget map to typed blockers; corrupt read
	//     may still throw; compiler output round-trips through write/read ────
	const storeRoot = mkdtempSync(join(tmpdir(), "core-v2-test-continuation-compiler-"));
	try {
		const store: ContinuationStore = createContinuationStore({ root: storeRoot });
		const liveInput = makeInput({ createdAt: new Date().toISOString(), failureEvidence: { ...DEFAULT_FAILURE, timestamp: new Date().toISOString() } });
		const compiledRecord = record(compile(liveInput));

		// Compiler output passes the same gate that persists it.
		const admitted = await store.validate(compiledRecord);
		check(admitted.status === "valid", "store gate accepts a compiler-produced record");
		const persistedId = await store.write(compiledRecord);
		check(persistedId === hashRecord(compiledRecord), "write returns the deterministic content hash");
		const readBack = await store.read(persistedId);
		check(
			readBack !== undefined &&
				canonicalContinuationBytes(readBack).toString("hex") ===
					canonicalContinuationBytes(compiledRecord).toString("hex"),
			"store write/read round-trips the compiled record",
		);

		// Malformed JSON → corrupt blocker (no throw).
		const malformed = await store.validate('{"version": ');
		check(
			malformed.status === "blocked" && malformed.blocker === "corrupt",
			"hostile/malformed JSON maps to a typed corrupt blocker",
		);

		// Hostile record (bad authority identity) → corrupt blocker.
		const hostile = await store.validate({ ...compiledRecord, specHash: "sha256:not-hex" });
		check(
			hostile.status === "blocked" && hostile.blocker === "corrupt",
			"hostile/malformed record maps to a typed corrupt blocker",
		);

		// Non-canonical serialization → corrupt blocker.
		const nonCanonicalJson = JSON.stringify(compiledRecord);
		const nonCanonical = await store.validate(nonCanonicalJson);
		check(
			nonCanonical.status === "blocked" && nonCanonical.blocker === "corrupt",
			"non-canonical serialization maps to a typed corrupt blocker",
		);
		// The canonical serialization IS accepted (proves the gate measures the
		// same deterministic bytes the compiler writes).
		const canonicalJson = canonicalContinuationBytes(compiledRecord).toString("utf8");
		const canonical = await store.validate(canonicalJson);
		check(
			canonical.status === "valid",
			"canonical serialization is accepted by the store gate",
		);

		// Incompatible version → incompatible blocker.
		const incompatible = await store.validate({ ...compiledRecord, version: 2 });
		check(
			incompatible.status === "blocked" && incompatible.blocker === "incompatible",
			"incompatible record version maps to a typed incompatible blocker",
		);

		// Expired timestamp → expired blocker.
		const expired = await store.validate({
			...compiledRecord,
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
		});
		check(
			expired.status === "blocked" && expired.blocker === "expired",
			"expired timestamp maps to a typed expired blocker",
		);

		// Over-budget at the store gate (supplied cap-policy override) →
		// over_budget blocker, and write fails closed with a typed error.
		const tinyStore = createContinuationStore({
			root: join(storeRoot, "tiny"),
			capPolicy: {
				maxBytes: 128,
				maxTokens: 32,
				maxPairs: 1,
				maxContextEntries: 1,
				maxBytesPerEntry: 64,
				expiryMs: 60_000,
			},
		});
		const overBudgetGate = await tinyStore.validate(compiledRecord);
		check(
			overBudgetGate.status === "blocked" && overBudgetGate.blocker === "over_budget",
			"over-budget record maps to a typed over_budget blocker at the store gate",
		);
		let writeBlocker: string | undefined;
		try {
			await tinyStore.write(compiledRecord);
		} catch (error: unknown) {
			writeBlocker =
				error instanceof ContinuationAdmissionError ? error.blocker : undefined;
		}
		check(
			writeBlocker === "over_budget",
			"write fails closed with a typed over_budget admission error",
		);

		// Corrupt read may still throw (existing behavior), never returns a typed
		// blocker.
		const tamperStore = createContinuationStore({ root: join(storeRoot, "tamper") });
		const tamperId = await tamperStore.write(compiledRecord);
		writeFileSync(
			join(storeRoot, "tamper", tamperId.slice("sha256:".length)),
			"corrupted body",
			"utf8",
		);
		let readThrewCorrupt = false;
		try {
			await tamperStore.read(tamperId);
		} catch (error: unknown) {
			readThrewCorrupt = error instanceof ContinuationAdmissionError && error.blocker === "corrupt";
		}
		check(readThrewCorrupt, "read fails closed (throws corrupt) on tampered bodies");

		// read re-validates caps: a body written under a looser policy then read
		// under a tighter one fails closed.
		const looser: ContinuationCapPolicy = { ...GENEROUS, maxBytes: 512 * 1024, maxTokens: 128_000 };
		const tightened: ContinuationCapPolicy = { ...GENEROUS, maxPairs: 1 };
		const pairHeavy = record(
			compile(
				makeInput({
					createdAt: new Date().toISOString(),
					failureEvidence: { ...DEFAULT_FAILURE, timestamp: new Date().toISOString() },
					observedContextEntries: [],
					observedToolPairs: [pair("p0", 0), pair("p1", 1), pair("p2", 2)],
				}),
				looser,
			),
		);
		const heavyStore = createContinuationStore({ root: join(storeRoot, "heavy"), capPolicy: looser });
		const heavyId = await heavyStore.write(pairHeavy);
		const tightStore = createContinuationStore({ root: join(storeRoot, "heavy"), capPolicy: tightened });
		let tightReadThrew = false;
		try {
			await tightStore.read(heavyId);
		} catch {
			tightReadThrew = true;
		}
		check(tightReadThrew, "read re-validates the cap policy and fails closed when policy tightens");
	} finally {
		rmSync(storeRoot, { recursive: true, force: true });
	}

	// ─── Successful-run zero-extra-inference signal ────────────────────────
	{
		check(
			shouldPersistContinuationRecord("completed") === false &&
				shouldPersistContinuationRecord("ship") === false &&
				shouldPersistContinuationRecord("failed") === true &&
				shouldPersistContinuationRecord("resumable") === true &&
				shouldPersistContinuationRecord("blocked") === true &&
				shouldPersistContinuationRecord("escalated") === true,
			"shouldPersistContinuationRecord is FALSE only for completed/ship terminal success",
		);
	}

	if (errors.length > 0) {
		return Promise.reject(
			new Error(
				"continuation-compiler tests failed:\n  ✗ " +
					errors.join("\n  ✗ "),
			),
		);
	}
	console.log(
		"✓ continuation-compiler: deterministic compile, complete-pair invariant, ADR pruning order, newest-wins ties, cap + typed-blocker compliance, store gate round-trip",
	);
	return Promise.resolve();
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests()
		.then(() => process.exit(0))
		.catch((err: unknown) => {
			console.error(err instanceof Error ? err.message : err);
			process.exit(1);
		});
}
