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
/** Comma-separated model ids EXEMPT from the tier (the cheap workhorse
 *  stays standard-priced even inside a flex run). */
export const SERVICE_TIER_EXCLUDES_ENV_VAR = "PI_TASK_SERVICE_TIER_EXCLUDES";
/** Comma-separated OpenRouter endpoint slugs for provider.only (the
 *  flex-pin — e.g. "google-vertex/flex"; the tier suffix opts into the
 *  tier). Same model scoping as the tier itself. */
export const SERVICE_TIER_PROVIDER_ONLY_ENV_VAR = "PI_TASK_PROVIDER_ONLY";

const VALID_SERVICE_TIERS = new Set(["flex", "priority"]);

/**
 * Pure injection rule (hermetic-tested): a valid tier + object payload →
 * a copy carrying `service_tier`; anything else → the payload unchanged.
 * Model-scoped: a payload whose `model` is in `excludes` is left alone —
 * a worker session runs BOTH the flex-priced strong model (prewalk) and
 * the standard-priced workhorse (post-swap loop), and only the former
 * gets the tier. Never mutates its input.
 */
export function injectServiceTier(
	payload: unknown,
	tier: string | undefined,
	excludes?: readonly string[],
): unknown {
	if (!tier || !VALID_SERVICE_TIERS.has(tier)) return payload;
	if (typeof payload !== "object" || payload === null) return payload;
	const record = payload as Record<string, unknown>;
	if (excludes && excludes.length > 0 && typeof record.model === "string" && excludes.includes(record.model)) {
		return payload;
	}
	return { ...record, service_tier: tier };
}

/**
 * Pure provider-pin rule (hermetic-tested): non-empty `only` + object
 * payload whose model is not excluded → a copy carrying
 * provider.only + allow_fallbacks:false; anything else → unchanged. The
 * pin travels WITH the tier: a flex request pinned to google-vertex/flex
 * must never shed to another endpoint (billing follows the served tier).
 */
export function injectProviderOnly(
	payload: unknown,
	only: readonly string[] | undefined,
	excludes?: readonly string[],
): unknown {
	if (!only || only.length === 0) return payload;
	if (typeof payload !== "object" || payload === null) return payload;
	const record = payload as Record<string, unknown>;
	if (excludes && excludes.length > 0 && typeof record.model === "string" && excludes.includes(record.model)) {
		return payload;
	}
	return { ...record, provider: { only: [...only], allow_fallbacks: false } };
}

export default function (pi: ExtensionAPI) {
	const tier = process.env[SERVICE_TIER_ENV_VAR];
	const providerOnly = (process.env[SERVICE_TIER_PROVIDER_ONLY_ENV_VAR] ?? "")
		.split(",")
		.map((m) => m.trim())
		.filter((m) => m.length > 0);
	if (!tier && providerOnly.length === 0) return; // not a pinned run
	const excludes = (process.env[SERVICE_TIER_EXCLUDES_ENV_VAR] ?? "")
		.split(",")
		.map((m) => m.trim())
		.filter((m) => m.length > 0);
	pi.on("before_provider_request", (event: { payload: unknown }) => {
		const withTier = tier ? injectServiceTier(event.payload, tier, excludes) : event.payload;
		return injectProviderOnly(withTier, providerOnly, excludes) as never;
	});
}
