/**
 * Failure-hygiene CONTRACT tests — REQUIRED end-state per termination
 * kind, pinned as PASSING assertions (zero LLM).
 *
 * Contract under test: the "Failure-artifact contract" section in
 * docs/pi-task-design.md. Each fixture drives the engine's termination
 * logic directly (no worker spawns, no LLM; real jj on temp repos for the
 * repo-artifact footprints). The single-run fixtures (wall-timeout,
 * user-abort) assert the CONTRACT end-state via the engine's real
 * singleRunFailureHygiene step — one goal-named rescue commit, no
 * engine-authored empty stubs, no undescribed snapshots, recovery info;
 * the parallel fixtures assert the CONTRACT end-state via the engine's
 * parallelRunPostMortem — per-workspace rescues stacked onto the dispatch
 * base, no surviving engine stubs, forgotten workspaces, and a
 * machine-grep-able recovery block in the merge-failure artifact.
 *
 * Termination kinds covered:
 *   - watchdog aborts (wall_timeout / no_progress / tool_timeout /
 *     no_yield) — structured diagnostics identity
 *   - wall-timeout single-worker footprint (CONTRACT): rescue + stub
 *     abandonment + snapshot fold-in + recovery block
 *   - user/signal-driven abort (null-code diagnostics) — first-class,
 *     CONTRACT: same preservation, user/doubtful content never destroyed
 *   - parallel flat worker-failure footprint (per-workspace rescues,
 *     preserved workspaces, merge-failure artifact + recovery guide)
 *   - parallel no-merge stub suppression (restoreParallelWorkingCopy)
 *
 * Run: timeout 300 npx tsx extensions/task/test-failure-hygiene.ts
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { aiIdentityToml } from "./config.ts";
import {
	ensureDispatchableTree,
	singleRunFailureHygiene,
	serializeSingleRunRecovery,
	parallelRunPostMortem,
	rescueWorkspaceStateBestEffort,
	restoreParallelWorkingCopy,
	writeMergeFailureArtifact,
} from "./orchestrator.ts";
import { assertCleanWorkingCopy } from "./workspace.ts";
import { buildAbortError, NO_YIELD_FAILURE } from "./worker.ts";
import {
	createAiTaskBase,
	createWorkspace,
	workspaceCommitId,
} from "./workspace.ts";
import { buildFailureArtifact, writeFailureArtifact } from "./metrics.ts";

// ─── Helpers (mirrors test-workspace.ts conventions) ──────────────────

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

function initRepo(dir: string): void {
	jj(
		[
			"--config",
			'user.name="Test User"',
			"--config",
			'user.email="user@test.dev"',
			"git",
			"init",
			"--colocate",
		],
		dir,
	);
	jj(["config", "set", "--repo", "user.name", "Test User"], dir);
	jj(["config", "set", "--repo", "user.email", "user@test.dev"], dir);
	writeFileSync(join(dir, "README.md"), "# Test repo\n", "utf-8");
	jj(["commit", "-m", "init"], dir);
}

/** Visible commits that are EMPTY and DESCRIPTION-LESS (contract taxonomy
 *  class 1 — the "empty stub" detector used throughout this suite). */
function countEmptyStubs(dir: string): number {
	const out = jj(
		[
			"log",
			"-r",
			"all()",
			"--no-graph",
			"-T",
			'if(empty, if(description.first_line() == "", "STUB", "ok"), "ok") ++ "\n"',
		],
		dir,
	);
	return out.split("\n").filter((l) => l.trim() === "STUB").length;
}

/** Change id of a rev (read-only). */
function changeIdOf(dir: string, rev: string): string {
	return jj(
		["log", "-r", rev, "--no-graph", "-T", "change_id", "--ignore-working-copy"],
		dir,
	).trim();
}

/** Change ids of VISIBLE commits (excluding the immutable root, which is
 *  empty + undescribed by construction) that are empty AND
 *  description-less — the survivor set after abort hygiene (each one
 *  preserved-by-doubt). */
function emptyUndescribedChangeIds(dir: string): string[] {
	return jj(
		[
			"log",
			"-r",
			"all() ~ root()",
			"--no-graph",
			"-T",
			'if(empty, if(description.first_line() == "", change_id ++ "\\n", ""), "")',
		],
		dir,
	)
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

/** Author emails of VISIBLE commits that are empty AND description-less
 *  (contract taxonomy class 1) — proves WHICH empties survived a failure:
 *  after hygiene, none may carry the engine's AI identity (rule 2); any
 *  survivor is preserved-by-doubt user territory (rule R3). */
function stubAuthorEmails(dir: string): string[] {
	return jj(
		[
			"log",
			"-r",
			"all()",
			"--no-graph",
			"-T",
				'if(empty, if(description.first_line() == "", "STUB|" ++ author.email(), ""), "") ++ "\\n"',
		],
		dir,
	)
		.split("\n")
		.map((l) => l.replace(/^STUB\|/, "").trim())
		.filter((l) => l.length > 0);
}

/** Workspace names from `jj workspace list` (lines "name: ..."). */
function workspaceNames(dir: string): string[] {
	return jj(["workspace", "list"], dir)
		.split("\n")
		.map((l) => (/^(\S+):/.exec(l.trim())?.[1] ?? ""))
		.filter((l) => l.length > 0);
}

/** Change id of the dispatch base — the default workspace's @- (the
 *  pre-task head the workspaces branched from). */
function dispatchBaseChangeId(dir: string): string {
	return jj(["log", "-r", "@-", "--no-graph", "-T", "change_id"], dir).trim();
}

/** All visible non-empty first-line descriptions (order: newest first). */
function descriptions(dir: string): string[] {
	return jj(
		[
			"log",
			"-r",
			"all()",
			"--no-graph",
			"-T",
			'description.first_line() ++ "\n"',
		],
		dir,
	)
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

/** Author email of a change id (read-only) — provenance assertions. */
function authorEmailOf(dir: string, changeId: string): string {
	return jj(
		[
			"log",
			"-r",
			changeId,
			"--no-graph",
			"--ignore-working-copy",
			"-T",
			"author.email()",
		],
		dir,
	).trim();
}

/** Full visible state snapshot for IDEMPOTENCE comparison (R3): every
 *  visible commit's (change id, first description line, emptiness) sorted
 *  lexicographically — a second cleanup pass must reproduce this EXACTLY
 *  (no moved commits, no re-described or newly abandoned changes).
 *  Commit ids are excluded deliberately: they are content hashes that
 *  jj's abandon-rebase may legitimately rewrite while change ids — the
 *  identity the contract reasons over — stay stable. */
function treeFingerprint(dir: string): string[] {
	return jj(
		[
			"log",
			"-r",
			"all() ~ root()",
			"--no-graph",
			"--ignore-working-copy",
			"-T",
			'change_id ++ "|" ++ description.first_line() ++ "|" ++ if(empty, "E", "F") ++ "\\n"',
		],
		dir,
	)
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.sort();
}

/** Files tracked in the working copy (read-only) — the on-disk half of
 *  the idempotence fingerprint. */
function fileList(dir: string): string[] {
	return jj(["file", "list", "--ignore-working-copy"], dir)
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.sort();
}

/** Visible commits that carry content but NO description (taxonomy
 *  class 3 — an undescribed full-tree snapshot; class 1 is countEmptyStubs). */
function countNonEmptyUndescribed(dir: string): number {
	const out = jj(
		[
			"log",
			"-r",
			"all()",
			"--no-graph",
			"-T",
			'if(empty, "ok", if(description.first_line() == "", "BAD", "ok")) ++ "\n"',
		],
		dir,
	);
	return out.split("\n").filter((l) => l.trim() === "BAD").length;
}

const SPEC_MARKDOWN =
	"## Goal\nBuild the widget.\n## Requirements\n- R1: widget\n## Verification\n- true\n";
const GOAL = "Build the widget.";

// ─── 1. Watchdog + user-abort identity (pure) ─────────────────────────

/**
 * Every termination kind must be MACHINE-IDENTIFIABLE: the abort
 * rejection carries structured `diagnostics` (code + cause + final
 * state), never message text alone. Watchdog kinds carry their code;
 * the user/signal-driven abort carries a NULL code — still structured,
 * still a first-class termination kind (contract rule 6's input).
 *
 * SATISFIES: contract rule 6's precondition (machine-readable failure
 * identity per kind, including user-abort).
 */
function testTerminationIdentity(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const diagOf = (err: unknown) =>
		(err as { diagnostics?: { code?: unknown; cause?: unknown } }).diagnostics;

	// Watchdog kinds: wall / no-progress / tool-timeout / no-yield.
	const wall = buildAbortError({
		code: "wall_timeout",
		cause: "worker wall-clock budget expired",
		turns: 12,
		idleMs: 4000,
		lastTool: { name: "bash", args: "make ci" },
		stderrTail: "",
	});
	check(diagOf(wall)?.code === "wall_timeout", "wall_timeout code carried");

	const progress = buildAbortError({
		code: "no_progress",
		cause: "no RPC activity observed",
		turns: 3,
		idleMs: 600_000,
		lastTool: null,
		stderrTail: "",
	});
	check(diagOf(progress)?.code === "no_progress", "no_progress code carried");

	const tool = buildAbortError({
		code: "tool_timeout",
		cause: "tool exceeded per-tool budget",
		turns: 5,
		idleMs: 900_000,
		lastTool: { name: "bash", args: "sleep infinity" },
		stderrTail: "",
	});
	check(diagOf(tool)?.code === "tool_timeout", "tool_timeout code carried");

	const noYield = buildAbortError({
		code: "no_yield",
		cause: NO_YIELD_FAILURE,
		turns: 9,
		idleMs: 100,
		lastTool: null,
		stderrTail: "",
	});
	check(diagOf(noYield)?.code === "no_yield", "no_yield code carried");

	// User/signal-driven abort (spawnWorkerSession's onSignalAbort → abort()
	// → close handler): NULL code + generic cause — structured but distinct
	// from every watchdog. A manual user abort is FIRST-CLASS: it flows
	// through the same diagnostics channel the watchdogs use.
	const userAbort = buildAbortError({
		code: null,
		cause: null,
		turns: 7,
		idleMs: 1200,
		lastTool: { name: "edit_file", args: "src/x.ts" },
		stderrTail: "",
	});
	check(
		diagOf(userAbort)?.code === null,
		"user abort carries the null-code identity",
	);
	check(
		diagOf(userAbort)?.cause === "Worker was aborted",
		"user abort cause defaults to the generic abort line",
	);
	check(userAbort.message.includes("turns: 7"), "final state travels along");

	console.log(
		"✓ termination identity: watchdog codes + null-code user-abort all machine-readable",
	);
}

// ─── 2. Single-worker failure footprint (real jj) ─────────────────────

/**
 * Single-worker WALL-TIMEOUT/watchdog termination, CONTRACT assertions
 * (flipped from characterization): driving the engine's real hygiene step
 * (singleRunFailureHygiene — what executeSingle's failure path runs) on a
 * repo shaped like a mid-work abort (AI task base + a worker commit + a
 * dirty working-copy tail):
 *
 * rule 1/R2: partial work squashed into AT MOST ONE commit ON THE DISPATCH
 *   BASE, message `rescue: <goal first line> (<cause>)` — goal-named.
 * rule 2/R3: NO engine-created empty stub survives — every remaining
 *   empty description-less commit carries a NON-engine author
 *   (preserve-by-doubt), never the AI identity.
 * rule 3/R4: the dirty workspace snapshot is FOLDED INTO the described
 *   rescue — no undescribed full-tree snapshot commit remains.
 * rule 4/R4: single runs create no jj workspaces — none exist and none
 *   are left forgotten after the failure exit.
 * rule 6/R5: machine-readable recovery travels with the result: rescue
 *   change id + exact jj inspect/continue commands, grep-able in the
 *   .failure.json recovery field.
 */
async function testSingleWorkerRescue(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-task-fh-single-"));
	const identityDir = mkdtempSync(join(tmpdir(), "pi-task-fh-single-id-"));
	try {
		initRepo(dir);
		const identityFile = join(identityDir, "jj-identity.toml");
		writeFileSync(
			identityFile,
			aiIdentityToml("Pi (test-model)", "ai@test.dev"),
			"utf-8",
		);
		const AI_EMAIL = "ai@test.dev";

		// Shape the repo like a mid-work abort: AI base on the dispatch base,
		// one worker commit, then the worker's working-copy stub (empty,
		// AI-authored) holding a DIRTY tail at kill time.
		await createAiTaskBase(dir, identityFile, GOAL);
		writeFileSync(join(dir, "done.txt"), "committed part\n", "utf-8");
		jj(["--config-file", identityFile, "commit", "-m", "task: widget part"], dir);
		jj(["--config-file", identityFile, "new", "@"], dir); // empty AI stub @
		writeFileSync(join(dir, "wip.txt"), "half-done feature\n", "utf-8");

		const wallErr = new Error("Worker wall-timeout: budget exhausted");
		const info = await singleRunFailureHygiene({
			cwd: dir,
			err: wallErr,
			goal: GOAL,
			aiAuthorName: "Pi (test-model)",
			aiAuthorEmail: AI_EMAIL,
		});

		// Rule 1/R2: ONE goal-named rescue commit carrying the cause.
		const rescues = descriptions(dir).filter((d) => d.startsWith("rescue:"));
		check(
			rescues.length === 1,
			`exactly ONE rescue commit on the base, got ${JSON.stringify(descriptions(dir))}`,
		);
		check(
			rescues[0] === `rescue: ${GOAL} (${wallErr.message})`,
			`rescue message is "rescue: <goal> (<cause>)", got "${rescues[0]}"`,
		);
		check(
			jj(["file", "list"], dir).includes("wip.txt") &&
				jj(["file", "list"], dir).includes("done.txt"),
			"partial work (dirty tail + committed part) survives",
		);

		// Rule 3/R4: the dirty snapshot folded into the DESCRIBED rescue —
		// no undescribed non-empty (full-tree snapshot) commit remains.
		check(
			countNonEmptyUndescribed(dir) === 0,
			`every non-empty commit is described, got ${JSON.stringify(descriptions(dir))}`,
		);

		// Rule 2/R3: no ENGINE-authored empty stub survives; anything empty
		// left behind is non-engine (preserved by doubt, never deleted).
		const survivingStubs = stubAuthorEmails(dir);
		check(
			!survivingStubs.includes(AI_EMAIL),
			`no AI-authored empty stub survives the failure exit, got ${JSON.stringify(survivingStubs)}`,
		);

		// Rule 4/R4: single runs spawn no workspaces — none exist after the
		// failure exit (nothing forgotten-and-left, no snapshot @s).
		check(
			JSON.stringify(workspaceNames(dir)) === JSON.stringify(["default"]),
			`only the default workspace exists after a failed single run, got ${JSON.stringify(workspaceNames(dir))}`,
		);

		// Rule 6/R5: machine-readable recovery — rescue change id + exact jj
		// commands, grep-able once serialized into the failure artifact.
		check(
			typeof info?.rescued_commit === "string" &&
				info.rescued_commit.length > 0,
			"recovery names the rescue commit (change id)",
		);
		check(
			(info?.commands ?? []).some((c) => c.startsWith(`jj show ${info!.rescued_commit}`)) === true &&
				(info?.commands ?? []).some((c) => c.startsWith(`jj new ${info!.rescued_commit}`)) === true,
			`recovery carries the exact inspect/continue commands, got ${JSON.stringify(info?.commands)}`,
		);
		const serialized = serializeSingleRunRecovery(info!);
		check(
			serialized.startsWith(`rescued_commit=${info!.rescued_commit}`),
			"serialized recovery is grep-able (leading rescued_commit=key=line)",
		);

		// At-most-one: a SECOND (clean-tree) abort adds no further rescue.
		jj(["new"], dir);
		const rescuesBefore = descriptions(dir).filter((d) =>
			d.startsWith("rescue:"),
		).length;
		await singleRunFailureHygiene({
			cwd: dir,
			err: new Error("watchdog: no progress"),
			goal: GOAL,
			aiAuthorName: "Pi (test-model)",
			aiAuthorEmail: AI_EMAIL,
		});
		check(
			descriptions(dir).filter((d) => d.startsWith("rescue:")).length ===
				rescuesBefore,
			"clean abort → zero additional rescue commits (at-most-one, not always-one)",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(identityDir, { recursive: true, force: true });
	}
	console.log(
		"✓ single-worker wall-timeout: one goal-named rescue, engine empties abandoned, snapshot folded, recovery block [CONTRACT]",
	);
}

// ─── 3. USER-ABORT footprint (real jj) ────────────────────────────────

/**
 * USER-ABORT termination, CONTRACT assertions (flipped from
 * characterization): a manual abort is FIRST-CLASS — identical end-state
 * to a watchdog abort, with the R3 degrade-gracefully guarantee made
 * sharp: the user's OWN pre-existing work and any doubtful commits are
 * NEVER destroyed; only provably engine-authored empties go.
 *
 * rule 1/R2: partial work → one `rescue: <goal> (<cause>)` commit.
 * rule 2/R3: user's pre-existing described work intact; a doubtful
 *   (user-authored, empty, undescribed) commit is PRESERVED and LISTED
 *   in the recovery block, not deleted.
 * rule 6/R5: recovery names the rescue + the preserved stub + commands.
 */
async function testUserAbortRescue(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-task-fh-userabort-"));
	const identityDir = mkdtempSync(join(tmpdir(), "pi-task-fh-ua-id-"));
	try {
		initRepo(dir);
		const AI_EMAIL = "ai@test.dev";
		const identityFile = join(identityDir, "jj-identity.toml");
		writeFileSync(
			identityFile,
			aiIdentityToml("Pi (test-model)", AI_EMAIL),
			"utf-8",
		);

		// The user's OWN prior work (described, with content) — must never be
		// touched by abort hygiene.
		writeFileSync(join(dir, "user.txt"), "user prior work\n", "utf-8");
		jj(["commit", "-m", "feat: user prior work"], dir);

		// AI base + the worker's mid-edit working copy at Ctrl-C time.
		await createAiTaskBase(dir, identityFile, GOAL);
		jj(["--config-file", identityFile, "new", "@"], dir);
		writeFileSync(join(dir, "partial.txt"), "user-interrupted work\n", "utf-8");

		// What spawnWorkerSession's close handler produces on signal abort:
		// the null-code structured rejection.
		const userAbortError = buildAbortError({
			code: null,
			cause: null,
			turns: 4,
			idleMs: 300,
			lastTool: null,
			stderrTail: "",
		});

		const info = await singleRunFailureHygiene({
			cwd: dir,
			err: userAbortError,
			goal: GOAL,
			aiAuthorName: "Pi (test-model)",
			aiAuthorEmail: AI_EMAIL,
		});

		// Rule 1: ONE goal-named rescue naming the user-abort cause.
		const rescues = descriptions(dir).filter((d) => d.startsWith("rescue:"));
		check(
			rescues.length === 1,
			`user abort preserves partial work as ONE goal-named commit, got ${JSON.stringify(descriptions(dir))}`,
		);
		check(
			rescues[0] === `rescue: ${GOAL} (Worker was aborted)`,
			`rescue message names goal + user-abort cause, got "${rescues[0]}"`,
		);
		check(
			jj(["file", "list"], dir).includes("partial.txt"),
			"user-interrupted work survives in the rescue commit",
		);

		// Rule 2/R3: the user's pre-existing work is untouched...
		check(
			descriptions(dir).includes("feat: user prior work"),
			"user's pre-existing described work survives the abort",
		);
		check(
			jj(["file", "list"], dir).includes("user.txt"),
			"user's pre-existing file content survives",
		);
		// ...and every DOUBTFUL stub is preserved (never destroyed) and
		// LISTED. After the rescue there is exactly one: the fresh empty
		// working copy `jj commit` opened on top of the rescue — user-
		// authored (the orchestrator's own config), so provenance doubt
		// forbids deleting it.
		const survivors = emptyUndescribedChangeIds(dir);
		check(
			survivors.length === 1,
			`exactly one doubtful empty stub survives (the rescue's fresh @), got ${JSON.stringify(survivors)}`,
		);
		const doubtfulStub = survivors[0];
		check(
			doubtfulStub !== undefined &&
				info?.preserved_stubs?.includes(doubtfulStub) === true,
			`the doubtful stub is listed in recovery info, got ${JSON.stringify(info?.preserved_stubs)}`,
		);

		// No ENGINE empties survive (same rule as watchdog aborts).
		check(
			!stubAuthorEmails(dir).includes(AI_EMAIL),
			"no AI-authored empty stub survives a user abort",
		);
		check(
			countNonEmptyUndescribed(dir) === 0,
			"no undescribed full-tree snapshot remains (folded into the rescue)",
		);

		// Rule 6: recovery carries the continue-from-rescue command.
		check(
			(info?.commands ?? []).some((c) => c.startsWith(`jj new ${info!.rescued_commit}`)) === true,
			"recovery tells the user how to continue the rescued work",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(identityDir, { recursive: true, force: true });
	}
	console.log(
		"✓ user-abort: goal-named rescue, user work + doubtful stubs preserved & listed [CONTRACT]",
	);
}

// ─── 4. Parallel flat worker-failure footprint (real jj) ──────────────

/**
 * Parallel run, a worker aborts MID-WORK (classifyWorkerFailures →
 * "abort"): the engine performs the full post-mortem itself
 * (parallelRunPostMortem) — each workspace's uncommitted state is rescued,
 * every workspace's commits are stacked onto the dispatch base in ONE
 * linear chain, engine-authored empty stubs are abandoned, the workspaces
 * are forgotten (their content is live in the main ancestry), and the
 * merge-failure artifact carries the machine-readable recovery result.
 *
 * SATISFIES: rule 1 (one rescue commit per affected tree), rule 2 (no
 * engine empty stubs survive — creation-time stubs + rescue @s abandoned),
 * rule 3 (the undescribed dirty snapshot is DESCRIBED as the rescue — no
 * anonymous full-tree commits), rule 5 (no dangling workspace ids — the
 * workspaces no longer exist), rule 6 (artifact carries ids + the exact
 * machine-grep-able jj recovery commands).
 */
async function testParallelFlatWorkerFailure(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-task-fh-parallel-"));
	const metricsDir = mkdtempSync(join(tmpdir(), "pi-task-fh-metrics-"));
	try {
		initRepo(dir);

		// Worker 1: committed work + dirty tail (aborted mid-final-edit).
		const w1 = await createWorkspace(dir, "fhpar-1");
		writeFileSync(join(w1, "done.txt"), "committed part\n", "utf-8");
		jj(["commit", "-m", "task: worker 1 part"], w1);
		writeFileSync(join(w1, "tail.txt"), "uncommitted tail\n", "utf-8");
		// Snapshot the dirty state the way jj does on any later read op —
		// the workspace's @ is now an UNDESCRIBED FULL-TREE snapshot.
		jj(["status"], w1);
		// Worker 2: committed work, clean at abort.
		const w2 = await createWorkspace(dir, "fhpar-2");
		writeFileSync(join(w2, "other.txt"), "worker 2\n", "utf-8");
		jj(["commit", "-m", "task: worker 2 part"], w2);

		// The engine's flat failure path (orchestrator.ts, worker-failure
		// branch): per-workspace rescue (bounded), then the post-mortem
		// stacks both workspaces onto the dispatch base and forgets them;
		// the artifact records where everything landed.
		const at1 = await workspaceCommitId(dir, "fhpar-1");
		const at2 = await workspaceCommitId(dir, "fhpar-2");
		const cause = "Parallel workers failed: wall-clock budget expired";
		const rescue1 = await rescueWorkspaceStateBestEffort(w1, cause);
		check(
			rescue1 !== null && /^[0-9a-f]{40}$/.test(rescue1),
			"dirty workspace's uncommitted tail rescued to a real commit id",
		);

		writeMergeFailureArtifact({
			cause,
			workspaces: [
				{
					name: "fhpar-1",
					commit_id: rescue1 ?? at1,
					...(rescue1 ? { rescue_commit_id: rescue1 } : {}),
				},
				{ name: "fhpar-2", commit_id: at2 },
			],
			danglingCommitIds: [],
			conflictedFiles: [],
			metricsDir,
			runId: "fh-run-1",
			project: "proj",
			specMarkdown: SPEC_MARKDOWN,
			parallelRecovery: await parallelRunPostMortem({
				projectDir: dir,
				workspaceNames: ["fhpar-1", "fhpar-2"],
				baseChangeId: dispatchBaseChangeId(dir),
				cause,
				aiAuthorEmail: "ai@test.dev",
				workspaceDirs: { "fhpar-1": w1, "fhpar-2": w2 },
			}),
		});

		// Rule 5 (post-mortem era): the workspaces are GONE — their content
		// is stacked in the main ancestry, so no dangling workspace ids remain.
		const list = jj(["workspace", "list"], dir);
		check(
			!list.includes("fhpar-1:") && !list.includes("fhpar-2:"),
			"workspaces forgotten after the post-mortem (no dangling ids)",
		);

		// Rule 6: the artifact names the workspaces + rescue ids and carries
		// the machine-grep-able post-mortem recovery (exact jj commands).
		const artifacts = readdirSync(join(metricsDir, "proj")).filter((f) =>
			f.endsWith(".failure.json"),
		);
		check(artifacts.length === 1, "exactly one failure artifact written");
		const parsed = JSON.parse(
			readFileSync(join(metricsDir, "proj", artifacts[0]!), "utf-8"),
		) as {
			merge?: {
				workspaces: Array<{
					name: string;
					commit_id: string;
					rescue_commit_id?: string;
				}>;
				dangling_commit_ids: string[];
			};
			recovery?: string;
		};
		check(
			parsed.merge?.workspaces[0]?.name === "fhpar-1" &&
				parsed.merge?.workspaces[1]?.name === "fhpar-2",
			"artifact names both workspaces",
		);
		check(
			parsed.merge?.workspaces[0]?.rescue_commit_id === rescue1,
			"artifact points at the rescue commit (where the uncommitted state lives)",
		);
		check(
			parsed.recovery?.includes("stacked=fhpar-1:") === true &&
				parsed.recovery?.includes("stacked=fhpar-2:") === true,
			"machine recovery records BOTH stacked chains (key=value lines)",
		);
		check(
			parsed.recovery?.includes("jj log -r ") === true &&
				parsed.recovery?.includes("jj new ") === true,
			"recovery carries the exact jj commands (inspect + continue)",
		);

		// Rule 1/4 (post-mortem): both chains stacked onto the dispatch base —
		// every worker commit reachable from base:: exactly once, ONE linear
		// chain, and the dirty snapshot DESCRIBED as the rescue (rule 3).
		const visible = jj(
			[
				"log",
				"-r",
				`${dispatchBaseChangeId(dir)}:: ~ root()`,
				"--no-graph",
				"--ignore-working-copy",
				"-T",
				'description.first_line() ++ "\\n"',
			],
			dir,
		)
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		for (const desc of [
			"task: worker 1 part",
			"task: worker 2 part",
			`rescue: aborted task run (${cause.slice(0, 140)})`,
		]) {
			check(
				visible.filter((d) => d === desc).length === 1,
				`exactly one visible copy of "${desc}" in the main ancestry`,
			);
		}
		check(
			countNonEmptyUndescribed(dir) === 0,
			"no undescribed full-tree snapshot remains (described as the rescue)",
		);

		// Rule 2 (post-mortem): NO engine empty stubs survive anywhere — the
		// creation-time workspace stubs were abandoned with the forgotten
		// workspaces; only the default workspace's fresh empty @ remains.
		const survivors = emptyUndescribedChangeIds(dir);
		check(
			survivors.length === 1,
			`exactly one empty stub survives (the default @), got ${JSON.stringify(survivors)}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(metricsDir, { recursive: true, force: true });
	}
	console.log(
		"✓ parallel flat failure: rescues + stacked chains + engine-side recovery [CONTRACT]",
	);
}

// ─── 5. Parallel no-merge stub suppression (real jj) ──────────────────

/**
 * The parallel finally's identity restore must NOT create the
 * description-less `jj new` stub when no merge landed (the AI base stays
 * described); when a merge DID land, exactly the success-shaped stub
 * appears on top of the merged base.
 *
 * SATISFIES: rule 2 for the parallel no-merge failure path (no NEW empty
 * stub in the user's ancestry beyond the success-path equivalent).
 */
async function testNoMergeStubSuppression(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-task-fh-nostub-"));
	try {
		initRepo(dir);
		const identityDir = mkdtempSync(join(tmpdir(), "pi-task-fh-identity-"));
		const identityFile = join(identityDir, "jj-identity.toml");
		writeFileSync(
			identityFile,
			aiIdentityToml("Pi (test-model)", "noreply@danong.dev"),
			"utf-8",
		);
		await createAiTaskBase(dir, identityFile, "Build the widget.");

		// No-merge failure: restore must not add any commit.
		const descsBefore = descriptions(dir).length;
		const stubsBefore = countEmptyStubs(dir);
		await restoreParallelWorkingCopy(dir, {
			identityDir,
			mergeLanded: false,
		});
		check(
			descriptions(dir).length === descsBefore &&
				countEmptyStubs(dir) === stubsBefore,
			"no-merge failure: the restore creates NO stub commit",
		);
		check(!existsSync(identityDir), "identity dir cleaned up either way");

		// Merge landed: exactly the success-shaped empty stub on the base.
		const identityDir2 = mkdtempSync(join(tmpdir(), "pi-task-fh-identity2-"));
		const identityFile2 = join(identityDir2, "jj-identity.toml");
		writeFileSync(
			identityFile2,
			aiIdentityToml("Pi (test-model)", "noreply@danong.dev"),
			"utf-8",
		);
		await createAiTaskBase(dir, identityFile2, "Build the widget.");
		await restoreParallelWorkingCopy(dir, {
			identityDir: identityDir2,
			mergeLanded: true,
		});
		const at = jj(
			["log", "-r", "@", "--no-graph", "-T", "if(empty, 'EMPTY', 'X')"],
			dir,
		).trim();
		const parent = jj(
			["log", "-r", "@-", "--no-graph", "-T", "description.first_line()"],
			dir,
		).trim();
		check(at === "EMPTY", "merge landed → the fresh empty @ (success shape)");
		check(
			parent === "task: Build the widget.",
			`stub sits on the described merged base, got "${parent}"`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log(
		"✓ no-merge stub suppression: stub only when a merge landed (mergeLanded guard)",
	);
}

// ─── 6. Workspace-add stub taxonomy (real jj) ─────────────────────────

/**
 * Taxonomy class 1 characterized: `jj workspace add` (createWorkspace)
 * opens ONE empty, description-less working-copy stub per worker. On the
 * SUCCESS path a `jj workspace forget` removes it; on FAILURE paths the
 * post-mortem (parallelRunPostMortem) provides the same guarantee — it
 * stacks each workspace's content, detaches any content-bearing @, and
 * forgets the workspace so its creation-time stub is abandoned too.
 *
 * SATISFIES: pins taxonomy class 1's producer + lifetime (input to rules
 * 2 and 5) AND rule 2 on the failure path: no workspace-add stub survives
 * a failed run — engine-side cleanup, not scripted manual recovery.
 */
async function testWorkspaceAddStubLifetime(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-task-fh-wsstub-"));
	try {
		initRepo(dir);
		const stubsBefore = countEmptyStubs(dir);
		const w = await createWorkspace(dir, "fhstub-1");
		check(
			countEmptyStubs(dir) === stubsBefore + 1,
			"workspace add opens exactly ONE empty description-less stub per worker",
		);
		// Failure path: the worker committed something then aborted; the
		// post-mortem must stack the content AND remove the creation-time
		// stub (the forget abandons the workspace's @ after the content is
		// stacked away from it).
		writeFileSync(join(w, "part.txt"), "partial work\n", "utf-8");
		jj(["commit", "-m", "task: fhstub part"], w);
		const recovery = await parallelRunPostMortem({
			projectDir: dir,
			workspaceNames: ["fhstub-1"],
			baseChangeId: dispatchBaseChangeId(dir),
			cause: "Parallel workers failed: wall-clock budget expired",
			aiAuthorEmail: "ai@test.dev",
			workspaceDirs: { "fhstub-1": w },
		});
		check(
			recovery.stacked.length === 1 && recovery.stacked[0]!.name === "fhstub-1",
			`failure path stacks the workspace's chain, got ${JSON.stringify(recovery.stacked)}`,
		);
		check(
			!jj(["workspace", "list"], dir).includes("fhstub-1:"),
			"failed run's workspace is forgotten (no dangling id)",
		);
		check(
			countEmptyStubs(dir) === stubsBefore,
			"failure path leaves NO workspace-add stub behind (same end-state as success)",
		);
		check(
			descriptions(dir).includes("task: fhstub part"),
			"the worker's content survives the cleanup (never destroyed)",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log(
		"✓ workspace-add stub lifetime: one stub per worker, removed on success AND failure paths [CONTRACT]",
	);
}

// ─── 7. Worker-kind failure artifact round-trip (pure fs) ─────────────

/**
 * The single-worker failure artifact (<run_id>.failure.json) must carry
 * the machine-readable recovery info: the structured diagnostics
 * (cause/turns/idle/last tool) plus the spec hash tying the artifact to
 * the run. Drives the same builder/writer pair
 * writeFailureArtifactBestEffort uses.
 *
 * SATISFIES: rule 6's machine-readable half for the single-worker kinds.
 */
function testWorkerFailureArtifactRoundTrip(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const metricsDir = mkdtempSync(join(tmpdir(), "pi-task-fh-artifact-"));
	try {
		const err = buildAbortError({
			code: "wall_timeout",
			cause: "worker wall-clock budget expired",
			turns: 21,
			idleMs: 5000,
			lastTool: { name: "bash", args: "timeout 300 make ci" },
			stderrTail: "killed\n",
		});
		// buildAbortError attaches the structured diagnostics the orchestrator's
		// writeFailureArtifactBestEffort reads (worker.ts todo #86 contract).
		const d = (
			err as unknown as {
				diagnostics: {
					cause: string;
					turns: number;
					idleMs: number;
					lastTool: { name: string; args: string } | null;
					stderrTail: string;
				};
			}
		).diagnostics;
		const artifact = buildFailureArtifact({
			kind: "worker",
			runId: "fh-run-2",
			specHash: "abc123",
			tier: "economy",
			cause: d.cause,
			turns: d.turns,
			idleMs: d.idleMs,
			lastTool: d.lastTool,
			stderrTail: d.stderrTail,
		});
		writeFailureArtifact(artifact, { metricsDir, project: "proj" });

		const parsed = JSON.parse(
			readFileSync(join(metricsDir, "proj", "fh-run-2.failure.json"), "utf-8"),
		) as {
			run_id: string;
			kind: string;
			cause: string;
			turns?: number;
			idle_ms?: number;
			spec_hash?: string;
			last_tool?: { name: string } | null;
		};
		check(parsed.run_id === "fh-run-2", "artifact keyed by the run id");
		check(parsed.kind === "worker", "single-worker kind recorded");
		check(
			parsed.cause.includes("wall-clock budget"),
			"watchdog cause travels into the artifact",
		);
		check(
			parsed.turns === 21 && parsed.idle_ms === 5000,
			"final-state counters travel (machine-readable)",
		);
		check(
			parsed.last_tool?.name === "bash",
			"last tool call recorded for post-mortem",
		);
		check(parsed.spec_hash === "abc123", "spec hash ties artifact to run");

		// Rule 6/R5 end-to-end: the single-run recovery block rides the
		// artifact's recovery field — serialize → write → parse → grep.
		const recovery = serializeSingleRunRecovery({
			rescued_commit: "qkzlvpyt",
			preserved_stubs: ["mnopqrst"],
			commands: ["jj show qkzlvpyt   # inspect", "jj new qkzlvpyt   # continue"],
		});
		const withRecovery = buildFailureArtifact({
			kind: "worker",
			runId: "fh-run-3",
			specHash: "abc123",
			cause: d.cause,
			turns: d.turns,
			idleMs: d.idleMs,
			lastTool: d.lastTool,
			stderrTail: d.stderrTail,
			recovery,
		});
		writeFailureArtifact(withRecovery, { metricsDir, project: "proj" });
		const raw = readFileSync(
			join(metricsDir, "proj", "fh-run-3.failure.json"),
			"utf-8",
		);
		check(
			/rescued_commit=qkzlvpyt/.test(raw),
			"failure artifact is grep-able for rescued_commit=<id>",
			);
		check(
			/preserved_stub=mnopqrst/.test(raw) && /jj new qkzlvpyt/.test(raw),
			"preserved stubs + continue commands travel verbatim in the artifact",
		);
	} finally {
		rmSync(metricsDir, { recursive: true, force: true });
	}
	console.log(
		"✓ worker failure artifact: diagnostics + spec hash round-trip (.failure.json)",
	);
}

// ─── 8. Pre-dispatch legacy-stray tolerance (real jj) ─────────────────

/**
 * The pre-dispatch gate (ensureDispatchableTree) on a repo littered by
 * PAST failed runs — the R2/R4 contract:
 *
 * legacy tolerance: mid-lineage engine strays (an empty AI stub left by a
 *   dead run) are classified and CLEANED in one pass — dispatch proceeds
 *   where the strict check alone would refuse; the rescue commit from an
 *   earlier failed run is ignorable base history, NEVER swept as junk.
 * user safety: the user's described commit and its content are untouched;
 *   the working copy's own resting empty @ (recreated by every jj command,
 *   any author) is never mistaken for a stray.
 */
async function testLegacyStrayTolerance(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-task-fh-legacy-"));
	const identityDir = mkdtempSync(join(tmpdir(), "pi-task-fh-legacy-id-"));
	try {
		initRepo(dir);
		const AI_EMAIL = "ai@test.dev";
		const identityFile = join(identityDir, "jj-identity.toml");
		writeFileSync(
			identityFile,
			aiIdentityToml("Pi (test-model)", AI_EMAIL),
			"utf-8",
		);

		// The user's own committed history.
		writeFileSync(join(dir, "user.txt"), "user prior work\n", "utf-8");
		jj(["commit", "-m", "feat: user prior work"], dir);

		// A PAST failed run's rescue commit (described, ignorable history),
		// its rescue-opened empty AI stub, one more empty AI stub on top,
		// and finally a plain user-side @ (the normal resting state).
		writeFileSync(join(dir, "salvaged.txt"), "rescued partial work\n", "utf-8");
		jj(
			[
				"--config-file",
				identityFile,
				"commit",
				"-m",
				"rescue: Build the widget. (wall_timeout)",
			],
			dir,
		);
		jj(["--config-file", identityFile, "new", "@"], dir); // empty AI stub (mid-lineage)
		jj(["new", "@"], dir); // fresh resting @ (user author)

		const report = await ensureDispatchableTree({
			cwd: dir,
			aiAuthorEmail: AI_EMAIL,
		});
		check(
			report.cleaned.some((c) => c.kind === "engine_stub"),
			`the mid-lineage empty AI stub is classified engine_stub and cleaned, got ${JSON.stringify(report.cleaned)}`,
		);
		check(
			report.preserved.length === 0,
			`nothing preserved when only engine strays exist, got ${JSON.stringify(report.preserved)}`,
		);
		// Dispatch proceeds past the gate that used to refuse.
		await assertCleanWorkingCopy(dir);

		// R4: the rescue commit was NEVER swept — description and content
		// survive verbatim; the user's history is untouched too.
		check(
			descriptions(dir).includes("rescue: Build the widget. (wall_timeout)"),
			"the earlier run's rescue commit survives dispatch (never junk)",
		);
		check(
			jj(["file", "list"], dir).includes("salvaged.txt"),
			"the rescue commit's salvaged content survives",
		);
		check(
			descriptions(dir).includes("feat: user prior work") &&
				jj(["file", "list"], dir).includes("user.txt"),
			"user's own described work untouched",
		);
		check(
			JSON.stringify(emptyUndescribedChangeIds(dir)) ===
				JSON.stringify([changeIdOf(dir, "@")]),
			`only the resting working-copy @ remains empty+undescribed, got ${JSON.stringify(emptyUndescribedChangeIds(dir))}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(identityDir, { recursive: true, force: true });
	}
	console.log(
		"✓ pre-dispatch legacy tolerance: engine strays cleaned in one pass, rescue commits kept, dispatch proceeds [CONTRACT]",
	);
}

/**
 * Legacy SNAPSHOT at @ (taxonomy classes 2/3): a past run died mid-edit
 * and jj snapshotted the dirty tail into an undescribed AI-authored
 * commit. Without tolerance this dirt BLOCKED every future dispatch
 * forever; the gate must clean it so the next run starts on a tree that
 * is actually the user's last commit (a left-behind tail would pollute
 * verification). A user-authored undescribed snapshot is instead
 * PRESERVED by doubt and reported — never destroyed (R4).
 */
async function testLegacySnapshotCleanup(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-task-fh-snap-"));
	try {
		initRepo(dir);
		const AI_EMAIL = "ai@test.dev";
		const identityFile = join(dir, "jj-identity.toml");
		writeFileSync(
			identityFile,
			aiIdentityToml("Pi (test-model)", AI_EMAIL),
			"utf-8",
		);
		writeFileSync(join(dir, "base.txt"), "base\n", "utf-8");
		jj(["commit", "-m", "feat: user prior work"], dir);

		// The wedged-run shape: AI stub @ holding a dirty tail, snapshotted.
		jj(["--config-file", identityFile, "new", "@"], dir);
		writeFileSync(join(dir, "wip.txt"), "half-done feature\n", "utf-8");
		jj(["status"], dir); // snapshot op → @ is now an undescribed non-empty commit
		check(
			countNonEmptyUndescribed(dir) >= 1,
			"fixture shaped: undescribed snapshot exists",
		);

		const report = await ensureDispatchableTree({
			cwd: dir,
			aiAuthorEmail: AI_EMAIL,
		});
		check(
			report.cleaned.some((c) => c.kind === "legacy_snapshot"),
			`the AI-authored undescribed snapshot is classified legacy_snapshot, got ${JSON.stringify(report.cleaned)}`,
		);
		check(report.preserved.length === 0, "nothing preserved (all strays engine-authored)");
		await assertCleanWorkingCopy(dir);
		check(
			countNonEmptyUndescribed(dir) === 0 &&
				!stubAuthorEmails(dir).includes(AI_EMAIL),
			"no undescribed content-bearing commit and no ENGINE-authored empty remains after cleanup (non-engine mechanical empties are not ours to delete)",
		);
		check(
			emptyUndescribedChangeIds(dir).filter(
				(id) => authorEmailOf(dir, id) === AI_EMAIL,
			).length === 0,
			"every surviving empty undescribed commit is non-engine",
		);
		check(
			!jj(["file", "list"], dir).includes("wip.txt"),
			"the abandoned tail is off the working tree (would have polluted verification)",
		);
		check(
			descriptions(dir).includes("feat: user prior work") &&
				jj(["file", "list"], dir).includes("base.txt"),
			"user's committed base intact",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log(
		"✓ pre-dispatch legacy snapshot: undescribed AI snapshot abandoned, dispatch unblocked [CONTRACT]",
	);
}

/**
 * User-authority boundaries (R4): the user's own uncommitted work STILL
 * blocks dispatch exactly as before, and a user-authored undescribed
 * stray is reported under `preserved`, never swept with the engine's.
 */
async function testUserWorkStillBlocks(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-task-fh-blocks-"));
	try {
		initRepo(dir);
		const AI_EMAIL = "ai@test.dev";
		const identityFile = join(dir, "jj-identity.toml");
		writeFileSync(
			identityFile,
			aiIdentityToml("Pi (test-model)", AI_EMAIL),
			"utf-8",
		);

		// Live user work-in-progress on top of a repo with NO legacy strays:
		// the gate must still refuse (unchanged behavior for genuine WIP).
		writeFileSync(join(dir, "wip.txt"), "live user edit\n", "utf-8");
		let blocked = false;
		try {
			await ensureDispatchableTree({ cwd: dir, aiAuthorEmail: AI_EMAIL });
		} catch {
			blocked = true;
		}
		check(blocked, "genuine user work-in-progress still blocks dispatch");
		check(
			existsSync(join(dir, "wip.txt")),
			"the blocking user work-in-progress is untouched",
		);
		jj(["commit", "-m", "feat: user wip"], dir);

		// A USER-authored undescribed snapshot sits in the lineage beside an
		// ENGINE-owned empty stub: only the engine's is cleaned; the user's
		// is preserved-by-doubt and named in the report.
		writeFileSync(join(dir, "manual.txt"), "manual scratch\n", "utf-8");
		jj(["status"], dir); // user-authored undescribed snapshot @
		jj(["--config-file", identityFile, "new", "@"], dir); // AI stub on top
		jj(["new", "@"], dir); // fresh resting @ (user side)
		const report = await ensureDispatchableTree({
			cwd: dir,
			aiAuthorEmail: AI_EMAIL,
		});
		check(
			report.preserved.length === 1 &&
				report.preserved[0]!.kind === "snapshot" &&
				authorEmailOf(dir, report.preserved[0]!.changeId) !== AI_EMAIL,
			`the user-authored undescribed snapshot is preserved-by-doubt with its author intact, got ${JSON.stringify(report.preserved)}`,
		);
		check(
			report.cleaned.length === 1 &&
				report.cleaned[0]!.kind === "engine_stub",
			`only the AI stub is cleaned, got ${JSON.stringify(report.cleaned)}`,
		);
		check(
			jj(["file", "list"], dir).includes("manual.txt"),
			"the preserved snapshot's content stays on disk",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log(
		"✓ user authority: live WIP still blocks, user-authored strays preserved & named, only engine junk cleaned [CONTRACT]",
	);
}

/**
 * R3 IDEMPOTENCE: running the recovery/cleanup path TWICE leaves the tree
 * identical the second time. Fixture: a repo carrying every legacy stray
 * class at once (mid-lineage engine stub, AI snapshot with a dirty tail,
 * rescue commit + its opened stub, user history). Pass 2 re-runs classify
 * + clean + the strict gate over pass 1's result: nothing is left to
 * move, so the visible-tree fingerprint (change ids + descriptions +
 * emptiness) and the tracked file list must match EXACTLY — no second
 * rescue, no re-abandoned change, no divergent duplicate copies created.
 */
async function testRecoveryIdempotence(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-task-fh-idem-"));
	try {
		initRepo(dir);
		const AI_EMAIL = "ai@test.dev";
		const identityFile = join(dir, "jj-identity.toml");
		writeFileSync(
			identityFile,
			aiIdentityToml("Pi (test-model)", AI_EMAIL),
			"utf-8",
		);

		// Every stray class at once.
		writeFileSync(join(dir, "user.txt"), "user prior work\n", "utf-8");
		jj(["commit", "-m", "feat: user prior work"], dir);
		writeFileSync(join(dir, "salvaged.txt"), "rescued partial work\n", "utf-8");
		jj(
			[
				"--config-file",
				identityFile,
				"commit",
				"-m",
				"rescue: Build the widget. (wall_timeout)",
			],
			dir,
		);
		jj(["--config-file", identityFile, "new", "@"], dir); // rescue-opened empty AI stub
		writeFileSync(join(dir, "wip.txt"), "half-done feature\n", "utf-8");
		jj(["status"], dir); // AI snapshot (undescribed, content-bearing)
		jj(["--config-file", identityFile, "new", "@"], dir); // another empty AI stub
		jj(["new", "@"], dir); // fresh resting @ (user side)

		// Pass 1 through the full gate (classify + clean + strict check).
		const report1 = await ensureDispatchableTree({
			cwd: dir,
			aiAuthorEmail: AI_EMAIL,
		});
		check(
			report1.cleaned.length >= 3 &&
				report1.cleaned.some((c) => c.kind === "legacy_snapshot"),
			`pass 1 cleans the stubs AND the snapshot, got ${JSON.stringify(report1.cleaned)}`,
		);
		const fingerprintAfterPass1 = treeFingerprint(dir);
		const filesAfterPass1 = fileList(dir);
		const rescuesAfterPass1 = descriptions(dir).filter((d) =>
			d.startsWith("rescue:"),
		);

		// Pass 2: same path again — must be a no-op on the tree.
		const report2 = await ensureDispatchableTree({
			cwd: dir,
			aiAuthorEmail: AI_EMAIL,
		});
		check(
			report2.cleaned.length === 0 && report2.preserved.length === 0,
			`pass 2 finds nothing left to clean or preserve, got ${JSON.stringify(report2)}`,
		);
		check(
			JSON.stringify(treeFingerprint(dir)) ===
				JSON.stringify(fingerprintAfterPass1),
			`visible tree identical after the second pass:\n  pass1=${JSON.stringify(fingerprintAfterPass1)}\n  pass2=${JSON.stringify(treeFingerprint(dir))}`,
		);
		check(
			JSON.stringify(fileList(dir)) === JSON.stringify(filesAfterPass1),
			"tracked files identical after the second pass",
		);
		check(
			descriptions(dir).filter((d) => d.startsWith("rescue:")).length ===
				rescuesAfterPass1.length,
			"no second rescue / no multiplied artifacts after the second pass",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log(
		"✓ recovery idempotence: second cleanup pass leaves the tree byte-identical (R3) [CONTRACT]",
	);
}

// ─── Runner ───────────────────────────────────────────────────────────

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	console.log(
		"── test-failure-hygiene: termination identity + single/user-abort/parallel footprints + stub suppression + artifact round-trip ──",
	);
	testTerminationIdentity(errors);
	await testSingleWorkerRescue(errors);
	await testUserAbortRescue(errors);
	await testParallelFlatWorkerFailure(errors);
	await testNoMergeStubSuppression(errors);
	await testWorkspaceAddStubLifetime(errors);
	testWorkerFailureArtifactRoundTrip(errors);
	await testLegacyStrayTolerance(errors);
	await testLegacySnapshotCleanup(errors);
	await testUserWorkStillBlocks(errors);
	await testRecoveryIdempotence(errors);

	if (errors.length > 0) {
		throw new Error(
			"test-failure-hygiene failed:\n  ✗ " + errors.join("\n  ✗ "),
		);
	}
	console.log("✓ failure-hygiene characterization assertions passed");
}

// Direct execution support: `npx tsx extensions/task/test-failure-hygiene.ts`
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error((err as Error).message ?? err);
			process.exit(1);
		});
}
