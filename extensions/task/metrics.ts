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
 * - config.budget is the resolved budget tier (Phase 10); it falls back to
 *   "default" when a direct executeTask caller omits the label.
 * - Parallel runs produce ONE aggregate manifest: phases.execute SUMS
 *   per-worker usage/reads via aggregateExecutePhase (wall-time duration),
 *   with prewalk/review null and fixLoop zero (see orchestrator.ts).
 */

import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
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
	config: MetricsConfig;
	task: { spec_hash: string; requirements: number };
	phases: {
		prewalk: PhaseMetrics | null;
		execute: PhaseMetrics;
		verify: VerifyPhaseMetrics;
		review: ReviewPhaseMetrics | null;
		fix_loop: FixLoopPhaseMetrics;
	};
	totals: {
		cost_usd: number;
		duration_ms: number;
		read_duplication_tokens: number;
		session_files: string[];
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
		},
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
