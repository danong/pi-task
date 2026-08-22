/**
 * Continuation pruning — M3 continuation handoff (contract §5.2–§5.3, FR-7).
 *
 * When a turn-limit forces a session handoff the continuation inherits the
 * predecessor's transcript. Without thinning that context grows forever:
 * every retry re-encodes everything the prior attempt already paid for.
 * The continuation pruner bounds it to a representative subset before the
 * fork re-encodes.
 *
 * SEAM: one file, one interface. The scorer is a pure function
 *   (entries[], budgetTokens, context?) -> entries[]
 * with no LLM, no I/O, no AgentSession reach-in. Selection is
 * config-driven (named scorers, see selectScorer). Heuristics are
 * bounded by construction: no swallow/max-chunk/age unbounded loops —
 * every loop is over the finite input, every score is a finite weighted
 * sum, every budget pass is a single greedy scan.
 */

export interface ContinuationEntry {
	role: string;
	content?: unknown;
	toolName?: string;
	/** Optional pre-computed token estimate for this entry; when omitted
	 *  estimateEntryTokens derives it from the content size. */
	tokens?: number;
	[k: string]: unknown;
}

/** Second-layer retry signal visible to the scorer (R3). A fork that
 *  already pruned once re-invokes the scorer with attemptNumber>1 or
 *  alreadyPruned=true — the scorer must not return byte-identical output
 *  on immediate retry when that signal is present. */
export interface ScorerContext {
	/** 1-indexed attempt number from the ledger envelope; >1 means retry. */
	attemptNumber?: number;
	/** True when the predecessor fork was already pruned. */
	alreadyPruned?: boolean;
	/** Remaining retry budget already spent (0..1); alternative shape for R3. */
	retryBudgetSpent?: number;
}

export interface PruneRequest {
	entries: ContinuationEntry[];
	budgetTokens: number;
	context?: ScorerContext;
}

/** Pluggable scorer seam (R1): pure, hermetically testable (no LLM). */
export type ContinuationScorer = (
	entries: readonly ContinuationEntry[],
	budgetTokens: number,
	context?: ScorerContext,
) => ContinuationEntry[];

/** Token estimate for one entry. Mirrors task-runner.ts estimateGroundingTokens
 *  (4 bytes ≈ 1 token) so budgets are comparable across the pipeline. */
export function estimateEntryTokens(entry: ContinuationEntry): number {
	if (typeof entry.tokens === "number" && Number.isFinite(entry.tokens) && entry.tokens >= 0) {
		return Math.max(1, Math.ceil(entry.tokens));
	}
	const content = entry.content;
	let bytes = 0;
	if (typeof content === "string") bytes = Buffer.byteLength(content, "utf-8");
	else if (Array.isArray(content)) bytes = Buffer.byteLength(JSON.stringify(content), "utf-8");
	else if (content !== undefined && content !== null) bytes = Buffer.byteLength(String(content), "utf-8");
	else bytes = 16;
	// + role/toolName overhead
	bytes += Buffer.byteLength(entry.role ?? "", "utf-8");
	if (entry.toolName) bytes += Buffer.byteLength(entry.toolName, "utf-8");
	return Math.max(1, Math.ceil(bytes / 4));
}

function totalTokens(entries: readonly ContinuationEntry[]): number {
	let s = 0;
	for (const e of entries) s += estimateEntryTokens(e);
	return s;
}

function isToolResult(e: ContinuationEntry): boolean {
	return e.role === "toolResult";
}

function cloneEntries(entries: readonly ContinuationEntry[]): ContinuationEntry[] {
	return entries.map((e) => ({ ...e }));
}

/**
 * Core budget enforcement shared by all scorers: given entries scored
 * descending, greedily keep until budget would overflow. Returns entries
 * in **original order** (ordering preserved by construction).
 * Guarantees at-least-one-tool-result when the input contains one.
 */
function enforceBudget(
	scored: Array<{ entry: ContinuationEntry; score: number; index: number }>,
	budgetTokens: number,
	entries: readonly ContinuationEntry[],
): ContinuationEntry[] {
	const budget = Math.max(0, Math.floor(budgetTokens));
	if (budget === 0 || entries.length === 0) {
		// Even at zero budget the at-least-one-tool invariant is handled
		// below for non-empty input when a toolResult exists.
		if (entries.length === 0) return [];
	}
	// Over-budget shortcut: budget covers everything → return copy in order.
	if (totalTokens(entries) <= budget) return cloneEntries(entries);

	const sortedByScore = [...scored].sort((a, b) => b.score - a.score);
	const kept = new Set<number>();
	let spent = 0;
	for (const s of sortedByScore) {
		const tok = estimateEntryTokens(s.entry);
		if (spent + tok <= budget) {
			kept.add(s.index);
			spent += tok;
		}
	}

	// At-least-one-tool-result invariant (R4): if we kept none of the
	// toolResults but the input has at least one, force the best-scoring
	// toolResult in, evicting the lowest-scoring kept non-tool if needed.
	const hasToolResult = entries.some(isToolResult);
	const keptHasTool = [...kept].some((idx) => isToolResult(entries[idx] as ContinuationEntry));
	if (hasToolResult && !keptHasTool && kept.size > 0) {
		const bestTool = sortedByScore.find((s) => isToolResult(s.entry));
		if (bestTool) {
			// Evict lowest-scoring kept non-tool to stay within budget if needed.
			const keptScored = sortedByScore.filter((s) => kept.has(s.index));
			keptScored.sort((a, b) => a.score - b.score); // ascending
			const victim = keptScored.find((s) => !isToolResult(s.entry));
			const toolTok = estimateEntryTokens(bestTool.entry);
			if (victim) {
				const victimTok = estimateEntryTokens(victim.entry);
				if (spent - victimTok + toolTok <= budget) {
					kept.delete(victim.index);
					kept.add(bestTool.index);
				} else if (kept.size === 1) {
					// Only one slot and it is non-tool: swap regardless (prefer tool)
					kept.clear();
					kept.add(bestTool.index);
				}
			} else {
				// All kept are tools but we somehow missed — add if fits
				if (spent + toolTok <= budget) kept.add(bestTool.index);
			}
		}
	}
	// Budget may still be zero and we have a non-empty input with a tool:
	// keep exactly the best toolResult as the minimal representative set.
	if (kept.size === 0 && hasToolResult) {
		const bestTool = sortedByScore.find((s) => isToolResult(s.entry));
		if (bestTool) kept.add(bestTool.index);
		else if (entries.length > 0) kept.add(sortedByScore[0]?.index ?? 0);
	} else if (kept.size === 0 && entries.length > 0) {
		// No toolResults at all: keep the single best entry to guarantee
		// at-least-one when budget is pathological (>0 budget but every
		// entry individually exceeds it).
		const best = sortedByScore[0];
		if (best) kept.add(best.index);
	}

	// Return in original order.
	const out: ContinuationEntry[] = [];
	for (let i = 0; i < entries.length; i++) {
		if (kept.has(i)) out.push({ ...(entries[i] as ContinuationEntry) });
	}
	return out;
}

// ─── Concrete scorers (R2) ───────────────────────────────────────────

/**
 * Recency + tool-use signal scorer (bounded heuristics).
 *
 * Score = recencyWeight * normalizedPosition + toolBonus + userBonus
 * where normalizedPosition = index/len in [0,1] (newer = higher).
 *
 * RETRY SIGNAL (R3): on a fork that already pruned once (attemptNumber>1
 * or alreadyPruned), the oldest entry is removed from candidacy outright
 * (unless it is the input's only tool result) — the keep-window visibly
 * shifts forward instead of re-pruning identically.
 */
export function recencyToolScorer(
	entries: readonly ContinuationEntry[],
	budgetTokens: number,
	context?: ScorerContext,
): ContinuationEntry[] {
	if (entries.length === 0) return [];
	const n = entries.length;
	const isRetry =
		(context?.alreadyPruned === true) ||
		(context?.attemptNumber !== undefined && context.attemptNumber > 1) ||
		(context?.retryBudgetSpent !== undefined && context.retryBudgetSpent > 0);

	// R3: shift the window past the oldest entry on retry — unless it is
	// the only tool result (the at-least-one-tool invariant would just
	// force it back, so keep it scored).
	const oldestIsOnlyTool =
		isToolResult(entries[0] as ContinuationEntry) && !entries.slice(1).some(isToolResult);
	const start = isRetry && n > 1 && !oldestIsOnlyTool ? 1 : 0;

	const toolBonusBase = isRetry ? 0.5 : 0.35;
	const userBonus = 0.15;
	const recencyScale = isRetry ? 1.4 : 1.0;

	const scored = entries.slice(start).map((e, j) => {
		const i = j + start;
		const pos = n <= 1 ? 1 : i / (n - 1); // 0..1
		let score = pos * recencyScale;
		if (isToolResult(e)) score += toolBonusBase;
		// Assistant tool calls with a tool name also hint at signal; small bump.
		if (e.role === "assistant" && typeof e.toolName === "string") score += 0.08;
		if (e.role === "user") score += userBonus;
		return { entry: e, score, index: i };
	});

	return enforceBudget(scored, budgetTokens, entries);
}

/**
 * Uniform-drop scorer (bounded): scores uniformly then drops the oldest
 * entries first until budget fits. On retry the scorer offsets the keep
 * window by one to avoid identical output (R3).
 */
export function uniformScorer(
	entries: readonly ContinuationEntry[],
	budgetTokens: number,
	context?: ScorerContext,
): ContinuationEntry[] {
	if (entries.length === 0) return [];
	const isRetry =
		(context?.alreadyPruned === true) ||
		(context?.attemptNumber !== undefined && context.attemptNumber > 1) ||
		(context?.retryBudgetSpent !== undefined && context.retryBudgetSpent > 0);

	// Uniform base score: all equal except recency tie-breaker so the
	// greedy pass keeps the most recent uniformly-dropped set.
	// On retry, shift the tie-breaker by one position.
	const offset = isRetry ? 1 : 0;
	const scored = entries.map((e, i) => {
		// Uniform: base 0.5 everywhere, recency contributes only ε to break ties.
		const recencyEpsilon = 0.01 * ((i + offset) % entries.length) / entries.length;
		let score = 0.5 + recencyEpsilon;
		if (isToolResult(e)) score += 0.05; // tiny tool bias for invariant
		return { entry: e, score, index: i };
	});
	return enforceBudget(scored, budgetTokens, entries);
}

// ─── Config-driven selection (R2) ────────────────────────────────────

export const SCORER_NAMES = ["recencyTool", "uniform"] as const;
export type ScorerName = (typeof SCORER_NAMES)[number];

const REGISTRY: Record<ScorerName, ContinuationScorer> = {
	recencyTool: recencyToolScorer,
	uniform: uniformScorer,
};

export function selectScorer(name: string): ContinuationScorer {
	if (name in REGISTRY) return REGISTRY[name as ScorerName];
	throw new Error(`unknown continuation scorer "${name}" — expected one of ${SCORER_NAMES.join(", ")}`);
}

export function listScorers(): ScorerName[] {
	return [...SCORER_NAMES];
}

/**
 * Convenience entry point: select by name and prune. Pure.
 */
export function pruneContinuation(
	entries: readonly ContinuationEntry[],
	budgetTokens: number,
	opts?: { scorer?: ScorerName | ContinuationScorer; context?: ScorerContext },
): ContinuationEntry[] {
	const scorer: ContinuationScorer =
		typeof opts?.scorer === "function"
			? opts.scorer
			: selectScorer((opts?.scorer as string) ?? "recencyTool");
	return scorer(entries, budgetTokens, opts?.context);
}
