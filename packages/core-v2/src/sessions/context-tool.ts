/** Bounded worker-facing context query/handle resolution tool (M4). */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ContextProvider } from "../contracts/context-provider.ts";
import { DEFAULT_CONTEXT_BUDGET } from "../context/compiler.ts";

const CONTEXT_PARAMS_SCHEMA = Type.Union([
	Type.Object({ action: Type.Literal("query"), query: Type.String({ minLength: 1, maxLength: 2000 }), max_results: Type.Optional(Type.Integer({ minimum: 0, maximum: DEFAULT_CONTEXT_BUDGET.maxHandles })) }),
	Type.Object({ action: Type.Literal("resolve"), handles: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: DEFAULT_CONTEXT_BUDGET.maxHandles }) }),
]);

function safeText(value: unknown): string {
	const text = JSON.stringify(value);
	return text === undefined ? "{}" : text.slice(0, DEFAULT_CONTEXT_BUDGET.maxCharacters);
}

export function makeContextTool(provider: ContextProvider) {
	return defineTool({
		name: "context",
		label: "Context",
		description: "Query bounded repository context handles or resolve known handles to compact path and provenance metadata. Source bodies are never returned.",
		parameters: CONTEXT_PARAMS_SCHEMA,
		execute(_toolCallId: string, params: { action: "query"; query: string; max_results?: number } | { action: "resolve"; handles: string[] }) {
			try {
				if (params.action === "query") {
					const options = params.max_results === undefined ? {} : { maxResults: params.max_results };
					return provider.query({ query: params.query, options }).then((artifact) => ({ content: [{ type: "text" as const, text: safeText(artifact) }], details: { status: "ok", provider: artifact.provider.id, selectedCount: artifact.handles.length, omittedCount: artifact.omissions.count } }));
				}
				return Promise.resolve(provider.resolve(params.handles)).then((handles) => ({ content: [{ type: "text" as const, text: safeText({ handles }) }], details: { status: "ok", selectedCount: handles.length } }));
			} catch (error) {
				return Promise.resolve({ content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], details: { status: "rejected" } });
			}
		},
	});
}
