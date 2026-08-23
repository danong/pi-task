/**
 * /plan R3 — the human gate (M5 planning-only workflow).
 *
 * A plan is only ever a DRY-RUN artifact until a human approves it:
 *   - `recordPlanApproval(store, { dagId, approved })` writes one
 *     workflow_approvals ledger row — dry plans write approved=false
 *     ("planned, not approved"); `--approve` flips the row to true.
 *   - `requirePlanApproved(store, dagId)` is the gate BUILD consults:
 *     an unapproved (or unknown) DAG fails typed with actionable
 *     guidance to re-run plan --approve. It never mutates state.
 *
 * All persistence rides the existing ledger database seam (the
 * workflow_approvals table added in schema v2) — no second DB.
 */

import type { LedgerStore } from "../ledger/store.ts";

export class GateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GateError";
	}
}

export interface RecordPlanApprovalOptions {
	dagId: string;
	/** true = human-approved buildable plan; false = dry-run record only. */
	approved: boolean;
}

/** Write (or flip) this DAG's approval row on the existing ledger. */
export function recordPlanApproval(store: LedgerStore, options: RecordPlanApprovalOptions): void {
	store.setWorkflowApproval(options.dagId, options.approved);
}

/**
 * The gate BUILD consults before dispatching anything: throws a typed
 * GateError with guidance when the DAG has never been planned or was
 * planned without approval. Read-only.
 */
export function requirePlanApproved(store: LedgerStore, dagId: string): void {
	const row = store.getWorkflowApproval(dagId);
	if (row === null) {
		throw new GateError(
			`workflow "${dagId}" has no approval record — run plan first (dry run), then plan --approve to authorize execution`,
		);
	}
	if (!row.approved) {
		throw new GateError(
			`workflow "${dagId}" was planned but NOT approved (last updated ${row.updatedAt}) — re-run plan --approve to authorize execution`,
		);
	}
}

/** Non-throwing probe for surfaces that want a status line instead. */
export function planApprovalStatus(store: LedgerStore, dagIdId: string):
	| { status: "approved" | "pending" | "unknown"; updatedAt?: string } {
	const row = store.getWorkflowApproval(dagIdId);
	if (row === null) return { status: "unknown" };
	return { status: row.approved ? "approved" : "pending", updatedAt: row.updatedAt };
}
