/** Hermetic derivation and JSONL storage for canonical trace evidence. */
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { z } from "zod";
import {
	TraceArtifactSchema,
	type TraceArtifact,
	type TraceEvent,
} from "../contracts/index.ts";

export interface BenchmarkRecord {
	traceId: string;
	label: string;
	accepted: boolean;
	costUsd?: number;
	turns: number;
	toolCalls: Record<string, number>;
	repeatedReads: number;
	contextTokens?: number;
	elapsedMs?: number;
	verificationFailures: number;
	acceptanceFailures: number;
	unavailableMetrics: string[];
}

export const BenchmarkRecordSchema = z.object({
	traceId: z.string().min(1),
	label: z.string().min(1),
	accepted: z.boolean(),
	costUsd: z.number().nonnegative().optional(),
	turns: z.number().int().nonnegative(),
	toolCalls: z.record(z.string(), z.number().int().nonnegative()),
	repeatedReads: z.number().int().nonnegative(),
	contextTokens: z.number().nonnegative().optional(),
	elapsedMs: z.number().nonnegative().optional(),
	verificationFailures: z.number().int().nonnegative(),
	acceptanceFailures: z.number().int().nonnegative(),
	unavailableMetrics: z.array(z.string()),
}).strict();

export interface BenchmarkAggregate {
	label: string;
	runs: number;
	accepted: number;
	acceptedRate: number;
	costPerAccepted?: number;
	turns: number;
	toolCalls: Record<string, number>;
	repeatedReads: number;
	contextTokens?: number;
	elapsedMs?: number;
	verificationFailures: number;
	acceptanceFailures: number;
	unavailableMetrics: string[];
	traceIds: string[];
}

function events(trace: TraceArtifact, type: TraceEvent["type"]): TraceEvent[] {
	return trace.events.filter((event) => event.type === type);
}

function numberDetail(event: TraceEvent, key: string): number | undefined {
	const value = event.detail?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageFromTrace(trace: TraceArtifact): TraceEvent | undefined {
	return events(trace, "usage.observed")[0];
}

/** Parse stored evidence and return an exact-optional-safe record. */
export function parseBenchmarkRecord(input: unknown): BenchmarkRecord {
	const checked = BenchmarkRecordSchema.parse(input);
	return {
		traceId: checked.traceId,
		label: checked.label,
		accepted: checked.accepted,
		...(checked.costUsd === undefined ? {} : { costUsd: checked.costUsd }),
		turns: checked.turns,
		toolCalls: checked.toolCalls,
		repeatedReads: checked.repeatedReads,
		...(checked.contextTokens === undefined ? {} : { contextTokens: checked.contextTokens }),
		...(checked.elapsedMs === undefined ? {} : { elapsedMs: checked.elapsedMs }),
		verificationFailures: checked.verificationFailures,
		acceptanceFailures: checked.acceptanceFailures,
		unavailableMetrics: checked.unavailableMetrics,
	};
}

/** Derive benchmark facts only from the validated, provider-neutral trace. */
export function benchmarkRecord(traceInput: TraceArtifact, label: string): BenchmarkRecord {
	const trace = TraceArtifactSchema.parse(traceInput);
	const tools: Record<string, number> = {};
	for (const event of events(trace, "tool.started")) {
		const name = typeof event.detail?.toolName === "string" ? event.detail.toolName : "unknown";
		tools[name] = (tools[name] ?? 0) + 1;
	}
	const reads = events(trace, "tool.started").filter((event) => event.detail?.toolName === "read");
	const paths = reads
		.map((event) => typeof event.detail?.path === "string" ? event.detail.path : "")
		.filter((path) => path.length > 0);
	const repeatedReads = paths.length - new Set(paths).size;
	const usageEvent = usageFromTrace(trace);
	const usageStatus = trace.usage?.status ?? (usageEvent?.detail?.status === "measured" ? "measured" : "unavailable");
	const measured = usageStatus === "measured";
	const contextEvents = events(trace, "context.injected");
	const contextValues = contextEvents.map((event) => numberDetail(event, "tokens")).filter((value): value is number => value !== undefined);
	const contextTokens = contextEvents.length > 0 && contextValues.length === contextEvents.length
		? contextValues.reduce((sum, value) => sum + value, 0)
		: undefined;
	const verificationFailures = events(trace, "verification.completed").filter((event) => event.detail?.passed === false).length;
	const acceptanceFailures = events(trace, "artifact.rejected").length;
	const unavailableMetrics: string[] = [];
	if (!measured) unavailableMetrics.push("usage");
	if (contextTokens === undefined) unavailableMetrics.push("contextTokens");
	const elapsedMs = Date.parse(trace.endedAt) - Date.parse(trace.startedAt);
	const validElapsedMs = Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : undefined;
	if (validElapsedMs === undefined) unavailableMetrics.push("elapsedMs");
	const observedCost = trace.usage?.costUsd ?? (usageEvent === undefined ? undefined : numberDetail(usageEvent, "costUsd"));
	const costUsd = measured && observedCost !== undefined && observedCost >= 0 ? observedCost : undefined;
	if (costUsd === undefined && !unavailableMetrics.includes("usage")) unavailableMetrics.push("usage");
	return parseBenchmarkRecord({
		traceId: trace.runId,
		label,
		accepted: trace.outcome === "ship" && acceptanceFailures === 0,
		...(costUsd === undefined ? {} : { costUsd }),
		turns: events(trace, "turn.started").length,
		toolCalls: tools,
		repeatedReads,
		...(contextTokens === undefined ? {} : { contextTokens }),
		...(validElapsedMs === undefined ? {} : { elapsedMs: validElapsedMs }),
		verificationFailures,
		acceptanceFailures,
		unavailableMetrics,
	});
}

export function aggregateBenchmark(records: readonly BenchmarkRecord[], label: string): BenchmarkAggregate {
	const checkedRecords = records.map((record) => parseBenchmarkRecord(record));
	const selected = checkedRecords.filter((record) => record.label === label);
	const accepted = selected.filter((record) => record.accepted).length;
	const costs = selected.flatMap((record) => record.costUsd === undefined ? [] : [record.costUsd]);
	const toolCalls: Record<string, number> = {};
	for (const record of selected) {
		for (const [tool, count] of Object.entries(record.toolCalls)) toolCalls[tool] = (toolCalls[tool] ?? 0) + count;
	}
	const orderedToolCalls = Object.fromEntries(Object.entries(toolCalls).sort(([left], [right]) => left.localeCompare(right)));
	const context = selected.flatMap((record) => record.contextTokens === undefined ? [] : [record.contextTokens]);
	const elapsed = selected.flatMap((record) => record.elapsedMs === undefined ? [] : [record.elapsedMs]);
	return {
		label,
		runs: selected.length,
		accepted,
		acceptedRate: selected.length === 0 ? 0 : accepted / selected.length,
		...(accepted > 0 && costs.length === selected.length ? { costPerAccepted: costs.reduce((sum, cost) => sum + cost, 0) / accepted } : {}),
		turns: selected.reduce((sum, record) => sum + record.turns, 0),
		toolCalls: orderedToolCalls,
		repeatedReads: selected.reduce((sum, record) => sum + record.repeatedReads, 0),
		...(context.length === selected.length ? { contextTokens: context.reduce((sum, value) => sum + value, 0) } : {}),
		...(elapsed.length === selected.length ? { elapsedMs: elapsed.reduce((sum, value) => sum + value, 0) } : {}),
		verificationFailures: selected.reduce((sum, record) => sum + record.verificationFailures, 0),
		acceptanceFailures: selected.reduce((sum, record) => sum + record.acceptanceFailures, 0),
		unavailableMetrics: [...new Set(selected.flatMap((record) => record.unavailableMetrics))].sort(),
		traceIds: selected.map((record) => record.traceId).sort(),
	};
}

/** Read and validate trace JSON files; invalid evidence is never benchmarked. */
export function loadTraceArtifacts(paths: readonly string[]): TraceArtifact[] {
	return [...paths].sort().map((path) => TraceArtifactSchema.parse(JSON.parse(readFileSync(path, "utf8"))));
}

/** Read all trace artifacts directly beneath a directory in stable order. */
export function loadTraceDirectory(directory: string): TraceArtifact[] {
	const paths = readdirSync(directory, { withFileTypes: true })
		.filter((entry: { isFile(): boolean; name: string }) => entry.isFile() && extname(entry.name) === ".json" && entry.name.endsWith(".trace.json"))
		.map((entry: { name: string }) => join(directory, entry.name));
	return loadTraceArtifacts(paths);
}


export function benchmarkRecordsFromTraces(traces: readonly TraceArtifact[], label: string): BenchmarkRecord[] {
	return traces.map((trace) => benchmarkRecord(trace, label));
}

export class BenchmarkStore {
	constructor(readonly path: string) {}

	append(record: BenchmarkRecord): void {
		const checked = BenchmarkRecordSchema.parse(record);
		mkdirSync(dirname(this.path), { recursive: true });
		appendFileSync(this.path, `${JSON.stringify(checked)}\n`, "utf8");
	}

	appendTrace(trace: TraceArtifact, label: string): BenchmarkRecord {
		const record = benchmarkRecord(trace, label);
		this.append(record);
		return record;
	}

	load(): BenchmarkRecord[] {
		try {
			return readFileSync(this.path, "utf8")
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.map((line) => parseBenchmarkRecord(JSON.parse(line)));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}
}

export function renderBenchmarkReport(aggregates: readonly BenchmarkAggregate[]): string {
	const lines = [
		"# v2 trace benchmark",
		"",
		"| configuration | accepted | cost/accepted | turns | tool calls | repeated reads | context | elapsed | failures | unavailable |",
		"|---|---:|---:|---|---:|---:|---:|---:|---|---|",
	];
	const ordered = [...aggregates].sort((left, right) => left.label.localeCompare(right.label));
	for (const aggregate of ordered) {
		lines.push(`| ${aggregate.label} | ${aggregate.accepted}/${aggregate.runs} (${(aggregate.acceptedRate * 100).toFixed(1)}%) | ${aggregate.costPerAccepted === undefined ? "unavailable" : aggregate.costPerAccepted.toFixed(6)} | ${aggregate.turns} | ${JSON.stringify(aggregate.toolCalls)} | ${aggregate.repeatedReads} | ${aggregate.contextTokens ?? "unavailable"} | ${aggregate.elapsedMs ?? "unavailable"} | verify=${aggregate.verificationFailures}, acceptance=${aggregate.acceptanceFailures} | ${aggregate.unavailableMetrics.join(", ") || "none"} |`);
	}
	const identities = ordered.flatMap((aggregate) => aggregate.traceIds.map((id) => `${aggregate.label}=${id}`)).sort();
	lines.push("", `Trace identities: ${identities.join(", ") || "none"}`);
	return `${lines.join("\n")}\n`;
}
