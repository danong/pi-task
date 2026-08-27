/** Hermetic M4 context comparison: canonical traces only, no model/network. */
import { pathToFileURL } from "node:url";
import { TraceCollector } from "../src/contracts/index.ts";
import {
	CONTEXT_EVALUATION_CONFIGS,
	adaptV1MapBaseline,
	contextEvaluationRecord,
	aggregateContextEvaluation,
	renderContextEvaluationPlan,
	renderContextEvaluationReport,
} from "../src/bench/context-evaluation.ts";

function fixture(id: string, provider: string, accepted: boolean, measured: boolean) {
	let tick = 0;
	const trace = new TraceCollector(id, id, () => new Date(tick++ * 1000).toISOString());
	if (provider !== "v1-map-baseline") {
		trace.record({ type: "context.planned", phase: "context", taskId: id, provider, config: "1", detail: { planId: `plan:${id}`, mode: provider === "raw" ? "raw" : "managed" } });
		trace.record({ type: "context.cache", phase: "context", taskId: id, provider, config: "1", detail: { strategy: provider === "raw" ? "none" : "local", attribution: "unavailable", storedArtifactCount: provider === "raw" ? 0 : 2 } });
		trace.record({ type: "epoch.started", phase: "recovery", taskId: id, provider, config: "1", detail: { epochId: `epoch:${id}`, planId: `plan:${id}` } });
	}
	trace.record({ type: "context.selected", phase: "context", taskId: id, provider, config: "1", detail: { treeIdentity: `tree:${id}`, selectedCount: provider === "raw" ? 0 : 3, omittedCount: 1, estimatedCharacters: provider === "raw" ? 0 : 600, estimatedTokens: provider === "raw" ? 0 : 150, ...(provider === "v1-map-baseline" ? { baselineShape: "v1-deterministic-map" } : {}) } });
	trace.record({ type: "context.injected", phase: "context", taskId: id, provider, config: "1", detail: { treeIdentity: `tree:${id}`, selectedCount: provider === "raw" ? 0 : 3, omittedCount: 1, estimatedCharacters: provider === "raw" ? 0 : 600, estimatedTokens: provider === "raw" ? 0 : 150 } });
	trace.record({ type: "turn.started", phase: "turn", taskId: id });
	trace.record({ type: "tool.started", phase: "tool", taskId: id, detail: { toolName: "read", path: "src/a.ts" } });
	trace.record({ type: "tool.started", phase: "tool", taskId: id, detail: { toolName: "read", path: "src/a.ts" } });
	trace.record({ type: "tool.started", phase: "tool", taskId: id, detail: { toolName: "context", action: "query" } });
	trace.setUsage({ status: measured ? "measured" : "unavailable", costUsd: measured ? 0.25 : 0, inputTokens: measured ? 100 : 0, outputTokens: measured ? 20 : 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
	return trace.finish(accepted ? "ship" : "failed");
}

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (condition: boolean, message: string): void => { if (!condition) errors.push(message); };
	check(JSON.stringify(CONTEXT_EVALUATION_CONFIGS.map((item) => item.id)) === JSON.stringify(["raw", "v1-map-baseline", "symbol-tree"]), "dry plan compares the required provider-neutral configurations");
	const dry = renderContextEvaluationPlan();
	check(dry.includes("dry run") && dry.includes("no model or network"), "dry plan is explicitly hermetic");

	const raw = contextEvaluationRecord(fixture("raw-1", "raw", true, false));
	const v1 = adaptV1MapBaseline(fixture("v1-1", "v1-map-baseline", false, true));
	const symbol = contextEvaluationRecord(fixture("symbol-1", "symbol-tree", true, true));
	check(raw.contextCharacters === 0 && raw.selectedHandles === 0, "raw/no-injection size and handles derive from trace evidence");
	check(v1.providerId === "v1-map-baseline" && v1.accepted === false, "v1 adapter preserves a recorded negative acceptance outcome");
	check(symbol.readCalls === 2 && symbol.contextToolCalls === 1 && symbol.repeatedReads === 1 && symbol.turns === 1, "read/tool/repeated-read activity and turns derive from canonical events");
	check(raw.costUsd === undefined && raw.costStatus === "unavailable", "unmeasured cost stays unavailable rather than zero");
	check(symbol.costUsd === 0.25 && symbol.sourceTraceId === "symbol-1", "measured cost and source trace identity are preserved");
	check(symbol.storedArtifacts === 2 && symbol.epochs === 1 && symbol.cacheStrategy === "local", "artifact strategy and epoch activity derive from canonical lifecycle events");

	const aggregates = aggregateContextEvaluation([raw, v1, symbol]);
	const report = renderContextEvaluationReport(aggregates);
	check(report.includes("raw-1") && report.includes("v1-1") && report.includes("symbol-1"), "report retains every source trace identity");
	check(report.includes("unavailable") && report.includes("1/1") && report.includes("0/1"), "report preserves unavailable and neutral/negative outcomes");
	check(!/winner|wins|improv/i.test(report), "report makes no fabricated quality or cost win claim");

	if (errors.length > 0) throw new Error(`test-context-eval failed:\n  ✗ ${errors.join("\n  ✗ ")}`);
	console.log("✓ context-eval: honest canonical raw/v1-map/symbol comparison with source identities");
	return Promise.resolve();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
