/**
 * runner.ts hermetic tests — the pure parts of detached dispatch.
 *
 * No worker spawns, no LLM, no child processes: run-request assembly
 * (buildRunRequest — the serializable spec/options/plan contract), the
 * child-process spawn command assembly (buildRunnerCommand /
 * resolveRunnerSpawn / parseRunnerArgs), the run_id → status resolution
 * (locateRun / readRunStatus over a temp metrics dir — manifest beats
 * failure artifact beats live heartbeat beats bare request beats unknown),
 * and the /task-status rendering (live: phases/elapsed/goals + stale
 * heartbeat warning; finished: verify result / findings / cost; failed:
 * cause; unknown: clear message). The child's own run (runChild) is
 * exercised only by the manual e2e — this file never spawns anything.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
	existsSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunManifest } from "./metrics.ts";
import type { RunPlan } from "./progress.ts";
import {
	buildRunRequest,
	buildRunnerCommand,
	LIVE_STALE_THRESHOLD_MS,
	livePathFor,
	locateRun,
	parseRunnerArgs,
	readRunStatus,
	removeFileBestEffort,
	renderRunStatus,
	requestPathFor,
	resolveRunnerSpawn,
	writeLiveState,
	writeRunRequest,
	type LiveRunState,
	type RunRequest,
} from "./runner.ts";

const PLAN: RunPlan = {
	tier: "economy",
	phases: [
		{ name: "prewalk", model: "p/prewalk" },
		{ name: "work", model: "p/work" },
	],
	wallTimeoutMs: 25 * 60_000,
	goals: "make the build green",
};

function requestFixture(over: Partial<RunRequest> = {}): RunRequest {
	return buildRunRequest({
		run_id: "20260805T0000-abcd",
		metrics_dir: "/tmp/m",
		project: "proj",
		worker_count: 2,
		plan: PLAN,
		options: {
			cwd: "/repo",
			model: "p/work",
			spec: "## Goal\nx\n## Requirements\n- R1: y\n## Verification\n- true\n",
			prewalkModel: "p/prewalk",
			executeModel: "p/work",
			review: false,
			budget: "economy",
			workerTimeoutMs: 25 * 60_000,
			toolTimeoutMs: 15 * 60_000,
			verificationTimeoutMs: 600_000,
			aiAuthorName: "Pi ({model})",
			aiAuthorEmail: "noreply@example.com",
			receivedAt: "2026-08-05T00:00:00.000Z",
			mainSessionTokens: 1234,
		},
		now: new Date("2026-08-05T00:00:00.000Z"),
		...over,
	});
}

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	console.log(
		"── test-runner: detached dispatch — request assembly, spawn command, status resolution + rendering ──",
	);

	// ─── path helpers ───
	check(
		requestPathFor("/m", "p", "r1") === join("/m", "p", "r1.request.json"),
		"request path suffix",
	);
	check(
		livePathFor("/m", "p", "r1") === join("/m", "p", "r1.live.json"),
		"live path suffix",
	);

	// ─── buildRunRequest: field mapping + JSON round-trip ───
	{
		const req = requestFixture();
		check(req.run_id === "20260805T0000-abcd", "run_id lands");
		check(
			req.created_at === "2026-08-05T00:00:00.000Z",
			"created_at from injectable now",
		);
		check(
			req.metrics_dir === "/tmp/m" && req.project === "proj",
			"metrics dir + project land",
		);
		check(req.worker_count === 2, "worker count lands");
		check(
			req.plan === PLAN && req.options.spec?.includes("## Goal") === true,
			"plan + options land",
		);
		// The request must survive JSON serialization with no function values
		// (the child process reads it back and executes from it).
		const roundTrip = JSON.parse(JSON.stringify(req)) as RunRequest;
		check(
			JSON.stringify(roundTrip) === JSON.stringify(req) &&
				roundTrip.options.workerTimeoutMs === 25 * 60_000 &&
				roundTrip.options.receivedAt === "2026-08-05T00:00:00.000Z",
			"request JSON round-trips (no functions, no data loss)",
		);
	}

	// ─── writeRunRequest: durable file, atomic (no .tmp left) ───
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-task-req-"));
		try {
			const req = requestFixture({ metrics_dir: dir, project: "alpha" });
			const path = writeRunRequest(req);
			check(
				path === requestPathFor(dir, "alpha", req.run_id),
				"request written at the canonical path",
			);
			check(existsSync(path), "request file exists");
			const parsed = JSON.parse(requireRead(path)) as RunRequest;
			check(
				parsed.run_id === req.run_id && parsed.options.model === "p/work",
				"request round-trips from disk",
			);
			check(!existsSync(`${path}.tmp`), "no tmp file left after rename");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// ─── buildRunnerCommand / resolveRunnerSpawn: child invocation ───
	{
		const local = buildRunnerCommand({
			runnerPath: "/repo/extensions/task/runner.ts",
			requestPath: "/m/p/r1.request.json",
			tsxBin: "/repo/node_modules/.bin/tsx",
		});
		check(
			local.command === "/repo/node_modules/.bin/tsx" &&
				local.args.join(" ") ===
					"/repo/extensions/task/runner.ts --request /m/p/r1.request.json",
			`local tsx invocation, got ${local.command} ${local.args.join(" ")}`,
		);
		const npx = buildRunnerCommand({
			runnerPath: "/repo/extensions/task/runner.ts",
			requestPath: "/m/p/r1.request.json",
		});
		check(
			npx.command === "npx" &&
				npx.args.join(" ") ===
					"tsx /repo/extensions/task/runner.ts --request /m/p/r1.request.json",
			"npx fallback invocation",
		);
		// resolveRunnerSpawn: a baseDir with node_modules/.bin/tsx prefers the
		// local binary; one without falls back to npx.
		const base = mkdtempSync(join(tmpdir(), "pi-task-tsx-"));
		try {
			const binDir = join(base, "node_modules", ".bin");
			mkdirSync(binDir, { recursive: true });
			writeFileSync(join(binDir, "tsx"), "#!/usr/bin/env node\n", "utf-8");
			const withLocal = resolveRunnerSpawn({
				runnerPath: "/repo/extensions/task/runner.ts",
				requestPath: "/m/p/r1.request.json",
				baseDir: base,
			});
			check(
				withLocal.command === join(binDir, "tsx"),
				`local tsx preferred, got ${withLocal.command}`,
			);
			const withoutLocal = resolveRunnerSpawn({
				runnerPath: "/repo/extensions/task/runner.ts",
				requestPath: "/m/p/r1.request.json",
				baseDir: mkdtempSync(join(tmpdir(), "pi-task-notsx-")),
			});
			check(withoutLocal.command === "npx", "no local tsx → npx fallback");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	}

	// ─── parseRunnerArgs ───
	{
		const ok = parseRunnerArgs(["--request", "/m/p/r1.request.json"]);
		check(
			ok.requestPath === "/m/p/r1.request.json" && !ok.help,
			"request path parsed",
		);
		check(parseRunnerArgs(["--help"]).help, "--help parsed");
		let threw = false;
		try {
			parseRunnerArgs(["--bogus"]);
		} catch {
			threw = true;
		}
		check(threw, "unknown arg throws");
		let threwMissing = false;
		try {
			parseRunnerArgs(["--request"]);
		} catch {
			threwMissing = true;
		}
		check(threwMissing, "missing --request value throws");
	}

	// ─── locateRun: run_id → files, across projects ───
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-task-loc-"));
		try {
			const mk = (project: string, file: string, content = "{}"): void => {
				const p = join(dir, project);
				mkdirSync(p, { recursive: true });
				writeFileSync(join(p, file), content, "utf-8");
			};
			check(locateRun(dir, "nope") === null, "unknown run_id → null");

			mk("alpha", "20260805T0001-abcd.json", '{"run_id":"20260805T0001-abcd"}');
			const byManifest = locateRun(dir, "20260805T0001-abcd");
			check(
				byManifest?.project === "alpha" &&
					byManifest.manifestPath ===
						join(dir, "alpha", "20260805T0001-abcd.json"),
				"manifest located",
			);

			mk("beta", "20260805T0002-abcd.live.json", "{}");
			const byLive = locateRun(dir, "20260805T0002-abcd");
			check(
				byLive?.project === "beta" && byLive.livePath !== undefined,
				"live file located",
			);

			mk("gamma", "20260805T0003-abcd.failure.json", "{}");
			const byFailure = locateRun(dir, "20260805T0003-abcd");
			check(
				byFailure?.project === "gamma" && byFailure.failurePath !== undefined,
				"failure artifact located",
			);

			mk("delta", "20260805T0004-abcd.request.json", "{}");
			const byRequest = locateRun(dir, "20260805T0004-abcd");
			check(
				byRequest?.project === "delta" && byRequest.requestPath !== undefined,
				"request located",
			);

			// A project with the manifest wins over one with only sidecars.
			mk("alpha", "20260805T0005-abcd.json", '{"run_id":"20260805T0005-abcd"}');
			mk("epsilon", "20260805T0005-abcd.live.json", "{}");
			const winner = locateRun(dir, "20260805T0005-abcd");
			check(
				winner?.project === "alpha" && winner.manifestPath !== undefined,
				"manifest project wins over sidecar-only",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// ─── readRunStatus: precedence manifest > failure > live > starting > unknown ───
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-task-st-"));
		const now = Date.parse("2026-08-05T00:10:00.000Z");
		try {
			const mk = (project: string, file: string, content: string): void => {
				const p = join(dir, project);
				mkdirSync(p, { recursive: true });
				writeFileSync(join(p, file), content, "utf-8");
			};
			const manifest: RunManifest = {
				run_id: "20260805T0001-abcd",
				config: {
					budget: "economy",
					prewalk_model: "p",
					execute_model: "p",
					review_model: "p",
					swap_trigger: "edit",
					checklist: true,
					review_forked: false,
					shape: "code",
					sandbox: false,
				},
				task: { spec_hash: "abc", requirements: 2 },
				phases: {
					prewalk: null,
					execute: {
						model: "p",
						turns: 5,
						tokens_in: 100,
						tokens_out: 50,
						reads: 3,
						edits: 2,
						duration_ms: 10_000,
						cost_usd: 0.002,
					},
					verify: {
						passed: true,
						commands: 2,
						duration_ms: 50,
						source: "worker-tree",
					},
					review: null,
					fix_loop: { iterations: 0, cost_usd: 0 },
				},
				totals: {
					cost_usd: 0.002,
					duration_ms: 12_000,
					read_duplication_tokens: 0,
					session_files: [],
					files_changed: ["a.txt"],
					insertions: 3,
					deletions: 1,
				},
				received_at: "2026-08-05T00:00:00.000Z",
				completed_at: "2026-08-05T00:03:00.000Z",
			};
			mk("alpha", "20260805T0001-abcd.json", JSON.stringify(manifest));
			mk("alpha", "20260805T0001-abcd.live.json", "{}"); // stale sidecar must not win
			const finished = readRunStatus(dir, "20260805T0001-abcd", now);
			check(finished.kind === "finished", "manifest beats live sidecar");
			if (finished.kind === "finished") {
				check(
					finished.project === "alpha" &&
						finished.manifest.totals.cost_usd === 0.002,
					"finished carries the manifest",
				);
			}

			mk(
				"beta",
				"20260805T0002-abcd.failure.json",
				JSON.stringify({
					run_id: "20260805T0002-abcd",
					kind: "worker",
					timestamp: "2026-08-05T00:01:00.000Z",
					cause: "no progress",
				}),
			);
			mk("beta", "20260805T0002-abcd.request.json", "{}");
			const failed = readRunStatus(dir, "20260805T0002-abcd", now);
			check(failed.kind === "failed", "failure artifact beats bare request");
			if (failed.kind === "failed")
				check(
					failed.artifact.cause === "no progress",
					"failed carries the artifact",
				);

			const live: LiveRunState = {
				run_id: "20260805T0003-abcd",
				project: "gamma",
				started_at: "2026-08-05T00:05:00.000Z",
				heartbeat_at: "2026-08-05T00:09:30.000Z",
				plan: PLAN,
				progress_text:
					"plan(economy): prewalk(p/prewalk) → work(p/work) · goals: make the build green\n1/2 workers done",
			};
			mk("gamma", "20260805T0003-abcd.live.json", JSON.stringify(live));
			const liveStatus = readRunStatus(dir, "20260805T0003-abcd", now);
			check(liveStatus.kind === "live", "live heartbeat resolves to live");
			if (liveStatus.kind === "live")
				check(
					liveStatus.staleMs === 30_000,
					`staleMs from heartbeat, got ${liveStatus.staleMs}`,
				);

			// Request-only: spawned but not yet heartbeating.
			const req = requestFixture({
				run_id: "20260805T0004-abcd",
				metrics_dir: dir,
				project: "delta",
			});
			writeRunRequest(req);
			const starting = readRunStatus(dir, "20260805T0004-abcd", now);
			check(starting.kind === "starting", "bare request → starting");
			if (starting.kind === "starting")
				check(
					starting.request.worker_count === 2,
					"starting carries the request",
				);

			const unknown = readRunStatus(dir, "20260805T9999-abcd", now);
			check(unknown.kind === "unknown", "no files → unknown");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// ─── renderRunStatus ───
	{
		const now = Date.parse("2026-08-05T00:10:00.000Z");

		const unknownLines = renderRunStatus(
			{ kind: "unknown", runId: "20260805T9999-abcd", metricsDir: "/tmp/m" },
			now,
		);
		check(
			unknownLines.some((l) => l.includes('no run "20260805T9999-abcd"')) &&
				unknownLines.some((l) => l.includes("/tmp/m")),
			"unknown: clear message with run_id + metrics dir",
		);

		const startingLines = renderRunStatus(
			{
				kind: "starting",
				runId: "r1",
				project: "alpha",
				metricsDir: "/tmp/m",
				request: requestFixture(),
			},
			now,
		);
		check(
			startingLines.some((l) => l.includes("STARTING")) &&
				startingLines.some((l) => l.includes("first heartbeat")),
			"starting: spawned, awaiting heartbeat",
		);

		const live: LiveRunState = {
			run_id: "r1",
			project: "alpha",
			started_at: "2026-08-05T00:05:00.000Z",
			heartbeat_at: "2026-08-05T00:09:30.000Z",
			plan: PLAN,
			progress_text:
				"plan(economy): prewalk(p/prewalk) → work(p/work) · goals: make the build green\n1/2 workers done",
		};
		const liveLines = renderRunStatus(
			{
				kind: "live",
				runId: "r1",
				project: "alpha",
				metricsDir: "/tmp/m",
				state: live,
				staleMs: 30_000,
			},
			now,
		);
		const liveJoined = liveLines.join("\n");
		check(
			liveLines[0]!.includes("RUNNING") && liveLines[0]!.includes("elapsed 5m"),
			`live headline: ${liveLines[0]}`,
		);
		check(
			liveJoined.includes("prewalk(p/prewalk) → work(p/work)"),
			"live shows the phase chain",
		);
		check(
			liveJoined.includes("goals: make the build green"),
			"live shows goals",
		);
		check(liveJoined.includes("1/2 workers done"), "live shows progress text");
		check(
			!liveJoined.includes("no heartbeat"),
			"fresh heartbeat → no stale warning",
		);

		const staleLines = renderRunStatus(
			{
				kind: "live",
				runId: "r1",
				project: "alpha",
				metricsDir: "/tmp/m",
				state: live,
				staleMs: LIVE_STALE_THRESHOLD_MS + 5_000,
			},
			now,
		);
		check(
			staleLines.some(
				(l) => l.includes("no heartbeat") && l.includes("r1.log"),
			),
			"stale heartbeat warns with the log path",
		);

		// Finished: verify result, cost, duration, tier + findings.
		const manifest: RunManifest = {
			run_id: "r1",
			config: {
				budget: "economy",
				prewalk_model: "p",
				execute_model: "p",
				review_model: "p",
				swap_trigger: "edit",
				checklist: true,
				review_forked: true,
				shape: "code",
				sandbox: false,
			},
			task: { spec_hash: "abc", requirements: 2 },
			phases: {
				prewalk: null,
				execute: {
					model: "p",
					turns: 5,
					tokens_in: 100,
					tokens_out: 50,
					reads: 3,
					edits: 2,
					duration_ms: 10_000,
					cost_usd: 0.002,
				},
				verify: {
					passed: true,
					commands: 3,
					duration_ms: 50,
					source: "worker-tree",
				},
				review: {
					model: "p",
					forked: true,
					context_inherited_tokens: 10,
					findings: 2,
					by_priority: { P1: 2 },
					cost_usd: 0.001,
					personas: ["standards"],
				},
				fix_loop: { iterations: 0, cost_usd: 0 },
			},
			totals: {
				cost_usd: 0.003,
				duration_ms: 42_000,
				read_duplication_tokens: 0,
				session_files: [],
				files_changed: [],
				insertions: 0,
				deletions: 0,
			},
		};
		const doneLines = renderRunStatus(
			{
				kind: "finished",
				runId: "r1",
				project: "alpha",
				metricsDir: "/tmp/m",
				manifest,
			},
			now,
		);
		const doneJoined = doneLines.join("\n");
		check(
			doneLines[0]!.includes("DONE ✓"),
			`finished headline: ${doneLines[0]}`,
		);
		check(
			doneJoined.includes("verify: ✓ 3 command(s)"),
			"finished shows verify result",
		);
		check(
			doneJoined.includes("$0.003") &&
				doneJoined.includes("42s") &&
				doneJoined.includes("tier economy"),
			"finished shows cost + duration + tier",
		);
		check(
			doneJoined.includes("review: 2 finding(s) (P1: 2)"),
			"finished shows findings",
		);

		// Failed: cause + timestamp.
		const failLines = renderRunStatus(
			{
				kind: "failed",
				runId: "r1",
				project: "alpha",
				metricsDir: "/tmp/m",
				artifact: {
					run_id: "r1",
					kind: "worker",
					timestamp: "2026-08-05T00:01:00.000Z",
					cause: "no progress",
					tier: "economy",
				},
			},
			now,
		);
		const failJoined = failLines.join("\n");
		check(
			failLines[0]!.includes("FAILED (worker)"),
			`failed headline: ${failLines[0]}`,
		);
		check(failJoined.includes("cause: no progress"), "failed shows cause");
		check(
			failJoined.includes("2026-08-05T00:01:00.000Z"),
			"failed shows timestamp",
		);
	}

	// ─── removeFileBestEffort: live file gone, missing file tolerated ───
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-task-rm-"));
		try {
			const path = livePathFor(dir, "p", "r1");
			writeLiveState(
				{
					run_id: "r1",
					project: "p",
					started_at: "x",
					heartbeat_at: "y",
					plan: PLAN,
					progress_text: "",
				},
				path,
			);
			check(existsSync(path), "live file written");
			removeFileBestEffort(path);
			check(!existsSync(path), "live file removed");
			removeFileBestEffort(path); // missing → tolerated
			check(!existsSync(`${path}.done`), "no leftover .done files");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	if (errors.length > 0) {
		return Promise.reject(
			new Error("test-runner failed:\n  ✗ " + errors.join("\n  ✗ ")),
		);
	}
	console.log("✓ runner hermetic assertions passed");
	return Promise.resolve();
}

/** Small helper: read a file as string (keeps the assertions above short). */
function requireRead(path: string): string {
	return readFileSync(path, "utf-8");
}

// Direct execution support: `npx tsx extensions/task/test-runner.ts`
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
