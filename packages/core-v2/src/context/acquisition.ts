/** Adapters from acquisition providers to the kernel context planner. */
import type {
	ContextArtifactHandle,
	CompiledContextArtifact,
	ContextProvider,
} from "../contracts/context-provider.ts";
import type {
	ContextItem,
	ContextNeed,
	ContextPlan,
	ContextCacheCapabilities,
} from "../contracts/context-lifecycle.ts";
import { planContext } from "./planner.ts";

function matchingRequirementIds(
	handle: ContextArtifactHandle,
	needs: readonly ContextNeed[],
): string[] {
	const searchable = `${handle.path} ${handle.symbol ?? ""}`.toLowerCase();
	const matches = needs
		.filter((need) =>
			need.query
				.toLowerCase()
				.split(/[^a-z0-9_$-]+/)
				.filter((token) => token.length >= 3)
				.some((token) => searchable.includes(token)),
		)
		.map((need) => need.requirementId);
	return [...new Set(matches.length > 0 ? matches : ["goal"])].sort();
}
export function contextItemFromHandle(
	handle: ContextArtifactHandle,
	provider: ContextProvider,
	needs: readonly ContextNeed[] = [],
	requirementIds?: readonly string[],
): ContextItem {
	return {
		version: 1,
		id: handle.id,
		kind: handle.kind === "symbol" ? "candidate" : "source",
		label:
			handle.symbol === undefined
				? handle.path
				: `${handle.path}#${handle.symbol}`,
		summary: `${handle.kind} handle ${handle.path}${handle.symbol === undefined ? "" : `#${handle.symbol}`}`,
		provenance: {
			providerId: provider.identity.id,
			providerVersion: provider.identity.version,
			source: handle.provenance.source,
			sourceRevision: handle.sourceRevision,
			selector: handle.provenance.selector,
		},
		freshness: {
			revision: handle.sourceRevision,
			observedAtRevision: handle.sourceRevision,
			state: "fresh",
		},
		sensitivity: "internal",
		size: {
			characters: JSON.stringify(handle).length,
			tokens: Math.max(1, Math.ceil(JSON.stringify(handle).length / 4)),
		},
		requirementIds:
			requirementIds === undefined
				? matchingRequirementIds(handle, needs)
				: [...new Set(requirementIds)].sort(),
		sourcePath: handle.path,
		score: handle.score,
	};
}
export function contextItemsFromArtifact(
	artifact: CompiledContextArtifact,
	provider: ContextProvider = {
		identity: artifact.provider,
		compile: async () => artifact,
		query: async () => artifact,
		resolve: () => [],
	},
	needs: readonly ContextNeed[] = [],
): ContextItem[] {
	return artifact.handles.map((handle) =>
		contextItemFromHandle(handle, provider, needs),
	);
}
export interface ContextLifecycleBuildInput {
	provider: ContextProvider;
	sourceRevision: string;
	query: string;
	goal?: string;
	requirements?: readonly string[];
	budgets?: Parameters<typeof planContext>[0]["budgets"];
	cacheCapabilities?: Partial<ContextCacheCapabilities>;
	modelId?: string;
	toolSchemaIdentity?: string;
}
export async function planFromAcquisition(
	input: ContextLifecycleBuildInput,
): Promise<{ artifact: CompiledContextArtifact; plan: ContextPlan }> {
	const artifact = await input.provider.compile({ query: input.query });
	const planningInput = {
		goal: input.goal ?? input.query,
		requirements: input.requirements ?? [],
		candidates: contextItemsFromArtifact(artifact, input.provider),
		sourceRevision: artifact.source.treeIdentity,
		mode:
			input.provider.identity.id === "raw"
				? ("raw" as const)
				: ("managed" as const),
		...(input.budgets === undefined ? {} : { budgets: input.budgets }),
		...(input.cacheCapabilities === undefined
			? {}
			: { cacheCapabilities: input.cacheCapabilities }),
		...(input.modelId === undefined ? {} : { modelId: input.modelId }),
		...(input.toolSchemaIdentity === undefined
			? {}
			: { toolSchemaIdentity: input.toolSchemaIdentity }),
	};
	const plan = planContext(planningInput);
	return { artifact, plan };
}
