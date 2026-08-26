/**
 * Batch lane hermetic tests (M2) — zero LLM, zero network.
 *
 * Covers: output-contract validation (incl. code-fence stripping),
 * spec → item building, file extraction + path safety + conflict
 * detection, job-state persistence round-trips, the FakeBatchProvider
 * submit → poll → collect round-trip through runBatchLane (typed
 * failures: submit_failed, job_failed, poll_timeout, aborted,
 * items_incomplete), the OpenRouter wire protocol against a mock fetch
 * (request shape + JSONL results mapping — never the real endpoint), the
 * orchestrator's pure channel routing (routeRun), and a real-jj
 * executeTask run on the batch channel with the fake provider (files
 * applied, AI-authored commit, verification gate, manifest + job state
 * persisted, working copy restored). The REAL OpenRouter call lives in
 * test-batch-live.ts (guarded, network + cost — never imported here).
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseSpec } from "./schemas/spec.ts";
import {
	BatchError,
	FakeBatchProvider,
	OpenRouterBatchProvider,
	batchJobStatePath,
	buildBatchItems,
	buildBatchPrompt,
	extractBatchFiles,
	incompleteItems,
	mergeBatchFiles,
	readBatchJobState,
	requirementId,
	resumeBatchJob,
	runBatchLane,
	stripCodeFences,
	validateBatchOutput,
	writeBatchJobState,
	type BatchJobState,
	type BatchOutputContract,
} from "./batch.ts";
import { executeTask, routeRun, type TaskResult } from "./orchestrator.ts";
import { DEFAULT_TASK_SHAPES, type TaskShape } from "./config.ts";
import type { Spec } from "./schemas/spec.ts";

const SPEC = `## Goal
Create a file hello.txt containing the text "hi".

## Requirements
- R1: Create hello.txt with content "hi"
- R2: Commit the change with jj using the message "add hello.txt"

## Verification
- test -f hello.txt && grep -q hi hello.txt
`;

// ─── Helpers ─────────────────────────────────────────────────────────

/** Child env for jj: deterministic and hermetic (same pattern as
 *  test-workspace.ts). */
function jjEnv(): Record<string, string> {
	const env: Record<string, string> = { ...process.env, JJ_EDITOR: "true" };
	delete env.JJ_CONFIG;
	return env;
}

function jj(args: string[], cwd: string): string {
	return execFileSync("jj", args, {
		cwd,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
		env: jjEnv(),
	});
}

/** A real jj repo with a committed README (Test User identity). */
function initRepo(dir: string): void {
	jj(
		[
			"--config",
			'user.name="Test User"',
			"--config",
			'user.email="user@test.dev"',
			"git",
			"init",
			"--colocate",
		],
		dir,
	);
	jj(["config", "set", "--repo", "user.name", "Test User"], dir);
	jj(["config", "set", "--repo", "user.email", "user@test.dev"], dir);
	writeFileSync(join(dir, "README.md"), "# Test repo\n", "utf-8");
	jj(["commit", "-m", "init"], dir);
}

/** The batch channel shape (the built-in one). */
const BATCH_SHAPE: TaskShape = DEFAULT_TASK_SHAPES.batch!;

function specWith(requirements: string, verification: string): Spec {
	return parseSpec(
		`## Goal\nG\n## Requirements\n${requirements}\n## Verification\n- ${verification}\n`,
	);
}

const noSleep = (): Promise<void> => Promise.resolve();

/** The newest job-state file for a project dir (the run id is generated
 *  inside the lane — the test finds the file by scanning). */
function latestBatchState(
	metricsDir: string,
	project: string,
): BatchJobState | null {
	const projDir = join(metricsDir, project);
	if (!existsSync(projDir)) return null;
	const files = readdirSync(projDir)
		.filter((n) => n.endsWith(".batch.json"))
		.sort();
	if (files.length === 0) return null;
	const last = files[files.length - 1];
	if (!last) return null;
	return JSON.parse(
		readFileSync(join(projDir, last), "utf-8"),
	) as BatchJobState;
}

// ─── Contract validation (pure) ─────────────────────────────────────

function testContracts(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// stripCodeFences: ```json fences and bare fences removed; plain text
	// passes through.
	check(
		stripCodeFences('```json\n{"a": 1}\n```') === '{"a": 1}',
		"json fence stripped",
	);
	check(stripCodeFences("```\nplain\n```") === "plain", "bare fence stripped");
	check(
		stripCodeFences("  plain text  ") === "plain text",
		"plain text trimmed only",
	);

	// text contract: non-empty passes, empty fails.
	check(
		validateBatchOutput({ kind: "text" }, "hello").ok === true,
		"text contract accepts non-empty",
	);
	check(
		validateBatchOutput({ kind: "text" }, "   ").ok === false,
		"text contract rejects blank",
	);

	// json contract: any parseable JSON passes.
	check(
		validateBatchOutput({ kind: "json" }, "[1, 2]").ok === true,
		"json contract accepts arrays",
	);
	check(
		validateBatchOutput({ kind: "json" }, "not json").ok === false,
		"json contract rejects malformed",
	);
	const fenced = validateBatchOutput(
		{ kind: "json" },
		'```json\n{"ok": true}\n```',
	);
	check(
		fenced.ok === true && (fenced as { value: unknown }).value !== undefined,
		"json contract accepts fenced output",
	);

	// json_object contract: object + required keys; arrays and scalars fail.
	const obj: BatchOutputContract = {
		kind: "json_object",
		requiredKeys: ["a", "b"],
	};
	check(
		validateBatchOutput(obj, '{"a": 1, "b": 2}').ok === true,
		"json_object accepts a complete object",
	);
	const missing = validateBatchOutput(obj, '{"a": 1}');
	check(
		missing.ok === false && (missing as { error: string }).error.includes("b"),
		`json_object rejects missing keys (${(missing as { error: string }).error})`,
	);
	check(
		validateBatchOutput(obj, "[1, 2]").ok === false,
		"json_object rejects arrays",
	);
	check(
		validateBatchOutput(obj, '"str"').ok === false,
		"json_object rejects scalars",
	);
	check(
		validateBatchOutput({ kind: "json_object" }, "{}").ok === true,
		"json_object without requiredKeys accepts any object",
	);

	console.log(
		"✓ batch contracts: fence stripping + text/json/json_object validation",
	);
}

// ─── Item building + file outputs (pure) ────────────────────────────

function testItemBuilding(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// requirementId: "R1: ..." → "R1"; "1. ..." → req-<index>; "R12." → "R12".
	check(
		requirementId("R1: create x", 0) === "R1",
		`requirementId R1, got ${requirementId("R1: create x", 0)}`,
	);
	check(requirementId("R12. do y", 1) === "R12", "requirementId R12");
	check(
		requirementId("1. do y", 0) === "req-1",
		"requirementId falls back to req-<index>",
	);

	// buildBatchPrompt: self-contained single-turn with the output contract.
	const prompt = buildBatchPrompt("Create x.", "R1: create x");
	check(
		prompt.includes("## Goal") && prompt.includes("Create x."),
		"prompt carries the goal",
	);
	check(
		prompt.includes("## Requirement") && prompt.includes("R1: create x"),
		"prompt carries the requirement",
	);
	check(
		prompt.includes("Output contract") &&
			prompt.includes('"files"') &&
			prompt.includes("single JSON object"),
		"prompt embeds the typed output contract",
	);
	check(
		prompt.includes("no tools") && prompt.includes("single-turn"),
		"prompt declares single-turn/no-tools",
	);

	// buildBatchItems: one item per requirement, customId = the R-id,
	// contract = the coding files contract.
	const items = buildBatchItems(specWith("- R1: one\n- R2: two", "true"));
	check(items.length === 2, `one item per requirement, got ${items.length}`);
	const item0 = items[0];
	const item1 = items[1];
	if (!item0 || !item1)
		throw new Error("buildBatchItems must return one item per requirement");
	check(
		item0.customId === "R1" && item1.customId === "R2",
		"customIds are the R-ids",
	);
	check(
		items.every(
			(i) => i.contract.kind === "json_object" && i.prompt.length > 0,
		),
		"every item carries the files contract + a prompt",
	);

	// extractBatchFiles: valid files; path safety enforced mechanically.
	const ok = extractBatchFiles(
		{
			requirement: "R1",
			files: [{ path: "a/b.txt", content: "hi" }],
			summary: "s",
		},
		"R1",
	);
	check(
		ok.length === 1 && ok[0]?.path === "a/b.txt" && ok[0]?.content === "hi",
		"valid files extracted",
	);
	const bad = (value: unknown, needle: string): boolean => {
		try {
			extractBatchFiles(value, "R1");
			return false;
		} catch (err) {
			return (
				err instanceof BatchError &&
				err.code === "invalid_output" &&
				err.message.includes(needle)
			);
		}
	};
	check(bad("nope", "not a JSON object"), "non-object output rejected");
	check(bad({}, "files"), "missing files key rejected");
	check(
		bad(
			{ files: [{ path: "/etc/passwd", content: "x" }] },
			"not repo-relative",
		),
		"absolute path rejected",
	);
	check(
		bad({ files: [{ path: "../x.txt", content: "x" }] }, "escapes the repo"),
		".. path rejected",
	);
	check(
		bad({ files: [{ path: "a/../x.txt", content: "x" }] }, "escapes the repo"),
		"embedded .. rejected",
	);
	check(
		bad({ files: [{ path: "C:\\x.txt", content: "x" }] }, "not repo-relative"),
		"windows drive rejected",
	);
	check(
		bad({ files: [{ path: "a\\b.txt", content: "x" }] }, "not repo-relative"),
		"backslash rejected",
	);
	check(
		bad(
			{ files: [{ path: "", content: "x" }] },
			"path must be a non-empty string",
		),
		"empty path rejected",
	);
	check(
		bad({ files: [{ path: "a.txt", content: 7 }] }, "content must be a string"),
		"non-string content rejected",
	);
	check(
		bad({ files: [{ path: "a.txt" }] }, "content must be a string"),
		"missing content rejected",
	);

	// mergeBatchFiles: union with deterministic conflict rejection.
	const merged = mergeBatchFiles([
		{ customId: "R1", files: [{ path: "a.txt", content: "1" }] },
		{
			customId: "R2",
			files: [
				{ path: "b.txt", content: "2" },
				{ path: "a.txt", content: "1" },
			],
		},
	]);
	check(
		merged.length === 2,
		`union dedupes identical duplicates, got ${merged.length}`,
	);
	let conflict = false;
	try {
		mergeBatchFiles([
			{ customId: "R1", files: [{ path: "a.txt", content: "1" }] },
			{ customId: "R2", files: [{ path: "a.txt", content: "2" }] },
		]);
	} catch (err) {
		conflict =
			err instanceof BatchError &&
			err.code === "invalid_output" &&
			err.message.includes("R1") &&
			err.message.includes("R2");
	}
	check(
		conflict,
		"conflicting duplicate paths are a typed error (never silent last-wins)",
	);

	console.log(
		"✓ batch item building: R-ids, single-turn prompts, file extraction + path safety",
	);
}

// ─── Job-state persistence ──────────────────────────────────────────

function testJobState(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-task-batch-state-"));
	try {
		const state: BatchJobState = {
			kind: "batch-job",
			schema: 1,
			run_id: "run-1",
			job_id: "job-1",
			model: "m",
			provider: "fake",
			status: "in_progress",
			submitted_at: new Date(0).toISOString(),
			updated_at: new Date(0).toISOString(),
			prompts: [
				{
					custom_id: "R1",
					prompt: "p",
					contract: { kind: "json_object", requiredKeys: ["files"] },
				},
			],
			items: [
				{ custom_id: "R1", status: "completed", output: "{}" },
				{ custom_id: "R2", status: "invalid", error: "missing key" },
			],
		};
		const written = readBatchJobState(dir, "proj", "run-1");
		check(written === null, "missing state file reads as null");

		// Round-trip through the metrics-dir path.
		const path = writeBatchJobState(state, {
			metricsDir: dir,
			project: "proj",
		});
		check(
			path === batchJobStatePath(dir, "proj", "run-1"),
			"state path matches <metricsDir>/<project>/<run>.batch.json",
		);
		const back = readBatchJobState(dir, "proj", "run-1");
		check(
			back !== null &&
				back.job_id === "job-1" &&
				back.status === "in_progress" &&
				back.items.length === 2 &&
				back.prompts[0]?.custom_id === "R1",
			"state file round-trips (job id, prompts, per-item status)",
		);
		check(
			back!.items[1]?.status === "invalid" &&
				back!.items[1]?.error === "missing key",
			"per-item failure details survive the round-trip",
		);

		// incompleteItems: the recoverable subset.
		check(
			incompleteItems(state).length === 1 &&
				incompleteItems(state)[0]?.custom_id === "R2",
			"incompleteItems names the recoverable subset",
		);
		check(
			incompleteItems({
				...state,
				items: [{ custom_id: "R1", status: "completed" }],
			}).length === 0,
			"incompleteItems is empty for a green job",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log(
		"✓ batch job state: <metricsDir>/<project>/<run>.batch.json round-trip + recoverable subset",
	);
}

// ─── Lane round-trip with the fake provider ─────────────────────────

async function testLaneRoundTrip(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-task-batch-lane-"));
	try {
		const spec = specWith("- R1: one\n- R2: two", "true");
		const provider = new FakeBatchProvider({
			outputs: {
				R1: JSON.stringify({
					requirement: "R1",
					files: [{ path: "a.txt", content: "1" }],
					summary: "a",
				}),
				R2: JSON.stringify({ requirement: "R2", files: [], summary: "b" }),
			},
		});
		const events: string[] = [];
		const lane = await runBatchLane({
			spec,
			model: "fake/batch",
			provider,
			pollIntervalMs: 1,
			metricsDir: dir,
			project: "proj",
			sleep: noSleep,
			onUpdate: (e) => events.push(e.type),
		});
		check(
			provider.submitCalls === 1 && provider.jobId === "fake-batch-1",
			"one submit with the fake job id",
		);
		check(lane.jobId === "fake-batch-1", "lane carries the provider job id");
		check(
			lane.items.length === 2 &&
				lane.items.every((i) => i.status === "completed"),
			"all items completed on a green lane",
		);
		check(
			lane.outputs.R1 !== undefined &&
				(lane.outputs.R1 as { files: unknown[] }).files.length === 1,
			"validated parsed outputs keyed by customId",
		);
		check(
			lane.usage.prompt_tokens === 20 &&
				lane.usage.completion_tokens === 10 &&
				lane.usage.cost_usd === 0.0002,
			`usage aggregates across items, got ${JSON.stringify(lane.usage)}`,
		);
		check(
			events.includes("batch_submitted") &&
				events.includes("batch_status") &&
				events.includes("batch_collected"),
			`lane events flow (${events.join(",")})`,
		);
		check(
			provider.pollCalls >= 2,
			`fake polls advance in_progress → completed, got ${provider.pollCalls} polls`,
		);

		// Job state persisted: job id + prompts + per-item status.
		const state = readBatchJobState(dir, "proj", lane.runId);
		check(
			state !== null &&
				state.status === "completed" &&
				state.job_id === "fake-batch-1" &&
				state.items.length === 2 &&
				state.items[0]?.status === "completed",
			"job state file records the completed job",
		);
		check(
			state!.prompts.length === 2 &&
				state!.prompts[0]?.custom_id === "R1" &&
				state!.prompts[0]?.prompt.includes("Output contract"),
			"job state records the submitted prompts + contracts",
		);
		check(
			state!.usage !== undefined && state!.usage.cost_usd === 0.0002,
			"job state records aggregate usage",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log(
		"✓ fake provider round-trip: submit → poll → collect → validated outputs + persisted state",
	);
}

// ─── Recovery: resume an existing job + resubmit the failed subset (P2) ──

async function testBatchRecovery(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-task-batch-rec-"));
	try {
		const spec = specWith("- R1: one\n- R2: two", "true");
		const out = (req: string) =>
			JSON.stringify({
				requirement: req,
				files: [{ path: req + ".txt", content: "1" }],
				summary: req,
			});
		// 1. existingJobId resumes the SAME provider job on the same provider
		//    (a full re-run would double-spend the same work): the first run
		//    submits once; re-running with existingJobId must NOT submit again.
		{
			const provider = new FakeBatchProvider({
				outputs: { R1: out("R1"), R2: out("R2") },
			});
			await runBatchLane({
				spec,
				model: "fake/batch",
				provider,
				pollIntervalMs: 1,
				sleep: noSleep,
			});
			check(provider.submitCalls === 1, "first run submits once");
			const lane = await runBatchLane({
				spec,
				model: "fake/batch",
				provider,
				pollIntervalMs: 1,
				sleep: noSleep,
				existingJobId: provider.jobId!,
			});
			check(
				provider.submitCalls === 1,
				`resume must not re-submit, got ${provider.submitCalls} submits`,
			);
			check(
				lane.jobId === provider.jobId,
				"resume reuses the existing provider job id",
			);
			check(
				lane.items.length === 2 &&
					lane.items.every((i) => i.status === "completed"),
				"resumed job collects to terminal state",
			);
		}
		// 2. resumeBatchJob reads the persisted state + resumes that job id.
		{
			const metricsDir = join(dir, "results");
			const provider = new FakeBatchProvider({
				outputs: { R1: out("R1"), R2: out("R2") },
			});
			const first = await runBatchLane({
				spec,
				model: "fake/batch",
				provider,
				pollIntervalMs: 1,
				sleep: noSleep,
				metricsDir,
				project: "p",
			});
			const beforeSubmit = provider.submitCalls;
			const resumed = await resumeBatchJob({
				metricsDir,
				project: "p",
				runId: first.runId,
				spec,
				model: "fake/batch",
				provider,
				pollIntervalMs: 1,
				sleep: noSleep,
			});
			check(
				provider.submitCalls === beforeSubmit,
				"resumeBatchJob re-drives the same job, no re-submit",
			);
			check(
				resumed.jobId === first.jobId && resumed.items.length === 2,
				"resumeBatchJob reuses the persisted provider job id",
			);
		}
		// 3. resubmitCustomIds re-submits ONLY the failed set (no re-send of
		//    the whole batch).
		{
			const provider = new FakeBatchProvider({ outputs: { R2: out("R2") } });
			const lane = await runBatchLane({
				spec,
				model: "fake/batch",
				provider,
				pollIntervalMs: 1,
				sleep: noSleep,
				resubmitCustomIds: ["R2"],
			});
			check(
				provider.submitCalls === 1 &&
					lane.items.length === 1 &&
					lane.items[0]?.custom_id === "R2",
				"resubmit only the failed items, got " + lane.items.length,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log(
		"✓ batch recovery: resume existing job + resubmit failed subset (P2)",
	);
}

// ─── Typed lane failures ────────────────────────────────────────────

async function testLaneFailures(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-task-batch-fail-"));
	const spec = specWith("- R1: one", "true");
	const run = async (
		provider: FakeBatchProvider,
		extra: Record<string, unknown> = {},
	): Promise<unknown> => {
		try {
			return await runBatchLane({
				spec,
				model: "fake/batch",
				provider,
				pollIntervalMs: 1,
				metricsDir: dir,
				project: "proj",
				sleep: noSleep,
				...extra,
			});
		} catch (err) {
			return err;
		}
	};
	try {
		// Contract violation: unparseable output → typed items_incomplete,
		// item status "invalid" (raw output preserved), state status failed.
		const invalid = await run(
			new FakeBatchProvider({ outputs: { R1: "not json at all" } }),
		);
		check(
			invalid instanceof BatchError && invalid.code === "items_incomplete",
			"contract violation → BatchError items_incomplete",
		);
		check(
			(invalid as BatchError).detail?.items?.length === 1 &&
				(invalid as BatchError).detail?.items?.[0]?.custom_id === "R1" &&
				(invalid as BatchError).detail?.items?.[0]?.status === "invalid",
			"detail.items names the failed item + status",
		);
		const invalidState = latestBatchState(dir, "proj");
		check(
			invalidState !== null &&
				invalidState.status === "failed" &&
				invalidState.items[0]?.status === "invalid" &&
				invalidState.items[0]?.output === "not json at all" &&
				invalidState.items[0]?.error !== undefined,
			"job state records the invalid item + raw output (recoverable)",
		);
		check(
			invalidState!.job_id === "fake-batch-1",
			"job state keeps the job id for the failed items",
		);

		// Provider-level item failure → status "failed".
		const failed = await run(
			new FakeBatchProvider({ itemErrors: { R1: "provider exploded" } }),
		);
		check(
			failed instanceof BatchError &&
				failed.code === "items_incomplete" &&
				failed.detail?.items?.[0]?.status === "failed" &&
				failed.detail?.items?.[0].error === "provider exploded",
			"provider item failure → typed failed status with the provider error",
		);

		// Missing item (absent from results) → status "missing".
		const missing = await run(new FakeBatchProvider({ missing: ["R1"] }));
		check(
			missing instanceof BatchError &&
				missing.detail?.items?.[0]?.status === "missing",
			"item absent from the results payload → missing status",
		);

		// Job reached a failed terminal phase → job_failed.
		const jobFailed = await run(
			new FakeBatchProvider({ terminalPhase: "failed" }),
		);
		check(
			jobFailed instanceof BatchError &&
				jobFailed.code === "job_failed" &&
				jobFailed.message.includes('"failed"'),
			`terminal failed phase → job_failed (${(jobFailed as Error).message})`,
		);

		// Submit failure → submit_failed (state recorded, no job id).
		const submitFailed = await run(
			new FakeBatchProvider({ submitError: "provider down" }),
		);
		check(
			submitFailed instanceof BatchError &&
				submitFailed.code === "submit_failed",
			"submit failure → submit_failed",
		);

		// Abort mid-flight → aborted, state records the job id (recoverable).
		const ac = new AbortController();
		ac.abort();
		const aborted = await run(new FakeBatchProvider(), { signal: ac.signal });
		check(
			aborted instanceof BatchError &&
				aborted.code === "aborted" &&
				aborted.message.includes("fake-batch-1"),
			`abort → aborted naming the job id (${(aborted as Error).message})`,
		);

		// Poll timeout with a fake clock: the job keeps running provider-side.
		let t = 0;
		const timedOut = await run(
			new FakeBatchProvider({ completeAfterPolls: 100 }),
			{
				jobTimeoutMs: 500,
				now: () => t,
				sleep: () => {
					t += 1000;
					return Promise.resolve();
				},
			},
		);
		check(
			timedOut instanceof BatchError &&
				timedOut.code === "poll_timeout" &&
				timedOut.message.includes("fake-batch-1"),
			`poll timeout → poll_timeout naming the still-live job (${(timedOut as Error).message})`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log(
		"✓ typed lane failures: submit_failed, job_failed, poll_timeout, aborted, items_incomplete",
	);
}

// ─── OpenRouter wire protocol (mock fetch) ──────────────────────────

function testOpenRouterWire(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// A scriptable fetch: records requests, returns queued responses.
	const calls: Array<{
		url: string;
		init: { method: string; headers: Record<string, string>; body?: string };
	}> = [];
	const queue: Array<{ status: number; body: string }> = [];
	const fetchImpl = (url: string, init: unknown): Promise<Response> => {
		calls.push({
			url,
			init: init as {
				method: string;
				headers: Record<string, string>;
				body?: string;
			},
		});
		const next = queue.shift() ?? { status: 200, body: "{}" };
		return Promise.resolve(
			new Response(next.body, {
				status: next.status,
				headers: { "Content-Type": "application/json" },
			}),
		);
	};

	const provider = new OpenRouterBatchProvider({
		apiKey: "test-key",
		fetchImpl: fetchImpl as typeof fetch,
	});

	// Submit: POST /chat/batches with the pinned request shape.
	queue.push({
		status: 200,
		body: JSON.stringify({ id: "batch_abc", status: "validating" }),
	});
	void provider
		.submit("google/gemini-3.7-flash:batch", [
			{ customId: "R1", prompt: "do it", contract: { kind: "text" } },
		])
		.then((r) => {
			check(
				r.jobId === "batch_abc" && r.phase === "validating",
				"submit maps id + phase",
			);
			const submitCall = calls[0];
			if (!submitCall) throw new Error("submit call must be recorded");
			check(
				submitCall.url.endsWith("/chat/batches"),
				`submit URL, got ${submitCall.url}`,
			);
			check(submitCall.init.method === "POST", "submit method POST");
			check(
				submitCall.init.headers.Authorization === "Bearer test-key",
				"submit carries the bearer key",
			);
			const body = JSON.parse(submitCall.init.body ?? "{}") as {
				model: string;
				items: Array<{
					custom_id: string;
					body: { messages: Array<{ role: string; content: string }> };
				}>;
			};
			check(
				body.model === "google/gemini-3.7-flash:batch",
				"submit body carries the batch model id",
			);
			const submitted = body.items[0];
			if (!submitted) throw new Error("submit body must carry one item");
			check(
				body.items.length === 1 &&
					submitted.custom_id === "R1" &&
					submitted.body.messages[0]?.role === "user" &&
					submitted.body.messages[0]?.content === "do it",
				"submit body carries custom_id + single-turn user message",
			);
		});

	// Status: GET /chat/batches/{id} → phase + counts; unknown phase → in_progress.
	queue.push({
		status: 200,
		body: JSON.stringify({
			id: "batch_abc",
			status: "in_progress",
			request_counts: { total: 2, completed: 1, failed: 0 },
		}),
	});
	void provider.status("batch_abc").then((s) => {
		check(
			s.phase === "in_progress" &&
				s.counts.total === 2 &&
				s.counts.completed === 1,
			"status maps phase + request_counts",
		);
		const statusCall = calls[1];
		if (!statusCall) throw new Error("status call must be recorded");
		check(
			statusCall.url.endsWith("/chat/batches/batch_abc"),
			`status URL, got ${statusCall.url}`,
		);
	});
	queue.push({
		status: 200,
		body: JSON.stringify({ id: "x", status: "weird", request_counts: {} }),
	});
	void provider.status("x").then((s) => {
		check(
			s.phase === "in_progress",
			"unknown status maps to in_progress (forward compatible)",
		);
	});

	// Results: JSONL → per-item raw records (ok + error + usage + cost).
	const resultsJsonl = [
		JSON.stringify({
			id: "r1",
			custom_id: "R1",
			response: {
				status_code: 200,
				body: {
					choices: [{ message: { content: '{"files": []}' } }],
					usage: { prompt_tokens: 100, completion_tokens: 50 },
					cost: 0.001,
				},
			},
		}),
		JSON.stringify({
			id: "r2",
			custom_id: "R2",
			response: { status_code: 422, body: {}, error: "item rejected" },
		}),
		"this is not json",
	].join("\n");
	queue.push({ status: 200, body: resultsJsonl });
	void provider.results("batch_abc").then((raw) => {
		const okRecord = raw[0];
		if (!okRecord) throw new Error("results must map the ok item");
		check(
			raw.length === 2,
			`unparseable JSONL lines skipped, got ${raw.length}`,
		);
		check(
			okRecord.customId === "R1" &&
				okRecord.ok === true &&
				okRecord.text === '{"files": []}' &&
				okRecord.promptTokens === 100 &&
				okRecord.completionTokens === 50 &&
				okRecord.costUsd === 0.001,
			"ok item maps content + usage + cost",
		);
		const errRecord = raw[1];
		if (!errRecord) throw new Error("results must map the errored item");
		check(
			errRecord.customId === "R2" &&
				errRecord.ok === false &&
				errRecord.statusCode === 422 &&
				errRecord.error === "item rejected",
			"errored item maps status_code + error",
		);
		// calls: 0 submit · 1 status(batch_abc) · 2 status(x) · 3 results
		const resultsCall = calls[3];
		if (!resultsCall) throw new Error("results call must be recorded");
		check(
			resultsCall.url.endsWith("/chat/batches/batch_abc/results"),
			`results URL, got ${resultsCall.url}`,
		);
	});

	// HTTP failure → typed http_error naming the endpoint + status.
	queue.push({ status: 401, body: "unauthorized" });
	void provider.status("batch_abc").catch((err: unknown) => {
		check(
			err instanceof BatchError &&
				err.code === "http_error" &&
				err.message.includes("401"),
			`HTTP 401 → typed http_error (${(err as Error).message})`,
		);
	});

	// Missing api key → typed no_api_key (env stripped for this test).
	const savedKey = process.env.OPENROUTER_API_KEY;
	delete process.env.OPENROUTER_API_KEY;
	const noKey = new OpenRouterBatchProvider({
		fetchImpl: fetchImpl as typeof fetch,
	});
	void noKey
		.submit("m", [{ customId: "R1", prompt: "p", contract: { kind: "text" } }])
		.catch((err: unknown) => {
			check(
				err instanceof BatchError && err.code === "no_api_key",
				"missing api key → no_api_key",
			);
		});
	if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;

	// The queue is drained by the async handlers above — flush microtasks.
	void Promise.resolve().then(() => {
		if (queue.length > 0)
			errors.push(`unconsumed mock responses: ${queue.length}`);
	});
	console.log(
		"✓ OpenRouter wire: submit/status/results request shape + JSONL mapping (mock fetch)",
	);
}

// ─── Pure channel routing ───────────────────────────────────────────

function testRouteRun(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const codeShape = DEFAULT_TASK_SHAPES.code;
	if (!codeShape) throw new Error("DEFAULT_TASK_SHAPES.code must exist");

	// sync/flex/undefined → interactive.
	check(
		routeRun(undefined).kind === "interactive",
		"undefined shape → interactive",
	);
	check(routeRun(codeShape).kind === "interactive", "code shape → interactive");
	check(
		routeRun({ ...codeShape, channel: "flex" }).kind === "interactive",
		"flex shape → interactive",
	);
	// batch → batch (single worker, no sub-specs).
	check(routeRun(BATCH_SHAPE).kind === "batch", "batch shape → batch");
	// batch + parallel/sub_specs → invalid with the reason (configuration error).
	const p = routeRun(BATCH_SHAPE, { parallel: 2 });
	check(
		p.kind === "invalid" && p.reason.includes("parallel"),
		"batch + parallel → invalid (reason names parallel)",
	);
	const s = routeRun(BATCH_SHAPE, { hasSubSpecs: true });
	check(
		s.kind === "invalid" && s.reason.includes("sub_specs"),
		"batch + sub_specs → invalid (reason names sub_specs)",
	);
	check(
		routeRun(BATCH_SHAPE, { parallel: 1, hasSubSpecs: false }).kind === "batch",
		"batch + parallel 1 + no sub_specs → batch",
	);

	console.log(
		"✓ routeRun: batch channel routes to the lane; parallel/sub_specs are configuration errors",
	);
}

// ─── executeTask on the batch channel (real jj repo, fake provider) ─

async function testExecuteBatchLane(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-task-batch-exec-"));
	const metricsDir = mkdtempSync(join(tmpdir(), "pi-task-batch-metrics-"));
	try {
		initRepo(dir);

		// Green run: R1 produces hello.txt; R2 produces nothing (the lane's
		// single commit covers the commit requirement).
		const provider = new FakeBatchProvider({
			outputs: {
				R1: JSON.stringify({
					requirement: 'R1: Create hello.txt with content "hi"',
					files: [{ path: "hello.txt", content: "hi" }],
					summary: "created hello.txt",
				}),
				R2: JSON.stringify({
					requirement: "R2",
					files: [],
					summary: "commit via lane",
				}),
			},
		});
		const events: string[] = [];
		const result: TaskResult = await executeTask({
			cwd: dir,
			model: "provider/exec",
			spec: SPEC,
			shape: BATCH_SHAPE,
			batchProvider: provider,
			batch: {
				model: "google/gemini-3.7-flash:batch",
				pollIntervalMs: 1,
				jobTimeoutMs: 60_000,
			},
			metricsDir,
			project: "batch-test",
			aiAuthorName: "Pi ({model})",
			aiAuthorEmail: "pi@test.dev",
			onUpdate: (e) => events.push((e as { type: string }).type),
		});

		check(
			result.success === true && result.tests === "passing",
			"green batch run succeeds",
		);
		check(
			result.files_changed.length === 1 &&
				result.files_changed[0] === "hello.txt",
			`files_changed carries the applied file, got ${JSON.stringify(result.files_changed)}`,
		);
		check(
			existsSync(join(dir, "hello.txt")) &&
				readFileSync(join(dir, "hello.txt"), "utf-8") === "hi",
			"the batch output was applied to the working copy",
		);
		check(
			result.commits.length === 1 && /^[0-9a-f]{40}$/.test(result.commits[0]!),
			`the batch commit id is returned, got ${JSON.stringify(result.commits)}`,
		);
		check(
			result.batch?.jobId === "fake-batch-1" && result.batch?.items === 2,
			"result carries the batch record (job id + item count)",
		);
		check(
			result.worker.usage.turns === 2 &&
				result.worker.usage.cost_usd === 0.0002 &&
				result.worker.usage.edits === 1,
			"synthesized worker usage aggregates the lane",
		);
		check(
			events.includes("batch_submitted") &&
				events.includes("batch_status") &&
				events.includes("batch_collected"),
			"lane events flow through the orchestrator's onUpdate",
		);

		// The batch commit is AI-authored with the lane commit message; the
		// working copy is restored to an empty user commit on top.
		check(
			jj(["log", "-r", "@-", "-T", "description", "--no-graph"], dir)
				.trim()
				.startsWith("batch(task):"),
			"the batch commit carries the lane message",
		);
		check(
			jj(
				["log", "-r", "@-", "-T", "author.name()", "--no-graph"],
				dir,
			).trim() === "Pi (exec)",
			`the batch commit is AI-authored, got ${jj(["log", "-r", "@-", "-T", "author.name()", "--no-graph"], dir).trim()}`,
		);
		check(
			jj(["diff", "--from", "@-", "--to", "@", "--summary"], dir).trim() === "",
			"working copy restored clean (empty user commit on top)",
		);

		// Manifest: persisted with the batch verify source + channel; job
		// state file recorded next to it.
		check(
			result.manifest !== undefined &&
				result.manifest.phases.verify.source === "batch" &&
				result.manifest.config.channel === "batch" &&
				result.manifest.config.shape === "batch",
			"manifest records verify.source batch + channel batch",
		);
		check(
			result.manifest!.phases.execute.model ===
				"google/gemini-3.7-flash:batch" &&
				result.manifest!.phases.execute.turns === 2 &&
				result.manifest!.phases.execute.cost_usd === 0.0002,
			"manifest execute phase aggregates the lane usage",
		);
		check(
			result.manifestPath !== undefined && existsSync(result.manifestPath),
			"manifest persisted",
		);
		const state = readBatchJobState(
			metricsDir,
			"batch-test",
			result.manifest!.run_id,
		);
		check(
			state !== null &&
				state.job_id === "fake-batch-1" &&
				state.status === "completed" &&
				state.items.every((i) => i.status === "completed"),
			"job state file persisted next to the manifest (job id + per-item status)",
		);
		check(
			existsSync(
				batchJobStatePath(metricsDir, "batch-test", result.manifest!.run_id),
			),
			"job state lives at <metricsDir>/<project>/<run>.batch.json",
		);

		// Review requested on the batch channel → silently skipped (flag).
		const provider2 = new FakeBatchProvider();
		const result2 = await executeTask({
			cwd: dir,
			model: "provider/exec",
			spec: "## Goal\nG\n## Requirements\n- R1: x\n## Verification\n- true",
			shape: BATCH_SHAPE,
			batchProvider: provider2,
			batch: { model: "m", pollIntervalMs: 1, jobTimeoutMs: 60_000 },
			review: true,
			aiAuthorName: "Pi ({model})",
			aiAuthorEmail: "pi@test.dev",
		});
		check(
			result2.reviewSkipped === true,
			"review on the batch channel → reviewSkipped",
		);

		// Overwrite guard (review P2): an item targeting an EXISTING file is
		// refused — context-free single-turn output must never silently
		// replace content the model never saw (greenfield-only).
		{
			const provider3 = new FakeBatchProvider({
				outputs: {
					R1: JSON.stringify({
						requirement: "R1",
						files: [{ path: "hello.txt", content: "clobber" }],
						summary: "x",
					}),
				},
			});
			let threw: string | null = null;
			try {
				await executeTask({
					cwd: dir,
					model: "provider/exec",
					spec: "## Goal\nG\n## Requirements\n- R1: one\n## Verification\ntrue",
					shape: BATCH_SHAPE,
					batchProvider: provider3,
					batch: { model: "m", pollIntervalMs: 1, jobTimeoutMs: 60_000 },
				});
			} catch (err) {
				threw = err instanceof BatchError ? err.code : (err as Error).message;
			}
			check(
				threw === "existing_file",
				`existing-file overwrite refused (P2), got ${threw}`,
			);
			check(
				readFileSync(join(dir, "hello.txt"), "utf-8") === "hi",
				"existing file content untouched after the refused overwrite",
			);
		}

		// Failure: contract-violating output → typed BatchError + failure
		// artifact (kind batch) with the recovery hint; working copy restored.
		const failDir = mkdtempSync(join(tmpdir(), "pi-task-batch-failrun-"));
		try {
			initRepo(failDir);
			const badProvider = new FakeBatchProvider({
				outputs: { R1: "not json" },
			});
			let caught: unknown = null;
			try {
				await executeTask({
					cwd: failDir,
					model: "provider/exec",
					spec: SPEC,
					shape: BATCH_SHAPE,
					batchProvider: badProvider,
					batch: { model: "m", pollIntervalMs: 1, jobTimeoutMs: 60_000 },
					metricsDir,
					project: "batch-test",
					aiAuthorName: "Pi ({model})",
					aiAuthorEmail: "pi@test.dev",
				});
			} catch (err) {
				caught = err;
			}
			check(
				caught instanceof BatchError && caught.code === "items_incomplete",
				"contract violation surfaces as typed items_incomplete",
			);
			check(
				jj(
					["log", "-r", "@-", "-T", "description", "--no-graph"],
					failDir,
				).trim() === "init",
				"failed batch run restores the working copy (no dangling commits)",
			);
			check(
				jj(
					["diff", "--from", "@-", "--to", "@", "--summary"],
					failDir,
				).trim() === "",
				"failed batch run leaves a clean working copy",
			);
			// Failure artifact: <metricsDir>/<project>/*.failure.json with
			// kind batch + the recovery hint naming the job-state file.
			const projDir = join(metricsDir, "batch-test");
			const failures = readdirSync(projDir)
				.filter((n) => n.endsWith(".failure.json"))
				.sort();
			check(
				failures.length >= 1,
				"failure artifact written for the failed lane run",
			);
			const artifact = JSON.parse(
				readFileSync(join(projDir, failures[failures.length - 1]!), "utf-8"),
			) as { kind: string; recovery?: string; cause: string };
			check(
				artifact.kind === "batch" &&
					artifact.recovery !== undefined &&
					artifact.recovery.includes(".batch.json"),
				"failure artifact: kind batch + recovery hint naming the job-state file",
			);
		} finally {
			rmSync(failDir, { recursive: true, force: true });
		}

		// Batch + parallel / sub_specs → configuration error before any lane.
		const invalidConfigs: Array<{ parallel: number } | { subSpecs: string[] }> =
			[
				{ parallel: 2 },
				{
					subSpecs: [
						"## Goal\nG\n## Requirements\n- R1: x\n## Verification\n- true",
					],
				},
			];
		for (const opts of invalidConfigs) {
			let caught: unknown = null;
			try {
				await executeTask({
					cwd: dir,
					model: "provider/exec",
					spec: "## Goal\nG\n## Requirements\n- R1: x\n## Verification\n- true",
					shape: BATCH_SHAPE,
					batchProvider: new FakeBatchProvider(),
					batch: { model: "m", pollIntervalMs: 1, jobTimeoutMs: 60_000 },
					...opts,
				});
			} catch (err) {
				caught = err;
			}
			check(
				caught instanceof Error && caught.message.includes("batch channel"),
				`batch + ${"parallel" in opts ? "parallel" : "sub_specs"} → configuration error`,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(metricsDir, { recursive: true, force: true });
	}
	console.log(
		"✓ executeTask batch channel: real jj repo — apply → commit (AI) → verify → manifest + state, typed failures",
	);
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	console.log(
		"── test-batch: batch lane — contracts, fake round-trip, OpenRouter wire, routing ──",
	);
	testContracts(errors);
	testItemBuilding(errors);
	testJobState(errors);
	await testLaneRoundTrip(errors);
	await testBatchRecovery(errors);
	await testLaneFailures(errors);
	testOpenRouterWire(errors);
	testRouteRun(errors);
	await testExecuteBatchLane(errors);

	// Let the OpenRouter wire test's promise handlers flush before asserting.
	await new Promise((resolve) => setTimeout(resolve, 10));
	if (errors.length > 0) {
		throw new Error("test-batch failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log("✓ batch hermetic assertions passed");
}

// Direct execution support: `npx tsx extensions/task/test-batch.ts`
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error((err as Error).message ?? err);
			process.exit(1);
		});
}
