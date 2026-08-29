/**
 * Continuation-store surface (artifact-policy path).
 *
 * The typed local store implementation lives in
 * `context/continuation-store.ts` per the M5.5 layering — record bodies stay
 * in local user state, outside the checkout and outside canonical artifacts
 * (ADR docs/adr/m5.5-linear-recovery.md). This module re-exports that typed
 * surface so the declared contracts path is a stable entry point for the
 * same interface (schemas, types, and helpers are in
 * `contracts/continuation-record.ts`).
 */
export * from "../context/continuation-store.ts";
