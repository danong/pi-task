/**
 * M1 parity e2e (R8) — one real single-worker runTask through the v2 daemon
 * core, on openrouter/stealth/ox-alpha, against a temp jj repo.
 *
 * Manual/network gate like v1's test-e2e.ts: NOT part of run-all.ts or
 * `mise run test`. Skips with exit 0 when no OpenRouter auth is configured.
 *
 * Run: timeout 1200 npx tsx packages/core-v2/test/e2e-parity.ts
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
import { runTask } from "../src/daemon/task-runner.ts";

const MODEL = "openrouter/stealth/ox-alpha";

const SPEC = `## Goal
Prove the v2 daemon pipeline end to end.

## Requirements
- R1: hello-v2.txt exists at the repo root containing exactly "parity"
- R2: commit the change with message "parity"

## Verification
- test -f hello-v2.txt
- grep -qx parity hello-v2.txt
- test -n "$(jj log -r @- -T description --no-graph | grep parity)"
`;

async function main(): Promise<number> {
	const runtime = await ModelRuntime.create();
	if (!runtime.hasConfiguredAuth("openrouter")) {
		console.log("SKIPPED: no OpenRouter auth configured");
		return 0;
	}

	const dir = mkdtempSync(join(tmpdir(), "core-v2-parity-"));
	const repo = join(dir, "repo");
	mkdirSync(repo, { recursive: true });
	try {
		execSync("jj git init --colocate", { cwd: repo, stdio: "pipe" });
		writeInitialCommit(repo);

		const dbPath = join(dir, "tasks.db");
		const daemon = startDaemon(dbPath);
		if (
			daemon.reconciled.requeued.length + daemon.reconciled.failed.length !==
			0
		) {
			throw new Error("fresh ledger should reconcile nothing");
		}

		const startedAt = Date.now();
		const result = await runTask({
			specMarkdown: SPEC,
			cwd: repo,
			artifactsDir: join(dir, "artifacts"),
			dbPath,
			model: MODEL,
			sessionTimeoutMs: 240_000,
			onEvent: (event) => {
				const t = Math.round((Date.now() - startedAt) / 1000);
				console.log(`[${t}s] ${JSON.stringify(event).slice(0, 160)}`);
			},
		});

		const failures: string[] = [];
		const check = (cond: boolean, msg: string): void => {
			if (!cond) failures.push(msg);
		};

		check(
			result.receipt.verdict === "ship",
			`receipt verdict ship (got ${result.receipt.verdict})`,
		);
		check(result.verificationPassed, "verification passed");
		check(existsSync(join(repo, "hello-v2.txt")), "hello-v2.txt exists");

		const committed = execSync(
			"jj log -r 'all()' --no-graph -T 'description' 2>/dev/null",
			{ cwd: repo, encoding: "utf-8" },
		).includes("parity");
		check(committed, "a commit described 'parity' exists in the repo");

		const task = daemon.store.getTask(result.taskId);
		check(task?.status === "completed", "ledger task row completed");
		check(
			task?.planMode !== null && task?.planMode !== undefined,
			"ledger plan_mode recorded",
		);
		const session = daemon.store.getMicroSession(`${result.taskId}-worker`);
		check(session?.status === "yielded", "ledger session row yielded");
		daemon.store.close();

		console.log(`receipt: ${JSON.stringify(result.receipt)}`);
		if (failures.length > 0) {
			// Keep the workspace + ledger + failure artifact for diagnosis.
			console.error(
				`parity FAILED (workspace kept at ${dir}):\n  ${failures.join("\n  ")}`,
			);
			return 1;
		}
		console.log("✓ parity e2e passed");
		return 0;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function writeInitialCommit(repo: string): void {
	writeFileSync(join(repo, "README.md"), "# parity fixture\n", "utf-8");
	execSync('JJ_EDITOR=true jj commit -m "init"', { cwd: repo, stdio: "pipe" });
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		console.error(
			err instanceof Error ? (err.stack ?? err.message) : String(err),
		);
		process.exit(1);
	});
