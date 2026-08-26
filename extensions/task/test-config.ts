/**
 * config.ts hermetic tests — the task.toml loader (Phases 10-11).
 *
 * No LLM, no workers, no network: missing-file defaults, valid-file
 * parse, DYNAMIC tier discovery (every [budget.*] section is a usable
 * tier in file order — a new tier loads with no code change, Phase 11),
 * per-field warn-and-fallback validation (invalid budget mode, invalid
 * max_fix_iterations, invalid tool_timeout_ms, invalid wall_timeout_ms,
 * invalid [sandbox] values, malformed TOML), prewalk == execute
 * normalization, tool_timeout_ms + per-tier wall_timeout_ms parsing, and
 * the drift guard that the shipped config/task.toml equals the built-in
 * defaults (budget tiers + defaults + sandbox section).
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	DEFAULT_BUDGET_TIERS,
	DEFAULT_TASK_CONFIG,
	DEFAULT_TIER_WALL_TIMEOUT_MS,
	DEFAULT_TOOL_TIMEOUT_MS,
	DEFAULT_VERIFICATION_TIMEOUT_MS,
	DEFAULT_REVIEW_WALL_TIMEOUT_MS,
	DEFAULT_TURN_BUDGET,
	DEFAULT_TASK_SHAPES,
	DEFAULT_BATCH_CONFIG,
	DEFAULT_BATCH_MODEL,
	DEFAULT_BATCH_POLL_INTERVAL_MS,
	DEFAULT_BATCH_JOB_TIMEOUT_MS,
	DEFAULT_PREWALK_MIN_REQUIREMENTS,
	channelWatchdogWindows,
	aiIdentityToml,
	resolveTaskShape,
	formatAiAuthorName,
	loadTaskConfig,
	type TaskConfig,
	type TaskShape,
} from "./config.ts";

/** Run a synchronous fn with console.warn captured; restore afterwards. */
function captureWarnings(fn: () => void): string[] {
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]): void => {
		warnings.push(args.map(String).join(" "));
	};
	try {
		fn();
	} finally {
		console.warn = original;
	}
	return warnings;
}

function withTempToml(content: string, fn: (path: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-task-config-"));
	const path = join(dir, "task.toml");
	try {
		writeFileSync(path, content);
		fn(path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** JSON equality — loader output and defaults share key order by construction. */
function sameConfig(a: TaskConfig, b: TaskConfig): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function testMissingFile(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	let cfg: TaskConfig | undefined;
	const warnings = captureWarnings(() => {
		cfg = loadTaskConfig("/nonexistent/pi-task/task.toml");
	});
	check(
		cfg !== undefined && sameConfig(cfg, DEFAULT_TASK_CONFIG),
		"missing file should return the built-in defaults",
	);
	check(
		warnings.length === 0,
		`missing file should be silent, got ${JSON.stringify(warnings)}`,
	);
	// Mutating the returned config must not corrupt the shared defaults.
	cfg!.defaults.maxFixIterations = 99;
	check(
		DEFAULT_TASK_CONFIG.defaults.maxFixIterations === 2,
		"returned config must be a copy, not the shared defaults object",
	);
	// The missing-file defaults carry the Phase 11 budget surface.
	check(
		cfg!.defaults.toolTimeoutMs === DEFAULT_TOOL_TIMEOUT_MS,
		`missing file defaults should carry tool_timeout_ms, got ${cfg!.defaults.toolTimeoutMs}`,
	);
	check(
		cfg!.defaults.verificationTimeoutMs === DEFAULT_VERIFICATION_TIMEOUT_MS,
		`missing file defaults should carry verification_timeout_ms, got ${cfg!.defaults.verificationTimeoutMs}`,
	);
	check(
		cfg!.defaults.reviewWallTimeoutMs === DEFAULT_REVIEW_WALL_TIMEOUT_MS,
		`missing file defaults should carry review_wall_timeout_ms, got ${cfg!.defaults.reviewWallTimeoutMs}`,
	);
	check(
		DEFAULT_REVIEW_WALL_TIMEOUT_MS === 20 * 60_000,
		`the review wall default must stay 20 minutes, got ${DEFAULT_REVIEW_WALL_TIMEOUT_MS}`,
	);
	check(
		cfg!.defaults.aiAuthorName === "Pi ({model})" &&
			cfg!.defaults.aiAuthorEmail === "noreply@danong.dev",
		`missing file defaults should carry the AI commit identity, got ${cfg!.defaults.aiAuthorName} <${cfg!.defaults.aiAuthorEmail}>`,
	);
	check(
		JSON.stringify(cfg!.tierOrder) ===
			JSON.stringify(["max", "full", "economy", "free", "async"]),
		`missing file defaults should carry the built-in tier order, got ${JSON.stringify(cfg!.tierOrder)}`,
	);
	const asyncTier = cfg?.tiers.async;
	const missingEconomy = cfg?.tiers.economy;
	const missingFree = cfg?.tiers.free;
	if (!asyncTier || !missingEconomy || !missingFree)
		throw new Error(
			"built-in defaults must define the async/economy/free tiers",
		);
	check(
		asyncTier.serviceTier === "flex" &&
			asyncTier.shape === "async" &&
			asyncTier.prewalkModel === "openrouter/google/gemini-3.7-flash" &&
			asyncTier.executeModel ===
				"openrouter/~deepseek/deepseek-v4-flash-latest" &&
			asyncTier.reviewModel === "openrouter/~deepseek/deepseek-v4-flash-latest",
		"async tier: flex for the gemini prewalk slice only; the cheap deepseek workhorse runs the loop + review",
	);
	check(
		missingEconomy.wallTimeoutMs === 45 * 60_000,
		`economy's built-in wall should be 45 min (big builds need headroom), got ${missingEconomy.wallTimeoutMs}`,
	);
	check(
		missingFree.wallTimeoutMs === 30 * 60_000,
		`free's built-in wall should be 30 min, got ${missingFree.wallTimeoutMs}`,
	);
	console.log(
		"✓ missing file → silent defaults (copy semantics, Phase 11 surface)",
	);
}

function testValidFile(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	withTempToml(
		`
[defaults]
budget = "auto"
max_fix_iterations = 4
tool_timeout_ms = 300000
verification_timeout_ms = 600000
review_wall_timeout_ms = 600000
ai_author_name = "Assistant ({model})"
ai_author_email = "ai@example.dev"

[budget.full]
prewalk_model = "provider/strong"
execute_model = "provider/fast"
review_model = "provider/strong"
review = true
wall_timeout_ms = 3600000

[budget.economy]
prewalk_model = "provider/fast"
execute_model = "provider/fast"
review_model = "provider/fast"
review = false
wall_timeout_ms = 1500000

[budget.free]
prewalk_model = "provider/free"
execute_model = "provider/free"
review_model = "provider/free"
review = false
wall_timeout_ms = 1200000

[sandbox]
enabled = false
network = "isolate"
extra_ro_binds = ["/data", "/shared-cache"]
extra_rw_binds = ["/build"]
`,
		(path) => {
			let cfg: TaskConfig | undefined;
			const warnings = captureWarnings(() => {
				cfg = loadTaskConfig(path);
			});
			check(
				warnings.length === 0,
				`valid file should not warn, got ${JSON.stringify(warnings)}`,
			);
			check(
				cfg!.defaults.budget === "auto",
				`defaults.budget should be "auto", got ${cfg!.defaults.budget}`,
			);
			check(
				cfg!.defaults.maxFixIterations === 4,
				`maxFixIterations should be 4, got ${cfg!.defaults.maxFixIterations}`,
			);
			check(
				cfg!.defaults.toolTimeoutMs === 300000,
				`toolTimeoutMs should be 300000, got ${cfg!.defaults.toolTimeoutMs}`,
			);
			check(
				cfg!.defaults.aiAuthorName === "Assistant ({model})",
				`aiAuthorName override, got ${cfg!.defaults.aiAuthorName}`,
			);
			check(
				cfg!.defaults.aiAuthorEmail === "ai@example.dev",
				`aiAuthorEmail override, got ${cfg!.defaults.aiAuthorEmail}`,
			);
			check(
				cfg!.defaults.verificationTimeoutMs === 600000,
				`verificationTimeoutMs override, got ${cfg!.defaults.verificationTimeoutMs}`,
			);
			check(
				cfg!.defaults.reviewWallTimeoutMs === 600000,
				`reviewWallTimeoutMs override, got ${cfg!.defaults.reviewWallTimeoutMs}`,
			);
			const validFull = cfg?.tiers.full;
			const validEconomy = cfg?.tiers.economy;
			const validFree = cfg?.tiers.free;
			if (!validFull || !validEconomy || !validFree)
				throw new Error(
					"a valid file with [budget.*] sections must expose those tiers",
				);
			check(
				validFull.prewalkModel === "provider/strong",
				"full.prewalkModel override",
			);
			check(
				validFull.executeModel === "provider/fast",
				"full.executeModel override",
			);
			check(validFull.review === true, "full.review override");
			check(
				validFull.wallTimeoutMs === 3600000,
				`full.wallTimeoutMs override, got ${validFull.wallTimeoutMs}`,
			);
			check(validEconomy.review === false, "economy.review override");
			check(
				validEconomy.wallTimeoutMs === 1500000,
				`economy.wallTimeoutMs override, got ${validEconomy.wallTimeoutMs}`,
			);
			// economy: prewalk_model == execute_model → normalized to null
			check(
				validEconomy.prewalkModel === null,
				`prewalk == execute should normalize to null, got ${JSON.stringify(validEconomy.prewalkModel)}`,
			);
			check(
				validFree.executeModel === "provider/free",
				"free.executeModel override",
			);
			check(
				validFree.wallTimeoutMs === 1200000,
				`free.wallTimeoutMs override, got ${validFree.wallTimeoutMs}`,
			);
			// [sandbox] valid overrides
			check(
				cfg!.sandbox.enabled === false,
				`sandbox.enabled should be false, got ${cfg!.sandbox.enabled}`,
			);
			check(
				cfg!.sandbox.network === "isolate",
				`sandbox.network should be "isolate", got ${cfg!.sandbox.network}`,
			);
			check(
				JSON.stringify(cfg!.sandbox.extraRoBinds) ===
					JSON.stringify(["/data", "/shared-cache"]),
				"sandbox.extraRoBinds override",
			);
			check(
				JSON.stringify(cfg!.sandbox.extraRwBinds) ===
					JSON.stringify(["/build"]),
				"sandbox.extraRwBinds override",
			);
		},
	);
	console.log(
		"✓ valid file: defaults (incl. tool_timeout_ms) + all tiers (incl. wall_timeout_ms) + sandbox parse",
	);
}

function testDynamicTierDiscovery(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	// A NEW tier (Phase 11, todo #81): any [budget.*] section becomes a
	// usable tier with no code change. File order is preserved; built-in
	// tiers NOT declared in the file are NOT part of the set.
	withTempToml(
		`
[defaults]
budget = "turbo"

[budget.turbo]
execute_model = "provider/turbo"
review = false

[budget.max]
execute_model = "provider/max"

[budget.fast]
execute_model = "provider/fast"
wall_timeout_ms = 600000
service_tier = "flex"
`,
		(path) => {
			let cfg: TaskConfig | undefined;
			const warnings = captureWarnings(() => {
				cfg = loadTaskConfig(path);
			});
			check(
				warnings.length === 0,
				`a file with only real tiers must not warn, got ${JSON.stringify(warnings)}`,
			);
			// Order: file order (turbo before max before fast).
			check(
				JSON.stringify(cfg!.tierOrder) ===
					JSON.stringify(["turbo", "max", "fast"]),
				`tier order should be file order, got ${JSON.stringify(cfg!.tierOrder)}`,
			);
			check(
				JSON.stringify(Object.keys(cfg!.tiers)) ===
					JSON.stringify(["turbo", "max", "fast"]),
				`tiers record order should match file order, got ${JSON.stringify(Object.keys(cfg!.tiers))}`,
			);
			// Built-ins not declared in the file are NOT usable tiers.
			check(
				!("economy" in cfg!.tiers) &&
					!("full" in cfg!.tiers) &&
					!("free" in cfg!.tiers),
				"undeclared built-in tiers must not leak into a file-defined tier set",
			);
			const dynamicTurbo = cfg?.tiers.turbo;
			const dynamicFast = cfg?.tiers.fast;
			const dynamicMax = cfg?.tiers.max;
			const fullTemplate = DEFAULT_BUDGET_TIERS.full;
			if (!dynamicTurbo || !dynamicFast || !dynamicMax || !fullTemplate)
				throw new Error(
					"the declared tiers must load and the defaults must define 'full'",
				);
			// The new tier loads with its overrides.
			check(
				dynamicTurbo.executeModel === "provider/turbo",
				"turbo.executeModel override",
			);
			check(dynamicTurbo.review === false, "turbo.review override");
			check(
				dynamicFast.serviceTier === "flex",
				"fast.service_tier parses (flex infra)",
			);
			check(
				dynamicTurbo.serviceTier === undefined,
				"absent service_tier → standard tier",
			);
			// Custom-tier per-key fallback: the DEFAULT tier's built-in
			// template (models + 45-min wall) when keys are absent.
			check(
				dynamicTurbo.prewalkModel === fullTemplate.prewalkModel,
				"custom tier prewalk_model falls back to the default tier template",
			);
			check(
				dynamicTurbo.reviewModel === fullTemplate.reviewModel,
				"custom tier review_model falls back to the default tier template",
			);
			check(
				dynamicTurbo.wallTimeoutMs === DEFAULT_TIER_WALL_TIMEOUT_MS,
				`custom tier wall falls back to the 45-min default, got ${dynamicTurbo.wallTimeoutMs}`,
			);
			// [defaults] budget names a loaded tier → valid, no warning.
			check(
				cfg!.defaults.budget === "turbo",
				`defaults.budget should be "turbo", got ${cfg!.defaults.budget}`,
			);
			// Explicit wall_timeout_ms on a custom tier is honored.
			check(
				dynamicFast.wallTimeoutMs === 600000,
				`fast.wallTimeoutMs override, got ${dynamicFast.wallTimeoutMs}`,
			);
			// A built-in-name tier (max) still gets its built-in per-key fallbacks.
			check(
				dynamicMax.executeModel === "provider/max" &&
					dynamicMax.review === true,
				"built-in-name tier keeps built-in per-key fallbacks (max.review → true)",
			);
		},
	);
	console.log(
		"✓ dynamic tier discovery: new tier loads, file order, no unknown-section warning, per-key fallback",
	);
}

function testNoBudgetSections(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	// A file with NO [budget.*] sections (e.g. [defaults]- or [sandbox]-only)
	// falls back to the built-in tier set — the same "no tier configuration"
	// semantics as a missing file, so the config stays usable.
	withTempToml(
		`[defaults]
budget = "economy"
`,
		(path) => {
			let cfg: TaskConfig | undefined;
			const warnings = captureWarnings(() => {
				cfg = loadTaskConfig(path);
			});
			check(
				JSON.stringify(cfg!.tiers) === JSON.stringify(DEFAULT_BUDGET_TIERS),
				"no [budget.*] sections → built-in tier set",
			);
			check(
				JSON.stringify(cfg!.tierOrder) ===
					JSON.stringify(["max", "full", "economy", "free", "async"]),
				"no [budget.*] sections → built-in tier order",
			);
			check(
				cfg!.defaults.budget === "economy",
				"economy is a built-in tier → valid defaults.budget",
			);
			check(
				warnings.length === 0,
				`no-budget-sections file should be silent, got ${JSON.stringify(warnings)}`,
			);
		},
	);
	console.log("✓ no [budget.*] sections → built-in tier set (silently)");
}

function testPartialTierFallback(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	// Phase 11: the file's sections ARE the tier set — a partial file does
	// NOT keep the undeclared built-ins. Within the declared tier, missing
	// keys fall back to that tier's built-in config per key.
	withTempToml(
		`
[budget.full]
execute_model = "provider/custom-exec"
`,
		(path) => {
			const cfg = loadTaskConfig(path);
			const fullTier = cfg.tiers.full;
			const builtInFull = DEFAULT_BUDGET_TIERS.full;
			if (!fullTier || !builtInFull)
				throw new Error(
					"the declared 'full' tier must load and exist in the defaults",
				);
			check(
				fullTier.executeModel === "provider/custom-exec",
				"execute_model overridden",
			);
			check(
				fullTier.prewalkModel === builtInFull.prewalkModel,
				"missing prewalk_model falls back to the built-in tier default",
			);
			check(
				fullTier.reviewModel === builtInFull.reviewModel,
				"missing review_model falls back",
			);
			check(
				fullTier.review === builtInFull.review,
				"missing review falls back",
			);
			check(
				fullTier.wallTimeoutMs === builtInFull.wallTimeoutMs,
				`missing wall_timeout_ms falls back to the tier's built-in wall, got ${fullTier.wallTimeoutMs}`,
			);
			check(
				JSON.stringify(cfg.tierOrder) === JSON.stringify(["full"]),
				`partial file exposes ONLY the declared tier, got ${JSON.stringify(cfg.tierOrder)}`,
			);
			check(
				!("economy" in cfg.tiers) && !("free" in cfg.tiers),
				"undeclared built-ins must not be part of the loaded tier set",
			);
		},
	);
	console.log(
		"✓ partial tier section: per-key fallback; undeclared tiers not part of the set",
	);
}

function testSandboxConfig(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	// Built-in defaults include the sandbox vocabulary.
	check(
		DEFAULT_TASK_CONFIG.sandbox.enabled === true,
		"sandbox default enabled should be true",
	);
	check(
		DEFAULT_TASK_CONFIG.sandbox.network === "allow",
		'sandbox default network should be "allow"',
	);
	check(
		DEFAULT_TASK_CONFIG.sandbox.extraRoBinds.length === 0 &&
			DEFAULT_TASK_CONFIG.sandbox.extraRwBinds.length === 0,
		"sandbox default binds should be empty arrays",
	);
	// A file with only [defaults] → missing [sandbox] table → built-in defaults, silently.
	withTempToml(
		`[defaults]
budget = "economy"
`,
		(path) => {
			let cfg: TaskConfig | undefined;
			const warnings = captureWarnings(() => {
				cfg = loadTaskConfig(path);
			});
			check(
				JSON.stringify(cfg!.sandbox) ===
					JSON.stringify(DEFAULT_TASK_CONFIG.sandbox),
				"missing [sandbox] table should fall back to built-in defaults",
			);
			check(
				warnings.length === 0,
				`missing [sandbox] table should be silent, got ${JSON.stringify(warnings)}`,
			);
		},
	);
	// Partial [sandbox]: per-key fallback for absent keys.
	withTempToml(
		`[sandbox]
network = "isolate"
`,
		(path) => {
			const cfg = loadTaskConfig(path);
			check(
				cfg.sandbox.network === "isolate" &&
					cfg.sandbox.enabled === true &&
					cfg.sandbox.extraRoBinds.length === 0 &&
					cfg.sandbox.extraRwBinds.length === 0,
				"partial [sandbox] should keep built-in defaults for absent keys",
			);
		},
	);
	console.log(
		"✓ sandbox: built-in defaults, missing-table fallback, partial per-key fallback",
	);
}

function testInvalidValues(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	withTempToml(
		`
[defaults]
budget = "phantom"
max_fix_iterations = -1
tool_timeout_ms = "long"
verification_timeout_ms = -5

[budget.full]
execute_model = ""
wall_timeout_ms = -5

[budget.mega]
execute_model = "provider/x"

[sandbox]
enabled = "yes"
network = "bridge"
extra_ro_binds = "/data"
extra_rw_binds = [1, 2]
`,
		(path) => {
			let cfg: TaskConfig | undefined;
			const warnings = captureWarnings(() => {
				cfg = loadTaskConfig(path);
			});
			// "phantom" is not a tier in the file → warn + fall back to the
			// default tier (DEFAULT_BUDGET_TIER "full" IS declared here).
			check(
				cfg!.defaults.budget === "full",
				`invalid budget should fall back to "full", got ${cfg!.defaults.budget}`,
			);
			check(
				cfg!.defaults.maxFixIterations === 2,
				`invalid max_fix_iterations should fall back to 2, got ${cfg!.defaults.maxFixIterations}`,
			);
			check(
				cfg!.defaults.toolTimeoutMs === DEFAULT_TOOL_TIMEOUT_MS,
				`invalid tool_timeout_ms should fall back to the 15-min default, got ${cfg!.defaults.toolTimeoutMs}`,
			);
			check(
				cfg!.defaults.verificationTimeoutMs === DEFAULT_VERIFICATION_TIMEOUT_MS,
				`invalid verification_timeout_ms should fall back to the 15-min default, got ${cfg!.defaults.verificationTimeoutMs}`,
			);
			const invalidFull = cfg?.tiers.full;
			const fallbackTemplate = DEFAULT_BUDGET_TIERS.full;
			if (!invalidFull || !fallbackTemplate)
				throw new Error(
					"the declared 'full' tier must load and exist in the defaults",
				);
			check(
				invalidFull.executeModel === fallbackTemplate.executeModel,
				"empty execute_model should fall back",
			);
			check(
				invalidFull.wallTimeoutMs === fallbackTemplate.wallTimeoutMs,
				`invalid wall_timeout_ms should fall back to the tier's built-in wall, got ${invalidFull.wallTimeoutMs}`,
			);
			// Phase 11: [budget.mega] IS a usable tier (no "unknown tier
			// section" warning — every section in the file is a tier).
			check(
				cfg!.tiers.mega !== undefined &&
					cfg!.tiers.mega.executeModel === "provider/x",
				"any [budget.*] section is a usable tier",
			);
			check(
				cfg!.sandbox.enabled === true,
				"invalid sandbox.enabled should fall back to true",
			);
			check(
				cfg!.sandbox.network === "allow",
				'invalid sandbox.network should fall back to "allow"',
			);
			check(
				cfg!.sandbox.extraRoBinds.length === 0 &&
					cfg!.sandbox.extraRwBinds.length === 0,
				"invalid sandbox bind arrays should fall back to []",
			);
			check(
				warnings.some((w) => w.includes("budget") && w.includes("phantom")),
				"should warn about the invalid budget value",
			);
			check(
				warnings.some((w) => w.includes("max_fix_iterations")),
				"should warn about max_fix_iterations",
			);
			check(
				warnings.some((w) => w.includes("tool_timeout_ms")),
				"should warn about tool_timeout_ms",
			);
			check(
				warnings.some((w) => w.includes("verification_timeout_ms")),
				"should warn about verification_timeout_ms",
			);
			check(
				warnings.some((w) => w.includes("execute_model")),
				"should warn about the empty execute_model",
			);
			check(
				warnings.some((w) => w.includes("wall_timeout_ms")),
				"should warn about wall_timeout_ms",
			);
			check(
				!warnings.some((w) => w.includes("budget.mega")),
				"no unknown-tier-section warning for a tier actually present in the file",
			);
			check(
				warnings.some((w) => w.includes("enabled")),
				"should warn about the invalid sandbox.enabled",
			);
			check(
				warnings.some((w) => w.includes("network")),
				"should warn about the invalid sandbox.network",
			);
			check(
				warnings.some((w) => w.includes("extra_ro_binds")),
				"should warn about the invalid extra_ro_binds",
			);
			check(
				warnings.some((w) => w.includes("extra_rw_binds")),
				"should warn about the invalid extra_rw_binds",
			);
		},
	);
	// Non-integer / wrong-type max_fix_iterations variants.
	withTempToml(`\n[defaults]\nmax_fix_iterations = 2.5\n`, (path) => {
		let cfg: TaskConfig | undefined;
		const warnings = captureWarnings(() => {
			cfg = loadTaskConfig(path);
		});
		check(
			cfg!.defaults.maxFixIterations === 2,
			"float max_fix_iterations falls back to 2",
		);
		check(warnings.length > 0, "float max_fix_iterations should warn");
	});
	withTempToml(`\n[defaults]\nmax_fix_iterations = "two"\n`, (path) => {
		let cfg: TaskConfig | undefined;
		captureWarnings(() => {
			cfg = loadTaskConfig(path);
		});
		check(
			cfg!.defaults.maxFixIterations === 2,
			"string max_fix_iterations falls back to 2",
		);
	});
	// Wrong-type tool_timeout_ms / wall_timeout_ms variants.
	withTempToml(`[defaults]\nreview_wall_timeout_ms = -5\n`, (path) => {
		let cfg: TaskConfig | undefined;
		const warnings = captureWarnings(() => {
			cfg = loadTaskConfig(path);
		});
		check(
			warnings.some((w) => w.includes("review_wall_timeout_ms")),
			"invalid review_wall_timeout_ms should warn",
		);
		check(
			cfg!.defaults.reviewWallTimeoutMs === DEFAULT_REVIEW_WALL_TIMEOUT_MS,
			`invalid review_wall_timeout_ms should fall back to the 20-min default, got ${cfg!.defaults.reviewWallTimeoutMs}`,
		);
	});
	withTempToml(`[defaults]\ntool_timeout_ms = 2.5\n`, (path) => {
		let cfg: TaskConfig | undefined;
		captureWarnings(() => {
			cfg = loadTaskConfig(path);
		});
		check(
			cfg!.defaults.toolTimeoutMs === DEFAULT_TOOL_TIMEOUT_MS,
			"float tool_timeout_ms falls back to the default",
		);
	});
	withTempToml(
		`[budget.economy]\nprovider_only = ["google-vertex/flex", "openai/priority"]\n`,
		(path) => {
			let cfg: TaskConfig | undefined;
			captureWarnings(() => {
				cfg = loadTaskConfig(path);
			});
			check(
				JSON.stringify(cfg!.tiers.economy!.providerOnly) ===
					JSON.stringify(["google-vertex/flex", "openai/priority"]),
				"provider_only parses as endpoint slugs",
			);
		},
	);

	// Wave-1 config: prewalk_min_requirements (defaults) + checklist (tier).
	withTempToml(
		`[defaults]
prewalk_min_requirements = 1
[budget.economy]
checklist = false
`,
		(path) => {
			let cfg: TaskConfig | undefined;
			captureWarnings(() => {
				cfg = loadTaskConfig(path);
			});
			check(
				cfg!.defaults.prewalkMinRequirements === 1,
				"prewalk_min_requirements parses from [defaults]",
			);
			check(
				cfg!.defaults.prewalkMinRequirements !==
					DEFAULT_PREWALK_MIN_REQUIREMENTS,
				"the explicit 1 differs from the built-in default",
			);
			check(
				cfg!.tiers.economy!.checklist === false,
				"checklist = false parses on the tier",
			);
		},
	);
	// Absent keys → built-in defaults (all tiers default checklist ON).
	withTempToml(
		`[budget.economy]
`,
		(path) => {
			let cfg: TaskConfig | undefined;
			captureWarnings(() => {
				cfg = loadTaskConfig(path);
			});
			check(
				cfg!.tiers.economy!.checklist === true,
				"checklist absent → tier defaults to ON",
			);
			check(
				cfg!.defaults.prewalkMinRequirements ===
					DEFAULT_PREWALK_MIN_REQUIREMENTS,
				"prewalk_min_requirements absent → built-in default",
			);
		},
	);
	withTempToml(`[budget.economy]\nturn_budget = 25\n`, (path) => {
		let cfg: TaskConfig | undefined;
		captureWarnings(() => {
			cfg = loadTaskConfig(path);
		});
		check(
			cfg!.tiers.economy!.turnBudget === 25,
			`turn_budget override, got ${cfg!.tiers.economy!.turnBudget}`,
		);
	});
	// Wave-2 config: slim_worker_prompt (defaults).
	withTempToml(`[defaults]\nslim_worker_prompt = false\n`, (path) => {
		let cfg: TaskConfig | undefined;
		captureWarnings(() => {
			cfg = loadTaskConfig(path);
		});
		check(
			cfg!.defaults.slimWorkerPrompt === false,
			"slim_worker_prompt=false parses",
		);
	});
	withTempToml(`[defaults]\n`, (path) => {
		let cfg: TaskConfig | undefined;
		captureWarnings(() => {
			cfg = loadTaskConfig(path);
		});
		check(
			cfg!.defaults.slimWorkerPrompt === true,
			"slim_worker_prompt absent → default true",
		);
	});
	withTempToml(`[budget.economy]\nturn_budget = -5\n`, (path) => {
		let cfg: TaskConfig | undefined;
		const warnings = captureWarnings(() => {
			cfg = loadTaskConfig(path);
		});
		check(
			warnings.some((w) => w.includes("turn_budget")),
			"invalid turn_budget should warn",
		);
		check(
			cfg!.tiers.economy!.turnBudget === DEFAULT_TURN_BUDGET,
			`invalid turn_budget falls back to the default, got ${cfg!.tiers.economy!.turnBudget}`,
		);
	});
	withTempToml(`[budget.economy]\nprovider_only = []\n`, (path) => {
		let cfg: TaskConfig | undefined;
		const warnings = captureWarnings(() => {
			cfg = loadTaskConfig(path);
		});
		check(
			warnings.some((w) => w.includes("provider_only")),
			"empty provider_only should warn",
		);
		check(
			cfg!.tiers.economy!.providerOnly === undefined,
			"empty provider_only falls back to default routing",
		);
	});
	withTempToml(`[budget.economy]\nservice_tier = "bogus"\n`, (path) => {
		let cfg: TaskConfig | undefined;
		const warnings = captureWarnings(() => {
			cfg = loadTaskConfig(path);
		});
		check(
			warnings.some((w) => w.includes("service_tier")),
			"invalid service_tier should warn",
		);
		check(
			cfg!.tiers.economy!.serviceTier === undefined,
			"invalid service_tier falls back to the tier's built-in (standard)",
		);
	});
	withTempToml(`[budget.economy]\nwall_timeout_ms = "fast"\n`, (path) => {
		let cfg: TaskConfig | undefined;
		captureWarnings(() => {
			cfg = loadTaskConfig(path);
		});
		const stringWallEconomy = cfg!.tiers.economy;
		const builtInEconomy = DEFAULT_BUDGET_TIERS.economy;
		if (!stringWallEconomy || !builtInEconomy)
			throw new Error("[budget.economy] must load and exist in the defaults");
		check(
			stringWallEconomy.wallTimeoutMs === builtInEconomy.wallTimeoutMs,
			"string wall_timeout_ms falls back to the tier's built-in wall",
		);
	});
	console.log(
		"✓ invalid values: warn + per-field fallback (incl. tool_timeout_ms / wall_timeout_ms)",
	);
}

function testMalformedToml(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	withTempToml(`this is [not toml = =`, (path) => {
		let cfg: TaskConfig | undefined;
		const warnings = captureWarnings(() => {
			cfg = loadTaskConfig(path);
		});
		check(
			cfg !== undefined && sameConfig(cfg, DEFAULT_TASK_CONFIG),
			"malformed TOML should return the built-in defaults",
		);
		check(warnings.length > 0, "malformed TOML should warn");
	});
	console.log("✓ malformed TOML: warn + defaults");
}

// ─── AI commit identity (todo #84) ─────────────────────────
function testAiIdentity(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	// formatAiAuthorName: the {model} placeholder resolves to the model's
	// short name (after the last "/"); a template without the placeholder
	// passes through unchanged.
	{
		check(
			formatAiAuthorName("Pi ({model})", "opencode-go/deepseek-v4-flash") ===
				"Pi (deepseek-v4-flash)",
			`formatAiAuthorName: {model} → short name, got ${formatAiAuthorName("Pi ({model})", "opencode-go/deepseek-v4-flash")}`,
		);
		check(
			formatAiAuthorName("Pi", "opencode-go/deepseek-v4-flash") === "Pi",
			"formatAiAuthorName: no placeholder passes through",
		);
		check(
			formatAiAuthorName(
				"A ({model})",
				"qwen-token-plan/qwen3.8-max-preview",
			) === "A (qwen3.8-max-preview)",
			"formatAiAuthorName: multi-slash model takes the last segment",
		);
	}
	// aiIdentityToml: the jj config a worker spawn needs (JJ_CONFIG /
	// --config-file) — author AND committer follow it.
	{
		const toml = aiIdentityToml("Pi (deepseek-v4-flash)", "noreply@danong.dev");
		check(
			toml.includes('user.name = "Pi (deepseek-v4-flash)"'),
			"aiIdentityToml: name line",
		);
		check(
			toml.includes('user.email = "noreply@danong.dev"'),
			"aiIdentityToml: email line",
		);
	}
	console.log("✓ AI commit identity: {model} placeholder + identity TOML");
}

/** Drift guard: the shipped config/task.toml mirrors the built-in
 *  defaults, so deployed behavior is unchanged for every tier. */
function testShippedConfigMatchesDefaults(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	// Explicit path → the package's shipped config/task.toml (extensions/
	// task/test-config.ts → package root). The agent-dir config is the
	// user's overrides and may legitimately diverge from built-in defaults.
	const cfg = loadTaskConfig(
		join(
			dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
			"config",
			"task.toml",
		),
	);
	check(
		sameConfig(cfg, DEFAULT_TASK_CONFIG),
		`shipped config/task.toml should equal built-in defaults, got ${JSON.stringify(cfg)}`,
	);
	// The [sandbox] section is part of the drift guard.
	check(
		JSON.stringify(cfg.sandbox) === JSON.stringify(DEFAULT_TASK_CONFIG.sandbox),
		"shipped [sandbox] section should equal the built-in sandbox defaults",
	);
	// The Phase 11 budget surface is part of the drift guard too: the
	// shipped tool_timeout_ms and per-tier wall_timeout_ms mirror the
	// built-in defaults (economy/free get the shorter 25-min wall).
	// The shipped config must carry every built-in tier for the drift guard.
	const shippedMax = cfg.tiers.max;
	const shippedFull = cfg.tiers.full;
	const shippedEconomy = cfg.tiers.economy;
	const shippedFree = cfg.tiers.free;
	const builtInMax = DEFAULT_BUDGET_TIERS.max;
	const driftFull = DEFAULT_BUDGET_TIERS.full;
	const builtInEconomy = DEFAULT_BUDGET_TIERS.economy;
	const builtInFree = DEFAULT_BUDGET_TIERS.free;
	if (
		!shippedMax ||
		!shippedFull ||
		!shippedEconomy ||
		!shippedFree ||
		!builtInMax ||
		!driftFull ||
		!builtInEconomy ||
		!builtInFree
	)
		throw new Error(
			"shipped config and defaults must both define the max/full/economy/free tiers",
		);
	check(
		cfg.defaults.toolTimeoutMs === DEFAULT_TOOL_TIMEOUT_MS,
		"shipped tool_timeout_ms should equal the built-in default",
	);
	check(
		cfg.defaults.reviewWallTimeoutMs === DEFAULT_REVIEW_WALL_TIMEOUT_MS,
		"shipped review_wall_timeout_ms should equal the built-in 20-min default",
	);
	check(
		shippedMax.wallTimeoutMs === builtInMax.wallTimeoutMs &&
			shippedFull.wallTimeoutMs === driftFull.wallTimeoutMs,
		"shipped max/full wall_timeout_ms should equal the built-in defaults",
	);
	check(
		shippedEconomy.wallTimeoutMs === builtInEconomy.wallTimeoutMs &&
			shippedFree.wallTimeoutMs === builtInFree.wallTimeoutMs,
		"shipped economy/free wall_timeout_ms should equal the built-in defaults",
	);
	console.log(
		"✓ shipped config/task.toml matches built-in defaults (incl. tool_timeout_ms + wall_timeout_ms)",
	);
}

export function runTests(): Promise<void> {
	console.log("\n── test-config: task.toml loader ──");
	const errors: string[] = [];

	testMissingFile(errors);
	testValidFile(errors);
	testDynamicTierDiscovery(errors);
	testNoBudgetSections(errors);
	testPartialTierFallback(errors);
	testSandboxConfig(errors);
	testInvalidValues(errors);
	testMalformedToml(errors);
	testAiIdentity(errors);
	testShippedConfigMatchesDefaults(errors);
	testShapes(errors);
	testBatchSection(errors);

	// ─── [shapes.*] run-pipeline shapes ──────────────────────────────────

	function testShapes(errors: string[]): void {
		const check = (cond: boolean, msg: string): void => {
			if (!cond) errors.push(msg);
		};
		// Built-in shapes: code (the current pipeline) + analysis (strong
		// writer, no swap, no review axes), both with a working review contract
		// (analysis never forks — the shape declares no axes).
		check(
			JSON.stringify(Object.keys(DEFAULT_TASK_SHAPES)) ===
				JSON.stringify(["code", "async", "analysis", "batch"]),
			`built-in shapes, got ${JSON.stringify(Object.keys(DEFAULT_TASK_SHAPES))}`,
		);
		const codeShape = DEFAULT_TASK_SHAPES.code;
		const analysisShape = DEFAULT_TASK_SHAPES.analysis;
		const asyncShape = DEFAULT_TASK_SHAPES.async;
		const batchShape = DEFAULT_TASK_SHAPES.batch;
		if (!codeShape || !analysisShape || !asyncShape || !batchShape)
			throw new Error("built-in shapes must define code/analysis/async/batch");
		check(
			codeShape.prewalk && codeShape.swap && codeShape.workModel === "execute",
			"code shape: prewalk + swap + execute writer",
		);
		check(
			!analysisShape.prewalk &&
				!analysisShape.swap &&
				analysisShape.workModel === "prewalk" &&
				analysisShape.reviewModel === "prewalk" &&
				analysisShape.review.length === 0,
			"analysis shape: no prewalk/swap, strong writer, no review axes (single task)",
		);
		// Channel: default sync; flex/batch parse; the watchdog calibration.
		check(
			codeShape.channel === "sync" && analysisShape.channel === "sync",
			"built-in code/analysis shapes default to the sync channel",
		);
		check(
			asyncShape.channel === "flex" && asyncShape.prewalk && asyncShape.swap,
			"async shape: flex channel, standard pipeline",
		);
		// Batch shape (M2): the async job lane — no prewalk/swap, no review axes.
		check(
			batchShape.channel === "batch" &&
				!batchShape.prewalk &&
				!batchShape.swap &&
				batchShape.review.length === 0,
			"batch shape: channel batch, no prewalk/swap, no review axes",
		);
		{
			const sync = channelWatchdogWindows("sync");
			const flex = channelWatchdogWindows("flex");
			const batch = channelWatchdogWindows("batch");
			check(
				sync.firstEventMs === 3 * 60_000 && sync.noProgressMs === 10 * 60_000,
				"sync keeps the interactive watchdog defaults",
			);
			check(
				flex.firstEventMs > sync.firstEventMs &&
					flex.noProgressMs > sync.noProgressMs &&
					flex.firstEventMs >= 25 * 60_000,
				"flex extends the first-event + no-progress windows (1-15 min calls must not false-fire)",
			);
			check(
				batch.firstEventMs === Number.MAX_SAFE_INTEGER &&
					batch.noProgressMs === Number.MAX_SAFE_INTEGER,
				"batch has no interactive session — watchdogs unbounded (job polling instead)",
			);
		}

		// resolveTaskShape: loaded set, built-ins, unknown → code; never throws.
		const loaded: Record<string, TaskShape> = {
			...DEFAULT_TASK_SHAPES,
			custom: { ...codeShape, swap: false },
		};
		check(
			resolveTaskShape("custom", loaded).swap === false,
			"resolveTaskShape finds a loaded shape",
		);
		check(
			resolveTaskShape("analysis", {}) === analysisShape,
			"resolveTaskShape falls back to built-ins",
		);
		check(
			resolveTaskShape("bogus", loaded) === codeShape,
			"unknown shape → code",
		);
		check(
			resolveTaskShape(undefined, loaded) === codeShape,
			"undefined shape → code",
		);

		// Config file: [shapes.*] overrides + tier shape refs parse (per-key fallback).
		withTempToml(
			`
[shapes.custom]
channel = "flex"
prewalk = false
swap = true
work_model = "execute"
review_model = "prewalk"
review = ["adversarial"]
`,
			(path) => {
				const cfg = loadTaskConfig(path);
				const custom = cfg.shapes.custom;
				if (!custom)
					throw new Error("[shapes.custom] must load as a usable shape");
				check(
					custom.prewalk === false &&
						custom.swap === true &&
						custom.reviewModel === "prewalk" &&
						JSON.stringify(custom.review) === JSON.stringify(["adversarial"]),
					`custom shape parses, got ${JSON.stringify(custom)}`,
				);
				// Absent keys fall back to the code shape; channel parses.
				check(
					custom.workModel === "execute",
					"custom shape falls back per-key to code",
				);
				check(
					custom.channel === "flex",
					`custom shape channel parses, got ${custom.channel}`,
				);
				// A tier without an explicit shape still defaults to code.
				const tierFull = cfg.tiers.full;
				if (!tierFull)
					throw new Error(
						"the built-in 'full' tier must exist in a shapes-only file",
					);
				check(
					tierFull.shape === "code",
					`tier shape defaults to code, got ${tierFull.shape}`,
				);
			},
		);
		console.log(
			"✓ shapes: built-ins, resolveTaskShape, [shapes.*] parse + per-key fallback, tier default",
		);
	}

	/** The [batch] lane section (M2): defaults, parse, warn-and-fallback. */
	function testBatchSection(errors: string[]): void {
		const check = (cond: boolean, msg: string): void => {
			if (!cond) errors.push(msg);
		};

		// Built-in defaults carry the batch lane surface.
		check(
			DEFAULT_TASK_CONFIG.batch.model === DEFAULT_BATCH_MODEL,
			`batch model default should be ${DEFAULT_BATCH_MODEL}, got ${DEFAULT_TASK_CONFIG.batch.model}`,
		);
		check(
			DEFAULT_TASK_CONFIG.batch.pollIntervalMs ===
				DEFAULT_BATCH_POLL_INTERVAL_MS &&
				DEFAULT_TASK_CONFIG.batch.jobTimeoutMs === DEFAULT_BATCH_JOB_TIMEOUT_MS,
			"batch polling defaults should be the 30s/24h built-ins",
		);

		// A file with no [batch] table → silent defaults.
		withTempToml(
			`[defaults]
budget = "economy"
`,
			(path) => {
				let cfg: TaskConfig | undefined;
				const warnings = captureWarnings(() => {
					cfg = loadTaskConfig(path);
				});
				check(
					JSON.stringify(cfg!.batch) === JSON.stringify(DEFAULT_BATCH_CONFIG),
					"missing [batch] table should fall back to built-in defaults",
				);
				check(
					warnings.length === 0,
					`missing [batch] table should be silent, got ${JSON.stringify(warnings)}`,
				);
			},
		);

		// A valid [batch] table parses (model override + polling budgets).
		withTempToml(
			`[batch]
model = "provider/batch-2"
poll_interval_ms = 60000
job_timeout_ms = 3600000
`,
			(path) => {
				let cfg: TaskConfig | undefined;
				const warnings = captureWarnings(() => {
					cfg = loadTaskConfig(path);
				});
				check(
					warnings.length === 0,
					`valid [batch] should not warn, got ${JSON.stringify(warnings)}`,
				);
				check(
					cfg!.batch.model === "provider/batch-2",
					`batch model override, got ${cfg!.batch.model}`,
				);
				check(
					cfg!.batch.pollIntervalMs === 60000,
					`batch poll_interval_ms override, got ${cfg!.batch.pollIntervalMs}`,
				);
				check(
					cfg!.batch.jobTimeoutMs === 3600000,
					`batch job_timeout_ms override, got ${cfg!.batch.jobTimeoutMs}`,
				);
			},
		);

		// Invalid values warn + fall back per field.
		withTempToml(
			`[batch]
model = ""
poll_interval_ms = -1
job_timeout_ms = "long"
`,
			(path) => {
				let cfg: TaskConfig | undefined;
				const warnings = captureWarnings(() => {
					cfg = loadTaskConfig(path);
				});
				check(
					cfg!.batch.model === DEFAULT_BATCH_MODEL,
					"empty batch model should fall back to the default",
				);
				check(
					cfg!.batch.pollIntervalMs === DEFAULT_BATCH_POLL_INTERVAL_MS,
					"invalid poll_interval_ms should fall back",
				);
				check(
					cfg!.batch.jobTimeoutMs === DEFAULT_BATCH_JOB_TIMEOUT_MS,
					"invalid job_timeout_ms should fall back",
				);
				check(
					warnings.some((w) => w.includes("model")),
					"should warn about the invalid batch model",
				);
				check(
					warnings.some((w) => w.includes("poll_interval_ms")),
					"should warn about poll_interval_ms",
				);
				check(
					warnings.some((w) => w.includes("job_timeout_ms")),
					"should warn about job_timeout_ms",
				);
			},
		);
		console.log(
			"✓ [batch] section: defaults, parse, per-field warn-and-fallback",
		);
	}

	if (errors.length > 0) {
		return Promise.reject(
			new Error("test-config failed:\n  ✗ " + errors.join("\n  ✗ ")),
		);
	}
	console.log("✓ config hermetic assertions passed");
	return Promise.resolve();
}

// Direct execution support: `npx tsx extensions/task/test-config.ts`
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
