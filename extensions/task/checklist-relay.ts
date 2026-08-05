/**
 * Checklist relay — carries worker checklist state to the orchestrator
 * through the existing worker event stream (R4).
 *
 * The worker-side checklist extension (tools/checklist.ts) is unchanged;
 * this relay is observer-only: it reconstructs {done, total} from the
 * checklist tool's RPC events by correlating tool_execution_start args
 * with tool_execution_end results via toolCallId — the same pattern
 * worker.ts uses for read paths. Events only: zero LLM tokens, zero
 * commands sent to the worker, so the checklist tool behavior, the
 * prewalk swap trigger, and the post-swap reminder injection all remain
 * exactly as they are.
 *
 * State reconstruction:
 * - init: total = the tool's post-truncation item list (result.details.items).
 * - done/status: remaining = result.details.remaining; done = total − remaining.
 * - errored calls and duplicate marks (alreadyDone) change nothing.
 */

import type { WorkerSession } from "./worker.ts";

/** A relayed snapshot of the worker's checklist state. */
export interface ChecklistProgress {
	/** Number of items checked off. */
	done: number;
	/** Total item count (after the tool's truncation). */
	total: number;
}

export interface ChecklistRelayState {
	/** Item count as of the last observed init; null = not initialized. */
	total: number | null;
	/** Unchecked count as of the last observed done/status; null = unknown. */
	remaining: number | null;
	/** toolCallId → checklist action, correlating start → end events. */
	pendingActions: Map<string, string>;
}

export function createChecklistRelayState(): ChecklistRelayState {
	return { total: null, remaining: null, pendingActions: new Map() };
}

/**
 * Fold one raw RPC event into relay state. Emits an update only when a
 * checklist call actually changed the reconstructed state; returns null
 * otherwise (non-checklist tools, errored calls, unknown actions).
 * Pure — tested hermetically.
 */
export function reduceChecklistRelayEvent(
	state: ChecklistRelayState,
	event: unknown,
): { state: ChecklistRelayState; update: ChecklistProgress | null } {
	const ev = event as Record<string, any> | null;
	if (!ev || ev.toolName !== "checklist" || typeof ev.toolCallId !== "string") {
		return { state, update: null };
	}

	// Capture the action at start; consume it at end (mirrors the read-path
	// correlation in worker.ts). A missing start event yields no update.
	if (ev.type === "tool_execution_start") {
		const action = typeof ev.args?.action === "string" ? ev.args.action : "";
		state.pendingActions.set(ev.toolCallId, action);
		return { state, update: null };
	}
	if (ev.type !== "tool_execution_end") return { state, update: null };

	const action = state.pendingActions.get(ev.toolCallId);
	state.pendingActions.delete(ev.toolCallId);
	if (action === undefined || ev.isError === true) return { state, update: null };
	const details = ev.result?.details as Record<string, any> | undefined;

	if (action === "init") {
		// The tool reports the post-truncation item list — authoritative total.
		if (!details || !Array.isArray(details.items)) return { state, update: null };
		state.total = details.items.length;
		state.remaining = state.total;
		return { state, update: { done: 0, total: state.total } };
	}

	// done / status: the tool reports the unchecked count. Duplicate marks
	// (alreadyDone) carry no remaining field → no change.
	const remaining = details?.remaining;
	if (typeof remaining !== "number" || state.total === null) return { state, update: null };
	state.remaining = remaining;
	const done = Math.min(state.total, Math.max(0, state.total - remaining));
	return { state, update: { done, total: state.total } };
}

export interface ChecklistRelayConfig {
	/** Called with each reconstructed state change. */
	onChecklist?: (progress: ChecklistProgress) => void;
}

export interface ChecklistRelayController {
	/** Latest relayed progress; null while the checklist isn't initialized. */
	readonly latest: ChecklistProgress | null;
	/** Stop listening. Safe to call multiple times. */
	detach(): void;
}

/**
 * Attach the relay to a live worker session. Listens on the same raw event
 * stream the prewalk swap listener uses (session.onEvent) and reports via
 * the config callback — the orchestrator forwards these as
 * `{ type: "checklist", index?, done, total }` progress updates.
 */
export function attachChecklistRelay(
	session: WorkerSession,
	config: ChecklistRelayConfig = {},
): ChecklistRelayController {
	const state = createChecklistRelayState();
	let latest: ChecklistProgress | null = null;
	let detached = false;

	const unsubscribe = session.onEvent((event) => {
		if (detached) return;
		const { update } = reduceChecklistRelayEvent(state, event);
		if (update) {
			latest = update;
			config.onChecklist?.(update);
		}
	});

	return {
		get latest(): ChecklistProgress | null {
			return latest;
		},
		detach(): void {
			if (!detached) {
				detached = true;
				unsubscribe();
			}
		},
	};
}
