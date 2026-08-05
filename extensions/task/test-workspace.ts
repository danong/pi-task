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
 *
 * splitSpec moved to test-orchestrator.ts; the parallel LLM integration
 * moved to test-e2e.ts section 5.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
	assertCleanWorkingCopy,
	assertMerged,
	assertVisibleCommit,
	createWorkspace,
	detectChangeConflicts,
	mergeWorkspace,
	removeWorkspace,
	resolveCommitId,
	taskBaseChangeId,
} from "./workspace.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

function jj(args: string[], cwd: string): string {
	return execFileSync("jj", args, {
		cwd,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, JJ_EDITOR: "true" },
	});
}

/** Async jj — the child process runs in the OS concurrently with others. */
function jjAsync(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("jj", args, { cwd, env: { ...process.env, JJ_EDITOR: "true" } }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout.toString());
		});
	});
}

function initRepo(dir: string): void {
	jj(["git", "init", "--colocate"], dir);
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

		check(baseChange === jj(["log", "-r", "@", "-T", "change_id"], testDir).trim(),
			"createAiTaskBase returns the new @'s change id");
		const author = jj(["log", "-r", "@", "-T", 'author.name() ++ " <" ++ author.email() ++ ">"'], testDir);
		check(author.includes("Pi (deepseek-v4-flash)") && author.includes("noreply@danong.dev"),
			`merged base authored as the AI identity, got: ${author.trim()}`);
		const parent = jj(["log", "-r", "@-", "-T", "description.first_line()"], testDir);
		check(parent.trim() === "init", `parent is @- (the user's last commit), got: ${parent.trim()}`);
		const desc = jj(["log", "-r", "@", "-T", "description.first_line()"], testDir);
		check(desc.trim() === "task: Handle UTF-8 BOM", `described with the spec goal, got: ${desc.trim()}`);
		const files = jj(["log", "-r", "@", "-T", "files.len()"], testDir);
		check(files.trim() === "0", `the base starts empty (workspaces' work lands via squash), got: ${files.trim()}`);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
	console.log("✓ AI-authored task base: identity + parent + goal description + empty tree");
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
		await assertMerged(testDir, ["rer-1", "rer-2", "rer-f"], baseChange);

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
			await assertMerged(testDir, ["gate-1", "gate-2"], baseChange);
			errors.push("assertMerged should fail when a workspace was never merged");
		} catch (err) {
			const msg = (err as Error).message;
			check(msg.includes("gate-2"), `gate error should name the unmerged workspace, got: ${msg}`);
			check(msg.includes("did NOT integrate"), `gate error should say the merge is not integrated, got: ${msg}`);
			check(msg.includes("b.txt"), `gate error should name the stranded file, got: ${msg}`);
		}

		// Merge w2 properly — the gate now passes.
		await mergeWorkspace(testDir, "gate-2", baseChange);
		await assertMerged(testDir, ["gate-1", "gate-2"], baseChange);
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
			await assertMerged(testDir, ["stale-1", "stale-2"], baseChange);
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

// ─── Runner ──────────────────────────────────────────────────────────

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	console.log("── test-workspace: jj mechanics + conflict + final-state conflicts + commit ids + guard + merge integrity + fork-proof (real jj) ──");
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
	await testForkProofReadOnly(errors);

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
