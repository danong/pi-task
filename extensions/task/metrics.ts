/**
 * RunManifest — structured per-run metrics (Phase 8).
 *
 * Every executeTask run produces a manifest: config (embedded so A/B
 * comparison is trivial), per-phase metrics, and totals. The shape follows
 * docs/pi-task-design.md → Metrics. buildRunManifest() is pure assembly from
 * pre-computed phase data (the orchestrator computes the phases via
 * splitPhases/computeReadDuplication and passes them in); collection is
 * external — workers don't know they're being measured.
 *
 * Approximations (documented, validation-grade not exact):
 * - read_duplication_tokens: ≈ content-length/4 of files read in both the
 *   prewalk and execute phases (see computeReadDuplication, Phase 8 chunk 3).
 * - Wall-clock run lifecycle: received_at/dispatched_at/completed_at ISO
 *   timestamps plus main_session_tokens (the main agent's pre-dispatch
 *   spend) are supplied by the task tool + orchestrator; direct callers
 *   that omit them get absent/zero values (backward compatible).
 * - totals.insertions/deletions: line counts parsed from `jj diff --git`
 *   over the task base..head range (added/removed lines, hunk headers
 *   excluded — see orchestrator.ts parseDiffStat); totals.files_changed is
 *   the union of the workers' schema-validated yield lists.
 * - config.budget is the resolved budget tier (Phase 10); it falls back to
 *   "default" when a direct executeTask caller omits the label.
 * - Parallel runs produce ONE aggregate manifest: phases.execute SUMS
 *   per-worker usage/reads via aggregateExecutePhase (wall-time duration),
 *   with prewalk/review null and fixLoop zero (see orchestrator.ts).
 */

import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Finding } from "./schemas/findings.ts";
import type { ReadRecord, WorkerResult, WorkerUsage } from "./worker.ts";

// ─── Types (per design doc) ──────────────────────────────────────────

export interface PhaseMetrics {
	model: string;
	turns: number;
	tokens_in: number;
	tokens_out: number;
	reads: number;
	edits: number;
	duration_ms: number;
	cost_usd: number;
}

export interface VerifyPhaseMetrics {
	passed: boolean;
	commands: number;
	duration_ms: number;
	/** Where verification ran: "worker-tree" (single-worker, post-yield,
	 *  on the worker's commits) | "union-gate" (parallel, post-merge, on
	 *  the merged tree). A run that died before either produces a failure
	 *  artifact, not a manifest — so "unverified" is never written. */
	source: "worker-tree" | "union-gate";
	/** True when a command was killed by its timeout (exit 124). */
	timed_out?: boolean;
}

export interface ReviewPhaseMetrics {
	model: string;
	forked: boolean;
	context_inherited_tokens: number;
	findings: number;
	by_priority: Record<string, number>;
	cost_usd: number;
}

export interface FixLoopPhaseMetrics {
	iterations: number;
	cost_usd: number;
}

/**
 * Parallel-merge record (R1/R4/R5): how the worker commits combined and
 * how conflicts were settled. Present on parallel runs (empty arrays when
 * nothing happened); absent for single-worker runs and direct callers
 * that don't supply it (backward compatible).
 */
export interface MergeMetrics {
	/** Files whose conflicts were resolved deterministically by the union
	 *  merge tool (jj resolve --tool union, git merge-file --union). */
	resolved_union: string[];
	/** Files still conflicted after the union ladder — escalated. */
	conflicts: string[];
	/** Pre-merge overlap classification (R5): files changed by ≥2 workers,
	 *  each marked comment-only (union-safe) or substantive (flagged). */
	overlaps: Array<{ file: string; kind: "comment-only" | "substantive" }>;
}

export interface MetricsConfig {
	budget: string;
	prewalk_model: string;
	execute_model: string;
	review_model: string;
	swap_trigger: string;
	checklist: boolean;
	review_forked: boolean;
	/** Effective worker sandbox state (R3): enabled AND the host probe passed. */
	sandbox: boolean;
}

export interface RunManifest {
	run_id: string;
	/** Wall-clock timestamps of the run lifecycle (ISO strings, task tool +
	 *  orchestrator). Absent when a direct caller doesn't supply them —
	 *  backward compatible. received_at: task tool execute starts;
	 *  dispatched_at: worker session spawns; completed_at: run finishes. */
	received_at?: string;
	dispatched_at?: string;
	completed_at?: string;
	/** Main-session tokens consumed before the task call (the main agent's
	 *  cumulative spend at dispatch — the worker phases are separate).
	 *  Absent (0) when not supplied. */
	main_session_tokens?: number;
	config: MetricsConfig;
	task: { spec_hash: string; requirements: number };
	phases: {
		prewalk: PhaseMetrics | null;
		execute: PhaseMetrics;
		verify: VerifyPhaseMetrics;
		review: ReviewPhaseMetrics | null;
		fix_loop: FixLoopPhaseMetrics;
	};
	/** Parallel-merge record (R1/R4/R5) — see MergeMetrics. Absent when not
	 *  supplied (single-worker runs, direct callers). */
	merge?: MergeMetrics;
	totals: {
		cost_usd: number;
		duration_ms: number;
		read_duplication_tokens: number;
		session_files: string[];
		/** Aggregate files changed across the run's worker commits (the
		 *  workers' schema-validated yield lists, unioned). Empty when not
		 *  supplied. */
		files_changed: string[];
		/** Added/removed line counts from the worker commit diffs (parsed from
		 *  `jj diff --git` over the task base..head range). 0 when not supplied. */
		insertions: number;
		deletions: number;
	};
}

// ─── Pure helpers ────────────────────────────────────────────────────

/** Short stable hash of the spec markdown (first 12 hex chars of sha256). */
export function hashSpec(specMarkdown: string): string {
	return createHash("sha256").update(specMarkdown).digest("hex").slice(0, 12);
}

/**
 * Run id: a UTC timestamp slug plus a short random suffix, e.g.
 * "20260802T1730-a3f2" — sortable by time, unique per run. `now` is
 * injectable for deterministic tests.
 */
export function generateRunId(now: Date = new Date()): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	const slug =
		`${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
		`T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
	return `${slug}-${randomBytes(2).toString("hex")}`;
}

/** Count findings by priority, e.g. { P0: 1, P1: 2, P2: 1 }. */
export function countByPriority(findings: Finding[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const f of findings) {
		counts[f.priority] = (counts[f.priority] ?? 0) + 1;
	}
	return counts;
}

// ─── Assembly ────────────────────────────────────────────────────────

export interface BuildManifestInput {
	specMarkdown: string;
	requirements: number;
	config: {
		prewalkModel: string;
		executeModel: string;
		reviewModel: string;
		reviewForked: boolean;
		/** Resolved budget tier label (Phase 10); "default" when omitted by the caller. */
		budget?: string;
		swapTrigger?: string;
		checklist?: boolean;
		/** Effective sandbox state — enabled AND probe passed (R3); false when a
		 *  direct caller omits it. */
		sandbox?: boolean;
	};
	phases: {
		prewalk: PhaseMetrics | null;
		execute: PhaseMetrics;
		verify: VerifyPhaseMetrics;
		review: ReviewPhaseMetrics | null;
		fixLoop: FixLoopPhaseMetrics;
	};
	durationMs: number;
	readDuplicationTokens: number;
	sessionFiles?: string[];
	/** Wall-clock timestamps (R1): received_at (task tool execute starts),
	 *  dispatched_at (worker session spawns), completed_at (run finishes).
	 *  Optional — absent/undefined when a direct caller doesn't supply them,
	 *  so existing callers and tests pass unchanged. */
	receivedAt?: string;
	dispatchedAt?: string;
	completedAt?: string;
	/** Main-session tokens consumed before the task call (0 when not supplied). */
	mainSessionTokens?: number;
	/** Aggregate files changed across the run's worker commits ([] when not
	 *  supplied). */
	filesChanged?: string[];
	/** Added/removed line counts from the worker commit diffs (0 when not
	 *  supplied). */
	insertions?: number;
	deletions?: number;
	/** Parallel-merge record (R1/R4/R5): resolved_union, remaining
	 *  conflicts, and the pre-merge overlap classification. Absent when not
	 *  supplied (single-worker runs, direct callers). */
	merge?: MergeMetrics;
	/** Override the generated run id (deterministic tests). */
	runId?: string;
	now?: Date;
}

/**
 * Assemble a RunManifest from pre-computed phase data. totals.cost_usd is
 * the sum of every phase's cost; everything else is passed through with
 * config defaults filled in. Pure.
 */
export function buildRunManifest(input: BuildManifestInput): RunManifest {
	const { prewalk, execute, review, fixLoop } = input.phases;
	const totalCost =
		(prewalk?.cost_usd ?? 0) + execute.cost_usd + (review?.cost_usd ?? 0) + fixLoop.cost_usd;

	return {
		run_id: input.runId ?? generateRunId(input.now),
		config: {
			budget: input.config.budget ?? "default",
			prewalk_model: input.config.prewalkModel,
			execute_model: input.config.executeModel,
			review_model: input.config.reviewModel,
			swap_trigger: input.config.swapTrigger ?? "first-edit",
			checklist: input.config.checklist ?? true,
			review_forked: input.config.reviewForked,
			sandbox: input.config.sandbox ?? false,
		},
		task: {
			spec_hash: hashSpec(input.specMarkdown),
			requirements: input.requirements,
		},
		phases: {
			prewalk,
			execute,
			verify: input.phases.verify,
			review,
			fix_loop: fixLoop,
		},
		totals: {
			cost_usd: totalCost,
			duration_ms: input.durationMs,
			read_duplication_tokens: input.readDuplicationTokens,
			session_files: input.sessionFiles ?? [],
			files_changed: input.filesChanged ?? [],
			insertions: input.insertions ?? 0,
			deletions: input.deletions ?? 0,
		},
		merge: input.merge,
		received_at: input.receivedAt,
		dispatched_at: input.dispatchedAt,
		completed_at: input.completedAt,
		main_session_tokens: input.mainSessionTokens ?? 0,
	};
}

/**
 * Aggregate a parallel run's execute phase into ONE PhaseMetrics (R6):
 * per-worker usage/reads are SUMMED (turns, tokens in/out, cost, reads
 * count, edits). duration_ms is the parallel phase's WALL time — workers
 * run concurrently, so summing their durations would overstate the phase
 * (the orchestrator passes the measured wall time instead). Aggregate
 * approximation: no per-worker manifests; `model` is the shared execute
 * model. Pure — hermetic-testable with fake WorkerResults.
 */
export function aggregateExecutePhase(
	workers: Array<Pick<WorkerResult, "usage" | "reads">>,
	durationMs: number,
	model: string,
): PhaseMetrics {
	let turns = 0;
	let tokensIn = 0;
	let tokensOut = 0;
	let reads = 0;
	let edits = 0;
	let costUsd = 0;
	for (const w of workers) {
		turns += w.usage.turns;
		tokensIn += w.usage.tokens_in;
		tokensOut += w.usage.tokens_out;
		reads += w.usage.reads;
		edits += w.usage.edits;
		costUsd += w.usage.cost_usd;
	}
	return {
		model,
		turns,
		tokens_in: tokensIn,
		tokens_out: tokensOut,
		reads,
		edits,
		duration_ms: durationMs,
		cost_usd: costUsd,
	};
}

// ─── Phase split + read duplication (Phase 8) ─────────────────────────

export interface PhaseSplit {
	prewalk: PhaseMetrics | null;
	execute: PhaseMetrics;
}

function zeroUsage(): WorkerUsage {
	return { turns: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0, reads: 0, edits: 0 };
}

/** Per-field diff of two cumulative usage snapshots (b − a), floored at 0. */
function diffUsage(a: WorkerUsage, b: WorkerUsage): WorkerUsage {
	return {
		turns: Math.max(0, b.turns - a.turns),
		tokens_in: Math.max(0, b.tokens_in - a.tokens_in),
		tokens_out: Math.max(0, b.tokens_out - a.tokens_out),
		cache_read: Math.max(0, b.cache_read - a.cache_read),
		cache_write: Math.max(0, b.cache_write - a.cache_write),
		cost_usd: Math.max(0, b.cost_usd - a.cost_usd),
		reads: Math.max(0, b.reads - a.reads),
		edits: Math.max(0, b.edits - a.edits),
	};
}

function phaseFrom(model: string, usage: WorkerUsage, turns: number, reads: number, durationMs: number): PhaseMetrics {
	return {
		model,
		turns,
		tokens_in: usage.tokens_in,
		tokens_out: usage.tokens_out,
		reads,
		edits: usage.edits,
		duration_ms: durationMs,
		cost_usd: usage.cost_usd,
	};
}

/**
 * Split a worker run into prewalk and execute phase metrics at the swap
 * turn (the swap fires on the first edit; that turn belongs to prewalk).
 * `turnUsage` are per-turn CUMULATIVE snapshots (WorkerResult.turnUsage);
 * `reads` carry the turn they completed on (WorkerResult.reads). With no
 * swap, prewalk is null and everything is execute. Durations are split
 * proportionally to turns (documented approximation). Pure.
 */
export function splitPhases(opts: {
	turnUsage: WorkerUsage[];
	reads: ReadRecord[];
	swapTurn: number | null;
	prewalkModel: string;
	executeModel: string;
	totalDurationMs: number;
}): PhaseSplit {
	const { turnUsage, reads, swapTurn, prewalkModel, executeModel, totalDurationMs } = opts;
	const totalTurns = turnUsage.length;
	const final = turnUsage[totalTurns - 1] ?? zeroUsage();

	// Reads split by phase boundary (a read with turn <= swapTurn is prewalk).
	const hasSplit = swapTurn !== null && swapTurn > 0 && totalTurns > 0;
	const prewalkReads = hasSplit ? reads.filter((r) => r.turn <= swapTurn) : [];
	const executeReads = hasSplit ? reads.filter((r) => r.turn > swapTurn) : reads;

	if (!hasSplit) {
		return {
			prewalk: null,
			execute: phaseFrom(executeModel, final, totalTurns, executeReads.length, totalDurationMs),
		};
	}

	const prewalkTurns = Math.min(swapTurn, totalTurns);
	const prewalkSnapshot = turnUsage[prewalkTurns - 1] ?? zeroUsage();
	const executeTurns = totalTurns - prewalkTurns;
	const prewalkDuration = Math.round((totalDurationMs * prewalkTurns) / Math.max(1, totalTurns));
	const executeDuration = totalDurationMs - prewalkDuration;
	const executeUsage = executeTurns > 0 ? diffUsage(prewalkSnapshot, final) : zeroUsage();

	return {
		prewalk: phaseFrom(prewalkModel, prewalkSnapshot, prewalkTurns, prewalkReads.length, prewalkDuration),
		execute: phaseFrom(executeModel, executeUsage, executeTurns, executeReads.length, executeDuration),
	};
}

export interface ReadDuplication {
	tokens: number;
	files: string[];
}

/**
 * Read duplication between the prewalk and execute phases: files read in
 * both, with tokens = the EXECUTE-phase reads' approxTokens for duplicated
 * files (the re-read cost the prewalk was supposed to save). Approximate —
 * approxTokens is content-length/4. Pure.
 */
export function computeReadDuplication(reads: ReadRecord[], swapTurn: number | null): ReadDuplication {
	if (swapTurn === null || swapTurn <= 0) return { tokens: 0, files: [] };
	const prewalkPaths = new Set<string>();
	const duplicatedFiles = new Set<string>();
	let tokens = 0;
	for (const r of reads) {
		if (!r.path) continue;
		if (r.turn <= swapTurn) {
			prewalkPaths.add(r.path);
		} else if (prewalkPaths.has(r.path)) {
			tokens += r.approxTokens;
			duplicatedFiles.add(r.path);
		}
	}
	return { tokens, files: [...duplicatedFiles].sort() };
}

/**
 * Approximate the context a forked reviewer inherits: the worker's final
 * turn's input-token delta (the last full context size sent). Pure.
 */
export function contextInheritedTokens(turnUsage: WorkerUsage[]): number {
	if (turnUsage.length === 0) return 0;
	if (turnUsage.length === 1) return turnUsage[0].tokens_in;
	return Math.max(0, turnUsage[turnUsage.length - 1].tokens_in - turnUsage[turnUsage.length - 2].tokens_in);
}

// ─── Storage (Phase 8) ───────────────────────────────────────────────
// The production default results dir (~/.pi/agent/results/) is DATA, not
// config — it must be gitignored. Callers (and tests) pass a metricsDir
// explicitly; Phase 9's task tool supplies the real one.

/** Derive the project name from the working directory basename. */
export function deriveProjectName(cwd: string): string {
	const name = basename(cwd);
	return name && name !== "/" ? name : "unknown";
}

/**
 * Write a manifest to <metricsDir>/<project>/<run_id>.json atomically
 * (tmp file + rename, so a crash never leaves a partial manifest). Returns
 * the written path.
 */
export function writeManifest(manifest: RunManifest, opts: { metricsDir: string; project: string }): string {
	const dir = join(opts.metricsDir, opts.project);
	mkdirSync(dir, { recursive: true });
	const target = join(dir, `${manifest.run_id}.json`);
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
	renameSync(tmp, target);
	return target;
}

// ─── Failure artifacts (todo #86) ────────────────────────────────────

/**
 * The failure-state record written when a worker/review/parallel run dies
 * WITHOUT a manifest — so timeouts and aborts are inspectable after the
 * fact (a failed run currently leaves no trace: no manifest, no session
 * file). Written best-effort; never masks the original failure.
 */
export interface FailureArtifact {
	run_id: string;
	kind: "worker" | "review" | "parallel";
	timestamp: string;
	spec_hash?: string;
	tier?: string;
	cause: string;
	turns?: number;
	idle_ms?: number;
	last_tool?: { name: string; args: string } | null;
	stderr_tail?: string;
	/** Merge-failure record (R2): present when a parallel run's merge path
	 *  fails or escalates — names the worker workspaces (NEVER forgotten on
	 *  merge failure), the dangling worker commit ids, and the conflicted
	 *  files, so recovery is scripted rather than LLM-discovered. */
	merge?: MergeFailureRecord;
}

/**
 * The merge-failure record (R2): workspace names + their working-copy
 * commit ids (dangling when the merge did not land), the dangling commit
 * ids, and the conflicted files. `conflict_hunks` carries the conflict
 * marker content of each escalated file, bounded per file (the
 * orchestrator caps it) — the "just the conflicted hunks" escalation
 * payload.
 */
export interface MergeFailureRecord {
	workspaces: Array<{ name: string; commit_id: string }>;
	dangling_commit_ids: string[];
	conflicted_files: string[];
	conflict_hunks?: Record<string, string>;
}

export function buildFailureArtifact(input: {
	kind: FailureArtifact["kind"];
	now?: Date;
	specHash?: string;
	tier?: string;
	cause: string;
	turns?: number;
	idleMs?: number;
	lastTool?: { name: string; args: string } | null;
	stderrTail?: string;
	/** R2: merge-failure record (workspaces, dangling commit ids, conflicted
	 *  files + hunks). Present on parallel merge failures/escalations. */
	merge?: MergeFailureRecord;
}): FailureArtifact {
	return {
		run_id: generateRunId(input.now ?? new Date()),
		kind: input.kind,
		timestamp: (input.now ?? new Date()).toISOString(),
		spec_hash: input.specHash,
		tier: input.tier,
		cause: input.cause,
		turns: input.turns,
		idle_ms: input.idleMs,
		last_tool: input.lastTool,
		stderr_tail: input.stderrTail,
		merge: input.merge,
	};
}

/**
 * Write a failure artifact to <metricsDir>/<project>/<run_id>.failure.json
 * atomically (mirrors writeManifest). Returns the written path.
 */
export function writeFailureArtifact(
	artifact: FailureArtifact,
	opts: { metricsDir: string; project: string },
): string {
	const dir = join(opts.metricsDir, opts.project);
	mkdirSync(dir, { recursive: true });
	const target = join(dir, `${artifact.run_id}.failure.json`);
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, JSON.stringify(artifact, null, 2) + "\n", "utf-8");
	renameSync(tmp, target);
	return target;
}

/**
 * Copy session traces into <metricsDir>/<project>/<run_id>/ as
 * <prefix>-1.jsonl, <prefix>-2.jsonl, … (benchmark mode: --preserve-
 * sessions). Returns the saved paths; empty when there are no sources.
 */
export function copySessionTraces(opts: {
	metricsDir: string;
	project: string;
	runId: string;
	sources: string[];
	prefix: string;
}): string[] {
	if (opts.sources.length === 0) return [];
	const runDir = join(opts.metricsDir, opts.project, opts.runId);
	mkdirSync(runDir, { recursive: true });
	return opts.sources.map((src, i) => {
		const dest = join(runDir, `${opts.prefix}-${i + 1}.jsonl`);
		copyFileSync(src, dest);
		return dest;
	});
}

// ─── Consumption: summarizeRuns + render (metrics step 1) ────────────
//
// Pure functions over the results/<project>/<run_id>.json manifests so
// /task-stats can answer "how is task performing" with data that is
// already collected — no new collection, no benchmark suite.

/** One completed run, flattened for aggregation/reporting. */
export interface RunRow {
	runId: string;
	project: string;
	tier: string;
	requirements: number;
	durationMs: number;
	costUsd: number;
	verifyPassed: boolean;
	fixIterations: number;
}

export interface RunSummary {
	/** Ascending by run id (time-sortable). */
	rows: RunRow[];
	count: number;
	/** Runs whose verify phase passed. */
	passed: number;
	/** *.failure.json artifacts: aborts/timeouts that left no manifest. */
	failures: number;
	/** Malformed manifest files skipped. */
	unreadable: number;
	totalCostUsd: number;
	totalDurationMs: number;
	p50DurationMs: number;
	p90DurationMs: number;
	byTier: Record<string, { count: number; costUsd: number }>;
	byProject: Record<string, { count: number; costUsd: number }>;
}

/** Nearest-rank percentile of sorted durations; 0 when empty. */
function percentile(sortedMs: number[], p: number): number {
	if (sortedMs.length === 0) return 0;
	const idx = Math.min(sortedMs.length - 1, Math.max(0, Math.ceil((p / 100) * sortedMs.length) - 1));
	return sortedMs[idx];
}

/**
 * Wall-clock latency of a run (R1): completed_at − received_at when both ISO
 * timestamps are present and parseable (completed >= received), else the
 * worker-measured totals.duration_ms. The /task-stats p50/p90 (and recent-run
 * durations) come from this — real wall time includes dispatch overhead the
 * worker cannot see. Pure.
 */
export function runLatencyMs(manifest: RunManifest): number {
	const received = manifest.received_at !== undefined ? Date.parse(manifest.received_at) : NaN;
	const completed = manifest.completed_at !== undefined ? Date.parse(manifest.completed_at) : NaN;
	if (Number.isFinite(received) && Number.isFinite(completed) && completed >= received) {
		return completed - received;
	}
	return manifest.totals?.duration_ms ?? 0;
}

/**
 * Summarize run manifests under <metricsDir>/<project>/<run_id>.json
 * (optional project filter). Lenient: malformed files count in
 * `unreadable` and are skipped; *.failure.json artifacts count in
 * `failures` (they record aborts/timeouts that produced no manifest).
 */
export function summarizeRuns(metricsDir: string, project?: string): RunSummary {
	const rows: RunRow[] = [];
	let failures = 0;
	let unreadable = 0;

	const projectDirs = project
		? [project]
		: existsSync(metricsDir)
			? readdirSync(metricsDir, { withFileTypes: true })
					.filter((d) => d.isDirectory())
					.map((d) => d.name)
			: [];

	for (const proj of projectDirs) {
		const dir = join(metricsDir, proj);
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			if (name.endsWith(".failure.json")) {
				failures++;
				continue;
			}
			if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
			let manifest: RunManifest;
			try {
				manifest = JSON.parse(readFileSync(join(dir, name), "utf-8")) as RunManifest;
				if (typeof manifest.run_id !== "string" || !manifest.phases?.verify) throw new Error("bad shape");
			} catch {
				unreadable++;
				continue;
			}
			rows.push({
				runId: manifest.run_id,
				project: proj,
				tier: manifest.config?.budget ?? "unknown",
				requirements: manifest.task?.requirements ?? 0,
				// R1: wall-clock latency when the manifest carries the run-lifecycle
				// timestamps (completed_at − received_at), else the worker-measured
				// totals.duration_ms — the /task-stats headline p50/p90 come from this.
				durationMs: runLatencyMs(manifest),
				costUsd: manifest.totals?.cost_usd ?? 0,
				verifyPassed: manifest.phases.verify.passed === true,
				fixIterations: manifest.phases.fix_loop?.iterations ?? 0,
			});
		}
	}

	rows.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
	const durations = rows.map((r) => r.durationMs).sort((a, b) => a - b);
	const byTier: Record<string, { count: number; costUsd: number }> = {};
	const byProject: Record<string, { count: number; costUsd: number }> = {};
	for (const r of rows) {
		(byTier[r.tier] ??= { count: 0, costUsd: 0 }).count++;
		byTier[r.tier].costUsd += r.costUsd;
		(byProject[r.project] ??= { count: 0, costUsd: 0 }).count++;
		byProject[r.project].costUsd += r.costUsd;
	}

	return {
		rows,
		count: rows.length,
		passed: rows.filter((r) => r.verifyPassed).length,
		failures,
		unreadable,
		totalCostUsd: rows.reduce((a, r) => a + r.costUsd, 0),
		totalDurationMs: rows.reduce((a, r) => a + r.durationMs, 0),
		p50DurationMs: percentile(durations, 50),
		p90DurationMs: percentile(durations, 90),
		byTier,
		byProject,
	};
}

/** Compact human duration, e.g. "42s", "7m12s", "1h2m". */
export function formatDuration(ms: number): string {
	const total = Math.round(ms / 1000);
	if (total < 60) return `${total}s`;
	const m = Math.floor(total / 60);
	const s = total % 60;
	if (m < 60) return s > 0 ? `${m}m${s}s` : `${m}m`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	return rm > 0 ? `${h}h${rm}m` : `${h}h`;
}

const fmtUsd = (usd: number): string => `$${usd.toFixed(4)}`;

/**
 * Render the summary for /task-stats: headline, recent runs (latest
 * first, capped), then by-tier/by-project rollups. Pure string array.
 */
export function renderTaskStats(summary: RunSummary, maxRows = 10): string[] {
	const lines: string[] = [
		`task runs: ${summary.count} total · ${summary.passed}/${summary.count} verified · ` +
			`${summary.failures} aborted (no manifest) · ${fmtUsd(summary.totalCostUsd)} · ` +
			`p50 ${formatDuration(summary.p50DurationMs)} · p90 ${formatDuration(summary.p90DurationMs)}`,
	];
	const recent = [...summary.rows].reverse().slice(0, maxRows);
	if (recent.length > 0) {
		lines.push("recent runs (latest first):");
		for (const r of recent) {
			lines.push(
				`  ${r.runId} ${r.project.padEnd(18)} ${r.tier.padEnd(8)} ${String(r.requirements).padStart(2)}r ` +
					`${formatDuration(r.durationMs).padStart(8)} ${fmtUsd(r.costUsd).padStart(9)} ` +
					`${r.verifyPassed ? "✓" : "✗"}${r.fixIterations > 0 ? ` (${r.fixIterations} fix)` : ""}`,
			);
		}
	} else {
		lines.push("no task runs recorded yet — manifests land in <agent-dir>/results/<project>/.");
	}
	const tierLine = Object.entries(summary.byTier)
		.map(([t, v]) => `${t} ${v.count} (${fmtUsd(v.costUsd)})`)
		.join(" · ");
	if (tierLine) lines.push(`by tier: ${tierLine}`);
	const projectLine = Object.entries(summary.byProject)
		.map(([p, v]) => `${p} ${v.count} (${fmtUsd(v.costUsd)})`)
		.join(" · ");
	if (projectLine) lines.push(`by project: ${projectLine}`);
	if (summary.unreadable > 0) lines.push(`${summary.unreadable} unreadable manifest file(s) skipped`);
	return lines;
}
