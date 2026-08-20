/**
 * runner.ts — detached task dispatch.
 *
 * A detached run (the task tool's `detach` param) executes in a child
 * process: the tool writes a run REQUEST file, spawns this module via tsx
 * (the bench-regression spawn pattern — a fresh process that runs the
 * SAME orchestrator with the SAME spec/options), and returns the run_id
 * immediately. Detach changes only WHO waits, never the guarantees: the
 * child passes the same wall-clock / per-tool / verification timeouts and
 * sandbox policy, and the orchestrator enforces them exactly as in a
 * blocking run.
 *
 * File layout under <metricsDir>/<project>/ (all keyed by run_id):
 *
 *   <run_id>.request.json — the run request (spec/options/plan), written
 *       by the task tool BEFORE the spawn. Durable input + record; also
 *       the "this run was dispatched" marker.
 *   <run_id>.live.json    — live heartbeat: plan, progress text, start +
 *       heartbeat timestamps. Written by the child (throttled + periodic);
 *       REMOVED when the run finishes. /task-status reads it while running.
 *   <run_id>.log          — the child's stdout/stderr.
 *   <run_id>.json         — the final RunManifest (same path a blocking
 *       run writes — see metrics.ts writeManifest). The returned run_id
 *       IS the manifest's run_id (the orchestrator's injected runId).
 *   <run_id>.failure.json — the failure artifact when the run dies
 *       without a manifest (same path a blocking run writes; also
 *       keyed by the injected runId).
 *
 * The pure parts (path helpers, request assembly, spawn command assembly,
 * run_id → status resolution, status rendering) are exported and
 * hermetically tested in test-runner.ts; the orchestrator is lazy-imported
 * only when the child actually runs, so importing this module never pulls
 * the worker machinery into the fast suite's module graph.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SandboxConfig, TaskShape } from "./config.ts";
import type { RunPlan } from "./progress.ts";
import { formatDuration } from "./progress.ts";
import type { FailureArtifact, RunManifest } from "./metrics.ts";
import type { ExecuteTaskOptions } from "./orchestrator.ts";

// ─── File naming ─────────────────────────────────────────────────────

export const REQUEST_SUFFIX = ".request.json";
export const LIVE_SUFFIX = ".live.json";
export const LOG_SUFFIX = ".log";
/** A live heartbeat older than this is presumed dead (the child writes
 *  every LIVE_HEARTBEAT_INTERVAL_MS). */
export const LIVE_STALE_THRESHOLD_MS = 60_000;
/** Child heartbeat cadence (periodic live-file refresh even when no
 *  progress events arrive). */
export const LIVE_HEARTBEAT_INTERVAL_MS = 2_000;
/** Child progress-event → live-file write throttle (the progress view
 *  updates far more often than a status reader needs). */
export const LIVE_WRITE_THROTTLE_MS = 1_000;

export function requestPathFor(metricsDir: string, project: string, runId: string): string {
	return join(metricsDir, project, `${runId}${REQUEST_SUFFIX}`);
}
export function livePathFor(metricsDir: string, project: string, runId: string): string {
	return join(metricsDir, project, `${runId}${LIVE_SUFFIX}`);
}
export function logPathFor(metricsDir: string, project: string, runId: string): string {
	return join(metricsDir, project, `${runId}${LOG_SUFFIX}`);
}
export function manifestPathFor(metricsDir: string, project: string, runId: string): string {
	return join(metricsDir, project, `${runId}.json`);
}
export function failurePathFor(metricsDir: string, project: string, runId: string): string {
	return join(metricsDir, project, `${runId}.failure.json`);
}

// ─── Request / live state shapes ─────────────────────────────────────

/**
 * The SERIALIZABLE subset of ExecuteTaskOptions a detached run carries
 * across the process boundary. Everything the orchestrator needs to
 * reproduce the blocking run's bounds (R4): same spec/options, same
 * timeouts, same sandbox policy. Functions (signal/onUpdate/onSwap) are
 * child-side only — the child builds its own.
 */
export interface DetachedRunOptions {
	cwd: string;
	model: string;
	spec?: string;
	subSpecs?: string[];
	parallel?: number;
	prewalkModel?: string;
	executeModel?: string;
	reviewModel?: string;
	review?: boolean;
	persona?: string;
	/** OpenRouter service tier the tier declares (flex infra) — the child
	 *  threads it to every worker/reviewer spawn. */
	serviceTier?: string;
	/** OpenRouter provider.only pin the tier declares (flex infra). */
	providerOnly?: string[];
	/** Turn budget the tier declares (Phase 3). */
	turnBudget?: number;
	shape?: TaskShape;
	maxFixIterations?: number;
	workerTimeoutMs?: number;
	toolTimeoutMs?: number;
	verificationTimeoutMs?: number;
	/** Per-fork review wall (ms); absent → review.ts's 20-min default. */
	reviewWallTimeoutMs?: number;
	aiAuthorName?: string;
	aiAuthorEmail?: string;
	budget?: string;
	sandbox?: SandboxConfig;
	/** Wall-clock timestamps + pre-dispatch main-session spend (R1): the
	 *  tool records them at dispatch, the manifest carries them. */
	receivedAt?: string;
	mainSessionTokens?: number;
}

/** The durable run request written before the child spawns. */
export interface RunRequest {
	run_id: string;
	created_at: string;
	metrics_dir: string;
	project: string;
	/** Worker count the progress view shows (mirrors the tool's clamp). */
	worker_count: number;
	/** The dispatched plan (tier, phases, goals) — /task-status's live view. */
	plan: RunPlan;
	options: DetachedRunOptions;
}

/** The child's live heartbeat file (present only while the run is live). */
export interface LiveRunState {
	run_id: string;
	project: string;
	started_at: string;
	heartbeat_at: string;
	plan: RunPlan;
	/** The same progress text a blocking run's TUI would show. */
	progress_text: string;
}

// ─── Request assembly (pure) ─────────────────────────────────────────

/**
 * Assemble a run request for a detached dispatch. `now` is injectable for
 * deterministic tests. Pure — hermetically tested.
 */
export function buildRunRequest(input: {
	run_id: string;
	metrics_dir: string;
	project: string;
	worker_count: number;
	plan: RunPlan;
	options: DetachedRunOptions;
	now?: Date;
}): RunRequest {
	return {
		run_id: input.run_id,
		created_at: (input.now ?? new Date()).toISOString(),
		metrics_dir: input.metrics_dir,
		project: input.project,
		worker_count: input.worker_count,
		plan: input.plan,
		options: input.options,
	};
}

// ─── Spawn command assembly (pure) ───────────────────────────────────

/**
 * Assemble the child-process invocation: tsx (or the npx fallback) +
 * runner.ts + the request path. `tsxBin` is the resolved local
 * node_modules/.bin/tsx (see resolveRunnerSpawn); absent → `npx tsx`.
 * Pure — hermetically tested.
 */
export function buildRunnerCommand(opts: {
	runnerPath: string;
	requestPath: string;
	tsxBin?: string;
}): { command: string; args: string[] } {
	const common = [opts.runnerPath, "--request", opts.requestPath];
	return opts.tsxBin
		? { command: opts.tsxBin, args: common }
		: { command: "npx", args: ["tsx", ...common] };
}

/**
 * Resolve the runner spawn: prefer the local node_modules/.bin/tsx under
 * `baseDir` (the pi-task package root — deterministic, no PATH lookup);
 * fall back to `npx tsx`. Pure — hermetically tested.
 */
export function resolveRunnerSpawn(opts: {
	runnerPath: string;
	requestPath: string;
	baseDir?: string;
}): { command: string; args: string[] } {
	const localTsx = join(opts.baseDir ?? PACKAGE_ROOT, "node_modules", ".bin", "tsx");
	return buildRunnerCommand({
		runnerPath: opts.runnerPath,
		requestPath: opts.requestPath,
		tsxBin: existsSync(localTsx) ? localTsx : undefined,
	});
}

// ─── Child CLI args (pure) ───────────────────────────────────────────

export interface RunnerArgs {
	requestPath?: string;
	help: boolean;
}

/** Parse the child's CLI flags. Pure — tested. */
export function parseRunnerArgs(argv: string[]): RunnerArgs {
	const out: RunnerArgs = { help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--request") {
			const value = argv[++i];
			if (value === undefined) throw new Error("--request requires a path");
			out.requestPath = value;
		} else if (arg === "--help" || arg === "-h") {
			out.help = true;
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return out;
}

// ─── Status resolution (pure) ────────────────────────────────────────

export interface LocatedRun {
	project: string;
	manifestPath?: string;
	failurePath?: string;
	livePath?: string;
	requestPath?: string;
}

/**
 * Locate a run_id under <metricsDir>/<project>/ — every project dir is
 * scanned for the run's four keyed files (manifest, failure artifact,
 * live heartbeat, request). A project holding the manifest wins over a
 * project with only sidecars (run_ids are unique; the manifest is the
 * authoritative record). Null when no project has any of the files.
 * Pure — hermetically tested.
 */
/** Project dirs under a metrics dir; lenient (unreadable dirs → []). */
function projectDirs(metricsDir: string): string[] {
	try {
		return readdirSync(metricsDir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
	} catch {
		return [];
	}
}

export function locateRun(metricsDir: string, runId: string): LocatedRun | null {
	if (!existsSync(metricsDir)) return null;
	const candidates: LocatedRun[] = [];
	for (const project of projectDirs(metricsDir)) {
		const found: LocatedRun = { project };
		const manifestPath = manifestPathFor(metricsDir, project, runId);
		if (existsSync(manifestPath)) found.manifestPath = manifestPath;
		const failurePath = failurePathFor(metricsDir, project, runId);
		if (existsSync(failurePath)) found.failurePath = failurePath;
		const livePath = livePathFor(metricsDir, project, runId);
		if (existsSync(livePath)) found.livePath = livePath;
		const requestPath = requestPathFor(metricsDir, project, runId);
		if (existsSync(requestPath)) found.requestPath = requestPath;
		if (found.manifestPath || found.failurePath || found.livePath || found.requestPath) {
			candidates.push(found);
		}
	}
	if (candidates.length === 0) return null;
	return candidates.find((c) => c.manifestPath) ?? candidates[0];
}

/** One run's resolved status for /task-status. */
export type RunStatus =
	| { kind: "unknown"; runId: string; metricsDir: string }
	| { kind: "starting"; runId: string; project: string; metricsDir: string; request: RunRequest }
	| { kind: "live"; runId: string; project: string; metricsDir: string; state: LiveRunState; staleMs: number }
	| { kind: "finished"; runId: string; project: string; metricsDir: string; manifest: RunManifest }
	| { kind: "failed"; runId: string; project: string; metricsDir: string; artifact: FailureArtifact };

function parseJsonFile<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return null;
	}
}

/**
 * Resolve a run_id's status from disk, in precedence order: a manifest
 * (finished — even a verify-failed run has one) > a failure artifact
 * (died without a manifest) > a live heartbeat (running) > a bare
 * request (spawned, awaiting the first heartbeat) > unknown. Lenient:
 * unreadable files fall through to the next candidate. Pure —
 * hermetically tested.
 */
export function readRunStatus(metricsDir: string, runId: string, nowMs: number): RunStatus {
	const loc = locateRun(metricsDir, runId);
	if (!loc) return { kind: "unknown", runId, metricsDir };
	if (loc.manifestPath) {
		const manifest = parseJsonFile<RunManifest>(loc.manifestPath);
		if (manifest && typeof manifest.run_id === "string") {
			return { kind: "finished", runId, project: loc.project, metricsDir, manifest };
		}
	}
	if (loc.failurePath) {
		const artifact = parseJsonFile<FailureArtifact>(loc.failurePath);
		if (artifact && typeof artifact.run_id === "string") {
			return { kind: "failed", runId, project: loc.project, metricsDir, artifact };
		}
	}
	if (loc.livePath) {
		const state = parseJsonFile<LiveRunState>(loc.livePath);
		if (state && typeof state.run_id === "string") {
			const hb = Date.parse(state.heartbeat_at);
			return {
				kind: "live",
				runId,
				project: loc.project,
				metricsDir,
				state,
				staleMs: Number.isFinite(hb) ? Math.max(0, nowMs - hb) : Number.POSITIVE_INFINITY,
			};
		}
	}
	if (loc.requestPath) {
		const request = parseJsonFile<RunRequest>(loc.requestPath);
		if (request && typeof request.run_id === "string") {
			return { kind: "starting", runId, project: loc.project, metricsDir, request };
		}
	}
	return { kind: "unknown", runId, metricsDir };
}

// ─── Status rendering (pure) ─────────────────────────────────────────

const fmtUsd = (usd: number): string => `$${usd.toFixed(4)}`;

/** The manifest's review-finding summary, e.g. "3 finding(s) (P1: 2, P2: 1)". */
function reviewSummary(manifest: RunManifest): string | null {
	const review = manifest.phases.review;
	if (!review) return null;
	const byPriority = Object.entries(review.by_priority ?? {})
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([p, n]) => `${p}: ${n}`)
		.join(", ");
	return `${review.findings} finding(s)${byPriority ? ` (${byPriority})` : ""}`;
}

/**
 * Render /task-status output for a resolved status. `nowMs` explicit so
 * tests are deterministic. Pure — hermetically tested.
 */
export function renderRunStatus(status: RunStatus, nowMs: number): string[] {
	if (status.kind === "unknown") {
		return [
			`no run "${status.runId}" found under ${status.metricsDir}`,
			"check the run_id — /task-stats lists recorded runs, /task-status <run_id> queries one",
		];
	}
	const base = `run ${status.runId} · ${status.project}`;
	if (status.kind === "starting") {
		return [
			`${base} · STARTING`,
			"child spawned — awaiting the first heartbeat; re-check shortly",
			`log: ${logPathFor(status.metricsDir, status.project, status.runId)}`,
		];
	}
	if (status.kind === "live") {
		const start = Date.parse(status.state.started_at);
		const elapsed = Number.isFinite(start) ? formatDuration(Math.max(0, nowMs - start)) : "?";
		const lines = [`${base} · RUNNING · elapsed ${elapsed}`, ...status.state.progress_text.split("\n")];
		if (status.staleMs >= LIVE_STALE_THRESHOLD_MS) {
			lines.push(
				`⚠ no heartbeat for ${formatDuration(status.staleMs)} — the child may have died; ` +
					`log: ${logPathFor(status.metricsDir, status.project, status.runId)}`,
			);
		}
		return lines;
	}
	if (status.kind === "finished") {
		const m = status.manifest;
		const verify = m.phases.verify;
		const lines = [
			`${base} · ${verify.passed ? "DONE ✓" : "DONE ✗"}`,
			`verify: ${verify.passed ? "✓" : "✗"} ${verify.commands} command(s)` +
				`${verify.timed_out ? " (timed out)" : ""} · cost ${fmtUsd(m.totals.cost_usd)} · ` +
				`${formatDuration(m.totals.duration_ms)} · tier ${m.config.budget ?? "default"}`,
		];
		const review = reviewSummary(m);
		if (review) lines.push(`review: ${review}`);
		if (m.merge) {
			lines.push(
				`merge: ${m.merge.worker_count ?? "?"} worker(s) → ${m.merge.merged_commit_id ?? "?"}` +
					` (${m.merge.files_changed ?? 0} file(s) changed)`,
			);
		}
		return lines;
	}
	// failed
	const a = status.artifact;
	return [
		`${base} · FAILED (${a.kind})`,
		`cause: ${a.cause}`,
		`at ${a.timestamp}${a.recovery ? " · recovery guide in the artifact" : ""}`,
	];
}

// ─── Disk writes (impure — used by the tool and the child) ───────────

/** Atomic write (tmp + rename, mirrors writeManifest): a crash never
 *  leaves a partial request/live file. */
function writeFileAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, path);
}

/** Write the run request (the tool does this before the spawn). Returns
 *  the written path. */
export function writeRunRequest(request: RunRequest): string {
	const path = requestPathFor(request.metrics_dir, request.project, request.run_id);
	writeFileAtomic(path, JSON.stringify(request, null, 2) + "\n");
	return path;
}

/** Write the live heartbeat file. */
export function writeLiveState(state: LiveRunState, path: string): void {
	writeFileAtomic(path, JSON.stringify(state, null, 2) + "\n");
}

/** Best-effort removal (the live file goes away when the run ends). */
export function removeFileBestEffort(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// Best effort — the run's outcome is recorded in the manifest.
	}
}

// ─── Child process (direct execution only) ───────────────────────────

/** This module's directory — the pi-task package root for tsx resolution. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const USAGE = `usage: npx tsx extensions/task/runner.ts --request <request.json>

Runs a detached task: reads the run request (spec/options/plan), executes
the orchestrator with the SAME bounds as a blocking run, writes the same
manifest / failure artifacts, and maintains <run_id>.live.json until done.

flags:
  --request <path>  run request file (written by the task tool)
  --help            print this help

exit codes: 0 run completed · 1 run failed · 2 usage/request error`;

/** The child's main flow. Kept separate from main() for clarity. */
async function runChild(requestPath: string): Promise<number> {
	let request: RunRequest;
	try {
		request = JSON.parse(readFileSync(requestPath, "utf-8")) as RunRequest;
	} catch (err) {
		console.error(`runner: cannot read request ${requestPath}: ${err instanceof Error ? err.message : String(err)}`);
		return 2;
	}
	const { run_id, metrics_dir, project, worker_count, plan, options } = request;
	if (!run_id || !metrics_dir || !project || !options?.cwd || !options.model) {
		console.error("runner: malformed request (run_id / metrics_dir / project / options.cwd / options.model required)");
		return 2;
	}

	// Live heartbeat: written immediately (so /task-status shows the run
	// before the first worker event), then on every progress event
	// (throttled) and on a fixed cadence (a silent-but-healthy worker must
	// not look dead).
	const startedAt = new Date().toISOString();
	let lastWriteMs = Date.now();
	const state: LiveRunState = {
		run_id,
		project,
		started_at: startedAt,
		heartbeat_at: startedAt,
		plan,
		progress_text: "",
	};
	const writeLive = (): void => {
		state.heartbeat_at = new Date().toISOString();
		try {
			writeLiveState(state, livePathFor(metrics_dir, project, run_id));
		} catch {
			// Best effort — a failed heartbeat must not kill the run.
		}
	};

	// Lazy imports: the worker machinery loads only when a run actually
	// happens (the fast suite imports this module's pure parts).
	const [{ executeTask }, { applyProgressEvent, buildProgressText, createProgressState }] =
		await Promise.all([import("./orchestrator.ts"), import("./progress.ts")]);

	const progress = createProgressState(worker_count, plan, Date.now());
	const onUpdate = (partial: unknown): void => {
		applyProgressEvent(progress, partial, Date.now());
		const now = Date.now();
		if (now - lastWriteMs >= LIVE_WRITE_THROTTLE_MS) {
			lastWriteMs = now;
			state.progress_text = buildProgressText(progress, now);
			writeLive();
		}
	};
	state.progress_text = buildProgressText(progress, Date.now());
	writeLive();
	const heartbeat = setInterval(writeLive, LIVE_HEARTBEAT_INTERVAL_MS);

	try {
		// R4: the SAME options (wall clock, per-tool timeout, verification
		// timeout, sandbox) as a blocking run — detach changes only who
		// waits. The injected runId makes the manifest (and any failure
		// artifact) land under the id the tool already returned.
		const result = await executeTask({
			...options,
			runId: run_id,
			metricsDir: metrics_dir,
			project,
			onUpdate,
		});
		removeFileBestEffort(livePathFor(metrics_dir, project, run_id));
		console.log(
			`run ${run_id}: ${result.success ? "done" : "done (verification failed)"} in ` +
				`${formatDuration(result.durationMs)} · verify ${result.verification.passed ? "pass" : "fail"} · ` +
				fmtUsd(result.manifest?.totals.cost_usd ?? 0),
		);
		return result.success ? 0 : 1;
	} catch (err) {
		// The caller returned this run_id, so /task-status must be able to
		// find the failure even when the orchestrator's internal best-effort
		// writes didn't cover it (e.g. a spec-validation error). Never
		// overwrite an artifact the orchestrator already wrote under the id.
		const failurePath = failurePathFor(metrics_dir, project, run_id);
		const manifestPath = manifestPathFor(metrics_dir, project, run_id);
		if (!existsSync(failurePath) && !existsSync(manifestPath)) {
			try {
				const { buildFailureArtifact, writeFailureArtifact } = await import("./metrics.ts");
				const kind =
					(options.subSpecs?.length ?? 1) > 1 || (options.parallel ?? 1) > 1 ? "parallel" : "worker";
				writeFailureArtifact(
					buildFailureArtifact({
						kind,
						runId: run_id,
						tier: options.budget,
						specHash: options.spec ?? options.subSpecs?.join("\n\n"),
						cause: err instanceof Error ? err.message : String(err),
					}),
					{ metricsDir: metrics_dir, project },
				);
			} catch {
				// Best effort — the original failure propagates regardless.
			}
		}
		removeFileBestEffort(livePathFor(metrics_dir, project, run_id));
		console.error(`run ${run_id}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	} finally {
		clearInterval(heartbeat);
	}
}

async function main(): Promise<number> {
	let args: RunnerArgs;
	try {
		args = parseRunnerArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`runner: ${(err as Error).message}`);
		console.error(USAGE);
		return 2;
	}
	if (args.help) {
		console.log(USAGE);
		return 0;
	}
	if (!args.requestPath) {
		console.error(USAGE);
		return 2;
	}
	return runChild(args.requestPath);
}

// Guard: only run when executed directly (never on import — the hermetic
// tests import the pure parts).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error("runner FAILED:", err instanceof Error ? err.message : err);
			process.exit(1);
		});
}
