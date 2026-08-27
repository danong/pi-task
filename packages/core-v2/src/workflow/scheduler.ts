/**
 * Workflow scheduler — DAG orchestration (M5 /build).
 *
 * Thin orchestration over the already-landed DAG (workflow/dag.ts):
 *   - derives the ready-set from SynthesizedDag.order (Kahn's stable
 *     order, never reimplemented here)
 *   - executes the ready-set through an injected runNode seam (the
 *     caller wires the real workspace/verify/merge ladder; tests inject
 *     a fake) — never reimplements jj or verify
 *   - respects maxParallel and never exceeds the DAG's declared fan-out
 *     ceiling (DEFAULT_MAX_FAN_OUT)
 *   - short-circuits dependents of failed nodes as `skipped` (typed
 *     failed-dependent) without spawning them
 *   - emits task lifecycle events via TaskGateway for every node
 *     (routed -> completed/failed/skipped); gateway isolation already
 *     handles handler throws
 */

import type { TaskGateway } from "../contracts/task-plugin.ts";
import { DEFAULT_MAX_FAN_OUT, type SynthesizedDag } from "./dag.ts";

export type NodeVerdict = "completed" | "failed" | "skipped";

export interface NodeResult {
	id: string;
	verdict: NodeVerdict;
	/** Present for failed + skipped (failed-dependent). */
	cause?: string | undefined;
}

export interface ScheduleOptions {
	dag: SynthesizedDag;
	/** Injected per-node executor — the caller wires real seams; tests inject a fake. */
	runNode: (
		nodeId: string,
	) => Promise<{ verdict: "completed" | "failed"; cause?: string | undefined }>;
	/** Fan-out limit for this run. Capped by DEFAULT_MAX_FAN_OUT. */
	maxParallel?: number | undefined;
	/** Gateway for lifecycle events. One routed + one terminal per node. */
	gateway?: TaskGateway | undefined;
}

export interface ScheduleResult {
	results: ReadonlyMap<string, NodeResult>;
	/** Peak concurrency observed (chunk size). */
	maxObservedConcurrency: number;
}

function effectiveMaxParallel(requested: number | undefined): number {
	const capped = requested ?? DEFAULT_MAX_FAN_OUT;
	if (!Number.isFinite(capped) || capped <= 0) return DEFAULT_MAX_FAN_OUT;
	return Math.min(Math.floor(capped), DEFAULT_MAX_FAN_OUT);
}

export async function scheduleDag(
	options: ScheduleOptions,
): Promise<ScheduleResult> {
	const maxParallel = effectiveMaxParallel(options.maxParallel);
	const dag = options.dag;
	const orderIndex = new Map<string, number>();
	dag.order.forEach((id, i) => orderIndex.set(id, i));

	const dependenciesOf = new Map<string, readonly string[]>();
	for (const id of dag.order) {
		const node = dag.nodes.get(id);
		dependenciesOf.set(id, node ? [...node.spec.dependsOn] : []);
	}

	const pending = new Set<string>(dag.order);
	const results = new Map<string, NodeResult>();
	const completed = new Set<string>();
	const failed = new Set<string>();
	const skipped = new Set<string>();
	let maxObservedConcurrency = 0;

	const emitRouted = (taskId: string): void => {
		if (options.gateway === undefined) return;
		try {
			options.gateway.emit({
				type: "task.routed",
				taskId,
				detail: { planMode: "cold" },
			});
		} catch {
			// gateway isolation is elsewhere; never crash scheduling
		}
	};
	const emitTerminal = (
		id: string,
		verdict: NodeVerdict,
		cause: string | undefined,
	): void => {
		if (options.gateway === undefined) return;
		try {
			if (verdict === "completed") {
				options.gateway.emit({
					type: "task.completed",
					taskId: id,
					detail: { verdict: "ship" },
				});
			} else if (verdict === "failed") {
				options.gateway.emit({
					type: "task.failed",
					taskId: id,
					detail: {
						cause: cause ?? "failed",
						stage: "workflow",
						code: "worker_failed",
					},
				});
			} else {
				// skipped is a typed failed-dependent — surface as task.failed with a skipped cause so every node has a terminal event
				options.gateway.emit({
					type: "task.failed",
					taskId: id,
					detail: {
						cause: cause ?? "skipped: failed dependency",
						stage: "workflow",
						code: "dependency_failed",
					},
				});
			}
		} catch {
			// isolated
		}
	};

	while (pending.size > 0) {
		// 1. Short-circuit any pending node whose dependency already failed or was skipped.
		let skippedThisPass = false;
		for (const id of [...pending]) {
			const deps = dependenciesOf.get(id) ?? [];
			const blocker = deps.find((d) => failed.has(d) || skipped.has(d));
			if (blocker !== undefined) {
				pending.delete(id);
				const cause = `skipped: dependency "${blocker}" failed`;
				emitRouted(id);
				emitTerminal(id, "skipped", cause);
				results.set(id, { id, verdict: "skipped", cause });
				skipped.add(id);
				skippedThisPass = true;
			}
		}
		if (skippedThisPass) continue;

		// 2. Ready-set: every dependency completed (deterministic by dag.order).
		const ready = [...pending]
			.filter((id) => {
				const deps = dependenciesOf.get(id) ?? [];
				return deps.every((d) => completed.has(d));
			})
			.sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));

		if (ready.length === 0) {
			// No ready and no skipped progress but pending remains — cycle or bug (dag already validated).
			// Mark remaining as skipped to avoid hang.
			for (const id of [...pending]) {
				pending.delete(id);
				const cause = "skipped: unresolved dependencies";
				emitRouted(id);
				emitTerminal(id, "skipped", cause);
				results.set(id, { id, verdict: "skipped", cause });
				skipped.add(id);
			}
			break;
		}

		const chunk = ready.slice(0, maxParallel);
		maxObservedConcurrency = Math.max(maxObservedConcurrency, chunk.length);

		for (const id of chunk) emitRouted(id);

		const settled = await Promise.all(
			chunk.map(async (id) => {
				try {
					const outcome = await options.runNode(id);
					return {
						id,
						verdict: outcome.verdict as NodeVerdict,
						cause: outcome.cause,
					};
				} catch (err) {
					const cause = err instanceof Error ? err.message : String(err);
					return { id, verdict: "failed" as NodeVerdict, cause };
				}
			}),
		);

		for (const r of settled) {
			pending.delete(r.id);
			if (r.verdict === "completed") {
				completed.add(r.id);
				results.set(r.id, { id: r.id, verdict: "completed" });
				emitTerminal(r.id, "completed", undefined);
			} else {
				failed.add(r.id);
				results.set(r.id, {
					id: r.id,
					verdict: "failed",
					cause: r.cause ?? "failed",
				});
				emitTerminal(r.id, "failed", r.cause ?? "failed");
			}
		}
	}

	return { results, maxObservedConcurrency };
}
