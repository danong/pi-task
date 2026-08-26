/**
 * Parity R2 — the canonical spec DAG both engines consume.
 *
 * One DAG, one shape: each node carries full spec markdown (Goal /
 * Requirements / Verification / optional Depends On) plus its declared
 * dependency ids. The SAME CanonicalDag instance feeds the v1 surface
 * (parity/v1-surface.ts) and the v2 build (parity/v2-build.ts), so any
 * parity mismatch is engine behavior, not input drift.
 *
 * `validateCanonicalDag` performs the structural checks both engines
 * also enforce on their own (duplicate ids, unknown dependencies,
 * cycles) BEFORE dispatch so a malformed fixture fails typed at the
 * harness boundary instead of surfacing as a bogus parity mismatch.
 * Pure — no fs, no ledger.
 */

import { DagSynthesisError, synthesizeDag } from "../workflow/dag.ts";
import type { CanonicalDag } from "./types.ts";

export class CanonicalDagError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CanonicalDagError";
	}
}

/** Structural validation over the canonical form. Pure. */
export function validateCanonicalDag(dag: CanonicalDag): void {
	if (dag.nodes.length === 0) {
		throw new CanonicalDagError(`canonical DAG "${dag.dagId}" has no nodes`);
	}
	try {
		synthesizeDag(
			dag.nodes.map((n) => ({
				id: n.id,
				spec: {
					goal: "",
					requirements: [],
					verificationCommands: [],
					dependsOn: [...n.dependsOn],
				},
			})),
		);
	} catch (err) {
		if (err instanceof DagSynthesisError)
			throw new CanonicalDagError(err.message);
		throw err;
	}
}
