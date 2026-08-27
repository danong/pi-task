/**
 * jj primitives — M2.c (the v1 ladder ported VERBATIM, semantics unchanged).
 *
 * Ported from extensions/task/workspace.ts (read-only reference; no import).
 * Every empirical jj 0.43 mechanic documented there holds here: change-id
 * tracking for squash targets, atomic revset-union combine, per-file union
 * resolution, --ignore-working-copy read discipline, JJ_EDITOR=true,
 * bounded every-call timeouts, loud divergent-change failures.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface JjResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
}

export const DEFAULT_JJ_TIMEOUT_MS = 120_000;
const MAX_JJ_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Run jj; never throws. JJ_EDITOR=true (jj opens an editor for squash even
 *  with --from/--into when descriptions differ — an interactive editor on an
 *  idle pipe hangs the caller). Bounded by timeoutMs: a timed-out call
 *  resolves code 1 + timedOut, so error paths stay bounded too. */
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
				const err = error as NodeJS.ErrnoException & { killed?: boolean };
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
				resolve({
					code: typeof err.code === "number" ? err.code : 1,
					stdout: stdout.toString(),
					stderr: stderr.toString(),
				});
			},
		);
	});
}

/** True when the repo has a git remote configured. */
export async function hasGitRemote(projectDir: string): Promise<boolean> {
	const r = await execJj(["git", "remote", "list"], projectDir);
	return r.code === 0 && r.stdout.trim().length > 0;
}

/** Fetch remotes; NON-FATAL by contract (local-only repos must work). */
export async function fetchIfRemote(projectDir: string): Promise<void> {
	if (!(await hasGitRemote(projectDir))) return;
	await execJj(["git", "fetch"], projectDir);
}

export interface WorkspaceRevision {
	changeId: string;
	commitId: string;
}

/** Parse the deliberately tab-delimited `jj workspace list -T` output. */
export function parseMachineWorkspaceList(
	stdout: string,
): Map<string, WorkspaceRevision> {
	const result = new Map<string, WorkspaceRevision>();
	for (const rawLine of stdout.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		const fields = line.split("\t");
		if (
			fields.length !== 3 ||
			fields[0] === undefined ||
			fields[1] === undefined ||
			fields[2] === undefined ||
			!/^[a-z0-9]{32}$/.test(fields[1]) ||
			!/^[0-9a-f]{40}$/.test(fields[2])
		)
			continue;
		result.set(fields[0], { changeId: fields[1], commitId: fields[2] });
	}
	return result;
}

const MACHINE_WORKSPACE_TEMPLATE =
	'self.name() ++ "\\t" ++ self.target().change_id() ++ "\\t" ++ self.target().commit_id() ++ "\\n"';

/** A workspace's working-copy revision via machine-readable jj output. */
export async function workspaceRevision(
	projectDir: string,
	name: string,
	opts?: { timeoutMs?: number },
): Promise<WorkspaceRevision> {
	const result = await execJj(
		["workspace", "list", "-T", MACHINE_WORKSPACE_TEMPLATE, "--ignore-working-copy"],
		projectDir,
		opts,
	);
	if (result.code !== 0)
		throw new Error(
			`jj workspace list failed (${result.code}): ${result.stderr.trim()}`,
		);
	const ws = parseMachineWorkspaceList(result.stdout).get(name);
	if (!ws)
		throw new Error(`Workspace "${name}" not found in jj workspace list`);
	return ws;
}

/** A workspace's working-copy COMMIT id via machine-readable jj output. */
export async function workspaceCommitId(
	projectDir: string,
	name: string,
	opts?: { timeoutMs?: number },
): Promise<string> {
	return (await workspaceRevision(projectDir, name, opts)).commitId;
}

/** Change id → current commit id. Divergent / hidden changes fail LOUDLY —
 *  never a stale or arbitrary squash target. */
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
				`change ${changeId} is DIVERGENT (multiple visible commits share the change id). ` +
					`Refusing to pick one arbitrarily; resolve the divergence and re-run. jj: ${stderr.split("\n")[0]}`,
			);
		}
		if (stderr.includes("doesn't exist")) {
			throw new Error(
				`change ${changeId} has NO visible commit (hidden or abandoned). Refusing to proceed ` +
					`without the integrated work. jj: ${stderr.split("\n")[0]}`,
			);
		}
		throw new Error(`jj log -r ${changeId} failed (${result.code}): ${stderr}`);
	}
	const id = result.stdout.trim();
	if (!/^[0-9a-f]{40}$/.test(id)) {
		throw new Error(
			`jj log -r ${changeId}: expected one 40-hex commit id, got ${JSON.stringify(id)}`,
		);
	}
	return id;
}

/** Resolve one revision to both jj identities using a template, never human
 *  log output. The caller supplies an explicit revision such as @-. */
export async function revisionIdentity(
	projectDir: string,
	revision: string,
): Promise<WorkspaceRevision> {
	const result = await execJj(
		[
			"log",
			"-r",
			revision,
			"-T",
			'commit_id ++ "\\t" ++ change_id ++ "\\n"',
			"--no-graph",
			"--ignore-working-copy",
		],
		projectDir,
	);
	if (result.code !== 0)
		throw new Error(
			`jj log -r ${revision} failed (${result.code}): ${result.stderr.trim()}`,
		);
	const fields = result.stdout.trimEnd().split("\t");
	if (
		fields.length !== 2 ||
		fields[0] === undefined ||
		fields[1] === undefined ||
		!/^[0-9a-f]{40}$/.test(fields[0]) ||
		!/^[a-z0-9]{32}$/.test(fields[1])
	)
		throw new Error(
			`jj log -r ${revision}: expected one machine-readable commit/change pair`,
		);
	return { commitId: fields[0], changeId: fields[1] };
}

/** The task base's CHANGE id (@- of the main working copy at task start). */
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
	if (result.code !== 0)
		throw new Error(
			`jj log -r @- failed (${result.code}): ${result.stderr.trim()}`,
		);
	const id = result.stdout.trim();
	if (!id)
		throw new Error(
			"jj log -r @-: no task base commit found (repo needs a starter commit)",
		);
	return id;
}

/** Write the AI-identity temp config file ([user] name/email TOML). */
export function writeIdentityFile(
	authorName: string,
	authorEmail: string,
): string {
	const dir = mkdtempSync(join(tmpdir(), "core-v2-jj-id-"));
	const file = join(dir, "identity.toml");
	writeFileSync(
		file,
		`[user]\nname = "${authorName}"\nemail = "${authorEmail}"\n`,
		"utf-8",
	);
	return file;
}

/** AI-authored empty integration base parented on @-, described with the
 *  goal (--config-file MERGES with user config, keeping revset aliases). */
export async function createAiTaskBase(
	projectDir: string,
	identityFile: string,
	goal: string,
): Promise<string> {
	const newResult = await execJj(
		["--config-file", identityFile, "new", "@-"],
		projectDir,
	);
	if (newResult.code !== 0)
		throw new Error(
			`jj new @- failed (${newResult.code}): ${newResult.stderr.trim()}`,
		);
	const describeResult = await execJj(
		["describe", "-m", `task: ${goal}`],
		projectDir,
	);
	if (describeResult.code !== 0)
		throw new Error(
			`jj describe failed (${describeResult.code}): ${describeResult.stderr.trim()}`,
		);
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

/** Commit a worker's snapshotted edits with the engine identity.
 *
 * The worker workspace already has a working-copy commit when this runs. A
 * `jj commit` alone snapshots that existing commit and therefore keeps the
 * identity it was created with. Create the destination with the temporary
 * identity first, move the snapshotted delta into it, then snapshot the
 * working tree there. The temporary source is abandoned by `jj squash`; any
 * model-created parent commit remains untouched.
 */
export async function commitWorkspaceEdits(
	projectDir: string,
	identityFile: string,
	message: string,
	author?: { name: string; email: string },
): Promise<void> {
	const config =
		author === undefined
			? []
			: [
					"--config",
					`user.name=${JSON.stringify(author.name)}`,
					"--config",
					`user.email=${JSON.stringify(author.email)}`,
				];
	const newResult = await execJj(
			[...config, "--config-file", identityFile, "new", "@"],
			projectDir,
	);
	if (newResult.code !== 0)
		throw new Error(
			`jj new (engine finalization identity) failed (${newResult.code}): ${newResult.stderr.trim()}`,
		);
	const squashResult = await execJj(
			["squash", "--from", "@-", "--into", "@", "-m", message],
			projectDir,
	);
	if (squashResult.code !== 0)
		throw new Error(
			`jj squash (engine finalization) failed (${squashResult.code}): ${squashResult.stderr.trim()}`,
		);
	const commitResult = await execJj(
			[...config, "--config-file", identityFile, "commit", "-m", message],
			projectDir,
	);
	if (commitResult.code !== 0)
		throw new Error(
			`jj commit (engine finalization) failed (${commitResult.code}): ${commitResult.stderr.trim()}`,
		);
}

/** Create one worker workspace rooted at the current base. Returns its dir. */
export async function createWorkerWorkspace(
	projectDir: string,
	name: string,
): Promise<string> {
	const parent = mkdtempSync(join(tmpdir(), "core-v2-ws-"));
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

async function diffSummary(
	projectDir: string,
	from: string,
	to: string,
): Promise<string[]> {
	const result = await execJj(
		["diff", "--from", from, "--to", to, "--summary"],
		projectDir,
	);
	if (result.code !== 0)
		throw new Error(
			`jj diff --from ${from} --to ${to} failed (${result.code}): ${result.stderr.trim()}`,
		);
	return result.stdout.split("\n").filter((line) => line.trim().length > 0);
}

/** The post-squash invariant per workspace: diff-empty vs its OWN parent. */
export async function assertWorkspacesConsumed(
	projectDir: string,
	workspaceNames: string[],
): Promise<void> {
	for (const name of workspaceNames) {
		const wsAt = await workspaceCommitId(projectDir, name);
		const leftover = await diffSummary(projectDir, `${wsAt}-`, wsAt);
		if (leftover.length > 0) {
			throw new Error(
				`jj squash did not fully consume workspace "${name}" — changes remain vs its parent ` +
					`(${leftover.join(", ")}). Nothing was lost: the merged delta lives in the task base.`,
			);
		}
	}
}

/**
 * R1 ATOMIC combine: ONE squash over the revset union of all worker ranges.
 * Conflicts land in the base (they do not fail the squash); returns them.
 */
export interface CombineOutcome {
	commitId: string;
	conflicts: string[];
	filesChanged: number;
	changedPaths: string[];
	presentFiles: string[];
	deletedFiles: string[];
}

const UNION_TOOL = "union";
const UNION_SCRIPT =
	'git merge-file --union -p "$1" "$2" "$3" > "$4" && test -s "$4"';

function unionToolConfigArgs(): string[] {
	const escaped = UNION_SCRIPT.replace(/"/g, '\\"');
	return [
		`merge-tools.${UNION_TOOL}.program=sh`,
		`merge-tools.${UNION_TOOL}.merge-args=["-c","${escaped}","pi-union","$left","$base","$right","$output"]`,
	];
}

export async function detectChangeConflicts(
	projectDir: string,
	changeId: string,
): Promise<string[]> {
	const commitId = await resolveCommitId(projectDir, changeId);
	const result = await execJj(
		["resolve", "--list", "-r", commitId],
		projectDir,
	);
	const all = `${result.stdout}\n${result.stderr}`;
	if (result.code === 2 && all.includes("No conflicts found")) return [];
	if (result.code !== 0)
		throw new Error(
			`jj resolve --list -r ${commitId} failed (${result.code}): ${all.trim()}`,
		);
	const paths: string[] = [];
	for (const line of result.stdout.split("\n")) {
		const match = /^(\S+)\s+\d+-sided conflict/.exec(line.trim());
		if (match?.[1]) paths.push(match[1]);
	}
	return paths;
}

/** R4 rung 2: per-file union resolution (ONE FILE PER INVOCATION — a tool
 *  failure isolates to that file instead of stranding later paths). Each
 *  success rewrites the base, so the commit id is re-resolved per file. */
export async function resolveConflictsWithUnion(
	projectDir: string,
	changeId: string,
	paths: string[],
): Promise<void> {
	for (const path of paths) {
		const commitId = await resolveCommitId(projectDir, changeId);
		const flat = unionToolConfigArgs().flatMap((c) => ["--config", c]);
		await execJj(
			[...flat, "resolve", "--tool", UNION_TOOL, "-r", commitId, "--", path],
			projectDir,
		);
	}
}

/**
 * R3 consistency gate: the merged base is visible, non-empty, and holds
 * the pre-merge union of workers' added/modified files — both in the base
 * TREE and on disk (verification runs on the working tree, never a snapshot).
 */
export async function assertMerged(
	projectDir: string,
	baseChangeId: string,
	opts: { expectedFiles: string[] },
): Promise<void> {
	const base = await resolveCommitId(projectDir, baseChangeId);
	const problems: string[] = [];
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
			if (!files.has(f)) problems.push(`merged tree is missing "${f}"`);
		}
	}
	for (const f of opts.expectedFiles) {
		if (!existsSync(join(projectDir, f)))
			problems.push(`working tree is missing "${f}"`);
	}
	if (problems.length > 0) {
		throw new Error(
			"parallel merge did NOT integrate all worker changes into the task base:\n  - " +
				problems.join("\n  - "),
		);
	}
}

/** Atomic combine + consumption check + conflict detection. */
export async function mergeWorkspacesAtomic(
	projectDir: string,
	workspaceNames: string[],
	into: string,
): Promise<CombineOutcome> {
	if (workspaceNames.length === 0) {
		const commitId = await resolveCommitId(projectDir, into);
		return {
			commitId,
			conflicts: [],
			filesChanged: 0,
			changedPaths: [],
			presentFiles: await filesAtRevision(projectDir, commitId),
			deletedFiles: [],
		};
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
			`jj squash (atomic combine of ${workspaceNames.length} workspace(s)) failed (${squash.code}): ${squash.stderr.trim()}`,
		);
	}
	await assertWorkspacesConsumed(projectDir, workspaceNames);
	const newBase = await resolveCommitId(projectDir, into);
	const evidence = await changedPathEvidence(projectDir, baseCommit, newBase);
	return {
		commitId: newBase,
		conflicts: await detectChangeConflicts(projectDir, into),
		filesChanged: evidence.changedPaths.length,
		...evidence,
	};
}

/** One workspace's file changes vs the base ("A"/"M"/"D"/"R" summary lines).
 *  Renames parse to the NEW path. Pure parser exported as parseSummaryChanges. */
export interface WorkspaceFileChange {
	file: string;
	kind: string;
}

export function parseSummaryChanges(lines: string[]): WorkspaceFileChange[] {
	const changes: WorkspaceFileChange[] = [];
	for (const line of lines) {
		const match = /^(\S+)\s+(.*)$/.exec(line.trim());
		if (!match?.[1] || !match[2]) continue;
		const rename = /^\{([^}]+) => ([^}]+)\}$/.exec(match[2]);
		changes.push({ kind: match[1], file: rename?.[2] ?? match[2] });
	}
	return changes;
}

const MACHINE_DIFF_TEMPLATE =
	'self.status_char() ++ "\\t" ++ self.path() ++ "\\n"';

/** Parse only the tab-delimited status/path records emitted by the machine
 *  diff template. Human `jj status` or `jj diff --summary` prose is ignored. */
export function parseMachineDiffPaths(lines: string[]): string[] {
	return parseMachineDiffEntries(lines).map((entry) => entry.path);
}

interface MachineDiffEntry {
	status: string;
	path: string;
}

function parseMachineDiffEntries(lines: string[]): MachineDiffEntry[] {
	const entries: MachineDiffEntry[] = [];
	for (const rawLine of lines) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		const match = /^([MADCR])\t(.+)$/.exec(line);
		if (match?.[1] !== undefined && match[2] !== undefined)
			entries.push({ status: match[1], path: match[2] });
	}
	return entries;
}

/** Return repository-relative changed paths between explicit revisions. The
 *  default is read-only; snapshotWorkingCopy is used only to capture worker
 *  edits before the engine commits them. */
async function changedPathEntriesBetween(
	projectDir: string,
	from: string,
	to: string,
	opts?: { snapshotWorkingCopy?: boolean },
): Promise<MachineDiffEntry[]> {
	const args = [
		"diff",
		"--from",
		from,
		"--to",
		to,
		"-T",
		MACHINE_DIFF_TEMPLATE,
	];
	if (!opts?.snapshotWorkingCopy) args.push("--ignore-working-copy");
	const result = await execJj(args, projectDir);
	if (result.code !== 0)
		throw new Error(
			`jj diff --from ${from} --to ${to} failed (${result.code}): ${result.stderr.trim()}`,
		);
	return parseMachineDiffEntries(result.stdout.split("\n"));
}

export async function changedPathsBetween(
	projectDir: string,
	from: string,
	to: string,
	opts?: { snapshotWorkingCopy?: boolean },
): Promise<string[]> {
	return (await changedPathEntriesBetween(projectDir, from, to, opts)).map(
		(entry) => entry.path,
	);
}

async function filesAtRevision(projectDir: string, revision: string): Promise<string[]> {
	const result = await execJj(
		["file", "list", "-r", revision, "--ignore-working-copy"],
		projectDir,
	);
	if (result.code !== 0)
		throw new Error(
			`jj file list -r ${revision} failed (${result.code}): ${result.stderr.trim()}`,
		);
	return result.stdout.split("\n").map((path) => path.trim()).filter(Boolean).sort();
}

export async function changedPathEvidence(
	projectDir: string,
	from: string,
	to: string,
): Promise<Pick<CombineOutcome, "changedPaths" | "presentFiles" | "deletedFiles">> {
	const entries = await changedPathEntriesBetween(projectDir, from, to);
	return {
		changedPaths: entries.map((entry) => entry.path),
		presentFiles: await filesAtRevision(projectDir, to),
		deletedFiles: entries.filter((entry) => entry.status === "D").map((entry) => entry.path),
	};
}

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

/** R1 guard: clean main working copy before any task work. */
export async function assertCleanWorkingCopy(cwd: string): Promise<void> {
	const diff = await execJj(
		["diff", "--from", "@-", "--to", "@", "--summary"],
		cwd,
	);
	if (diff.code !== 0)
		throw new Error(
			`jj diff --from @- --to @ failed (${diff.code}): ${diff.stderr.trim()}`,
		);
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

/** Cleanup: forget the workspace (abandons the empty @), delete its dir. */
export async function removeWorkspace(
	projectDir: string,
	name: string,
	dir?: string,
): Promise<void> {
	const result = await execJj(["workspace", "forget", name], projectDir);
	if (result.code !== 0)
		throw new Error(
			`jj workspace forget "${name}" failed (${result.code}): ${result.stderr.trim()}`,
		);
	if (dir) rmSync(dir, { recursive: true, force: true });
}

/** feature-branch mode: named bookmark at a workspace's tip. Re-publish
 *  moves an existing bookmark to the CURRENT tip (review M2/P1: the old
 *  fallback treated any already-exists as success, silently pointing the
 *  bookmark at a stale/hidden commit). */
export async function createBookmarkAt(
	projectDir: string,
	name: string,
	wsName: string,
): Promise<void> {
	// Target the workspace @'s PARENT: `jj commit` leaves @ as an empty
	// child, so the WORK lives at @-. Pointing the bookmark at @ would
	// publish an empty commit.
	const wsAt = await workspaceCommitId(projectDir, wsName);
	const targetRev = `${wsAt}-`;
	const targetCommit = await resolveCommitId(projectDir, targetRev);
	const create = await execJj(
		["bookmark", "create", name, "-r", targetRev, "--ignore-working-copy"],
		projectDir,
	);
	if (create.code === 0) return;
	// Already exists: idempotent only when it points at the SAME commit;
	// otherwise MOVE to the current tip (review M2/P1 — never silently
	// report success while pointing at a stale/hidden commit).
	const existingId = await resolveCommitId(projectDir, name);
	if (existingId === targetCommit) return;
	const move = await execJj(
		["bookmark", "move", name, "--to", targetRev, "--ignore-working-copy"],
		projectDir,
	);
	if (move.code !== 0) {
		throw new Error(
			`bookmark "${name}" is stale (at ${existingId.slice(0, 12)}) and move to tip ` +
				`${targetCommit.slice(0, 12)} failed (${move.code}): ${move.stderr.trim()}`,
		);
	}
}
