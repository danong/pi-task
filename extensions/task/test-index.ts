/**
 * index.ts hermetic tests — the pure parts of the Phase 9 tool wiring.
 *
 * No worker spawns, no LLM, no extension runtime: the budget
 * schema-locking decision (a locked tier removes the `budget` param from
 * the tool's TypeBox schema), the sub_specs-vs-spec precedence / parallel
 * derivation, budget tier resolution, the TaskResult → tool-return mapping,
 * the review-report summary text (todo #72) + the in-place TUI render
 * helper (todo #68), and the dispatch-plan + progress render (buildRunPlan /
 * applyProgressEvent / buildProgressText) — including the live phase/total
 * durations, completed-phase checkmarks, and the review-phase freeze (R1-R3)
 * — plus the completion-summary metrics (duration + tokens/cost, R4) and the
 * one-line task completion summary (wall-clock latency · cost · verify
 * status · tier — R1/R4).
 *
 * The flag→schema-locking TIMING (CLI values only readable at
 * session_start, not at factory time) was verified empirically with a real
 * pi probe during Phase 9 — see docs/pi-task-design.md → Budget
 * Enforcement → Implementation notes. The renderResult lastComponent-
 * reuse behavior is covered hermetically here (renderInPlace) and
 * TUI-verified in the running app.
 */

import { pathToFileURL } from "node:url";
import type { TaskResult, WorkerResult } from "./orchestrator.ts";
import type { RunManifest } from "./metrics.ts";
import type { WorkerUsage } from "./worker.ts";
import {
	autoTierForRequirements,
	applyProgressEvent,
	buildProgressText,
	buildRunPlan,
	completionSummaryLine,
	countSpecRequirements,
	countSubSpecsRequirements,
	createProgressState,
	deriveRunMetrics,
	detachedDispatchText,
	failureMessageWithProgress,
	formatDuration,
	isLockedBudget,
	normalizeBudgetMode,
	normalizeSubSpecs,
	readBudgetOverride,
	readGoals,
	readSessionTokensBefore,
	renderGoalsClause,
	renderInPlace,
	renderPlanLine,
	renderReviewReport,
	renderSubSpecObject,
	resolveBudgetMode,
	resolveBudgetTier,
	resolveSubSpecs,
	summarizeResult,
	taskResultToToolReturn,
	taskToolSchema,
	workflowContractBlock,
	workflowContractText,
	formatTokenCount,
	type BudgetTierConfig,
	type ProgressState,
	type RunPlan,
	type TaskToolReturn,
} from "./index.ts";

// MAX_REVIEW_FINDINGS_IN_SUMMARY is intentionally NOT imported here: the
// cap test derives the bound from the rendered output so a change to the
// constant (in index.ts) can't silently pass a stale test.
import type { Finding, ReviewResult } from "./schemas/findings.ts";
import { parseSpec } from "./schemas/spec.ts";
import { BUDGET_TIERS } from "./config.ts";
import { extractFileScope } from "./progress.ts";
import { truncateGoals } from "./progress.ts";

/** Extract the property names from a TypeBox schema's JSON form. */
function schemaProperties(schema: ReturnType<typeof taskToolSchema>): string[] {
	const json = JSON.parse(JSON.stringify(schema));
	return Object.keys(json.properties ?? {});
}

/** A dynamic-tier fixture (Phase 11): a loaded config's tier set — any
 *  [budget.*] section in task.toml becomes a tier with no code change. */
function tierConfig(overrides: Partial<BudgetTierConfig> = {}): BudgetTierConfig {
	return {
		prewalkModel: null,
		executeModel: "prov/m",
		reviewModel: "prov/m",
		review: false,
		wallTimeoutMs: 2_700_000,
		...overrides,
	};
}

/** Extract the JSON form of a property from a schema (by name). */
function propertyJson(
	schema: ReturnType<typeof taskToolSchema>,
	name: string,
): Record<string, unknown> {
	const json = JSON.parse(
		JSON.stringify((schema as unknown as { properties: Record<string, unknown> }).properties[name]),
	) as Record<string, unknown>;
	return json;
}

/** A minimal TaskResult for mapping tests. */
function fakeResult(overrides: Partial<TaskResult> = {}): TaskResult {
	return {
		success: true,
		commits: ["abc123"],
		files_changed: ["hello.txt"],
		tests: "passing",
		spec: { goal: "G", requirements: ["- R1: x"], verification: ["true"] },
		worker: {
			yield: { files_changed: ["hello.txt"], summary: "s", commit_ids: ["abc123"], deviations: [] },
			usage: { turns: 1, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0, reads: 0, edits: 0 },
			reads: [],
			turnUsage: [],
			exitCode: 0,
		},
		verification: { passed: true, commands: 1, duration_ms: 1, failures: [] },
		durationMs: 65000,
		...overrides,
	};
}

/** A WorkerResult whose per-turn usage snapshots are exactly the given ones. */
function fakeWorker(turnUsage: WorkerUsage[]): WorkerResult {
	return {
		yield: { files_changed: ["a.txt"], summary: "s", commit_ids: ["c1"], deviations: [] },
		usage: { turns: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0, reads: 0, edits: 0 },
		reads: [],
		turnUsage,
		exitCode: 0,
	};
}

function testBudgetSchemaLocking(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const unlocked = schemaProperties(taskToolSchema(false));
	const locked = schemaProperties(taskToolSchema(true));

	check(unlocked.includes("spec"), "unlocked schema should have spec");
	check(unlocked.includes("sub_specs"), "unlocked schema should have sub_specs");
	check(unlocked.includes("parallel"), "unlocked schema should have parallel");
	check(unlocked.includes("review"), "unlocked schema should have the review axis override");
	check(unlocked.includes("shape"), "unlocked schema should have the shape param");
	check(unlocked.includes("detach"), "unlocked schema should have the detach param");
	check(unlocked.includes("budget"), "unlocked schema should expose budget");

	check(locked.includes("spec") && locked.includes("sub_specs") && locked.includes("parallel") && locked.includes("review") && locked.includes("shape"),
		"locked schema keeps the work parameters + review/shape overrides");
	check(locked.includes("detach"), "locked schema keeps the detach param (it is not a budget override)");
	check(!locked.includes("budget"), "locked schema must NOT expose budget (model cannot see or override it)");

	// Budget enum values are exactly "auto" + the built-in tier set (derived,
	// never a hardcoded count — new built-in tiers flow through).
	const budgetSchema = propertyJson(taskToolSchema(false), "budget");
	check(Array.isArray(budgetSchema.enum) && budgetSchema.enum.length === BUDGET_TIERS.length + 1,
		`budget enum should have auto + the built-in tiers, got ${JSON.stringify(budgetSchema.enum)}`);
	check(JSON.stringify(budgetSchema.enum) === JSON.stringify(["auto", ...BUDGET_TIERS]),
		`budget enum values, got ${JSON.stringify(budgetSchema.enum)}`);

	// Phase 11 (R2): the enum is config-driven — a NEW tier in the loaded
	// config appears in the enum, in file order after "auto", with no code
	// change. Tiers NOT in the loaded set disappear from the enum.
	const dynTiers: Record<string, BudgetTierConfig> = { fast: tierConfig(), turbo: tierConfig() };
	const dynSchema = propertyJson(taskToolSchema(false, dynTiers), "budget");
	check(JSON.stringify(dynSchema.enum) === JSON.stringify(["auto", "fast", "turbo"]),
		`dynamic enum should be auto + tiers in file order, got ${JSON.stringify(dynSchema.enum)}`);
	check(!dynSchema.enum!.includes("full"), "a tier not in the loaded set must not appear in the enum");

	// The schema-locking behavior is unchanged over a dynamic set: a locked
	// tier removes the budget param entirely.
	check(!schemaProperties(taskToolSchema(true, dynTiers)).includes("budget"),
		"locked schema removes budget even with a dynamic tier set");
	check(schemaProperties(taskToolSchema(true, dynTiers)).includes("detach"),
		"detach survives schema locking over a dynamic tier set");

	console.log("✓ taskToolSchema: budget param removed when locked; enum config-driven (dynamic tiers)");
}

function testBudgetResolution(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	check(isLockedBudget("full") && isLockedBudget("economy") && isLockedBudget("free"), "concrete tiers are locked");
	check(!isLockedBudget("auto") && !isLockedBudget(undefined) && !isLockedBudget("bogus"), "auto/invalid are not locked");

	check(normalizeBudgetMode("free") === "free", "normalize keeps valid modes");
	check(normalizeBudgetMode("auto") === "auto", "normalize keeps auto");
	check(normalizeBudgetMode("bogus") === "auto" && normalizeBudgetMode(undefined) === "auto",
		"normalize degrades invalid/undefined to auto");

	// Locked CLI flag wins over everything.
	check(resolveBudgetTier("free", "full") === "free", "locked flag beats the model param");
	check(resolveBudgetTier("economy", undefined) === "economy", "locked flag alone");
	// Unlocked flag: the model's budget param is honored.
	check(resolveBudgetTier("auto", "full") === "full", "param honored when flag is auto");
	check(resolveBudgetTier(undefined, "economy") === "economy", "param honored when flag unset");
	// Neither → default tier.
	check(resolveBudgetTier("auto", "auto") === "full", "auto/auto → default full");
	check(resolveBudgetTier(undefined, undefined) === "full", "unset/unset → default full");
	// Invalid values degrade to the default.
	check(resolveBudgetTier("bogus", "bogus") === "full", "invalid values → default");

	// Runtime-realistic: getFlag("task-budget") never returns undefined —
	// the flag is registered with default "auto", so an unset flag arrives
	// as "auto". An unlocked "auto" flag falls through to the config
	// default; the requirement-count heuristic is only reached via
	// [defaults] budget = "auto".
	check(resolveBudgetMode("auto", undefined, "full") === "full", "auto flag + full default → full");
	check(resolveBudgetTier("auto", undefined, "full", 3) === "full", "auto flag + full default → full regardless of count");
	check(resolveBudgetTier("auto", undefined, "full", 8) === "full", "auto flag + full default → full for big specs too");
	check(resolveBudgetTier("auto", undefined, "auto", 3) === "economy", "config auto + 3 reqs → economy");
	check(resolveBudgetTier("auto", undefined, "auto", 8) === "full", "config auto + 8 reqs → full");
	check(resolveBudgetTier("auto", "economy", "full", 8) === "economy", "locked param beats config default");
	check(resolveBudgetTier("free", "full", "economy", 8) === "free", "locked flag beats everything");

	// ─── Phase 11: resolution over a DYNAMIC tier set ──────────────
	// A loaded config's tiers define the vocabulary: any tier in the set is
	// lockable, anything outside it (built-in or not) is not.
	const dynTiers: Record<string, BudgetTierConfig> = { fast: tierConfig(), turbo: tierConfig() };
	check(isLockedBudget("turbo", dynTiers), "a new tier is locked over the dynamic set");
	check(!isLockedBudget("max", dynTiers) && !isLockedBudget("full", dynTiers),
		"built-ins NOT in the loaded set are not locked");
	check(!isLockedBudget("auto", dynTiers) && !isLockedBudget("bogus", dynTiers), "auto/invalid never locked");
	check(normalizeBudgetMode("turbo", dynTiers) === "turbo", "normalize keeps a loaded new tier");
	check(normalizeBudgetMode("max", dynTiers) === "auto", "normalize rejects a tier outside the set");
	check(resolveBudgetTier("turbo", undefined, undefined, null, dynTiers) === "turbo", "locked new tier flag wins");
	check(resolveBudgetTier(undefined, "turbo", "full", 8, dynTiers) === "turbo", "locked new tier param beats a default outside the set");
	check(resolveBudgetTier(undefined, undefined, "auto", 3, dynTiers) === "fast",
		"auto heuristic over a set without economy/full → the default tier (first non-max)");
	// A config default naming a tier outside the set degrades to auto
	// (resolution never yields a tier that is not in the set).
	check(resolveBudgetTier(undefined, undefined, "full", 8, dynTiers) === "fast",
		"config default outside the set → auto → heuristic default tier");
	// The heuristic never auto-selects the max tier.
	const maxSet: Record<string, BudgetTierConfig> = { max: tierConfig(), ultra: tierConfig() };
	check(autoTierForRequirements(3, maxSet) === "ultra", "auto never picks the max tier");

	console.log("✓ resolveBudgetTier: locked flag > locked param > config default; normalize/isLocked; dynamic tier sets");
}

function testSubSpecsPrecedence(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// The tool's parallel derivation mirrors the orchestrator contract:
	// sub_specs wins; parallel derives from its length.
	const deriveParallel = (subSpecs: string[] | undefined, parallel: number | undefined): number =>
		subSpecs && subSpecs.length > 0 ? subSpecs.length : Math.max(1, parallel ?? 1);

	check(deriveParallel(["s1", "s2", "s3"], 2) === 3, "sub_specs wins over parallel (3 > 2)");
	check(deriveParallel(["s1"], 4) === 1, "sub_specs of length 1 wins over parallel 4");
	check(deriveParallel(undefined, 3) === 3, "no sub_specs → caller parallel");
	check(deriveParallel(undefined, undefined) === 1, "nothing → single worker");
	check(deriveParallel([], 5) === 5, "empty sub_specs falls back to parallel");

	console.log("✓ sub_specs precedence: sub_specs.length wins; empty/spec fall back");
}

function testSubSpecNormalization(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// Schema: spec is optional (not in required), and sub_specs accepts
	// BOTH markdown strings and {goal, requirements, verification, context?}
	// objects (serialized as items.anyOf — verified against typebox 1.3.7's
	// actual JSON form, no Value.Check in this version).
	const json = JSON.parse(JSON.stringify(taskToolSchema(false))) as { required?: string[] };
	check(!(json.required ?? []).includes("spec"), "spec is NOT required (optional when sub_specs is given)");
	check(!(json.required ?? []).includes("sub_specs"), "sub_specs is optional");
	const subSchema = propertyJson(taskToolSchema(false), "sub_specs") as {
		items?: { anyOf?: Array<{ type?: string; properties?: Record<string, unknown> }> };
	};
	const anyOf = subSchema.items?.anyOf;
	check(Array.isArray(anyOf) && anyOf.length === 2 && anyOf[0].type === "string", "sub_specs accepts markdown strings");
	check(
		anyOf?.[1]?.type === "object" &&
			["goal", "requirements", "verification", "context"].every((k) => k in (anyOf![1].properties ?? {})),
		"sub_specs accepts {goal, requirements, verification, context?} objects",
	);

	// Guard: neither spec nor sub_specs → a precise error naming both options.
	let guardErr = "";
	try {
		resolveSubSpecs({});
	} catch (e) {
		guardErr = (e as Error).message;
	}
	check(guardErr.includes("spec") && guardErr.includes("sub_specs"), `guard message names both options, got ${guardErr}`);

	// Normalization: strings pass through; objects render to the worker contract.
	const md = "## Goal\nx\n## Requirements\n- R1: y\n## Verification\ntrue";
	const normalized = normalizeSubSpecs([
		md,
		{ goal: "g2", requirements: ["a", "b"], verification: ["test -f x", "npm test"], context: "see docs/foo" },
	]);
	check(normalized.length === 2 && normalized[0] === md, "string entry passes through unchanged");
	const rendered = parseSpec(normalized[1]);
	check(rendered.goal === "g2", `object goal renders, got ${rendered.goal}`);
	check(JSON.stringify(rendered.requirements) === JSON.stringify(["R1: a", "R2: b"]), "object requirements render as R1/R2");
	check(JSON.stringify(rendered.verification) === JSON.stringify(["test -f x", "npm test"]), "object verification renders verbatim");
	check(normalized[1].includes("## Context") && normalized[1].includes("see docs/foo"), "context renders as a ## Context section");

	// Empty requirements/verification in an object → a precise error.
	let objErr = "";
	try {
		renderSubSpecObject({ goal: "g", requirements: [], verification: ["true"] });
	} catch (e) {
		objErr = (e as Error).message;
	}
	check(objErr.includes("requirements") && objErr.includes("verification"), `object guard message, got ${objErr}`);

	// resolveSubSpecs returns normalized strings for the orchestrator.
	const resolved = resolveSubSpecs({ sub_specs: [{ goal: "g3", requirements: ["r"], verification: ["true"] }] });
	check(resolved.hasSubSpecs && resolved.subSpecs.length === 1 && resolved.spec === "", "resolveSubSpecs normalizes object entries");
	check(
		resolveSubSpecs({ spec: "  s  " }).spec === "  s  " && !resolveSubSpecs({ spec: "  s  " }).hasSubSpecs,
		"spec path passes through",
	);

	console.log("✓ sub_specs normalization: objects ≡ markdown strings; spec optional with sub_specs; guards");
}

function testAutoHeuristicAndCounting(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// autoTierForRequirements: null → full; ≤5 → economy; ≥6 → full.
	check(autoTierForRequirements(null) === "full", "uncountable spec → full");
	check(autoTierForRequirements(0) === "economy", "0 requirements → economy");
	check(autoTierForRequirements(5) === "economy", "5 requirements → economy");
	check(autoTierForRequirements(6) === "full", "6 requirements → full");
	check(autoTierForRequirements(20) === "full", "large spec → full");

	// Phase 11: the heuristic adapts to the loaded tier set — economy/full
	// when present, else the default tier (never the max tier).
	check(autoTierForRequirements(3, { fast: tierConfig(), economy: tierConfig() }) === "economy",
		"economy present → economy for small tasks");
	check(autoTierForRequirements(8, { fast: tierConfig(), full: tierConfig() }) === "full",
		"full present → full for large tasks");
	check(autoTierForRequirements(3, { fast: tierConfig() }) === "fast",
		"no economy/full → the default tier (first non-max)");
	check(autoTierForRequirements(8, { fast: tierConfig() }) === "fast",
		"large task without full → the default tier too");
	check(autoTierForRequirements(null, { fast: tierConfig() }) === "fast",
		"uncountable spec over a set without full → the default tier");

	// countSpecRequirements: valid spec counts; invalid → null.
	const spec5 = `## Goal
X

## Requirements
- R1: a
- R2: b
- R3: c
- R4: d
- R5: e

## Verification
- true
`;
	check(countSpecRequirements(spec5) === 5, `5-item spec counts 5, got ${countSpecRequirements(spec5)}`);
	check(countSpecRequirements("no sections here") === null, "unparseable spec → null");
	check(countSpecRequirements("") === null, "empty spec → null");

	// countSubSpecsRequirements: sums parseable; all-unparseable/empty → null.
	const spec2 = `## Goal
X

## Requirements
- R1: a
- R2: b

## Verification
- true
`;
	check(countSubSpecsRequirements([spec2, spec5]) === 7, `two sub-specs sum to 7, got ${countSubSpecsRequirements([spec2, spec5])}`);
	check(countSubSpecsRequirements(["garbage"]) === null, "all-unparseable sub_specs → null");
	check(countSubSpecsRequirements([spec2, "garbage"]) === 2, "unparseable sub-spec skipped, rest counted");
	check(countSubSpecsRequirements([]) === null, "empty sub_specs → null");

	// resolveBudgetMode: locked flag > locked param > config default.
	check(resolveBudgetMode("free", "full") === "free", "locked flag beats param");
	check(resolveBudgetMode(undefined, "economy") === "economy", "locked param honored");
	check(resolveBudgetMode(undefined, undefined, "free") === "free", "config default applies when nothing locks");
	check(resolveBudgetMode("auto", "economy") === "economy", "locked param beats an auto flag");
	check(resolveBudgetMode(undefined, undefined, "auto") === "auto", "config default auto → auto");

	// resolveBudgetTier: config default + heuristic drive the auto path.
	check(resolveBudgetTier(undefined, undefined, "economy") === "economy", "config default economy when nothing locks");
	check(resolveBudgetTier(undefined, undefined, "auto", 3) === "economy", "config auto + 3 reqs → economy");
	check(resolveBudgetTier(undefined, undefined, "auto", 8) === "full", "config auto + 8 reqs → full");
	check(resolveBudgetTier("free", undefined, "full", 8) === "free", "locked flag beats heuristic");

	console.log("✓ auto heuristic + lenient counting + config-default resolution (dynamic tiers)");
}

function testBudgetOverridePersistence(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// The LAST matching pi-task-budget session entry wins (mirrors
	// checklist.ts readState): a stale earlier override must not clobber a
	// newer one when /reload replays the session entries.
	const fakeCtx = (entries: unknown[]): { sessionManager: { getEntries(): unknown[] } } => ({
		sessionManager: { getEntries: () => entries },
	});
	const budgetEntry = (mode: string, customType = "pi-task-budget"): unknown => ({
		type: "custom",
		customType,
		data: { budgetMode: mode },
	});

	check(readBudgetOverride(fakeCtx([budgetEntry("economy")])) === "economy", "single override read back");
	check(readBudgetOverride(fakeCtx([budgetEntry("economy"), budgetEntry("free")])) === "free", "latest entry wins");
	check(readBudgetOverride(fakeCtx([budgetEntry("free"), budgetEntry("economy"), budgetEntry("full")])) === "full", "last of three wins");
	check(readBudgetOverride(fakeCtx([budgetEntry("economy"), budgetEntry("auto")])) === "auto", "auto override persists too");
	check(readBudgetOverride(fakeCtx([])) === undefined, "no entries → undefined");
	check(readBudgetOverride(fakeCtx([budgetEntry("economy"), budgetEntry("bogus")])) === "auto", "invalid latest normalizes to auto");
	check(readBudgetOverride(fakeCtx([budgetEntry("free", "pi-task-other"), budgetEntry("economy")])) === "economy", "non-budget entries ignored");

	// R1: readSessionTokensBefore — the main session's pre-dispatch token
	// spend, summed from assistant message usage in the session entries
	// (reads the session the same way readBudgetOverride does).
	const msgEntry = (role: string, usage?: unknown): unknown => ({
		type: "message",
		message: { role, ...(usage !== undefined ? { usage } : {}) },
	});
	check(readSessionTokensBefore(fakeCtx([])) === 0, "no entries → 0 tokens");
	check(readSessionTokensBefore(fakeCtx([msgEntry("user"), msgEntry("toolResult")])) === 0,
		"non-assistant entries contribute 0");
	check(readSessionTokensBefore(fakeCtx([msgEntry("assistant", { totalTokens: 1000 }), msgEntry("assistant", { totalTokens: 2500 })])) === 3500,
		"assistant totalTokens summed");
	check(readSessionTokensBefore(fakeCtx([msgEntry("assistant", { input: 800, output: 200 })])) === 1000,
		"no totalTokens → input + output fallback");
	check(readSessionTokensBefore(fakeCtx([msgEntry("assistant")])) === 0, "assistant without usage → 0");
	check(readSessionTokensBefore(fakeCtx([budgetEntry("economy"), msgEntry("assistant", { totalTokens: 42 })])) === 42,
		"custom entries (budget overrides) contribute 0");

	// todo #69 regression: a /task-budget session lock must drive the task
	// call's tier even though the CLI flag value never changes. The task
	// tool handler feeds the SESSION mode (stored override, else flag) into
	// resolveBudgetTier — the raw flag alone resolves this task to full via
	// the auto heuristic (8 requirements ≥ 6), silently bypassing the lock.
	const flag = "auto"; // CLI flag is untouched by /task-budget
	const sessionMode = readBudgetOverride(fakeCtx([budgetEntry("economy")])) ?? normalizeBudgetMode(flag);
	check(sessionMode === "economy", "session_start resolution: stored override wins over the auto flag");
	const lockedTier = resolveBudgetTier(sessionMode, undefined, "full", 8);
	check(lockedTier === "economy", "locked session mode must beat config default + auto heuristic");
	check(resolveBudgetTier(flag, undefined, "full", 8) === "full", "raw flag alone resolves to full for 8 requirements — the bypass the handler fix removes");
	const plan = buildRunPlan({ tier: lockedTier, executeModel: "m" });
	check(plan.tier === "economy", "plan carries the locked tier");

	console.log("✓ readBudgetOverride: last matching session entry wins; /task-budget lock survives into the task call");
	console.log("✓ readSessionTokensBefore: assistant-message token sums (R1 main-session spend)");
}

function testGoalsPersistence(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// R1: user-owned goals live as pi-task-goals session entries — the LAST
	// matching entry wins (mirrors readBudgetOverride). They die with the
	// session: no persistent store, and only the /goals command writes them
	// (readGoals is the only goals read path; it never mutates).
	const fakeCtx = (entries: unknown[]): { sessionManager: { getEntries(): unknown[] } } => ({
		sessionManager: { getEntries: () => entries },
	});
	const goalsEntry = (goals: string, customType = "pi-task-goals"): unknown => ({
		type: "custom",
		customType,
		data: { goals },
	});

	check(readGoals(fakeCtx([])) === undefined, "no entries → no goals");
	check(readGoals(fakeCtx([goalsEntry("block algorithmic feeds")])) === "block algorithmic feeds",
		"single goals statement read back");
	check(readGoals(fakeCtx([goalsEntry("ship the feed"), goalsEntry("block algorithmic feeds")])) === "block algorithmic feeds",
		"latest goals entry wins");
	check(readGoals(fakeCtx([goalsEntry("a"), goalsEntry("b"), goalsEntry("c")])) === "c",
		"last of three wins");
	check(readGoals(fakeCtx([goalsEntry("a"), goalsEntry("   ")])) === undefined,
		"whitespace-only latest statement → no goals");
	check(readGoals(fakeCtx([goalsEntry("  keep the api small  ")])) === "keep the api small",
		"goals are trimmed on read");
	check(readGoals(fakeCtx([goalsEntry("x", "pi-task-budget"), goalsEntry("y")])) === "y",
		"non-goals entries ignored");
	check(readGoals(fakeCtx([{ type: "custom", customType: "pi-task-goals", data: { budgetMode: "economy" } }])) === undefined,
		"goals entry without a goals string → no goals");
	check(readGoals(fakeCtx([{ type: "message", message: { role: "user" } }, goalsEntry("y")])) === "y",
		"message entries ignored");

	console.log("✓ readGoals: last matching pi-task-goals session entry wins; trimmed; user-owned (command is the only writer)");
}

function testResultMapping(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// Detached dispatch text (R1): the run_id + the tracking path. The
	// returned id IS the manifest's id, and the message says exactly that.
	{
		const text = detachedDispatchText("20260805T0000-abcd", "proj", "/m/proj/20260805T0000-abcd.log");
		check(text.includes("Task detached: run 20260805T0000-abcd (project proj)"), "detached text names the run + project");
		check(text.includes("/task-status 20260805T0000-abcd"), "detached text shows the tracking command");
		check(text.includes("results/proj/20260805T0000-abcd.json"), "detached text names the manifest path");
		check(text.includes("/m/proj/20260805T0000-abcd.log"), "detached text names the log path");
	}

	const ret: TaskToolReturn = taskResultToToolReturn(fakeResult());
	check(ret.success === true && ret.tests === "passing", "mapping carries success/tests");
	check(ret.commits.length === 1 && ret.commits[0] === "abc123", "mapping carries commits");
	check(ret.files_changed.includes("hello.txt"), "mapping carries files_changed");
	check(ret.duration_ms === 65000, "mapping carries the run duration (the completion summary's latency fallback)");
	check(ret.review === null, "review is null when absent");
	check(ret.metrics === null, "metrics is null when absent");
	check(!("conflicts" in ret), "conflicts omitted when absent");
	check(ret.verification.passed === true && ret.verification.failures.length === 0, "mapping carries verification");

	// Parallel run: conflicts + workers surfaced.
	const par = taskResultToToolReturn(fakeResult({
		success: false,
		conflicts: ["a.txt"],
		workers: [],
		tests: "failing",
		verification: { passed: false, commands: 1, duration_ms: 1, failures: [{ command: "x", exitCode: 1, output: "oops" }] },
	}));
	check(par.success === false && par.tests === "failing", "failure mapped");
	check(par.conflicts !== undefined && par.conflicts.length === 1, "conflicts surfaced on parallel runs");
	check(par.verification.failures[0].exitCode === 1 && par.verification.failures[0].output === "oops",
		"verification failures carried");

	// Metrics passthrough.
	const manifest = { run_id: "r1" } as unknown as RunManifest;
	const withMetrics = taskResultToToolReturn(fakeResult({ manifest }));
	check(withMetrics.metrics === manifest, "metrics (RunManifest) passed through");

	// summarizeResult: readable one-line + expanded text.
	const summary = summarizeResult(fakeResult());
	check(summary.includes("succeeded") && summary.includes("1 commit") && summary.includes("passing"),
		`summary text, got: ${summary}`);
	check(summary.includes("hello.txt"), "summary lists files");

	// reviewSkipped (R7/R1): a requested review that did not run — parallel
	// (single-worker only) or an axis-less shape like analysis (the forked
	// review never runs on a shape with no declared axes) — is surfaced in
	// the tool return and the summary (todo #73 removed the console.warn
	// entirely).
	const skipped = taskResultToToolReturn(fakeResult({ reviewSkipped: true }));
	check(skipped.review_skipped === true,
		"review_skipped surfaced when review was requested but did not run");
	const notSkipped = taskResultToToolReturn(fakeResult());
	check(!("review_skipped" in notSkipped), "review_skipped omitted when no review was requested");
	const skippedSummary = summarizeResult(fakeResult({ reviewSkipped: true }));
	check(skippedSummary.includes("Review requested but not run"),
		`summary notes the skipped review, got: ${skippedSummary}`);

	// caveat (R2): a finalization-incomplete recovery reports success WITH
	// the caveat — surfaced in the tool return and the summary.
	const caveated = taskResultToToolReturn(fakeResult({
		caveat: "worker 1 aborted during finalization; verified post-merge — merged commit xyz, 3 file(s) changed",
	}));
	check(caveated.success === true, "finalization-incomplete recovery maps as a success");
	check(caveated.caveat !== undefined && caveated.caveat.includes("aborted during finalization"),
		`caveat surfaced in the tool return, got: ${caveated.caveat}`);
	const plain = taskResultToToolReturn(fakeResult());
	check(!("caveat" in plain), "caveat omitted when absent");
	const caveatSummary = summarizeResult(fakeResult({
		caveat: "worker 1 aborted during finalization; verified post-merge — merged commit xyz, 3 file(s) changed",
	}));
	check(caveatSummary.includes("aborted during finalization") && caveatSummary.includes("verified post-merge"),
		`summary carries the caveat, got: ${caveatSummary}`);

	console.log("✓ taskResultToToolReturn: typed mapping + conflicts/metrics/verification/review_skipped + caveat");
}

function testReviewReport(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// A finding for the summary tests — matching ReviewResult's shape.
	const finding = (id: string, priority: Finding["priority"], category: string, file: string, description: string): Finding => ({
		id,
		priority,
		confidence: 0.9,
		category,
		file,
		description,
		verification: "check",
	});

	// Mixed requirements + several findings (todo #72): the report renders
	// the verdict, per-requirement status, and each finding as
	// `[PRIORITY, category] file: description`.
	const mixed: ReviewResult = {
		verdict: "fix",
		findings: [
			finding("F1", "P1", "security", "src/auth.ts", "tokens leaked in logs"),
			finding("F2", "P2", "design", "src/api.ts", "error paths swallow failures"),
		],
		requirements: [
			{ id: "R1", status: "met" },
			{ id: "R2", status: "unmet" },
			{ id: "R3", status: "uncertain" },
		],
	};
	const report = renderReviewReport(mixed);
	check(report.startsWith("Review: fix — 2 finding(s)."), `verdict line, got: ${report.split("\n")[0]}`);
	check(report.includes("Requirements: R1: met; R2: unmet; R3: uncertain"),
		`per-requirement status, got: ${report}`);
	check(report.includes("  [P1, security] src/auth.ts: tokens leaked in logs"),
		`finding line format, got: ${report}`);
	check(report.includes("  [P2, design] src/api.ts: error paths swallow failures"), "second finding line");

	// The report flows into summarizeResult's content text (the only text
	// the conversational agent reliably reads) alongside the existing fields.
	const summary = summarizeResult(fakeResult({ review: mixed }));
	check(summary.includes("Review: fix — 2 finding(s).") && summary.includes("R2: unmet"),
		`summary carries the review report, got: ${summary}`);
	check(summary.includes("[P1, security] src/auth.ts: tokens leaked in logs"),
		"summary carries the finding lines");
	check(summary.includes("hello.txt"), "summary keeps the files field");

	// No findings (clean review): compact — verdict + requirements only, no
	// finding lines, no elision line.
	const clean: ReviewResult = {
		verdict: "ship",
		findings: [],
		requirements: [{ id: "R1", status: "met" }],
	};
	const cleanReport = renderReviewReport(clean);
	check(cleanReport === "Review: ship — 0 finding(s).\n  Requirements: R1: met",
		`clean review stays compact, got: ${JSON.stringify(cleanReport)}`);

	// The cap (todo #72): more findings than MAX_REVIEW_FINDINGS_IN_SUMMARY
	// are elided with "... and M more finding(s)" so the text stays
	// reasonable. The cap lives in index.ts (MAX_REVIEW_FINDINGS_IN_SUMMARY);
	// the test derives it from the rendered output rather than hardcoding.
	const many = Array.from({ length: 15 }, (_, i) =>
		finding(`F${i + 1}`, "P3", "test-quality", `src/f${i}.ts`, `issue ${i + 1}`));
	const capped = renderReviewReport({ verdict: "fix", findings: many, requirements: [] });
	const listed = capped.match(/^  \[P3, test-quality\]/gm)?.length ?? 0;
	check(listed === 10, `cap lists 10 findings, got ${listed}: ${capped}`);
	check(capped.includes("... and 5 more finding(s)"), `elision line, got: ${capped.split("\n").pop()}`);
	check(!capped.includes("issue 11"), "elided findings are not listed");
	check(capped.includes("issue 10"), "the last listed finding is present");

	// Exactly at the cap: no elision line.
	const atCap = renderReviewReport({ verdict: "fix", findings: many.slice(0, 10), requirements: [] });
	check(!atCap.includes("... and"), "at-cap report has no elision line");

	// Empty requirements array: no Requirements line.
	const noReqs = renderReviewReport({ verdict: "fix", findings: [], requirements: [] });
	check(noReqs === "Review: fix — 0 finding(s).", "no requirements → no Requirements line");

	console.log("✓ renderReviewReport: verdict + requirement status + finding lines, capped at MAX_REVIEW_FINDINGS_IN_SUMMARY");
}

function testRenderInPlace(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// todo #68: partial progress renders must REUSE the previous component
	// (pi's documented lastComponent pattern — see dist/core/tools/find.ts
	// renderResult/renderCall) so the TUI updates the line in place instead
	// of stacking a fresh Text per onUpdate. The live stacking behavior is
	// TUI-verified; this pins the reuse contract hermetically.
	const ctx: { lastComponent?: unknown } = {};
	const first = renderInPlace(ctx, "plan(full): work(m)");
	check(first.text === "plan(full): work(m)", "first render creates a Text with the content");
	ctx.lastComponent = first;
	const second = renderInPlace(ctx, "plan(full): work(m)\n1/1 workers done");
	check(second === first, "partial re-render must return the SAME component (no stacking)");
	check(second.text === "plan(full): work(m)\n1/1 workers done", "reused component carries the new content");

	// A missing lastComponent (first render) creates a fresh Text.
	const fresh = renderInPlace({}, "x");
	check(fresh !== first && fresh.text === "x", "no previous component → fresh Text");

	console.log("✓ renderInPlace: reuses the previous component in place; fresh Text on first render");
}

function testRunPlan(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const names = (plan: RunPlan): string[] => plan.phases.map((p) => p.name);
	const models = (plan: RunPlan): string[] => plan.phases.map((p) => p.model);

	// Full tier: all three phases in run order, each with its configured model.
	const full = buildRunPlan({
		tier: "full",
		prewalkModel: "prov/strong",
		executeModel: "prov/fast",
		reviewModel: "prov/strong",
		review: true,
	});
	check(JSON.stringify(names(full)) === JSON.stringify(["prewalk", "work", "review"]),
		`full plan phases, got ${JSON.stringify(names(full))}`);
	check(JSON.stringify(models(full)) === JSON.stringify(["prov/strong", "prov/fast", "prov/strong"]),
		`full plan models, got ${JSON.stringify(models(full))}`);

	// Economy: no prewalk phase (no distinct prewalk model).
	const economy = buildRunPlan({
		tier: "economy",
		executeModel: "prov/fast",
		reviewModel: "prov/fast",
		review: true,
	});
	check(JSON.stringify(names(economy)) === JSON.stringify(["work", "review"]),
		`economy plan omits prewalk, got ${JSON.stringify(names(economy))}`);

	// Free: no review phase (review disabled).
	const free = buildRunPlan({ tier: "free", executeModel: "prov/fast", reviewModel: "prov/fast", review: false });
	check(JSON.stringify(names(free)) === JSON.stringify(["work"]),
		`free plan omits review, got ${JSON.stringify(names(free))}`);

	// prewalk == execute auto-skips the prewalk phase (mirrors isPrewalkActive).
	const skipped = buildRunPlan({ tier: "x", prewalkModel: "prov/fast", executeModel: "prov/fast", review: false });
	check(JSON.stringify(names(skipped)) === JSON.stringify(["work"]),
		`equal prewalk/execute models drop prewalk, got ${JSON.stringify(names(skipped))}`);

	// Review model falls back to the execute model when unset.
	const fallback = buildRunPlan({ tier: "x", executeModel: "prov/fast", review: true });
	check(fallback.phases[1]?.model === "prov/fast", "review model falls back to the execute model");

	// R5: the review phase carries its OWN wall budget on the plan line
	// ("· review wall 20m"), shown ONLY when a review will run and the
	// value is set — never on a review-less plan (no review wall clause).
	const withReviewWall = buildRunPlan({
		tier: "full",
		executeModel: "prov/fast",
		reviewModel: "prov/strong",
		review: true,
		reviewWallTimeoutMs: 20 * 60_000,
	});
	check(withReviewWall.reviewWallTimeoutMs === 20 * 60_000, "plan carries the review wall");
	check(
		renderPlanLine(withReviewWall) === "plan(full): work(prov/fast) → review(prov/strong) · review wall 20m",
		`plan line carries the review wall, got: ${renderPlanLine(withReviewWall)}`,
	);
	// Goals + review wall compose in clause order (goals first).
	const goalsAndWall = buildRunPlan({
		tier: "full",
		executeModel: "prov/fast",
		reviewModel: "prov/strong",
		review: true,
		reviewWallTimeoutMs: 10 * 60_000,
		goals: "keep it small",
	});
	check(
		renderPlanLine(goalsAndWall) === "plan(full): work(prov/fast) → review(prov/strong) · goals: keep it small · review wall 10m",
		`goals then review-wall clauses, got: ${renderPlanLine(goalsAndWall)}`,
	);
	// No review phase → never a review-wall clause, even when the value is set.
	const noReviewWall = buildRunPlan({
		tier: "free",
		executeModel: "prov/fast",
		review: false,
		reviewWallTimeoutMs: 20 * 60_000,
	});
	check(!renderPlanLine(noReviewWall).includes("review wall"), "no review phase → no review-wall clause");
	const noReviewWallValue = buildRunPlan({ tier: "full", executeModel: "prov/fast", review: true });
	check(!renderPlanLine(noReviewWallValue).includes("review wall"), "review phase without a wall value → no clause");

	// R2: the session goals flow into the plan and render truncated on the
	// plan line — "goals: <statement>…" — so the dispatch linkage is visible
	// in the widget. Absent/blank goals → no goals clause (backward
	// compatible with the pre-goals plan line).
	const withGoals = buildRunPlan({ tier: "full", executeModel: "prov/fast", goals: "block algorithmic feeds" });
	check(withGoals.goals === "block algorithmic feeds", "plan carries the resolved goals");
	check(
		renderPlanLine(withGoals) === "plan(full): work(prov/fast) · goals: block algorithmic feeds",
		`plan line with goals clause, got: ${renderPlanLine(withGoals)}`,
	);
	const longGoals = "keep the feed chronological and free of engagement-baiting ranking models everywhere";
	const truncated = renderPlanLine(buildRunPlan({ tier: "full", executeModel: "prov/fast", goals: longGoals }));
	check(
		truncated.endsWith("goals: keep the feed chronological and free of engagement-baitin…"),
		`long goals truncated on the plan line, got: ${truncated}`,
	);
	check(renderGoalsClause(undefined) === "" && renderGoalsClause("") === "" && renderGoalsClause("   ") === "",
		"absent/blank goals render no clause");
	check(renderGoalsClause("keep it small") === "goals: keep it small", "goals clause prefix");
	check(truncateGoals("a".repeat(60)) === "a".repeat(60) && truncateGoals("a".repeat(61)) === "a".repeat(57) + "…",
		"truncation boundary: 60 chars kept, 61+ cut with ellipsis");
	check(truncateGoals("multi\nline\ngoal statement") === "multi line goal statement",
		"newlines collapse to a single line (no embedded newline in plan line/notify)");
	check(truncateGoals("  padded  goal  ") === "padded goal", "whitespace collapsed + trimmed");
	check(!renderPlanLine(full).includes("goals:"), "absent goals → no goals clause (backward compatible)");

	console.log("✓ buildRunPlan: phase sequence + per-phase models; tier-gated omissions");
}

function testProgressStateAndRender(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const fullPlan = buildRunPlan({
		tier: "full",
		prewalkModel: "prov/strong",
		executeModel: "prov/fast",
		reviewModel: "prov/strong",
		review: true,
	});

	// R1: the initial render — emitted synchronously at dispatch, before any
	// worker event — shows the plan line (tier + phases + models) and fresh
	// workers in the plan's first phase, with zeroed phase/total clocks.
	const state = createProgressState(1, fullPlan, 1000);
	check(state.done === 0 && state.total === 1, "initial state: 0/1");
	check(state.startMs === 1000 && state.workers.get(0)?.phaseStartMs === 1000,
		"state records the run start + per-worker phase start");
	let text = buildProgressText(state, 1000);
	check(text.startsWith("plan(full): prewalk(prov/strong) → work(prov/fast) → review(prov/strong)"),
		`initial plan line, got: ${text.split("\n")[0]}`);
	check(text.includes("0/1 workers done"), `done header, got: ${text}`);
	check(text.includes("⏳ worker-1: prewalk 0s | total 0s | no checklist yet | 0 turns, 0s idle"),
		`initial worker line (phase + durations), got: ${text.split("\n")[2]}`);

	// R2: the widget's plan line shows the resolved session goals truncated
	// ("goals: …") so the dispatch linkage is visible during the run; absent
	// goals → the plain plan line (backward compatible).
	const goalsPlan = buildRunPlan({
		tier: "full",
		prewalkModel: "prov/strong",
		executeModel: "prov/fast",
		reviewModel: "prov/strong",
		review: true,
		goals: "block algorithmic feeds before launch",
	});
	const goalsText = buildProgressText(createProgressState(1, goalsPlan, 1000), 1000);
	check(
		goalsText.split("\n")[0].includes("plan(full): prewalk(prov/strong) → work(prov/fast) → review(prov/strong) · goals: block algorithmic feeds before launch"),
		`goals clause on the widget plan line, got: ${goalsText.split("\n")[0]}`,
	);
	const plainText = buildProgressText(createProgressState(1, fullPlan, 1000), 1000);
	check(!plainText.includes("goals:"), "widget plan line without goals stays plain");

	// Tier without prewalk (economy): plan line omits prewalk; workers start in work.
	const economyPlan = buildRunPlan({ tier: "economy", executeModel: "prov/fast", reviewModel: "prov/fast", review: true });
	const eState = createProgressState(1, economyPlan, 1000);
	const eText = buildProgressText(eState, 1000);
	check(eText.startsWith("plan(economy): work(prov/fast) → review(prov/fast)"),
		`economy plan line, got: ${eText.split("\n")[0]}`);
	check(eText.includes("⏳ worker-1: work 0s | total 0s | no checklist yet"), "economy worker starts in work phase");

	// Tier without review (free): plan line omits review entirely.
	const freePlan = buildRunPlan({ tier: "free", executeModel: "prov/fast", review: false });
	const fText = buildProgressText(createProgressState(1, freePlan, 1000), 1000);
	check(fText.startsWith("plan(free): work(prov/fast)"), `free plan line, got: ${fText.split("\n")[0]}`);
	check(!fText.includes("review"), "free render mentions no review phase");

	// R2: checklist progress updates from the relayed worker state.
	applyProgressEvent(state, { type: "checklist", done: 0, total: 5 }, 2000);
	text = buildProgressText(state, 2000);
	check(text.includes("checklist 0/5"), `checklist after init, got: ${text}`);
	check(!text.includes("no checklist yet"), "initialized checklist replaces the placeholder");
	applyProgressEvent(state, { type: "checklist", done: 3, total: 5 }, 3000);
	text = buildProgressText(state, 3000);
	check(text.includes("checklist 3/5"), `checklist after check-offs, got: ${text}`);

	// R1: the merge event records the atomic-combine outcome; the render
	// shows the unambiguous success line (merged commit + file delta vs
	// base + consumed status) — the false-alarm class reported deltas
	// against a non-base reference instead.
	applyProgressEvent(state, { type: "merge", conflicts: [], commit_id: "c8e4de5f", files_changed: 19 }, 5000);
	text = buildProgressText(state, 5000);
	check(
		text.includes("merged 1 worker commit(s) → c8e4de5f (19 file(s) changed vs base; worker commits consumed)"),
		`merge success line in the progress render, got: ${text}`,
	);

	// A+B: a FRESH state so the shared `state` below stays pristine for the
	// line-index-sensitive assertions. worker_meta carries each worker's
	// goal + file scope (extracted mechanically at dispatch, no LLM);
	// tool_start surfaces the live tool; tool_end clears it.
	const metaState = createProgressState(1, fullPlan, 1000);
	applyProgressEvent(metaState, {
		type: "worker_meta",
		metas: [{ goal: "Fix the Rust side of the bot", scope: ["rust/bot/src/convert.rs", "tests/convert_integration.rs"] }],
	}, 6000);
	text = buildProgressText(metaState, 6000);
	check(
		text.includes("worker-1 → Fix the Rust side of the bot [rust/bot/src/convert.rs, tests/convert_integration.rs]"),
		`worker meta line (goal + scope), got: ${text}`,
	);
	applyProgressEvent(metaState, { type: "tool_start", toolName: "edit", args: "{path:rust/bot/src/convert.rs}" }, 7000);
	text = buildProgressText(metaState, 7000);
	check(text.includes("⎈ edit: {path:rust/bot/src/convert.rs}"), `live tool line, got: ${text}`);
	applyProgressEvent(metaState, { type: "tool_end", toolName: "edit" }, 8000);
	text = buildProgressText(metaState, 8000);
	check(!text.includes("⎈"), "tool_end clears the live tool line");

	// Analysis shape plan: the strong prewalk model is the WRITER (no
	// prewalk phase, no swap, no review phase) — what /survey dispatches.
	{
		const analysisPlan = buildRunPlan({
			tier: "full",
			prewalkModel: undefined,
			executeModel: "qwen-token-plan/qwen3.8-max-preview",
			reviewModel: "qwen-token-plan/qwen3.8-max-preview",
			review: false,
		});
		const t = buildProgressText(createProgressState(1, analysisPlan, 1000), 1000);
		check(t.startsWith("plan(full): work(qwen-token-plan/qwen3.8-max-preview)"),
			`analysis plan: strong writer, no prewalk/review, got: ${t.split("\n")[0]}`);
		// The model name qwen3.8-max-preview contains "review" as a substring —
		// check the PHASE chain, not the bare word.
		check(!t.includes("→ prewalk") && !t.includes("→ review"), "analysis plan omits prewalk + review phases");
	}

	// C: the tier wall shows as total-clock headroom.
	const wallPlan = buildRunPlan({ tier: "economy", executeModel: "prov/fast", wallTimeoutMs: 25 * 60_000 });
	const wallText = buildProgressText(createProgressState(1, wallPlan, 1000), 2000);
	check(wallText.includes("total 1s/25m"), `wall headroom in the total clock, got: ${wallText}`);
	check(!buildProgressText(state, 8000).includes("total 7s/"), "no wall suffix when the plan carries no wall");

	// extractFileScope: path tokens from spec prose, deduped + noise-filtered.
	check(
		JSON.stringify(extractFileScope("touch docs/pi-task-design.md and extensions/task/worker.ts, then verify")) ===
			JSON.stringify(["docs/pi-task-design.md", "extensions/task/worker.ts"]),
		`extractFileScope finds path tokens, got ${JSON.stringify(extractFileScope("touch docs/pi-task-design.md and extensions/task/worker.ts, then verify"))}`,
	);
	check(extractFileScope("no paths here — just prose about https://example.com/x.md and 0.83.0").length === 0,
		"extractFileScope filters URLs + version tokens");
	check(extractFileScope("a.ts a.ts b.rs c.md d.txt e.go").length === 5,
		"extractFileScope dedupes and caps at max");

	// R1+R3: liveness = turns + idle; the phase/total clocks are live vs `now`.
	applyProgressEvent(state, { type: "turn", turns: 3 }, 4000);
	text = buildProgressText(state, 16000);
	check(text.includes("3 turns, 12s idle"), `idle rendering, got: ${text.split("\n")[2]}`);
	check(text.includes("prewalk 15s | total 15s"), `phase + total elapsed, got: ${text.split("\n")[2]}`);

	// Phase transitions: prewalk → work on the FIRST SUCCESSFUL edit/write
	// (the same signal as the model swap); errored edits do not transition.
	applyProgressEvent(state, { type: "tool_end", toolName: "edit", isError: true }, 17000);
	check(state.workers.get(0)?.phase === "prewalk", "errored edit must not transition prewalk → work");
	applyProgressEvent(state, { type: "tool_end", toolName: "write", isError: false }, 17000);
	check(state.workers.get(0)?.phase === "work", "successful write transitions prewalk → work");
	text = buildProgressText(state, 17000);
	check(text.includes("⏳ worker-1: ✓prewalk → work 0s | total 16s |"),
		`R2: completed-phase checkmark on the worker line, got: ${text.split("\n")[2]}`);

	// work → review on review_start (the orchestrator emits it before forking);
	// the review clock restarts at the transition.
	applyProgressEvent(state, { type: "review_start" }, 20000);
	check(state.workers.get(0)?.phase === "review", "review_start transitions work → review");
	check(state.workers.get(0)?.phaseStartMs === 20000, "review_start restarts the phase clock");

	// yield marks the worker done; the done count recomputes (single-worker
	// runs never receive workers_progress). A done worker in review still
	// shows liveness — the forked review is running on its behalf — and the
	// full phase chain renders with completion marks.
	applyProgressEvent(state, { type: "yield" }, 21000);
	text = buildProgressText(state, 21000);
	check(text.includes("1/1 workers done"), `done header after yield, got: ${text.split("\n")[1]}`);
	check(text.includes("⏳ worker-1: ✓prewalk → ✓work → ✓review 1s | total 20s | checklist 3/5 | 3 turns, 0s idle"),
		`R2+R3: review-phase done worker line (all phases marked, live review elapsed), got: ${text.split("\n")[2]}`);

	// R3: during review the reviewer's turn/checklist events are FROZEN out
	// of the worker line (the reviewer is a separate process) while the
	// review phase clock keeps moving — the moving feedback the phase needs.
	const s4 = createProgressState(1, fullPlan, 0);
	applyProgressEvent(s4, { type: "turn", turns: 3 }, 1000);
	applyProgressEvent(s4, { type: "yield" }, 2000);
	applyProgressEvent(s4, { type: "review_start" }, 3000);
	applyProgressEvent(s4, { type: "turn", turns: 9 }, 4000); // reviewer turn — must not clobber 3
	applyProgressEvent(s4, { type: "checklist", done: 9, total: 9 }, 4000); // must not appear
	text = buildProgressText(s4, 4000);
	check(text.includes("⏳ worker-1: ✓prewalk → ✓work → ✓review 1s | total 4s | no checklist yet | 3 turns, 0s idle"),
		`R3: frozen turns/checklist + live review elapsed, got: ${text.split("\n")[2]}`);
	const laterReview = buildProgressText(s4, 9000);
	check(laterReview.includes("✓prewalk → ✓work → ✓review 6s | total 9s"),
		`R3: review elapsed moves with now, got: ${laterReview.split("\n")[2]}`);

	// A done worker OUTSIDE review is terminal: no idle field; the phase
	// chain is fully marked and the clocks are shown.
	const s2 = createProgressState(1, economyPlan, 0);
	applyProgressEvent(s2, { type: "turn", turns: 1 }, 1000);
	applyProgressEvent(s2, { type: "yield" }, 2000);
	const t2 = buildProgressText(s2, 9000);
	check(t2.includes("✓ worker-1: ✓work 9s | total 9s | no checklist yet | 1 turn"),
		`done worker line (phase elapsed + total), got: ${t2.split("\n")[2]}`);
	check(!t2.includes("idle"), "done worker outside review shows no idle");

	// Parallel: workers_progress drives the header; each worker keeps its own line.
	const s3 = createProgressState(3, economyPlan, 0);
	applyProgressEvent(s3, { type: "workers_progress", done: 2, total: 3 }, 0);
	applyProgressEvent(s3, { type: "turn", turns: 4, index: 0 }, 0);
	text = buildProgressText(s3, 0);
	check(text.includes("2/3 workers done"), `parallel header, got: ${text}`);
	check(text.includes("⏳ worker-1: work 0s | total 0s | no checklist yet | 4 turns, 0s idle"), "worker-1 running line");
	check(text.includes("⏳ worker-2: work 0s | total 0s | no checklist yet | 0 turns, 0s idle"), "worker-2 fresh line");

	// Unknown/malformed events never throw and never change the view.
	const before = buildProgressText(state, 21000);
	applyProgressEvent(state, { type: "workspace_created", index: 0, dir: "/x" }, 21000);
	applyProgressEvent(state, { type: "merge", index: 0, conflicts: [] }, 21000);
	applyProgressEvent(state, { type: "review", verdict: "ship", findings: 0, decision: "ship" }, 21000);
	applyProgressEvent(state, null, 21000);
	applyProgressEvent(state, { type: "turn" }, 21000);
	check(buildProgressText(state, 21000) === before, "unknown events change nothing");

	console.log("✓ buildProgressText: plan render, checklist, phases, checkmarks, durations, liveness, review freeze");
}

function testSummaryMetrics(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// formatDuration: the shared duration formatter ("42s", "1m05s", "2m").
	check(formatDuration(0) === "0s", `formatDuration(0), got ${formatDuration(0)}`);
	check(formatDuration(42000) === "42s", `formatDuration(42000), got ${formatDuration(42000)}`);
	check(formatDuration(65000) === "1m05s", `formatDuration(65000), got ${formatDuration(65000)}`);
	check(formatDuration(60000) === "1m", `formatDuration(60000), got ${formatDuration(60000)}`);
	check(formatDuration(120000) === "2m", `formatDuration(120000), got ${formatDuration(120000)}`);
	check(formatDuration(-5) === "0s", `formatDuration clamps negatives, got ${formatDuration(-5)}`);

	// Single-worker fixture WITH a manifest: tokens/cost/duration all come
	// from the manifest — tokens sum the prewalk+execute phase metrics, cost
	// is totals.cost_usd (includes review + fix loop), duration is
	// totals.duration_ms. The manifest wins even when result.durationMs
	// disagrees.
	const manifest: RunManifest = {
		run_id: "run-1",
		config: {
			budget: "full", prewalk_model: "prov/strong", execute_model: "prov/fast",
			review_model: "prov/strong", swap_trigger: "first-edit", checklist: true, review_forked: true, sandbox: false,
		},
		task: { spec_hash: "abc123", requirements: 1 },
		phases: {
			prewalk: { model: "prov/strong", turns: 2, tokens_in: 300, tokens_out: 150, reads: 2, edits: 0, duration_ms: 20000, cost_usd: 0.001 },
			execute: { model: "prov/fast", turns: 4, tokens_in: 700, tokens_out: 350, reads: 1, edits: 3, duration_ms: 40000, cost_usd: 0.002 },
			verify: { passed: true, commands: 1, duration_ms: 5000 },
			review: { model: "prov/strong", forked: true, context_inherited_tokens: 500, findings: 2, by_priority: { P1: 2 }, cost_usd: 0.004 },
			fix_loop: { iterations: 1, cost_usd: 0.0005 },
		},
		totals: { cost_usd: 0.0075, duration_ms: 65000, read_duplication_tokens: 0, session_files: [] },
	};
	const single = summarizeResult(fakeResult({ manifest, durationMs: 1 }));
	check(single.includes("task done in 1m05s · $0.0075 · 1/1 verified (full)"),
		`single manifest: one-line summary (duration from totals.duration_ms, cost/verify/tier from the manifest), got: ${single.split("\n")[0]}`);
	check(single.includes("Tokens: 1000 in / 500 out."), `single manifest: tokens sum phases, got: ${single}`);
	check(single.includes("$0.0075"), `single manifest: cost in the summary line, got: ${single}`);
	check(!single.includes("Took ") && !single.includes("Cost:"), "single manifest: duration/cost not duplicated (R4)");
	check(!single.includes("task done in 1s"), "manifest latency beats result.durationMs");

	// Parallel manifest: the commit line reports the merge outcome
	// unambiguously — merged commit id + file delta vs base + consumed
	// status (the false-alarm class reported deltas against a non-base
	// reference instead).
	const parallelManifest: RunManifest = {
		...manifest,
		merge: {
			resolved_union: [], conflicts: [], overlaps: [],
			worker_count: 2, merged_commit_id: "c8e4de5f", files_changed: 19,
		},
	};
	const parallel = summarizeResult(fakeResult({
		manifest: parallelManifest,
		commits: ["c8e4de5f"],
		files_changed: Array.from({ length: 19 }, (_, i) => `f${i}.txt`),
	}));
	check(
		parallel.includes("merged 2 worker commit(s) → c8e4de5f (19 file(s) changed vs base; worker commits consumed)"),
		`parallel summary reports the merge outcome, got: ${parallel.split("\n")[1]}`,
	);
	check(!parallel.includes("1 commit(s),"), "parallel summary does not use the single-worker commit phrasing");
	check(single.includes("hello.txt"), "existing summary lines stay intact");

	// Parallel fixture WITHOUT a manifest: tokens/cost aggregate the LAST
	// per-worker turnUsage snapshot; duration comes from result.durationMs.
	const par = fakeResult({
		manifest: undefined,
		durationMs: 45000,
		workers: [
			fakeWorker([{ turns: 3, tokens_in: 400, tokens_out: 200, cache_read: 0, cache_write: 0, cost_usd: 0.001, reads: 2, edits: 1 }]),
			fakeWorker([{ turns: 3, tokens_in: 600, tokens_out: 300, cache_read: 0, cache_write: 0, cost_usd: 0.002, reads: 2, edits: 1 }]),
		],
	});
	const parSummary = summarizeResult(par);
	check(parSummary.includes("task done in 45s"), `parallel no-manifest: duration from durationMs, got: ${parSummary}`);
	check(parSummary.includes("Tokens: 1000 in / 500 out."), `parallel no-manifest: last snapshots aggregated, got: ${parSummary}`);
	check(parSummary.includes("Cost: $0.003."), `parallel no-manifest: usage cost summed, got: ${parSummary}`);

	// No-manifest single-worker fixture (no usage snapshots): degrades to
	// duration-only.
	const bare = summarizeResult(fakeResult());
	check(bare.includes("task done in 1m05s"), `no-manifest single: duration still shown, got: ${bare}`);
	check(!bare.includes("Tokens:"), `no-manifest single: no tokens, got: ${bare}`);
	check(!bare.includes("Cost:"), `no-manifest single: no cost, got: ${bare}`);

	// Cost is reported only when the usage snapshots carry it (tokens still
	// derive from the same snapshots).
	const noCost = fakeResult({
		manifest: undefined,
		durationMs: 5000,
		workers: [
			fakeWorker([{ turns: 1, tokens_in: 10, tokens_out: 5, cache_read: 0, cache_write: 0, cost_usd: undefined as unknown as number, reads: 0, edits: 0 }]),
		],
	});
	const noCostSummary = summarizeResult(noCost);
	check(noCostSummary.includes("Tokens: 10 in / 5 out."), `tokens derived without cost, got: ${noCostSummary}`);
	check(!noCostSummary.includes("Cost:"), `cost omitted when usage lacks it, got: ${noCostSummary}`);

	// deriveRunMetrics directly: no manifest + no usage → duration-only shape.
	const metrics = deriveRunMetrics(fakeResult());
	check(metrics.durationMs === 65000 && metrics.tokensIn === null && metrics.tokensOut === null && metrics.costUsd === null,
		"deriveRunMetrics: no manifest + no usage → duration only");
	const manifestMetrics = deriveRunMetrics(fakeResult({ manifest }));
	check(manifestMetrics.tokensIn === 1000 && manifestMetrics.tokensOut === 500 && manifestMetrics.costUsd === 0.0075,
		"deriveRunMetrics: manifest path sums phases + totals");

	// failureMessageWithProgress (todo #86): the last progress view is
	// attached to a task failure; empty progress leaves the message bare.
	const withProgress = failureMessageWithProgress("Worker wall-timeout: ...", "plan(economy): work(prov/fast)\n1/1 workers done");
	check(withProgress.startsWith("Worker wall-timeout") && withProgress.includes("Last progress:\nplan(economy)"),
		`failure message carries the last progress, got: ${withProgress}`);
	check(failureMessageWithProgress("boom", "") === "boom", "empty progress leaves the message bare");

	console.log("✓ summarizeResult/deriveRunMetrics: one-line summary + tokens, manifest preferred, usage fallback, duration-only degradation; failureMessageWithProgress");
}

function testWorkflowContract(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// R1: the contract text comes from a pure function — compact (~120-150
	// words), covering the workflow obligations and referencing the delegation
	// skill, /build, and /plan.
	const text = workflowContractText();
	const words = text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
	check(words >= 120 && words <= 155, `contract stays compact (~120-150 words), got ${words} words`);
	check(text.startsWith("## Workflow contract"), "contract block has a header");
	check(/plan first/i.test(text) && /decompose/.test(text) && /verified before/i.test(text),
		"plan-first: decompose, sequence, verification per milestone");
	check(/delegate by default/i.test(text) && /task tool/i.test(text) && /trivial/i.test(text) && /reversible/.test(text),
		"delegate-by-default: task tool for multi-step/iterative/parallelizable/unvalidated, direct only for trivial reversible");
	check(/2-3/.test(text) && /codebase_map/.test(text) && /targeted read/.test(text) && /workers/.test(text),
		"orientation-only investigation: at most 2-3 calls (codebase_map + one targeted read) before the spec");
	check(/CONTEXT\.md/.test(text) && /shared domain language/.test(text) && /before deep work/.test(text) && /vocabulary/.test(text),
		"shared domain language: read the repo's CONTEXT.md before deep work and use its vocabulary");
	check(/WHAT, not HOW/.test(text) && /Goal/.test(text) && /Requirements/.test(text) && /Verification/.test(text) && /exits 0/.test(text),
		"spec discipline: WHAT not HOW; Goal/Requirements/Verification; verification = plain exit-0 bash");
	check(/\/goals/.test(text) && /no stated goal/.test(text) && /raised with the user/.test(text) && /not dispatched/.test(text),
		"goals: dispatches reference the current /goals; a change serving no stated goal is raised with the user, not dispatched");
	check(/\/build/.test(text) && /\/plan/.test(text) && /delegation skill/.test(text),
		"references the delegation skill, /build, and /plan");

	// R2/R4: the block is gated by the RESOLVED config — enabled → the text,
	// disabled → "" (the before_agent_start wiring skips empty results, so
	// the injection never blocks or throws).
	check(workflowContractBlock({ workflowContract: true }) === text, "enabled config → the contract text");
	check(workflowContractBlock({ workflowContract: false }) === "", "disabled config → no block");

	console.log("✓ workflowContract: pure ~120-150-word block (goals / plan-first / delegate-by-default / orientation-only / CONTEXT.md shared language / spec discipline), config-gated");
}

function testCompletionSummary(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// Minimal RunManifest fixture; mutate per case. The shape is shared by
	// single and parallel runs (parallel produces ONE aggregate manifest),
	// so the one-liner covers both paths (R2).
	const mk = (overrides: Partial<RunManifest> = {}): RunManifest => ({
		run_id: "run-1",
		config: {
			budget: "economy", prewalk_model: "prov/m", execute_model: "prov/m",
			review_model: "prov/m", swap_trigger: "first-edit", checklist: true, review_forked: false, sandbox: false,
		},
		task: { spec_hash: "abc123", requirements: 1 },
		phases: {
			prewalk: null,
			execute: { model: "prov/m", turns: 1, tokens_in: 100, tokens_out: 50, reads: 0, edits: 1, duration_ms: 60000, cost_usd: 0.005 },
			verify: { passed: true, commands: 5, duration_ms: 5000 },
			review: null,
			fix_loop: { iterations: 0, cost_usd: 0 },
		},
		totals: { cost_usd: 0.006, duration_ms: 60000, read_duplication_tokens: 0, session_files: [], files_changed: [], insertions: 0, deletions: 0 },
		...overrides,
	});

	// R1 happy path: the example's shape — latency · cost · verify status ·
	// tier. Wall clock (completed_at − received_at = 84s) wins over the
	// worker-measured totals and result.durationMs; the codebase's shared
	// duration formatter renders it as "1m24s".
	const wall = mk({
		received_at: "2026-08-06T10:00:00.000Z",
		completed_at: "2026-08-06T10:01:24.000Z",
	});
	const line = completionSummaryLine({ success: true, manifest: wall, durationMs: 1, verificationFailures: [] });
	check(line === "task done in 1m24s · $0.006 · 5/5 verified (economy)",
		`R1 one-liner (84s wall clock, 5/5 verified, economy), got: ${line}`);

	// No timestamps → the worker-measured totals.duration_ms fallback.
	const fallback = completionSummaryLine({ success: true, manifest: mk(), durationMs: 999999, verificationFailures: [] });
	check(fallback === "task done in 1m · $0.006 · 5/5 verified (economy)",
		`no timestamps → totals.duration_ms, got: ${fallback}`);

	// Inverted/unparseable timestamps degrade the same way (runLatencyMs).
	const inverted = mk({ received_at: "2026-08-06T10:01:24.000Z", completed_at: "2026-08-06T10:00:00.000Z" });
	check(completionSummaryLine({ success: true, manifest: inverted, durationMs: 0, verificationFailures: [] }) ===
		"task done in 1m · $0.006 · 5/5 verified (economy)", "inverted timestamps → totals.duration_ms fallback");

	// Failure: "task failed" and the passed count refines from the failure
	// list (the manifest only carries the passed boolean + command total).
	const fail = mk();
	fail.phases.verify = { passed: false, commands: 5, duration_ms: 5000 };
	const failed = completionSummaryLine({ success: false, manifest: fail, durationMs: 0, verificationFailures: [1, 2, 3] });
	check(failed === "task failed in 1m · $0.006 · 2/5 verified (economy)",
		`failure one-liner (2/5 passed), got: ${failed}`);

	// Tier comes from the manifest's config.budget.
	const full = mk();
	full.config.budget = "full";
	check(completionSummaryLine({ success: true, manifest: full, durationMs: 0, verificationFailures: [] }).endsWith("(full)"),
		"tier from the manifest budget");

	// No manifest → degrades to the duration only (defensive; the task tool
	// always has one).
	check(completionSummaryLine({ success: true, manifest: null, durationMs: 65000, verificationFailures: [] }) === "task done in 1m05s",
		"no manifest → duration only");
	check(completionSummaryLine({ success: false, manifest: null, durationMs: 42000, verificationFailures: [] }) === "task failed in 42s",
		"no-manifest failure degrades the same way");

	// summarizeResult integration (R2/R4): the one-liner is the FIRST line;
	// tokens stay; duration/cost are not duplicated on the manifest path.
	const withManifest = fakeResult({
		manifest: mk({ received_at: "2026-08-06T10:00:00.000Z", completed_at: "2026-08-06T10:00:42.000Z" }),
	});
	const summary = summarizeResult(withManifest);
	check(summary.split("\n")[0] === "task done in 42s · $0.006 · 5/5 verified (economy)",
		`summary first line, got: ${summary.split("\n")[0]}`);
	check(summary.includes("Tokens: 100 in / 50 out."), `tokens stay, got: ${summary}`);
	check(summary.includes("Task succeeded:"), "existing audit line stays");
	check(summary.includes("hello.txt"), "files stay");
	check(!summary.includes("Took "), "no duplicated duration (R4)");
	check(!summary.includes("Cost:"), "no duplicated cost (R4)");

	// Failure path: the one-liner says "task failed" AND the failure message
	// is right below it (the manifest's verify phase reflects the failure).
	const failManifest = mk();
	failManifest.phases.verify = { passed: false, commands: 5, duration_ms: 5000 };
	const failedResult = fakeResult({
		success: false,
		tests: "failing",
		manifest: failManifest,
		verification: {
			passed: false, commands: 5, duration_ms: 5000,
			failures: [
				{ command: "a", exitCode: 1, output: "no" },
				{ command: "b", exitCode: 1, output: "no" },
				{ command: "c", exitCode: 1, output: "no" },
			],
		},
	});
	const failedSummary = summarizeResult(failedResult);
	check(failedSummary.split("\n")[0] === "task failed in 1m · $0.006 · 2/5 verified (economy)",
		`failure first line, got: ${failedSummary.split("\n")[0]}`);
	check(failedSummary.includes("Task failed: 1 commit(s), tests failing"),
		"failure message alongside the summary line");

	// R3: the pre-dispatch main-session token spend — the one-liner appends
	// a "pre-dispatch: Nk tokens" clause when the manifest records
	// main_session_tokens > 0; absent or zero → no clause (backward
	// compatible with manifests that don't record it).
	const pre = mk({ main_session_tokens: 12000 });
	check(completionSummaryLine({ success: true, manifest: pre, durationMs: 0, verificationFailures: [] }) ===
		"task done in 1m · $0.006 · 5/5 verified (economy) · pre-dispatch: 12k tokens",
		"pre-dispatch clause appended when the manifest records the spend");
	const pre3 = mk({ main_session_tokens: 3500 });
	check(completionSummaryLine({ success: true, manifest: pre3, durationMs: 0, verificationFailures: [] }).includes("pre-dispatch: 3.5k tokens"),
		"pre-dispatch renders one-decimal k");
	const preSmall = mk({ main_session_tokens: 800 });
	check(completionSummaryLine({ success: true, manifest: preSmall, durationMs: 0, verificationFailures: [] }).includes("pre-dispatch: 800 tokens"),
		"pre-dispatch renders raw tokens below 1000");
	for (const absent of [undefined, 0]) {
		const noClause = completionSummaryLine({ success: true, manifest: mk({ main_session_tokens: absent }), durationMs: 0, verificationFailures: [] });
		check(!noClause.includes("pre-dispatch"), `no pre-dispatch clause when main_session_tokens is ${absent}`);
	}
	check(completionSummaryLine({ success: true, manifest: null, durationMs: 65000, verificationFailures: [] }) === "task done in 1m05s",
		"no manifest → no pre-dispatch clause (duration only)");

	// summarizeResult (R3): the clause is part of the completion summary's
	// first line; the worker-token line stays separate (no duplication).
	const preSummary = summarizeResult(fakeResult({ manifest: mk({ received_at: "2026-08-06T10:00:00.000Z", completed_at: "2026-08-06T10:00:42.000Z", main_session_tokens: 12345 }) }));
	check(preSummary.split("\n")[0].includes("pre-dispatch: 12.3k tokens"),
		`summarizeResult first line carries the clause, got: ${preSummary.split("\n")[0]}`);
	const noPreSummary = summarizeResult(fakeResult({ manifest: mk() }));
	check(!noPreSummary.includes("pre-dispatch"), "summarizeResult omits the clause when the manifest lacks it");

	// formatTokenCount directly: raw below 1000, one-decimal k above
	// (trailing .0 trimmed), rounding at the one-decimal digit.
	check(formatTokenCount(0) === "0 tokens" && formatTokenCount(999) === "999 tokens", "raw token counts below 1000");
	check(formatTokenCount(1000) === "1k tokens" && formatTokenCount(12000) === "12k tokens" && formatTokenCount(120000) === "120k tokens",
		"integer k trims the decimal");
	check(formatTokenCount(12345) === "12.3k tokens" && formatTokenCount(12355) === "12.4k tokens", "one-decimal k rounding");

	console.log("✓ completionSummaryLine: wall-clock latency · cost · verify status · tier; summarizeResult first line (R1/R2/R4)");
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	console.log("── test-index: schema locking + budget resolution + override persistence + sub_specs precedence + result mapping + progress ──");
	testBudgetSchemaLocking(errors);
	testBudgetResolution(errors);
	testAutoHeuristicAndCounting(errors);
	testBudgetOverridePersistence(errors);
	testGoalsPersistence(errors);
	testSubSpecsPrecedence(errors);
	testSubSpecNormalization(errors);
	testResultMapping(errors);
	testReviewReport(errors);
	testRenderInPlace(errors);
	testRunPlan(errors);
	testProgressStateAndRender(errors);
	testSummaryMetrics(errors);
	testCompletionSummary(errors);
	testWorkflowContract(errors);

	if (errors.length > 0) {
		throw new Error("test-index failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log("✓ index hermetic assertions passed");
}

// Direct execution support: `npx tsx extensions/task/test-index.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
