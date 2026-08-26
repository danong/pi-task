/**
 * grounding-eval.ts — suite-03 grounding-mode evaluation harness (M3,
 * docs/pi-task-v2.md §7).
 *
 * One command scores the v2 grounding configurations against each other
 * on the pre-seeded suite-03 fixture, using the RECORDED baselines in the
 * owner file (`bench-regression.ts`) as the comparison anchor.
 *
 *   DRY (default, zero LLM):  npx tsx extensions/task/grounding-eval.ts
 *   REAL RUNS (LLM-gated):    ... --run [--allow-strong]
 *
 * Specs/fixtures/baselines are NEVER duplicated here — they are read
 * from the owner file. Pure plan/score/render logic lives in
 * packages/core-v2/src/bench/ (strictly typechecked there, hermetically
 * tested in packages/core-v2/test/test-grounding-eval.ts).
 *
 * Evidence: every real run appends one GroundingRunRecord JSON line to
 * <metrics-dir>/eval-grounding/records.jsonl; the summary artifact
 * (wins/loses + normalized table) lands next to it as summary.md.
 *
 * Exit codes: 0 ok/dry · 1 usage/config error · 2 some real runs failed ·
 * 3 NFR-4 cache-affinity violation recorded (deterministic-prefix break).
 */

import { execSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import {
	GROUNDING_CONFIG_IDS,
	filterConfigs,
	type GroundingConfig,
} from "../../packages/core-v2/src/bench/grounding-configs.ts";
import {
	aggregateRecords,
	buildWinsLoses,
	renderSummaryLines,
	type GroundingRunRecord,
} from "../../packages/core-v2/src/bench/grounding-metrics.ts";
import {
	buildGroundingPlan,
	renderGroundingPlan,
	type PlanSpecInput,
} from "../../packages/core-v2/src/bench/grounding-plan.ts";
import { GROUNDING_SPECS } from "./bench-regression.ts"; // owner file — do not copy
import type { BudgetTierConfig } from "./config.ts";

// ─── CLI ─────────────────────────────────────────────────────────────

export interface EvalCliArgs {
	configFilter: string[];
	specFilter: string[];
	tier: string;
	run: boolean;
	allowStrong: boolean;
	metricsDir?: string;
	summaryOut?: string;
	help: boolean;
}

export function parseEvalArgs(argv: string[]): EvalCliArgs {
	const out: EvalCliArgs = {
		configFilter: [],
		specFilter: [],
		tier: process.env.PI_TASK_EVAL_TIER ?? "default",
		run: false,
		allowStrong: process.env.PI_TASK_ALLOW_STRONG === "1",
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = (): string => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${arg} requires a value`);
			return v;
		};
		if (arg === "--config") out.configFilter.push(value());
		else if (arg === "--spec") out.specFilter.push(value());
		else if (arg === "--tier") out.tier = value();
		else if (arg === "--run") out.run = true;
		else if (arg === "--allow-strong") out.allowStrong = true;
		else if (arg === "--metrics-dir") out.metricsDir = value();
		else if (arg === "--summary-out") out.summaryOut = value();
		else if (arg === "--help" || arg === "-h") out.help = true;
		else throw new Error(`unknown argument: ${arg}`);
	}
	return out;
}

const USAGE = `usage: npx tsx extensions/task/grounding-eval.ts [--run] [flags]

Suite-03 grounding-mode evaluation (docs/pi-task-v2.md §7). Default prints
the plan and exits — no spawns, no LLM calls.

modes:
  (default)         dry run — print the (config × spec) plan, exit 0
  --run             execute real LLM runs and emit evidence + summary

flags:
  --config <id>     restrict to one grounding config (repeatable;
                    known ids: ${GROUNDING_CONFIG_IDS.join(", ")})
  --spec <id>       restrict to one suite-03 spec id (repeatable)
  --tier <name>     baseline tier key (default: "default", or PI_TASK_EVAL_TIER)
  --allow-strong    include strong-model configs (or PI_TASK_ALLOW_STRONG=1)
  --metrics-dir <p> evidence dir (records.jsonl + summary.md)
  --summary-out <p> override the summary artifact path
  --help            this help

exit codes: 0 ok · 1 usage/config error · 2 run failures · 3 NFR-4 violation`;

/** Select configs honoring the strong gate; throws typed on bad filters. */
export function selectConfigs(
	args: Pick<EvalCliArgs, "allowStrong" | "configFilter">,
): GroundingConfig[] {
	return filterConfigs({
		includeStrong: args.allowStrong,
		configFilter: args.configFilter,
	});
}

/** Select suite-03 specs from the owner file (never duplicated). */
export function selectSpecs(
	args: Pick<EvalCliArgs, "specFilter">,
): PlanSpecInput[] {
	let specs: PlanSpecInput[] = GROUNDING_SPECS.map((s) => ({
		id: s.id,
		description: s.description,
		baseline: s.baseline,
	}));
	if (args.specFilter.length > 0) {
		const unknown = args.specFilter.filter(
			(id) => !specs.some((s) => s.id === id),
		);
		if (unknown.length > 0) {
			throw new Error(
				`--spec matched no known suite-03 spec: ${unknown.join(", ")} (known: ${GROUNDING_SPECS.map((s) => s.id).join(", ")})`,
			);
		}
		specs = specs.filter((s) => args.specFilter.includes(s.id));
	}
	return specs;
}

/** Render the dry plan (pure parts only — safe, zero LLM). */
export function renderPlanReport(args: EvalCliArgs): string[] {
	const configs = selectConfigs(args);
	const specs = selectSpecs(args);
	const plan = buildGroundingPlan({ configs, specs, tier: args.tier });
	return renderGroundingPlan(plan, { gatedIncluded: args.allowStrong });
}

// ─── Evidence store ──────────────────────────────────────────────────

export function recordsPath(metricsDir: string): string {
	return join(metricsDir, "eval-grounding", "records.jsonl");
}

/** Append one record (JSONL — additive, resumable). Throws on failure. */
export function appendRecord(
	metricsDir: string,
	record: GroundingRunRecord,
): void {
	const path = recordsPath(metricsDir);
	mkdirSync(join(path, ".."), { recursive: true });
	appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
}

/** Load every stored record (blank lines skipped; corrupt counted). */
export function loadRecords(metricsDir: string): {
	records: GroundingRunRecord[];
	corrupt: number;
} {
	const path = recordsPath(metricsDir);
	if (!existsSync(path)) return { records: [], corrupt: 0 };
	const records: GroundingRunRecord[] = [];
	let corrupt = 0;
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			records.push(JSON.parse(line) as GroundingRunRecord);
		} catch {
			corrupt += 1;
		}
	}
	return { records, corrupt };
}

/** Build + persist the summary artifact; returns its rendered lines. */
export function writeSummary(
	records: readonly GroundingRunRecord[],
	summaryOut: string,
): string[] {
	const aggs = [...aggregateRecords(records).values()];
	const winners = buildWinsLoses(aggs);
	const lines = renderSummaryLines(records, aggs, winners);
	mkdirSync(join(summaryOut, ".."), { recursive: true });
	writeFileSync(summaryOut, lines.join("\n") + "\n", "utf-8");
	return lines;
}

// ─── Real-run adapters (LLM-gated; lazy imports) ─────────────────────

interface TempRepo {
	dir: string;
	cleanup(): void;
}

async function makeTempFixtureRepo(specId: string): Promise<TempRepo> {
	const spec = GROUNDING_SPECS.find((s) => s.id === specId);
	if (!spec) throw new Error(`no fixture for spec ${specId}`);
	const dir = mkdtempSync(join(tmpdir(), "pi-task-grounding-"));
	execSync("jj git init --colocate", { cwd: dir, stdio: "pipe" });
	writeFileSync(join(dir, "README.md"), "# grounding-eval repo\n", "utf-8");
	execSync('jj commit -m "init"', { cwd: dir, stdio: "pipe" });
	const { materializeGroundingFixture } = await import("./bench-regression.ts");
	materializeGroundingFixture(dir, spec.fixture);
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Dispatch one planned run through its host's real pipeline.
 *
 * Fork/bundle hosts are NOT silently faked — they fail typed until their
 * engines can host them from batch context: forks need a live parent
 * session; bundles need the ExecutionBundle generator wired to a host.
 * Fabricating telemetry would defeat the thesis measurement.
 */
export async function dispatchOne(opts: {
	config: GroundingConfig;
	specId: string;
	tierConfig: BudgetTierConfig;
}): Promise<GroundingRunRecord> {
	if (opts.config.planMode === "fork") {
		throw new Error(
			`${opts.config.id}: fork runs need a live parent session — not reachable from batch; run interactively`,
		);
	}
	if (opts.config.planMode === "bundle") {
		throw new Error(
			`${opts.config.id}: bundle generation is not wired to a host yet (§5.3 b) — no fabricated telemetry`,
		);
	}
	const repo = await makeTempFixtureRepo(opts.specId);
	const startedAt = Date.now();
	try {
		const artifactsDir = join(repo.dir, ".pi-artifacts");
		if (opts.config.host === "engine-v1") {
			const { executeTask } = await import("./orchestrator.ts");
			const spec = GROUNDING_SPECS.find((s) => s.id === opts.specId)!;
			const result = await executeTask({
				cwd: repo.dir,
				spec: spec.specMarkdown,
				model: opts.tierConfig.executeModel,
				// prewalkModel omitted when null (exactOptionalPropertyTypes:
				// an explicit undefined is not assignable to `prewalkModel?: string`).
				...(opts.tierConfig.prewalkModel !== null
					? { prewalkModel: opts.tierConfig.prewalkModel }
					: {}),
				executeModel: opts.tierConfig.executeModel,
				review: false,
				reviewModel: opts.tierConfig.reviewModel,
				workerTimeoutMs: opts.tierConfig.wallTimeoutMs,
				budget: "grounding-eval",
				metricsDir: artifactsDir,
				project: "eval",
			});
			const m = result.manifest;
			const turns =
				(m?.phases.prewalk?.turns ?? 0) + (m?.phases.execute.turns ?? 0);
			return {
				configId: opts.config.id,
				specId: opts.specId,
				turns,
				inputTokens: m?.phases.execute.tokens_in ?? 0,
				outputTokens: m?.phases.execute.tokens_out ?? 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				groundingTokens: 0,
				costUsd: m?.totals.cost_usd ?? 0,
				durationMs: Date.now() - startedAt,
				firstPassVerify:
					result.verification.passed &&
					(m?.phases.fix_loop.iterations ?? 0) === 0,
				bundleHit: null,
				forkDeviationCount: 0,
				retriedWithHandoff: false,
				cacheHitOnRetry: null,
				filesChanged: m?.totals.files_changed.length ?? 0,
			};
		}
		// daemon + bare hosts go through the v2 pipeline (runTask).
		const { runTask, estimateGroundingTokens, buildWorkerSystemPrompt } =
			await import("../../packages/core-v2/src/daemon/task-runner.ts");
		const specMarkdown = GROUNDING_SPECS.find(
			(s) => s.id === opts.specId,
		)!.specMarkdown;
		const usePrewalk =
			opts.config.planMode === "prewalk" &&
			opts.tierConfig.prewalkModel !== null &&
			opts.tierConfig.prewalkModel !== opts.tierConfig.executeModel;
		const result = await runTask({
			specMarkdown,
			cwd: repo.dir,
			artifactsDir,
			dbPath: join(artifactsDir, "tasks.db"),
			model: opts.config.modelId ?? opts.tierConfig.executeModel,
			tierName: opts.config.id,
			sessionTimeoutMs: opts.tierConfig.wallTimeoutMs,
			...(usePrewalk && opts.tierConfig.prewalkModel
				? {
						prewalk: {
							enabled: true,
							modelId: opts.tierConfig.prewalkModel,
							pricing: {
								strong: { input: 3, cacheRead: 0.3, output: 15 },
								execute: { input: 0.3, cacheRead: 0.03, output: 1 },
							},
						},
					}
				: {}),
		});
		const r = result.receipt;
		const systemPrompt = buildWorkerSystemPrompt(specMarkdown);
		return {
			configId: opts.config.id,
			specId: opts.specId,
			turns: r.turns,
			inputTokens: r.inputTokens,
			outputTokens: r.outputTokens,
			cacheReadTokens: r.cacheReadTokens,
			cacheWriteTokens: 0,
			groundingTokens: estimateGroundingTokens(systemPrompt, specMarkdown),
			costUsd: r.costUsd,
			durationMs: Date.now() - startedAt,
			firstPassVerify: result.verificationPassed,
			bundleHit: r.bundleHit,
			forkDeviationCount: result.yieldedResult?.deviations.length ?? 0,
			retriedWithHandoff: false,
			cacheHitOnRetry: null,
			filesChanged: r.filesChanged,
		};
	} finally {
		repo.cleanup();
	}
}

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<number> {
	let args: EvalCliArgs;
	try {
		args = parseEvalArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`grounding-eval: ${(err as Error).message}`);
		console.error(USAGE);
		return 1;
	}
	if (args.help) {
		console.log(USAGE);
		return 0;
	}
	const metricsDir = args.metricsDir ?? join(process.cwd(), "results");

	// Dry path (default): pure rendering only.
	if (!args.run) {
		try {
			for (const line of renderPlanReport(args)) console.log(line);
		} catch (err) {
			console.error(`grounding-eval: ${(err as Error).message}`);
			return 1;
		}
		console.log(
			"(dry run — pass --run to execute; strong configs stay gated without --allow-strong)",
		);
		return 0;
	}

	// Real runs: resolve tier models from the shipped task.toml loader.
	const { loadTaskConfig } = await import("./config.ts");
	const config = loadTaskConfig();
	let tierConfig = config.tiers[args.tier];
	if (!tierConfig) {
		tierConfig =
			config.tiers[config.defaults.budget] ?? Object.values(config.tiers)[0];
	}
	if (!tierConfig) {
		console.error("grounding-eval: no usable budget tier in task.toml");
		return 1;
	}

	let configs: GroundingConfig[];
	try {
		configs = selectConfigs(args);
	} catch (err) {
		console.error(`grounding-eval: ${(err as Error).message}`);
		return 1;
	}
	const specs = selectSpecs(args);
	const failures: string[] = [];
	let violations = 0;

	for (const cfg of configs) {
		for (const spec of specs) {
			process.stdout.write(`\n── grounding-eval: ${cfg.id} × ${spec.id} ──\n`);
			try {
				const record = await dispatchOne({
					config: cfg,
					specId: spec.id,
					tierConfig,
				});
				appendRecord(metricsDir, record);
				if (record.retriedWithHandoff && record.cacheHitOnRetry === false)
					violations += 1;
				console.log(
					`  ✓ ${record.turns} turns · $${record.costUsd.toFixed(4)} · ` +
						`verify ${record.firstPassVerify ? "first-pass" : "retried"}`,
				);
			} catch (err) {
				const cause = err instanceof Error ? err.message : String(err);
				failures.push(`${cfg.id}/${spec.id}: ${cause}`);
				console.error(`  ✗ ${cause}`);
			}
		}
	}

	const { records, corrupt } = loadRecords(metricsDir);
	const summaryOut =
		args.summaryOut ?? join(metricsDir, "eval-grounding", "summary.md");
	const lines = writeSummary(records, summaryOut);
	for (const line of lines) console.log(line);
	console.log(
		`\nevidence: ${recordsPath(metricsDir)}\nsummary:  ${summaryOut}`,
	);
	if (corrupt > 0)
		console.warn(`warning: skipped ${corrupt} corrupt record line(s)`);

	if (violations > 0) return 3;
	return failures.length > 0 ? 2 : 0;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(
				"grounding-eval FAILED:",
				err instanceof Error ? err.message : err,
			);
			process.exit(1);
		});
}
