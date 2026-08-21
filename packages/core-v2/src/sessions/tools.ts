/**
 * Engine-side custom tool definitions for the session host (M1.2 / R3).
 *
 * Unlike the v1 worker (which loads tools via the extension API inside a
 * spawned RPC subprocess), the v2 host registers its session-scoped tools
 * in-process through the SDK's tool-definition API (`defineTool` +
 * `CreateAgentSessionOptions.customTools`). Two tools are supplied:
 *
 *   - `yield`: the typed completion gate. Its TypeBox parameter schema is
 *     mirrored from the canonical zod `YieldSchema` (src/contracts/payloads.ts),
 *     and the execute() body re-validates the incoming params against that
 *     same contract so the engine-side tool and the v1 worker extension
 *     enforce an identical payload. A valid yield terminates collection
 *     (AgentToolResult.terminate) so no follow-up LLM call is made.
 *
 *   - `checklist`: init/done/status over session-scoped state held in a
 *     closure per session (never the project issue tracker).
 *
 * Both mutate host-side state only through the injected callbacks, keeping
 * the tool definitions pure with respect to the SDK.
 */

import type {
	AgentToolResult,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";

import { YieldSchema } from "../contracts/index.ts";
import type { Yield } from "../contracts/index.ts";

/** TypeBox parameter schema mirrored from the canonical zod YieldSchema. */
export const YIELD_PARAMS_SCHEMA = Type.Object({
	files_changed: Type.Array(Type.String(), {
		description: "Repository-relative paths of files modified during this session",
	}),
	summary: Type.String({ description: "One-paragraph description of the changes made" }),
	commit_ids: Type.Array(Type.String(), {
		description: "jj commit IDs created during this session",
	}),
	deviations: Type.Array(Type.String(), {
		description: "Any deviations from the spec (empty array if none)",
	}),
});

export type YieldParams = Static<typeof YIELD_PARAMS_SCHEMA>;

/** Callback receiving a contract-valid yield once the model invokes it. */
export interface YieldCallbacks {
	onYield(payload: Yield): void;
}

/**
 * Contract enforcement: files_changed is repo-relative whatever the model
 * reports (absolute paths are reduced to cwd-relative, matching v1).
 */
export function toRepoRelative(cwd: string, p: string): string {
	const prefix = cwd.replace(/\\/g, "/") + "/";
	const normalized = p.replace(/\\/g, "/");
	return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

/** Build the engine-side `yield` tool bound to the given host callbacks. */
export function makeYieldTool(cwd: string, callbacks: YieldCallbacks) {
	return defineTool<typeof YIELD_PARAMS_SCHEMA, Yield>({
		name: "yield",
		label: "Yield",
		description:
			"Return your typed result and terminate the session. " +
			"Call this when all requirements are complete and verification has passed. " +
			"This is your final action — the session ends after yield.",
		parameters: YIELD_PARAMS_SCHEMA,
		executionMode: "sequential",

		async execute(
			_toolCallId: string,
			params: YieldParams,
			_signal: AbortSignal | undefined,
			_onUpdate: undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<any>> {
			const parsed = YieldSchema.safeParse(params);
			if (!parsed.success) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid yield: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
						},
					],
					details: { issues: parsed.error.issues },
				};
			}
			const payload: Yield = {
				...parsed.data,
				files_changed: parsed.data.files_changed.map((p) => toRepoRelative(cwd, p)),
			};
			callbacks.onYield(payload);
			return {
				content: [{ type: "text", text: "Yield accepted. Session terminating." }],
				details: payload,
				terminate: true,
			};
		},
	});
}

/** TypeBox schema for the minimal checklist tool. */
export const CHECKLIST_PARAMS_SCHEMA = Type.Union([
	Type.Object({ action: Type.Literal("init"), items: Type.Array(Type.String()) }),
	Type.Object({ action: Type.Literal("done"), index: Type.Integer() }),
	Type.Object({ action: Type.Literal("status") }),
]);

export type ChecklistParams = Static<typeof CHECKLIST_PARAMS_SCHEMA>;

/** Session-scoped checklist state (dies with the session, never the repo). */
export interface ChecklistState {
	items: Array<{ text: string; done: boolean }>;
}

/** Max number of checklist items (mirrors the v1 worker cap). */
export const MAX_CHECKLIST_ITEMS = 12;

/** Copy of the pure checklist operations; kept here to avoid v1 imports. */
export function createChecklist(items: string[], maxItems = MAX_CHECKLIST_ITEMS): ChecklistState {
	return { items: items.slice(0, maxItems).map((text) => ({ text, done: false })) };
}

export function checklistRemaining(state: ChecklistState): number {
	return state.items.filter((item) => !item.done).length;
}

export function markChecklistDone(
	state: ChecklistState,
	index: number,
): { ok: true; remaining: number } | { ok: false; error: string } {
	if (index < 0 || index >= state.items.length) {
		return { ok: false, error: `Index ${index} invalid (expected 0..${state.items.length - 1}).` };
	}
	const item = state.items[index];
	if (item === undefined) {
		return { ok: false, error: `Index ${index} invalid (expected 0..${state.items.length - 1}).` };
	}
	if (item.done) {
		return { ok: false, error: `Item ${index} ("${item.text}") was already done.` };
	}
	item.done = true;
	return { ok: true, remaining: checklistRemaining(state) };
}

/**
 * Builds the session-scoped checklist tool. State is created lazily on the
 * first `init` action and kept in the host-supplied mutable store.
 */
export function makeChecklistTool(store: { state: ChecklistState | undefined }) {
	return defineTool({
		name: "checklist",
		label: "Checklist",
		description:
			"Track your plan as a session-scoped checklist. " +
			"init replaces the checklist, done marks an item complete, status lists remaining items.",
		parameters: CHECKLIST_PARAMS_SCHEMA,

		async execute(
			_toolCallId: string,
			params: ChecklistParams,
			_signal: AbortSignal | undefined,
			_onUpdate: undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<{ status: string }>> {
			switch (params.action) {
				case "init": {
					store.state = createChecklist(params.items);
					return {
						content: [
							{ type: "text", text: `Checklist initialized with ${store.state.items.length} item(s).` },
						],
						details: { status: "initialized" },
					};
				}
				case "done": {
					if (!store.state) {
						return {
							content: [{ type: "text", text: "No checklist initialized; call init first." }],
							details: { status: "error:not-initialized" },
						};
					}
					const mark = markChecklistDone(store.state, params.index);
					if (!mark.ok) {
						return {
							content: [{ type: "text", text: mark.error }],
							details: { status: "error:invalid-index" },
						};
					}
					return {
						content: [{ type: "text", text: `Marked item ${params.index} done (${mark.remaining} remaining).` }],
						details: { status: "ok" },
					};
				}
				case "status": {
					if (!store.state || store.state.items.length === 0) {
						return {
							content: [{ type: "text", text: "No checklist items yet." }],
							details: { status: "empty" },
						};
					}
					const lines = store.state.items.map(
						(item, index) => `${item.done ? "[x]" : "[ ]"} ${index}: ${item.text}`,
					);
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { status: "ok" },
					};
				}
			}
		},
	});
}