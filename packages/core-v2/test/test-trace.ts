/** Hermetic tests for the canonical trace contract and writer (M3).
 *
 * Covers validation and privacy boundaries, collector ordering/caps, usage
 * status, deterministic bytes, all gateway lifecycle projections, and atomic
 * artifact delivery. Zero LLM, zero network.
 *
 * Standalone: npx tsx packages/core-v2/test/test-trace.ts
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { TaskLifecycleEvent } from "../src/contracts/gateway-events.ts";
import {
	TRACE_MAX_DETAIL_CHARS,
	TRACE_MAX_EVENTS,
	MAX_VERIFICATION_COMMAND_SUMMARIES,
	TraceArtifactSchema,
	TraceCollector,
	TraceEventSchema,
	TraceUsageSchema,
	boundedDetail,
	capTraceText,
	stableStringify,
	traceEventFromGateway,
	verificationCommandDigest,
	writeTraceArtifact,
} from "../src/contracts/index.ts";

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

	// Schema validation and privacy boundaries are enforced even when callers
	// bypass the collector and validate a persisted artifact directly.
	{
		const base = {
			version: 1 as const,
			sequence: 1,
			at: "2026-01-01T00:00:00.000Z",
			taskId: "task-1",
			runId: "run-1",
			phase: "task" as const,
			type: "task.queued" as const,
		};
		check(!invalid(() => TraceEventSchema.parse(base)), "valid event parses");
		check(
			invalid(() => TraceEventSchema.parse({ ...base, sequence: 0 })),
			"non-positive sequence rejected",
		);
		check(
			invalid(() =>
				TraceEventSchema.parse({ ...base, type: "provider.private" }),
			),
			"provider-specific event rejected",
		);
		check(
			invalid(() =>
				TraceEventSchema.parse({ ...base, detail: { transcript: "hidden" } }),
			),
			"transcript detail rejected",
		);
		check(
			invalid(() =>
				TraceEventSchema.parse({
					...base,
					detail: { nested: { privateReasoning: "hidden" } },
				}),
			),
			"nested private reasoning rejected",
		);
		check(
			invalid(() =>
				TraceEventSchema.parse({
					...base,
					detail: { output: "secret output" },
				}),
			),
			"output detail rejected",
		);
		check(
			invalid(() =>
				TraceEventSchema.parse({
					...base,
					detail: { stdoutTail: "secret stdout" },
				}),
			),
			"stdout detail rejected",
		);
		check(
			invalid(() =>
				TraceEventSchema.parse({
					...base,
					detail: { prompt: "secret prompt" },
				}),
			),
			"prompt detail rejected",
		);
		const childTrace = {
			...base,
			type: "child.completed" as const,
			detail: {
				parentTaskId: "parent", childTaskId: "child-1", relationship: "continuation" as const,
				ordinal: 1, status: "completed" as const,
				resultArtifactId: "sha256:" + "1".repeat(64), receiptArtifactId: "sha256:" + "2".repeat(64), traceArtifactId: "sha256:" + "3".repeat(64),
			},
		};
		check(invalid(() => TraceEventSchema.parse(childTrace)), "trace rejects relationship-mismatched child event");
		check(
			invalid(() =>
				TraceEventSchema.parse({
					...base,
					detail: { text: "x".repeat(TRACE_MAX_DETAIL_CHARS) },
				}),
			),
			"unbounded detail rejected",
		);
		const capped = boundedDetail({ text: "x".repeat(TRACE_MAX_DETAIL_CHARS) });
		check(
			capped !== undefined &&
				JSON.stringify(capped).length <= TRACE_MAX_DETAIL_CHARS,
			"collector detail cap is encoded-size bounded",
		);
		check(
			!JSON.stringify(boundedDetail({ transcript: "hidden" })).includes(
				"hidden",
			),
			"collector omits private detail",
		);
		check(
			capTraceText("abcdef", 3) === "def" && capTraceText("abcdef", 0) === "",
			"text cap handles suffix and zero limits",
		);

		const malformedArtifact = {
			version: 1 as const,
			runId: "run-1",
			taskId: "task-1",
			startedAt: base.at,
			endedAt: base.at,
			events: [base, { ...base, sequence: 3 }],
		};
		check(
			invalid(() => TraceArtifactSchema.parse(malformedArtifact)),
			"artifact rejects gaps and out-of-order events",
		);
		check(
			invalid(() =>
				TraceArtifactSchema.parse({
					...malformedArtifact,
					events: [{ ...base, runId: "other" }],
				}),
			),
			"artifact rejects identity mismatch",
		);
	}

	// The collector supplies the monotonic envelope and stops at the structural
	// cap without inventing a sequence number for dropped events.
	{
		let tick = 0;
		const collector = new TraceCollector(
			"run-ordered",
			"task-ordered",
			() => `t-${++tick}`,
		);
		for (let i = 0; i < TRACE_MAX_EVENTS + 3; i += 1) {
			collector.record({
				type: "task.queued",
				phase: "task",
				taskId: "task-ordered",
				detail: { index: i },
			});
		}
		const artifact = collector.finish("ship");
		check(
			artifact.events.length === TRACE_MAX_EVENTS,
			"collector event cap is enforced",
		);
		check(
			artifact.events.every((event, index) => event.sequence === index + 1),
			"collector sequences are contiguous",
		);
		check(
			artifact.events[0]!.at === "t-2" &&
				artifact.events.at(-1)!.at === `t-${TRACE_MAX_EVENTS + 1}`,
			"collector preserves input order",
		);
		check(
			artifact.outcome === "ship" &&
				artifact.runId === "run-ordered" &&
				artifact.taskId === "task-ordered",
			"terminal outcome and identity are retained",
		);
	}

	// Usage status remains explicit: zeroes in an unavailable snapshot are not
	// interpreted as a measured free run.
	{
		const unavailable = TraceUsageSchema.parse({
			status: "unavailable",
			costUsd: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		const measured = TraceUsageSchema.parse({
			status: "measured",
			costUsd: 0,
			inputTokens: 2,
			outputTokens: 3,
			cacheReadTokens: 4,
			cacheWriteTokens: 5,
		});
		check(
			unavailable.status === "unavailable" && measured.status === "measured",
			"measured and unavailable usage statuses round-trip",
		);
		const collector = new TraceCollector(
			"usage-run",
			"usage-task",
			() => "same-time",
		);
		collector.setUsage(unavailable);
		check(
			collector.finish("failed").usage?.status === "unavailable",
			"unavailable usage is retained on artifact",
		);
		collector.setUsage(measured);
		check(
			collector.finish("failed").usage?.status === "measured",
			"measured usage replaces and remains explicit",
		);
	}

	// Projection is an exhaustive switch over the current gateway vocabulary.
	{
		const events: TaskLifecycleEvent[] = [
			{ type: "task.queued", taskId: "projection-task" },
			{
				type: "task.routed",
				taskId: "projection-task",
				detail: { planMode: "prewalk" },
			},
			{
				type: "session.spawned",
				taskId: "projection-task",
				sessionId: "session-1",
			},
			{
				type: "session.yielded",
				taskId: "projection-task",
				sessionId: "session-1",
			},
			{
				type: "session.exhausted",
				taskId: "projection-task",
				sessionId: "session-1",
			},
			{
				type: "verify.completed",
				taskId: "projection-task",
				detail: {
					passed: true,
					evidence: {
						executedCount: 2,
						expectedCount: 2,
						omittedCount: 0,
						capped: false,
						commands: [
							{
								index: 0,
								digest: verificationCommandDigest("true"),
								exitCode: 0,
								timedOut: false,
								durationMs: 4,
							},
							{
								index: 1,
								digest: verificationCommandDigest("false"),
								exitCode: 1,
								timedOut: false,
								durationMs: 5,
							},
						],
					},
				},
			},
			{
				type: "review.completed",
				taskId: "projection-task",
				detail: { verdict: "fix" },
			},
			{
				type: "merge.completed",
				taskId: "projection-task",
				detail: { commitId: "commit-1" },
			},
			{
				type: "merge.conflict",
				taskId: "projection-task",
				detail: { conflicts: ["a.ts", "b.ts"] },
			},
			{
				type: "permission.requested",
				taskId: "projection-task",
				sessionId: "session-1",
				requestId: "request-1",
				action: "bash",
				detail: "approval needed",
			},
			{
				type: "task.completed",
				taskId: "projection-task",
				sessionId: "session-1",
				detail: { verdict: "ship" },
			},
			{
				type: "task.failed",
				taskId: "projection-task",
				detail: {
					cause: "failure",
					stage: "verification",
					code: "verification_failed",
				},
			},
			{
				type: "task.escalated",
				taskId: "projection-task",
				detail: { verdict: "escalate" },
			},
			{
				type: "child.queued",
				taskId: "projection-task",
				detail: {
					parentTaskId: "projection-task", childTaskId: "projection-child",
					relationship: "continuation", ordinal: 1, status: "ready",
					handoffArtifactId: "sha256:" + "1".repeat(64),
				},
			},
		];
		const collector = new TraceCollector(
			"projection-run",
			"projection-task",
			() => "projection-time",
		);
		for (const event of events)
			collector.record(traceEventFromGateway(event, collector.runId));
		const artifact = collector.finish("escalate");
		check(
			artifact.events.length === events.length,
			"every gateway event projects to one trace event",
		);
		check(
			artifact.events.every(
				(event) =>
					event.taskId === "projection-task" &&
					event.runId === "projection-run",
			),
			"projected identities are canonical",
		);
		const verificationEvent = artifact.events.find(
			(event) => event.type === "verification.completed",
		);
		const verificationEvidence = verificationEvent?.detail?.evidence as
			| {
					commands?: Array<{
						index: number;
						digest: string;
						exitCode: number;
						timedOut: boolean;
						durationMs: number;
					}>;
					executedCount?: number;
					expectedCount?: number;
					omittedCount?: number;
					capped?: boolean;
			  }
			| undefined;
		check(
			verificationEvidence?.executedCount === 2 &&
				verificationEvidence.expectedCount === 2 &&
				verificationEvidence.omittedCount === 0 &&
				verificationEvidence.capped === false &&
				verificationEvidence.commands?.[0]?.index === 0 &&
				verificationEvidence.commands?.[1]?.exitCode === 1,
			"verification projection retains structural evidence",
		);
		const failureEvent = artifact.events.find(
			(event) => event.type === "task.failed",
		);
		check(
			failureEvent?.detail?.stage === "verification" &&
				failureEvent.detail.code === "verification_failed",
			"task failure projection retains stable stage and code",
		);
		check(
			artifact.events.every((event) => {
				const encoded = JSON.stringify(event);
				return (
					!encoded.includes("transcript") &&
					!encoded.includes("reasoning") &&
					!encoded.includes("secret command") &&
					!encoded.includes("secret stdout")
				);
			}),
			"projected events contain no command text or private fields",
		);
		check(
			!JSON.stringify(artifact).includes("undefined"),
			"projection has no invalid undefined fields",
		);

		const hugeConflict: TaskLifecycleEvent = {
			type: "merge.conflict",
			taskId: "projection-task",
			detail: { conflicts: ["x".repeat(10_000)] },
		};
		const projectedHuge = traceEventFromGateway(hugeConflict, "projection-run");
		check(
			JSON.stringify(projectedHuge).length <= TRACE_MAX_DETAIL_CHARS + 500,
			"gateway detail is bounded before collection",
		);

		const projectedEngineSettlement = traceEventFromGateway(
			{
				type: "task.completed",
				taskId: "projection-task",
				detail: { verdict: "ship", settlementSource: "engine_derived" },
			},
			"projection-run",
		);
		check(
			projectedEngineSettlement.detail?.settlementSource === "engine_derived",
			"trace projection preserves the canonical engine settlement source",
		);

		const projectedOversized = traceEventFromGateway(
			{
				type: "verify.completed",
				taskId: "projection-task",
				detail: {
					passed: false,
					evidence: {
						executedCount: MAX_VERIFICATION_COMMAND_SUMMARIES + 3,
						expectedCount: MAX_VERIFICATION_COMMAND_SUMMARIES + 3,
						omittedCount: 0,
						capped: false,
						commands: Array.from(
							{ length: MAX_VERIFICATION_COMMAND_SUMMARIES + 3 },
							(_, index) => ({
								index,
								digest: verificationCommandDigest(`hidden-${index}`),
								exitCode: 0,
								timedOut: false,
								durationMs: 1,
							}),
						),
					},
				},
			},
			"projection-run",
		);
		const projectedEvidence = projectedOversized.detail?.evidence as
			| { commands?: unknown[]; omittedCount?: number; capped?: boolean }
			| undefined;
		check(
			projectedEvidence?.commands?.length ===
				MAX_VERIFICATION_COMMAND_SUMMARIES &&
				projectedEvidence.omittedCount === 3 &&
				projectedEvidence.capped === true &&
				JSON.stringify(projectedOversized).length <=
					TRACE_MAX_DETAIL_CHARS + 500,
			"oversized verification evidence reports omitted summaries and stays bounded",
		);
	}

	const dir = mkdtempSync(join(tmpdir(), "core-v2-trace-"));
	try {
		// Same semantic input, including insertion-order differences, produces
		// byte-identical artifact output.
		const makeArtifact = (): ReturnType<TraceCollector["finish"]> => {
			const collector = new TraceCollector(
				"det-run",
				"det-task",
				() => "det-time",
			);
			collector.record({
				type: "task.queued",
				phase: "task",
				taskId: "det-task",
				detail: { z: 1, a: { y: 2, x: 3 } },
			});
			return collector.finish("ship");
		};
		const first = writeTraceArtifact(makeArtifact(), join(dir, "first"));
		const second = writeTraceArtifact(makeArtifact(), join(dir, "second"));
		check(first.ok && second.ok, "valid traces write successfully");
		if (first.ok && second.ok)
			check(
				readFileSync(first.path, "utf8") === readFileSync(second.path, "utf8"),
				"trace serialization is deterministic",
			);
		if (first.ok)
			check(
				JSON.parse(readFileSync(first.path, "utf8")).events[0].detail.a.x === 3,
				"written trace is valid JSON",
			);

		const invalidResult = writeTraceArtifact(
			{ runId: "bad", taskId: "bad", version: 999 } as never,
			join(dir, "invalid"),
		);
		check(
			!invalidResult.ok && invalidResult.error.length > 0,
			"schema failure returns typed failure",
		);
		check(
			!existsSync(join(dir, "invalid")),
			"schema failure does not claim delivery",
		);

		const atomicDir = join(dir, "atomic");
		mkdirSync(atomicDir, { recursive: true });
		mkdirSync(join(atomicDir, "det-run.trace.json"));
		const ioFailure = writeTraceArtifact(makeArtifact(), atomicDir);
		check(!ioFailure.ok, "rename failure returns typed failure");
		check(
			!existsSync(join(atomicDir, "det-run.trace.json.tmp")),
			"temporary trace is cleaned after atomic failure",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	if (errors.length > 0)
		throw new Error(`trace tests failed:\n  ${errors.join("\n  ")}`);
	console.log(
		"✓ trace: bounded validated events, usage identity, projection, deterministic atomic delivery",
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests()
		.then(() => process.exit(0))
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		});
}
