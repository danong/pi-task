/**
 * Hermetic tests for bench-regression.ts — the pure parts only: canned-spec
 * shape (each parses and is well under a minute per tier), plan assembly
 * (tier filtering, per-tier baseline resolution, totals), baseline
 * comparison (tier matching, averages, regression thresholds), project
 * naming, arg parsing, and plan/report rendering. No subprocess, no LLM,
 * no fs. The runner (runBench/runOne) spawns real pi and is exercised
 * manually like test-e2e.ts.
 *
 * Run standalone: npx tsx extensions/task/test-bench-regression.ts
 */

import { pathToFileURL } from "node:url";
import {
	BUDGET_TIERS,
	DEFAULT_BUDGET_TIERS,
	type BudgetTierConfig,
} from "./config.ts";
import { parseSpec } from "./schemas/spec.ts";
import type { RunRow, RunSummary } from "./metrics.ts";
import {
	BENCH_SPECS,
	REGRESSION_COST_FACTOR,
	REGRESSION_DURATION_FACTOR,
	baselineFor,
	buildBenchPlan,
	compareToBaselines,
	parseBenchArgs,
	projectForSpec,
	renderBenchPlan,
	renderBenchReport,
	buildGroundingFixture,
	GROUNDING_SPECS,
	type BenchComparisonRow,
	type BenchSpec,
} from "./bench-regression.ts";

/** A fake tier table for plan tests (config-driven vocabulary = any names). */
const FAKE_TIERS: Record<string, BudgetTierConfig> = {
	full: {
		prewalkModel: "pre/m",
		executeModel: "exe/m",
		reviewModel: "rev/m",
		review: true,
		wallTimeoutMs: 60_000,
		checklist: true,
		shape: "code",
		turnBudget: 50,
	},
	custom: {
		prewalkModel: null,
		executeModel: "fast/m",
		reviewModel: "fast/m",
		review: false,
		wallTimeoutMs: 60_000,
		checklist: true,
		shape: "code",
		turnBudget: 50,
	},
};

/** A custom spec with tier + default baselines (for fallback coverage). */
const CUSTOM_SPEC: BenchSpec = {
	id: "custom-spec",
	description: "a custom spec",
	specMarkdown: `## Goal
Make a marker file.

## Requirements
- R1: Create marker.txt with content "x"

## Verification
- test -f marker.txt
`,
	baseline: {
		default: { durationMs: 10_000, costUsd: 0.001 },
		full: { durationMs: 8_000, costUsd: 0.002 },
	},
};

function runRow(over: Partial<RunRow> = {}): RunRow {
	return {
		runId: "20260805T0000-abcd",
		project: "bench-hello",
		tier: "full",
		requirements: 2,
		durationMs: 30_000,
		costUsd: 0.002,
		verifyPassed: true,
		fixIterations: 0,
		...over,
	};
}

function summary(rows: RunRow[]): RunSummary {
	const sorted = [...rows].sort((a, b) =>
		a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0,
	);
	return {
		rows: sorted,
		count: rows.length,
		passed: rows.filter((r) => r.verifyPassed).length,
		failures: 0,
		unreadable: 0,
		totalCostUsd: rows.reduce((a, r) => a + r.costUsd, 0),
		totalDurationMs: rows.reduce((a, r) => a + r.durationMs, 0),
		p50DurationMs: 0,
		p90DurationMs: 0,
		byTier: {},
		byProject: {},
	};
}

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// ─── Canned specs: parseable, deterministic, well under a minute ───
	{
		check(
			BENCH_SPECS.length >= 2 && BENCH_SPECS.length <= 3,
			`expected 2-3 canned specs, got ${BENCH_SPECS.length}`,
		);
		const ids = new Set(BENCH_SPECS.map((s) => s.id));
		check(ids.size === BENCH_SPECS.length, "spec ids must be unique");
		for (const spec of BENCH_SPECS) {
			const parsed = parseSpec(spec.specMarkdown);
			check(
				parsed.requirements.length >= 1,
				`[${spec.id}] should have >= 1 requirement`,
			);
			check(
				parsed.verification.length >= 1,
				`[${spec.id}] should have >= 1 verification command`,
			);
			check(
				spec.baseline.default !== undefined,
				`[${spec.id}] baseline must define "default"`,
			);
			// R2: designed to complete well under a minute per tier.
			for (const [tier, b] of Object.entries(spec.baseline)) {
				check(
					b.durationMs > 0 && b.durationMs <= 60_000,
					`[${spec.id}] baseline "${tier}" should be >0 and <= 60s, got ${b.durationMs}ms`,
				);
				check(
					b.costUsd >= 0,
					`[${spec.id}] baseline "${tier}" cost must be >= 0`,
				);
			}
		}
	}

	// ─── Suite-03 grounding specs: parseable, deterministic fixture ───
	{
		check(
			GROUNDING_SPECS.length >= 2,
			`expected >= 2 grounding specs, got ${GROUNDING_SPECS.length}`,
		);
		const gids = new Set(GROUNDING_SPECS.map((s) => s.id));
		check(
			gids.size === GROUNDING_SPECS.length,
			"grounding spec ids must be unique",
		);
		for (const spec of GROUNDING_SPECS) {
			const parsed = parseSpec(spec.specMarkdown);
			check(
				parsed.requirements.length >= 1,
				`[${spec.id}] should have >= 1 requirement`,
			);
			check(
				parsed.verification.length >= 1,
				`[${spec.id}] should have >= 1 verification command`,
			);
			check(
				spec.baseline.default !== undefined,
				`[${spec.id}] baseline must define "default"`,
			);
		}

		// Fixture determinism (M0 invariant): same seed → identical bytes;
		// and the stated magnitudes hold (≥200 files, ≥100k LOC).
		const body = GROUNDING_SPECS[0]!.fixture;
		const a = buildGroundingFixture(body);
		const b = buildGroundingFixture(body);
		check(
			JSON.stringify(a) === JSON.stringify(b),
			"fixture is byte-deterministic per seed",
		);
		check(a.length >= 200, `fixture should span >= 200 files, got ${a.length}`);
		const loc = a.reduce((acc, f) => acc + f.content.split("\n").length - 1, 0);
		check(loc >= 100_000, `fixture should be >= 100k LOC, got ${loc}`);
	}

	// ─── baselineFor: known tier → its entry; unknown tier → default ───
	{
		const spec = BENCH_SPECS[0]!;
		check(
			baselineFor(spec, "full") === spec.baseline.full,
			"known tier returns its own baseline",
		);
		check(
			baselineFor(spec, "not-a-tier") === spec.baseline.default,
			"unknown tier falls back to default",
		);
		check(
			baselineFor(spec, "default") === spec.baseline.default,
			"default tier returns the default entry",
		);
		// Shape-aware baselines: "<tier>@<shape>" wins, then the tier, then default.
		check(
			baselineFor(spec, "full", "analysis") === spec.baseline.full,
			"no shape-specific baseline → tier entry",
		);
		const shaped = {
			...spec,
			baseline: { ...spec.baseline, "full@analysis": spec.baseline.full! },
		};
		check(
			baselineFor(shaped, "full", "analysis") === spec.baseline.full,
			"shape-specific baseline takes precedence",
		);
		check(
			baselineFor(shaped, "full") === spec.baseline.full,
			"shape omitted → tier entry (backward compatible)",
		);
	}

	// ─── buildBenchPlan: all tiers, totals, per-run expectations ───
	{
		const plan = buildBenchPlan({
			tiers: DEFAULT_BUDGET_TIERS,
			tierOrder: [...BUDGET_TIERS],
		});
		check(
			plan.shape === "code",
			`plan defaults to the code shape, got ${plan.shape}`,
		);
		const analysisPlan = buildBenchPlan({
			tiers: DEFAULT_BUDGET_TIERS,
			tierOrder: [...BUDGET_TIERS],
			shape: "analysis",
		});
		check(
			analysisPlan.shape === "analysis",
			`plan records the requested shape, got ${analysisPlan.shape}`,
		);
		check(
			JSON.stringify(plan.tiers.map((t) => t.tier)) ===
				JSON.stringify([...BUDGET_TIERS]),
			"plan keeps tier order",
		);
		check(
			plan.totalRuns === BUDGET_TIERS.length * BENCH_SPECS.length,
			`totalRuns = tiers × specs, got ${plan.totalRuns}`,
		);
		let expectedTotal = 0;
		for (const t of plan.tiers) {
			check(
				t.runs.length === BENCH_SPECS.length,
				`tier ${t.tier} should plan every spec`,
			);
			for (const r of t.runs) {
				const b = baselineFor(
					BENCH_SPECS.find((s) => s.id === r.specId)!,
					t.tier,
				);
				check(
					r.expectedDurationMs === b.durationMs &&
						r.expectedCostUsd === b.costUsd,
					`[${t.tier} × ${r.specId}] plan expectations match the baseline`,
				);
				expectedTotal += b.durationMs;
			}
			check(
				t.expectedDurationMs ===
					t.runs.reduce((a, r) => a + r.expectedDurationMs, 0),
				`tier ${t.tier} expected duration is the sum of its runs`,
			);
		}
		check(
			plan.totalExpectedDurationMs === expectedTotal,
			"total expected duration = sum of all run baselines",
		);
		check(
			plan.totalExpectedCostUsd ===
				plan.tiers.reduce((a, t) => a + t.expectedCostUsd, 0),
			"total expected cost = sum of tier expectations",
		);
	}

	// ─── buildBenchPlan: tier filter ───
	{
		const plan = buildBenchPlan({
			tiers: DEFAULT_BUDGET_TIERS,
			tierOrder: [...BUDGET_TIERS],
			tierFilter: ["full"],
		});
		check(
			plan.tiers.length === 1 &&
				plan.tiers[0] !== undefined &&
				plan.tiers[0].tier === "full",
			"filter keeps only the named tier",
		);
		check(
			plan.totalRuns === BENCH_SPECS.length,
			`filtered totalRuns, got ${plan.totalRuns}`,
		);

		const none = buildBenchPlan({
			tiers: DEFAULT_BUDGET_TIERS,
			tierOrder: [...BUDGET_TIERS],
			tierFilter: ["nope"],
		});
		check(
			none.tiers.length === 0 && none.totalRuns === 0,
			"unknown tier filter → empty plan",
		);
	}

	// ─── buildBenchPlan: custom tiers fall back to the default baseline ───
	{
		const plan = buildBenchPlan({
			tiers: FAKE_TIERS,
			tierOrder: ["full", "custom"],
			specs: [CUSTOM_SPEC],
		});
		check(plan.totalRuns === 2, `2 tiers × 1 spec, got ${plan.totalRuns}`);
		const full = plan.tiers.find((t) => t.tier === "full")!;
		const custom = plan.tiers.find((t) => t.tier === "custom")!;
		const fullRuns = full.runs[0]!;
		const customRuns = custom.runs[0]!;
		check(
			fullRuns.expectedDurationMs === 8_000 &&
				fullRuns.expectedCostUsd === 0.002,
			"known tier uses its own baseline entry",
		);
		check(
			customRuns.expectedDurationMs === 10_000 &&
				customRuns.expectedCostUsd === 0.001,
			"custom tier without a baseline entry falls back to default",
		);
	}

	// ─── projectForSpec ───
	{
		check(
			projectForSpec("bench-", "hello") === "bench-hello",
			"project naming",
		);
		check(projectForSpec("", "hello") === "hello", "empty prefix");
	}

	// ─── compareToBaselines: no data yet → runs 0, no regressions ───
	{
		const plan = buildBenchPlan({
			tiers: DEFAULT_BUDGET_TIERS,
			tierOrder: [...BUDGET_TIERS],
			tierFilter: ["full"],
		});
		const rows = compareToBaselines({
			plan,
			projectPrefix: "bench-",
			summaries: {},
		});
		check(rows.length === BENCH_SPECS.length, "one row per planned run");
		check(
			rows.every((r) => r.runs === 0),
			"no summaries → runs 0",
		);
		check(
			rows.every((r) => r.durationRatio === 0 && r.costRatio === 0),
			"no data → ratios 0",
		);
		check(
			rows.every((r) => r.regressions.length === 0),
			"no data → no regressions",
		);
		check(
			rows.every((r) => r.latest === null),
			"no data → latest null",
		);
	}

	// ─── compareToBaselines: averages, ratios, tier matching ───
	{
		const plan = buildBenchPlan({
			tiers: DEFAULT_BUDGET_TIERS,
			tierOrder: [...BUDGET_TIERS],
			tierFilter: ["full"],
		});
		const hello = BENCH_SPECS.find((s) => s.id === "hello")!;
		const baseline = baselineFor(hello, "full");
		const summaries = {
			"bench-hello": summary([
				runRow({
					runId: "20260805T0001-abcd",
					durationMs: baseline.durationMs,
					costUsd: baseline.costUsd,
				}),
				// A same-tier second run (repeat bench) → averaged in. 3x duration →
				// avg 2x baseline, which exceeds the 1.5x duration threshold.
				runRow({
					runId: "20260805T0002-abcd",
					durationMs: baseline.durationMs * 3,
					costUsd: baseline.costUsd,
				}),
				// A different-tier run in the same project → ignored.
				runRow({ tier: "economy", runId: "20260805T0003-abcd" }),
			]),
		};
		const rows = compareToBaselines({
			plan,
			projectPrefix: "bench-",
			summaries,
		});
		const row = rows.find((r) => r.specId === "hello")!;
		check(row.runs === 2, `only same-tier runs count, got ${row.runs}`);
		check(
			row.latest?.runId === "20260805T0002-abcd",
			"latest = most recent matching run",
		);
		const avgDur = (baseline.durationMs + baseline.durationMs * 3) / 2;
		check(
			Math.abs(row.avgDurationMs - avgDur) < 1e-9,
			`avg duration, got ${row.avgDurationMs}`,
		);
		check(
			Math.abs(row.durationRatio - avgDur / baseline.durationMs) < 1e-9,
			"duration ratio = avg/baseline",
		);
		check(
			row.regressions.length === 1 &&
				row.regressions[0] !== undefined &&
				row.regressions[0].startsWith("duration"),
			`2x avg duration trips the duration regression, got ${JSON.stringify(row.regressions)}`,
		);

		const other = rows.find((r) => r.specId !== "hello")!;
		check(other.runs === 0, "specs without manifests stay at runs 0");
	}

	// ─── compareToBaselines: cost regression + verify failure ───
	{
		const plan = buildBenchPlan({
			tiers: FAKE_TIERS,
			tierOrder: ["full"],
			specs: [CUSTOM_SPEC],
		});
		const b = baselineFor(CUSTOM_SPEC, "full");
		const rows = compareToBaselines({
			plan,
			projectPrefix: "bench-",
			summaries: {
				"bench-custom-spec": summary([
					// 3x duration + 5x cost → avg 2x duration and 3x cost, both
					// past the regression thresholds.
					runRow({
						project: "bench-custom-spec",
						runId: "20260805T0001-abcd",
						durationMs: b.durationMs * 3,
						costUsd: b.costUsd * 5,
					}),
					runRow({
						project: "bench-custom-spec",
						runId: "20260805T0002-abcd",
						durationMs: b.durationMs,
						costUsd: b.costUsd,
						verifyPassed: false,
					}),
				]),
			},
		});
		const row = rows[0]!;
		check(
			row.runs === 2 && row.verifyPassRate === 0.5,
			`verifyPassRate, got ${row.verifyPassRate}`,
		);
		check(
			Math.abs(row.costRatio - 3) < 1e-9,
			`cost ratio, got ${row.costRatio}`,
		);
		check(
			row.regressions.some((r) => r.startsWith("cost")),
			"3x cost trips the cost regression",
		);
		check(
			row.regressions.some((r) => r.startsWith("verify failed (1/2")),
			"verify failure is a regression",
		);
		check(
			row.regressions.some((r) => r.startsWith("duration")),
			"2x duration trips the duration regression",
		);
		check(
			REGRESSION_DURATION_FACTOR === 1.5 && REGRESSION_COST_FACTOR === 2.0,
			"shipped regression thresholds (documented in the header)",
		);
	}

	// ─── rendering ───
	{
		const plan = buildBenchPlan({
			tiers: DEFAULT_BUDGET_TIERS,
			tierOrder: [...BUDGET_TIERS],
			tierFilter: ["full"],
		});
		const planLines = renderBenchPlan(plan);
		const planText = planLines.join("\n");
		check(planLines[0]!.includes("dry run"), "plan header mentions dry run");
		check(
			planText.includes("planned runs") &&
				planText.includes(String(plan.totalRuns)),
			"plan lists the run count",
		);
		check(planText.includes("estimated:"), "plan lists the estimate line");
		for (const r of plan.tiers[0]!.runs) {
			check(
				new RegExp(`${r.tier}\\s+×\\s+${r.specId}`).test(planText),
				`plan lists ${r.tier} × ${r.specId}`,
			);
		}

		const rows: BenchComparisonRow[] = [
			{
				specId: "hello",
				tier: "full",
				runs: 0,
				latest: null,
				avgDurationMs: 0,
				avgCostUsd: 0,
				expectedDurationMs: 30_000,
				expectedCostUsd: 0.002,
				durationRatio: 0,
				costRatio: 0,
				verifyPassRate: 0,
				regressions: [],
			},
			{
				specId: "hello",
				tier: "full",
				runs: 1,
				latest: {
					runId: "20260805T0001-abcd",
					durationMs: 60_000,
					costUsd: 0.004,
					verifyPassed: true,
				},
				avgDurationMs: 60_000,
				avgCostUsd: 0.004,
				expectedDurationMs: 30_000,
				expectedCostUsd: 0.002,
				durationRatio: 2,
				costRatio: 2,
				verifyPassRate: 1,
				regressions: ["duration 2.00x baseline", "cost 2.00x baseline"],
			},
		];
		const report = renderBenchReport(rows);
		const reportText = report.join("\n");
		check(reportText.includes("no runs recorded yet"), "empty rows say so");
		check(reportText.includes("2.00x baseline"), "ratios rendered");
		check(
			reportText.includes("⚠") && reportText.includes("regression thresholds"),
			"regressions flagged + threshold note",
		);
		check(
			reportText.includes("1 regression(s)"),
			"report headline counts regressions",
		);
	}

	// ─── parseBenchArgs ───
	{
		const plain = parseBenchArgs([]);
		check(
			plain.tierFilter.length === 0 && !plain.dryRun && !plain.help,
			"empty argv → defaults",
		);
		const full = parseBenchArgs(["--tier", "full", "--dry-run"]);
		check(
			full.tierFilter.length === 1 &&
				full.tierFilter[0] === "full" &&
				full.dryRun,
			"--tier + --dry-run parsed",
		);
		const repeat = parseBenchArgs(["--tier", "full", "--tier", "free"]);
		check(
			JSON.stringify(repeat.tierFilter) === JSON.stringify(["full", "free"]),
			"--tier repeatable",
		);
		const metrics = parseBenchArgs(["--metrics-dir", "/tmp/x", "--help"]);
		check(
			metrics.metricsDir === "/tmp/x" && metrics.help,
			"--metrics-dir + --help parsed",
		);
		let threw = false;
		try {
			parseBenchArgs(["--bogus"]);
		} catch {
			threw = true;
		}
		check(threw, "unknown flag throws");
		let missing = false;
		try {
			parseBenchArgs(["--tier"]);
		} catch {
			missing = true;
		}
		check(missing, "--tier without a value throws");
	}

	if (errors.length > 0) {
		return Promise.reject(
			new Error("test-bench-regression failed:\n  ✗ " + errors.join("\n  ✗ ")),
		);
	}
	console.log(
		"✓ bench-regression: canned specs, plan assembly, baseline comparison, rendering, args",
	);
	return Promise.resolve();
}

// Direct execution support: `npx tsx extensions/task/test-bench-regression.ts`
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error((err as Error).message ?? err);
			process.exit(1);
		});
}
