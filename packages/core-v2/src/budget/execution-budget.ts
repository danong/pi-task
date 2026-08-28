/**
 * Execution-budget ingress and turn-cap helpers.
 *
 * Provider-neutral live cost signals do not exist yet. A cost value may still
 * occur in historical receipts/configuration, but new execution must reject a
 * configured maxCostUsd rather than treating settled usage as an interruption.
 */

/** Stable operator-facing explanation for the unsupported cost cap. */
export const MAX_COST_USD_UNSUPPORTED_MESSAGE =
	"maxCostUsd is unsupported: live cost interruption is unsupported; remove --max-cost-usd and use --max-turns or --wall-timeout-ms instead.";

/** Reject a cost cap at every execution ingress, including an explicit zero. */
export function assertNoMaxCostUsd(maxCostUsd: number | undefined): void {
	if (maxCostUsd !== undefined)
		throw new Error(MAX_COST_USD_UNSUPPORTED_MESSAGE);
}

export interface BudgetCaps {
	/** 0 = no cap */
	maxTurns: number;
	/** Historical compatibility only; never used to interrupt execution. */
	maxCostUsd?: number;
}

/** Reason a supported execution budget fired, or null when under budget. */
export type BudgetReason = "turns" | null;

/**
 * Pure turn-cap decision. The cost argument remains for source compatibility
 * with historical callers, but is deliberately not an interruption signal.
 * Wall time is NOT consulted here — callers check wall separately.
 */
export function budgetReason(
	turns: number,
	_costUsd: number,
	caps: BudgetCaps,
): BudgetReason {
	if (caps.maxTurns > 0 && turns >= caps.maxTurns) return "turns";
	return null;
}


