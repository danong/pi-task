/**
 * M2 parallel parity e2e — TWO real workers on openrouter/stealth/ox-alpha
 * through the REAL JujutsuWorkspaceDriver: isolated workspaces, atomic
 * combine, one verification gate on the integrated tree.
 *
 * Manual/network gate (NOT part of mise run test). Skips without auth.
 * Run: timeout 1800 npx tsx packages/core-v2/test/e2e-parallel.ts
 */

import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { startDaemon } from "../src/daemon/start.ts";
import { runParallelTask } from "../src/daemon/parallel.ts";
import { JujutsuWorkspaceDriver } from "../src/workspaces/jj-driver.ts";

const MODEL = "openrouter/stealth/ox-alpha";

const SPEC_A = `## Goal
Add the letter A to the fixture.

## Requirements
- R1: create a.txt at the repo root containing exactly "alpha"
- R2: commit the change with message "alpha"

## Verification
- test -f a.txt
- grep -qx alpha a.txt
`;

const SPEC_B = `## Goal
Add the letter B to the fixture.

## Requirements
- R1: create b.txt at the repo root containing exactly "beta"
- R2: commit the change with message "beta"

## Verification
- test -f b.txt
- grep -qx beta b.txt
`;

async function main(): Promise<number> {
	const runtime = await ModelRuntime.create();
	if (!runtime.hasConfiguredAuth("openrouter")) {
		console.log("SKIPPED: no OpenRouter auth configured");
		return 0;
	}

	const dir = mkdtempSync(join(tmpdir(), "core-v2-parity-par-"));
	const repo = join(dir, "repo");
	try {
		mkdirSync(repo, { recursive: true });
		execSync("jj git init --colocate", { cwd: repo, stdio: "pipe" });
		writeFileSync(join(repo, "README.md"), "# parallel fixture\n", "utf-8");
		execSync('JJ_EDITOR=true jj commit -m "init"', {
			cwd: repo,
			stdio: "pipe",
		});

		const daemon = startDaemon(join(dir, "tasks.db"));
		const driver = new JujutsuWorkspaceDriver({ projectDir: repo });

		const startedAt = Date.now();
		const result = await runParallelTask({
			subTasks: [SPEC_A, SPEC_B],
			projectDir: repo,
			artifactsDir: join(dir, "artifacts"),
			dbPath: join(dir, "tasks.db"),
			model: MODEL,
			workspaceDriver: driver,
			sessionTimeoutMs: 420_000,
			onEvent: (worker, event) => {
				const t = Math.round((Date.now() - startedAt) / 1000);
				console.log(
					`[w${worker} ${t}s] ${JSON.stringify(event).slice(0, 120)}`,
				);
			},
		});

		const failures: string[] = [];
		const check = (cond: boolean, msg: string): void => {
			if (!cond) failures.push(msg);
		};

		check(
			result.aggregate.verdict === "ship",
			`aggregate ship (got ${result.aggregate.verdict})`,
		);
		check(result.perWorker.length === 2, "two worker receipts");
		check(
			result.perWorker.every((r) => r.verdict === "ship"),
			"both workers shipped",
		);
		check(
			existsSync(join(repo, "a.txt")) && existsSync(join(repo, "b.txt")),
			"integrated tree holds both workers' files",
		);

		const log = execSync("jj log -r 'all()' --no-graph -T description", {
			cwd: repo,
			encoding: "utf-8",
		});
		check(
			log.includes("alpha") && log.includes("beta"),
			"both worker commits reached the repo",
		);

		const task = daemon.store.getTask(result.aggregate.taskId);
		check(task?.status === "completed", "ledger aggregate row completed");
		daemon.store.close();

		console.log(`aggregate: ${JSON.stringify(result.aggregate)}`);
		console.log(
			`per-worker: ${result.perWorker.map((r) => `${r.taskId}=${r.verdict}`).join(" ")}`,
		);
		if (failures.length > 0) {
			console.error(`parallel parity FAILED:\n  ${failures.join("\n  ")}`);
			return 1;
		}
		console.log("✓ parallel parity e2e passed");
		return 0;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		console.error(
			err instanceof Error ? (err.stack ?? err.message) : String(err),
		);
		process.exit(1);
	});
