/**
 * pi-task extension entry point (Phase 9) — the user-facing integration.
 *
 * Registers:
 *
 * 1. The `task` tool — the conversational model's interface to the
 *    orchestrator. Decomposition is the main agent's job: it writes either
 *    a single `spec` (mechanical `parallel` split fallback) or fully
 *    self-contained per-worker `sub_specs` (one worker per sub-spec, no
 *    shared goal — no scope leak by construction). The typed TaskResult is
 *    mapped to the tool's return shape (taskResultToToolReturn); progress
 *    streams to the TUI via onUpdate / renderResult — no LLM tokens burned
 *    for the chrome. Completion surfaces a one-line summary — wall-clock
 *    latency · cost · verify status · tier (completionSummaryLine) — as the
 *    content text's first line and the TUI's completion line (R1/R4).
 *
 * 2. Budget enforcement — the `--task-budget` CLI flag + `/task-budget`
 *    session command. When a concrete tier is locked, the `budget`
 *    parameter is REMOVED from the tool's schema: the model can neither
 *    see it nor override it, and the status bar shows "task: <tier>
 *    (locked)".
 *
 *    ⚠ Schema-locking timing (empirically verified, Phase 9): pi applies
 *    CLI flag values to the extension runtime AFTER extension factories
 *    run, so `pi.getFlag` at registration time returns only the registered
 *    default. The task tool is therefore registered at session_start (the
 *    earliest point the real value is reliably readable) and re-registered
 *    on every /task-budget change. See docs/pi-task-design.md → Budget
 *    Enforcement → Implementation notes (Phase 9).
 *
 * 3. Main-session codebase-map injection (hybrid): an always-on global
 *    overview appended to the system prompt (before_agent_start) plus an
 *    on-demand `codebase_map` tool returning relevance-sliced file lists —
 *    both gated by config/repo-map.toml [injection] main_agent /
 *    overview_in_system_prompt. The overview path is non-blocking: it only
 *    reads the cached map (never calls the LLM); the annotation that keeps
 *    the cache fresh runs asynchronously at session_start.
 *
 * Model resolution is config-driven (Phases 10-11): config/task.toml is the
 * tier source of truth (loaded by config.ts; built-in defaults when
 * missing/invalid), and since Phase 11 the tier VOCABULARY is dynamic —
 * every [budget.*] section in task.toml is a supported tier, with the schema
 * enum, the --task-budget flag choices, and the /task-budget command choices
 * built from the loaded config's tiers plus "auto" (no code change for a new
 * tier). The config is re-loaded at session_start and on every /task-budget
 * change (the enum reflects the current task.toml); editing task.toml
 * mid-session needs /reload or a /task-budget command to refresh the enum.
 * Resolution chain: locked flag > locked param > config default —
 * `pi.getFlag("task-budget")` never returns undefined (the flag is
 * registered with default "auto"), so `--task-budget auto` and an unset
 * flag are indistinguishable and both defer to the config default; the
 * `auto` mode is resolved via the requirement-count heuristic (≤5 economy,
 * ≥6 full, over the loaded tier set). See the resolution helpers below.
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeTask, type TaskResult } from "./orchestrator.ts";
import {
	applyProgressEvent,
	buildProgressText,
	buildRunPlan,
	createProgressState,
	formatDuration,
} from "./progress.ts";
import { buildMap, formatMapOverview, formatMapPrompt, loadCachedMap, loadRepoMapConfig, sliceRelevant } from "./repo-map.ts";
import type { ReviewResult } from "./schemas/findings.ts";
import { renderTaskStats, runLatencyMs, summarizeRuns } from "./metrics.ts";
import type { RunManifest } from "./metrics.ts";
import {
	budgetModes,
	DEFAULT_BUDGET_TIER,
	DEFAULT_BUDGET_TIERS,
	findTier,
	loadTaskConfig,
	type BudgetMode,
	type BudgetTier,
	type BudgetTierConfig,
	type TaskConfig,
} from "./config.ts";

// Budget vocabulary lives in config.ts (Phases 10-11 — task.toml owns it,
// config-driven tier discovery since Phase 11); re-exported so existing
// imports from index.ts keep working.
export {
	BUDGET_TIERS,
	budgetModes,
	DEFAULT_BUDGET_TIER,
	DEFAULT_BUDGET_TIERS,
	type BudgetMode,
	type BudgetTier,
	type BudgetTierConfig,
} from "./config.ts";
import { parseSpec } from "./schemas/spec.ts";

// ─── Budget resolution helpers ────────────────────────────────────────

/** True when `value` is a concrete (locked) budget tier of `tiers`.
 *  Phase 11: the tier vocabulary is the LOADED config's tier set (any
 *  [budget.*] section in task.toml); DEFAULT_BUDGET_TIERS is the
 *  fallback when no config is loaded. */
export function isLockedBudget(
	value: unknown,
	tiers: Record<BudgetTier, BudgetTierConfig> = DEFAULT_BUDGET_TIERS,
): value is BudgetTier {
	return findTier(tiers, value) !== undefined;
}

/** Normalize a flag/param value to a BudgetMode ("auto" or a loaded tier);
 *  anything invalid → "auto". Phase 11: the valid set is the loaded config's
 *  tiers + "auto". */
export function normalizeBudgetMode(
	value: unknown,
	tiers: Record<BudgetTier, BudgetTierConfig> = DEFAULT_BUDGET_TIERS,
): BudgetMode {
	return typeof value === "string" && budgetModes(tiers).includes(value) ? value : "auto";
}

/**
 * Resolve the effective budget MODE: a locked CLI flag wins; else a
 * locked model `budget` param wins; else the result is
 * `normalizeBudgetMode(configDefault)`. The flag value participates no
 * further — "auto" or any unlocked/undefined flag falls through to the
 * config default. (pi.getFlag("task-budget") never returns undefined: the
 * flag is registered with default "auto", so an unset flag arrives as
 * "auto" and is indistinguishable from an explicit --task-budget auto.)
 * `configDefault` is the `[defaults]` `budget` from task.toml and may
 * itself be "auto" (heuristic default). Pure — tested hermetically.
 */
export function resolveBudgetMode(
	flag: unknown,
	param: unknown,
	configDefault: BudgetMode = DEFAULT_BUDGET_TIER,
	tiers: Record<BudgetTier, BudgetTierConfig> = DEFAULT_BUDGET_TIERS,
): BudgetMode {
	if (isLockedBudget(flag, tiers)) return flag;
	if (isLockedBudget(param, tiers)) return param;
	return normalizeBudgetMode(configDefault, tiers);
}

/**
 * The `auto` requirement-count heuristic (planning decision, Phase 11
 * dynamic tiers): small tasks run on the cheap tier, large ones on full;
 * free is never auto-selected; an uncountable spec defaults to the default
 * tier. Well-known-name behavior kept over the LOADED tier set: ≤5 →
 * "economy" when present (else the default tier); ≥6 → "full" when present
 * (else the default tier); the fallback is DEFAULT_BUDGET_TIER when loaded,
 * else the first non-"max" tier — the heuristic never auto-selects the
 * "max"/strongest tier. Thresholds are deliberately simple (≤5 → economy,
 * ≥6 → full) — fine-tuning is future work. Pure — tested hermetically.
 */
export function autoTierForRequirements(
	count: number | null,
	tiers: Record<BudgetTier, BudgetTierConfig> = DEFAULT_BUDGET_TIERS,
): BudgetTier {
	const small = count !== null && count <= 5;
	const large = count !== null && count > 5;
	if (small && "economy" in tiers) return "economy";
	if (large && "full" in tiers) return "full";
	return heuristicDefaultTier(tiers);
}

/** The heuristic's "default tier": DEFAULT_BUDGET_TIER when loaded, else the
 *  first tier that is not "max" (never auto-select the strongest tier), else
 *  the first tier. Always a member of `tiers` when it is non-empty. */
function heuristicDefaultTier(tiers: Record<BudgetTier, BudgetTierConfig>): BudgetTier {
	if (DEFAULT_BUDGET_TIER in tiers) return DEFAULT_BUDGET_TIER;
	const names = Object.keys(tiers);
	const notMax = names.find((name) => name !== "max");
	return notMax ?? names[0] ?? DEFAULT_BUDGET_TIER;
}

/**
 * Lenient requirement count for the heuristic: parseSpec in a try/catch,
 * null when the spec is unparseable (the SpecError will surface later
 * from executeTask's validation — resolution must never throw).
 */
export function countSpecRequirements(spec: string): number | null {
	try {
		return parseSpec(spec).requirements.length;
	} catch {
		return null;
	}
}

/** Sum of per-sub-spec requirement counts; all unparseable (or empty) → null. */
export function countSubSpecsRequirements(subSpecs: string[]): number | null {
	let total = 0;
	let counted = 0;
	for (const sub of subSpecs) {
		const n = countSpecRequirements(sub);
		if (n !== null) {
			total += n;
			counted++;
		}
	}
	return counted > 0 ? total : null;
}

/** Render a structured sub-spec entry to the worker markdown contract. */
export function renderSubSpecObject(o: SubSpecObject): string {
	if (o.requirements.length === 0 || o.verification.length === 0) {
		throw new Error("Invalid sub_specs entry: requirements and verification must each have at least one item.");
	}
	const lines = ["## Goal", o.goal.trim(), "", "## Requirements"];
	o.requirements.forEach((r, i) => lines.push(`- R${i + 1}: ${r.trim()}`));
	lines.push("", "## Verification");
	o.verification.forEach((v) => lines.push(v.trim()));
	if (o.context && o.context.trim()) lines.push("", "## Context", o.context.trim());
	return lines.join("\n");
}

/** Normalize sub_specs entries: markdown strings pass through; objects render to markdown. */
export function normalizeSubSpecs(subSpecs: (string | SubSpecObject)[]): string[] {
	return subSpecs.map((s) => (typeof s === "string" ? s : renderSubSpecObject(s)));
}

/**
 * Resolve the tool's spec input: guard (spec or sub_specs required) and
 * normalize object entries to the markdown contract. Pure — tested
 * hermetically. Throws a precise error when neither is given.
 */
export function resolveSubSpecs(p: {
	spec?: string;
	sub_specs?: (string | SubSpecObject)[];
}): { hasSubSpecs: boolean; spec: string; subSpecs: string[] } {
	const hasSubSpecs = Array.isArray(p.sub_specs) && p.sub_specs.length > 0;
	if (!hasSubSpecs && !(p.spec && p.spec.trim())) {
		throw new Error(
			"The task tool needs work to do — pass 'spec' (markdown) or 'sub_specs' " +
				"(one spec per worker: markdown strings or {goal, requirements, verification} objects).",
		);
	}
	return hasSubSpecs
		? { hasSubSpecs: true, spec: "", subSpecs: normalizeSubSpecs(p.sub_specs!) }
		: { hasSubSpecs: false, spec: p.spec ?? "", subSpecs: [] };
}

/**
 * Resolve the effective TIER: the mode from `resolveBudgetMode` (locked
 * session mode > locked param > config default) mapped to a concrete
 * tier — locked → that tier; "auto" → `autoTierForRequirements(requirementCount)`
 * (heuristic unchanged; a null count degrades to the built-in default tier (full)).
 * `flag` is the SESSION budget mode — the stored /task-budget override,
 * else the CLI flag, resolved at session_start — not the raw flag value:
 * a /task-budget lock never appears in the flag, so feeding the raw flag
 * here bypasses the lock (todo #69). Pure — tested hermetically.
 */
export function resolveBudgetTier(
	flag: unknown,
	param: unknown,
	configDefault: BudgetMode = DEFAULT_BUDGET_TIER,
	requirementCount: number | null = null,
	tiers: Record<BudgetTier, BudgetTierConfig> = DEFAULT_BUDGET_TIERS,
): BudgetTier {
	const mode = resolveBudgetMode(flag, param, configDefault, tiers);
	return isLockedBudget(mode, tiers) ? mode : autoTierForRequirements(requirementCount, tiers);
}

// ─── Task tool schema (budget param gated by the lock) ───────────────

/** Structured sub-spec entry — normalized to the worker markdown contract. */
export interface SubSpecObject {
	/** One sentence describing the outcome (## Goal). */
	goal: string;
	/** WHATs that must be true when done (## Requirements; rendered as "- R1: ..."). */
	requirements: string[];
	/** Plain bash commands, one per line — each exits 0 when the work is done (## Verification). */
	verification: string[];
	/** Optional pointers/context for the worker (## Context; ignored by spec parsing). */
	context?: string;
}

/** The task tool's runtime params (superset of both schema shapes). */
export interface TaskToolParams {
	spec?: string;
	sub_specs?: (string | SubSpecObject)[];
	parallel?: number;
	budget?: string;
}

/**
 * Build the task tool's parameter schema. When `locked` (a concrete tier
 * fixed by the user via --task-budget or /task-budget), the `budget`
 * parameter is REMOVED entirely — the model never sees it and cannot
 * override it. The budget enum is config-driven (Phase 11): "auto" + the
 * loaded config's tiers in file order (any [budget.*] section in task.toml
 * becomes an enum value with no code change). Pure — tested hermetically.
 */
export function taskToolSchema(
	locked: boolean,
	tiers: Record<BudgetTier, BudgetTierConfig> = DEFAULT_BUDGET_TIERS,
): TSchema {
	const base = {
		spec: Type.Optional(
			Type.String({
				description:
					"Markdown task spec: ## Goal (one sentence), ## Requirements (numbered list, e.g. '- R1: ...'), " +
					"and ## Verification — PLAIN bash commands, one per line, no backticks, no quotes, no prose " +
					"(each line must be a shell command that exits 0 on success). Optional when sub_specs is given.",
			}),
		),
		sub_specs: Type.Optional(
			Type.Array(
				Type.Union([
					Type.String(),
					Type.Object({
						goal: Type.String({ description: "One sentence describing the outcome (## Goal)." }),
						requirements: Type.Array(Type.String(), {
							description: "WHATs that must be true when done (## Requirements; rendered as '- R1: ...').",
						}),
						verification: Type.Array(Type.String(), {
							description:
								"Plain bash commands, one per line, no backticks/quotes/prose — each exits 0 when done (## Verification).",
						}),
						context: Type.Optional(
							Type.String({ description: "Extra pointers for the worker (## Context; optional)." }),
						),
					}),
				]),
				{
					description:
						"Per-worker encapsulated specs — takes precedence over spec + parallel: one isolated worker runs " +
						"per entry, no splitting. Each is a markdown spec string (its own ## Goal / ## Requirements / " +
						"## Verification; no cross-references to other partitions) OR an object " +
						"{goal, requirements: string[], verification: string[], context?} rendered to the same markdown. " +
						"Their verification commands are unioned into the single post-merge gate. " +
						'Example: {goal: "Make the build green", requirements: ["Fix the failing test"], ' +
						'verification: ["test -f out.txt"]}.',
				},
			),
		),
		parallel: Type.Optional(
			Type.Integer({
				description:
					"Mechanical-split fallback: split spec across this many parallel workers (each in an isolated jj " +
					"workspace, merged afterwards). Ignored when sub_specs is set.",
			}),
		),
	};
	if (locked) return Type.Object(base);
	return Type.Object({
		...base,
		budget: Type.Optional(
			StringEnum(budgetModes(tiers), {
				description:
					"Worker model budget tier: any [budget.*] tier from task.toml (the enum lists the " +
					"currently loaded tiers in file order) or auto = defer to the task.toml [defaults] " +
					"budget. When the user locks a tier via --task-budget or /task-budget, this " +
					"parameter is removed from the schema.",
			}),
		),
	});
}

// ─── Tool return mapping (design doc "The `task` Tool") ──────────────

export interface TaskToolReturn {
	success: boolean;
	commits: string[];
	tests: "passing" | "failing";
	files_changed: string[];
	review: ReviewResult | null;
	metrics: RunManifest | null;
	/** Total run wall time (ms) — the completion summary's latency fallback
	 *  when the run left no manifest (defensive: the task tool always has
	 *  one, single AND parallel). */
	duration_ms: number;
	/** Present on parallel runs: repo-relative unresolved merge conflicts. */
	conflicts?: string[];
	/** True when a requested review was skipped (review is single-worker
	 *  only; parallel runs verify-only). */
	review_skipped?: boolean;
	/** R2: success-with-caveat note — present when a finalization-incomplete
	 *  abort recovered ("worker k aborted during finalization; verified
	 *  post-merge"). */
	caveat?: string;
	verification: { passed: boolean; failures: Array<{ command: string; exitCode: number; output: string }> };
}

/** Streamed progress details (TUI-only; not part of the final return). */
export interface TaskToolProgress {
	progress: string;
}

export type TaskToolDetails = TaskToolReturn | TaskToolProgress;

/**
 * Map the orchestrator's TaskResult to the tool's typed return shape.
 * Pure — tested hermetically.
 */
export function taskResultToToolReturn(result: TaskResult): TaskToolReturn {
	return {
		success: result.success,
		commits: result.commits,
		tests: result.tests,
		files_changed: result.files_changed,
		review: result.review ?? null,
		metrics: result.manifest ?? null,
		duration_ms: result.durationMs,
		...(result.conflicts !== undefined ? { conflicts: result.conflicts } : {}),
		...(result.reviewSkipped ? { review_skipped: true } : {}),
		...(result.caveat !== undefined ? { caveat: result.caveat } : {}),
		verification: {
			passed: result.verification.passed,
			failures: result.verification.failures,
		},
	};
}

/** Findings listed in the summary's review report; the rest are elided
 *  with "... and M more" so the content text stays reasonable. */
const MAX_REVIEW_FINDINGS_IN_SUMMARY = 10;

/**
 * Render the review report for the tool's content text (todo #72): the
 * verdict line, the per-requirement status (met/unmet/uncertain), and each
 * finding as `[PRIORITY, category] file: description` — capped at
 * MAX_REVIEW_FINDINGS_IN_SUMMARY findings (the remainder is elided with
 * "... and M more finding(s)"). Compact when the review is clean: no
 * per-finding lines, no elision line. Pure — tested hermetically.
 */
export function renderReviewReport(review: ReviewResult): string {
	const lines = [`Review: ${review.verdict} — ${review.findings.length} finding(s).`];
	const requirementStatus = review.requirements.map((r) => `${r.id}: ${r.status}`).join("; ");
	if (requirementStatus) lines.push(`  Requirements: ${requirementStatus}`);
	for (const finding of review.findings.slice(0, MAX_REVIEW_FINDINGS_IN_SUMMARY)) {
		lines.push(`  [${finding.priority}, ${finding.category}] ${finding.file}: ${finding.description}`);
	}
	const more = review.findings.length - MAX_REVIEW_FINDINGS_IN_SUMMARY;
	if (more > 0) lines.push(`  ... and ${more} more finding(s)`);
	return lines.join("\n");
}

export interface CompletionSummaryInput {
	/** Whether the run succeeded — "task done" vs "task failed". */
	success: boolean;
	/** The run's RunManifest — the latency/cost/verify/tier source (R1).
	 *  Null for direct executeTask callers without one (defensive: the task
	 *  tool always builds a manifest, single AND parallel). */
	manifest: RunManifest | null;
	/** Worker-measured duration fallback when the manifest is absent. */
	durationMs: number;
	/** Failed verification commands — refine the passed count when some
	 *  commands failed (the manifest's verify phase only carries the passed
	 *  boolean and the command total). */
	verificationFailures: unknown[];
}

/**
 * The one-line task completion summary for the main session (R1):
 * "task done in 84s · $0.006 · 5/5 verified (economy)". Latency is the
 * wall clock (completed_at − received_at) when the manifest carries both
 * timestamps, else the worker-measured totals.duration_ms (runLatencyMs);
 * cost, verify status, and tier come from the manifest (totals.cost_usd,
 * phases.verify passed/commands, config.budget). Verify status is the
 * passed/total verification-command count — "N/N verified" when the phase
 * passed, else refined from the failure list. Without a manifest, degrades
 * to the duration only. Pure — tested hermetically.
 */
export function completionSummaryLine(input: CompletionSummaryInput): string {
	const { success, manifest, durationMs, verificationFailures } = input;
	const duration = manifest ? runLatencyMs(manifest) : durationMs;
	const done = success ? "done" : "failed";
	if (!manifest) return `task ${done} in ${formatDuration(duration)}`;
	const verify = manifest.phases.verify;
	const passed = verify.passed
		? verify.commands
		: Math.max(0, verify.commands - verificationFailures.length);
	return [
		`task ${done} in ${formatDuration(duration)}`,
		`$${formatCost(manifest.totals.cost_usd)}`,
		`${passed}/${verify.commands} verified (${manifest.config.budget})`,
	].join(" · ");
}

/** One-line (plus expanded) summary of a TaskResult — the LLM-visible text. */
export function summarizeResult(result: TaskResult): string {
	const parts = [
		// R1/R4: the one-line completion summary owns latency (wall-clock when
		// the manifest carries the run-lifecycle timestamps, else the worker
		// duration), cost, verify status, and tier — shown for single and
		// parallel runs alike (the parallel aggregate manifest has the same
		// shape) and for failures ("task failed", failure lines follow).
		completionSummaryLine({
			success: result.success,
			manifest: result.manifest ?? null,
			durationMs: result.durationMs,
			verificationFailures: result.verification.failures,
		}),
		// R1: parallel runs report the merge outcome unambiguously — the
		// merged commit id + the file delta vs the pre-merge base, and that
		// the worker commits were consumed by the squash (no dangling state,
		// no "left outside the base" ambiguity).
		result.manifest?.merge
			? `Task ${result.success ? "succeeded" : "failed"}: merged ${result.manifest.merge.worker_count ?? "?"} worker commit(s) → ` +
				`${result.commits[0] ?? "?"} (${result.files_changed.length} file(s) changed vs base; worker commits consumed).`
			: `Task ${result.success ? "succeeded" : "failed"}: ${result.commits.length} commit(s), ` +
				`tests ${result.tests}, ${result.files_changed.length} file(s) changed.`,
	];
	// Token detail only — the summary line above already carries duration and
	// cost (R4: no duplication). Cost appears here again ONLY when the run
	// left no manifest (the summary line cannot show it then — defensive;
	// the task tool always has one). Tokens: manifest phases first, else
	// aggregated worker usage snapshots.
	const { tokensIn, tokensOut, costUsd } = deriveRunMetrics(result);
	const metricsLine = [
		tokensIn !== null ? `Tokens: ${tokensIn} in / ${tokensOut} out.` : null,
		!result.manifest && costUsd !== null ? `Cost: $${formatCost(costUsd)}.` : null,
	].filter((s): s is string => s !== null).join(" ");
	if (metricsLine) parts.push(metricsLine);
	if (result.conflicts && result.conflicts.length > 0) {
		parts.push(`Merge conflicts: ${result.conflicts.join(", ")}.`);
	}
	if (result.review) {
		parts.push(renderReviewReport(result.review));
	}
	if (result.reviewSkipped) {
		parts.push("Review skipped (single-worker only).");
	}
	// R2: a finalization-incomplete recovery reports success WITH the caveat
	// (the worker aborted during finalization; the gate verified post-merge).
	if (result.caveat) {
		parts.push(result.caveat);
	}
	parts.push(`Files: ${result.files_changed.join(", ") || "(none)"}`);
	return parts.join("\n");
}

/**
 * R4: the run's duration plus token/cost metrics for the completion
 * summary. The RunManifest (present on both single and parallel runs) is
 * preferred: tokens sum prewalk+execute phase metrics, cost is
 * totals.cost_usd (includes review + fix loop), duration is
 * totals.duration_ms. Without a manifest, tokens/cost aggregate the last
 * per-worker turnUsage snapshot (TaskResult.worker / workers[]) and the
 * duration comes from TaskResult.durationMs (always populated — R5). A
 * value is null when it is not derivable (no manifest AND no usage
 * snapshots / no cost field on the usage). Pure — tested hermetically.
 */
export function deriveRunMetrics(result: TaskResult): {
	durationMs: number;
	tokensIn: number | null;
	tokensOut: number | null;
	costUsd: number | null;
} {
	const manifest = result.manifest;
	if (manifest) {
		const prewalk = manifest.phases.prewalk;
		const execute = manifest.phases.execute;
		return {
			durationMs: manifest.totals.duration_ms,
			tokensIn: (prewalk?.tokens_in ?? 0) + execute.tokens_in,
			tokensOut: (prewalk?.tokens_out ?? 0) + execute.tokens_out,
			costUsd: manifest.totals.cost_usd,
		};
	}
	const sources = result.workers && result.workers.length > 0 ? result.workers : [result.worker];
	let tokensIn = 0;
	let tokensOut = 0;
	let cost = 0;
	let usageSeen = false;
	let costSeen = false;
	for (const w of sources) {
		const last = w.turnUsage[w.turnUsage.length - 1];
		if (!last) continue;
		usageSeen = true;
		tokensIn += last.tokens_in;
		tokensOut += last.tokens_out;
		if (typeof last.cost_usd === "number") {
			cost += last.cost_usd;
			costSeen = true;
		}
	}
	return {
		durationMs: result.durationMs,
		tokensIn: usageSeen ? tokensIn : null,
		tokensOut: usageSeen ? tokensOut : null,
		costUsd: costSeen ? cost : null,
	};
}

/** Cost as a readable dollar string, e.g. "0.0012" (trailing zeros trimmed). */
function formatCost(usd: number): string {
	const s = usd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
	return s || "0";
}

/**
 * Attach the last progress view to a task failure (todo #86): the main
 * agent sees the frozen worker state (phase, turns, checklist, idle)
 * next to the cause, instead of a bare timeout/abort message. Pure —
 * hermetically tested.
 */
export function failureMessageWithProgress(message: string, progressText: string): string {
	return progressText ? `${message}\n\nLast progress:\n${progressText}` : message;
}

/**
 * In-place TUI render (todo #68): pi's documented lastComponent-reuse
 * pattern — used by pi's own built-in tools (see dist/core/tools/find.ts
 * renderResult/renderCall) — a partial render must MUTATE the previous
 * component so the TUI updates the progress view in place instead of
 * stacking a fresh Text per update. Pure (no TUI runtime) — tested
 * hermetically in test-index.ts.
 */
export function renderInPlace(context: { lastComponent?: unknown }, content: string): Text {
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	text.setText(content);
	return text;
}

// ─── Progress streaming (TUI, zero LLM tokens) ───────────────────────
// Pure plan + render logic lives in progress.ts (hermetically tested);
// re-exported here so index.ts stays the integration surface.

export {
	applyProgressEvent,
	buildProgressText,
	buildRunPlan,
	createProgressState,
	formatDuration,
	initialPhaseOf,
	renderPlanLine,
	type BuildRunPlanOptions,
	type PlanPhase,
	type ProgressState,
	type RunPlan,
	type WorkerPhase,
	type WorkerProgress,
} from "./progress.ts";

// ─── Extension wiring ────────────────────────────────────────────────

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
/** Production default results dir (data, gitignored — see .gitignore). */
const METRICS_DIR = join(getAgentDir(), "results");

/** Session entry key persisting a mid-session /task-budget override. */
const BUDGET_ENTRY_TYPE = "pi-task-budget";

/**
 * Latest stored budget override from session entries, if any. The LAST
 * matching entry wins (mirrors checklist.ts readState) — a stale earlier
 * override must not clobber a newer one when /reload replays the session
 * entries. Exported for the hermetic persistence test.
 */
export function readBudgetOverride(
	ctx: { sessionManager: { getEntries(): unknown[] } },
	tiers: Record<BudgetTier, BudgetTierConfig> = DEFAULT_BUDGET_TIERS,
): BudgetMode | undefined {
	let latest: BudgetMode | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		const e = entry as { type?: string; customType?: string; data?: { budgetMode?: unknown } };
		if (e.type === "custom" && e.customType === BUDGET_ENTRY_TYPE) {
			latest = normalizeBudgetMode(e.data?.budgetMode, tiers);
		}
	}
	return latest;
}

/**
 * Main-session token spend BEFORE the task call (R1): the cumulative
 * tokens of every assistant message in the session entries — the main
 * agent's own consumption (worker tokens land in the manifest's phases;
 * this is what the session burned to get to the dispatch). Reads the
 * session the same way readBudgetOverride does
 * (ctx.sessionManager.getEntries() — no new API surface). Lenient:
 * entries without a usage object contribute 0 (tool results, custom
 * entries, user messages, compaction entries...). totalTokens preferred;
 * falls back to input+output when a provider omits it. Pure — tested
 * hermetically.
 */
export function readSessionTokensBefore(ctx: {
	sessionManager: { getEntries(): unknown[] };
}): number {
	let total = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		const e = entry as {
			type?: string;
			message?: { role?: string; usage?: { totalTokens?: number; input?: number; output?: number } };
		};
		if (e.type !== "message" || e.message?.role !== "assistant") continue;
		const u = e.message.usage;
		if (!u) continue;
		if (typeof u.totalTokens === "number") total += u.totalTokens;
		else total += (u.input ?? 0) + (u.output ?? 0);
	}
	return total;
}

export default function (pi: ExtensionAPI) {
	// ── Config (Phase 11: refreshed, not factory-only) ────────────────
	// task.toml (budget tiers + defaults) is loaded at factory time so the
	// --task-budget flag description and the codebase-map wiring exist, and
	// RE-loaded at session_start and on every /task-budget change so the
	// tool's schema enum reflects the CURRENT task.toml (Phase 11 — any
	// [budget.*] tier becomes an enum value with no code change). Editing
	// task.toml mid-session therefore needs /reload (which replays
	// session_start) or a /task-budget command to refresh the enum.
	// repo-map.toml stays factory-time (read-only after load).
	let taskConfig: TaskConfig = loadTaskConfig();
	const mapConfig = loadRepoMapConfig();

	// ── Budget state ─────────────────────────────────────────────
	// The single source of truth for the CURRENT session: initialized from
	// the CLI flag at session_start (stored overrides win on reload), then
	// mutated by /task-budget. The flag value itself is not writable from
	// extensions, so mid-session changes live here (and in the session
	// entry, so they survive /reload).
	let budgetMode: BudgetMode = "auto";

	pi.registerFlag("task-budget", {
		description:
			`Lock the task worker budget tier: ${budgetModes(taskConfig.tiers).join(" | ")} ` +
			"(auto defers to the task.toml default; the enum refreshes on /reload or a /task-budget change)",
		type: "string",
		default: "auto",
	});

	/** Register (or re-register) the task tool with the current lock state +
	 *  the loaded tier set (the schema enum follows the current task.toml). */
	const registerTaskTool = (locked: boolean, tiers: Record<BudgetTier, BudgetTierConfig>): void => {
		pi.registerTool<TSchema, TaskToolDetails>({
			name: "task",
			label: "Task",
			description:
				"Execute a coding task in an isolated worker session (jj-committed, verification-gated). " +
				"Write a spec describing WHAT to build, not how — the worker explores and plans. The spec's " +
				"## Verification must be plain bash commands, one per line (no backticks or prose). For parallel " +
				"work, prefer fully self-contained sub_specs (one per worker, each with its own Goal / " +
				"Requirements / Verification, no cross-references); the spec + parallel mechanical split is the " +
				"fallback. Budget: " +
				(locked ? "locked by the user (see status bar)." : "optional (auto = task.toml default)."),
			promptSnippet: "Execute a coding task in an isolated worker session (spec → typed result)",
			parameters: taskToolSchema(locked, tiers),

			async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
				const p = rawParams as TaskToolParams;
				const { hasSubSpecs, spec, subSpecs } = resolveSubSpecs(p);
				// Auto-heuristic requirement count: sub_specs win, else the spec.
				const reqCount = hasSubSpecs
					? countSubSpecsRequirements(subSpecs)
					: countSpecRequirements(spec);
				// The session budget mode (stored /task-budget override, else the
				// CLI flag — resolved at session_start, mutated by the command) is
				// the user's lock. The raw flag value is NOT a valid input here:
				// /task-budget locks never touch the flag, so resolving from it
				// would bypass the lock (todo #69).
				const tier = resolveBudgetTier(
					budgetMode,
					p.budget,
					taskConfig.defaults.budget,
					reqCount,
				);
				const tierConfig = taskConfig.tiers[tier];

				const parallel = hasSubSpecs ? subSpecs.length : Math.max(1, p.parallel ?? 1);
				// The orchestrator clamps mechanical splits to the requirement count;
				// mirror it so the view matches the number of workers dispatched.
				const workerCount =
					hasSubSpecs || reqCount === null ? parallel : Math.min(parallel, reqCount);
				// Review runs only on the single-worker non-sub_specs path (the
				// orchestrator warns and skips it otherwise) — the plan line
				// reflects that.
				const reviewWillRun = tierConfig.review && !hasSubSpecs && parallel <= 1;
				const plan = buildRunPlan({
					tier,
					prewalkModel: tierConfig.prewalkModel ?? undefined,
					executeModel: tierConfig.executeModel,
					reviewModel: tierConfig.reviewModel,
					review: reviewWillRun,
					wallTimeoutMs: tierConfig.wallTimeoutMs,
				});

				// Stream progress to the TUI (no LLM tokens for the chrome).
				const progress = createProgressState(workerCount, plan, Date.now());
				const emitProgress = (): void => {
					const text = buildProgressText(progress, Date.now());
					onUpdate?.({ content: [{ type: "text", text }], details: { progress: text } });
				};
				// R1: the dispatch plan (phase sequence + model per phase) is
				// emitted synchronously, before any worker event or turn.
				emitProgress();
				const handleUpdate = (partial: unknown): void => {
					applyProgressEvent(progress, partial, Date.now());
					emitProgress();
				};

				// Heartbeat: the elapsed/idle clocks only advance when worker
				// events arrive, so a long silent model call or tool run freezes
				// the view (observed: stuck at 17s, then jumping to 1m03s) and
				// makes a healthy worker look hung. Re-render once per second
				// while the run is active so the clocks tick smoothly. Zero LLM
				// cost — the same TUI-chrome onUpdate channel, in-place rendered.
				const heartbeat = setInterval(emitProgress, 1000);

				try {
					// R1: received_at = the moment the task tool's execute starts, and
					// the main session's token spend up to this point (worker tokens
					// are the manifest's phases — this is the pre-dispatch spend, read
					// the same way readBudgetOverride reads the session). Both land in
					// the RunManifest via ExecuteTaskOptions.
					const receivedAt = new Date().toISOString();
					const mainSessionTokens = readSessionTokensBefore(ctx);
					const result = await executeTask({
						cwd: ctx.cwd,
						model: tierConfig.executeModel,
						...(hasSubSpecs ? { subSpecs } : { spec }),
						parallel: hasSubSpecs ? undefined : parallel,
						prewalkModel: tierConfig.prewalkModel ?? undefined,
						executeModel: tierConfig.executeModel,
						reviewModel: tierConfig.reviewModel,
						review: tierConfig.review,
						maxFixIterations: taskConfig.defaults.maxFixIterations,
						// Phase 11 (R4/R5): the resolved tier's worker wall + the
						// shared per-tool-call budget (both config-driven).
						workerTimeoutMs: tierConfig.wallTimeoutMs,
						toolTimeoutMs: taskConfig.defaults.toolTimeoutMs,
						verificationTimeoutMs: taskConfig.defaults.verificationTimeoutMs,
						// Todo #84: AI commit identity for worker commits.
						aiAuthorName: taskConfig.defaults.aiAuthorName,
						aiAuthorEmail: taskConfig.defaults.aiAuthorEmail,
						budget: tier,
						sandbox: taskConfig.sandbox,
						signal,
						onUpdate: handleUpdate,
						metricsDir: METRICS_DIR,
						receivedAt,
						mainSessionTokens,
					});
					const ret = taskResultToToolReturn(result);
					return { content: [{ type: "text", text: summarizeResult(result) }], details: ret };
				} catch (err) {
					// Throwing signals isError: the model sees the precise
					// message (e.g. a SpecError listing what's missing) and
					// can retry with a corrected spec. Attach the last progress
					// view so a timeout/abort failure carries the frozen worker
					// state (phase, turns, checklist, idle) — todo #86.
					const msg = err instanceof Error ? err.message : String(err);
					throw new Error(failureMessageWithProgress(msg, buildProgressText(progress, Date.now())));
				} finally {
					clearInterval(heartbeat);
				}
			},

			renderResult(result, options, theme, context) {
				const d = result.details;
				if (context.isError) {
					const text = result.content
						.filter((c) => c.type === "text")
						.map((c) => c.text)
						.join(" ");
					return new Text(theme.fg("error", text || "task failed"), 0, 0);
				}
				if (options.isPartial && d && "progress" in d) {
					// todo #68: reuse the previous component (pi's documented
					// lastComponent pattern — see renderInPlace) so progress
					// updates in place; a fresh Text per update stacks a new
					// line on every onUpdate.
					return renderInPlace(context, theme.fg("muted", d.progress));
				}
				const ret = d as TaskToolReturn;
				// R1/R4: the completion line IS the one-line summary — wall-clock
				// latency, cost, verify status, tier. The audit trail (commits,
				// files, review, conflicts) stays in the content text and the
				// expanded view; the collapsed line remains a single line.
				const summary = completionSummaryLine({
					success: ret.success,
					manifest: ret.metrics,
					durationMs: ret.duration_ms,
					verificationFailures: ret.verification.failures,
				});
				let text = ret.success
					? theme.fg("success", theme.bold(`✓ ${summary}`))
					: theme.fg("error", theme.bold(`✗ ${summary}`));
				if (options.expanded) {
					const extras: string[] = [];
					if (ret.conflicts && ret.conflicts.length > 0) {
						extras.push(`Conflicts: ${ret.conflicts.join(", ")}`);
					}
					if (ret.files_changed.length > 0) {
						extras.push(...ret.files_changed.map((f) => `  ${f}`));
					}
					if (ret.review) {
						extras.push(`Review: ${ret.review.verdict} (${ret.review.findings.length} findings)`);
					}
					if (extras.length > 0) text += "\n" + extras.join("\n");
				}
				return new Text(text, 0, 0);
			},
		});
	};

	/** Re-register the task tool for the current lock state + status bar. */
	const applyBudget = (ctx: { ui: { setStatus(key: string, value: string | undefined): void } }): void => {
		const locked = isLockedBudget(budgetMode, taskConfig.tiers);
		registerTaskTool(locked, taskConfig.tiers);
		if (locked) ctx.ui.setStatus("task", `${budgetMode} (locked)`);
		else ctx.ui.setStatus("task", undefined);
	};

	// The CLI flag value is applied to the runtime only after factories
	// run; session_start is the earliest point it is reliably readable
	// (verified in Phase 9 — see the file header). A stored /task-budget
	// override wins on reload; /new starts from the flag again. Phase 11:
	// the config is re-loaded here so the schema enum reflects the current
	// task.toml (a mid-session edit shows up after /reload).
	pi.on("session_start", (_event, ctx) => {
		taskConfig = loadTaskConfig();
		budgetMode =
			readBudgetOverride(ctx, taskConfig.tiers) ??
			normalizeBudgetMode(pi.getFlag("task-budget"), taskConfig.tiers);
		applyBudget(ctx);
	});

	pi.registerCommand("task-budget", {
		description: "Show or set the task worker budget tier (auto | any tier in task.toml)",
		handler: async (args, ctx) => {
			// Phase 11: refresh the config so the enum/validation reflects a
			// mid-session task.toml edit (documented in the file header).
			taskConfig = loadTaskConfig();
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "") {
				ctx.ui.notify(
					`task budget: ${budgetMode}${isLockedBudget(budgetMode, taskConfig.tiers) ? " (locked)" : ""}`,
					"info",
				);
				return;
			}
			const mode = normalizeBudgetMode(arg, taskConfig.tiers);
			if (mode === "auto" && arg !== "auto") {
				ctx.ui.notify(`Invalid budget tier "${arg}" — use ${budgetModes(taskConfig.tiers).join(" | ")}`, "error");
				return;
			}
			budgetMode = mode;
			pi.appendEntry(BUDGET_ENTRY_TYPE, { budgetMode: mode });
			applyBudget(ctx);
			ctx.ui.notify(`task budget: ${mode}${isLockedBudget(mode, taskConfig.tiers) ? " (locked)" : ""}`, "info");
		},
	});

	pi.registerCommand("task-stats", {
		description:
			"Summarize task runs from the agent-dir metrics — all projects, or one: /task-stats <project>",
		handler: async (args, ctx) => {
			const project = (args ?? "").trim() || undefined;
			const summary = summarizeRuns(METRICS_DIR, project);
			ctx.ui.notify(renderTaskStats(summary), "info");
		},
	});

	// ── Main-session codebase-map injection (hybrid, Phase 9; Phase 10
	//    made the overview path non-blocking) ─────────────────────────
	// Gated by config/repo-map.toml: [injection] main_agent enables the
	// consumer entirely; overview_in_system_prompt additionally gates the
	// always-on system-prompt overview (the codebase_map tool stays).
	// Split so pi stays snappy: before_agent_start only READS the cache (one
	// file read, no LLM) and can never block a prompt; the LLM annotation that
	// refreshes the cache runs fire-and-forget at session_start.
	// repo-map.toml is loaded once at factory time and read-only after; the
	// task config above is refreshed per-session (see the factory header).

	if (mapConfig.mainAgent) {
		pi.registerTool({
			name: "codebase_map",
			label: "Codebase Map",
			description:
				"Return a relevance-sliced view of the cached codebase map for a query: entry points, patterns, " +
				"test layout, and the files most relevant to the query (with summaries and symbols). Use it to " +
				"orient on unfamiliar code before reading files — it is cached, so it is cheap after the first build.",
			promptSnippet: "Get a relevance-sliced codebase map for a query (entry points, patterns, relevant files)",
			parameters: Type.Object({
				query: Type.String({
					description: "What to look up, e.g. 'test layout', 'authentication flow', 'where rendering happens'",
				}),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				try {
					const map = await buildMap(ctx.cwd, {
						mode: mapConfig.mode,
						model: mapConfig.annotationModel,
					});
					const relevant = sliceRelevant(map, params.query, mapConfig.sliceLimit);
					const text = formatMapPrompt(map, relevant);
					return {
						content: [{ type: "text", text }],
						details: { files: relevant.map((f) => f.path) },
					};
				} catch (err) {
					throw new Error(
						`codebase_map unavailable: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			},
		});
	}

	if (mapConfig.mainAgent && mapConfig.overviewInSystemPrompt) {
		pi.on("before_agent_start", (event) => {
			// Fast path — never blocks a prompt. Load the cached map (one file
			// read, no LLM, no build) and inject its overview. The annotation
			// that keeps the cache fresh runs asynchronously at session_start
			// (below). A missing or briefly-stale cache only means an absent /
			// slightly-stale overview; the tree/content hashes self-heal it on
			// the next background refresh.
			const map = loadCachedMap(event.systemPromptOptions.cwd);
			if (!map) return undefined;
			const overview = formatMapOverview(map);
			if (!overview) return undefined;
			return { systemPrompt: event.systemPrompt + "\n\n" + overview };
		});
	}

	// Async map refresh (annotation) — fire-and-forget at session start, only
	// when the main-agent map consumer is enabled. Never blocks a prompt:
	// before_agent_start above only reads the cache. buildMap short-circuits
	// to ZERO LLM calls when the cache is fresh and re-annotates only changed
	// files when stale; the in-flight guard prevents overlapping runs. Set
	// [mode] default = "skeleton" in repo-map.toml to make even this refresh
	// LLM-free.
	/** Ignore a background map-refresh failure (todo #73): buildMap already
	 *  degrades internally to a skeleton map on annotation errors, and the
	 *  remaining throwers are environmental (e.g. not a git repo). The
	 *  refresh is fire-and-forget — a console write would leak into the
	 *  prompt box, and the next refresh retries the build. */
	function ignoreMapRefreshFailure(_err: unknown): void {}
	let mapRefreshInFlight = false;
	if (mapConfig.mainAgent) {
		pi.on("session_start", (_event, ctx) => {
			// Interactive sessions only (TUI/RPC). Headless one-shot runs
			// (-p / --mode json, hasUI=false) skip the refresh: they exit right
			// away (a background annotation could not finish and be written
			// back) and this keeps invisible LLM calls out of scripts/e2e.
			if (!ctx.hasUI) return;
			if (mapRefreshInFlight) return;
			mapRefreshInFlight = true;
			buildMap(ctx.cwd, { mode: mapConfig.mode, model: mapConfig.annotationModel })
				.catch(ignoreMapRefreshFailure)
				.finally(() => {
					mapRefreshInFlight = false;
				});
		});
	}
}
