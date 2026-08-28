/**
 * Hermetic tests for the M1.4 daemon assembly: spec parsing/validation,
 * deterministic system prompt (R5), pipeline success + failure paths with a
 * fake session handle (R6), and boot reconciliation wiring (R4). Zero LLM,
 * zero network; verification commands are fast real bash.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	SessionHandle,
	SessionHost,
	SessionHostEvent,
} from "../src/sessions/host.ts";
import { startDaemon } from "../src/daemon/start.ts";
import {
	buildWorkerSystemPrompt,
	computeCor,
	deriveTaskId,
	estimateGroundingTokens,
	parseTaskSpec,
	runTask,
	SpecValidationError,
	totalInputTokens,
} from "../src/daemon/task-runner.ts";
import type { ImmutableArtifactReference } from "../src/contracts/context-lifecycle.ts";
import type { SequentialEdgeConfig } from "../src/ledger/store.ts";
import { LedgerStore } from "../src/ledger/store.ts";

const GOOD_SPEC = `## Goal
Create a greeting file.

## Requirements
- R1: hello.txt contains exactly "hi"

## Verification
- test -f hello.txt
`;

/** Deterministic SessionStats-shaped fixture shared by the daemon fakes.
 *  Numbers chosen so the COR ratio is a clean known value: grounding is
 *  computed by the runner from prompt+spec bytes; total input here is
 *  1000 + 200 + 300 = 1500. */
const FAKE_SESSION_STATS = {
	sessionFile: undefined,
	sessionId: "fake-session",
	userMessages: 1,
	assistantMessages: 1,
	toolCalls: 2,
	toolResults: 2,
	totalMessages: 4,
	tokens: {
		input: 1000,
		output: 250,
		cacheRead: 200,
		cacheWrite: 300,
		total: 1750,
	},
	cost: 0.0123,
} as const;

/** Scriptable fake session host — the hermetic stand-in for SessionHost. */
class FakeHandle implements SessionHandle {
	readonly role = "worker";
	readonly model = { provider: "fake", modelId: "fake/m" };
	turns = 0;
	constructor(
		private readonly behavior: "yield" | "settle" | "error",
		public files: Array<{ path: string; content: string }> = [],
		private readonly statsThrows = false,
	) {}
	get result() {
		return this.behavior === "yield"
			? {
					files_changed: this.files.map((f) => f.path),
					summary: "done",
					commit_ids: ["c1"],
					deviations: [],
				}
			: undefined;
	}
	subscribe(listener: (event: SessionHostEvent) => void): () => void {
		listener({ type: "turnStart" });
		if (this.behavior !== "error") {
			listener({ type: "toolStart", toolName: "bash", toolCallId: "t1" });
			listener({
				type: "toolEnd",
				toolName: "bash",
				toolCallId: "t1",
				isError: false,
			});
			listener({ type: "settled" });
		}
		if (this.behavior === "yield") {
			listener({ type: "yielded", payload: this.result! });
		}
		return () => undefined;
	}
	prompt(): Promise<void> {
		return Promise.resolve().then(() => {
			this.turns += 1;
			for (const f of this.files) {
				writeFileSync(f.path, f.content, "utf-8");
			}
			if (this.behavior === "error") {
				throw new Error("boom");
			}
		});
	}
	async abort(): Promise<void> {}
	stats() {
		if (this.statsThrows)
			return Promise.reject(new Error("stats unavailable on the fake handle"));
		return Promise.resolve(structuredClone(FAKE_SESSION_STATS));
	}
	setModel(): Promise<void> {
		this.turns += 0; // no-op; recorded by prewalk-specific fakes
		return Promise.resolve();
	}
	close(): void {}
}

function fakeHost(
	behavior: "yield" | "settle" | "error",
	files: Array<{ path: string; content: string }> = [],
	statsThrows = false,
): SessionHost {
	return {
		spawn: () => Promise.resolve(new FakeHandle(behavior, files, statsThrows)),
	};
}

function recoveryReference(index: number, kind: ImmutableArtifactReference["kind"]): ImmutableArtifactReference {
	return {
		version: 1,
		id: `sha256:${index.toString(16).padStart(64, "0")}`,
		namespace: "daemon-test",
		kind,
		mediaType: "application/json",
		sizeBytes: 1,
		sensitivity: "public",
		sourceRevision: "source-1",
	};
}

function recoveryConfig(edgeId: string, offset = 1): SequentialEdgeConfig {
	return {
		edgeId,
		handoffReference: recoveryReference(offset, "handoff"),
		checkpointReference: recoveryReference(offset + 1, "checkpoint"),
		childSpecReference: recoveryReference(offset + 2, "context"),
		planReference: recoveryReference(offset + 3, "plan"),
		ingressConfigReference: recoveryReference(offset + 4, "context"),
		parentReceiptReference: recoveryReference(offset + 5, "receipt"),
		modelIdentity: "fake/model",
		sourceRevision: "source-1",
		capabilityIdentity: "fake-provider",
		capabilityVersion: "v1",
	};
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const dir = mkdtempSync(join(tmpdir(), "core-v2-daemon-"));
	try {
		// ─── Spec parsing + validation (R3) ──────────────────────────────
		{
			const parsed = parseTaskSpec(GOOD_SPEC);
			check(parsed.goal.includes("greeting file"), "goal parsed");
			check(
				parsed.requirements.length === 1 &&
					parsed.verificationCommands.length === 1,
				"sections parsed",
			);

			let caught: SpecValidationError | undefined;
			try {
				parseTaskSpec("## Goal\ng\n");
			} catch (err) {
				caught = err instanceof SpecValidationError ? err : undefined;
			}
			check(
				caught?.missing === "requirements",
				"missing requirements rejected typed",
			);

			caught = undefined;
			try {
				parseTaskSpec("## Goal\ng\n\n## Requirements\n- R1: x\n");
			} catch (err) {
				caught = err instanceof SpecValidationError ? err : undefined;
			}
			check(
				caught?.missing === "verification",
				"missing verification rejected typed",
			);
		}

		// ─── Deterministic prompt + id (R5) ──────────────────────────────
		{
			check(
				buildWorkerSystemPrompt(GOOD_SPEC) ===
					buildWorkerSystemPrompt(GOOD_SPEC),
				"system prompt is byte-stable for identical inputs",
			);
			check(
				!/[0-9a-f]{8}-/.test(buildWorkerSystemPrompt(GOOD_SPEC)),
				"prompt carries no uuid-like ids",
			);
			check(
				deriveTaskId(GOOD_SPEC, "/w") === deriveTaskId(GOOD_SPEC, "/w"),
				"task id deterministic per input",
			);
			check(
				deriveTaskId(GOOD_SPEC, "/w") !== deriveTaskId(GOOD_SPEC, "/other"),
				"task id varies by cwd",
			);
		}

		// ─── Success path (R6 ship) ──────────────────────────────────────
		{
			const workDir = join(dir, "success");
			mkdirSync(workDir, { recursive: true });
			const artifactsDir = join(dir, "artifacts-success");
			const result = await runTask({
				specMarkdown: GOOD_SPEC.replace("hello.txt", "hello.txt"),
				cwd: workDir,
				artifactsDir,
				dbPath: join(dir, "success.db"),
				model: "openrouter/stealth/ox-alpha",
				host: fakeHost("yield", [
					{ path: join(workDir, "hello.txt"), content: "hi" },
				]),
			});
			check(
				result.receipt.verdict === "ship",
				"ship verdict on yield + passing verify",
			);
			check(result.receipt.bundleHit === null, "bundleHit null in M1");
			// NFR-3: usage flows from the fake's deterministic SessionStats.
			const expectedGrounding = estimateGroundingTokens(
				buildWorkerSystemPrompt(GOOD_SPEC),
				GOOD_SPEC,
			);
			const expectedCor = computeCor(
				expectedGrounding,
				totalInputTokens({ input: 1000, cacheRead: 200, cacheWrite: 300 }),
			);
			check(
				result.receipt.costUsd === 0.0123,
				`ship receipt carries real cost (got ${result.receipt.costUsd})`,
			);
			check(
				result.receipt.inputTokens === 1000 &&
					result.receipt.outputTokens === 250 &&
					result.receipt.cacheReadTokens === 200,
				"ship receipt carries the fake's token counts",
			);
			check(
				result.receipt.cor > 0 &&
					Math.abs(result.receipt.cor - expectedCor) < 1e-12,
				`cor equals grounding / total input for known fixture sizes (got ${result.receipt.cor}, want ${expectedCor})`,
			);
			check(result.verificationPassed === true, "verification passed");
			check(
				result.receipt.commitIds.length === 0,
				"single-worker receipt does not treat model VCS claims as engine evidence",
			);
			check(existsSync(join(workDir, "hello.txt")), "worker file written");

			const store = new LedgerStore(join(dir, "success.db"));
			const task = store.getTask(result.taskId);
			check(task?.status === "completed", "task row completed");
			check(
				task?.planMode !== null && task?.planMode !== undefined,
				"plan_mode recorded",
			);
			const session = store.getMicroSession(`${result.taskId}-worker`);
			check(session?.status === "yielded", "session row yielded");
			check(
				session?.yieldPayload?.includes("hello.txt") === true,
				"yield payload persisted",
			);
			store.close();
		}

		// ─── Settle-without-yield failure path (R6 failed) ───────────────
		{
			const dbPath = join(dir, "settle.db");
			const result = await runTask({
				specMarkdown: GOOD_SPEC,
				cwd: (() => {
					const d = join(dir, "settle");
					mkdirSync(d, { recursive: true });
					return d;
				})(),
				artifactsDir: join(dir, "artifacts-settle"),
				dbPath,
				model: "openrouter/stealth/ox-alpha",
				host: fakeHost("settle"),
			});
			check(
				result.receipt.verdict === "failed",
				"failed verdict on settle without yield",
			);
			const artifactPath = join(
				dir,
				"artifacts-settle",
				`${result.taskId}.failure.json`,
			);
			check(existsSync(artifactPath), "failure artifact written");
			const artifact = JSON.parse(readFileSync(artifactPath, "utf-8")) as {
				cause?: string;
			};
			check((artifact.cause ?? "").length > 0, "artifact names the cause");
			const store = new LedgerStore(dbPath);
			check(
				store.getTask(result.taskId)?.status === "failed",
				"task row failed",
			);
			check(
				store.getMicroSession(`${result.taskId}-worker`)?.status === "crashed",
				"session crashed",
			);
			store.close();
		}

		// ─── Verification-failure path (R6 failed) ───────────────────────
		{
			const vFailDir = join(dir, "verifyfail");
			mkdirSync(vFailDir, { recursive: true });
			const result = await runTask({
				specMarkdown: GOOD_SPEC.replace("test -f hello.txt", "exit 3"),
				cwd: vFailDir,
				artifactsDir: join(dir, "artifacts-vfail"),
				dbPath: join(dir, "verifyfail.db"),
				model: "openrouter/stealth/ox-alpha",
				host: fakeHost("yield", [
					{ path: join(dir, "verifyfail", "hello.txt"), content: "hi" },
				]),
			});
			check(
				result.receipt.verdict === "failed",
				"failed verdict on failing verify",
			);
			check(
				result.receipt.costUsd === 0.0123 &&
					result.receipt.inputTokens === 1000,
				"verification-failure receipt still carries measured usage",
			);
			check(result.verificationPassed === false, "verificationPassed false");
			check(
				result.yieldedResult !== undefined,
				"yield still captured on verify failure",
			);
		}

		// ─── Re-run collision (review C1/P0): same spec+cwd twice ────────
		{
			const rerunDir = join(dir, "rerun");
			mkdirSync(rerunDir, { recursive: true });
			const dbPath = join(dir, "rerun.db");
			const first = await runTask({
				specMarkdown: GOOD_SPEC,
				cwd: rerunDir,
				artifactsDir: join(dir, "artifacts-rerun"),
				dbPath,
				model: "openrouter/stealth/ox-alpha",
				host: fakeHost("yield", [
					{ path: join(rerunDir, "hello.txt"), content: "hi" },
				]),
			});
			const second = await runTask({
				specMarkdown: GOOD_SPEC,
				cwd: rerunDir,
				artifactsDir: join(dir, "artifacts-rerun"),
				dbPath,
				model: "openrouter/stealth/ox-alpha",
				host: fakeHost("yield", [
					{ path: join(rerunDir, "hello.txt"), content: "hi" },
				]),
			});
			check(
				first.receipt.verdict === "ship" && second.receipt.verdict === "ship",
				"re-running the same spec must not collide on the PK",
			);
			check(
				first.taskId !== second.taskId,
				"attempts get distinct ids (family + discriminator)",
			);
		}

		// ─── Boot reconciliation wiring (R4) ─────────────────────────────
		{
			const dbPath = join(dir, "reconcile.db");
			const seed = new LedgerStore(dbPath);
			seed.insertTask({ id: "stale-1", goal: "g" });
			seed.setTaskStatus("stale-1", "executing");
			seed.insertTask({ id: "stale-2", goal: "g" });
			seed.setTaskStatus("stale-2", "verifying");
			seed.incrementRetry("stale-2");
			seed.incrementRetry("stale-2");
			seed.insertTask({ id: "done-1", goal: "g" });
			seed.setTaskStatus("done-1", "completed");
			seed.close();

			const daemon = await startDaemon(dbPath);
			check(
				daemon.reconciled.requeued.includes("stale-1"),
				"stale in-flight requeued",
			);
			check(
				daemon.reconciled.failed.includes("stale-2"),
				"exhausted retries failed",
			);
			check(
				daemon.store.getTask("stale-1")?.status === "queued",
				"requeued row is queued",
			);
			check(
				daemon.store.getTask("stale-2")?.status === "failed",
				"exhausted row failed",
			);
			check(
				daemon.store.getTask("done-1")?.status === "completed",
				"terminal rows untouched",
			);
			daemon.store.close();
		}

		// ─── M5 edge-owned boot recovery (close/reopen SQLite) ─────────────
		{
			const seedEdge = (dbPath: string, edgeId: string, state: "preparing" | "ready" | "claimed" | "resumable"): void => {
				const seed = new LedgerStore(dbPath);
				seed.insertTask({ id: `${edgeId}-parent`, goal: "parent" });
				const config = recoveryConfig(edgeId, edgeId.length);
				const intent = {
					edgeId,
					parentTaskId: `${edgeId}-parent`,
					childTaskId: `${edgeId}-child`,
					ordinal: 1,
					handoffArtifactId: config.handoffReference.id,
					checkpointArtifactId: config.checkpointReference.id,
					workspaceContinuation: {
						id: `${edgeId}-continuation`,
						taskId: `${edgeId}-child`,
						driver: "fake",
						capabilityIdentity: config.capabilityIdentity,
						capabilityVersion: config.capabilityVersion,
						opaqueToken: "opaque",
						revision: "provider-rev",
					},
					sequentialConfig: config,
				};
				if (state === "preparing") {
					const preparationId = `${edgeId}-preparation`;
					seed.persistChildPreparationOwner({
						preparationId,
						edgeId,
						parentTaskId: `${edgeId}-parent`,
						plannedChildTaskId: `${edgeId}-child`,
						driver: "fake",
						capabilityIdentity: config.capabilityIdentity,
						capabilityVersion: config.capabilityVersion,
					});
					seed.recordChildParentAcceptance(preparationId, "{}", "parent-revision");
					seed.beginChildArtifactPersistence(preparationId);
					seed.insertTask({ id: `${edgeId}-child`, goal: "child" });
					seed.persistPreparingChildIntent({
						...intent,
						preparationId,
						preparationDriver: "fake",
						preparationCapabilityIdentity: config.capabilityIdentity,
						preparationCapabilityVersion: config.capabilityVersion,
					});
				} else {
					seed.insertTask({ id: `${edgeId}-child`, goal: "child" });
					seed.persistReadyChildIntent(intent);
					if (state === "claimed" || state === "resumable")
						check(seed.claimReadyChild(edgeId) !== null, `${state} edge can be claimed`);
					if (state === "resumable") seed.markChildResumable(edgeId);
				}
				// Make both rows look like generic in-flight work. Edge ownership,
				// not task status, must decide boot reconciliation.
				seed.setTaskStatus(`${edgeId}-parent`, "executing");
				seed.setTaskStatus(`${edgeId}-child`, "executing");
				seed.close();
			};

			const bootAndCheck = async (edgeId: string, state: string, expected: "preparing" | "ready" | "resumable"): Promise<void> => {
				const daemon = await startDaemon(join(dir, `${edgeId}.db`));
				const edge = daemon.store.getTaskEdge(edgeId);
				check(edge?.status === expected, `${state} edge remains ${expected}`);
				check(!daemon.reconciled.requeued.includes(`${edgeId}-parent`), `${state} parent not generically requeued`);
				check(!daemon.reconciled.requeued.includes(`${edgeId}-child`), `${state} child not generically requeued`);
				check(daemon.store.listSessions(`${edgeId}-child`).length === 0, `${state} boot creates no session`);
				check(daemon.store.listWorkspaces(`${edgeId}-child`).length === 0, `${state} boot creates no workspace`);
				daemon.store.close();
			};

			const preparingDb = join(dir, "edge-preparing.db");
			seedEdge(preparingDb, "edge-preparing", "preparing");
			await bootAndCheck("edge-preparing", "preparing", "preparing");

			const readyDb = join(dir, "edge-ready.db");
			seedEdge(readyDb, "edge-ready", "ready");
			await bootAndCheck("edge-ready", "ready", "ready");

			const claimedDb = join(dir, "edge-claimed.db");
			seedEdge(claimedDb, "edge-claimed", "claimed");
			const claimedDaemon = await startDaemon(claimedDb);
			check(claimedDaemon.childReconciled.resumable.includes("edge-claimed"), "complete claimed edge becomes resumable");
			check(claimedDaemon.store.getTaskEdge("edge-claimed")?.status === "resumable", "claimed edge is durably resumable");
			check(!claimedDaemon.reconciled.requeued.includes("edge-claimed-parent") && !claimedDaemon.reconciled.requeued.includes("edge-claimed-child"), "claimed linked tasks bypass generic requeue");
			claimedDaemon.store.close();

			const resumableDb = join(dir, "edge-resumable.db");
			seedEdge(resumableDb, "edge-resumable", "resumable");
			await bootAndCheck("edge-resumable", "resumable", "resumable");

			const blockedDb = join(dir, "edge-blocked.db");
			seedEdge(blockedDb, "edge-blocked", "claimed");
			const corrupt = new LedgerStore(blockedDb);
			corrupt.db.prepare("DELETE FROM sequential_edge_configs WHERE edge_id = ?").run("edge-blocked");
			corrupt.close();
			const blockedDaemon = await startDaemon(blockedDb);
			check(
				blockedDaemon.childReconciled.blocked.length === 1 &&
					blockedDaemon.childReconciled.blocked[0] === "edge-blocked",
				"incomplete claimed ingress has one typed blocked classification",
			);
			check(blockedDaemon.store.getTaskEdge("edge-blocked")?.status === "blocked", "blocked edge stays authoritative");
			check(!blockedDaemon.reconciled.requeued.includes("edge-blocked-parent") && !blockedDaemon.reconciled.requeued.includes("edge-blocked-child"), "blocked linked tasks bypass generic requeue");
			check(blockedDaemon.store.getTask("edge-blocked-parent")?.status === "failed" && blockedDaemon.store.getTask("edge-blocked-child")?.status === "failed", "blocked edge fails both linked task rows");
			blockedDaemon.store.close();
		}

		// ─── Spawn-failure path (typed host error → failed receipt) ──────
		{
			mkdirSync(join(dir, "spawnfail"), { recursive: true });
			const badHost: SessionHost = {
				spawn: () => Promise.reject(new Error("no auth")),
			};
			const result = await runTask({
				specMarkdown: GOOD_SPEC,
				cwd: join(dir, "spawnfail"),
				artifactsDir: join(dir, "artifacts-spawnfail"),
				dbPath: join(dir, "spawnfail.db"),
				model: "openrouter/stealth/ox-alpha",
				host: badHost,
			});
			check(
				result.receipt.verdict === "failed",
				"failed verdict on spawn failure",
			);
			check(
				result.receipt.costUsd === 0 &&
					result.receipt.inputTokens === 0 &&
					result.receipt.outputTokens === 0 &&
					result.receipt.cacheReadTokens === 0 &&
					result.receipt.cor === 0,
				"spawn-failure receipt carries all-zero usage (no session ever existed)",
			);
		}

		// ─── Throwing stats() → zeroed usage, run still completes (NFR-3) ──
		{
			const workDir = join(dir, "statsthrow");
			mkdirSync(workDir, { recursive: true });
			const result = await runTask({
				specMarkdown: GOOD_SPEC.replace("test -f hello.txt", "exit 3"), // fail fast; only the accounting matters here
				cwd: workDir,
				artifactsDir: join(dir, "artifacts-statsthrow"),
				dbPath: join(dir, "statsthrow.db"),
				model: "openrouter/stealth/ox-alpha",
				host: fakeHost(
					"yield",
					[{ path: join(workDir, "hello.txt"), content: "hi" }],
					true,
				),
			});
			check(
				result.receipt.verdict === "failed" ||
					result.receipt.verdict === "ship",
				"throwing stats() does not throw out of runTask — valid receipt returned",
			);
			check(
				result.receipt.costUsd === 0 &&
					result.receipt.inputTokens === 0 &&
					result.receipt.outputTokens === 0 &&
					result.receipt.cacheReadTokens === 0 &&
					result.receipt.cor === 0,
				"throwing stats() zeroes every usage field on the receipt",
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		throw new Error(`daemon tests failed:\n  ${errors.join("\n  ")}`);
	}
	console.log(
		"✓ daemon: pipeline paths, deterministic prompt, reconciliation, failure artifacts",
	);
}

const invokedAs = process.argv[1];
if (
	invokedAs !== undefined &&
	import.meta.url.endsWith(invokedAs.split("/").pop() ?? "")
) {
	runTests().catch((err: unknown) => {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	});
}
