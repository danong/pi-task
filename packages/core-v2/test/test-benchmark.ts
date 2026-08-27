/** Hermetic tests for trace benchmark derivation, evidence storage, and report rendering.
 *
 * The fixtures are versioned evidence, not defaults or pass/fail thresholds.
 * This suite performs no LLM calls, network access, or child-process work.
 *
 * Standalone: npx tsx packages/core-v2/test/test-benchmark.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	aggregateBenchmark,
	BenchmarkStore,
	benchmarkRecord,
	loadTraceArtifacts,
	loadTraceDirectory,
	renderBenchmarkReport,
	type BenchmarkRecord,
} from "../src/bench/benchmark.ts";
import {
	parseBenchmarkReportArgs,
	renderStoredBenchmarkReport,
} from "../src/bench/report.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FREE_PATH = join(FIXTURES, "free-router-failure-v1.trace.json");
const LUNA_PATH = join(FIXTURES, "luna-success-v1.trace.json");

function invalid(fn: () => unknown): boolean {
	try {
		fn();
		return false;
	} catch {
		return true;
	}
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (condition: boolean, message: string): void => {
		if (!condition) errors.push(message);
	};

	const traces = loadTraceArtifacts([LUNA_PATH, FREE_PATH]);
	const free = traces.find((trace) => trace.runId === "fixture-free-router-failure-v1");
	const luna = traces.find((trace) => trace.runId === "fixture-luna-success-v1");
	check(free !== undefined && luna !== undefined, "both versioned trace fixtures load");
	if (free === undefined || luna === undefined) throw new Error(errors.join("\n"));

	const freeRecord = benchmarkRecord(free, "free-router");
	const lunaRecord = benchmarkRecord(luna, "luna");
	check(!freeRecord.accepted, "free-router failure is not accepted");
	check(lunaRecord.accepted, "luna ship is accepted");
	check(aggregateBenchmark([freeRecord, lunaRecord], "free-router").acceptedRate === 0, "failed run contributes zero accepted rate");
	check(aggregateBenchmark([freeRecord, lunaRecord], "luna").acceptedRate === 1, "successful run contributes full accepted rate");
	check(freeRecord.costUsd === undefined, "unavailable usage has no invented cost");
	check(lunaRecord.costUsd === 0.0125, "measured usage supplies cost");
	check(aggregateBenchmark([freeRecord], "free-router").costPerAccepted === undefined, "failed run has unavailable cost per accepted result");
	check(aggregateBenchmark([lunaRecord], "luna").costPerAccepted === 0.0125, "accepted cost per result is available");
	check(freeRecord.turns === 0, "empty-turn failure preserves zero turns");
	check(lunaRecord.turns === 2, "luna counts structural turns");
	check(JSON.stringify(lunaRecord.toolCalls) === JSON.stringify({ read: 2, bash: 1 }), "luna counts structural tool activity");
	check(lunaRecord.repeatedReads === 1, "repeated reads are counted by path");
	check(lunaRecord.contextTokens === 120, "context tokens are available when injected structurally");
	check(freeRecord.contextTokens === undefined && freeRecord.unavailableMetrics.includes("contextTokens"), "missing context is explicitly unavailable");
	check(lunaRecord.elapsedMs === 2500 && freeRecord.elapsedMs === 1000, "valid elapsed time is derived from trace envelope");
	check(freeRecord.unavailableMetrics.includes("usage"), "unavailable usage is named in metrics");

	const neutralInput = JSON.parse(JSON.stringify(luna)) as Record<string, unknown>;
	delete neutralInput.outcome;
	const neutralRecord = benchmarkRecord(neutralInput as never, "neutral");
	check(!neutralRecord.accepted, "trace without an outcome is neutral, not accepted");
	check(aggregateBenchmark([neutralRecord], "neutral").costPerAccepted === undefined, "neutral run has no cost per accepted result");

	const directoryTraces = loadTraceDirectory(FIXTURES);
	check(JSON.stringify(directoryTraces) === JSON.stringify(loadTraceDirectory(FIXTURES)), "repeated fixture reads are identical");
	check(directoryTraces.map((trace) => trace.runId).join(",") === "fixture-free-router-failure-v1,fixture-luna-success-v1", "trace reads have stable identity order");

	const scratch = mkdtempSync(join(dirname(FIXTURES), ".benchmark-test-"));
	try {
		const store = new BenchmarkStore(join(scratch, "records.jsonl"));
		store.append(freeRecord);
		store.append(lunaRecord);
		const roundTripped = store.load();
		check(JSON.stringify(roundTripped) === JSON.stringify([freeRecord, lunaRecord]), "benchmark records round-trip through JSONL");
		check(readFileSync(store.path, "utf8").split("\n").filter(Boolean).length === 2, "JSONL store writes one evidence record per line");
		check(invalid(() => store.append({ ...lunaRecord, turns: -1 } as never)), "invalid record is rejected before storage");
		check(invalid(() => aggregateBenchmark([{ ...lunaRecord, turns: -1 } as never], "luna")), "invalid record is rejected before aggregation");

		const invalidTracePath = join(scratch, "invalid.trace.json");
		writeFileSync(invalidTracePath, JSON.stringify({ ...luna, version: 999 }), "utf8");
		check(invalid(() => loadTraceArtifacts([invalidTracePath])), "invalid trace evidence is rejected before benchmarking");
		check(!existsSync(join(scratch, "invalid.trace.json.tmp")), "invalid trace does not create benchmark evidence side effects");

		const reportArgs = parseBenchmarkReportArgs(["--records", store.path, "--label", "comparison"]);
		check(reportArgs.recordsPath === store.path && reportArgs.label === "comparison", "report parses explicit record path and label");
		check(invalid(() => parseBenchmarkReportArgs(["--records", store.path])), "report rejects missing explicit label");
		check(invalid(() => parseBenchmarkReportArgs(["--trace", LUNA_PATH, "--records", store.path, "--label", "luna"])), "report rejects mixed evidence sources");
		const traceReport = renderStoredBenchmarkReport(parseBenchmarkReportArgs(["--trace", LUNA_PATH, "--label", "luna"]));
		check(traceReport.includes("fixture-luna-success-v1"), "trace report includes source trace identity");
		const report = renderStoredBenchmarkReport(reportArgs);
		check(report === renderStoredBenchmarkReport(reportArgs), "stored report output is stable across repeated reads");
		check(report.includes("free-router") && report.includes("luna"), "stored report renders labeled comparison rows");
		check(report.includes("fixture-free-router-failure-v1") && report.includes("fixture-luna-success-v1"), "stored report renders all source trace identities");
		const reversedReport = renderBenchmarkReport([
			aggregateBenchmark([lunaRecord], "luna"),
			aggregateBenchmark([freeRecord], "free-router"),
		]);
		check(reversedReport === report, "report rendering is independent of aggregate order");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}

	if (errors.length > 0) throw new Error(`benchmark tests failed:\n  ${errors.join("\n  ")}`);
	console.log("✓ benchmark: validated fixtures, metrics, JSONL storage, and stable reports");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests().then(() => process.exit(0)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
