/** Bounded worker-facing context query/handle resolution tool (M4). */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	CONTEXT_PROVIDER_MAX_CHARACTERS,
	CONTEXT_PROVIDER_MAX_HANDLES,
	ContextArtifactHandleSchema,
	ContextArtifactSchema,
} from "../contracts/context-provider.ts";
import type {
	CompiledContextArtifact,
	ContextProvider,
} from "../contracts/context-provider.ts";
import { DEFAULT_CONTEXT_BUDGET } from "../context/compiler.ts";

const CONTEXT_PARAMS_SCHEMA = Type.Union([
	Type.Object({
		action: Type.Literal("query"),
		query: Type.String({ minLength: 1, maxLength: 2000 }),
		max_results: Type.Optional(
			Type.Integer({ minimum: 0, maximum: DEFAULT_CONTEXT_BUDGET.maxHandles }),
		),
	}),
	Type.Object({
		action: Type.Literal("resolve"),
		handles: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
			minItems: 1,
			maxItems: DEFAULT_CONTEXT_BUDGET.maxHandles,
		}),
	}),
]);

function safeText(value: unknown): string {
	// Never slice structured output: reject an oversized provider result so the
	// caller receives a valid typed fallback rather than malformed JSON.
	const text = JSON.stringify(value);
	if (text === undefined) return "{}";
	if (text.length > CONTEXT_PROVIDER_MAX_CHARACTERS)
		throw new RangeError(
			"context tool output exceeds the hard character limit",
		);
	return text;
}

function validatedArtifact(value: unknown): CompiledContextArtifact {
	return ContextArtifactSchema.parse(value);
}

function validatedHandles(
	value: unknown,
): ReturnType<typeof ContextArtifactHandleSchema.parse>[] {
	if (!Array.isArray(value) || value.length > CONTEXT_PROVIDER_MAX_HANDLES)
		throw new RangeError("context handle result exceeds the hard handle limit");
	return value.map((handle) => ContextArtifactHandleSchema.parse(handle));
}

export interface ContextToolFallbackEvent {
	requestedProvider: { id: string; version: string };
	fallbackProvider: { id: string; version: string };
	error: string;
	artifact?: CompiledContextArtifact;
}

export interface ContextToolOptions {
	/** Raw/no-injection capability used after an in-session failure. */
	fallbackProvider?: ContextProvider;
	/** Sink for canonical context.omitted fallback evidence. */
	onFallback?: (event: ContextToolFallbackEvent) => void;
}

function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 256);
}

function isInvalidHandleError(error: unknown): boolean {
	const message = errorText(error).toLowerCase();
	return (
		message.includes("unknown") ||
		message.includes("unsafe") ||
		message.includes("traversal")
	);
}

function isUnsafeHandle(handle: string): boolean {
	return handle.includes("..") || handle.includes("/") || handle.includes("\\");
}

/** Minimal provider-neutral fallback for direct tool consumers that did not
 * assemble the normal raw provider. It never reads the filesystem. */
function makeDefaultRawFallback(): ContextProvider {
	const identity = { id: "raw", version: "1" } as const;
	const source = {
		source: "raw",
		sourceRevision: "unknown",
		treeIdentity: "unindexed:session",
		selector: "no-injection",
	} as const;
	const budget = {
		maxHandles: DEFAULT_CONTEXT_BUDGET.maxHandles,
		maxCharacters: DEFAULT_CONTEXT_BUDGET.maxCharacters,
		maxTokens: DEFAULT_CONTEXT_BUDGET.maxTokens,
	} as const;
	return {
		identity,
		compile: async ({ query }) =>
			ContextArtifactSchema.parse({
				provider: identity,
				source,
				query: query.trim(),
				handles: [],
				omissions: { count: 0, reasons: [] },
				estimatedSize: { characters: 0, tokens: 0 },
				budget,
			}),
		query: async ({ query }) =>
			ContextArtifactSchema.parse({
				provider: identity,
				source,
				query: query.trim(),
				handles: [],
				omissions: { count: 0, reasons: [] },
				estimatedSize: { characters: 0, tokens: 0 },
				budget,
			}),
		resolve: (handles) => {
			if (handles.length > 0)
				throw new Error("raw context provider has no handles");
			return [];
		},
	};
}

export function makeContextTool(
	provider: ContextProvider,
	options: ContextToolOptions = {},
) {
	const fallbackProvider = options.fallbackProvider ?? makeDefaultRawFallback();
	const notifyFallback = (
		error: unknown,
		artifact?: CompiledContextArtifact,
	): void => {
		options.onFallback?.({
			requestedProvider: provider.identity,
			fallbackProvider: fallbackProvider.identity,
			error: errorText(error),
			...(artifact === undefined ? {} : { artifact }),
		});
	};

	const rejected = (error: unknown) => ({
		content: [{ type: "text" as const, text: errorText(error) }],
		details: { status: "rejected", provider: provider.identity.id },
	});

	return defineTool({
		name: "context",
		label: "Context",
		description:
			"Query bounded repository context handles or resolve known handles to compact path and provenance metadata. Source bodies are never returned.",
		parameters: CONTEXT_PARAMS_SCHEMA,
		async execute(
			_toolCallId: string,
			params:
				| { action: "query"; query: string; max_results?: number }
				| { action: "resolve"; handles: string[] },
		) {
			try {
				if (params.action === "query") {
					const queryOptions =
						params.max_results === undefined
							? {}
							: { maxResults: params.max_results };
					try {
						const artifact = validatedArtifact(
							await provider.query({
								query: params.query,
								options: queryOptions,
							}),
						);
						return {
							content: [{ type: "text" as const, text: safeText(artifact) }],
							details: {
								status: "ok",
								provider: artifact.provider.id,
								selectedCount: artifact.handles.length,
								omittedCount: artifact.omissions.count,
							},
						};
					} catch (error) {
						try {
							const artifact = validatedArtifact(
								await fallbackProvider.query({
									query: params.query,
									options: queryOptions,
								}),
							);
							notifyFallback(error, artifact);
							return {
								content: [{ type: "text" as const, text: safeText(artifact) }],
								details: {
									status: "fallback",
									provider: artifact.provider.id,
									selectedCount: artifact.handles.length,
									omittedCount: artifact.omissions.count,
								},
							};
						} catch (fallbackError) {
							return rejected(fallbackError);
						}
					}
				}
				if (params.handles.some(isUnsafeHandle)) {
					return rejected(new Error("unsafe context handle"));
				}
				try {
					const handles = validatedHandles(
						await provider.resolve(params.handles),
					);
					return {
						content: [{ type: "text" as const, text: safeText({ handles }) }],
						details: {
							status: "ok",
							provider: provider.identity.id,
							selectedCount: handles.length,
						},
					};
				} catch (error) {
					// A known-invalid handle is a caller error, not an indexing
					// failure. Do not emit false fallback evidence for it.
					if (isInvalidHandleError(error)) return rejected(error);
					try {
						try {
							const handles = validatedHandles(
								await fallbackProvider.resolve(params.handles),
							);
							notifyFallback(error);
							return {
								content: [
									{ type: "text" as const, text: safeText({ handles }) },
								],
								details: {
									status: "fallback",
									provider: fallbackProvider.identity.id,
									selectedCount: handles.length,
								},
							};
						} catch {
							// Raw has no resolvable handles. Its empty artifact is the
							// explicit no-injection result for a failed index lookup.
							const artifact = validatedArtifact(
								await fallbackProvider.query({ query: "" }),
							);
							notifyFallback(error, artifact);
							return {
								content: [{ type: "text" as const, text: safeText(artifact) }],
								details: {
									status: "fallback",
									provider: artifact.provider.id,
									selectedCount: artifact.handles.length,
									omittedCount: artifact.omissions.count,
								},
							};
						}
					} catch (fallbackError) {
						return rejected(fallbackError);
					}
				}
			} catch (error) {
				return rejected(error);
			}
		},
	});
}
