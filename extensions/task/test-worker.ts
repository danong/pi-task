/**
 * Worker event reducer + settle logic unit tests — pure functions, no
 * subprocess, no LLM. The reducer contract mirrors what spawnWorkerSession
 * observed pre-extraction: turn counting on assistant message_end,
 * usage accumulation, read/edit counting, yield capture, onUpdate events.
 */

import { pathToFileURL } from "node:url";
import {
	AGENT_SETTLED_EVENT,
	buildAbortError,
	buildWorkerArgs,
	createWorkerEventState,
	decideIdleAction,
	decideNoProgressAction,
	decideToolTimeoutAction,
	decideWallGraceAction,
	estimateReadTokens,
	formatDuration,
	isVerificationCommand,
	noProgressErrorMessage,
	reduceWorkerEvent,
	selectWorkerWallTimeout,
	settleWorker,
	summarizeToolArgs,
	toolTimeoutErrorMessage,
	wallTimeoutErrorMessage,
	workerFailureMessage,
	WORKER_NO_PROGRESS_TIMEOUT_MS,
	WORKER_TOOL_TIMEOUT_MS,
	WORKER_WALL_TIMEOUT_MS,
	type WorkerEventState,
} from "./worker.ts";

const YIELD_PAYLOAD = {
	files_changed: ["a.txt"],
	summary: "did a thing",
	commit_ids: ["abc123"],
	deviations: [],
};

function reduce(state: WorkerEventState, event: unknown) {
	return reduceWorkerEvent(state, event);
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	console.log("── test-worker: reduceWorkerEvent + settleWorker ──");

	// ─── reduceWorkerEvent ───

	// 1. Turn counting only for assistant message_end; usage summed
	{
		const state = createWorkerEventState();
		const r1 = reduce(state, {
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3, cost: { total: 0.0012 } },
			},
		});
		check(r1.updates.length === 1 && r1.updates[0].type === "turn" && r1.updates[0].turns === 1,
			`first assistant message should emit one turn update, got ${JSON.stringify(r1.updates)}`);
		const r2 = reduce(state, {
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 50, output: 10, cacheRead: 1, cacheWrite: 2, cost: { total: 0.0004 } },
			},
		});
		check(state.usage.turns === 2, `turns should be 2, got ${state.usage.turns}`);
		check(state.usage.tokens_in === 150, `tokens_in should sum to 150, got ${state.usage.tokens_in}`);
		check(state.usage.tokens_out === 30, `tokens_out should sum to 30, got ${state.usage.tokens_out}`);
		check(state.usage.cache_read === 6, `cache_read should sum to 6, got ${state.usage.cache_read}`);
		check(state.usage.cache_write === 5, `cache_write should sum to 5, got ${state.usage.cache_write}`);
		check(Math.abs(state.usage.cost_usd - 0.0016) < 1e-9, `cost should sum to 0.0016, got ${state.usage.cost_usd}`);
		check(r2.updates.length === 1 && r2.updates[0].type === "turn" && r2.updates[0].turns === 2,
			"second message should emit turn update with turns 2");
	}

	// 2. Non-assistant message_end produces no turn update
	{
		const state = createWorkerEventState();
		const { updates } = reduce(state, { type: "message_end", message: { role: "user", usage: { input: 99 } } });
		check(state.usage.turns === 0, "user message must not count as a turn");
		check(updates.length === 0, `user message should produce no updates, got ${JSON.stringify(updates)}`);
	}

	// 3. Missing usage / cost fields → no NaN, stays zero
	{
		const state = createWorkerEventState();
		reduce(state, { type: "message_end", message: { role: "assistant" } });
		reduce(state, { type: "message_end", message: { role: "assistant", usage: { input: 10 } } });
		const u = state.usage;
		check(u.turns === 2, `turns should be 2, got ${u.turns}`);
		check(u.tokens_in === 10, `tokens_in should be 10, got ${u.tokens_in}`);
		for (const [k, v] of Object.entries({ tokens_out: u.tokens_out, cache_read: u.cache_read, cache_write: u.cache_write, cost_usd: u.cost_usd })) {
			check(v === 0, `${k} should be 0 (missing fields must not produce NaN), got ${v}`);
			check(!Number.isNaN(v), `${k} must not be NaN`);
		}
	}

	// 4. read counts reads; edit/write count edits
	{
		const state = createWorkerEventState();
		reduce(state, { type: "tool_execution_end", toolName: "read" });
		reduce(state, { type: "tool_execution_end", toolName: "edit" });
		reduce(state, { type: "tool_execution_end", toolName: "write" });
		reduce(state, { type: "tool_execution_end", toolName: "grep" });
		check(state.usage.reads === 1, `reads should be 1, got ${state.usage.reads}`);
		check(state.usage.edits === 2, `edits should be 2 (edit + write), got ${state.usage.edits}`);
	}

	// 5. tool_execution_start emits tool_start update
	{
		const state = createWorkerEventState();
		const { updates } = reduce(state, { type: "tool_execution_start", toolName: "read" });
		check(updates.length === 1 && updates[0].type === "tool_start" && updates[0].toolName === "read",
			`expected tool_start(read), got ${JSON.stringify(updates)}`);
	}

	// 6. Yield captured from tool_execution_end result.details
	{
		const state = createWorkerEventState();
		const { updates } = reduce(state, {
			type: "tool_execution_end",
			toolName: "yield",
			isError: false,
			result: { details: YIELD_PAYLOAD },
		});
		check(state.yieldPayload !== null, "yield payload should be captured");
		check(state.yieldPayload?.files_changed.includes("a.txt") === true, "yield payload content wrong");
		const yieldUpdate = updates.find((u) => u.type === "yield");
		check(!!yieldUpdate && yieldUpdate.type === "yield" && yieldUpdate.yieldPayload === YIELD_PAYLOAD,
			`expected a yield update, got ${JSON.stringify(updates)}`);
		check(updates.some((u) => u.type === "tool_end" && u.toolName === "yield"), "tool_end(yield) update missing");
	}

	// 7. Yield with isError is NOT captured (but tool_end still emitted)
	{
		const state = createWorkerEventState();
		const { updates } = reduce(state, {
			type: "tool_execution_end",
			toolName: "yield",
			isError: true,
			result: { details: YIELD_PAYLOAD },
		});
		check(state.yieldPayload === null, "errored yield must not be captured");
		check(!updates.some((u) => u.type === "yield"), "errored yield must not emit a yield update");
		check(updates.some((u) => u.type === "tool_end"), "errored yield should still emit tool_end");
	}

	// 8. Unrelated events produce no updates and no state change
	{
		const state = createWorkerEventState();
		const { updates } = reduce(state, { type: "session_ready", sessionId: "x" });
		check(updates.length === 0, `unrelated event should produce no updates, got ${JSON.stringify(updates)}`);
		check(state.usage.turns === 0 && state.yieldPayload === null, "unrelated event must not change state");
	}

	// 9. Reduce is cumulative: same state object is mutated and returned
	{
		const state = createWorkerEventState();
		const out = reduce(state, { type: "message_end", message: { role: "assistant", usage: { input: 1 } } });
		check(out.state === state, "reducer should return the same state object");
	}

	// ─── settleWorker ───

	// 10. Yielded → ok with result, exitCode passed through
	{
		const state = createWorkerEventState();
		reduce(state, { type: "tool_execution_end", toolName: "yield", result: { details: YIELD_PAYLOAD } });
		const settled = settleWorker(state, 0, false, "");
		check(settled.ok === true, "yielded worker should settle ok");
		if (settled.ok) {
			check(settled.result.yield === YIELD_PAYLOAD, "settled result should carry the yield payload");
			check(settled.result.exitCode === 0, `exitCode should be 0, got ${settled.result.exitCode}`);
			check(settled.result.usage === state.usage, "settled result should carry accumulated usage");
		}
	}

	// 11. Aborted without yield → "Worker was aborted"
	{
		const state = createWorkerEventState();
		const settled = settleWorker(state, 1, true, "whatever");
		check(settled.ok === false, "aborted worker should settle as failure");
		if (!settled.ok) {
			check(settled.error.message.includes("abort"), `error should mention abort, got: ${settled.error.message}`);
		}
	}

	// 12. Exited without yield → error with code + stderr detail
	{
		const state = createWorkerEventState();
		const settled = settleWorker(state, 3, false, "boom\nstack");
		check(settled.ok === false, "bare exit should settle as failure");
		if (!settled.ok) {
			check(settled.error.message.includes("Worker exited (code 3) without yielding a result."),
				`error should include exit code, got: ${settled.error.message}`);
			check(settled.error.message.includes("stderr: boom"), `error should include stderr, got: ${settled.error.message}`);
		}
	}

	// 13. Empty stderr → no stderr section; long stderr → sliced to 500
	{
		const quiet = settleWorker(createWorkerEventState(), 1, false, "   ");
		if (!quiet.ok) {
			check(!quiet.error.message.includes("stderr:"), `empty stderr should be omitted, got: ${quiet.error.message}`);
		}
		const long = settleWorker(createWorkerEventState(), 1, false, "x".repeat(700));
		if (!long.ok) {
			const detail = long.error.message.split("stderr: ")[1] ?? "";
			check(detail.length === 500, `stderr detail should be sliced to 500 chars, got ${detail.length}`);
		}
	}

	// ─── buildWorkerArgs ───

	// 14. Default (no sessionDir) → ephemeral --no-session; yield extension always loaded
	{
		const args = buildWorkerArgs({ model: "prov/m" });
		check(args.includes("--no-session"), "default should pass --no-session");
		check(!args.includes("--session-dir"), "default must not pass --session-dir");
		check(args.includes("--mode") && args[args.indexOf("--mode") + 1] === "rpc", "should pass --mode rpc");
		check(args.includes("--model") && args[args.indexOf("--model") + 1] === "prov/m", "should pass the model");
		const extIdx = args.indexOf("--extension");
		check(extIdx !== -1 && args[extIdx + 1].endsWith("yield.ts"), `yield extension must always load, got ${args[extIdx + 1]}`);
		check(!args.includes("--append-system-prompt"), "no prompt path → no --append-system-prompt");
	}

	// 15. sessionDir → --session-dir <dir> and NO --no-session (persisted for forking)
	{
		const args = buildWorkerArgs({ model: "prov/m", sessionDir: "/tmp/sess" });
		check(args.includes("--session-dir") && args[args.indexOf("--session-dir") + 1] === "/tmp/sess", "should pass --session-dir <dir>");
		check(!args.includes("--no-session"), "sessionDir mode must not pass --no-session");
	}

	// 16. Extra extensions + system prompt path are forwarded
	{
		const args = buildWorkerArgs({
			model: "prov/m",
			extensions: ["/a/checklist.ts", "/b/prewalk.ts"],
			systemPromptPath: "/p/prompt.md",
		});
		check(args.includes("/a/checklist.ts") && args.includes("/b/prewalk.ts"), "extra extensions should be forwarded");
		check(args.filter((a) => a === "--extension").length === 3, "yield + 2 extra extensions = 3 --extension flags");
		check(
			args.includes("--append-system-prompt") && args[args.indexOf("--append-system-prompt") + 1] === "/p/prompt.md",
			"system prompt path should be forwarded",
		);
	}

	// ─── read tracking + per-turn usage (Phase 8) ───

	// 17. estimateReadTokens: text content → ceil(chars/4); non-text ignored
	{
		check(estimateReadTokens({ content: [{ type: "text", text: "x".repeat(400) }] }) === 100, "400 chars → 100 tokens");
		check(estimateReadTokens({ content: [{ type: "text", text: "abc" }] }) === 1, "3 chars → ceil(3/4)=1");
		check(estimateReadTokens({ content: [{ type: "text", text: "aa" }, { type: "text", text: "bb" }] }) === 1, "text blocks summed (4 chars → 1)");
		check(estimateReadTokens({ content: [{ type: "image", data: "zzz" }] }) === 0, "non-text blocks ignored");
		check(estimateReadTokens(undefined) === 0, "no result → 0");
		check(estimateReadTokens({ content: "notarray" }) === 0, "non-array content → 0");
	}

	// 18. Read start/end correlation captures path + approxTokens + turn
	{
		const state = createWorkerEventState();
		reduce(state, { type: "tool_execution_start", toolName: "read", toolCallId: "c1", args: { path: "src/a.ts" } });
		reduce(state, { type: "tool_execution_end", toolName: "read", toolCallId: "c1", result: { content: [{ type: "text", text: "y".repeat(80) }] } });
		check(state.reads.length === 1, `one read recorded, got ${state.reads.length}`);
		check(state.reads[0].path === "src/a.ts", `path captured, got ${state.reads[0].path}`);
		check(state.reads[0].approxTokens === 20, `80 chars → 20 tokens, got ${state.reads[0].approxTokens}`);
		check(state.reads[0].turn === 0, `read before any turn → turn 0, got ${state.reads[0].turn}`);
		check(state.usage.reads === 1, "reads count still incremented");
		check(state.pendingReadPaths.size === 0, "pending path cleared after end");
	}

	// 19. Read tagged with the current turn; end without start → path undefined
	{
		const state = createWorkerEventState();
		reduce(state, { type: "message_end", message: { role: "assistant", usage: { input: 1 } } }); // turn 1
		reduce(state, { type: "tool_execution_start", toolName: "read", toolCallId: "c2", args: { path: "b.ts" } });
		reduce(state, { type: "tool_execution_end", toolName: "read", toolCallId: "c2", result: { content: [{ type: "text", text: "z".repeat(8) }] } });
		check(state.reads[0].turn === 1, `read after 1 turn → turn 1, got ${state.reads[0].turn}`);
		reduce(state, { type: "tool_execution_end", toolName: "read", toolCallId: "orphan", result: { content: [{ type: "text", text: "q".repeat(4) }] } });
		check(state.reads.length === 2, "orphan read end still recorded");
		check(state.reads[1].path === undefined, "orphan read has undefined path");
		check(state.reads[1].approxTokens === 1, "orphan read tokens from result (4 chars → 1)");
		check(state.usage.reads === 2, "both reads counted");
	}

	// 20. Per-turn cumulative usage snapshots (copies, not aliased)
	{
		const state = createWorkerEventState();
		reduce(state, { type: "message_end", message: { role: "assistant", usage: { input: 100, output: 10, cost: { total: 0.001 } } } });
		reduce(state, { type: "message_end", message: { role: "assistant", usage: { input: 50, output: 5, cost: { total: 0.0005 } } } });
		check(state.turnUsage.length === 2, `two turn snapshots, got ${state.turnUsage.length}`);
		check(state.turnUsage[0].tokens_in === 100, `snapshot 1 tokens_in 100, got ${state.turnUsage[0].tokens_in}`);
		check(state.turnUsage[1].tokens_in === 150, `snapshot 2 cumulative tokens_in 150, got ${state.turnUsage[1].tokens_in}`);
		check(state.turnUsage[1].turns === 2, "snapshot 2 turns 2");
		check(Math.abs(state.turnUsage[1].cost_usd - 0.0015) < 1e-9, "snapshot 2 cumulative cost");
		check(state.turnUsage[0] !== state.usage, "snapshot is a copy, not the live usage object");
	}

	// ─── decideIdleAction (R1 idle-watchdog decision, pure) ───

	// 21. Non-settled events → null regardless of payload/nudge state
	{
		check(decideIdleAction("message_end", false, false) === null, "message_end → null");
		check(decideIdleAction("agent_start", true, true) === null, "agent_start ignored even with payload+nudge");
		check(decideIdleAction("", false, false) === null, "empty/unknown event type → null");
	}

	// 22. agent_settled with a captured payload → null (never nudge/fail after yield)
	{
		check(decideIdleAction(AGENT_SETTLED_EVENT, true, false) === null, "settled with payload → null");
		check(decideIdleAction(AGENT_SETTLED_EVENT, true, true) === null, "settled with payload after nudge → null");
	}

	// 23. First settled-without-payload → nudge; second → fail
	{
		check(decideIdleAction(AGENT_SETTLED_EVENT, false, false) === "nudge", "first settle without payload → nudge");
		check(decideIdleAction(AGENT_SETTLED_EVENT, false, true) === "fail", "second settle without payload → fail");
	}

	// ─── no-progress watchdog (todo #74: fail-fast on a hung worker) ───

	// 25. formatDuration renders compactly (minutes / seconds / ms)
	{
		check(formatDuration(45 * 60_000) === "45m", `45 min → 45m, got ${formatDuration(45 * 60_000)}`);
		check(formatDuration(10 * 60_000) === "10m", `10 min → 10m, got ${formatDuration(10 * 60_000)}`);
		check(formatDuration(90_000) === "90s", `90s, got ${formatDuration(90_000)}`);
		check(formatDuration(250) === "250ms", `250ms, got ${formatDuration(250)}`);
	}

	// 26. decideNoProgressAction: an in-flight tool call always counts as progress
	{
		check(
			decideNoProgressAction({ nowMs: 1_000_000, lastActivityMs: 0, timeoutMs: 1_000, inToolCall: true }) === null,
			"in-flight tool call → null even far past the window (long silent bash/test tools are legit)",
		);
	}

	// 27. decideNoProgressAction: within window → null; at/past window → abort; recent activity resets
	{
		check(
			decideNoProgressAction({ nowMs: 500, lastActivityMs: 0, timeoutMs: 1_000, inToolCall: false }) === null,
			"within the window → null",
		);
		check(
			decideNoProgressAction({ nowMs: 1_000, lastActivityMs: 0, timeoutMs: 1_000, inToolCall: false }) === "abort",
			"exactly at the window → abort",
		);
		check(
			decideNoProgressAction({ nowMs: 1_001, lastActivityMs: 0, timeoutMs: 1_000, inToolCall: false }) === "abort",
			"past the window → abort",
		);
		check(
			decideNoProgressAction({ nowMs: 5_000, lastActivityMs: 4_500, timeoutMs: 1_000, inToolCall: false }) === null,
			"recent activity resets the clock → null",
		);
	}

	// 28. Error messages name the CAUSE + limits (visible, not generic)
	{
		const np = noProgressErrorMessage(WORKER_NO_PROGRESS_TIMEOUT_MS, WORKER_WALL_TIMEOUT_MS);
		check(np.includes("no progress"), `no-progress message names the cause, got: ${np}`);
		check(np.includes("10m"), `no-progress message names the no-progress window, got: ${np}`);
		check(np.includes("45m"), `no-progress message names the wall limit, got: ${np}`);
		const wt = wallTimeoutErrorMessage(WORKER_WALL_TIMEOUT_MS);
		check(wt.includes("wall-timeout"), `wall message names the cause, got: ${wt}`);
		check(wt.includes("45m"), `wall message names the limit, got: ${wt}`);
	}

	// ─── tool_end isError passthrough (progress view keys off the swap signal) ───

	// 24. tool_end updates carry isError: successful edit/write vs errored
	{
		const state = createWorkerEventState();
		const ok = reduce(state, { type: "tool_execution_end", toolName: "edit", isError: false });
		check(ok.updates.some((u) => u.type === "tool_end" && u.toolName === "edit" && u.isError === false),
			`successful edit should carry isError=false, got ${JSON.stringify(ok.updates)}`);
		const bad = reduce(state, { type: "tool_execution_end", toolName: "write", isError: true });
		check(bad.updates.some((u) => u.type === "tool_end" && u.toolName === "write" && u.isError === true),
			`errored write should carry isError=true, got ${JSON.stringify(bad.updates)}`);
		const noFlag = reduce(state, { type: "tool_execution_end", toolName: "read" });
		check(noFlag.updates.some((u) => u.type === "tool_end" && u.isError === false),
			"missing isError flag normalizes to false");
	}

	// ─── Failure diagnostics (todo #86) ─────────────────────────
	// summarizeToolArgs truncates long tool arguments.
	{
		check(summarizeToolArgs({ command: "ls" }) === '{"command":"ls"}',
			`summarizeToolArgs: object args stringify, got ${summarizeToolArgs({ command: "ls" })}`);
		const long = "x".repeat(300);
		const truncated = summarizeToolArgs(long);
		check(truncated.length === 150 && truncated.endsWith("..."),
			`summarizeToolArgs: long args truncate to 150 chars, got length ${truncated.length}`);
	}
	// workerFailureMessage: cause line + turns/idle/last tool/stderr tail;
	// empty sections are omitted.
	{
		const msg = workerFailureMessage({
			cause: "Worker wall-timeout: ...",
			turns: 47,
			idleMs: 9 * 60_000,
			lastTool: { name: "bash", args: '{command: "timeout 120 npx tsx test.ts"}' },
			stderrTail: "  error: boom\n",
		});
		check(msg.includes("Worker wall-timeout"), "message carries the cause");
		check(msg.includes("turns: 47 | idle: 9m"), `turns+idle line, got: ${msg}`);
		check(msg.includes("last tool: bash("), "message carries the last tool");
		check(msg.includes("stderr (last 2048 chars):"), "message carries the stderr tail");
		const bare = workerFailureMessage({ cause: "c", turns: 0, idleMs: 0, lastTool: null, stderrTail: "" });
		check(!bare.includes("last tool") && !bare.includes("stderr"), "empty sections are omitted");
	}
	// buildAbortError: message + structured diagnostics on the error.
	{
		const err = buildAbortError({ cause: null, turns: 3, idleMs: 1000, lastTool: null, stderrTail: "x" });
		check(err.message.startsWith("Worker was aborted"),
			`null cause defaults to the generic message, got: ${err.message}`);
		const d = (err as unknown as { diagnostics?: { cause: string; turns: number } }).diagnostics;
		check(d?.cause === "Worker was aborted" && d?.turns === 3, "diagnostics carry cause + turns");
		const specific = buildAbortError({ cause: "no progress", turns: 1, idleMs: 0, lastTool: null, stderrTail: "" });
		check(specific.message.startsWith("no progress"), "specific cause wins over the generic");
	}

	// ─── tool-call timeout (Phase 11, R4) + per-tier wall (R5) ───

	// 29. decideToolTimeoutAction: within budget → null; at/past → abort
	{
		check(
			decideToolTimeoutAction({ nowMs: 500, startedAtMs: 0, timeoutMs: 1_000 }) === null,
			"tool within budget → null",
		);
		check(
			decideToolTimeoutAction({ nowMs: 1_000, startedAtMs: 0, timeoutMs: 1_000 }) === "abort",
			"tool exactly at the budget → abort",
		);
		check(
			decideToolTimeoutAction({ nowMs: 1_001, startedAtMs: 0, timeoutMs: 1_000 }) === "abort",
			"tool past the budget → abort",
		);
		check(
			decideToolTimeoutAction({ nowMs: 9_999, startedAtMs: 9_000, timeoutMs: 1_000 }) === null,
			"recent start resets the clock → null",
		);
	}

	// 30. toolTimeoutErrorMessage names the tool + its truncated arguments,
	//     and why the no-progress watchdog could not catch the hang.
	{
		const args = summarizeToolArgs({ command: "timeout 120 npx tsx test.ts" });
		const msg = toolTimeoutErrorMessage(15 * 60_000, "bash", args);
		check(msg.includes('tool "bash"'), `message names the tool, got: ${msg}`);
		check(msg.includes('{"command":"timeout 120 npx tsx test.ts"}'), `message carries the args, got: ${msg}`);
		check(msg.includes("15m"), `message names the budget, got: ${msg}`);
		check(msg.includes("no-progress"), `message explains the no-progress gap, got: ${msg}`);
		// A long command is truncated to the 150-char summarizeToolArgs form.
		const longMsg = toolTimeoutErrorMessage(15 * 60_000, "bash", summarizeToolArgs("x".repeat(300)));
		check(longMsg.includes("…") || longMsg.includes("..."), "long args appear truncated in the message");
	}

	// 31. selectWorkerWallTimeout: the resolved tier's wall wins; unset →
	//     the built-in 45-min default (Phase 11, R5).
	{
		check(selectWorkerWallTimeout(25 * 60_000) === 25 * 60_000,
			"resolved tier wall (25 min) wins");
		check(selectWorkerWallTimeout(undefined) === WORKER_WALL_TIMEOUT_MS,
			"no tier wall → the built-in 45-min default");
		check(WORKER_WALL_TIMEOUT_MS === 45 * 60_000, "built-in wall is 45 min");
		check(WORKER_TOOL_TIMEOUT_MS === 15 * 60_000, "built-in tool timeout is 15 min");
	}

	// 32. isVerificationCommand: lenient prefix/suffix/exact matching so the
	//     wall grace recognizes the spec's suite commands however the worker
	//     wraps them (cd, timeout, env prefixes...).
	{
		const cmds = ["flutter test", "npm test", "npx tsx extensions/task/test.ts"];
		check(isVerificationCommand("flutter test", cmds) === true, "exact match");
		check(isVerificationCommand("cd app && flutter test", cmds) === true, "suffix match (cd && cmd)");
		check(isVerificationCommand("timeout 300 flutter test", cmds) === true, "prefix match (timeout wrapper)");
		check(isVerificationCommand("flutter test --coverage", cmds) === true, "prefix match (flags)");
		check(isVerificationCommand("make build", cmds) === false, "unrelated command does not match");
		check(isVerificationCommand("flutter test", []) === false, "no commands → never matches");
	}

	// 33. decideWallGraceAction: the wall expiry aborts unless verification is
	//     in flight; the grace is bounded and ends early on non-verification work.
	{
		const mk = (over: Record<string, unknown>) => ({
			wallExpired: false,
			graceExhausted: false,
			verificationInFlight: false,
			newToolIsVerification: null,
			...over,
		});
		check(decideWallGraceAction(mk({})) === "continue", "wall not expired → continue");
		check(
			decideWallGraceAction(mk({ wallExpired: true, verificationInFlight: true })) === "continue",
			"wall expired + verification in flight → grace continues",
		);
		check(
			decideWallGraceAction(mk({ wallExpired: true, verificationInFlight: true, graceExhausted: true })) === "abort",
			"grace exhausted → abort even mid-verification",
		);
		check(
			decideWallGraceAction(mk({ wallExpired: true, verificationInFlight: false })) === "abort",
			"wall expired + no verification → abort",
		);
		check(
			decideWallGraceAction(mk({ wallExpired: true, verificationInFlight: true, newToolIsVerification: false })) === "abort",
			"wall expired + worker left the suite → abort",
		);
		check(
			decideWallGraceAction(mk({ wallExpired: true, verificationInFlight: true, newToolIsVerification: true })) === "continue",
			"wall expired + new tool is another verification command → continue",
		);
	}

	if (errors.length > 0) {
		throw new Error("test-worker failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log("✓ turns, usage sums, no-NaN, reads/edits, yield capture, settle branches, worker args, read tracking + per-turn usage, decideIdleAction, no-progress watchdog (todo #74), tool_end isError");
}

// Direct execution support: `npx tsx extensions/task/test-worker.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
