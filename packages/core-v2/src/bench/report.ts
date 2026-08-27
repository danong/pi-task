/** Provider-neutral benchmark report command over stored trace evidence. */
import {
	aggregateBenchmark,
	BenchmarkStore,
	benchmarkRecordsFromTraces,
	loadTraceArtifacts,
	loadTraceDirectory,
	renderBenchmarkReport,
} from "./benchmark.ts";

export interface BenchmarkReportArgs {
	tracePaths: string[];
	tracesDirectory?: string;
	recordsPath?: string;
	label: string;
}

export function parseBenchmarkReportArgs(argv: readonly string[]): BenchmarkReportArgs {
	const tracePaths: string[] = [];
	let tracesDirectory: string | undefined;
	let recordsPath: string | undefined;
	let label: string | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]!;
		const readValue = (): string => {
			const value = argv[++i];
			if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
			return value;
		};
		if (arg === "--trace" || arg === "--traces") tracePaths.push(readValue());
		else if (arg === "--traces-dir") tracesDirectory = readValue();
		else if (arg === "--records") recordsPath = readValue();
		else if (arg === "--label") label = readValue();
		else if (arg === "--help" || arg === "-h") throw new Error("usage: report.ts (--trace <file>... | --traces-dir <dir> | --records <jsonl>) --label <name>");
		else throw new Error(`unknown option: ${arg}`);
	}
	if (tracePaths.length === 0 && tracesDirectory === undefined && recordsPath === undefined) throw new Error("one of --trace, --traces-dir, or --records is required");
	const sourceCount = (tracePaths.length > 0 ? 1 : 0) + (tracesDirectory === undefined ? 0 : 1) + (recordsPath === undefined ? 0 : 1);
	if (sourceCount > 1) throw new Error("choose exactly one evidence source");
	if (label === undefined || label.trim().length === 0) throw new Error("--label is required");
	return { tracePaths, ...(tracesDirectory === undefined ? {} : { tracesDirectory }), ...(recordsPath === undefined ? {} : { recordsPath }), label };
}

export function renderStoredBenchmarkReport(args: BenchmarkReportArgs): string {
	const records = args.recordsPath === undefined
		? benchmarkRecordsFromTraces(args.tracesDirectory === undefined ? loadTraceArtifacts(args.tracePaths) : loadTraceDirectory(args.tracesDirectory), args.label)
		: new BenchmarkStore(args.recordsPath).load();
	const labels = [...new Set(records.map((record) => record.label))].sort();
	return renderBenchmarkReport(labels.map((label) => aggregateBenchmark(records, label)));
}

if (process.argv[1]?.endsWith("/bench/report.ts") || process.argv[1]?.endsWith("\\bench\\report.ts")) {
	try {
		process.stdout.write(renderStoredBenchmarkReport(parseBenchmarkReportArgs(process.argv.slice(2))));
	} catch (error) {
		process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	}
}
