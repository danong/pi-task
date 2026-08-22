/**
 * Hermetic tests for the M3 grounding evaluation harness
 * (docs/pi-task-v2.md §7): config enumeration + strong-model gating,
 * plan assembly against owner-file baselines, per-config metric
 * aggregation (COR recomputed from sums, never averaged ratios),
 * NFR-3 cost normalization (USD per changed file), NFR-4 cache-affinity
 * violation counting, and summary rendering. Zero LLM, zero network.
 *
 * Standalone: npx tsx packages/core-v2/test/test-grounding-eval.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	GROUNDING_CONFIGS,
	filterConfigs,
	findGroundingConfig,
	isStrongConfig,
} from "../src/bench/grounding-configs.ts";
import {
	aggregateRecords,
	buildWinsLoses,
	costPerFileChanged,
	isCacheAffinityViolation,
	renderSummaryLines,
	totalBilledInput,
	type GroundingRunRecord,
} from "../src/bench/grounding-metrics.ts";
import {
	buildGroundingPlan,
	baselineForSpec,
	formatEvalDuration,
	renderGroundingPlan,
	type PlanSpecInput,
} from "../src/bench/grounding-plan.ts";
import {
	appendRecord,
	defaultSummaryPath,
	loadRecords,
	recordsPath,
	writeSummary,
} from "../src/bench/grounding-store.ts";

/** A minimal spec-shaped input mirroring GROUNDING_SPECS' baseline shape. */
const SPEC_A: PlanSpecInput = {
	id: "spec-a",
	description: "a spec",
	baseline: {
		default: { durationMs: 10_000, costUsd: 0.01 },
		"bench-good": { durationMs: 8_000, costUsd: 0.02 },
	},
};
const SPEC_B: PlanSpecInput = {
	id: "spec-b",
	description: "another spec",
	baseline: { default: { durationMs: 20_000, costUsd: 0.005 } },
};

function record(over: Partial<GroundingRunRecord>): GroundingRunRecord {
	return {
		configId: "daemon-cold",
		specId: "spec-a",
		turns: 6,
		inputTokens: 1_000,
		outputTokens: 300,
		cacheReadTokens: 2_000,
		cacheWriteTokens: 100,
		groundingTokens: 900,
		costUsd: 0.01,
		durationMs: 30_000,
		firstPassVerify: true,
		bundleHit: null,
		forkDeviationCount: 0,
		retriedWithHandoff: false,
		cacheHitOnRetry: null,
		filesChanged: 1,
		...over,
	};
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// ─── Config enumeration: every plan mode covered, ids unique ────────
	{
		const modes = new Set(GROUNDING_CONFIGS.map((c) => c.planMode));
		for (const mode of ["cold", "prewalk", "bundle", "fork"] as const) {
			check(modes.has(mode), `plan mode ${mode} reachable in GROUNDING_CONFIGS`);
		}
		const hosts = new Set(GROUNDING_CONFIGS.map((c) => c.host));
		for (const host of ["bare", "engine-v1", "daemon"] as const) {
			check(hosts.has(host), `host ${host} present in GROUNDING_CONFIGS`);
		}
		const ids = new Set(GROUNDING_CONFIGS.map((c) => c.id));
		check(ids.size === GROUNDING_CONFIGS.length, "config ids unique");
		check(findGroundingConfig("bare") !== undefined, "lookup by id works");
		check(findGroundingConfig("nope") === undefined, "unknown id → undefined");
	}

	// ─── Strong-model gate: default excludes, flag includes ─────────────
	{
		const gated = filterConfigs({ includeStrong: false });
		check(gated.every((c) => !isStrongConfig(c)), "default selection has no strong configs");
		check(filterConfigs({ includeStrong: true }).length > gated.length,
			"--allow-strong widens the selection");
		let threw = false;
		try {
			filterConfigs({ includeStrong: false, configFilter: ["daemon-prewalk-strong"] });
		} catch (err) {
			threw = /allow-strong/i.test((err as Error).message);
		}
		check(threw, "gated strong id without --allow-strong fails typed");
		let unknownThrew = false;
		try {
			filterConfigs({ includeStrong: true, configFilter: ["not-a-config"] });
		} catch {
			unknownThrew = true;
		}
		check(unknownThrew, "unknown --config id fails typed");
		const narrowed = filterConfigs({ includeStrong: true, configFilter: ["bare", "daemon-bundle"] });
		check(narrowed.length === 2 && narrowed.every((c) => c.id === "bare" || c.id === "daemon-bundle"),
			"config filter narrows to named configs only");
	}

	// ─── Plan assembly: cross product, tier baselines, gating flags ────
	{
		const plan = buildGroundingPlan({
			configs: filterConfigs({ includeStrong: false }),
			specs: [SPEC_A, SPEC_B],
			tier: "bench-good",
		});
		check(plan.totalRuns === plan.rows.length, "totalRuns = rows length");
		check(plan.rows.length === filterConfigs({ includeStrong: false }).length * 2,
			"plan is configs × specs");
		check(plan.rows.every((r) => !r.gated), "ungated selection marks nothing gated");

		// bench-good entry preferred over default for SPEC_A.
		const a = plan.rows.find((r) => r.specId === "spec-a")!;
		check(a.expectedDurationMs === 8_000 && a.expectedCostUsd === 0.02,
			"tier baseline wins when present");
		const b = plan.rows.find((r) => r.specId === "spec-b")!;
		check(b.expectedDurationMs === 20_000 && b.expectedCostUsd === 0.005,
			"missing tier falls back to default baseline");
		check(baselineForSpec(SPEC_B, "no-such-tier").durationMs === 20_000,
			"baselineForSpec falls back to default for unknown tiers");
		check(Math.abs(plan.totalExpectedDurationMs - plan.rows.reduce((s, r) => s + r.expectedDurationMs, 0)) < 1e-9,
			"expected duration totals = sum of rows");

		const strongPlan = buildGroundingPlan({
			configs: filterConfigs({ includeStrong: true }),
			specs: [SPEC_A],
			tier: "default",
		});
		check(strongPlan.rows.some((r) => r.gated), "strong rows flagged gated in the plan");

		const lines = renderGroundingPlan(plan, { gatedIncluded: false });
		const text = lines.join("\n");
		check(text.includes("dry run") && text.includes("planned runs"), "plan header rendered");
		check(text.includes("--allow-strong"), "plan states how to ungate");
		check(formatEvalDuration(33_207) === "33.2s", `duration fmt small (${formatEvalDuration(33_207)})`);
		check(formatEvalDuration(65_000).startsWith("1m"), `duration fmt large (${formatEvalDuration(65_000)})`);
	}

	// ─── Aggregation: COR from sums, rates exact, nulls respected ──────
	{
		const recs = [
			record({ configId: "x", turns: 4 }),
			record({ configId: "x", turns: 6, firstPassVerify: false }),
			// bundle-mode telemetry on its own config
			record({ configId: "b", bundleHit: true }),
			record({ configId: "b", bundleHit: false }),
			record({ configId: "b", bundleHit: null }), // non-bundle run — ignored
		];
		const aggs = aggregateRecords(recs);
		const x = aggs.get("x")!;
		check(x.runs === 2 && Math.abs(x.avgTurns - 5) < 1e-9, "avgTurns computed");
		const billed = totalBilledInput(recs[0]!) * 2;
		const grounded = recs[0]!.groundingTokens * 2;
		check(x.cor !== null && Math.abs((x.cor - grounded / billed)) < 1e-9,
			"COR recomputed from sums, not averaged ratios");
		check(Math.abs(x.firstPassVerifyRate - 0.5) < 1e-9, "first-pass rate");
		check(x.forkCleanRate !== null && Math.abs(x.forkCleanRate - 1) < 1e-9, "clean-run rate");
		check(x.bundleHitRate === null, "bundle rate null when no bundle run");

		const b = aggs.get("b")!;
		check(b.bundleHitRate !== null && Math.abs(b.bundleHitRate - 0.5) < 1e-9,
			"bundle hit rate counts only bundle-mode runs");

		// Empty input → empty map (no fabricated zeros).
		check(aggregateRecords([]).size === 0, "no records → no aggregates");
	}

	// ─── NFR-3: USD per changed file; null with no diffs ───────────────
	{
		const recs = [
			record({ configId: "n", costUsd: 0.10, filesChanged: 2 }),
			record({ configId: "n", costUsd: 0.05, filesChanged: 3 }),
			record({ configId: "m", costUsd: 0.99, filesChanged: 0 }),
		];
		const perFile = costPerFileChanged(recs, "n");
		check(perFile !== null && Math.abs(perFile - 0.15 / 5) < 1e-12,
			`USD/file = total cost ÷ total files (${perFile})`);
		check(costPerFileChanged(recs, "m") === null, "zero-diff config → null (nothing to normalize)");
		check(costPerFileChanged(recs, "absent") === null, "unknown config → null");
		const agg = aggregateRecords(recs).get("n")!;
		check(agg.costPerFileChangedUsd !== null && Math.abs(agg.costPerFileChangedUsd - 0.03) < 1e-12,
			"aggregate carries the normalized figure");
	}

	// ─── NFR-4: violations counted, retry rate over known outcomes ─────
	{
		check(!isCacheAffinityViolation(record({ retriedWithHandoff: false, cacheHitOnRetry: false })),
			"no retry → not a violation");
		check(isCacheAffinityViolation(record({ retriedWithHandoff: true, cacheHitOnRetry: false })),
			"retry that missed cache → violation");
		check(!isCacheAffinityViolation(record({ retriedWithHandoff: true, cacheHitOnRetry: true })),
			"cache-hit retry → clean");
		check(!isCacheAffinityViolation(record({ retriedWithHandoff: true, cacheHitOnRetry: null })),
			"unknown-outcome retry → not counted as a violation");

		const agg = aggregateRecords([
			record({ retriedWithHandoff: true, cacheHitOnRetry: true }),
			record({ retriedWithHandoff: true, cacheHitOnRetry: false }),
			record({ retriedWithHandoff: true, cacheHitOnRetry: null }),
			record({ retriedWithHandoff: false, cacheHitOnRetry: null }),
		]).get("daemon-cold")!;
		check(agg.retryCacheHitRate !== null && Math.abs(agg.retryCacheHitRate - 0.5) < 1e-9,
			"retry rate covers known outcomes only");
		check(agg.cacheAffinityViolations === 1, "violation count audited");
	}

	// ─── Wins/loses + summary rendering ────────────────────────────────
	{
		const recs = [
			record({ configId: "cheap", costUsd: 0.01, filesChanged: 10, turns: 3 }),
			record({ configId: "thorough", costUsd: 0.50, filesChanged: 10, turns: 9, firstPassVerify: true }),
			record({ configId: "cheap", firstPassVerify: true }),
		];
		const aggs = [...aggregateRecords(recs).values()];
		const winners = buildWinsLoses(aggs);
		check(winners.length >= 4, "multiple dimensions scored");
		const byDim = new Map(winners.map((w) => [w.dimension, w.winner]));
		check(byDim.get("lowest cost per run") === "cheap", "cheap wins raw cost");
		check(byDim.get("fewest average turns") === "cheap", "cheap wins turns");
		check(buildWinsLoses([]).length === 0, "empty aggregates → empty winners table");

		const lines = renderSummaryLines(recs, aggs, winners);
		const text = lines.join("\n");
		check(text.includes("| config |"), "summary carries the metric table header");
		check(text.includes("cheap") && text.includes("thorough"), "summary lists both configs");
		check(text.includes("Where each mode wins / loses"), "summary carries the wins/loses section");
		check(text.includes("NFR-4"), "summary surfaces cache-affinity accounting");
		check(text.includes("extensions/task/bench-regression.ts"),
			"summary points readers at the fixture/spec owner file");

		const empty = renderSummaryLines([], [], []);
		check(empty.some((l) => l.includes("No evidence recorded yet")),
			"empty evidence → explicit no-data note (never a fake table)");
	}

	// ─── Evidence store round-trip (real fs, temp dir only) ────────────
	{
		const dir = mkdtempSync(join(tmpdir(), "core-v2-grounding-eval-"));
		try {
			appendRecord(dir, record({ configId: "store-a" }));
			appendRecord(dir, record({ configId: "store-b" }));
			writeFileSync(recordsPath(dir), "{corrupt}\n", { flag: "a" });
			const { records, corrupt } = loadRecords(dir);
			check(records.length === 2 && corrupt === 1,
				`JSONL round-trip skips corrupt lines (${records.length}/${corrupt})`);
			check(loadRecords(join(dir, "missing")).records.length === 0, "missing store loads as empty");

			// writeSummary must create parent dirs for a nested --summary-out.
			const outPath = join(dir, "nested", "summary.md");
			const lines = writeSummary([record({ configId: "s" })], outPath);
			check(lines.length > 0 && lines[0]!.startsWith("# Suite-03 grounding evaluation"),
				"summary artifact written and returns rendered lines");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	if (errors.length > 0) {
		throw new Error(`test-grounding-eval failed:\n  ✗ ${errors.join("\n  ✗ ")}`);
	}
	console.log(
		"✓ grounding-eval: config enumeration + gating, plan assembly vs owner-file baselines, COR-from-sums aggregation, NFR-3/4 normalization, wins/loses rendering, JSONL evidence round-trip",
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
