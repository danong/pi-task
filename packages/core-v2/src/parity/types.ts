/**
 * Parity harness types (M5 shadow phase) — the typed parity report (R3).
 *
 * The harness (parity/harness.ts) feeds ONE canonical spec DAG to both
 * engines and diffs the NORMALIZED outputs:
 *   - v1 side: a normalized manifest per node, derived from the v1
 *     surface (extensions/task/test.ts) via parity/v1-surface.ts —
 *     READ-ONLY, never imported into any v1 file (R5).
 *   - v2 side: a normalized receipt per node, derived from the v2
 *     /build pipeline (workflow/build.ts + workflow/scheduler.ts) via
 *     parity/v2-build.ts.
 *
 * Normalization strips every per-attempt field (run ids, wall-clock
 * timestamps, session ids, durations) — the deterministic-serialization
 * rule (NFR-4) — so the diff compares only what parity means: per-node
 * verdicts, requirement coverage, verification outcomes, commit counts,
 * and cost/turns DELTAS (never raw absolute costs, which legitimately
 * differ between engines).
 */

import type { TaskReceipt } from "../contracts/payloads.ts";
import type { NodeSummary } from "../workflow/receipts.ts";

/** How the canonical DAG was executed on each side (R2). */
export type ParityExecutionMode = "dry" | "real";

/** One canonical DAG node: id, spec markdown, declared dependencies. */
export interface CanonicalDagNode {
	id: string;
	/** Full spec markdown (Goal / Requirements / Verification / Depends On). */
	specMarkdown: string;
	dependsOn: readonly string[];
}

/** The canonical input both engines consume (R2). */
export interface CanonicalDag {
	dagId: string;
	nodes: readonly CanonicalDagNode[];
}

/** Normalized v1-side per-node outcome (parity/v1-surface.ts). */
export interface NormalizedV1Node {
	nodeId: string;
	/** v1 verdict vocabulary mapped onto the shared three-valued scale. */
	verdict: "ship" | "escalate" | "failed";
	/** Requirements the node's sub-spec declared (coverage evidence). */
	requirements: readonly string[];
	/** Verification commands the node's sub-spec declared. */
	verificationCommands: readonly string[];
	/** Whether v1's verification runner passed the node's gate. */
	verificationPassed: boolean;
	/** Per-attempt noise stripped: only the COUNT is comparable (NFR-4). */
	commitCount: number;
	/** Files the node's yield declared (sorted, deduped). */
	filesChanged: readonly string[];
	/** True when the node never ran (short-circuit); deltas are then null. */
	skipped: boolean;
	/** v1-side node cost evidence (0 when skipped): phase-cost sum in real
	 *  mode, 0 in dry mode. Deltas are compared, never absolute costs. */
	costUsd: number;
	/** v1-side node turn count (0 when skipped). */
	turns: number;
}

/** Normalized v2-side per-node outcome (parity/v2-build.ts). */
export interface NormalizedV2Node {
	nodeId: string;
	verdict: TaskReceipt["verdict"];
	requirements: readonly string[];
	verificationCommands: readonly string[];
	verificationPassed: boolean;
	commitCount: number;
	filesChanged: readonly string[];
	/** True when the scheduler short-circuited the node (failed dependency
	 *  or gate refusal) — it never spawned. Parity treats a skipped node on
	 *  BOTH sides as matching without cost comparison. */
	skipped: boolean;
	/** v2-side node cost evidence (0 when skipped): receipt.costUsd in real
	 *  mode, 0 in dry mode. */
	costUsd: number;
	/** v2-side node turn count (0 when skipped). */
	turns: number;
	/** NFR-3 evidence preserved from the receipt (undefined when skipped). */
	receipt?: TaskReceipt | undefined;
	/** Derived per-node summary when a receipt exists (undefined otherwise). */
	summary?: NodeSummary | undefined;
}

/** Per-node parity diff (R3). */
export interface NodeParity {
	nodeId: string;
	passed: boolean;
	/** Field-level mismatches, empty when passed. Deterministic order. */
	mismatches: readonly string[];
	/** Cost delta v2 − v1 (USD). Null when either side skipped the node. */
	costDeltaUsd: number | null;
	/** Turns delta v2 − v1. Null when either side skipped the node. */
	turnsDelta: number | null;
}

/** Aggregate parity evidence (R3): NFR-3/COR preserved from receipts.
 *  Every field is a plain sum over the normalized nodes; COR is the
 *  weighted ratio Σ(grounding)/Σ(totalInput) exactly as receipts.ts
 *  computes it. Delta fields are null when any node was skipped on
 *  either side (cross-engine sums are then not meaningful). */
export interface AggregateParity {
	v1TotalCostUsd: number | null;
	v2TotalCostUsd: number | null;
	costDeltaUsd: number | null;
	v1TotalTurns: number | null;
	v2TotalTurns: number | null;
	turnsDelta: number | null;
	v2AggregateCor: number;
	v2TotalInputTokens: number;
	v2TotalOutputTokens: number;
	v2VerdictCounts: Record<TaskReceipt["verdict"], number>;
}

/** The typed parity report (R3). Deterministic for identical inputs. */
export interface ParityReport {
	dagId: string;
	mode: ParityExecutionMode;
	/** True iff every node passed parity. */
	parity: boolean;
	/** Per-node results, sorted by nodeId (deterministic). */
	nodes: readonly NodeParity[];
	aggregate: AggregateParity;
	/** Deterministic diff text; null when parity held (no diff file). */
	diff: string | null;
}
