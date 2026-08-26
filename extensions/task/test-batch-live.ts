/**
 * GUARDED real-OpenRouter batch integration test (M2) — NOT part of
 * test.ts (network + cost). Run manually:
 *
 *   OPENROUTER_API_KEY=<key> timeout 2400 npx tsx extensions/task/test-batch-live.ts
 *
 * Guard: without OPENROUTER_API_KEY the test prints SKIPPED and exits 0.
 *
 * Submits ONE real batch job with a single trivial text-contract item
 * ("Reply with exactly: pong") on the shipped batch model
 * (google/gemini-3.7-flash:batch — config/task.toml [batch] model),
 * polls it to completion with real intervals, collects, and validates
 * the output against the text contract. Also asserts the job-state file
 * round-trip (writeBatchJobState / readBatchJobState) so the R4 record
 * path is exercised end-to-end.
 *
 * The hermetic suite (test-batch.ts) never makes this call — it mocks
 * the wire protocol (OpenRouterBatchProvider fetchImpl) and uses the
 * FakeBatchProvider for the lane round-trip.
 *
 * Exit codes: 0 ok · 1 the job failed / the assertions failed ·
 * 2 the job did not finish within the wall cap (still live provider-side —
 * the printed job id + job-state file are the recovery handles).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
	BatchError,
	OpenRouterBatchProvider,
	readBatchJobState,
	runBatchLane,
	writeBatchJobState,
} from "./batch.ts";
import { loadTaskConfig } from "./config.ts";
import { parseSpec } from "./schemas/spec.ts";

/** Wall cap for the live poll (30 min — small batch jobs usually finish
 *  in minutes; a job past the cap is reported as still-live, not failed). */
const LIVE_WALL_TIMEOUT_MS = 30 * 60_000;
/** Real poll interval while the job is in flight. */
const LIVE_POLL_INTERVAL_MS = 15_000;

const SPEC = `## Goal
Prove the batch lane end to end.

## Requirements
- R1: Reply with exactly the word pong

## Verification
- true
`;

function fail(message: string): never {
	console.error(`✗ test-batch-live: ${message}`);
	process.exit(1);
}

async function main(): Promise<void> {
	if (!process.env.OPENROUTER_API_KEY) {
		console.log(
			"SKIPPED: OPENROUTER_API_KEY not set — the real batch call is guarded (network + cost).",
		);
		return;
	}

	const model = loadTaskConfig().batch.model;
	console.log(`submitting live batch job on ${model} ...`);
	const dir = mkdtempSync(join(tmpdir(), "pi-task-batch-live-"));
	const metricsDir = join(dir, "metrics");
	try {
		const lane = await runBatchLane({
			spec: parseSpec(SPEC),
			model,
			provider: new OpenRouterBatchProvider(),
			pollIntervalMs: LIVE_POLL_INTERVAL_MS,
			jobTimeoutMs: LIVE_WALL_TIMEOUT_MS,
			metricsDir,
			project: "batch-live",
		});
		console.log(
			`job ${lane.jobId} completed: ${lane.items.length} item(s), ${lane.usage.cost_usd} USD`,
		);

		if (lane.items.length !== 1 || lane.items[0]!.status !== "completed") {
			fail(`expected 1 completed item, got ${JSON.stringify(lane.items)}`);
		}
		const output = lane.outputs.R1;
		if (typeof output !== "string" || !/pong/i.test(output)) {
			fail(
				`expected the output to contain "pong", got ${JSON.stringify(output)}`,
			);
		}

		// R4: the job-state file round-trips (written by the lane, read back).
		const state = readBatchJobState(metricsDir, "batch-live", lane.runId);
		if (
			state === null ||
			state.job_id !== lane.jobId ||
			state.status !== "completed"
		) {
			fail("job-state file did not round-trip (job id / status)");
		}
		// writeBatchJobState must accept the read-back state unchanged
		// (the manifest-adjacent record is the recovery handle).
		writeBatchJobState(state, { metricsDir, project: "batch-live" });
		console.log(
			"✓ live batch lane: submit → poll → collect → validate → job-state round-trip",
		);
	} catch (err) {
		if (err instanceof BatchError && err.code === "poll_timeout") {
			console.error(
				`job still live provider-side after ${LIVE_WALL_TIMEOUT_MS / 60000} min — poll it later ` +
					`(job id in the message above; state recorded in ${metricsDir})`,
			);
			process.exit(2);
		}
		fail(err instanceof Error ? err.message : String(err));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	});
}
