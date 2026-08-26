/**
 * Session-ID injection — the wave-4 cost-plan correlation item.
 *
 * Loaded into EVERY pi process that talks to a provider: the INTERACTIVE
 * session (via the project's package extension wiring) as well as every
 * worker/reviewer subprocess (via --extension). It injects a top-level
 * `session_id` string into each outgoing provider payload so a run's traffic
 * is attributable/correlatable downstream (OpenRouter dashboard) — which
 * cheapens debugging by grouping a run's requests.
 *
 * The identifier is one shared, per-launch-stable value, resolved at REQUEST
 * time (not only at load) with run-override precedence:
 *   1. the PI_TASK_SESSION_ID env var — the engine sets it to the RUN id on
 *      worker/reviewer spawns, so every subprocess of a run shares one id
 *      (per-run correlation); and
 *   2. the pi session's own session id (a cheap synchronous read) — the
 *      ambient source for the interactive session, which never sets the env
 *      var, so the conversational agent's own traffic is attributable too.
 *
 * Policy: an identifier longer than 256 characters is DROPPED (never
 * truncated) and the drop is logged; the payload otherwise passes through
 * unchanged.
 *
 * No identifier → the extension is a strict no-op (zero overhead, zero
 * injection). The field lands only under before_provider_request — it never
 * enters prompt text, so the deterministic-prefix/cache rule is preserved.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const SESSION_ID_ENV_VAR = "PI_TASK_SESSION_ID";
/** Cap on a usable session_id; longer values are dropped, never truncated. */
export const SESSION_ID_MAX_LENGTH = 256;

/**
 * Pure injection rule (hermetic-tested): a non-empty identifier within the
 * cap + an object payload → a copy carrying a top-level string `session_id`
 * (all other fields preserved); anything else → the payload unchanged.
 * Non-object payloads, an absent/empty identifier, and an over-cap
 * identifier (>256 chars → DROPPED, never truncated) all return the input
 * as-is. Never mutates its input.
 */
export function injectSessionId(
	payload: unknown,
	sessionId: string | undefined,
): unknown {
	if (!sessionId) return payload;
	if (sessionId.length > SESSION_ID_MAX_LENGTH) return payload; // dropped, never truncated
	if (typeof payload !== "object" || payload === null) return payload;
	return { ...(payload as Record<string, unknown>), session_id: sessionId };
}

/**
 * Pure precedence rule (hermetic-tested), run-override: a spawn-provided
 * PI_TASK_SESSION_ID (the run id) wins so a run's subprocesses all correlate
 * on one id; the pi session's own id is the ambient fallback (the interactive
 * session, which never sets the env var). Returns undefined when neither is
 * present — the extension is then a strict no-op.
 */
export function resolveSessionId(
	piSessionId: string | undefined,
	envSessionId: string | undefined,
): string | undefined {
	if (envSessionId) return envSessionId;
	if (piSessionId) return piSessionId;
	return undefined;
}

let dropLogged = false;

export default function (pi: ExtensionAPI) {
	pi.on(
		"before_provider_request",
		(event: { payload: unknown }, ctx: ExtensionContext) => {
			// Read the identifier at REQUEST time so it reflects the current
			// process/session rather than a stale load-time capture.
			let piSessionId: string | undefined;
			try {
				const id = ctx?.sessionManager?.getSessionId?.();
				if (typeof id === "string" && id.length > 0) piSessionId = id;
			} catch {
				piSessionId = undefined;
			}
			const sessionId = resolveSessionId(
				piSessionId,
				process.env[SESSION_ID_ENV_VAR],
			);
			if (!sessionId) return; // strict no-op when no identifier is present
			if (sessionId.length > SESSION_ID_MAX_LENGTH) {
				// Drop (never truncate); log once per process so it is surfaceable.
				if (!dropLogged) {
					dropLogged = true;
					console.warn(
						`[session-id] session_id dropped: ${sessionId.length} chars exceeds the ` +
							`${SESSION_ID_MAX_LENGTH}-char cap (not truncated); request sent without it`,
					);
				}
				return;
			}
			return injectSessionId(event.payload, sessionId);
		},
	);
}
