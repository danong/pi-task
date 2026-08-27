/** Provider-neutral M4 context evaluation dry-run/report command. */
import { readFileSync } from "node:fs";
import {
	adaptV1MapBaseline,
	aggregateContextEvaluation,
	contextEvaluationRecord,
	renderContextEvaluationPlan,
	renderContextEvaluationReport,
} from "./context-evaluation.ts";
import { TraceArtifactSchema, type TraceArtifact } from "../contracts/index.ts";

function recordForTrace(input: TraceArtifact) {
	// v1 emitted context.injected but had no canonical context.selected event.
	// Treat that shape as the recorded map baseline, rather than preserving the
	// model/provider label and silently losing the comparison configuration.
	return input.events.some((event) => event.type === "context.selected")
		? contextEvaluationRecord(input)
		: adaptV1MapBaseline(input);
}

function parseTraceFile(text: string): unknown[] {
	const trimmed = text.trim();
	if (trimmed.length === 0) return [];
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		return trimmed
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	}
}

export function renderContextReport(path: string): string {
	const records = parseTraceFile(readFileSync(path, "utf8")).map((value) =>
		recordForTrace(TraceArtifactSchema.parse(value)),
	);
	return renderContextEvaluationReport(aggregateContextEvaluation(records));
}

if (
	process.argv[1]?.endsWith("/context-report.ts") ||
	process.argv[1]?.endsWith("\\context-report.ts")
) {
	try {
		const path = process.argv[2];
		process.stdout.write(
			path === undefined
				? renderContextEvaluationPlan()
				: renderContextReport(path),
		);
	} catch (error) {
		process.stderr.write(
			`error: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 2;
	}
}
