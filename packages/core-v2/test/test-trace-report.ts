import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	loadTraceReport,
	renderTraceReport,
} from "../src/bench/trace-report.ts";
import { TraceCollector, writeTraceArtifact } from "../src/contracts/trace.ts";
import { buildVerificationEvidence } from "../src/contracts/verification-driver.ts";

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (condition: boolean, message: string): void => {
		if (!condition) errors.push(message);
	};
	const root = mkdtempSync(join(tmpdir(), "core-v2-trace-report-"));
	try {
		let tick = 0;
		const collector = new TraceCollector("report-run", "report-task", () =>
			new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
		);
		collector.record({
			type: "model.assigned",
			phase: "model",
			taskId: "report-task",
			provider: "provider",
			config: "provider/model",
			detail: { modelId: "provider/model" },
		});
		collector.record({
			type: "context.planned",
			phase: "context",
			taskId: "report-task",
			provider: "symbol-tree",
			config: "1",
			detail: { mode: "managed" },
		});
		collector.record({
			type: "context.injected",
			phase: "context",
			taskId: "report-task",
			detail: { selectedCount: 2, omittedCount: 1, estimatedTokens: 30 },
		});
		collector.record({
			type: "context.cache",
			phase: "context",
			taskId: "report-task",
			detail: { strategy: "prefix" },
		});
		collector.record({
			type: "session.spawned",
			phase: "session",
			taskId: "report-task",
		});
		collector.record({
			type: "turn.started",
			phase: "turn",
			taskId: "report-task",
		});
		for (let index = 0; index < 2; index += 1) {
			collector.record({
				type: "tool.started",
				phase: "tool",
				taskId: "report-task",
				detail: {
					toolName: "read",
					toolCallId: `read-${index}`,
					path: "src/a.ts",
				},
			});
			collector.record({
				type: "tool.ended",
				phase: "tool",
				taskId: "report-task",
				detail: {
					toolName: "read",
					toolCallId: `read-${index}`,
					isError: index === 1,
				},
			});
		}
		collector.record({
			type: "turn.ended",
			phase: "turn",
			taskId: "report-task",
		});
		collector.record({
			type: "session.ended",
			phase: "session",
			taskId: "report-task",
			detail: { outcome: "yielded" },
		});
		const evidence = buildVerificationEvidence(
			[
				{
					command: "false",
					exitCode: 1,
					stdoutTail: "",
					stderrTail: "secret",
					durationMs: 12,
					timedOut: false,
				},
			],
			1,
		);
		collector.record({
			type: "verification.completed",
			phase: "verification",
			taskId: "report-task",
			detail: { passed: false, evidence },
		});
		collector.record({
			type: "task.failed",
			phase: "task",
			taskId: "report-task",
			detail: {
				cause: "verification failed",
				stage: "verification",
				code: "verification_failed",
			},
		});
		collector.setUsage({
			status: "measured",
			costUsd: 0.01,
			inputTokens: 100,
			outputTokens: 10,
			cacheReadTokens: 50,
			cacheWriteTokens: 0,
		});
		const trace = collector.finish("failed");
		const rendered = renderTraceReport(trace);
		check(rendered.includes("- Turns: 1"), "reports observed turns");
		check(rendered.includes("read=2"), "reports tool counts");
		check(rendered.includes("- Tool errors: 1"), "reports tool errors");
		check(rendered.includes("- Repeated reads: 1"), "reports repeated reads");
		check(
			rendered.includes("- Measured command time: 12 ms"),
			"reports verification duration",
		);
		check(rendered.includes("- Stage: verification"), "reports failure stage");
		check(
			rendered.includes("- Code: verification_failed"),
			"reports failure code",
		);
		check(
			!rendered.includes("secret"),
			"never renders verification output tails",
		);

		const delivered = writeTraceArtifact(trace, root);
		check(delivered.ok, "trace fixture writes");
		if (delivered.ok) {
			writeFileSync(join(root, "report-run.receipt.json"), "{}\n", "utf8");
			writeFileSync(join(root, "report-run.failure.json"), "{}\n", "utf8");
			const loaded = loadTraceReport(delivered.path);
			check(loaded.includes("Receipt: present"), "finds sibling receipt");
			check(
				loaded.includes("Failure: present"),
				"finds sibling failure artifact",
			);
		}

		const dogfood = loadTraceReport(
			fileURLToPath(
				new URL(
					"./fixtures/dogfood/m41-verification-timeout.trace.json",
					import.meta.url,
				),
			),
		);
		check(
			dogfood.includes("- Outcome: failed") &&
				dogfood.includes("- Stage: session") &&
				dogfood.includes("- Code: timed_out") &&
				dogfood.includes("prompt exceeded"),
			"explains the retained useful-dogfood timeout through legacy evidence",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	if (errors.length > 0)
		throw new Error(`test-trace-report failed:\n  ✗ ${errors.join("\n  ✗ ")}`);
	console.log(
		"✓ trace-report: bounded single-run execution and failure explanation",
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
