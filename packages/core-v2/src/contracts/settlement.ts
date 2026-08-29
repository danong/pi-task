/** Provider-neutral settlement contracts.
 *
 * The source is deliberately shared by receipts, acceptance, and lifecycle
 * adapters. Engine-derived settlement has no model narrative: null values are
 * an explicit unavailable marker, rather than an invented Yield.
 */

import { z } from "zod";
import type { Yield } from "./payloads.ts";

/** The only authorities that may produce a terminal settlement. */
export const SETTLEMENT_SOURCES = ["model_yield", "engine_derived"] as const;
export const MODEL_YIELD_SETTLEMENT_SOURCE = SETTLEMENT_SOURCES[0];
export const ENGINE_DERIVED_SETTLEMENT_SOURCE = SETTLEMENT_SOURCES[1];
export const SettlementSourceSchema = z.enum(SETTLEMENT_SOURCES);
export type SettlementSource = z.infer<typeof SettlementSourceSchema>;

/**
 * Model narrative availability for a terminal settlement. This is separate
 * from TaskReceipt's compact accounting fields so summary/deviations are not
 * copied into receipts or confused with engine evidence.
 */
export const SettlementNarrativeSchema = z.discriminatedUnion("source", [
	z.object({
		source: z.literal(MODEL_YIELD_SETTLEMENT_SOURCE),
		summary: z.string(),
		deviations: z.array(z.string()),
	}).strict(),
	z.object({
		source: z.literal(ENGINE_DERIVED_SETTLEMENT_SOURCE),
		summary: z.null(),
		deviations: z.null(),
	}).strict(),
]);
export type SettlementNarrative = z.infer<typeof SettlementNarrativeSchema>;

/** No model completion payload exists for an engine-derived settlement. */
export type SettlementResult =
	| {
			source: typeof MODEL_YIELD_SETTLEMENT_SOURCE;
			yield: Yield;
			narrative: Extract<SettlementNarrative, { source: typeof MODEL_YIELD_SETTLEMENT_SOURCE }>;
	  }
	| {
			source: typeof ENGINE_DERIVED_SETTLEMENT_SOURCE;
			yield?: never;
			narrative: Extract<SettlementNarrative, { source: typeof ENGINE_DERIVED_SETTLEMENT_SOURCE }>;
	  };
