/**
 * Yield tool — worker-side extension (the completion gate).
 *
 * Loaded inside the worker subprocess via --extension. When the worker
 * calls yield(), pi validates the args against YieldSchema, then this
 * tool returns a terminating result and shuts down the RPC session.
 *
 * terminate: true skips the follow-up LLM call.
 * ctx.shutdown() closes the RPC session (deferred until idle in RPC mode,
 * which is immediate after a terminating tool result).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { YieldSchema } from "../schemas/yield.ts";
import { takeRecordedDisputes, type RecordedDispute } from "./dispute.ts";

/** Pure: tool-recorded disputes + inline yield disputes, deduped by command. */
export function mergeDisputes(
	recordedDisputes: RecordedDispute[],
	inline: Array<{ command: string; reason: string }> | undefined,
): Array<{ command: string; reason: string }> {
	const merged: Array<{ command: string; reason: string }> = [...recordedDisputes];
	for (const d of inline ?? []) {
		if (!merged.some((m) => m.command === d.command)) merged.push(d);
	}
	return merged;
}

/** Contract enforcement: files_changed is repo-relative, whatever the model reports. */
function toRepoRelative(cwd: string, p: string): string {
	const prefix = cwd.replace(/\\/g, "/") + "/";
	const norm = p.replace(/\\/g, "/");
	return norm.startsWith(prefix) ? norm.slice(prefix.length) : norm;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "yield",
		label: "Yield",
		description:
			"Return your typed result and terminate the session. " +
			"Call this when all requirements are complete and verification has passed. " +
			"This is your final action — the session ends after yield.",
		parameters: YieldSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ctx.shutdown();
			return {
				content: [{ type: "text", text: "Yield accepted." }],
				details: {
					...params,
					files_changed: params.files_changed.map((p) => toRepoRelative(ctx.cwd, p)),
					// Disputes recorded via dispute_verification travel with the
					// yield automatically (deduped with any inline params.disputes).
					disputes: mergeDisputes(takeRecordedDisputes(), params.disputes),
				},
				terminate: true,
			};
		},
	});
}
