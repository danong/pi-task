/**
 * Checklist tool + context injection — worker-side (Phase 4).
 *
 * The worker captures its plan as a session-scoped checklist
 * (checklist({action:"init"})), checking items off as it completes
 * them. Once the worker is in the execution phase (first edit), a
 * reminder of remaining unchecked items is injected into context each
 * turn until all are done — steering fast execute models through the
 * requirements.
 *
 * State lives in the session via pi.appendEntry(): it dies with the
 * session and never touches the project issue tracker (.pi/TODO.json).
 *
 * Injection gate: first edit done AND checklist initialized AND
 * unchecked items > 0. "First edit done" is the same signal prewalk uses
 * for the model swap — a proxy for "execution phase" that works with or
 * without prewalk (the planning model is never nagged).
 *
 * Reports remaining count via ctx.ui.setStatus("checklist",
 * "remaining:N") on every context event so tests can observe steering.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const CUSTOM_TYPE = "pi-task-checklist";

/** Default cap on checklist items (spec/design: 12 maximum). */
export const MAX_CHECKLIST_ITEMS = 12;

// ─── Pure state machine (exported for tests) ─────────────────────────

/**
 * The pure checklist state machine. The extension's tool handlers and
 * context injection call these functions — the observable behavior is
 * identical to the pre-extraction inline logic. All functions are pure
 * (create/query) or mutate their state argument (markChecklistDone).
 */
export interface ChecklistItem {
	text: string;
	done: boolean;
}

export interface ChecklistState {
	items: ChecklistItem[];
}

/** Create checklist state from item texts; truncates at maxItems (default 12). */
export function createChecklistState(
	items: string[],
	maxItems = MAX_CHECKLIST_ITEMS,
): ChecklistState {
	return {
		items: items.slice(0, maxItems).map((text) => ({ text, done: false })),
	};
}

/**
 * Mark an item done. Out-of-range and duplicate marks are rejected
 * (ok:false) without mutating state; on success returns the remaining
 * unchecked count. Mutates `state` in place.
 *
 * The failure result carries `alreadyDone` so callers can distinguish
 * duplicate marks (benign, tool result stays a success) from invalid
 * indexes (a genuine error).
 */
export function markChecklistDone(
	state: ChecklistState,
	index: number,
):
	| { ok: true; state: ChecklistState; remaining: number }
	| { ok: false; error: string; alreadyDone: boolean } {
	if (
		index < 0 ||
		index >= state.items.length ||
		state.items[index] === undefined
	) {
		return {
			ok: false,
			error: `Index ${index} invalid (expected 0..${state.items.length - 1}).`,
			alreadyDone: false,
		};
	}
	if (state.items[index].done) {
		return {
			ok: false,
			error: `Item ${index} ("${state.items[index].text}") was already done.`,
			alreadyDone: true,
		};
	}
	state.items[index].done = true;
	return { ok: true, state, remaining: checklistRemaining(state) };
}

/** Count unchecked items. */
export function checklistRemaining(state: ChecklistState): number {
	return state.items.filter((i) => !i.done).length;
}

/** The status-bar text: "remaining:N". */
export function checklistStatusText(state: ChecklistState): string {
	return `remaining:${checklistRemaining(state)}`;
}

/** The injected context reminder (1-based numbering of unchecked items). */
export function checklistReminder(state: ChecklistState): string {
	const unchecked = state.items
		.map((item, index) => ({ ...item, index }))
		.filter((i) => !i.done);
	return (
		`Remaining checklist items (complete before calling yield):\n` +
		unchecked.map((i) => `${i.index + 1}. ${i.text}`).join("\n")
	);
}

/**
 * Injection gate: first edit done AND checklist initialized AND
 * unchecked items > 0.
 */
export function shouldInjectChecklistReminder(
	firstEditDone: boolean,
	state: ChecklistState | null,
): boolean {
	return firstEditDone && state !== null && checklistRemaining(state) > 0;
}

// ─── Extension plumbing ──────────────────────────────────────────────

// Flat schema (not a discriminated union): providers reject unions-of-objects
// in tool schemas (400 invalid_request_error). Matches the yield tool's
// flat-schema pattern.
const ChecklistParams = Type.Object({
	action: StringEnum(["init", "done", "status"] as const, {
		description:
			"What to do: init (create from requirements), done (mark complete), status (list remaining)",
	}),
	items: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Checklist items derived from the task requirements (max 12); required for init",
		}),
	),
	index: Type.Optional(
		Type.Integer({
			description:
				"0-based index of the item to mark complete; required for done",
		}),
	),
});

function errorResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: {},
	};
}

/** Latest checklist state from session entries, or null if not initialized. */
function readState(ctx: {
	sessionManager: { getEntries(): unknown[] };
}): ChecklistState | null {
	let latest: ChecklistState | null = null;
	for (const entry of ctx.sessionManager.getEntries()) {
		const e = entry as { type?: string; customType?: string; data?: unknown };
		if (e.type === "custom" && e.customType === CUSTOM_TYPE) {
			latest = e.data as ChecklistState;
		}
	}
	return latest;
}

export default function (pi: ExtensionAPI) {
	let firstEditDone = false;

	// Same first-edit signal prewalk uses for the model swap.
	pi.on("tool_execution_end", (event) => {
		if (
			!firstEditDone &&
			(event.toolName === "edit" || event.toolName === "write") &&
			!event.isError
		) {
			firstEditDone = true;
		}
	});

	pi.registerTool({
		name: "checklist",
		label: "Checklist",
		description:
			"Session-scoped progress tracker. Initialize it from the task requirements (init), " +
			"mark items complete as you finish them (done), and query remaining items (status). " +
			"Use this to track your progress through the requirements; remaining items are " +
			"surfaced back to you until complete.",
		promptSnippet:
			"Track progress through task requirements (init/done/status)",
		parameters: ChecklistParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await Promise.resolve();
			switch (params.action) {
				case "init": {
					const raw = params.items ?? [];
					const state = createChecklistState(raw);
					pi.appendEntry(CUSTOM_TYPE, state);
					const truncated = raw.length > MAX_CHECKLIST_ITEMS;
					const n = state.items.length;
					return {
						content: [
							{
								type: "text",
								text:
									`Checklist initialized with ${n} item${n === 1 ? "" : "s"}.` +
									(truncated
										? ` (truncated from ${raw.length} to ${MAX_CHECKLIST_ITEMS}.)`
										: ""),
							},
						],
						details: { items: state.items.map((i) => i.text) },
					};
				}

				case "done": {
					const state = readState(ctx);
					if (!state) {
						return errorResult(
							"Checklist not initialized. Call checklist({action:'init', items:[...]}) first.",
						);
					}
					const result = markChecklistDone(state, params.index as number);
					if (!result.ok) {
						// Duplicate marks stay benign (pre-refactor behavior): the item is
						// already done, which is not an error — report it, don't fail.
						if (result.alreadyDone) {
							return {
								content: [{ type: "text", text: result.error }],
								details: { index: params.index, alreadyDone: true },
							};
						}
						return errorResult(result.error);
					}
					pi.appendEntry(CUSTOM_TYPE, state);
					const remaining = result.remaining;
					return {
						content: [
							{
								type: "text",
								text: `Marked item ${params.index} done. ${remaining} item${remaining === 1 ? "" : "s"} remaining.`,
							},
						],
						details: { index: params.index, remaining },
					};
				}

				case "status": {
					const state = readState(ctx);
					if (!state) {
						return errorResult(
							"Checklist not initialized. Call checklist({action:'init', items:[...]}) first.",
						);
					}
					const unchecked = state.items
						.map((item, index) => ({ ...item, index }))
						.filter((i) => !i.done);
					if (unchecked.length === 0) {
						return {
							content: [
								{ type: "text", text: "All checklist items are complete." },
							],
							details: { remaining: 0 },
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `Remaining:\n${unchecked.map((i) => `${i.index}: ${i.text}`).join("\n")}`,
							},
						],
						details: {
							remaining: unchecked.length,
							items: unchecked.map((i) => i.text),
						},
					};
				}
			}
		},
	});

	// Context injection — nag about remaining items once in the execution phase.
	pi.on("context", (event, ctx) => {
		const state = readState(ctx);
		ctx.ui.setStatus("checklist", checklistStatusText(state ?? { items: [] }));

		if (!shouldInjectChecklistReminder(firstEditDone, state) || !state) return;

		return {
			messages: [
				...event.messages,
				{
					role: "user",
					content: checklistReminder(state),
					timestamp: Date.now(),
				},
			],
		};
	});
}
