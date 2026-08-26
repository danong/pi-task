/**
 * Workspace isolation for parallel workers (Phase 6).
 *
 * Each parallel worker runs in its own jj workspace: an extra working
 * copy on the same repo (shared commits + op log, its own working-copy
 * commit). Workers commit freely without touching the main working copy;
 * the orchestrator combines every workspace's commits into the task base
 * in ONE jj operation (mergeWorkspacesAtomic — a single squash of all
 * workspace ranges, R1), resolves textual conflicts deterministically
 * with the jj-native "union" merge tool (resolveConflictsWithUnion, R4),
 * and removes the workspaces only after the full consistency gate
 * (assertMerged, R3) and verification pass. On merge failure the
 * workspaces are NEVER forgotten (R2) — the failure artifact records
 * them for scripted recovery.
 *
 * jj 0.43 mechanics pinned down empirically (see docs/pi-task-design.md):
 *
 * - Workspace names are NOT revsets ("Revision `ws1` doesn't exist").
 *   Resolve the workspace's working-copy commit id from
 *   `jj workspace list` (columns: name, change id, commit id, description).
 * - `jj squash --into <commit>` rewrites the target in place (same change
 *   id, new commit id) and auto-rebases descendants. The merge base must
 *   therefore be tracked by its CHANGE id and re-resolved to a commit id
 *   before EVERY squash — squashing into a stale commit id silently
 *   diverges (two workspaces merge into the old snapshot; no conflict).
 * - A divergent change (two or more VISIBLE commits sharing a change id —
 *   the op-log-fork signature, see below) makes `jj log -r <change>` fail
 *   with "Change ID ... is divergent". Resolution never picks a stale or
 *   arbitrary revision: it fails loudly instead.
 * - Squashing every workspace range in ONE operation (atomic combine,
 *   R1): `jj squash --from '<base>..<ws1-@>|<base>..<ws2-@>' --into
 *   <base>` (revset union is `|` — `+` is not a binary operator in jj
 *   0.43 revsets). The worker commits are abandoned in that single
 *   operation; the workspace @s are auto-rebased onto the rewritten
 *   base, empty.
 * - Conflicts do NOT fail the squash — they land in the base commit with
 *   conflict markers. Detect via `jj resolve --list -r <base>`: exit 0 +
 *   "<path> N-sided conflict" lines when conflicted; exit 2 + "No
 *   conflicts found" when clean.
 * - `jj resolve --tool union -r <commit> <path>` resolves conflicts
 *   directly in the commit's tree with the configured merge tool
 *   (merge-tools.<name>.program + merge-args with $base/$left/$right/
 *   $output placeholders). Non-zero tool exit keeps the conflict; git
 *   merge-file --union exits 0 when it applied the union (no markers).
 * - jj 0.43 has no `jj workspace remove` — cleanup is `jj workspace
 *   forget <name>` (abandons the now-empty @ commit) plus deleting the
 *   directory.
 * - jj snapshots the working copy on read-only commands too (`jj diff`,
 *   `jj status`, ...) when the on-disk state changed — writing a
 *   "snapshot working copy" op. Concurrent jj processes writing ops from
 *   the same op-log head FORK the op log (jj reconciles with a
 *   "Concurrent modification detected" op and can leave divergent
 *   changes). Orchestrator read-only commands therefore pass
 *   `--ignore-working-copy` (no snapshot op, no fork). The lone exception
 *   is assertCleanWorkingCopy, whose PURPOSE is the live working-copy
 *   state — it is the run's first jj op, when no other writer exists.
 *
 * Also exported for the orchestrator: assertCleanWorkingCopy (R1 guard),
 * detectChangeConflicts (final-state conflict check on the base change),
 * resolveCommitId (the surviving post-squash base commit id),
 * mergeWorkspacesAtomic (R1 atomic combine), resolveConflictsWithUnion
 * (R4 union ladder), workspaceFileChanges/diffForWorkspacePath (R5
 * overlap classification inputs), conflictHunks (R4 escalation payload)
 * and assertMerged (R3 post-merge consistency gate). Every jj call is
 * bounded by DEFAULT_JJ_TIMEOUT_MS (R5), overridable per call — a wedged
 * workspace can never hang the abort path.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Types ───────────────────────────────────────────────────────────

export interface MergeOutcome {
	/** Repo-relative paths with unresolved conflicts in the merged base. */
	conflicts: string[];
	/** The merged base's commit id (post-squash). */
	commit_id: string;
	/** Number of files the merge changed vs the pre-merge base. */
	files_changed: number;
}

/** One workspace's file changes vs the task base (R3/R5 input). */
export interface WorkspaceFileChange {
	/** Repo-relative path. For renames, the NEW path. */
	file: string;
	/** "A" added, "M" modified, "D" deleted, "R" renamed (jj diff
	 *  --summary first token) — open vocabulary: jj may add kinds, and
	 *  consumers treat unknown kinds conservatively. */
	kind: string;
}

interface JjResult {
	code: number;
	stdout: string;
	stderr: string;
	/** True when the call was killed by its timeout bound (R5). */
	timedOut?: boolean;
}

// ─── jj plumbing ─────────────────────────────────────────────────────

const MAX_JJ_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Default bound for EVERY jj call (R5, ~120s): a wedged jj process (op-log
 *  corruption, a stuck store lock) must never hang the orchestrator — least
 *  of all the abort/failure path, whose workspace-commit-id resolution and
 *  rescue commits run on wedged workspaces. Overridable per call; the
 *  failure path passes a tighter bound. */
export const DEFAULT_JJ_TIMEOUT_MS = 120_000;

/** Run jj; never throws (exit code + output captured for error messages).
 *  JJ_EDITOR=true in the child env: jj invokes the editor for squash even
 *  with --from/--into when descriptions differ — an interactive editor
 *  reading an idle pipe hangs the orchestrator.
 *  R5: bounded by opts.timeoutMs (default DEFAULT_JJ_TIMEOUT_MS) — a
 *  timed-out call resolves with code 1 + timedOut:true + a stderr note
 *  naming the bound, so every caller's error path stays bounded too. */
export function execJj(
	args: string[],
	cwd: string,
	opts?: { timeoutMs?: number },
): Promise<JjResult> {
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_JJ_TIMEOUT_MS;
	return new Promise((resolve) => {
		execFile(
			"jj",
			args,
			{
				cwd,
				timeout: timeoutMs,
				maxBuffer: MAX_JJ_OUTPUT_BYTES,
				env: { ...process.env, JJ_EDITOR: "true" },
			},
			(error, stdout, stderr) => {
				if (!error) {
					resolve({
						code: 0,
						stdout: stdout.toString(),
						stderr: stderr.toString(),
					});
					return;
				}
				const err = error as NodeJS.ErrnoException & {
					killed?: boolean;
					signal?: string;
				};
				// Timeout: execFile kills the child with SIGTERM (killed=true);
				// ETIMEDOUT is the older/other-platform shape.
				if (err.killed === true || err.code === "ETIMEDOUT") {
					resolve({
						code: 1,
						stdout: stdout.toString(),
						stderr:
							stderr.toString() +
							`\n(jj timed out after ${Math.round(timeoutMs / 1000)}s — command: jj ${args.join(" ")})`,
						timedOut: true,
					});
					return;
				}
				// Non-zero exit: error.code is the numeric exit code.
				// Spawn failures (ENOENT etc.): error.code is a string.
				const code = typeof err.code === "number" ? err.code : 1;
				resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
			},
		);
	});
}

/** Parse `jj workspace list` into name → { changeId, commitId }. */
function parseWorkspaceList(
	stdout: string,
): Map<string, { changeId: string; commitId: string }> {
	const result = new Map<string, { changeId: string; commitId: string }>();
	for (const line of stdout.split("\n")) {
		const match = /^(\S+):\s+(\S+)\s+(\S+)/.exec(line);
		if (match)
			result.set(match[1] ?? "", {
				// Groups 2/3 are \S+ atoms — present whenever the regex matched.
				changeId: match[2] ?? "",
				commitId: match[3] ?? "",
			});
	}
	return result;
}

/** Resolve a workspace's working-copy COMMIT id from `jj workspace list`
 *  (workspace names are NOT revsets). Exported for the orchestrator: the
 *  merge-failure artifact records each workspace's commit id (R2). The
 *  failure path passes a tighter timeoutMs — resolving ids on a wedged
 *  workspace must never stall the abort (R5). */
export async function workspaceCommitId(
	projectDir: string,
	name: string,
	opts?: { timeoutMs?: number },
): Promise<string> {
	const result = await execJj(["workspace", "list"], projectDir, opts);
	if (result.code !== 0) {
		throw new Error(
			`jj workspace list failed (${result.code}): ${result.stderr.trim()}`,
		);
	}
	const ws = parseWorkspaceList(result.stdout).get(name);
	if (!ws)
		throw new Error(`Workspace "${name}" not found in jj workspace list`);
	return ws.commitId;
}

/** Resolve a change id to its current commit id. Change ids are stable
 *  across `jj squash --into` rewrites; commit ids are not. Exported for
 *  the orchestrator: a parallel run's surviving commit is the base
 *  change's commit id resolved AFTER the last squash.
 *
 *  Never picks a stale or arbitrary revision: a divergent change (two or
 *  more visible commits sharing the change id — the op-log-fork
 *  signature) makes jj fail, and multi-match output is rejected. Either
 *  way the caller gets a loud error instead of squashing into the wrong
 *  commit (todo #71's corruption mode). */
export async function resolveCommitId(
	projectDir: string,
	changeId: string,
): Promise<string> {
	const result = await execJj(
		[
			"log",
			"-r",
			changeId,
			"-T",
			"commit_id",
			"--no-graph",
			"--ignore-working-copy",
		],
		projectDir,
	);
	if (result.code !== 0) {
		const stderr = result.stderr.trim();
		if (stderr.includes("is divergent")) {
			throw new Error(
				`change ${changeId} is DIVERGENT (multiple visible commits share the change id — ` +
					`signature of a concurrent jj session/op-log fork). Refusing to pick one arbitrarily; ` +
					`resolve the divergence (e.g. jj abandon) and re-run. jj: ${stderr.split("\n")[0]}`,
			);
		}
		if (stderr.includes("doesn't exist")) {
			throw new Error(
				`change ${changeId} has NO visible commit (hidden or abandoned — a stale-target squash ` +
					`can hide the whole merged base, todo #71). Refusing to verify a tree without the ` +
					`integrated work. jj: ${stderr.split("\n")[0]}`,
			);
		}
		throw new Error(`jj log -r ${changeId} failed (${result.code}): ${stderr}`);
	}
	const id = result.stdout.trim();
	if (!/^[0-9a-f]{40}$/.test(id)) {
		throw new Error(
			`jj log -r ${changeId}: expected a single 40-hex commit id, got ${JSON.stringify(id)} ` +
				"(multiple matches or unexpected output — the change may be divergent)",
		);
	}
	return id;
}

/** The task base's CHANGE id: the parent of the main working-copy commit
 *  at task start (main @ is empty; @- is the commit workers build on).
 *  `--ignore-working-copy`: the recorded @ (fresh from the
 *  assertCleanWorkingCopy snapshot, the run's first jj op) is exact — no
 *  snapshot op to race later writers with (todo #70). */
export async function taskBaseChangeId(projectDir: string): Promise<string> {
	const result = await execJj(
		[
			"log",
			"-r",
			"@-",
			"-T",
			"change_id",
			"--no-graph",
			"--ignore-working-copy",
		],
		projectDir,
	);
	if (result.code !== 0) {
		throw new Error(
			`jj log -r @- failed (${result.code}): ${result.stderr.trim()}`,
		);
	}
	const id = result.stdout.trim();
	if (!id) {
		throw new Error(
			"jj log -r @-: no task base commit found (repo needs a starter commit)",
		);
	}
	return id;
}

/**
 * The parallel-run merge target: a fresh EMPTY commit authored as the AI
 * identity (todo #84), parented on @- (the user's last commit), described
 * with the spec goal. The workspaces' work is squashed into it, so the
 * merged parallel commit is AI-authored — jj squash keeps the DESTINATION
 * commit's author, so squashing into the user's base would silently
 * attribute AI work to the user. jj 0.43 has no author-reset, so the
 * identity must be set at creation: `jj --config-file <identity> new @-`
 * (--config-file MERGES with the user config, unlike the JJ_CONFIG env
 * var — verified: author+committer follow the identity while the user's
 * revset aliases survive).
 *
 * Returns the new commit's CHANGE id (the base for mergeWorkspacesAtomic).
 *
 * @param identityFile path to a jj config with the AI identity.
 * @param goal the spec's Goal line — the merged commit's description.
 */
export async function createAiTaskBase(
	projectDir: string,
	identityFile: string,
	goal: string,
): Promise<string> {
	const newResult = await execJj(
		["--config-file", identityFile, "new", "@-"],
		projectDir,
	);
	if (newResult.code !== 0) {
		throw new Error(
			`jj new @- failed (${newResult.code}): ${newResult.stderr.trim()}`,
		);
	}
	const describeResult = await execJj(
		["describe", "-m", `task: ${goal}`],
		projectDir,
	);
	if (describeResult.code !== 0) {
		throw new Error(
			`jj describe failed (${describeResult.code}): ${describeResult.stderr.trim()}`,
		);
	}
	const idResult = await execJj(
		[
			"log",
			"-r",
			"@",
			"-T",
			"change_id",
			"--no-graph",
			"--ignore-working-copy",
		],
		projectDir,
	);
	if (idResult.code !== 0 || !idResult.stdout.trim()) {
		throw new Error(
			`jj log -r @ failed (${idResult.code}): ${idResult.stderr.trim()}`,
		);
	}
	return idResult.stdout.trim();
}

// ─── Workspace lifecycle ─────────────────────────────────────────────

/**
 * Create a jj workspace for one worker. The workspace's working-copy
 * commit starts at the task base (@- of the main working copy), so the
 * worker commits freely without touching the main working copy.
 *
 * @returns the workspace directory — the worker's cwd.
 */
export async function createWorkspace(
	projectDir: string,
	name: string,
): Promise<string> {
	const parent = mkdtempSync(join(tmpdir(), "pi-task-parallel-"));
	const dir = join(parent, name);
	const result = await execJj(
		["workspace", "add", dir, "--name", name],
		projectDir,
	);
	if (result.code !== 0) {
		rmSync(parent, { recursive: true, force: true });
		throw new Error(
			`jj workspace add "${name}" failed (${result.code}): ${result.stderr.trim()}`,
		);
	}
	return dir;
}

/** Summary lines of `jj diff --from <from> --to <to>` ("M path", "A path", ...).
 *  Explicit commit ids only — no @ evaluation, no working-copy snapshot. */
async function diffSummary(
	projectDir: string,
	from: string,
	to: string,
): Promise<string[]> {
	const result = await execJj(
		["diff", "--from", from, "--to", to, "--summary"],
		projectDir,
	);
	if (result.code !== 0) {
		throw new Error(
			`jj diff --from ${from} --to ${to} failed (${result.code}): ${result.stderr.trim()}`,
		);
	}
	return result.stdout.split("\n").filter((line) => line.trim().length > 0);
}

/**
 * Parse `jj diff --summary` lines into file changes. Renames print as a
 * single token "R {old => new}" (verified on jj 0.43) — the NEW path is
 * the one whose presence matters for the merged-tree gate. The path token
 * itself may contain spaces ("{old => new}"), so the kind is split off
 * with a first-token match, never `split(/\s+/)` (which would cut the
 * rename token at its inner spaces). Pure.
 */
export function parseSummaryChanges(lines: string[]): WorkspaceFileChange[] {
	const changes: WorkspaceFileChange[] = [];
	for (const line of lines) {
		const match = /^(\S+)\s+(.*)$/.exec(line.trim());
		if (!match) continue;
		// Both groups participate in every match: group 1 is a \S+ atom,
		// group 2 always has at least that atom's content.
		const kind = match[1] ?? "";
		const pathToken = match[2] ?? "";
		const rename = /^\{([^}]+) => ([^}]+)\}$/.exec(pathToken);
		changes.push({ kind, file: rename?.[2] ?? pathToken });
	}
	return changes;
}

/**
 * Repo-relative file changes of one workspace vs the task base (R5/R3
 * input): `jj diff --from <base> --to <ws-@> --summary`, parsed into
 * path + kind. Used for the pre-merge overlap classification and the
 * union-file-presence half of the post-merge consistency gate.
 */
export async function workspaceFileChanges(
	projectDir: string,
	baseChangeId: string,
	name: string,
): Promise<WorkspaceFileChange[]> {
	const baseCommit = await resolveCommitId(projectDir, baseChangeId);
	const wsAt = await workspaceCommitId(projectDir, name);
	const result = await execJj(
		["diff", "--from", baseCommit, "--to", wsAt, "--summary"],
		projectDir,
	);
	if (result.code !== 0) {
		throw new Error(
			`jj diff (workspace "${name}" vs base) failed (${result.code}): ${result.stderr.trim()}`,
		);
	}
	return parseSummaryChanges(
		result.stdout.split("\n").filter((line) => line.trim().length > 0),
	);
}

/**
 * Repo-relative paths changed between two EXPLICIT revisions (`jj diff
 * --summary`, parsed) — used by the single-worker finalization-incomplete
 * path to report the aborted worker's files (R2: the worker never yielded,
 * so the yield payload's files_changed is unavailable).
 */
export async function filesChangedBetween(
	projectDir: string,
	from: string,
	to: string,
): Promise<string[]> {
	// --ignore-working-copy: read-only diff — no snapshot op (todo #70's
	// op-log-fork discipline); @- resolves from the recorded working-copy
	// commit, which is exact for this purpose.
	const result = await execJj(
		["diff", "--from", from, "--to", to, "--summary", "--ignore-working-copy"],
		projectDir,
	);
	if (result.code !== 0) {
		throw new Error(
			`jj diff --from ${from} --to ${to} failed (${result.code}): ${result.stderr.trim()}`,
		);
	}
	return parseSummaryChanges(
		result.stdout.split("\n").filter((line) => line.trim().length > 0),
	).map((c) => c.file);
}

/**
 * `jj diff --git` output for ONE path as changed by one workspace — the
 * R5 overlap-classification input (the pure classifier lives in
 * orchestrator.ts). Empty when the workspace did not touch the path.
 */
export async function diffForWorkspacePath(
	projectDir: string,
	baseChangeId: string,
	name: string,
	path: string,
): Promise<string> {
	const baseCommit = await resolveCommitId(projectDir, baseChangeId);
	const wsAt = await workspaceCommitId(projectDir, name);
	const result = await execJj(
		["diff", "--from", baseCommit, "--to", wsAt, "--git", path],
		projectDir,
	);
	if (result.code !== 0) {
		throw new Error(
			`jj diff --git (workspace "${name}" vs base, ${path}) failed (${result.code}): ${result.stderr.trim()}`,
		);
	}
	return result.stdout;
}

// ─── Atomic combine + deterministic union ladder (R1/R4) ─────────────

/**
 * The jj-native custom merge tool "union" (R4): backed by `git
 * merge-file --union`. jj 0.43's merge-tools contract (verified
 * empirically): `merge-tools.<name>.program` + `merge-tools.<name>
 * .merge-args` with $base/$left/$right/$output placeholders; a non-zero
 * exit leaves the conflict in place (unless listed in
 * merge-conflict-exit-codes, which we deliberately do NOT set).
 *
 * git merge-file has no -o flag, so a sh wrapper redirects `-p` stdout
 * into $output; `&& test -s "$output"` guards the binary/error case:
 * git merge-file exits 255 without output on binary files, so an empty
 * result exits non-zero and jj KEEPS the conflict (escalation) — a
 * false "resolved" with empty content must never pass the gate. git
 * merge-file --union exits 0 when it applied the union (no markers), so
 * no exit-code mapping is needed.
 */
const UNION_TOOL = "union";
const UNION_SCRIPT =
	'git merge-file --union -p "$1" "$2" "$3" > "$4" && test -s "$4"';

/** jj global `--config` args defining the union merge tool. */
function unionToolConfigArgs(): string[] {
	const escaped = UNION_SCRIPT.replace(/"/g, '\\"');
	return [
		`merge-tools.${UNION_TOOL}.program=sh`,
		`merge-tools.${UNION_TOOL}.merge-args=["-c","${escaped}","pi-union","$left","$base","$right","$output"]`,
	];
}

/**
 * Run jj with extra global `--config <NAME=VALUE>` args (the union
 * merge-tool definition). Global options precede the subcommand.
 */
function execJjConfigured(
	args: string[],
	cwd: string,
	configArgs: string[],
): Promise<JjResult> {
	const flat: string[] = [];
	for (const config of configArgs) flat.push("--config", config);
	return execJj([...flat, ...args], cwd);
}

/**
 * The post-squash invariant per workspace: the squash consumed every
 * worker commit, so each workspace's working-copy commit is DIFF-EMPTY
 * vs its OWN PARENT — whether jj auto-rebased it onto the rewritten
 * base or left it on the pre-merge base. (Diffing against the rewritten
 * base instead is WRONG: an empty stub left on the old base shows every
 * merged file as a deletion — the false-alarm class that made a
 * successful merge look like lost work.) A non-empty diff means the
 * workspace holds changes the squash did not consume: leftover commits
 * or uncommitted work. Throws with the precise leftover list.
 */
export async function assertWorkspacesConsumed(
	projectDir: string,
	workspaceNames: string[],
): Promise<void> {
	for (const name of workspaceNames) {
		const wsAt = await workspaceCommitId(projectDir, name);
		const leftover = await diffSummary(projectDir, `${wsAt}-`, wsAt);
		if (leftover.length > 0) {
			throw new Error(
				`jj squash did not fully consume workspace "${name}" — its working-copy commit still has ` +
					`changes vs its parent (${leftover.join(", ")}). Nothing was lost: the squash's merged delta ` +
					`lives in the task base; these are the workspace's own unconsumed changes.`,
			);
		}
	}
}

/**
 * R1: ATOMIC combine — every workspace's commits land in the task base
 * in ONE jj operation: a single `jj squash --from '<base>..<ws1-@> |
 * <base>..<ws2-@> | …' --into <base>`. (Revset union is `|`; `+` is not
 * a binary operator in jj 0.43 revsets.) There is no incremental
 * per-workspace squash into a moving base, so the observed failure class
 * — a mid-loop squash failure leaving a partial merge with dangling
 * sibling commits — cannot occur.
 *
 * After the squash, verifies the provable-integration invariant per
 * workspace (its @ sits on the CURRENT base with zero remaining diff),
 * then returns the conflicts that landed in the base (they do not fail
 * the squash — jj 3-way merge is rung 1 of the R4 conflict ladder).
 */
export async function mergeWorkspacesAtomic(
	projectDir: string,
	workspaceNames: string[],
	into: string,
): Promise<MergeOutcome> {
	if (workspaceNames.length === 0) {
		const base = await resolveCommitId(projectDir, into);
		return { conflicts: [], commit_id: base, files_changed: 0 };
	}
	const baseCommit = await resolveCommitId(projectDir, into);
	const wsAtIds = await Promise.all(
		workspaceNames.map((n) => workspaceCommitId(projectDir, n)),
	);
	const from = wsAtIds.map((id) => `(${baseCommit}..${id})`).join("|");

	const squash = await execJj(
		["squash", "--from", from, "--into", baseCommit],
		projectDir,
	);
	if (squash.code !== 0) {
		throw new Error(
			`jj squash (atomic combine of ${workspaceNames.length} workspace(s)) failed (${squash.code}): ` +
				squash.stderr.trim(),
		);
	}

	// Provable integration: the single squash consumed EVERY worker commit.
	const newBase = await resolveCommitId(projectDir, into);
	await assertWorkspacesConsumed(projectDir, workspaceNames);
	const filesChanged = (await diffSummary(projectDir, baseCommit, newBase))
		.length;
	return {
		conflicts: await detectConflicts(projectDir, newBase),
		commit_id: newBase,
		files_changed: filesChanged,
	};
}

/**
 * R4 rung 2: resolve the given conflicted files with the jj-native
 * "union" merge tool (git merge-file --union — both sides' hunks are
 * kept, deterministic, no markers). Runs on the base commit directly
 * (`jj resolve --tool union -r <base> <path>` — resolves in the
 * commit's tree, rewriting it; verified on jj 0.43).
 *
 * ONE FILE PER INVOCATION: `jj resolve --tool <tool> <p1> <p2> ...`
 * ABORTS the whole command on the first tool failure (e.g. a binary
 * file makes git merge-file exit 255 — "Error: Failed to resolve
 * conflicts", no op written), which would strand every later path's
 * conflict unresolved. Resolving per-file keeps each failure isolated:
 * a failed file stays conflicted (escalation) while the rest still
 * resolve. Each successful resolve REWRITES the base commit, so the
 * commit id is re-resolved before every file.
 *
 * Best-effort by design: a tool failure (binary file, tool error) leaves
 * the conflict in place — the authoritative post-check
 * (detectChangeConflicts) decides what escalates. jj's stderr noise is
 * captured, never printed.
 */
export async function resolveConflictsWithUnion(
	projectDir: string,
	changeId: string,
	paths: string[],
): Promise<void> {
	for (const path of paths) {
		const commitId = await resolveCommitId(projectDir, changeId);
		await execJjConfigured(
			["resolve", "--tool", UNION_TOOL, "-r", commitId, "--", path],
			projectDir,
			unionToolConfigArgs(),
		);
	}
}

/**
 * Escalation payload (R4): the conflicted file contents (conflict
 * markers included) of the given paths in a commit, bounded per file.
 * Best-effort — failures yield an empty map (the artifact write must
 * never mask the run's outcome).
 */
export async function conflictHunks(
	projectDir: string,
	changeId: string,
	paths: string[],
	maxBytesPerFile = 8 * 1024,
): Promise<Record<string, string>> {
	const hunks: Record<string, string> = {};
	for (const path of paths) {
		try {
			const commitId = await resolveCommitId(projectDir, changeId);
			const result = await execJj(
				["file", "show", "-r", commitId, "--", path],
				projectDir,
			);
			if (result.code === 0)
				hunks[path] = result.stdout.slice(0, maxBytesPerFile);
		} catch {
			// Best effort — escalation proceeds with the paths alone.
		}
	}
	return hunks;
}

/** List unresolved conflict paths in a commit. `jj resolve --list -r`:
 *  exit 0 + "<path> N-sided conflict" lines when conflicted;
 *  exit 2 + "No conflicts found" (printed to stderr) when clean. */
async function detectConflicts(
	projectDir: string,
	commitId: string,
): Promise<string[]> {
	const result = await execJj(
		["resolve", "--list", "-r", commitId],
		projectDir,
	);
	const all = `${result.stdout}\n${result.stderr}`;
	if (result.code === 2 && all.includes("No conflicts found")) return [];
	if (result.code !== 0) {
		throw new Error(
			`jj resolve --list -r ${commitId} failed (${result.code}): ${all.trim()}`,
		);
	}
	const paths: string[] = [];
	for (const line of result.stdout.split("\n")) {
		const match = /^(\S+)\s+\d+-sided conflict/.exec(line.trim());
		if (match) paths.push(match[1] ?? "");
	}
	return paths;
}

/**
 * Unresolved conflict paths in the current commit of a change id — the
 * FINAL-state conflict check. Squashes rewrite the commit (not the change),
 * so the change is re-resolved to its latest commit before listing its
 * conflicts. The orchestrator uses this once, after ALL workspaces merged,
 * instead of unioning per-squash conflict lists (a later squash's changes
 * can change the conflict state, so per-squash lists are stale).
 */
export async function detectChangeConflicts(
	projectDir: string,
	changeId: string,
): Promise<string[]> {
	const commitId = await resolveCommitId(projectDir, changeId);
	return detectConflicts(projectDir, commitId);
}

/**
 * Provable-integration + consistency gate (R2/R3, todo #71 observation
 * 3): after ALL workspaces merged, assert that
 *
 *  - every workspace's working-copy commit is a DESCENDANT of the
 *    current merged base with zero remaining diff (every worker commit
 *    reachable from the merged result — R3), AND the main working copy
 *    sits directly on the merged base with zero diff,
 *  - the merged tree is non-empty and holds the union of the workers'
 *    added/modified files (`expectedFiles`, computed pre-merge — R3),
 *
 * The orchestrator runs this BEFORE verification and before workspace
 * cleanup — a merge that targeted a stale/pre-rewrite base (or never
 * ran) leaves worker changes OUTSIDE the current base, which would let
 * verification pass trivially on a working copy without the integrated
 * work. Fails the run loudly instead.
 *
 * Throws when the base change has no visible commit (the whole change
 * was rewritten into a hidden revision) or when any check fails, naming
 * the offenders.
 */
export async function assertMerged(
	projectDir: string,
	workspaceNames: string[],
	baseChangeId: string,
	opts: { expectedFiles: string[] },
): Promise<void> {
	const base = await resolveCommitId(projectDir, baseChangeId);
	const problems: string[] = [];
	// R3: the merged tree must be non-empty and contain the union of the
	// workers' added/modified files (computed pre-merge by the
	// orchestrator). A green verification on a tree missing the integrated
	// work is the false-success mode this gate exists to prevent. This
	// union check also catches the dangling-commit class on its own: an
	// unmerged workspace's content is simply absent from the base tree.
	//
	// Deliberately NO per-workspace checks against the merged base
	// (reachability / diff): jj sometimes leaves the (empty) workspace
	// stubs on the PRE-merge base instead of auto-rebasing them onto the
	// rewritten base, and both checks false-alarm on that shape — the
	// workspace stubs are throwaway; the union checks below are what
	// matter.
	const fileList = await execJj(
		["file", "list", "-r", base, "--ignore-working-copy"],
		projectDir,
	);
	if (fileList.code !== 0) {
		problems.push(
			`jj file list -r <merged base> failed (${fileList.code}): ${fileList.stderr.trim().split("\n")[0]}`,
		);
	} else {
		const files = new Set(
			fileList.stdout.split("\n").filter((l) => l.trim().length > 0),
		);
		if (files.size === 0) problems.push("the merged tree is EMPTY");
		for (const f of opts.expectedFiles) {
			if (!files.has(f)) {
				problems.push(
					`merged tree is missing "${f}" — the union of worker file changes is not present`,
				);
			}
		}
	}
	// The verification gate runs on the WORKING TREE (cwd), not on a jj
	// snapshot: prove the on-disk tree contains the merged work. (Checking
	// @/@- identity against the base false-alarms when the working copy
	// holds the merged files but the recorded commit lags the disk — the
	// gate is read-only and never snapshots.)
	for (const f of opts.expectedFiles) {
		if (!existsSync(join(projectDir, f))) {
			problems.push(
				`working tree is missing "${f}" — verification would run on a tree without the merged work`,
			);
		}
	}
	if (problems.length > 0) {
		throw new Error(
			"parallel merge did NOT integrate all worker changes into the task base — refusing to " +
				"verify a tree without the merged work:\n  - " +
				problems.join("\n  - "),
		);
	}
}

/**
 * The merged base must be a VISIBLE commit (assertMerged's postconditions
 * — main @- and every workspace @ directly on it — can only hold for a
 * visible head; a stale-target squash hides the whole base chain). Run
 * after assertMerged so a divergent base (op-log fork) is also caught.
 *
 * jj 0.43 reports a fully hidden change as "Revision ... doesn't exist",
 * which resolveCommitId already turns into the "NO visible commit" error;
 * the zero-id check below is a defensive guard for jj versions that
 * resolve a hidden change to the all-zero commit id instead.
 */
export async function assertVisibleCommit(
	projectDir: string,
	changeId: string,
): Promise<void> {
	const id = await resolveCommitId(projectDir, changeId);
	if (!/^[0-9a-f]{40}$/.test(id) || /^0+$/.test(id)) {
		throw new Error(
			`base change ${changeId} has NO visible commit (id ${JSON.stringify(id)}) — ` +
				"the merge rewrote the base into a hidden revision. Refusing to verify a tree " +
				"without the integrated work.",
		);
	}
}

/**
 * R1 guard: the orchestrator requires a CLEAN main working copy. The
 * single path commits task work into the main working copy; the parallel
 * path squashes workspace commits under it — either way, pre-existing user
 * changes would be silently bundled into task commits. Fails fast when `@`
 * differs from its parent (e.g. `jj diff --from @- --to @ --summary` is
 * non-empty), with a short `jj status` excerpt. Real jj, hermetic-testable.
 *
 * Deliberately does NOT use --ignore-working-copy: its purpose is the LIVE
 * on-disk state, and it is the run's FIRST jj op — nothing else writes ops
 * yet, so its snapshot cannot race another process (todo #70).
 */
export async function assertCleanWorkingCopy(cwd: string): Promise<void> {
	const diff = await execJj(
		["diff", "--from", "@-", "--to", "@", "--summary"],
		cwd,
	);
	if (diff.code !== 0) {
		throw new Error(
			`jj diff --from @- --to @ failed (${diff.code}): ${diff.stderr.trim()}`,
		);
	}
	if (diff.stdout.trim().length > 0) {
		const status = await execJj(["status"], cwd);
		const excerpt = (status.stdout.trim() || status.stderr.trim())
			.split("\n")
			.slice(0, 8)
			.join("\n");
		throw new Error(
			"task requires a clean working copy — commit or stash your changes before dispatching" +
				(excerpt ? `\njj status excerpt:\n${excerpt}` : ""),
		);
	}
}

/**
 * Remove a workspace: `jj workspace forget` (abandons the now-empty @
 * commit) and delete its directory when `dir` is provided.
 */
export async function removeWorkspace(
	projectDir: string,
	name: string,
	dir?: string,
): Promise<void> {
	const result = await execJj(["workspace", "forget", name], projectDir);
	if (result.code !== 0) {
		throw new Error(
			`jj workspace forget "${name}" failed (${result.code}): ${result.stderr.trim()}`,
		);
	}
	if (dir) rmSync(dir, { recursive: true, force: true });
}
