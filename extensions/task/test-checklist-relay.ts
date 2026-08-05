/**
 * Checklist relay hermetic tests — the pure reducer plus attachChecklistRelay
 * against an in-process fake session (same pattern as test-prewalk.ts).
 *
 * Asserts the R4 contract: relayed progress tracks the worker's real
 * checklist state (init → done → status) with zero LLM tokens, and the
 * relay is observer-only — it never sends commands to or touches the
 * worker session, so worker-side semantics (tool behavior, prewalk swap
 * trigger, reminder injection) are unchanged.
 */

import { pathToFileURL } from "node:url";
import {
	attachChecklistRelay,
	createChecklistRelayState,
	reduceChecklistRelayEvent,
	type ChecklistProgress,
	type ChecklistRelayState,
} from "./checklist-relay.ts";
import type { WorkerSession } from "./worker.ts";

/** Synthetic checklist tool events (start carries the action, end the result). */
const start = (id: string, action: string): Record<string, unknown> => ({
	type: "tool_execution_start",
	toolCallId: id,
	toolName: "checklist",
	args: { action },
});
const end = (id: string, details: Record<string, unknown>, isError = false): Record<string, unknown> => ({
	type: "tool_execution_end",
	toolCallId: id,
	toolName: "checklist",
	result: { details },
	isError,
});

interface FakeSession {
	session: WorkerSession;
	/** Dispatch an event to all registered listeners. */
	emit(event: Record<string, unknown>): void;
	/** Every command the relay (or anything else) wrote to the session. */
	commands: string[];
}

/** Minimal WorkerSession stub that records any command sent (must stay empty). */
function makeFakeSession(): FakeSession {
	const listeners: Array<(event: unknown) => void> = [];
	const commands: string[] = [];
	const session = {
		onEvent(listener: (event: unknown) => void): () => void {
			listeners.push(listener);
			return () => {
				const i = listeners.indexOf(listener);
				if (i !== -1) listeners.splice(i, 1);
			};
		},
		sendCommand(): void {
			commands.push("sendCommand");
		},
		request(): Promise<any> {
			commands.push("request");
			return Promise.resolve({});
		},
		setModel(): Promise<any> {
			commands.push("setModel");
			return Promise.resolve({});
		},
		abort(): void {
			commands.push("abort");
		},
		result: new Promise(() => {}),
	} as unknown as WorkerSession;
	return {
		session,
		emit: (event) => {
			for (const l of [...listeners]) l(event);
		},
		commands,
	};
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	console.log("── test-checklist-relay: reducer + fake-session attachment ──");

	// 1. Reducer: init → total known; done/status fold into done count
	{
		const state = createChecklistRelayState();
		const i1 = reduceChecklistRelayEvent(state, start("c1", "init"));
		check(i1.update === null, "start event alone emits nothing");
		const i2 = reduceChecklistRelayEvent(state, end("c1", { items: ["a", "b", "c", "d", "e"] }));
		check(i2.update !== null && i2.update.done === 0 && i2.update.total === 5,
			`init should report 0/5, got ${JSON.stringify(i2.update)}`);
		check(state.total === 5 && state.remaining === 5, "state carries total/remaining after init");

		const d1 = reduceChecklistRelayEvent(state, start("c2", "done"));
		check(d1.update === null, "done start emits nothing");
		const d2 = reduceChecklistRelayEvent(state, end("c2", { index: 0, remaining: 4 }));
		check(d2.update !== null && d2.update.done === 1 && d2.update.total === 5,
			`done should report 1/5, got ${JSON.stringify(d2.update)}`);

		const s1 = reduceChecklistRelayEvent(state, start("c3", "status"));
		check(s1.update === null, "status start emits nothing");
		const s2 = reduceChecklistRelayEvent(state, end("c3", { remaining: 2, items: ["c", "d"] }));
		check(s2.update !== null && s2.update.done === 3 && s2.update.total === 5,
			`status should report 3/5, got ${JSON.stringify(s2.update)}`);

		const s3 = reduceChecklistRelayEvent(state, start("c4", "status"));
		const s4 = reduceChecklistRelayEvent(state, end("c4", { remaining: 0 }));
		check(s4.update !== null && s4.update.done === 5 && s4.update.total === 5,
			`all-done status should report 5/5, got ${JSON.stringify(s4.update)}`);
	}

	// 2. Reducer: non-checklist tools, errored calls, and duplicate marks are ignored
	{
		const state = createChecklistRelayState();
		reduceChecklistRelayEvent(state, start("r1", "init"));
		reduceChecklistRelayEvent(state, end("r1", { items: ["a", "b"] }));
		const irrelevant = reduceChecklistRelayEvent(state, { type: "tool_execution_end", toolName: "edit", toolCallId: "r2" });
		check(irrelevant.update === null, "non-checklist tools emit nothing");
		const noCallId = reduceChecklistRelayEvent(state, { type: "tool_execution_end", toolName: "checklist" });
		check(noCallId.update === null, "checklist end without toolCallId emits nothing");

		const bad = reduceChecklistRelayEvent(state, end("r3", { index: 99, remaining: 2 }, true));
		check(bad.update === null, "errored checklist call emits nothing");

		const dup = reduceChecklistRelayEvent(state, start("r4", "done"));
		const dup2 = reduceChecklistRelayEvent(state, end("r4", { index: 0, alreadyDone: true }));
		check(dup2.update === null, "duplicate mark (alreadyDone, no remaining) emits nothing");

		const orphan = reduceChecklistRelayEvent(state, end("r5", { remaining: 1 }));
		check(orphan.update === null, "end without a correlated start emits nothing");
		check(state.total === 2, "ignored events never corrupt state");
	}

	// 3. Reducer: done before init is impossible (tool errors), but a stray
	//    remaining with unknown total is ignored; re-init resets
	{
		const state = createChecklistRelayState();
		const stray = reduceChecklistRelayEvent(state, start("s1", "done"));
		const stray2 = reduceChecklistRelayEvent(state, end("s1", { index: 0, remaining: 1 }));
		check(stray2.update === null && state.total === null, "remaining without known total emits nothing");

		reduceChecklistRelayEvent(state, start("s2", "init"));
		reduceChecklistRelayEvent(state, end("s2", { items: ["a", "b", "c"] }));
		const reinit = reduceChecklistRelayEvent(state, start("s3", "init"));
		const reinit2 = reduceChecklistRelayEvent(state, end("s3", { items: ["x"] }));
		check(reinit2.update !== null && reinit2.update.total === 1 && reinit2.update.done === 0,
			"re-init resets total and done");
	}

	// 4. Attachment: event stream through the fake session drives onChecklist
	{
		const fake = makeFakeSession();
		const updates: ChecklistProgress[] = [];
		const ctrl = attachChecklistRelay(fake.session, { onChecklist: (p) => updates.push(p) });
		check(ctrl.latest === null, "no checklist yet before any event");

		fake.emit({ type: "message_end", message: { role: "assistant" } });
		fake.emit(start("a1", "init"));
		fake.emit(end("a1", { items: ["r1", "r2", "r3", "r4"] }));
		check(updates.length === 1, `one update after init, got ${updates.length}`);
		check(updates[0]?.done === 0 && updates[0]?.total === 4, `init update should be 0/4, got ${JSON.stringify(updates[0])}`);
		check(ctrl.latest?.total === 4, "latest getter tracks init");

		fake.emit(start("a2", "done"));
		fake.emit(end("a2", { index: 1, remaining: 3 }));
		fake.emit(start("a3", "done"));
		fake.emit(end("a3", { index: 2, remaining: 2 }));
		check(updates.length === 3, `three updates after two done calls, got ${updates.length}`);
		check(updates[2]?.done === 2, `latest update should be 2/4, got ${JSON.stringify(updates[2])}`);

		// Unrelated events pass through the listener without producing updates.
		fake.emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "a9", result: { details: {} } });
		fake.emit({ type: "session_ready", sessionId: "x" });
		check(updates.length === 3, "unrelated events emit nothing");
	}

	// 5. Observer-only: the relay never sends commands or requests
	{
		const fake = makeFakeSession();
		const ctrl = attachChecklistRelay(fake.session, { onChecklist: () => {} });
		fake.emit(start("o1", "init"));
		fake.emit(end("o1", { items: ["a"] }));
		fake.emit(start("o2", "done"));
		fake.emit(end("o2", { index: 0, remaining: 0 }));
		check(fake.commands.length === 0, `relay must be observer-only, sent ${JSON.stringify(fake.commands)}`);
		check(ctrl.latest?.done === 1, "observer-only relay still tracks state");
	}

	// 6. Detach stops updates (and is idempotent)
	{
		const fake = makeFakeSession();
		const updates: ChecklistProgress[] = [];
		const ctrl = attachChecklistRelay(fake.session, { onChecklist: (p) => updates.push(p) });
		fake.emit(start("d1", "init"));
		fake.emit(end("d1", { items: ["a"] }));
		check(updates.length === 1, "update before detach");
		ctrl.detach();
		ctrl.detach(); // idempotent
		fake.emit(start("d2", "done"));
		fake.emit(end("d2", { index: 0, remaining: 0 }));
		check(updates.length === 1, "no updates after detach");
	}

	if (errors.length > 0) {
		throw new Error("test-checklist-relay failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log("✓ reducer reconstruction + observer-only attachment, detach, zero commands");
}

// Direct execution support: `npx tsx extensions/task/test-checklist-relay.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
