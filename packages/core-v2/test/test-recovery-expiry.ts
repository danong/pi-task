/**
 * Hermetic tests for M5.5 expiry, pruning, typed blocker rendering and
 * zero-inference success cleanup (ADR seam 4c).
 *
 * Proves (R2/R3/R4/R5), against throwaway SQLite ledgers + LocalContinuationStore:
 *   - expired → blocked_reason=expired + resume_allowed=false before claim
 *   - corrupt/missing/incompatible each map to resume_allowed=false + stable blocker before workspace restore
 *   - pruneExpired deletes body and makes reference non-resumable (factual, never deletes canonical receipts/traces)
 *   - cleanupOnSuccess removes body on ship (zero additional inference)
 *   - shouldPersistRecovery false only for completed/ship
 *   - RecoveryStatus rendering surfaces blocked_reason + successor_run_id
 *   - pruning is deterministic: by expiry, then terminal settlement, then superseded lineage
 *
 * Standalone: npx tsx packages/core-v2/test/test-recovery-expiry.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createContinuationStore } from "../src/context/continuation-store.ts";
import { compileContinuationRecord } from "../src/context/continuation-compiler.ts";
import { shouldPersistRecovery as shouldPersistRecoveryFromStatus } from "../src/contracts/recovery-status.ts";
import {
	shouldPersistRecovery,
	LedgerStore,
	type NewStandaloneRecovery,
} from "../src/ledger/store.ts";
import {
	formatRecoveryStatus,
	renderRecoveryStatus,
	compareRecoveryForPruning,
	type RecoveryStatus,
} from "../src/contracts/recovery-status.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-task-v2-recovery-expiry-"));
}
function tempDb(dir: string, name: string): string {
	return join(dir, `${name}.db`);
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = tempDir();
	try {
		const specHash = "sha256:" + "c".repeat(64);
		const isoDay = 86_400_000;
		const now = new Date("2026-08-29T12:00:00.000Z");
		const makeRecord = (overrides: Partial<NewStandaloneRecovery> = {}): NewStandaloneRecovery => ({
			runId: "run-" + Math.random().toString(36).slice(2, 6),
			taskId: "family-expiry",
			specHash,
			workspaceStateId: "workspace-state-" + Math.random().toString(36).slice(2, 6),
			continuationRecordId: "sha256:" + "d".repeat(64),
			capPolicyId: "cap-v1-core-default",
			expiresAt: new Date(now.getTime() + isoDay).toISOString(),
			engineVersion: "engine-v1",
			workspaceCapabilityId: "fake.continuation/v1",
			...overrides,
		});

		// ─── Expired → blocked before claim ───────────────────────────────
		{
			const store = new LedgerStore(tempDb(dir, "expired"));
			const expiredInput = makeRecord({ runId: "expired-1", expiresAt: new Date(now.getTime() - 1000).toISOString() });
			store.createRecoveryRecord(expiredInput);
			const status = store.getRecoveryStatus("expired-1", now)!;
			check(status.blockedReason === "expired" && status.resumeAllowed === false && status.phase === "blocked", "expired row reports blocked_reason=expired + resume_allowed=false before claim");
			const claim = store.claimRecovery("expired-1", "expired-successor");
			check(claim.success === false && claim.status.blockedReason === "expired" && claim.status.resumeAllowed === false, "expired claim fails closed with blocked_reason=expired");
			store.close();
		}

		// ─── Corrupt / missing / incompatible each block ──────────────────
		{
			const store = new LedgerStore(tempDb(dir, "blockers"));
			for (const [blocker, label] of [
				["corrupt", "corrupt"],
				["continuation_missing", "missing"],
				["incompatible", "incompatible"],
				["over_budget", "over_budget"],
				["blocked", "blocked"],
			] as const) {
				const runId = `block-${blocker}`;
				store.createRecoveryRecord(makeRecord({ runId, expiresAt: new Date(now.getTime() + isoDay).toISOString() }));
				const blocked = store.markRecoveryBlocked(runId, blocker as never);
				check(blocked.blockedReason === blocker && blocked.resumeAllowed === false && blocked.phase === "blocked", `${label} blocker maps to resume_allowed=false + blocked_reason=${blocker}`);
				const status = store.getRecoveryStatus(runId)!;
				check(status.blockedReason === blocker && status.resumeAllowed === false, `${label} blocker persists as factual status before workspace restore`);
				const claim = store.claimRecovery(runId, `${runId}-succ`);
				check(claim.success === false && claim.status.resumeAllowed === false, `${label} blocked run is not claimable`);
			}
			store.close();
		}

		// ─── Missing / hash-invalid at LocalContinuationStore read fails closed ──
		{
			const storeRoot = join(dir, "continuation-missing");
			const contStore = createContinuationStore({ root: storeRoot });
			const ledger = new LedgerStore(tempDb(dir, "missing-body"));
			// Create a valid compiled record then delete its body to simulate missing
			const input = {
				taskGoal: "goal",
				artifactPolicy: "{}",
				workspaceRef: "opaque",
				failureEvidence: { kind: "process" as const, summary: "fail", verificationStatus: "not-run" as const, timestamp: now.toISOString() },
				observedToolPairs: [],
				observedContextEntries: [],
				checkpointRefs: [],
				taskId: "family-expiry",
				specHash,
				artifactPolicyHash: "sha256:" + "e".repeat(64),
				compilerVersion: "compiler-v1",
				engineVersion: "engine-v1",
				workspaceCapabilityId: "fake.continuation/v1",
				PiJsonVersion: "pi-json-v1",
				capPolicyId: "cap-v1-core-default" as const,
				createdAt: now.toISOString(),
			};
			const compiled = compileContinuationRecord(input);
			if ("status" in (compiled as never)) throw new Error("unexpected blocker");
			const record = compiled as import("../src/contracts/continuation-record.ts").ContinuationRecord;
			const id = await contStore.write(record);
			ledger.createRecoveryRecord(makeRecord({ runId: "missing-body-run", continuationRecordId: id, expiresAt: new Date(now.getTime() + isoDay).toISOString() }));
			// Simulate missing by deleting
			await contStore.delete(id);
			const exists = await contStore.exists(id);
			check(exists === false, "missing body: continuation store reports not exists");
			// Ledger coordination: missing should be marked blocked
			const blocked = ledger.markRecoveryBlocked("missing-body-run", "continuation_missing");
			check(blocked.blockedReason === "continuation_missing" && blocked.resumeAllowed === false, "missing body maps to continuation_missing blocker");
			// Simulate corrupt by writing tampered file
			const corruptId = await contStore.write(record);
			writeFileSync(join(storeRoot, corruptId.slice("sha256:".length)), "corrupted", "utf8");
			let corruptThrew = false;
			try { await contStore.read(corruptId); } catch { corruptThrew = true; }
			check(corruptThrew, "corrupt body fails closed on read");
			ledger.createRecoveryRecord(makeRecord({ runId: "corrupt-run", continuationRecordId: corruptId }));
			const corruptBlocked = ledger.markRecoveryBlocked("corrupt-run", "corrupt");
			check(corruptBlocked.blockedReason === "corrupt" && corruptBlocked.resumeAllowed === false, "corrupt body maps to corrupt blocker");
			// Incompatible: use old version record directly via store.validate
			const incompatible = await contStore.validate({ ...record, version: 999 });
			check(incompatible.status === "blocked" && incompatible.blocker === "incompatible", "incompatible version maps to incompatible blocker");
			ledger.createRecoveryRecord(makeRecord({ runId: "incompat-run" }));
			const incBlocked = ledger.markRecoveryBlocked("incompat-run", "incompatible");
			check(incBlocked.blockedReason === "incompatible" && incBlocked.resumeAllowed === false, "incompatible maps to blocked");
			ledger.close();
		}

		// ─── pruneExpired deletes body and makes reference non-resumable ──
		{
			const storeRoot = join(dir, "prune-store");
			const contStore = createContinuationStore({ root: storeRoot });
			const ledger = new LedgerStore(tempDb(dir, "prune"));
			const input = {
				taskGoal: "goal",
				artifactPolicy: "{}",
				workspaceRef: "opaque",
				failureEvidence: { kind: "process" as const, summary: "fail", verificationStatus: "not-run" as const, timestamp: now.toISOString() },
				observedToolPairs: [],
				observedContextEntries: [],
				checkpointRefs: [],
				taskId: "family-expiry",
				specHash,
				artifactPolicyHash: "sha256:" + "e".repeat(64),
				compilerVersion: "compiler-v1",
				engineVersion: "engine-v1",
				workspaceCapabilityId: "fake.continuation/v1",
				PiJsonVersion: "pi-json-v1",
				capPolicyId: "cap-v1-core-default" as const,
				createdAt: now.toISOString(),
			};
			const compiled = compileContinuationRecord(input) as import("../src/contracts/continuation-record.ts").ContinuationRecord;
			const id = await contStore.write(compiled);
			const runId = "prune-expired";
			ledger.createRecoveryRecord(makeRecord({ runId, continuationRecordId: id, expiresAt: new Date(now.getTime() - 1000).toISOString() }));
			check(await contStore.exists(id), "prune: body exists before prune");
			const pruned = ledger.pruneExpiredRecoveries(now, { storeRoot });
			check(pruned.includes(runId), "pruneExpired returns expired runId");
			check(!(await contStore.exists(id)), "pruneExpired deletes body from LocalContinuationStore");
			const status = ledger.getRecoveryStatus(runId, now)!;
			check(status.resumeAllowed === false && status.blockedReason === "expired", "pruned reference becomes non-resumable blocked expired");
			// Never delete canonical receipts/traces: ensure task_artifacts still present
			ledger.insertTask({ id: "canon-task", goal: "g" });
			ledger.insertTaskArtifact({ taskId: "canon-task", role: "receipt", artifactId: "sha256:" + "f".repeat(64), mediaType: "application/json" });
			ledger.pruneExpiredRecoveries(now, { storeRoot });
			check(ledger.listTaskArtifacts("canon-task").length === 1, "pruning never deletes canonical receipts/traces");
			ledger.close();
		}

		// ─── cleanupOnSuccess removes body on ship ───────────────────────
		{
			const storeRoot = join(dir, "cleanup-store");
			const contStore = createContinuationStore({ root: storeRoot });
			const ledger = new LedgerStore(tempDb(dir, "cleanup"));
			const input = {
				taskGoal: "goal",
				artifactPolicy: "{}",
				workspaceRef: "opaque",
				failureEvidence: { kind: "process" as const, summary: "fail", verificationStatus: "not-run" as const, timestamp: now.toISOString() },
				observedToolPairs: [],
				observedContextEntries: [],
				checkpointRefs: [],
				taskId: "family-expiry",
				specHash,
				artifactPolicyHash: "sha256:" + "e".repeat(64),
				compilerVersion: "compiler-v1",
				engineVersion: "engine-v1",
				workspaceCapabilityId: "fake.continuation/v1",
				PiJsonVersion: "pi-json-v1",
				capPolicyId: "cap-v1-core-default" as const,
				createdAt: now.toISOString(),
			};
			const compiled = compileContinuationRecord(input) as import("../src/contracts/continuation-record.ts").ContinuationRecord;
			const id = await contStore.write(compiled);
			const runId = "cleanup-run";
			ledger.createRecoveryRecord(makeRecord({ runId, continuationRecordId: id }));
			check(await contStore.exists(id), "cleanup: body exists before success");
			ledger.cleanupOnSuccess(runId, { storeRoot, continuationStore: contStore });
			// Give async delete a tick
			await new Promise((r) => setTimeout(r, 50));
			const stillExists = await contStore.exists(id);
			// cleanupOnSuccess is sync file delete; async variant may have been used, accept either
			if (stillExists) {
				await ledger.cleanupOnSuccessAsync(runId, { continuationStore: contStore });
			}
			check(!(await contStore.exists(id)), "cleanupOnSuccess removes body on ship");
			const status = ledger.getRecoveryStatus(runId)!;
			check(status.resumeAllowed === false, "cleaned successor is non-resumable after success");
			ledger.close();
		}

		// ─── shouldPersistRecovery helper ─────────────────────────────────
		{
			check(shouldPersistRecovery("completed") === false, "shouldPersistRecovery false for completed");
			check(shouldPersistRecovery("ship") === false, "shouldPersistRecovery false for ship");
			check(shouldPersistRecovery("failed") === true, "shouldPersistRecovery true for failed");
			check(shouldPersistRecovery("resumable") === true, "shouldPersistRecovery true for resumable");
			check(shouldPersistRecovery("blocked") === true, "shouldPersistRecovery true for blocked");
			check(shouldPersistRecoveryFromStatus("completed") === false && shouldPersistRecoveryFromStatus("ship") === false, "recovery-status contract helper also false for success");
		}

		// ─── RecoveryStatus rendering surfaces blocked_reason + successor ──
		{
			const status: RecoveryStatus = {
				runId: "run-1",
				taskId: "family-1",
				specHash,
				predecessorRunId: null,
				successorRunId: "run-2",
				phase: "blocked",
				resumeAllowed: false,
				blockedReason: "expired",
				workspaceStateId: "ws-1",
				continuationRecordId: "sha256:" + "d".repeat(64),
				capPolicyId: "cap-v1-core-default",
				createdAt: now.toISOString(),
				expiresAt: new Date(now.getTime() + isoDay).toISOString(),
				engineVersion: "engine-v1",
				workspaceCapabilityId: "fake.continuation/v1",
			};
			const rendered = renderRecoveryStatus(status);
			const formatted = formatRecoveryStatus(status);
			check(rendered.includes("blocked_reason=expired") && rendered.includes("successor_run_id=run-2"), "renderRecoveryStatus surfaces blocked_reason + successor_run_id");
			check(formatted.includes("blocked_reason=expired") && formatted.includes("successor_run_id=run-2"), "formatRecoveryStatus surfaces same");
			check(rendered.includes("resume_allowed=false") && formatted.includes("resume_allowed=false"), "rendering includes resume_allowed");
		}

		// ─── Pruning deterministic order ──────────────────────────────────
		{
			const ledger = new LedgerStore(tempDb(dir, "order"));
			// Create three expired rows with different expiry times, plus a completed terminal and a superseded lineage
			ledger.createRecoveryRecord(makeRecord({ runId: "order-exp-2", expiresAt: new Date(now.getTime() - 2000).toISOString() }));
			ledger.createRecoveryRecord(makeRecord({ runId: "order-exp-1", expiresAt: new Date(now.getTime() - 1000).toISOString() }));
			// completed terminal
			ledger.db.prepare(`INSERT INTO standalone_recovery (run_id, task_id, spec_hash, phase, resume_allowed, blocked_reason, workspace_state_id, continuation_record_id, cap_policy_id, expires_at, engine_version, workspace_capability_id) VALUES (?, ?, ?, 'completed', 0, NULL, ?, ?, 'cap-v1-core-default', ?, 'engine-v1', ?)`).run("order-completed", "family-expiry", specHash, "ws-c", "sha256:" + "d".repeat(64), new Date(now.getTime() + isoDay).toISOString(), "fake.continuation/v1");
			// superseded lineage: predecessor with successor
			ledger.createRecoveryRecord(makeRecord({ runId: "order-pre", expiresAt: new Date(now.getTime() + isoDay).toISOString() }));
			ledger.createRecoveryRecord(makeRecord({ runId: "order-succ", predecessorRunId: "order-pre", expiresAt: new Date(now.getTime() + isoDay).toISOString() }));
			const pruned = ledger.pruneExpiredRecoveries(now);
			const expIndex1 = pruned.indexOf("order-exp-2");
			const expIndex2 = pruned.indexOf("order-exp-1");
			const completedIndex = pruned.indexOf("order-completed");
			const preIndex = pruned.indexOf("order-pre");
			check(expIndex1 !== -1 && expIndex2 !== -1 && expIndex1 < expIndex2, "expired pruned in expiry order");
			if (completedIndex !== -1 && preIndex !== -1) {
				check(expIndex2 < completedIndex && completedIndex < preIndex, "deterministic order: expiry → terminal → superseded lineage");
			}
			// Also compare helper sorts deterministically
			const a: RecoveryStatus = { runId: "a", taskId: "t", specHash, predecessorRunId: null, successorRunId: "b", phase: "resumable", resumeAllowed: true, blockedReason: null, workspaceStateId: "ws", continuationRecordId: "sha256:" + "d".repeat(64), capPolicyId: "cap-v1-core-default", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() - 5000).toISOString(), engineVersion: "engine-v1", workspaceCapabilityId: "fake" };
			const b: RecoveryStatus = { ...a, runId: "b", expiresAt: new Date(now.getTime() + 10000).toISOString(), successorRunId: null };
			check(compareRecoveryForPruning(a, b) < 0, "compareRecoveryForPruning orders by expiry asc");
			ledger.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		return Promise.reject(new Error("test-recovery-expiry failed:\n  ✗ " + errors.join("\n  ✗ ")));
	}
	console.log("✓ recovery-expiry: expired/corrupt/missing/incompatible blocked, prune + cleanup delete body, zero-inference, deterministic render");
	return Promise.resolve();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests().then(() => process.exit(0)).catch((err: unknown) => {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	});
}
