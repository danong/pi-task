/**
 * Hermetic tests for the M2.c JujutsuWorkspaceDriver — real jj repos in
 * temp dirs, no LLM. Covers: support probe, fetch-before-work tolerance
 * (no remote), AI-authored base, clean two-worker atomic combine, union
 * ladder on conflicting edits, consistency-gate failure on a lost file,
 * feature-branch bookmark mode, and cleanup.
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
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JujutsuWorkspaceDriver } from "../src/workspaces/jj-driver.ts";
import {
	workspaceContinuationOf,
	WorkspaceContinuationError,
	type WorkspaceContinuation,
	type WorkspaceDriver,
} from "../src/contracts/workspace-driver.ts";
import { parseMachineDiffPaths } from "../src/workspaces/jj.ts";

function newRepo(dir: string): void {
	mkdirSync(dir, { recursive: true });
	execSync("jj git init --colocate", { cwd: dir, stdio: "pipe" });
	writeFileSync(join(dir, "README.md"), "# fixture\n", "utf-8");
	execSync('JJ_EDITOR=true jj commit -m "init"', { cwd: dir, stdio: "pipe" });
}

/** Drive one worker workspace: write files + commit via jj in that dir. */
function workerCommit(wsDir: string, message: string): void {
	execSync(`JJ_EDITOR=true jj commit -m ${JSON.stringify(message)}`, {
		cwd: wsDir,
		stdio: "pipe",
	});
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
			check(
				existsSync(join(ws1.hostPath, "README.md")),
				"workspace materializes the repo",
			);
			check(ws1.branchName !== ws2.branchName, "distinct workspace names");

			writeFileSync(join(ws1.hostPath, "one.txt"), "one\n", "utf-8");
			writeFileSync(join(ws2.hostPath, "two.txt"), "two\n", "utf-8");
			workerCommit(ws1.hostPath, "ws1: one.txt");
			workerCommit(ws2.hostPath, "ws2: two.txt");

			const outcome = await driver.combine(base, [ws1, ws2]);
			check(outcome.conflicts.length === 0, "clean combine has no conflicts");

			await driver.materialize(base);
			check(
				existsSync(join(repo, "one.txt")) && existsSync(join(repo, "two.txt")),
				"merged tree holds both workers' files (consistency gate passed)",
			);

			await driver.cleanupWorkspace(ws1);
			await driver.cleanupWorkspace(ws2);
			check(!existsSync(ws1.hostPath), "cleanup removes the workspace dir");
		}

		// ─── Union ladder: conflicting edits resolve deterministically ───
		{
			const repo = join(dir, "union");
			newRepo(repo);
			writeFileSync(join(repo, "shared.txt"), "line-a\nline-b\n", "utf-8");
			execSync('JJ_EDITOR=true jj commit -m "shared"', {
				cwd: repo,
				stdio: "pipe",
			});

			const driver = new JujutsuWorkspaceDriver({ projectDir: repo });
			const base = await driver.prepareIntegrationBase("union ladder");
			const ws1 = await driver.createWorkspace("u1");
			const ws2 = await driver.createWorkspace("u2");

			// Both workers edit the SAME line — a real conflict for 3-way merge.
			writeFileSync(
				join(ws1.hostPath, "shared.txt"),
				"line-A1\nline-b\n",
				"utf-8",
			);
			workerCommit(ws1.hostPath, "u1 edit");
			writeFileSync(
				join(ws2.hostPath, "shared.txt"),
				"line-A2\nline-b\n",
				"utf-8",
			);
			workerCommit(ws2.hostPath, "u2 edit");

			const outcome = await driver.combine(base, [ws1, ws2]);
			if (outcome.conflicts.length === 0) {
				// Union keeps BOTH sides' lines (deterministic, no markers).
				const content = readFileSync(join(repo, "shared.txt"), "utf-8");
				check(
					content.includes("line-A1") && content.includes("line-A2"),
					"union resolution kept both sides' hunks",
				);
				check(!content.includes("<<<<<<<"), "no conflict markers remain");
			} else {
				// Escalation is also acceptable — but must be reported, not silent.
				check(
					outcome.conflicts.includes("shared.txt"),
					"residual conflict reported as escalation",
				);
			}

			// The gate already ran inside combine(); the tree must hold the file.
			await driver.materialize(base);
			check(
				existsSync(join(repo, "shared.txt")),
				"conflicted combine still integrates the file",
			);
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
			execSync('JJ_EDITOR=true jj commit -m "remove gone"', {
				cwd: repo,
				stdio: "pipe",
			});

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

		// ─── Binary conflict: union tool fails → residual escalation ─────
		{
			const repo = join(dir, "binary");
			newRepo(repo);
			writeFileSync(
				join(repo, "blob.bin"),
				Buffer.from([0x00, 0x01, 0x02, 0xff]),
				"utf-8",
			);
			execSync('JJ_EDITOR=true jj commit -m "binary base"', {
				cwd: repo,
				stdio: "pipe",
			});

			const driver = new JujutsuWorkspaceDriver({ projectDir: repo });
			const base = await driver.prepareIntegrationBase("binary ladder");
			const ws1 = await driver.createWorkspace("bin1");
			const ws2 = await driver.createWorkspace("bin2");
			writeFileSync(
				join(ws1.hostPath, "blob.bin"),
				Buffer.from([0xaa, 0xbb]),
				"utf-8",
			);
			workerCommit(ws1.hostPath, "bin1 edit");
			writeFileSync(
				join(ws2.hostPath, "blob.bin"),
				Buffer.from([0xcc, 0xdd]),
				"utf-8",
			);
			workerCommit(ws2.hostPath, "bin2 edit");

			const outcome = await driver.combine(base, [ws1, ws2]);
			check(
				outcome.conflicts.includes("blob.bin"),
				"binary conflict escalates through the real union ladder (git merge-file exits 255)",
			);
		}

		// ─── Workspace finalization: engine-owned jj evidence ─────────────
		{
			const repo = join(dir, "finalize");
			newRepo(repo);
			const driver = new JujutsuWorkspaceDriver({
				projectDir: repo,
				authorName: "engine-finalizer",
				authorEmail: "engine-finalizer@example.test",
			});
			const base = await driver.prepareIntegrationBase("finalize worker");
			const ws = await driver.createWorkspace("finalize");
			writeFileSync(join(ws.hostPath, "new.txt"), "new\n", "utf-8");
			rmSync(join(ws.hostPath, "README.md"));

			const finalized = await driver.finalizeWorkspace(ws, base);
			check(finalized.hasChanges, "uncommitted edits are real changes");
			check(
				finalized.changedPaths.includes("new.txt") &&
					finalized.changedPaths.includes("README.md"),
				"finalization reports additions and deletions relative to the base",
			);
			check(
				/^[0-9a-f]{40}$/.test(finalized.commitId) &&
				/^[a-z]{32}$/.test(finalized.changeId),
				"finalization returns engine-derived commit and change ids",
			);
			const author = execSync(
				`jj log -r ${finalized.commitId} --no-graph -T 'author.email()'`,
				{ cwd: repo, encoding: "utf-8" },
			);
			check(
				author.trim() === driver.authorEmail,
				"uncommitted edits are committed with the engine identity",
			);
		}
		{
			const repo = join(dir, "finalize-committed");
			newRepo(repo);
			const driver = new JujutsuWorkspaceDriver({ projectDir: repo });
			const base = await driver.prepareIntegrationBase("preserve commit");
			const ws = await driver.createWorkspace("committed");
			writeFileSync(join(ws.hostPath, "kept.txt"), "kept\n", "utf-8");
			workerCommit(ws.hostPath, "model commit");
			const modelTip = execSync("jj log -r @- --no-graph -T commit_id", {
				cwd: ws.hostPath,
				encoding: "utf-8",
			}).trim();
			const finalized = await driver.finalizeWorkspace(ws, base);
			check(finalized.commitId === modelTip, "model-created commit is preserved");
			check(
				finalized.hasChanges && finalized.changedPaths.includes("kept.txt"),
				"already-committed work is reported authoritatively",
			);
		}
		{
			const repo = join(dir, "finalize-empty");
			newRepo(repo);
			const driver = new JujutsuWorkspaceDriver({ projectDir: repo });
			const base = await driver.prepareIntegrationBase("empty worker");
			const ws = await driver.createWorkspace("empty");
			const finalized = await driver.finalizeWorkspace(ws, base);
			check(!finalized.hasChanges, "empty worker has no real changes");
			check(finalized.changedPaths.length === 0, "empty worker has no changed paths");
			check(/^[0-9a-f]{40}$/.test(finalized.commitId), "empty worker still has a tip id");
		}
		check(
			parseMachineDiffPaths(["Working copy: stale", "M\tkept.txt"]).join() ===
				"kept.txt",
			"machine diff parser ignores human status prose",
		);

		// ─── Durable opaque continuation: restart with a new driver ────────
		{
			const repo = join(dir, "continuation");
			newRepo(repo);
			const firstDriver = new JujutsuWorkspaceDriver({ projectDir: repo });
			await firstDriver.prepareIntegrationBase("continuation");
			const ws = await firstDriver.createWorkspace("resume-1");
			writeFileSync(join(ws.hostPath, "partial.txt"), "recover me\n", "utf-8");
			const continuation = await firstDriver.continuation!.preserveContinuation(ws);
			const serialized = JSON.stringify(continuation);
			check(
				!serialized.includes(ws.hostPath) && !serialized.includes(ws.branchName),
				"continuation does not expose a host path or workspace name",
			);
			check(
				/^[0-9a-f]{40}$/.test(continuation.revision) &&
				/^jjc1_[0-9a-f]{64}$/.test(continuation.opaqueToken),
				"continuation contains an opaque provider/version token and revision",
			);

			// A second driver has no in-memory context map; it resolves the live
			// provider workspace and recovers the snapshotted partial tree.
			const restarted = new JujutsuWorkspaceDriver({ projectDir: repo });
			const resumed = await restarted.continuation!.resumeContinuation(
				"resume-1",
				continuation,
			);
			check(
				readFileSync(join(resumed.hostPath, "partial.txt"), "utf-8") ===
					"recover me\n",
				"new driver resumes the same workspace tree",
			);
			const recovery = await firstDriver.recoverFailedRun({
				workspaceNames: [ws.branchName],
				cause: "interrupted",
				workspaceDirs: { [ws.branchName]: ws.hostPath },
			});
			check(
				recovery.stacked.length === 0 &&
				(await firstDriver.continuation!.resumeContinuation("resume-1", continuation)).hostPath ===
					ws.hostPath,
				"failure hygiene leaves an explicitly preserved continuation resumable",
			);
			const again = await restarted.continuation!.preserveContinuation(resumed);
			check(
				JSON.stringify(again) === JSON.stringify(continuation),
				"repeated preservation is idempotent",
			);
			const resumedAgain = await restarted.continuation!.resumeContinuation(
				"resume-1",
				continuation,
			);
			check(
				resumedAgain.hostPath === resumed.hostPath,
				"repeated resumption does not create a duplicate workspace",
			);

			writeFileSync(join(resumed.hostPath, "advanced.txt"), "new revision\n", "utf-8");
			workerCommit(resumed.hostPath, "advance continuation");
			let stale: WorkspaceContinuationError | undefined;
			try {
				await new JujutsuWorkspaceDriver({ projectDir: repo }).continuation!.resumeContinuation(
					"resume-1",
					continuation,
				);
			} catch (error: unknown) {
				if (error instanceof WorkspaceContinuationError) stale = error;
			}
			check(stale?.code === "stale", "revision mismatch is a typed stale outcome");

			const malformed: WorkspaceContinuation = {
				opaqueToken: "jjc9_not-a-provider-token",
				revision: continuation.revision,
			};
			let malformedError: WorkspaceContinuationError | undefined;
			try {
				await restarted.continuation!.resumeContinuation("resume-1", malformed);
			} catch (error: unknown) {
				if (error instanceof WorkspaceContinuationError) malformedError = error;
			}
			check(
				malformedError?.code === "malformed_token",
				"provider/version mismatch is a typed malformed-token outcome",
			);
			let unsupported: WorkspaceContinuationError | undefined;
			try {
				workspaceContinuationOf({ continuation: undefined } as unknown as WorkspaceDriver);
			} catch (error: unknown) {
				if (error instanceof WorkspaceContinuationError) unsupported = error;
			}
			check(unsupported?.code === "unsupported", "provider deletion is typed unsupported");
			await restarted.cleanupWorkspace(resumed);
			let missing: WorkspaceContinuationError | undefined;
			try {
				await new JujutsuWorkspaceDriver({ projectDir: repo }).continuation!.resumeContinuation(
					"resume-1",
					continuation,
				);
			} catch (error: unknown) {
				if (error instanceof WorkspaceContinuationError) missing = error;
			}
			check(missing?.code === "missing", "deleted continuation is a typed missing outcome");
		}

		// ─── Feature-branch mode: bookmarks, no squash ───────────────────
		{
			const repo = join(dir, "branches");
			newRepo(repo);
			const driver = new JujutsuWorkspaceDriver({
				projectDir: repo,
				integrationMode: "feature-branch",
			});
			const ws1 = await driver.createWorkspace("b1");
			writeFileSync(join(ws1.hostPath, "feat.txt"), "feat\n", "utf-8");
			workerCommit(ws1.hostPath, "b1 work");

			const result = await driver.mergeWorkspace(ws1); // bookmarks the tip
			check(
				result.success && (result.conflicts?.length ?? 0) === 0,
				"feature-branch merge is bookkeeping only",
			);
			const bookmarks = execSync("jj bookmark list", {
				cwd: repo,
				encoding: "utf-8",
			});
			check(bookmarks.includes("v2-task-b1"), "worker bookmark created");
			check(driver.combine !== undefined, "combine present but mode-guarded");

			// M2 regression: advance the workspace tip and re-publish — the
			// bookmark must MOVE to the new tip, not silently stay stale.
			writeFileSync(join(ws1.hostPath, "feat.txt"), "feat-2\n", "utf-8");
			workerCommit(ws1.hostPath, "b1 work 2");
			await driver.mergeWorkspace(ws1);
			const moved = execSync("jj log -r v2-task-b1 --no-graph -T description", {
				cwd: repo,
				encoding: "utf-8",
			});
			check(
				moved.includes("b1 work 2"),
				"re-publish moves the bookmark to the current tip",
			);

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
	console.log(
		"✓ jj-driver: combine, union ladder, consistency gate, bookmarks, guards",
	);
}

if (process.argv[1] !== undefined) {
	const invokedAs = process.argv[1];
	if (import.meta.url.endsWith(invokedAs.split("/").pop() ?? "")) {
		runTests().catch((err) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		});
	}
}
