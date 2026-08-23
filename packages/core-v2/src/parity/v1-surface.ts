/**
 * Parity R2 — the v1 harness surface, READ-ONLY (R5).
 *
 * The v1 engine is exercised through its pure spec surface:
 * extensions/task/schemas/spec.ts (`parseSpec` + `splitSpec`) — the
 * same surface the M0 smoke oracle covers (docs/pi-task-v2.md §8:
 * "M0's smoke tests are what the shadow phase's parity checks run").
 * Nothing under extensions/task/** is mutated or written; this module
 * only imports and calls.
 *
 * The executor seam (`V1NodeExecutor`) is injected by the caller:
 *   - dry mode wires the deterministic in-process executor below
 *     (zero LLM, zero subprocess);
 *   - real mode (scripts/parity-m5.sh --real) wires the v1
 *     orchestrator pipeline OUTSIDE core-v2 (the strict type gate
 *     covers packages/core-v2 only, so the real-mode adapter lives in
 *     the wrapper layer).
 *
 * The executor returns the raw v1 outcome which `normalizeV1Node`
 * folds into the normalized manifest shape (types.ts): commit IDS
 * become a deduped count, wall-clock durations are dropped, file lists
 * are sorted + deduped — the deterministic-serialization rule (NFR-4)
 * applied to the v1 side.
 */

// @ts-ignore type-gate covers packages/core-v2 only — this harness reads v1 only at runtime
import { parseSpec } from "../../../../extensions/task/schemas/spec.ts";
// @ts-ignore type-gate covers packages/core-v2 only — this harness reads v1 only at runtime
import { splitSpec } from "../../../../extensions/task/orchestrator.ts";
import type { CanonicalDag, CanonicalDagNode, NormalizedV1Node } from "./types.ts";

/** Raw v1 outcome for one DAG node, as the executor seam produces it. */
export interface V1NodeOutcome {
	/** The sub-spec markdown v1's splitSpec derived for this node. */
	subSpecMarkdown: string;
	/** The original canonical spec markdown (pre-split) — used for parity comparison so v1 boilerplate is not diffed. */
	originalSpecMarkdown?: string | undefined;
	/** Commit ids the node produced (normalized to a count downstream). */
	commitIds: readonly string[];
	/** Files the node's yield declared (deduped + sorted downstream). */
	filesChanged: readonly string[];
	/** Whether v1's verification runner passed the node's gate. */
	verificationPassed: boolean;
	/** v1 escalation vocabulary mapped onto the shared scale. */
	escalated: boolean;
	/** Node cost evidence for the delta columns (phase-cost sum; dry = 0). */
	costUsd: number;
	/** Node turn count for the delta columns (dry = 0). */
	turns: number;
	/** True when the node never ran (a short-circuit on either side makes
	 *  deltas null instead of bogus). */
	skipped: boolean;
}

/**
 * The v1 executor seam. Dry mode: deterministic in-process simulation
 * (below). Real mode: the wrapper wires the v1 orchestrator pipeline.
 */
export type V1NodeExecutor = (
	node: CanonicalDagNode,
	subSpecMarkdown: string,
) => Promise<V1NodeOutcome>;

/**
 * Derive the v1 sub-spec for one DAG node via v1's own splitSpec: the
 * canonical node's requirements are bucketed exactly as a parallel v1
 * run would bucket them. READ-ONLY — calls v1's exported pure function.
 * Pure.
 */
export function v1SubSpecFor(node: CanonicalDagNode): string {
	const spec = parseSpec(node.specMarkdown);
	// v1 splits requirements across workers; the parity harness runs ONE
	// worker per node (the DAG itself supplies the parallelism), so the
	// sub-spec carries all of the node's requirements in a single bucket.
	const [subSpec] = splitSpec(spec, 1);
	if (subSpec === undefined) {
		throw new Error(`v1SubSpecFor: splitSpec produced no bucket for node "${node.id}"`);
	}
	return subSpec;
}

/**
 * Deterministic dry-mode v1 executor (zero LLM, zero subprocess, zero
 * network): derives the requirements through v1's own parser and emits
 * a fully deterministic outcome — one commit + one file per requirement,
 * verification passing. Same inputs → identical outcomes, always.
 */
export function dryV1Executor(
	node: CanonicalDagNode,
	subSpecMarkdown: string,
): Promise<V1NodeOutcome> {
	const spec = parseSpec(subSpecMarkdown);
	return Promise.resolve({
		subSpecMarkdown,
		originalSpecMarkdown: node.specMarkdown,
		commitIds: spec.requirements.map((_: unknown, i: number) => `${node.id}-c${i + 1}`),
		filesChanged: spec.requirements.map((_: unknown, i: number) => `${node.id}-file-${i + 1}.txt`),
		verificationPassed: true,
		escalated: false,
		costUsd: 0,
		turns: 0,
		skipped: false,
	});
}

/**
 * Normalize one raw v1 outcome into the comparable manifest shape.
 * Pure: commit ids → deduped count, files sorted + deduped, verdict
 * mapped onto the shared three-valued scale. The sub-spec's "## Scope"
 * partition note (v1 splitSpec boilerplate) carries no Goal/
 * Requirements/Verification content, so parseSpec simply ignores it.
 */
export function normalizeV1Node(nodeId: string, outcome: V1NodeOutcome): NormalizedV1Node {
	const source = outcome.originalSpecMarkdown ?? outcome.subSpecMarkdown;
	const subSpec = parseSpec(source);
	return {
		nodeId,
		verdict: outcome.skipped
			? "failed"
			: outcome.escalated
				? "escalate"
				: outcome.verificationPassed
					? "ship"
					: "failed",
		requirements: [...subSpec.requirements],
		verificationCommands: [...subSpec.verification],
		verificationPassed: outcome.verificationPassed,
		commitCount: new Set(outcome.commitIds).size,
		filesChanged: [...new Set(outcome.filesChanged)].sort(),
		skipped: outcome.skipped,
		costUsd: outcome.costUsd,
		turns: outcome.turns,
	};
}

/**
 * Drive the canonical DAG through the v1 surface (R2), topologically:
 * for each node — sub-spec derivation via v1's own splitSpec, the
 * injected executor, normalization into the comparable shape. Nodes run
 * one at a time in the DAG's stable topo order (v1 has no DAG
 * scheduler of its own — the harness supplies the ordering).
 */
export async function runV1Surface(options: {
	dag: CanonicalDag;
	order: readonly string[];
	executor: V1NodeExecutor;
}): Promise<readonly NormalizedV1Node[]> {
	const byId = new Map(options.dag.nodes.map((n) => [n.id, n]));
	for (const id of options.order) {
		if (!byId.has(id)) {
			throw new Error(`runV1Surface: order references unknown node "${id}"`);
		}
	}
	const normalized: NormalizedV1Node[] = [];
	for (const id of options.order) {
		const node = byId.get(id)!;
		const subSpec = v1SubSpecFor(node);
		const outcome = await options.executor(node, subSpec);
		if (outcome.originalSpecMarkdown === undefined) outcome = { ...outcome, originalSpecMarkdown: node.specMarkdown };
		normalized.push(normalizeV1Node(id, outcome));
	}
	return normalized;
}
