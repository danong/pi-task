/**
 * jj workspace mechanics tests — real jj on a temp repo, no LLM:
 *
 * 1. Mechanics: two workspaces, commits in each (one workspace makes two —
 *    multi-commit range), both squashed into the task base, all files land,
 *    workspaces removed cleanly.
 * 2. Conflict: two workspaces edit the same file differently → the merge
 *    conflict is surfaced (conflicts: ["shared.txt"], markers in WC).
 * 3. Final-state conflicts (R3): a per-squash conflict that is resolved
 *    afterwards reads CLEAN from the final-state check on the base change.
 * 4. Post-squash commit ids (R5): the base change resolves to ONE surviving
 *    commit id; the workers' pre-squash commits are abandoned.
 * 5. Clean-working-copy guard (R1): clean passes; untracked/modified
 *    files throw with a precise message + status excerpt.
 * 14. Merge-failure artifact (R2): a simulated merge failure writes the
 *    .failure.json recording workspace names, dangling commit ids, and
 *    conflicted files — the workspaces survive for scripted recovery.
 * 15. Recovery guide (R4): the artifact carries the scripted recovery
 *    guide (stacking commands, stub-abandon-before-push, add-vs-delete
 *    :ours/:theirs) and names R3 rescue commits.
 * 16. Bounded jj (R5): execJj's default ~120s bound, per-call override,
 *    and the failure path's tighter bound on wedged workspaces.
 * 17. Rescue commits (R3): a parallel workspace's uncommitted state is
 *    captured inside the preserved workspace.
 * 18. No-merge-failure stub (R1): the finally's `jj new` identity restore
 *    runs only when a merge actually landed — never a description-less
 *    stub on the failure path.
 *
 * splitSpec moved to test-orchestrator.ts; the parallel LLM integration
 * moved to test-e2e.ts section 5.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { aiIdentityToml } from "./config.ts";
import {
	rescueAbortedWorkBestEffort,
	rescueWorkspaceStateBestEffort,
	restoreParallelWorkingCopy,
	writeMergeFailureArtifact,
} from "./orchestrator.ts";
import {
	assertCleanWorkingCopy,
	assertMerged,
	assertVisibleCommit,
	assertWorkspacesConsumed,
	conflictHunks,
	createAiTaskBase,
	createWorkspace,
	DEFAULT_JJ_TIMEOUT_MS,
	detectChangeConflicts,
	execJj,
	mergeWorkspace,
	mergeWorkspacesAtomic,
	parseSummaryChanges,
	removeWorkspace,
	resolveCommitId,
	resolveConflictsWithUnion,
	taskBaseChangeId,
	workspaceCommitId,
} from "./workspace.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Child env for jj: deterministic and hermetic. JJ_EDITOR=true keeps
 *  jj out of the interactive editor; the harness's JJ_CONFIG (the agent
 *  worker identity) is stripped — the tests simulate a USER repo whose
 *  identity comes from the repo config (initRepo), never from the host. */
function jjEnv(): Record<string, string> {
	const env: Record<string, string> = { ...process.env, JJ_EDITOR: "true" };
	delete env.JJ_CONFIG;
	return env;
}

function jj(args: string[], cwd: string): string {
	return execFileSync("jj", args, {
		cwd,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
		env: jjEnv(),
	});
}

/** Async jj — the child process runs in the OS concurrently with others. */
function jjAsync(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("jj", args, { cwd, env: jjEnv() }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout.toString());
		});
	});
}

function initRepo(dir: string): void {
	// Deterministic repo identity — the suite must not depend on the host's
	// jj config (or its absence). jj commit PRESERVES the working-copy
	// commit's author, so the initial WC is created with the Test User
	// identity via --config (the init commit inherits it); the repo config
	// keeps every later commit (restore `jj new` steps) on the same
	// identity. The harness's JJ_CONFIG is stripped by jjEnv().
	jj(
		[
			"--config", 'user.name="Test User"',
			"--config", 'user.email="user@test.dev"',
			"git", "init", "--colocate",
		],
		dir,
	);
	jj(["config", "set", "--repo", "user.name", "Test User"], dir);
	jj(["config", "set", "--repo", "user.email", "user@test.dev"], dir);
	writeFileSync(join(dir, "README.md"), "# Test repo\n", "utf-8");
	jj(["commit", "-m", "init"], dir);
}

/** Remove the workspace and its temp parent dir (createWorkspace parent). */
async function cleanupWorkspace(projectDir: string, name: string, dir: string): Promise<void> {
	await removeWorkspace(projectDir, name, dir);
	rmSync(dirname(dir), { recursive: true, force: true });
}

// ─── Section 1: mechanics ────────────────────────────────────────────

async function testMechanics(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-mech-"));
	try {
		initRepo(testDir);
		const baseChange = await taskBaseChangeId(testDir);

		const ws1 = await createWorkspace(testDir, "mech-1");
		const ws2 = await createWorkspace(testDir, "mech-2");
		check(existsSync(join(ws1, "README.md")), "ws1 should materialize base files");
		check(existsSync(join(ws2, "README.md")), "ws2 should materialize base files");

		// ws1 makes TWO commits (multi-commit range), ws2 makes one
		writeFileSync(join(ws1, "a.txt"), "one\n", "utf-8");
		jj(["commit", "-m", "mech ws1 c1"], ws1);
		writeFileSync(join(ws1, "a2.txt"), "two\n", "utf-8");
		jj(["commit", "-m", "mech ws1 c2"], ws1);
		writeFileSync(join(ws2, "b.txt"), "three\n", "utf-8");
		jj(["commit", "-m", "mech ws2 c1"], ws2);

		const out1 = await mergeWorkspace(testDir, "mech-1", baseChange);
		check(out1.conflicts.length === 0, `ws1 merge should be clean, got ${JSON.stringify(out1.conflicts)}`);
		const out2 = await mergeWorkspace(testDir, "mech-2", baseChange);
		check(out2.conflicts.length === 0, `ws2 merge should be clean, got ${JSON.stringify(out2.conflicts)}`);

		// All three files land in the main working copy (empty @ on the merged base)
		for (const f of ["a.txt", "a2.txt", "b.txt"]) {
			check(existsSync(join(testDir, f)), `${f} should be in the merged tree`);
		}
		const st = jj(["st"], testDir);
		check(st.includes("The working copy has no changes"), `main working copy should be clean after merge, got: ${st}`);

		await cleanupWorkspace(testDir, "mech-1", ws1);
		await cleanupWorkspace(testDir, "mech-2", ws2);
		const list = jj(["workspace", "list"], testDir);
		check(!list.includes("mech-"), `workspace list should only have default, got: ${list}`);
		check(!existsSync(ws1) && !existsSync(ws2), "workspace dirs should be deleted");
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ workspace mechanics: multi-commit merge, clean removal");
}

// ─── Section 3: final-state conflicts (R3) ──────────────────────────

async function testFinalStateConflicts(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-final-"));
	try {
		initRepo(testDir);
		const baseChange = await taskBaseChangeId(testDir);

		const c1 = await createWorkspace(testDir, "final-1");
		const c2 = await createWorkspace(testDir, "final-2");

		writeFileSync(join(c1, "shared.txt"), "a\nb\nc\n", "utf-8");
		jj(["commit", "-m", "final c1"], c1);
		writeFileSync(join(c2, "shared.txt"), "a\nB\nc\n", "utf-8");
		jj(["commit", "-m", "final c2"], c2);

		// Per-squash detection (the OLD union source) reports the conflict...
		const out1 = await mergeWorkspace(testDir, "final-1", baseChange);
		check(out1.conflicts.length === 0, `first merge should be clean, got ${JSON.stringify(out1.conflicts)}`);
		const out2 = await mergeWorkspace(testDir, "final-2", baseChange);
		check(out2.conflicts.length === 1 && out2.conflicts[0] === "shared.txt",
			`per-squash detection should report shared.txt, got ${JSON.stringify(out2.conflicts)}`);

		// ...but the conflict is then RESOLVED (markers edited in the main
		// working copy, squashed into the base). The FINAL-state check must
		// reflect the FINAL tree and read CLEAN — a per-squash union would
		// still carry shared.txt and fail the task on a resolved conflict.
		writeFileSync(join(testDir, "shared.txt"), "a\nB\nc\n", "utf-8");
		jj(["squash"], testDir);
		const finalConflicts = await detectChangeConflicts(testDir, baseChange);
		check(finalConflicts.length === 0,
			`final-state detection should be empty after resolution, got ${JSON.stringify(finalConflicts)}`);

		await cleanupWorkspace(testDir, "final-1", c1);
		await cleanupWorkspace(testDir, "final-2", c2);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ final-state conflicts: per-squash stale, final tree authoritative (R3)");
}

// ─── Section 4: post-squash commit ids (R5) ──────────────────────────

async function testPostSquashCommitIds(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-cid-"));
	try {
		initRepo(testDir);
		const baseChange = await taskBaseChangeId(testDir);
		const baseIdPre = await resolveCommitId(testDir, baseChange);

		const w1 = await createWorkspace(testDir, "cid-1");
		const w2 = await createWorkspace(testDir, "cid-2");
		writeFileSync(join(w1, "a.txt"), "one\n", "utf-8");
		jj(["commit", "-m", "cid w1"], w1);
		writeFileSync(join(w2, "b.txt"), "two\n", "utf-8");
		jj(["commit", "-m", "cid w2"], w2);
		const ws1Commit = jj(["log", "-r", "@-", "-T", "commit_id", "--no-graph"], w1).trim();
		const ws2Commit = jj(["log", "-r", "@-", "-T", "commit_id", "--no-graph"], w2).trim();

		await mergeWorkspace(testDir, "cid-1", baseChange);
		await mergeWorkspace(testDir, "cid-2", baseChange);

		// R5: the base change's commit id resolved AFTER the last squash is
		// the surviving commit — the workers' pre-squash commits were
		// abandoned by `jj squash`, so returning THEIR ids would report dead
		// revisions.
		const baseIdPost = await resolveCommitId(testDir, baseChange);
		check(baseIdPost.length === 40, `resolved commit id should be a full id, got "${baseIdPost}"`);
		check(baseIdPost !== baseIdPre, "squashes rewrite the base commit (new commit id)");
		check(baseIdPost !== ws1Commit && baseIdPost !== ws2Commit,
			"the surviving id must not be a worker's pre-squash commit id");
		try {
			jj(["log", "-r", baseIdPost, "--no-graph", "-T", "commit_id"], testDir);
		} catch {
			errors.push(`[cid] resolved base commit id ${baseIdPost} does not resolve via jj log -r`);
		}

		await cleanupWorkspace(testDir, "cid-1", w1);
		await cleanupWorkspace(testDir, "cid-2", w2);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ post-squash commit ids: base change resolves to ONE surviving id (R5)");
}

// ─── Section 5: clean-working-copy guard (R1) ────────────────────────

async function testCleanWorkingCopyGuard(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-guard-"));
	try {
		initRepo(testDir);

		// Clean working copy → passes.
		await assertCleanWorkingCopy(testDir);

		// Untracked file (user WIP) → throws with the precise message + excerpt.
		writeFileSync(join(testDir, "stray.txt"), "user work in progress\n", "utf-8");
		try {
			await assertCleanWorkingCopy(testDir);
			errors.push("guard should throw on an untracked file");
		} catch (err) {
			const msg = (err as Error).message;
			check(msg.includes("task requires a clean working copy"), `guard message, got: ${msg}`);
			check(msg.includes("stray.txt"), `guard message should name the change in the status excerpt, got: ${msg}`);
		}

		// Removing it restores a clean state (the mutation-gate restore path).
		rmSync(join(testDir, "stray.txt"), { force: true });
		await assertCleanWorkingCopy(testDir);

		// Modified tracked file → throws too.
		writeFileSync(join(testDir, "README.md"), "# changed by the user\n", "utf-8");
		try {
			await assertCleanWorkingCopy(testDir);
			errors.push("guard should throw on a modified tracked file");
		} catch (err) {
			check((err as Error).message.includes("README.md"),
				`guard message should name the modified file, got: ${(err as Error).message}`);
		}
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ assertCleanWorkingCopy: clean passes, untracked/modified throw (R1)");
}

// ─── Section 2: conflict surfacing ───────────────────────────────────

/**
 * createAiTaskBase (todo #84): the parallel merge target is a fresh EMPTY
 * commit authored as the AI identity, parented on @-, described with the
 * spec goal — so squashing the workspaces' work into it produces an
 * AI-authored merged commit (jj squash keeps the destination's author).
 */
async function testAiTaskBase(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-ai-"));
	try {
		initRepo(testDir);
		const identityFile = join(testDir, "jj-identity.toml");
		writeFileSync(identityFile, aiIdentityToml("Pi (deepseek-v4-flash)", "noreply@danong.dev"), "utf-8");
		const baseChange = await createAiTaskBase(testDir, identityFile, "Handle UTF-8 BOM");

		check(baseChange === jj(["log", "-r", "@", "-T", "change_id", "--no-graph"], testDir).trim(),
			"createAiTaskBase returns the new @'s change id");
		const author = jj(["log", "-r", "@", "-T", 'author.name() ++ " <" ++ author.email() ++ ">"', "--no-graph"], testDir);
		check(author.includes("Pi (deepseek-v4-flash)") && author.includes("noreply@danong.dev"),
			`merged base authored as the AI identity, got: ${author.trim()}`);
		const parent = jj(["log", "-r", "@-", "-T", "description.first_line()", "--no-graph"], testDir);
		check(parent.trim() === "init", `parent is @- (the user's last commit), got: ${parent.trim()}`);
		const desc = jj(["log", "-r", "@", "-T", "description.first_line()", "--no-graph"], testDir);
		check(desc.trim() === "task: Handle UTF-8 BOM", `described with the spec goal, got: ${desc.trim()}`);
		const files = jj(["log", "-r", "@", "-T", "if(empty, 'EMPTY', 'X')", "--no-graph"], testDir);
		check(files.trim() === "EMPTY", `the base starts empty (workspaces' work lands via squash), got: ${files.trim()}`);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ AI-authored task base: identity + parent + goal description + empty tree");
}

/**
 * The single-worker identity lifecycle (todo #84 regression): the worker
 * works directly in the user's repo, so the orchestrator roots it on an
 * AI-authored base (createAiTaskBase). The worker's first jj commit
 * rewrites that base — author preserved, so the work commit is
 * AI-authored — and afterwards the restore step (`jj new` + abandoning
 * the empty leftover WC) returns the working copy to the user's identity.
 * Without this, the worker's first commit inherits the USER's WC author
 * and the user's next commit inherits the AI's.
 */
async function testSingleWorkerIdentity(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-id-"));
	try {
		initRepo(testDir);
		const userAuthor = jj(["log", "-r", "@-", "-T", "author.email()", "--no-graph"], testDir).trim();
		check(userAuthor.length > 0 && userAuthor !== "noreply@danong.dev",
			`the repo's default author is the user's (got ${userAuthor}) — test precondition`);
		const identityFile = join(testDir, "jj-identity.toml");
		writeFileSync(identityFile, aiIdentityToml("Pi (deepseek-v4-flash)", "noreply@danong.dev"), "utf-8");

		// 1. Orchestrator roots the worker on the AI-authored base.
		await createAiTaskBase(testDir, identityFile, "Implement feature");

		// 2. The worker commits under JJ_CONFIG (as spawnWorkerSession sets it).
		writeFileSync(join(testDir, "feature.txt"), "work\n", "utf-8");
		execFileSync("jj", ["commit", "-m", "implement feature"], {
			cwd: testDir,
			encoding: "utf8",
			env: { ...process.env, JJ_EDITOR: "true", JJ_CONFIG: identityFile },
		});

		// 3. The restore step from executeSingle's finally (user identity —
		// no JJ_CONFIG, the repo config's Test User applies).
		const restoreEnv = jjEnv();
		execFileSync("jj", ["new"], { cwd: testDir, encoding: "utf8", env: restoreEnv });
		const leftover = jj(["log", "-r", "@-", "-T", "if(empty, 'EMPTY', 'X')", "--no-graph"], testDir).trim();
		check(leftover === "EMPTY", `the worker's leftover WC is empty and abandoned, got: ${leftover}`);
		execFileSync("jj", ["abandon", "@-"], { cwd: testDir, encoding: "utf8", env: restoreEnv });

		// 4. Assertions: work is AI-authored, the WC is back to the user's
		// identity, and the history is clean (work directly on the user's
		// commit — no empty AI base, no empty leftover).
		const workAuthor = jj(["log", "-r", "@-", "-T", "author.email()", "--no-graph"], testDir).trim();
		check(workAuthor === "noreply@danong.dev", `the worker's commit is AI-authored, got: ${workAuthor}`);
		const wcAuthor = jj(["log", "-r", "@", "-T", "author.email()", "--no-graph"], testDir).trim();
		check(wcAuthor === userAuthor, `the restored WC is user-authored, got: ${wcAuthor}`);
		const parentDesc = jj(["log", "-r", "@-", "-T", "description.first_line()", "--no-graph"], testDir).trim();
		check(parentDesc === "implement feature", `the result commit is the worker's work, got: ${parentDesc}`);
		const grandparentDesc = jj(["log", "-r", "@--", "-T", "description.first_line()", "--no-graph"], testDir).trim();
		check(grandparentDesc === "init", `no empty AI base between the work and the user's commit, got: ${grandparentDesc}`);
		const wcEmpty = jj(["log", "-r", "@", "-T", "if(empty, 'EMPTY', 'X')", "--no-graph"], testDir).trim();
		check(wcEmpty === "EMPTY", `the restored WC is empty (no diff vs the work in @-), got: ${wcEmpty}`);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ single-worker identity: AI-authored work commit + user-authored restored WC, no empty leftovers");
}

async function testConflict(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-conf-"));
	try {
		initRepo(testDir);
		const baseChange = await taskBaseChangeId(testDir);

		const c1 = await createWorkspace(testDir, "conf-1");
		const c2 = await createWorkspace(testDir, "conf-2");

		writeFileSync(join(c1, "shared.txt"), "line1\nline2\nline3\n", "utf-8");
		jj(["commit", "-m", "conf c1"], c1);
		writeFileSync(join(c2, "shared.txt"), "line1\nCHANGED\nline3\n", "utf-8");
		jj(["commit", "-m", "conf c2"], c2);

		const out1 = await mergeWorkspace(testDir, "conf-1", baseChange);
		check(out1.conflicts.length === 0, `first merge should be clean, got ${JSON.stringify(out1.conflicts)}`);
		const out2 = await mergeWorkspace(testDir, "conf-2", baseChange);
		check(out2.conflicts.length === 1 && out2.conflicts[0] === "shared.txt",
			`expected conflict on shared.txt, got ${JSON.stringify(out2.conflicts)}`);

		// Conflict markers are visible in the main working copy
		const content = readFileSync(join(testDir, "shared.txt"), "utf-8");
		check(content.includes("<<<<<<<"), "conflict markers should be in the working copy");

		await cleanupWorkspace(testDir, "conf-1", c1);
		await cleanupWorkspace(testDir, "conf-2", c2);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ merge conflicts surfaced (paths + WC markers)");
}

// ─── Section 6: re-resolved squash targets (R1, todo #71) ────────────

async function testReResolvedSquashTargets(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-rer-"));
	try {
		initRepo(testDir);
		const baseChange = await taskBaseChangeId(testDir);

		const w1 = await createWorkspace(testDir, "rer-1");
		const w2 = await createWorkspace(testDir, "rer-2");
		writeFileSync(join(w1, "a.txt"), "one\n", "utf-8");
		jj(["commit", "-m", "rer w1"], w1);
		writeFileSync(join(w2, "b.txt"), "two\n", "utf-8");
		jj(["commit", "-m", "rer w2"], w2);

		// Merge w1 — rewrites the base in place (same change id, NEW commit id).
		await mergeWorkspace(testDir, "rer-1", baseChange);

		// A FOREIGN session (concurrent task run / user) rewrites the base
		// AGAIN between the merges. The second mergeWorkspace's internal
		// re-resolution must pick the CURRENT commit id — squashing into the
		// pre-rewrite id is todo #71's corruption mode.
		const foreign = await createWorkspace(testDir, "rer-f");
		writeFileSync(join(foreign, "foreign.txt"), "foreign\n", "utf-8");
		jj(["commit", "-m", "rer foreign"], foreign);
		await mergeWorkspace(testDir, "rer-f", baseChange);

		// The second worker merge must land its changes in the CURRENT base.
		await mergeWorkspace(testDir, "rer-2", baseChange);

		// Provable integration: every workspace + the main working copy sit
		// on the current base, and the final base holds EVERY change.
		await assertMerged(testDir, ["rer-1", "rer-2", "rer-f"], baseChange, { expectedFiles: ["a.txt", "b.txt", "foreign.txt"] });

		for (const f of ["a.txt", "b.txt", "foreign.txt"]) {
			check(existsSync(join(testDir, f)), `${f} should be in the merged tree`);
		}
		check(jj(["st"], testDir).includes("The working copy has no changes"),
			"main working copy should be clean after the merges");

		// The base change must resolve to EXACTLY ONE visible commit — no
		// divergence, no work stranded in a hidden/pre-rewrite revision.
		let baseIds = "";
		try {
			baseIds = jj(["log", "-r", baseChange, "--no-graph", "-T", "commit_id"], testDir).trim();
		} catch (err) {
			errors.push(`base change should resolve (got jj error: ${(err as Error).message})`);
		}
		check(/^[0-9a-f]{40}$/.test(baseIds),
			`base change should resolve to ONE commit id, got: ${JSON.stringify(baseIds)}`);
		const mainParent = jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], testDir).trim();
		check(mainParent === baseIds, `main @- should BE the merged base, got ${mainParent} vs ${baseIds}`);

		await cleanupWorkspace(testDir, "rer-1", w1);
		await cleanupWorkspace(testDir, "rer-2", w2);
		await cleanupWorkspace(testDir, "rer-f", foreign);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ re-resolved squash targets: foreign base rewrite between merges lands in the CURRENT base (R1)");
}

// ─── Section 7: provable-integration gate (R2, todo #71 obs 3) ───────

/** Leftover diff summary lines between two revs (explicit ids, no snapshot). */
function diffLines(projectDir: string, from: string, to: string): string[] {
	return execFileSync("jj", ["diff", "--from", from, "--to", to, "--summary"], {
		cwd: projectDir,
		encoding: "utf8",
		env: { ...process.env, JJ_EDITOR: "true" },
	})
		.split("\n")
		.filter((l) => l.trim().length > 0);
}

async function testMergeIntegrityGate(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-gate-"));
	try {
		initRepo(testDir);
		const baseChange = await taskBaseChangeId(testDir);

		const w1 = await createWorkspace(testDir, "gate-1");
		const w2 = await createWorkspace(testDir, "gate-2");
		writeFileSync(join(w1, "a.txt"), "one\n", "utf-8");
		jj(["commit", "-m", "gate w1"], w1);
		writeFileSync(join(w2, "b.txt"), "two\n", "utf-8");
		jj(["commit", "-m", "gate w2"], w2);

		// Merge ONLY w1 — w2's work is still outside the base. The gate must
		// fail loudly, naming the unmerged workspace, instead of letting
		// verification pass trivially on a tree without the integrated work.
		await mergeWorkspace(testDir, "gate-1", baseChange);
		try {
			await assertMerged(testDir, ["gate-1", "gate-2"], baseChange, { expectedFiles: ["a.txt", "b.txt"] });
			errors.push("assertMerged should fail when a workspace was never merged");
		} catch (err) {
			const msg = (err as Error).message;
			check(msg.includes("did NOT integrate"), `gate error should say the merge is not integrated, got: ${msg}`);
			check(msg.includes("b.txt"), `gate error should name the stranded file, got: ${msg}`);
		}

		// Merge w2 properly — the gate now passes.
		await mergeWorkspace(testDir, "gate-2", baseChange);
		await assertMerged(testDir, ["gate-1", "gate-2"], baseChange, { expectedFiles: ["a.txt", "b.txt"] });
		check(existsSync(join(testDir, "a.txt")) && existsSync(join(testDir, "b.txt")),
			"both workers' files should be in the merged tree");

		await cleanupWorkspace(testDir, "gate-1", w1);
		await cleanupWorkspace(testDir, "gate-2", w2);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ provable-integration gate: unmerged workspace fails loud, merged passes (R2)");
}

async function testStaleTargetSurfaced(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-stale-"));
	try {
		initRepo(testDir);
		const baseChange = await taskBaseChangeId(testDir);
		const baseIdPre = await resolveCommitId(testDir, baseChange);

		const w1 = await createWorkspace(testDir, "stale-1");
		const w2 = await createWorkspace(testDir, "stale-2");
		writeFileSync(join(w1, "a.txt"), "one\n", "utf-8");
		jj(["commit", "-m", "stale w1"], w1);
		writeFileSync(join(w2, "b.txt"), "two\n", "utf-8");
		jj(["commit", "-m", "stale w2"], w2);

		// Merge w1 legitimately (base rewritten: pre-rewrite id -> new id).
		await mergeWorkspace(testDir, "stale-1", baseChange);

		// Reproduce todo #71's corruption: a merge that squashes into the
		// STALE pre-rewrite base id (the resolution raced a concurrent base
		// rewrite). The work lands in a hidden revision, the visible base and
		// the main working copy end up without it — the exact state where a
		// green verification on the working copy reported a successful run.
		const ws2At = jj(["workspace", "list"], testDir)
			.split("\n")
			.find((l) => l.startsWith("stale-2:"))!
			.split(/\s+/)[2];
		jj(["squash", "--from", `${baseIdPre}..${ws2At}`, "--into", baseIdPre], testDir);

		// The corrupted merge must be surfaced — the gate refuses to verify a
		// tree without the integrated work (and the base change no longer
		// resolves to a visible commit holding it).
		try {
			await assertMerged(testDir, ["stale-1", "stale-2"], baseChange, { expectedFiles: ["a.txt", "b.txt"] });
			errors.push("assertMerged should fail after a stale-target squash (work in hidden revision)");
		} catch (err) {
			const msg = (err as Error).message;
			check(msg.length > 0 && !msg.includes("unexpected"),
				`stale-target corruption should fail with a precise error, got: ${msg}`);
		}
		// The corrupted state matches the observation: the main working copy
		// holds NO changes (its chain was detached from the rewritten base).
		check(diffLines(testDir, "@-", "@").length === 0,
			"corrupted main working copy should show no changes (verification would pass trivially)");

		await cleanupWorkspace(testDir, "stale-1", w1);
		await cleanupWorkspace(testDir, "stale-2", w2);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ stale squash target surfaced: work in hidden revision fails the gate (R2)");
}

// ─── Section 8b: assertVisibleCommit — a hidden base fails loud (R2) ──

async function testAssertVisibleCommit(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-visible-"));
	try {
		initRepo(testDir);
		const baseChange = await taskBaseChangeId(testDir);
		// Visible base → passes.
		await assertVisibleCommit(testDir, baseChange);

		// Hide the base change (abandon its visible commit) — the todo #71
		// corruption can leave the base chain fully hidden; resolution then
		// yields the 40-zero commit id and assertVisibleCommit must fail
		// loud instead of letting assertMerged surface a raw jj error.
		jj(["abandon", await resolveCommitId(testDir, baseChange)], testDir);
		let threw = "";
		try {
			await assertVisibleCommit(testDir, baseChange);
		} catch (err) {
			threw = (err as Error).message;
		}
		check(threw.includes("NO visible commit"), `hidden base must fail loud, got: ${JSON.stringify(threw)}`);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ assertVisibleCommit: hidden base change fails loud, visible passes (R2)");
}

// ─── Section 8: divergent change resolution (R1) — divergence is
// manufactured by racing concurrent jj commits (the wild's signature);
// if jj reconciles cleanly the race-dependent checks warn-and-skip ─────

async function testDivergentChangeResolution(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-div-"));
	try {
		initRepo(testDir);

		// Build a REAL divergent change the way the wild produces one:
		// concurrent commits from two workspaces fork the op log (jj 0.43
		// reconciles with "Concurrent modification detected", leaving
		// divergent changes — todo #70's rewrite signature).
		const d1 = await createWorkspace(testDir, "div-1");
		const d2 = await createWorkspace(testDir, "div-2");
		// Build a REAL divergent change the way the wild produces one:
		// concurrent commits from two workspaces fork the op log (jj 0.43
		// auto-reconciles with "Concurrent modification detected", leaving
		// divergent changes — todo #70's rewrite signature). Under heavy
		// racing a commit can hit jj's sibling-op internal error instead;
		// tolerate that and heal the op log (the error's own hint) before
		// querying. Up to three rounds of racing pairs.
		let divergent = "";
		for (let round = 0; round < 3 && divergent.length === 0; round++) {
			const pairs = Array.from({ length: 5 }, (_, i) => i + round * 5);
			await Promise.allSettled(
				pairs.flatMap((i) => [
					(async () => {
						writeFileSync(join(d1, `d1-${i}.txt`), `${i}\n`, "utf-8");
						await jjAsync(["commit", "-m", `div d1 c${i}`], d1);
					})(),
					(async () => {
						writeFileSync(join(d2, `d2-${i}.txt`), `${i}\n`, "utf-8");
						await jjAsync(["commit", "-m", `div d2 c${i}`], d2);
					})(),
				]),
			);
			try {
				divergent = jj(["log", "-r", "divergent()", "--no-graph", "-T", "change_id"], testDir).trim();
			} catch (err) {
				// jj 0.43's sibling-op internal error leaves the op log
				// unhealed — integrate the working copy's op (its own hint).
				const m = /op integrate ([0-9a-f]+)/.exec((err as Error).message);
				if (m) {
					try {
						jj(["op", "integrate", m[1]], testDir);
					} catch {
						/* already healed by a later racer */
					}
				}
				divergent = jj(["log", "-r", "divergent()", "--no-graph", "-T", "change_id"], testDir).trim();
			}
		}
		if (divergent.length === 0) {
			// jj 0.43's concurrent-commit reconciliation sometimes serializes
			// cleanly (no "Concurrent modification detected" artifact), so the
			// racing pair leaves NO divergent change. The divergence checks
			// below are ours (resolveCommitId must fail loudly) and only apply
			// when the race actually forked the op log — warn loudly instead of
			// failing: producing the artifact is jj's timing, not this package's
			// behavior. The shape + hidden-commit checks still run.
			console.warn("  ⚠ jj race produced no divergent change — skipping the R1 divergence-resolution checks");
		} else {
			const changeId = divergent.slice(0, 12);
			try {
				await resolveCommitId(testDir, changeId);
				errors.push(`resolveCommitId should fail loudly on divergent change ${changeId}`);
			} catch (err) {
				const msg = (err as Error).message;
				check(msg.includes("DIVERGENT"), `divergence error should be explicit, got: ${msg}`);
			}
		}

		// Shape validation: multi-match output (any revset resolving to more
		// than one commit) must also be rejected, never concatenated into a
		// bogus target id.
		try {
			await resolveCommitId(testDir, "@ | @-");
			errors.push("resolveCommitId should reject multi-commit output");
		} catch (err) {
			check((err as Error).message.includes("single 40-hex"),
				`multi-match error should mention the shape check, got: ${(err as Error).message}`);
		}

		// A change with NO visible commit (all hidden/abandoned) is rejected
		// with a hint, not silently resolved.
		const hidden = jj(["log", "-r", "hidden()", "--no-graph", "-T", "change_id"], testDir).trim();
		if (hidden.length > 0) {
			try {
				await resolveCommitId(testDir, hidden.slice(0, 12));
				errors.push("resolveCommitId should reject a change with no visible commit");
			} catch (err) {
				check((err as Error).message.includes("hidden"),
					`no-visible-commit error should mention hidden, got: ${(err as Error).message}`);
			}
		}

		await cleanupWorkspace(testDir, "div-1", d1);
		await cleanupWorkspace(testDir, "div-2", d2);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ divergent change resolution: loud failure, never an arbitrary pick (R1)");
}

// ─── Section 9: fork-proof read-only commands (R3, todo #70) ─────────

/** Ops in the op store (colocated jj 0.43 layout) — unambiguous, no jj call. */
function opCount(projectDir: string): number {
	return readdirSync(join(projectDir, ".jj", "repo", "op_store", "operations")).length;
}

async function testForkProofReadOnly(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-fork-"));
	try {
		initRepo(testDir);

		// (a) The flag is load-bearing: a read-only command SNAPSHOTS a dirty
		// working copy without it (writes an op — the race source) and writes
		// NOTHING with it.
		writeFileSync(join(testDir, "dirty.txt"), "wip\n", "utf-8");
		const n0 = opCount(testDir);
		jj(["diff", "--from", "@-", "--to", "@", "--summary", "--ignore-working-copy"], testDir);
		check(opCount(testDir) === n0, "--ignore-working-copy read-only command must not write an op");
		jj(["diff", "--from", "@-", "--to", "@", "--summary"], testDir);
		check(opCount(testDir) === n0 + 1, "read-only command WITHOUT the flag writes a snapshot op");
		jj(["commit", "-m", "dirty"], testDir); // back to a clean working copy

		// (b) Concurrent worker commits + orchestrator read-only commands
		// (with the flag): no op-log fork, no rewritten/duplicated commits.
		const readOnlyOps: Array<() => Promise<string>> = [
			() => jjAsync(["diff", "--from", "@-", "--to", "@", "--summary", "--ignore-working-copy"], testDir),
			() => jjAsync(["log", "-r", "@-", "-T", "change_id", "--no-graph", "--ignore-working-copy"], testDir),
			() => jjAsync(["file", "list", "--ignore-working-copy"], testDir),
		];
		const commits: string[] = [];
		for (let i = 0; i < 4; i++) {
			writeFileSync(join(testDir, `race-${i}.txt`), `race ${i}\n`, "utf-8");
			// Truly concurrent child processes: the commit's snapshot+commit
			// ops and the read-only command run at the same time.
			await Promise.all([
				(async () => {
					await jjAsync(["commit", "-m", `race c${i}`], testDir);
				})(),
				readOnlyOps[i % readOnlyOps.length](),
			]);
			commits.push(jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], testDir).trim());
		}

		// No op-log fork: jj reconciles forks with a "Concurrent modification
		// detected" op — its absence proves every op was written in one chain.
		const oplog = jj(["op", "log", "--no-graph"], testDir);
		check(
			!oplog.includes("reconcile") && !oplog.includes("Concurrent modification"),
			"concurrent read-only commands must not fork the op log",
		);
		// Every worker commit survived intact: visible, right description,
		// no duplicate/divergent change.
		for (let i = 0; i < commits.length; i++) {
			const c = jj(["log", "-r", commits[i], "--no-graph", "-T", `description ++ " hidden=" ++ hidden`], testDir);
			check(
				c.includes(`race c${i}`) && !c.includes("hidden=true"),
				`commit ${i} should be visible and intact, got: ${JSON.stringify(c)}`,
			);
		}
		const divergent = jj(["log", "-r", "divergent()", "--no-graph", "-T", "change_id"], testDir).trim();
		check(divergent.length === 0, `no divergent changes expected, got: ${divergent.slice(0, 40)}`);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ fork-proof read-only commands: no snapshot ops, no op-log fork under concurrency (R3)");
}

// ─── Section 10: atomic combine (R1) ────────────────────────────────

/**
 * R1: ALL worker commits land in the task base in ONE jj operation — a
 * single squash of every workspace range. No incremental per-workspace
 * squash into a moving base, so a mid-loop failure can no longer leave a
 * partial merge. Proof: the op-store delta across mergeWorkspacesAtomic
 * is EXACTLY ONE, and every workspace @ ends up on the rewritten base
 * with zero remaining diff.
 */
async function testAtomicCombine(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-atomic-"));
	try {
		initRepo(testDir);
		const baseChange = await taskBaseChangeId(testDir);

		const w1 = await createWorkspace(testDir, "atom-1");
		const w2 = await createWorkspace(testDir, "atom-2");
		const w3 = await createWorkspace(testDir, "atom-3");

		// w1 makes TWO commits (multi-commit range), w2/w3 one each.
		writeFileSync(join(w1, "a1.txt"), "one\n", "utf-8");
		jj(["commit", "-m", "atom w1 c1"], w1);
		writeFileSync(join(w1, "a2.txt"), "two\n", "utf-8");
		jj(["commit", "-m", "atom w1 c2"], w1);
		writeFileSync(join(w2, "b.txt"), "three\n", "utf-8");
		jj(["commit", "-m", "atom w2"], w2);
		writeFileSync(join(w3, "c.txt"), "four\n", "utf-8");
		jj(["commit", "-m", "atom w3"], w3);

		const opsBefore = opCount(testDir);
		const outcome = await mergeWorkspacesAtomic(testDir, ["atom-1", "atom-2", "atom-3"], baseChange);
		const opsAfter = opCount(testDir);

		check(opsAfter - opsBefore === 1,
			`atomic combine must be ONE jj operation (op delta ${opsAfter - opsBefore})`);
		check(outcome.conflicts.length === 0,
			`atomic combine should be clean, got ${JSON.stringify(outcome.conflicts)}`);
		check(outcome.commit_id.length > 0 && outcome.files_changed === 4,
			`merge outcome should carry the merged commit + file count (4 files), got ${outcome.commit_id} / ${outcome.files_changed}`);

		// Every worker's content is in the merged tree (main working copy).
		for (const f of ["a1.txt", "a2.txt", "b.txt", "c.txt"]) {
			check(existsSync(join(testDir, f)), `${f} should be in the merged tree`);
		}
		check(jj(["st"], testDir).includes("The working copy has no changes"),
			"main working copy clean after the atomic combine");

		// Provable integration: every workspace @ sits on the current base,
		// diff-empty, and the base resolves to ONE visible commit.
		await assertMerged(testDir, ["atom-1", "atom-2", "atom-3"], baseChange, {
			expectedFiles: ["a1.txt", "a2.txt", "b.txt", "c.txt"],
		});
		const baseId = await resolveCommitId(testDir, baseChange);
		const mainParent = jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], testDir).trim();
		check(mainParent === baseId, `main @- should BE the merged base, got ${mainParent} vs ${baseId}`);

		// Cleanup still works (workspaces are empty after the combine).
		await cleanupWorkspace(testDir, "atom-1", w1);
		await cleanupWorkspace(testDir, "atom-2", w2);
		await cleanupWorkspace(testDir, "atom-3", w3);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ atomic combine: N workspaces in ONE jj op, all content present (R1)");
}

// ─── Section 11: consistency gate catches dangling commits (R3) ──────

/**
 * R3: the post-merge consistency gate is a HARD gate — every workspace's
 * @ must be a DESCENDANT of the merged result (not merely diff-equal on
 * some other chain), the merged tree non-empty, and the union of worker
 * file changes present. A dangling commit (work stranded outside the
 * merged result — the todo #71 corruption mode) fails loud, never a
 * false success.
 */
async function testConsistencyGateDangling(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-dangle-"));
	try {
		initRepo(testDir);
		// A second commit makes the repo root a proper ancestor of the task
		// base: the dangling manufacture below roots the worker's chain at
		// the ROOT (a visible ancestor of everything — the base change must
		// NOT diverge; rebasing onto the old hidden base commit would
		// resurrect it and make the change divergent).
		const rootCommitId = jj(["log", "-r", "@-", "-T", "commit_id", "--no-graph"], testDir).trim();
		writeFileSync(join(testDir, "base.txt"), "base\n", "utf-8");
		jj(["commit", "-m", "base"], testDir);
		const baseChange = await taskBaseChangeId(testDir);

		const w1 = await createWorkspace(testDir, "dang-1");
		const w2 = await createWorkspace(testDir, "dang-2");
		writeFileSync(join(w1, "a.txt"), "one\n", "utf-8");
		jj(["commit", "-m", "dang w1"], w1);
		// Worker 2 commits on a DETACHED revision (the dangling class the
		// gate must catch): the workspace @ is rooted at the repo ROOT, not
		// the task base — its commits are unreachable from the merged
		// result. (`jj rebase -d <root>` would be a no-op — everything
		// descends from the root.)
		jj(["new", rootCommitId, "-m", "detached"], w2);
		writeFileSync(join(w2, "b.txt"), "two\n", "utf-8");
		jj(["commit", "-m", "dang w2"], w2);

		// Merge ONLY w1 — w2's work is still outside the base.
		await mergeWorkspacesAtomic(testDir, ["dang-1"], baseChange);

		// The gate must fail loud, naming the dangling workspace — never
		// let verification run on a tree without the integrated work.
		try {
			await assertMerged(testDir, ["dang-1", "dang-2"], baseChange, {
				expectedFiles: ["a.txt", "b.txt"],
			});
			errors.push("assertMerged should fail when a workspace commit dangles outside the merged result");
		} catch (err) {
			const msg = (err as Error).message;
			check(msg.includes("merged tree is missing"), `gate should report the missing union file, got: ${msg}`);
			check(msg.includes("b.txt"), `gate error should name the stranded file, got: ${msg}`);
		}

		// The union-file-presence half of the gate: a file the workers
		// changed but the merged tree lacks fails too.
		try {
			await assertMerged(testDir, ["dang-1"], baseChange, {
				expectedFiles: ["a.txt", "never-written.txt"],
			});
			errors.push("assertMerged should fail when a worker file is missing from the merged tree");
		} catch (err) {
			check((err as Error).message.includes("never-written.txt"),
				`missing-file error should name the file, got: ${(err as Error).message}`);
		}

		// Recovery: move the detached chain (work commit + empty @) back
		// onto the merged base and merge it — the gate then passes
		// (scripted recovery works).
		const ws2At = jj(["workspace", "list"], testDir)
			.split("\n")
			.find((l) => l.startsWith("dang-2:"))!
			.split(/\s+/)[2];
		const work2 = jj(["log", "-r", `${ws2At}-`, "-T", "commit_id", "--no-graph"], testDir).trim();
		jj(["rebase", "-s", work2, "-d", await resolveCommitId(testDir, baseChange)], testDir);
		await mergeWorkspacesAtomic(testDir, ["dang-2"], baseChange);
		await assertMerged(testDir, ["dang-1", "dang-2"], baseChange, {
			expectedFiles: ["a.txt", "b.txt"],
		});
		check(existsSync(join(testDir, "a.txt")) && existsSync(join(testDir, "b.txt")),
			"both workers' files in the merged tree after recovery");

		await cleanupWorkspace(testDir, "dang-1", w1);
		await cleanupWorkspace(testDir, "dang-2", w2);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ consistency gate: dangling commit fails loud, recovery + union files verified (R3)");
}

// ─── Section 12: deterministic union ladder (R4) ─────────────────────

/**
 * R4: the deterministic conflict ladder — jj 3-way merge first (inside
 * the squash); each remaining conflicted file resolves via the jj-native
 * "union" merge tool (git merge-file --union). Comment-only conflicts
 * resolve with both versions kept; substantive text conflicts also
 * resolve (both sides unioned); binary conflicts FAIL the union tool and
 * remain conflicted (escalation — never a false "resolved").
 */
async function testUnionLadder(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-union-"));
	try {
		initRepo(testDir);
		writeFileSync(join(testDir, "comments.txt"), "// base note\ncode\n", "utf-8");
		writeFileSync(join(testDir, "code.txt"), "line1\nline2\nline3\n", "utf-8");
		writeFileSync(join(testDir, "blob.bin"), Buffer.from([0, 1, 2, 3, 4]));
		jj(["commit", "-m", "base files"], testDir);
		const baseChange = await taskBaseChangeId(testDir);

		const w1 = await createWorkspace(testDir, "uni-1");
		const w2 = await createWorkspace(testDir, "uni-2");
		// Both workers touch all three files; the two text files conflict
		// (same lines changed differently), the binary file conflicts too.
		writeFileSync(join(w1, "comments.txt"), "// worker one\ncode\n", "utf-8");
		writeFileSync(join(w1, "code.txt"), "line1\nLEFT\nline3\n", "utf-8");
		writeFileSync(join(w1, "blob.bin"), Buffer.from([9, 9, 9, 9]));
		jj(["commit", "-m", "uni w1"], w1);
		writeFileSync(join(w2, "comments.txt"), "// worker two\ncode\n", "utf-8");
		writeFileSync(join(w2, "code.txt"), "line1\nRIGHT\nline3\n", "utf-8");
		writeFileSync(join(w2, "blob.bin"), Buffer.from([8, 8, 8, 8, 8, 8]));
		jj(["commit", "-m", "uni w2"], w2);

		await mergeWorkspacesAtomic(testDir, ["uni-1", "uni-2"], baseChange);
		const conflictsBefore = await detectChangeConflicts(testDir, baseChange);
		check(conflictsBefore.length === 3, `expected 3 conflicts, got ${JSON.stringify(conflictsBefore)}`);

		// Rung 2: the union tool — text conflicts resolve deterministically.
		await resolveConflictsWithUnion(testDir, baseChange, conflictsBefore);
		const conflictsAfter = await detectChangeConflicts(testDir, baseChange);

		check(!conflictsAfter.includes("comments.txt"),
			"comment-only conflict should resolve via the union tool");
		const comments = readFileSync(join(testDir, "comments.txt"), "utf-8");
		check(comments.includes("// worker one") && comments.includes("// worker two"),
			`union should keep BOTH comment versions, got: ${JSON.stringify(comments)}`);
		check(!comments.includes("<<<<<<<"), "no conflict markers may remain after the union tool");

		check(!conflictsAfter.includes("code.txt"), "substantive text conflict should also resolve via union");
		const code = readFileSync(join(testDir, "code.txt"), "utf-8");
		check(code.includes("LEFT") && code.includes("RIGHT"),
			`union should keep BOTH code versions, got: ${JSON.stringify(code)}`);

		// Binary conflicts: git merge-file fails (exit 255) → the conflict
		// REMAINS — escalation, never a false "resolved" with empty content.
		check(conflictsAfter.includes("blob.bin"),
			`binary conflict must remain after the union tool (escalation), got ${JSON.stringify(conflictsAfter)}`);

		// Escalation payload: the conflicted hunks are retrievable (bounded).
		const hunks = await conflictHunks(testDir, baseChange, ["blob.bin"]);
		check("blob.bin" in hunks && hunks["blob.bin"].length > 0, "conflict hunks retrievable for escalation");

		await cleanupWorkspace(testDir, "uni-1", w1);
		await cleanupWorkspace(testDir, "uni-2", w2);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ union ladder: comment + substantive conflicts resolved, binary escalates (R4)");
}

// ─── Section 13: summary parsing (R3/R5 input) ───────────────────────

/** parseSummaryChanges: jj diff --summary lines → path + kind (renames
 *  resolve to the NEW path). Pure. */
function testParseSummaryChanges(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const changes = parseSummaryChanges(["M shared.txt", "A new.txt", "D old.txt", "R {a.txt => renamed.txt}"]);
	check(changes.length === 4, `expected 4 changes, got ${changes.length}`);
	check(changes[0].kind === "M" && changes[0].file === "shared.txt", "modified change parsed");
	check(changes[1].kind === "A" && changes[1].file === "new.txt", "added change parsed");
	check(changes[2].kind === "D" && changes[2].file === "old.txt", "deleted change parsed");
	check(changes[3].kind === "R" && changes[3].file === "renamed.txt",
		`rename should resolve to the NEW path, got ${JSON.stringify(changes[3])}`);
	check(parseSummaryChanges([]).length === 0, "empty input → empty changes");
	check(parseSummaryChanges(["   ", "junk"]).length === 0, "blank/garbage lines skipped");

	console.log("✓ parseSummaryChanges: kinds + rename-to-new-path (R3/R5 input)");
}

// ─── Rescue-commit for an aborted single-worker's WIP ────────────────

async function testRescueAbortedWork(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-rescue-"));
	try {
		initRepo(testDir);
		// Dirty working copy (untracked WIP) → rescue commit preserves it.
		writeFileSync(join(testDir, "wip.txt"), "half-done\n", "utf-8");
		await rescueAbortedWorkBestEffort(testDir, new Error("wall-clock budget expired"));
		const msg = jj(["log", "-r", "@-", "--no-graph", "-T", "description.first_line()"], testDir).trim();
		check(msg.startsWith("rescue: aborted task run"), `rescue commit named, got: ${msg}`);
		check(existsSync(join(testDir, "wip.txt")), "rescued file survives in the working copy");
		check(jj(["file", "list"], testDir).includes("wip.txt"), "rescued file tracked in the rescue commit");

		// Clean working copy → NO rescue commit created.
		jj(["new"], testDir);
		const before = jj(["log", "-r", "all()", "-T", "description.first_line()"], testDir).trim().length;
		await rescueAbortedWorkBestEffort(testDir, new Error("worker error"));
		const after = jj(["log", "-r", "all()", "-T", "description.first_line()"], testDir).trim().length;
		check(before === after, "clean working copy → no rescue commit");
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ rescue-commit: aborted single-worker WIP preserved (dirty), skipped when clean");
}

// ─── assertWorkspacesConsumed: the post-squash invariant ─────────────
// The false-alarm regression: an EMPTY workspace @ left on the PRE-merge
// base (jj does not always auto-rebase) must PASS the check — diffing it
// against the rewritten base would report every merged file as a
// deletion (the "left changes OUTSIDE the merged base" false alarm). A
// workspace with genuinely unconsumed changes must FAIL.

async function testWorkspacesConsumed(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-consumed-"));
	try {
		initRepo(testDir);
		const baseChange = await taskBaseChangeId(testDir);
		const baseBefore = await resolveCommitId(testDir, baseChange);

		const w1 = await createWorkspace(testDir, "con-1");
		const w2 = await createWorkspace(testDir, "con-2");
		writeFileSync(join(w1, "x.txt"), "one\n", "utf-8");
		jj(["commit", "-m", "con w1"], w1);
		writeFileSync(join(w2, "y.txt"), "two\n", "utf-8");
		jj(["commit", "-m", "con w2"], w2);

		const outcome = await mergeWorkspacesAtomic(testDir, ["con-1", "con-2"], baseChange);
		check(outcome.commit_id.length > 0 && outcome.files_changed === 2,
			`atomic outcome fields, got ${outcome.commit_id} / ${outcome.files_changed}`);

		// False-alarm regression: move ws-@ BACK onto the pre-merge base
		// (jj sometimes leaves empty workspace stubs there instead of
		// auto-rebasing them onto the rewritten base). The check must still
		// PASS — an empty stub has no changes vs its own parent.
		const w1At = await workspaceCommitId(testDir, "con-1");
		jj(["rebase", "-s", w1At, "-o", baseBefore], testDir);
		await assertWorkspacesConsumed(testDir, ["con-1", "con-2"]);

		// Real leftover: a workspace whose snapshot holds UNCONSUMED changes
		// (uncommitted working-copy work — the squash consumed committed
		// content; anything left in the workspace's own commit is either
		// unconsumed or was added after the combine) must FAIL the check
		// with a message naming it. Committed content the combine never saw
		// is out of this check's scope (the atomic squash consumes every
		// included workspace atomically or fails as one operation).
		const w3 = await createWorkspace(testDir, "con-3");
		writeFileSync(join(w3, "z.txt"), "three\n", "utf-8"); // NOT committed
		jj(["st"], w3); // trigger the snapshot so ws-@ actually holds z.txt
		let threw = "";
		try {
			await assertWorkspacesConsumed(testDir, ["con-1", "con-2", "con-3"]);
		} catch (err) {
			threw = (err as Error).message;
		}
		check(threw.includes("con-3") && threw.includes("did not fully consume"),
			`leftover workspace must fail with a precise message, got: ${threw}`);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ assertWorkspacesConsumed: empty stub on the pre-merge base passes (false-alarm fix); unconsumed work fails");
}

// ─── assertMerged: the unrebased-stub regression (R3 gate) ───────────
// The exact false-alarm from the field: jj leaves the (empty) workspace
// stubs on the PRE-merge base instead of auto-rebasing them onto the
// rewritten base. The old gate checked reachability + diff against the
// merged base and reported a successful merge as "NOT a descendant" /
// "changes outside the merged base". The gate must PASS for that shape —
// the union checks (merged tree + working tree) are the invariants.

async function testAssertMergedUnrebasedStub(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-stubgate-"));
	try {
		initRepo(testDir);
		const baseChange = await taskBaseChangeId(testDir);
		// The repo ROOT — a visible ancestor of everything (never rewritten):
		// rebasing onto it can't resurrect a rewritten change / diverge it.
		const rootCommitId = jj(["log", "-r", "root()", "--no-graph", "-T", "commit_id"], testDir).trim();

		const w1 = await createWorkspace(testDir, "sg-1");
		const w2 = await createWorkspace(testDir, "sg-2");
		writeFileSync(join(w1, "a.txt"), "one\n", "utf-8");
		jj(["commit", "-m", "sg w1"], w1);
		writeFileSync(join(w2, "b.txt"), "two\n", "utf-8");
		jj(["commit", "-m", "sg w2"], w2);

		const outcome = await mergeWorkspacesAtomic(testDir, ["sg-1", "sg-2"], baseChange);
		check(outcome.files_changed === 2, `atomic outcome, got ${outcome.files_changed}`);

		// Normal shape (stubs rebased): the gate passes.
		await assertMerged(testDir, ["sg-1", "sg-2"], baseChange, { expectedFiles: ["a.txt", "b.txt"] });

		// Unrebased-stub shape: move ws-@ BACK onto the pre-merge base — the
		// empty stub is no longer a descendant of the merged base and its tree
		// lacks the merged files. The gate must STILL pass (the stub is
		// throwaway; the merged tree + working tree hold the union).
		const w1At = await workspaceCommitId(testDir, "sg-1");
		jj(["rebase", "-s", w1At, "-o", rootCommitId], testDir);
		await assertMerged(testDir, ["sg-1", "sg-2"], baseChange, { expectedFiles: ["a.txt", "b.txt"] });
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ assertMerged: unrebased empty stubs pass (false-alarm regression); union checks gate");
}

// ─── R5: bounded jj calls ────────────────────────────────────────────

/** R5: execJj is bounded — default ~120s, overridable per call, and a
 *  wedged command (the failure path resolves workspace commit ids on
 *  possibly-wedged workspaces) can never hang the abort. */
async function testJjTimeoutBounded(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-timeout-"));
	try {
		initRepo(testDir);

		// The default bound is ~120s (R5).
		check(DEFAULT_JJ_TIMEOUT_MS === 120_000, `default jj bound should be 120s, got ${DEFAULT_JJ_TIMEOUT_MS}`);

		// A normal call: bounded, succeeds, no timeout flag.
		const ok = await execJj(["status"], testDir);
		check(ok.code === 0, `jj status should succeed, got code ${ok.code}: ${ok.stderr.trim()}`);
		check(ok.timedOut !== true, "no timedOut flag on a clean call");

		// A 1ms bound: the call is killed — it must return (bounded), report
		// timedOut, and carry a stderr note naming the bound. (jj process
		// startup alone far exceeds 1ms, so this is deterministic.)
		const t0 = Date.now();
		const timed = await execJj(["status"], testDir, { timeoutMs: 1 });
		const elapsed = Date.now() - t0;
		check(timed.timedOut === true,
			`a 1ms bound must time out, got code ${timed.code} timedOut ${timed.timedOut}`);
		check(elapsed < 5000, `timed-out call must return quickly (took ${elapsed}ms)`);
		check(timed.stderr.includes("timed out"), "timeout note in stderr");

		// The failure path's tighter bound is honored through
		// workspaceCommitId's opts pass-through (a wedged workspace can never
		// stall the abort): a 1ms bound surfaces as an error message naming
		// the timeout instead of hanging.
		let msg = "";
		try {
			await workspaceCommitId(testDir, "no-such-workspace", { timeoutMs: 1 });
		} catch (err) {
			msg = (err as Error).message;
		}
		check(msg.includes("timed out"), `wedged-workspace resolution is bounded, got: ${JSON.stringify(msg)}`);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ execJj timeout: bounded by default, overridable per call, failure path can't hang (R5)");
}

// ─── R3: rescue uncommitted workspace state ──────────────────────────

/** R3: on parallel worker failure, each preserved workspace's uncommitted
 *  state is captured by a rescue commit INSIDE the workspace ("rescue:
 *  aborted task run (<cause>)") — untracked files and scratch under the
 *  workspace's /tmp included. The returned id is what the failure artifact
 *  records as where the uncommitted state lives. */
async function testRescueWorkspaceState(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-rescws-"));
	try {
		initRepo(testDir);
		const baseChange = await taskBaseChangeId(testDir);

		const w1 = await createWorkspace(testDir, "rescws-1");
		// The worker committed real work, then left a dirty working copy
		// (uncommitted WIP + scratch under the workspace's tmp/).
		writeFileSync(join(w1, "work.txt"), "committed\n", "utf-8");
		jj(["commit", "-m", "rescws committed work"], w1);
		writeFileSync(join(w1, "wip.txt"), "half-done\n", "utf-8");
		mkdirSync(join(w1, "tmp"), { recursive: true });
		writeFileSync(join(w1, "tmp", "scratch.json"), "{}\n", "utf-8");

		const rescueId = await rescueWorkspaceStateBestEffort(
			w1,
			"Parallel workers failed: wall-clock budget expired",
		);
		check(rescueId !== null && /^[0-9a-f]{40}$/.test(rescueId!), "rescue commit id returned");
		const msg = jj(["log", "-r", "@-", "--no-graph", "-T", "description.first_line()"], w1).trim();
		check(msg.startsWith("rescue: aborted task run"), `rescue commit message, got: ${msg}`);
		check(msg.includes("wall-clock budget expired"), `cause embedded in the rescue message, got: ${msg}`);
		check(jj(["file", "list"], w1).includes("wip.txt"), "untracked WIP captured by the rescue commit");
		check(jj(["file", "list"], w1).includes("tmp/scratch.json"),
			"scratch under the workspace's tmp captured by the rescue commit");
		// The rescue commit stacks INSIDE the preserved workspace chain (the
		// worker's committed work is its parent — squashing base..@- recovers
		// everything).
		const parentDesc = jj(["log", "-r", "@--", "--no-graph", "-T", "description.first_line()"], w1).trim();
		check(parentDesc === "rescws committed work",
			`rescue commit stacks on the worker's commits, got: ${parentDesc}`);
		check((await workspaceCommitId(testDir, "rescws-1")) !== rescueId,
			"the workspace @ is the fresh empty WC — the rescue commit is its parent (the artifact records the rescue id)");

		// A clean workspace → no rescue commit.
		const w2 = await createWorkspace(testDir, "rescws-2");
		const before = jj(["log", "-r", "all()", "--no-graph", "-T", "commit_id"], testDir).trim().length;
		const none = await rescueWorkspaceStateBestEffort(w2, "cause");
		check(none === null, "clean workspace → no rescue commit");
		const after = jj(["log", "-r", "all()", "--no-graph", "-T", "commit_id"], testDir).trim().length;
		check(before === after, "no new commits on a clean workspace");

		// The rescue helper never throws on a wedged workspace (bounded).
		const bounded = await rescueWorkspaceStateBestEffort("/nonexistent-dir", "cause", { timeoutMs: 1 });
		check(bounded === null, "rescue on an unusable workspace → null (best effort)");

		await cleanupWorkspace(testDir, "rescws-1", w1);
		await cleanupWorkspace(testDir, "rescws-2", w2);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ rescue-commit: parallel workspace WIP preserved inside the workspace (R3)");
}

// ─── R1: no description-less stub on a no-merge failure ──────────────

/** R1: the parallel finally creates the fresh working-copy stub (`jj new`
 *  identity restore) ONLY when a merge actually landed. On a no-merge
 *  failure (worker failure before the merge path) the stub — a
 *  description-less commit, which jj refuses to push — must not appear in
 *  the user's ancestry: whatever remains (the AI-authored task base,
 *  described with the spec goal) carries a description. */
async function testNoStubOnNoMergeFailure(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-stub-"));
	try {
		initRepo(testDir);
		const identityDir = mkdtempSync(join(tmpdir(), "pi-task-identity-"));
		const identityFile = join(identityDir, "jj-identity.toml");
		writeFileSync(identityFile, aiIdentityToml("Pi (deepseek-v4-flash)", "noreply@danong.dev"), "utf-8");
		await createAiTaskBase(testDir, identityFile, "Handle UTF-8 BOM");

		// No-merge failure: the finally's restore must NOT create the stub.
		await restoreParallelWorkingCopy(testDir, { identityDir, mergeLanded: false });

		// Every visible commit carries a description (jj refuses to push
		// description-less commits) and the identity dir was cleaned up.
		const descs = jj(["log", "-r", "all()", "--no-graph", "-T", "description.first_line()"], testDir)
			.trim()
			.split("\n")
			.filter((l) => l.trim().length > 0);
		check(descs.every((d) => d.trim().length > 0),
			`no description-less commit may remain, got: ${JSON.stringify(descs)}`);
		check(!existsSync(identityDir), "identity dir removed by the restore");
		const at = jj(["log", "-r", "@", "--no-graph", "-T", "description.first_line()"], testDir).trim();
		check(at === "task: Handle UTF-8 BOM", `the described AI base remains as @, got: ${at}`);

		// When a merge DID land, the restore creates the stub — and only then.
		const identityDir2 = mkdtempSync(join(tmpdir(), "pi-task-identity-"));
		const identityFile2 = join(identityDir2, "jj-identity.toml");
		writeFileSync(identityFile2, aiIdentityToml("Pi (deepseek-v4-flash)", "noreply@danong.dev"), "utf-8");
		await createAiTaskBase(testDir, identityFile2, "Handle UTF-8 BOM");
		await restoreParallelWorkingCopy(testDir, { identityDir: identityDir2, mergeLanded: true });
		const stub = jj(["log", "-r", "@", "--no-graph", "-T", "if(empty, 'EMPTY', 'X')"], testDir).trim();
		check(stub === "EMPTY", "merge landed → fresh empty stub created");
		const stubParent = jj(["log", "-r", "@-", "--no-graph", "-T", "description.first_line()"], testDir).trim();
		check(stubParent === "task: Handle UTF-8 BOM",
			`stub sits on the described AI/merged base, got: ${stubParent}`);
		check(!existsSync(identityDir2), "second identity dir removed too");
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ no-merge failure: no description-less stub; stub only when a merge landed (R1)");
}

// ─── Section 14: merge-failure artifact (R2) ─────────────────────────

/**
 * R2: on merge failure the engine NEVER forgets the worker workspaces —
 * the merge-failure artifact (.failure.json, the metrics.ts write path)
 * records workspace names, their working-copy commit ids (dangling when
 * the merge did not land), the dangling commit ids, and the conflicted
 * files, so recovery is scripted rather than LLM-discovered. Simulated
 * failure: real workspaces with real commits whose merge never ran —
 * their @s ARE the dangling ids — plus conflicted files; the written
 * artifact must round-trip the full R2 record.
 */
async function testMergeFailureArtifact(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const testDir = mkdtempSync(join(tmpdir(), "pi-task-ws-failart-"));
	const metricsDir = mkdtempSync(join(tmpdir(), "pi-task-ws-failart-metrics-"));
	try {
		initRepo(testDir);
		const baseChange = await taskBaseChangeId(testDir);

		const w1 = await createWorkspace(testDir, "fail-1");
		const w2 = await createWorkspace(testDir, "fail-2");
		writeFileSync(join(w1, "a.txt"), "one\n", "utf-8");
		jj(["commit", "-m", "fail w1"], w1);
		writeFileSync(join(w2, "b.txt"), "two\n", "utf-8");
		jj(["commit", "-m", "fail w2"], w2);
		const at1 = await workspaceCommitId(testDir, "fail-1");
		const at2 = await workspaceCommitId(testDir, "fail-2");
		// Simulated failure: the atomic combine never ran — the @s are
		// dangling (nothing landed in the base), both files conflicted, and
		// worker 1's uncommitted state was rescued (R3).
		writeMergeFailureArtifact({
			cause: "simulated merge failure",
			workspaces: [
				{ name: "fail-1", commit_id: at1, rescue_commit_id: at1 },
				{ name: "fail-2", commit_id: at2 },
			],
			danglingCommitIds: [at1, at2],
			conflictedFiles: ["a.txt", "b.txt"],
			conflictHunks: { "a.txt": "<<<<<<< one\n" },
			metricsDir,
			project: "proj",
			specMarkdown: "## Goal\nX\n## Requirements\n- R1: x\n## Verification\n- true\n",
			tier: "economy",
		});

		// The artifact exists and round-trips the full R2 record.
		const dir = join(metricsDir, "proj");
		const files = readdirSync(dir).filter((f) => f.endsWith(".failure.json"));
		check(files.length === 1, `exactly one failure artifact expected, got ${JSON.stringify(files)}`);
		const parsed = JSON.parse(readFileSync(join(dir, files[0]), "utf-8")) as {
			kind: string;
			cause: string;
			recovery?: string;
			merge?: {
				workspaces: Array<{ name: string; commit_id: string; rescue_commit_id?: string }>;
				dangling_commit_ids: string[];
				conflicted_files: string[];
				conflict_hunks?: Record<string, string>;
			};
		};
		check(parsed.kind === "parallel", `artifact kind should be parallel, got ${parsed.kind}`);
		check(parsed.cause.includes("simulated merge failure"), `cause recorded, got ${parsed.cause}`);
		check(parsed.merge !== undefined, "merge record present (R2)");
		check(
			parsed.merge!.workspaces.length === 2 &&
				parsed.merge!.workspaces[0].name === "fail-1" &&
				parsed.merge!.workspaces[1].name === "fail-2",
			`workspace names recorded, got ${JSON.stringify(parsed.merge!.workspaces)}`,
		);
		check(
			parsed.merge!.workspaces[0].commit_id === at1 && parsed.merge!.workspaces[1].commit_id === at2,
			"workspace commit ids recorded (the dangling ids)",
		);
		check(
			parsed.merge!.workspaces[0].rescue_commit_id === at1 &&
				parsed.merge!.workspaces[1].rescue_commit_id === undefined,
			"R3 rescue commit ids recorded where the uncommitted state lives",
		);
		check(
			parsed.merge!.dangling_commit_ids.length === 2 &&
				parsed.merge!.dangling_commit_ids.includes(at1) &&
				parsed.merge!.dangling_commit_ids.includes(at2),
			`dangling commit ids recorded, got ${JSON.stringify(parsed.merge!.dangling_commit_ids)}`,
		);
		check(
			parsed.merge!.conflicted_files.includes("a.txt") && parsed.merge!.conflicted_files.includes("b.txt"),
			`conflicted files recorded, got ${JSON.stringify(parsed.merge!.conflicted_files)}`,
		);
		check(parsed.merge!.conflict_hunks?.["a.txt"] === "<<<<<<< one\n", "conflict hunks recorded");

		// R4: the artifact carries the scripted recovery guide — stacking
		// commands, the stub-abandon-before-push warning, and the
		// add-vs-delete :ours/:theirs warning.
		check(typeof parsed.recovery === "string" && parsed.recovery.length > 100,
			"recovery guide present in the artifact");
		check(parsed.recovery!.includes("jj rebase -s"), "guide stacks the workspaces");
		check(parsed.recovery!.includes("description-less"), "guide warns about description-less commits refusing push");
		check(parsed.recovery!.includes(":ours") && parsed.recovery!.includes(":theirs"),
			"guide resolves add-vs-delete via :ours/:theirs");
		check(parsed.recovery!.includes("mid-stack abandon"), "guide warns against mid-stack abandon");
		check(parsed.recovery!.includes(at1), "guide names the rescue commit (where the uncommitted state lives)");

		// No metricsDir → no artifact, no throw (the best-effort contract).
		writeMergeFailureArtifact({
			cause: "x",
			workspaces: [],
			danglingCommitIds: [],
			conflictedFiles: [],
			project: "proj",
			specMarkdown: "s",
		});

		// The failure did NOT forget the workspaces: they still exist and
		// their @s still hold the unmerged commits (scripted recovery).
		const list = jj(["workspace", "list"], testDir);
		check(list.includes("fail-1:") && list.includes("fail-2:"), "workspaces survive the simulated failure");
		check((await workspaceCommitId(testDir, "fail-1")) === at1, "fail-1 @ still holds its commit");

		await cleanupWorkspace(testDir, "fail-1", w1);
		await cleanupWorkspace(testDir, "fail-2", w2);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
		rmSync(metricsDir, { recursive: true, force: true });
	}
	console.log("✓ merge-failure artifact: workspaces + dangling ids + conflicted files recorded (R2)");
}

// ─── Runner ──────────────────────────────────────────────────────────

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	console.log("── test-workspace: jj mechanics + conflict + final-state conflicts + commit ids + guard + merge integrity + fork-proof + atomic combine + consistency gate + union ladder + failure artifact + recovery guide + jj timeout + rescue + no-stub (real jj) ──");
	await testMechanics(errors);
	await testConflict(errors);
	await testFinalStateConflicts(errors);
	await testPostSquashCommitIds(errors);
	await testCleanWorkingCopyGuard(errors);
	await testReResolvedSquashTargets(errors);
	await testMergeIntegrityGate(errors);
	await testStaleTargetSurfaced(errors);
	await testAssertVisibleCommit(errors);
	await testDivergentChangeResolution(errors);
	await testAiTaskBase(errors);
	await testSingleWorkerIdentity(errors);
	await testForkProofReadOnly(errors);
	await testAtomicCombine(errors);
	await testConsistencyGateDangling(errors);
	await testUnionLadder(errors);
	await testMergeFailureArtifact(errors);
	testParseSummaryChanges(errors);
	await testRescueAbortedWork(errors);
	await testWorkspacesConsumed(errors);
	await testAssertMergedUnrebasedStub(errors);
	await testJjTimeoutBounded(errors);
	await testRescueWorkspaceState(errors);
	await testNoStubOnNoMergeFailure(errors);

	if (errors.length > 0) {
		throw new Error("test-workspace failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log("✓ workspace assertions passed");
}

// Direct execution support: `npx tsx extensions/task/test-workspace.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
