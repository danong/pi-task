/**
 * dispute_verification — worker-side challenge tool (Phase 2 of the
 * verification lifecycle).
 *
 * A worker that believes a verification command is defective (broken
 * pattern, wrong intent, environment-dependent) calls this tool instead
 * of hacking code to satisfy a bad gate. The tool RECORDS the dispute;
 * the ENGINE adjudicates it against evidence at verification time
 * (orchestrator.adjudicateDisputes): a dispute is upheld only when the
 * command's current failure matches its pre-change baseline exactly
 * (exit + output signature). Disputes never override the gate
 * unilaterally — autonomy bounded by mechanics.
 *
 * Recorded disputes travel with the yield payload automatically (the
 * yield extension drains the collector) — the worker does not re-state
 * them. The module collector is shared process state: both extensions
 * load in the same worker process and import this module once.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface RecordedDispute {
	command: string;
	reason: string;
}

const recorded: RecordedDispute[] = [];

/** Record a dispute (deduped by command — the first reason wins). */
export function recordDispute(dispute: RecordedDispute): void {
	if (!recorded.some((d) => d.command === dispute.command)) {
		recorded.push(dispute);
	}
}

/** Drain the recorded disputes (yield calls this exactly once). */
export function takeRecordedDisputes(): RecordedDispute[] {
	return recorded.splice(0, recorded.length);
}

/** Pure: the adjudication contract shown back to the worker. */
export function disputeRecordedMessage(command: string): string {
	return (
		`Dispute recorded for ENGINE adjudication: ${command}\n` +
		`The engine compares the command's failure against its pre-change baseline evidence: ` +
		`identical failure (exit + output) → upheld and excluded from the gate; anything else → rejected. ` +
		`Disputes never override the gate unilaterally. Do NOT edit code to satisfy a command you believe is ` +
		`defective — finish the rest of the work and yield; the adjudication travels with your yield.`
	);
}

export const DisputeVerificationSchema = Type.Object({
	command: Type.String({
		description:
			"The EXACT verification command being disputed (copy it verbatim from the spec)",
	}),
	reason: Type.String({
		description:
			"Why the command is defective — e.g. the pattern substring-matches a live symbol, it tests the wrong thing, or it depends on the environment",
	}),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "dispute_verification",
		label: "Dispute verification",
		description:
			"Challenge a verification command you believe is DEFECTIVE (broken pattern, wrong intent, " +
			"environment-dependent) instead of hacking code to satisfy it. The ENGINE adjudicates the dispute " +
			"against its pre-change baseline evidence at verification time; upheld disputes are excluded from " +
			"the gate, rejected ones are recorded. Call once per disputed command, any time before yield().",
		parameters: DisputeVerificationSchema,

		execute(_toolCallId, params) {
			const command = params.command.trim();
			const reason = params.reason.trim();
			if (command.length === 0 || reason.length === 0) {
				return Promise.resolve({
					content: [
						{
							type: "text",
							text: "Both command (verbatim) and reason are required.",
						},
					],
					details: {},
				});
			}
			recordDispute({ command, reason });
			return Promise.resolve({
				content: [{ type: "text", text: disputeRecordedMessage(command) }],
				details: { command, reason },
			});
		},
	});
}
