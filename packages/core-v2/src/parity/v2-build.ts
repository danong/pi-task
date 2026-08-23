/**
 * Parity R2 — the v2 /build executor surface.
 *
 * Drives ONE canonical DAG through the REAL v2 pipeline — human gate,
 * DAG synthesis, ready-set scheduling via workflow/build.ts (which
 * delegates ordering to workflow/dag.ts and execution to
 * workflow/scheduler.ts) — and normalizes the outcomes into RECEIPTS
 * (the SDK-measured source of truth):
 *
 *   - dry mode (default): the built-in deterministic executor returns
 *     completed verdicts with a schema-valid zero-cost receipt per node
 *     — zero LLM, zero subprocess, zero network;
 *   - real mode: the caller injects `executor`, wiring the daemon's
 *     runTask seam (workspace spawn → yield → verify → merge) per node;
 *     its TaskReceipt flows through unchanged.
 *
 * Normalization reuses workflow/receipts.ts verbatim
 * (`nodeSummaryFromReceipt`) so the NFR-3/COR evidence in the parity
 * report is computed by exactly the code that produces production build
 * summaries — no parallel implementation to drift.
 */

import { TaskReceiptSchema, type TaskReceipt } from "../contracts/payloads.ts";
import { runBuild } from "../workflow/build.ts";
import type { LedgerStore } from "../ledger/store.ts";
import type { DagNode } from "../workflow/dag.ts";
import { validateSpec } from "../workflow/plan.ts";
import { nodeSummaryFromReceipt } from "../workflow/receipts.ts";
import type { CanonicalDag, CanonicalDagNode, NormalizedV2Node } from "./types.ts";

/**
 * The v2 node executor seam: one canonical node → verdict + receipt.
 * Omitted (undefined) = dry mode (the built-in deterministic executor).
 */
export type V2NodeExecutor = (
	node: CanonicalDagNode,
) => Promise<{
	verdict: "completed" | "failed";
	cause?: string | undefined;
	receipt?: TaskReceipt | undefined;
}>;

/**
 * Deterministic zero-cost receipt for dry runs (schema-validated): one
 * synthetic commit id per requirement, matching the dry v1 executor's
 * convention so dry-side normalized shapes are comparable by design.
 */
export function dryReceiptFor(nodeId: string, requirementCount: number): TaskReceipt {
	return TaskReceiptSchema.parse({
		taskId: nodeId,
		verdict: "ship",
		filesChanged: requirementCount,
		commitIds: Array.from({ length: requirementCount }, (_, i) => `${nodeId}-c${i + 1}`),
		turns: 0,
		costUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cor: 0,
		bundleHit: null,
	});
}

/** Map a scheduler verdict onto the shared three-valued scale. */
function schedulerVerdictToReceiptVerdict(
	verdict: "completed" | "failed" | "skipped",
): TaskReceipt["verdict"] {
	if (verdict === "completed") return "ship";
	return "failed";
}

/**
 * Normalize one scheduled node into the comparable receipt shape (R2).
 * Reuses nodeSummaryFromReceipt so COR/token evidence comes from the
 * SAME code as production summaries. Pure.
 *
 * Note on filesChanged: TaskReceipt carries a COUNT, not names, so the
 * normalized v2 side fills deterministic count-placeholders
 * (`<nodeId>-f<N>`); cross-engine comparison is by count.
 */
export function normalizeV2Node(options: {
	node: CanonicalDagNode;
	result: { id: string; verdict: "completed" | "failed" | "skipped"; cause?: string | undefined };
	receipt?: TaskReceipt | undefined;
}): NormalizedV2Node {
	const spec = validateSpec(options.node.specMarkdown);
	if (options.result.verdict === "skipped" || options.receipt === undefined) {
		return {
			nodeId: options.node.id,
			verdict: schedulerVerdictToReceiptVerdict(options.result.verdict),
			requirements: [...spec.requirements],
			verificationCommands: [...spec.verificationCommands],
			verificationPassed: false,
			commitCount: 0,
			filesChanged: [],
			skipped: true,
			costUsd: 0,
			turns: 0,
		};
	}
	const receipt = options.receipt;
	return {
		nodeId: options.node.id,
		verdict: receipt.verdict,
		requirements: [...spec.requirements],
		verificationCommands: [...spec.verificationCommands],
		verificationPassed: receipt.verdict === "ship",
		commitCount: new Set(receipt.commitIds).size,
		filesChanged: Array.from({ length: receipt.filesChanged }, (_, i) => `${options.node.id}-f${i + 1}`),
		skipped: false,
		costUsd: receipt.costUsd,
		turns: receipt.turns,
		receipt,
		summary: nodeSummaryFromReceipt(receipt),
	};
}

/**
 * Drive the canonical DAG through the v2 /build pipeline (R2):
 *
 *   1. record this harness's own approval row on the SUPPLIED ledger
 *      fixture (the R1 gate passes without touching shared state),
 *   2. translate canonical nodes into /plan-validated DagNodes,
 *   3. runBuild once — the real gate + synthesis + scheduler path,
 *      threading each node's receipt out through the executor closure,
 *   4. normalize every scheduled result in sorted-id order.
 */
export async function runV2Build(options: {
	dag: CanonicalDag;
	store: LedgerStore;
	executor?: V2NodeExecutor | undefined;
	maxParallel?: number | undefined;
}): Promise<readonly NormalizedV2Node[]> {
	options.store.setWorkflowApproval(options.dag.dagId, true);

	const dagNodes: DagNode[] = options.dag.nodes.map((n) => {
		const spec = validateSpec(n.specMarkdown);
		return { id: n.id, spec: { ...spec, dependsOn: [...n.dependsOn] } };
	});

	const receipts = new Map<string, TaskReceipt>();
	const schedule = await runBuild({
		dagId: options.dag.dagId,
		nodes: dagNodes,
		store: options.store,
		maxParallel: options.maxParallel,
		runNode: async (nodeId) => {
			const node = options.dag.nodes.find((n) => n.id === nodeId);
			if (node === undefined) throw new Error(`runV2Build: unknown node "${nodeId}"`);
			if (options.executor === undefined) {
				const spec = validateSpec(node.specMarkdown);
				receipts.set(node.id, dryReceiptFor(node.id, spec.requirements.length));
				return { verdict: "completed" as const };
			}
			const outcome = await options.executor(node);
			if (outcome.receipt !== undefined) receipts.set(node.id, outcome.receipt);
			return { verdict: outcome.verdict, cause: outcome.cause };
		},
	});

	const normalized: NormalizedV2Node[] = [];
	for (const id of [...schedule.results.keys()].sort()) {
		const node = options.dag.nodes.find((n) => n.id === id);
		const result = schedule.results.get(id);
		if (node === undefined || result === undefined) {
			throw new Error(`runV2Build: scheduler produced no result for node "${id}"`);
		}
		normalized.push(normalizeV2Node({ node, result, receipt: receipts.get(id) }));
	}
	return normalized;
}
