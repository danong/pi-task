/**
 * Reviewer-side extension: the report_findings completion gate PLUS the
 * context-pruning filter that strips the worker's commitment from the
 * inherited session (see prune.ts) before each reviewer LLM call.
 *
 * Loaded inside the forked reviewer subprocess via --extension. When the
 * reviewer calls report_findings(), pi validates the args against
 * ReviewResultSchema, then this tool returns a terminating result and shuts
 * down the RPC session. Mirrors tools/yield.ts (the worker completion gate):
 * terminate:true skips the follow-up LLM call; ctx.shutdown() closes the
 * session (deferred until idle in RPC mode, immediate after a terminating
 * tool result).
 *
 * The orchestrator's review runner captures the payload from the
 * tool_execution_end event's result.details (same mechanism as yield).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ReviewResultSchema } from "../schemas/findings.ts";
import { pruneReviewContext } from "../prune.ts";

export default function (pi: ExtensionAPI) {
	// Prune the inherited worker context before each reviewer LLM call: keep
	// the factual reads/bash, drop the worker's reasoning/edits/checklist so
	// the review is adversarial rather than self-confirming. Same mechanism
	// as checklist injection (the context handler returns modified messages).
	pi.on("context", (event) => {
		return { messages: pruneReviewContext(event.messages) };
	});
	pi.registerTool({
		name: "report_findings",
		label: "Report findings",
		description:
			"Return your structured review report and terminate the session. " +
			"Call this exactly once, when your review is complete: a verdict " +
			"(ship/fix/escalate), your prioritized findings (P0-P3), and a " +
			"per-requirement status for every spec requirement. This is your " +
			"final action — the session ends after report_findings.",
		parameters: ReviewResultSchema,

		execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ctx.shutdown();
			return Promise.resolve({
				content: [{ type: "text", text: "Review report accepted." }],
				details: { ...params },
				terminate: true,
			});
		},
	});
}
