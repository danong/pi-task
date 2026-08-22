/**
 * Hermetic tests for continuation pruning (R1–R4) — the pruner seam,
 * both shipped scorers, config-driven selection, budget semantics, and
 * the second-layer retry signal. Zero LLM, zero network, no fs.
 *
 * Standalone: npx tsx packages/core-v2/test/test-continuation.ts
 */

import { pathToFileURL } from "node:url";

import {
	estimateEntryTokens,
	listScorers,
	pruneContinuation,
	recencyToolScorer,
	selectScorer,
	uniformScorer,
	type ContinuationEntry,
} from "../src/continuation/pruner.ts";

/** Entries carry a stable `id` (index-signature field) because scorers
 *  return shallow copies — identity must be compared by id, not reference. */
let seq = 0;
const entry = (role: string, text: string, toolName?: string): ContinuationEntry => {
	const e: ContinuationEntry = toolName === undefined
		? { role, content: text }
		: { role, content: text, toolName };
	e.id = `e${seq++}`;
	return e;
};

/** Map kept entries back to their original indices (by id). */
function indicesOf(entries: readonly ContinuationEntry[], kept: readonly ContinuationEntry[]): number[] {
	const pos = new Map<string, number>();
	entries.forEach((e, i) => pos.set(String(e.id), i));
	return kept.map((e) => pos.get(String(e.id)) ?? -1);
}

function hasId(entries: readonly ContinuationEntry[], e: ContinuationEntry): boolean {
	return entries.some((x) => x.id === e.id);
}

/** Total estimated tokens of a pruned output. */
function spentTokens(entries: readonly ContinuationEntry[]): number {
	return entries.reduce((s, e) => s + estimateEntryTokens(e), 0);
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// ─── R4: empty input → empty output (both scorers) ──────────────────
	{
		check(recencyToolScorer([], 1000).length === 0, "recencyTool: empty input → empty output");
		check(uniformScorer([], 1000).length === 0, "uniform: empty input → empty output");
		check(pruneContinuation([], 1000).length === 0, "pruneContinuation: empty input → empty output");
	}

	// ─── R4: over-budget edge — zero budget still keeps one representative
	//     entry when input is non-empty (never returns garbage / throws) ──
	{
		const out = recencyToolScorer([entry("user", "task"), entry("toolResult", "r", "read")], 0);
		check(out.length >= 1 && out.length <= 2, `zero-budget keeps ≤2 entries (got ${out.length})`);
		check(spentTokens(out) <= 200, "zero-budget output stays tiny");
	}

	// ─── R4: budget respected — greedy keep never exceeds budget ────────
	{
		const entries = Array.from({ length: 40 }, (_, i) => entry("toolResult", `x`.repeat(160), "read"));
		// each ≈ 44 tokens; 40 × 44 ≈ 1760 total. Budget 400 → subset.
		const out = recencyToolScorer(entries, 400);
		check(out.length < entries.length, `budget forces pruning (${out.length}/${entries.length})`);
		check(spentTokens(out) <= 400 + estimateEntryTokens(entries[entries.length - 1] as ContinuationEntry),
			`spent within one-entry slack of budget (spent ${spentTokens(out)})`);
	}

	// ─── R4: ordering preserved — kept entries appear in original order ──
	{
		const entries = [
			entry("user", "first task"),
			entry("assistant", "thinking aloud"),
			entry("toolResult", "middle result", "bash"),
			entry("assistant", "more thinking"),
			entry("toolResult", "last result", "bash"),
		];
		for (const scorer of [recencyToolScorer, uniformScorer]) {
			const bigBudget = scorer(entries, 10_000);
			check(
				bigBudget.map((e) => e.content).join("|") === entries.map((e) => e.content).join("|"),
				`${scorer.name}: generous budget keeps everything in order`,
			);
			const tight = scorer(entries, 60);
			const positions = indicesOf(entries, tight);
			check(
				positions.every((p, i) => i === 0 || p > (positions[i - 1] as number)),
				`${scorer.name}: kept entries preserve original order (${JSON.stringify(positions)})`,
			);
		}
	}

	// ─── R4: at-least-one-tool-result kept when available ────────────────
	{
		// Budget only fits ~1 entry; input has exactly one toolResult.
		// (Kept-entry membership checked by id — outputs are shallow copies.)
		const entries = [
			entry("assistant", "y".repeat(400)),
			entry("toolResult", "the evidence", "grep"),
			entry("assistant", "z".repeat(400)),
		];
		for (const scorer of [recencyToolScorer, uniformScorer]) {
			const out = scorer(entries, 20);
			check(out.some((e) => e.role === "toolResult"),
				`${scorer.name}: tool result survives even a tiny budget`);
		}
		// No toolResults present → invariant vacuous, but output non-empty.
		const noTools = [entry("user", "a".repeat(300)), entry("assistant", "b".repeat(300))];
		const out = pruneContinuation(noTools, 30);
		check(out.length === 1, "no-tool-result input still keeps one representative entry");
	}

	// ─── R1/R2: recency+tool signal beats uniform on which tail survives ─
	{
		const entries = [
			entry("user", "old goal ".repeat(20)),          // oldest
			entry("toolResult", "old read", "read"),         // old tool result
			entry("assistant", "filler ".repeat(20)),
			entry("toolResult", "recent bash", "bash"),      // recent tool result
			entry("assistant", "final plan ".repeat(10)),    // newest
		];
		const budget = 120; // fits roughly two entries
		const rt = recencyToolScorer(entries, budget);
		const newest = entries[entries.length - 1] as ContinuationEntry;
		check(hasId(entries, rt[rt.length - 1] as ContinuationEntry) &&
			(rt[rt.length - 1] as ContinuationEntry).id === newest.id,
			"recencyTool keeps the newest entry under pressure");
		check(rt.some((e) => e.role === "toolResult"),
			"recencyTool keeps a tool result under pressure");
	}

	// ─── R2: selection is config-driven; unknown name fails typed ───────
	{
		check(listScorers().includes("recencyTool" as never), "registry exposes recencyTool");
		check(listScorers().includes("uniform" as never), "registry exposes uniform");
		check(selectScorer("uniform") === uniformScorer, "selectScorer resolves uniform by name");
		check(selectScorer("recencyTool") === recencyToolScorer, "selectScorer resolves recencyTool by name");
		let threw = false;
		try {
			selectScorer("bogus-scorer");
		} catch {
			threw = true;
		}
		check(threw, "unknown scorer name throws instead of silently defaulting");
		// Same inputs through both named scorers differ in shape under pressure
		// (proves selection actually changes behavior). Budget fits exactly two
		// short entries: uniform keeps the OLD tool (flat score + tool bias);
		// recencyTool keeps the NEW tool + the newest assistant instead.
		const entries = [
			entry("toolResult", "o", "read"),   // 4 est. tokens
			entry("assistant", "a"),             // 3 est. tokens
			entry("toolResult", "n", "bash"),   // 4 est. tokens
			entry("assistant", "b"),             // 3 est. tokens
		];
		const viaPruneUniform = pruneContinuation(entries, 9, { scorer: "uniform" });
		const viaPruneRecency = pruneContinuation(entries, 9, { scorer: "recencyTool" });
		check(
			JSON.stringify(indicesOf(entries, viaPruneUniform)) !== JSON.stringify(indicesOf(entries, viaPruneRecency)),
			`scorer choice changes the pruned subset (selection is real): uniform=${JSON.stringify(indicesOf(entries, viaPruneUniform))} recency=${JSON.stringify(indicesOf(entries, viaPruneRecency))}`,
		);
	}

	// ─── R3: retry signal changes the outcome vs first attempt ──────────
	{
		const entries = Array.from({ length: 12 }, (_, i) =>
			i % 3 === 0 ? entry("toolResult", `r${i} `.repeat(8), "read") : entry("assistant", `t${i} `.repeat(8)));
		// Strictly below the transcript total so pruning actually engages.
		const budget = 100;
		for (const scorer of [recencyToolScorer, uniformScorer]) {
			const first = scorer(entries, budget);
			const retried = scorer(entries, budget, { attemptNumber: 2 });
			check(
				JSON.stringify(retried) !== JSON.stringify(first),
				`${scorer.name}: attemptNumber=2 does not re-prune identically`,
			);
			const flagged = scorer(entries, budget, { alreadyPruned: true });
			check(
				JSON.stringify(flagged) !== JSON.stringify(first),
				`${scorer.name}: alreadyPruned=true does not re-prune identically`,
			);
			// Retry outputs stay within budget and ordered.
			check(spentTokens(retried) <= budget + 60, `${scorer.name}: retry output bounded`);
			const positions = indicesOf(entries, retried);
			check(positions.every((p, i) => i === 0 || p > (positions[i - 1] as number)),
				`${scorer.name}: retry output preserves order`);
			check(retried.some((e) => e.role === "toolResult"),
				`${scorer.name}: retry output keeps a tool result`);
		}
	}

	// ─── Determinism & purity ────────────────────────────────────────────
	{
		const entries = [entry("user", "u1"), entry("toolResult", "r1", "read"), entry("assistant", "a1")];
		const before = JSON.stringify(entries);
		const a = recencyToolScorer(entries, 500);
		const b = recencyToolScorer(entries, 500);
		check(JSON.stringify(a) === JSON.stringify(b), "same input → identical output (deterministic)");
		check(JSON.stringify(entries) === before, "input array not mutated (pure)");
	}

	if (errors.length > 0) {
		throw new Error(`continuation tests failed:\n  ✗ ${errors.join("\n  ✗ ")}`);
	}
	console.log("✓ continuation: budgets respected, order preserved, tool-result invariant, retry-aware scorers, config-driven selection");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
