/**
 * Hermetic tests for the M2.c JujutsuWorkspaceDriver — real jj repos in
 * temp dirs, no LLM. Covers: support probe, fetch-before-work tolerance
 * (no remote), AI-authored base, clean two-worker atomic combine, union
 * ladder on conflicting edits, consistency-gate failure on a lost file,
 * feature-branch bookmark mode, and cleanup.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JujutsuWorkspaceDriver } from "../src/workspaces/jj-driver.ts";
import { taskBaseChangeId } from "../src/workspaces/jj.ts";

function newRepo(dir: string): void {
	mkdirSync(dir, { recursive: true });
	execSync("jj git init --colocate", { cwd: dir, stdio: "pipe" });
	writeFileSync(join(dir, "README.md"), "# fixture\n", "utf-8");
	execSync('JJ_EDITOR=true jj commit -m "init"', { cwd: dir, stdio: "pipe" });
}

/** Drive one worker workspace: write files + commit via jj in that dir. */
function workerCommit(wsDir: string, message: string): void {
	execSync(`JJ_EDITOR=true jj commit -m ${JSON.stringify(message)}`, { cwd: wsDir, stdio: "pipe" });
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

	const dir = mkdtempSync(join(tmpdir(), "core-v2-jjd-"));
	try {
		// ─── task-base mode: AI base + clean two-worker combine ──────────
		{
			const repo = join(dir, "task-base");
			newRepo(repo);
			const driver = new JujutsuWorkspaceDriver({ projectDir: repo });
			check(await driver.isSupported(), "jj supported");

			const base = await driver.prepareIntegrationBase("combine two workers");
			check(/^[a-z]{32}$/.test(base), "integration base change id returned");
			check(existsSync(join(repo, ".jj")), "repo intact");

			const ws1 = await driver.createWorkspace("t1");
			const ws2 = await driver.createWorkspace("t2");
			check(existsSync(join(ws1.hostPath, "README.md")), "workspace materializes the repo");
			check(ws1.branchName !== ws2.branchName, "distinct workspace names");

			writeFileSync(join(ws1.hostPath, "one.txt"), "one\n", "utf-8");
			writeFileSync(join(ws2.hostPath, "two.txt"), "two\n", "utf-8");
			workerCommit(ws1.hostPath, "ws1: one.txt");
			workerCommit(ws2.hostPath, "ws2: two.txt");

			const outcome = await driver.combine(base, [ws1, ws2]);
			check(outcome.conflicts.length === 0, "clean combine has no conflicts");

			await driver.materialize(base);
			check(existsSync(join(repo, "one.txt")) && existsSync(join(repo, "two.txt")),
				"merged tree holds both workers' files (consistency gate passed)");

			await driver.cleanupWorkspace(ws1);
			await driver.cleanupWorkspace(ws2);
			check(!existsSync(ws1.hostPath), "cleanup removes the workspace dir");
		}

		// ─── Union ladder: conflicting edits resolve deterministically ───
		{
			const repo = join(dir, "union");
			newRepo(repo);
			writeFileSync(join(repo, "shared.txt"), "line-a\nline-b\n", "utf-8");
			execSync('JJ_EDITOR=true jj commit -m "shared"', { cwd: repo, stdio: "pipe" });

			const driver = new JujutsuWorkspaceDriver({ projectDir: repo });
			const base = await driver.prepareIntegrationBase("union ladder");
			const ws1 = await driver.createWorkspace("u1");
			const ws2 = await driver.createWorkspace("u2");

			// Both workers edit the SAME line — a real conflict for 3-way merge.
			writeFileSync(join(ws1.hostPath, "shared.txt"), "line-A1\nline-b\n", "utf-8");
			workerCommit(ws1.hostPath, "u1 edit");
			writeFileSync(join(ws2.hostPath, "shared.txt"), "line-A2\nline-b\n", "utf-8");
			workerCommit(ws2.hostPath, "u2 edit");

			const outcome = await driver.combine(base, [ws1, ws2]);
			if (outcome.conflicts.length === 0) {
				// Union keeps BOTH sides' lines (deterministic, no markers).
				const content = readFileSync(join(repo, "shared.txt"), "utf-8");
				check(content.includes("line-A1") && content.includes("line-A2"),
					"union resolution kept both sides' hunks");
				check(!content.includes("<<<<<<<"), "no conflict markers remain");
			} else {
				// Escalation is also acceptable — but must be reported, not silent.
				check(outcome.conflicts.includes("shared.txt"), "residual conflict reported as escalation");
			}

			// The gate already ran inside combine(); the tree must hold the file.
			await driver.materialize(base);
			check(existsSync(join(repo, "shared.txt")), "conflicted combine still integrates the file");
		}

		// ─── Consistency gate: a lost file fails loudly ──────────────────
		{
			const repo = join(dir, "gate");
			newRepo(repo);
			const driver = new JujutsuWorkspaceDriver({ projectDir: repo });
			const base = await driver.prepareIntegrationBase("gate check");
			const ws1 = await driver.createWorkspace("g1");
			writeFileSync(join(ws1.hostPath, "gone.txt"), "gone\n", "utf-8");
			workerCommit(ws1.hostPath, "g1 work");
			// Simulate loss: delete the file from the merged tree before the gate.
			const outcome = await driver.combine(base, [ws1]);
			void outcome;
			rmSync(join(repo, "gone.txt"), { force: true });
			execSync('JJ_EDITOR=true jj commit -m "remove gone"', { cwd: repo, stdio: "pipe" });

			let threw = false;
			try {
				// Re-run ONLY the gate via a fresh combine-shaped assertion:
				// assertMerged is exercised through driver.combine's internals,
				// so simulate by calling the exported gate path indirectly —
				// here we re-check via materialize + manual expectation.
				const { assertMerged } = await import("../src/workspaces/jj.ts");
				await assertMerged(repo, base, { expectedFiles: ["gone.txt"] });
			} catch {
				threw = true;
			}
			check(threw, "consistency gate fails when the union file is missing");
		}

		// ─── Feature-branch mode: bookmarks, no squash ───────────────────
		{
			const repo = join(dir, "branches");
			newRepo(repo);
			const driver = new JujutsuWorkspaceDriver({ projectDir: repo, integrationMode: "feature-branch" });
			const ws1 = await driver.createWorkspace("b1");
			writeFileSync(join(ws1.hostPath, "feat.txt"), "feat\n", "utf-8");
			workerCommit(ws1.hostPath, "b1 work");

			const result = await driver.mergeWorkspace(ws1); // bookmarks the tip
			check(result.success && (result.conflicts?.length ?? 0) === 0, "feature-branch merge is bookkeeping only");
			const bookmarks = execSync("jj bookmark list", { cwd: repo, encoding: "utf-8" });
			check(bookmarks.includes("v2-task-b1"), "worker bookmark created");
			check(driver.combine !== undefined, "combine present but mode-guarded");

			// M2 regression: advance the workspace tip and re-publish — the
			// bookmark must MOVE to the new tip, not silently stay stale.
			writeFileSync(join(ws1.hostPath, "feat.txt"), "feat-2\n", "utf-8");
			workerCommit(ws1.hostPath, "b1 work 2");
			await driver.mergeWorkspace(ws1);
			const moved = execSync("jj log -r v2-task-b1 --no-graph -T description", { cwd: repo, encoding: "utf-8" });
			check(moved.includes("b1 work 2"), "re-publish moves the bookmark to the current tip");

			let threw = false;
			try {
				await driver.combine("somebase", [ws1]);
			} catch {
				threw = true;
			}
			check(threw, "combine() refuses to run in feature-branch mode");
		}

		// ─── Clean-working-copy guard ─────────────────────────────────────
		{
			const repo = join(dir, "dirty");
			newRepo(repo);
			writeFileSync(join(repo, "wip.txt"), "wip\n", "utf-8"); // uncommitted
			const driver = new JujutsuWorkspaceDriver({ projectDir: repo });
			let threw = false;
			try {
				await driver.prepare();
			} catch {
				threw = true;
			}
			check(threw, "dirty working copy fails prepare() loudly");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		throw new Error(`jj-driver tests failed:\n  ${errors.join("\n  ")}`);
	}
	console.log("✓ jj-driver: combine, union ladder, consistency gate, bookmarks, guards");
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
