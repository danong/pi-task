/** Compatibility edge for the pre-M4 monolithic provider shape.
 *
 * The execution kernel never imports this module. CLI/tests may use it while
 * migrating a provider; every result is revalidated at the explicit
 * acquisition/materialization boundary before kernel use.
 */
import {
	ContextArtifactHandleSchema,
	ContextArtifactSchema,
	type ContextProvider,
	type ContextProviderFactory,
} from "../contracts/context-provider.ts";
import {
	ContextAcquisitionCapabilitiesSchema,
	ContextAcquisitionRequestSchema,
	ContextItemListSchema,
	ContextMaterializationRequestSchema,
	type ContextAcquisitionCapabilities,
	type ContextAcquisitionFactory,
} from "../contracts/context-lifecycle.ts";
import {
	contextItemFromHandle,
	contextItemsFromArtifact,
} from "./acquisition.ts";

function checkedIdentity(identity: { id: string; version: string }) {
	return { id: identity.id, version: identity.version };
}

/** Translate one legacy provider at the provider boundary only. */
export function capabilitiesFromLegacyProvider(
	provider: ContextProvider,
): ContextAcquisitionCapabilities {
	const capabilities: ContextAcquisitionCapabilities = {
		identity: checkedIdentity(provider.identity),
		candidates: {
			identity: checkedIdentity(provider.identity),
			acquire: async (input) => {
				const request = ContextAcquisitionRequestSchema.parse(input);
				const artifact = ContextArtifactSchema.parse(
					await provider.query({
						query: request.needs.map((need) => need.query).join("\n"),
					}),
				);
				const items = contextItemsFromArtifact(
					artifact,
					provider,
					request.needs,
				);
				return ContextItemListSchema.parse(items);
			},
		},
		materializer: {
			identity: checkedIdentity(provider.identity),
			materialize: async (input) => {
				const request = ContextMaterializationRequestSchema.parse(input);
				const handles = (await provider.resolve(request.handles)).map(
					(handle) => ContextArtifactHandleSchema.parse(handle),
				);
				const items = handles.map((handle) =>
					contextItemFromHandle(
						handle,
						provider,
						[],
						request.requirementIds ?? ["goal"],
					),
				);
				return ContextItemListSchema.parse(
					items.map((item) => ({
						...item,
						requirementIds:
							request.requirementIds === undefined
								? item.requirementIds
								: [...new Set(request.requirementIds)].sort(),
					})),
				);
			},
		},
	};
	return ContextAcquisitionCapabilitiesSchema.parse(
		capabilities,
	) as unknown as ContextAcquisitionCapabilities;
}

/** Translate a legacy factory at the CLI/provider edge. */
export function acquisitionFactoryFromLegacy(
	factory: ContextProviderFactory,
): ContextAcquisitionFactory {
	return {
		identity: checkedIdentity(factory.identity),
		create: (options) =>
			capabilitiesFromLegacyProvider(factory.create(options)),
	};
}
