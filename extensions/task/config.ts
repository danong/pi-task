/**
 * task.toml config loader (Phases 10-11).
 *
 * Loads `<agent-dir>/config/task.toml` — the budget-tier, per-tier wall,
 * per-tool-call budget, and worker-sandbox source of truth that replaces
 * the Phase-9 inline placeholder table (see docs/pi-task-design.md →
 * Budget Tiers / Worker Sandbox). Shape:
 *
 *   [defaults]
 *   budget = "full"            # "auto" or any [budget.*] tier
 *   max_fix_iterations = 2
 *   tool_timeout_ms = 900000   # per-tool-call budget (15 min default)
 *
 *   [budget.full]              # prewalk_model / execute_model /
 *   ...                        # review_model / review / wall_timeout_ms
 *
 *   [sandbox]
 *   enabled = true             # worker bwrap sandbox: enabled /
 *   network = "allow"          # network / extra_ro_binds /
 *   extra_ro_binds = []        # extra_rw_binds (the orchestrator
 *   extra_rw_binds = []        # consumes these in a later phase)
 *
 * Budget tiers are CONFIG-DRIVEN (Phase 11, todo #81): every [budget.*]
 * table in the file is a usable tier, in file order — the hardcoded
 * built-in table (DEFAULT_BUDGET_TIERS) is only the fallback for a
 * missing/invalid file. A file with no [budget.*] sections at all (e.g.
 * [defaults]- or [sandbox]-only) falls back to the built-in tier set.
 *
 * Validation policy (planning decision 4a): never throw. A missing file
 * degrades silently to built-in defaults; an explicitly invalid value
 * warns once and falls back per field. There is no runtime model
 * availability probing — model failures surface as task-tool errors.
 *
 * Loader pattern cribbed from loadRepoMapConfig (repo-map.ts): TOML via
 * python3 tomllib (zero JS deps), same agent-dir-relative path
 * resolution (works in the dev workspace and the installed layout).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ─── Budget vocabulary ────────────────────────────────────────────────

/** Any [budget.*] tier name from task.toml is a valid tier — the
 *  vocabulary is config-driven (Phase 11); the built-ins below are only
 *  the missing-file fallback and the names the auto heuristic recognizes. */
export type BudgetTier = string;

/** Built-in tier names, in order — the fallback tier set for a missing
 *  config file (and DEFAULT_TASK_CONFIG's tierOrder). */
export const BUDGET_TIERS = ["max", "full", "economy", "free"] as const;

/** A budget MODE: "auto" or any loaded tier name. (Collapses to string —
 *  the dynamic tier vocabulary is the point.) */
export type BudgetMode = "auto" | BudgetTier;

/** Ordered tier names of a tier table — file order for loaded configs,
 *  built-in order for the defaults. */
export function tierNames(tiers: Record<BudgetTier, BudgetTierConfig>): string[] {
	return Object.keys(tiers);
}

/** The tier named `name` when present in `tiers`; undefined otherwise. */
export function findTier(
	tiers: Record<BudgetTier, BudgetTierConfig>,
	name: unknown,
): BudgetTier | undefined {
	return typeof name === "string" && name in tiers ? name : undefined;
}

/**
 * The mode vocabulary: "auto" first, then the tiers in file order
 * (Phase 11 — replaces the hardcoded BUDGET_MODES list in the schema
 * enum, the --task-budget flag choices, and the /task-budget command).
 */
export function budgetModes(tiers: Record<BudgetTier, BudgetTierConfig>): string[] {
	return ["auto", ...tierNames(tiers)];
}

/**
 * A valid default budget mode for a tier set: DEFAULT_BUDGET_TIER when
 * present (the shipped `[defaults] budget = "full"` shape), else the
 * first loaded tier (file order) — resolution always yields a usable tier.
 */
export function defaultBudgetFor(tiers: Record<BudgetTier, BudgetTierConfig>): BudgetMode {
	return DEFAULT_BUDGET_TIER in tiers ? DEFAULT_BUDGET_TIER : (tierNames(tiers)[0] ?? DEFAULT_BUDGET_TIER);
}

export interface BudgetTierConfig {
	/** Strong exploration model; null = no prewalk (start on execute model). */
	prewalkModel: string | null;
	executeModel: string;
	reviewModel: string;
	/** Enable the forked adversarial review + bounded fix loop. */
	review: boolean;
	/** The run-pipeline SHAPE (a [shapes.*] section): the phase structure,
	 *  swap policy, model slots, and review axes. Default: "code" (the
	 *  prewalk→swap→work→review pipeline; see DEFAULT_TASK_SHAPES). */
	shape: string;
	/**
	 * Per-tier worker wall-clock budget (ms, Phase 11). Default when the
	 * tier omits wall_timeout_ms: {@link DEFAULT_TIER_WALL_TIMEOUT_MS}
	 * (45 min). The task tool passes the resolved tier's wall to the
	 * orchestrator (ExecuteTaskOptions.workerTimeoutMs →
	 * WorkerOptions.timeoutMs).
	 */
	wallTimeoutMs: number;
}

// ─── Run pipeline SHAPES (the task's shape) ─────────────────────────

/**
 * A run pipeline shape: the phase structure, swap policy, model slots,
 * and review axes — separated from the budget tier so tasks fit the type
 * of work (a survey is an ANALYSIS task: strong model in the writer slot,
 * no prewalk swap) and the same spec can be benchmarked across shapes
 * (prewalk on/off, swap on/off) with everything recorded in the manifest.
 */
/** The model channel a run uses: sync (interactive, fast), flex
 *  (synchronous endpoint, 1-15 min per call, ~50% off), or batch
 *  (async job lane — typed single-turn prompts, ~24h, ~50% off). The
 *  channel calibrates the interactive watchdogs (flex needs longer
 *  first-event/no-progress windows) and selects the execution path
 *  (batch runs as a job, not a session). */
export type RunChannel = "sync" | "flex" | "batch";

export interface TaskShape {
	/** The model channel (default "sync"). */
	channel: RunChannel;
	/** Run the prewalk phase on the tier's prewalk model (auto-skipped when
	 *  the model is null/equal — the existing auto-skip rule). */
	prewalk: boolean;
	/** Swap to the work model on the first successful edit (prewalk only). */
	swap: boolean;
	/** Model slot for the WORK phase: "execute" (the tier's execute model)
	 *  or "prewalk" (promote the strong prewalk model — analysis tasks). */
	workModel: "execute" | "prewalk";
	/** Model slot for the REVIEW phase: "review" (the tier's review model)
	 *  or "prewalk" (promote the strong prewalk model — strong review). */
	reviewModel: "review" | "prewalk";
	/** Review axes (persona names); [] = no review. ANDed with the tier's
	 *  review flag (economy/free keep review off). */
	review: string[];
}

export const DEFAULT_TASK_SHAPES: Record<string, TaskShape> = {
	/** The default pipeline: strong prewalk plans, swap to the fast execute
	 *  model on the first edit, the default review axes (standards +
	 *  spec-fidelity + architecture) on the tier's review model. */
	code: {
		channel: "sync",
		prewalk: true,
		swap: true,
		workModel: "execute",
		reviewModel: "review",
		review: ["standards", "spec-fidelity", "architecture"],
	},
	/** Analysis tasks (surveys, design reviews): the STRONG model writes
	 *  (the prewalk model is promoted to the work slot — no swap), and the
	 *  strong model reviews too. Review axes are supplied per dispatch
	 *  (e.g. /survey passes review: "survey-reviewer"). */
	analysis: {
		channel: "sync",
		prewalk: false,
		swap: false,
		workModel: "prewalk",
		reviewModel: "prewalk",
		review: [],
	},
	/** Batch lane (M2): the run is an ASYNC batch job, not an interactive
	 *  session — one typed single-turn prompt per requirement on the [batch]
	 *  model (config/task.toml), outputs validated against their contracts
	 *  and applied as files, no tool loop, no review (batch.ts runBatchLane).
	 *  The batch channel also unbinds the interactive watchdogs
	 *  (channelWatchdogWindows) — job polling replaces the watchers. */
	batch: {
		channel: "batch",
		prewalk: false,
		swap: false,
		workModel: "execute",
		reviewModel: "review",
		review: [],
	},
};

/** Interactive watchdog windows for a channel (flex: synchronous
 *  endpoints take 1-15 min per model call, so the first-event and
 *  no-progress watchdogs must not false-fire; batch has no interactive
 *  session — its run is a job, not a watcher). Pure — tested. */
export function channelWatchdogWindows(channel: RunChannel): {
	firstEventMs: number;
	noProgressMs: number;
} {
	switch (channel) {
		case "flex":
			return { firstEventMs: 25 * 60_000, noProgressMs: 20 * 60_000 };
		case "batch":
			return { firstEventMs: Number.MAX_SAFE_INTEGER, noProgressMs: Number.MAX_SAFE_INTEGER };
		default:
			return { firstEventMs: 3 * 60_000, noProgressMs: 10 * 60_000 };
	}
}

/** Resolve a shape by name: the loaded set, else the built-ins, else the
 *  code shape. Never throws — a bad name degrades to the default. */
export function resolveTaskShape(shapeName: string | undefined, shapes: Record<string, TaskShape>): TaskShape {
	const name = shapeName ?? "code";
	return shapes[name] ?? DEFAULT_TASK_SHAPES[name] ?? DEFAULT_TASK_SHAPES.code;
}

/**
 * Per-tier worker wall when a [budget.*] tier omits wall_timeout_ms
 * (45 min). Mirrors WORKER_WALL_TIMEOUT_MS in worker.ts.
 */
export const DEFAULT_TIER_WALL_TIMEOUT_MS = 45 * 60_000;

/**
 * Built-in tier table — the fallback for a missing/invalid task.toml and
 * the per-key fallback within a partial one. Mirrors the shipped
 * `[budget.max/full/economy/free]`: max = strongest model everywhere;
 * full = strong prewalk + fast execute/review; economy = fast
 * throughout, no review; free = fastest models, no review. Economy
 * matches the max/full 45-min wall — a big build under fast models
 * needs the headroom (a 25-min wall aborted real suites mid-run); free
 * carries a shorter 30-min wall (the cheapest tier, never auto-picked).
 *
 * `prewalkModel: null` is the canonical "no prewalk" shape. The design's
 * economy/free tiers set prewalk_model == execute_model; the loader
 * normalizes that equality to null (the orchestrator's auto-skip rule
 * makes the two forms behaviorally identical).
 */
export const DEFAULT_BUDGET_TIERS: Record<BudgetTier, BudgetTierConfig> = {
	max: {
		prewalkModel: null,
		executeModel: "qwen-token-plan/qwen3.8-max-preview",
		reviewModel: "qwen-token-plan/qwen3.8-max-preview",
		review: true,
		shape: "code",
		wallTimeoutMs: 45 * 60_000,
	},
	full: {
		prewalkModel: "qwen-token-plan/qwen3.8-max-preview",
		executeModel: "opencode-go/deepseek-v4-flash",
		reviewModel: "opencode-go/deepseek-v4-flash",
		review: true,
		shape: "code",
		wallTimeoutMs: 45 * 60_000,
	},
	economy: {
		prewalkModel: null,
		executeModel: "opencode-go/deepseek-v4-flash",
		reviewModel: "opencode-go/deepseek-v4-flash",
		review: false,
		shape: "code",
		wallTimeoutMs: 45 * 60_000,
	},
	free: {
		prewalkModel: null,
		executeModel: "opencode/deepseek-v4-flash-free",
		reviewModel: "opencode/deepseek-v4-flash-free",
		review: false,
		shape: "code",
		wallTimeoutMs: 30 * 60_000,
	},
};

/** Default tier for auto/unset — the design doc's `[defaults] budget = "full"`. */
export const DEFAULT_BUDGET_TIER: BudgetTier = "full";

// ─── Batch lane (M2) ───────────────────────────────────────────────

/**
 * Default batch-lane model id — OpenRouter's async batch lane (`:batch`
 * suffix, ~50% off list price, up to ~24h turnaround). The orchestrator's
 * batch channel (TaskShape.channel === "batch") submits the run's typed
 * single-turn prompts to this model and polls the job to completion
 * (extensions/task/batch.ts).
 */
export const DEFAULT_BATCH_MODEL = "google/gemini-3.7-flash:batch";

/** Default poll interval while a batch job is in flight (30s). */
export const DEFAULT_BATCH_POLL_INTERVAL_MS = 30_000;

/** Default wall budget for polling one batch job to a terminal state
 *  (24h — the batch lane's advertised turnaround). The job itself keeps
 *  running provider-side on timeout; the job-state file records the
 *  job id so polling can resume (typed, recoverable failure). */
export const DEFAULT_BATCH_JOB_TIMEOUT_MS = 24 * 60 * 60_000;

/**
 * Batch-lane configuration ([batch] section in task.toml). The channel
 * wiring lives on the shape (TaskShape.channel === "batch"); this table
 * supplies the model id + polling budgets the lane runs with.
 */
export interface BatchLaneConfig {
	/** Batch model id (OpenRouter `:batch` model). */
	model: string;
	/** Poll interval (ms) while the job is in flight. */
	pollIntervalMs: number;
	/** Wall budget (ms) for polling the job to a terminal state. */
	jobTimeoutMs: number;
}

export const DEFAULT_BATCH_CONFIG: BatchLaneConfig = {
	model: DEFAULT_BATCH_MODEL,
	pollIntervalMs: DEFAULT_BATCH_POLL_INTERVAL_MS,
	jobTimeoutMs: DEFAULT_BATCH_JOB_TIMEOUT_MS,
};

// ─── Scheduled jobs ([jobs.*], M4) ──────────────────────────────────
// A scheduled job: the standalone pi-task-scheduler dispatches it when
// due (every_ms elapsed since the last run), on the job's channel
// (flex = a detached run; batch = a batch job). No default jobs ship —
// the shipped config documents the format with a commented example.

export interface JobConfig {
	/** Description shown in the scheduler's plan/dry-run. */
	description: string;
	/** Channel the job runs on: "flex" | "batch" | "sync". */
	channel: string;
	/** Budget tier name (e.g. "economy") and run shape (e.g. "analysis"). */
	tier: string;
	shape: string;
	/** The task spec: inline markdown, or "file:<path>" to read it at
	 *  dispatch time. */
	spec: string;
	/** Dispatch interval (ms). */
	everyMs: number;
}

export const DEFAULT_JOBS: Record<string, JobConfig> = {};

/** Load [jobs.<name>] sections. A missing [jobs.*] → empty; a job
 *  without a spec or interval warns and is skipped. */
export function loadJobs(sections: TomlSections): Record<string, JobConfig> {
	const out: Record<string, JobConfig> = {};
	const parent = sections["jobs"];
	if (parent === undefined || typeof parent !== "object" || parent !== null) return out;
	for (const key of Object.keys(parent)) {
		const section = subTable(sections, "jobs", key);
		if (!section) continue;
		const label = `[jobs.${key}]`;
		const spec = str(section, "spec") ?? "";
		const everyRaw = int(section, "every_ms");
		if (spec.length === 0 || everyRaw === undefined || everyRaw <= 0) {
			warn(`${label} requires a spec and every_ms > 0 — skipping`);
			continue;
		}
		out[key] = {
			description: str(section, "description") ?? key,
			channel: str(section, "channel") ?? "flex",
			tier: str(section, "tier") ?? DEFAULT_BUDGET_TIER,
			shape: str(section, "shape") ?? "code",
			spec,
			everyMs: everyRaw,
		};
	}
	return out;
}

// ─── AI commit identity (todo #84) ───────────────────────────────────

/**
 * Replace the "{model}" placeholder in an ai_author_name template with the
 * model's short name (the part after the last "/"). Pure — tested.
 */
export function formatAiAuthorName(template: string, model: string): string {
	return template.replace("{model}", model.split("/").pop() ?? model);
}

/**
 * The jj config TOML a worker spawn needs so its commits are authored as
 * the AI identity — jj reads it via the JJ_CONFIG env var (verified:
 * JJ_CONFIG replaces the user config, author AND committer both follow
 * it). Pure — tested.
 */
export function aiIdentityToml(name: string, email: string): string {
	return `user.name = "${name}"\nuser.email = "${email}"\n`;
}

// ─── Sandbox vocabulary ───────────────────────────────────────────────

export const SANDBOX_NETWORK_MODES = ["allow", "isolate"] as const;
export type SandboxNetworkMode = (typeof SANDBOX_NETWORK_MODES)[number];

/**
 * Worker sandbox policy (docs/pi-task-design.md → Worker Sandbox).
 * Config vocabulary only in this phase — the orchestrator consumes it
 * when worker bwrap sandboxing lands; nothing reads it yet, so changing
 * these values has no runtime effect.
 */
export interface SandboxConfig {
	/** Run workers inside a bwrap sandbox (false = plain spawn). */
	enabled: boolean;
	/** "allow" = host network; "isolate" = --unshare-net. */
	network: SandboxNetworkMode;
	/** Additional read-only bind paths beyond the default allowlist. */
	extraRoBinds: string[];
	/** Additional read-write bind paths beyond the default allowlist. */
	extraRwBinds: string[];
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
	enabled: true,
	network: "allow",
	extraRoBinds: [],
	extraRwBinds: [],
};

// ─── TaskConfig ───────────────────────────────────────────────────────

/**
 * Default per-tool-call budget for a single worker tool execution
 * (15 min, Phase 11 — [defaults] tool_timeout_ms). Mirrors
 * WORKER_TOOL_TIMEOUT_MS in worker.ts.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 15 * 60_000;

/**
 * Default per-command budget for a spec's verification commands + the
 * worker wall-clock grace granted when the wall expires mid-verification
 * ([defaults] verification_timeout_ms). Mirrors the tool-call budget: a
 * verification suite gets the same bound as any other tool.
 */
export const DEFAULT_VERIFICATION_TIMEOUT_MS = DEFAULT_TOOL_TIMEOUT_MS;

export interface TaskConfig {
	defaults: {
		/** Effective budget mode when neither flag nor param locks a tier.
		 *  "auto" makes the requirement-count heuristic the everyday default. */
		budget: BudgetMode;
		/** Max fix workers the review-fix loop may dispatch. */
		maxFixIterations: number;
		/** Per-tool-call budget for a single worker tool execution (ms,
		 * Phase 11). Default: {@link DEFAULT_TOOL_TIMEOUT_MS} (15 min). */
		toolTimeoutMs: number;
		/** Per-command budget for verification + the wall-clock grace cap
		 * when the wall expires mid-verification (ms). Default:
		 * {@link DEFAULT_VERIFICATION_TIMEOUT_MS} (15 min). */
		verificationTimeoutMs: number;
		/**
		 * AI commit identity (todo #84): task-worker commits are authored as
		 * aiAuthorName / aiAuthorEmail — jj reads them via the JJ_CONFIG env
		 * var in the worker spawn. "{model}" in the name is replaced with the
		 * execute model's short name (see {@link formatAiAuthorName}). The
		 * user's own jj/git commits are unaffected (the override is worker-
		 * scoped only).
		 */
		aiAuthorName: string;
		aiAuthorEmail: string;
	};
	/** Budget tiers keyed by name; order is `tierOrder` (the record's own
	 *  key order is unreliable for integer-like tier names). */
	tiers: Record<BudgetTier, BudgetTierConfig>;
	/**
	 * Tier names in FILE order (built-in order for the missing-file
	 * defaults) — the authoritative order for the schema enum and the
	 * auto-heuristic preference. `Object.keys` would silently reorder
	 * integer-like tier names, so the loader records the order explicitly.
	 */
	tierOrder: string[];
	/** Run-pipeline shapes ([shapes.*]): the phase structure, swap policy,
	 *  model slots, and review axes — separated from the model tiers. */
	shapes: Record<string, TaskShape>;
	/** Batch lane ([batch]): the async job channel's model id + polling
	 *  budgets (M2 — consumed when a shape's channel is "batch"). */
	batch: BatchLaneConfig;
	/** Scheduled jobs ([jobs.*]) for the standalone scheduler. */
	jobs: Record<string, JobConfig>;
	sandbox: SandboxConfig;
}

export const DEFAULT_TASK_CONFIG: TaskConfig = {
	defaults: {
		budget: DEFAULT_BUDGET_TIER,
		maxFixIterations: 2,
		toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
		verificationTimeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS,
		aiAuthorName: "Pi ({model})",
		aiAuthorEmail: "noreply@danong.dev",
	},
	tiers: DEFAULT_BUDGET_TIERS,
	tierOrder: [...BUDGET_TIERS],
	shapes: DEFAULT_TASK_SHAPES,
	batch: DEFAULT_BATCH_CONFIG,
	jobs: DEFAULT_JOBS,
	sandbox: DEFAULT_SANDBOX_CONFIG,
};

// ─── Loader ───────────────────────────────────────────────────────────

type TomlValue = string | boolean | number | TomlValue[];
/** A flat TOML table of scalars/arrays (e.g. [defaults], [budget.full]). */
type TomlTable = Record<string, TomlValue>;
/** Parsed TOML: sections may hold scalars or nested tables ([budget.full]
 *  parses as { budget: { full: {...} } }). */
type TomlSections = Record<string, TomlValue | Record<string, TomlValue | TomlTable>>;

const TOML_TO_JSON_SCRIPT =
	"import tomllib, json, sys; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb'))))";

function parseTomlFile(path: string): TomlSections {
	const out = execFileSync("python3", ["-c", TOML_TO_JSON_SCRIPT, path], {
		encoding: "utf8",
		maxBuffer: 1 << 20,
		// stderr piped (not inherited): a malformed file throws, and the
		// python traceback is replaced by our own one-line warning.
		stdio: ["ignore", "pipe", "pipe"],
	});
	return JSON.parse(out);
}

/** Coerce a parsed section to a flat scalar/array table (undefined otherwise). */
function asTable(value: TomlSections[string] | undefined): TomlTable | undefined {
	if (value === undefined || typeof value !== "object" || value === null) return undefined;
	const out: TomlTable = {};
	for (const [k, v] of Object.entries(value)) {
		if (typeof v === "string" || typeof v === "boolean" || typeof v === "number" || Array.isArray(v)) {
			out[k] = v;
		}
	}
	return out;
}

/** Nested table lookup: sections[section][key] as a flat scalar table. */
function subTable(sections: TomlSections, section: string, key: string): TomlTable | undefined {
	const parent = sections[section];
	if (parent === undefined || typeof parent !== "object" || parent === null) return undefined;
	const child = (parent as Record<string, TomlValue | TomlTable>)[key];
	if (child === undefined || typeof child !== "object" || child === null) return undefined;
	return child as TomlTable;
}

function str(section: TomlTable | undefined, key: string): string | undefined {
	const v = section?.[key];
	return typeof v === "string" ? v : undefined;
}
function bool(section: TomlTable | undefined, key: string): boolean | undefined {
	const v = section?.[key];
	return typeof v === "boolean" ? v : undefined;
}
function int(section: TomlTable | undefined, key: string): number | undefined {
	const v = section?.[key];
	return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}
/** Array of strings; a present-but-invalid value warns and yields [] (the
 *  per-field default) rather than partially loading. */
function strArray(section: TomlTable | undefined, key: string, label: string): string[] {
	const v = section?.[key];
	if (v === undefined) return [];
	if (!Array.isArray(v) || v.some((item) => typeof item !== "string")) {
		warn(`${label} ${key} must be an array of strings — using []`);
		return [];
	}
	return [...v] as string[];
}

function warn(message: string): void {
	console.warn(`task.toml: ${message}`);
}

function loadTier(sections: TomlSections, tier: BudgetTier): BudgetTierConfig | undefined {
	const section = subTable(sections, "budget", tier);
	if (section === undefined) return undefined;
	// Per-key fallback: the built-in config for a tier of the same name, or
	// the DEFAULT tier's built-in config for a custom tier (Phase 11 — any
	// [budget.*] section is a usable tier, so custom tiers fall back to the
	// default tier's template).
	const fallback = DEFAULT_BUDGET_TIERS[tier] ?? DEFAULT_BUDGET_TIERS[DEFAULT_BUDGET_TIER];
	const label = `[budget.${tier}]`;
	const model = (key: string, fallbackValue: string): string => {
		const raw = str(section, key);
		if (raw === undefined) return fallbackValue; // absent → fallback silently
		const value = raw.trim();
		if (value.length === 0) {
			warn(`${label} ${key} is empty — using ${fallbackValue}`);
			return fallbackValue;
		}
		return value;
	};
	const executeModel = model("execute_model", fallback.executeModel);
	// prewalk_model == execute_model normalizes to null — BudgetTierConfig's
	// "no prewalk" shape; the orchestrator's auto-skip treats equal models
	// the same way.
	let prewalkModel: string | null;
	const prewalkRaw = str(section, "prewalk_model");
	if (prewalkRaw === undefined) {
		prewalkModel = fallback.prewalkModel;
	} else {
		const value = prewalkRaw.trim();
		if (value.length === 0) {
			warn(`${label} prewalk_model is empty — using ${fallback.prewalkModel ?? "no prewalk"}`);
			prewalkModel = fallback.prewalkModel;
		} else {
			prewalkModel = value === executeModel ? null : value;
		}
	}
	// wall_timeout_ms: positive integer ms; absent → the tier's built-in
	// wall (45 min for custom tiers); invalid → warn + fallback.
	const wallPresent = section?.["wall_timeout_ms"] !== undefined;
	const wallRaw = int(section, "wall_timeout_ms");
	let wallTimeoutMs = fallback.wallTimeoutMs;
	if (wallPresent && (wallRaw === undefined || wallRaw <= 0)) {
		warn(`${label} wall_timeout_ms must be a positive integer (ms) — using ${wallTimeoutMs}`);
	} else if (wallRaw !== undefined) {
		wallTimeoutMs = wallRaw;
	}
	// shape: the run-pipeline shape name (a [shapes.*] section); absent →
	// the fallback tier's; empty → warn + fallback.
	const shapeRaw = str(section, "shape");
	let shape = fallback.shape ?? "code";
	if (shapeRaw !== undefined) {
		const value = shapeRaw.trim();
		if (value.length === 0) {
			warn(`${label} shape is empty — using ${shape}`);
		} else {
			shape = value;
		}
	}
	return {
		prewalkModel,
		executeModel,
		reviewModel: model("review_model", fallback.reviewModel),
		review: bool(section, "review") ?? fallback.review,
		shape,
		wallTimeoutMs,
	};
}

/**
 * Load one [shapes.<name>] run-pipeline shape with per-field
 * warn-and-fallback to the built-in shape of the same name, else the
 * code shape. A missing table degrades silently to undefined (no shape).
 */
function loadShape(sections: TomlSections, name: string): TaskShape | undefined {
	const section = subTable(sections, "shapes", name);
	if (section === undefined) return undefined;
	const fallback = DEFAULT_TASK_SHAPES[name] ?? DEFAULT_TASK_SHAPES.code;
	const label = `[shapes.${name}]`;
	const b = (key: string, fallbackValue: boolean): boolean => {
		const raw = bool(section, key);
		if (raw === undefined) return fallbackValue;
		return raw;
	};
	const slot = (key: string, fallbackValue: "execute" | "prewalk"): "execute" | "prewalk" => {
		const raw = str(section, key);
		if (raw === "execute" || raw === "prewalk") return raw;
		if (raw !== undefined) warn(`${label} ${key} must be "execute" | "prewalk" — using ${fallbackValue}`);
		return fallbackValue;
	};
	// The REVIEW slot's full vocabulary includes "review" (the tier's review
	// model — the code shape's default): the shipped [shapes.code] section
	// declares it explicitly, so it must parse without a warning.
	const reviewSlot = (key: string, fallbackValue: "review" | "prewalk"): "review" | "prewalk" => {
		const raw = str(section, key);
		if (raw === "review" || raw === "prewalk") return raw;
		if (raw !== undefined) warn(`${label} ${key} must be "review" | "prewalk" — using ${fallbackValue}`);
		return fallbackValue;
	};
	const channelRaw = str(section, "channel");
	let channel: RunChannel = fallback.channel;
	if (channelRaw === "sync" || channelRaw === "flex" || channelRaw === "batch") {
		channel = channelRaw;
	} else if (channelRaw !== undefined) {
		warn(`${label} channel must be "sync" | "flex" | "batch" — using ${channel}`);
	}
	return {
		channel,
		prewalk: b("prewalk", fallback.prewalk),
		swap: b("swap", fallback.swap),
		workModel: slot("work_model", fallback.workModel),
		reviewModel: reviewSlot("review_model", fallback.reviewModel),
		review: strArray(section, "review", label).length > 0 || section?.["review"] !== undefined
			? strArray(section, "review", label)
			: fallback.review,
	};
}

/**
 * Load the [sandbox] table with per-field warn-and-fallback. A missing
 * table degrades silently to DEFAULT_SANDBOX_CONFIG.
 */
function loadSandbox(sections: TomlSections): SandboxConfig {
	const section = asTable(sections["sandbox"]);
	const fallback = DEFAULT_SANDBOX_CONFIG;
	const label = "[sandbox]";

	// enabled: boolean; present-but-wrong-type → warn + true.
	const enabledPresent = section?.["enabled"] !== undefined;
	const enabledRaw = bool(section, "enabled");
	let enabled = fallback.enabled;
	if (enabledPresent && enabledRaw === undefined) {
		warn(`${label} enabled must be a boolean — using true`);
	} else if (enabledRaw !== undefined) {
		enabled = enabledRaw;
	}

	// network: "allow" | "isolate"; invalid → warn + "allow".
	const networkRaw = str(section, "network");
	let network: SandboxNetworkMode = fallback.network;
	if (networkRaw !== undefined && !(SANDBOX_NETWORK_MODES as readonly string[]).includes(networkRaw)) {
		warn(`${label} network "${networkRaw}" is not one of ${SANDBOX_NETWORK_MODES.join(" | ")} — using "allow"`);
	} else if (networkRaw !== undefined) {
		network = networkRaw as SandboxNetworkMode;
	}

	return {
		enabled,
		network,
		extraRoBinds: strArray(section, "extra_ro_binds", label),
		extraRwBinds: strArray(section, "extra_rw_binds", label),
	};
}

/**
 * Load the [batch] table (M2) with per-field warn-and-fallback. A missing
 * table degrades silently to DEFAULT_BATCH_CONFIG.
 */
function loadBatch(sections: TomlSections): BatchLaneConfig {
	const section = asTable(sections["batch"]);
	const fallback = DEFAULT_BATCH_CONFIG;
	const label = "[batch]";

	// model: non-empty string; present-but-invalid → warn + fallback.
	const modelPresent = section?.["model"] !== undefined;
	const modelRaw = str(section, "model");
	let model = fallback.model;
	if (modelPresent && (modelRaw === undefined || modelRaw.trim().length === 0)) {
		warn(`${label} model must be a non-empty string — using ${fallback.model}`);
	} else if (modelRaw !== undefined) {
		model = modelRaw.trim();
	}

	// poll_interval_ms / job_timeout_ms: positive integer ms; invalid →
	// warn + fallback (same policy as [defaults] tool_timeout_ms).
	const ms = (key: string, fallbackValue: number): number => {
		const present = section?.[key] !== undefined;
		const raw = int(section, key);
		if (present && (raw === undefined || raw <= 0)) {
			warn(`${label} ${key} must be a positive integer (ms) — using ${fallbackValue}`);
			return fallbackValue;
		}
		return raw ?? fallbackValue;
	};

	return {
		model,
		pollIntervalMs: ms("poll_interval_ms", fallback.pollIntervalMs),
		jobTimeoutMs: ms("job_timeout_ms", fallback.jobTimeoutMs),
	};
}

/**
 * Load task.toml. Optional path overrides the code-relative default
 * (`<agent-dir>/config/task.toml`). Never throws: a missing file returns
 * DEFAULT_TASK_CONFIG silently; invalid values warn and fall back per
 * field (planning decision 4a).
 *
 * Budget tiers are discovered DYNAMICALLY (Phase 11, todo #81): every
 * [budget.*] section in the file is a usable tier, in file order (python
 * tomllib preserves TOML table order; the explicit tierOrder list keeps
 * that order authoritative even for integer-like tier names). A file with
 * NO [budget.*] sections falls back to the built-in tier set (the
 * missing-file defaults), so [defaults]-/[[sandbox]]-only configs stay
 * usable. The "unknown tier section" warning is gone by construction —
 * there are no unknown tiers, only configured ones.
 */
export function loadTaskConfig(configPath?: string): TaskConfig {
	const path = configPath ?? join(getAgentDir(), "config", "task.toml");
	let sections: TomlSections = {};
	try {
		// Check existence first so a missing config degrades to defaults
		// silently (no python traceback for a normal missing file).
		if (existsSync(path)) {
			sections = parseTomlFile(path);
		} else {
			return structuredClone(DEFAULT_TASK_CONFIG);
		}
	} catch (err) {
		warn(`unreadable/invalid TOML at ${path} — using built-in defaults (${(err as Error).message})`);
		return structuredClone(DEFAULT_TASK_CONFIG);
	}

	// [budget.*] tiers: every section is a usable tier, in file order.
	const tiers: Record<BudgetTier, BudgetTierConfig> = {};
	const tierOrder: string[] = [];
	const budgetParent = sections["budget"];
	if (budgetParent !== undefined && typeof budgetParent === "object" && budgetParent !== null) {
		for (const key of Object.keys(budgetParent)) {
			const loaded = loadTier(sections, key);
			if (loaded !== undefined) {
				tiers[key] = loaded;
				tierOrder.push(key);
			}
		}
	}
	// No [budget.*] sections at all → the built-in tier set (silently — the
	// same "no tier configuration" semantics as a missing file).
	if (tierOrder.length === 0) {
		for (const tier of BUDGET_TIERS) {
			tiers[tier] = DEFAULT_BUDGET_TIERS[tier];
			tierOrder.push(tier);
		}
	}

	// [shapes.*] run-pipeline shapes: every section is a usable shape (the
	// tier's shape + the task tool's shape param reference these). Missing
	// [shapes.*] → the built-in set.
	const shapes: Record<string, TaskShape> = {};
	const shapesParent = sections["shapes"];
	if (shapesParent !== undefined && typeof shapesParent === "object" && shapesParent !== null) {
		for (const key of Object.keys(shapesParent)) {
			const loaded = loadShape(sections, key);
			if (loaded !== undefined) shapes[key] = loaded;
		}
	}
	if (Object.keys(shapes).length === 0) {
		Object.assign(shapes, structuredClone(DEFAULT_TASK_SHAPES));
	}

	// [defaults] budget: "auto" or any loaded tier; invalid → warn + the
	// default tier (DEFAULT_BUDGET_TIER when present, else the first loaded
	// tier) so resolution always yields a usable tier.
	const defaults = asTable(sections["defaults"]);
	const budgetRaw = str(defaults, "budget");
	let budget: BudgetMode = defaultBudgetFor(tiers);
	if (budgetRaw !== undefined && budgetRaw !== "auto" && !(budgetRaw in tiers)) {
		warn(`[defaults] budget "${budgetRaw}" is not one of ${budgetModes(tiers).join(" | ")} — using "${budget}"`);
	} else if (budgetRaw !== undefined) {
		budget = budgetRaw;
	}

	// [defaults] max_fix_iterations: integer >= 0; invalid → warn + 2.
	const iterPresent = defaults?.["max_fix_iterations"] !== undefined;
	const iterRaw = int(defaults, "max_fix_iterations");
	let maxFixIterations = DEFAULT_TASK_CONFIG.defaults.maxFixIterations;
	if (iterPresent && (iterRaw === undefined || iterRaw < 0)) {
		warn(`[defaults] max_fix_iterations must be an integer >= 0 — using 2`);
	} else if (iterRaw !== undefined) {
		maxFixIterations = iterRaw;
	}

	// [defaults] tool_timeout_ms: positive integer ms; invalid → warn + the
	// built-in 15-min default (Phase 11).
	const toolPresent = defaults?.["tool_timeout_ms"] !== undefined;
	const toolRaw = int(defaults, "tool_timeout_ms");
	let toolTimeoutMs = DEFAULT_TASK_CONFIG.defaults.toolTimeoutMs;
	if (toolPresent && (toolRaw === undefined || toolRaw <= 0)) {
		warn(`[defaults] tool_timeout_ms must be a positive integer (ms) — using ${toolTimeoutMs}`);
	} else if (toolRaw !== undefined) {
		toolTimeoutMs = toolRaw;
	}

	// [defaults] verification_timeout_ms: positive integer ms; invalid →
	// warn + the built-in 15-min default (mirrors tool_timeout_ms).
	const verifyPresent = defaults?.["verification_timeout_ms"] !== undefined;
	const verifyRaw = int(defaults, "verification_timeout_ms");
	let verificationTimeoutMs = DEFAULT_TASK_CONFIG.defaults.verificationTimeoutMs;
	if (verifyPresent && (verifyRaw === undefined || verifyRaw <= 0)) {
		warn(`[defaults] verification_timeout_ms must be a positive integer (ms) — using ${verificationTimeoutMs}`);
	} else if (verifyRaw !== undefined) {
		verificationTimeoutMs = verifyRaw;
	}

	// [defaults] ai_author_name / ai_author_email: the AI commit identity
	// (todo #84). Strings; an explicitly invalid value warns + falls back
	// to the built-in default, per the warn-and-fallback policy.
	const namePresent = defaults?.["ai_author_name"] !== undefined;
	const nameRaw = str(defaults, "ai_author_name");
	let aiAuthorName = DEFAULT_TASK_CONFIG.defaults.aiAuthorName;
	if (namePresent && nameRaw === undefined) {
		warn(`[defaults] ai_author_name must be a string — using "${aiAuthorName}"`);
	} else if (nameRaw !== undefined) {
		aiAuthorName = nameRaw;
	}
	const emailPresent = defaults?.["ai_author_email"] !== undefined;
	const emailRaw = str(defaults, "ai_author_email");
	let aiAuthorEmail = DEFAULT_TASK_CONFIG.defaults.aiAuthorEmail;
	if (emailPresent && emailRaw === undefined) {
		warn(`[defaults] ai_author_email must be a string — using "${aiAuthorEmail}"`);
	} else if (emailRaw !== undefined) {
		aiAuthorEmail = emailRaw;
	}

	// [batch]: the batch lane's model id + polling budgets (M2); missing
	// table → silent defaults.
	const batch = loadBatch(sections);

	// [sandbox]: worker sandbox policy; missing table → silent defaults.
	const sandbox = loadSandbox(sections);

	return {
		defaults: {
			budget,
			maxFixIterations,
			toolTimeoutMs,
			verificationTimeoutMs,
			aiAuthorName,
			aiAuthorEmail,
		},
		tiers,
		tierOrder,
		shapes,
		batch,
		jobs: loadJobs(sections),
		sandbox,
	};
}
