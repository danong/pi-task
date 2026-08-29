/**
 * Hermetic tests for the M2.d parallel pipeline: two REAL-jj workers with
 * disjoint files combine cleanly; a failing worker fails the aggregate and
 * demotes children; residual conflicts ESCALATE end-to-end (verdict,
 * artifact, ledger); a throwing combine produces a recovery artifact;
 * re-runs never collide; feature-branch mode bookmarks instead of
 * combining. Real jj repos throughout; fakes only for session handles and
 * adversarial drivers. No LLM. (The e2e-parallel manual gate covers what
 * fakes cannot: real model workers and live op-log behavior.)
 */

import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	SessionHandle,
	SessionHost,
	SessionHostConfig,
	SessionHostEvent,
} from "../src/sessions/host.ts";
import {
	buildWorkerSystemPrompt,
	computeCor,
	estimateGroundingTokens,
	totalInputTokens,
} from "../src/daemon/task-runner.ts";
import { runParallelTask } from "../src/daemon/parallel.ts";

/** Shape of the recovery blob embedded in parallel failure artifacts. */
type RecoveryInfo = {
	baseChangeId?: string;
};

const SPEC_A = `## Goal\nFile A.\n\n## Requirements\n- R1: a.txt says A\n\n## Verification\n- test -f a.txt\n`;
const SPEC_B = `## Goal\nFile B.\n\n## Requirements\n- R1: b.txt says B\n\n## Verification\n- test -f b.txt\n`;

class FakeHandle implements SessionHandle {
	readonly role: string;
	readonly model = { provider: "fake", modelId: "fake/m" };
	result:
		| {
				files_changed: string[];
				summary: string;
				commit_ids: string[];
				deviations: string[];
		  }
		| undefined;
	constructor(
		config: SessionHostConfig,
		private readonly file: string,
		private readonly workerIndex = 0,
	) {
		this.role = config.role;
	}
	subscribe(listener: (event: SessionHostEvent) => void): () => void {
		listener({ type: "turnStart" });
		listener({ type: "settled" });
		return () => undefined;
	}
	prompt(): Promise<void> {
		return Promise.resolve().then(() => {
			writeFileSync(
				this.file,
				`${this.file.endsWith("a.txt") ? "A" : "B"}-${this.workerIndex}`,
				"utf-8",
			);
			// Workers commit their work (jj snapshots on command): without this,
			// the workspace @ holds nothing for the combine to consume.
			execSync('JJ_EDITOR=true jj commit -m "fake work"', {
				cwd: dirname(this.file),
				stdio: "pipe",
			});
			this.result = {
				files_changed: [this.file.split("/").pop()!],
				summary: "done",
				commit_ids: ["fake"],
				deviations: [],
			};
		});
	}
	async abort(): Promise<void> {}
	/** Deterministic per-worker usage (NFR-3): distinct numbers per worker
	 *  so aggregate summation is provable; total input 500+100+50=650. */
	stats() {
		return Promise.resolve({
			sessionFile: undefined,
			sessionId: `fake-worker-${this.workerIndex}`,
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 1,
			toolResults: 1,
			totalMessages: 4,
			tokens: {
				input: 500 + 100 * this.workerIndex,
				output: 200 + 10 * this.workerIndex,
				cacheRead: 100 + 10 * this.workerIndex,
				cacheWrite: 50,
				total: 0,
			},
			cost: 0.01 * (this.workerIndex + 1),
		});
	}
	setModel(): Promise<void> {
		return Promise.resolve();
	}
	close(): void {}
}

class NoYieldHandle extends FakeHandle {
	override async prompt(): Promise<void> {
		await super.prompt();
		this.result = undefined;
	}
}

function noYieldHost(
	fileName: string,
	promptCalls?: { value: number },
): SessionHost {
	return {
		spawn: (config) => {
			const handle = new NoYieldHandle(config, join(config.cwd, fileName));
			if (promptCalls !== undefined) {
				const prompt = handle.prompt.bind(handle);
				Object.defineProperty(handle, "prompt", {
					value: () => {
						promptCalls.value += 1;
						return prompt();
					},
				});
			}
			return Promise.resolve(handle);
		},
	};
}

function scriptedHost(
	filesByCall: string[],
	calls: { value: number },
): SessionHost {
	return {
		spawn: (config) => {
			const file = filesByCall[calls.value] ?? "a.txt";
			const index = calls.value;
			calls.value += 1;
			return Promise.resolve(
				new FakeHandle(config, join(config.cwd, file), index),
			);
		},
	};
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	let jjAvailable = true;
	try {
		execSync("jj --version", { stdio: "pipe" });
	} catch {
		jjAvailable = false;
	}
	if (!jjAvailable) {
		console.log("SKIPPED (no jj binary)");
		return;
	}

	const dir = mkdtempSync(join(tmpdir(), "core-v2-par-"));
	try {
		// ─── Clean two-worker combine through the REAL jj driver ─────────
		{
			const repo = join(dir, "clean");
			mkdirSync(repo, { recursive: true });
			execSync("jj git init --colocate", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "README.md"), "# fixture\n", "utf-8");
			execSync('JJ_EDITOR=true jj commit -m "init"', {
				cwd: repo,
				stdio: "pipe",
			});

			const { JujutsuWorkspaceDriver } =
				await import("../src/workspaces/jj-driver.ts");
			const driver = new JujutsuWorkspaceDriver({ projectDir: repo });
			const result = await runParallelTask({
				subTasks: [SPEC_A, SPEC_B],
				projectDir: repo,
				artifactsDir: join(dir, "artifacts-clean"),
				dbPath: join(dir, "clean.db"),
				model: "openrouter/stealth/ox-alpha",
				workspaceDriver: driver,
				host: scriptedHost(["a.txt", "b.txt"], { value: 0 }),
			});

			check(
				result.aggregate.verdict === "ship",
				`aggregate ship (got ${result.aggregate.verdict})`,
			);
			check(
				result.perWorker.length === 2 &&
					result.perWorker.every((r) => r.verdict === "ship"),
				"both worker receipts ship",
			);
			// NFR-3: per-worker usage matches each fake; the aggregate sums it
			// and RECOMPUTES cor from summed grounding over summed input.
			const groundings = [SPEC_A, SPEC_B].map((s) =>
				estimateGroundingTokens(buildWorkerSystemPrompt(s), s),
			);
			for (let i = 0; i < 2; i += 1) {
				const r = result.perWorker[i]!;
				check(
					r.costUsd === 0.01 * (i + 1) &&
						r.inputTokens === 500 + 100 * i &&
						r.outputTokens === 200 + 10 * i &&
						r.cacheReadTokens === 100 + 10 * i,
					`worker ${i} receipt carries its own fake usage (got cost ${r.costUsd}, in ${r.inputTokens})`,
				);
			}
			const agg = result.aggregate;
			check(
				Math.abs(agg.costUsd - 0.03) < 1e-9 &&
					agg.inputTokens === 1100 &&
					agg.outputTokens === 410 &&
					agg.cacheReadTokens === 210,
				`aggregate sums per-worker usage (got cost ${agg.costUsd}, in ${agg.inputTokens})`,
			);
			const summedGrounding = groundings[0]! + groundings[1]!;
			const expectedAggCor = computeCor(
				summedGrounding,
				totalInputTokens({ input: 1100, cacheRead: 210, cacheWrite: 100 }),
			);
			check(
				Math.abs(agg.cor - expectedAggCor) < 1e-12 &&
					Math.abs(
						agg.cor - (result.perWorker[0]!.cor + result.perWorker[1]!.cor) / 2,
					) > 0,
				`aggregate cor recomputed from sums, not averaged (got ${agg.cor}, want ${expectedAggCor})`,
			);
			check(
				existsSync(join(repo, "a.txt")) && existsSync(join(repo, "b.txt")),
				"combined tree holds both workers' files",
			);
			check(result.conflicts.length === 0, "no conflicts");
			check(result.mergedCommitId !== undefined, "merged commit id returned");
		}

		// ─── Re-run collision (review M1/P0): same specs, same repo, twice ──
		{
			const repo = join(dir, "rerun");
			mkdirSync(repo, { recursive: true });
			execSync("jj git init --colocate", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "README.md"), "# fixture\n", "utf-8");
			execSync('JJ_EDITOR=true jj commit -m "init"', {
				cwd: repo,
				stdio: "pipe",
			});

			const { JujutsuWorkspaceDriver } =
				await import("../src/workspaces/jj-driver.ts");
			const dbPath = join(dir, "rerun.db");
			const driver = new JujutsuWorkspaceDriver({ projectDir: repo });
			const rerunCalls = { value: 0 };
			const rerunHost = scriptedHost(["a.txt", "b.txt"], rerunCalls);
			const runOnce = () =>
				runParallelTask({
					subTasks: [SPEC_A, SPEC_B],
					projectDir: repo,
					artifactsDir: join(dir, "artifacts-rerun"),
					dbPath,
					model: "openrouter/stealth/ox-alpha",
					workspaceDriver: driver,
					host: rerunHost,
				});
			// Reuse one provider instance across attempts: the provider must
			// refresh its integration base for each run, while the ledger still
			// allocates distinct attempt ids.
			const first = await runOnce();
			const second = await runOnce();
			check(
				first.aggregate.verdict === "ship" &&
					second.aggregate.verdict === "ship",
				"two consecutive parallel runs both ship",
			);
			check(
				first.aggregate.taskId !== second.aggregate.taskId,
				"attempts get distinct aggregate ids",
			);

			// Run 3 reuses the SAME database (warm ledger) — attempt discriminator.
			const third = await runOnce();
			check(
				third.aggregate.verdict === "ship",
				"third run on a warm ledger still ships",
			);
			check(
				third.aggregate.taskId !== second.aggregate.taskId,
				"warm-ledger attempts distinct",
			);
			check(
				third.aggregate.verdict === "ship",
				"third run on a warm ledger still ships",
			);
			check(
				third.aggregate.taskId !== second.aggregate.taskId,
				"warm-ledger attempts distinct",
			);
		}

		// ─── Escalate path end-to-end (review M8): verdict+artifact+ledger ──
		{
			const repo = join(dir, "escalate");
			mkdirSync(repo, { recursive: true });
			execSync("jj git init --colocate", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "README.md"), "# fixture\n", "utf-8");
			execSync('JJ_EDITOR=true jj commit -m "init"', {
				cwd: repo,
				stdio: "pipe",
			});

			const conflictDriver = {
				name: "conflicter",
				integrationMode: "task-base" as const,
				isSupported: () => Promise.resolve(true),
				prepare: () => Promise.resolve(),
				createWorkspace: (taskId: string) =>
					Promise.resolve({
						taskId,
						hostPath: join(dir, `esc-ws-${taskId}`),
						branchName: `v2-task-${taskId}`,
						status: "active" as const,
					}),
				mergeWorkspace: () =>
					Promise.resolve({ success: false, conflicts: ["x.txt"] }),
				cleanupWorkspace: () => Promise.resolve(),
				prepareIntegrationBase: () =>
					Promise.resolve("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
				combine: () =>
					Promise.resolve({
						commitId: "cccccccccccccccccccccccccccccccc",
						conflicts: ["x.txt"],
						filesChanged: 3,
					}),
				materialize: () => Promise.resolve(),
			};
			const result = await runParallelTask({
				subTasks: [SPEC_A],
				projectDir: repo,
				artifactsDir: join(dir, "artifacts-escalate"),
				dbPath: join(dir, "escalate.db"),
				model: "openrouter/stealth/ox-alpha",
				workspaceDriver: conflictDriver,
				host: scriptedHost(["a.txt"], { value: 0 }),
			});
			check(
				result.aggregate.verdict === "escalate",
				`escalate verdict (got ${result.aggregate.verdict})`,
			);
			check(
				result.conflicts.includes("x.txt"),
				"conflicts surfaced on the result",
			);
			const artifact = JSON.parse(
				readFileSync(
					join(
						dir,
						"artifacts-escalate",
						`${result.aggregate.taskId}.failure.json`,
					),
					"utf-8",
				),
			) as { cause?: string; recovery?: RecoveryInfo };
			check(
				(artifact.cause ?? "").includes("x.txt"),
				"escalation artifact names the conflicted file",
			);
			check(
				artifact.recovery?.baseChangeId === "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				"escalation artifact carries recovery data",
			);
			const store = await import("../src/ledger/store.ts");
			const ledger = new store.LedgerStore(join(dir, "escalate.db"));
			check(
				ledger.getTask(result.aggregate.taskId)?.status === "escalated",
				"ledger row escalated",
			);
			ledger.close();
		}

		// ─── M5: single-workspace driver fails TYPED on the parallel lane ──
		{
			const repo = join(dir, "typed");
			mkdirSync(repo, { recursive: true });
			execSync("jj git init --colocate", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "README.md"), "# fixture\n", "utf-8");
			execSync('JJ_EDITOR=true jj commit -m "init"', {
				cwd: repo,
				stdio: "pipe",
			});
			const minimalDriver = {
				name: "minimal",
				isSupported: () => Promise.resolve(true),
				createWorkspace: () => Promise.reject(new Error("unreachable")),
				mergeWorkspace: () => Promise.resolve({ success: true }),
				cleanupWorkspace: () => Promise.resolve(),
			};
			let typedError = false;
			try {
				await runParallelTask({
					subTasks: [SPEC_A],
					projectDir: repo,
					artifactsDir: join(dir, "artifacts-typed"),
					dbPath: join(dir, "typed.db"),
					model: "openrouter/stealth/ox-alpha",
					workspaceDriver: minimalDriver,
					host: scriptedHost(["a.txt"], { value: 0 }),
				});
			} catch (err) {
				typedError =
					err instanceof Error && err.message.includes("task-base integration");
			}
			check(
				typedError,
				"single-workspace driver fails TYPED (missing task-base capabilities)",
			);
		}

		// ─── M3: a throwing combine → recovery artifact + terminal ledger ──
		{
			const repo = join(dir, "throwcombine");
			mkdirSync(repo, { recursive: true });
			execSync("jj git init --colocate", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "README.md"), "# fixture\n", "utf-8");
			execSync('JJ_EDITOR=true jj commit -m "init"', {
				cwd: repo,
				stdio: "pipe",
			});
			const throwingDriver = {
				name: "thrower",
				integrationMode: "task-base" as const,
				isSupported: () => Promise.resolve(true),
				prepare: () => Promise.resolve(),
				createWorkspace: (taskId: string) =>
					Promise.resolve({
						taskId,
						hostPath: join(dir, "throwcombine-ws"),
						branchName: `v2-task-${taskId}`,
						status: "active" as const,
					}),
				mergeWorkspace: () => Promise.resolve({ success: true }),
				cleanupWorkspace: () => Promise.resolve(),
				prepareIntegrationBase: () =>
					Promise.resolve("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
				combine: () => {
					throw new Error("squash exploded");
				},
				materialize: () => Promise.resolve(),
			};
			const result = await runParallelTask({
				subTasks: [SPEC_A],
				projectDir: repo,
				artifactsDir: join(dir, "artifacts-throw"),
				dbPath: join(dir, "throw.db"),
				model: "openrouter/stealth/ox-alpha",
				workspaceDriver: throwingDriver,
				host: scriptedHost(["a.txt"], { value: 0 }),
			});
			check(
				result.aggregate.verdict === "failed",
				"throwing combine → failed receipt (no bare escape)",
			);
			const artifact = JSON.parse(
				readFileSync(
					join(
						dir,
						"artifacts-throw",
						`${result.aggregate.taskId}.failure.json`,
					),
					"utf-8",
				),
			) as {
				cause?: string;
				recovery?: RecoveryInfo & { workspaces?: string[] };
			};
			check(
				(artifact.cause ?? "").includes("merge ladder failed"),
				"artifact names the ladder failure",
			);
			check(
				artifact.recovery?.baseChangeId === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"artifact carries the base change id",
			);
			check(
				Array.isArray(artifact.recovery?.workspaces) &&
					artifact.recovery.workspaces.length === 1,
				"artifact lists preserved workspaces",
			);
			const store = await import("../src/ledger/store.ts");
			const ledger = new store.LedgerStore(join(dir, "throw.db"));
			check(
				ledger.getTask(result.aggregate.taskId)?.status === "failed",
				"ledger terminal after ladder failure",
			);
			ledger.close();
		}

		// ─── Failing worker → failed aggregate (still integrates healthy work)
		{
			const repo = join(dir, "mixed");
			mkdirSync(repo, { recursive: true });
			execSync("jj git init --colocate", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "README.md"), "# fixture\n", "utf-8");
			execSync('JJ_EDITOR=true jj commit -m "init"', {
				cwd: repo,
				stdio: "pipe",
			});

			class SettleHandle extends FakeHandle {
				constructor(
					config: SessionHostConfig,
					file: string,
					private readonly settleOnly: boolean,
				) {
					super(config, file);
					this.settleOnly = settleOnly;
				}
				override prompt(): Promise<void> {
					if (!this.settleOnly) return super.prompt();
					return Promise.resolve();
				}
			}
			let call = 0;
			const mixedHost: SessionHost = {
				spawn: (config) => {
					const file = call++ === 0 ? "a.txt" : "b.txt";
					const settleOnly = call === 1;
					return Promise.resolve(
						new SettleHandle(config, join(config.cwd, file), settleOnly),
					);
				},
			};
			const { JujutsuWorkspaceDriver } =
				await import("../src/workspaces/jj-driver.ts");
			const driver = new JujutsuWorkspaceDriver({ projectDir: repo });
			const result = await runParallelTask({
				subTasks: [SPEC_A, SPEC_B],
				projectDir: repo,
				artifactsDir: join(dir, "artifacts-mixed"),
				dbPath: join(dir, "mixed.db"),
				model: "openrouter/stealth/ox-alpha",
				workspaceDriver: driver,
				host: mixedHost,
			});
			check(
				result.aggregate.verdict === "failed",
				"aggregate failed when a worker fails",
			);
			check(
				result.perWorker.some((r) => r.verdict !== "ship"),
				"the failed worker is named in receipts",
			);
			// M4: no completed children under a failed parent.
			const store = await import("../src/ledger/store.ts");
			const ledger = new store.LedgerStore(join(dir, "mixed.db"));
			const statuses = result.perWorker.map(
				(r) => ledger.getTask(r.taskId)?.status,
			);
			check(
				statuses.every((st) => st === "failed"),
				`failed run demotes children (got ${statuses.join(",")})`,
			);
			ledger.close();
		}

		// ─── M5.5: authoritative standalone work settles without yield ──
		{
			const repo = join(dir, "engine-settlement");
			mkdirSync(repo, { recursive: true });
			execSync("jj git init --colocate", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "README.md"), "# fixture\n", "utf-8");
			execSync('JJ_EDITOR=true jj commit -m "init"', {
				cwd: repo,
				stdio: "pipe",
			});

			const promptCalls = { value: 0 };
			const host = noYieldHost("a.txt", promptCalls);
			const { JujutsuWorkspaceDriver } =
				await import("../src/workspaces/jj-driver.ts");
			const result = await runParallelTask({
				subTasks: [SPEC_A],
				singleTask: true,
				projectDir: repo,
				artifactsDir: join(dir, "artifacts-engine-settlement"),
				dbPath: join(dir, "engine-settlement.db"),
				model: "openrouter/stealth/ox-alpha",
				workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: repo }),
				host,
			});
			check(
				result.aggregate.verdict === "ship" &&
					result.aggregate.settlementSource === "engine_derived",
				`authoritative no-yield standalone work ships as engine-derived (got ${result.aggregate.verdict}/${result.aggregate.settlementSource ?? "missing"})`,
			);
			check(
				result.perWorker[0]?.settlementSource === "engine_derived",
				"engine-derived authority is present on the worker receipt",
			);
			check(
				result.aggregate.turns === 1 &&
					result.aggregate.inputTokens === 500 &&
					promptCalls.value === 1,
				`engine settlement preserves usage and issues one prompt (got ${promptCalls.value})`,
			);
			check(existsSync(join(repo, "a.txt")), "engine-settled work is integrated");
			const { LedgerStore } = await import("../src/ledger/store.ts");
			const ledger = new LedgerStore(join(dir, "engine-settlement.db"));
			const session = ledger.getMicroSession(`${result.perWorker[0]!.taskId}-worker`);
			check(session?.status === "exhausted", "engine-settled session remains non-yielded");
			check(
				ledger.getTask(result.aggregate.taskId)?.status === "completed",
				"aggregate completes only after objective settlement",
			);
			ledger.close();
		}

		// ─── M5.5: objective gates still reject no-yield work ────────────
		{
			const repo = join(dir, "engine-settlement-verify-fail");
			mkdirSync(repo, { recursive: true });
			execSync("jj git init --colocate", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "README.md"), "# fixture\n", "utf-8");
			execSync('JJ_EDITOR=true jj commit -m "init"', {
				cwd: repo,
				stdio: "pipe",
			});
			const failingSpec = `## Goal\nFail verification after work.\n\n## Requirements\n- R1: a.txt says A\n\n## Verification\n- false\n\n## Artifact Policy\n- Change required\n`;
			const { JujutsuWorkspaceDriver } =
				await import("../src/workspaces/jj-driver.ts");
			const result = await runParallelTask({
				subTasks: [failingSpec],
				singleTask: true,
				projectDir: repo,
				artifactsDir: join(dir, "artifacts-engine-settlement-verify-fail"),
				dbPath: join(dir, "engine-settlement-verify-fail.db"),
				model: "openrouter/stealth/ox-alpha",
				workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: repo }),
				host: noYieldHost("a.txt"),
			});
			check(
				result.aggregate.verdict === "failed" &&
					result.aggregate.settlementSource === undefined,
				"failed verification cannot become engine-derived shipment",
			);
			const artifact = JSON.parse(
				readFileSync(
					join(
						dir,
						"artifacts-engine-settlement-verify-fail",
						`${result.aggregate.taskId}.failure.json`,
					),
					"utf-8",
				),
			) as { cause?: string };
			check(
				artifact.cause?.includes("verification failed") === true,
				"no-yield verification failure retains the specific gate cause",
			);
		}

		// ─── M5.5: thrown objective gate reconciles exactly once ─────────
		{
			const repo = join(dir, "engine-settlement-materialize-throw");
			mkdirSync(repo, { recursive: true });
			execSync("jj git init --colocate", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "README.md"), "# fixture\n", "utf-8");
			execSync('JJ_EDITOR=true jj commit -m "init"', {
				cwd: repo,
				stdio: "pipe",
			});
			const { JujutsuWorkspaceDriver } =
				await import("../src/workspaces/jj-driver.ts");
			const driver = new JujutsuWorkspaceDriver({ projectDir: repo });
			let recoveries = 0;
			const recover = driver.recoverFailedRun.bind(driver);
			Object.defineProperty(driver, "recoverFailedRun", {
				value: async (...args: Parameters<typeof recover>) => {
					recoveries += 1;
					return await recover(...args);
				},
			});
			Object.defineProperty(driver, "materialize", {
				value: async () => {
					throw new Error("materialize fault");
				},
			});
			const result = await runParallelTask({
				subTasks: [SPEC_A],
				singleTask: true,
				projectDir: repo,
				artifactsDir: join(dir, "artifacts-engine-settlement-materialize-throw"),
				dbPath: join(dir, "engine-settlement-materialize-throw.db"),
				model: "openrouter/stealth/ox-alpha",
				workspaceDriver: driver,
				host: noYieldHost("a.txt"),
			});
			check(
				result.aggregate.verdict === "failed" && recoveries === 1,
				`materialization exception fails with one reconciliation (got ${result.aggregate.verdict}/${recoveries})`,
			);
			const { LedgerStore } = await import("../src/ledger/store.ts");
			const ledger = new LedgerStore(
				join(dir, "engine-settlement-materialize-throw.db"),
			);
			check(
				ledger.getTask(result.aggregate.taskId)?.status === "failed",
				"materialization exception leaves a terminal failed task",
			);
			ledger.close();
		}

		// ─── M5.5: missing authoritative finalization fails closed ───────
		{
			const repo = join(dir, "engine-settlement-no-authority");
			mkdirSync(repo, { recursive: true });
			execSync("jj git init --colocate", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "README.md"), "# fixture\n", "utf-8");
			execSync('JJ_EDITOR=true jj commit -m "init"', {
				cwd: repo,
				stdio: "pipe",
			});
			const { JujutsuWorkspaceDriver } =
				await import("../src/workspaces/jj-driver.ts");
			const driver = new JujutsuWorkspaceDriver({ projectDir: repo });
			Object.defineProperty(driver, "finalizeWorkspace", { value: undefined });
			const result = await runParallelTask({
				subTasks: [SPEC_A],
				singleTask: true,
				projectDir: repo,
				artifactsDir: join(dir, "artifacts-engine-settlement-no-authority"),
				dbPath: join(dir, "engine-settlement-no-authority.db"),
				model: "openrouter/stealth/ox-alpha",
				workspaceDriver: driver,
				host: noYieldHost("a.txt"),
			});
			check(
				result.aggregate.verdict === "failed",
				"no-yield provider without authoritative finalization fails closed",
			);
			check(
				result.perWorker[0]?.settlementSource === undefined,
				"claim-only provider never gains engine-derived authority",
			);
		}

		// ─── M5.5: engine aggregate never falls back before combine ──────
		{
			const repo = join(dir, "engine-settlement-no-combine-evidence");
			mkdirSync(repo, { recursive: true });
			execSync("jj git init --colocate", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "README.md"), "# fixture\n", "utf-8");
			execSync('JJ_EDITOR=true jj commit -m "init"', {
				cwd: repo,
				stdio: "pipe",
			});
			const { JujutsuWorkspaceDriver } =
				await import("../src/workspaces/jj-driver.ts");
			const driver = new JujutsuWorkspaceDriver({ projectDir: repo });
			const combine = driver.combine.bind(driver);
			Object.defineProperty(driver, "combine", {
				value: async (...args: Parameters<typeof combine>) => {
					const outcome = await combine(...args);
					return {
						commitId: outcome.commitId,
						conflicts: outcome.conflicts,
						filesChanged: outcome.filesChanged,
					};
				},
			});
			const result = await runParallelTask({
				subTasks: [SPEC_A],
				singleTask: true,
				projectDir: repo,
				artifactsDir: join(dir, "artifacts-engine-no-combine-evidence"),
				dbPath: join(dir, "engine-no-combine-evidence.db"),
				model: "openrouter/stealth/ox-alpha",
				workspaceDriver: driver,
				host: noYieldHost("a.txt"),
			});
			check(
				result.aggregate.verdict === "failed",
				"engine settlement rejects missing post-combine tree evidence",
			);
		}

		// ─── Feature-branch mode: bookmarks, no integration ──────────────
		{
			const repo = join(dir, "branchmode");
			mkdirSync(repo, { recursive: true });
			execSync("jj git init --colocate", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "README.md"), "# fixture\n", "utf-8");
			execSync('JJ_EDITOR=true jj commit -m "init"', {
				cwd: repo,
				stdio: "pipe",
			});

			const { JujutsuWorkspaceDriver } =
				await import("../src/workspaces/jj-driver.ts");
			const driver = new JujutsuWorkspaceDriver({
				projectDir: repo,
				integrationMode: "feature-branch",
			});
			const result = await runParallelTask({
				subTasks: [SPEC_A, SPEC_B],
				projectDir: repo,
				artifactsDir: join(dir, "artifacts-branch"),
				dbPath: join(dir, "branch.db"),
				model: "openrouter/stealth/ox-alpha",
				workspaceDriver: driver,
				host: scriptedHost(["a.txt", "b.txt"], { value: 0 }),
			});
			check(
				result.aggregate.verdict === "ship",
				"feature-branch run ships its bookkeeping",
			);
			check(
				!existsSync(join(repo, "a.txt")),
				"no combine happened — main tree untouched",
			);
			const bookmarks = execSync("jj bookmark list", {
				cwd: repo,
				encoding: "utf-8",
			});
			check(bookmarks.includes("v2-task-"), "worker bookmarks published");
		}
	} finally {
		// Keep the tree on failure — failure artifacts name the cause.
		if (errors.length === 0) rmSync(dir, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		throw new Error(`parallel tests failed:\n  ${errors.join("\n  ")}`);
	}
	console.log("✓ parallel: clean combine, mixed failure, feature-branch mode");
}

if (process.argv[1] !== undefined) {
	const invokedAs = process.argv[1];
	if (import.meta.url.endsWith(invokedAs.split("/").pop() ?? "")) {
		runTests().catch((err: unknown) => {
			console.error(err instanceof Error ? err.message : err);
			process.exit(1);
		});
	}
}
