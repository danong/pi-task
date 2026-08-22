/**
 * Daemon entry point — M1.4 / R2.
 *
 * Library-first daemon surface: start(dbPath) opens the ledger and applies
 * boot reconciliation (stale in-flight tasks → requeue or fail per the
 * pure policy) before any work is accepted. Long-running process hosting,
 * surface attachment, and scheduling arrive in later milestones; M1's
 * contract is the pipeline + durable state.
 */

import { LedgerStore } from "../ledger/store.ts";

export interface StartedDaemon {
	store: LedgerStore;
	/** Reconciliation outcome: task ids requeued vs failed at boot. */
	reconciled: { requeued: string[]; failed: string[] };
}

/** Open the ledger at dbPath and reconcile stale in-flight tasks. */
export function startDaemon(dbPath: string): StartedDaemon {
	const store = new LedgerStore(dbPath);
	const reconciled = store.reconcileOnBoot();
	return { store, reconciled };
}
