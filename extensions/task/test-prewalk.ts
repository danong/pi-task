/**
 * Prewalk swap logic tests — attachPrewalk against an in-process fake
 * session (captured listeners, recorded setModel calls). No real session,
 * no LLM. Covers the swap decision: first successful edit/write fires the
 * swap exactly once, errored edits don't, and equal models auto-skip.
 *
 * The prewalk EXTENSION behavior (setStatus("prewalk") pruning) is
 * pi-extension territory → e2e section 3.
 */

import { pathToFileURL } from "node:url";
import { attachPrewalk, isPrewalkActive, type SwapInfo } from "./prewalk.ts";
import type { WorkerSession } from "./worker.ts";

// Distinct-model labels only — no real model is ever invoked here (hermetic
// fake-session test). Neutral names per the suite's model policy: the real
// frontier model name must not appear anywhere in the test suite.
const PREWALK_MODEL = "test/prewalk-model";
const EXECUTE_MODEL = "test/execute-model";

interface FakeSession {
	session: WorkerSession;
	/** Dispatch an event to all registered listeners. */
	emit(event: Record<string, unknown>): void;
	setModelCalls: string[];
}

/** A minimal WorkerSession stub: attachPrewalk only needs onEvent + setModel. */
function makeFakeSession(opts?: { failSetModel?: boolean }): FakeSession {
	const listeners: Array<(event: unknown) => void> = [];
	const setModelCalls: string[] = [];
	const session = {
		onEvent(listener: (event: unknown) => void): () => void {
			listeners.push(listener);
			return () => {
				const i = listeners.indexOf(listener);
				if (i !== -1) listeners.splice(i, 1);
			};
		},
		// Request-based setModel (R6): resolves/rejects like the real
		// request()-correlated set_model; the fake rejects when asked to.
		setModel(model: string): Promise<void> {
			setModelCalls.push(model);
			if (opts?.failSetModel)
				return Promise.reject(new Error(`model not found: ${model}`));
			return Promise.resolve();
		},
		sendCommand(): void {},
		abort(): void {},
		result: new Promise(() => {}),
	} as unknown as WorkerSession;
	return {
		session,
		emit: (event) => {
			for (const l of [...listeners]) l(event);
		},
		setModelCalls,
	};
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	console.log("── test-prewalk: swap decision via fake session ──");

	// 1. Swap on first successful edit: message_end ×2 then edit
	{
		const fake = makeFakeSession();
		const swaps: SwapInfo[] = [];
		const ctrl = attachPrewalk(fake.session, {
			prewalkModel: PREWALK_MODEL,
			executeModel: EXECUTE_MODEL,
			onSwap: (info) => swaps.push(info),
		});
		check(
			ctrl.active === true,
			"controller should be active for distinct models",
		);

		fake.emit({ type: "message_end", message: { role: "assistant" } });
		fake.emit({ type: "message_end", message: { role: "assistant" } });
		fake.emit({ type: "tool_execution_start", toolName: "edit" });
		fake.emit({
			type: "tool_execution_end",
			toolName: "edit",
			toolCallId: "tc-1",
			isError: false,
		});

		check(
			fake.setModelCalls.length === 1,
			`setModel should be called once, got ${fake.setModelCalls.length}`,
		);
		check(
			fake.setModelCalls[0] === EXECUTE_MODEL,
			`setModel should receive execute model, got ${fake.setModelCalls[0]}`,
		);
		check(ctrl.swapped === true, "controller should report swapped=true");
		check(swaps.length === 1, `onSwap should fire once, got ${swaps.length}`);
		if (swaps[0]) {
			check(
				swaps[0].turns === 2,
				`swap turns should be 2 (message_ends before edit), got ${swaps[0].turns}`,
			);
			check(
				swaps[0].toolName === "edit",
				`swap toolName should be "edit", got ${swaps[0].toolName}`,
			);
			check(
				swaps[0].toolCallId === "tc-1",
				`swap toolCallId should be "tc-1", got ${swaps[0].toolCallId}`,
			);
		}

		// No further swaps on later events (including more edits)
		fake.emit({ type: "message_end", message: { role: "assistant" } });
		fake.emit({
			type: "tool_execution_end",
			toolName: "edit",
			toolCallId: "tc-2",
		});
		fake.emit({
			type: "tool_execution_end",
			toolName: "write",
			toolCallId: "tc-3",
		});
		check(
			fake.setModelCalls.length === 1,
			`setModel must fire exactly once, got ${fake.setModelCalls.length}`,
		);
		check(
			swaps.length === 1,
			`onSwap must fire exactly once, got ${swaps.length}`,
		);
	}

	// 2. write also triggers the swap
	{
		const fake = makeFakeSession();
		const swaps: SwapInfo[] = [];
		const ctrl = attachPrewalk(fake.session, {
			prewalkModel: PREWALK_MODEL,
			executeModel: EXECUTE_MODEL,
			onSwap: (info) => swaps.push(info),
		});
		fake.emit({
			type: "tool_execution_end",
			toolName: "write",
			toolCallId: "tc-w",
		});
		check(
			ctrl.swapped === true && swaps.length === 1,
			"write should trigger the swap",
		);
		check(
			swaps[0]?.toolName === "write",
			`swap toolName should be "write", got ${swaps[0]?.toolName}`,
		);
	}

	// 3. isError edit does not trigger the swap; later successful edit does
	{
		const fake = makeFakeSession();
		const swaps: SwapInfo[] = [];
		const ctrl = attachPrewalk(fake.session, {
			prewalkModel: PREWALK_MODEL,
			executeModel: EXECUTE_MODEL,
			onSwap: (info) => swaps.push(info),
		});
		fake.emit({
			type: "tool_execution_end",
			toolName: "edit",
			toolCallId: "tc-bad",
			isError: true,
		});
		check(
			ctrl.swapped === false && swaps.length === 0,
			"errored edit must not trigger the swap",
		);
		fake.emit({ type: "message_end", message: { role: "assistant" } });
		fake.emit({
			type: "tool_execution_end",
			toolName: "edit",
			toolCallId: "tc-good",
		});
		check(
			ctrl.swapped === true && swaps.length === 1,
			"successful edit after an errored one should trigger the swap",
		);
		check(
			swaps[0]?.turns === 1,
			`turns should count only assistant message_ends, got ${swaps[0]?.turns}`,
		);
		check(
			swaps[0]?.toolCallId === "tc-good",
			`swap should carry the successful edit's call id, got ${swaps[0]?.toolCallId}`,
		);
	}

	// 4. Auto-skip: equal models disable the mechanism entirely
	{
		check(
			isPrewalkActive(PREWALK_MODEL, EXECUTE_MODEL) === true,
			"isPrewalkActive should be true for distinct models",
		);
		check(
			isPrewalkActive(EXECUTE_MODEL, EXECUTE_MODEL) === false,
			"isPrewalkActive should be false for equal models",
		);

		const fake = makeFakeSession();
		const swaps: SwapInfo[] = [];
		const ctrl = attachPrewalk(fake.session, {
			prewalkModel: EXECUTE_MODEL,
			executeModel: EXECUTE_MODEL,
			onSwap: (info) => swaps.push(info),
		});
		check(
			ctrl.active === false,
			"controller should be inactive when models are equal",
		);
		check(
			ctrl.swapped === false,
			"inactive controller should report swapped=false",
		);
		fake.emit({
			type: "tool_execution_end",
			toolName: "edit",
			toolCallId: "tc-x",
		});
		check(
			fake.setModelCalls.length === 0,
			"inactive controller must never call setModel",
		);
		check(swaps.length === 0, "inactive controller must never fire onSwap");
		ctrl.detach(); // must be safe to call
	}

	// 5. detach stops listening (and is idempotent)
	{
		const fake = makeFakeSession();
		const swaps: SwapInfo[] = [];
		const ctrl = attachPrewalk(fake.session, {
			prewalkModel: PREWALK_MODEL,
			executeModel: EXECUTE_MODEL,
			onSwap: (info) => swaps.push(info),
		});
		fake.emit({ type: "tool_execution_end", toolName: "edit" });
		check(
			ctrl.swapped === true && swaps.length === 1,
			"swap should fire before detach",
		);
		ctrl.detach();
		ctrl.detach(); // idempotent
		fake.emit({ type: "tool_execution_end", toolName: "edit" });
		fake.emit({ type: "tool_execution_end", toolName: "write" });
		check(fake.setModelCalls.length === 1, "no setModel calls after detach");
		check(swaps.length === 1, "no onSwap after detach");
	}

	// 6. Failed swap (rejected set_model) surfaces a precise error via onError (R6)
	{
		const fake = makeFakeSession({ failSetModel: true });
		const swaps: SwapInfo[] = [];
		const swapErrors: string[] = [];
		const ctrl = attachPrewalk(fake.session, {
			prewalkModel: PREWALK_MODEL,
			executeModel: EXECUTE_MODEL,
			onSwap: (info) => swaps.push(info),
			onError: (err) => swapErrors.push(err.message),
		});
		fake.emit({
			type: "tool_execution_end",
			toolName: "edit",
			toolCallId: "tc-fail",
		});
		check(
			swaps.length === 1,
			"onSwap should still fire synchronously on the edit",
		);
		check(fake.setModelCalls.length === 1, "setModel should be called once");
		await new Promise((r) => setTimeout(r, 0)); // let the rejection microtask run
		check(
			swapErrors.length === 1,
			`failed swap should surface one error, got ${swapErrors.length}`,
		);
		check(
			swapErrors[0] ===
				`model swap to ${EXECUTE_MODEL} failed: model not found: ${EXECUTE_MODEL}`,
			`error message should be precise, got: ${swapErrors[0]}`,
		);
		check(ctrl.swapped === true, "swap should still be reported fired");
	}

	if (errors.length > 0) {
		throw new Error("test-prewalk failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log(
		"✓ swap on edit/write, once-only, isError ignore, auto-skip, detach, failed-swap error",
	);
}

// Direct execution support: `npx tsx extensions/task/test-prewalk.ts`
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error((err as Error).message ?? err);
			process.exit(1);
		});
}
