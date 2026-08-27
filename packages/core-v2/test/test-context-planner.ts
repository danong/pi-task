/** Pure M4 context need, budget, selection, and cache-plan tests. */
import { pathToFileURL } from "node:url";

import { ContextItemSchema } from "../src/contracts/context-lifecycle.ts";
import { deriveInformationNeeds, planContext } from "../src/context/planner.ts";

function candidate(
	id: string,
	score: number,
	tokens = 10,
	sensitivity:
		"public" | "internal" | "confidential" | "restricted" = "internal",
) {
	return ContextItemSchema.parse({
		version: 1,
		id,
		kind: "candidate",
		label: id,
		summary: `summary ${id}`,
		provenance: {
			providerId: "fixture",
			providerVersion: "1",
			source: "fixture",
			sourceRevision: "rev-1",
			selector: "test",
		},
		freshness: {
			revision: "rev-1",
			observedAtRevision: "rev-1",
			state: "fresh",
		},
		sensitivity,
		size: { characters: tokens * 4, tokens },
		requirementIds: ["R1"],
		score,
	});
}

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (value: boolean, message: string): void => {
		if (!value) errors.push(message);
	};
	const needs = deriveInformationNeeds({
		goal: "change parser",
		requirements: ["reject unsafe input"],
		checkpoint: { openQuestions: ["where is ingress?"] },
	}).needs;
	check(
		needs.length === 3 && needs[0]?.requirementId === "goal",
		"information needs preserve deterministic goal/requirement/checkpoint priority",
	);
	const plan = planContext({
		goal: "change parser",
		requirements: ["reject unsafe input"],
		candidates: [
			candidate("low", 1),
			candidate("high", 10),
			candidate("secret", 20, 10, "restricted"),
		],
		sourceRevision: "rev-1",
		modelId: "cheap/model",
		toolSchemaIdentity: "worker-tools-v1:read,yield",
		allowedSensitivity: "internal",
		budgets: {
			economic: { maxUncachedTokens: 20, maxProviderCacheWriteTokens: 20 },
			window: { maxTokens: 40, reserveTokens: 20 },
			attention: { maxItems: 2, maxVolatileSegments: 0 },
		},
		cacheCapabilities: {
			providerPrefixCaching: true,
			compatibleModels: ["other/model"],
		},
	});
	check(
		plan.selected.map((entry) => entry.id).join(",") === "high,low",
		"planner ranks deterministically within all budgets",
	);
	check(
		plan.omissions.some(
			(entry) =>
				entry.candidateId === "secret" && entry.reason === "sensitivity",
		),
		"planner reports sensitivity omissions",
	);
	check(
		!plan.cache.compatible && plan.cache.strategy !== "provider-prefix",
		"provider cache reuse is disabled for an incompatible model",
	);
	check(
		plan.cache.toolSchemaIdentity === "worker-tools-v1:read,yield",
		"tool schema participates in cache affinity",
	);
	const cacheLimited = planContext({
		goal: "goal",
		requirements: [],
		candidates: [candidate("large", 1, 11)],
		sourceRevision: "rev-1",
		cacheCapabilities: { providerPrefixCaching: true },
		budgets: {
			economic: { maxUncachedTokens: 100, maxProviderCacheWriteTokens: 10 },
			window: { maxTokens: 100, reserveTokens: 10 },
			attention: { maxItems: 4, maxVolatileSegments: 0 },
		},
	});
	check(
		cacheLimited.selected.length === 0 &&
			cacheLimited.omissions[0]?.reason === "cache-write-budget",
		"provider cache writes have an independent economic limit",
	);
	const costLimited = planContext({
		goal: "goal",
		requirements: [],
		candidates: [candidate("priced", 1, 100)],
		sourceRevision: "rev-1",
		cacheCapabilities: { inputCostUsdPerMillion: 10 },
		budgets: {
			economic: {
				maxInputCostUsd: 0.0005,
				maxUncachedTokens: 1_000,
				maxProviderCacheWriteTokens: 1_000,
			},
			window: { maxTokens: 1_000, reserveTokens: 100 },
			attention: { maxItems: 4, maxVolatileSegments: 0 },
		},
	});
	check(
		costLimited.omissions[0]?.reason === "economic-cost-budget",
		"USD budgets use declared input pricing",
	);
	let missingPriceRejected = false;
	try {
		planContext({
			goal: "goal",
			requirements: [],
			sourceRevision: "rev-1",
			budgets: {
				economic: {
					maxInputCostUsd: 1,
					maxUncachedTokens: 1,
					maxProviderCacheWriteTokens: 1,
				},
			},
		});
	} catch {
		missingPriceRejected = true;
	}
	check(
		missingPriceRejected,
		"an explicit USD cap cannot silently proceed without pricing",
	);
	if (errors.length > 0)
		throw new Error(
			`test-context-planner failed:\n  ✗ ${errors.join("\n  ✗ ")}`,
		);
	console.log(
		"✓ context-planner: deterministic needs, budgets, omissions, and cache affinity",
	);
	return Promise.resolve();
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
