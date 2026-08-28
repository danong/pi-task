/**
 * Deterministic prompt-bound serialization (contract NFR-3 / NFR-4).
 *
 * Two rules this exists to enforce:
 *  - Byte-stable bytes: a payload's object keys are sorted, so the output
 *    is independent of construction key order. Combined with the fact that
 *    the schema envelopes carry no timestamp/run/session literals, the same
 *    semantic payload always serializes to the same bytes.
 *  - Ledger stripping: validation through the zod schema drops any
 *    ledger-only envelope fields (WithLedgerFields in payloads.ts) before
 *    serialization — the ledger-only fields never reach a prompt, and a
 *    retry that appends a handoff preserves the cache prefix.
 */

import type { z } from "zod";
import { ChildHandoffSchema, buildChildHandoff } from "./payloads.ts";

/** Order an object's keys recursively (leaves). */
function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value !== null && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(obj).sort()) {
			out[key] = sortKeys(obj[key]);
		}
		return out;
	}
	return value;
}

/**
 * Deterministic JSON serialization of a prompt-bound payload: key order
 * cannot vary the byte output. Numbers/floats are JSON-native.
 */
export function stableStringify(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

/**
 * Serialize a payload to its prompt form: validate through `schema`
 * (which strips any ledger-only envelope fields) then serialize stably.
 * Pass a WithLedgerFields record to prove stripping.
 */
export function serializeForPrompt(
	schema: z.ZodType,
	payload: unknown,
): string {
	// Child handoffs have a stronger admission contract than legacy payloads:
	// revalidate, canonicalize every collection, then serialize. Keeping this
	// check here prevents a caller from accidentally bypassing the sole prompt
	// ingress builder by using the generic serializer.
	if (schema === ChildHandoffSchema) return stableStringify(buildChildHandoff(payload));
	return stableStringify(schema.parse(payload));
}
