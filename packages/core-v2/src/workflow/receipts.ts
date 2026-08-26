/**
 * Workflow receipts — per-node usage/COR + aggregate BuildSummary (R1–R3).
 *
 * Pure over TaskReceipts (the SDK-measured source of truth). Every field
 * on the aggregate is a sum of the flat numbers already on the receipts —
 * no nested objects — so retry cost is never double-counted or lost: a
 * retry simply contributes its own receipt to the sum, and handoff-cap
 * semantics (60 kB tail capping) do not affect the usage counters.
 *
 * Determinism (R3): inputs are sorted by taskId before any aggregation
 * or rendering, and file persistence uses stableStringify (sorted keys),
 * so the same receipt set always yields byte-identical summary bytes and
 * retrieved digests. No timestamps, run ids, or clocks enter the shape.
 *
 * Retrieval seam (R3): file-backed persistence — writeBuildSummary /
 * readBuildSummary — so the summary is retrievable without re-running
 * the build. Ledger callers can persist the same bytes in their own
 * store; the module never reaches into fs beyond the two seam helpers.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { TaskReceipt } from "../contracts/payloads.ts";
import { stableStringify } from "../contracts/serialize.ts";

/** Per-node view derived from a single TaskReceipt (R1). */
export interface NodeSummary {
	/** Stable node identifier — the receipt's taskId. */
	nodeId: string;
	verdict: TaskReceipt["verdict"];
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	/** SDK cache-write tokens when present on the receipt; 0 otherwise
	 *  (current TaskReceipt schema is ledger-only for cacheWrite, so
	 *  hermetic fixtures may carry 0 — the aggregate treats missing as 0). */
	cacheWriteTokens: number;
	costUsd: number;
	cor: number;
	filesChanged: number;
	turns: number;
	commitIds: readonly string[];
	bundleHit: boolean | null;
}

/** Aggregate sums over a BuildSummary's nodes (R1). */
export interface AggregateSummary {
	nodeCount: number;
	verdictCounts: Record<TaskReceipt["verdict"], number>;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalCostUsd: number;
	/** Recomputed as Σ(grounding)/Σ(totalInput), never an average of ratios.
	 *  Grounding per node is recovered as cor * totalInput (since receipts
	 *  carry cor but not groundingTokens directly). */
	cor: number;
	totalFilesChanged: number;
	totalTurns: number;
}

/** Typed BuildSummary over TaskReceipts (R1). */
export interface BuildSummary {
	/** Per-node summaries, sorted by nodeId (deterministic). */
	nodes: readonly NodeSummary[];
	aggregate: AggregateSummary;
	/** Single escalation digest when any node escalated; null otherwise.
	 *  The digest is deterministic: escalated nodeIds sorted and joined. */
	escalationDigest: string | null;
}

// ─── Per-node extraction (pure, R1 + R2) ─────────────────────────────

function cacheWriteOf(receipt: TaskReceipt): number {
	const maybe = (receipt as unknown as Record<string, unknown>)
		.cacheWriteTokens;
	return typeof maybe === "number" && Number.isFinite(maybe) ? maybe : 0;
}

export function nodeSummaryFromReceipt(receipt: TaskReceipt): NodeSummary {
	return {
		nodeId: receipt.taskId,
		verdict: receipt.verdict,
		inputTokens: receipt.inputTokens,
		outputTokens: receipt.outputTokens,
		cacheReadTokens: receipt.cacheReadTokens,
		cacheWriteTokens: cacheWriteOf(receipt),
		costUsd: receipt.costUsd,
		cor: receipt.cor,
		filesChanged: receipt.filesChanged,
		turns: receipt.turns,
		commitIds: [...receipt.commitIds],
		bundleHit: receipt.bundleHit,
	};
}

// ─── Aggregation helpers (pure) ───────────────────────────────────────

function totalInputOf(node: NodeSummary): number {
	return node.inputTokens + node.cacheReadTokens + node.cacheWriteTokens;
}

/** Aggregate COR: Σ(cor_i * totalInput_i) / Σ(totalInput_i), zero when idle. */
function aggregateCor(nodes: readonly NodeSummary[]): number {
	let totalInput = 0;
	let totalGrounding = 0;
	for (const n of nodes) {
		const ti = totalInputOf(n);
		totalInput += ti;
		totalGrounding += n.cor * ti;
	}
	return totalInput === 0 ? 0 : totalGrounding / totalInput;
}

function emptyAggregate(): AggregateSummary {
	return {
		nodeCount: 0,
		verdictCounts: { ship: 0, escalate: 0, failed: 0 },
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheReadTokens: 0,
		totalCacheWriteTokens: 0,
		totalCostUsd: 0,
		cor: 0,
		totalFilesChanged: 0,
		totalTurns: 0,
	};
}

export function aggregateFromNodes(
	nodes: readonly NodeSummary[],
): AggregateSummary {
	if (nodes.length === 0) return emptyAggregate();
	const counts: Record<TaskReceipt["verdict"], number> = {
		ship: 0,
		escalate: 0,
		failed: 0,
	};
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCacheReadTokens = 0;
	let totalCacheWriteTokens = 0;
	let totalCostUsd = 0;
	let totalFilesChanged = 0;
	let totalTurns = 0;
	for (const n of nodes) {
		counts[n.verdict] += 1;
		totalInputTokens += n.inputTokens;
		totalOutputTokens += n.outputTokens;
		totalCacheReadTokens += n.cacheReadTokens;
		totalCacheWriteTokens += n.cacheWriteTokens;
		totalCostUsd += n.costUsd;
		totalFilesChanged += n.filesChanged;
		totalTurns += n.turns;
	}
	return {
		nodeCount: nodes.length,
		verdictCounts: counts,
		totalInputTokens,
		totalOutputTokens,
		totalCacheReadTokens,
		totalCacheWriteTokens,
		totalCostUsd,
		cor: aggregateCor(nodes),
		totalFilesChanged,
		totalTurns,
	};
}

// ─── Escalation digest (R1, deterministic) ───────────────────────────

export function buildEscalationDigest(
	nodes: readonly NodeSummary[],
): string | null {
	const escalated = nodes
		.filter((n) => n.verdict === "escalate")
		.map((n) => n.nodeId)
		.sort();
	if (escalated.length === 0) return null;
	return `escalated: ${escalated.join(", ")}`;
}

export function renderEscalationDigest(digest: string | null): string {
	return digest ?? "no escalations";
}

// ─── BuildSummary assembly (pure, deterministic — R1 + R3) ───────────

/**
 * Build a deterministic BuildSummary from TaskReceipts.
 * Pure: sorts by taskId, maps through nodeSummaryFromReceipt, aggregates,
 * and renders the single escalation digest.
 */
export function buildBuildSummary(
	receipts: readonly TaskReceipt[],
): BuildSummary {
	const sorted = [...receipts].sort((a, b) => a.taskId.localeCompare(b.taskId));
	const nodes = sorted.map(nodeSummaryFromReceipt);
	const aggregate = aggregateFromNodes(nodes);
	const escalationDigest = buildEscalationDigest(nodes);
	return { nodes, aggregate, escalationDigest };
}

/** Alias for callers that prefer the aggregate-verb. */
export const aggregateReceipts = buildBuildSummary;

// ─── Deterministic serialization (R3) ─────────────────────────────────

/** Deterministic JSON for a BuildSummary — stableStringify sorts keys
 *  recursively, so identical summaries yield identical bytes. */
export function serializeBuildSummary(summary: BuildSummary): string {
	return stableStringify(summary);
}

// ─── File-backed retrieval seam (R3) ──────────────────────────────────

/**
 * Persist a BuildSummary to a file deterministically (sorted keys, stable
 * bytes). Creates parent directories as needed.
 */
export function writeBuildSummary(
	filePath: string,
	summary: BuildSummary,
): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const bytes = serializeBuildSummary(summary);
	writeFileSync(filePath, bytes + "\n", "utf-8");
}

/**
 * Retrieve a BuildSummary from a file without re-running the build.
 * Parses the deterministic JSON and returns the typed summary.
 */
export function readBuildSummary(filePath: string): BuildSummary {
	const raw = readFileSync(filePath, "utf-8");
	return JSON.parse(raw) as BuildSummary;
}
