/** Pure kernel context planning: needs, deduplication, omissions, and budgets. */
import { createHash } from "node:crypto";
import {
	ContextCacheCapabilitiesSchema,
	ContextItemSchema,
	ContextPlanSchema,
	type AttentionBudget,
	type ContextBudgets,
	type ContextCacheCapabilities,
	type ContextItem,
	type ContextNeed,
	type ContextPlan,
	type EconomicBudget,
	type ImmutableArtifactReference,
	type WindowBudget,
} from "../contracts/context-lifecycle.ts";
import { stableStringify } from "../contracts/serialize.ts";

export const DEFAULT_CONTEXT_BUDGETS: ContextBudgets = {
	economic: { maxUncachedTokens: 8_000, maxProviderCacheWriteTokens: 4_000 },
	window: { maxTokens: 8_000, reserveTokens: 2_000 },
	attention: { maxItems: 24, maxVolatileSegments: 4 },
};
export const DEFAULT_CACHE_CAPABILITIES: ContextCacheCapabilities = {
	localArtifactReuse: true,
	providerPrefixCaching: false,
	inSessionReuse: false,
	compatibleModels: [],
	attribution: "unavailable",
};
function idFor(value: unknown): string {
	return `ctx-${createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24)}`;
}
function clean(value: string, max: number): string {
	return value.trim().slice(0, max);
}
function positive(value: number, fallback: number): number {
	return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
function budgetsFor(
	input: Partial<ContextBudgets> | undefined,
): ContextBudgets {
	const economic: EconomicBudget = {
		...DEFAULT_CONTEXT_BUDGETS.economic,
		...(input?.economic ?? {}),
	};
	const window: WindowBudget = {
		...DEFAULT_CONTEXT_BUDGETS.window,
		...(input?.window ?? {}),
	};
	const attention: AttentionBudget = {
		...DEFAULT_CONTEXT_BUDGETS.attention,
		...(input?.attention ?? {}),
	};
	return {
		economic: {
			...economic,
			maxUncachedTokens: positive(
				economic.maxUncachedTokens,
				DEFAULT_CONTEXT_BUDGETS.economic.maxUncachedTokens,
			),
			maxProviderCacheWriteTokens: positive(
				economic.maxProviderCacheWriteTokens,
				DEFAULT_CONTEXT_BUDGETS.economic.maxProviderCacheWriteTokens,
			),
		},
		window: {
			...window,
			maxTokens: positive(
				window.maxTokens,
				DEFAULT_CONTEXT_BUDGETS.window.maxTokens,
			),
			reserveTokens: positive(
				window.reserveTokens,
				DEFAULT_CONTEXT_BUDGETS.window.reserveTokens,
			),
		},
		attention: {
			...attention,
			maxItems: positive(
				attention.maxItems,
				DEFAULT_CONTEXT_BUDGETS.attention.maxItems,
			),
			maxVolatileSegments: positive(
				attention.maxVolatileSegments,
				DEFAULT_CONTEXT_BUDGETS.attention.maxVolatileSegments,
			),
		},
	};
}
export interface ContextPlanningInput {
	goal: string;
	requirements: readonly string[];
	candidates?: readonly ContextItem[];
	checkpoint?: {
		openQuestions?: readonly string[];
		nextActions?: readonly string[];
	};
	sourceRevision: string;
	budgets?: Partial<ContextBudgets>;
	cacheCapabilities?: Partial<ContextCacheCapabilities>;
	modelId?: string;
	toolSchemaIdentity?: string;
	mode?: "raw" | "managed";
	allowedSensitivity?: ContextItem["sensitivity"];
}
export interface ContextNeedDerivation {
	needs: ContextNeed[];
}

export function deriveInformationNeeds(
	input: Pick<ContextPlanningInput, "goal" | "requirements" | "checkpoint">,
): ContextNeedDerivation {
	const needs: ContextNeed[] = [];
	const add = (
		requirementId: string,
		query: string,
		priority: number,
	): void => {
		const normalized = clean(query, 512);
		if (
			normalized.length === 0 ||
			needs.some(
				(item) =>
					item.requirementId === requirementId && item.query === normalized,
			)
		)
			return;
		needs.push({
			id: idFor({ requirementId, query: normalized }),
			requirementId,
			query: normalized,
			priority,
		});
	};
	add("goal", input.goal, 10_000);
	input.requirements.forEach((requirement, index) =>
		add(`R${index + 1}`, requirement, 9_000 - index),
	);
	for (const question of input.checkpoint?.openQuestions ?? [])
		add("checkpoint", question, 5_000);
	for (const action of input.checkpoint?.nextActions ?? [])
		add("checkpoint", action, 4_000);
	return { needs };
}

function cachePlan(
	planId: string,
	modelId: string,
	toolSchemaIdentity: string,
	capabilities: ContextCacheCapabilities,
	selected: readonly ContextItem[],
): ContextPlan["cache"] {
	const compatible =
		capabilities.compatibleModels.length === 0 ||
		capabilities.compatibleModels.includes(modelId);
	const strategy = capabilities.inSessionReuse
		? "in-session"
		: capabilities.providerPrefixCaching && compatible
			? "provider-prefix"
			: capabilities.localArtifactReuse &&
				  selected.some((item) => item.artifact !== undefined)
				? "local"
				: "none";
	const localArtifactIds = [
		...new Set(
			selected.flatMap((item) =>
				item.artifact?.id === undefined ? [] : [item.artifact.id],
			),
		),
	].sort();
	const providerPrefixIdentity = `prefix-${createHash("sha256").update(stableStringify({ modelId, planId, toolSchemaIdentity })).digest("hex").slice(0, 24)}`;
	return {
		version: 1,
		localArtifactIds,
		providerPrefixIdentity,
		toolSchemaIdentity,
		strategy,
		modelId,
		compatible,
		attribution: capabilities.attribution,
	};
}
function candidateKey(item: ContextItem): string {
	return `${item.id}\0${item.artifact?.id ?? ""}\0${item.provenance.sourceRevision}`;
}
function tokenCost(item: ContextItem): number {
	return Math.max(item.size.tokens, Math.ceil(item.size.characters / 4));
}
function stableCandidates(candidates: readonly ContextItem[]): {
	items: ContextItem[];
	duplicates: ContextItem[];
} {
	const seen = new Map<string, ContextItem>();
	const duplicates: ContextItem[] = [];
	for (const item of candidates) {
		const key = candidateKey(item);
		if (seen.has(key)) duplicates.push(item);
		else seen.set(key, item);
	}
	return {
		items: [...seen.values()].sort(
			(a, b) => b.score - a.score || a.id.localeCompare(b.id),
		),
		duplicates,
	};
}

export function planContext(input: ContextPlanningInput): ContextPlan {
	const budgets = budgetsFor(input.budgets);
	const needs = deriveInformationNeeds(input).needs;
	const candidates = (input.candidates ?? []).map((item) =>
		ContextItemSchema.parse(item),
	);
	const unique = stableCandidates(candidates);
	const selected: ContextItem[] = [];
	const omissions: ContextPlan["omissions"] = unique.duplicates.map((item) => ({
		candidateId: item.id,
		reason: "duplicate",
		requirementIds: item.requirementIds,
	}));
	const mode = input.mode ?? (unique.items.length === 0 ? "raw" : "managed");
	const capabilities = ContextCacheCapabilitiesSchema.parse({
		...DEFAULT_CACHE_CAPABILITIES,
		...(input.cacheCapabilities ?? {}),
	});
	if (
		budgets.economic.maxInputCostUsd !== undefined &&
		capabilities.inputCostUsdPerMillion === undefined
	) {
		throw new Error("maxInputCostUsd requires an input token price");
	}
	let usedTokens = 0;
	let usedUncached = 0;
	let cacheWriteTokens = 0;
	let usedInputCostUsd = 0;
	for (const item of unique.items) {
		const requirementIds =
			item.requirementIds.length > 0 ? item.requirementIds : ["goal"];
		const tooSensitive =
			input.allowedSensitivity !== undefined &&
			{ public: 0, internal: 1, confidential: 2, restricted: 3 }[
				item.sensitivity
			] >
				{ public: 0, internal: 1, confidential: 2, restricted: 3 }[
					input.allowedSensitivity
				];
		const tokens = tokenCost(item);
		const pricePerMillion =
			capabilities.providerPrefixCaching &&
			capabilities.cacheWriteCostUsdPerMillion !== undefined
				? capabilities.cacheWriteCostUsdPerMillion
				: capabilities.inputCostUsdPerMillion;
		const incrementalCostUsd =
			pricePerMillion === undefined
				? 0
				: (tokens * pricePerMillion) / 1_000_000;
		const reason =
			mode === "raw"
				? "raw-mode"
				: tooSensitive
					? "sensitivity"
					: selected.length >= budgets.attention.maxItems
						? "attention-budget"
						: usedTokens + tokens >
							  Math.max(
									0,
									budgets.window.maxTokens - budgets.window.reserveTokens,
							  )
							? "window-budget"
							: usedUncached + tokens > budgets.economic.maxUncachedTokens
								? "economic-budget"
								: capabilities.providerPrefixCaching &&
									  cacheWriteTokens + tokens >
											budgets.economic.maxProviderCacheWriteTokens
									? "cache-write-budget"
									: budgets.economic.maxInputCostUsd !== undefined &&
										  usedInputCostUsd + incrementalCostUsd >
												budgets.economic.maxInputCostUsd
										? "economic-cost-budget"
										: undefined;
		if (reason !== undefined) {
			omissions.push({ candidateId: item.id, reason, requirementIds });
			continue;
		}
		selected.push(item);
		usedTokens += tokens;
		usedUncached += tokens;
		if (capabilities.providerPrefixCaching) cacheWriteTokens += tokens;
		usedInputCostUsd += incrementalCostUsd;
	}
	const modelId = input.modelId ?? "unknown/model";
	const toolSchemaIdentity =
		clean(input.toolSchemaIdentity ?? "worker-tools:unknown", 512) ||
		"worker-tools:unknown";
	const provisional = {
		version: 1 as const,
		id: "ctx-placeholder",
		mode,
		needs,
		candidates: unique.items,
		selected,
		omissions,
		budgets,
		reservedTokens: budgets.window.reserveTokens,
		cache: cachePlan(
			"ctx-placeholder",
			modelId,
			toolSchemaIdentity,
			capabilities,
			selected,
		),
		sourceRevision: clean(input.sourceRevision, 256) || "unknown",
	};
	const id = idFor({
		...provisional,
		id: undefined,
		cache: { ...provisional.cache, providerPrefixIdentity: undefined },
	});
	return ContextPlanSchema.parse({
		...provisional,
		id,
		cache: cachePlan(id, modelId, toolSchemaIdentity, capabilities, selected),
	});
}
export function emptyContextPlan(
	sourceRevision: string,
	options: Pick<
		ContextPlanningInput,
		"budgets" | "cacheCapabilities" | "modelId"
	> = {},
): ContextPlan {
	return planContext({
		goal: "",
		requirements: [],
		candidates: [],
		sourceRevision,
		mode: "raw",
		...options,
	});
}
export function contextItemFromReference(
	reference: ImmutableArtifactReference,
	input: Omit<ContextItem, "version" | "id" | "artifact" | "size"> & {
		size?: ContextItem["size"];
	},
): ContextItem {
	return ContextItemSchema.parse({
		version: 1,
		id: idFor(reference),
		artifact: reference,
		size: input.size ?? { characters: 0, tokens: 0 },
		...input,
	});
}
