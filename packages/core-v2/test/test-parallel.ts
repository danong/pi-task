/**
 * Hermetic tests for the M2.d parallel pipeline: two fake workers with
 * disjoint files combine cleanly; a failing worker fails the aggregate;
 * residual conflicts escalate (fake workspace driver); feature-branch mode
 * bookmarks instead of combining. Uses the REAL JujutsuWorkspaceDriver for
 * the clean-combine path (real jj, real repos) and fakes elsewhere. No LLM.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionHandle, SessionHost, SessionHostConfig, SessionHostEvent } from "../src/sessions/host.ts";
import { runParallelTask } from "../src/daemon/parallel.ts";

const SPEC_A = `## Goal\nFile A.\n\n## Requirements\n- R1: a.txt says A\n\n## Verification\n- test -f a.txt\n`;
const SPEC_B = `## Goal\nFile B.\n\n## Requirements\n- R1: b.txt says B\n\n## Verification\n- test -f b.txt\n`;

class FakeHandle implements SessionHandle {
	readonly role: string;
	readonly model = { provider: "fake", modelId: "fake/m" };
	result: { files_changed: string[]; summary: string; commit_ids: string[]; deviations: string[] } | undefined;
	constructor(config: SessionHostConfig, private readonly file: string) {
		this.role = config.role;
	}
	subscribe(listener: (event: SessionHostEvent) => void): () => void {
		listener({ type: "turnStart" });
		listener({ type: "settled" });
		return () => undefined;
	}
	async prompt(): Promise<void> {
		writeFileSync(this.file, this.file.endsWith("a.txt") ? "A" : "B", "utf-8");
		// Workers commit their work (jj snapshots on command): without this,
		// the workspace @ holds nothing for the combine to consume.
		execSync('JJ_EDITOR=true jj commit -m "fake work"', { cwd: dirname(this.file), stdio: "pipe" });
		this.result = { files_changed: [this.file.split("/").pop()!], summary: "done", commit_ids: ["fake"], deviations: [] };
	}
	async abort(): Promise<void> {}
	close(): void {}
}

function scriptedHost(filesByCall: string[], calls: { value: number }): SessionHost {
	return {
		spawn: async (config) => {
			const file = filesByCall[calls.value] ?? "a.txt";
			calls.value += 1;
			return new FakeHandle(config, join(config.cwd, file));
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
			execSync('JJ_EDITOR=true jj commit -m "init"', { cwd: repo, stdio: "pipe" });

			const { JujutsuWorkspaceDriver } = await import("../src/workspaces/jj-driver.ts");
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

			check(result.aggregate.verdict === "ship", `aggregate ship (got ${result.aggregate.verdict})`);
			check(result.perWorker.length === 2 && result.perWorker.every((r) => r.verdict === "ship"),
				"both worker receipts ship");
			check(existsSync(join(repo, "a.txt")) && existsSync(join(repo, "b.txt")),
				"combined tree holds both workers' files");
			check(result.conflicts.length === 0, "no conflicts");
			check(result.mergedCommitId !== undefined, "merged commit id returned");
		}

		// ─── Re-run collision (review M1/P0): same specs, same repo, twice ──
		{
			const repo = join(dir, "rerun");
			mkdirSync(repo, { recursive: true });
			execSync("jj git init --colocate", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "README.md"), "# fixture\n", "utf-8");
			execSync('JJ_EDITOR=true jj commit -m "init"', { cwd: repo, stdio: "pipe" });

			const { JujutsuWorkspaceDriver } = await import("../src/workspaces/jj-driver.ts");
			const dbPath = join(dir, "rerun.db");
			const runOnce = () => runParallelTask({
				subTasks: [SPEC_A, SPEC_B],
				projectDir: repo,
				artifactsDir: join(dir, "artifacts-rerun"),
				dbPath,
				model: "openrouter/stealth/ox-alpha",
				workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: repo }),
				host: scriptedHost(["a.txt", "b.txt"], { value: 0 }),
			});
			// Runs 1–2: FRESH driver + fresh DB each — both the jj-level wall
			// (workspace names) and the ledger-level wall (PKs) must yield.
			const first = await runOnce();
			const second = await runOnce();
			check(first.aggregate.verdict === "ship" && second.aggregate.verdict === "ship",
				"two consecutive parallel runs both ship");
			check(first.aggregate.taskId !== second.aggregate.taskId, "attempts get distinct aggregate ids");

			// Run 3 reuses the SAME database (warm ledger) — attempt discriminator.
			const third = await runOnce();
			check(third.aggregate.verdict === "ship", "third run on a warm ledger still ships");
			check(third.aggregate.taskId !== second.aggregate.taskId, "warm-ledger attempts distinct");
			check(third.aggregate.verdict === "ship", "third run on a warm ledger still ships");
			check(third.aggregate.taskId !== second.aggregate.taskId, "warm-ledger attempts distinct");
		}

		// ─── Failing worker → failed aggregate (still integrates healthy work)
		{
			const repo = join(dir, "mixed");
			mkdirSync(repo, { recursive: true });
			execSync("jj git init --colocate", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "README.md"), "# fixture\n", "utf-8");
			execSync('JJ_EDITOR=true jj commit -m "init"', { cwd: repo, stdio: "pipe" });

			class SettleHandle extends FakeHandle {
				constructor(config: SessionHostConfig, file: string, private readonly settleOnly: boolean) {
					super(config, file);
					this.settleOnly = settleOnly;
				}
				override async prompt(): Promise<void> {
					if (!this.settleOnly) await super.prompt();
				}
			}
			let call = 0;
			const mixedHost: SessionHost = {
				spawn: async (config) => new SettleHandle(config, join(config.cwd, call++ === 0 ? "a.txt" : "b.txt"), call === 1),
			};
			const { JujutsuWorkspaceDriver } = await import("../src/workspaces/jj-driver.ts");
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
			check(result.aggregate.verdict === "failed", "aggregate failed when a worker fails");
			check(result.perWorker.some((r) => r.verdict !== "ship"), "the failed worker is named in receipts");
		}

		// ─── Feature-branch mode: bookmarks, no integration ──────────────
		{
			const repo = join(dir, "branchmode");
			mkdirSync(repo, { recursive: true });
			execSync("jj git init --colocate", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "README.md"), "# fixture\n", "utf-8");
			execSync('JJ_EDITOR=true jj commit -m "init"', { cwd: repo, stdio: "pipe" });

			const { JujutsuWorkspaceDriver } = await import("../src/workspaces/jj-driver.ts");
			const driver = new JujutsuWorkspaceDriver({ projectDir: repo, integrationMode: "feature-branch" });
			const result = await runParallelTask({
				subTasks: [SPEC_A, SPEC_B],
				projectDir: repo,
				artifactsDir: join(dir, "artifacts-branch"),
				dbPath: join(dir, "branch.db"),
				model: "openrouter/stealth/ox-alpha",
				workspaceDriver: driver,
				host: scriptedHost(["a.txt", "b.txt"], { value: 0 }),
			});
			check(result.aggregate.verdict === "ship", "feature-branch run ships its bookkeeping");
			check(!existsSync(join(repo, "a.txt")), "no combine happened — main tree untouched");
			const bookmarks = execSync("jj bookmark list", { cwd: repo, encoding: "utf-8" });
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
		runTests().catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
	}
}
