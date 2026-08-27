/** Provider-neutral M4 context evaluation dry-run/report command. */
import { readFileSync } from "node:fs";
import { aggregateContextEvaluation, contextEvaluationRecord, renderContextEvaluationPlan, renderContextEvaluationReport } from "./context-evaluation.ts";
import { TraceArtifactSchema } from "../contracts/index.ts";

export function renderContextReport(path: string): string {
	const records = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => contextEvaluationRecord(TraceArtifactSchema.parse(JSON.parse(line))));
	return renderContextEvaluationReport(aggregateContextEvaluation(records));
}

if (process.argv[1]?.endsWith("/context-report.ts") || process.argv[1]?.endsWith("\\context-report.ts")) {
	try {
		const path = process.argv[2];
		process.stdout.write(path === undefined ? renderContextEvaluationPlan() : renderContextReport(path));
	} catch (error) {
		process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	}
}
