/**
 * Independent execution budgets: maxTurns / maxCostUsd separate from wall time.
 *
 * Pure decision functions over observed events — no I/O, no timers. Wall time
 * is NOT consulted here; callers check wall separately so the two budgets never
 * conflate. Zero means no cap.
 */

export interface BudgetCaps {
	/** 0 = no cap */
	maxTurns: number;
	/** 0 = no cap; USD */
	maxCostUsd: number;
}

/** Reason a budget soft-cap fired, or null when under budget. */
export type BudgetReason = "turns" | "cost" | null;

/**
 * Pure: does the current usage exceed an independent cap?
 * Wall time is NOT consulted here — caller checks wall separately.
 */
export function budgetReason(
	turns: number,
	costUsd: number,
	caps: BudgetCaps,
): BudgetReason {
	if (caps.maxTurns > 0 && turns >= caps.maxTurns) return "turns";
	if (caps.maxCostUsd > 0 && costUsd >= caps.maxCostUsd) return "cost";
	return null;
}


