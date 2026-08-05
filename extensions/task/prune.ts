/**
 * Review-context pruning — pure message filter (Phase 7).
 *
 * A forked reviewer inherits the worker's full conversation (reads, bash
 * outputs, reasoning, edits, checklist state). To review adversarially —
 * not self-confirmingly — it must reason from the FACTUAL context (what was
 * read, what ran) without the worker's commitment to its chosen approach.
 * This filter keeps the facts and drops the bias:
 *
 *   kept:    user messages (the task) and factual tool results
 *            (read / bash / grep / find / ...)
 *   dropped: assistant reasoning (text/thinking blocks); edit / write /
 *            checklist / yield tool calls AND their results; custom
 *            extension state entries (checklist / prewalk)
 *
 * The worker's edits are replaced by the final diff, which the review runner
 * (review.ts) injects separately — pruning only removes the edit calls here.
 *
 * The planning instruction needs no pruning: prewalk injects it as a
 * per-process system-prompt modification (before_agent_start), which is not
 * persisted as a session message, and the forked reviewer rebuilds its own
 * system prompt (the adversarial persona).
 *
 * Dependency-free (no pi import) so it is hermetically testable. The
 * reviewer-side extension (tools/findings.ts) calls this from its `context`
 * handler — the same mechanism checklist injection uses.
 */

/** Loose structural view of an AgentMessage (avoids a pi runtime dependency). */
export interface ReviewMessage {
	role: string;
	/** assistant: content blocks; user: string | blocks; toolResult: blocks. */
	content?: unknown;
	/** Present on toolResult messages. */
	toolName?: string;
	[k: string]: unknown;
}

interface ContentBlock {
	type?: string;
	/** toolCall blocks carry the tool name. */
	name?: string;
	[k: string]: unknown;
}

/** Tools whose calls/results are commitment or bias and are pruned. The
 *  worker's final diff is injected by the review runner instead of the
 *  step-by-step edit calls. */
export const DEFAULT_DROP_TOOLS = ["edit", "write", "checklist", "yield"];

export interface PruneOptions {
	/** Tool names to drop (calls + results). Defaults to DEFAULT_DROP_TOOLS. */
	dropTools?: string[];
}

/**
 * Filter inherited conversation messages down to the factual context a
 * detached reviewer needs. Pure: returns a new array; a kept message is
 * shallow-copied only when its content is rewritten (assistant blocks).
 */
export function pruneReviewContext<T extends { role: string }>(messages: T[], opts: PruneOptions = {}): T[] {
	const dropTools = new Set(opts.dropTools ?? DEFAULT_DROP_TOOLS);
	const out: T[] = [];

	for (const m of messages) {
		// Loose field view (the generic constraint only guarantees `role`).
		const msg = m as unknown as ReviewMessage;

		// Custom extension state entries (checklist/prewalk) — commitment, drop.
		if (msg.role === "custom") continue;

		// Tool results: keep factual tools, drop biased/commitment tools.
		if (msg.role === "toolResult") {
			if (!dropTools.has(msg.toolName ?? "")) out.push(m);
			continue;
		}

		// Assistant: drop reasoning (text/thinking) and biased tool calls; keep
		// factual tool calls (so kept tool results stay paired with their call).
		// Drop the whole message if nothing remains.
		if (msg.role === "assistant") {
			const blocks = Array.isArray(msg.content) ? (msg.content as ContentBlock[]) : [];
			const kept = blocks.filter((b) => {
				if (b?.type === "text" || b?.type === "thinking") return false;
				if (b?.type === "toolCall") return !dropTools.has(b?.name ?? "");
				return true; // keep unknown block types
			});
			if (kept.length > 0) out.push({ ...m, content: kept } as T);
			continue;
		}

		// user (the task) and any other role: keep as-is.
		out.push(m);
	}

	return out;
}
