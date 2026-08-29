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
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	IN_FLIGHT_STATUSES,
	LEDGER_SCHEMA_VERSION,
	classifyChildRestart,
	LedgerStore,
	reconcileCrashedTask,
	type SequentialEdgeConfig,
} from "../src/ledger/store.ts";
import type { ImmutableArtifactReference } from "../src/contracts/context-lifecycle.ts";

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

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const tmp = tempDb();
	try {
		// ─── Migration-on-open + idempotent reopen + CRUD ─────────────
		{
			const store = new LedgerStore(tmp.path);
			const versionRow = store.db.prepare("PRAGMA user_version").get() as {
				user_version: number;
			};
			check(
				versionRow.user_version === LEDGER_SCHEMA_VERSION,
				`fresh DB at schema v${LEDGER_SCHEMA_VERSION}`,
			);

			// tasks CRUD
			store.insertTask({
				id: "t1",
				goal: "Ship feature",
				planMode: "bundle",
				maxRetries: 3,
			});
			let t = store.getTask("t1")!;
			check(
				t.status === "queued" &&
					t.planMode === "bundle" &&
					t.retryCount === 0 &&
					t.maxRetries === 3,
				"task insert defaults (queued, retry 0, maxRetries honored)",
			);

			store.setTaskStatus("t1", "executing");
			t = store.getTask("t1")!;
			check(t.status === "executing", "task status update round-trip");
			check(
				store.listTasks("executing").length === 1 &&
					store.listTasks("queued").length === 0,
				"listTasks filters by status",
			);

			// micro_sessions CRUD + JSON payload round-trip
			store.insertMicroSession({
				id: "s1",
				taskId: "t1",
				role: "worker",
				turnCount: 4,
			});
			store.insertMicroSession({ id: "s2", taskId: "t1", role: "reviewer" });
			let s = store.getMicroSession("s1")!;
			check(
				s.status === "active" &&
					s.turnCount === 4 &&
					s.lastHeartbeatAt === null,
				"session insert defaults (active, heartbeat null for in-process)",
			);
			const yieldJson = JSON.stringify({
				files_changed: ["a.ts"],
				summary: "done",
				commit_ids: ["c1"],
				deviations: [],
			});
			store.setSessionStatus("s1", "yielded", yieldJson);
			s = store.getMicroSession("s1")!;
			const parsedYield = JSON.parse(s.yieldPayload!) as {
				summary: string;
			};
			check(
				s.status === "yielded" && parsedYield.summary === "done",
				"yield JSON payload round-trip",
			);
			store.heartbeat("s2");
			check(
				store.getMicroSession("s2")!.lastHeartbeatAt !== null,
				"heartbeat stamps a child session",
			);
			check(store.listSessions("t1").length === 2, "listSessions by task");

			// workspaces CRUD
			store.insertWorkspace({
				id: "w1",
				taskId: "t1",
				driver: "test-jj",
				hostPath: "/tmp/ws/t1",
				branchName: "t1",
			});
			store.insertWorkspace({
				id: "w2",
				taskId: "t1",
				driver: "test-jj",
				hostPath: "/tmp/ws/t1-2",
				containerPath: "/work",
				branchName: "t1-2",
			});
			const w2 = store.getWorkspace("w2")!;
			check(
				w2.status === "provisioning" && w2.containerPath === "/work",
				"workspace insert defaults + containerPath",
			);
			store.setWorkspaceStatus("w1", "released");
			check(
				store.getWorkspace("w1")!.status === "released" &&
					store.listWorkspaces("t1").length === 2,
				"workspace status update + list",
			);

			// routing_feedback
			store.recordRoutingFeedback("repo/a", "bundle", 1);
			store.recordRoutingFeedback("repo/a", "bundle", 0);
			store.recordRoutingFeedback("repo/a", "fork", 1);
			const rows = store.routingRows("repo/a");
			check(rows.length === 3, "raw feedback rows returned in order");
			check(
				rows[0]?.mode === "bundle" && rows[0]?.hit === 1,
				"first bundle row is a hit",
			);
			check(rows[2]?.mode === "fork", "per-repo isolation + ordering");

			// ON DELETE CASCADE: dropping a task removes its sessions.
			store.close();
			// Reopen (idempotent migration) and confirm persistence.
			const reopened = new LedgerStore(tmp.path);
			const freshVersion = reopened.db.prepare("PRAGMA user_version").get() as {
				user_version: number;
			};
			check(
				freshVersion.user_version === LEDGER_SCHEMA_VERSION,
				"reopen is idempotent (no re-migrate)",
			);
			reopened.insertTask({ id: "to-drop", goal: "g" });
			reopened.insertMicroSession({
				id: "s-drop",
				taskId: "to-drop",
				role: "worker",
			});
			reopened.db.prepare("DELETE FROM tasks WHERE id = 'to-drop'").run();
			check(
				reopened.listSessions("to-drop").length === 0,
				"ON DELETE CASCADE removes task sessions",
			);
			check(
				reopened.getTask("t1")!.status === "executing",
				"persisted row survives reopen",
			);
			reopened.close();
		}

		// ─── Constraint violations rejected ───────────────────────────
		{
			const store = new LedgerStore(tmp.path + ".c"); // write a NEW file? reuse
			store.db.exec("DELETE FROM tasks");
			store.db.exec("DELETE FROM micro_sessions");
			store.insertTask({ id: "t2", goal: "g" });

			const badStatus = expectThrow(() =>
				store.setTaskStatus("t2", "nonsense" as never),
			);
			check(
				badStatus.includes("CHECK"),
				`invalid task status rejected (${badStatus})`,
			);

			const badPlan = expectThrow(() =>
				store.insertTask({ id: "t3", goal: "g", planMode: "boom" as never }),
			);
			check(badPlan.includes("CHECK"), "invalid plan_mode rejected");

			const badRole = expectThrow(() =>
				store.insertMicroSession({
					id: "s3",
					taskId: "t2",
					role: "janitor" as never,
				}),
			);
			check(badRole.includes("CHECK"), "invalid session role rejected");

			// Valid rows — must insert WITHOUT throwing (positive probes; the
			// invalid-status probes below then have rows to act on).
			store.insertMicroSession({
				id: "s4",
				taskId: "t2",
				role: "worker",
				turnCount: 1,
			});
			const badSessionStatus = expectThrow(() =>
				store.setSessionStatus("s4", "done" as never),
			);
			check(
				badSessionStatus.includes("CHECK"),
				"invalid session status rejected",
			);

			store.insertWorkspace({
				id: "w3",
				taskId: "t2",
				driver: "d",
				hostPath: "h",
				branchName: "b",
			});
			const badWsStatus = expectThrow(() =>
				store.setWorkspaceStatus("w3", "not-a-status" as never),
			);
			check(badWsStatus.includes("CHECK"), "invalid workspace status rejected");

			const dupPk = expectThrow(() =>
				store.insertTask({ id: "t2", goal: "again" }),
			);
			check(
				dupPk.includes("UNIQUE") || dupPk.includes("PRIMARY"),
				"duplicate task PK rejected",
			);

			const fkViolation = expectThrow(() =>
				store.insertMicroSession({
					id: "s-orphan",
					taskId: "no-such-task",
					role: "worker",
				}),
			);
			check(
				fkViolation.includes("FOREIGN KEY"),
				"session referencing a missing task rejected",
			);

			store.close();
		}

		// ─── M5 child edges, references, and transactional claims ────────
		{
			const store = new LedgerStore(tmp.path + ".m5");
			store.insertTask({ id: "parent", goal: "parent goal" });
			store.insertTask({ id: "child", goal: "child goal" });
			const ready = store.persistReadyChildIntent({
				edgeId: "edge-1",
				parentTaskId: "parent",
				childTaskId: "child",
				ordinal: 1,
				handoffArtifactId: "sha256:" + "1".repeat(64),
				checkpointArtifactId: "sha256:" + "2".repeat(64),
				artifacts: [
					{
						role: "plan",
						artifactId: "sha256:" + "3".repeat(64),
						mediaType: "application/json",
						sourceRevision: "sha256:" + "4".repeat(64),
					},
				],
				workspaceContinuation: {
					id: "continuation-1",
					taskId: "child",
					driver: "fake",
					providerVersion: "1",
					opaqueToken: "opaque-provider-token",
					revision: "rev-1",
				},
			});
			check(ready.status === "ready", "ready child intent is durable");
			check(
			store.listTaskArtifacts("child").length === 3,
			"handoff, checkpoint, and plan references commit with the intent",
		);
		check(
			store.getWorkspaceContinuation("continuation-1")?.opaqueToken ===
				"opaque-provider-token",
			"workspace continuation record round-trips as opaque ledger state",
		);
		check(
			store.getParentTask("child")?.id === "parent" &&
				store.getParentEdge("child")?.ordinal === 1,
			"parent lookup follows the durable edge",
		);
		const duplicateOrdinal = expectThrow(() =>
			store.persistReadyChildIntent({
				edgeId: "edge-duplicate",
				parentTaskId: "parent",
				childTaskId: "child",
				ordinal: 1,
				handoffArtifactId: "sha256:" + "8".repeat(64),
			}),
		);
		check(
			duplicateOrdinal.includes("UNIQUE"),
			"parent and ordinal uniqueness is enforced",
		);
		check(
			store.listTaskArtifacts("child").length === 3 &&
			Number((store.db.prepare("SELECT COUNT(*) AS n FROM workspace_continuations").get() as { n: number }).n) === 1,
			"failed duplicate intent rolls back all child rows",
		);

		// Two independent connections use the same conditional ownership update.
		const claimed = store.claimReadyChild("edge-1");
		check(claimed?.status === "claimed", "first ready claim succeeds");
		const secondConnection = new LedgerStore(tmp.path + ".m5");
		check(secondConnection.claimReadyChild("edge-1") === null, "second connection loses a ready claim cleanly");
		secondConnection.close();
		check(store.claimReadyChild("edge-1") === null, "second claim is a no-op");
		store.markChildResumable("edge-1");
		check(
			store.findResumableChild("parent")?.edgeId === "edge-1",
			"resumable child lookup is durable",
		);
		const resumableConnection = new LedgerStore(tmp.path + ".m5");
		const resumableClaim = resumableConnection.claimResumableChild("edge-1");
		check(
			resumableClaim?.status === "claimed" &&
				store.claimResumableChild("edge-1") === null,
			"two connections make resumable compare-and-set exactly once",
		);
		resumableConnection.close();
		const settlement = {
			resultArtifactId: "sha256:" + "5".repeat(64),
			receiptArtifactId: "sha256:" + "6".repeat(64),
			traceArtifactId: "sha256:" + "7".repeat(64),
		};
		const terminal = store.settleChild("edge-1", "completed", settlement);
		const repeated = store.settleChild("edge-1", "completed", settlement);
		check(
			terminal.status === "completed" &&
			terminal.completedAt !== null &&
			repeated.status === "completed" &&
			repeated.completedAt === terminal.completedAt,
			"terminal transition is idempotent",
		);
		check(
			store.getWorkspaceContinuation("continuation-1")?.status === "completed" &&
			store.getTask("parent")?.status === "completed" &&
			store.getTask("child")?.status === "completed" &&
			store.listTaskArtifacts("child").length === 6,
			"atomic settlement updates continuation, both tasks, and all evidence references",
		);
		check(expectThrow(() => store.markChildResumable("edge-1")).length > 0, "terminal edge cannot become resumable");
		check(expectThrow(() => store.markChildBlocked("edge-1")).length > 0, "terminal edge cannot become blocked");
		check(expectThrow(() => store.settleChild("edge-1", "failed", settlement)).length > 0, "terminal outcome is immutable");
		// Relational invariants are enforced below the convenience API too.
		store.insertTask({ id: "other-child", goal: "g" });
		store.insertWorkspaceContinuation({ id: "wrong-cont", taskId: "parent", driver: "fake", providerVersion: "1", opaqueToken: "x", revision: "r" });
		const wrongContinuation = expectThrow(() => store.db.prepare(`INSERT INTO task_edges (edge_id, parent_task_id, child_task_id, ordinal, relationship, status, handoff_artifact_id, workspace_continuation_id) VALUES ('wrong-edge', 'parent', 'other-child', 2, 'continuation', 'ready', ?, 'wrong-cont')`).run("sha256:" + "8".repeat(64)));
		check(wrongContinuation.includes("FOREIGN KEY"), "edge cannot reference another task's continuation");
		const duplicateParent = expectThrow(() => store.db.prepare(`INSERT INTO task_edges (edge_id, parent_task_id, child_task_id, ordinal, relationship, status, handoff_artifact_id) VALUES ('duplicate-child-edge', 'parent', 'child', 3, 'continuation', 'ready', ?)`).run("sha256:" + "8".repeat(64)));
		check(duplicateParent.includes("UNIQUE"), "non-null child has one parent edge");
		store.close();
		const reopened = new LedgerStore(tmp.path + ".m5");
		check(
			reopened.getTask("parent")?.goal === "parent goal" &&
				reopened.getTaskEdge("edge-1")?.status === "completed",
			"old and child rows survive reopen/migration",
		);
		reopened.close();

		// ─── M5-C4 durable external delivery phase ───────────────────────
		{
			const store = new LedgerStore(tmp.path + ".delivery");
			store.insertTask({ id: "delivery-parent", goal: "parent" });
			store.insertTask({ id: "delivery-child", goal: "child" });
			const ref = (kind: ImmutableArtifactReference["kind"], digit: string): ImmutableArtifactReference => ({ version: 1, id: `sha256:${digit.repeat(64)}`, namespace: kind, kind, mediaType: "application/json", sizeBytes: 1, sensitivity: "internal", sourceRevision: "rev" });
			const refs = { verificationReference: ref("verification", "1"), resultReference: ref("result", "2"), receiptReference: ref("receipt", "3"), traceReference: ref("trace", "4"), parentReceiptReference: ref("receipt", "5"), parentTraceReference: ref("trace", "6") };
			store.persistReadyChildIntent({ edgeId: "delivery-edge", parentTaskId: "delivery-parent", childTaskId: "delivery-child", ordinal: 1, handoffArtifactId: ref("handoff", "7").id, checkpointArtifactId: ref("checkpoint", "8").id, workspaceContinuation: { id: "delivery-cont", taskId: "delivery-child", driver: "fake", providerVersion: "1", opaqueToken: "opaque", revision: "rev" } });
			store.claimReadyChild("delivery-edge");
			store.beginChildTerminalSettlement({ edgeId: "delivery-edge", childStatus: "completed", ...refs, verification: {}, result: {}, receipt: {}, trace: {}, parentReceipt: {}, parentTrace: {} });
			store.settleChild("delivery-edge", "completed", { verificationArtifactId: refs.verificationReference.id, resultArtifactId: refs.resultReference.id, receiptArtifactId: refs.receiptReference.id, traceArtifactId: refs.traceReference.id, parentReceiptArtifactId: refs.parentReceiptReference.id, parentTraceArtifactId: refs.parentTraceReference.id, ...refs }, { deliveryAcknowledged: false });
			check(store.getTaskEdge("delivery-edge")?.status === "delivery_pending" && store.getTask("delivery-parent")?.status === "delivery_pending" && store.getTask("delivery-child")?.status === "delivery_pending", "external delivery keeps ledger and edge non-terminal");
			store.recordChildDeliveryFailure("delivery-edge", "trace_write_failed", "bounded trace failure");
			store.close();
			const reopenedDelivery = new LedgerStore(tmp.path + ".delivery");
			check(reopenedDelivery.getChildTerminalSettlement("delivery-edge")?.delivery.failureCode === "trace_write_failed", "typed delivery failure survives close/reopen");
			reopenedDelivery.acknowledgeChildDeliveryStep("delivery-edge", "receipt");
			reopenedDelivery.acknowledgeChildDeliveryStep("delivery-edge", "trace");
			check(reopenedDelivery.getTaskEdge("delivery-edge")?.status === "delivery_pending", "partial acknowledgement remains delivery pending");
			const terminalDelivery = reopenedDelivery.acknowledgeChildDeliveryStep("delivery-edge", "final_receipt");
			const repeatedDelivery = reopenedDelivery.acknowledgeChildDeliveryStep("delivery-edge", "final_receipt");
			check(terminalDelivery.status === "completed" && repeatedDelivery.status === "completed" && reopenedDelivery.getTask("delivery-parent")?.status === "completed", "idempotent final acknowledgement completes ledger delivery");
			reopenedDelivery.close();
		}

		// True pre-v3 fixture: build only the v1/v2 tables, rather than opening
		// LedgerStore and merely changing user_version after v3 already exists.
		const legacyPath = tmp.path + ".legacy";
		const legacyDb = new DatabaseSync(legacyPath);
		legacyDb.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('queued','planning','executing','verifying','reviewing','completed','failed','escalated')), goal TEXT NOT NULL, parent_branch TEXT, plan_mode TEXT, retry_count INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 2, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
			CREATE TABLE micro_sessions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, role TEXT NOT NULL, status TEXT NOT NULL, turn_count INTEGER DEFAULT 0, yield_payload JSON, last_heartbeat_at DATETIME);
			CREATE TABLE routing_feedback (repo TEXT NOT NULL, mode TEXT NOT NULL, hit INTEGER NOT NULL, recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP);
			CREATE TABLE workspaces (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, driver TEXT NOT NULL, host_path TEXT NOT NULL, container_path TEXT, branch_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'provisioning', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
			CREATE TABLE workflow_approvals (dag_id TEXT PRIMARY KEY, approved INTEGER NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
			PRAGMA user_version = 2;
		`);
		legacyDb.prepare("INSERT INTO tasks (id, status, goal) VALUES (?, 'queued', ?)").run("legacy", "preserve me");
		legacyDb.prepare("INSERT INTO micro_sessions (id, task_id, role, status) VALUES (?, ?, ?, 'active')").run("legacy-session", "legacy", "worker");
		legacyDb.close();
		const migrated = new LedgerStore(legacyPath);
		check(
			migrated.getTask("legacy")?.goal === "preserve me" &&
			migrated.getMicroSession("legacy-session")?.taskId === "legacy" &&
			(Number((migrated.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version) === LEDGER_SCHEMA_VERSION) &&
			migrated.db.prepare("SELECT name FROM sqlite_master WHERE name = 'task_edges'").get() !== undefined,
			"true pre-v3 migration preserves legacy rows and installs child schema",
		);
		migrated.close();

		// Pre-hardening M5 fixture: task_artifacts had only the role-scoped
		// uniqueness constraint. The hardened upsert's conflict target therefore
		// failed at statement preparation on an otherwise usable warm ledger.
		const warmPath = tmp.path + ".warm";
		const warmDb = new DatabaseSync(warmPath);
		warmDb.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('queued','planning','executing','verifying','reviewing','completed','failed','escalated')), goal TEXT NOT NULL, parent_branch TEXT, plan_mode TEXT, retry_count INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 2, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
			CREATE TABLE task_artifacts (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, role TEXT NOT NULL, artifact_id TEXT NOT NULL, media_type TEXT NOT NULL, source_revision TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, reference_json TEXT, UNIQUE(task_id, role, artifact_id));
			CREATE TABLE workspace_continuations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, driver TEXT NOT NULL, provider_version TEXT NOT NULL, opaque_token TEXT NOT NULL, revision TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','claimed','resumable','blocked','completed','failed','escalated')), created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, capability_identity TEXT, capability_version TEXT, UNIQUE(task_id, id));
			CREATE TABLE task_edges (edge_id TEXT PRIMARY KEY, parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, child_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL CHECK (ordinal > 0), relationship TEXT NOT NULL CHECK (relationship IN ('continuation')), status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','claimed','resumable','blocked','completed','failed','escalated')), handoff_artifact_id TEXT NOT NULL, checkpoint_artifact_id TEXT, workspace_continuation_id TEXT REFERENCES workspace_continuations(id) ON DELETE SET NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, claimed_at DATETIME, completed_at DATETIME, UNIQUE(parent_task_id, ordinal), UNIQUE(child_task_id), FOREIGN KEY (child_task_id, workspace_continuation_id) REFERENCES workspace_continuations(task_id, id));
			CREATE TABLE sequential_edge_configs (edge_id TEXT PRIMARY KEY REFERENCES task_edges(edge_id) ON DELETE CASCADE, handoff_reference_json TEXT NOT NULL, checkpoint_reference_json TEXT NOT NULL, child_spec_reference_json TEXT NOT NULL, plan_reference_json TEXT NOT NULL, ingress_config_reference_json TEXT NOT NULL, parent_receipt_reference_json TEXT NOT NULL, model_identity TEXT NOT NULL, source_revision TEXT NOT NULL, capability_identity TEXT NOT NULL, capability_version TEXT NOT NULL);
			PRAGMA user_version = 4;
		`);
		warmDb.prepare("INSERT INTO tasks (id, status, goal) VALUES (?, 'queued', ?)").run("warm-parent", "warm parent");
		warmDb.prepare("INSERT INTO tasks (id, status, goal) VALUES (?, 'queued', ?)").run("warm-child", "warm child");
		const warmArtifactId = "sha256:" + "a".repeat(64);
		const oldUpsertFailure = expectThrow(() => warmDb.prepare(`INSERT INTO task_artifacts (task_id, role, artifact_id, media_type, source_revision, reference_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, artifact_id) DO UPDATE SET role = excluded.role`).run("warm-child", "legacy", warmArtifactId, "application/json", null, null));
		check(oldUpsertFailure.includes("ON CONFLICT clause does not match"), "pre-hardening fixture reproduces the warm-ledger parent-to-child failure");
		warmDb.prepare("INSERT INTO task_artifacts (task_id, role, artifact_id, media_type) VALUES (?, 'legacy', ?, 'application/json')").run("warm-child", warmArtifactId);
		warmDb.close();

		const migratedWarm = new LedgerStore(warmPath);
		const warmVersion = Number((migratedWarm.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
		const warmIndexes = migratedWarm.db.prepare("PRAGMA index_list(task_artifacts)").all() as Array<{ name: string; unique: number }>;
		check(warmVersion === LEDGER_SCHEMA_VERSION && warmIndexes.some((index) => index.unique === 1 && index.name === "task_artifacts_task_artifact_v11_uidx"), "warm ledger migration installs the additive artifact conflict index");
		const warmRef = (digit: string, kind: ImmutableArtifactReference["kind"], namespace = kind): ImmutableArtifactReference => ({ version: 1, id: `sha256:${digit.repeat(64)}`, namespace, kind, mediaType: "application/json", sizeBytes: 1, sensitivity: "internal", sourceRevision: "sha256:" + "f".repeat(64) });
		const warmConfig: SequentialEdgeConfig = { edgeId: "warm-edge", handoffReference: warmRef("a", "handoff"), checkpointReference: warmRef("2", "checkpoint"), childSpecReference: warmRef("3", "context", "context"), planReference: warmRef("4", "plan"), ingressConfigReference: warmRef("5", "context", "context"), parentReceiptReference: warmRef("6", "receipt"), modelIdentity: "fake/model", sourceRevision: "sha256:" + "f".repeat(64), capabilityIdentity: "fake.continuation", capabilityVersion: "1" };
		const preparedWarm = migratedWarm.persistReadyChildIntent({ edgeId: warmConfig.edgeId, parentTaskId: "warm-parent", childTaskId: "warm-child", ordinal: 1, handoffArtifactId: warmConfig.handoffReference.id, checkpointArtifactId: warmConfig.checkpointReference.id, workspaceContinuation: { id: "warm-continuation", taskId: "warm-child", driver: "fake", providerVersion: "1", capabilityIdentity: "fake.continuation", capabilityVersion: "1", opaqueToken: "opaque", revision: "warm-revision" }, sequentialConfig: warmConfig });
		const warmClaimed = migratedWarm.claimReadyChild(preparedWarm.edgeId);
		migratedWarm.markChildResumable(preparedWarm.edgeId);
		const warmResumeClaim = migratedWarm.claimResumableChild(preparedWarm.edgeId);
		const resumedWarm = migratedWarm.updateResumableChild(preparedWarm.edgeId, { id: "warm-continuation", taskId: "warm-child", driver: "fake", providerVersion: "1", capabilityIdentity: "fake.continuation", capabilityVersion: "1", opaqueToken: "opaque-resumed", revision: "warm-revision-2" }, warmConfig);
		check(warmClaimed?.status === "claimed" && warmResumeClaim?.status === "claimed" && resumedWarm.status === "resumable" && migratedWarm.listTaskArtifacts("warm-child").some((artifact) => artifact.artifactId === warmConfig.handoffReference.id), "migrated warm ledger prepares and resumes a child through the hardened ON CONFLICT path");
		migratedWarm.close();
		const reopenedWarm = new LedgerStore(warmPath);
		check(Number((reopenedWarm.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version) === LEDGER_SCHEMA_VERSION && reopenedWarm.getTask("warm-parent")?.goal === "warm parent" && reopenedWarm.getTask("warm-child")?.goal === "warm child", "warm migration remains idempotent and preserves existing task rows on reopen");
		reopenedWarm.close();

		// A conflicting historical identity rejects atomically: no version bump,
		// no half-installed index, and no artifact row is lost for repair.
		const failedMigrationPath = tmp.path + ".migration-failure";
		const failedMigrationDb = new DatabaseSync(failedMigrationPath);
		failedMigrationDb.exec(`CREATE TABLE task_artifacts (task_id TEXT NOT NULL, role TEXT NOT NULL, artifact_id TEXT NOT NULL, media_type TEXT NOT NULL, source_revision TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, reference_json TEXT, UNIQUE(task_id, role, artifact_id)); PRAGMA user_version = 10;`);
		failedMigrationDb.prepare("INSERT INTO task_artifacts (task_id, role, artifact_id, media_type) VALUES ('t', ?, 'sha256:" + "b".repeat(64) + "', 'application/json')").run("one");
		failedMigrationDb.prepare("INSERT INTO task_artifacts (task_id, role, artifact_id, media_type) VALUES ('t', ?, 'sha256:" + "b".repeat(64) + "', 'application/json')").run("two");
		failedMigrationDb.close();
		const migrationFailure = expectThrow(() => new LedgerStore(failedMigrationPath));
		const failedInspection = new DatabaseSync(failedMigrationPath);
		const failedVersion = Number((failedInspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
		const failedIndexes = failedInspection.prepare("PRAGMA index_list(task_artifacts)").all() as Array<{ name: string; unique: number }>;
		const failedRows = Number((failedInspection.prepare("SELECT COUNT(*) AS n FROM task_artifacts").get() as { n: number }).n);
		check(migrationFailure.includes("UNIQUE") && failedVersion === 10 && failedRows === 2 && !failedIndexes.some((index) => index.name === "task_artifacts_task_artifact_v11_uidx"), "failed warm-ledger migration rolls back version, index, and durable rows");
		failedInspection.close();
	}

		// ─── R2 regression: isolated/parallel worker+aggregate finalization must not be blocked by global terminal immutability ───
		{
			const store = new LedgerStore(tmp.path + ".regression");
			// Simulate the isolated/parallel pipeline's existing task lifecycle:
			// aggregate and workers are set to executing, then workers complete, then healthy workers are
			// moved to verifying for the shared verification gate, then back to completed, and aggregate completes.
			// The hardened global check `terminal task status is immutable` would reject the completed -> verifying step.
			store.insertTask({ id: "agg", goal: "aggregate" });
			store.insertTask({ id: "worker-0", goal: "worker 0" });
			store.insertTask({ id: "worker-1", goal: "worker 1" });
			store.setTaskStatus("agg", "executing");
			store.setTaskStatus("worker-0", "executing");
			store.setTaskStatus("worker-1", "executing");
			// Workers yield → completed (parallel.ts:720)
			store.setTaskStatus("worker-0", "completed");
			store.setTaskStatus("worker-1", "completed");
			check(store.getTask("worker-0")!.status === "completed" && store.getTask("worker-1")!.status === "completed", "workers completed after yield");
			// M4 verification gate: healthy workers sit in `verifying` until aggregate ships (parallel.ts:915)
			let threw = "";
			try {
				store.setTaskStatus("worker-0", "verifying");
				store.setTaskStatus("worker-1", "verifying");
			} catch (err) {
				threw = err instanceof Error ? err.message : String(err);
			}
			check(threw === "", `worker completed -> verifying must not throw terminal immutability, got: ${threw || "no error"} but pipeline requires it`);
			check(store.getTask("worker-0")!.status === "verifying" && store.getTask("worker-1")!.status === "verifying", "workers verifying after completed");
			// Verification passed → workers back to completed (parallel.ts:1194) and aggregate completed (1200)
			store.setTaskStatus("worker-0", "completed");
			store.setTaskStatus("worker-1", "completed");
			store.setTaskStatus("agg", "completed");
			check(store.getTask("worker-0")!.status === "completed" && store.getTask("agg")!.status === "completed", "workers and aggregate re-completed after verification");
			// Idempotent re-completion must also not throw; child-edge APIs remain strict on their own paths (tested above)
			threw = "";
			try { store.setTaskStatus("worker-0", "completed"); } catch (err) { threw = err instanceof Error ? err.message : String(err); }
			check(threw === "", `repeated completed -> completed must not throw terminal immutability, got: ${threw}`);
			check(!threw.includes("terminal task status is immutable"), "generic setTaskStatus does not impose terminal immutability");
			store.close();
		}

		// ─── Boot reconciliation (pure policy + store method) ─────────
		{
			check(
				IN_FLIGHT_STATUSES.length === 4,
				"in-flight set is the four mid-flight statuses",
			);
			check(
				reconcileCrashedTask({
					status: "executing",
					retryCount: 0,
					maxRetries: 2,
				}).action === "requeue",
				"in-flight + attempts left → requeue",
			);
			check(
				reconcileCrashedTask({
					status: "verifying",
					retryCount: 2,
					maxRetries: 2,
				}).action === "fail",
				"in-flight + attempts exhausted → fail",
			);
			check(
				reconcileCrashedTask({ status: "queued", retryCount: 0, maxRetries: 1 })
					.action === "keep",
				"queued is not touched",
			);
			check(
				reconcileCrashedTask({
					status: "completed",
					retryCount: 0,
					maxRetries: 1,
				}).action === "keep",
				"completed is not touched",
			);
			check(classifyChildRestart({ status: "claimed", checkpointPresent: true, continuationPresent: true }) === "resumable", "valid claimed child is resumable without a session");
			check(classifyChildRestart({ status: "claimed", checkpointPresent: false, continuationPresent: true }) === "blocked", "missing checkpoint blocks restart");
			check(classifyChildRestart({ status: "completed", checkpointPresent: false, continuationPresent: false }) === "completed", "terminal child restart is immutable");

			const store = new LedgerStore(tmp.path + ".rec");
			store.insertTask({ id: "r1", goal: "g", maxRetries: 2 }); // executing, 0 retries → requeue
			store.setTaskStatus("r1", "executing");
			store.insertTask({ id: "r2", goal: "g", maxRetries: 1, retryCount: 1 }); // executing, exhausted → fail
			store.setTaskStatus("r2", "executing");
			store.insertTask({ id: "r3", goal: "g" }); // queued → keep
			store.insertTask({ id: "r4", goal: "g" }); // completed → keep
			store.setTaskStatus("r4", "completed");

			// Restart classification is deterministic and ledger-only. Incomplete
			// ingress is blocked; a complete immutable manifest is required before
			// a claimed edge can become resumable.
			store.insertTask({ id: "edge-parent", goal: "g" });
			store.insertTask({ id: "r5-child", goal: "g" });
			store.persistReadyChildIntent({
				edgeId: "r5-edge", parentTaskId: "edge-parent", childTaskId: "r5-child", ordinal: 1,
				handoffArtifactId: "sha256:" + "9".repeat(64),
			});
			store.claimReadyChild("r5-edge");
			store.insertTask({ id: "r6-child", goal: "g" });
			store.persistReadyChildIntent({
				edgeId: "r6-edge", parentTaskId: "edge-parent", childTaskId: "r6-child", ordinal: 2,
				handoffArtifactId: "sha256:" + "a".repeat(64),
				checkpointArtifactId: "sha256:" + "b".repeat(64),
				workspaceContinuation: { id: "r6-cont", taskId: "r6-child", driver: "fake", providerVersion: "1", opaqueToken: "token", revision: "rev" },
			});
			store.claimReadyChild("r6-edge");
			const recoveryRef = (hex: string, kind: ImmutableArtifactReference["kind"], namespace = kind): ImmutableArtifactReference => ({ version: 1, id: `sha256:${hex.repeat(64)}`, namespace, kind, mediaType: "application/json", sizeBytes: 1, sensitivity: "internal", sourceRevision: "rev" });
			const recoveryConfig: SequentialEdgeConfig = { edgeId: "r6-edge", handoffReference: recoveryRef("1", "handoff"), checkpointReference: recoveryRef("2", "checkpoint"), childSpecReference: recoveryRef("3", "context", "context"), planReference: recoveryRef("4", "plan"), ingressConfigReference: recoveryRef("5", "context", "context"), parentReceiptReference: recoveryRef("6", "receipt"), modelIdentity: "fake/model", sourceRevision: "rev", capabilityIdentity: "fake.continuation", capabilityVersion: "1" };
			const ownershipFailure = expectThrow(() => store.updateResumableChild("r6-edge", { id: "wrong-continuation", taskId: "r6-child", driver: "fake", providerVersion: "1", capabilityIdentity: "fake.continuation", capabilityVersion: "1", opaqueToken: "token", revision: "rev" }, recoveryConfig));
			check(ownershipFailure.includes("owned by the child edge"), "resumable refresh rejects a continuation not owned by the edge");
			const childRestart = store.reconcileChildEdgesOnBoot();
			check(childRestart.blocked.includes("r5-edge") && childRestart.blocked.includes("r6-edge") && childRestart.resumable.length === 0, "restart blocks claims without a complete immutable ingress manifest");

			const result = store.reconcileOnBoot();
			check(
				result.requeued.join(",") === "r1",
				`requeued ids, got ${result.requeued.join(",")}`,
			);
			check(
				result.failed.join(",") === "r2",
				`failed ids, got ${result.failed.join(",")}`,
			);
			check(
				store.getTask("r1")!.status === "queued" &&
					store.getTask("r1")!.retryCount === 1,
				"requeued task went back to queued with retry incremented",
			);
			check(store.getTask("r2")!.status === "failed", "exhausted task failed");
			check(
				store.getTask("r3")!.status === "queued" &&
					store.getTask("r4")!.status === "completed",
				"queued/completed untouched",
			);

			// Active M5 edges, rather than the generic task loop, own recovery of
			// both linked rows. A blocked edge is no longer active ownership and
			// therefore retains ordinary retry behavior.
			const authority = new LedgerStore(tmp.path + ".authority");
			const activeStatuses = ["preparing", "ready", "claimed", "resumable"] as const;
			const activeTaskIds: string[] = [];
			for (const [index, status] of activeStatuses.entries()) {
				const parentTaskId = `authority-${status}-parent`;
				const childTaskId = `authority-${status}-child`;
				const edgeId = `authority-${status}-edge`;
				activeTaskIds.push(parentTaskId, childTaskId);
				authority.insertTask({ id: parentTaskId, goal: "g", maxRetries: 2 });
				authority.insertTask({ id: childTaskId, goal: "g", maxRetries: 2 });
				authority.setTaskStatus(parentTaskId, "executing");
				authority.setTaskStatus(childTaskId, "executing");
				authority.db.prepare(
					`INSERT INTO task_edges
					 (edge_id, parent_task_id, child_task_id, ordinal, relationship, status, handoff_artifact_id)
					 VALUES (?, ?, ?, ?, 'continuation', ?, ?)`,
				).run(edgeId, parentTaskId, childTaskId, index + 1, status === "preparing" ? "ready" : status, "sha256:" + "0".repeat(64));
				if (status === "preparing")
					authority.db.prepare("INSERT INTO task_edge_status_overrides (edge_id, status) VALUES (?, ?)").run(edgeId, status);
			}
			authority.insertTask({ id: "authority-blocked-parent", goal: "g", maxRetries: 2 });
			authority.insertTask({ id: "authority-blocked-child", goal: "g", maxRetries: 2 });
			authority.setTaskStatus("authority-blocked-parent", "executing");
			authority.setTaskStatus("authority-blocked-child", "executing");
			authority.db.prepare(
				`INSERT INTO task_edges
				 (edge_id, parent_task_id, child_task_id, ordinal, relationship, status, handoff_artifact_id)
				 VALUES (?, ?, ?, ?, 'continuation', 'blocked', ?)`,
			).run("authority-blocked-edge", "authority-blocked-parent", "authority-blocked-child", 5, "sha256:" + "0".repeat(64));
			authority.insertTask({ id: "authority-standalone", goal: "g", maxRetries: 2 });
			authority.setTaskStatus("authority-standalone", "executing");
			const authorityResult = authority.reconcileOnBoot();
			check(
				activeTaskIds.every((id) => !authorityResult.requeued.includes(id) && !authorityResult.failed.includes(id) && authority.getTask(id)?.status === "executing" && authority.getTask(id)?.retryCount === 0),
				"preparing/ready/claimed/resumable edges retain authority over parent and child restart",
			);
			check(
				authorityResult.requeued.includes("authority-blocked-parent") &&
					authorityResult.requeued.includes("authority-blocked-child") &&
					authorityResult.requeued.includes("authority-standalone") &&
					authorityResult.failed.length === 0,
				"blocked-edge and standalone tasks retain generic retry behavior",
			);
			check(
				authority.getTask("authority-blocked-parent")?.retryCount === 1 &&
					authority.getTask("authority-standalone")?.status === "queued",
				"generic retry increments and requeues unowned task rows",
			);
			authority.close();

			// Idempotent: a second boot finds nothing in flight.
			const second = store.reconcileOnBoot();
			check(
				second.requeued.length === 0 && second.failed.length === 0,
				"reconcile is idempotent",
			);
			store.close();
		}
	} finally {
		rmSync(tmp.dir, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		return Promise.reject(
			new Error("test-ledger failed:\n  ✗ " + errors.join("\n  ✗ ")),
		);
	}
	console.log(
		"✓ ledger: migrations, CRUD round-trips, constraints, boot reconciliation",
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
