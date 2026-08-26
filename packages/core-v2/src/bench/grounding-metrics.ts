/**
 * Grounding evaluation metrics — M3 (docs/pi-task-v2.md §5.3, §7).
 *
 * Pure scoring layer for the suite-03 grounding-mode comparison. The
 * harness never hardcodes fixture or spec counts: specs/fixtures live in
 * the owner file `extensions/task/bench-regression.ts` (GROUNDING_SPECS,
 * GROUNDING_LAYERS); the config vocabulary lives in grounding-configs.ts.
 *
 * Metrics per run (contract §7): tokens, turns, wall time, USD cost, COR
 * (NFR-3), first-pass verification rate, cache hits on retried prefixes
 * (NFR-4), bundle hit rate, fork cleanliness.
 *
 * Normalizations (R3):
 *   - NFR-3: cost is reported per changed FILE (diff size), never per
 *     repository size — the fixture is ~100k LOC by construction, so raw
 *     totals would reward nothing but reading less of it.
 *   - NFR-4: a handoff retry must hit cache on the identical serialized
 *     prefix; every miss is counted and surfaced as a violation.
 */

/** One completed grounding-mode run, flattened for scoring. */
export interface GroundingRunRecord {
	configId: string;
	specId: string;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	/** Cache-write tokens when the source exposes them (daemon receipts do
	 *  not carry them — they stay 0 there; the COR denominator notes it). */
	cacheWriteTokens: number;
	groundingTokens: number;
	costUsd: number;
	durationMs: number;
	firstPassVerify: boolean;
	/** null = bundle not used (every non-bundle config). */
	bundleHit: boolean | null;
	/** Yield deviation count — 0 means a clean run/fork. */
	forkDeviationCount: number;
	retriedWithHandoff: boolean;
	/** null = no retry happened. */
	cacheHitOnRetry: boolean | null;
	/** Diff size (files changed) — the NFR-3 normalization base. */
	filesChanged: number;
}

/** Everything billed as prompt for one record (NFR-3 denominator). */
export function totalBilledInput(
	r: Pick<
		GroundingRunRecord,
		"inputTokens" | "cacheReadTokens" | "cacheWriteTokens"
	>,
): number {
	return r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens;
}

/** NFR-4 violation: a handoff retry whose prefix was NOT a cache hit. */
export function isCacheAffinityViolation(r: GroundingRunRecord): boolean {
	return r.retriedWithHandoff && r.cacheHitOnRetry === false;
}

/** Per-config aggregate. Aggregate COR is RECOMPUTED from summed
 *  grounding over summed billed input — never an average of ratios. */
export interface ConfigAggregate {
	configId: string;
	runs: number;
	totalTurns: number;
	avgTurns: number;
	totalCostUsd: number;
	avgDurationMs: number;
	billedInputTokens: number;
	groundingTokens: number;
	/** Summed grounding ÷ summed billed input; null when nothing was billed. */
	cor: number | null;
	/** Hits ÷ bundle-mode runs; null when no run used a bundle. */
	bundleHitRate: number | null;
	/** Clean (zero-deviation) share across runs; null when no runs. */
	forkCleanRate: number | null;
	firstPassVerifyRate: number;
	/** Cache-hit share over handoff retries with known outcome; null when
	 *  no such retry was recorded. */
	retryCacheHitRate: number | null;
	/** Audited NFR-4 figure: handoff retries that MISSED the prefix cache. */
	cacheAffinityViolations: number;
	/** Total cost ÷ total changed files (USD/file); null when no diffs. */
	costPerFileChangedUsd: number | null;
}

interface Acc extends Omit<
	ConfigAggregate,
	| "avgTurns"
	| "cor"
	| "costPerFileChangedUsd"
	| "bundleHitRate"
	| "forkCleanRate"
> {
	bundleHits: number;
	bundleTotal: number;
	cleanRuns: number;
	retryHits: number;
	retryTotal: number;
	filesChanged: number;
	durationTotalMs: number;
}

/** Aggregate records per config id. Pure. */
export function aggregateRecords(
	records: readonly GroundingRunRecord[],
): Map<string, ConfigAggregate> {
	const accs = new Map<string, Acc>();
	for (const r of records) {
		const existing = accs.get(r.configId);
		const a: Acc = existing ?? {
			configId: r.configId,
			runs: 0,
			totalTurns: 0,
			totalCostUsd: 0,
			billedInputTokens: 0,
			groundingTokens: 0,
			firstPassVerifyRate: 0,
			retryCacheHitRate: null,
			cacheAffinityViolations: 0,
			bundleHits: 0,
			bundleTotal: 0,
			cleanRuns: 0,
			retryHits: 0,
			retryTotal: 0,
			filesChanged: 0,
			durationTotalMs: 0,
			avgDurationMs: 0,
		};
		if (existing === undefined) accs.set(r.configId, a);
		a.runs += 1;
		a.totalTurns += r.turns;
		a.totalCostUsd += r.costUsd;
		a.billedInputTokens += totalBilledInput(r);
		a.groundingTokens += r.groundingTokens;
		if (r.firstPassVerify) a.firstPassVerifyRate += 1;
		if (r.bundleHit !== null) {
			a.bundleTotal += 1;
			if (r.bundleHit) a.bundleHits += 1;
		}
		if (r.forkDeviationCount === 0) a.cleanRuns += 1;
		if (r.retriedWithHandoff && r.cacheHitOnRetry !== null) {
			a.retryTotal += 1;
			if (r.cacheHitOnRetry) a.retryHits += 1;
		}
		if (isCacheAffinityViolation(r)) a.cacheAffinityViolations += 1;
		a.filesChanged += r.filesChanged;
		a.durationTotalMs += r.durationMs;
	}
	const out = new Map<string, ConfigAggregate>();
	for (const a of accs.values()) {
		out.set(a.configId, {
			configId: a.configId,
			runs: a.runs,
			totalTurns: a.totalTurns,
			avgTurns: a.runs > 0 ? a.totalTurns / a.runs : 0,
			totalCostUsd: a.totalCostUsd,
			avgDurationMs: a.runs > 0 ? a.durationTotalMs / a.runs : 0,
			billedInputTokens: a.billedInputTokens,
			groundingTokens: a.groundingTokens,
			cor:
				a.billedInputTokens > 0
					? a.groundingTokens / a.billedInputTokens
					: null,
			bundleHitRate: a.bundleTotal > 0 ? a.bundleHits / a.bundleTotal : null,
			forkCleanRate: a.runs > 0 ? a.cleanRuns / a.runs : null,
			firstPassVerifyRate: a.runs > 0 ? a.firstPassVerifyRate / a.runs : 0,
			retryCacheHitRate: a.retryTotal > 0 ? a.retryHits / a.retryTotal : null,
			cacheAffinityViolations: a.cacheAffinityViolations,
			costPerFileChangedUsd:
				a.filesChanged > 0 ? a.totalCostUsd / a.filesChanged : null,
		});
	}
	return out;
}

/**
 * NFR-3 normalization for one config: total cost ÷ total changed files.
 * Null when the config produced no diffs (nothing to normalize).
 */
export function costPerFileChanged(
	records: readonly GroundingRunRecord[],
	configId: string,
): number | null {
	let cost = 0;
	let files = 0;
	for (const r of records) {
		if (r.configId !== configId) continue;
		cost += r.costUsd;
		files += r.filesChanged;
	}
	return files > 0 ? cost / files : null;
}

/** One "where X wins" line for the summary artifact. */
export interface DimensionWinner {
	dimension: string;
	winner: string | null;
	note: string;
}

function bestOf(
	scored: readonly ConfigAggregate[],
	pick: (a: ConfigAggregate) => number | null,
	lowerIsBetter: boolean,
): string | null {
	let winner: string | null = null;
	let bestVal: number | null = null;
	for (const a of scored) {
		const v = pick(a);
		if (v === null || !Number.isFinite(v)) continue;
		if (bestVal === null || (lowerIsBetter ? v < bestVal : v > bestVal)) {
			bestVal = v;
			winner = a.configId;
		}
	}
	return winner;
}

/**
 * Short wins/loses table across the scored dimensions. Only configs with
 * runs compete; ties keep the first encountered (stable input order).
 */
export function buildWinsLoses(
	aggs: readonly ConfigAggregate[],
): DimensionWinner[] {
	const scored = aggs.filter((a) => a.runs > 0);
	if (scored.length === 0) return [];
	return [
		{
			dimension: "lowest cost per run",
			winner: bestOf(
				scored,
				(a) => (a.runs > 0 ? a.totalCostUsd / a.runs : null),
				true,
			),
			note: "raw USD averaged over runs",
		},
		{
			dimension: "lowest normalized cost (USD per changed file)",
			winner: bestOf(scored, (a) => a.costPerFileChangedUsd, true),
			note: "NFR-3 — cost scales with diff size, not repo size",
		},
		{
			dimension: "fewest average turns",
			winner: bestOf(scored, (a) => a.avgTurns, true),
			note: "grounding should save exploration turns",
		},
		{
			dimension: "highest first-pass verification rate",
			winner: bestOf(scored, (a) => a.firstPassVerifyRate, false),
			note: "share of runs passing verification with no fix loop",
		},
		{
			dimension: "highest bundle hit rate",
			winner: bestOf(scored, (a) => a.bundleHitRate, false),
			note: "only bundle-mode runs carry this telemetry",
		},
		{
			dimension: "cleanest forks (zero deviations)",
			winner: bestOf(scored, (a) => a.forkCleanRate, false),
			note: "fork_deviation_rate complement (§5.4)",
		},
	];
}

/** Render the summary artifact body (markdown lines). Pure. */
export function renderSummaryLines(
	records: readonly GroundingRunRecord[],
	aggs: readonly ConfigAggregate[],
	winners: readonly DimensionWinner[],
): string[] {
	const lines: string[] = [
		"# Suite-03 grounding evaluation — summary",
		"",
		"Specs and fixtures: see the owner file `extensions/task/bench-regression.ts`",
		"(GROUNDING_SPECS / GROUNDING_LAYERS). Config vocabulary:",
		"`packages/core-v2/src/bench/grounding-configs.ts`. Recorded baselines live in",
		"the owner file's `baseline` tables.",
		"",
	];
	if (records.length === 0) {
		lines.push(
			"No evidence recorded yet. Dry path: `mise run eval-grounding` prints the plan",
		);
		lines.push(
			"(zero LLM). Real runs: see `docs/pi-task-v2.md §7` for the reproduction steps.",
		);
		return lines;
	}
	lines.push(
		"| config | runs | avg turns | cost/run | USD/file | COR | first-pass | bundle hit | fork clean |",
	);
	lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const a of aggs) {
		const fmt = (v: number | null): string => (v === null ? "—" : v.toFixed(3));
		lines.push(
			`| ${a.configId} | ${a.runs} | ${a.avgTurns.toFixed(1)} | $${(a.runs > 0 ? a.totalCostUsd / a.runs : 0).toFixed(4)} | ` +
				`${fmt(a.costPerFileChangedUsd)} | ${fmt(a.cor)} | ${(a.firstPassVerifyRate * 100).toFixed(0)}% | ` +
				`${a.bundleHitRate === null ? "n/a" : `${(a.bundleHitRate * 100).toFixed(0)}%`} | ` +
				`${a.forkCleanRate === null ? "n/a" : `${(a.forkCleanRate * 100).toFixed(0)}%`} |`,
		);
	}
	const violations = records.filter(isCacheAffinityViolation).length;
	const retries = records.filter((r) => r.retriedWithHandoff).length;
	lines.push("");
	lines.push(
		`NFR-4 cache affinity: ${retries} handoff retry(ies), ${violations} prefix-cache miss(es) ` +
			`(any miss is a deterministic-prefix violation).`,
	);
	lines.push("");
	lines.push("## Where each mode wins / loses");
	for (const w of winners) {
		lines.push(
			`- ${w.dimension}: **${w.winner ?? "(no comparable data)"}** — ${w.note}`,
		);
	}
	return lines;
}
