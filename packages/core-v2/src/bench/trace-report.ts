/** Human-oriented explanation of one canonical v2 trace. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	TraceArtifactSchema,
	type TraceArtifact,
	type TraceEvent,
} from "../contracts/trace.ts";

function events(trace: TraceArtifact, type: TraceEvent["type"]): TraceEvent[] {
	return trace.events.filter((event) => event.type === type);
}

function last(
	trace: TraceArtifact,
	type: TraceEvent["type"],
): TraceEvent | undefined {
	return events(trace, type).at(-1);
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function textValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function elapsedMs(start: string, end: string): number | undefined {
	const value = Date.parse(end) - Date.parse(start);
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function eventSpanMs(
	start: TraceEvent | undefined,
	end: TraceEvent | undefined,
): number | undefined {
	return start === undefined || end === undefined
		? undefined
		: elapsedMs(start.at, end.at);
}

function display(value: unknown): string {
	return value === undefined ? "unavailable" : String(value);
}

function toolSummary(trace: TraceArtifact): {
	calls: string;
	errors: number;
	repeatedReads: number;
} {
	const counts = new Map<string, number>();
	const readPaths: string[] = [];
	for (const event of events(trace, "tool.started")) {
		const tool = textValue(event.detail?.toolName) ?? "unknown";
		counts.set(tool, (counts.get(tool) ?? 0) + 1);
		if (tool === "read") {
			const path = textValue(event.detail?.path);
			if (path !== undefined) readPaths.push(path);
		}
	}
	const calls = [...counts.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, count]) => `${name}=${count}`)
		.join(", ");
	const errors = events(trace, "tool.ended").filter(
		(event) => event.detail?.isError === true,
	).length;
	return {
		calls: calls || "none",
		errors,
		repeatedReads: readPaths.length - new Set(readPaths).size,
	};
}

/** Render only bounded structural evidence already admitted by the trace schema. */
export function renderTraceReport(
	traceInput: TraceArtifact,
	tracePath?: string,
): string {
	const trace = TraceArtifactSchema.parse(traceInput);
	const model = last(trace, "model.assigned");
	const planned = last(trace, "context.planned");
	const injected = last(trace, "context.injected");
	const cache = last(trace, "context.cache");
	const verification = last(trace, "verification.completed");
	const terminalFailure = last(trace, "task.failed");
	const diagnosticFailure = last(trace, "failure");
	const failure = terminalFailure ?? diagnosticFailure;
	const spawned = events(trace, "session.spawned")[0];
	const sessionEnded = last(trace, "session.ended");
	const tools = toolSummary(trace);
	const evidence = verification?.detail?.evidence as
		Record<string, unknown> | undefined;
	const artifactDirectory =
		tracePath === undefined ? undefined : dirname(resolve(tracePath));
	const sibling = (suffix: string): string | undefined =>
		artifactDirectory === undefined
			? undefined
			: join(artifactDirectory, `${trace.runId}.${suffix}.json`);
	const receiptPath = sibling("receipt");
	const failurePath = sibling("failure");
	const modelId = textValue(model?.detail?.modelId) ?? model?.config;
	const engineVersion = textValue(model?.detail?.engineVersion);
	const familyId = textValue(model?.detail?.familyId);
	const attemptNumber = numberValue(model?.detail?.attemptNumber);
	const specHash = textValue(model?.detail?.specHash);
	const modelMaxTurns = numberValue(model?.detail?.maxTurns);
	const modelMaxCostUsd = numberValue(model?.detail?.maxCostUsd);
	const modelWallTimeoutMs = numberValue(model?.detail?.wallTimeoutMs);
	const failureMaxTurns =
		numberValue(terminalFailure?.detail?.maxTurns) ?? numberValue(diagnosticFailure?.detail?.maxTurns);
	const failureMaxCostUsd =
		numberValue(terminalFailure?.detail?.maxCostUsd) ?? numberValue(diagnosticFailure?.detail?.maxCostUsd);
	const failureWallTimeoutMs =
		numberValue(terminalFailure?.detail?.wallTimeoutMs) ?? numberValue(diagnosticFailure?.detail?.wallTimeoutMs);
	const provider = planned?.provider ?? "unavailable";
	const contextMode = textValue(planned?.detail?.mode);
	const selectedCount = numberValue(injected?.detail?.selectedCount);
	const omittedCount = numberValue(injected?.detail?.omittedCount);
	const contextTokens = numberValue(injected?.detail?.estimatedTokens);
	const strategy = textValue(cache?.detail?.strategy);
	const failureStage =
		textValue(terminalFailure?.detail?.stage) ??
		textValue(diagnosticFailure?.detail?.stage) ??
		diagnosticFailure?.phase;
	const failureCode =
		textValue(terminalFailure?.detail?.code) ??
		textValue(diagnosticFailure?.detail?.code);
	const diagnosticCause =
		textValue(diagnosticFailure?.detail?.cause) ??
		textValue(diagnosticFailure?.detail?.message);
	const terminalCause = textValue(terminalFailure?.detail?.cause);
	const failureCause =
		diagnosticCause ?? terminalCause ?? textValue(failure?.detail?.message);
	const totalMs = elapsedMs(trace.startedAt, trace.endedAt);
	const sessionMs = eventSpanMs(spawned, sessionEnded);
	const verificationMs =
		numberValue(evidence?.durationMs) ??
		(Array.isArray(evidence?.commands)
			? evidence.commands.reduce(
					(sum: number, command: unknown) =>
						sum +
						(numberValue(
							(command as Record<string, unknown> | null)?.durationMs,
						) ?? 0),
					0,
				)
			: undefined);
	const lines = [
		"# v2 trace report",
		"",
		"## Run",
		`- Run: ${trace.runId}`,
		`- Outcome: ${trace.outcome ?? "unavailable"}`,
		`- Model: ${modelId ?? "unavailable"}`,
		`- Engine: ${engineVersion ?? "unavailable"}`,
		`- Task family: ${familyId ?? "unavailable"}`,
		`- Attempt: ${display(attemptNumber)}`,
		`- Spec hash: ${specHash ?? "unavailable"}`,
		`- Total elapsed: ${display(totalMs)} ms`,
		`- Session elapsed: ${display(sessionMs)} ms`,
		`- Configured maxTurns: ${display(modelMaxTurns)}`,
		`- Configured maxCostUsd: ${display(modelMaxCostUsd)}`,
		`- Configured wallTimeoutMs: ${display(modelWallTimeoutMs)}`,
		"",
		"## Execution",
		`- Turns: ${events(trace, "turn.started").length}`,
		`- Tool calls: ${tools.calls}`,
		`- Tool errors: ${tools.errors}`,
		`- Repeated reads: ${tools.repeatedReads}`,
		`- Budget maxTurns: ${display(modelMaxTurns ?? failureMaxTurns)}`,
		`- Budget maxCostUsd: ${display(modelMaxCostUsd ?? failureMaxCostUsd)}`,
		"",
		"## Context",
		`- Provider: ${provider}`,
		`- Mode: ${contextMode ?? "unavailable"}`,
		`- Selected: ${display(selectedCount)}`,
		`- Omitted: ${display(omittedCount)}`,
		`- Estimated tokens: ${display(contextTokens)}`,
		`- Planned cache strategy: ${strategy ?? "unavailable"}`,
		"",
		"## Verification",
		`- Passed: ${display(verification?.detail?.passed)}`,
		`- Executed/expected: ${display(evidence?.executedCount)}/${display(evidence?.expectedCount)}`,
		`- Omitted summaries: ${display(evidence?.omittedCount)}`,
		`- Measured command time: ${display(verificationMs)} ms`,
		"",
		"## Failure",
		`- Stage: ${failureStage ?? "none"}`,
		`- Code: ${failureCode ?? "none"}`,
		`- Cause: ${failureCause ?? "none"}`,
		`- Terminal cause: ${terminalCause ?? "none"}`,
		`- Budget maxTurns: ${display(failureMaxTurns ?? modelMaxTurns)}`,
		`- Budget maxCostUsd: ${display(failureMaxCostUsd ?? modelMaxCostUsd)}`,
		`- Budget wallTimeoutMs: ${display(failureWallTimeoutMs ?? modelWallTimeoutMs)}`,
		"",
		"## Usage",
		`- Status: ${trace.usage?.status ?? "unavailable"}`,
		`- Cost USD: ${display(trace.usage?.costUsd)}`,
		`- Input tokens: ${display(trace.usage?.inputTokens)}`,
		`- Output tokens: ${display(trace.usage?.outputTokens)}`,
		`- Cache-read tokens: ${display(trace.usage?.cacheReadTokens)}`,
		"",
		"## Artifacts",
		`- Trace: ${tracePath === undefined ? "unavailable" : resolve(tracePath)}`,
		`- Receipt: ${receiptPath === undefined ? "unavailable" : `${existsSync(receiptPath) ? "present" : "missing"} (${receiptPath})`}`,
		`- Failure: ${failurePath === undefined ? "unavailable" : `${existsSync(failurePath) ? "present" : "missing"} (${failurePath})`}`,
	];
	return `${lines.join("\n")}\n`;
}

export function loadTraceReport(tracePath: string): string {
	const resolved = resolve(tracePath);
	const trace = TraceArtifactSchema.parse(
		JSON.parse(readFileSync(resolved, "utf8")),
	);
	return renderTraceReport(trace, resolved);
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const tracePath = process.argv[2];
	if (tracePath === undefined) {
		console.error("usage: trace-report <trace.json> [report.md]");
		process.exit(2);
	}
	try {
		const report = loadTraceReport(tracePath);
		const outputPath = process.argv[3];
		if (outputPath === undefined) process.stdout.write(report);
		else writeFileSync(resolve(outputPath), report, "utf8");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
