/**
 * Prewalk — event-driven model swap (Phase 3).
 *
 * The worker spawns on a strong `prewalk_model`, explores the codebase
 * (reads accumulate in context), and swaps to a cheap `execute_model` on
 * the first successful edit. Context is preserved across the swap because
 * it happens in the same RPC session — the execute model continues with
 * the prewalk model's grounded exploration, no duplicate reads.
 *
 * Auto-skip: when prewalk_model == execute_model the mechanism is
 * disabled entirely (zero overhead), per the design doc's auto-skip rule.
 *
 * The planning-instruction injection + pruning lives in the worker-side
 * extension at tools/prewalk.ts, which reacts to the same first-edit
 * event independently (no cross-process signaling).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerSession } from "./worker.ts";

/** Absolute path to the worker-side prewalk extension (planning prompt). */
export const PREWALK_EXTENSION_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"tools",
	"prewalk.ts",
);

export interface PrewalkConfig {
	/** Model the worker starts on (strong/expensive). */
	prewalkModel: string;
	/** Model the worker swaps to on the first edit (cheap/fast). */
	executeModel: string;
	/** Called when the swap fires. */
	onSwap?: (info: SwapInfo) => void;
	/**
	 * Called when the set_model swap FAILS (e.g. unknown model). Without
	 * this, the worker silently continues on the expensive prewalk model —
	 * callers must surface the failure as a run error (R6).
	 */
	onError?: (err: Error) => void;
}

export interface SwapInfo {
	/** Assistant turns completed before the swap (includes the edit turn). */
	turns: number;
	toolCallId: string;
	toolName: string;
}

export interface PrewalkController {
	/** False when prewalk_model == execute_model (mechanism disabled). */
	active: boolean;
	/** True once the swap has fired. */
	swapped: boolean;
	/** Stop listening. Safe to call multiple times. */
	detach(): void;
}

/** True when the prewalk mechanism should run at all. */
export function isPrewalkActive(
	prewalkModel: string,
	executeModel: string,
): boolean {
	return prewalkModel !== executeModel;
}

/** edit/write are the edit tools that trigger the swap. */
export function isEditTool(toolName: string): boolean {
	return toolName === "edit" || toolName === "write";
}

export function attachPrewalk(
	session: WorkerSession,
	config: PrewalkConfig,
): PrewalkController {
	const { prewalkModel, executeModel, onSwap, onError } = config;

	if (!isPrewalkActive(prewalkModel, executeModel)) {
		return { active: false, swapped: false, detach: () => {} };
	}

	let swapped = false;
	let turns = 0;
	let detached = false;

	const handleEvent = (raw: unknown): void => {
		if (swapped) return;

		// The RPC event stream is untyped at this seam (worker.ts exposes it as
		// unknown); narrow to the fields the swap trigger inspects.
		const event = raw as {
			type?: string;
			message?: { role?: string };
			toolName?: string;
			isError?: boolean;
			toolCallId?: string;
		};

		if (event.type === "message_end" && event.message?.role === "assistant") {
			turns++;
			return;
		}

		if (
			event.type === "tool_execution_end" &&
			typeof event.toolName === "string" &&
			isEditTool(event.toolName) &&
			!event.isError
		) {
			swapped = true;
			const swap = session.setModel(executeModel);
			// onSwap stays synchronous (fires on the first edit, unchanged); the
			// set_model rejection is surfaced via onError — fire-and-forget made
			// a failed swap invisible (R6).
			onSwap?.({
				turns,
				toolCallId: event.toolCallId ?? "",
				toolName: event.toolName,
			});
			swap.catch((err) => {
				if (detached) return;
				const why = err instanceof Error ? err.message : String(err);
				onError?.(new Error(`model swap to ${executeModel} failed: ${why}`));
			});
		}
	};

	const unsubscribe = session.onEvent(handleEvent);

	return {
		active: true,
		get swapped(): boolean {
			return swapped;
		},
		detach(): void {
			if (!detached) {
				detached = true;
				unsubscribe();
			}
		},
	};
}
