/**
 * pi-task-v2 router (M1.1) — pure routing decisions (docs/pi-task-v2.md
 * §5.3, §5.4; FR-9/FR-10).
 *
 * Which grounding a task gets (plan mode) and which lane it runs on is a
 * deterministic function of spec metadata, the resolved tier config, and
 * per-repo routing telemetry from the ledger's `routing_feedback` table
 * (ledger/store.ts). Everything here is pure — no I/O, no clocks, no
 * randomness — so the same input always decides identically and the mode
 * selection improves from accumulated evidence (§5.4) rather than
 * developer intuition.
 *
 * Mode selection (§5.3), most-specific first:
 *   - fork  — explicit continuation AND a live parent session (the fork
 *             inherits the parent's judgments through the continuation
 *             prune profile) AND fork telemetry shows acceptable
 *             deviation. A continuation without a live parent cannot fork:
 *             the understanding it would inherit is unreachable, so it
 *             routes to exploration (prewalk), never bundle.
 *   - cold  — trivial specs (few requirements, no continuation) skip all
 *             special grounding beyond the base repo-map slice.
 *   - bundle — tightly-scoped tasks (few requirements AND orientation
 *             notes) ONLY when this repo's bundle hit-rate telemetry backs
 *             it (never with empty feedback).
 *   - prewalk — the exploration-heavy default and the conservative
 *             fallback for everything else.
 *
 * Lane selection (FR-10): the tier config may prefer a lane; unsupported
 * lanes degrade to `interactive`.
 */

/** The four plan modes (ledger task.plan_mode vocabulary; store.ts). */
export const PLAN_MODES = ["cold", "prewalk", "bundle", "fork"] as const;
export type PlanMode = (typeof PLAN_MODES)[number];

/** Lane vocabulary (FR-10; keep in sync with ModelAssignmentSchema in
 *  contracts/payloads.ts). */
export const ROUTING_LANES = ["interactive", "flex", "batch"] as const;
export type Lane = (typeof ROUTING_LANES)[number];

/** Telemetry mode keys the router reads from routing_feedback rows.
 *  (The ledger's mode column is free text; the router narrows to these
 *  two, ignoring every other mode as non-evidence.) */
export const BUNDLE_FEEDBACK_MODE = "bundle";
export const FORK_FEEDBACK_MODE = "fork";

/** One routing_feedback-shaped row (ledger: `routing_feedback` table).
 *  `hit` means the mode succeeded: bundle grounded at turn 1 (a hit), or
 *  the fork was clean (deviation = miss). */
export interface RoutingFeedbackRow {
	repo: string;
	mode: string;
	/** Columns are INTEGER 0/1; accept boolean too for richer callers. */
	hit: boolean | number;
}

/** Aggregated telemetry for one (repo, mode) pair. */
export interface ModeRate {
	total: number;
	hits: number;
	/** hits/total, always in [0, 1]. */
	rate: number;
}

/** Named routing thresholds. R3: constants overridable via config input,
 *  never magic numbers inline. All rates are proportions in [0, 1]. */
export interface RoutingThresholds {
	/** At-or-below this requirement count a spec is trivial → cold. */
	coldMaxRequirements: number;
	/** Bundle requires at-most this many requirements. */
	bundleMaxRequirements: number;
	/** Minimum bundle samples before bundle telemetry is trusted. */
	minBundleSamples: number;
	/** Bundle grounded turn 1 this often → keep bundling. */
	bundleMinHitRate: number;
	/** Minimum fork samples before high deviation disables fork. */
	minForkSamples: number;
	/** At-or-above this fork deviation rate → stop forking. */
	forkMaxDeviationRate: number;
}

export const DEFAULT_ROUTING_THRESHOLDS: RoutingThresholds = {
	coldMaxRequirements: 1,
	bundleMaxRequirements: 3,
	minBundleSamples: 1,
	bundleMinHitRate: 0.7,
	minForkSamples: 1,
	forkMaxDeviationRate: 0.3,
};

/** Spec metadata the router decides on (§5.3 inputs). */
export interface SpecMetadata {
	requirementCount: number;
	hasOrientationNotes: boolean;
	/** True when the task continues prior conversational work (§5.2). */
	continuesPriorWork: boolean;
	/** The continuation signal points at a still-live parent session. */
	hasLiveParentSession: boolean;
}

/** The resolved budget tier (config-loaded). The router needs the tier
 *  name to carry through and the tier's preferred lane. */
export interface ResolvedTierConfig {
	name: string;
	/** Lane preferred for this tier; unsupported values degrade to
	 *  interactive (FR-10). */
	lane?: string | undefined;
}

export interface RouteInput {
	spec: SpecMetadata;
	tier: ResolvedTierConfig;
	/** Which repo is being routed — telemetry is per-repo. */
	repo: string;
	/** routing_feedback-shaped rows (empty = no evidence yet). */
	feedback: readonly RoutingFeedbackRow[];
	/** Overrides for the named thresholds (defaults if omitted). */
	thresholds?: Partial<RoutingThresholds> | undefined;
}

export interface RouteDecision {
	planMode: PlanMode;
	/** The resolved tier name (passes through from config). */
	tier: string;
	lane: Lane;
}

/** Aggregate routing_feedback-shaped rows into per-repo, per-mode rates. */
export function aggregateRoutingFeedback(
	rows: readonly RoutingFeedbackRow[],
): ReadonlyMap<string, ReadonlyMap<string, ModeRate>> {
	const byRepo = new Map<string, Map<string, ModeRate>>();
	for (const row of rows) {
		let modes = byRepo.get(row.repo);
		if (!modes) {
			modes = new Map();
			byRepo.set(row.repo, modes);
		}
		const isHit = row.hit === true || row.hit === 1;
		const cur = modes.get(row.mode) ?? { total: 0, hits: 0, rate: 0 };
		cur.total += 1;
		if (isHit) cur.hits += 1;
		cur.rate = cur.hits / cur.total;
		modes.set(row.mode, cur);
	}
	return byRepo;
}

/** Bundle hit rate for a repo's aggregated modes; null when unsampled. */
export function bundleHitRate(
	modes: ReadonlyMap<string, ModeRate> | undefined,
): number | null {
	return modes?.get(BUNDLE_FEEDBACK_MODE)?.rate ?? null;
}

/** Fork deviation rate (1 − clean rate); null when unsampled. */
export function forkDeviationRate(
	modes: ReadonlyMap<string, ModeRate> | undefined,
): number | null {
	const rate = modes?.get(FORK_FEEDBACK_MODE)?.rate;
	return rate === undefined ? null : 1 - rate;
}

/** Coerce a tier preference onto the lane vocabulary; anything unsupported
 *  (or absent) degrades to interactive (FR-10). */
export function normalizeLane(value: string | undefined): Lane {
	if (value === undefined) return "interactive";
	return (ROUTING_LANES as readonly string[]).includes(value)
		? (value as Lane)
		: "interactive";
}

/** Layer config overrides onto the named defaults (R3). */
export function resolveThresholds(
	overrides?: Partial<RoutingThresholds> | undefined,
): RoutingThresholds {
	return { ...DEFAULT_ROUTING_THRESHOLDS, ...overrides };
}

/** The pure routing decision (R1). No I/O, no clocks, no randomness. */
export function routeTask(input: RouteInput): RouteDecision {
	const count = input.spec.requirementCount;
	if (!Number.isInteger(count) || count < 0) {
		throw new TypeError(`requirementCount must be a non-negative integer, got ${count}`);
	}

	const thresholds = resolveThresholds(input.thresholds);
	const modes = aggregateRoutingFeedback(input.feedback).get(input.repo);

	// Telemetry gates (conservative when unsure: null rates never
	// support bundle nor disable fork).
	const bundleTotal = modes?.get(BUNDLE_FEEDBACK_MODE)?.total ?? 0;
	const bundleRate = bundleHitRate(modes);
	const bundleSupported =
		bundleRate !== null &&
		bundleTotal >= thresholds.minBundleSamples &&
		bundleRate >= thresholds.bundleMinHitRate;

	const forkTotal = modes?.get(FORK_FEEDBACK_MODE)?.total ?? 0;
	const deviation = forkDeviationRate(modes);
	const forkDisabled =
		deviation !== null &&
		forkTotal >= thresholds.minForkSamples &&
		deviation > thresholds.forkMaxDeviationRate;

	const spec = input.spec;
	let planMode: PlanMode;
	if (spec.continuesPriorWork && spec.hasLiveParentSession && !forkDisabled) {
		planMode = "fork";
	} else if (spec.continuesPriorWork) {
		// A continuation is exploration-heavy (the understanding it would
		// inherit is only reachable through a live fork); never bundle it.
		planMode = "prewalk";
	} else if (count <= thresholds.coldMaxRequirements) {
		planMode = "cold";
	} else if (
		spec.hasOrientationNotes &&
		count <= thresholds.bundleMaxRequirements &&
		bundleSupported
	) {
		planMode = "bundle";
	} else {
		planMode = "prewalk";
	}

	return {
		planMode,
		tier: input.tier.name,
		lane: normalizeLane(input.tier.lane),
	};
}