/**
 * Service-tier injection — worker/review-side extension.
 *
 * Loaded into worker and reviewer subprocesses via --extension. When the
 * engine spawns a subprocess for a run whose budget tier declares a
 * service tier (task.toml `[budget.*] service_tier`), it sets the
 * PI_TASK_SERVICE_TIER env var; this extension then injects
 * `service_tier` into EVERY outgoing provider payload of that subprocess.
 *
 * Scoping is per-process on purpose: the tier is a property of the RUN
 * (the budget tier), never of the model. The same model can serve an
 * async flex run here and the interactive session at standard speed —
 * the conversational session never sets the env var, so it is untouched.
 *
 * No env var → the extension is a no-op (zero overhead, zero injection).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SERVICE_TIER_ENV_VAR = "PI_TASK_SERVICE_TIER";

const VALID_SERVICE_TIERS = new Set(["flex", "priority"]);

/**
 * Pure injection rule (hermetic-tested): a valid tier + object payload →
 * a copy carrying `service_tier`; anything else → the payload unchanged.
 * Never mutates its input.
 */
export function injectServiceTier(payload: unknown, tier: string | undefined): unknown {
	if (!tier || !VALID_SERVICE_TIERS.has(tier)) return payload;
	if (typeof payload !== "object" || payload === null) return payload;
	return { ...(payload as Record<string, unknown>), service_tier: tier };
}

export default function (pi: ExtensionAPI) {
	const tier = process.env[SERVICE_TIER_ENV_VAR];
	if (!tier) return; // not a service-tier run — leave every payload alone
	pi.on("before_provider_request", (event: { payload: unknown }) => injectServiceTier(event.payload, tier) as never);
}
