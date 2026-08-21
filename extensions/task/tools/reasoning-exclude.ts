/**
 * Worker-side reasoning-exclusion — the WAVE-1 cost lever (cost-reduction
 * plan item 4).
 *
 * Loaded into worker and reviewer subprocesses via --extension. When the
 * engine sets PI_TASK_EXCLUDE_REASONING=1 on the spawn (the tier's or the
 * engine's decision), this extension injects `reasoning: { exclude: true }`
 * into EVERY outgoing provider payload of that subprocess — so the model
 * still REASONS at its configured budget (quality preserved) but the
 * reasoning output is not returned, and the accumulated `reasoning_details`
 * blobs (1-5KB each) that were being re-sent on every later turn stop
 * growing the transcript.
 *
 * Scoping is per-process on purpose (the model may run both the interactive
 * session and worker subprocesses): the env var is set only on worker/
 * reviewer spawns — the conversational session never sets it, so its
 * reasoning stays visible for review.
 *
 * No env var → the extension is a no-op (zero overhead, zero injection).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const EXCLUDE_REASONING_ENV_VAR = "PI_TASK_EXCLUDE_REASONING";

/**
 * Pure injection rule (hermetic-tested): enabled + an object payload → a
 * copy carrying `reasoning: { exclude: true }` (preserving any existing
 * reasoning fields); anything else → the payload unchanged. Never mutates
 * its input.
 */
export function injectReasoningExclude(payload: unknown, enabled: boolean): unknown {
	if (!enabled) return payload;
	if (typeof payload !== "object" || payload === null) return payload;
	const record = payload as Record<string, unknown>;
	const reasoning =
		typeof record.reasoning === "object" && record.reasoning !== null
			? { ...(record.reasoning as object) }
			: {};
	return { ...record, reasoning: { ...reasoning, exclude: true } };
}

export default function (pi: ExtensionAPI) {
	if (process.env[EXCLUDE_REASONING_ENV_VAR] !== "1") return; // not a worker/reviewer spawn
	pi.on("before_provider_request", (event: { payload: unknown }) => {
		return injectReasoningExclude(event.payload, true) as never;
	});
}