/**
 * Standalone task scheduler (M4) — dispatches [jobs.*] config entries when
 * due, onto their channel (flex = a detached run via runner.ts; batch = a
 * batch job via batch.ts). Pure mechanics: timestamps + spawn + state — zero
 * LLM tokens in the scheduler itself (the LLM work happens in the runs it
 * dispatches). Run standalone: `npx tsx extensions/task/scheduler.ts
 * --once|--loop [--dry-run]`.
 *
 * The pure parts (isDue, state round-trip, dueJobs, the dispatch decision)
 * are exported and hermetically tested in test-scheduler.ts; the spawn and
 * batch submit are exercised by the real lanes (manual validation with real
 * models/keys) and the fake batch provider in tests.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadTaskConfig, resolveTaskShape, type JobConfig } from "./config.ts";
import { buildRunRequest, resolveRunnerSpawn, requestPathFor } from "./runner.ts";
import { generateRunId } from "./metrics.ts";

export const SCHEDULER_STATE_FILENAME = "scheduler-state.json";

/** One job's scheduler state (last dispatch + the run/job id it started). */
export interface SchedulerEntry {
	lastRunMs: number;
	/** The detached run_id (flex) or provider job id (batch) last started. */
	runId?: string;
}
export type SchedulerState = Record<string, SchedulerEntry>;

export function schedulerStatePath(agentDir: string): string {
	return join(agentDir, "results", SCHEDULER_STATE_FILENAME);
}

export function readSchedulerState(path: string): SchedulerState {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as SchedulerState;
	} catch {
		return {};
	}
}

export function writeSchedulerState(path: string, state: SchedulerState): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
	renameSync(tmp, path);
}

/** True when a job is due: never run, or everyMs has elapsed since the
 *  last dispatch. Pure — tested. */
export function isDue(job: JobConfig, lastRunMs: number | undefined, nowMs: number): boolean {
	return lastRunMs === undefined || nowMs - lastRunMs >= job.everyMs;
}

/** The jobs due now, in config order. Pure — tested. */
export function dueJobs(config: { jobs: Record<string, JobConfig> }, state: SchedulerState, nowMs: number): Array<{ name: string; job: JobConfig }> {
	const out: Array<{ name: string; job: JobConfig }> = [];
	for (const [name, job] of Object.entries(config.jobs)) {
		if (isDue(job, state[name]?.lastRunMs, nowMs)) out.push({ name, job });
	}
	return out;
}

/** Resolve the job's spec: inline markdown, or "file:<path>" read at
 *  dispatch time. */
export function resolveJobSpec(job: JobConfig): string {
	if (job.spec.startsWith("file:")) {
		try {
			return readFileSync(job.spec.slice(5), "utf-8");
		} catch (err) {
			throw new Error(`[jobs] ${job.spec}: cannot read spec file (${(err as Error).message})`);
		}
	}
	return job.spec;
}

/** The run request a flex/sync job dispatches through the detached runner. */
export function buildJobRequest(input: {
	metricsDir: string;
	project: string;
	spec: string;
	tier: string;
	shape: JobConfig["shape"];
	channel: JobConfig["channel"];
	config: ReturnType<typeof loadTaskConfig>;
	cwd: string;
	now?: Date;
}) {
	const runId = generateRunId(input.now ?? new Date());
	const requestPath = requestPathFor(input.metricsDir, input.project, runId);
	const tierConfig = input.config.tiers[input.tier];
	if (!tierConfig) throw new Error(`[jobs] unknown tier "${input.tier}"`);
	// The request must carry the tier's MODELS (not its name), the tier
	// wall, the shared tool timeout, and the AI identity — otherwise the
	// runner child starts with model id "economy" and the session dies
	// before the first model call (review P1).
	const shape = { ...resolveTaskShape(input.shape, input.config.shapes), channel: input.channel };
	const request = buildRunRequest({
		run_id: runId,
		metrics_dir: input.metricsDir,
		project: input.project,
		worker_count: 1,
		plan: {
			tier: input.tier,
			phases: [],
			wallTimeoutMs: tierConfig.wallTimeoutMs,
			goals: undefined,
		},
		options: {
			cwd: input.cwd,
			model: tierConfig.executeModel,
			prewalkModel: tierConfig.prewalkModel ?? undefined,
			executeModel: tierConfig.executeModel,
			reviewModel: tierConfig.reviewModel,
			review: tierConfig.review,
			spec: input.spec,
			budget: input.tier,
			workerTimeoutMs: tierConfig.wallTimeoutMs,
			toolTimeoutMs: input.config.defaults.toolTimeoutMs,
			verificationTimeoutMs: input.config.defaults.verificationTimeoutMs,
			reviewWallTimeoutMs: input.config.defaults.reviewWallTimeoutMs,
			aiAuthorName: input.config.defaults.aiAuthorName,
			aiAuthorEmail: input.config.defaults.aiAuthorEmail,
			shape,
			sandbox: input.config.sandbox,
		},
		now: input.now,
	});
	mkdirSync(dirname(requestPath), { recursive: true });
	writeFileSync(requestPath, JSON.stringify(request), "utf-8");
	return { runId, requestPath };
}

/** The result of a job dispatch: the lane + the id it started. */
export interface DispatchResult {
	lane: "flex" | "batch";
	id: string;
}

/** Dispatch a due job onto its channel. flex/sync → spawn the detached
 *  runner; batch → submit a batch job via the provider. Pure decision +
 *  spawn. */
export async function dispatchJob(
	name: string,
	job: JobConfig,
	opts: {
		metricsDir: string;
		project: string;
		config: ReturnType<typeof loadTaskConfig>;
		cwd: string;
		baseDir: string;
		spawnRunner?: (cmd: string, args: string[], cwd: string) => ChildProcess;
	},
): Promise<DispatchResult> {
	const spec = resolveJobSpec(job);
	// Both flex and batch dispatch through the detached runner: the child's
	// orchestrator routes by the shape's channel — batch runs the full lane
	// (poll, collect, validate, apply, commit, verify, manifest + the
	// config.batch.model id), flex runs the interactive worker. The scheduler
	// records the run_id; it never submits a bare batch job (that was
	// fire-and-forget with the literal model "batch").
	const { runId, requestPath } = buildJobRequest({
		metricsDir: opts.metricsDir,
		project: opts.project,
		spec,
		tier: job.tier,
		shape: job.shape,
		channel: job.channel,
		config: opts.config,
		cwd: opts.cwd,
	});
	const runnerPath = join(opts.baseDir, "runner.ts");
	const { command, args } = resolveRunnerSpawn({ runnerPath, requestPath, baseDir: opts.baseDir });
	const spawnFn = opts.spawnRunner ?? spawn;
	spawnFn(command, args, { cwd: opts.cwd, detached: true, stdio: "ignore" }).unref();
	return { lane: job.channel as "flex" | "batch", id: runId };
}

/** Check due jobs, dispatch them, record state. Returns the dispatched
 *  results (empty when dryRun). */
export async function runOnce(
	opts: {
		agentDir: string;
		metricsDir: string;
		project: string;
		cwd: string;
		baseDir: string;
		now?: Date;
		dryRun?: boolean;
	},
): Promise<Array<{ name: string; lane: string; id: string }>> {
	const config = loadTaskConfig();
	const statePath = schedulerStatePath(opts.agentDir);
	const state = readSchedulerState(statePath);
	const nowMs = (opts.now ?? new Date()).getTime();
	const due = dueJobs(config, state, nowMs);
	const dispatched: Array<{ name: string; lane: string; id: string }> = [];

	if (opts.dryRun || due.length === 0) {
		for (const { name } of due) {
			console.log(`[scheduler] due: ${name} (dry-run — not dispatched)`);
			dispatched.push({ name, lane: (config.jobs[name]?.channel ?? "flex"), id: "(dry)" });
		}
		return dispatched;
	}

	for (const { name, job } of due) {
		console.log(`[scheduler] dispatching ${name} on ${job.channel} (${job.description})…`);
		try {
			const result = await dispatchJob(name, job, {
				metricsDir: opts.metricsDir,
				project: opts.project,
				config,
				cwd: opts.cwd,
				baseDir: opts.baseDir,
			});
			state[name] = { lastRunMs: nowMs, runId: result.id };
			dispatched.push({ name, lane: result.lane, id: result.id });
			console.log(`[scheduler] dispatched ${name} → ${result.lane}:${result.id}`);
		} catch (err) {
			console.error(`[scheduler] dispatch ${name} failed: ${(err as Error).message}`);
		}
	}
	writeSchedulerState(statePath, state);
	return dispatched;
}

// ─── CLI ────────────────────────────────────────────────────────────

export interface SchedulerArgs {
	mode: "once" | "loop" | (string & {});
	project?: string;
	dryRun: boolean;
	help: boolean;
}

export function parseSchedulerArgs(argv: string[]): SchedulerArgs {
	const out: SchedulerArgs = { mode: "once", dryRun: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--once") out.mode = "once";
		else if (a === "--loop") out.mode = "loop";
		else if (a === "--dry-run") out.dryRun = true;
		else if (a === "--project") {
			const v = argv[++i];
			if (v === undefined) throw new Error("--project requires a value");
			out.project = v;
		} else if (a === "--help" || a === "-h") out.help = true;
		else throw new Error(`unknown argument: ${a}`);
	}
	return out;
}

const USAGE = `usage: npx tsx extensions/task/scheduler.ts [--once|--loop] [--dry-run] [--project <name>]

Dispatches due [jobs.*] entries (task.toml) on their channel: flex/sync →
detached runner; batch → batch job. Reads last-run state from
<agent-dir>/results/scheduler-state.json.

flags:
  --once       check + dispatch due jobs once, then exit (default)
  --loop       check every minute, forever (for a supervisor/daemon)
  --dry-run    list due jobs without dispatching
  --project    metrics project dir name (default: cwd's basename)
  --help       print this help`;

export async function main(): Promise<number> {
	let args: SchedulerArgs;
	try {
		args = parseSchedulerArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`scheduler: ${(err as Error).message}`);
		console.error(USAGE);
		return 1;
	}
	if (args.help) {
		console.log(USAGE);
		return 0;
	}
	const agentDir = getAgentDir();
	const cwd = process.cwd();
	const project = args.project ?? basename(process.cwd());
	const metricsDir = join(agentDir, "results");
	// The batch provider requires OPENROUTER_API_KEY; without it, batch jobs
	// fail typed on submit (OpenRouterBatchProvider throws). Flex/sync jobs
	// run regardless. A dry-run uses the fake provider (no key needed).
	const baseDir = dirname(fileURLToPath(import.meta.url));
	if (args.mode === "loop") {
		// eslint-disable-next-line no-constant-condition
		while (true) {
			try {
				await runOnce({ agentDir, metricsDir, project, cwd, baseDir, dryRun: args.dryRun });
			} catch (err) {
				console.error(`[scheduler] run failed: ${(err as Error).message}`);
			}
			await new Promise((r) => setTimeout(r, 60_000));
		}
	}
	await runOnce({ agentDir, metricsDir, project, cwd, baseDir, dryRun: args.dryRun });
	return 0;
}

function basename(p: string): string {
	return p.split(/[\\/]/).pop() ?? "unknown";
}

// Guard: only run when executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
