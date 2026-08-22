/**
 * Grounding evaluation plan — M3 (docs/pi-task-v2.md §7).
 *
 * Pure plan assembly for the suite-03 grounding-mode comparison: which
 * (config × spec) pairs will run, and what the RECORDED baselines expect.
 * This module owns NO data: configs come from grounding-configs.ts, and
 * specs + baselines are supplied by the caller — the CLI glue reads them
 * from the owner file `extensions/task/bench-regression.ts`, so fixture
 * and spec facts are never re-derived here.
 */

import type { GroundingConfig } from "./grounding-configs.ts";

/** The baseline shape the owner file records per spec (durationMs/costUsd). */
export interface GroundingBaselineEntry {
	durationMs: number;
	costUsd: number;
}

/** Minimal spec surface the plan needs (satisfied by GROUNDING_SPECS). */
export interface PlanSpecInput {
	id: string;
	description: string;
	baseline: Record<string, GroundingBaselineEntry> & { default: GroundingBaselineEntry };
}

/** Resolve a spec's baseline for a tier (unknown tiers → default entry). */
export function baselineForSpec(spec: PlanSpecInput, tier: string): GroundingBaselineEntry {
	return spec.baseline[tier] ?? spec.baseline.default;
}

/** One planned (config × spec) run. */
export interface GroundingPlanRow {
	configId: string;
	specId: string;
	expectedDurationMs: number;
	expectedCostUsd: number;
	/** True when the row needs the strong-model gate (--allow-strong). */
	gated: boolean;
}

/** The full plan: rows plus totals over non-gated expectations. */
export interface GroundingPlan {
	rows: GroundingPlanRow[];
	totalRuns: number;
	totalExpectedDurationMs: number;
	totalExpectedCostUsd: number;
}

/** Assemble the plan: every enabled config × every spec, baselines per tier. Pure. */
export function buildGroundingPlan(opts: {
	configs: readonly GroundingConfig[];
	specs: readonly PlanSpecInput[];
	tier?: string;
}): GroundingPlan {
	const tier = opts.tier ?? "default";
	const rows: GroundingPlanRow[] = [];
	for (const config of opts.configs) {
		for (const spec of opts.specs) {
			const b = baselineForSpec(spec, tier);
			rows.push({
				configId: config.id,
				specId: spec.id,
				expectedDurationMs: b.durationMs,
				expectedCostUsd: b.costUsd,
				gated: config.strongModel,
			});
		}
	}
	return {
		rows,
		totalRuns: rows.length,
		totalExpectedDurationMs: rows.reduce((a, r) => a + r.expectedDurationMs, 0),
		totalExpectedCostUsd: rows.reduce((a, r) => a + r.expectedCostUsd, 0),
	};
}

/** Format ms as a compact duration ("33.2s", "1m05s"). */
export function formatEvalDuration(ms: number): string {
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return `${m}m${String(s).padStart(2, "0")}s`;
}

/** Render the dry-run plan (no spawns, no LLM). Pure. */
export function renderGroundingPlan(plan: GroundingPlan, opts: { gatedIncluded: boolean }): string[] {
	const lines = [
		"grounding evaluation — dry run (no runs spawned, no LLM calls)",
		opts.gatedIncluded
			? "strong-model configs INCLUDED (--allow-strong)"
			: "strong-model configs gated off (pass --allow-strong or PI_TASK_ALLOW_STRONG=1 to include)",
	];
	const specIds = [...new Set(plan.rows.map((r) => r.specId))];
	const configIds = [...new Set(plan.rows.map((r) => r.configId))];
	lines.push(`configs (${configIds.length}): ${configIds.join(", ")}`);
	lines.push(`specs (${specIds.length}): ${specIds.join(", ")}`);
	lines.push(`planned runs (${plan.totalRuns}):`);
	for (const r of plan.rows) {
		lines.push(
			`  ${r.configId.padEnd(22)} × ${r.specId.padEnd(20)} ` +
				`${formatEvalDuration(r.expectedDurationMs).padStart(8)} ` +
				`$${r.expectedCostUsd.toFixed(4).padStart(9)}${r.gated ? "  [gated]" : ""}`,
		);
	}
	lines.push(
		`estimated: ${plan.totalRuns} runs · ${formatEvalDuration(plan.totalExpectedDurationMs)} · ` +
			`$${plan.totalExpectedCostUsd.toFixed(4)}`,
	);
	return lines;
}
