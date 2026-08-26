/**
 * Prewalk planning extension — worker-side (Phase 3).
 *
 * Injects a planning instruction into the system prompt for the worker's
 * exploration phase, then prunes it once the worker lands its first edit
 * (the same event that triggers the orchestrator's model swap). The
 * execute model never sees the planning instruction.
 *
 * Mechanism (empirically verified via probe):
 * - before_agent_start fires ONCE per agent run, and the system prompt
 *   it returns persists for every LLM call in that run.
 * - Therefore: inject once, and strip from each outgoing provider request
 *   payload after the first edit.
 * - For our models, the system prompt lives at payload.messages[0]
 *   (role "system", string content). Stripping is an exact suffix match
 *   of what was appended — no regex, no ambiguity.
 *
 * Reports pruning state via ctx.ui.setStatus("prewalk", "active"|"pruned")
 * so the orchestrator/test can observe it on the RPC event stream
 * (extension_ui_request events).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PLANNING_INSTRUCTION =
	"Before editing: explore thoroughly, then capture your plan as a checklist. " +
	"Keep the checklist to 12 items maximum. Each item should have a clear verification step.";

// The exact suffix appended to the system prompt; removed verbatim at prune time.
const PLANNING_SUFFIX = "\n\n" + PLANNING_INSTRUCTION;

export default function (pi: ExtensionAPI) {
	let planningDone = false;

	// The orchestrator swaps the model on this same event; pruning is
	// independent (stop showing planning framing to the execute model).
	pi.on("tool_execution_end", (event) => {
		if (
			!planningDone &&
			(event.toolName === "edit" || event.toolName === "write") &&
			!event.isError
		) {
			planningDone = true;
		}
	});

	pi.on("before_agent_start", (event) => {
		return {
			systemPrompt: event.systemPrompt + PLANNING_SUFFIX,
		};
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (planningDone) {
			stripPlanningSuffix(event.payload as Record<string, unknown>);
		}
		ctx.ui.setStatus("prewalk", planningDone ? "pruned" : "active");
	});
}

function stripPlanningSuffix(payload: Record<string, unknown>): void {
	const rawMessages: unknown = payload.messages;
	const messages: unknown[] = Array.isArray(rawMessages) ? rawMessages : [];
	const sysMsg = messages.find(
		(m) => (m as { role?: string }).role === "system",
	);
	if (!sysMsg) return;

	const content = (sysMsg as { content?: unknown }).content;
	if (typeof content === "string" && content.endsWith(PLANNING_SUFFIX)) {
		(sysMsg as { content: string }).content = content.slice(
			0,
			-PLANNING_SUFFIX.length,
		);
	}
}
