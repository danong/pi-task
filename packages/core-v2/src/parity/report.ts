/**
 * Parity R3 — typed diffing, report assembly, exit code, diff file.
 *
 * All comparisons are pure functions of the NORMALIZED sides
 * (types.ts), so identical inputs always produce identical report
 * bytes (determinism): node ids are processed sorted, mismatch strings
 * are phrased identically run over run, aggregate numbers are plain
 * sums, and serialization uses stableStringify (sorted keys). No
 * timestamps, random ids, or wall-clock anywhere.
 *
 * Exit code contract (R3): exactly one code — PARITY_EXIT_OK (0) means
 * parity held; PARITY_EXIT_MISMATCH (1) means at least one node
 * mismatched. The diff file is written ONLY on mismatch.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stableStringify } from "../contracts/serialize.ts";
import type {
	AggregateParity,
	CanonicalDag,
	NodeParity,
	NormalizedV1Node,
	NormalizedV2Node,
	ParityExecutionMode,
	ParityReport,
} from "./types.ts";

export const PARITY_EXIT_OK = 0;
export const PARITY_EXIT_MISMATCH = 1;

/** Field-by-field per-node comparison (R3). Pure. */
export function compareNodes(v1: NormalizedV1Node, v2: NormalizedV2Node): NodeParity {
	if (v1.skipped && v2.skipped) {
		return { nodeId: v1.nodeId, passed: true, mismatches: [], costDeltaUsd: null, turnsDelta: null };
	}
	const mismatches: string[] = [];
	if (v1.verdict !== v2.verdict) {
		mismatches.push(`verdict: v1=${v1.verdict} v2=${v2.verdict}`);
	}
	const reqsKey = (reqs: readonly string[]): string => [...reqs].sort().join("\u0000");
	if (reqsKey(v1.requirements) !== reqsKey(v2.requirements)) {
		mismatches.push(`requirements: v1=${v1.requirements.length} v2=${v2.requirements.length}`);
	}
	const cmdsKey = (cmds: readonly string[]): string => [...cmds].sort().join("\u0000");
	if (cmdsKey(v1.verificationCommands) !== cmdsKey(v2.verificationCommands)) {
		mismatches.push(
			`verification-commands: v1=${v1.verificationCommands.length} v2=${v2.verificationCommands.length}`,
		);
	}
	if (v1.verificationPassed !== v2.verificationPassed) {
		mismatches.push(
			`verification-passed: v1=${v1.verificationPassed} v2=${v2.verificationPassed}`,
		);
	}
	if (!v1.skipped && !v2.skipped && v1.commitCount !== v2.commitCount) {
		mismatches.push(`commit-count: v1=${v1.commitCount} v2=${v2.commitCount}`);
	}
	if (v1.skipped !== v2.skipped) {
		mismatches.push(`skipped: v1=${v1.skipped} v2=${v2.skipped}`);
	}
	const comparable = !v1.skipped && !v2.skipped;
	return {
		nodeId: v1.nodeId,
		passed: mismatches.length === 0,
		mismatches,
		costDeltaUsd: comparable ? round6(v2.costUsd - v1.costUsd) : null,
		turnsDelta: comparable ? v2.turns - v1.turns : null,
	};
}

/** 6-decimal rounding keeps float noise out of deterministic output. */
function round6(n: number): number {
	return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Assemble the typed parity report (R3). Pure and deterministic: nodes
 * are visited in sorted-id order; aggregates are plain sums; NFR-3/COR
 * evidence is recomputed exactly as workflow/receipts.ts computes it
 * (Σ grounding / Σ totalInput over per-node summaries).
 */
export function buildParityReport(options: {
	dag: CanonicalDag;
	mode: ParityExecutionMode;
	v1: readonly NormalizedV1Node[];
	v2: readonly NormalizedV2Node[];
}): ParityReport {
	const v1ById = new Map(options.v1.map((n) => [n.nodeId, n]));
	const v2ById = new Map(options.v2.map((n) => [n.nodeId, n]));
	const allIds = [...new Set([...v1ById.keys(), ...v2ById.keys()])].sort();

	const nodes: NodeParity[] = [];
	for (const id of allIds) {
		const v1 = v1ById.get(id);
		const v2 = v2ById.get(id);
		if (v1 === undefined || v2 === undefined) {
			nodes.push({
				nodeId: id,
				passed: false,
				mismatches: [
					v1 === undefined ? "side missing: v1 absent (v2 present)" : "side missing: v2 absent (v1 present)",
				],
				costDeltaUsd: null,
				turnsDelta: null,
			});
			continue;
		}
		nodes.push(compareNodes(v1, v2));
	}

	const parity = nodes.every((n) => n.passed);
	const deltasComparable = nodes.every((n) => n.costDeltaUsd !== null && n.turnsDelta !== null);

	let v1TotalCostUsd = 0;
	for (const n of options.v1) v1TotalCostUsd += n.costUsd;
	let v1TotalTurns = 0;
	for (const n of options.v1) v1TotalTurns += n.turns;
	let v2TotalCostUsd = 0;
	for (const n of options.v2) v2TotalCostUsd += n.costUsd;
	let v2TotalTurns = 0;
	for (const n of options.v2) v2TotalTurns += n.turns;

	// NFR-3/COR evidence preserved from receipts: recompute the weighted
	// aggregate COR exactly like receipts.aggregateFromNodes does.
	let totalInputTokens = 0;
	let totalGrounding = 0;
	for (const n of options.v2) {
		if (n.summary === undefined) continue;
		const ti = n.summary.inputTokens + n.summary.cacheReadTokens + n.summary.cacheWriteTokens;
		totalInputTokens += ti;
		totalGrounding += n.summary.cor * ti;
	}

	const verdictCounts: Record<"ship" | "escalate" | "failed", number> = {
		ship: 0,
		escalate: 0,
		failed: 0,
	};
	for (const n of options.v2) verdictCounts[n.verdict] += 1;

	const aggregate: AggregateParity = {
		v1TotalCostUsd: deltasComparable ? round6(v1TotalCostUsd) : null,
		v2TotalCostUsd: deltasComparable ? round6(v2TotalCostUsd) : null,
		costDeltaUsd: deltasComparable ? round6(v2TotalCostUsd - v1TotalCostUsd) : null,
		v1TotalTurns: deltasComparable ? v1TotalTurns : null,
		v2TotalTurns: deltasComparable ? v2TotalTurns : null,
		turnsDelta: deltasComparable ? v2TotalTurns - v1TotalTurns : null,
		v2AggregateCor: totalInputTokens === 0 ? 0 : totalGrounding / totalInputTokens,
		v2TotalInputTokens: totalInputTokens,
		v2TotalOutputTokens: options.v2.reduce((sum, n) => sum + (n.summary?.outputTokens ?? 0), 0),
		v2VerdictCounts: verdictCounts,
	};

	const report: ParityReport = {
		dagId: options.dag.dagId,
		mode: options.mode,
		parity,
		nodes,
		aggregate,
		diff: null,
	};
	report.diff = parity ? null : renderParityDiff(report);
	return report;
}

/**
 * Deterministic human-readable diff text (R3). Derived ONLY from the
 * report fields, so the same inputs always render the same bytes.
 */
export function renderParityDiff(report: ParityReport): string {
	const lines: string[] = [];
	lines.push(`parity MISMATCH: dag "${report.dagId}" (${report.mode})`);
	lines.push("");
	for (const node of [...report.nodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId))) {
		if (node.passed) continue;
		lines.push(`node ${node.nodeId}:`);
		for (const m of node.mismatches) lines.push(`  ✗ ${m}`);
	}
	lines.push("");
	lines.push(
		`aggregate: cost delta ${fmt(report.aggregate.costDeltaUsd)} USD, ` +
			`turns delta ${fmt(report.aggregate.turnsDelta)}, ` +
			`v2 COR ${report.aggregate.v2AggregateCor.toFixed(4)} ` +
			`(input ${report.aggregate.v2TotalInputTokens} tok, output ${report.aggregate.v2TotalOutputTokens} tok)`,
	);
	lines.push(
		`verdicts (v2): ship=${report.aggregate.v2VerdictCounts.ship} ` +
			`escalate=${report.aggregate.v2VerdictCounts.escalate} ` +
			`failed=${report.aggregate.v2VerdictCounts.failed}`,
	);
	return lines.join("\n");
}

function fmt(n: number | null): string {
	return n === null ? "n/a" : String(n);
}

/** Deterministic JSON bytes for a report (sorted keys). */
export function serializeParityReport(report: ParityReport): string {
	return stableStringify(report);
}

/** The single exit code (R3): 0 iff parity held. */
export function parityExitCode(report: ParityReport): typeof PARITY_EXIT_OK | typeof PARITY_EXIT_MISMATCH {
	return report.parity ? PARITY_EXIT_OK : PARITY_EXIT_MISMATCH;
}

/**
 * Persist the report deterministically; on mismatch ALSO writes the diff
 * file next to it (`<basePath>.diff`). Returns the diff file path (null
 * when parity held — no diff file exists). Creates parent directories.
 */
export function writeParityReport(basePath: string, report: ParityReport): string | null {
	mkdirSync(dirname(basePath), { recursive: true });
	writeFileSync(basePath, serializeParityReport(report) + "\n", "utf-8");
	if (report.parity || report.diff === null) return null;
	const diffPath = `${basePath}.diff`;
	writeFileSync(diffPath, report.diff + "\n", "utf-8");
	return diffPath;
}
