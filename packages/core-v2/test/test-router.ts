/**
 * Hermetic tests for the router (M1.1 — docs/pi-task-v2.md §5.3/§5.4).
 *
 * The router is a PURE decision function: no I/O, no clocks, no
 * randomness, no LLM. These tests exercise:
 *   - every plan mode reachable (cold / prewalk / bundle / fork)
 *   - continuation semantics (fork needs a live parent session; a
 *     continuation without one routes to exploration, never bundle)
 *   - feedback switching: bundle hit-rate below the threshold disables
 *     bundle for that repo; fork deviation above the threshold disables
 *     fork — per repo, never cross-repo
 *   - empty-feedback conservative defaults: never bundle, fork only on
 *     explicit continuation
 *   - the aggregation helper over routing_feedback-shaped rows
 *   - named-threshold overrides via config input
 *   - determinism: same input → same decision
 *
 * Standalone: npx tsx packages/core-v2/test/test-router.ts
 */

import { pathToFileURL } from "node:url";

import {
	BUNDLE_FEEDBACK_MODE,
	DEFAULT_ROUTING_THRESHOLDS,
	FORK_FEEDBACK_MODE,
	PLAN_MODES,
	ROUTING_LANES,
	aggregateRoutingFeedback,
	bundleHitRate,
	forkDeviationRate,
	normalizeLane,
	routeTask,
} from "../src/router/route.ts";
import type {
	ResolvedTierConfig,
	RouteInput,
	RoutingFeedbackRow,
	SpecMetadata,
} from "../src/router/route.ts";

const TIER: ResolvedTierConfig = { name: "test-tier" };
const REPO = "repo/a";

function specOf(overrides: Partial<SpecMetadata> = {}): SpecMetadata {
	return {
		requirementCount: 5,
		hasOrientationNotes: false,
		continuesPriorWork: false,
		hasLiveParentSession: false,
		...overrides,
	};
}

interface InputOverrides {
	spec?: Partial<SpecMetadata> | undefined;
	tier?: ResolvedTierConfig | undefined;
	repo?: string | undefined;
	feedback?: RoutingFeedbackRow[] | undefined;
	thresholds?: RouteInput["thresholds"] | undefined;
}

function inputOf(overrides: InputOverrides = {}): RouteInput {
	const input: RouteInput = {
		spec: specOf(overrides.spec),
		tier: overrides.tier ?? TIER,
		repo: overrides.repo ?? REPO,
		feedback: overrides.feedback ?? [],
	};
	if (overrides.thresholds !== undefined)
		input.thresholds = overrides.thresholds;
	return input;
}

function row(
	repo: string,
	mode: string,
	hit: boolean | number,
): RoutingFeedbackRow {
	return { repo, mode, hit };
}

/** n hit rows then m miss rows for (repo, mode). */
function runs(
	repo: string,
	mode: string,
	hits: number,
	misses: number,
): RoutingFeedbackRow[] {
	const out: RoutingFeedbackRow[] = [];
	for (let i = 0; i < hits; i++) out.push(row(repo, mode, 1));
	for (let i = 0; i < misses; i++) out.push(row(repo, mode, 0));
	return out;
}

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// ─── Every plan mode reachable ─────────────────────────────────────
	{
		// (d) cold — trivial spec, no continuation.
		const cold = routeTask(inputOf({ spec: { requirementCount: 1 } }));
		check(
			cold.planMode === "cold",
			`trivial spec → cold, got ${cold.planMode}`,
		);
		check(
			cold.tier === "test-tier" && cold.lane === "interactive",
			"tier name + default lane pass through",
		);

		// (a) prewalk — exploration-heavy default (high count, no notes).
		const prewalk = routeTask(inputOf({ spec: { requirementCount: 9 } }));
		check(
			prewalk.planMode === "prewalk",
			`exploration-heavy → prewalk, got ${prewalk.planMode}`,
		);

		// (b) bundle — well-scoped AND telemetry supports it.
		const bundle = routeTask(
			inputOf({
				spec: { requirementCount: 2, hasOrientationNotes: true },
				feedback: runs(REPO, BUNDLE_FEEDBACK_MODE, 1, 0),
			}),
		);
		check(
			bundle.planMode === "bundle",
			`well-scoped + supported telemetry → bundle, got ${bundle.planMode}`,
		);

		// (c) fork — explicit continuation with a live parent session.
		const fork = routeTask(
			inputOf({
				spec: {
					requirementCount: 4,
					continuesPriorWork: true,
					hasLiveParentSession: true,
				},
			}),
		);
		check(
			fork.planMode === "fork",
			`continuation + live parent → fork, got ${fork.planMode}`,
		);

		const modes = new Set([
			cold.planMode,
			prewalk.planMode,
			bundle.planMode,
			fork.planMode,
		]);
		check(
			modes.size === 4 && PLAN_MODES.every((m) => modes.has(m)),
			"all four plan modes reachable",
		);
	}

	// ─── Lane normalization (FR-10: unsupported lanes degrade) ────────
	{
		const batch = routeTask(inputOf({ tier: { name: "t", lane: "batch" } }));
		check(batch.lane === "batch", "tier lane 'batch' passes through");
		const flex = routeTask(inputOf({ tier: { name: "t", lane: "flex" } }));
		check(flex.lane === "flex", "tier lane 'flex' passes through");
		const bogus = routeTask(
			inputOf({ tier: { name: "t", lane: "carrier-pigeon" } }),
		);
		check(
			bogus.lane === "interactive",
			`unsupported lane degrades to interactive, got ${bogus.lane}`,
		);
		check(
			normalizeLane(undefined) === "interactive",
			"absent lane defaults to interactive",
		);
		check(
			ROUTING_LANES.length === 3 && ROUTING_LANES.includes("interactive"),
			"lane vocabulary (FR-10)",
		);
	}

	// ─── Continuation semantics ────────────────────────────────────────
	{
		// Continuation WITHOUT a live parent cannot fork; it routes to
		// exploration (prewalk), never bundle — the understanding it
		// continues is unreachable.
		const orphan = routeTask(
			inputOf({
				spec: {
					requirementCount: 2,
					hasOrientationNotes: true,
					continuesPriorWork: true,
					hasLiveParentSession: false,
				},
				feedback: runs(REPO, BUNDLE_FEEDBACK_MODE, 5, 0),
			}),
		);
		check(
			orphan.planMode === "prewalk",
			`continuation without live parent → prewalk, got ${orphan.planMode}`,
		);

		// Continuation + live parent, but fork telemetry is bad → prewalk.
		const dirtyFork = routeTask(
			inputOf({
				spec: { continuesPriorWork: true, hasLiveParentSession: true },
				feedback: runs(REPO, FORK_FEEDBACK_MODE, 1, 2),
			}),
		);
		check(
			dirtyFork.planMode === "prewalk",
			`fork disabled by deviation telemetry → prewalk, got ${dirtyFork.planMode}`,
		);
	}

	// ─── Feedback switching ────────────────────────────────────────────
	{
		const bundleSpec = { requirementCount: 2, hasOrientationNotes: true };

		// Hit-rate below threshold (1/3 < 0.7) disables bundle.
		const low = routeTask(
			inputOf({
				spec: bundleSpec,
				feedback: runs(REPO, BUNDLE_FEEDBACK_MODE, 1, 2),
			}),
		);
		check(
			low.planMode === "prewalk",
			`bundle hit-rate below threshold disables bundle, got ${low.planMode}`,
		);

		// Hit-rate at/above threshold (3/4 = 0.75 ≥ 0.7) keeps bundle.
		const high = routeTask(
			inputOf({
				spec: bundleSpec,
				feedback: runs(REPO, BUNDLE_FEEDBACK_MODE, 3, 1),
			}),
		);
		check(
			high.planMode === "bundle",
			`bundle hit-rate above threshold keeps bundle, got ${high.planMode}`,
		);

		// Inclusive boundary: exactly the threshold (7/10 = 0.7) still bundles.
		const exact = routeTask(
			inputOf({
				spec: bundleSpec,
				feedback: runs(REPO, BUNDLE_FEEDBACK_MODE, 7, 3),
			}),
		);
		check(
			exact.planMode === "bundle",
			`bundle hit-rate exactly at threshold keeps bundle, got ${exact.planMode}`,
		);

		// Fork deviation above threshold (2/3 > 0.3) disables fork.
		const forkSpec = { continuesPriorWork: true, hasLiveParentSession: true };
		const deviant = routeTask(
			inputOf({
				spec: forkSpec,
				feedback: runs(REPO, FORK_FEEDBACK_MODE, 1, 2),
			}),
		);
		check(
			deviant.planMode !== "fork",
			`fork deviation above threshold disables fork, got ${deviant.planMode}`,
		);

		// Clean fork history keeps fork.
		const clean = routeTask(
			inputOf({
				spec: forkSpec,
				feedback: runs(REPO, FORK_FEEDBACK_MODE, 2, 0),
			}),
		);
		check(
			clean.planMode === "fork",
			`clean fork telemetry keeps fork, got ${clean.planMode}`,
		);

		// Per-repo isolation: telemetry for repo/b must not route repo/a.
		const isolated = routeTask(
			inputOf({
				spec: bundleSpec,
				feedback: runs("repo/b", BUNDLE_FEEDBACK_MODE, 0, 9),
			}),
		);
		check(
			isolated.planMode === "prewalk",
			"no telemetry for THIS repo → never bundle (conservative)",
		);
		const isolatedFork = routeTask(
			inputOf({
				spec: forkSpec,
				feedback: runs("repo/b", FORK_FEEDBACK_MODE, 0, 9),
			}),
		);
		check(
			isolatedFork.planMode === "fork",
			"other-repo fork telemetry does not disable fork here",
		);

		// Unrelated telemetry modes are ignored by the router.
		const unrelated = routeTask(
			inputOf({
				spec: bundleSpec,
				feedback: runs(REPO, "prewalk", 0, 9),
			}),
		);
		check(
			unrelated.planMode === "prewalk",
			"non-bundle/fork feedback rows never enable bundle",
		);
	}

	// ─── Empty-feedback conservative defaults ──────────────────────────
	{
		// Bundle-eligible spec but zero telemetry → never bundle.
		const noBundle = routeTask(
			inputOf({
				spec: { requirementCount: 2, hasOrientationNotes: true },
			}),
		);
		check(
			noBundle.planMode !== "bundle",
			`empty feedback never bundles, got ${noBundle.planMode}`,
		);

		// No continuation signal → never fork, telemetry or not.
		const noFork = routeTask(
			inputOf({
				spec: { requirementCount: 9 },
				feedback: [
					...runs(REPO, BUNDLE_FEEDBACK_MODE, 9, 0),
					...runs(REPO, FORK_FEEDBACK_MODE, 9, 0),
				],
			}),
		);
		check(
			noFork.planMode !== "fork",
			`fork requires explicit continuation, got ${noFork.planMode}`,
		);

		// Fork on explicit continuation is allowed with empty feedback
		// (no evidence against it yet).
		const forkEmpty = routeTask(
			inputOf({
				spec: { continuesPriorWork: true, hasLiveParentSession: true },
			}),
		);
		check(
			forkEmpty.planMode === "fork",
			"empty feedback: fork allowed on explicit continuation",
		);
	}

	// ─── Aggregation helper ────────────────────────────────────────────
	{
		const rows: RoutingFeedbackRow[] = [
			row("repo/a", "bundle", 1),
			row("repo/a", "bundle", true),
			row("repo/a", "bundle", 0),
			row("repo/a", "fork", false),
			row("repo/b", "bundle", 1),
		];
		const agg = aggregateRoutingFeedback(rows);
		const aBundle = agg.get("repo/a")?.get("bundle");
		check(
			aBundle !== undefined && aBundle.total === 3 && aBundle.hits === 2,
			"per-repo per-mode totals + hits",
		);
		check(
			aBundle !== undefined && Math.abs(aBundle.rate - 2 / 3) < 1e-12,
			"hit rate computed",
		);
		const aFork = agg.get("repo/a")?.get("fork");
		check(
			aFork !== undefined && aFork.total === 1 && aFork.hits === 0,
			"boolean hits normalized",
		);
		check(
			agg.get("repo/b")?.get("bundle")?.total === 1,
			"per-repo partitioning",
		);
		check(
			aggregateRoutingFeedback([]).size === 0,
			"empty input → empty aggregate",
		);

		check(
			bundleHitRate(undefined) === null,
			"bundleHitRate: no samples → null",
		);
		check(
			forkDeviationRate(undefined) === null,
			"forkDeviationRate: no samples → null",
		);
		const modes = agg.get("repo/a")!;
		check(
			bundleHitRate(modes) === aBundle!.rate,
			"bundleHitRate reads the bundle mode",
		);
		check(
			forkDeviationRate(modes) === 1,
			"forkDeviationRate = 1 - clean rate (0/1 clean → 1.0 deviation)",
		);
	}

	// ─── Threshold overrides via config input ──────────────────────────
	{
		const lowHitRepo = runs(REPO, BUNDLE_FEEDBACK_MODE, 1, 2); // rate 1/3
		const lenient = routeTask(
			inputOf({
				spec: { requirementCount: 2, hasOrientationNotes: true },
				feedback: lowHitRepo,
				thresholds: { bundleMinHitRate: 0.25 },
			}),
		);
		check(
			lenient.planMode === "bundle",
			`lowered bundleMinHitRate re-enables bundle, got ${lenient.planMode}`,
		);

		const strictCold = routeTask(
			inputOf({
				spec: { requirementCount: 2, hasOrientationNotes: true },
				feedback: runs(REPO, BUNDLE_FEEDBACK_MODE, 5, 0),
				thresholds: { coldMaxRequirements: 2 },
			}),
		);
		check(
			strictCold.planMode === "cold",
			`raised coldMaxRequirements routes count-2 to cold, got ${strictCold.planMode}`,
		);

		const tolerantFork = routeTask(
			inputOf({
				spec: { continuesPriorWork: true, hasLiveParentSession: true },
				feedback: runs(REPO, FORK_FEEDBACK_MODE, 1, 2), // deviation 2/3
				thresholds: { forkMaxDeviationRate: 0.9 },
			}),
		);
		check(
			tolerantFork.planMode === "fork",
			`raised forkMaxDeviationRate re-enables fork, got ${tolerantFork.planMode}`,
		);

		// Defaults are named constants, not inline magic.
		check(
			typeof DEFAULT_ROUTING_THRESHOLDS.bundleMinHitRate === "number" &&
				typeof DEFAULT_ROUTING_THRESHOLDS.coldMaxRequirements === "number" &&
				typeof DEFAULT_ROUTING_THRESHOLDS.bundleMaxRequirements === "number" &&
				typeof DEFAULT_ROUTING_THRESHOLDS.forkMaxDeviationRate === "number",
			"default thresholds exported as named constants",
		);
	}

	// ─── Boundary: requirement-count cutoffs ───────────────────────────
	{
		const atCold = routeTask(
			inputOf({
				spec: {
					requirementCount: DEFAULT_ROUTING_THRESHOLDS.coldMaxRequirements,
				},
			}),
		);
		const pastCold = routeTask(
			inputOf({
				spec: {
					requirementCount: DEFAULT_ROUTING_THRESHOLDS.coldMaxRequirements + 1,
				},
			}),
		);
		check(
			atCold.planMode === "cold" && pastCold.planMode !== "cold",
			"cold cutoff inclusive at the threshold",
		);

		const atBundle = routeTask(
			inputOf({
				spec: {
					requirementCount: DEFAULT_ROUTING_THRESHOLDS.bundleMaxRequirements,
					hasOrientationNotes: true,
				},
				feedback: runs(REPO, BUNDLE_FEEDBACK_MODE, 4, 0),
			}),
		);
		const pastBundle = routeTask(
			inputOf({
				spec: {
					requirementCount:
						DEFAULT_ROUTING_THRESHOLDS.bundleMaxRequirements + 1,
					hasOrientationNotes: true,
				},
				feedback: runs(REPO, BUNDLE_FEEDBACK_MODE, 4, 0),
			}),
		);
		check(
			atBundle.planMode === "bundle" && pastBundle.planMode === "prewalk",
			`bundle cutoff inclusive at the threshold (got ${atBundle.planMode}/${pastBundle.planMode})`,
		);
	}

	// ─── Determinism ───────────────────────────────────────────────────
	{
		const input = inputOf({
			spec: { requirementCount: 2, hasOrientationNotes: true },
			feedback: [
				...runs(REPO, BUNDLE_FEEDBACK_MODE, 3, 1),
				...runs(REPO, FORK_FEEDBACK_MODE, 1, 0),
				row("repo/b", "bundle", 0),
			],
		});
		const first = JSON.stringify(routeTask(input));
		let stable = true;
		for (let i = 0; i < 10; i++) {
			if (JSON.stringify(routeTask(input)) !== first) stable = false;
		}
		check(stable, "repeated calls on the same input are identical");

		// A structurally-equal input built independently decides identically.
		const rebuilt = inputOf({
			spec: { requirementCount: 2, hasOrientationNotes: true },
			feedback: [
				...runs(REPO, BUNDLE_FEEDBACK_MODE, 3, 1),
				...runs(REPO, FORK_FEEDBACK_MODE, 1, 0),
				row("repo/b", "bundle", 0),
			],
		});
		check(
			JSON.stringify(routeTask(rebuilt)) === first,
			"structurally-equal inputs decide identically",
		);
	}

	// ─── Input validation (still pure — throws, never reads I/O) ───────
	{
		const expectThrow = (fn: () => void): string => {
			try {
				fn();
				return "";
			} catch (err) {
				return err instanceof Error ? err.message : String(err);
			}
		};
		check(
			expectThrow(() =>
				routeTask(inputOf({ spec: { requirementCount: -1 } })),
			) !== "",
			"negative requirement count rejected",
		);
		check(
			expectThrow(() =>
				routeTask(inputOf({ spec: { requirementCount: 1.5 } })),
			) !== "",
			"non-integer requirement count rejected",
		);
	}

	if (errors.length > 0) {
		throw new Error("test-router failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log(
		"✓ router: all modes reachable, feedback switching, empty-feedback defaults, determinism",
	);
	return Promise.resolve();
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		});
}
