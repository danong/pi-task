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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
	CHECKLIST_EXTENSION_PATH,
	DEFAULT_WORKER_SYSTEM_PROMPT,
	spawnWorkerSession,
	type WorkerFailureDiagnostics,
	type WorkerResult,
} from "./worker.ts";
import {
	attachPrewalk,
	isPrewalkActive,
	PREWALK_EXTENSION_PATH,
	type SwapInfo,
} from "./prewalk.ts";
import { attachChecklistRelay, type ChecklistProgress } from "./checklist-relay.ts";
import { resolveSandbox, type ResolvedSandbox } from "./sandbox.ts";
import {
	DEFAULT_TASK_CONFIG,
	DEFAULT_TASK_SHAPES,
	aiIdentityToml,
	formatAiAuthorName,
	type SandboxConfig,
	type TaskShape,
} from "./config.ts";
import { buildMap, formatMapPrompt, loadRepoMapConfig, sliceRelevant } from "./repo-map.ts";
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
import { DEFAULT_PERSONA, DEFAULT_REVIEW_PERSONAS, getPersona, type Persona } from "./personas.ts";
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
	conflictHunks?: Record<string, string>;
	metricsDir?: string;
	project: string;
	specMarkdown: string;
	tier?: string;
}

/** Write a merge-failure artifact via the existing .failure.json pattern
 *  (metrics.ts writeFailureArtifact), extended with the R2 merge record
 *  and the R4 scripted recovery guide. */
export function writeMergeFailureArtifact(opts: MergeFailureInfo): void {
	if (!opts.metricsDir) return;
	try {
		const artifact = buildFailureArtifact({
			kind: "parallel",
			specHash: hashSpec(opts.specMarkdown),
			tier: opts.tier,
			cause: opts.cause,
			merge: {
				workspaces: opts.workspaces,
				dangling_commit_ids: opts.danglingCommitIds,
				conflicted_files: opts.conflictedFiles,
				conflict_hunks: opts.conflictHunks,
			},
			// R4: recovery happens on the USER's repo, scripted from the
			// artifact — the guide travels with it.
			recovery: buildRecoveryGuide(opts),
		});
		writeFailureArtifact(artifact, { metricsDir: opts.metricsDir, project: opts.project });
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
export function isFinalizationIncomplete(progress: ChecklistProgress | null): boolean {
	return progress !== null && progress.total > 0 && progress.done >= progress.total;
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
	return progresses.length > 0 && progresses.every(isFinalizationIncomplete) ? "merge" : "abort";
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
			["log", "-r", "@-", "-T", "commit_id", "--no-graph", "--ignore-working-copy"],
			workspaceDir,
			opts,
		);
		return id.code === 0 && /^[0-9a-f]{40}$/.test(id.stdout.trim()) ? id.stdout.trim() : null;
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
	workspaces: Array<{ name: string; commit_id: string; rescue_commit_id?: string }>;
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
			summary: "worker aborted during finalization (no yield payload)",
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
			if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")) continue;
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
 * original failure. Exported for the hermetic test (real jj on a temp
 * repo).
 */
export async function rescueAbortedWorkBestEffort(cwd: string, err: unknown): Promise<void> {
	try {
		const status = await execJj(["status"], cwd);
		if (status.code !== 0 || /has no changes/i.test(status.stdout)) return;
		const cause = err instanceof Error ? err.message.slice(0, 140) : "unknown cause";
		await execJj(["commit", "-m", `rescue: aborted task run (${cause})`], cwd);
	} catch {
		// Best effort — the original failure propagates regardless.
	}
}

/**
 * Best-effort failure artifact: write the run's failure state to
 * <metricsDir>/<project>/<run_id>.failure.json when a worker, review, or
 * parallel run dies without a manifest, so timeouts and aborts are
 * inspectable after the fact. Reads the structured `diagnostics` the
 * worker/review rejections carry (worker.ts buildAbortError). Swallows
 * write errors — never masks the original failure.
 */
function writeFailureArtifactBestEffort(opts: {
	err: unknown;
	kind: "worker" | "review" | "parallel";
	metricsDir?: string;
	project: string;
	specMarkdown: string;
	tier?: string;
}): void {
	if (!opts.metricsDir) return;
	try {
		const d = (opts.err as { diagnostics?: WorkerFailureDiagnostics }).diagnostics;
		const artifact = buildFailureArtifact({
			kind: opts.kind,
			specHash: hashSpec(opts.specMarkdown),
			tier: opts.tier,
			cause: d?.cause ?? (opts.err instanceof Error ? opts.err.message : String(opts.err)),
			turns: d?.turns,
			idleMs: d?.idleMs,
			lastTool: d?.lastTool,
			stderrTail: d?.stderrTail,
		});
		writeFailureArtifact(artifact, { metricsDir: opts.metricsDir, project: opts.project });
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
	systemPrompt?: string;
	/** When set, worker starts on this model and swaps to the execute
	 *  model on its first edit (prewalk). Auto-skipped if == execute model. */
	prewalkModel?: string;
	/** Model the worker runs on after the prewalk swap. Defaults to model. */
	executeModel?: string;
	/** Called when a prewalk model swap fires. */
	onSwap?: (info: SwapInfo) => void;
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
	signal?: AbortSignal;
	/** Per-command timeout for verification (ms). Default: 10 min. */
	verificationTimeoutMs?: number;
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
	/** Enable forked adversarial review + bounded fix loop (single-worker).
	 *  Default: false — the pre-Phase-7 verify-once path, unchanged. The
	 *  task.toml budget wiring is Phase 10; this is the per-call switch. */
	review?: boolean;
	/** Reviewer model (when review enabled). Default: the execute model. */
	reviewModel?: string;
	/** Reviewer persona name (when review enabled). Unset → the DEFAULT
	 *  two-axis review (standards + spec-fidelity, run as parallel forks);
	 *  a single name (e.g. "survey-reviewer" for /survey dispatches, or
	 *  "adversarial") overrides the set. */
	persona?: string;
	/** The run-pipeline SHAPE (resolved by the task tool from its `shape`
	 *  param / the tier's default): the phase structure, swap policy, model
	 *  slots, and review axes. Default: the built-in code shape. */
	shape?: TaskShape;
	/** Max fix workers the loop may dispatch (when review enabled). Default: 2. */
	maxFixIterations?: number;
	/** Budget tier label for the manifest (Phase 10). Orchestrator does
	 *  not interpret it — the task tool passes the resolved tier so
	 *  persisted manifests carry config.budget. Direct executeTask callers
	 *  may omit it (manifests then say "default"). */
	budget?: string;
	/** Directory for persisted run manifests. When unset, the manifest is
	 *  built in-memory only (TaskResult.manifest) and nothing is written. */
	metricsDir?: string;
	/**
	 * Worker sandbox policy ([sandbox] vocabulary, config/task.toml).
	 * Omitted → the built-in defaults (same shape as loadTaskConfig with no
	 * file — sandbox enabled). Resolved ONCE per run: when enabled the host
	 * is probed with a real user-namespace call (probeBwrapAvailability); a
	 * probe failure degrades this run to plain spawns with ONE actionable
	 * warning.
	 */
	sandbox?: SandboxConfig;
	/**
	 * AI commit identity (todo #84): worker commits are authored as
	 * aiAuthorName / aiAuthorEmail ("{model}" in the name is replaced with
	 * the execute model's short name). Omitted → the built-in defaults
	 * ("Pi ({model})" / noreply@danong.dev). The user's own commits keep
	 * their identity — the override is worker-scoped (JJ_CONFIG in the
	 * worker env) and the parallel merge target (createAiTaskBase).
	 */
	aiAuthorName?: string;
	aiAuthorEmail?: string;
	/** Project name for the manifest path (<metricsDir>/<project>/...).
	 *  Default: the cwd basename. */
	project?: string;
	/** Preserve worker session traces next to the manifest (benchmark mode;
	 *  requires metricsDir). Implies the worker persists its session. */
	preserveSessions?: boolean;
	onUpdate?: (partial: unknown) => void;
	/** Wall-clock run-lifecycle timestamps + pre-dispatch main-session spend
	 *  (R1). The task tool records received_at + main_session_tokens when the
	 *  tool call starts (main-session tokens read via sessionManager); direct
	 *  callers may omit them (manifest fields then absent/zero — backward
	 *  compatible). dispatched_at/completed_at are stamped by the orchestrator. */
	receivedAt?: string;
	mainSessionTokens?: number;
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
	/** True when a requested review was skipped: review is single-worker
	 *  only, and a parallel run ignores the flag and verifies only. Set when
	 *  opts.review is true on a parallel run. */
	reviewSkipped?: boolean;
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
				const err = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
				const timedOut = err?.code === "ETIMEDOUT" || (err?.killed === true && err.signal === "SIGTERM");
				const exitCode = !err ? 0 : timedOut ? 124 : typeof err.code === "number" ? err.code : 1;
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
		buckets[index % parallel].push(`- ${req}`);
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

/**
 * Build the fix-worker prompt from the verification failures + P0/P1
 * findings. Pure — tested hermetically. The fix worker makes the changes and
 * yields; the orchestrator then re-verifies and re-reviews.
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
			.map((f) => `### \`${f.command}\` (exit ${f.exitCode})\n\`\`\`\n${f.output}\n\`\`\``)
			.join("\n\n");
		parts.push(`## Verification failures\n${failText}`);
	}
	if (opts.findings.length > 0) {
		const findText = opts.findings
			.map((f) => `- [${f.priority}] (${f.category}) ${f.file}: ${f.description} — verify: ${f.verification}`)
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
			["log", "-r", rev, "--no-graph", "-T", "commit_id", "--ignore-working-copy"],
			{ cwd },
			(error, stdout) => {
				if (error) reject(new Error(`jj log -r ${rev} failed: ${error.message}`));
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
			["diff", "--from", fromRev, "--to", "@-", "--git", "--ignore-working-copy"],
			{ cwd, maxBuffer: MAX_OUTPUT_BYTES },
			(error, stdout) => {
				if (error) reject(new Error(`jj diff --from ${fromRev} failed: ${error.message}`));
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
export function parseDiffStat(diff: string): { insertions: number; deletions: number } {
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
	shape: string;
	reviewForked: boolean;
	budget?: string;
	worker: WorkerResult;
	workerDurationMs: number;
	totalDurationMs: number;
	swapTurn: number | null;
	verification: VerificationResult;
	review: ReviewMetricsInput | null;
	fixLoop: { iterations: number; costUsd: number };
	/** Whether the worker sandbox was ACTIVE for this run (R3). */
	sandbox?: boolean;
	/** Run-lifecycle timestamps (R1): dispatched_at (worker spawn) and the
	 *  main-session pre-dispatch token spend (task tool supplies received_at
	 *  + mainSessionTokens; completed_at is stamped by finalizeMetrics). */
	receivedAt?: string;
	dispatchedAt?: string;
	completedAt?: string;
	mainSessionTokens?: number;
	/** Aggregate files changed + added/removed line counts (R1). */
	filesChanged?: string[];
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
			budget: opts.budget,
			sandbox: opts.sandbox,
		},
		phases: {
			prewalk: split.prewalk,
			execute: split.execute,
			verify: {
				passed: opts.verification.passed,
				commands: opts.verification.commands,
				duration_ms: opts.verification.duration_ms,
				source: "worker-tree",
				timed_out: opts.verification.timed_out,
			},
			review,
			fixLoop: { iterations: opts.fixLoop.iterations, cost_usd: opts.fixLoop.costUsd },
		},
		durationMs: opts.totalDurationMs,
		readDuplicationTokens: computeReadDuplication(opts.worker.reads, opts.swapTurn).tokens,
		sessionFiles: opts.sessionFiles,
		receivedAt: opts.receivedAt,
		dispatchedAt: opts.dispatchedAt,
		completedAt: opts.completedAt,
		mainSessionTokens: opts.mainSessionTokens,
		filesChanged: opts.filesChanged,
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
	project?: string;
	metricsDir?: string;
	preserveSessions?: boolean;
	worker: WorkerResult;
	assemble: Omit<Parameters<typeof assembleManifest>[0], "runId" | "sessionFiles" | "completedAt">;
}): { manifest: RunManifest; manifestPath?: string } {
	const project = opts.project ?? deriveProjectName(opts.cwd);
	const runId = generateRunId();

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
	project?: string;
	metricsDir?: string;
	specMarkdown: string;
	requirements: number;
	prewalkModel: string;
	executeModel: string;
	reviewModel: string;
	budget?: string;
	/** Whether the worker sandbox was ACTIVE for this run (R3). */
	sandbox?: boolean;
	workers: WorkerResult[];
	parallelDurationMs: number;
	totalDurationMs: number;
	verification: VerificationResult;
	/** Run-lifecycle timestamps + main-session spend + diff stats (R1). */
	receivedAt?: string;
	dispatchedAt?: string;
	mainSessionTokens?: number;
	/** Aggregate files changed across the workers (R1). */
	filesChanged?: string[];
	insertions: number;
	deletions: number;
	/** R1/R4/R5 parallel-merge record (atomic combine + union ladder +
	 *  overlap classification) — written into the manifest. */
	merge?: MergeMetrics;
}): { manifest: RunManifest; manifestPath?: string } {
	const project = opts.project ?? deriveProjectName(opts.cwd);
	const manifest = buildRunManifest({
		runId: generateRunId(),
		specMarkdown: opts.specMarkdown,
		requirements: opts.requirements,
		config: {
			prewalkModel: opts.prewalkModel,
			executeModel: opts.executeModel,
			reviewModel: opts.reviewModel,
			reviewForked: false,
			budget: opts.budget,
			sandbox: opts.sandbox,
		},
		phases: {
			prewalk: null,
			execute: aggregateExecutePhase(opts.workers, opts.parallelDurationMs, opts.executeModel),
			verify: {
				passed: opts.verification.passed,
				commands: opts.verification.commands,
				duration_ms: opts.verification.duration_ms,
				source: "union-gate",
				timed_out: opts.verification.timed_out,
			},
			review: null,
			fixLoop: { iterations: 0, cost_usd: 0 },
		},
		durationMs: opts.totalDurationMs,
		readDuplicationTokens: 0,
		receivedAt: opts.receivedAt,
		dispatchedAt: opts.dispatchedAt,
		completedAt: new Date().toISOString(),
		mainSessionTokens: opts.mainSessionTokens,
		filesChanged: opts.filesChanged,
		insertions: opts.insertions,
		deletions: opts.deletions,
		merge: opts.merge,
	});
	const manifestPath = opts.metricsDir
		? writeManifest(manifest, { metricsDir: opts.metricsDir, project })
		: undefined;
	return { manifest, manifestPath };
}

// ─── Orchestrator ────────────────────────────────────────────────────

export async function executeTask(opts: ExecuteTaskOptions): Promise<TaskResult> {
	const { cwd, model, systemPrompt, signal, verificationTimeoutMs, onUpdate, onSwap } = opts;
	// R2: the merge-failure artifact targets <metricsDir>/<project>/; resolved
	// once here (the parallel path's worker-failure + merge-failure writes
	// both use these).
	const metricsDir = opts.metricsDir;
	const project = opts.project ?? deriveProjectName(cwd);
	const budget = opts.budget;
	const parallel = opts.parallel ?? 1;
	const subSpecs = opts.subSpecs && opts.subSpecs.length > 0 ? opts.subSpecs : undefined;

	// R1: the orchestrator commits task work into (single path) or squashes
	// workspace commits under (parallel path) the main working copy — user
	// work-in-progress would be silently bundled into task commits. Fail fast
	// FIRST, before spec parsing, map build, workspace creation, or worker
	// spawn (both paths).
	await assertCleanWorkingCopy(cwd);

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
	const shape = opts.shape ?? DEFAULT_TASK_SHAPES.code;
	const executeModel =
		shape.workModel === "prewalk"
			? (opts.prewalkModel ?? opts.executeModel ?? model)
			: (opts.executeModel ?? model);
	const usePrewalk =
		shape.prewalk &&
		opts.prewalkModel !== undefined &&
		isPrewalkActive(opts.prewalkModel, executeModel);
	const reviewModel =
		shape.reviewModel === "prewalk"
			? (opts.prewalkModel ?? opts.reviewModel ?? executeModel)
			: (opts.reviewModel ?? executeModel);
	// Review runs when the shape declares axes AND the tier's review flag,
	// or when an explicit persona override forces a single-axis review
	// (e.g. /survey passes review: "survey-reviewer").
	const reviewEnabled = opts.persona !== undefined || (opts.review === true && shape.review.length > 0);

	// 2a. AI commit identity (todo #84): resolve once per run — worker
	// commits (single + fix workers) and the parallel merge target are
	// authored as the AI, never as the user. "{model}" in the name resolves
	// to the execute model's short name.
	const aiName = formatAiAuthorName(
		opts.aiAuthorName ?? DEFAULT_TASK_CONFIG.defaults.aiAuthorName,
		executeModel,
	);
	const aiEmail = opts.aiAuthorEmail ?? DEFAULT_TASK_CONFIG.defaults.aiAuthorEmail;

	// 2b. Resolve the worker sandbox (R1): the option omitted → the built-in
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
	const injectMap = opts.useMap !== undefined ? opts.useMap : mapConfig.injectWorkers;
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
	const promptFor = (body: string): string => (mapPrompt ? mapPrompt + "\n\n" + body : body);

	if (parallel <= 1 && !subSpecs) {
		return executeSingle(cwd, {
			taskPrompt: promptFor(specMarkdown),
			usePrewalk,
			prewalkModel: opts.prewalkModel,
			executeModel,
			systemPrompt,
			signal,
			onSwap,
			onUpdate,
			verificationTimeoutMs,
			workerTimeoutMs: opts.workerTimeoutMs,
			toolTimeoutMs: opts.toolTimeoutMs,
			spec,
			specMarkdown,
			review: reviewEnabled,
			reviewModel,
			persona: opts.persona,
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
			receivedAt: opts.receivedAt,
			mainSessionTokens: opts.mainSessionTokens,
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

	// Worker count: sub_specs mode spawns exactly one worker per sub-spec
	// (caller-controlled, no clamp — every sub-spec is validated to have at
	// least one requirement). The mechanical fallback clamps parallel to the
	// requirement count: round-robin splitting can't give every worker at
	// least one requirement beyond that.
	const workerCount = subSpecs ? subSpecs.length : Math.min(parallel, spec.requirements.length);
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
		spawnWorkerSession({
			cwd: ws.dir,
			// Todo #89: the workspace differs from the project root — the
			// sandbox must bind the shared jj store rw or workspace commits
			// fail with EROFS.
			projectDir: cwd,
			model: usePrewalk ? opts.prewalkModel! : executeModel,
			task: promptFor(workerTasks[i]),
			systemPrompt: systemPrompt ?? DEFAULT_WORKER_SYSTEM_PROMPT,
			extensions: [
				CHECKLIST_EXTENSION_PATH,
				...(usePrewalk ? [PREWALK_EXTENSION_PATH] : []),
			],
			signal,
			sandbox,
			aiAuthorName: aiName,
			aiAuthorEmail: aiEmail,
			onUpdate: (partial) => {
				onUpdate?.({ ...partial, index: i });
				if (partial.type === "yield") {
					onUpdate?.({ type: "workers_progress", done: ++doneCount, total: workerCount });
				}
			},
			// Phase 11 (R4/R5): per-tier wall + per-tool-call budget. The
			// verification commands + grace: the wall must not kill an
			// in-flight suite run — it gets a bounded grace instead.
			timeoutMs: opts.workerTimeoutMs,
			toolTimeoutMs: opts.toolTimeoutMs,
			verificationCommands: spec.verification,
			verificationTimeoutMs: opts.verificationTimeoutMs,
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
					onSwap,
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
			onChecklist: (c) => onUpdate?.({ type: "checklist", index: i, done: c.done, total: c.total }),
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
		if (swapErrors.length > 0) throw swapErrors[0];
		const failures = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
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
				.map((r, i) => (r.status === "rejected" ? checklistCtrls[i].latest : null))
				.filter((p): p is ChecklistProgress => p !== null);
			if (classifyWorkerFailures(failedProgresses) === "merge") {
				finalizationIncompleteIndexes = settled
					.map((r, i) => (r.status === "rejected" ? i : -1))
					.filter((i) => i >= 0);
			} else {
				// Flat worker-failure path: R3 rescues each workspace's
				// uncommitted state into a rescue commit inside the preserved
				// workspace ("rescue: aborted task run (<cause>)" — the
				// artifact names where the uncommitted state lives), the
				// failure artifact records the workspaces + their @ commit ids
				// (best-effort resolution — the workers may have died mid-tool,
				// bounded by FAILURE_PATH_JJ_TIMEOUT_MS so a wedged workspace
				// never stalls the abort), and the finally block below keeps
				// the workspaces alive for scripted recovery.
				mergeFailed = new Error(message);
				const wsRecords: MergeFailureInfo["workspaces"] = [];
				for (const ws of workspaces) {
					let at = "";
					try {
						at = await workspaceCommitId(cwd, ws.name, { timeoutMs: FAILURE_PATH_JJ_TIMEOUT_MS });
					} catch {
						/* best effort */
					}
					const rescueId = await rescueWorkspaceStateBestEffort(ws.dir, message, {
						timeoutMs: FAILURE_PATH_JJ_TIMEOUT_MS,
					});
					wsRecords.push({
						name: ws.name,
						commit_id: rescueId ?? at,
						...(rescueId ? { rescue_commit_id: rescueId } : {}),
					});
				}
				writeMergeFailureArtifact({
					cause: message,
					workspaces: wsRecords,
					danglingCommitIds: [],
					conflictedFiles: [],
					metricsDir,
					project,
					specMarkdown,
					tier: budget,
				});
				throw new Error(message);
			}
		}
		results = (settled as PromiseFulfilledResult<WorkerResult>[]).map((r) => r.value);

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
				const name = workspaces[i].name;
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
				for (const name of names) diffs.push(await diffForWorkspacePath(cwd, baseChangeId, name, file));
				overlaps.push({ file, workers: names, kind: classifyOverlapDiffs(diffs) });
			}
			mergeMetrics.overlaps = overlaps.map((o) => ({ file: o.file, kind: o.kind }));
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
				await assertMerged(cwd, workspaces.map((w) => w.name), baseChangeId, {
					expectedFiles: [...expectedFiles],
				});
				// The merged base must remain a VISIBLE commit: a stale-target
				// squash can hide the whole base chain, which assertMerged's
				// re-resolution would surface only as a raw jj error (a hidden
				// change resolves to the 40-zero commit id).
				await assertVisibleCommit(cwd, baseChangeId);
			} catch (err) {
				throw new Error(`Parallel merge consistency check failed: ${(err as Error).message}`);
			}

			// R4: deterministic conflict ladder — rung 1 (jj 3-way merge) ran
			// inside the squash; rung 2 resolves every remaining conflicted
			// file with the jj-native "union" merge tool (git merge-file
			// --union). No markers remain → accept and record resolved:"union"
			// (manifest). Only files that STILL carry markers escalate
			// (LLM/manual) — with just the conflicted hunks (artifact +
			// result); the verification gate below always validates the final
			// tree.
			const conflictsBeforeUnion = await detectChangeConflicts(cwd, baseChangeId);
			if (conflictsBeforeUnion.length > 0) {
				await resolveConflictsWithUnion(cwd, baseChangeId, conflictsBeforeUnion);
				const conflictsAfterUnion = await detectChangeConflicts(cwd, baseChangeId);
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
						workspaces: workspaces.map((w) => ({
							name: w.name,
							commit_id: workspaceAtIds.get(w.name) ?? "",
						})),
						danglingCommitIds: [],
						conflictedFiles: conflictsAfterUnion,
						conflictHunks: await conflictHunks(cwd, baseChangeId, conflictsAfterUnion),
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
				danglingCommitIds: [...workspaceAtIds.values()].filter((id) => id.length > 0),
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
		// never merges or claims success without it.
		verification = await runVerification(
			spec.verification,
			cwd,
			verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS,
			signal,
		);
		if (!verification.passed && finalizationIncompleteIndexes.length > 0) {
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
				verification.failures.map((f) => `${f.command} (exit ${f.exitCode})`).join("; ");
			mergeFailed = new Error(cause);
			writeMergeFailureArtifact({
				cause,
				workspaces: workspaces.map((w) => ({
					name: w.name,
					commit_id: workspaceAtIds.get(w.name) ?? "",
				})),
				danglingCommitIds: [],
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
					console.warn(`workspace cleanup "${ws.name}": ${(err as Error).message}`);
				}
			}
		}
		const parents = new Set(workspaces.map((w) => dirname(w.dir)));
		for (const parent of parents) rmSync(parent, { recursive: true, force: true });
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
	const filesChanged = finalizationIncompleteIndexes.length > 0
		? await filesChangedBetweenBestEffort(cwd, taskBaseCommitId, baseCommitId)
		: results.flatMap((r) => r.yield.files_changed);
	const metrics = finalizeParallelMetrics({
		cwd,
		project: opts.project,
		metricsDir: opts.metricsDir,
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
		finalizationIncompleteIndexes.length > 0 && verification.passed && conflicts.length === 0
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
		...(caveat ? { caveat } : {}),
		// R7: a requested review is single-worker only — surface that it was
		// skipped (todo #73: no console.warn; the plan line and this flag
		// carry the signal).
		...(opts.review ? { reviewSkipped: true } : {}),
		manifest: metrics.manifest,
		manifestPath: metrics.manifestPath,
		durationMs: Date.now() - runStartMs,
	};
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
		prewalkModel?: string;
		executeModel: string;
		systemPrompt?: string;
		signal?: AbortSignal;
		onSwap?: (info: SwapInfo) => void;
		onUpdate?: (partial: unknown) => void;
		verificationTimeoutMs?: number;
		workerTimeoutMs?: number;
		toolTimeoutMs?: number;
		spec: Spec;
		specMarkdown: string;
		review?: boolean;
		reviewModel?: string;
		persona?: string;
		shape?: TaskShape;
		maxFixIterations?: number;
		metricsDir?: string;
		project?: string;
		preserveSessions?: boolean;
		budget?: string;
		sandbox: ResolvedSandbox;
		/** AI commit identity (todo #84) — already formatted ({model} resolved). */
		aiAuthorName?: string;
		aiAuthorEmail?: string;
		/** R1: the task tool's received_at + pre-dispatch main-session spend
		 *  (absent for direct callers — manifest fields then absent/zero). */
		receivedAt?: string;
		mainSessionTokens?: number;
	},
): Promise<TaskResult> {
	const {
		taskPrompt, usePrewalk, prewalkModel, executeModel, systemPrompt, signal, onSwap, onUpdate,
		verificationTimeoutMs, workerTimeoutMs, toolTimeoutMs, spec, specMarkdown, review, reviewModel,
		persona, shape, maxFixIterations, metricsDir, project, preserveSessions, budget, sandbox,
		aiAuthorName, aiAuthorEmail,
	} = opts;

	const workerSystemPrompt = systemPrompt ?? DEFAULT_WORKER_SYSTEM_PROMPT;
	const workerExtensions = [CHECKLIST_EXTENSION_PATH, ...(usePrewalk ? [PREWALK_EXTENSION_PATH] : [])];
	const verifyTimeout = verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;

	// The worker persists a session when the reviewer forks it (review) or when
	// traces are preserved (benchmark mode). The orchestrator owns the scratch
	// dir and cleans it up in finally.
	const sessionDir = review || preserveSessions ? mkdtempSync(join(tmpdir(), "pi-task-session-")) : undefined;

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
	if (aiAuthorName.trim().length > 0 && aiAuthorEmail.trim().length > 0) {
		identityDir = mkdtempSync(join(tmpdir(), "pi-task-identity-"));
		identityFile = join(identityDir, "jj-identity.toml");
		writeFileSync(identityFile, aiIdentityToml(aiAuthorName, aiAuthorEmail), "utf-8");
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
		const session = spawnWorkerSession({
			cwd,
			model: usePrewalk ? prewalkModel! : executeModel,
			task: taskPrompt,
			systemPrompt: workerSystemPrompt,
			extensions: workerExtensions,
			sessionDir,
			signal,
			sandbox,
			aiAuthorName,
			aiAuthorEmail,
			onUpdate,
			// Phase 11 (R4/R5): per-tier wall + per-tool-call budget. The
			// verification commands + grace: the wall must not kill an
			// in-flight suite run — it gets a bounded grace instead.
			timeoutMs: workerTimeoutMs,
			toolTimeoutMs,
			verificationCommands: spec.verification,
			verificationTimeoutMs,
		});
		// Checklist relay (R4): streams the worker's real checklist state to the
		// progress view via the existing worker event stream — observer-only,
		// zero LLM tokens, worker-side semantics unchanged.
		const checklistCtrl = attachChecklistRelay(session, {
			onChecklist: (c) => onUpdate?.({ type: "checklist", done: c.done, total: c.total }),
		});

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
			if (swapError) throw swapError;
			// R2 (third outcome): finalization-incomplete — the checklist relay
			// showed ALL requirements done at abort, so the worker committed
			// everything and was verifying/yielding when it was killed. Rescue
			// any uncommitted tail first (a dirty WC would otherwise fail the
			// gate), then run verification on the committed tree post-abort:
			// pass → success-with-caveat (the worker's commit ids); fail → the
			// current failure path below. Never claim success without the
			// verification gate.
			if (isFinalizationIncomplete(checklistCtrl.latest)) {
				await rescueAbortedWorkBestEffort(cwd, err);
				const verification = await runVerification(spec.verification, cwd, verifyTimeout, signal);
				if (verification.passed) {
					// The worker's commits: the range baseCommit..@- (the worker
					// never yielded, so the payload's commit_ids are unavailable).
					// Empty working-copy commits are filtered out — the identity
					// restore in the finally abandons them anyway.
					let commitIds: string[] = [];
					const ids = await execJj(
						[
							"log", "-r", `${baseCommit}..@-`, "--no-graph",
							"-T", "if(empty, '', commit_id)", "--ignore-working-copy",
						],
						cwd,
					);
					if (ids.code === 0) {
						commitIds = ids.stdout.split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/.test(l));
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
						cwd, project, metricsDir, preserveSessions, worker,
						assemble: {
							specMarkdown,
							requirements: spec.requirements.length,
							prewalkModel: usePrewalk ? prewalkModel! : executeModel,
							executeModel,
							reviewModel: reviewModel ?? executeModel,
							reviewForked: false,
				shape: shape?.name ?? "code",
							budget,
							sandbox: sandbox.active,
							worker, workerDurationMs: Date.now() - workerStartMs,
							totalDurationMs: Date.now() - runStartMs,
							swapTurn,
							verification,
							review: null,
							fixLoop: { iterations: 0, costUsd: 0 },
							receivedAt: opts.receivedAt,
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
						manifestPath: metrics.manifestPath,
						durationMs: Date.now() - runStartMs,
						caveat:
							`worker aborted during finalization; verified post-merge — ` +
							`${commitIds.length} commit(s): ${commitIds.join(", ") || "(none)"}`,
					};
				}
			}
			// The current failure path: keep the aborted worker's WIP —
			// rescue-commit a dirty working copy ("rescue:" prefix) so the work
			// survives in history and the next run starts from a clean copy.
			// Best effort — never masks the original failure.
			await rescueAbortedWorkBestEffort(cwd, err);
			writeFailureArtifactBestEffort({
				err,
				kind: "worker",
				metricsDir,
				project,
				specMarkdown,
				tier: budget,
			});
			throw err;
		} finally {
			prewalkCtrl?.detach();
			checklistCtrl.detach();
		}
		const workerDurationMs = Date.now() - workerStartMs;

		// ── Review disabled: unchanged verify-once path (plus metrics) ──
		if (!review) {
			const verification = await runVerification(spec.verification, cwd, verifyTimeout, signal);
			// R1 diff stats: the worker's commits are baseCommit..@- (the worker
			// leaves @ as an empty working-copy commit after its last `jj commit`).
			const diffStat = await computeDiffStatBestEffort(cwd, baseCommit);
			const metrics = finalizeMetrics({
				cwd, project, metricsDir, preserveSessions, worker,
				assemble: {
					specMarkdown,
					requirements: spec.requirements.length,
					prewalkModel: usePrewalk ? prewalkModel! : executeModel,
					executeModel,
					reviewModel: reviewModel ?? executeModel,
					reviewForked: false,
				shape: shape?.name ?? "code",
					budget,
					sandbox: sandbox.active,
					worker, workerDurationMs,
					totalDurationMs: Date.now() - runStartMs,
					swapTurn,
					verification,
					review: null,
					fixLoop: { iterations: 0, costUsd: 0 },
					receivedAt: opts.receivedAt,
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
				manifest: metrics.manifest,
				manifestPath: metrics.manifestPath,
				durationMs: Date.now() - runStartMs,
			};
		}

		// ── Review + bounded fix loop ──
		const sessionFile = worker.sessionFile;
		if (!sessionFile) {
			throw new Error("review enabled but the worker did not persist a session (no sessionFile)");
		}
		const maxFixes = Math.max(0, maxFixIterations ?? 2);
		// The review axes: an explicit persona (single — e.g. /survey
		// dispatches pass "survey-reviewer" to validate the report artifact)
		// or the DEFAULT two-axis set (standards + spec-fidelity), each run
		// as its own parallel fork so neither pollutes the other. Findings
		// merge, verdict = worst, requirements = worst per id.
		// The review axes come from the SHAPE (its review list — the analysis
		// shape is empty and relies on an explicit persona like
		// survey-reviewer), ANDed with the tier's review flag upstream
		// (reviewEnabled); an explicit persona overrides to a single axis.
		const shapeAxes = (shape ?? DEFAULT_TASK_SHAPES.code).review;
		const reviewAxes = persona
			? [getPersona(persona) ?? DEFAULT_PERSONA]
			: shapeAxes.map((n) => getPersona(n)).filter((p): p is Persona => p !== undefined);
		const effectiveAxes = reviewAxes.length > 0 ? reviewAxes : [DEFAULT_PERSONA];
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
			verification = await runVerification(spec.verification, cwd, verifyTimeout, signal);
			// 8b. Forked adversarial review (inherits the worker's pruned context).
			// The progress view keys its work → review transition off this event.
			onUpdate?.({ type: "review_start" });
			let outcomes: Array<{ result: ReviewResult; usage: { cost_usd: number } }>;
			try {
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
							signal,
							onUpdate,
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
					metricsDir,
					project,
					specMarkdown,
					tier: budget,
				});
				throw err;
			}
			const merged = mergeReviewOutcomes(outcomes);
			reviewResult = merged.result;
			reviewCostUsd += merged.costUsd;
			// 8c. Ship / fix / escalate
			decision = decideFixLoop({ testsPass: verification.passed, review: reviewResult, fixesUsed, maxFixes });
			onUpdate?.({ type: "review", verdict: reviewResult.verdict, findings: reviewResult.findings.length, decision });
			if (decision !== "fix") break;

			// 8d. Dispatch a fix worker for the P0/P1 blockers + failing tests
			const fixPrompt = buildFixPrompt({ specMarkdown, failures: verification.failures, findings: blockersOf(reviewResult) });
			const fixSession = spawnWorkerSession({
				cwd,
				model: executeModel,
				task: fixPrompt,
				systemPrompt: workerSystemPrompt,
				extensions: [CHECKLIST_EXTENSION_PATH],
				signal,
				sandbox,
				aiAuthorName,
				aiAuthorEmail,
				onUpdate,
				// Phase 11 (R4/R5): the same per-tier wall + per-tool-call budget.
				timeoutMs: workerTimeoutMs,
				toolTimeoutMs,
			});
			const fixResult = await fixSession.result
				.catch((err: unknown) => {
					writeFailureArtifactBestEffort({
						err,
						kind: "worker",
						metricsDir,
						project,
						specMarkdown,
						tier: budget,
					});
					throw err;
				});
			fixesUsed++;
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
			cwd, project, metricsDir, preserveSessions, worker,
			assemble: {
				specMarkdown,
				requirements: spec.requirements.length,
				prewalkModel: usePrewalk ? prewalkModel! : executeModel,
				executeModel,
				reviewModel: rModel,
				reviewForked: true,
				shape: shape?.name ?? "code",
				budget,
				sandbox: sandbox.active,
				worker, workerDurationMs,
				totalDurationMs: Date.now() - runStartMs,
				swapTurn,
				verification,
				review: reviewResult ? { result: reviewResult, costUsd: reviewCostUsd, personas: effectiveAxes.map((p) => p.name) } : null,
				fixLoop: { iterations: fixesUsed + 1, costUsd: fixesCostUsd },
				receivedAt: opts.receivedAt,
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
			review: reviewResult ?? undefined,
			fixLoop: { iterations: fixesUsed + 1, fixesDispatched: fixesUsed },
			manifest: metrics.manifest,
			manifestPath: metrics.manifestPath,
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
					await execJj(["log", "-r", "@-", "-T", "if(empty, 'EMPTY', 'X')", "--no-graph"], cwd)
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
