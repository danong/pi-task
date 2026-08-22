/**
 * Hermetic tests for the ledger (R3 / M0).
 *
 * Runs against throwaway SQLite databases in a temp dir (node:sqlite) —
 * zero LLM, zero network, real DDL enforced by the engine:
 *   - migration-on-open: fresh DB gets the schema + user_version=1;
 *     reopening is idempotent
 *   - CRUD round-trips on all four tables (tasks, micro_sessions,
 *     routing_feedback, workspaces) including the yield JSON payload
 *   - constraint violations rejected (bad status / plan_mode / role, FK
 *     to a missing task, duplicate PK)
 *   - boot-reconciliation: pure reconcileCrashedTask policy plus the
 *     store's reconcileOnBoot applying it to in-flight rows.
 *
 * Standalone: npx tsx packages/core-v2/test/test-ledger.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	IN_FLIGHT_STATUSES,
	LEDGER_SCHEMA_VERSION,
	LedgerStore,
	reconcileCrashedTask,
} from "../src/ledger/store.ts";

function tempDb(): { path: string; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-task-v2-ledger-"));
	return { path: join(dir, "tasks.db"), dir };
}

/** Run a fn expecting an SQLite constraint error; returns the error message. */
function expectThrow(fn: () => void): string {
	try {
		fn();
		return "";
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const tmp = tempDb();
	try {
		// ─── Migration-on-open + idempotent reopen + CRUD ─────────────
		{
			const store = new LedgerStore(tmp.path);
			const versionRow = store.db.prepare("PRAGMA user_version").get() as { user_version: number };
			check(versionRow.user_version === LEDGER_SCHEMA_VERSION, `fresh DB at schema v${LEDGER_SCHEMA_VERSION}`);

			// tasks CRUD
			store.insertTask({ id: "t1", goal: "Ship feature", planMode: "bundle", maxRetries: 3 });
			let t = store.getTask("t1")!;
			check(t.status === "queued" && t.planMode === "bundle" && t.retryCount === 0 && t.maxRetries === 3,
				"task insert defaults (queued, retry 0, maxRetries honored)");

			store.setTaskStatus("t1", "executing");
			t = store.getTask("t1")!;
			check(t.status === "executing", "task status update round-trip");
			check(store.listTasks("executing").length === 1 && store.listTasks("queued").length === 0,
				"listTasks filters by status");

			// micro_sessions CRUD + JSON payload round-trip
			store.insertMicroSession({ id: "s1", taskId: "t1", role: "worker", turnCount: 4 });
			store.insertMicroSession({ id: "s2", taskId: "t1", role: "reviewer" });
			let s = store.getMicroSession("s1")!;
			check(s.status === "active" && s.turnCount === 4 && s.lastHeartbeatAt === null,
				"session insert defaults (active, heartbeat null for in-process)");
			const yieldJson = JSON.stringify({
				files_changed: ["a.ts"],
				summary: "done",
				commit_ids: ["c1"],
				deviations: [],
			});
			store.setSessionStatus("s1", "yielded", yieldJson);
			s = store.getMicroSession("s1")!;
			check(s.status === "yielded" && JSON.parse(s.yieldPayload!).summary === "done",
				"yield JSON payload round-trip");
			store.heartbeat("s2");
			check(store.getMicroSession("s2")!.lastHeartbeatAt !== null, "heartbeat stamps a child session");
			check(store.listSessions("t1").length === 2, "listSessions by task");

			// workspaces CRUD
			store.insertWorkspace({ id: "w1", taskId: "t1", driver: "test-jj", hostPath: "/tmp/ws/t1", branchName: "t1" });
			store.insertWorkspace({ id: "w2", taskId: "t1", driver: "test-jj", hostPath: "/tmp/ws/t1-2", containerPath: "/work", branchName: "t1-2" });
			const w2 = store.getWorkspace("w2")!;
			check(w2.status === "provisioning" && w2.containerPath === "/work", "workspace insert defaults + containerPath");
			store.setWorkspaceStatus("w1", "released");
			check(store.getWorkspace("w1")!.status === "released" && store.listWorkspaces("t1").length === 2,
				"workspace status update + list");

			// routing_feedback
			store.recordRoutingFeedback("repo/a", "bundle", 1);
			store.recordRoutingFeedback("repo/a", "bundle", 0);
			store.recordRoutingFeedback("repo/a", "fork", 1);
			const rows = store.routingRows("repo/a");
			check(rows.length === 3, "raw feedback rows returned in order");
			check(rows[0]?.mode === "bundle" && rows[0]?.hit === 1, "first bundle row is a hit");
			check(rows[2]?.mode === "fork", "per-repo isolation + ordering");

			// ON DELETE CASCADE: dropping a task removes its sessions.
			store.close();
			// Reopen (idempotent migration) and confirm persistence.
			const reopened = new LedgerStore(tmp.path);
			const freshVersion = reopened.db.prepare("PRAGMA user_version").get() as { user_version: number };
			check(freshVersion.user_version === LEDGER_SCHEMA_VERSION, "reopen is idempotent (no re-migrate)");
			reopened.insertTask({ id: "to-drop", goal: "g" });
			reopened.insertMicroSession({ id: "s-drop", taskId: "to-drop", role: "worker" });
			reopened.db.prepare("DELETE FROM tasks WHERE id = 'to-drop'").run();
			check(reopened.listSessions("to-drop").length === 0, "ON DELETE CASCADE removes task sessions");
			check(reopened.getTask("t1")!.status === "executing", "persisted row survives reopen");
			reopened.close();
		}

		// ─── Constraint violations rejected ───────────────────────────
		{
			const store = new LedgerStore(tmp.path + ".c"); // write a NEW file? reuse
			store.db.exec("DELETE FROM tasks");
			store.db.exec("DELETE FROM micro_sessions");
			store.insertTask({ id: "t2", goal: "g" });

			const badStatus = expectThrow(() => store.setTaskStatus("t2", "nonsense" as never));
			check(badStatus.includes("CHECK"), `invalid task status rejected (${badStatus})`);

			const badPlan = expectThrow(() => store.insertTask({ id: "t3", goal: "g", planMode: "boom" as never }));
			check(badPlan.includes("CHECK"), "invalid plan_mode rejected");

			const badRole = expectThrow(() => store.insertMicroSession({ id: "s3", taskId: "t2", role: "janitor" as never }));
			check(badRole.includes("CHECK"), "invalid session role rejected");

			// Valid rows — must insert WITHOUT throwing (positive probes; the
			// invalid-status probes below then have rows to act on).
			store.insertMicroSession({ id: "s4", taskId: "t2", role: "worker", turnCount: 1 });
			const badSessionStatus = expectThrow(() => store.setSessionStatus("s4", "done" as never));
			check(badSessionStatus.includes("CHECK"), "invalid session status rejected");

			store.insertWorkspace({ id: "w3", taskId: "t2", driver: "d", hostPath: "h", branchName: "b" });
			const badWsStatus = expectThrow(() => store.setWorkspaceStatus("w3", "not-a-status" as never));
			check(badWsStatus.includes("CHECK"), "invalid workspace status rejected");

			const dupPk = expectThrow(() => store.insertTask({ id: "t2", goal: "again" }));
			check(dupPk.includes("UNIQUE") || dupPk.includes("PRIMARY"), "duplicate task PK rejected");

			const fkViolation = expectThrow(() =>
				store.insertMicroSession({ id: "s-orphan", taskId: "no-such-task", role: "worker" }),
			);
			check(fkViolation.includes("FOREIGN KEY"), "session referencing a missing task rejected");

			store.close();
		}

		// ─── Boot reconciliation (pure policy + store method) ─────────
		{
			check(IN_FLIGHT_STATUSES.length === 4, "in-flight set is the four mid-flight statuses");
			check(reconcileCrashedTask({ status: "executing", retryCount: 0, maxRetries: 2 }).action === "requeue",
				"in-flight + attempts left → requeue");
			check(reconcileCrashedTask({ status: "verifying", retryCount: 2, maxRetries: 2 }).action === "fail",
				"in-flight + attempts exhausted → fail");
			check(reconcileCrashedTask({ status: "queued", retryCount: 0, maxRetries: 1 }).action === "keep",
				"queued is not touched");
			check(reconcileCrashedTask({ status: "completed", retryCount: 0, maxRetries: 1 }).action === "keep",
				"completed is not touched");

			const store = new LedgerStore(tmp.path + ".rec");
			store.insertTask({ id: "r1", goal: "g", maxRetries: 2 }); // executing, 0 retries → requeue
			store.setTaskStatus("r1", "executing");
			store.insertTask({ id: "r2", goal: "g", maxRetries: 1, retryCount: 1 }); // executing, exhausted → fail
			store.setTaskStatus("r2", "executing");
			store.insertTask({ id: "r3", goal: "g" }); // queued → keep
			store.insertTask({ id: "r4", goal: "g" }); // completed → keep
			store.setTaskStatus("r4", "completed");

			const result = store.reconcileOnBoot();
			check(result.requeued.join(",") === "r1", `requeued ids, got ${result.requeued}`);
			check(result.failed.join(",") === "r2", `failed ids, got ${result.failed}`);
			check(store.getTask("r1")!.status === "queued" && store.getTask("r1")!.retryCount === 1,
				"requeued task went back to queued with retry incremented");
			check(store.getTask("r2")!.status === "failed", "exhausted task failed");
			check(store.getTask("r3")!.status === "queued" && store.getTask("r4")!.status === "completed",
				"queued/completed untouched");

			// Idempotent: a second boot finds nothing in flight.
			const second = store.reconcileOnBoot();
			check(second.requeued.length === 0 && second.failed.length === 0, "reconcile is idempotent");
			store.close();
		}
	} finally {
		rmSync(tmp.dir, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		throw new Error("test-ledger failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log("✓ ledger: migrations, CRUD round-trips, constraints, boot reconciliation");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}