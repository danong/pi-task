/**
 * Grounding evaluation evidence store — M3 (docs/pi-task-v2.md §7).
 *
 * Append-only JSONL record log + summary artifact writer for the
 * suite-03 grounding-mode harness. Lives in core-v2 so it is strictly
 * typechecked and hermetically testable; extensions/task/grounding-eval.ts
 * is thin CLI glue over this module plus the owner file's specs.
 *
 * Records are ADDITIVE (resumable across runs); corrupt lines are counted
 * and skipped, never fatal — evidence survives partial writes.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
	aggregateRecords,
	buildWinsLoses,
	renderSummaryLines,
} from "./grounding-metrics.ts";
import type { GroundingRunRecord } from "./grounding-metrics.ts";

/** Where the evidence lives: <metricsDir>/eval-grounding/. */
export function evalEvidenceDir(metricsDir: string): string {
	return join(metricsDir, "eval-grounding");
}

export function recordsPath(metricsDir: string): string {
	return join(evalEvidenceDir(metricsDir), "records.jsonl");
}

export function defaultSummaryPath(metricsDir: string): string {
	return join(evalEvidenceDir(metricsDir), "summary.md");
}

/** Append one record as a JSONL line. Throws on fs failure (never silent). */
export function appendRecord(
	metricsDir: string,
	record: GroundingRunRecord,
): void {
	const path = recordsPath(metricsDir);
	mkdirSync(evalEvidenceDir(metricsDir), { recursive: true });
	appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
}

/** Load every stored record; blank lines skipped, corrupt lines counted. */
export function loadRecords(metricsDir: string): {
	records: GroundingRunRecord[];
	corrupt: number;
} {
	const path = recordsPath(metricsDir);
	if (!existsSync(path)) return { records: [], corrupt: 0 };
	const records: GroundingRunRecord[] = [];
	let corrupt = 0;
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			records.push(JSON.parse(line) as GroundingRunRecord);
		} catch {
			corrupt += 1;
		}
	}
	return { records, corrupt };
}

/**
 * Build + persist the wins/loses summary artifact (creates parent dirs).
 * Returns the rendered markdown lines.
 */
export function writeSummary(
	records: readonly GroundingRunRecord[],
	summaryOut: string,
): string[] {
	const aggs = [...aggregateRecords(records).values()];
	const winners = buildWinsLoses(aggs);
	const lines = renderSummaryLines(records, aggs, winners);
	mkdirSync(join(summaryOut, ".."), { recursive: true });
	writeFileSync(summaryOut, lines.join("\n") + "\n", "utf-8");
	return lines;
}
