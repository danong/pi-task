/**
 * Prewalk policy — M3 (contract §5.3 mode a), OFF by default.
 *
 * The user's economics, formalized: after a model swap, the execute
 * model's FIRST request re-prices the entire accumulated context at its
 * UNCACHED input rate. Staying on the strong model keeps cache-read rates.
 * Prewalk therefore pays only when
 *
 *   swapPenalty + (N-1) × cheapCachedTurn  <  N × strongCachedTurn
 *
 * where swapPenalty = contextAtSwap × cheapUncachedIn and N is the
 * estimated remaining turns. For small units of work (small context,
 * few remaining turns) it loses; for long tasks with big explorations
 * on a much cheaper workhorse it wins. The decision function below makes
 * that explicit and auditable — every input is visible in the result.
 *
 * MECHANISM vs POLICY: setModel lives on SessionHandle (engine); THIS
 * module is the swappable policy. OFF by default — runTask only attaches
 * it when explicitly configured AND the router selected planMode=prewalk.
 */

/** USD per million tokens. */
export interface TokenPricing {
	input: number;
	/** Cache READ rate (what an already-cached prompt token costs). */
	cacheRead: number;
	output: number;
}

export interface PrewalkPricing {
	strong: TokenPricing;
	execute: TokenPricing;
}

export interface PrewalkDecisionInput {
	/** Context size at the swap point ≈ cacheWrite + cacheRead + input. */
	contextTokensAtSwap: number;
	/** Estimated REMAINING turns after the swap (the work left to do). */
	remainingTurnsEstimate: number;
	/** Expected output tokens per turn (defaults to 300). */
	outputTokensPerTurn?: number;
	pricing: PrewalkPricing;
}

export interface PrewalkDecision {
	swap: boolean;
	reason: string;
	/** Projected cost of staying on the strong model for N turns (USD). */
	stayCostUsd: number;
	/** Projected cost of swapping now (uncached penalty + cheap turns) (USD). */
	swapCostUsd: number;
	breakEvenTurns: number;
}

const DEFAULT_OUTPUT_TOKENS_PER_TURN = 300;

function perM(tokens: number, rate: number): number {
	return (tokens / 1_000_000) * rate;
}

/**
 * The pure break-even decision (review-proof: every term is named).
 * Assumptions documented at the module head: per-turn prompt growth is
 * ignored (conservative — growth favors swapping LATER, i.e. favors stay),
 * output counts equally on both models and cancels out of the comparison
 * only partially (cheap output is also cheaper), so output IS included.
 */
export function decidePrewalkSwap(input: PrewalkDecisionInput): PrewalkDecision {
	const ctx = Math.max(0, input.contextTokensAtSwap);
	const n = Math.max(1, Math.round(input.remainingTurnsEstimate));
	const out = input.outputTokensPerTurn ?? DEFAULT_OUTPUT_TOKENS_PER_TURN;

	const strong = input.pricing.strong;
	const cheap = input.pricing.execute;

	// Stay: every turn re-reads the context at the strong cache-read rate.
	const stayCostUsd = n * (perM(ctx, strong.cacheRead) + perM(out, strong.output));

	// Swap: turn 1 re-prices the WHOLE context uncached; turns 2..N are
	// cheap cache reads. Output runs on the cheap model throughout.
	const swapPenaltyUsd = perM(ctx, cheap.input);
	const swapCostUsd = swapPenaltyUsd + (n - 1) * (perM(ctx, cheap.cacheRead) + perM(out, cheap.output));

	// Break-even N*: smallest N where swapping beats staying.
	const perTurnSaving = perM(ctx, strong.cacheRead - cheap.cacheRead) + perM(out, strong.output - cheap.output);
	const breakEvenTurns =
		perTurnSaving > 0 ? Math.ceil(swapPenaltyUsd / perTurnSaving) : Number.POSITIVE_INFINITY;

	const swap = swapCostUsd < stayCostUsd && Number.isFinite(breakEvenTurns);
	return {
		swap,
		reason: swap
			? `swap saves $${(stayCostUsd - swapCostUsd).toFixed(4)} over ~${n} turns (penalty $${swapPenaltyUsd.toFixed(4)}, break-even ${breakEvenTurns} turns)`
			: `staying saves $${(stayCostUsd - swapCostUsd).toFixed(4)} — penalty $${swapPenaltyUsd.toFixed(4)} needs ${Number.isFinite(breakEvenTurns) ? `${breakEvenTurns} turns` : "infinite turns"} to amortize`,
		stayCostUsd,
		swapCostUsd,
		breakEvenTurns,
	};
}

/** Edit-family tools whose successful completion marks the swap point. */
const EDIT_TOOLS = new Set(["edit", "write"]);

export interface AttachPrewalkOptions {
	/** Execute-model id to switch to when the policy fires. */
	executeModelId: string;
	decide: (input: { contextTokensAtSwap: number }) => PrewalkDecision;
	onSwap?: (info: { contextTokensAtSwap: number; decision: PrewalkDecision }) => void;
}

export interface PrewalkAttachment {
	dispose(): void;
}

/**
 * Wire the policy onto a live session handle: on the FIRST successful
 * edit/write, read usage stats and consult the decision function. Fires
 * at most once. Returns an attachment; dispose to detach untouched.
 */
export function attachPrewalk(
	handle: import("../sessions/host.ts").SessionHandle,
	options: AttachPrewalkOptions,
): PrewalkAttachment {
	let fired = false;
	const unsubscribe = handle.subscribe((event) => {
		if (fired || event.type !== "toolEnd") return;
		if (!EDIT_TOOLS.has(event.toolName) || event.isError) return;
		fired = true;
		void (async () => {
			try {
				const stats = await handle.stats();
				const contextTokensAtSwap =
					stats.tokens.cacheWrite + stats.tokens.cacheRead + stats.tokens.input;
				const decision = options.decide({ contextTokensAtSwap });
				if (!decision.swap) return;
				await handle.setModel(options.executeModelId);
				options.onSwap?.({ contextTokensAtSwap, decision });
			} catch (err) {
				// A failed policy must never kill the worker session mid-run.
				console.error(`prewalk: policy error (ignored): ${err instanceof Error ? err.message : String(err)}`);
			}
		})();
	});
	return { dispose: () => unsubscribe() };
}
