/**
 * Worker body for the concurrent-claim proof in test-recovery-claim.ts.
 *
 * Opens the shared ledger file (WAL allows several connections) and issues
 * exactly one claimRecovery call. The claim is atomic in SQLite, so whatever
 * the interleaving, exactly one of two concurrently started workers wins.
 * Only primitive facts are posted back; the assertions live in the main
 * thread.
 */

import { parentPort, workerData } from "node:worker_threads";

import { LedgerStore } from "../src/ledger/store.ts";

interface WorkerClaimData {
	dbPath: string;
	runId: string;
	successorRunId: string;
}

const data = workerData as WorkerClaimData;
const store = new LedgerStore(data.dbPath);
try {
	const outcome = store.claimRecovery(data.runId, data.successorRunId);
	parentPort!.postMessage({
		success: outcome.success,
		runId: outcome.status.runId,
		phase: outcome.status.phase,
		successorRunId: outcome.status.successorRunId,
	});
} finally {
	store.close();
}