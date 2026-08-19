/**
 * Hermetic tests for the RunManifest assembly (metrics.ts) — pure functions,
 * no subprocess, no LLM, no fs. Covers hashSpec, generateRunId,
 * countByPriority, buildRunManifest (config defaults, cost summation,
 * pass-through of phases/totals), splitPhases, computeReadDuplication,
 * contextInheritedTokens, aggregateExecutePhase (R6 parallel aggregate), and
 * the storage functions.
 *
 * Run standalone: npx tsx extensions/task/test-metrics.ts
 */

import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	aggregateExecutePhase,
	buildRunManifest,
	hashSpec,
	generateRunId,
	buildFailureArtifact,
	writeFailureArtifact,
	countByPriority,
	splitPhases,
	computeReadDuplication,
	contextInheritedTokens,
	writeManifest,
	copySessionTraces,
	deriveProjectName,
	recentCompletions,
	summarizeRuns,
	renderTaskStats,
	formatDuration,
	runLatencyMs,
	type PhaseMetrics,
	type BuildManifestInput,
	type RunManifest,
	type FailureArtifact,
} from "./metrics.ts";
import type { Finding } from "./schemas/findings.ts";
import type { ReadRecord, WorkerResult, WorkerUsage } from "./worker.ts";

function phase(over: Partial<PhaseMetrics> = {}): PhaseMetrics {
	return {
		model: "m",
		turns: 1,
		tokens_in: 10,
		tokens_out: 5,
		reads: 1,
		edits: 0,
		duration_ms: 100,
		cost_usd: 0.01,
		...over,
	};
}

function finding(priority: "P0" | "P1" | "P2" | "P3"): Finding {
	return { id: "F", priority, confidence: 0.5, category: "x", file: "f", description: "d", verification: "v" };
}

function baseInput(over: Partial<BuildManifestInput> = {}): BuildManifestInput {
	return {
		specMarkdown: "## Goal\nG\n## Requirements\n- R1: x\n## Verification\n- true",
		requirements: 1,
		config: { prewalkModel: "pre/m", executeModel: "exe/m", reviewModel: "rev/m", reviewForked: false },
		phases: {
			prewalk: null,
			execute: phase({ cost_usd: 0.02 }),
			verify: { passed: true, commands: 1, duration_ms: 50, source: "worker-tree" },
			review: null,
			fixLoop: { iterations: 1, cost_usd: 0 },
		},
		durationMs: 1000,
		readDuplicationTokens: 0,
		runId: "test-run",
		...over,
	};
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// ─── hashSpec ───
	check(/^[0-9a-f]{12}$/.test(hashSpec("abc")), "hashSpec is 12 hex chars");
	check(hashSpec("abc") === hashSpec("abc"), "hashSpec is deterministic");
	check(hashSpec("abc") !== hashSpec("abd"), "different specs hash differently");

	// ─── generateRunId ───
	{
		const now = new Date(Date.UTC(2026, 7, 2, 17, 30));
		const id = generateRunId(now);
		check(/^\d{8}T\d{4}-[0-9a-f]{4}$/.test(id), `run id format, got ${id}`);
		check(id.startsWith("20260802T1730-"), `run id timestamp prefix from injected now, got ${id}`);
		check(generateRunId(now) !== id, "random suffix makes ids unique even for the same timestamp");
	}

	// ─── countByPriority ───
	{
		const counts = countByPriority([finding("P0"), finding("P1"), finding("P1"), finding("P2")]);
		check(counts.P0 === 1 && counts.P1 === 2 && counts.P2 === 1 && !("P3" in counts),
			`countByPriority wrong: ${JSON.stringify(counts)}`);
		check(Object.keys(countByPriority([])).length === 0, "empty findings → empty counts");
	}

	// ─── buildRunManifest: defaults + pass-through ───
	{
		const m = buildRunManifest(baseInput());
		check(m.run_id === "test-run", "run_id taken from input when provided");
		check(m.task.spec_hash === hashSpec(baseInput().specMarkdown), "spec_hash = hashSpec(spec)");
		check(m.task.requirements === 1, "task.requirements passed through");
		check(m.config.budget === "default", `budget defaults to 'default', got ${m.config.budget}`);
		check(m.config.swap_trigger === "first-edit", `swap_trigger defaults to 'first-edit', got ${m.config.swap_trigger}`);
		check(m.config.checklist === true, "checklist defaults to true");
		check(m.config.review_forked === false, "review_forked passed through");
		check(m.config.sandbox === false, "sandbox defaults to false when a direct caller omits it");
		check(m.config.prewalk_model === "pre/m" && m.config.execute_model === "exe/m" && m.config.review_model === "rev/m",
			"models passed through");
		check(m.phases.execute.cost_usd === 0.02 && m.phases.prewalk === null && m.phases.review === null,
			"phases passed through");
		check(m.totals.cost_usd === 0.02, `totals.cost_usd = execute only (0.02), got ${m.totals.cost_usd}`);
		check(m.totals.duration_ms === 1000, "totals.duration_ms passed through");
		check(m.totals.read_duplication_tokens === 0, "read_duplication_tokens passed through");
		check(Array.isArray(m.totals.session_files) && m.totals.session_files.length === 0, "session_files defaults to []");
		// R1/R2: new fields are ABSENT/ZERO when not supplied (backward compatible).
		check(m.received_at === undefined && m.dispatched_at === undefined && m.completed_at === undefined,
			"run-lifecycle timestamps absent when not supplied");
		check(m.main_session_tokens === 0, `main_session_tokens defaults to 0, got ${m.main_session_tokens}`);
		check(JSON.stringify(m.totals.files_changed) === "[]", `files_changed defaults to [], got ${JSON.stringify(m.totals.files_changed)}`);
		check(m.totals.insertions === 0 && m.totals.deletions === 0, "insertions/deletions default to 0");
		// JSON serialization drops the undefined timestamps (absent in the file).
		const serialized = JSON.parse(JSON.stringify(m)) as RunManifest;
		check(!("received_at" in serialized) && !("dispatched_at" in serialized) && !("completed_at" in serialized),
			"timestamps absent from serialized JSON when not supplied");
	}

	// ─── buildRunManifest: cost summation across all phases + overrides ───
	{
		const m = buildRunManifest(
			baseInput({
				config: {
					prewalkModel: "pre/m", executeModel: "exe/m", reviewModel: "rev/m", reviewForked: true,
					budget: "full", swapTrigger: "custom", checklist: false, sandbox: true,
				},
				phases: {
					prewalk: phase({ cost_usd: 0.01 }),
					execute: phase({ cost_usd: 0.02 }),
					verify: { passed: false, commands: 2, duration_ms: 75, source: "worker-tree" },
					review: {
						model: "rev/m", forked: true, context_inherited_tokens: 5000,
						findings: 3, by_priority: countByPriority([finding("P0"), finding("P1"), finding("P2")]),
						cost_usd: 0.03,
					},
					fixLoop: { iterations: 2, cost_usd: 0.04 },
				},
				readDuplicationTokens: 1234,
				sessionFiles: ["/tmp/s/worker-1.jsonl"],
			}),
		);
		check(Math.abs(m.totals.cost_usd - 0.1) < 1e-9, `totals.cost_usd sums all phases (0.10), got ${m.totals.cost_usd}`);
		check(m.config.budget === "full" && m.config.swap_trigger === "custom" && m.config.checklist === false,
			"config overrides respected");
		check(m.config.review_forked === true, "review_forked true");
		check(m.config.sandbox === true, "sandbox true passed through");
		check(m.phases.review?.by_priority.P0 === 1 && m.phases.review?.by_priority.P1 === 1 && m.phases.review?.by_priority.P2 === 1,
			"review by_priority preserved");
		check(m.phases.fix_loop.iterations === 2 && m.phases.fix_loop.cost_usd === 0.04, "fix_loop preserved");
		check(m.totals.read_duplication_tokens === 1234, "read_duplication_tokens preserved");
		check(m.totals.session_files.length === 1 && m.totals.session_files[0] === "/tmp/s/worker-1.jsonl",
			"session_files preserved");
	}

	// ─── buildRunManifest: R1 run-lifecycle fields pass through ───
	{
		const m = buildRunManifest(
			baseInput({
				receivedAt: "2026-08-05T00:00:00.000Z",
				dispatchedAt: "2026-08-05T00:00:05.000Z",
				completedAt: "2026-08-05T01:30:00.000Z",
				mainSessionTokens: 12345,
				filesChanged: ["a.ts", "b/c.ts"],
				insertions: 42,
				deletions: 7,
			}),
		);
		check(m.received_at === "2026-08-05T00:00:00.000Z" && m.dispatched_at === "2026-08-05T00:00:05.000Z"
			&& m.completed_at === "2026-08-05T01:30:00.000Z", "run-lifecycle timestamps pass through");
		check(m.main_session_tokens === 12345, `main_session_tokens pass through, got ${m.main_session_tokens}`);
		check(JSON.stringify(m.totals.files_changed) === JSON.stringify(["a.ts", "b/c.ts"]), "files_changed pass through");
		check(m.totals.insertions === 42 && m.totals.deletions === 7, "insertions/deletions pass through");
	}

	// ─── runLatencyMs (R4): wall-clock latency, worker-duration fallback ───
	{
		const mk = (over: Partial<RunManifest>): RunManifest => ({
			run_id: "r",
			config: { budget: "full", prewalk_model: "p", execute_model: "e", review_model: "r",
				swap_trigger: "first-edit", checklist: true, review_forked: false, sandbox: false },
			task: { spec_hash: "h", requirements: 1 },
			phases: {
				prewalk: null,
				execute: phase(),
				verify: { passed: true, commands: 1, duration_ms: 10, source: "worker-tree" },
				review: null,
				fix_loop: { iterations: 0, cost_usd: 0 },
			},
			totals: { cost_usd: 0, duration_ms: 1000, read_duplication_tokens: 0, session_files: [],
				files_changed: [], insertions: 0, deletions: 0 },
			...over,
		});
		const withTimestamps = mk({
			received_at: "2026-08-05T00:00:00.000Z",
			completed_at: "2026-08-05T00:01:30.000Z",
		});
		check(runLatencyMs(withTimestamps) === 90_000, `latency from timestamps (90s), got ${runLatencyMs(withTimestamps)}`);
		check(runLatencyMs(mk({})) === 1000, "no timestamps → totals.duration_ms fallback");
		const onlyReceived = mk({ received_at: "2026-08-05T00:00:00.000Z" });
		check(runLatencyMs(onlyReceived) === 1000, "received_at only → fallback (completed_at missing)");
		const inverted = mk({
			received_at: "2026-08-05T00:05:00.000Z",
			completed_at: "2026-08-05T00:00:00.000Z",
		});
		check(runLatencyMs(inverted) === 1000, "completed < received (inverted) → fallback");
		const unparseable = mk({ received_at: "not-a-date", completed_at: "also-not" });
		check(runLatencyMs(unparseable) === 1000, "unparseable timestamps → fallback");
	}

	// ─── splitPhases ───
	{
		const usage = (turns: number, tokensIn: number, cost: number, edits = 0): WorkerUsage => ({
			turns, tokens_in: tokensIn, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: cost, reads: 0, edits,
		});

		// No swap → prewalk null, everything in execute
		const noSwap = splitPhases({
			turnUsage: [usage(1, 100, 0.01), usage(2, 200, 0.02)],
			reads: [{ path: "a.ts", approxTokens: 50, turn: 1 }],
			swapTurn: null, prewalkModel: "pre/m", executeModel: "exe/m", totalDurationMs: 1000,
		});
		check(noSwap.prewalk === null, "no swap → prewalk null");
		check(noSwap.execute.model === "exe/m" && noSwap.execute.turns === 2 && noSwap.execute.tokens_in === 200,
			"no swap → execute carries everything");
		check(noSwap.execute.reads === 1, "no swap → execute reads = all reads");

		// Swap at turn 2 of 4 → prewalk = first 2 turns, execute = the rest
		const split = splitPhases({
			turnUsage: [usage(1, 100, 0.01), usage(2, 220, 0.02), usage(3, 340, 0.03), usage(4, 400, 0.04)],
			reads: [
				{ path: "shared.ts", approxTokens: 60, turn: 1 },
				{ path: "shared.ts", approxTokens: 60, turn: 3 },
				{ path: "only-exec.ts", approxTokens: 10, turn: 4 },
			],
			swapTurn: 2, prewalkModel: "pre/m", executeModel: "exe/m", totalDurationMs: 1000,
		});
		check(split.prewalk !== null && split.prewalk.model === "pre/m", "prewalk model");
		check(split.prewalk?.turns === 2 && split.prewalk.tokens_in === 220, `prewalk turns/tokens, got ${split.prewalk?.turns}/${split.prewalk?.tokens_in}`);
		check(split.prewalk?.reads === 1, `prewalk reads (turn <= 2), got ${split.prewalk?.reads}`);
		check(split.execute.model === "exe/m" && split.execute.turns === 2 && split.execute.tokens_in === 180,
			`execute turns/tokens (400-220), got ${split.execute.turns}/${split.execute.tokens_in}`);
		check(split.execute.reads === 2, `execute reads (turn > 2), got ${split.execute.reads}`);
		check(split.prewalk?.duration_ms === 500 && split.execute.duration_ms === 500, "durations split proportionally (2/4)");
		check(Math.abs((split.prewalk?.cost_usd ?? 0) - 0.02) < 1e-9, "prewalk cost from snapshot");
		check(Math.abs(split.execute.cost_usd - 0.02) < 1e-9, "execute cost = diff (0.04-0.02)");

		// Swap on the last turn → prewalk has the turn, execute zeroed
		const late = splitPhases({
			turnUsage: [usage(1, 50, 0, 1)],
			reads: [],
			swapTurn: 1, prewalkModel: "pre/m", executeModel: "exe/m", totalDurationMs: 100,
		});
		check(late.prewalk?.turns === 1 && late.prewalk.edits === 1, "swap on last turn → prewalk has the turn + edits");
		check(late.execute.turns === 0 && late.execute.tokens_in === 0 && late.execute.edits === 0, "execute zeroed");

		// No turns recorded → execute zeroed, prewalk null
		const empty = splitPhases({ turnUsage: [], reads: [], swapTurn: null, prewalkModel: "p", executeModel: "e", totalDurationMs: 0 });
		check(empty.prewalk === null && empty.execute.turns === 0, "no turns → zeroed execute");
	}

	// ─── computeReadDuplication ───
	{
		const dup = computeReadDuplication([
			{ path: "shared.ts", approxTokens: 100, turn: 1 },
			{ path: "unique.ts", approxTokens: 50, turn: 1 },
			{ path: "shared.ts", approxTokens: 100, turn: 4 },
			{ path: "shared.ts", approxTokens: 80, turn: 5 },
			{ path: "new.ts", approxTokens: 30, turn: 4 },
		], 2);
		check(dup.tokens === 180, `duplication tokens = execute re-reads of shared.ts (100+80), got ${dup.tokens}`);
		check(JSON.stringify(dup.files) === JSON.stringify(["shared.ts"]), `duplicated files, got ${JSON.stringify(dup.files)}`);
	}
	{
		const none = computeReadDuplication([{ path: "a.ts", approxTokens: 10, turn: 1 }], null);
		check(none.tokens === 0 && none.files.length === 0, "no swap → no duplication");
		const zero = computeReadDuplication([], 2);
		check(zero.tokens === 0 && zero.files.length === 0, "no reads → no duplication");
	}

	// ─── contextInheritedTokens ───
	{
		const usage = (turns: number, tokensIn: number): WorkerUsage => ({
			turns, tokens_in: tokensIn, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0, reads: 0, edits: 0,
		});
		check(contextInheritedTokens([]) === 0, "no turns → 0");
		check(contextInheritedTokens([usage(1, 500)]) === 500, "single turn → its input tokens");
		check(contextInheritedTokens([usage(1, 500), usage(2, 900)]) === 400, "final-turn input delta (900-500)");
	}

	// ─── storage (real fs on a temp dir) ───
	{
		const metricsDir = mkdtempSync(join(tmpdir(), "pi-task-metrics-"));
		try {
			const manifest = buildRunManifest(baseInput({ runId: "run-abc" }));
			const path = writeManifest(manifest, { metricsDir, project: "proj" });
			check(path.endsWith(join("proj", "run-abc.json")), `manifest path, got ${path}`);
			check(existsSync(path), "manifest file exists");
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as RunManifest;
			check(parsed.run_id === "run-abc" && parsed.task.requirements === 1, "written manifest round-trips");
			check(!existsSync(`${path}.tmp`), "no tmp file left after rename");
			// overwrite is atomic (rename over existing)
			writeManifest(manifest, { metricsDir, project: "proj" });
			check(existsSync(path), "overwrite works");
		} finally {
			rmSync(metricsDir, { recursive: true, force: true });
		}
	}
	{
		const metricsDir = mkdtempSync(join(tmpdir(), "pi-task-metrics-"));
		try {
			const src = join(metricsDir, "src-session.jsonl");
			writeFileSync(src, "{} \n{}\n", "utf-8");
			const saved = copySessionTraces({ metricsDir, project: "proj", runId: "run-abc", sources: [src], prefix: "worker" });
			check(saved.length === 1 && saved[0].endsWith(join("proj", "run-abc", "worker-1.jsonl")),
				`saved trace path, got ${JSON.stringify(saved)}`);
			check(existsSync(saved[0]) && readFileSync(saved[0], "utf-8") === "{} \n{}\n", "trace copied with content");
			const empty = copySessionTraces({ metricsDir, project: "proj", runId: "run-abc", sources: [], prefix: "review" });
			check(empty.length === 0, "no sources → nothing copied");
		} finally {
			rmSync(metricsDir, { recursive: true, force: true });
		}
	}
	{
		check(deriveProjectName("/tmp/myproj") === "myproj", "project from basename");
		check(deriveProjectName("/") === "unknown", "root → unknown");
	}

	// ─── aggregateExecutePhase (R6, parallel aggregate approximation) ───
	{
		const fakeWorker = (usage: Partial<WorkerUsage>): Pick<WorkerResult, "usage" | "reads"> => ({
			usage: {
				turns: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0,
				cost_usd: 0, reads: 0, edits: 0, ...usage,
			},
			reads: [],
		});

		// Two workers → per-field SUMS; duration_ms is the passed wall time.
		const agg = aggregateExecutePhase([
			fakeWorker({ turns: 2, tokens_in: 100, tokens_out: 50, cost_usd: 0.01, reads: 3, edits: 2 }),
			fakeWorker({ turns: 3, tokens_in: 200, tokens_out: 70, cost_usd: 0.02, reads: 1, edits: 4 }),
		], 500, "exe/m");
		check(agg.turns === 5, `turns summed (2+3), got ${agg.turns}`);
		check(agg.tokens_in === 300 && agg.tokens_out === 120, `tokens summed, got ${agg.tokens_in}/${agg.tokens_out}`);
		check(Math.abs(agg.cost_usd - 0.03) < 1e-9, `cost summed (0.01+0.02), got ${agg.cost_usd}`);
		check(agg.reads === 4 && agg.edits === 6, `reads/edits summed, got ${agg.reads}/${agg.edits}`);
		check(agg.duration_ms === 500, "duration_ms = parallel phase WALL time (not worker durations summed)");
		check(agg.model === "exe/m", "aggregate carries the execute model");

		// No workers → zeroed phase (still a valid PhaseMetrics).
		const empty = aggregateExecutePhase([], 0, "exe/m");
		check(empty.turns === 0 && empty.tokens_in === 0 && empty.tokens_out === 0,
			"empty workers → zeroed tokens/turns");
		check(empty.cost_usd === 0 && empty.reads === 0 && empty.edits === 0, "empty workers → zeroed cost/reads/edits");
		check(empty.duration_ms === 0 && empty.model === "exe/m", "empty workers → duration 0, model kept");

		// Reads are counted via usage.reads (the count field), not per-file.
		const readsAgg = aggregateExecutePhase([fakeWorker({ reads: 7 })], 10, "m");
		check(readsAgg.reads === 7, "reads count from usage.reads");
	}

	// ─── failure artifacts (todo #86) ───────────────────────────
	// buildFailureArtifact: run_id + timestamp + the failure fields.
	{
		const now = new Date("2026-08-05T00:00:00.000Z");
		const artifact = buildFailureArtifact({
			kind: "worker",
			now,
			specHash: "abc123",
			tier: "economy",
			cause: "no progress",
			turns: 47,
			idleMs: 540_000,
			lastTool: { name: "bash", args: "{command: x}" },
			stderrTail: "err",
		});
		check(artifact.kind === "worker" && artifact.cause === "no progress" && artifact.turns === 47,
			"artifact carries the failure fields");
		check(artifact.run_id.startsWith("20260805T0000"), `run_id from now, got ${artifact.run_id}`);
		check(artifact.timestamp === "2026-08-05T00:00:00.000Z", "timestamp ISO");
		check(artifact.last_tool?.name === "bash" && artifact.stderr_tail === "err", "last tool + stderr tail land");
	}
	// buildFailureArtifact: an INJECTED run_id (detached dispatch — the caller
	// knows the id before the run dies) wins over the generated one.
	{
		const now = new Date("2026-08-05T00:00:00.000Z");
		const injected = buildFailureArtifact({ kind: "worker", now, runId: "20260805T0000-feed", cause: "x" });
		check(injected.run_id === "20260805T0000-feed", `injected run_id wins, got ${injected.run_id}`);
		const generated = buildFailureArtifact({ kind: "worker", now, cause: "x" });
		check(generated.run_id !== "20260805T0000-feed" && generated.run_id.startsWith("20260805T0000"),
			"absent runId still generates from now");
	}
	// writeFailureArtifact: atomic write + round-trip on a temp dir.
	{
		const metricsDir = mkdtempSync(join(tmpdir(), "pi-task-fail-"));
		try {
			const artifact = buildFailureArtifact({ kind: "review", cause: "timed out", turns: 2 });
			const path = writeFailureArtifact(artifact, { metricsDir, project: "proj" });
			check(path.endsWith(join("proj", `${artifact.run_id}.failure.json`)), `artifact path, got ${path}`);
			check(existsSync(path), "artifact file exists");
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as FailureArtifact;
			check(parsed.kind === "review" && parsed.cause === "timed out", "written artifact round-trips");
			check(!existsSync(`${path}.tmp`), "no tmp file left after rename");
		} finally {
			rmSync(metricsDir, { recursive: true, force: true });
		}
	}

	// summarizeRuns + renderTaskStats: consume manifests on disk.
	{
		const metricsDir = mkdtempSync(join(tmpdir(), "pi-task-sum-"));
		try {
			const manifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
				run_id: "20260805T0000-abcd",
				config: { budget: "full" },
				task: { spec_hash: "abc", requirements: 2 },
				phases: {
					prewalk: null,
					execute: { model: "m", turns: 1, tokens_in: 1, tokens_out: 1, reads: 0, edits: 0, duration_ms: 1000, cost_usd: 0.01 },
					verify: { passed: true, commands: 1, duration_ms: 100, source: "worker-tree" },
					review: null,
					fix_loop: { iterations: 0, cost_usd: 0 },
				},
				totals: { cost_usd: 0.01, duration_ms: 1100, read_duplication_tokens: 0, session_files: [] },
				...over,
			});
			const write = (project: string, m: Record<string, unknown>): void => {
				const dir = join(metricsDir, project);
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, `${m.run_id}.json`), JSON.stringify(m), "utf-8");
			};

			// alpha: pass (full, 60s, $0.02) + fail (120s, $0.03) + abort artifact + garbage file.
			write("alpha", manifest({ run_id: "20260805T0001-abcd", config: { budget: "full" }, totals: { cost_usd: 0.02, duration_ms: 60000 } }));
			write("alpha", manifest({
				run_id: "20260805T0002-abcd",
				config: { budget: "full" },
				phases: { verify: { passed: false, commands: 1, duration_ms: 100, source: "worker-tree" } },
				totals: { cost_usd: 0.03, duration_ms: 120000 },
			}));
			writeFileSync(join(metricsDir, "alpha", "20260805T0003-abcd.failure.json"), "{}", "utf-8");
			writeFileSync(join(metricsDir, "alpha", "garbage.json"), "{not json", "utf-8");
			// Detached-dispatch sidecars (request input + live heartbeat) are NOT
			// runs: summarizeRuns must skip them silently — not as unreadable.
			writeFileSync(join(metricsDir, "alpha", "20260805T0005-abcd.request.json"), "{}", "utf-8");
			writeFileSync(join(metricsDir, "alpha", "20260805T0005-abcd.live.json"), "{}", "utf-8");
			writeFileSync(join(metricsDir, "alpha", "20260805T0005-abcd.log"), "log\n", "utf-8");
			// beta: pass (economy, 30s, $0.01).
			write("beta", manifest({ run_id: "20260805T0004-abcd", config: { budget: "economy" }, totals: { cost_usd: 0.01, duration_ms: 30000 } }));

			const s = summarizeRuns(metricsDir);
			check(s.count === 3, `count, got ${s.count}`);
			check(s.passed === 2, `passed, got ${s.passed}`);
			check(s.failures === 1, `failure artifacts, got ${s.failures}`);
			check(s.unreadable === 1, `unreadable manifests, got ${s.unreadable}`);
			check(Math.abs(s.totalCostUsd - 0.06) < 1e-9, `total cost, got ${s.totalCostUsd}`);
			check(s.p50DurationMs === 60000, `p50, got ${s.p50DurationMs}`);
			check(s.p90DurationMs === 120000, `p90, got ${s.p90DurationMs}`);
			check(s.byTier.full?.count === 2 && Math.abs(s.byTier.full.costUsd - 0.05) < 1e-9, "byTier full rollup");
			check(s.byTier.economy?.count === 1, "byTier economy rollup");
			check(s.byProject.alpha?.count === 2 && s.byProject.beta?.count === 1, "byProject rollup");
			check(s.rows[0].runId === "20260805T0001-abcd" && s.rows[2].runId === "20260805T0004-abcd", "rows sorted by run id");

			const filtered = summarizeRuns(metricsDir, "alpha");
			check(filtered.count === 2 && filtered.byProject.alpha?.count === 2 && !("beta" in filtered.byProject),
				"project filter narrows the summary");

			const lines = renderTaskStats(s);
			const joined = lines.join("\n");
			check(lines[0].includes("3 total") && lines[0].includes("2/3 verified") && lines[0].includes("1 aborted"),
				`headline: ${lines[0]}`);
			check(joined.includes("by tier: full 2") && joined.includes("by project: alpha 2"), "rollup lines");
			check(joined.includes("✓") && joined.includes("✗"), "pass/fail glyphs in recent rows");
			check(joined.includes("1 unreadable manifest"), "unreadable note");

			const empty = renderTaskStats(summarizeRuns(join(metricsDir, "nonexistent")));
			check(empty.some((l) => l.includes("no task runs recorded yet")), "empty summary message");
		} finally {
			rmSync(metricsDir, { recursive: true, force: true });
		}
	}

	// summarizeRuns/renderTaskStats latency (R4): manifests WITH the wall-clock
	// timestamps report completed_at − received_at; the headline p50/p90 and
	// recent-run durations use it. Manifests without timestamps fall back to
	// totals.duration_ms.
	{
		const metricsDir = mkdtempSync(join(tmpdir(), "pi-task-lat-"));
		try {
			const manifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
				run_id: "20260805T0000-abcd",
				config: { budget: "full" },
				task: { spec_hash: "abc", requirements: 2 },
				phases: {
					prewalk: null,
					execute: { model: "m", turns: 1, tokens_in: 1, tokens_out: 1, reads: 0, edits: 0, duration_ms: 1000, cost_usd: 0.01 },
					verify: { passed: true, commands: 1, duration_ms: 100, source: "worker-tree" },
					review: null,
					fix_loop: { iterations: 0, cost_usd: 0 },
				},
				totals: { cost_usd: 0.01, duration_ms: 1000, read_duplication_tokens: 0, session_files: [] },
				...over,
			});
			const write = (runId: string, m: Record<string, unknown>): void => {
				const dir = join(metricsDir, "proj");
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, `${runId}.json`), JSON.stringify(m), "utf-8");
			};
			// With timestamps: worker duration 10s, wall latency 2m30s (150s).
			write("20260805T0001-abcd", manifest({
				run_id: "20260805T0001-abcd",
				received_at: "2026-08-05T00:00:00.000Z",
				dispatched_at: "2026-08-05T00:00:01.000Z",
				completed_at: "2026-08-05T00:02:30.000Z",
				totals: { cost_usd: 0.01, duration_ms: 10000, read_duplication_tokens: 0, session_files: [] },
			}));
			// No timestamps: falls back to totals.duration_ms (45s).
			write("20260805T0002-abcd", manifest({
				run_id: "20260805T0002-abcd",
				totals: { cost_usd: 0.01, duration_ms: 45000, read_duplication_tokens: 0, session_files: [] },
			}));

			const s = summarizeRuns(metricsDir);
			check(s.rows[0].durationMs === 150_000, `latency from timestamps (150s), got ${s.rows[0].durationMs}`);
			check(s.rows[1].durationMs === 45_000, `fallback to totals.duration_ms (45s), got ${s.rows[1].durationMs}`);
			// p50/p90 (sorted [45000, 150000]): both come from the latency values.
			check(s.p50DurationMs === 45_000, `p50 uses latency/fallback, got ${s.p50DurationMs}`);
			check(s.p90DurationMs === 150_000, `p90 uses latency, got ${s.p90DurationMs}`);
			const lines = renderTaskStats(s);
			check(lines[0].includes("p50 45s · p90 2m30s"), `headline uses latency: ${lines[0]}`);
		} finally {
			rmSync(metricsDir, { recursive: true, force: true });
		}
	}

	// formatDuration: compact human durations.
	{
		check(formatDuration(42000) === "42s", `42s, got ${formatDuration(42000)}`);
		check(formatDuration(432000) === "7m12s", `7m12s, got ${formatDuration(432000)}`);
		check(formatDuration(3723000) === "1h2m", `1h2m, got ${formatDuration(3723000)}`);
		check(formatDuration(0) === "0s", `0s, got ${formatDuration(0)}`);
	}

	if (errors.length > 0) {
		throw new Error("test-metrics failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	
// ─── recentCompletions: derived from manifests + failure artifacts (M3) ───
async function testRecentCompletions(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const metricsDir = mkdtempSync(join(tmpdir(), "pi-task-recent-"));
	try {
		// Completed manifest (with channel) + a failure artifact.
		const proj = join(metricsDir, "demo");
		mkdirSync(proj, { recursive: true });
		const now = Date.now();
		const manifest = {
			run_id: "run1", config: { channel: "flex" }, phases: {}, totals: {},
		};
		const mtime = new Date(now - 60_000);
		const write = (name: string, body: string): void => {
			const path = join(proj, name);
			writeFileSync(path, body, "utf-8");
			try { const s = statSync(path); /* touch */ } catch { /* ignore */ }
		};
		write("run1.json", JSON.stringify(manifest));
		write("run2.failure.json", "{}");
		write("garbage.json", "{not json");

		const recent = recentCompletions(metricsDir, 5);
		check(recent.length === 2, `derived 2 completions, got ${recent.length}`);
		check(recent[0].status === "failed" && recent[0].project === "demo" && recent[0].runId === "run2",
			"failure artifact surfaces as a failed completion");
		const done = recent.find((c) => c.runId === "run1");
		check(done?.status === "completed" && done?.channel === "flex", `manifest channel surfaces, got ${JSON.stringify(done)}`);
		// limit + empty
		check(recentCompletions(metricsDir, 1).length === 1, "limit respected");
		check(recentCompletions(join(metricsDir, "nope")).length === 0, "missing dir → empty");
	} finally {
		rmSync(metricsDir, { recursive: true, force: true });
	}
	console.log("✓ recentCompletions: manifests + failures derived, channel surfaced (M3)");
}
await testRecentCompletions(errors);
console.log("✓ metrics: hashSpec, generateRunId, countByPriority, buildRunManifest, phase split, aggregation, duplication, storage");
}

// Direct execution support: `npx tsx extensions/task/test-metrics.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
