/**
 * Hermetic tests for workflow receipts — per-node usage/COR + aggregate
 * BuildSummary (packages/core-v2/src/workflow/receipts.ts). Zero LLM,
 * zero network, no spawns; the only I/O is a throwaway temp dir for the
 * file-backed retrieval seam.
 *
 *   - R1 typed BuildSummary: per-node verdicts + usage/COR (input,
 *     output, cacheRead, cacheWrite, costUsd, cor), aggregate sums,
 *     single escalation digest when any node escalated;
 *   - R2 retry wiring: receipts stay flat (no nested objects), retries
 *     contribute their own receipt so cost is summed exactly once, and
 *     handoff-cap semantics never touch usage counters;
 *   - R3 retrieval + determinism: file-backed round-trip without a
 *     re-run, byte-identical serialization regardless of input order,
 *     and stable rendered digest.
 *
 * Standalone: npx tsx packages/core-v2/test/test-workflow-receipts.ts
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { TaskReceipt } from "../src/contracts/payloads.ts";
import {
	aggregateFromNodes,
	buildBuildSummary,
	buildEscalationDigest,
	nodeSummaryFromReceipt,
	readBuildSummary,
	renderEscalationDigest,
	serializeBuildSummary,
	writeBuildSummary,
	type NodeSummary,
} from "../src/workflow/receipts.ts";
import { TaskReceiptSchema } from "../src/contracts/payloads.ts";

/** A receipt fixture: flat fields only (schema-shaped). */
function receipt(over: Partial<TaskReceipt> & { taskId: string }): TaskReceipt {
	return TaskReceiptSchema.parse({
		verdict: "ship",
		filesChanged: 1,
		commitIds: ["c1"],
		turns: 2,
		costUsd: 0.01,
		inputTokens: 100,
		outputTokens: 20,
		cacheReadTokens: 40,
		cor: 0.5,
		bundleHit: null,
		...over,
	});
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const fixtures: TaskReceipt[] = [
		// n-b omits cacheWriteTokens entirely — receipts are flat and the
		// schema has no such field; nodeSummaryFromReceipt treats it as 0.
		receipt({ taskId: "n-b", verdict: "ship", inputTokens: 100, outputTokens: 30, cacheReadTokens: 50, costUsd: 0.02, cor: 0.4, filesChanged: 3, turns: 5 }),
		receipt({ taskId: "n-a", verdict: "escalate", inputTokens: 200, outputTokens: 10, cacheReadTokens: 100, costUsd: 0.05, cor: 0.6, filesChanged: 1, turns: 9 }),
		receipt({ taskId: "n-c", verdict: "failed", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, cor: 0, filesChanged: 0, turns: 0 }),
	];

	// ─── R1: typed per-node summaries ──────────────────────────────
	{
		const n = nodeSummaryFromReceipt(fixtures[0]!);
		check(n.nodeId === "n-b" && n.verdict === "ship", `nodeId/verdict carried (${n.nodeId}/${n.verdict})`);
		check(n.inputTokens === 100 && n.outputTokens === 30 && n.cacheReadTokens === 50,
			`per-node token counters carried (${n.inputTokens}/${n.outputTokens}/${n.cacheReadTokens})`);
		check(n.cacheWriteTokens === 0, `absent cacheWriteTokens treated as 0 (got ${n.cacheWriteTokens})`);
		check(Math.abs(n.costUsd - 0.02) < 1e-12 && Math.abs(n.cor - 0.4) < 1e-12, "cost/cor carried");
		check(n.filesChanged === 3 && n.turns === 5, "filesChanged/turns carried");

		// commitIds copied defensively (mutating the copy leaves receipt intact).
		const ids = [...n.commitIds];
		ids.push("mutant");
		check(n.commitIds.length === 1, "commitIds snapshot is defensive");
	}

	// ─── R1: aggregate sums over nodes ─────────────────────────────
	{
		const summary = buildBuildSummary(fixtures);
		check(summary.aggregate.nodeCount === 3, `nodeCount = 3 (got ${summary.aggregate.nodeCount})`);
		check(summary.aggregate.verdictCounts.ship === 1 && summary.aggregate.verdictCounts.escalate === 1
			&& summary.aggregate.verdictCounts.failed === 1,
			`verdict counts partitioned (${JSON.stringify(summary.aggregate.verdictCounts)})`);
		check(summary.aggregate.totalInputTokens === 300, `Σinput = 300 (got ${summary.aggregate.totalInputTokens})`);
		check(summary.aggregate.totalOutputTokens === 40, `Σoutput = 40 (got ${summary.aggregate.totalOutputTokens})`);
		check(summary.aggregate.totalCacheReadTokens === 150, `ΣcacheRead = 150 (got ${summary.aggregate.totalCacheReadTokens})`);
		check(summary.aggregate.totalCacheWriteTokens === 0, `ΣcacheWrite = 0 (got ${summary.aggregate.totalCacheWriteTokens})`);
		check(Math.abs(summary.aggregate.totalCostUsd - 0.07) < 1e-12,
			`Σcost = 0.07 (got ${summary.aggregate.totalCostUsd})`);
		check(summary.aggregate.totalFilesChanged === 4, `ΣfilesChanged = 4 (got ${summary.aggregate.totalFilesChanged})`);
		check(summary.aggregate.totalTurns === 14, `Σturns = 14 (got ${summary.aggregate.totalTurns})`);

		// Aggregate COR is grounding-weighted over total input, not an average
		// of ratios: Σ(cor·ti)/Σ(ti) with ti = in+read (+write when present).
		// n-b: ti=150, g=60; n-a: ti=300, g=180; n-c: ti=0 → (240)/(450).
		const expected = 240 / 450;
		check(Math.abs(summary.aggregate.cor - expected) < 1e-12,
			`weighted aggregate cor ≈ ${expected} (got ${summary.aggregate.cor})`);

		// Nodes sorted by nodeId regardless of input order (deterministic).
		check(JSON.stringify(summary.nodes.map((n) => n.nodeId)) === JSON.stringify(["n-a", "n-b", "n-c"]),
			`nodes sorted by id (${JSON.stringify(summary.nodes.map((n) => n.nodeId))})`);
	}

	// ─── R1: single escalation digest only when something escalated ──
	{
		const none = buildEscalationDigest([
			nodeSummaryFromReceipt(receipt({ taskId: "a", verdict: "ship" })),
			nodeSummaryFromReceipt(receipt({ taskId: "b", verdict: "failed" })),
		]);
		check(none === null, `no escalations → null digest (got ${none})`);
		check(renderEscalationDigest(null) === "no escalations", "null digest renders honestly");

		const some = buildEscalationDigest([
			nodeSummaryFromReceipt(receipt({ taskId: "z-9", verdict: "escalate" })),
			nodeSummaryFromReceipt(receipt({ taskId: "a-1", verdict: "ship" })),
			nodeSummaryFromReceipt(receipt({ taskId: "m-5", verdict: "escalate" })),
		]);
		check(some !== null && some.includes("z-9") && some.includes("m-5") && !some.includes("a-1"),
			`digest names escalated node ids only (got ${some})`);

		const summary = buildBuildSummary(fixtures);
		check(summary.escalationDigest !== null && summary.escalationDigest.includes("n-a"),
			`build summary carries the single digest (got ${summary.escalationDigest})`);
	}

	// ─── R2: retry wiring visible, flat fields, no double-counting ──
	{
		// A retried attempt contributes its OWN receipt; total is the sum of
		// both attempts' flat numbers — neither lost nor double-counted.
		const firstAttempt = receipt({ taskId: "r-attempt-1", verdict: "failed", inputTokens: 500, costUsd: 0.1 });
		const retry = receipt({ taskId: "r-attempt-2", verdict: "ship", inputTokens: 300, costUsd: 0.06 });
		const s = buildBuildSummary([firstAttempt, retry]);
		check(s.aggregate.totalInputTokens === 800, `retry cost included once (Σinput 800, got ${s.aggregate.totalInputTokens})`);
		check(Math.abs(s.aggregate.totalCostUsd - 0.16) < 1e-12, "retry cost summed, not duplicated");

		// Receipts are flat: no nested objects anywhere on a receipt.
		for (const r of [firstAttempt, retry]) {
			check(Object.values(r).every((v) => typeof v !== "object" || v === null || Array.isArray(v)),
				`receipt stays flat for ${r.taskId}`);
		}
		// Handoff-cap semantics live on HandoffBundle stderr tails; they never
		// touch usage counters — a capped-tail retry still bills full tokens.
		check(nodeSummaryFromReceipt(retry).inputTokens === 300, "cap semantics do not alter token counters");

		// Aggregate-from-nodes agrees with buildBuildSummary on same inputs.
		const viaNodes = aggregateFromNodes(buildBuildSummary([firstAttempt, retry]).nodes);
		check(JSON.stringify(viaNodes) === JSON.stringify(s.aggregate), "aggregateFromNodes matches end-to-end path");
	}

	// ─── Empty input: zeroed aggregate, null digest ──────────────────
	{
		const empty = buildBuildSummary([]);
		check(empty.nodes.length === 0 && empty.aggregate.nodeCount === 0, "empty receipts → zeroed summary");
		check(empty.aggregate.totalCostUsd === 0 && empty.aggregate.cor === 0, "empty aggregate zeroes cost/cor");
		check(empty.escalationDigest === null, "empty receipts → null digest");
	}

	// ─── R3: determinism — order-independent, byte-stable bytes ─────
	{
		const forward = buildBuildSummary(fixtures);
		const shuffled = buildBuildSummary([fixtures[2]!, fixtures[0]!, fixtures[1]!]);
		check(serializeBuildSummary(forward) === serializeBuildSummary(shuffled),
			"same receipts in any order serialize identically");

		// Repeated builds are byte-stable outright (no timestamps anywhere).
		const again = buildBuildSummary(fixtures);
		check(serializeBuildSummary(again) === serializeBuildSummary(forward),
			"repeated aggregation is byte-identical");
		check(!serializeBuildSummary(forward).match(/\d{4}-\d\d-\d\d|T\d\d:/),
			"serialization carries no timestamps by construction");

		// Different receipts DO change the bytes (not a constant function).
		const changed = buildBuildSummary([...fixtures, receipt({ taskId: "n-d", verdict: "ship" })]);
		check(serializeBuildSummary(changed) !== serializeBuildSummary(forward),
			"a new receipt changes the serialized summary");
	}

	// ─── R3: file-backed retrieval seam without re-running the build ──
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-task-v2-workflow-receipts-"));
		try {
			const path = join(dir, "nested", "summary.json");
			const summary = buildBuildSummary(fixtures);
			writeBuildSummary(path, summary);

			const raw = readFileSync(path, "utf-8");
			check(raw === serializeBuildSummary(summary) + "\n", "file holds exactly the deterministic bytes");

			// Retrieval parses back to an equal summary WITHOUT re-running:
			// mutate nothing, just read. Compare via the deterministic serializer
			// (raw JSON.stringify would differ on object key insertion order).
			const retrieved = readBuildSummary(path);
			check(serializeBuildSummary(retrieved) === serializeBuildSummary(summary), "retrieved summary equals built summary");
			check(retrieved.escalationDigest === summary.escalationDigest, "digest survives the round-trip");
			check(retrieved.aggregate.verdictCounts.escalate === 1, "verdict counts survive the round-trip");

			// Digest rendering off a RETRIEVED summary is deterministic too.
			check(renderEscalationDigest(retrieved.escalationDigest)
				=== renderEscalationDigest(buildBuildSummary(fixtures).escalationDigest),
			"rendered digest stable across retrieve/build paths");

			// Write twice → byte-identical file (idempotent persistence).
			writeBuildSummary(path, buildBuildSummary(fixtures));
			check(readFileSync(path, "utf-8") === raw, "rewriting the same receipts yields identical file bytes");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// ─── cacheWriteTokens participates in totals when present ───────
	{
		const withCacheWrite: NodeSummary[] = [
			{ nodeId: "w1", verdict: "ship", inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 70, costUsd: 0.01, cor: 0.5, filesChanged: 1, turns: 1, commitIds: [], bundleHit: null },
		];
		const agg = aggregateFromNodes(withCacheWrite);
		check(agg.totalCacheWriteTokens === 70, `ΣcacheWrite counts present values (got ${agg.totalCacheWriteTokens})`);
		// Grounding is recovered as cor × totalInput (the same denominator
		// computeCor uses: input+read+write = 100, grounding 50); the weighted
		// aggregate is 50/100 = 0.5 — a ratio-weighted recompute, not an
		// arithmetic mean of node ratios.
		check(Math.abs(agg.cor - 0.5) < 1e-12, `cor recomputes grounding-weighted, not averaged (got ${agg.cor})`);
	}

	if (errors.length > 0) {
		throw new Error(`test-workflow-receipts failed:\n  ✗ ${errors.join("\n  ✗ ")}`);
	}
	console.log("✓ workflow-receipts: per-node usage/COR, aggregate sums, escalation digest, deterministic retrieval");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
