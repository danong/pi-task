/** Honest hermetic comparison of raw, v1 map shape, and symbol-tree traces. */
import type { TraceArtifact, TraceEvent } from "../contracts/index.ts";
import { TraceArtifactSchema } from "../contracts/index.ts";

export const CONTEXT_EVALUATION_CONFIGS = [
	{ id: "raw", description: "no-injection baseline" },
	{ id: "v1-map-baseline", description: "recorded deterministic v1 map shape" },
	{ id: "symbol-tree", description: "deterministic symbol-tree handles" },
] as const;

export interface ContextEvaluationRecord {
	sourceTraceId: string;
	providerId: string;
	providerVersion?: string;
	accepted: boolean;
	contextCharacters?: number;
	contextTokens?: number;
	selectedHandles: number;
	readCalls: number;
	contextToolCalls: number;
	repeatedReads: number;
	turns: number;
	costStatus: "measured" | "unavailable";
	costUsd?: number;
	unavailableMetrics: string[];
	treeIdentity?: string;
}

export interface ContextEvaluationAggregate {
	providerId: string;
	runs: number;
	accepted: number;
	contextCharacters?: number;
	contextTokens?: number;
	selectedHandles: number;
	readCalls: number;
	contextToolCalls: number;
	repeatedReads: number;
	turns: number;
	costUsd?: number;
	costStatus: "measured" | "unavailable";
	unavailableMetrics: string[];
	traceIds: string[];
}

function events(trace: TraceArtifact, type: TraceEvent["type"]): TraceEvent[] {
	return trace.events.filter((event) => event.type === type);
}
function numberDetail(
	event: TraceEvent | undefined,
	key: string,
): number | undefined {
	const value = event?.detail?.[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

export function contextEvaluationRecord(
	input: TraceArtifact,
): ContextEvaluationRecord {
	const trace = TraceArtifactSchema.parse(input);
	const injected = events(trace, "context.injected")[0];
	const selected = events(trace, "context.selected")[0];
	const toolStarts = events(trace, "tool.started");
	const reads = toolStarts.filter((event) => event.detail?.toolName === "read");
	const readPaths = reads
		.map((event) => event.detail?.path)
		.filter((value): value is string => typeof value === "string");
	const observedCost = trace.usage?.costUsd;
	const measured = trace.usage?.status === "measured";
	const contextCharacters =
		numberDetail(injected, "estimatedCharacters") ??
		numberDetail(selected, "estimatedCharacters");
	// v1 recorded only its injected token estimate. Keep that legacy fact in the
	// adapter instead of treating missing character evidence as zero.
	const contextTokens =
		numberDetail(injected, "estimatedTokens") ??
		numberDetail(selected, "estimatedTokens") ??
		numberDetail(injected, "tokens");
	const unavailableMetrics: string[] = [];
	if (!measured) unavailableMetrics.push("cost");
	if (contextTokens === undefined) unavailableMetrics.push("contextTokens");
	const providerId =
		typeof injected?.provider === "string"
			? injected.provider
			: typeof selected?.provider === "string"
				? selected.provider
				: "unknown";
	const result: ContextEvaluationRecord = {
		sourceTraceId: trace.runId,
		providerId,
		...(injected?.config === undefined
			? {}
			: { providerVersion: injected.config }),
		accepted:
			trace.outcome === "ship" &&
			events(trace, "artifact.rejected").length === 0,
		...(contextCharacters === undefined ? {} : { contextCharacters }),
		...(contextTokens === undefined ? {} : { contextTokens }),
		selectedHandles: numberDetail(selected, "selectedCount") ?? 0,
		readCalls: reads.length,
		contextToolCalls: toolStarts.filter(
			(event) => event.detail?.toolName === "context",
		).length,
		repeatedReads: readPaths.length - new Set(readPaths).size,
		turns: events(trace, "turn.started").length,
		costStatus: measured ? "measured" : "unavailable",
		...(measured && observedCost !== undefined
			? { costUsd: observedCost }
			: {}),
		unavailableMetrics,
		...(typeof selected?.detail?.treeIdentity === "string"
			? { treeIdentity: selected.detail.treeIdentity }
			: {}),
	};
	return result;
}

/** v1 has no canonical context provider; this adapter records its shape without inventing quality. */
export function adaptV1MapBaseline(
	input: TraceArtifact,
): ContextEvaluationRecord {
	const record = contextEvaluationRecord(input);
	return { ...record, providerId: "v1-map-baseline" };
}

export function aggregateContextEvaluation(
	records: readonly ContextEvaluationRecord[],
): ContextEvaluationAggregate[] {
	const groups = new Map<string, ContextEvaluationRecord[]>();
	for (const record of records)
		groups.set(record.providerId, [
			...(groups.get(record.providerId) ?? []),
			record,
		]);
	return [...groups.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([providerId, group]) => {
			const measured = group.every(
				(record) =>
					record.costStatus === "measured" && record.costUsd !== undefined,
			);
			const contexts = group.flatMap((record) =>
				record.contextCharacters === undefined
					? []
					: [record.contextCharacters],
			);
			const tokens = group.flatMap((record) =>
				record.contextTokens === undefined ? [] : [record.contextTokens],
			);
			return {
				providerId,
				runs: group.length,
				accepted: group.filter((record) => record.accepted).length,
				...(contexts.length === group.length
					? { contextCharacters: contexts.reduce((a, b) => a + b, 0) }
					: {}),
				...(tokens.length === group.length
					? { contextTokens: tokens.reduce((a, b) => a + b, 0) }
					: {}),
				selectedHandles: group.reduce(
					(sum, record) => sum + record.selectedHandles,
					0,
				),
				readCalls: group.reduce((sum, record) => sum + record.readCalls, 0),
				contextToolCalls: group.reduce(
					(sum, record) => sum + record.contextToolCalls,
					0,
				),
				repeatedReads: group.reduce(
					(sum, record) => sum + record.repeatedReads,
					0,
				),
				turns: group.reduce((sum, record) => sum + record.turns, 0),
				...(measured
					? { costUsd: group.reduce((sum, record) => sum + record.costUsd!, 0) }
					: {}),
				costStatus: measured ? "measured" : "unavailable",
				unavailableMetrics: [
					...new Set(group.flatMap((record) => record.unavailableMetrics)),
				].sort(),
				traceIds: group.map((record) => record.sourceTraceId).sort(),
			};
		});
}

export function renderContextEvaluationPlan(): string {
	return [
		"# v2 context evaluation (dry run)",
		"",
		"Configurations:",
		...CONTEXT_EVALUATION_CONFIGS.map(
			(config) => `- ${config.id}: ${config.description}`,
		),
		"",
		"no model or network calls are made; real-model execution is manual and must provide canonical trace artifacts.",
		"",
	].join("\n");
}

export function renderContextEvaluationReport(
	aggregates: readonly ContextEvaluationAggregate[],
): string {
	const lines = [
		"# v2 context evaluation report",
		"",
		"No quality, cost, or acceptance advantage is inferred without measured trials.",
		"",
		"| provider | accepted | context chars | handles | reads | context tools | repeated reads | turns | cost | unavailable | traces |",
		"|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|",
	];
	for (const aggregate of [...aggregates].sort((a, b) =>
		a.providerId.localeCompare(b.providerId),
	))
		lines.push(
			`| ${aggregate.providerId} | ${aggregate.accepted}/${aggregate.runs} | ${aggregate.contextCharacters ?? "unavailable"} | ${aggregate.selectedHandles} | ${aggregate.readCalls} | ${aggregate.contextToolCalls} | ${aggregate.repeatedReads} | ${aggregate.turns} | ${aggregate.costUsd ?? "unavailable"} | ${aggregate.unavailableMetrics.join(", ") || "none"} | ${aggregate.traceIds.join(", ")} |`,
		);
	return `${lines.join("\n")}\n`;
}
