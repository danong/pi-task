/**
 * Grounding configs — M3 (docs/pi-task-v2.md §5.3, §7).
 *
 * Enumerates the v2 grounding modes the suite-03 harness scores against
 * each other. The fixture and spec counts live in the owner file
 * `extensions/task/bench-regression.ts` (GROUNDING_SPECS, GROUNDING_LAYERS)
 * — this module owns the *mode* vocabulary, not the fixture.
 *
 * Modes (router planMode vocabulary, src/router/route.ts):
 *   cold    — repo-map slice only, no special grounding
 *   prewalk — strong explore then swap to cheap on first edit
 *   bundle  — ExecutionBundle on turn 1 (≤200 tok/file)
 *   fork    — pruned continuation from a live parent session
 *
 * Hosts (where the session runs):
 *   bare       — single long-context session, no driver
 *   engine-v1  — current in-process engine (v1 orchestrator)
 *   daemon     — v2 daemon (in-process SDK sessions, ledger, router)
 *
 * Strong-model variants are pinned configs, never baseline changes (§7):
 * same mode + same spec, different model id, gated behind a flag/env so
 * the dry path never spends.
 */

import type { PlanMode } from "../router/route.ts";

export type GroundingHost = "bare" | "engine-v1" | "daemon";

export interface GroundingConfig {
	/** Stable id — also the evidence key (grounding-<id>). */
	id: string;
	/** Human label for reports. */
	label: string;
	/** Where the session runs. */
	host: GroundingHost;
	/** Router planMode when daemon-hosted; null = no router (bare/engine). */
	planMode: PlanMode | null;
	/** One-line description for the plan rendering. */
	description: string;
	/** True when the config pins a stronger model — gated, never default. */
	strongModel: boolean;
	/** Prune profile name when the mode carries one (fork). */
	pruneProfile?: string | null;
	/** Model id when pinned (strong variants); null = tier default. */
	modelId?: string | null;
}

/**
 * Canonical enumeration — every mode the thesis discriminates between.
 * Strong-model variants are included but gated (see includeStrong flag).
 * Do not hardcode fixture counts here — see bench-regression.ts.
 */
export const GROUNDING_CONFIGS: readonly GroundingConfig[] = [
	{
		id: "bare",
		label: "bare long-context",
		host: "bare",
		planMode: null,
		description: "single long-context session — spec + raw reads, no repo-map",
		strongModel: false,
	},
	{
		id: "engine-v1",
		label: "current in-process engine",
		host: "engine-v1",
		planMode: null,
		description: "v1 orchestrator — repo-map slice, no daemon routing",
		strongModel: false,
	},
	{
		id: "daemon-cold",
		label: "v2 daemon (cold)",
		host: "daemon",
		planMode: "cold",
		description: "v2 daemon cold start — repo-map slice only",
		strongModel: false,
	},
	{
		id: "daemon-prewalk",
		label: "v2 daemon (prewalk)",
		host: "daemon",
		planMode: "prewalk",
		description:
			"v2 daemon prewalk — strong explore, swap to cheap on first edit",
		strongModel: false,
	},
	{
		id: "daemon-bundle",
		label: "v2 daemon (bundle)",
		host: "daemon",
		planMode: "bundle",
		description:
			"v2 daemon bundle — ExecutionBundle on turn 1 (miss → exploration)",
		strongModel: false,
	},
	{
		id: "daemon-fork",
		label: "v2 daemon (fork)",
		host: "daemon",
		planMode: "fork",
		description: "v2 daemon fork — continuation from live parent session",
		strongModel: false,
		pruneProfile: "continuation",
	},
	{
		id: "daemon-fork-pruned",
		label: "v2 daemon (fork-pruned)",
		host: "daemon",
		planMode: "fork",
		description:
			"v2 daemon fork through explicit prune profile (judgment, not transcript)",
		strongModel: false,
		pruneProfile: "continuation-pruned",
	},
	// Pinned strong-model variants — gated, never baseline changes (§7).
	{
		id: "daemon-prewalk-strong",
		label: "v2 daemon (prewalk-strong)",
		host: "daemon",
		planMode: "prewalk",
		description:
			"prewalk with pinned strong model (gated — not a baseline change)",
		strongModel: true,
		modelId: "openrouter/anthropic/claude-strong",
	},
	{
		id: "daemon-bundle-strong",
		label: "v2 daemon (bundle-strong)",
		host: "daemon",
		planMode: "bundle",
		description:
			"bundle with pinned strong model (gated — not a baseline change)",
		strongModel: true,
		modelId: "openrouter/anthropic/claude-strong",
	},
] as const;

/** All config ids (for --config validation). */
export const GROUNDING_CONFIG_IDS = GROUNDING_CONFIGS.map((c) => c.id);

/** Lookup by id — undefined when unknown. */
export function findGroundingConfig(id: string): GroundingConfig | undefined {
	return GROUNDING_CONFIGS.find((c) => c.id === id);
}

/** True when the config requires the strong-model gate. */
export function isStrongConfig(config: GroundingConfig): boolean {
	return config.strongModel;
}

/** Filter configs by gate and optional allow-list. Pure. */
export function filterConfigs(opts: {
	includeStrong: boolean;
	configFilter?: string[];
}): GroundingConfig[] {
	let configs = [...GROUNDING_CONFIGS];
	if (!opts.includeStrong) {
		configs = configs.filter((c) => !c.strongModel);
	}
	if (opts.configFilter && opts.configFilter.length > 0) {
		const unknown = opts.configFilter.filter(
			(id) => !configs.some((c) => c.id === id),
		);
		// If the filter names a strong id while gated off, report it as unknown
		// (the caller gated it — they should pass --allow-strong).
		if (unknown.length > 0) {
			const allUnknown = opts.configFilter.filter(
				(id) => !GROUNDING_CONFIGS.some((c) => c.id === id),
			);
			if (allUnknown.length > 0) {
				throw new Error(
					`--config matched no known grounding config: ${allUnknown.join(", ")} (known: ${GROUNDING_CONFIG_IDS.join(", ")})`,
				);
			}
			throw new Error(
				`--config includes gated strong configs: ${unknown.join(", ")} — pass --allow-strong or set PI_TASK_ALLOW_STRONG=1`,
			);
		}
		configs = configs.filter((c) => opts.configFilter!.includes(c.id));
	}
	return configs;
}
