/**
 * /build — gate-checked DAG orchestration (M5).
 *
 * Thin orchestration over the already-landed workflow modules:
 *   - workflow/gate.ts supplies the human-gate check (R1): an unknown or
 *     unapproved DAG refuses TYPED here (BuildGateError) with guidance
 *     to re-run `/plan --approve` before anything dispatches.
 *   - workflow/dag.ts supplies the pure topological synthesis (R2);
 *     this module never re-implements ordering.
 *   - workflow/scheduler.ts supplies the ready-set executor: it drives
 *     the injected runNode seam (the caller wires the existing
 *     workspace/verify/merge seams — the jj ladder and verify runner are
 *     NOT reimplemented), respects max_parallel capped by the DAG's
 *     declared fan-out ceiling, and short-circuits dependents of failed
 *     nodes so they never spawn (R3). Every node emits task lifecycle
 *     events through the TaskGateway (routed -> completed/failed/
 *     skipped); handler throws stay isolated inside the gateway seam.
 */

import type { TaskGateway } from "../contracts/task-plugin.ts";
import type { LedgerStore } from "../ledger/store.ts";
import { synthesizeDag, type DagNode } from "./dag.ts";
import { requirePlanApproved } from "./gate.ts";
import { scheduleDag, type ScheduleResult } from "./scheduler.ts";

/** Typed build refusal (R1): the DAG was never planned or was planned
 *  without approval. The message always guides to `plan --approve`. */
export class BuildGateError extends Error {
	constructor(
		public readonly dagId: string,
		message: string,
	) {
		super(message);
		this.name = "BuildGateError";
	}
}

/** Per-node executor seam: the caller wires the real pipeline
 *  (workspace spawn → yield → verify → merge); tests inject a fake. */
export type BuildNodeExecutor = (
	nodeId: string,
) => Promise<{ verdict: "completed" | "failed"; cause?: string | undefined }>;

export interface RunBuildOptions {
	dagId: string;
	/** Validated spec nodes for this DAG (as produced by /plan). */
	nodes: readonly DagNode[];
	/** The ledger whose workflow_approvals row gates execution. */
	store: LedgerStore;
	runNode: BuildNodeExecutor;
	maxParallel?: number | undefined;
	gateway?: TaskGateway | undefined;
}

/**
 * Execute an approved DAG (R1–R3): gate first, then topological,
 * fan-out-limited, dependent-short-circuiting scheduling. The gate is
 * read-only; nothing mutates approval state.
 */
export async function runBuild(options: RunBuildOptions): Promise<ScheduleResult> {
	try {
		requirePlanApproved(options.store, options.dagId);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new BuildGateError(
			options.dagId,
			`build refused for workflow "${options.dagId}": ${detail}`,
		);
	}
	const dag = synthesizeDag(options.nodes);
	return scheduleDag({
		dag,
		runNode: options.runNode,
		maxParallel: options.maxParallel,
		gateway: options.gateway,
	});
}
