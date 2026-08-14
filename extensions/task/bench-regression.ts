/**
 * bench-regression.ts — standalone canned-task regression runner.
 *
 * Runs tiny deterministic specs per budget tier against real pi + a real
 * LLM (the tier's configured models from task.toml — no new models, no
 * model policy of its own), then reports latency and cost against shipped
 * per-spec-per-tier baselines. Manifests land through the EXISTING metrics
 * write path (executeTask → writeManifest, as the task tool does) and the
 * comparison reads them back via summarizeRuns — nothing in the engine is
 * modified by this script.
 *
 * Usage:
 *   npx tsx extensions/task/bench-regression.ts [--tier <name>] [--dry-run]
 *
 * Flags:
 *   --tier <name>     Restrict the run to one tier (repeatable).
 *   --shape <name>    Run-pipeline shape to benchmark (default: code;
 *                     analysis benchmarks the strong-writer shape).
 *   --dry-run         Print the run plan (tiers, specs, expected cost/time)
 *                     and exit 0 — nothing is spawned, no LLM is called
 *                     (the only subprocess is the config TOML read).
 *   --metrics-dir <p> Where manifests are written/read (default:
 *                     <agent-dir>/results). Each spec writes under the
 *                     project "bench-<specId>" (see projectForSpec).
 *   --help            Print this usage.
 *
 * Exit codes:
 *   0 — dry run, or every planned run completed with verification passing
 *       and no regression vs. the baselines.
 *   1 — one or more runs failed (worker error or verification failure).
 *   2 — runs completed but regressions were detected (see
 *       REGRESSION_DURATION_FACTOR / REGRESSION_COST_FACTOR).
 *
 * Baselines: starting estimates (tuning targets, not measurements) in
 * BENCH_SPECS below — per spec, per tier, with a "default" fallback for
 * custom tiers. Tiers come from task.toml (config-driven), so the plan
 * always reflects the installed config. The canned specs are the same
 * shapes the e2e suite exercises (create-a-file + commit, README edit,
 * verify gate) — each completes well under a minute per tier by design.
 *
 * The pure parts (plan assembly, baseline comparison, rendering) are
 * exported and hermetically tested in test-bench-regression.ts; the runner
 * lazily imports the orchestrator only when it actually runs tasks, so
 * importing this module never pulls the worker machinery into the fast
 * suite's module graph.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	loadTaskConfig,
	resolveTaskShape,
	type BudgetTier,
	type BudgetTierConfig,
	type SandboxConfig,
	type TaskShape,
} from "./config.ts";
import { formatDuration, summarizeRuns, type RunSummary } from "./metrics.ts";

// ─── Canned specs (R2) ───────────────────────────────────────────────

/** Expected wall time + cost for ONE run of a spec on a tier. */
export interface SpecBaseline {
	/** Expected wall time (ms) — the latency regression target. */
	durationMs: number;
	/** Expected total cost (USD) — the cost regression target. */
	costUsd: number;
}

export interface BenchSpec {
	/** Stable id — also the metrics project suffix ("bench-<id>"). */
	id: string;
	/** One-line description shown in the run plan. */
	description: string;
	/** The canned spec markdown (Goal / Requirements / Verification). */
	specMarkdown: string;
	/**
	 * Baseline per tier name; tiers without an entry (custom task.toml
	 * tiers) fall back to the required "default" entry.
	 */
	baseline: Record<string, SpecBaseline> & { default: SpecBaseline };
}

/**
 * Regression thresholds: a row trips a regression when its average
 * duration exceeds REGRESSION_DURATION_FACTOR × the baseline, or its
 * average cost exceeds REGRESSION_COST_FACTOR × the baseline (or any
 * recorded run failed verification). Tune here; the thresholds are
 * reported in the rendered report.
 */
export const REGRESSION_DURATION_FACTOR = 1.5;
export const REGRESSION_COST_FACTOR = 2.0;

/**
 * The canned specs (2-3 tiny deterministic tasks, each well under a
 * minute per tier — same shapes as the e2e suite's hello/readme/fix-loop
 * sections, minus the fix loop). Baselines are STARTING ESTIMATES —
 * refresh them from real bench runs once this has been run a few times.
 */
export const BENCH_SPECS: BenchSpec[] = [
	{
		id: "hello",
		description: "create hello.txt + commit",
		specMarkdown: `## Goal
Create a file hello.txt containing the text "hi".

## Requirements
- R1: Create hello.txt with content "hi"
- R2: Commit the change with jj using the message "add hello.txt"

## Verification
- test -f hello.txt && grep -q hi hello.txt
`,
		baseline: {
			default: { durationMs: 45_000, costUsd: 0.003 },
			max: { durationMs: 40_000, costUsd: 0.008 },
			full: { durationMs: 30_000, costUsd: 0.002 },
			economy: { durationMs: 25_000, costUsd: 0.001 },
			free: { durationMs: 20_000, costUsd: 0.0005 },
		},
	},
	{
		id: "readme",
		description: "add two README sections + commit",
		specMarkdown: `## Goal
Add two small additions to README.md.

## Requirements
- R1: Add a "## Features" section to README.md listing "fast and reliable"
- R2: Add a line at the end of README.md reading "Updated by the task worker"
- R3: Commit the change with jj (message: "update readme")

## Verification
- grep -q "## Features" README.md
- grep -q "Updated by the task worker" README.md
`,
		baseline: {
			default: { durationMs: 60_000, costUsd: 0.004 },
			max: { durationMs: 55_000, costUsd: 0.012 },
			full: { durationMs: 40_000, costUsd: 0.003 },
			economy: { durationMs: 35_000, costUsd: 0.0015 },
			free: { durationMs: 30_000, costUsd: 0.0008 },
		},
	},
	{
		id: "verify",
		description: "create data.txt + a passing check",
		specMarkdown: `## Goal
Create a data file and a small test that passes.

## Requirements
- R1: Create data.txt containing the text "ok"
- R2: Commit the change with jj (message: "add data.txt")

## Verification
- test -f data.txt && grep -q ok data.txt
`,
		baseline: {
			default: { durationMs: 50_000, costUsd: 0.003 },
			max: { durationMs: 45_000, costUsd: 0.01 },
			full: { durationMs: 35_000, costUsd: 0.0025 },
			economy: { durationMs: 30_000, costUsd: 0.0012 },
			free: { durationMs: 25_000, costUsd: 0.0006 },
		},
	},
];

// ─── Plan assembly (pure) ────────────────────────────────────────────

/** One planned (tier × spec) run with its baseline expectations. */
export interface BenchRunPlan {
	tier: string;
	specId: string;
	specMarkdown: string;
	expectedDurationMs: number;
	expectedCostUsd: number;
}

export interface BenchTierPlan {
	tier: string;
	runs: BenchRunPlan[];
	expectedDurationMs: number;
	expectedCostUsd: number;
}

/** The full dry-run plan: tiers × specs with expected cost/time. */
export interface BenchPlan {
	/** The run-pipeline shape this plan benchmarks (default "code"). */
	shape: string;
	tiers: BenchTierPlan[];
	totalRuns: number;
	totalExpectedDurationMs: number;
	totalExpectedCostUsd: number;
}

/** The baseline for a spec on a tier; unknown tiers → the default entry. */
export function baselineFor(spec: BenchSpec, tier: string, shape?: string): SpecBaseline {
	// Shape-specific baselines ("<tier>@<shape>") take precedence; the
	// per-tier entry (and the required default) remain valid for the code
	// shape. Record per-shape baselines after a few analysis-shape runs.
	return spec.baseline[`${tier}@${shape ?? "code"}`] ?? spec.baseline[tier] ?? spec.baseline.default;
}

/**
 * Assemble the run plan: every tier in `tierOrder` (config-driven —
 * task.toml's tier set) × every spec, with per-run baseline expectations
 * resolved per tier. `tierFilter` restricts to the named tiers (an empty
 * filter = all tiers). Pure — hermetically tested.
 */
export function buildBenchPlan(opts: {
	tiers: Record<BudgetTier, BudgetTierConfig>;
	tierOrder: string[];
	specs?: BenchSpec[];
	tierFilter?: string[];
	shape?: string;
}): BenchPlan {
	const shape = opts.shape ?? "code";
	const specs = opts.specs ?? BENCH_SPECS;
	const tierNames =
		opts.tierFilter && opts.tierFilter.length > 0
			? opts.tierOrder.filter((t) => opts.tierFilter!.includes(t))
			: [...opts.tierOrder];
	let totalRuns = 0;
	let totalExpectedDurationMs = 0;
	let totalExpectedCostUsd = 0;
	const tiers: BenchTierPlan[] = tierNames.map((tier) => {
		const runs = specs.map((spec) => {
			const b = baselineFor(spec, tier, shape);
			return {
				tier,
				specId: spec.id,
				specMarkdown: spec.specMarkdown,
				expectedDurationMs: b.durationMs,
				expectedCostUsd: b.costUsd,
			};
		});
		const expectedDurationMs = runs.reduce((a, r) => a + r.expectedDurationMs, 0);
		const expectedCostUsd = runs.reduce((a, r) => a + r.expectedCostUsd, 0);
		totalRuns += runs.length;
		totalExpectedDurationMs += expectedDurationMs;
		totalExpectedCostUsd += expectedCostUsd;
		return { tier, runs, expectedDurationMs, expectedCostUsd };
	});
	return { tiers, totalRuns, totalExpectedDurationMs, totalExpectedCostUsd, shape };
}

// ─── Baseline comparison (pure) ──────────────────────────────────────

/** One (tier × spec) comparison row: recorded runs vs. the baseline. */
export interface BenchComparisonRow {
	specId: string;
	tier: string;
	/** Recorded runs in this spec's metrics project for this tier. */
	runs: number;
	/** Most recent recorded run (summarizeRuns rows are run-id-ascending). */
	latest: { runId: string; durationMs: number; costUsd: number; verifyPassed: boolean } | null;
	avgDurationMs: number;
	avgCostUsd: number;
	expectedDurationMs: number;
	expectedCostUsd: number;
	/** avg/baseline; 0 when no runs are recorded. */
	durationRatio: number;
	costRatio: number;
	/** Fraction of recorded runs whose verify phase passed (0..1). */
	verifyPassRate: number;
	/** Reasons this row trips the regression thresholds (empty = fine). */
	regressions: string[];
}

/** The metrics project a spec's runs land in: "<prefix><specId>". */
export function projectForSpec(projectPrefix: string, specId: string): string {
	return `${projectPrefix}${specId}`;
}

/**
 * Compare recorded runs (via summarizeRuns' RunSummary per spec project)
 * against the plan's baselines. Only rows matching the row's tier count;
 * averages cover every recorded run for that (tier × spec), so repeated
 * bench runs accumulate data. Pure — hermetically tested.
 */
export function compareToBaselines(opts: {
	plan: BenchPlan;
	projectPrefix: string;
	/** Keyed by full project name (projectForSpec output). */
	summaries: Record<string, RunSummary>;
}): BenchComparisonRow[] {
	const rows: BenchComparisonRow[] = [];
	for (const tierPlan of opts.plan.tiers) {
		for (const run of tierPlan.runs) {
			const summary = opts.summaries[projectForSpec(opts.projectPrefix, run.specId)];
			const tierRows = (summary?.rows ?? []).filter((r) => r.tier === run.tier);
			const runs = tierRows.length;
			const latest = runs > 0 ? tierRows[runs - 1] : null;
			const avgDurationMs = runs > 0 ? tierRows.reduce((a, r) => a + r.durationMs, 0) / runs : 0;
			const avgCostUsd = runs > 0 ? tierRows.reduce((a, r) => a + r.costUsd, 0) / runs : 0;
			const verifyPassRate = runs > 0 ? tierRows.filter((r) => r.verifyPassed).length / runs : 0;
			const durationRatio = runs > 0 ? avgDurationMs / run.expectedDurationMs : 0;
			const costRatio = runs > 0 ? avgCostUsd / run.expectedCostUsd : 0;
			const regressions: string[] = [];
			if (runs > 0 && durationRatio > REGRESSION_DURATION_FACTOR) {
				regressions.push(`duration ${durationRatio.toFixed(2)}x baseline`);
			}
			if (runs > 0 && costRatio > REGRESSION_COST_FACTOR) {
				regressions.push(`cost ${costRatio.toFixed(2)}x baseline`);
			}
			if (runs > 0 && verifyPassRate < 1) {
				regressions.push(`verify failed (${Math.round((1 - verifyPassRate) * runs)}/${runs} runs)`);
			}
			rows.push({
				specId: run.specId,
				tier: run.tier,
				runs,
				latest: latest
					? { runId: latest.runId, durationMs: latest.durationMs, costUsd: latest.costUsd, verifyPassed: latest.verifyPassed }
					: null,
				avgDurationMs,
				avgCostUsd,
				expectedDurationMs: run.expectedDurationMs,
				expectedCostUsd: run.expectedCostUsd,
				durationRatio,
				costRatio,
				verifyPassRate,
				regressions,
			});
		}
	}
	return rows;
}

// ─── Rendering (pure) ────────────────────────────────────────────────

const fmtUsd = (usd: number): string => `$${usd.toFixed(4)}`;

/** Render the dry-run plan (tiers, specs, expected cost/time). Pure. */
export function renderBenchPlan(plan: BenchPlan): string[] {
	const lines = [
		"task bench-regression — dry run (no runs spawned, no LLM calls)",
		`tiers (${plan.tiers.length}): ${plan.tiers.map((t) => t.tier).join(", ") || "(none — check --tier names)"}`,
	];
	const specs = [...new Set(plan.tiers.flatMap((t) => t.runs.map((r) => r.specId)))];
	if (specs.length > 0) {
		lines.push(`specs (${specs.length}):`);
		for (const specId of specs) {
			const spec = BENCH_SPECS.find((s) => s.id === specId);
			lines.push(`  ${specId} — ${spec?.description ?? "?"}`);
		}
	}
	lines.push(`planned runs (${plan.totalRuns}):`);
	for (const t of plan.tiers) {
		for (const r of t.runs) {
			lines.push(
				`  ${r.tier.padEnd(9)} × ${r.specId.padEnd(7)} ${formatDuration(r.expectedDurationMs).padStart(7)} ` +
					`${fmtUsd(r.expectedCostUsd).padStart(9)}`,
			);
		}
	}
	lines.push(
		`estimated: ${plan.totalRuns} runs · ${formatDuration(plan.totalExpectedDurationMs)} · ` +
			`${fmtUsd(plan.totalExpectedCostUsd)}`,
	);
	return lines;
}

/** Render the comparison report (recorded runs vs. baselines). Pure. */
export function renderBenchReport(rows: BenchComparisonRow[]): string[] {
	const withData = rows.filter((r) => r.runs > 0);
	const regressions = rows.filter((r) => r.regressions.length > 0);
	const lines = [
		`bench report: ${rows.length} tier×spec row(s) · ${withData.length} with data · ` +
			`${regressions.length} regression(s)`,
	];
	for (const r of rows) {
		const data =
			r.runs === 0
				? "(no runs recorded yet)"
				: `${r.runs} run${r.runs > 1 ? "s" : ""} · latest ${formatDuration(r.latest!.durationMs)} ` +
					`${fmtUsd(r.latest!.costUsd)} ${r.latest!.verifyPassed ? "✓" : "✗"} · avg ` +
					`${formatDuration(r.avgDurationMs)} ${fmtUsd(r.avgCostUsd)} ` +
					`(${r.durationRatio.toFixed(2)}x/${r.costRatio.toFixed(2)}x baseline)`;
		const flag = r.regressions.length > 0 ? `  ⚠ ${r.regressions.join("; ")}` : "";
		lines.push(`  ${r.tier.padEnd(9)} × ${r.specId.padEnd(7)} ${data}${flag}`);
	}
	if (regressions.length > 0) {
		lines.push(
			`regression thresholds: ${REGRESSION_DURATION_FACTOR}x duration / ${REGRESSION_COST_FACTOR}x cost ` +
				`(tune in extensions/task/bench-regression.ts)`,
		);
	}
	return lines;
}

// ─── Runner (non-pure; lazy-imports the orchestrator) ────────────────

export interface BenchRunFailure {
	tier: string;
	specId: string;
	cause: string;
}

export interface BenchRunOutcome {
	exitCode: number;
	plan: BenchPlan;
	failures: BenchRunFailure[];
	report: string[];
}

export interface BenchOptions {
	tiers: Record<BudgetTier, BudgetTierConfig>;
	tierOrder: string[];
	shapes: Record<string, TaskShape>;
	/** Run-pipeline shape to benchmark (default "code"; "analysis" for the
	 *  strong-writer shape). Baselines key "<tier>@<shape>" with a tier
	 *  fallback. */
	shape?: string;
	tierFilter?: string[];
	specs?: BenchSpec[];
	metricsDir: string;
	projectPrefix?: string;
	dryRun?: boolean;
	sandbox?: SandboxConfig;
}

/**
 * Run the bench: for each planned (tier × spec), spawn a fresh temp jj
 * workspace and run the canned spec through executeTask with the tier's
 * configured models/sandbox; manifests land via the existing metrics write
 * path (writeManifest). Afterwards read the runs back through
 * summarizeRuns and compare against the baselines. `dryRun` prints the
 * plan and returns without spawning anything.
 */
export async function runBench(opts: BenchOptions): Promise<BenchRunOutcome> {
	const projectPrefix = opts.projectPrefix ?? "bench-";
	const plan = buildBenchPlan({
		tiers: opts.tiers,
		tierOrder: opts.tierOrder,
		specs: opts.specs,
		tierFilter: opts.tierFilter,
		shape: opts.shape,
	});

	if (opts.dryRun) {
		return { exitCode: 0, plan, failures: [], report: renderBenchPlan(plan) };
	}

	const specs = opts.specs ?? BENCH_SPECS;
	const failures: BenchRunFailure[] = [];
	for (const tierPlan of plan.tiers) {
		const tierConfig = opts.tiers[tierPlan.tier];
		if (!tierConfig) {
			failures.push({ tier: tierPlan.tier, specId: "(plan)", cause: `no tier config for "${tierPlan.tier}"` });
			continue;
		}
		for (const run of tierPlan.runs) {
			const spec = specs.find((s) => s.id === run.specId);
			if (!spec) continue;
			console.log(`\n── bench: ${run.tier} × ${run.specId} (${spec.description}) ──`);
			try {
				const shape = resolveTaskShape(opts.shape ?? tierConfig.shape, opts.shapes);
				await runOne({
					tier: run.tier,
					tierConfig,
					spec,
					shape,
					metricsDir: opts.metricsDir,
					project: projectForSpec(projectPrefix, run.specId),
					sandbox: opts.sandbox,
				});
			} catch (err) {
				failures.push({
					tier: run.tier,
					specId: run.specId,
					cause: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	// Read the runs back through the existing metrics consumption path.
	const summaries: Record<string, RunSummary> = {};
	const projects = new Set(plan.tiers.flatMap((t) => t.runs.map((r) => projectForSpec(projectPrefix, r.specId))));
	for (const project of projects) {
		summaries[project] = summarizeRuns(opts.metricsDir, project);
	}
	const rows = compareToBaselines({ plan, projectPrefix, summaries });
	const report = [
		...renderBenchReport(rows),
		...(failures.length > 0
			? [`${failures.length} run(s) failed: ${failures.map((f) => `${f.tier}/${f.specId}: ${f.cause}`).join("; ")}`]
			: []),
	];
	const exitCode = failures.length > 0 ? 1 : rows.some((r) => r.regressions.length > 0) ? 2 : 0;
	return { exitCode, plan, failures, report };
}

/** One (tier × spec) run: temp jj workspace → executeTask → manifest on disk. */
async function runOne(opts: {
	tier: string;
	tierConfig: BudgetTierConfig;
	spec: BenchSpec;
	shape: TaskShape;
	metricsDir: string;
	project: string;
	sandbox?: SandboxConfig;
}): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pi-task-bench-"));
	try {
		execSync("jj git init --colocate", { cwd: dir, stdio: "pipe" });
		writeFileSync(join(dir, "README.md"), "# Bench repo\n", "utf-8");
		execSync('jj commit -m "init"', { cwd: dir, stdio: "pipe" });

		// Lazy import: the orchestrator (and its worker machinery) loads
		// only when a run actually happens — dry-run and hermetic tests
		// never pull it in.
		const { executeTask } = await import("./orchestrator.ts");
		const result = await executeTask({
			cwd: dir,
			model: opts.tierConfig.executeModel,
			prewalkModel: opts.tierConfig.prewalkModel ?? undefined,
			executeModel: opts.tierConfig.executeModel,
			review: opts.tierConfig.review,
			reviewModel: opts.tierConfig.reviewModel,
			workerTimeoutMs: opts.tierConfig.wallTimeoutMs,
			budget: opts.tier,
			shape: opts.shape,
			metricsDir: opts.metricsDir,
			project: opts.project,
			sandbox: opts.sandbox,
		});
		if (!result.verification.passed) {
			const detail = result.verification.failures
				.map((f) => `exit ${f.exitCode}: ${f.command}`)
				.join("; ");
			throw new Error(`verification failed (${detail})`);
		}
		console.log(
			`  ✓ ${opts.tier} × ${opts.spec.id}: ${formatDuration(result.durationMs)} · ` +
				`${fmtUsd(result.manifest?.totals.cost_usd ?? 0)} · verify pass`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ─── CLI ─────────────────────────────────────────────────────────────

export interface BenchCliArgs {
	tierFilter: string[];
	dryRun: boolean;
	metricsDir?: string;
	help: boolean;
}

/** Parse the CLI flags. Pure — tested. */
export function parseBenchArgs(argv: string[]): BenchCliArgs {
	const out: BenchCliArgs = { tierFilter: [], dryRun: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--shape") {
			const value = argv[++i];
			if (value === undefined) throw new Error("--shape requires a value");
			out.shape = value;
		} else if (arg === "--tier") {
			const value = argv[++i];
			if (value === undefined) throw new Error("--tier requires a value");
			out.tierFilter.push(value);
		} else if (arg === "--dry-run") {
			out.dryRun = true;
		} else if (arg === "--metrics-dir") {
			const value = argv[++i];
			if (value === undefined) throw new Error("--metrics-dir requires a value");
			out.metricsDir = value;
		} else if (arg === "--help" || arg === "-h") {
			out.help = true;
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return out;
}

const USAGE = `usage: npx tsx extensions/task/bench-regression.ts [--tier <name>] [--dry-run]

Runs tiny canned specs per budget tier (models from task.toml) and reports
latency/cost against shipped baselines. See the header of this file.

flags:
  --tier <name>     restrict to one tier (repeatable)
  --shape <name>    run-pipeline shape to benchmark (default: code;
                    analysis benchmarks the strong-writer shape)
  --dry-run         print the run plan and exit 0 (no spawns, no LLM)
  --metrics-dir <p> metrics dir (default: <agent-dir>/results)
  --help            print this help

exit codes: 0 ok · 1 a run failed · 2 regressions vs. baselines`;

async function main(): Promise<number> {
	let args: BenchCliArgs;
	try {
		args = parseBenchArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`bench-regression: ${(err as Error).message}`);
		console.error(USAGE);
		return 1;
	}
	if (args.help) {
		console.log(USAGE);
		return 0;
	}
	const config = loadTaskConfig();
	const metricsDir = args.metricsDir ?? join(getAgentDir(), "results");
	const outcome = await runBench({
		tiers: config.tiers,
		tierOrder: config.tierOrder,
		shapes: config.shapes,
		shape: args.shape,
		tierFilter: args.tierFilter,
		metricsDir,
		dryRun: args.dryRun,
		sandbox: config.sandbox,
	});
	for (const line of outcome.report) console.log(line);
	return outcome.exitCode;
}

// Guard: only run when executed directly (never on import — the hermetic
// tests import the pure parts, and runBench is invoked explicitly).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error("bench-regression FAILED:", err instanceof Error ? err.message : err);
			process.exit(1);
		});
}
