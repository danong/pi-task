/**
 * Hermetic tests for the M5.5 atomic linear claim (ADR seam 4b): one winner,
 * losers get factual status, and no session/workspace/task_edges side effect.
 *
 * Proves (R2/R3/R4), against throwaway SQLite ledgers (zero LLM, zero network):
 *   - resolveToLatestFailed reaches the successor-chain terminal member and
 *     claimRecovery operates on that terminal `resumable` row
 *   - a single claim is `resumable -> claimed` with exactly one successor
 *   - a second claim returns `claimed` + `successor_run_id` and success:false
 *   - two concurrent claimers (worker threads over one WAL ledger) have
 *     exactly one winner; the loser sees the winner's factual status
 *   - the claimed run is no longer eligible and creates no session, workspace,
 *     workspace continuation, task edge, artifact, or preparation row
 *   - successor family/attempt ids come from the existing
 *     deriveTaskId/resolveAttemptId machinery
 *
 * Standalone: npx tsx packages/core-v2/test/test-recovery-claim.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { deriveTaskId, resolveAttemptId } from "../src/daemon/task-runner.ts";
import {
	LEDGER_SCHEMA_VERSION,
	LedgerStore,
	type NewStandaloneRecovery,
} from "../src/ledger/store.ts";
import {
	RecoveryStatusSchema,
	type RecoveryStatus,
} from "../src/contracts/recovery-status.ts";

function tempDb(): { path: string; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-task-v2-recovery-claim-"));
	return { path: join(dir, "tasks.db"), dir };
}

/** Run a fn expecting an error; returns the error message. */
function expectThrow(fn: () => void): string {
	try {
		fn();
		return "";
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

interface WorkerClaimResult {
	success: boolean;
	runId: string;
	phase: string;
	successorRunId: string | null;
}

/** Start one worker that opens the shared ledger and issues one claim. */
function claimInWorker(
	dbPath: string,
	runId: string,
	successorRunId: string,
): Promise<WorkerClaimResult> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(
			new URL("./test-recovery-claim-worker.ts", import.meta.url),
			{ workerData: { dbPath, runId, successorRunId } },
		);
		let settled = false;
		const settle = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			fn();
		};
		worker.once("message", (message) =>
			settle(() => resolve(message as WorkerClaimResult)),
		);
		worker.once("error", (error) =>
			settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
		);
		worker.once("exit", (code) =>
			settle(() => {
				if (code !== 0) reject(new Error(`recovery claim worker exited with ${code}`));
			}),
		);
	});
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const tmp = tempDb();
	try {
		const specHash = "sha256:" + "c".repeat(64);
		const recordId = "sha256:" + "d".repeat(64);
		const isoDay = 86_400_000;
		const make = (
			store: LedgerStore,
			runId: string,
			overrides: Partial<NewStandaloneRecovery> = {},
		): RecoveryStatus =>
			store.createRecoveryRecord({
				runId,
				taskId: "family-claim",
				specHash,
				workspaceStateId: `workspace-state-${runId}`,
				continuationRecordId: recordId,
				capPolicyId: "cap-v1-core-default",
				expiresAt: new Date(Date.now() + isoDay).toISOString(),
				engineVersion: "engine-v1",
				workspaceCapabilityId: "fake.continuation/v1",
				...overrides,
			});
		const noSideEffectTables = (
			store: LedgerStore,
			allowTasks: boolean,
			label: string,
		): void => {
			for (const [table, column] of [
				["micro_sessions", "id"], ["workspaces", "id"],
				["task_edges", "edge_id"], ["workspace_continuations", "id"],
				["task_artifacts", "task_id"], ["child_preparation_ownership", "preparation_id"],
			] as const)
				check(
					Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n) === 0,
					`${label}: claims create no ${table} row`,
				);
			if (!allowTasks)
				check(
					Number((store.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n) === 0,
					`${label}: claims create no task row`,
				);
		};

		// ─── Single claim success + factual status (no side effects) ───
		{
			const store = new LedgerStore(tmp.path + ".single");
			make(store, "claim-1");

			// The terminal lineage member of a single row is the row itself.
			const terminal = store.resolveToLatestFailed("claim-1");
			check(
				terminal !== null && terminal.runId === "claim-1" &&
					terminal.phase === "resumable" && terminal.successorRunId === null &&
					store.getRecoveryStatus("claim-1")!.runId === "claim-1",
				"resolveToLatestFailed reaches the single terminal resumable row",
			);

			const claimed = store.claimRecovery("claim-1", "claim-2");
			check(
				claimed.success === true &&
					RecoveryStatusSchema.safeParse(claimed.status).success,
				"a single claim succeeds and returns a valid RecoveryStatus",
			);
			check(
				claimed.status.runId === "claim-1" && claimed.status.taskId === "family-claim" &&
					claimed.status.phase === "claimed" && claimed.status.resumeAllowed === false &&
					claimed.status.successorRunId === "claim-2" &&
					claimed.status.blockedReason === null,
				"the winner's status is the claimed row with exactly one successor",
			);
			const durable = store.db.prepare(
				"SELECT successor_run_id FROM standalone_recovery WHERE run_id = 'claim-1'",
			).get() as { successor_run_id: string | null };
			check(durable.successor_run_id === "claim-2", "the successor identity is durable on the claimed row");
			noSideEffectTables(store, false, "single claim");

			// ─── Second claim: loser receives factual claimed status ───
			const loser = store.claimRecovery("claim-1", "claim-3");
			check(
				loser.success === false && loser.status.runId === "claim-1" &&
					loser.status.phase === "claimed" && loser.status.successorRunId === "claim-2",
				"a second claim returns claimed + successor_run_id and success:false",
			);
			const sameSuccessor = store.claimRecovery("claim-1", "claim-2");
			check(
				sameSuccessor.success === false &&
					sameSuccessor.status.successorRunId === "claim-2",
				"re-claiming with the winner's successor is still a factual loser",
			);

			// ─── Claimed run is no longer eligible ───
			check(
				expectThrow(() => make(store, "claim-1")).includes("conflicts with durable state"),
				"a claimed run cannot be re-registered as resumable",
			);
			check(
				store.resolveToLatestFailed("claim-1")!.phase === "claimed" &&
					store.resolveToLatestFailed("claim-1")!.resumeAllowed === false,
				"the claimed run is no longer resumable-eligible",
			);
			noSideEffectTables(store, false, "failed second claim");

			// The gate is per-run, not global: a fresh run is still claimable.
			make(store, "claim-9");
			const fresh = store.claimRecovery("claim-9", "claim-10");
			check(
				fresh.success === true && fresh.status.runId === "claim-9" &&
					fresh.status.phase === "claimed" && fresh.status.successorRunId === "claim-10",
				"a fresh run remains claimable after another run was claimed",
			);

			store.close();
			const reopened = new LedgerStore(tmp.path + ".single");
			const reopenedStatus = reopened.resolveToLatestFailed("claim-1");
			check(
				Number((reopened.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version) === LEDGER_SCHEMA_VERSION &&
					reopenedStatus?.phase === "claimed" && reopenedStatus.successorRunId === "claim-2" &&
					reopened.claimRecovery("claim-1", "claim-11").success === false,
				"claim, phase, and successor survive close/reopen without a new migration",
			);
			reopened.close();
		}

		// ─── Terminal-chain resolution: claim operates on the lineage end ───
		{
			const store = new LedgerStore(tmp.path + ".chain");
			make(store, "chain-1");
			make(store, "chain-2", { predecessorRunId: "chain-1" });
			make(store, "chain-3", { predecessorRunId: "chain-2" });
			check(
				store.resolveToLatestFailed("chain-1")!.runId === "chain-3" &&
					store.resolveToLatestFailed("chain-2")!.runId === "chain-3" &&
					store.resolveToLatestFailed("chain-3")!.runId === "chain-3",
				"resolveToLatestFailed follows the successor chain to its terminal member",
			);

			// Claiming the head of the lineage claims the terminal member only:
			// chain-1 and chain-2 keep their existing successors and stay resumable.
			const claimed = store.claimRecovery("chain-1", "chain-4");
			check(
				claimed.success === true && claimed.status.runId === "chain-3" &&
					claimed.status.phase === "claimed" && claimed.status.successorRunId === "chain-4",
				"claimRecovery operates on the terminal resumable row of the lineage",
			);
			const headLink = store.db.prepare(
				"SELECT successor_run_id, phase FROM standalone_recovery WHERE run_id = 'chain-1'",
			).get() as { successor_run_id: string; phase: string };
			const midLink = store.db.prepare(
				"SELECT successor_run_id, phase FROM standalone_recovery WHERE run_id = 'chain-2'",
			).get() as { successor_run_id: string; phase: string };
			check(
				headLink.successor_run_id === "chain-2" && midLink.successor_run_id === "chain-3" &&
					store.getRecoveryStatus("chain-1")!.runId === "chain-3",
				"middle lineage rows keep exactly one direct successor each",
			);
			const midLoser = store.claimRecovery("chain-2", "chain-5");
			check(
				midLoser.success === false && midLoser.status.runId === "chain-3" &&
					midLoser.status.phase === "claimed" && midLoser.status.successorRunId === "chain-4",
				"a loser claiming a middle run still resolves to the claimed terminal",
			);

			// Wiring the precursor row into an ANCESTOR predecessor is a genuine
			// cycle: chain-1's chain already reaches (the still-dangling) chain-4.
			check(
				expectThrow(() => store.createRecoveryRecord({
					runId: "chain-4",
					taskId: "family-claim",
					specHash,
					predecessorRunId: "chain-1",
					workspaceStateId: "workspace-state-chain-4",
					continuationRecordId: recordId,
					capPolicyId: "cap-v1-core-default",
					expiresAt: new Date(Date.now() + isoDay).toISOString(),
					engineVersion: "engine-v1",
					workspaceCapabilityId: "fake.continuation/v1",
				})).includes("lineage cycle"),
				"a genuine lineage cycle is still rejected",
			);

			// The resumer then creates the claimed successor: the pre-allocated
			// slot is the one legitimate "chain already reaches this id" case.
			store.createRecoveryRecord({
				runId: "chain-4",
				taskId: "family-claim",
				specHash,
				predecessorRunId: "chain-3",
				workspaceStateId: "workspace-state-chain-4",
				continuationRecordId: recordId,
				capPolicyId: "cap-v1-core-default",
				expiresAt: new Date(Date.now() + isoDay).toISOString(),
				engineVersion: "engine-v1",
				workspaceCapabilityId: "fake.continuation/v1",
			});
			check(
				store.resolveToLatestFailed("chain-1")!.runId === "chain-4" &&
					store.resolveToLatestFailed("chain-2")!.runId === "chain-4" &&
					store.resolveToLatestFailed("chain-3")!.runId === "chain-4",
				"creating the successor row makes it the new terminal lineage member",
			);
			noSideEffectTables(store, false, "chain claim");
			store.close();
		}

		// ─── Successor identity via deriveTaskId/resolveAttemptId ───
		{
			const store = new LedgerStore(tmp.path + ".identity");
			const specMarkdown = "# recover me\n\n- keep the investigation\n- finish the fix\n";
			const cwd = join(tmp.dir, "project");
			const familyId = deriveTaskId(specMarkdown, cwd);
			// The failed first attempt owned the family task row; its run id is the
			// family id, exactly as the standalone runner allocates attempts
			// (fresh family, then family-a2, family-a3, ...).
			store.insertTask({ id: familyId, goal: "standalone family" });
			make(store, familyId, { taskId: familyId });

			// The successor is the next free attempt of the SAME family: a new
			// standalone execution identity, not a child task.
			const successorRunId = resolveAttemptId(store, familyId);
			check(
				successorRunId === `${familyId}-a2`,
				"resolveAttemptId allocates the successor attempt id",
			);
			const claimed = store.claimRecovery(familyId, successorRunId);
			check(
				claimed.success === true && claimed.status.taskId === familyId &&
					claimed.status.runId === familyId &&
					claimed.status.successorRunId === `${familyId}-a2`,
				"the claim carries the derived family/attempt successor identity",
			);

			// The resumer then creates the successor row: lineage resolution of
			// the original run id reaches the new latest state.
			store.createRecoveryRecord({
				runId: successorRunId,
				taskId: familyId,
				specHash,
				predecessorRunId: familyId,
				workspaceStateId: `workspace-state-${successorRunId}`,
				continuationRecordId: recordId,
				capPolicyId: "cap-v1-core-default",
				expiresAt: new Date(Date.now() + isoDay).toISOString(),
				engineVersion: "engine-v1",
				workspaceCapabilityId: "fake.continuation/v1",
			});
			const latest = store.resolveToLatestFailed(familyId);
			check(
				latest !== null && latest.runId === successorRunId &&
					latest.taskId === familyId && latest.phase === "resumable" &&
					latest.predecessorRunId === familyId,
				"resolving the original run id reaches the successor state",
			);
			store.close();
		}

		// ─── Concurrent two-callers: exactly one winner ───
		{
			const path = tmp.path + ".concurrent";
			const seed = new LedgerStore(path);
			make(seed, "conc-1");
			seed.close();

			const results = await Promise.all([
				claimInWorker(path, "conc-1", "conc-1-b"),
				claimInWorker(path, "conc-1", "conc-1-c"),
			]);
			const winners = results.filter((result) => result.success);
			const losers = results.filter((result) => !result.success);
			check(
				winners.length === 1 && losers.length === 1,
				`concurrent claimers have exactly one winner, got ${results.map((r) => `${r.success}:${r.successorRunId}`).join(",")}`,
			);
			const winner = winners[0]!;
			const loser = losers[0]!;
			check(
				loser.phase === "claimed" && loser.successorRunId === winner.successorRunId &&
					loser.runId === "conc-1",
				"the concurrent loser receives the winner's factual claimed status",
			);

			const store = new LedgerStore(path);
			const status = store.resolveToLatestFailed("conc-1");
			const successorLinks = Number((store.db.prepare(
				"SELECT COUNT(*) AS n FROM standalone_recovery WHERE run_id = 'conc-1' AND successor_run_id IS NOT NULL",
			).get() as { n: number }).n);
			check(
				status !== null && status.phase === "claimed" &&
					status.successorRunId === winner.successorRunId && successorLinks === 1,
				"the claimed run has exactly one durable direct successor",
			);
			noSideEffectTables(store, false, "concurrent claim");
			store.close();
		}
	} finally {
		rmSync(tmp.dir, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		return Promise.reject(
			new Error("test-recovery-claim failed:\n  ✗ " + errors.join("\n  ✗ ")),
		);
	}
	console.log(
		"✓ recovery-claim: atomic linear claim, one winner, factual losers, zero side effects",
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