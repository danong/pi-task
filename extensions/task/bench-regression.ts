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
 *   npx tsx extensions/task/bench-regression.ts [--tier <name>] [--spec <id>] [--dry-run]
 *
 * Flags:
 *   --tier <name>     Restrict the run to one tier (repeatable).
 *   --spec <id>       Restrict the run to one spec id (repeatable);
 *                     matches canned AND suite-03 grounding specs.
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
 * Suite-03 (GROUNDING_SPECS, docs/pi-task-v2.md §7) adds grounding-heavy
 * specs that run against a seeded ~100k-LOC synthetic fixture each run
 * materializes into the bench repo before the worker spawns.
 *
 * The pure parts (plan assembly, baseline comparison, rendering) are
 * exported and hermetically tested in test-bench-regression.ts; the runner
 * lazily imports the orchestrator only when it actually runs tasks, so
 * importing this module never pulls the worker machinery into the fast
 * suite's module graph.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

// ─── Suite-03 grounding-heavy specs (R4/M0) ──────────────────────────

/**
 * test-bench-regression.ts (v1) locks BENCH_SPECS.length to 2-3 and its
 * <=60s baseline bounds, so suite-03 (docs/pi-task-v2.md §7) lands in its
 * OWN list. The runner's default spec set is ALL_SPECS (BENCH_SPECS +
 * GROUNDING_SPECS), so a plain dry-run or real run includes the grounding
 * suite without disturbing BENCH_SPECS; --spec <id> narrows any run to
 * named ids across both lists.
 */

/** Deterministic body of a synthesized grounding fixture. */
export interface GroundingBody {
	/** PRNG seed (the generated graph is identical run-to-run per seed). */
	seed: number;
	/** Cross-importing module files spread across GROUNDING_LAYERS. */
	files: number;
	/** Lines of well-formed code per module file (total ≈ files × this). */
	locPerFile: number;
}

/** A suite-03 spec: a BenchSpec plus the seeded fixture it runs against. */
export interface GroundingSpec extends BenchSpec {
	/** Non-optional: runOne materializes this into the repo before the
	 *  worker spawns. */
	fixture: GroundingBody;
}

/** Fixture layer: a directory of same-prefix modules (grounding surface). */
export interface GroundingLayer {
	/** Module name prefix ("<prefix>NNNN.ts", NNNN = zero-padded index). */
	prefix: string;
	/** Directory the layer's modules live in (repo-relative). */
	dir: string;
}

/**
 * The suite-03 layers in dependency order: handlers import services,
 * services import types — navigating the fixture means crossing
 * directories, which is what makes these specs grounding-heavy.
 */
export const GROUNDING_LAYERS: GroundingLayer[] = [
	{ prefix: "type", dir: "packages/types" },
	{ prefix: "svc", dir: "services" },
	{ prefix: "handler", dir: "handlers" },
];

/** Which layer the i-th module belongs to (layers split the id space). */
export function groundingLayerOf(i: number, files: number): number {
	const per = Math.max(1, Math.floor(files / GROUNDING_LAYERS.length));
	return Math.min(Math.floor(i / per), GROUNDING_LAYERS.length - 1);
}

/** GROUNDING_LAYERS entry for a layer index produced by
 *  {@link groundingLayerOf} — that function clamps to the table's range,
 *  so the guard below is unreachable in practice (noUncheckedIndexedAccess
 *  just cannot see the clamp). Throws rather than asserting. */
function groundingLayerAt(index: number) {
	const layer = GROUNDING_LAYERS[index];
	if (layer === undefined)
		throw new Error(`grounding layer index ${index} out of range`);
	return layer;
}

/** Base name (no extension) of the i-th fixture module. */
export function groundingModuleName(i: number, files: number): string {
	return `${groundingLayerAt(groundingLayerOf(i, files)).prefix}${String(i).padStart(4, "0")}`;
}

/**
 * mulberry32 — tiny deterministic PRNG, no stdlib, pure. Seeded per spec
 * so the synthesized graph is identical run-to-run.
 */
export function mulberry32(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Relative import specifier (no extension) from module `from` to `to`. */
export function groundingImportPath(
	fromLayer: number,
	to: number,
	files: number,
): string {
	const fromSegs = groundingLayerAt(fromLayer).dir.split("/");
	const toLayer = groundingLayerOf(to, files);
	const toSegs = groundingLayerAt(toLayer).dir.split("/");
	let common = 0;
	while (
		common < fromSegs.length &&
		common < toSegs.length &&
		fromSegs[common] === toSegs[common]
	)
		common++;
	const ups = fromSegs.slice(common).map(() => "..");
	const downs = toSegs.slice(common);
	const name = groundingModuleName(to, files);
	if (ups.length === 0 && downs.length === 0) return `./${name}`;
	return [...ups, ...downs, name].join("/");
}

/**
 * Pure: synthesize a cross-importing TypeScript corpus — `files` modules
 * spread across GROUNDING_LAYERS (packages/types, services, handlers),
 * each importing 2-4 strictly-earlier modules (a DAG by construction, at
 * least one cross-layer edge per non-root-layer module) and padded to
 * `locPerFile` lines of distinct well-formed code, plus an index.ts
 * "front door" at the repo root importing a fixed spread across all three
 * layers. Total ≈ files × locPerFile LOC (suite uses 210 × 480 ≈ 100k).
 */
export function buildGroundingFixture(
	body: GroundingBody,
): Array<{ path: string; content: string }> {
	if (body.files < GROUNDING_LAYERS.length) {
		throw new Error(
			`grounding fixture needs >= ${GROUNDING_LAYERS.length} files, got ${body.files}`,
		);
	}
	if (body.locPerFile < 16)
		throw new Error(
			`grounding fixture locPerFile must be >= 16, got ${body.locPerFile}`,
		);
	const rand = mulberry32(body.seed);
	const per = Math.max(1, Math.floor(body.files / GROUNDING_LAYERS.length));
	const layerStart = (layer: number): number => layer * per;
	const layerEnd = (layer: number): number =>
		layer === GROUNDING_LAYERS.length - 1 ? body.files : (layer + 1) * per;
	const out: Array<{ path: string; content: string }> = [];
	for (let i = 0; i < body.files; i++) {
		const layer = groundingLayerOf(i, body.files);
		const name = groundingModuleName(i, body.files);
		// Deps: strictly earlier module ids → acyclic by construction.
		const deps = new Set<number>();
		const nDeps = 2 + Math.floor(rand() * 3); // 2-4
		if (i > 0) {
			if (layer > 0) {
				// Guaranteed cross-layer edge into the previous layer.
				const start = layerStart(layer - 1);
				deps.add(start + Math.floor(rand() * (layerEnd(layer - 1) - start)));
			}
			let guard = 0;
			while (deps.size < nDeps && guard++ < 64)
				deps.add(Math.floor(rand() * i));
		}
		const lines: string[] = [];
		for (const d of [...deps].sort((a, b) => a - b)) {
			lines.push(
				`import { ${groundingModuleName(d, body.files)}Estimate } from \"${groundingImportPath(layer, d, body.files)}\";`,
			);
		}
		if (lines.length > 0) lines.push("");
		const depSum = [...deps]
			.sort((a, b) => a - b)
			.map((d) => `${groundingModuleName(d, body.files)}Estimate`)
			.join(" + ");
		lines.push(
			`export const ${name}Estimate = ${depSum.length > 0 ? `${depSum} + ` : ""}${i};`,
			`export interface ${name}Shape { id: number; label: string; depth: ${layer} }`,
			`export function ${name}Describe(): string { return \"${name}\"; }`,
		);
		const fixed = lines.length;
		for (let k = 0; k < Math.max(0, body.locPerFile - fixed); k++) {
			lines.push(
				`export const ${name}_p${k} = ${(i * 7919 + k * 104729) % 65536};`,
			);
		}
		out.push({
			path: join(groundingLayerAt(layer).dir, `${name}.ts`),
			content: lines.join("\n") + "\n",
		});
	}
	// The front door: index.ts at the repo root imports a fixed spread
	// across all three layers (the grounding-anchor spec starts here).
	const spread = [0, 1, 25, 70, 99, 104, 140, 199, 200, 209].filter(
		(d) => d < body.files,
	);
	const index = [
		"// suite-03 grounding fixture — front door (generated).",
		"// Imports a fixed spread of modules across packages/types, services,",
		"// and handlers.",
		"",
		...spread.map(
			(d) =>
				`import { ${groundingModuleName(d, body.files)}Estimate } from \"./${groundingLayerAt(groundingLayerOf(d, body.files)).dir}/${groundingModuleName(d, body.files)}\";`,
		),
		"",
		"export const FIXTURE_ESTIMATE = 42;",
	];
	out.push({ path: "index.ts", content: index.join("\n") + "\n" });
	return out;
}

/** Files written / LOC committed by materializeGroundingFixture. */
export interface GroundingFixtureStats {
	files: number;
	loc: number;
}

/**
 * Materialize a fixture INTO a jj-tracked bench workspace and commit it,
 * so the worker orients over a real, tracked, cross-importing graph.
 * Composes with runOne's temp-repo creation (called after the init
 * commit, before the worker spawns).
 */
export function materializeGroundingFixture(
	dir: string,
	body: GroundingBody,
): GroundingFixtureStats {
	const files = buildGroundingFixture(body);
	let loc = 0;
	for (const f of files) {
		const p = join(dir, f.path);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, f.content, "utf-8");
		loc += f.content.split("\n").length - 1;
	}
	execSync(
		`jj commit -m \"suite-03 grounding fixture (${body.files} modules, seed ${body.seed})\"`,
		{
			cwd: dir,
			stdio: "pipe",
		},
	);
	return { files: files.length, loc };
}

/**
 * Suite-03 cold-grounding specs. Each REQUIRES the worker to orient over
 * the ~100k-LOC / 210-module tracked fixture; every Verification command
 * is plain bash and asserts against the REAL tree (never a count answered
 * in the prompt). Baselines carry a pre-R5 estimate fallback ("default")
 * plus the RECORDED bench-good numbers landed by R5 (once per spec, tiered).
 */
export const GROUNDING_SPECS: GroundingSpec[] = [
	{
		id: "grounding-anchor",
		description:
			"ground at the fixture front door, list the modules it imports",
		specMarkdown: `## Goal
A synthetic TypeScript fixture (suite-03) fills this repo: modules under
packages/types/, services/, and handlers/ cross-import each other. Orient
from the single anchor file index.ts at the repo root.

## Requirements
- R1: Read index.ts and identify every module it imports.
- R2: Write INDEX.md at the repo root listing each imported module's bare file name (e.g. type0000.ts), one per line, no other content.
- R3: Commit the change with jj (message: "grounding-anchor")

## Verification
- test -f INDEX.md
- test "$(grep -cE '^(type|svc|handler)[0-9]{4}\\.ts$' INDEX.md | tr -d ' ')" -ge 10
- test "$(find packages services handlers -name '*.ts' | wc -l | tr -d ' ')" -ge 200
- test "$(find packages services handlers index.ts -name '*.ts' -print0 | xargs -0 cat | wc -l | tr -d ' ')" -ge 100000
`,
		fixture: { seed: 42, files: 210, locPerFile: 480 },
		baseline: {
			// RECORDED baseline — anchoring spec, tier bench-good (seed 42) from a
			// real run. "default" mirrors the bench-good measurement until other
			// tiers are measured (custom tiers fall back here by design).
			default: { durationMs: 33_207, costUsd: 0 },
			"bench-good": { durationMs: 33_207, costUsd: 0 },
		},
	},
	{
		id: "grounding-imports",
		description: "count the cross-file import edges over the fixture",
		specMarkdown: `## Goal
The fixture in this repo (packages/types/, services/, handlers/) is a DAG
of module imports. Count its edges by scanning the tree — index.ts at the
repo root is the front door but is NOT part of the count.

## Requirements
- R1: Count every line that starts with "import " across all *.ts files under packages/, services/, and handlers/ (repo-root index.ts excluded).
- R2: Write INVENTORY.md at the repo root containing a single line "edges: <N>" with that count.
- R3: Commit the change with jj (message: "import-edges")

## Verification
- test -f INVENTORY.md
- test "$(grep -c '^edges: ' INVENTORY.md | tr -d ' ')" -eq 1
- test "$(grep -oE '^edges: [0-9]+' INVENTORY.md)" = "edges: $(grep -rh '^import ' packages services handlers | wc -l | tr -d ' ')"
- test "$(find packages services handlers -name '*.ts' | wc -l | tr -d ' ')" -ge 200
`,
		fixture: { seed: 1337, files: 210, locPerFile: 480 },
		baseline: {
			// RECORDED baseline — import-scanning spec, tier bench-good (seed
			// 1337) from a real run. "default" mirrors the bench-good measurement
			// until other tiers are measured (custom tiers fall back by design).
			default: { durationMs: 53_078, costUsd: 0 },
			"bench-good": { durationMs: 53_078, costUsd: 0 },
		},
	},
	{
		id: "grounding-surface",
		description: "recover the fixture's max module index by scanning",
		specMarkdown: `## Goal
The fixture's modules follow a strict naming pattern: <prefix>NNNN.ts
where NNNN is a zero-padded module index, across packages/types/,
services/, and handlers/. Recover the surface extent by scanning.

## Requirements
- R1: Find the largest module index NNNN defined by any *.ts file under packages/, services/, and handlers/.
- R2: Write SURFACE.md at the repo root containing a single line "max-module-index: <N>" where <N> is that index as a plain decimal number (no leading zeros).
- R3: Commit the change with jj (message: "grounding-surface")

## Verification
- test -f SURFACE.md
- test "$(grep -c '^max-module-index: ' SURFACE.md | tr -d ' ')" -eq 1
- test "$(grep -oE '^max-module-index: [0-9]+' SURFACE.md)" = "max-module-index: $(find packages services handlers -name '*.ts' | grep -oE '[0-9]{4}' | sort -n | tail -1 | sed 's/^0*//')"
- test "$(find packages services handlers -name '*.ts' | wc -l | tr -d ' ')" -ge 200
`,
		fixture: { seed: 2048, files: 210, locPerFile: 480 },
		baseline: {
			// RECORDED baseline — surface-scan tier bench-good (seed 2048) from a
			// real run; the "default" fallback below stays intact for custom tiers.
			default: { durationMs: 37_111, costUsd: 0 },
			"bench-good": { durationMs: 37_111, costUsd: 0 },
		},
	},
];

/**
 * Bench spectrum: BENCH_SPECS (v1 canned, length-locked at 2-3) FIRST,
 * then GROUNDING_SPECS (suite-03). The runner's default spec set.
 */
export const ALL_SPECS: BenchSpec[] = [...BENCH_SPECS, ...GROUNDING_SPECS];

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
export function baselineFor(
	spec: BenchSpec,
	tier: string,
	shape?: string,
): SpecBaseline {
	// Shape-specific baselines ("<tier>@<shape>") take precedence; the
	// per-tier entry (and the required default) remain valid for the code
	// shape. Record per-shape baselines after a few analysis-shape runs.
	return (
		spec.baseline[`${tier}@${shape ?? "code"}`] ??
		spec.baseline[tier] ??
		spec.baseline.default
	);
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
	specs?: BenchSpec[] | undefined;
	tierFilter?: string[] | undefined;
	shape?: string | undefined;
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
		const expectedDurationMs = runs.reduce(
			(a, r) => a + r.expectedDurationMs,
			0,
		);
		const expectedCostUsd = runs.reduce((a, r) => a + r.expectedCostUsd, 0);
		totalRuns += runs.length;
		totalExpectedDurationMs += expectedDurationMs;
		totalExpectedCostUsd += expectedCostUsd;
		return { tier, runs, expectedDurationMs, expectedCostUsd };
	});
	return {
		tiers,
		totalRuns,
		totalExpectedDurationMs,
		totalExpectedCostUsd,
		shape,
	};
}

// ─── Baseline comparison (pure) ──────────────────────────────────────

/** One (tier × spec) comparison row: recorded runs vs. the baseline. */
export interface BenchComparisonRow {
	specId: string;
	tier: string;
	/** Recorded runs in this spec's metrics project for this tier. */
	runs: number;
	/** Most recent recorded run (summarizeRuns rows are run-id-ascending). */
	latest: {
		runId: string;
		durationMs: number;
		costUsd: number;
		verifyPassed: boolean;
	} | null;
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
			const summary =
				opts.summaries[projectForSpec(opts.projectPrefix, run.specId)];
			const tierRows = (summary?.rows ?? []).filter((r) => r.tier === run.tier);
			const runs = tierRows.length;
			const latest = runs > 0 ? tierRows[runs - 1] : null;
			const avgDurationMs =
				runs > 0 ? tierRows.reduce((a, r) => a + r.durationMs, 0) / runs : 0;
			const avgCostUsd =
				runs > 0 ? tierRows.reduce((a, r) => a + r.costUsd, 0) / runs : 0;
			const verifyPassRate =
				runs > 0 ? tierRows.filter((r) => r.verifyPassed).length / runs : 0;
			const durationRatio =
				runs > 0 ? avgDurationMs / run.expectedDurationMs : 0;
			// A non-positive expected cost (free-model runs, un-measured specs)
			// makes the ratio undefined/Infinite — cost is then NON-COMPARABLE,
			// never a regression. Ratio 0 = "no data", matching duration above.
			const costRatio =
				runs > 0 && run.expectedCostUsd > 0
					? avgCostUsd / run.expectedCostUsd
					: 0;
			const regressions: string[] = [];
			if (runs > 0 && durationRatio > REGRESSION_DURATION_FACTOR) {
				regressions.push(`duration ${durationRatio.toFixed(2)}x baseline`);
			}
			if (runs > 0 && costRatio > REGRESSION_COST_FACTOR) {
				regressions.push(`cost ${costRatio.toFixed(2)}x baseline`);
			}
			if (runs > 0 && verifyPassRate < 1) {
				regressions.push(
					`verify failed (${Math.round((1 - verifyPassRate) * runs)}/${runs} runs)`,
				);
			}
			rows.push({
				specId: run.specId,
				tier: run.tier,
				runs,
				latest: latest
					? {
							runId: latest.runId,
							durationMs: latest.durationMs,
							costUsd: latest.costUsd,
							verifyPassed: latest.verifyPassed,
						}
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
	const specs = [
		...new Set(plan.tiers.flatMap((t) => t.runs.map((r) => r.specId))),
	];
	if (specs.length > 0) {
		lines.push(`specs (${specs.length}):`);
		for (const specId of specs) {
			const spec = ALL_SPECS.find((s) => s.id === specId);
			lines.push(`  ${specId} — ${spec?.description ?? "?"}`);
		}
	}
	lines.push(`planned runs (${plan.totalRuns}):`);
	for (const t of plan.tiers) {
		for (const r of t.runs) {
			lines.push(
				`  ${r.tier.padEnd(9)} × ${r.specId.padEnd(16)} ${formatDuration(r.expectedDurationMs).padStart(7)} ` +
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
		const flag =
			r.regressions.length > 0 ? `  ⚠ ${r.regressions.join("; ")}` : "";
		lines.push(`  ${r.tier.padEnd(9)} × ${r.specId.padEnd(16)} ${data}${flag}`);
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
	 *  fallback. Optional AND nullable under exactOptionalPropertyTypes —
	 *  callers forward their own `T | undefined` options verbatim. */
	shape?: string | undefined;
	tierFilter?: string[] | undefined;
	/** Narrow to these spec ids (--spec, repeatable). Empty = the full
	 *  default set. Unknown ids are an error. */
	specFilter?: string[] | undefined;
	/** Explicit spec set; defaults to ALL_SPECS (canned + suite-03). */
	specs?: BenchSpec[];
	metricsDir: string;
	projectPrefix?: string | undefined;
	dryRun?: boolean | undefined;
	sandbox?: SandboxConfig | undefined;
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
	const specSet = opts.specs ?? ALL_SPECS;
	const specFilter = opts.specFilter ?? [];
	const unknown = specFilter.filter((id) => !specSet.some((s) => s.id === id));
	if (unknown.length > 0) {
		throw new Error(
			`--spec matched no known spec id(s): ${unknown.join(", ")} (known: ${specSet.map((s) => s.id).join(", ")})`,
		);
	}
	const specs =
		specFilter.length > 0
			? specSet.filter((s) => specFilter.includes(s.id))
			: [...specSet];
	const plan = buildBenchPlan({
		tiers: opts.tiers,
		tierOrder: opts.tierOrder,
		specs,
		tierFilter: opts.tierFilter,
		shape: opts.shape,
	});

	if (opts.dryRun) {
		return { exitCode: 0, plan, failures: [], report: renderBenchPlan(plan) };
	}

	const failures: BenchRunFailure[] = [];
	for (const tierPlan of plan.tiers) {
		const tierConfig = opts.tiers[tierPlan.tier];
		if (!tierConfig) {
			failures.push({
				tier: tierPlan.tier,
				specId: "(plan)",
				cause: `no tier config for "${tierPlan.tier}"`,
			});
			continue;
		}
		for (const run of tierPlan.runs) {
			const spec = specs.find((s) => s.id === run.specId);
			if (!spec) continue;
			console.log(
				`\n── bench: ${run.tier} × ${run.specId} (${spec.description}) ──`,
			);
			try {
				const shape = resolveTaskShape(
					opts.shape ?? tierConfig.shape,
					opts.shapes,
				);
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
	const projects = new Set(
		plan.tiers.flatMap((t) =>
			t.runs.map((r) => projectForSpec(projectPrefix, r.specId)),
		),
	);
	for (const project of projects) {
		summaries[project] = summarizeRuns(opts.metricsDir, project);
	}
	const rows = compareToBaselines({ plan, projectPrefix, summaries });
	const report = [
		...renderBenchReport(rows),
		...(failures.length > 0
			? [
					`${failures.length} run(s) failed: ${failures.map((f) => `${f.tier}/${f.specId}: ${f.cause}`).join("; ")}`,
				]
			: []),
	];
	const exitCode =
		failures.length > 0
			? 1
			: rows.some((r) => r.regressions.length > 0)
				? 2
				: 0;
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
	sandbox?: SandboxConfig | undefined;
}): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pi-task-bench-"));
	try {
		execSync("jj git init --colocate", { cwd: dir, stdio: "pipe" });
		writeFileSync(join(dir, "README.md"), "# Bench repo\n", "utf-8");
		execSync('jj commit -m "init"', { cwd: dir, stdio: "pipe" });

		// Suite-03: grounding-heavy specs materialize their seeded fixture
		// INTO the bench repo (committed) before the worker spawns, so the
		// worker orients over a real tracked ~100k-LOC graph.
		const fixture = (opts.spec as GroundingSpec).fixture;
		if (fixture) {
			const stats = materializeGroundingFixture(dir, fixture);
			console.log(
				`  fixture: ${stats.files} files · ${stats.loc} LOC (seed ${fixture.seed})`,
			);
		}

		// Lazy import: the orchestrator (and its worker machinery) loads
		// only when a run actually happens — dry-run and hermetic tests
		// never pull it in.
		const { executeTask } = await import("./orchestrator.ts");
		const result = await executeTask({
			cwd: dir,
			spec: opts.spec.specMarkdown,
			model: opts.tierConfig.executeModel,
			// prewalkModel omitted when null (exactOptionalPropertyTypes:
			// an explicit undefined is not assignable to `prewalkModel?: string`).
			...(opts.tierConfig.prewalkModel !== null
				? { prewalkModel: opts.tierConfig.prewalkModel }
				: {}),
			executeModel: opts.tierConfig.executeModel,
			review: opts.tierConfig.review,
			reviewModel: opts.tierConfig.reviewModel,
			workerTimeoutMs: opts.tierConfig.wallTimeoutMs,
			budget: opts.tier,
			shape: opts.shape,
			metricsDir: opts.metricsDir,
			project: opts.project,
			// sandbox omitted when unset (exactOptionalPropertyTypes: an
			// explicit undefined is not assignable to `sandbox?: SandboxConfig`).
			...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
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
	specFilter: string[];
	shape?: string;
	dryRun: boolean;
	metricsDir?: string;
	help: boolean;
}

/** Parse the CLI flags. Pure — tested. */
export function parseBenchArgs(argv: string[]): BenchCliArgs {
	const out: BenchCliArgs = {
		tierFilter: [],
		specFilter: [],
		dryRun: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--shape") {
			const value = argv[++i];
			if (value === undefined) throw new Error("--shape requires a value");
			out.shape = value;
		} else if (arg === "--spec") {
			const value = argv[++i];
			if (value === undefined) throw new Error("--spec requires a value");
			out.specFilter.push(value);
		} else if (arg === "--tier") {
			const value = argv[++i];
			if (value === undefined) throw new Error("--tier requires a value");
			out.tierFilter.push(value);
		} else if (arg === "--dry-run") {
			out.dryRun = true;
		} else if (arg === "--metrics-dir") {
			const value = argv[++i];
			if (value === undefined)
				throw new Error("--metrics-dir requires a value");
			out.metricsDir = value;
		} else if (arg === "--help" || arg === "-h") {
			out.help = true;
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return out;
}

const USAGE = `usage: npx tsx extensions/task/bench-regression.ts [--tier <name>] [--spec <id>] [--dry-run]

Runs tiny canned specs per budget tier (models from task.toml) and reports
latency/cost against shipped baselines. See the header of this file.

flags:
  --tier <name>     restrict to one tier (repeatable)
  --spec <id>       restrict to one spec id (repeatable; matches canned
                    and suite-03 grounding specs)
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
		specFilter: args.specFilter,
		metricsDir,
		dryRun: args.dryRun,
		sandbox: config.sandbox,
	});
	for (const line of outcome.report) console.log(line);
	return outcome.exitCode;
}

// Guard: only run when executed directly (never on import — the hermetic
// tests import the pure parts, and runBench is invoked explicitly).
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(
				"bench-regression FAILED:",
				err instanceof Error ? err.message : err,
			);
			process.exit(1);
		});
}
