/**
 * Scheduler hermetic tests — the pure parts (isDue, state round-trip,
 * dueJobs, spec resolution, arg parsing, the detached-run request).
 * No spawn, no batch provider, no LLM. Registered in test.ts.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
	dueJobs,
	isDue,
	parseSchedulerArgs,
	readSchedulerState,
	writeSchedulerState,
	schedulerStatePath,
	resolveJobSpec,
	buildJobRequest,
} from "./scheduler.ts";
import { loadTaskConfig, type JobConfig } from "./config.ts";

function job(over: Partial<JobConfig> = {}): JobConfig {
	return {
		description: "test job",
		channel: "flex",
		tier: "full",
		shape: "code",
		spec: "## Goal\ng\n## Requirements\n- R1: x\n## Verification\ntrue",
		everyMs: 60_000,
		...over,
	};
}

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// isDue
	{
		const j = job();
		check(isDue(j, undefined, 0) === true, "never run → due");
		check(isDue(j, 1000, 61_000) === true, "everyMs elapsed → due");
		check(isDue(j, 1000, 1001) === false, "not elapsed → not due");
		check(
			isDue(job({ everyMs: 0 }), undefined, 0) === true,
			"zero interval → always due",
		);
	}

	// state round-trip
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-task-sched-"));
		try {
			const path = schedulerStatePath(dir);
			check(
				readSchedulerState(path).length === undefined,
				"missing state → empty record",
			);
			writeSchedulerState(path, { weekly: { lastRunMs: 123, runId: "r1" } });
			check(
				readSchedulerState(path).weekly?.runId === "r1",
				"state round-trips",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// dueJobs
	{
		const config = {
			jobs: { a: job({ everyMs: 10_000 }), b: job({ everyMs: 10_000 }) },
		};
		const all = dueJobs(config, {}, 20_000);
		check(all.length === 2, "all due when never run");
		const one = dueJobs(config, { a: { lastRunMs: 15_000 } }, 20_000); // 5s elapsed < 10s → a not due
		check(one.length === 1 && one[0]!.name === "b", "only un-elapsed job due");
		check(dueJobs({ jobs: {} }, {}, 0).length === 0, "no jobs → empty plan");
	}

	// resolveJobSpec: inline + file:
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-task-spec-"));
		try {
			const p = join(dir, "spec.md");
			writeFileSync(
				p,
				"## Goal\nfile\n## Requirements\n- R1: y\n## Verification\ntrue",
				"utf-8",
			);
			check(
				resolveJobSpec(job({ spec: "inline" })) === "inline",
				"inline spec returned",
			);
			check(
				resolveJobSpec(job({ spec: `file:${p}` })).includes("file"),
				"file: spec read",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// parseSchedulerArgs
	{
		check(parseSchedulerArgs(["--once"]).mode === "once", "--once");
		check(parseSchedulerArgs(["--loop"]).mode === "loop", "--loop");
		check(parseSchedulerArgs(["--dry-run"]).dryRun === true, "--dry-run");
		check(
			parseSchedulerArgs(["--project", "x"]).project === "x",
			"--project value",
		);
		let threw = "";
		try {
			parseSchedulerArgs(["--bogus"]);
		} catch (err) {
			threw = (err as Error).message;
		}
		check(threw.includes("bogus"), "unknown arg throws");
	}

	// buildJobRequest: writes the detached-run request file (flex lane) and
	// carries the tier's MODELS + timeouts (not the tier NAME) so the runner
	// child can actually start a session (review P1).
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-task-req-"));
		try {
			const metricsDir = join(dir, "results");
			const config = loadTaskConfig();
			const { runId, requestPath } = buildJobRequest({
				metricsDir,
				project: "proj",
				spec: "## Goal\ng\n## Requirements\n- R1: x\n## Verification\ntrue",
				tier: "full",
				shape: "analysis",
				channel: "flex",
				config,
				cwd: dir,
			});
			const { run_id, options } = JSON.parse(
				readFileSync(requestPath, "utf-8"),
			) as {
				run_id: string;
				options: {
					spec?: string;
					budget?: string;
					shape: { channel: string; workModel: string };
					model: string;
					prewalkModel?: string;
					reviewModel: string;
					workerTimeoutMs: number;
					toolTimeoutMs: number;
					aiAuthorName: string;
				};
			};
			check(run_id === runId, "request carries the run id");
			check(
				typeof options.spec === "string" && options.budget === "full",
				"request carries spec + tier",
			);
			check(
				options.shape.channel === "flex" &&
					options.shape.workModel === "prewalk",
				"request carries the resolved shape with the job's channel forced",
			);
			const t = config.tiers.full!;
			check(
				options.model === t.executeModel,
				"request model is the tier's execute model, not the tier name (P1)",
			);
			check(
				options.prewalkModel === (t.prewalkModel ?? undefined),
				"request carries the tier prewalk model (P1)",
			);
			check(
				options.reviewModel === t.reviewModel,
				"request carries the tier review model (P1)",
			);
			check(
				options.workerTimeoutMs === t.wallTimeoutMs,
				"request carries the tier wall timeout (P1)",
			);
			check(
				typeof options.toolTimeoutMs === "number",
				"request carries the shared tool timeout (P1)",
			);
			check(
				typeof options.aiAuthorName === "string",
				"request carries the AI commit identity (P1)",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	if (errors.length > 0) {
		return Promise.reject(
			new Error("test-scheduler failed:\n  ✗ " + errors.join("\n  ✗ ")),
		);
	}
	console.log(
		"✓ scheduler: isDue, state, dueJobs, spec resolution, args, request (M4)",
	);
	return Promise.resolve();
}

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
