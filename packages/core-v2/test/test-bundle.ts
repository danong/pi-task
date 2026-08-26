/**
 * Hermetic tests for bundle telemetry (M3 mode b — FR-9/NFR-2): the
 * one-shot versioned/hashed ExecutionBundle builder (isolated from the
 * route choice), TaskReceipt.bundleHit semantics across every outcome
 * path, and the miss→routing-feedback loop that feeds routeTask.
 *
 * Zero LLM, zero network: sessions run through the scriptable fake host,
 * verification through fast real bash, telemetry through a temp-dir
 * SQLite ledger.
 *
 * Standalone: npx tsx packages/core-v2/test/test-bundle.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	buildExecutionBundle,
	hashExecutionBundle,
	isBundleFocused,
	isBundleUsable,
} from "../src/grounding/bundle.ts";
import {
	aggregateRoutingFeedback,
	bundleHitRate,
	BUNDLE_FEEDBACK_MODE,
	routeTask,
} from "../src/router/route.ts";
import type {
	SessionHandle,
	SessionHost,
	SessionHostConfig,
} from "../src/sessions/host.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { runTask } from "../src/daemon/task-runner.ts";

/** Bundle-eligible spec: ≥2 requirements, orientation notes present. */
const BUNDLED_SPEC = `## Goal
Update the notes file. Orientation notes: src/notes.md holds the facts.

## Requirements
- R1: notes.md contains "v2"
- R2: notes.md mentions bundling

## Verification
- grep -q v2 notes.md && grep -qi bundling notes.md
`;

const NON_BUNDLE_SPEC = `## Goal
Create a greeting file.

## Requirements
- R1: hello.txt contains exactly "hi"
- R2: hello.txt ends with a newline

## Verification
- test -f hello.txt
`;

/** Scriptable fake worker: writes `files` on prompt, yields them. */
class ScriptedHandle implements SessionHandle {
	readonly role = "worker";
	readonly model = { provider: "fake", modelId: "fake/m" };
	constructor(
		private readonly files: Array<{ path: string; content: string }>,
		private readonly yieldedPaths: readonly string[],
	) {}
	get result() {
		return {
			files_changed: [...this.yieldedPaths],
			summary: "done",
			commit_ids: ["c1"],
			deviations: [],
		};
	}
	subscribe(): () => void {
		return () => undefined;
	}
	prompt(): Promise<void> {
		for (const f of this.files) writeFileSync(f.path, f.content, "utf-8");
		return Promise.resolve();
	}
	async abort(): Promise<void> {}
	stats() {
		return Promise.resolve({
			sessionFile: undefined,
			sessionId: "fake-session",
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 1,
			toolResults: 1,
			totalMessages: 4,
			tokens: {
				input: 100,
				output: 20,
				cacheRead: 10,
				cacheWrite: 10,
				total: 140,
			},
			cost: 0.001,
		});
	}
	setModel(): Promise<void> {
		return Promise.resolve();
	}
	close(): void {}
}

function scriptedHost(
	files: Array<{ path: string; content: string }>,
	yieldedPaths: readonly string[],
): SessionHost {
	return {
		spawn: (config: SessionHostConfig) => {
			void config;
			return Promise.resolve(new ScriptedHandle(files, yieldedPaths));
		},
	};
}

/** Count (repo, bundle) feedback rows by outcome in a ledger. */
function bundleRowCounts(
	dbPath: string,
	repo: string,
): { hits: number; misses: number } {
	const store = new LedgerStore(dbPath);
	try {
		const modes = aggregateRoutingFeedback(store.routingRows(repo)).get(repo);
		const rate = modes?.get(BUNDLE_FEEDBACK_MODE);
		return {
			hits: rate?.hits ?? 0,
			misses: (rate?.total ?? 0) - (rate?.hits ?? 0),
		};
	} finally {
		store.close();
	}
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const dir = mkdtempSync(join(tmpdir(), "core-v2-bundle-"));
	try {
		// ─── Builder isolation (R1): versioned + content-hashed, pure ────
		{
			const b1 = buildExecutionBundle({
				taskId: "t1",
				goal: "g",
				requirements: ["r1"],
				verificationCommands: ["true"],
				targetPaths: [],
			});
			const b2 = buildExecutionBundle({
				taskId: "t1",
				goal: "g",
				requirements: ["r1"],
				verificationCommands: ["true"],
				targetPaths: [],
			});
			check(
				hashExecutionBundle(b1) === hashExecutionBundle(b2),
				"identical bundles → identical hash",
			);
			check(
				hashExecutionBundle(b1).startsWith("v"),
				`hash namespaced by format version (${hashExecutionBundle(b1)})`,
			);
			const b3 = buildExecutionBundle({
				taskId: "t1",
				goal: "g",
				requirements: ["r1", "r2"],
				verificationCommands: ["true"],
				targetPaths: [],
			});
			check(
				hashExecutionBundle(b1) !== hashExecutionBundle(b3),
				"content change → different hash",
			);
			check(!isBundleUsable(b1), "bundle without target files is unusable");
			const focused = isBundleFocused(
				buildExecutionBundle({
					taskId: "t",
					goal: "g",
					requirements: ["r"],
					verificationCommands: ["true"],
					targetPaths: [],
				}),
				[],
				dir,
			);
			check(focused, "no changes → trivially focused");

			// Building never touches routing state: the pure functions above
			// are the entire builder surface consumed by the runner.
		}

		// ─── Hit path: bundled run ships focused → bundleHit=true ─────────
		{
			const workDir = join(dir, "hit");
			mkdirSync(workDir, { recursive: true });
			// The runner keys routing_feedback by the cwd basename — seed
			// under the SAME key so the router sees this run's evidence.
			const repo = workDir.split("/").filter(Boolean).pop()!;
			writeFileSync(join(workDir, "notes.md"), "# notes\n", "utf-8"); // bundle target must exist
			const dbPath = join(dir, "hit.db");
			// Seed telemetry so the router SELECTS bundle mode.
			const seed = new LedgerStore(dbPath);
			seed.recordRoutingFeedback(repo, BUNDLE_FEEDBACK_MODE, 1);
			seed.close();

			const result = await runTask({
				specMarkdown: BUNDLED_SPEC,
				cwd: workDir,
				artifactsDir: join(dir, "artifacts-hit"),
				dbPath,
				model: "openrouter/stealth/ox-alpha",
				host: scriptedHost(
					[{ path: join(workDir, "notes.md"), content: "v2 bundling\n" }],
					[join(workDir, "notes.md")],
				),
				bundle: { targetPaths: [join(workDir, "notes.md")] },
			});
			check(
				result.receipt.verdict === "ship",
				`hit-path run ships (got ${result.receipt.verdict})`,
			);
			check(
				result.receipt.bundleHit === true,
				`focused bundled ship → bundleHit true (got ${result.receipt.bundleHit})`,
			);
			const counts = bundleRowCounts(dbPath, repo);
			check(
				counts.hits === 2 && counts.misses === 0,
				`seed + hit recorded as bundle feedback (got ${counts.hits}/${counts.misses})`,
			);
		}

		// ─── Misfocused miss: ship outside the target set → miss ──────────
		{
			const workDir = join(dir, "drift");
			mkdirSync(workDir, { recursive: true });
			// The runner keys routing_feedback by the cwd basename — seed
			// under the SAME key so the router sees this run's evidence.
			const repo = workDir.split("/").filter(Boolean).pop()!;
			writeFileSync(join(workDir, "notes.md"), "# notes\n", "utf-8");
			const dbPath = join(dir, "drift.db");
			const seed = new LedgerStore(dbPath);
			seed.recordRoutingFeedback(repo, BUNDLE_FEEDBACK_MODE, 1);
			seed.close();

			const stray = join(workDir, "stray.txt");
			const result = await runTask({
				specMarkdown: BUNDLED_SPEC.replace("notes.md", "notes.md").concat(""), // keep verification on notes.md
				cwd: workDir,
				artifactsDir: join(dir, "artifacts-drift"),
				dbPath,
				model: "openrouter/stealth/ox-alpha",
				host: scriptedHost(
					[
						{ path: join(workDir, "notes.md"), content: "v2 bundling\n" },
						{ path: stray, content: "x\n" },
					],
					[join(workDir, "notes.md"), stray],
				),
				bundle: { targetPaths: [join(workDir, "notes.md")] },
			});
			check(
				result.receipt.verdict === "ship",
				"misfocused run still ships (verification passed)",
			);
			check(
				result.receipt.bundleHit === false,
				`worker drift outside the bundle → bundleHit false (got ${result.receipt.bundleHit})`,
			);
			const counts = bundleRowCounts(dbPath, repo);
			check(
				counts.misses === 1,
				`drift recorded as bundle miss (got ${counts.misses})`,
			);

			// R3/R4 loop: the recorded miss FEEDS the route function — one hit
			// + one drift miss (rate 0.5 < 0.7) disables bundle for the repo.
			const store = new LedgerStore(dbPath);
			const decision = routeTask({
				spec: {
					requirementCount: 2,
					hasOrientationNotes: true,
					continuesPriorWork: false,
					hasLiveParentSession: false,
				},
				tier: { name: "local" },
				repo,
				feedback: store.routingRows(repo),
			});
			store.close();
			check(
				decision.planMode === "prewalk",
				`misses disable bundle routing (got ${decision.planMode})`,
			);
		}

		// ─── Empty-bundle miss: unusable bundle grounds nothing ───────────
		{
			const workDir = join(dir, "empty");
			mkdirSync(workDir, { recursive: true });
			// The runner keys routing_feedback by the cwd basename — seed
			// under the SAME key so the router sees this run's evidence.
			const repo = workDir.split("/").filter(Boolean).pop()!;
			writeFileSync(join(workDir, "notes.md"), "v2 bundling\n", "utf-8"); // satisfy verification directly
			const dbPath = join(dir, "empty.db");
			const seed = new LedgerStore(dbPath);
			seed.recordRoutingFeedback(repo, BUNDLE_FEEDBACK_MODE, 1);
			seed.close();

			const result = await runTask({
				specMarkdown: BUNDLED_SPEC,
				cwd: workDir,
				artifactsDir: join(dir, "artifacts-empty"),
				dbPath,
				model: "openrouter/stealth/ox-alpha",
				host: scriptedHost([], []),
				bundle: { targetPaths: [join(workDir, "does-not-exist.md")] },
			});
			check(
				result.receipt.verdict === "ship",
				"run proceeds ungrounded when the bundle is empty",
			);
			check(
				result.receipt.bundleHit === false,
				`empty bundle → advertised miss (got ${result.receipt.bundleHit})`,
			);
			const counts = bundleRowCounts(dbPath, repo);
			check(
				counts.misses === 1,
				`empty-bundle miss recorded (got ${counts.misses})`,
			);
		}

		// ─── Verify-after-bundle failure: failed run → miss ───────────────
		{
			const workDir = join(dir, "vfail");
			mkdirSync(workDir, { recursive: true });
			// The runner keys routing_feedback by the cwd basename — seed
			// under the SAME key so the router sees this run's evidence.
			const repo = workDir.split("/").filter(Boolean).pop()!;
			writeFileSync(join(workDir, "notes.md"), "# notes\n", "utf-8");
			const dbPath = join(dir, "vfail.db");
			const seed = new LedgerStore(dbPath);
			seed.recordRoutingFeedback(repo, BUNDLE_FEEDBACK_MODE, 1);
			seed.close();

			const result = await runTask({
				specMarkdown: BUNDLED_SPEC.replace(
					"grep -q v2 notes.md && grep -qi bundling notes.md",
					"exit 7",
				),
				cwd: workDir,
				artifactsDir: join(dir, "artifacts-vfail"),
				dbPath,
				model: "openrouter/stealth/ox-alpha",
				host: scriptedHost(
					[{ path: join(workDir, "notes.md"), content: "v2 bundling\n" }],
					[join(workDir, "notes.md")],
				),
				bundle: { targetPaths: [join(workDir, "notes.md")] },
			});
			check(
				result.receipt.verdict === "failed",
				"failing verification fails the run",
			);
			check(
				result.receipt.bundleHit === false,
				`verify-after-bundle failure → bundleHit false (got ${result.receipt.bundleHit})`,
			);
			const counts = bundleRowCounts(dbPath, repo);
			check(
				counts.misses === 1,
				`verify failure recorded as bundle miss (got ${counts.misses})`,
			);
		}

		// ─── Non-bundle runs stay null and untouched ──────────────────────
		{
			const workDir = join(dir, "cold");
			mkdirSync(workDir, { recursive: true });
			// The runner keys routing_feedback by the cwd basename — seed
			// under the SAME key so the router sees this run's evidence.
			const repo = workDir.split("/").filter(Boolean).pop()!;
			const dbPath = join(dir, "cold.db");
			const seed = new LedgerStore(dbPath);
			seed.recordRoutingFeedback(repo, BUNDLE_FEEDBACK_MODE, 1);
			seed.close();

			const result = await runTask({
				specMarkdown: NON_BUNDLE_SPEC,
				cwd: workDir,
				artifactsDir: join(dir, "artifacts-cold"),
				dbPath,
				model: "openrouter/stealth/ox-alpha",
				host: scriptedHost(
					[{ path: join(workDir, "hello.txt"), content: "hi\n" }],
					[join(workDir, "hello.txt")],
				),
				bundle: { targetPaths: [join(workDir, "hello.txt")] },
			});
			check(
				result.receipt.bundleHit === null,
				`unbundled run keeps bundleHit null (got ${result.receipt.bundleHit})`,
			);
			const counts = bundleRowCounts(dbPath, repo);
			check(
				counts.hits === 1 && counts.misses === 0,
				"unbundled run adds NO bundle feedback rows",
			);
		}

		// ─── The telemetry loop closes both directions ────────────────
		{
			const loopRepo = "loop-repo";
			const row = (hit: number) => ({
				repo: loopRepo,
				mode: BUNDLE_FEEDBACK_MODE,
				hit,
			});

			// Mostly misses (4/7 ≈ 0.571 < 0.7): bundle stays disabled.
			const mostlyMisses = [
				row(0),
				row(0),
				row(0),
				row(1),
				row(1),
				row(1),
				row(1),
			];
			const modes = aggregateRoutingFeedback(mostlyMisses).get(loopRepo);
			const rate = bundleHitRate(modes);
			check(
				rate !== null && Math.abs(rate - 4 / 7) < 1e-12,
				`hit rate aggregates over hits+misses (got ${rate})`,
			);
			const disabled = routeTask({
				spec: {
					requirementCount: 2,
					hasOrientationNotes: true,
					continuesPriorWork: false,
					hasLiveParentSession: false,
				},
				tier: { name: "local" },
				repo: loopRepo,
				feedback: mostlyMisses,
			});
			check(
				disabled.planMode === "prewalk",
				`4/7 below threshold keeps bundle off (got ${disabled.planMode})`,
			);

			// Accumulated hits cross back over the threshold (8/11 ≈ 0.727).
			const recovered = [...mostlyMisses, row(1), row(1), row(1), row(1)];
			const reEnabled = routeTask({
				spec: {
					requirementCount: 2,
					hasOrientationNotes: true,
					continuesPriorWork: false,
					hasLiveParentSession: false,
				},
				tier: { name: "local" },
				repo: loopRepo,
				feedback: recovered,
			});
			check(
				reEnabled.planMode === "bundle",
				`hits accumulating past the threshold re-enable bundle (got ${reEnabled.planMode})`,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		return Promise.reject(
			new Error(`bundle telemetry tests failed:\n  ✗ ${errors.join("\n  ✗ ")}`),
		);
	}
	console.log(
		"✓ bundle: versioned hashing, hit/miss receipt semantics, miss→router feedback loop",
	);
	return Promise.resolve();
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests()
		.then(() => process.exit(0))
		.catch((err: unknown) => {
			console.error(err instanceof Error ? err.message : err);
			process.exit(1);
		});
}
