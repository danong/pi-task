/**
 * Orchestrator — deterministic workflow engine (Phases 2-9).
 *
 * Validates a spec, spawns one worker per parallel slot (optionally with
 * prewalk model swap), gates the result on the spec's verification
 * commands (bash exit codes, zero LLM tokens). With `parallel > 1` each
 * worker runs in its own jj workspace and the workspaces are combined
 * into the task base in ONE jj operation (atomic combine, R1), with a
 * deterministic union-merge ladder for textual conflicts (R4), a
 * post-merge consistency gate (R3), pre-merge overlap classification
 * (R5), and a merge-failure artifact that never forgets the workspaces
 * (R2) — see workspace.ts for the jj mechanics.
 * With `review` enabled (single-worker), a forked adversarial review +
 * bounded fix loop gates the result on P0/P1 findings (see review.ts).
 *
 * Parallel decomposition has two modes (Phase 9): caller-supplied
 * `subSpecs` — one encapsulated, fully self-contained spec per worker,
 * no shared goal, no scope leak by construction — or the mechanical
 * `spec` + `parallel` fallback, which round-robins the requirements
 * (`splitSpec`) under an explicit Scope contract. Both share the single
 * post-merge verification gate (the union of verification commands).
 *
 * The task tool (Phase 9, index.ts) is the user-facing entry point;
 * metrics persistence is wired via metricsDir (Phase 8).
 */

import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
	CHECKLIST_EXTENSION_PATH,
	buildWorkerSystemPrompt,
	spawnWorkerSessionResilient,
	type WorkerFailureDiagnostics,
	type WorkerResult,
} from "./worker.ts";
import {
	attachPrewalk,
	isPrewalkActive,
	PREWALK_EXTENSION_PATH,
	type SwapInfo,
} from "./prewalk.ts";
import {
	attachChecklistRelay,
	type ChecklistProgress,
} from "./checklist-relay.ts";
import { resolveSandbox, type ResolvedSandbox } from "./sandbox.ts";
import {
	DEFAULT_PREWALK_MIN_REQUIREMENTS,
	DEFAULT_TASK_CONFIG,
	DEFAULT_TASK_SHAPES,
	channelWatchdogWindows,
	aiIdentityToml,
	formatAiAuthorName,
	loadTaskConfig,
	type BatchLaneConfig,
	type SandboxConfig,
	type TaskShape,
} from "./config.ts";
import {
	buildMap,
	formatMapPrompt,
	loadRepoMapConfig,
	sliceRelevant,
} from "./repo-map.ts";
import {
	assertCleanWorkingCopy,
	assertMerged,
	assertVisibleCommit,
	conflictHunks,
	createAiTaskBase,
	createWorkspace,
	detectChangeConflicts,
	diffForWorkspacePath,
	execJj,
	filesChangedBetween,
	mergeWorkspacesAtomic,
	removeWorkspace,
	resolveCommitId,
	resolveConflictsWithUnion,
	taskBaseChangeId,
	workspaceCommitId,
	workspaceFileChanges,
} from "./workspace.ts";
import { parseSpec, SpecError, type Spec } from "./schemas/spec.ts";
import { extractFileScope } from "./progress.ts";
import { forkedReview, mergeReviewOutcomes } from "./review.ts";
import { DEFAULT_PERSONA, getPersona, type Persona } from "./personas.ts";
import {
	batchJobStatePath,
	BatchError,
	extractBatchFiles,
	mergeBatchFiles,
	runBatchLane,
	type BatchFile,
	type BatchProvider,
} from "./batch.ts";
import { OpenRouterBatchProvider } from "./batch.ts";
import type { Finding, ReviewResult } from "./schemas/findings.ts";
import {
	aggregateExecutePhase,
	buildFailureArtifact,
	buildRunManifest,
	computeReadDuplication,
	contextInheritedTokens,
	copySessionTraces,
	countByPriority,
	deriveProjectName,
	generateRunId,
	hashSpec,
	splitPhases,
	writeFailureArtifact,
	writeManifest,
	type MergeMetrics,
	type RunManifest,
} from "./metrics.ts";

// ─── Run-pipeline shape default ─────────────────────────────────────

/** A run-pipeline shape optionally tagged with its config-table name
 *  ("code" | "analysis" | any [shapes.*] key). A plain TaskShape IS a
 *  valid NamedTaskShape: resolveTaskShape resolves shapes BY name, so
 *  the orchestrator normally handles anonymous resolved shapes and the
 *  manifest records the built-in default name when the tag is absent
 *  (metrics.ts BuildManifestInput.shape: string). */
interface NamedTaskShape extends TaskShape {
	name?: string | undefined;
}

/** The built-in code shape — the fallback wherever a caller omits the
 *  run-pipeline shape. Bound once so every `shape ?? …` site shares one
 *  narrowed, non-optional value (DEFAULT_TASK_SHAPES is a plain Record,
 *  so its `.code` entry alone does not satisfy strict null checks). */
const DEFAULT_SHAPE: NamedTaskShape = {
	// Unreachable fallback: DEFAULT_TASK_SHAPES always ships "code" (the
	// same invariant config.ts resolveTaskShape relies on); the assertion
	// only narrows the Record index.
	...(DEFAULT_TASK_SHAPES.code as TaskShape),
	name: "code",
};

// ─── Merge-failure artifact (R2) ────────────────────────────────────

/**
 * The merge-failure record written when the parallel merge path fails or
 * escalates (R2/R4): workspace names + their working-copy commit ids
 * (dangling when the merge did not land), the dangling commit ids, and
 * the conflicted files (+ bounded hunks). Recovery is scripted from this
 * file rather than LLM-discovered: `jj workspace list` names survive,
 * and each dangling id can be squashed into the base manually.
 * Best-effort — never masks the original failure.
 */
export interface MergeFailureInfo {
	cause: string;
	workspaces: Array<{
		name: string;
		commit_id: string;
		/** R3: the rescue commit capturing this workspace's uncommitted state
		 *  (absent when clean / the rescue failed — best effort). */
		rescue_commit_id?: string;
	}>;
	danglingCommitIds: string[];
	conflictedFiles: string[];
	/** Optional AND nullable under exactOptionalPropertyTypes — call sites
	 *  forward their own `T | undefined` locals verbatim (R4 discipline). */
	conflictHunks?: Record<string, string> | undefined;
	/** R4: the engine-side post-mortem result when the run already performed
	 *  the recovery itself — serialized into the `recovery` field as
	 *  machine-grep-able lines. Absent → the scripted manual guide is used. */
	parallelRecovery?: ParallelRecoveryInfo | undefined;
	metricsDir?: string | undefined;
	project: string;
	specMarkdown: string;
	tier?: string | undefined;
	runId?: string | undefined;
}

/** Write a merge-failure artifact via the existing .failure.json pattern
 *  (metrics.ts writeFailureArtifact), extended with the R2 merge record
 *  and the R4 scripted recovery guide. `parallelRecovery` (the engine's
 *  own post-mortem result, when the run already performed it) rides the
 *  artifact's `recovery` field as machine-grep-able lines. */
export function writeMergeFailureArtifact(opts: MergeFailureInfo): void {
	if (!opts.metricsDir) return;
	try {
		const artifact = buildFailureArtifact({
			kind: "parallel",
			...(opts.runId === undefined ? {} : { runId: opts.runId }),
			specHash: hashSpec(opts.specMarkdown),
			...(opts.tier === undefined ? {} : { tier: opts.tier }),
			cause: opts.cause,
			merge: {
				workspaces: opts.workspaces,
				dangling_commit_ids: opts.danglingCommitIds,
				conflicted_files: opts.conflictedFiles,
				...(opts.conflictHunks === undefined
					? {}
					: { conflict_hunks: opts.conflictHunks }),
			},
			// R4: recovery travels with the artifact — either the ENGINE-side
			// post-mortem result (machine-readable stack tip + per-workspace
			// heads + preserved stubs + exact jj commands) or, absent one, the
			// scripted guide for manual recovery.
			recovery:
				opts.parallelRecovery !== undefined
					? serializeParallelRecovery(opts.parallelRecovery)
					: buildRecoveryGuide(opts),
		});
		writeFailureArtifact(artifact, {
			metricsDir: opts.metricsDir,
			project: opts.project,
		});
	} catch {
		// Best effort — the original failure propagates regardless.
	}
}

// ─── Abort/failure path (R1-R5) ─────────────────────────────────────

/** Tighter jj bound for the abort/failure path (R5): resolving workspace
 *  commit ids and rescue-committing wedged workspaces must never stall the
 *  abort — DEFAULT_JJ_TIMEOUT_MS already bounds every call; this keeps the
 *  failure path snappy. */
const FAILURE_PATH_JJ_TIMEOUT_MS = 30_000;

/**
 * R2: the third outcome — classify an aborted worker as
 * "finalization-incomplete" when its checklist relay showed ALL
 * requirements done at abort (done === total): the worker had committed
 * everything and was verifying or yielding when it was killed. Its
 * committed work is complete, so the run attempts finalization (merge +
 * verification gate) instead of failing flat. Pure — hermetically tested.
 */
export function isFinalizationIncomplete(
	progress: ChecklistProgress | null,
): boolean {
	return (
		progress !== null && progress.total > 0 && progress.done >= progress.total
	);
}

/**
 * True when a worker failure is the idle-watchdog no-yield class (the
 * worker settled twice without calling yield()). Matches the structured
 * `diagnostics.code` union member — NOT the cause text (multi-line,
 * decorative) and not the message. Null-code failures (external aborts)
 * are never classified. Pure — hermetically tested.
 */
export function isNoYieldFailure(err: unknown): boolean {
	const diag = (err as { diagnostics?: { code?: unknown } } | null)
		?.diagnostics;
	return diag?.code === "no_yield";
}

/**
 * R2: decide a parallel run's response to worker failures from the failed
 * workers' checklist progress. Every failed worker finalization-incomplete
 * → "merge": the committed work is complete, so the run proceeds to the
 * atomic combine + union verification gate (pass → success-with-caveat;
 * fail → the failure path with preserved workspaces). ANY failed worker
 * aborted mid-work → "abort": the flat failure path (preserve workspaces,
 * rescue uncommitted state, failure artifact). Empty input (no failed
 * workers) → "abort" (vacuous — the caller only consults this when at
 * least one worker failed). Pure — hermetically tested.
 */
export function classifyWorkerFailures(
	progresses: Array<ChecklistProgress | null>,
): "merge" | "abort" {
	return progresses.length > 0 && progresses.every(isFinalizationIncomplete)
		? "merge"
		: "abort";
}

/**
 * R3: rescue a parallel workspace's uncommitted state on worker failure —
 * a rescue commit INSIDE the preserved workspace ("rescue: aborted task
 * run (<cause>)") capturing the worker's dirty working copy, untracked
 * files included (the workspace lives under the host /tmp, so staged
 * scratch under the workspace's /tmp is captured too). Returns the rescue
 * commit id, or null when there was nothing to rescue or the rescue failed
 * (best effort — never masks the original failure). Exported for the
 * hermetic test (real jj on a temp repo).
 */
export async function rescueWorkspaceStateBestEffort(
	workspaceDir: string,
	cause: string,
	opts?: { timeoutMs?: number },
): Promise<string | null> {
	try {
		const status = await execJj(["status"], workspaceDir, opts);
		if (status.code !== 0 || /has no changes/i.test(status.stdout)) return null;
		const reason = (cause || "worker failure").slice(0, 140);
		const commit = await execJj(
			["commit", "-m", `rescue: aborted task run (${reason})`],
			workspaceDir,
			opts,
		);
		if (commit.code !== 0) return null;
		// After jj commit the rescue commit is @- (jj commit finalizes the
		// working copy and opens a fresh empty @ on top).
		const id = await execJj(
			[
				"log",
				"-r",
				"@-",
				"-T",
				"commit_id",
				"--no-graph",
				"--ignore-working-copy",
			],
			workspaceDir,
			opts,
		);
		return id.code === 0 && /^[0-9a-f]{40}$/.test(id.stdout.trim())
			? id.stdout.trim()
			: null;
	} catch {
		return null;
	}
}

/**
 * R4: the scripted recovery guide the merge/worker-failure artifact
 * carries — how to stack the preserved workspaces onto the task base, how
 * to abandon the AI base/stubs BEFORE pushing (jj refuses to push
 * description-less commits), and the add-vs-delete conflict warning
 * (resolve via :ours/:theirs — never mid-stack abandon, which drops the
 * other side's changes). Workspace names + rescue commit ids interpolated
 * when known. Pure — hermetically tested.
 */
export function buildRecoveryGuide(opts: {
	cause: string;
	workspaces: Array<{
		name: string;
		commit_id: string;
		rescue_commit_id?: string;
	}>;
}): string {
	const lines = [
		`The task run failed before completing: ${opts.cause}`,
		"",
		"The worker workspaces were PRESERVED — their commits still live in the repo. Recover manually:",
		"",
		"1. Find the workspaces and their commits:",
		"   jj workspace list",
		"   jj log -r all()   # the worker commits carry the sub-spec/run descriptions",
		"",
		"2. Stack the preserved workspaces' commits onto the task base, one workspace at a",
		"   time, in dependency order, then squash them into the base:",
		"   jj rebase -s <workspace-commit> -o <base-commit>",
		"   jj squash --from <base-commit>..<workspace-tip> --into <base-commit>",
		"   Re-resolve ids AFTER every command (rebase rewrites commit ids).",
	];
	const rescued = opts.workspaces.filter((w) => w.rescue_commit_id);
	if (rescued.length > 0) {
		lines.push(
			"",
			`   Uncommitted state was rescued into commit(s): ${rescued
				.map((w) => `${w.name} → ${w.rescue_commit_id}`)
				.join(", ")} — included in the squashes above.`,
		);
	}
	lines.push(
		"",
		"3. BEFORE pushing, abandon the AI-authored task base and any empty working-copy",
		"   stubs — jj REFUSES to push description-less commits:",
		"   jj abandon <commit-id>   # every commit whose description is empty + the empty AI base",
		"   Verify: jj log -r all() shows no commit with an empty description.",
		"   A resolution commit ON TOP of a conflicted commit does NOT clear the parent's",
		"   conflict for push (jj refuses to push any commit whose tree carries markers) —",
		"   squash the resolution INTO the conflicted commit: JJ_EDITOR=true jj squash -r <res>",
		"",
		"4. Add-vs-delete conflicts: a file DELETED on one side and kept on the other",
		"   resolves via :ours/:theirs, NOT mid-stack abandon (abandoning a commit mid-stack",
		"   silently drops whichever side the abandoned commit held):",
		"   jj resolve --tool :ours -r <commit> <path>    # keep the modified side",
		"   jj resolve --tool :theirs -r <commit> <path>  # keep the deletion",
		"",
		"5. Run the full verification gate on the merged tree before considering the merge",
		"   done.",
	);
	return lines.join("\n");
}

/**
 * R1: the parallel finally's identity restore, extracted for hermetic
 * testing. Creates the fresh empty user working-copy commit (`jj new`)
 * ONLY when a merge actually landed (mergeLanded). On a no-merge failure
 * (a worker failure before the merge path) the stub must NOT be created:
 * it is description-less and jj refuses to push description-less commits
 * (the observed failure mode — the stub blocked a real push and cascaded
 * into a conflict nightmare). Whatever remains in the ancestry — e.g. the
 * AI-authored task base, described with the spec goal — must carry a
 * description. Best effort — never masks the run's outcome. Also removes
 * the identity config dir.
 */
export async function restoreParallelWorkingCopy(
	cwd: string,
	opts: { identityDir: string | null; mergeLanded: boolean },
): Promise<void> {
	if (!opts.identityDir) return;
	if (opts.mergeLanded) {
		try {
			await execJj(["new"], cwd);
		} catch {
			/* best effort */
		}
	}
	try {
		rmSync(opts.identityDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}

/**
 * Machine-readable PARALLEL-run recovery info (the same contract rule 6
 * channel single runs use): where each workspace's work was stacked plus
 * the exact jj commands a user runs to inspect or continue it. Serialized
 * into the merge-failure artifact's `recovery` field via
 * serializeSingleRunRecovery's line format (`key=value` machine lines +
 * verbatim commands).
 */
export interface ParallelRecoveryInfo {
	/** The dispatch-base change id every stacked chain hangs off. */
	base_change?: string | undefined;
	/** Change id of the stack TIP after the post-mortem — `jj new <id>`
	 *  continues from all workers' combined work. */
	stack_tip?: string | undefined;
	/** One entry per processed workspace, dependency order: the workspace
	 *  name and the change id its stacked chain now ends at. */
	stacked: Array<{ name: string; change_id: string }>;
	/** Empty description-less commits PRESERVED by doubt (provenance not
	 *  provably the engine's) — listed, never silently dropped. */
	preserved_stubs?: string[] | undefined;
	/** Exact jj commands to inspect/continue/repair the stacked work. */
	commands: string[];
}

/** Serialize parallel recovery info into the artifact's `recovery`
 *  string field (pure): machine-grep-able key=value lines + the exact jj
 *  commands, matching serializeSingleRunRecovery's format contract. */
export function serializeParallelRecovery(info: ParallelRecoveryInfo): string {
	const lines: string[] = [];
	if (info.base_change !== undefined)
		lines.push(`base_change=${info.base_change}`);
	if (info.stack_tip !== undefined)
		lines.push(`stack_tip=${info.stack_tip}`);
	for (const s of info.stacked)
		lines.push(`stacked=${s.name}:${s.change_id}`);
	for (const s of info.preserved_stubs ?? [])
		lines.push(`preserved_stub=${s}`);
	lines.push(...info.commands);
	return lines.join("\n");
}

/**
 * The parallel post-mortem (failure-artifact contract rules 1-6, flipped
 * from "preserve everything for scripted recovery" to "the engine performs
 * the recovery itself"): on ANY parallel termination the engine
 *
 *  1. describes every workspace working-copy commit that is NON-empty but
 *     UNDESCRIBED (taxonomy class 2/3 — the dirty-tail snapshot jj wrote
 *     when the worker died mid-edit) as `rescue: aborted task run (<cause>)`
 *     — partial uncommitted work becomes a described commit instead of
 *     littering history as an anonymous full-tree snapshot;
 *  2. stacks every workspace's commits ONTO THE DISPATCH BASE in
 *     dependency order: one `jj rebase -s roots(<chain>) -o <tip>` per
 *     workspace, the tip advancing to the newly stacked head each time —
 *     the result is ONE linear chain base → ws1-commits → ws2-commits …,
 *     no sibling litter;
 *  3. abandons ONLY engine-authored empty stubs (empty + description-less
 *     + AI identity — the same conservative provenance test
 *     singleRunFailureHygiene applies); anything doubtful survives and is
 *     listed under preserved_stubs;
 *  4. forgets every workspace (rule 5, post-mortem era: the stacked
 *     commits are live in the main ancestry, so the workspace working
 *     copies themselves are disposable on EVERY exit path).
 *
 * Every step is best-effort and bounded (FAILURE_PATH_JJ_TIMEOUT_MS) —
 * a wedged repo degrades toward preservation, never masks the original
 * failure, and never throws.
 *
 * IDEMPOTENCE / NO DIVERGENT COPIES (rule 4): chains move by CHANGE id
 * (`jj rebase` keeps change ids stable across rewrites), and a workspace
 * whose @ already sits on the current base-with-zero-diff contributes no
 * chain (the consumed check) — so re-running the post-mortem after a
 * partial first pass moves nothing that already moved, abandons nothing
 * twice, and cannot produce two visible commits sharing one change id.
 */
async function listEngineStubsBestEffort(opts: {
	projectDir: string;
	aiAuthorEmail?: string | undefined;
}): Promise<{ engine: string[]; preserved: string[] }> {
	const result = { engine: [] as string[], preserved: [] as string[] };
	try {
		// Visible commits only (all() ~ root(): the immutable root is empty +
		// undescribed by construction — never an engine artifact).
		const log = await execJj(
			[
				"log",
				"-r",
				"all() ~ root()",
				"--no-graph",
				"-T",
				'change_id ++ "|" ++ if(empty, if(description.first_line() == "", "STUB", "OK"), "OK") ++ "|" ++ author.email() ++ "\\n"',
			],
			opts.projectDir,
			{ timeoutMs: FAILURE_PATH_JJ_TIMEOUT_MS },
		);
		if (log.code !== 0) return result;
		for (const line of log.stdout.split("\n")) {
			const m = /^([^|]+)\|STUB\|(.+)$/.exec(line.trim());
			if (!m) continue; // described or non-empty → not a stub
			const changeId = m[1]!;
			const authorEmail = m[2]!.trim();
			if (
				opts.aiAuthorEmail !== undefined &&
				authorEmail === opts.aiAuthorEmail
			) {
				result.engine.push(changeId);
			} else {
				result.preserved.push(changeId); // doubt → preserve + report
			}
		}
	} catch {
		// Best effort — degrade toward preservation.
	}
	return result;
}

/**
 * The parallel post-mortem (failure-artifact contract rules 1-6, engine-side
 * recovery): on ANY parallel termination the engine performs the recovery
 * itself instead of leaving it scripted for the user —
 *
 *  1. DESCRIBES every workspace working-copy commit that is NON-empty but
 *     UNDESCRIBED (taxonomy class 3 — the full-tree snapshot jj wrote when
 *     the worker died mid-edit) as `rescue: aborted task run (<cause>)`;
 *     partial uncommitted work becomes a described commit, never an
 *     anonymous snapshot.
 *  2. STACKS every workspace's commits ONTO THE DISPATCH BASE in dependency
 *     order: one `jj rebase -s roots(<ws chain>) -o <tip>` per workspace
 *     with the tip advancing to the newly stacked head — ONE linear chain
 *     base → ws1-commits → ws2-commits ..., no sibling litter (rule 4:
 *     every worker change reachable from exactly one named commit id —
 *     the stack tip). Rebase moves whole chains BY CHANGE ID (stable
 *     across rewrites), so re-running cannot fork divergent copies.
 *  3. ABANDONS ONLY engine-authored empty stubs (empty + description-less
 *     + the AI identity configured for this run — the same conservative
 *     provenance test singleRunFailureHygiene applies); anything doubtful
 *     survives and is listed under `preserved_stubs` (user-abort rule:
 *     content-bearing commits keep their messages and are stacked; only
 *     provable engine empties are removed).
 *  4. FORGETS every workspace (rule 5, post-mortem era): the workspaces'
 *     commits are live in the main ancestry, so the working copies are
 *     disposable on EVERY exit path.
 *
 * IDEMPOTENCE / NO DIVERGENT COPIES (rule 4 / R2): a workspace whose
 * recorded @ is diff-empty against its parent AND already parented on the
 * current tip contributed no chain this pass (its commits were consumed by
 * an earlier post-mortem pass or the success-path squash) — skipped. A
 * second full pass therefore moves nothing that already moved, abandons
 * nothing twice (the first pass's abandon hid those changes), and cannot
 * produce two visible commits sharing one change id.
 *
 * Every step is best-effort and bounded (FAILURE_PATH_JJ_TIMEOUT_MS) —
 * a wedged repo degrades toward preservation, never masks the original
 * failure, and never throws.
 *
 * @returns the machine-readable ParallelRecoveryInfo for the failure
 * artifact (stack tip, per-workspace stacked heads, preserved stubs,
 * exact jj commands).
 */
/** Parsed `jj workspace list` entry: the workspace @'s stable ids. */
interface WorkspaceEntry {
	changeId: string;
	commitId: string;
}

/** Parse `jj workspace list` output into name → entry ("name: <change-id>
 *  <commit-id>" — this jj build prints no working-copy path). */
function parseWorkspaceListLocal(
	stdout: string,
): Map<string, WorkspaceEntry> {
	const result = new Map<string, WorkspaceEntry>();
	for (const line of stdout.split("\n")) {
		const match = /^(\S+):\s+(\S+)\s+(\S+)/.exec(line.trim());
		if (match)
			result.set(match[1] ?? "", {
				changeId: match[2] ?? "",
				commitId: match[3] ?? "",
			});
	}
	return result;
}

export async function parallelRunPostMortem(opts: {
	projectDir: string;
	workspaceNames: string[];
	/** The task base's change id (executeTask's baseChangeId). */
	baseChangeId: string;
	/** The DISPATCH base the workspaces branched from — the AI base's
	 *  parent in identity mode (createWorkspace parents each workspace's @
	 *  on the default workspace's @-, i.e. the pre-task head), or
	 *  baseChangeId itself without an AI base. Defaults to baseChangeId. */
	dispatchBaseChangeId?: string | undefined;
	cause: string;
	/** AI identity configured for the run — the provenance test for
	 *  engine-authored empties. Absent → NOTHING is deleted. */
	aiAuthorEmail?: string | undefined;
	/** Working-copy directories by workspace name — REQUIRED for the
	 *  content-bearing-@ detach step (`jj new` inside the workspace before
	 *  the forget). This jj build's `workspace list` prints no paths, so
	 *  they must come from the caller (executeTask's workspaces array).
	 *  A workspace without a dir here is stacked but kept live. */
	workspaceDirs?: Record<string, string> | undefined;
}): Promise<ParallelRecoveryInfo> {	const timeout = { timeoutMs: FAILURE_PATH_JJ_TIMEOUT_MS };
	const cause = (opts.cause || "worker failure").slice(0, 140);
	// The base the workspaces branched from — the anchor for isolating each
	// workspace's OWN chain out of the shared ancestry (see the rebase below).
	const dispatchBase = opts.dispatchBaseChangeId ?? opts.baseChangeId;
	const stacked: Array<{ name: string; change_id: string }> = [];
	const preserved: string[] = [];
	// Workspaces whose leftovers were provably detached from their content
	// (stacked or consumed) — ONLY these are forgotten below. A workspace
	// whose rebase failed keeps its @ attached to its (unstacked) chain:
	// forgetting it would abandon content-bearing commits.
	const forgotten: string[] = [];
	// Tip of the linear stack so far — advances with every stacked chain.
	let tipChangeId = opts.baseChangeId;
	// Live-workspace snapshot, read ONCE up front: a workspace missing here
	// was already forgotten (an earlier post-mortem pass or the success-path
	// cleanup) — the natural idempotence boundary for a second pass.
	const wsEntries = await (async () => {
		try {
			const list = await execJj(
				["workspace", "list"],
				opts.projectDir,
				timeout,
			);
			return list.code === 0
				? parseWorkspaceListLocal(list.stdout)
				: new Map<string, WorkspaceEntry>();
		} catch {
			return new Map<string, WorkspaceEntry>();
		}
	})();
	for (const name of opts.workspaceNames) {
		try {
			const entry = wsEntries.get(name);
			if (!entry) continue; // already forgotten — nothing left to recover
			const wsAt = entry.commitId;
			const state = await execJj(
				[
					"log",
					"-r",
					wsAt,
					"--no-graph",
					"--ignore-working-copy",
					"-T",
					'if(empty, if(description.first_line() == "", "STUB", "DESCRIBED"), if(description.first_line() == "", "SNAPSHOT", "DESCRIBED"))',
				],
				opts.projectDir,
				timeout,
			);
			let wsState = state.code === 0 ? state.stdout.trim() : "UNKNOWN";
			if (wsState === "SNAPSHOT") {
				// Taxonomy class 3: describe the dirty-tail snapshot IN PLACE —
				// it becomes the rescue commit carrying the uncommitted work.
				await execJj(
					[
						"describe",
						"-r",
						wsAt,
						"-m",
						`rescue: aborted task run (${cause})`,
					],
					opts.projectDir,
					timeout,
				);
				wsState = "DESCRIBED";
			}
			// The workspace's OWN chain: the ANCESTORS of its @ that are not
			// ancestors of the dispatch base (`::wsAt ~ ::dispatchBase` —
			// workspaces branch from the dispatch base: createWorkspace parents
			// each workspace's @ on the default workspace's @-, NOT on
			// baseChangeId/the AI base). The workspace's own EMPTY undescribed @
			// carries no work and is excluded (`~ wsAt`) — its content commits
			// stay in the chain while the stub itself is cleaned up by the
			// workspace forget below.
			const chainRev =
				wsState === "STUB"
					? `::${wsAt} ~ ::${dispatchBase} ~ ${wsAt}`
					: `::${wsAt} ~ ::${dispatchBase}`;
			{
				const probe = await execJj(
					[
						"log",
						"-r",
						chainRev,
						"--no-graph",
						"--ignore-working-copy",
						"-T",
						'change_id ++ "\\n"',
					],
					opts.projectDir,
					timeout,
				);
				if (probe.code !== 0 || probe.stdout.trim().length === 0) {
					// Nothing to stack — either the workspace never produced work
					// or its commits were already stacked by an earlier pass (the
					// consumed state: its content hangs off the base's descendants).
					// The leftover empty working copy is cleaned up below.
					forgotten.push(name);
					continue;
				}
			}
			// Tip of THIS workspace's chain (a linear worker chain → single
			// head), captured BEFORE the rebase: jj rebase keeps CHANGE ids
			// stable across rewrites, so the stacked chain's head keeps this
			// exact change id at its new position — no post-rebase head query
			// needed (one that would race sibling workspaces' own heads).
			const tipQuery = await execJj(
				[
					"log",
					"-r",
					`heads(${chainRev})`,
					"--no-graph",
					"--ignore-working-copy",
					"-T",
					'change_id ++ "\\n"',
				],
				opts.projectDir,
				timeout,
			);
			const chainTipChangeId = tipQuery.stdout
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.length > 0)[0] ?? "";
			// STACK the chain onto the current tip: its roots move (with their
			// descendants, by stable change ids — rebase never forks copies)
			// onto <tip>, producing ONE linear chain base → ws1 → ws2 …
			const rebase = await execJj(
				[
					"rebase",
					"-s",
					`roots(${chainRev})`,
					"-o",
					tipChangeId,
				],
				opts.projectDir,
				timeout,
			);
			if (rebase.code !== 0 || chainTipChangeId.length === 0)
				continue; // preserve > move: workspace stays live
			if (wsState !== "STUB") {
				// The workspace's @ IS content-bearing (e.g. the described
				// rescue snapshot, just stacked into the main ancestry).
				// `jj workspace forget` abandons the workspace's @, so detach it
				// first: a fresh empty working-copy commit on top takes the
				// abandonment instead. Requires the workspace's directory (this
				// jj build prints no paths in `workspace list`, so the caller
				// supplies them). Best effort — any failure here leaves the
				// workspace live rather than risking the rescued content.
				const wsDir = opts.workspaceDirs?.[name];
				if (wsDir === undefined) continue;
				try {
					const fresh = await execJj(["new"], wsDir, timeout);
					if (fresh.code !== 0) continue;
				} catch {
					continue;
				}
			}
			forgotten.push(name);
			stacked.push({ name, change_id: chainTipChangeId });
			tipChangeId = chainTipChangeId;
		} catch {
			// Best effort — degrade toward preservation.
		}
	}

	// Stub hygiene (rule 2 + user-abort R3): abandon ONLY provably
	// engine-authored empties; doubtful ones survive and are listed. Runs
	// AFTER stacking so a just-stacked workspace's leftover empty @ is
	// classified on its final position.
	if (opts.aiAuthorEmail !== undefined) {
		const stubs = await listEngineStubsBestEffort({
			projectDir: opts.projectDir,
			aiAuthorEmail: opts.aiAuthorEmail,
		});
		for (const changeId of stubs.engine) {
			try {
				await execJj(["abandon", changeId], opts.projectDir, timeout);
			} catch {
				// Best effort.
			}
		}
		// Doubtful survivors EXCLUDING workspace working-copy @s: those are
		// removed by design via the forget below and are never recovery
		// anchors — listing them would send the user hunting for commits the
		// engine itself is about to hide.
		const wsAtChangeIds = new Set(
			opts.workspaceNames.map((n) => wsEntries.get(n)?.changeId ?? ""),
		);
		preserved.push(
			...stubs.preserved.filter((id) => !wsAtChangeIds.has(id)),
		);
	}

	// Workspace forget (rule 5): the stacked/consumed workspaces' commits
	// are live in the main ancestry — their working copies are disposable.
	// Workspaces whose rebase failed stay live for manual recovery (named in
	// the commands below).
	for (const name of forgotten) {
		try {
			await execJj(["workspace", "forget", name], opts.projectDir, timeout);
		} catch {
			// Best effort.
		}
	}
	const keptLive = opts.workspaceNames.filter((n) => !forgotten.includes(n));

	return {
		base_change: opts.baseChangeId,
		stack_tip: tipChangeId,
		stacked,
		...(preserved.length === 0 ? {} : { preserved_stubs: [...preserved] }),
		commands: [
			`jj log -r ${opts.baseChangeId}::   # inspect the stacked worker commits`,
			`jj show ${tipChangeId}   # inspect the combined work`,
			`jj new ${tipChangeId}   # continue work on top of the stack`,
			...(keptLive.length > 0
				? [
						`jj workspace list   # ${keptLive.join(", ")} kept live — ` +
							"their commits could not be stacked automatically; recover manually",
					]
				: []),
			...preserved.map(
				(s) =>
					`jj abandon ${s}   # verified empty + undescribed — drop manually if unwanted`,
			),
		],
	};
}

/**
 * R2: a zeroed WorkerResult standing in for an aborted worker that never
 * yielded — the finalization-incomplete success-with-caveat path has no
 * yield payload (the session died mid-finalization); the manifest's usage
 * aggregates then carry the yielded workers' real usage, and the caveat
 * carries the recovery story.
 */
function abortedWorkerResult(): WorkerResult {
	return {
		yield: {
			files_changed: [],
			summary: "worker ended without a yield payload (verified salvage)",
			commit_ids: [],
			deviations: [],
		},
		usage: {
			turns: 0,
			tokens_in: 0,
			tokens_out: 0,
			cache_read: 0,
			cache_write: 0,
			cost_usd: 0,
			reads: 0,
			edits: 0,
		},
		exitCode: 1,
		reads: [],
		turnUsage: [],
	};
}

/** Best-effort files-changed list between two explicit revs (R2
 *  finalization-incomplete path: the aborted workers never yielded, so
 *  their files come from the merged delta instead of yield payloads). */
async function filesChangedBetweenBestEffort(
	cwd: string,
	from: string,
	to: string,
): Promise<string[]> {
	try {
		return await filesChangedBetween(cwd, from, to);
	} catch {
		return [];
	}
}

// ─── Pre-merge overlap classification (R5) ───────────────────────────

export type OverlapKind = "comment-only" | "substantive";

export interface FileOverlap {
	/** Repo-relative path changed by ≥2 workers. */
	file: string;
	/** The workers whose changes touch the file. */
	workers: string[];
	kind: OverlapKind;
}

/** Line prefixes that mark a changed line as comment-only (language
 *  agnostic: // # /* * -- ; ' <!--) plus whitespace-only lines. */
const COMMENT_LINE_RE = /^\s*(?:\/\/|#|\/\*|\*|--|;|'|<!--)/;

/**
 * Classify a multi-worker overlap on one file (R5): "comment-only" when
 * EVERY worker's added/removed lines are comments or whitespace — the
 * deterministic union path (R4) resolves such overlaps safely;
 * "substantive" when any worker changed a code line (or the file is
 * binary) — flagged in the merge report before merging. Input: each
 * worker's `jj diff --git` output for the file. Pure — hermetically
 * tested.
 */
export function classifyOverlapDiffs(diffsByWorker: string[]): OverlapKind {
	for (const diff of diffsByWorker) {
		if (diff.includes("Binary files differ")) return "substantive";
		for (const line of diff.split("\n")) {
			if (
				line.startsWith("+++") ||
				line.startsWith("---") ||
				line.startsWith("diff --git")
			)
				continue;
			if (!line.startsWith("+") && !line.startsWith("-")) continue;
			const content = line.slice(1);
			if (content.trim().length === 0) continue; // whitespace-only
			if (COMMENT_LINE_RE.test(content)) continue;
			return "substantive";
		}
	}
	return "comment-only";
}

/**
 * Best effort: preserve an aborted single-worker's WIP as a "rescue:"
 * commit so it survives in history and the next run starts from a clean
 * working copy. Only commits when the working copy is dirty (a clean
 * abort leaves nothing to save); swallows errors — never masks the
 * original failure. The message names the GOAL (the task description's
 * first line) with the abort cause in parentheses; with no goal the
 * legacy "aborted task run" summary is kept for compatibility. Returns
 * the rescue CHANGE id (null when clean / best-effort failed) for the
 * failure artifact's recovery block — change ids survive rebases that
 * rewrite commit ids. Exported for the hermetic tests (real jj on temp
 * repos); legacy callers may ignore the return value.
 */
export async function rescueAbortedWorkBestEffort(
	cwd: string,
	err: unknown,
	goal?: string,
): Promise<string | null> {
	try {
		const status = await execJj(["status"], cwd);
		if (status.code !== 0 || /has no changes/i.test(status.stdout)) return null;
		// Cause line: prefer the structured diagnostics (worker.ts
		// buildAbortError) — err.message is the composed multi-part worker
		// failure line and slices mid-clause; diagnostics.cause names the
		// termination kind cleanly ("Worker was aborted", watchdog lines).
		const diag = (
			err as { diagnostics?: { cause?: unknown } } | undefined
		)?.diagnostics;
		const cause = (
			typeof diag?.cause === "string"
				? diag.cause
				: err instanceof Error
					? err.message
					: "unknown cause"
		).slice(0, 140);
		const summary = (goal ?? "aborted task run").trim().split("\n")[0]!.slice(
			0,
			100,
		);
		await execJj(["commit", "-m", `rescue: ${summary} (${cause})`], cwd);
		const id = await execJj(
			[
				"log",
				"-r",
				"@-",
				"-T",
				"change_id",
				"--no-graph",
				"--ignore-working-copy",
			],
			cwd,
		);
		return id.code === 0 ? id.stdout.trim() || null : null;
	} catch {
		// Best effort — the original failure propagates regardless.
		return null;
	}
}

/** Machine-readable single-run recovery info (contract rule 6): where the
 *  rescued partial work lives plus the exact jj commands a user runs to
 *  inspect or continue it. Serialized deterministically into the failure
 *  artifact's `recovery` field — one fact per line, `key=value` for the
 *  machine (`grep '^rescued_commit=' *.failure.json`) and the commands
 *  verbatim for the human. */
export interface SingleRunRecoveryInfo {
	/** Change id of the goal-named rescue commit holding the WIP (absent
	 *  when the tree was clean or the rescue failed best-effort). */
	rescued_commit?: string | undefined;
	/** Empty description-less commits PRESERVED by doubt (provenance not
	 *  provably the engine's) — listed, never silently dropped. */
	preserved_stubs?: string[] | undefined;
	/** Exact jj commands to inspect/continue/repair the rescued work. */
	commands?: string[] | undefined;
}

/** Assemble the recovery record + scripted command list (pure). */
function buildSingleRunRecovery(
	rescued: string | null,
	preserved: string[],
): SingleRunRecoveryInfo {
	const commands = [
		"jj log -r all()   # locate the rescue: commit and any leftover stubs",
	];
	if (rescued !== null) {
		commands.push(
			`jj show ${rescued}   # inspect the rescued partial work`,
			`jj new ${rescued}   # continue work on top of the rescue`,
		);
	}
	for (const stub of preserved) {
		commands.push(
			`jj abandon ${stub}   # verified empty + undescribed — drop manually if unwanted`,
		);
	}
	return {
		...(rescued === null ? {} : { rescued_commit: rescued }),
		...(preserved.length === 0 ? {} : { preserved_stubs: [...preserved] }),
		commands,
	};
}

/** Serialize single-run recovery info into the artifact's `recovery`
 *  string field (pure): machine-grep-able key=value lines + the exact jj
 *  commands, so recovery is scripted rather than LLM-discovered. */
export function serializeSingleRunRecovery(
	info: SingleRunRecoveryInfo,
): string {
	const lines: string[] = [];
	if (info.rescued_commit !== undefined)
		lines.push(`rescued_commit=${info.rescued_commit}`);
	for (const s of info.preserved_stubs ?? [])
		lines.push(`preserved_stub=${s}`);
	lines.push(...(info.commands ?? []));
	return lines.join("\n");
}

/**
 * Single-run termination hygiene (failure-artifact contract rules 1–6):
 * rescue the dirty working copy into ONE goal-named commit directly on
 * the dispatch base, remove ONLY engine-created empty stubs, and produce
 * machine-readable recovery info. Stub removal is conservative: a commit
 * qualifies only when it is empty, description-less, AND authored by the
 * AI identity configured for this run — any doubt about provenance
 * preserves it and lists it under `preserved_stubs` instead of deleting
 * (a user abort mid-work must never destroy user content). Never
 * throws — every step is best effort; the original failure propagates
 * regardless.
 *
 * @returns the recovery record for the failure artifact, or undefined
 * when there is nothing to report (clean tree, no stubs).
 */
export async function singleRunFailureHygiene(opts: {
	cwd: string;
	err: unknown;
	/** Spec goal — its first line names the rescue commit. */
	goal?: string;
	/** AI identity configured for this run — the provenance test for
	 *  engine-authored empties. Absent → nothing is deleted. */
	aiAuthorName?: string | undefined;
	aiAuthorEmail?: string | undefined;
}): Promise<SingleRunRecoveryInfo | undefined> {
	const rescued = await rescueAbortedWorkBestEffort(
		opts.cwd,
		opts.err,
		opts.goal,
	);
	const preserved: string[] = [];
	try {
		// all() ~ root(): the immutable root is empty + undescribed by
		// construction — never an engine artifact, never ours to abandon.
		const log = await execJj([
			"log",
			"-r",
			"all() ~ root()",
			"--no-graph",
			"-T",
			'change_id ++ "|" ++ if(empty, if(description.first_line() == "", "STUB", "OK"), "OK") ++ "|" ++ author.email() ++ "\\n"',
		], opts.cwd);
		if (log.code === 0) {
			for (const line of log.stdout.split("\n")) {
				const m = /^([^|]+)\|STUB\|(.+)$/.exec(line.trim());
				if (!m) continue; // described or non-empty → not ours to touch
				const changeId = m[1]!;
				const authorEmail = m[2]!.trim();
				const engineAuthored =
					opts.aiAuthorEmail !== undefined &&
					authorEmail === opts.aiAuthorEmail;
				if (!engineAuthored) {
					preserved.push(changeId); // doubt → preserve + report
					continue;
				}
				await execJj(["abandon", changeId], opts.cwd);
			}
		}
	} catch {
		// Best effort — stub hygiene must never mask the original failure.
	}
	if (rescued === null && preserved.length === 0) return undefined;
	return buildSingleRunRecovery(rescued, preserved);
}

// ─── Pre-dispatch legacy-stray tolerance (R2/R4) ─────────────────────

export type CleanedStrayKind = "engine_stub" | "legacy_snapshot";
export type PreservedStrayKind = "stub" | "snapshot";

/** What the pre-dispatch gate found in a repo littered by past failed
 *  runs. `cleaned` entries were neutralized by the gate's single cleanup
 *  pass; `preserved` entries were LEFT ALONE (provenance doubt — a user
 *  abort mid-work must never destroy user content) and only reported. */
export interface LegacyStrayReport {
	cleaned: Array<{ kind: CleanedStrayKind; changeId: string }>;
	preserved: Array<{ kind: PreservedStrayKind; changeId: string }>;
}

/**
 * Classify legacy strays in the DEFAULT working-copy lineage (`::@`, the
 * only lineage a dispatch builds on — off-lineage leftovers belong to
 * live/preserved workspaces and are never ours to judge here).
 *
 * A commit in that lineage is a LEGACY STRAY when it carries content or
 * is empty yet is UNDESCRIBED (taxonomy classes 1–3: engine stubs, dirty
 * snapshots, rescue-opened stubs) — the compliant end-state after any
 * run's hygiene has none of these. Ownership follows the same provenance
 * doctrine as singleRunFailureHygiene: authored by the configured AI
 * identity → engine junk the gate may clean; anything else is DOUBT →
 * preserved and reported, never touched (R4). Described commits that are
 * not rescue-prefixed ("rescue: ..." — a past run's deliberate
 * preservation via rescueAbortedWorkBestEffort /
 * rescueWorkspaceStateBestEffort) are the user's history — skipped
 * outright; rescue-prefixed ones are ignorable base history for the same
 * reason: named, self-describing, never swept as junk (R4).
 * Bounded, never throws. The log deliberately does NOT use
 * --ignore-working-copy: like assertCleanWorkingCopy, its subject is the
 * LIVE working copy — the snapshot op folds any unsnapshotted tail into
 * `@` so the wedged-run shape (an undescribed AI snapshot AT @) is
 * actually visible. The live default-@ is then resolved BY CHANGE ID and
 * exempt when empty + undescribed: that is jj's normal resting state
 * after every command (abandon/jj new recreate it under whatever config
 * ran), not a stray — only a CONTENT-BEARING undescribed @ is one.
 */
export async function classifyLegacyStrays(opts: {
	cwd: string;
	aiAuthorEmail?: string | undefined;
}): Promise<LegacyStrayReport> {
	const report: LegacyStrayReport = { cleaned: [], preserved: [] };
	try {
		// Snapshot-triggering read FIRST (folds unsnapshotted tails into @),
		// then resolve the live @ against the now-current view.
		const log = await execJj(
			[
				"log",
				"-r",
				"(::@) ~ root()",
				"--no-graph",
				"-T",
				'change_id ++ "|" ++ if(empty, if(description.first_line() == "", "STUB", "OK"), "OK") ++ "|" ++ author.email() ++ "|" ++ description.first_line() ++ "\\n"',
			],
			opts.cwd,
		);
		if (log.code !== 0) return report;
		const at = await execJj(
			[
				"log",
				"-r",
				"@",
				"--no-graph",
				"--ignore-working-copy",
				"-T",
				"change_id",
			],
			opts.cwd,
		);
		const liveAt = at.code === 0 ? at.stdout.trim() : null;
		for (const line of log.stdout.split("\n")) {
			// Split (not regex): the description is last and may contain "|".
			const parts = line.trim().split("|");
			if (parts.length < 4) continue;
			const [changeId, emptyClass, authorEmail] = parts as [
				string,
				string,
				string,
			];
			const description = parts.slice(3).join("|");
			const isEmptyUndescribed = emptyClass === "STUB";
			// 1. Any DESCRIBED commit: a rescue-prefix marks a past run's
			// deliberate preservation (ignorable base history, never junk —
			// R4); any other description is history. Neither is ours to touch.
			if (description !== "") continue;
			// 2. Undescribed from here on. An EMPTY live tip is the working
			// copy itself (jj's resting state) — the strict check judges it.
			// A CONTENT-BEARING live tip is the wedged-run shape itself (a
			// dead worker's unsnapshotted tail folded into @) — it MUST fall
			// through to the ownership rules below, or every future dispatch
			// stays blocked forever.
			if (isEmptyUndescribed && liveAt !== null && changeId === liveAt) {
				continue;
			}
			const engineAuthored =
				opts.aiAuthorEmail !== undefined &&
				authorEmail === opts.aiAuthorEmail;
			if (isEmptyUndescribed) {
				// 3. Empty + undescribed, off-tip: a jj-mechanical artifact
				// (every `jj commit` opens one; dead runs leak more) with ZERO
				// content. Engine-authored → swept; anything else is not ours
				// to delete — and it blocks nothing, so it is ignored.
				if (engineAuthored) {
					report.cleaned.push({ kind: "engine_stub", changeId });
				}
				continue;
			}
			// 4. Content-bearing + undescribed: engine junk when provably the
			// engine's; REAL doubt (potential interrupted user work) otherwise
			// → preserved untouched and reported (R4).
			if (engineAuthored) {
				report.cleaned.push({ kind: "legacy_snapshot", changeId });
			} else {
				report.preserved.push({ kind: "snapshot", changeId });
			}
		}
	} catch {
		// Best effort — classification problems fall through to the strict
		// cleanness check, which reports the precise blocking state.
	}
	return report;
}

/**
 * The gate's ONE cleanup action (R2): abandon the classified engine
 * strays. Abandon (not describe-in-place) is deliberate for the tail:
 * a legacy snapshot left at @ keeps its files on disk and would pollute
 * the run's verification tree; abandoning drops them from the working
 * copy while the content stays recoverable in the hidden commit.
 * Mid-lineage abandons are content-safe: jj rebases descendants onto the
 * abandoned commit's parents preserving each child's tree. Change ids of
 * later items survive earlier abandons (rebase keeps change ids), and an
 * already-hidden id simply fails its abandon — caught and skipped, so
 * re-running moves nothing (idempotence, R3). Never throws.
 */
async function cleanLegacyStrays(opts: {
	cwd: string;
	classification: LegacyStrayReport;
}): Promise<void> {
	for (const item of opts.classification.cleaned) {
		try {
			await execJj(["abandon", item.changeId], opts.cwd);
		} catch {
			// Best effort — the strict check below still gates the dispatch.
		}
	}
}

/**
 * The pre-dispatch cleanness gate (R2/R4): tolerate repos littered by
 * PAST failed runs, block only genuine user work-in-progress.
 *
 * 1. Classify legacy strays in the dispatch lineage and clean the
 *    provably-engine junk in ONE pass (empty stubs, undescribed AI
 *    snapshots). Rescue commits are classified as ignorable base
 *    history — dispatch neither refuses nor multiplies them.
 * 2. Re-run the STRICT check (assertCleanWorkingCopy): the user's own
 *    uncommitted work still blocks dispatch exactly as before — the
 *    gate only ever removes what the engine itself authored undescribed.
 *
 * Assumption (unchanged from assertCleanWorkingCopy's design): dispatches
 * to one repo's default working copy are sequential — the gate is the
 * run's first jj writer, so it cannot race a live run's snapshot op.
 */
export async function ensureDispatchableTree(opts: {
	cwd: string;
	aiAuthorEmail?: string | undefined;
}): Promise<LegacyStrayReport> {
	const classification = await classifyLegacyStrays(opts);
	if (classification.cleaned.length > 0) {
		await cleanLegacyStrays({ cwd: opts.cwd, classification });
	}
	await assertCleanWorkingCopy(opts.cwd);
	return classification;
}

/**
 * Best-effort failure artifact: write the run's failure state to
 * <metricsDir>/<project>/<run_id>.failure.json when a worker, review,
 * parallel, or batch run dies without a manifest, so timeouts and aborts
 * are inspectable after the fact. Reads the structured `diagnostics` the
 * worker/review rejections carry (worker.ts buildAbortError). Swallows
 * write errors — never masks the original failure.
 */
function writeFailureArtifactBestEffort(opts: {
	err: unknown;
	kind: "worker" | "review" | "parallel" | "batch";
	runId?: string | undefined;
	metricsDir?: string | undefined;
	project: string;
	specMarkdown: string;
	tier?: string | undefined;
	/** R4 recovery hint (batch lane): the job-state file path — the
	 *  recovery handle for aborted/timed-out jobs and failed items. */
	recovery?: string | undefined;
	/** Contract rule 6: machine-readable single-run recovery block —
	 *  serialized into the artifact's `recovery` field (rescue change id,
	 *  preserved-by-doubt stubs, exact jj commands). */
	singleRunRecovery?: SingleRunRecoveryInfo | undefined;
}): void {
	if (!opts.metricsDir) return;
	try {
		const d = (opts.err as { diagnostics?: WorkerFailureDiagnostics })
			.diagnostics;
		const artifact = buildFailureArtifact({
			kind: opts.kind,
			...(opts.runId === undefined ? {} : { runId: opts.runId }),
			specHash: hashSpec(opts.specMarkdown),
			...(opts.tier === undefined ? {} : { tier: opts.tier }),
			cause:
				d?.cause ??
				(opts.err instanceof Error ? opts.err.message : String(opts.err)),
			...(d?.turns === undefined ? {} : { turns: d.turns }),
			...(d?.idleMs === undefined ? {} : { idleMs: d.idleMs }),
			lastTool: d?.lastTool ?? null,
			...(d?.stderrTail === undefined ? {} : { stderrTail: d.stderrTail }),
			// Rule 6: the single-run recovery block rides the existing
			// `recovery` guide field (serialized machine-grep-able), so it
			// reaches <run_id>.failure.json without a metrics.ts schema change.
			// A caller-supplied `recovery` (batch lane's job-state hint) wins.
			...(opts.recovery === undefined && opts.singleRunRecovery === undefined
				? {}
				: {
						recovery:
							opts.recovery ??
							serializeSingleRunRecovery(opts.singleRunRecovery!),
					}),
		});
		writeFailureArtifact(artifact, {
			metricsDir: opts.metricsDir,
			project: opts.project,
		});
	} catch {
		// Best effort — the original failure propagates regardless.
	}
}

// ─── Types ───────────────────────────────────────────────────────────

export interface ExecuteTaskOptions {
	/** Working directory (must be a jj repo). */
	cwd: string;
	/** Model for the worker, e.g. "opencode-go/deepseek-v4-flash". */
	model: string;
	/** Spec markdown (Goal / Requirements / Verification). Required unless
	 *  subSpecs is set. */
	spec?: string;
	/** Per-worker encapsulated sub-specs (Phase 9): one worker per sub-spec,
	 *  each receiving its own sub-spec as the task prompt. Takes precedence
	 *  over spec + parallel — no splitSpec, no shared goal, no scope leak by
	 *  construction. Each sub-spec must be fully self-contained (its own
	 *  Goal / Requirements / Verification); the union of their verification
	 *  commands is the single post-merge gate, run once on the merged tree. */
	subSpecs?: string[];
	/** Worker system prompt (appended to pi's default). */
	systemPrompt?: string | undefined;
	/** When set, worker starts on this model and swaps to the execute
	 *  model on its first edit (prewalk). Auto-skipped if == execute model. */
	prewalkModel?: string;
	/** Model the worker runs on after the prewalk swap. Defaults to model. */
	executeModel?: string;
	/** R2: called once per dispatch with what the pre-dispatch legacy-stray
	 *  tolerance found and did in the repo — engine strays cleaned, doubtful
	 *  undescribed commits preserved. Lets the caller surface the cleanup to
	 *  the user instead of silently rewriting their history. */
	onStrays?: ((report: LegacyStrayReport) => void) | undefined;
	/** Called when a prewalk model swap fires. */
	onSwap?: ((info: SwapInfo) => void) | undefined;
	/** Number of parallel workers. Default: 1 (single-worker path).
	 *  Each worker gets an isolated jj workspace merged into the task base
	 *  afterwards; clamped to the requirement count. */
	parallel?: number;
	/** Inject a codebase map into the worker prompt. Default: config (injectWorkers). */
	useMap?: boolean;
	/** Map build mode override ("full" | "skeleton"). Default: config. */
	mapMode?: "full" | "skeleton";
	/** Map annotation model override. Default: config (then execute model). */
	mapModel?: string;
	/** Abort signal — terminates the worker on abort. */
	signal?: AbortSignal | undefined;
	/** Per-command timeout for verification (ms). Default: 10 min. */
	verificationTimeoutMs?: number | undefined;
	/**
	 * Worker wall-clock budget (ms, Phase 11 — R5). Default:
	 * WORKER_WALL_TIMEOUT_MS (45 min). The task tool passes the resolved
	 * tier's wall_timeout_ms; direct callers may override. Mirrors
	 * verificationTimeoutMs.
	 */
	workerTimeoutMs?: number;
	/**
	 * Per-tool-call budget for a single worker tool execution (ms, Phase 11
	 * — R4). Default: WORKER_TOOL_TIMEOUT_MS (15 min, [defaults]
	 * tool_timeout_ms). The bound for a hung tool the no-progress watchdog
	 * cannot see. Mirrors verificationTimeoutMs.
	 */
	toolTimeoutMs?: number;
	/**
	 * Wall-clock budget for EACH forked review (ms, [defaults]
	 * review_wall_timeout_ms). Default: 20 min — the same REVIEW_WALL_TIMEOUT_MS
	 * constant review.ts falls back to. Independent of workerTimeoutMs:
	 * every review fork gets its own budget, never subtracted from or
	 * shared with the worker's tier wall.
	 */
	reviewWallTimeoutMs?: number;
	/** Enable forked adversarial review + bounded fix loop (single-worker).
	 *  Default: false — the pre-Phase-7 verify-once path, unchanged. The
	 *  task.toml budget wiring is Phase 10; this is the per-call switch. */
	review?: boolean;
	/** Reviewer model (when review enabled). Default: the execute model. */
	reviewModel?: string;
	/** Reviewer persona name (when review enabled). Unset → the DEFAULT
	 *  review: ONE adversarial fork (DEFAULT_PERSONA), regardless of how
	 *  many axes the shape declares. "parallel" (PARALLEL_REVIEW_PERSONA)
	 *  → the shape's full declared axis set as parallel forks (the old
	 *  default; the explicit opt-in for high-stakes/shared code). A single
	 *  name (e.g. "adversarial" or "architecture") selects exactly that
	 *  one axis. Only shapes that declare review axes fork a review — an
	 *  explicit persona on an axis-less shape (analysis) is skipped, never
	 *  forked. */
	persona?: string;
	/** The run-pipeline SHAPE (resolved by the task tool from its `shape`
	 *  param / the tier's default): the phase structure, swap policy, model
	 *  slots, and review axes. Default: the built-in code shape. */
	shape?: TaskShape;
	/** Max fix workers the loop may dispatch (when review enabled). Default: 2. */
	maxFixIterations?: number | undefined;
	/** Tasks with FEWER requirements than this skip the prewalk (start
	 *  straight on the execute model). Default: config
	 *  `[defaults] prewalk_min_requirements` (3). */
	prewalkMinRequirements?: number;
	/** Batch lane config ([batch] section, M2). Omitted → loadTaskConfig's
	 *  [batch] (the shipped defaults when no task.toml). Only consulted on
	 *  the batch channel (shape.channel === "batch"). */
	batch?: BatchLaneConfig;
	/** OpenRouter service tier for this run's subprocesses (the tier's
	 *  service_tier config — "flex" | "priority"). Threaded to every worker
	 *  and reviewer spawn; recorded in the manifest. Unset → standard. */
	serviceTier?: string | undefined;
	/** Turn budget for the main worker (the tier's turn_budget — Phase 3):
	 *  convergence nudge at 70%, typed abort at 100%. Unset → unbounded. */
	turnBudget?: number | undefined;
	/** Whether the worker tracks requirements via the checklist tool
	 *  (the tier's checklist config). false → the checklist extension is
	 *  not loaded and the prompt stops mandating it. Default: true. */
	checklist?: boolean | undefined;
	/** OpenRouter endpoint slugs for provider.only (the tier's provider_only
	 *  config — the flex pin). Threaded with serviceTier. */
	providerOnly?: string[] | undefined;
	/** Batch provider injection (hermetic tests inject the fake; the task
	 *  tool never passes one). Default: OpenRouterBatchProvider (needs
	 *  OPENROUTER_API_KEY — typed BatchError("no_api_key") when absent). */
	batchProvider?: BatchProvider | undefined;
	/** Budget tier label for the manifest (Phase 10). Orchestrator does
	 *  not interpret it — the task tool passes the resolved tier so
	 *  persisted manifests carry config.budget. Direct executeTask callers
	 *  may omit it (manifests then say "default"). */
	budget?: string | undefined;
	/** Directory for persisted run manifests. When unset, the manifest is
	 *  built in-memory only (TaskResult.manifest) and nothing is written. */
	metricsDir?: string | undefined;
	/**
	 * Worker sandbox policy ([sandbox] vocabulary, config/task.toml).
	 * Omitted → the built-in defaults (same shape as loadTaskConfig with no
	 * file — sandbox enabled). Resolved ONCE per run: when enabled the host
	 * is probed with a real user-namespace call (probeBwrapAvailability); a
	 * probe failure degrades this run to plain spawns with ONE actionable
	 * warning.
	 */
	sandbox?: SandboxConfig | undefined;
	/**
	 * AI commit identity (todo #84): worker commits are authored as
	 * aiAuthorName / aiAuthorEmail ("{model}" in the name is replaced with
	 * the execute model's short name). Omitted → the built-in defaults
	 * ("Pi ({model})" / noreply@danong.dev). The user's own commits keep
	 * their identity — the override is worker-scoped (JJ_CONFIG in the
	 * worker env) and the parallel merge target (createAiTaskBase).
	 */
	aiAuthorName?: string | undefined;
	aiAuthorEmail?: string | undefined;
	/** Project name for the manifest path (<metricsDir>/<project>/...).
	 *  Default: the cwd basename. */
	project?: string | undefined;
	/** Preserve worker session traces next to the manifest (benchmark mode;
	 *  requires metricsDir). Implies the worker persists its session. */
	preserveSessions?: boolean | undefined;
	onUpdate?: ((partial: unknown) => void) | undefined;
	/** Wall-clock run-lifecycle timestamps + pre-dispatch main-session spend
	 *  (R1). The task tool records received_at + main_session_tokens when the
	 *  tool call starts (main-session tokens read via sessionManager); direct
	 *  callers may omit them (manifest fields then absent/zero — backward
	 *  compatible). dispatched_at/completed_at are stamped by the orchestrator. */
	receivedAt?: string | undefined;
	mainSessionTokens?: number | undefined;
	/** Pre-generated run id (detached dispatch): the caller knows the id
	 *  BEFORE the run completes (it returns it immediately), so the manifest
	 *  and any failure artifact must land under that same id. Absent →
	 *  generated at finalization (blocking runs, unchanged). */
	runId?: string | undefined;
}

export interface VerificationCommandResult {
	command: string;
	exitCode: number;
	output: string;
}

export interface VerificationResult {
	passed: boolean;
	commands: number;
	duration_ms: number;
	failures: VerificationCommandResult[];
	/** True when a command was killed by its timeout (exit 124). */
	timed_out?: boolean;
}

export interface TaskResult {
	success: boolean;
	/** Commit ids created by the run. Single-worker: the worker's commit
	 *  ids. Parallel: EXACTLY one id — the merged task base's commit id
	 *  resolved AFTER the last squash (the workers' pre-squash commits are
	 *  abandoned by `jj squash`, so their ids would be dead revisions). */
	commits: string[];
	files_changed: string[];
	tests: "passing" | "failing";
	spec: Spec;
	/** First worker's result (the only worker in single-worker mode). */
	worker: WorkerResult;
	/** All worker results. Present when `parallel > 1`. */
	workers?: WorkerResult[];
	/** Repo-relative paths with unresolved merge conflicts. Present when
	 *  `parallel > 1`; empty when the merge was clean. */
	conflicts?: string[];
	verification: VerificationResult;
	/** Adversarial review report (last loop iteration). Present when review
	 *  is enabled. */
	review?: ReviewResult;
	/** Fix-loop metadata. Present when review is enabled. */
	fixLoop?: { iterations: number; fixesDispatched: number };
	/** True when a requested review was skipped instead of forked: review is
	 *  single-worker only (a parallel run ignores the flag and verifies
	 *  only), and it forks only on shapes that declare review axes — a
	 *  requested review on an axis-less shape (e.g. analysis) is never
	 *  forked, whatever was requested. */
	reviewSkipped?: boolean;
	/** Verification commands whose failures exactly matched their pre-change
	 *  baseline — suspected spec defects (unsatisfiable gates the fix loop
	 *  spent nothing on). Present only when non-empty. */
	suspectedSpecDefects?: string[];
	/** Adjudicated worker disputes (Phase 2 of the verification lifecycle):
	 *  upheld = excluded from the gate by baseline evidence; rejected =
	 *  recorded for the spec author. Present only when disputes were made. */
	disputes?: { upheld: string[]; rejected: VerificationDispute[] };
	/** R2: success-with-caveat note — present when a finalization-incomplete
	 *  abort recovered (the merge landed and the verification gate PASSED
	 *  post-abort): names the aborted worker(s), the merged commit id, and
	 *  the file delta. */
	caveat?: string;
	/** Structured per-run metrics manifest (always built in-memory). */
	manifest?: RunManifest;
	/** Where the manifest was persisted, when a metricsDir is configured. */
	manifestPath?: string;
	/** Total run wall time (ms) — always populated, single AND parallel, so
	 *  the completion summary is consistent even when no manifest is
	 *  present. Same clock as the progress view's total-elapsed line. */
	durationMs: number;
	/** Batch-lane record (M2): present when the run took the batch channel
	 *  (shape.channel === "batch") — the provider job id, the batch model,
	 *  and the collected item count. */
	batch?: { jobId: string; model: string; items: number };
}

// ─── Verification runner ─────────────────────────────────────────────

const DEFAULT_VERIFICATION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

function runCommand(
	command: string,
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<VerificationCommandResult> {
	return new Promise((resolve) => {
		execFile(
			"/bin/sh",
			["-c", command],
			{ cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, signal },
			(error, stdout, stderr) => {
				// Timeout exit code 124 (conventional, matches `timeout(1)`).
				// Node 22 reports execFile timeouts as killed=true + signal=SIGTERM
				// (code is null); ETIMEDOUT is the older/other-platform shape.
				const err = error as
					| (NodeJS.ErrnoException & { killed?: boolean; signal?: string })
					| null;
				const timedOut =
					err?.code === "ETIMEDOUT" ||
					(err?.killed === true && err.signal === "SIGTERM");
				const exitCode = !err
					? 0
					: timedOut
						? 124
						: typeof err.code === "number"
							? err.code
							: 1;
				const output = [stdout, stderr].filter(Boolean).join("\n").trim();
				resolve({ command, exitCode, output });
			},
		);
	});
}

/**
 * Run verification commands sequentially (bash hard gate, zero LLM tokens).
 * Stops per-command only: every command runs, failures are aggregated.
 * Exported for tests — real bash on a temp repo, no worker needed.
 */
export async function runVerification(
	commands: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<VerificationResult> {
	const start = Date.now();
	const failures: VerificationCommandResult[] = [];

	for (const command of commands) {
		const result = await runCommand(command, cwd, timeoutMs, signal);
		if (result.exitCode !== 0) failures.push(result);
	}

	return {
		passed: failures.length === 0,
		commands: commands.length,
		duration_ms: Date.now() - start,
		failures,
		timed_out: failures.some((f) => f.exitCode === 124),
	};
}

// ─── Verification lifecycle: baseline evidence (spec-defect adjudication) ──
//
// A spec's verification commands can be malformed (the incident class:
// a grep substring-matching a live symbol — fails identically before and
// after ANY change, and no fix worker can ever satisfy it). The engine
// adjudicates by EVIDENCE, not prompts:
//   1. captureVerificationBaseline dry-runs every command on the untouched
//      tree at dispatch (zero model tokens) and records exit + output
//      signature. Broken commands (command-not-found / shell syntax
//      errors) reject the dispatch BEFORE any worker spawns.
//   2. Post-change, classifyVerificationFailures matches each failure
//      against its baseline: identical (exit + signature) → spec defect
//      suspected → the fix loop spends ZERO iterations on it.

/** A dry-run baseline record for one verification command. */
export interface VerificationBaselineEntry {
	command: string;
	exitCode: number;
	/** Bounded output signature (first chars only) for exact comparison. */
	signature: string;
}

/** Bytes of output kept in a baseline signature (head-bounded). */
export const BASELINE_SIGNATURE_CAP = 2000;

/** Pure: the bounded comparison signature of a command's output. */
export function outputSignature(
	output: string,
	cap: number = BASELINE_SIGNATURE_CAP,
): string {
	return output.length <= cap ? output : output.slice(0, cap);
}

/**
 * Pure: is this baseline record a BROKEN command (as opposed to a
 * legitimately-failing one)? Narrow by design — only unambiguous shell
 * breakage rejects a dispatch; everything else is merely a red baseline
 * (most task verifications fail before the change — that is TDD, not a
 * defect).
 */
export function isBrokenVerificationCommand(
	entry: VerificationBaselineEntry,
): boolean {
	if (entry.exitCode === 127) return true; // command not found
	return (
		entry.exitCode === 2 && /syntax error|parse error/i.test(entry.signature)
	);
}

/**
 * Dry-run every verification command on the UNTOUCHED tree (dispatch
 * time, zero model tokens). Failing commands are expected (red baselines);
 * BROKEN commands (isBrokenVerificationCommand) throw — the dispatch is
 * rejected before any worker spawns and nobody pays for a malformed gate.
 */
export async function captureVerificationBaseline(
	commands: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<VerificationBaselineEntry[]> {
	const baseline: VerificationBaselineEntry[] = [];
	for (const command of commands) {
		const result = await runCommand(command, cwd, timeoutMs, signal);
		const entry: VerificationBaselineEntry = {
			command,
			exitCode: result.exitCode,
			signature: outputSignature(result.output),
		};
		if (isBrokenVerificationCommand(entry)) {
			throw new Error(
				`verification command is broken (exit ${entry.exitCode} on the untouched tree) — fix the spec before dispatching:\n` +
					`  ${command}\n` +
					`  ${entry.signature.split("\n")[0]}`,
			);
		}
		baseline.push(entry);
	}
	return baseline;
}

/**
 * Pure: split post-change verification failures by baseline evidence. A
 * failure whose exit code AND output signature exactly match its baseline
 * entry is a suspected spec defect (the change made no difference — the
 * command was unsatisfiable before the work began). Everything else is
 * actionable fix-loop material. Failures for commands absent from the
 * baseline are actionable (conservative).
 */
export function classifyVerificationFailures(
	failures: VerificationCommandResult[],
	baseline: VerificationBaselineEntry[],
): {
	actionable: VerificationCommandResult[];
	specDefectSuspected: VerificationCommandResult[];
} {
	const byCommand = new Map(baseline.map((b) => [b.command, b]));
	const actionable: VerificationCommandResult[] = [];
	const specDefectSuspected: VerificationCommandResult[] = [];
	for (const failure of failures) {
		const base = byCommand.get(failure.command);
		if (
			base &&
			base.exitCode === failure.exitCode &&
			base.signature === outputSignature(failure.output)
		) {
			specDefectSuspected.push(failure);
		} else {
			actionable.push(failure);
		}
	}
	return { actionable, specDefectSuspected };
}

/** A worker's structured challenge against a verification command. */
export interface VerificationDispute {
	command: string;
	reason: string;
}

/**
 * Pure: adjudicate worker disputes by EVIDENCE — a dispute is upheld only
 * when the command's current failure matches its pre-change baseline
 * exactly (the same shape classifyVerificationFailures flags as a spec
 * defect). Anything else — a different failure, or a command that passed
 * — is rejected and recorded. Disputes never override the gate
 * unilaterally; upheld ones join the suspect list (excluded from the fix
 * loop), rejected ones travel to the manifest for the spec author.
 */
export function adjudicateDisputes(
	disputes: VerificationDispute[],
	failures: VerificationCommandResult[],
	baseline: VerificationBaselineEntry[],
): { upheld: string[]; rejected: VerificationDispute[] } {
	const suspected = new Set(
		classifyVerificationFailures(failures, baseline).specDefectSuspected.map(
			(f) => f.command,
		),
	);
	const upheld: string[] = [];
	const rejected: VerificationDispute[] = [];
	for (const dispute of disputes) {
		if (suspected.has(dispute.command)) upheld.push(dispute.command);
		else rejected.push(dispute);
	}
	return { upheld, rejected };
}

// ─── Turn budget (Phase 3): bounded autonomy ─────────────────────────
//
// Prompt discipline does not scale (it would apply to no other pi agent
// using pi-task), so the bound is mechanical: at 70% of the tier's
// turn_budget the engine injects a convergence prompt; at 100% it aborts
// the session with a typed error.

/** Pure: the turn-budget decision for the just-ended turn. */
export function decideTurnBudgetAction(
	turns: number,
	budget: number | undefined,
	nudged: boolean,
): "none" | "nudge" | "abort" {
	if (!budget || budget <= 0) return "none";
	if (turns >= budget) return "abort";
	if (!nudged && turns >= Math.ceil(budget * 0.7)) return "nudge";
	return "none";
}

/** The convergence prompt injected at the soft threshold. */
export function turnBudgetNudgeMessage(turns: number, budget: number): string {
	return (
		`TURN BUDGET: ${turns}/${budget} turns used. Converge now: finish with the fewest possible ` +
		`tool calls (batch independent calls, never repeat a command), run verification once, and ` +
		`call yield(). If verification cannot pass, yield and report why.`
	);
}

// ─── Spec aggregation (sub_specs mode, Phase 9) ──────────────────────

/**
 * Aggregate per-worker sub-specs into one Spec: parse each independently
 * (every sub-spec must be fully self-contained — its own Requirements and
 * Verification) and merge. The aggregate's requirements and verification
 * are the unions; the goal is the first non-empty one (informational).
 * The union verification is the single post-merge gate. Errors name the
 * offending sub-spec index.
 */
export function aggregateSubSpecs(subSpecs: string[]): Spec {
	const parsed = subSpecs.map((s, i) => {
		try {
			return parseSpec(s);
		} catch (err) {
			if (err instanceof SpecError) {
				throw new SpecError(`sub_specs[${i}] is invalid: ${err.message}`);
			}
			throw err;
		}
	});
	return {
		goal: parsed.map((p) => p.goal).find((g) => g.length > 0) ?? "",
		requirements: parsed.flatMap((p) => p.requirements),
		verification: parsed.flatMap((p) => p.verification),
	};
}

// ─── Spec splitting (parallel) ──────────────────────────────────────

/**
 * Deterministic spec split for parallel workers: round-robin by
 * requirement index — worker j gets requirements where index % N === j.
 * Original requirement ids ("R1", "R2", ...) are preserved so the
 * worker's checklist maps back to the source spec. The full spec's
 * verification commands are not splittable across workers, so each
 * sub-task carries a note instead; the orchestrator runs the full
 * verification once on the merged tree after all workers finish.
 *
 * Each sub-task also carries an explicit Scope contract: the shared goal
 * may name deliverables assigned to OTHER partitions (a fast model will
 * follow the goal's explicit file list and over-create, causing merge
 * conflicts), so the sub-task pins "implement ONLY the listed
 * requirements" as the binding contract.
 */
export function splitSpec(spec: Spec, parallel: number): string[] {
	const buckets: string[][] = Array.from({ length: parallel }, () => []);
	spec.requirements.forEach((req, index) => {
		// index < parallel keeps every bucket in range (noUncheckedIndexedAccess).
		buckets[index % parallel]!.push(`- ${req}`);
	});
	return buckets.map((reqs) => {
		const parts = [`## Goal\n${spec.goal}`];
		if (reqs.length > 0) parts.push(`## Requirements\n${reqs.join("\n")}`);
		parts.push(
			"## Scope\nThis is one partition of a parallel task. Implement ONLY the requirements listed in this sub-task; other partitions handle the rest. Do not create files or make changes beyond what the listed requirements describe.",
			"## Verification\nFull-spec verification runs after merging. Sanity-check your own changes before yielding.",
		);
		return parts.join("\n\n");
	});
}

// ─── Batch channel routing (M2) ─────────────────────────────────────

/**
 * Pure channel-routing decision: a shape on the batch channel (declared
 * in M1) routes the run to the batch lane (single-turn job, no interactive
 * worker); sync/flex run the interactive pipeline. The batch lane has no
 * tool loop and no workspace model, so parallel/sub_specs runs on it are
 * a configuration error (invalid — the caller throws the reason). Pure —
 * hermetically tested in test-batch.ts.
 */
export type RunRoute =
	| { kind: "batch" }
	| { kind: "interactive" }
	| { kind: "invalid"; reason: string };

export function routeRun(
	shape: TaskShape | undefined,
	opts: { parallel?: number; hasSubSpecs?: boolean } = {},
): RunRoute {
	const channel = (shape ?? DEFAULT_SHAPE).channel;
	if (channel !== "batch") return { kind: "interactive" };
	if ((opts.parallel ?? 1) > 1) {
		return {
			kind: "invalid",
			reason:
				"the batch channel does not support parallel runs (single-turn job lane, no workspaces)",
		};
	}
	if (opts.hasSubSpecs) {
		return {
			kind: "invalid",
			reason:
				"the batch channel does not support sub_specs runs (single-turn job lane, one spec)",
		};
	}
	return { kind: "batch" };
}

/**
 * Review fork gate (R1): the nested forked review runs ONLY when the run's
 * shape declares a review axis — the declared axes are a required
 * precondition for the tier's review flag AND the persona override alike.
 * A shape with no axes (the built-in analysis shape: surveys/reviews are a
 * single task, the worker itself IS the review) never forks a nested
 * reviewer, whatever is requested — the request surfaces as `skipped` (the
 * TaskResult.reviewSkipped disposition, same contract as parallel/batch).
 * The gate keys on DECLARED AXES, never the shape name/channel: a
 * hypothetical custom shape that declares axes still forks. Pure — tested
 * hermetically (testReviewGate in test-orchestrator.ts).
 */
export function resolveReviewGate(
	opts: { review?: boolean; persona?: string },
	shape: TaskShape,
): { requested: boolean; enabled: boolean; skipped: boolean } {
	const requested = opts.review === true || opts.persona !== undefined;
	const enabled = requested && shape.review.length > 0;
	return { requested, enabled, skipped: requested && !enabled };
}

/**
 * Sentinel persona name: fork ALL of the shape's declared review axes in
 * parallel (the pre-R1 default for code runs). Handled BEFORE getPersona —
 * it is not itself a registered persona, and resolveReviewAxes never feeds
 * it to the registry lookup. Pure — tested hermetically (testReviewAxes).
 */
export const PARALLEL_REVIEW_PERSONA = "parallel";

/**
 * Resolve the review forks to dispatch (R1): NO persona override → exactly
 * ONE fork of the default adversarial persona, regardless of how many axes
 * the shape declares. `"parallel"` (PARALLEL_REVIEW_PERSONA) → the shape's
 * full declared axis set as parallel forks (the old default; the explicit
 * opt-in for high-stakes/shared code), falling back to [DEFAULT_PERSONA]
 * when none of the axes resolve. A single named persona (e.g. "adversarial"
 * or "architecture") → exactly that one axis (unknown names fall back to
 * the default). Axis-less shapes never reach here — resolveReviewGate
 * disabled the review upstream. Pure — tested hermetically.
 */
export function resolveReviewAxes(
	persona: string | undefined,
	shape: TaskShape | undefined,
): Persona[] {
	if (persona === PARALLEL_REVIEW_PERSONA) {
		const axes = (shape ?? DEFAULT_SHAPE).review
			.map((n) => getPersona(n))
			.filter((p): p is Persona => p !== undefined);
		return axes.length > 0 ? axes : [DEFAULT_PERSONA];
	}
	if (persona !== undefined) return [getPersona(persona) ?? DEFAULT_PERSONA];
	return [DEFAULT_PERSONA];
}

// ─── Review + bounded fix loop (Phase 7) ─────────────────────────────

/** Priorities that block ship and drive the fix loop. */
export const BLOCKER_PRIORITIES = new Set(["P0", "P1"]);

export function isBlocker(f: Finding): boolean {
	return BLOCKER_PRIORITIES.has(f.priority);
}

export function blockersOf(review: ReviewResult): Finding[] {
	return review.findings.filter(isBlocker);
}

export type FixLoopDecision = "ship" | "fix" | "escalate";

/**
 * Pure fix-loop control. After a verify+review pass, decide whether to ship,
 * dispatch another fix worker, or escalate. `review` is null when review is
 * disabled (verification-only). Clean = tests pass AND no P0/P1 blockers;
 * out of fix budget and not clean → escalate. Hermetically tested.
 */
export function decideFixLoop(opts: {
	testsPass: boolean;
	review: ReviewResult | null;
	fixesUsed: number;
	maxFixes: number;
}): FixLoopDecision {
	const blockers = opts.review ? blockersOf(opts.review) : [];
	if (opts.testsPass && blockers.length === 0) return "ship";
	if (opts.fixesUsed >= opts.maxFixes) return "escalate";
	return "fix";
}

/** Default cap on each verification failure's output embedded in the fix
 *  prompt — a real suite's output can be multi-KB, and it is re-sent on
 *  every fix iteration. Truncated cell: first N lines + a pointer. */
const FIX_PROMPT_OUTPUT_CAP_LINES = 40;

/** Pure: cap a verification failure's output for the fix prompt (first
 *  {@link FIX_PROMPT_OUTPUT_CAP_LINES} lines + a pointer when truncated).
 *  Hermetically tested. */
export function capFixOutput(
	output: string,
	capLines: number = FIX_PROMPT_OUTPUT_CAP_LINES,
): string {
	const lines = output.split("\n");
	if (lines.length <= capLines) return output;
	return (
		lines.slice(0, capLines).join("\n") +
		`\n… (${lines.length - capLines} more lines truncated — full output in the manifest)`
	);
}

/**
 * Build the fix-worker prompt from the verification failures + P0/P1
 * findings. Pure — tested hermetically. The fix worker makes the changes and
 * yields; the orchestrator then re-verifies and re-reviews. Failure outputs
 * are capped (see {@link capFixOutput}) so a verbose suite does not blow the
 * prompt on every fix iteration.
 */
export function buildFixPrompt(opts: {
	specMarkdown: string;
	failures: VerificationCommandResult[];
	findings: Finding[];
}): string {
	const parts = [
		"You are fixing issues found during review of a completed task. Address the " +
			"findings below and make the verification pass, then call yield().",
		`## Spec\n${opts.specMarkdown}`,
	];
	if (opts.failures.length > 0) {
		const failText = opts.failures
			.map(
				(f) =>
					`### \`${f.command}\` (exit ${f.exitCode})\n\`\`\`\n${capFixOutput(f.output)}\n\`\`\``,
			)
			.join("\n\n");
		parts.push(`## Verification failures\n${failText}`);
	}
	if (opts.findings.length > 0) {
		const findText = opts.findings
			.map(
				(f) =>
					`- [${f.priority}] (${f.category}) ${f.file}: ${f.description} — verify: ${f.verification}`,
			)
			.join("\n");
		parts.push(`## Review findings to address (P0/P1)\n${findText}`);
	}
	return parts.join("\n\n");
}

/** Commit id of a rev (default @) — used to anchor the review diff at the task base.
 *  --ignore-working-copy: the recorded @ is exact pre-spawn, and read-only
 *  commands must not write snapshot ops (todo #70's op-log fork). */
function headCommitId(cwd: string, rev = "@"): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"jj",
			[
				"log",
				"-r",
				rev,
				"--no-graph",
				"-T",
				"commit_id",
				"--ignore-working-copy",
			],
			{ cwd },
			(error, stdout) => {
				if (error)
					reject(new Error(`jj log -r ${rev} failed: ${error.message}`));
				else resolve(stdout.trim());
			},
		);
	});
}

/** Cumulative diff of the change from a base rev to the current working copy's parent. */
function computeDiff(cwd: string, fromRev: string): Promise<string> {
	// R2: fail FAST on a jj failure — an empty fallback diff would be fed to
	// the reviewer, which would likely report "ship" and silently neuter the
	// review gate. The rejection propagates through executeSingle's try/finally
	// (sessionDir cleanup) and out to the caller as the run's error.
	// R3 (todo #70): --ignore-working-copy — the diff runs AFTER the worker
	// yielded; a snapshot op here (the working copy may be dirty) could race
	// a fix worker's commits and fork the op log. @- resolves from the
	// recorded working-copy commit, which is exact for the diff's purpose.
	return new Promise((resolve, reject) => {
		execFile(
			"jj",
			[
				"diff",
				"--from",
				fromRev,
				"--to",
				"@-",
				"--git",
				"--ignore-working-copy",
			],
			{ cwd, maxBuffer: MAX_OUTPUT_BYTES },
			(error, stdout) => {
				if (error)
					reject(
						new Error(`jj diff --from ${fromRev} failed: ${error.message}`),
					);
				else resolve(stdout.trim());
			},
		);
	});
}

/**
 * Parse `jj diff --git` output into added/removed line counts (R1 diff
 * stats): every line starting with "+" counts as an insertion, "-" as a
 * deletion, EXCLUDING the "+++"/"---" hunk headers. Binary diffs and
 * rename-only changes count nothing. Pure — hermetically tested.
 */
export function parseDiffStat(diff: string): {
	insertions: number;
	deletions: number;
} {
	let insertions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) insertions++;
		else if (line.startsWith("-")) deletions++;
	}
	return { insertions, deletions };
}

/**
 * Best-effort diff stats for the manifest: a metrics failure (e.g. a jj
 * error at finalize) must not fail an otherwise-successful run — record
 * 0/0 and keep going (collection is external; workers don't know they're
 * being measured).
 */
async function computeDiffStatBestEffort(
	cwd: string,
	fromRev: string,
): Promise<{ insertions: number; deletions: number }> {
	try {
		return parseDiffStat(await computeDiff(cwd, fromRev));
	} catch {
		// Best effort — the run's outcome is already decided; metrics are additive.
		return { insertions: 0, deletions: 0 };
	}
}

// ─── Metrics assembly + persistence (Phase 8) ────────────────────────

interface ReviewMetricsInput {
	result: ReviewResult;
	costUsd: number;
	/** The review axes that ran (e.g. ["standards", "spec-fidelity"]). */
	personas: string[];
}

/** Assemble the RunManifest from collected run data (pure wiring over the
 *  metrics.ts functions; no I/O). */
function assembleManifest(opts: {
	specMarkdown: string;
	requirements: number;
	prewalkModel: string;
	executeModel: string;
	reviewModel: string;
	/** The run-pipeline SHAPE the run used (resolved by executeTask).
	 *  Optional: absent → the built-in defaults (name "code", channel
	 *  "sync") are recorded on the manifest. */
	shape?: NamedTaskShape | undefined;
	reviewForked: boolean;
	budget?: string | undefined;
	/** OpenRouter service tier the run requested (flex infra). */
	serviceTier?: string | undefined;
	worker: WorkerResult;
	workerDurationMs: number;
	totalDurationMs: number;
	swapTurn: number | null;
	verification: VerificationResult;
	/** Spec-defect suspects (baseline-matched failures) for the manifest. */
	suspectedSpecDefects?: string[] | undefined;
	/** Adjudicated worker disputes for the manifest. */
	disputes?: { upheld: string[]; rejected: VerificationDispute[] } | undefined;
	review: ReviewMetricsInput | null;
	fixLoop: { iterations: number; costUsd: number };
	/** Whether the worker sandbox was ACTIVE for this run (R3). */
	sandbox?: boolean | undefined;
	/** Run-lifecycle timestamps (R1): dispatched_at (worker spawn) and the
	 *  main-session pre-dispatch token spend (task tool supplies received_at
	 *  + mainSessionTokens; completed_at is stamped by finalizeMetrics). */
	receivedAt?: string | undefined;
	dispatchedAt?: string | undefined;
	completedAt?: string | undefined;
	mainSessionTokens?: number | undefined;
	/** Aggregate files changed + added/removed line counts (R1). */
	filesChanged?: string[] | undefined;
	insertions: number;
	deletions: number;
	/** Supplied by finalizeMetrics (the run id + preserved session traces). */
	runId: string;
	sessionFiles: string[];
}): RunManifest {
	const split = splitPhases({
		turnUsage: opts.worker.turnUsage,
		reads: opts.worker.reads,
		swapTurn: opts.swapTurn,
		prewalkModel: opts.prewalkModel,
		executeModel: opts.executeModel,
		totalDurationMs: opts.workerDurationMs,
	});
	const review = opts.review
		? {
				model: opts.reviewModel,
				forked: true,
				context_inherited_tokens: contextInheritedTokens(opts.worker.turnUsage),
				findings: opts.review.result.findings.length,
				by_priority: countByPriority(opts.review.result.findings),
				cost_usd: opts.review.costUsd,
				personas: opts.review.personas,
			}
		: null;
	return buildRunManifest({
		runId: opts.runId,
		specMarkdown: opts.specMarkdown,
		requirements: opts.requirements,
		config: {
			prewalkModel: opts.prewalkModel,
			executeModel: opts.executeModel,
			reviewModel: opts.reviewModel,
			reviewForked: opts.reviewForked,
			shape: opts.shape?.name ?? "code",
			channel: opts.shape?.channel ?? "sync",
			...(opts.budget === undefined ? {} : { budget: opts.budget }),
			...(opts.sandbox === undefined ? {} : { sandbox: opts.sandbox }),
			...(opts.serviceTier === undefined
				? {}
				: { serviceTier: opts.serviceTier }),
		},
		phases: {
			prewalk: split.prewalk,
			execute: split.execute,
			verify: {
				passed: opts.verification.passed,
				commands: opts.verification.commands,
				duration_ms: opts.verification.duration_ms,
				source: "worker-tree",
				...(opts.verification.timed_out === undefined
					? {}
					: { timed_out: opts.verification.timed_out }),
				...(opts.suspectedSpecDefects?.length
					? { suspected_spec_defects: opts.suspectedSpecDefects }
					: {}),
				...(opts.disputes &&
				(opts.disputes.upheld.length > 0 || opts.disputes.rejected.length > 0)
					? { disputes: opts.disputes }
					: {}),
			},
			review,
			fixLoop: {
				iterations: opts.fixLoop.iterations,
				cost_usd: opts.fixLoop.costUsd,
			},
		},
		durationMs: opts.totalDurationMs,
		readDuplicationTokens: computeReadDuplication(
			opts.worker.reads,
			opts.swapTurn,
		).tokens,
		sessionFiles: opts.sessionFiles,
		...(opts.receivedAt === undefined ? {} : { receivedAt: opts.receivedAt }),
		...(opts.dispatchedAt === undefined
			? {}
			: { dispatchedAt: opts.dispatchedAt }),
		...(opts.completedAt === undefined
			? {}
			: { completedAt: opts.completedAt }),
		...(opts.mainSessionTokens === undefined
			? {}
			: { mainSessionTokens: opts.mainSessionTokens }),
		...(opts.filesChanged === undefined
			? {}
			: { filesChanged: opts.filesChanged }),
		insertions: opts.insertions,
		deletions: opts.deletions,
	});
}

/**
 * Finalize a run's metrics: preserve worker traces first (benchmark mode —
 * the manifest lists the saved paths), assemble the manifest, and persist it
 * when a metricsDir is configured. In-memory only otherwise.
 */
function finalizeMetrics(opts: {
	cwd: string;
	/** Optional AND nullable under exactOptionalPropertyTypes — call sites
	 *  forward their own `T | undefined` locals verbatim (R4 discipline). */
	project?: string | undefined;
	metricsDir?: string | undefined;
	preserveSessions?: boolean | undefined;
	runId?: string | undefined;
	worker: WorkerResult;
	assemble: Omit<
		Parameters<typeof assembleManifest>[0],
		"runId" | "sessionFiles" | "completedAt"
	>;
}): { manifest: RunManifest; manifestPath?: string | undefined } {
	const project = opts.project ?? deriveProjectName(opts.cwd);
	const runId = opts.runId ?? generateRunId();

	let savedSessions: string[] = [];
	if (opts.preserveSessions && opts.metricsDir && opts.worker.sessionFile) {
		savedSessions = copySessionTraces({
			metricsDir: opts.metricsDir,
			project,
			runId,
			sources: [opts.worker.sessionFile],
			prefix: "worker",
		});
	}

	// completed_at = the moment the run finishes: manifest assembly is the
	// last step before the result is returned (R1 wall-clock lifecycle).
	const manifest = assembleManifest({
		...opts.assemble,
		runId,
		sessionFiles: savedSessions,
		completedAt: new Date().toISOString(),
	});
	const manifestPath = opts.metricsDir
		? writeManifest(manifest, { metricsDir: opts.metricsDir, project })
		: undefined;
	return { manifest, manifestPath };
}

/** Render an aggregated Spec back to markdown (R6 — the manifest's spec
 *  for sub_specs mode: the union, not the raw concatenation of sub-specs). */
function renderSpecMarkdown(spec: Spec): string {
	return [
		`## Goal\n${spec.goal}`,
		`## Requirements\n${spec.requirements.join("\n")}`,
		`## Verification\n${spec.verification.join("\n")}`,
	].join("\n\n");
}

/**
 * Finalize a PARALLEL run's metrics: ONE aggregate RunManifest (R6), built
 * with the same machinery as the single path (buildRunManifest +
 * writeManifest when a metricsDir is set). AGGREGATE APPROXIMATION:
 * phases.execute SUMS per-worker usage/reads (aggregateExecutePhase) with
 * duration_ms = the parallel phase's WALL time (workers run concurrently —
 * summing worker durations would overstate it); prewalk and review are null
 * (parallel runs have no prewalk swap and no forked review) and fixLoop is
 * zero; read_duplication_tokens is 0 (no per-worker phase split); no
 * per-worker manifests. config mirrors the single path (budget, models,
 * review_forked false).
 */
function finalizeParallelMetrics(opts: {
	cwd: string;
	/** Optional AND nullable under exactOptionalPropertyTypes — the caller
	 *  forwards its own `T | undefined` locals verbatim (R4 discipline). */
	project?: string | undefined;
	metricsDir?: string | undefined;
	runId?: string | undefined;
	specMarkdown: string;
	requirements: number;
	prewalkModel: string;
	executeModel: string;
	reviewModel: string;
	budget?: string | undefined;
	/** Whether the worker sandbox was ACTIVE for this run (R3). */
	sandbox?: boolean | undefined;
	workers: WorkerResult[];
	parallelDurationMs: number;
	totalDurationMs: number;
	verification: VerificationResult;
	/** Run-lifecycle timestamps + main-session spend + diff stats (R1).
	 *  Optional AND nullable under exactOptionalPropertyTypes — the caller
	 *  forwards its own `T | undefined` locals verbatim (R4 discipline). */
	receivedAt?: string | undefined;
	dispatchedAt?: string | undefined;
	mainSessionTokens?: number | undefined;
	/** Aggregate files changed across the workers (R1). */
	filesChanged?: string[] | undefined;
	insertions: number;
	deletions: number;
	/** R1/R4/R5 parallel-merge record (atomic combine + union ladder +
	 *  overlap classification) — written into the manifest. */
	merge?: MergeMetrics | undefined;
	/** Spec-defect suspects (baseline-matched failures on the merged tree). */
	suspectedSpecDefects?: string[];
}): { manifest: RunManifest; manifestPath?: string | undefined } {
	const project = opts.project ?? deriveProjectName(opts.cwd);
	const manifest = buildRunManifest({
		runId: opts.runId ?? generateRunId(),
		specMarkdown: opts.specMarkdown,
		requirements: opts.requirements,
		config: {
			prewalkModel: opts.prewalkModel,
			executeModel: opts.executeModel,
			reviewModel: opts.reviewModel,
			reviewForked: false,
			...(opts.budget === undefined ? {} : { budget: opts.budget }),
			...(opts.sandbox === undefined ? {} : { sandbox: opts.sandbox }),
		},
		phases: {
			prewalk: null,
			execute: aggregateExecutePhase(
				opts.workers,
				opts.parallelDurationMs,
				opts.executeModel,
			),
			verify: {
				passed: opts.verification.passed,
				commands: opts.verification.commands,
				duration_ms: opts.verification.duration_ms,
				source: "union-gate",
				...(opts.verification.timed_out === undefined
					? {}
					: { timed_out: opts.verification.timed_out }),
				...(opts.suspectedSpecDefects?.length
					? { suspected_spec_defects: opts.suspectedSpecDefects }
					: {}),
			},
			review: null,
			fixLoop: { iterations: 0, cost_usd: 0 },
		},
		durationMs: opts.totalDurationMs,
		readDuplicationTokens: 0,
		...(opts.receivedAt === undefined ? {} : { receivedAt: opts.receivedAt }),
		...(opts.dispatchedAt === undefined
			? {}
			: { dispatchedAt: opts.dispatchedAt }),
		completedAt: new Date().toISOString(),
		...(opts.mainSessionTokens === undefined
			? {}
			: { mainSessionTokens: opts.mainSessionTokens }),
		...(opts.filesChanged === undefined
			? {}
			: { filesChanged: opts.filesChanged }),
		insertions: opts.insertions,
		deletions: opts.deletions,
		...(opts.merge === undefined ? {} : { merge: opts.merge }),
	});
	const manifestPath = opts.metricsDir
		? writeManifest(manifest, { metricsDir: opts.metricsDir, project })
		: undefined;
	return { manifest, manifestPath };
}

// ─── Orchestrator ────────────────────────────────────────────────────

export async function executeTask(
	opts: ExecuteTaskOptions,
): Promise<TaskResult> {
	const {
		cwd,
		model,
		systemPrompt,
		signal,
		verificationTimeoutMs,
		onUpdate,
		onSwap,
	} = opts;
	// R2: the merge-failure artifact targets <metricsDir>/<project>/; resolved
	// once here (the parallel path's worker-failure + merge-failure writes
	// both use these).
	const metricsDir = opts.metricsDir;
	const project = opts.project ?? deriveProjectName(cwd);
	const budget = opts.budget;
	const parallel = opts.parallel ?? 1;
	const subSpecs =
		opts.subSpecs && opts.subSpecs.length > 0 ? opts.subSpecs : undefined;

	// R1/R2: the orchestrator commits task work into (single path) or squashes
	// workspace commits under (parallel path) the main working copy — user
	// work-in-progress would be silently bundled into task commits. Fail fast
	// FIRST, before spec parsing, map build, workspace creation, or worker
	// spawn (both paths). The gate is legacy-tolerant: strays from PAST
	// failed runs (engine stubs, undescribed AI snapshots) are classified
	// and cleaned in one pass; rescue commits are ignorable history; the
	// user's OWN uncommitted work still blocks via the strict check inside.
	const strayReport = await ensureDispatchableTree({
		cwd,
		// Same resolution the run's own identity block below uses — the
		// provenance test for "authored by this engine" must match what the
		// engine actually authors with.
		aiAuthorEmail:
			opts.aiAuthorEmail ?? DEFAULT_TASK_CONFIG.defaults.aiAuthorEmail,
	});
	if (strayReport.cleaned.length > 0 || strayReport.preserved.length > 0) {
		opts.onStrays?.(strayReport);
	}

	if (!opts.spec && !subSpecs) {
		throw new Error('executeTask: "spec" (or "subSpecs") is required');
	}

	// 1. Validate spec (code, not LLM). In sub_specs mode every sub-spec is
	// parsed independently (each must be self-contained) and aggregated; the
	// aggregate's verification (the union) is the single post-merge gate.
	const specMarkdown = subSpecs ? subSpecs.join("\n\n") : opts.spec!;
	const spec = subSpecs ? aggregateSubSpecs(subSpecs) : parseSpec(specMarkdown);

	// 2. Resolve the run-pipeline SHAPE + the effective models. The shape
	//    (code | analysis | any [shapes.*] section) declares the phase
	//    structure, swap policy, model slots, and review axes — separated
	//    from the budget tier (which picks the models). `analysis` promotes
	//    the strong prewalk model into the writer/review slots (no swap):
	//    surveys/design reviews get the deep thinker writing, not planning.
	const shape = opts.shape ?? DEFAULT_SHAPE;
	const executeModel =
		shape.workModel === "prewalk"
			? (opts.prewalkModel ?? opts.executeModel ?? model)
			: (opts.executeModel ?? model);
	const usePrewalk =
		shape.prewalk &&
		opts.prewalkModel !== undefined &&
		isPrewalkActive(opts.prewalkModel, executeModel) &&
		spec.requirements.length >=
			(opts.prewalkMinRequirements ?? DEFAULT_PREWALK_MIN_REQUIREMENTS);
	const reviewModel =
		shape.reviewModel === "prewalk"
			? (opts.prewalkModel ?? opts.reviewModel ?? executeModel)
			: (opts.reviewModel ?? executeModel);
	// Review forks only when the shape declares review axes: the declared
	// axes are the precondition for the tier's review flag and the persona
	// override alike. An axis-less shape (analysis: a survey/review is a
	// single task, the worker IS the review) never forks a nested reviewer,
	// even when an explicit persona or `review: true` is passed — the
	// request surfaces as reviewSkipped on the result instead.
	const reviewGate = resolveReviewGate(opts, shape);

	// 2a. AI commit identity (todo #84): resolve once per run — worker
	// commits (single + fix workers) and the parallel merge target are
	// authored as the AI, never as the user. "{model}" in the name resolves
	// to the execute model's short name.
	const aiName = formatAiAuthorName(
		opts.aiAuthorName ?? DEFAULT_TASK_CONFIG.defaults.aiAuthorName,
		executeModel,
	);
	const aiEmail =
		opts.aiAuthorEmail ?? DEFAULT_TASK_CONFIG.defaults.aiAuthorEmail;

	// 2b. Batch channel routing (M2): a shape on the batch channel runs the
	// spec as an ASYNC batch job — one typed single-turn prompt per
	// requirement (batch.ts buildBatchItems), polled to completion,
	// outputs validated against their contracts and applied as files; no
	// interactive worker, no tool loop, no workspace model. parallel /
	// sub_specs on the batch channel are a configuration error
	// (routeRun → invalid). Review is single-turn-incompatible: silently
	// skipped (reviewSkipped on the result — same contract as parallel).
	const route = routeRun(shape, {
		parallel,
		hasSubSpecs: subSpecs !== undefined,
	});
	if (route.kind === "invalid") {
		throw new Error(`executeTask: ${route.reason}`);
	}
	if (route.kind === "batch") {
		return executeBatchLane(cwd, {
			spec,
			specMarkdown,
			runId: opts.runId,
			// Mirror the parallel path: a REQUESTED review (opts.review or an
			// explicit persona) is reported as skipped — the batch lane is
			// single-turn and cannot fork a reviewer session.
			reviewRequested: reviewGate.requested,
			metricsDir,
			project,
			budget,
			signal,
			onUpdate,
			verificationTimeoutMs: opts.verificationTimeoutMs,
			aiAuthorName: aiName,
			aiAuthorEmail: aiEmail,
			...(opts.receivedAt === undefined ? {} : { receivedAt: opts.receivedAt }),
			...(opts.mainSessionTokens === undefined
				? {}
				: { mainSessionTokens: opts.mainSessionTokens }),
			batch: opts.batch,
			batchProvider: opts.batchProvider,
		});
	}

	// Verification lifecycle (interactive routes): dry-run the gate on the
	// UNTOUCHED tree — zero model tokens. Broken commands throw here (the
	// dispatch is rejected before any worker spawns); the recorded baseline
	// lets executeSingle adjudicate spec defects by evidence instead of
	// spending fix iterations on unsatisfiable gates.
	const verificationBaseline = await captureVerificationBaseline(
		spec.verification,
		cwd,
		opts.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS,
		signal,
	);

	// 2c. Resolve the worker sandbox (R1): the option omitted → the built-in
	// defaults (same shape as loadTaskConfig with no task.toml file).
	// Availability is probed ONCE for the whole run with a real
	// user-namespace-exercising call (probeBwrapAvailability); a
	// requested-but-unavailable sandbox degrades to plain spawns with ONE
	// actionable warning — a genuine failure, not expected-condition noise
	// (console discipline). Every worker spawn of the run shares this
	// resolution.
	const sandbox = resolveSandbox(opts.sandbox);
	if (sandbox.config.enabled && !sandbox.active) {
		console.warn(
			"task: worker sandbox unavailable — the bwrap probe failed (missing bwrap, non-Linux host, or user namespaces disabled); workers run WITHOUT sandboxing for this task",
		);
	}

	// 3. Build/load the codebase map and inject a relevance-sliced view into
	// the task prompt (turns cold-start exploration into targeted reads).
	// Built ONCE here on the main repo, before any workspace is created:
	// the tree hash is the task base, and every worker reuses the same slice
	// (parallel workers must not each build their own map — that would be
	// N duplicate annotation calls). Degrades gracefully: any map failure
	// just means no map section.
	// Mode/model come from config/repo-map.toml, overridable per call.
	const mapConfig = loadRepoMapConfig();
	const injectMap =
		opts.useMap !== undefined ? opts.useMap : mapConfig.injectWorkers;
	let mapPrompt: string | null = null;
	if (injectMap) {
		try {
			const map = await buildMap(cwd, {
				mode: opts.mapMode ?? mapConfig.mode,
				model: opts.mapModel ?? mapConfig.annotationModel ?? executeModel,
			});
			const relevant = sliceRelevant(map, specMarkdown, mapConfig.sliceLimit);
			if (relevant.length > 0 || map.entryPoints.length > 0) {
				mapPrompt = formatMapPrompt(map, relevant);
			}
		} catch {
			// todo #73: a map failure must not write to the process console
			// (it would leak into the user's prompt box). The run continues
			// without the map — the degradation is silent by design, and the
			// next invocation retries the build. buildMap already degrades
			// internally to a skeleton map on annotation errors, so this only
			// catches environmental failures (e.g. not a git repo).
		}
	}
	const promptFor = (body: string): string =>
		mapPrompt ? mapPrompt + "\n\n" + body : body;

	if (parallel <= 1 && !subSpecs) {
		return executeSingle(cwd, {
			taskPrompt: promptFor(specMarkdown),
			usePrewalk,
			checklist: opts.checklist,
			prewalkModel: opts.prewalkModel,
			executeModel,
			systemPrompt,
			signal,
			onSwap,
			onUpdate,
			verificationTimeoutMs,
			workerTimeoutMs: opts.workerTimeoutMs,
			toolTimeoutMs: opts.toolTimeoutMs,
			reviewWallTimeoutMs: opts.reviewWallTimeoutMs,
			...(opts.serviceTier === undefined
				? {}
				: { serviceTier: opts.serviceTier }),
			...(opts.providerOnly === undefined
				? {}
				: { providerOnly: opts.providerOnly }),
			verificationBaseline,
			...(opts.turnBudget === undefined ? {} : { turnBudget: opts.turnBudget }),
			spec,
			specMarkdown,
			reviewRequested: reviewGate.requested,
			review: reviewGate.enabled,
			reviewModel,
			...(opts.persona === undefined ? {} : { persona: opts.persona }),
			shape,
			maxFixIterations: opts.maxFixIterations,
			budget: opts.budget,
			metricsDir: opts.metricsDir,
			project: opts.project,
			preserveSessions: opts.preserveSessions,
			sandbox,
			aiAuthorName: aiName,
			aiAuthorEmail: aiEmail,
			// R1: the task tool records these when its execute starts (received_at
			// + the main session's pre-dispatch token spend); direct callers may
			// omit them (manifest fields then absent/zero).
			...(opts.receivedAt === undefined ? {} : { receivedAt: opts.receivedAt }),
			...(opts.mainSessionTokens === undefined
				? {}
				: { mainSessionTokens: opts.mainSessionTokens }),
			runId: opts.runId,
		});
	}

	// Review is single-worker in Phase 7 (the fix loop operates on one working
	// copy). A parallel review request is ignored — silently (todo #73: no
	// console output; the dispatch plan already omits the review phase and
	// the result carries reviewSkipped so the agent stays informed).

	// ─── Parallel path (Phase 6) ─────────────────────────────────────
	// Each worker runs in an isolated jj workspace rooted at the task
	// base; afterwards every workspace's commits are combined into the
	// base in ONE jj operation (mergeWorkspacesAtomic, R1), textual
	// conflicts resolve deterministically via the union ladder (R4), and
	// the workspaces are removed only after the consistency gate (R3)
	// and verification pass. On merge failure the workspaces are NEVER
	// forgotten (R2) — the merge-failure artifact records them.

	const runStartMs = Date.now();
	// R1: the pre-run task base commit id (@- of the main working copy —
	// captured BEFORE the AI base/workspace creation, read-only, no snapshot
	// op with --ignore-working-copy). The run's diff stats are the range
	// taskBaseCommitId..final-@- (the merged base at finalize time), which
	// covers every worker's commits in both identity modes (the AI base is
	// empty and contributes nothing).
	const taskBaseCommitId = await headCommitId(cwd, "@-");
	// R2: the DISPATCH base the workspaces branch from — the AI task base's
	// parent in identity mode (createWorkspace parents each workspace's @ on
	// the default workspace's @-, the pre-task head), or the pre-task head
	// itself without an AI base. Captured BEFORE any commit is created so
	// the failure-path post-mortem can isolate each workspace's OWN chain.
	const parallelDispatchBaseChangeId = await taskBaseChangeId(cwd);

	// Worker count: sub_specs mode spawns exactly one worker per sub-spec
	// (caller-controlled, no clamp — every sub-spec is validated to have at
	// least one requirement). The mechanical fallback clamps parallel to the
	// requirement count: round-robin splitting can't give every worker at
	// least one requirement beyond that.
	const workerCount = subSpecs
		? subSpecs.length
		: Math.min(parallel, spec.requirements.length);
	// The parallel merge target (todo #84): a fresh AI-authored commit unless
	// the identity is empty (direct callers without the config). The identity
	// config file lives in a temp dir (orchestrator-side, not sandboxed);
	// removed in the finally below.
	let identityDir: string | null = null;
	let identityFile: string | null = null;
	const baseChangeId = await (async () => {
		if (aiName.trim().length === 0 || aiEmail.trim().length === 0) {
			return taskBaseChangeId(cwd);
		}
		// jj squash keeps the DESTINATION commit's author, so squashing into
		// @- would attribute the merged AI work to the user. createAiTaskBase
		// makes the new @ an AI-authored empty commit on @- (described with
		// the spec goal); the workspaces' work squashes into it.
		identityDir = mkdtempSync(join(tmpdir(), "pi-task-identity-"));
		identityFile = join(identityDir, "jj-identity.toml");
		writeFileSync(identityFile, aiIdentityToml(aiName, aiEmail), "utf-8");
		return createAiTaskBase(cwd, identityFile, spec.goal);
	})();

	const runSuffix = Date.now().toString(36).slice(-4);
	const workspaces: Array<{ name: string; dir: string }> = [];
	for (let i = 0; i < workerCount; i++) {
		const name = `pi-task-${runSuffix}-${i}`;
		const dir = await createWorkspace(cwd, name);
		workspaces.push({ name, dir });
		onUpdate?.({ type: "workspace_created", index: i, dir });
	}

	// Per-worker task prompts: the caller's encapsulated sub-specs when given
	// (each worker sees ONLY its own sub-spec — no shared goal to leak scope),
	// otherwise the mechanical round-robin split under the Scope contract.
	const workerTasks = subSpecs ?? splitSpec(spec, workerCount);
	// A: dispatch-time worker context — each worker's goal + file-scope
	// hints, extracted mechanically from its spec markdown (parseSpec +
	// extractFileScope; zero LLM). The widget renders it so the user sees
	// WHAT each worker is doing, not just that it is working.
	onUpdate?.({
		type: "worker_meta",
		metas: workerTasks.map((t) => {
			try {
				return { goal: parseSpec(t).goal, scope: extractFileScope(t) };
			} catch {
				return { goal: "", scope: [] };
			}
		}),
	});
	let doneCount = 0;
	// R6: the parallel phase's WALL time — workers run concurrently, so this
	// is the manifest's phases.execute.duration_ms (not the sum of workers).
	const parallelStartMs = Date.now();
	// R1: dispatched_at — the moment the parallel workers' sessions spawn
	// (the wall-clock lifecycle stamp; the manifest's completed_at is set by
	// finalizeParallelMetrics).
	const dispatchedAt = new Date().toISOString();
	const sessions = workspaces.map((ws, i) =>
		spawnWorkerSessionResilient({
			cwd: ws.dir,
			noProgressTimeoutMs: channelWatchdogWindows(
				(shape ?? DEFAULT_SHAPE).channel,
			).noProgressMs,
			// Todo #89: the workspace differs from the project root — the
			// sandbox must bind the shared jj store rw or workspace commits
			// fail with EROFS.
			projectDir: cwd,
			model: usePrewalk ? opts.prewalkModel! : executeModel,
			...(opts.serviceTier === undefined
				? {}
				: { serviceTier: opts.serviceTier }),
			...(opts.serviceTier || opts.providerOnly?.length
				? { serviceTierExcludes: [executeModel] }
				: {}),
			...(opts.providerOnly === undefined
				? {}
				: { providerOnly: opts.providerOnly }),
			...(opts.runId === undefined ? {} : { sessionId: opts.runId }),
			task:
				// workerTasks.length === workerCount (splitSpec / subSpecs) and
				// i < workerCount, so the entry is always present (guard only
				// narrows noUncheckedIndexedAccess).
				promptFor(workerTasks[i]!),
			systemPrompt:
				systemPrompt ?? buildWorkerSystemPrompt(opts.checklist !== false),
			extensions: [
				...(opts.checklist !== false ? [CHECKLIST_EXTENSION_PATH] : []),
				...(usePrewalk ? [PREWALK_EXTENSION_PATH] : []),
			],
			...(signal === undefined ? {} : { signal }),
			sandbox,
			aiAuthorName: aiName,
			aiAuthorEmail: aiEmail,
			onUpdate: (partial) => {
				onUpdate?.({ ...partial, index: i });
				if (partial.type === "yield") {
					onUpdate?.({
						type: "workers_progress",
						done: ++doneCount,
						total: workerCount,
					});
				}
			},
			// Phase 11 (R4/R5): per-tier wall + per-tool-call budget. The
			// verification commands + grace: the wall must not kill an
			// in-flight suite run — it gets a bounded grace instead.
			...(opts.workerTimeoutMs === undefined
				? {}
				: { timeoutMs: opts.workerTimeoutMs }),
			...(opts.toolTimeoutMs === undefined
				? {}
				: { toolTimeoutMs: opts.toolTimeoutMs }),
			verificationCommands: spec.verification,
			...(opts.verificationTimeoutMs === undefined
				? {}
				: { verificationTimeoutMs: opts.verificationTimeoutMs }),
		}),
	);
	// R6: a failed model swap aborts its session and surfaces as a precise
	// run failure — the generic parallel failure message would hide it.
	const swapErrors: Error[] = [];
	const prewalkCtrls = usePrewalk
		? sessions.map((s) =>
				attachPrewalk(s, {
					prewalkModel: opts.prewalkModel!,
					executeModel,
					...(onSwap === undefined ? {} : { onSwap }),
					onError: (err) => {
						swapErrors.push(err);
						s.abort();
					},
				}),
			)
		: [];
	// Checklist relay (R4): carries each worker's real checklist state to the
	// progress view through the same raw event stream the prewalk listener
	// uses — observer-only (zero LLM tokens), worker-side semantics unchanged.
	const checklistCtrls = sessions.map((s, i) =>
		attachChecklistRelay(s, {
			onChecklist: (c) =>
				onUpdate?.({
					type: "checklist",
					index: i,
					done: c.done,
					total: c.total,
				}),
		}),
	);

	let results: WorkerResult[] = [];
	// R2: failure state — set when the worker-failure path or the MERGE path
	// throws. The finally block then PRESERVES the worker workspaces so
	// recovery is scripted from the failure artifact instead of
	// LLM-discovered.
	let mergeFailed: Error | null = null;
	// R1: set when the atomic combine actually landed — the finally only
	// creates the fresh working-copy stub (`jj new` identity restore) when a
	// merge landed; on a no-merge failure the stub (description-less — jj
	// refuses to push description-less commits) must not appear in the
	// user's ancestry.
	let mergeLanded = false;
	// R2: indexes of the workers that aborted finalization-incomplete — the
	// run proceeds to the merge + union verification gate instead of failing
	// flat; the result carries a caveat when the gate passes.
	let finalizationIncompleteIndexes: number[] = [];
	// The union verification gate (R2): declared here so the failure path
	// can consult it and the post-finally success path can report it — it
	// runs INSIDE the try so a finalization-incomplete gate failure can
	// preserve the workspaces.
	let verification!: VerificationResult;
	const parallelSuspects: string[] = [];
	// R1/R4/R5: merge metrics for the aggregate manifest (atomic combine,
	// union resolution, overlap classification).
	const mergeMetrics: MergeMetrics = {
		resolved_union: [],
		conflicts: [],
		overlaps: [],
		worker_count: workerCount,
	};
	// Workspace @ commit ids captured BEFORE the atomic combine — the
	// dangling ids when the merge fails (R2).
	const workspaceAtIds = new Map<string, string>();
	try {
		// Await all yields concurrently (each session streams its own turns)
		const settled = await Promise.allSettled(sessions.map((s) => s.result));
		// A failed model swap (R6) takes precedence over the generic failure
		// aggregation — surface the precise error.
		const swapError = swapErrors[0];
		if (swapError) throw swapError;
		const failures = settled.filter(
			(r): r is PromiseRejectedResult => r.status === "rejected",
		);
		if (failures.length > 0) {
			const message = `Parallel workers failed: ${failures.map((f) => (f.reason as Error).message).join("; ")}`;
			// R2 (third outcome): classify each failed worker from its
			// checklist relay — finalization-incomplete means ALL requirements
			// were done at abort (the worker committed everything and was
			// verifying/yielding). When EVERY failed worker is
			// finalization-incomplete, the committed work is complete: proceed
			// to the merge path below and let the union verification gate
			// decide (pass → success-with-caveat; fail → the failure path with
			// preserved workspaces). Never merge or claim success without the
			// gate.
			const failedProgresses = settled
				.map((r, i) =>
					// sessions/checklistCtrls share the worker index; only
					// rejected entries consult the relay (guard narrows the
					// noUncheckedIndexedAccess index).
					r.status === "rejected" ? (checklistCtrls[i]!.latest ?? null) : null,
				)
				.filter((p): p is ChecklistProgress => p !== null);
			if (classifyWorkerFailures(failedProgresses) === "merge") {
				finalizationIncompleteIndexes = settled
					.map((r, i) => (r.status === "rejected" ? i : -1))
					.filter((i) => i >= 0);
			} else {
				// Flat worker-failure path: the engine performs the
				// full post-mortem itself (parallelRunPostMortem): each workspace's
				// dirty tail is rescued/described, every workspace's commits are
				// stacked onto the dispatch base, engine-authored empty stubs are
				// abandoned, and the workspaces are forgotten — the artifact then
				// carries the machine-readable recovery result instead of leaving
				// scripted manual recovery. Best effort + bounded
				// (FAILURE_PATH_JJ_TIMEOUT_MS): a wedged repo degrades toward
				// preservation and never masks the original failure.
				mergeFailed = new Error(message);
				const wsRecords: MergeFailureInfo["workspaces"] = [];
				for (const ws of workspaces) {
					let at = "";
					try {
						at = await workspaceCommitId(cwd, ws.name, {
							timeoutMs: FAILURE_PATH_JJ_TIMEOUT_MS,
						});
					} catch {
						/* best effort */
					}
					const rescueId = await rescueWorkspaceStateBestEffort(
						ws.dir,
						message,
						{
							timeoutMs: FAILURE_PATH_JJ_TIMEOUT_MS,
						},
					);
					wsRecords.push({
						name: ws.name,
						commit_id: rescueId ?? at,
						...(rescueId ? { rescue_commit_id: rescueId } : {}),
					});
				}
				// The post-mortem needs the AI identity for the provenance test
				// (ONLY provably engine-authored empties are abandoned); without
				// it nothing is deleted — pure preservation.
				const parallelRecovery = await parallelRunPostMortem({
					projectDir: cwd,
					workspaceNames: workspaces.map((w) => w.name),
					baseChangeId,
					dispatchBaseChangeId: parallelDispatchBaseChangeId,
					cause: message,
					...(aiEmail.trim().length === 0 ? {} : { aiAuthorEmail: aiEmail }),
					workspaceDirs: Object.fromEntries(
						workspaces.map((w) => [w.name, w.dir]),
					),
				});
				writeMergeFailureArtifact({
					cause: message,
					workspaces: wsRecords,
					danglingCommitIds: [],
					conflictedFiles: [],
					metricsDir,
					runId: opts.runId,
					project,
					specMarkdown,
					tier: budget,
					parallelRecovery,
				});
				throw new Error(message);
			}
		}
		results = (settled as PromiseFulfilledResult<WorkerResult>[]).map(
			(r) => r.value,
		);

		// ── Merge path (R1/R2/R3/R4/R5) — a failure here never forgets the
		// workspaces (R2): the artifact records names + dangling ids, the
		// finally block keeps the workspaces alive for scripted recovery.
		try {
			// R5: pre-merge overlap classification — per-worker changed-file
			// sets; comment/whitespace-only overlaps take the deterministic
			// union path (R4), substantive overlaps are flagged in the merge
			// report BEFORE merging. Also collects the union of added/modified
			// files for the R3 consistency gate.
			const expectedFiles = new Set<string>();
			const fileWorkers = new Map<string, string[]>();
			for (let i = 0; i < workerCount; i++) {
				// workspaces has exactly workerCount entries (built above) —
				// the guard only narrows noUncheckedIndexedAccess.
				const name = workspaces[i]!.name;
				const changes = await workspaceFileChanges(cwd, baseChangeId, name);
				for (const c of changes) {
					if (c.kind !== "D") expectedFiles.add(c.file);
					const list = fileWorkers.get(c.file) ?? [];
					list.push(name);
					fileWorkers.set(c.file, list);
				}
			}
			const overlaps: FileOverlap[] = [];
			for (const [file, names] of fileWorkers) {
				if (names.length < 2) continue;
				const diffs: string[] = [];
				for (const name of names)
					diffs.push(await diffForWorkspacePath(cwd, baseChangeId, name, file));
				overlaps.push({
					file,
					workers: names,
					kind: classifyOverlapDiffs(diffs),
				});
			}
			mergeMetrics.overlaps = overlaps.map((o) => ({
				file: o.file,
				kind: o.kind,
			}));
			onUpdate?.({ type: "merge_report", overlaps });

			// R1: ATOMIC combine — every workspace's commits land in the task
			// base in ONE jj operation (a single squash of all workspace
			// ranges; no incremental per-workspace squash into a moving base —
			// the mid-loop partial-merge failure class cannot occur).
			for (const ws of workspaces) {
				workspaceAtIds.set(ws.name, await workspaceCommitId(cwd, ws.name));
			}
			const mergeOutcome = await mergeWorkspacesAtomic(
				cwd,
				workspaces.map((w) => w.name),
				baseChangeId,
			);
			// R1: the atomic combine LANDED — the finally may now create the
			// fresh working-copy stub (identity restore).
			mergeLanded = true;
			mergeMetrics.merged_commit_id = mergeOutcome.commit_id;
			mergeMetrics.files_changed = mergeOutcome.files_changed;
			onUpdate?.({
				type: "merge",
				conflicts: mergeOutcome.conflicts,
				commit_id: mergeOutcome.commit_id,
				files_changed: mergeOutcome.files_changed,
			});

			// R3: post-merge consistency gate — every workspace's @ reachable
			// from the merged result, merged tree non-empty, union of worker
			// file changes present. Fail → merge-failure artifact + run failure
			// (never a false success). Runs BEFORE cleanup (the gate needs the
			// workspaces alive) and BEFORE verification (which then provably
			// runs on the merged tree).
			try {
				await assertMerged(
					cwd,
					workspaces.map((w) => w.name),
					baseChangeId,
					{
						expectedFiles: [...expectedFiles],
					},
				);
				// The merged base must remain a VISIBLE commit: a stale-target
				// squash can hide the whole base chain, which assertMerged's
				// re-resolution would surface only as a raw jj error (a hidden
				// change resolves to the 40-zero commit id).
				await assertVisibleCommit(cwd, baseChangeId);
			} catch (err) {
				throw new Error(
					`Parallel merge consistency check failed: ${(err as Error).message}`,
				);
			}

			// R4: deterministic conflict ladder — rung 1 (jj 3-way merge) ran
			// inside the squash; rung 2 resolves every remaining conflicted
			// file with the jj-native "union" merge tool (git merge-file
			// --union). No markers remain → accept and record resolved:"union"
			// (manifest). Only files that STILL carry markers escalate
			// (LLM/manual) — with just the conflicted hunks (artifact +
			// result); the verification gate below always validates the final
			// tree.
			const conflictsBeforeUnion = await detectChangeConflicts(
				cwd,
				baseChangeId,
			);
			if (conflictsBeforeUnion.length > 0) {
				await resolveConflictsWithUnion(
					cwd,
					baseChangeId,
					conflictsBeforeUnion,
				);
				const conflictsAfterUnion = await detectChangeConflicts(
					cwd,
					baseChangeId,
				);
				mergeMetrics.resolved_union = conflictsBeforeUnion.filter(
					(f) => !conflictsAfterUnion.includes(f),
				);
				mergeMetrics.conflicts = conflictsAfterUnion;
				if (conflictsAfterUnion.length > 0) {
					// Escalate: the union ladder is exhausted. The merge-failure
					// artifact records the conflicted files + hunks (recovery is
					// scripted); the run reports failure below (success=false).
					// Nothing dangles — the atomic combine already landed every
					// worker commit in the base.
					writeMergeFailureArtifact({
						cause:
							`merge conflicts remain after the deterministic union ladder ` +
							`(${conflictsAfterUnion.length} file(s))`,
						runId: opts.runId,
						workspaces: workspaces.map((w) => ({
							name: w.name,
							commit_id: workspaceAtIds.get(w.name) ?? "",
						})),
						danglingCommitIds: [],
						conflictedFiles: conflictsAfterUnion,
						conflictHunks: await conflictHunks(
							cwd,
							baseChangeId,
							conflictsAfterUnion,
						),
						metricsDir,
						project,
						specMarkdown,
						tier: budget,
					});
					onUpdate?.({ type: "merge_conflicts", files: conflictsAfterUnion });
				}
			}
		} catch (err) {
			// R2: merge failure — write the merge-failure artifact (workspace
			// names, dangling commit ids, conflicted files) BEFORE rethrowing,
			// so recovery is scripted rather than LLM-discovered. The finally
			// block below preserves the workspaces (never forgotten).
			const cause = err instanceof Error ? err.message : String(err);
			mergeFailed = err instanceof Error ? err : new Error(cause);
			writeMergeFailureArtifact({
				cause,
				workspaces: workspaces.map((w) => ({
					name: w.name,
					commit_id: workspaceAtIds.get(w.name) ?? "",
				})),
				danglingCommitIds: [...workspaceAtIds.values()].filter(
					(id) => id.length > 0,
				),
				runId: opts.runId,
				conflictedFiles: [],
				metricsDir,
				project,
				specMarkdown,
				tier: budget,
			});
			throw err;
		}

		// 6. Verification (bash hard gate, zero tokens) — once, after the
		// merge and after the deterministic union ladder, on the final tree.
		// assertMerged ran above (before cleanup), so the main working copy
		// provably sits on the merged base holding every worker's changes;
		// escalated conflicts (markers still present after the union tool),
		// if any, are visible here as conflict markers. The gate always
		// validates the final tree — a finalization-incomplete recovery
		// never merges or claims success without it. SKIPPED when escalated
		// conflicts remain after the union ladder: the gate on a conflicted
		// tree is meaningless (its "verified" output misleads) — the run
		// fails fast on the conflicts, already artifacted above.
		if (mergeMetrics.conflicts.length > 0) {
			verification = {
				passed: false,
				commands: 0,
				duration_ms: 0,
				failures: [],
			};
		} else {
			verification = await runVerification(
				spec.verification,
				cwd,
				verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS,
				signal,
			);
			// Baseline adjudication on the merged tree: failures identical to
			// the pre-change baseline are suspected spec defects — recorded in
			// the manifest/result (the parallel path has no fix loop).
			for (const f of classifyVerificationFailures(
				verification.failures,
				verificationBaseline,
			).specDefectSuspected) {
				if (!parallelSuspects.includes(f.command))
					parallelSuspects.push(f.command);
			}
		}
		if (
			mergeMetrics.conflicts.length === 0 &&
			!verification.passed &&
			finalizationIncompleteIndexes.length > 0
		) {
			// R2: the gate FAILS a finalization-incomplete recovery → the
			// current failure path with preserved workspaces: failure artifact
			// (the recovery guide travels with it) + throw, so the finally
			// below keeps the workspaces alive for scripted recovery. The
			// merged base — which holds every worker's commits — is named in
			// the cause.
			const cause =
				`parallel run failed verification after merging finalization-incomplete ` +
				`worker(s) ${finalizationIncompleteIndexes.map((i) => `#${i}`).join(", ")} ` +
				`into ${mergeMetrics.merged_commit_id ?? "?"}: ` +
				verification.failures
					.map((f) => `${f.command} (exit ${f.exitCode})`)
					.join("; ");
			mergeFailed = new Error(cause);
			writeMergeFailureArtifact({
				cause,
				workspaces: workspaces.map((w) => ({
					name: w.name,
					commit_id: workspaceAtIds.get(w.name) ?? "",
				})),
				danglingCommitIds: [],
				runId: opts.runId,
				conflictedFiles: mergeMetrics.conflicts,
				metricsDir,
				project,
				specMarkdown,
				tier: budget,
			});
			throw mergeFailed;
		}
	} finally {
		// R2: on merge failure OR worker failure the worker workspaces are
		// NEVER forgotten — recovery is scripted from the failure artifact
		// (workspace names + commit ids). On success (or a model-swap error,
		// which aborts before any real work) cleanup runs as before.
		if (mergeFailed) {
			console.warn(
				`task: parallel run failed — worker workspaces PRESERVED for recovery: ` +
					`${workspaces.map((w) => w.name).join(", ")} ` +
					"(see the failure artifact in <metricsDir>/<project>/ — its recovery guide stacks the " +
					"workspaces and clears description-less stubs before pushing)",
			);
		} else {
			for (const ws of workspaces) {
				try {
					await removeWorkspace(cwd, ws.name, ws.dir);
				} catch (err) {
					console.warn(
						`workspace cleanup "${ws.name}": ${(err as Error).message}`,
					);
				}
			}
		}
		const parents = new Set(workspaces.map((w) => dirname(w.dir)));
		for (const parent of parents)
			rmSync(parent, { recursive: true, force: true });
		prewalkCtrls.forEach((c) => c.detach());
		checklistCtrls.forEach((c) => c.detach());
		// The AI-authored merge target became @ during the run (todo #84);
		// restore the main working copy to an empty commit on top of it so
		// the run's result commit is @- — the same invariant as the
		// single-worker path. R1: the stub is created ONLY when a merge
		// actually landed (mergeLanded) — on a no-merge failure (worker
		// failure before the merge path) it would be a description-less
		// commit, which jj refuses to push; whatever remains in the ancestry
		// (the AI-authored task base, described with the spec goal) must
		// carry a description instead. Best effort: a failure here must not
		// mask the run's outcome.
		await restoreParallelWorkingCopy(cwd, { identityDir, mergeLanded });
	}

	// 6. Verification ran INSIDE the try above (the gate must run before the
	// finally's workspace cleanup so a finalization-incomplete gate failure
	// can preserve the workspaces); `verification` holds its result.

	// R3/R4: the final conflict state comes from the ladder's post-union
	// detection (the authoritative final-tree check — per-squash conflict
	// states are stale; the union tool rewrote the base, so the state is
	// re-detected after it). Nothing changes the base tree between the
	// ladder and here, so this is the final state.
	const conflicts = mergeMetrics.conflicts;
	// The merged base's commit id resolved AFTER the atomic combine and the
	// union ladder (both rewrite the base commit). The workers' pre-squash
	// commit ids were abandoned by the single `jj squash` — pointing
	// TaskResult.commits at them would return dead revisions. Same
	// change-id→commit-id resolution workspace.ts does everywhere.
	const baseCommitId = await resolveCommitId(cwd, baseChangeId);

	// R6: parallel runs produce ONE aggregate RunManifest (no per-worker
	// manifests — aggregate approximation, documented in finalizeParallelMetrics).
	// R1: diff stats over taskBaseCommitId..final-@- (the merged base) — best
	// effort (a metrics jj failure must not fail an otherwise-green run).
	const diffStat = await computeDiffStatBestEffort(cwd, taskBaseCommitId);
	// R2: on the finalization-incomplete path some/all workers never yielded —
	// their files live in the merged base; derive the aggregate from the
	// merged delta instead of the (partial) yield payloads.
	const filesChanged =
		finalizationIncompleteIndexes.length > 0
			? await filesChangedBetweenBestEffort(cwd, taskBaseCommitId, baseCommitId)
			: results.flatMap((r) => r.yield.files_changed);
	const metrics = finalizeParallelMetrics({
		suspectedSpecDefects: parallelSuspects,
		cwd,
		...(opts.project === undefined ? {} : { project: opts.project }),
		...(opts.metricsDir === undefined ? {} : { metricsDir: opts.metricsDir }),
		// Detached dispatch: the manifest must land under the caller's id.
		runId: opts.runId,
		// sub_specs mode: the AGGREGATE spec's markdown (the union, rendered
		// as one spec); the mechanical fallback: the original spec markdown.
		specMarkdown: subSpecs ? renderSpecMarkdown(spec) : specMarkdown,
		requirements: spec.requirements.length,
		prewalkModel: usePrewalk ? opts.prewalkModel! : executeModel,
		executeModel,
		reviewModel: opts.reviewModel ?? executeModel,
		budget: opts.budget,
		sandbox: sandbox.active,
		workers: results,
		parallelDurationMs: Date.now() - parallelStartMs,
		totalDurationMs: Date.now() - runStartMs,
		verification,
		receivedAt: opts.receivedAt,
		dispatchedAt,
		mainSessionTokens: opts.mainSessionTokens,
		filesChanged,
		insertions: diffStat.insertions,
		deletions: diffStat.deletions,
		// R1/R4/R5: atomic combine + union-ladder + overlap classification
		// record (resolved:"union" files, remaining conflicts, overlaps).
		merge: mergeMetrics,
	});

	// R2: success-with-caveat — a finalization-incomplete recovery whose
	// merge landed and whose union verification gate PASSED reports success
	// with the caveat (merged commit id + file delta + the aborted-worker
	// note). The gate-fail case already threw (failure path with preserved
	// workspaces); escalated conflicts keep the plain failure return.
	const caveat =
		finalizationIncompleteIndexes.length > 0 &&
		verification.passed &&
		conflicts.length === 0
			? `worker${finalizationIncompleteIndexes.length > 1 ? "s" : ""} ` +
				`${finalizationIncompleteIndexes.map((i) => `#${i}`).join(", ")} aborted during finalization; ` +
				`verified post-merge — merged commit ${baseCommitId}, ` +
				`${mergeMetrics.files_changed ?? 0} file(s) changed`
			: undefined;

	return {
		success: verification.passed && conflicts.length === 0,
		commits: [baseCommitId],
		files_changed: filesChanged,
		tests: verification.passed ? "passing" : "failing",
		spec,
		// R2: an all-aborted finalization-incomplete run has no yielded
		// worker — the zeroed stand-in keeps the result shape intact.
		worker: results[0] ?? abortedWorkerResult(),
		workers: results,
		conflicts,
		verification,
		...(parallelSuspects.length > 0
			? { suspectedSpecDefects: [...parallelSuspects] }
			: {}),
		...(caveat ? { caveat } : {}),
		// R7: a requested review is single-worker only — surface that it was
		// skipped (todo #73: no console.warn; the plan line and this flag
		// carry the signal).
		...(opts.review ? { reviewSkipped: true } : {}),
		manifest: metrics.manifest,
		...(metrics.manifestPath === undefined
			? {}
			: { manifestPath: metrics.manifestPath }),
		durationMs: Date.now() - runStartMs,
	};
}

// ─── Batch lane path (M2) ───────────────────────────────────────────

/**
 * The batch channel path (routeRun → "batch"): the run is an ASYNC batch
 * job, not an interactive session. The spec's typed requirements are
 * submitted as one single-turn prompt item each (batch.ts buildBatchItems,
 * output contract BATCH_FILE_CONTRACT), polled to a terminal phase,
 * collected, and validated against the contracts; the validated file
 * outputs are applied to the working copy, committed under the AI
 * identity (the same createAiTaskBase/restore dance as the single-worker
 * path), and gated by the spec's verification commands (bash, zero
 * tokens). Single-turn: no tool loop, no prewalk, no review, no sandbox
 * (no subprocess workers).
 *
 * Failures are TYPED (BatchError) + RECOVERABLE: the job-state file
 * (<metricsDir>/<project>/<run_id>.batch.json) records the job id + every
 * item's status, and the failure artifact carries the state-file path —
 * an aborted/timed-out job can be polled later; failed items can be
 * resubmitted alone.
 */
async function executeBatchLane(
	cwd: string,
	opts: {
		spec: Spec;
		specMarkdown: string;
		reviewRequested: boolean;
		/** Optional AND nullable under exactOptionalPropertyTypes — call sites
		 *  forward their own `T | undefined` locals verbatim (R4 discipline). */
		metricsDir?: string | undefined;
		project?: string | undefined;
		budget?: string | undefined;
		signal?: AbortSignal | undefined;
		onUpdate?: ((partial: unknown) => void) | undefined;
		verificationTimeoutMs?: number | undefined;
		/** AI commit identity — already formatted ({model} resolved). */
		aiAuthorName: string;
		aiAuthorEmail: string;
		receivedAt?: string;
		mainSessionTokens?: number;
		/** The injected run_id (the manifest + failure artifact must land
		 *  under THIS id — a detached dispatch keys everything by it). */
		runId?: string | undefined;
		batch?: BatchLaneConfig | undefined;
		batchProvider?: BatchProvider | undefined;
	},
): Promise<TaskResult> {
	const {
		spec,
		specMarkdown,
		reviewRequested,
		metricsDir,
		project,
		budget,
		signal,
		onUpdate,
		aiAuthorName,
		aiAuthorEmail,
		receivedAt,
		mainSessionTokens,
	} = opts;
	// The [batch] config: an explicit override (direct callers/tests), else
	// task.toml's [batch] section (shipped defaults when no file).
	const batchCfg = opts.batch ?? loadTaskConfig().batch;
	const provider = opts.batchProvider ?? new OpenRouterBatchProvider();
	const verifyTimeout =
		opts.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
	const projectName = project ?? deriveProjectName(cwd);
	const runStartMs = Date.now();
	const runId = opts.runId ?? generateRunId();

	// AI commit identity (todo #84): root the batch commit on a fresh
	// AI-authored commit (mirrors executeSingle — `jj commit` preserves the
	// working-copy commit's author).
	let identityDir: string | null = null;
	let identityFile: string | null = null;
	if (aiAuthorName.trim().length > 0 && aiAuthorEmail.trim().length > 0) {
		identityDir = mkdtempSync(join(tmpdir(), "pi-task-identity-"));
		identityFile = join(identityDir, "jj-identity.toml");
		writeFileSync(
			identityFile,
			aiIdentityToml(aiAuthorName, aiAuthorEmail),
			"utf-8",
		);
		try {
			await createAiTaskBase(cwd, identityFile, spec.goal);
		} catch (err) {
			try {
				rmSync(identityDir, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
			throw err;
		}
	}
	// The run's diff base: the recorded @ AFTER the AI base creation (the
	// AI base is empty — diffing from it or from @- is equivalent).
	const baseCommit = await headCommitId(cwd);

	// Verification lifecycle: the pre-apply baseline (the tree is clean
	// here — cleanness asserted at the run's head). Baseline-identical
	// post-apply failures are recorded as suspected spec defects.
	const batchBaseline = await captureVerificationBaseline(
		spec.verification,
		cwd,
		verifyTimeout,
		signal,
	);
	const batchSuspects: string[] = [];

	try {
		// 1. The lane: submit → poll → collect → validate (typed failures;
		// job state persisted to the metrics dir at every transition).
		const lane = await runBatchLane({
			spec,
			model: batchCfg.model,
			provider,
			pollIntervalMs: batchCfg.pollIntervalMs,
			jobTimeoutMs: batchCfg.jobTimeoutMs,
			...(metricsDir === undefined ? {} : { metricsDir }),
			project: projectName,
			runId,
			signal,
			onUpdate,
		});

		// 2. Re-check the working copy is CLEAN before applying — the job may
		// have polled for up to 24h, and user work-in-progress started during
		// that window must never be swept into the batch commit (review P2).
		// STRICT here by design: this rechecks the SAME tree the entry gate
		// just made dispatchable — any dirt that appeared during the poll
		// window is live user work-in-progress, not legacy residue.
		await assertCleanWorkingCopy(cwd);
		// Apply the validated file outputs to the working copy. The
		// model's output is untrusted input — extractBatchFiles enforces
		// repo-relative path safety; mergeBatchFiles rejects conflicting
		// duplicate paths deterministically (never silent last-wins).
		let files: BatchFile[] = [];
		try {
			files = mergeBatchFiles(
				lane.items.map((rec) => ({
					customId: rec.custom_id,
					files: extractBatchFiles(lane.outputs[rec.custom_id], rec.custom_id),
				})),
			);
		} catch (err) {
			throw err instanceof BatchError
				? err
				: new BatchError(
						"invalid_output",
						`batch output extraction failed: ${(err as Error).message}`,
					);
		}
		for (const f of files) {
			const target = join(cwd, f.path);
			// Greenfield-only: the items are context-free single-turn prompts,
			// so overwriting an existing file would silently replace content
			// the model never saw (review P2). Refuse rather than lose data.
			if (existsSync(target)) {
				throw new BatchError(
					"existing_file",
					`batch item targets existing file ${f.path} — the batch lane is greenfield-only; delete it or adapt the spec`,
				);
			}
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, f.content, "utf-8");
		}
		onUpdate?.({ type: "batch_applied", files: files.map((f) => f.path) });

		// 3. Commit the applied files. The working-copy commit @ is already
		// AI-authored (createAiTaskBase), so `jj commit` keeps the AI
		// identity — the same invariant as the single-worker path. No files
		// → nothing to commit (verification decides the outcome).
		let commitIds: string[] = [];
		if (files.length > 0) {
			const commit = await execJj(
				["commit", "-m", `batch(task): ${spec.goal}`],
				cwd,
			);
			if (commit.code !== 0) {
				throw new Error(
					`batch commit failed (${commit.code}): ${commit.stderr.trim()}`,
				);
			}
			const id = await execJj(
				[
					"log",
					"-r",
					"@-",
					"-T",
					"commit_id",
					"--no-graph",
					"--ignore-working-copy",
				],
				cwd,
			);
			if (id.code === 0 && /^[0-9a-f]{40}$/.test(id.stdout.trim())) {
				commitIds = [id.stdout.trim()];
			}
		}

		// 4. Verification (bash hard gate, zero tokens) on the applied tree.
		const verification = await runVerification(
			spec.verification,
			cwd,
			verifyTimeout,
			signal,
		);
		for (const f of classifyVerificationFailures(
			verification.failures,
			batchBaseline,
		).specDefectSuspected) {
			if (!batchSuspects.includes(f.command)) batchSuspects.push(f.command);
		}

		// 5. Metrics: ONE RunManifest — phases.execute is the lane's
		// aggregate usage (turns = items, edits = applied files, duration =
		// the lane's wall time), verify.source "batch", config carries the
		// channel. Diff stats over baseCommit..@- (best effort).
		const diffStat = await computeDiffStatBestEffort(cwd, baseCommit);
		const manifest = buildRunManifest({
			runId,
			specMarkdown,
			requirements: spec.requirements.length,
			config: {
				prewalkModel: batchCfg.model,
				executeModel: batchCfg.model,
				reviewModel: batchCfg.model,
				reviewForked: false,
				shape: "batch",
				channel: "batch",
				...(budget === undefined ? {} : { budget }),
				checklist: false,
				swapTrigger: "none",
			},
			phases: {
				prewalk: null,
				execute: {
					model: batchCfg.model,
					turns: lane.items.length,
					tokens_in: lane.usage.prompt_tokens,
					tokens_out: lane.usage.completion_tokens,
					reads: 0,
					edits: files.length,
					duration_ms: lane.durationMs,
					cost_usd: lane.usage.cost_usd,
				},
				verify: {
					passed: verification.passed,
					commands: verification.commands,
					duration_ms: verification.duration_ms,
					source: "batch",
					...(verification.timed_out === undefined
						? {}
						: { timed_out: verification.timed_out }),
					...(batchSuspects.length > 0
						? { suspected_spec_defects: batchSuspects }
						: {}),
				},
				review: null,
				fixLoop: { iterations: 0, cost_usd: 0 },
			},
			durationMs: Date.now() - runStartMs,
			readDuplicationTokens: 0,
			...(receivedAt === undefined ? {} : { receivedAt }),
			dispatchedAt: new Date().toISOString(),
			completedAt: new Date().toISOString(),
			...(mainSessionTokens === undefined ? {} : { mainSessionTokens }),
			filesChanged: files.map((f) => f.path),
			insertions: diffStat.insertions,
			deletions: diffStat.deletions,
		});
		const manifestPath = metricsDir
			? writeManifest(manifest, { metricsDir, project: projectName })
			: undefined;

		// The synthesized worker result: the lane has no session — usage is
		// the lane's aggregate, turns = items, edits = applied files.
		const worker: WorkerResult = {
			yield: {
				files_changed: files.map((f) => f.path),
				summary:
					`batch lane: ${lane.items.length}/${lane.items.length} item(s) collected via ` +
					`${batchCfg.model} (job ${lane.jobId}) — ${files.length} file(s) applied`,
				commit_ids: commitIds,
				deviations: [],
			},
			usage: {
				turns: lane.items.length,
				tokens_in: lane.usage.prompt_tokens,
				tokens_out: lane.usage.completion_tokens,
				cache_read: 0,
				cache_write: 0,
				cost_usd: lane.usage.cost_usd,
				reads: 0,
				edits: files.length,
			},
			exitCode: 0,
			reads: [],
			turnUsage: [],
		};

		return {
			success: verification.passed,
			commits: commitIds,
			files_changed: files.map((f) => f.path),
			tests: verification.passed ? "passing" : "failing",
			spec,
			worker,
			verification,
			// A requested review is single-turn-incompatible — surface that it
			// was skipped (todo #73: no console output; the flag carries it).
			...(reviewRequested ? { reviewSkipped: true } : {}),
			batch: {
				jobId: lane.jobId,
				model: batchCfg.model,
				items: lane.items.length,
			},
			...(batchSuspects.length > 0
				? { suspectedSpecDefects: [...batchSuspects] }
				: {}),
			manifest,
			...(manifestPath === undefined ? {} : { manifestPath }),
			durationMs: Date.now() - runStartMs,
		};
	} catch (err) {
		// Typed + recoverable failure: the failure artifact carries the
		// cause (the BatchError message names the job id) AND the job-state
		// file path — the recovery handle (resume polling an aborted/
		// timed-out job; resubmit only the failed items).
		if (err instanceof BatchError) {
			const statePath = metricsDir
				? batchJobStatePath(metricsDir, projectName, runId)
				: undefined;
			const recovery = statePath
				? `Batch lane failure — recover from the job-state file:\n  ${statePath}\n` +
					(err.code === "aborted" || err.code === "poll_timeout"
						? "The job is still live provider-side (job id in the state file) — poll it later, or run a new batch lane and compare.\n"
						: err.code === "items_incomplete"
							? "The job completed but some items failed validation — resubmit ONLY the failed items (per-item statuses in the state file).\n"
							: "The job did not produce a manifest — fix the cause and resubmit.\n")
				: undefined;
			writeFailureArtifactBestEffort({
				err,
				kind: "batch",
				metricsDir,
				project: projectName,
				specMarkdown,
				tier: budget,
				recovery,
			});
		}
		throw err;
	} finally {
		// Restore the working copy to the USER's identity (mirrors
		// executeSingle): `jj new` opens a fresh empty commit; the leftover
		// empty AI-authored WC (or the empty AI base when nothing was
		// committed) is abandoned. Best effort — never masks the run's
		// outcome.
		if (identityDir) {
			try {
				await execJj(["new"], cwd);
				const leftover = (
					await execJj(
						["log", "-r", "@-", "-T", "if(empty, 'EMPTY', 'X')", "--no-graph"],
						cwd,
					)
				).stdout.trim();
				if (leftover === "EMPTY") await execJj(["abandon", "@-"], cwd);
			} catch {
				/* best effort */
			}
			try {
				rmSync(identityDir, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	}
}

/**
 * Single-worker path. Without `review` this is byte-for-byte the Phases 2-5
 * behavior (spawn → verify once → return). With `review`, the worker persists
 * a session and the result is gated by a forked adversarial review + bounded
 * fix loop (verify → review → fix worker, up to maxFixIterations fixes).
 * Every run also produces a RunManifest (in-memory always; persisted when a
 * metricsDir is configured, see finalizeMetrics).
 */
async function executeSingle(
	cwd: string,
	opts: {
		taskPrompt: string;
		usePrewalk: boolean;
		/** Optional AND nullable under exactOptionalPropertyTypes — executeTask
		 *  forwards its own `T | undefined` locals verbatim (R4 discipline). */
		prewalkModel?: string | undefined;
		executeModel: string;
		/** Whether the checklist tool is loaded (tier checklist config). */
		checklist?: boolean | undefined;
		systemPrompt?: string | undefined;
		signal?: AbortSignal | undefined;
		onSwap?: ((info: SwapInfo) => void) | undefined;
		onUpdate?: ((partial: unknown) => void) | undefined;
		verificationTimeoutMs?: number | undefined;
		workerTimeoutMs?: number | undefined;
		toolTimeoutMs?: number | undefined;
		/** Per-fork review wall (ms); absent → review.ts's 20-min default. */
		reviewWallTimeoutMs?: number | undefined;
		/** OpenRouter service tier (flex infra) → worker/fix/reviewer spawns. */
		serviceTier?: string | undefined;
		/** OpenRouter provider.only pin (flex infra). */
		providerOnly?: string[] | undefined;
		/** Pre-change verification baseline (dispatch-time dry run) — lets the
		 *  fix loop distinguish spec defects from real failures by evidence. */
		verificationBaseline?: VerificationBaselineEntry[];
		/** Turn budget (the tier's turn_budget) — nudge at 70%, abort at 100%. */
		turnBudget?: number;
		spec: Spec;
		specMarkdown: string;
		/** Whether a review was REQUESTED (opts.review or an explicit persona)
		 *  — may differ from `review` (enabled), which is false for axis-less
		 *  shapes; a requested-but-not-run review surfaces as reviewSkipped. */
		reviewRequested?: boolean;
		review?: boolean;
		reviewModel?: string;
		persona?: string;
		shape?: TaskShape | undefined;
		maxFixIterations?: number | undefined;
		metricsDir?: string | undefined;
		project?: string | undefined;
		preserveSessions?: boolean | undefined;
		runId?: string | undefined;
		budget?: string | undefined;
		sandbox: ResolvedSandbox;
		/** AI commit identity (todo #84) — already formatted ({model} resolved). */
		aiAuthorName?: string | undefined;
		aiAuthorEmail?: string | undefined;
		/** R1: the task tool's received_at + pre-dispatch main-session spend
		 *  (absent for direct callers — manifest fields then absent/zero). */
		receivedAt?: string | undefined;
		mainSessionTokens?: number | undefined;
	},
): Promise<TaskResult> {
	const {
		taskPrompt,
		usePrewalk,
		prewalkModel,
		executeModel,
		systemPrompt,
		signal,
		onSwap,
		onUpdate,
		verificationTimeoutMs,
		workerTimeoutMs,
		toolTimeoutMs,
		reviewWallTimeoutMs,
		spec,
		specMarkdown,
		reviewRequested,
		review,
		reviewModel,
		persona,
		shape,
		maxFixIterations,
		metricsDir,
		project,
		preserveSessions,
		budget,
		sandbox,
		runId,
		aiAuthorName,
		aiAuthorEmail,
	} = opts;

	// Checklist-per-tier: false → the checklist tool is not loaded and the
	// prompt stops mandating it (saves the init + done-per-requirement
	// turns on cheap tiers). Default true.
	const useChecklist = opts.checklist !== false;
	const workerSystemPrompt =
		systemPrompt ?? buildWorkerSystemPrompt(useChecklist);
	// Failure artifacts land under <metricsDir>/<project>/ (R2): direct
	// callers omit project, so derive it like executeBatchLane does — an
	// undefined project would make join() throw inside the best-effort
	// catch and silently drop the artifact.
	const projectName = project ?? deriveProjectName(cwd);
	const workerExtensions = [
		...(useChecklist ? [CHECKLIST_EXTENSION_PATH] : []),
		...(usePrewalk ? [PREWALK_EXTENSION_PATH] : []),
	];

	// Verification lifecycle locals: the pre-change baseline (dispatch-time
	// dry run) + the accumulated spec-defect suspects (failures matching the
	// baseline exactly — recorded in the result/manifest, never fix-looped).
	const verificationBaseline = opts.verificationBaseline ?? [];
	const suspectedSpecDefects: string[] = [];
	let lastAdjudication: { upheld: string[]; rejected: VerificationDispute[] } =
		{ upheld: [], rejected: [] };

	const verifyTimeout =
		verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;

	// The worker persists a session when the reviewer forks it (review) or when
	// traces are preserved (benchmark mode). The orchestrator owns the scratch
	// dir and cleans it up in finally.
	const sessionDir =
		review || preserveSessions
			? mkdtempSync(join(tmpdir(), "pi-task-session-"))
			: undefined;

	// AI commit identity (todo #84): root the single worker on a fresh
	// AI-authored commit. jj commit preserves the working-copy commit's
	// ORIGINAL author, so rewriting the user's WC would attribute the AI's
	// work to the user — and the worker's leftover empty WC would then make
	// the user's NEXT commit AI-authored too (jj has no author-reset; the
	// identity is set at commit creation). Mirrors the parallel path's
	// createAiTaskBase; the restore step in the finally below returns the
	// working copy to the user's identity.
	let identityDir: string | null = null;
	let identityFile: string | null = null;
	if (
		aiAuthorName !== undefined &&
		aiAuthorEmail !== undefined &&
		aiAuthorName.trim().length > 0 &&
		aiAuthorEmail.trim().length > 0
	) {
		identityDir = mkdtempSync(join(tmpdir(), "pi-task-identity-"));
		identityFile = join(identityDir, "jj-identity.toml");
		writeFileSync(
			identityFile,
			aiIdentityToml(aiAuthorName, aiAuthorEmail),
			"utf-8",
		);
		try {
			await createAiTaskBase(cwd, identityFile, spec.goal);
		} catch (err) {
			try {
				rmSync(identityDir, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
			throw err;
		}
	}
	// The task base for the run's diff stats: the recorded @ AFTER the AI
	// base creation (the AI base is empty, so diffing from it or from @- is
	// equivalent; the review fork also anchors its review diff here).
	const baseCommit = await headCommitId(cwd);

	// Metrics: run timing + the swap turn (captured by wrapping the caller's
	// onSwap — the swap fires on the worker's first edit).
	const runStartMs = Date.now();
	let swapTurn: number | null = null;
	const captureSwap = (info: SwapInfo): void => {
		swapTurn = info.turns;
		onSwap?.(info);
	};

	try {
		// 4. Spawn worker — the spec markdown (plus map section) IS the task prompt.
		const workerStartMs = Date.now();
		// R1: dispatched_at — the moment the worker session spawns.
		const dispatchedAt = new Date(workerStartMs).toISOString();
		const session = spawnWorkerSessionResilient({
			cwd,
			model: usePrewalk ? prewalkModel! : executeModel,
			...(opts.serviceTier === undefined
				? {}
				: { serviceTier: opts.serviceTier }),
			...(opts.serviceTier || opts.providerOnly?.length
				? { serviceTierExcludes: [executeModel] }
				: {}),
			...(opts.providerOnly === undefined
				? {}
				: { providerOnly: opts.providerOnly }),
			...(runId === undefined ? {} : { sessionId: runId }),
			noProgressTimeoutMs: channelWatchdogWindows(
				(shape ?? DEFAULT_SHAPE).channel,
			).noProgressMs,
			task: taskPrompt,
			systemPrompt: workerSystemPrompt,
			extensions: workerExtensions,
			...(sessionDir === undefined ? {} : { sessionDir }),
			...(signal === undefined ? {} : { signal }),
			sandbox,
			...(aiAuthorName === undefined ? {} : { aiAuthorName }),
			...(aiAuthorEmail === undefined ? {} : { aiAuthorEmail }),
			...(onUpdate === undefined ? {} : { onUpdate }),
			// Phase 11 (R4/R5): per-tier wall + per-tool-call budget. The
			// verification commands + grace: the wall must not kill an
			// in-flight suite run — it gets a bounded grace instead.
			...(workerTimeoutMs === undefined ? {} : { timeoutMs: workerTimeoutMs }),
			...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }),
			verificationCommands: spec.verification,
			...(verificationTimeoutMs === undefined ? {} : { verificationTimeoutMs }),
		});
		// Checklist relay (R4): streams the worker's real checklist state to the
		// progress view via the existing worker event stream — observer-only,
		// zero LLM tokens, worker-side semantics unchanged.
		const checklistCtrl = attachChecklistRelay(session, {
			onChecklist: (c) =>
				onUpdate?.({ type: "checklist", done: c.done, total: c.total }),
		});

		// Turn budget (Phase 3): bounded autonomy, enforced mechanically. At
		// 70% of the tier's budget the engine injects a convergence prompt; at
		// 100% it aborts the session (typed turn-budget error below). Fix
		// workers are exempt (already bounded by maxFixIterations).
		const turnBudgetState = { turns: 0, nudged: false, exhausted: false };
		if (opts.turnBudget && opts.turnBudget > 0) {
			session.onEvent((event) => {
				const ev = event as { type?: string; message?: { role?: string } };
				if (ev.type !== "message_end" || ev.message?.role !== "assistant")
					return;
				turnBudgetState.turns++;
				const action = decideTurnBudgetAction(
					turnBudgetState.turns,
					opts.turnBudget,
					turnBudgetState.nudged,
				);
				if (action === "nudge") {
					turnBudgetState.nudged = true;
					session.sendCommand({
						type: "prompt",
						message: turnBudgetNudgeMessage(
							turnBudgetState.turns,
							opts.turnBudget!,
						),
					});
					onUpdate?.({
						type: "turn_budget_nudge",
						turns: turnBudgetState.turns,
						budget: opts.turnBudget,
					});
				} else if (action === "abort" && !turnBudgetState.exhausted) {
					turnBudgetState.exhausted = true;
					onUpdate?.({
						type: "turn_budget_exhausted",
						turns: turnBudgetState.turns,
						budget: opts.turnBudget,
					});
					session.abort();
				}
			});
		}

		// 5. Attach prewalk swap listener (no-op when auto-skipped). A failed
		// set_model swap (R6) aborts the worker and is surfaced as the run's
		// error below — instead of the silent "continue on the expensive
		// prewalk model" behavior a fire-and-forget swap would leave behind.
		let swapError: Error | null = null;
		const prewalkCtrl = usePrewalk
			? attachPrewalk(session, {
					prewalkModel: prewalkModel!,
					executeModel,
					onSwap: captureSwap,
					onError: (err) => {
						swapError = err;
						session.abort();
					},
				})
			: null;

		let worker: WorkerResult;
		try {
			worker = await session.result;
		} catch (err) {
			if (turnBudgetState.exhausted) {
				// This throw IS an abort exit — termination hygiene applies:
				// rescue the WIP + strip engine empties before failing.
				await singleRunFailureHygiene({
					cwd,
					err: new Error(
						"turn budget exhausted (worker aborted at 100% of the tier's turn budget)",
					),
					goal: spec.goal,
					aiAuthorName,
					aiAuthorEmail,
				});
				writeFailureArtifactBestEffort({
					err,
					kind: "worker",
					runId,
					metricsDir,
					project: projectName,
					specMarkdown,
					tier: budget,
				});
				throw new Error(
					`turn budget exhausted: the worker used the tier's full ${opts.turnBudget}-turn budget without yielding — ` +
						`the run was aborted to stop the spend. Any commits the worker made remain in the tree.`,
				);
			}
			// swapError's null-narrowing does not survive into a catch block
			// (the awaited call above can invalidate it), hence the explicit
			// Error assertion for only-throw-error.
			if (swapError !== null) {
				// Abort exit (the swap failure aborted the session): the same
				// termination hygiene applies before the error propagates.
				await singleRunFailureHygiene({
					cwd,
					err: swapError,
					goal: spec.goal,
					aiAuthorName,
					aiAuthorEmail,
				});
				writeFailureArtifactBestEffort({
					err,
					kind: "worker",
					runId,
					metricsDir,
					project: projectName,
					specMarkdown,
					tier: budget,
				});
				throw swapError as Error;
			}
			// R2 (third outcome): finalization-incomplete — the checklist relay
			// showed ALL requirements done at abort, so the worker committed
			// everything and was verifying/yielding when it was killed. Rescue
			// any uncommitted tail first (a dirty WC would otherwise fail the
			// gate), then run verification on the committed tree post-abort:
			// pass → success-with-caveat (the worker's commit ids); fail → the
			// current failure path below. Never claim success without the
			// verification gate.
			//
			// Same treatment for the idle-watchdog no-yield failure: a worker
			// that settled twice without calling yield() often FINISHED the work
			// (weak models end turns with prose instead of yielding) — the tree,
			// not the missing payload, decides via the same gate.
			const noYieldFailure = isNoYieldFailure(err);
			if (noYieldFailure || isFinalizationIncomplete(checklistCtrl.latest)) {
				await rescueAbortedWorkBestEffort(cwd, err, spec.goal);
				const verification = await runVerification(
					spec.verification,
					cwd,
					verifyTimeout,
					signal,
				);
				if (verification.passed) {
					// The worker's commits: the range baseCommit..@- (the worker
					// never yielded, so the payload's commit_ids are unavailable).
					// Empty working-copy commits are filtered out — the identity
					// restore in the finally abandons them anyway.
					let commitIds: string[] = [];
					const ids = await execJj(
						[
							"log",
							"-r",
							`${baseCommit}..@-`,
							"--no-graph",
							"-T",
							"if(empty, '', commit_id)",
							"--ignore-working-copy",
						],
						cwd,
					);
					if (ids.code === 0) {
						commitIds = ids.stdout
							.split("\n")
							.map((l) => l.trim())
							.filter((l) => /^[0-9a-f]{40}$/.test(l));
					}
					let filesChanged: string[] = [];
					try {
						filesChanged = await filesChangedBetween(cwd, baseCommit, "@-");
					} catch {
						/* best effort */
					}
					const diffStat = await computeDiffStatBestEffort(cwd, baseCommit);
					// The zeroed stand-in: the session died before yielding, so
					// there is no real usage to record — the caveat carries the
					// recovery story.
					const worker = abortedWorkerResult();
					const metrics = finalizeMetrics({
						cwd,
						project,
						metricsDir,
						preserveSessions,
						runId,
						worker,
						assemble: {
							specMarkdown,
							requirements: spec.requirements.length,
							prewalkModel: usePrewalk ? prewalkModel! : executeModel,
							executeModel,
							reviewModel: reviewModel ?? executeModel,
							reviewForked: false,
							shape,
							budget,
							serviceTier: opts.serviceTier,
							sandbox: sandbox.active,
							worker,
							workerDurationMs: Date.now() - workerStartMs,
							totalDurationMs: Date.now() - runStartMs,
							swapTurn,
							verification,
							review: null,
							fixLoop: { iterations: 0, costUsd: 0 },
							...(opts.receivedAt === undefined
								? {}
								: { receivedAt: opts.receivedAt }),
							dispatchedAt,
							mainSessionTokens: opts.mainSessionTokens,
							filesChanged,
							insertions: diffStat.insertions,
							deletions: diffStat.deletions,
						},
					});
					return {
						success: true,
						commits: commitIds,
						files_changed: filesChanged,
						tests: "passing",
						spec,
						worker,
						verification,
						manifest: metrics.manifest,
						...(metrics.manifestPath === undefined
							? {}
							: { manifestPath: metrics.manifestPath }),
						durationMs: Date.now() - runStartMs,
						caveat:
							(noYieldFailure
								? `worker ended without calling yield; salvaged — `
								: `worker aborted during finalization; verified post-merge — `) +
							`${commitIds.length} commit(s): ${commitIds.join(", ") || "(none)"}`,
					};
				}
			}
			// The current failure path: contract rules 1–6 — rescue the dirty
			// working copy into ONE goal-named commit, abandon ONLY provably
			// engine-authored empty stubs (preserve-by-doubt otherwise), and
			// attach machine-readable recovery info to the artifact. Best
			// effort — never masks the original failure.
			const recovery = await singleRunFailureHygiene({
				cwd,
				err,
				goal: spec.goal,
				aiAuthorName,
				aiAuthorEmail,
			});
			writeFailureArtifactBestEffort({
				err,
				kind: "worker",
				runId,
				metricsDir,
				project: projectName,
				specMarkdown,
				tier: budget,
				singleRunRecovery: recovery,
			});
			throw err;
		} finally {
			prewalkCtrl?.detach();
			checklistCtrl.detach();
		}
		const workerDurationMs = Date.now() - workerStartMs;

		// Worker disputes travel with the yield; fix workers may add more.
		const disputes: VerificationDispute[] = [...(worker.yield.disputes ?? [])];

		// ── Review disabled: unchanged verify-once path (plus metrics) ──
		if (!review) {
			const verification = await runVerification(
				spec.verification,
				cwd,
				verifyTimeout,
				signal,
			);
			const defectSplit0 = classifyVerificationFailures(
				verification.failures,
				verificationBaseline,
			);
			lastAdjudication = adjudicateDisputes(
				disputes,
				verification.failures,
				verificationBaseline,
			);
			for (const f of defectSplit0.specDefectSuspected) {
				if (!suspectedSpecDefects.includes(f.command))
					suspectedSpecDefects.push(f.command);
			}
			for (const c of lastAdjudication.upheld) {
				if (!suspectedSpecDefects.includes(c)) suspectedSpecDefects.push(c);
			}
			// R1 diff stats: the worker's commits are baseCommit..@- (the worker
			// leaves @ as an empty working-copy commit after its last `jj commit`).
			const diffStat = await computeDiffStatBestEffort(cwd, baseCommit);
			const metrics = finalizeMetrics({
				cwd,
				project,
				metricsDir,
				preserveSessions,
				runId,
				worker,
				assemble: {
					specMarkdown,
					requirements: spec.requirements.length,
					prewalkModel: usePrewalk ? prewalkModel! : executeModel,
					executeModel,
					reviewModel: reviewModel ?? executeModel,
					reviewForked: false,
					shape,
					budget,
					serviceTier: opts.serviceTier,
					sandbox: sandbox.active,
					worker,
					workerDurationMs,
					totalDurationMs: Date.now() - runStartMs,
					swapTurn,
					verification,
					suspectedSpecDefects: [...suspectedSpecDefects],
					disputes: lastAdjudication,
					review: null,
					fixLoop: { iterations: 0, costUsd: 0 },
					...(opts.receivedAt === undefined
						? {}
						: { receivedAt: opts.receivedAt }),
					dispatchedAt,
					mainSessionTokens: opts.mainSessionTokens,
					filesChanged: worker.yield.files_changed,
					insertions: diffStat.insertions,
					deletions: diffStat.deletions,
				},
			});
			return {
				success: verification.passed,
				commits: worker.yield.commit_ids,
				files_changed: worker.yield.files_changed,
				tests: verification.passed ? "passing" : "failing",
				spec,
				worker,
				verification,
				...(suspectedSpecDefects.length > 0
					? { suspectedSpecDefects: [...suspectedSpecDefects] }
					: {}),
				...(lastAdjudication.upheld.length > 0 ||
				lastAdjudication.rejected.length > 0
					? { disputes: lastAdjudication }
					: {}),
				// R1: a requested review on an axis-less shape (analysis — surveys
				// are a single task, the worker IS the review) never forks; surface
				// the skipped disposition instead (same contract as parallel/batch).
				...(reviewRequested ? { reviewSkipped: true } : {}),
				manifest: metrics.manifest,
				...(metrics.manifestPath === undefined
					? {}
					: { manifestPath: metrics.manifestPath }),
				durationMs: Date.now() - runStartMs,
			};
		}

		// ── Review + bounded fix loop ──
		const sessionFile = worker.sessionFile;
		if (!sessionFile) {
			throw new Error(
				"review enabled but the worker did not persist a session (no sessionFile)",
			);
		}
		const maxFixes = Math.max(0, maxFixIterations ?? 2);
		// The review axes (R1): no persona override → ONE default adversarial
		// fork (fast, lean — the everyday default for routine code work);
		// persona "parallel" (PARALLEL_REVIEW_PERSONA) → the shape's full
		// declared axis set as parallel forks (the explicit opt-in for
		// high-stakes/shared code); a single named persona → exactly that
		// one axis. Findings merge, verdict = worst, requirements = worst
		// per id. Axis-less shapes never reach here — resolveReviewGate
		// disabled the review upstream (surveys are a single task, the
		// worker IS the review).
		const effectiveAxes = resolveReviewAxes(persona, shape);
		const rModel = reviewModel ?? executeModel;

		let diff = await computeDiff(cwd, baseCommit);
		const commits = [...worker.yield.commit_ids];
		const files = [...worker.yield.files_changed];
		let fixesUsed = 0;
		let fixesCostUsd = 0;
		let reviewCostUsd = 0;
		let verification!: VerificationResult;
		let reviewResult: ReviewResult | null = null;
		let decision!: FixLoopDecision;

		while (true) {
			// 8a. Verification (bash hard gate, zero tokens)
			verification = await runVerification(
				spec.verification,
				cwd,
				verifyTimeout,
				signal,
			);
			// Baseline adjudication: failures matching the pre-change baseline
			// (same exit + output signature) are suspected spec defects — the
			// gate was unsatisfiable before the work began. The fix loop spends
			// NOTHING on them: all-suspect → escalate with the evidence, mixed
			// → fix only the actionable failures.
			const defectSplit = classifyVerificationFailures(
				verification.failures,
				verificationBaseline,
			);
			// Worker disputes (yield + fix workers): adjudicated by evidence —
			// upheld only on a baseline-identical failure. Never unilateral.
			lastAdjudication = adjudicateDisputes(
				disputes,
				verification.failures,
				verificationBaseline,
			);
			for (const f of defectSplit.specDefectSuspected) {
				if (!suspectedSpecDefects.includes(f.command))
					suspectedSpecDefects.push(f.command);
			}
			for (const c of lastAdjudication.upheld) {
				if (!suspectedSpecDefects.includes(c)) suspectedSpecDefects.push(c);
			}
			const actionableFailures = defectSplit.actionable.filter(
				(f) => !lastAdjudication.upheld.includes(f.command),
			);
			if (!verification.passed && actionableFailures.length === 0) {
				onUpdate?.({
					type: "spec_defect_suspected",
					commands: [...suspectedSpecDefects],
				});
				decision = "escalate";
				break;
			}
			// 8b. Forked adversarial review (inherits the worker's pruned context).
			// The progress view keys its work → review transition off this event.
			onUpdate?.({ type: "review_start" });
			let outcomes: Array<{
				result: ReviewResult;
				usage: { cost_usd: number };
			}>;
			try {
				const watchWindows = channelWatchdogWindows(
					(shape ?? DEFAULT_SHAPE).channel,
				);
				outcomes = await Promise.all(
					effectiveAxes.map((p) =>
						forkedReview({
							cwd,
							sessionFile,
							sessionDir: sessionDir!,
							model: rModel,
							specMarkdown,
							diff,
							summary: worker.yield.summary,
							deviations: worker.yield.deviations,
							persona: p,
							firstEventTimeoutMs: watchWindows.firstEventMs,
							...(reviewWallTimeoutMs === undefined
								? {}
								: { wallTimeoutMs: reviewWallTimeoutMs }),
							...(opts.serviceTier === undefined
								? {}
								: { serviceTier: opts.serviceTier }),
							...(opts.serviceTier || opts.providerOnly?.length
								? { serviceTierExcludes: [executeModel] }
								: {}),
							...(opts.providerOnly === undefined
								? {}
								: { providerOnly: opts.providerOnly }),
							...(signal === undefined ? {} : { signal }),
							...(onUpdate === undefined ? {} : { onUpdate }),
						}),
					),
				);
			} catch (err) {
				// A failed review must not vanish without a trace (the run has no
				// manifest on this path) — record the failure artifact, then the
				// original error propagates (todo #86).
				writeFailureArtifactBestEffort({
					err,
					kind: "review",
					runId,
					metricsDir,
					project: projectName,
					specMarkdown,
					tier: budget,
				});
				throw err;
			}
			const merged = mergeReviewOutcomes(outcomes);
			reviewResult = merged.result;
			reviewCostUsd += merged.costUsd;
			// 8c. Ship / fix / escalate
			decision = decideFixLoop({
				testsPass: verification.passed,
				review: reviewResult,
				fixesUsed,
				maxFixes,
			});
			onUpdate?.({
				type: "review",
				verdict: reviewResult.verdict,
				findings: reviewResult.findings.length,
				decision,
			});
			if (decision !== "fix") break;

			// 8d. Dispatch a fix worker for the P0/P1 blockers + failing tests
			const fixPrompt = buildFixPrompt({
				specMarkdown,
				failures: actionableFailures,
				findings: blockersOf(reviewResult),
			});
			const fixSession = spawnWorkerSessionResilient({
				cwd,
				model: executeModel,
				...(opts.serviceTier === undefined
					? {}
					: { serviceTier: opts.serviceTier }),
				...(opts.serviceTier || opts.providerOnly?.length
					? { serviceTierExcludes: [executeModel] }
					: {}),
				...(opts.providerOnly === undefined
					? {}
					: { providerOnly: opts.providerOnly }),
				...(runId === undefined ? {} : { sessionId: runId }),
				noProgressTimeoutMs: channelWatchdogWindows(
					(shape ?? DEFAULT_SHAPE).channel,
				).noProgressMs,
				task: fixPrompt,
				systemPrompt: workerSystemPrompt,
				extensions: useChecklist ? [CHECKLIST_EXTENSION_PATH] : [],
				...(signal === undefined ? {} : { signal }),
				sandbox,
				...(aiAuthorName === undefined ? {} : { aiAuthorName }),
				...(aiAuthorEmail === undefined ? {} : { aiAuthorEmail }),
				...(onUpdate === undefined ? {} : { onUpdate }),
				// Phase 11 (R4/R5): the same per-tier wall + per-tool-call budget.
				...(workerTimeoutMs === undefined
					? {}
					: { timeoutMs: workerTimeoutMs }),
				...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }),
			});
			const fixResult = await fixSession.result.catch((err: unknown) => {
				writeFailureArtifactBestEffort({
					err,
					kind: "worker",
					runId,
					metricsDir,
					project: projectName,
					specMarkdown,
					tier: budget,
				});
				throw err;
			});
			fixesUsed++;
			disputes.push(...(fixResult.yield.disputes ?? []));
			fixesCostUsd += fixResult.usage.cost_usd;
			commits.push(...fixResult.yield.commit_ids);
			files.push(...fixResult.yield.files_changed);
			diff = await computeDiff(cwd, baseCommit);
		}

		// Metrics: assemble + persist (traces preserved first, if configured).
		// R1 diff stats: reuse the LAST loop diff (baseCommit..@- recomputed
		// after every fix worker) — no extra jj call, and parseDiffStat is
		// pure. files_changed is the deduped union incl. fix workers.
		const diffStat = parseDiffStat(diff);
		const metrics = finalizeMetrics({
			cwd,
			project,
			metricsDir,
			preserveSessions,
			runId,
			worker,
			assemble: {
				specMarkdown,
				requirements: spec.requirements.length,
				prewalkModel: usePrewalk ? prewalkModel! : executeModel,
				executeModel,
				reviewModel: rModel,
				reviewForked: true,
				shape,
				budget,
				serviceTier: opts.serviceTier,
				sandbox: sandbox.active,
				worker,
				workerDurationMs,
				totalDurationMs: Date.now() - runStartMs,
				swapTurn,
				verification,
				suspectedSpecDefects: [...suspectedSpecDefects],
				disputes: lastAdjudication,
				review: reviewResult
					? {
							result: reviewResult,
							costUsd: reviewCostUsd,
							personas: effectiveAxes.map((p) => p.name),
						}
					: null,
				fixLoop: { iterations: fixesUsed + 1, costUsd: fixesCostUsd },
				...(opts.receivedAt === undefined
					? {}
					: { receivedAt: opts.receivedAt }),
				dispatchedAt,
				mainSessionTokens: opts.mainSessionTokens,
				filesChanged: [...new Set(files)],
				insertions: diffStat.insertions,
				deletions: diffStat.deletions,
			},
		});

		return {
			success: decision === "ship",
			commits,
			files_changed: [...new Set(files)],
			tests: verification.passed ? "passing" : "failing",
			spec,
			worker,
			verification,
			...(suspectedSpecDefects.length > 0
				? { suspectedSpecDefects: [...suspectedSpecDefects] }
				: {}),
			...(lastAdjudication.upheld.length > 0 ||
			lastAdjudication.rejected.length > 0
				? { disputes: lastAdjudication }
				: {}),
			...(reviewResult ? { review: reviewResult } : {}),
			fixLoop: { iterations: fixesUsed + 1, fixesDispatched: fixesUsed },
			manifest: metrics.manifest,
			...(metrics.manifestPath === undefined
				? {}
				: { manifestPath: metrics.manifestPath }),
			durationMs: Date.now() - runStartMs,
		};
	} finally {
		// Restore the main working copy to the USER's identity: `jj new`
		// creates a fresh empty commit under the orchestrator's (user)
		// config, and the worker's leftover empty AI-authored WC (or the AI
		// base itself when the worker made no commits) is abandoned — safe:
		// it is empty by construction. Best effort — a failure here must not
		// mask the run's outcome; the parallel path mirrors this restore.
		if (identityDir) {
			try {
				await execJj(["new"], cwd);
				const leftover = (
					await execJj(
						["log", "-r", "@-", "-T", "if(empty, 'EMPTY', 'X')", "--no-graph"],
						cwd,
					)
				).stdout.trim();
				if (leftover === "EMPTY") await execJj(["abandon", "@-"], cwd);
			} catch {
				/* best effort */
			}
			try {
				rmSync(identityDir, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
		if (sessionDir) {
			try {
				rmSync(sessionDir, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	}
}
