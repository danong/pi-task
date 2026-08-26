/**
 * Hermetic tests for review-context pruning (prune.ts) — pure message
 * filtering, no subprocess, no LLM. Feeds synthetic AgentMessage-shaped
 * objects and asserts the factual context survives while the worker's
 * commitment (reasoning, edits, checklist, custom state) is removed.
 *
 * Run standalone: npx tsx extensions/task/test-prune.ts
 */

import { pathToFileURL } from "node:url";
import {
	pruneReviewContext,
	DEFAULT_DROP_TOOLS,
	type ReviewMessage,
} from "./prune.ts";

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// message constructors
	const user = (t: string): ReviewMessage => ({ role: "user", content: t });
	const toolResult = (toolName: string, t: string): ReviewMessage => ({
		role: "toolResult",
		toolName,
		content: [{ type: "text", text: t }],
	});
	const assistant = (...content: unknown[]): ReviewMessage => ({
		role: "assistant",
		content,
	});
	const text = (t: string) => ({ type: "text", text: t });
	const thinking = (t: string) => ({ type: "thinking", thinking: t });
	const call = (name: string, id = "c1") => ({
		type: "toolCall",
		id,
		name,
		arguments: {},
	});
	const custom = (): ReviewMessage => ({
		role: "custom",
		customType: "pi-task-checklist",
		data: {},
	});

	/** Minimal content-block shape asserted by these tests (the subset of
	 *  prune.ts's internal ContentBlock that the fixtures carry). */
	interface TestBlock {
		type?: string;
		name?: string;
		[k: string]: unknown;
	}

	// 1. Empty in → empty out
	check(
		pruneReviewContext([]).length === 0,
		"empty input should prune to empty",
	);

	// 2. User messages (the task) are kept verbatim
	{
		const out = pruneReviewContext([user("build the thing")]);
		check(
			out.length === 1 &&
				out[0]!.role === "user" &&
				out[0]!.content === "build the thing",
			"user message should be kept verbatim",
		);
	}

	// 3. Factual tool results kept; biased/commitment tool results dropped
	{
		const out = pruneReviewContext([
			toolResult("read", "file contents"),
			toolResult("bash", "test output"),
			toolResult("grep", "matches"),
			toolResult("edit", "edit applied"),
			toolResult("write", "file written"),
			toolResult("checklist", "marked done"),
			toolResult("yield", "yield accepted"),
		]);
		const names = out.map((m) => m.toolName);
		check(
			JSON.stringify(names) === JSON.stringify(["read", "bash", "grep"]),
			`should keep read/bash/grep results only, got ${JSON.stringify(names)}`,
		);
	}

	// 4. Assistant reasoning (text/thinking) dropped; factual tool calls kept
	{
		const out = pruneReviewContext([
			assistant(
				text("I'll approach this by..."),
				thinking("let me plan"),
				call("read", "r1"),
			),
		]);
		check(
			out.length === 1,
			"assistant message with a kept tool call should survive",
		);
		const blocks = out[0]!.content as TestBlock[];
		check(
			blocks.length === 1 &&
				blocks[0]!.type === "toolCall" &&
				blocks[0]!.name === "read",
			`only the read toolCall should remain, got ${JSON.stringify(blocks)}`,
		);
	}

	// 5. Assistant message that is ONLY reasoning is dropped entirely
	{
		const out = pruneReviewContext([assistant(text("just thinking out loud"))]);
		check(
			out.length === 0,
			"pure-reasoning assistant message should be dropped",
		);
	}

	// 6. Biased tool calls dropped from assistant messages; empty → dropped
	{
		const out = pruneReviewContext([
			assistant(call("edit"), call("checklist")),
		]);
		check(
			out.length === 0,
			"assistant message with only biased tool calls should be dropped",
		);
	}

	// 7. Custom extension state entries dropped
	{
		const out = pruneReviewContext([custom(), user("task")]);
		check(
			out.length === 1 && out[0]!.role === "user",
			"custom entries should be dropped, user kept",
		);
	}

	// 8. Realistic mixed conversation → expected pruned shape
	{
		const convo: ReviewMessage[] = [
			user("Handle UTF-8 BOM in the parser"), // kept
			custom(), // dropped (checklist state)
			assistant(text("My plan: ..."), call("read", "r1")), // → read call only
			toolResult("read", "parser source"), // kept
			assistant(text("Now I'll edit"), call("edit", "e1")), // → dropped (only edit call)
			toolResult("edit", "applied"), // dropped
			assistant(text("Done"), call("yield", "y1")), // → dropped (only yield call)
			toolResult("yield", "accepted"), // dropped
		];
		const out = pruneReviewContext(convo);
		const shape = out.map((m) =>
			m.role === "toolResult"
				? `toolResult:${m.toolName}`
				: m.role === "assistant"
					? `assistant[${(m.content as TestBlock[]).map((b) => b.name ?? b.type).join(",")}]`
					: m.role,
		);
		check(
			JSON.stringify(shape) ===
				JSON.stringify(["user", "assistant[read]", "toolResult:read"]),
			`pruned shape wrong, got ${JSON.stringify(shape)}`,
		);
	}

	// 9. dropTools override changes what is pruned
	{
		const out = pruneReviewContext(
			[toolResult("edit", "x"), toolResult("read", "y")],
			{ dropTools: ["read"] },
		);
		const names = out.map((m) => m.toolName);
		check(
			JSON.stringify(names) === JSON.stringify(["edit"]),
			`override dropTools should drop read only, got ${JSON.stringify(names)}`,
		);
	}

	// 10. Malformed assistant content (non-array) → dropped, no throw
	{
		const out = pruneReviewContext([{ role: "assistant", content: "oops" }]);
		check(
			out.length === 0,
			"assistant with non-array content should be dropped without throwing",
		);
	}

	// 11. DEFAULT_DROP_TOOLS is the documented set
	check(
		JSON.stringify([...DEFAULT_DROP_TOOLS].sort()) ===
			JSON.stringify(["checklist", "edit", "write", "yield"]),
		`DEFAULT_DROP_TOOLS changed unexpectedly: ${JSON.stringify(DEFAULT_DROP_TOOLS)}`,
	);

	// 12. Input array is not mutated (pure)
	{
		const input: ReviewMessage[] = [assistant(text("x"), call("read"))];
		const before = JSON.stringify(input);
		pruneReviewContext(input);
		check(
			JSON.stringify(input) === before,
			"pruneReviewContext must not mutate its input",
		);
	}

	if (errors.length > 0) {
		return Promise.reject(
			new Error("test-prune failed:\n  ✗ " + errors.join("\n  ✗ ")),
		);
	}
	console.log(
		"✓ pruning: keeps task+reads/bash, drops reasoning/edits/checklist/custom, pure",
	);
	return Promise.resolve();
}

// Direct execution support: `npx tsx extensions/task/test-prune.ts`
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
