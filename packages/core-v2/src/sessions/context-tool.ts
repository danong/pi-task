/** Bounded worker tool over explicit M4 acquisition capabilities. */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	CONTEXT_MAX_ITEMS,
	ContextAcquisitionRequestSchema,
	ContextItemListSchema,
	ContextMaterializationRequestSchema,
	type ContextAcquisitionCapabilities,
} from "../contracts/context-lifecycle.ts";
import { CONTEXT_PROVIDER_MAX_CHARACTERS } from "../contracts/context-provider.ts";

const CONTEXT_PARAMS_SCHEMA = Type.Union([
	Type.Object({
		action: Type.Literal("query"),
		query: Type.String({ minLength: 1, maxLength: 2000 }),
		max_results: Type.Optional(
			Type.Integer({ minimum: 0, maximum: CONTEXT_MAX_ITEMS }),
		),
	}),
	Type.Object({
		action: Type.Literal("resolve"),
		handles: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
			minItems: 1,
			maxItems: CONTEXT_MAX_ITEMS,
		}),
	}),
]);

export interface ContextToolFallbackEvent {
	requestedProvider: { id: string; version: string };
	fallbackProvider: { id: string; version: string };
	error: string;
}

export interface ContextToolOptions {
	fallbackProvider?: ContextAcquisitionCapabilities;
	onFallback?: (event: ContextToolFallbackEvent) => void;
	root?: string;
	sourceRevision?: string;
}

function rawFallbackCapabilities(): ContextAcquisitionCapabilities {
	const identity = { id: "raw", version: "1" } as const;
	return {
		identity,
		candidates: { identity, acquire: () => [] },
		materializer: { identity, materialize: () => [] },
	};
}

function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 256);
}

function safeText(value: unknown): string {
	const text = JSON.stringify(value);
	if (text === undefined) throw new Error("context tool result is not JSON");
	if (text.length > CONTEXT_PROVIDER_MAX_CHARACTERS)
		throw new RangeError(
			"context tool output exceeds the hard character limit",
		);
	return text;
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

export function makeContextTool(
	provider: ContextAcquisitionCapabilities,
	options: ContextToolOptions = {},
) {
	const fallbackProvider =
		options.fallbackProvider ?? rawFallbackCapabilities();
	const notifyFallback = (error: unknown): void => {
		options.onFallback?.({
			requestedProvider: provider.identity,
			fallbackProvider: fallbackProvider.identity,
			error: errorText(error),
		});
	};
	const rejected = (error: unknown) => ({
		content: [{ type: "text" as const, text: errorText(error) }],
		details: { status: "rejected", provider: provider.identity.id },
	});
	const queryRequest = (query: string) =>
		ContextAcquisitionRequestSchema.parse({
			root: options.root ?? process.cwd(),
			sourceRevision: options.sourceRevision ?? "unknown",
			needs: [
				{
					id: "tool-query",
					requirementId: "goal",
					query,
					priority: 1,
				},
			],
		});

	return defineTool({
		name: "context",
		label: "Context",
		description:
			"Acquire bounded repository candidates or materialize known handles. Source bodies are never returned.",
		parameters: CONTEXT_PARAMS_SCHEMA,
		async execute(
			_toolCallId: string,
			params:
				| { action: "query"; query: string; max_results?: number }
				| { action: "resolve"; handles: string[] },
		) {
			if (params.action === "query") {
				const request = queryRequest(params.query);
				try {
					const items = ContextItemListSchema.parse(
						await provider.candidates.acquire(request),
					);
					const bounded =
						params.max_results === undefined
							? items
							: items.slice(0, params.max_results);
					return {
						content: [
							{
								type: "text" as const,
								text: safeText({ provider: provider.identity, items: bounded }),
							},
						],
						details: {
							status: "ok",
							provider: provider.identity.id,
							selectedCount: bounded.length,
						},
					};
				} catch (error) {
					try {
						const items = ContextItemListSchema.parse(
							await fallbackProvider.candidates.acquire(request),
						);
						notifyFallback(error);
						return {
							content: [
								{
									type: "text" as const,
									text: safeText({
										provider: fallbackProvider.identity,
										items,
									}),
								},
							],
							details: {
								status: "fallback",
								provider: fallbackProvider.identity.id,
								selectedCount: items.length,
							},
						};
					} catch (fallbackError) {
						return rejected(fallbackError);
					}
				}
			}

			if (params.handles.some(isUnsafeHandle))
				return rejected(new Error("unsafe context handle"));
			const request = ContextMaterializationRequestSchema.parse({
				handles: params.handles,
			});
			try {
				const items = ContextItemListSchema.parse(
					await provider.materializer.materialize(request),
				);
				return {
					content: [
						{
							type: "text" as const,
							text: safeText({ provider: provider.identity, items }),
						},
					],
					details: {
						status: "ok",
						provider: provider.identity.id,
						selectedCount: items.length,
					},
				};
			} catch (error) {
				if (isInvalidHandleError(error)) return rejected(error);
				try {
					const items = ContextItemListSchema.parse(
						await fallbackProvider.materializer.materialize(request),
					);
					notifyFallback(error);
					return {
						content: [
							{
								type: "text" as const,
								text: safeText({
									provider: fallbackProvider.identity,
									items,
								}),
							},
						],
						details: {
							status: "fallback",
							provider: fallbackProvider.identity.id,
							selectedCount: items.length,
						},
					};
				} catch (fallbackError) {
					return rejected(fallbackError);
				}
			}
		},
	});
}
