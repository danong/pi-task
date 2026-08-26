/**
 * THE consolidated real-LLM e2e test — run manually, not by test.ts.
 *
 *   timeout 900 npx tsx extensions/task/test-e2e.ts
 *
 * Exercises real pi + a real LLM end to end (~3-5 min, ~$0.01-0.03).
 *
 * MODEL POLICY (hardcoded, non-negotiable): the only model used anywhere
 * in this file is "opencode-go/deepseek-v4-flash" — the cheap fast model.
 * No frontier/reasoning models, no second model: the prewalk *swap*
 * (which needs two distinct models) is NOT e2e-tested; the swap decision
 * logic is covered hermetically by test-prewalk.ts.
 *
 * Sections (consolidating the six retired LLM smoke test files):
 *   1. runWorker — trivial task → typed yield, commits, usage (was test-worker-runner)
 *   2. Abort — runWorker on a long task, abort after 3s (was test-worker-runner)
 *   3. Checklist steering + prewalk-extension pruning — one direct session,
 *      single model, no attachPrewalk (was test-prewalk A + test-checklist A/B)
 *   4. executeTask single — success, verification passing (was test-orchestrator
 *      + test-checklist C)
 *   5. executeTask parallel 2 — isolated workspaces merge cleanly (was
 *      test-workspace integration)
 *   6. repo-map full — annotation build, cache hit, incremental rebuild
 *      (was test-repo-map 4-6)
 *   7. Forked adversarial review — clean task → review verdict "ship",
 *      structured ReviewResult, success (Phase 7)
 *   8. Review fix loop — verification stricter than the task → a fix worker
 *      is dispatched and the loop converges to green (Phase 7)
 *   9. RunManifest metrics — executeTask with a temp metricsDir → manifest
 *      built in-memory AND persisted, phases/totals populated (Phase 8)
 *  10. task tool end-to-end — a real conversational pi run with the Phase 9
 *      extension: single-worker task via the tool returns a typed result,
 *      plus a sub_specs parallel run asserting isolated non-duplicating
 *      workers (budget-locked to free, so no review/prewalk sessions)
 *
 * Explicitly dropped from the old suite: reads A/B (test-repo-map 8) —
 * declared benchmark-harness territory in its own comment, not a smoke
 * gate; map mechanics are validated hermetically in test-repo-map.ts.
 */

import { execSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	attachJsonlReader,
	runWorker,
	CHECKLIST_EXTENSION_PATH,
	DEFAULT_WORKER_SYSTEM_PROMPT,
	spawnWorkerSession,
} from "./worker.ts";
import { PREWALK_EXTENSION_PATH } from "./prewalk.ts";
import { executeTask, type TaskResult } from "./orchestrator.ts";
import { buildMap } from "./repo-map.ts";

const MODEL = "opencode-go/deepseek-v4-flash"; // THE only model, hardcoded.

/** The Phase 9 task extension entry point (spawned as a conversational run). */
const TASK_EXTENSION_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"index.ts",
);

// Section 10 prompts: instruct the model to pass the specs verbatim so the
// assertions hold deterministically. The task tool runs budget-locked to
// free (--task-budget free) so the schema hides `budget` and the run uses
// only the hardcoded model (no review/prewalk sessions).
const SINGLE_TOOL_PROMPT = `Use the task tool to run this EXACT spec (pass it verbatim as the spec parameter, do not modify it):

## Goal
Create a file hello.txt containing the text "hi".

## Requirements
- R1: Create hello.txt with content "hi"
- R2: Commit the change with jj using the message "add hello.txt"

## Verification
- test -f hello.txt && grep -q hi hello.txt

After the tool returns, report its success field and the files_changed list.`;

const SUBSPECS_TOOL_PROMPT = `Use the task tool with sub_specs containing EXACTLY these two specs (pass each verbatim as one element of the sub_specs array; do not modify them):

Sub-spec 1:
## Goal
Create a file a.txt containing the text "alpha".

## Requirements
- R1: Create a.txt with content "alpha"
- R2: Commit the change with jj (message: "add a.txt")

## Verification
- test -f a.txt && grep -q alpha a.txt

Sub-spec 2:
## Goal
Create a file b.txt containing the text "beta".

## Requirements
- R1: Create b.txt with content "beta"
- R2: Commit the change with jj (message: "add b.txt")

## Verification
- test -f b.txt && grep -q beta b.txt

Do not pass a spec parameter, only sub_specs. After the tool returns, report its success field and files_changed.`;

const SYSTEM_PROMPT = `You are implementing a coding task. Explore the codebase, make changes,
and call yield() when complete.

Make atomic jj commits as you complete each requirement.
Run verification commands after your changes.

Your first edit should be your most confident change.`;

const HELLO_SPEC = `## Goal
Create a file hello.txt containing the text "hi".

## Requirements
- R1: Create hello.txt with content "hi"
- R2: Commit the change with jj using the message "add hello.txt"

## Verification
- test -f hello.txt && grep -q hi hello.txt
`;

const MULTI_SPEC = `## Goal
Update the README with two additions.

## Requirements
- R1: Add a "## Features" section to README.md listing "fast and reliable"
- R2: Add a line at the end of README.md reading "Updated by the task worker"
- R3: Commit the change with jj (message: "update readme")

## Verification
- grep -q "## Features" README.md
- grep -q "Updated by the task worker" README.md
`;

// Phase 7: a fix-loop trigger — verification requires done.txt, which is NOT
// in the requirements, so a worker that follows the task (and is told not to
// self-verify) leaves verification failing until a fix worker adds done.txt.
const FIXLOOP_SPEC = `## Goal
Create hello.txt.

## Requirements
- R1: Create hello.txt containing "hi"
- R2: Commit the change with jj

## Verification
- test -f hello.txt && grep -q hi hello.txt && test -f done.txt
`;

// Tells the task worker NOT to run verification (so it does not self-fix the
// gap), forcing the orchestrator's fix loop to dispatch a fix worker.
const NO_VERIFY_PROMPT = `You are implementing a coding task. Make the changes described, then call yield().
Do not run the verification commands yourself — just make the changes and yield.
Create ONLY the files the Requirements list; never create files that appear only in the Verification section.
Make atomic jj commits as you complete each requirement.`;

const errors: string[] = [];
const check = (cond: boolean, msg: string): void => {
	if (!cond) errors.push(msg);
};

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-task-e2e-"));
	execSync("jj git init --colocate", { cwd: dir, stdio: "pipe" });
	writeFileSync(join(dir, "README.md"), "# Test repo\n", "utf-8");
	execSync('jj commit -m "init"', { cwd: dir, stdio: "pipe" });
	return dir;
}

/** Parse "remaining:N" statusText. */
function parseRemaining(text: string): number {
	const m = /^remaining:(\d+)$/.exec(text);
	if (!m) return -1;
	return parseInt(m[1]!, 10);
}

/** Checklist steering: remaining signals non-increasing to 0. */
function assertSteering(signals: number[], label: string): void {
	console.log(
		`  ${label} remaining sequence:`,
		signals.join(" → ") || "(none)",
	);
	const meaningful = signals.filter((n) => n > 0);
	if (meaningful.length === 0) {
		errors.push(
			`[${label}] checklist was never initialized (no remaining:N with N>0)`,
		);
		return;
	}
	const max = Math.max(...meaningful);
	if (max < 2)
		errors.push(
			`[${label}] expected checklist with >= 2 items, max remaining was ${max}`,
		);
	if (signals[signals.length - 1] !== 0) {
		errors.push(
			`[${label}] expected final remaining to be 0, got ${signals[signals.length - 1]}`,
		);
	}
	const firstMax = signals.indexOf(max);
	const tail = signals.slice(firstMax);
	for (let i = 1; i < tail.length; i++) {
		if (tail[i]! > tail[i - 1]!) {
			errors.push(
				`[${label}] remaining increased after init: ${signals.join(",")}`,
			);
			break;
		}
	}
}

// ─── Section 1: runWorker trivial task ───────────────────────────────

async function section1RunWorker(): Promise<void> {
	console.log("\n── 1. runWorker: trivial task → typed yield ──");
	const dir = makeRepo();
	try {
		const result = await runWorker({
			cwd: dir,
			model: MODEL,
			task: 'Create a file hello.txt containing the text "hi". Commit it with jj (message: "add hello.txt"). Then call yield reporting the file you changed and the commit id.',
			systemPrompt: SYSTEM_PROMPT,
		});
		console.log(
			`  turns: ${result.usage.turns}, files: ${JSON.stringify(result.yield.files_changed)}`,
		);

		check(
			result.yield.files_changed.includes("hello.txt"),
			`files_changed should include "hello.txt", got ${JSON.stringify(result.yield.files_changed)}`,
		);
		check(result.yield.commit_ids.length > 0, "commit_ids should be non-empty");
		check(
			result.usage.turns >= 1,
			`turns should be >= 1, got ${result.usage.turns}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ─── Section 2: abort ────────────────────────────────────────────────

async function section2Abort(): Promise<void> {
	console.log("\n── 2. Abort: long task aborted after 3s ──");
	const dir = makeRepo();
	try {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 3000);

		try {
			await runWorker({
				cwd: dir,
				model: MODEL,
				task: "Read every file in this repo carefully, then write a 500-word essay about each one. Call yield when done.",
				systemPrompt: SYSTEM_PROMPT,
				signal: controller.signal,
			});
			errors.push("[2] expected abort to reject the promise");
		} catch (err: unknown) {
			const message = (err as Error).message ?? String(err);
			if (message.includes("abort")) {
				console.log("  ✓ abort rejected with:", message);
			} else {
				errors.push(`[2] unexpected error: ${message}`);
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ─── Section 3: checklist steering + prewalk-extension pruning ───────

async function section3ChecklistAndPrewalk(): Promise<void> {
	console.log(
		"\n── 3. Checklist steering + prewalk pruning (single model, no attachPrewalk) ──",
	);
	const dir = makeRepo();
	const checklistSignals: number[] = [];
	const planningStates: string[] = [];

	try {
		const session = spawnWorkerSession({
			cwd: dir,
			model: MODEL, // equal models → prewalk auto-skip; the EXTENSION still prunes
			task:
				MULTI_SPEC +
				"\nUse the edit tool for the README changes and the checklist() tool to track your progress (init, then mark each done).",
			systemPrompt: DEFAULT_WORKER_SYSTEM_PROMPT,
			extensions: [CHECKLIST_EXTENSION_PATH, PREWALK_EXTENSION_PATH],
		});

		session.onEvent((rawEvent: unknown) => {
			// Narrowed view of the raw RPC event: only what this section asserts.
			const e = rawEvent as {
				type?: string;
				method?: string;
				statusKey?: string;
				statusText: string;
			};
			if (e.type === "extension_ui_request" && e.method === "setStatus") {
				if (e.statusKey === "checklist")
					checklistSignals.push(parseRemaining(e.statusText));
				if (e.statusKey === "prewalk") planningStates.push(e.statusText);
			}
		});

		const result = await session.result;
		console.log("  turns:", result.usage.turns, "| edits:", result.usage.edits);
		console.log("  files_changed:", result.yield.files_changed);
		console.log("  prewalk states:", planningStates.join(", ") || "(none)");

		assertSteering(checklistSignals, "3");
		check(
			result.yield.files_changed.includes("README.md"),
			`files_changed should include README.md, got ${JSON.stringify(result.yield.files_changed)}`,
		);
		const readme = readFileSync(join(dir, "README.md"), "utf-8");
		check(
			readme.includes("## Features") &&
				readme.includes("Updated by the task worker"),
			`README should contain both additions, got: ${JSON.stringify(readme.slice(0, 200))}`,
		);
		check(
			result.yield.commit_ids.length > 0,
			"[3] commit_ids should be non-empty",
		);
		check(
			result.yield.deviations.length === 0,
			`[3] expected no deviations, got ${JSON.stringify(result.yield.deviations)}`,
		);

		// Prewalk extension pruning: active → pruned at the first edit, stays pruned.
		if (!planningStates.includes("active")) {
			errors.push(
				`[3] expected at least one "active" planning state, got: ${planningStates.join(",")}`,
			);
		}
		if (planningStates[planningStates.length - 1] !== "pruned") {
			errors.push(
				`[3] expected final planning state "pruned", got: ${planningStates.join(",")}`,
			);
		}
		const firstPruned = planningStates.indexOf("pruned");
		if (
			firstPruned !== -1 &&
			planningStates.slice(firstPruned).some((s) => s !== "pruned")
		) {
			errors.push(
				`[3] planning state flapped after pruning: ${planningStates.join(",")}`,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ─── Section 4: executeTask single ───────────────────────────────────

async function section4ExecuteTask(): Promise<void> {
	console.log("\n── 4. executeTask: single worker, verification passing ──");
	const dir = makeRepo();
	try {
		const result: TaskResult = await executeTask({
			cwd: dir,
			model: MODEL,
			spec: HELLO_SPEC,
			systemPrompt: SYSTEM_PROMPT,
		});
		console.log(
			`  success: ${result.success} | tests: ${result.tests} | commits: ${JSON.stringify(result.commits)}`,
		);

		check(result.success, "[4] success should be true");
		check(
			result.tests === "passing",
			`[4] tests should be "passing", got "${result.tests}"`,
		);
		check(result.commits.length > 0, "[4] commits should be non-empty");
		check(
			result.files_changed.includes("hello.txt"),
			`[4] files_changed should include hello.txt, got ${JSON.stringify(result.files_changed)}`,
		);
		check(result.verification.passed, "[4] verification should have passed");
		check(
			result.worker.usage.turns >= 1,
			`[4] turns should be >= 1, got ${result.worker.usage.turns}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ─── Section 5: executeTask parallel 2 ───────────────────────────────

async function section5Parallel(): Promise<void> {
	console.log(
		"\n── 5. executeTask: parallel 2 workers, isolated workspaces, clean merge ──",
	);
	const dir = makeRepo();
	try {
		const SPEC = `## Goal
Create two independent files in the repo root: a.txt and b.txt.

## Requirements
- R1: Create a.txt containing the text "alpha"
- R2: Create b.txt containing the text "beta"

## Verification
- test -f a.txt && grep -q alpha a.txt && test -f b.txt && grep -q beta b.txt
`;

		const result: TaskResult = await executeTask({
			cwd: dir,
			model: MODEL,
			spec: SPEC,
			systemPrompt: SYSTEM_PROMPT,
			parallel: 2,
		});
		console.log(
			`  success: ${result.success} | workers: ${result.workers?.length} | conflicts: ${JSON.stringify(result.conflicts)}`,
		);
		for (const [i, w] of (result.workers ?? []).entries()) {
			console.log(
				`  worker-${i}: turns=${w.usage.turns} reads=${w.usage.reads} commits=${JSON.stringify(w.yield.commit_ids)}`,
			);
		}

		check(result.success, "[5] success should be true");
		check(
			result.tests === "passing",
			`[5] tests should be "passing", got "${result.tests}"`,
		);
		check(
			result.conflicts !== undefined && result.conflicts.length === 0,
			`[5] no merge conflicts expected, got ${JSON.stringify(result.conflicts)}`,
		);
		check(
			result.workers !== undefined && result.workers.length === 2,
			`[5] expected 2 workers, got ${result.workers?.length}`,
		);
		check(
			result.workers !== undefined &&
				result.workers.every((w) => w.usage.turns >= 1),
			"[5] each worker should have usage.turns >= 1",
		);
		for (const f of ["a.txt", "b.txt"]) {
			check(
				result.files_changed.includes(f),
				`[5] files_changed should include ${f}, got ${JSON.stringify(result.files_changed)}`,
			);
		}
		// R5: parallel commits = EXACTLY ONE id — the merged base's commit id
		// resolved AFTER the last squash (the workers' pre-squash commits were
		// abandoned by jj squash, so their ids would be dead revisions). It must
		// RESOLVE via `jj log -r <id>` in this repo, before cleanup.
		check(
			result.commits.length === 1,
			`[5] expected exactly 1 (merged base) commit id, got ${JSON.stringify(result.commits)}`,
		);
		if (result.commits.length === 1) {
			try {
				execSync(`jj log -r ${result.commits[0]} --no-graph`, {
					cwd: dir,
					stdio: "pipe",
				});
			} catch {
				errors.push(
					`[5] returned commit id ${result.commits[0]} does not resolve via jj log -r`,
				);
			}
		}
		check(result.verification.passed, "[5] verification should have passed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ─── Section 6: repo-map full build + cache + incremental ────────────

async function section6RepoMap(): Promise<void> {
	console.log(
		"\n── 6. repo-map: full annotation build, cache hit, incremental rebuild ──",
	);
	const dir = mkdtempSync(join(tmpdir(), "pi-task-e2e-map-"));
	execSync("jj git init --colocate", { cwd: dir, stdio: "pipe" });
	for (const [rel, content] of Object.entries({
		"src/main.ts": 'import { render } from "./renderer";\nrender();\n',
		"src/utils.ts":
			"export function clamp(n: number, lo: number, hi: number): number {\n  return Math.max(lo, Math.min(hi, n));\n}\n",
		"src/calculator.ts":
			"export function add(a: number, b: number): number {\n  return a + b;\n}\n",
		"README.md": "# Demo project\n",
	})) {
		const abs = join(dir, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content);
	}
	execSync('jj commit -m "init"', { cwd: dir, stdio: "pipe" });

	try {
		// Full annotation build (the only annotation cost, amortized)
		const map = await buildMap(dir, { model: MODEL });
		check(
			map.files.length === 4,
			`[6] expected 4 files in map, got ${map.files.length}`,
		);
		check(Array.isArray(map.entryPoints), "[6] entryPoints should be an array");
		const summarized = map.files.filter(
			(f) => f.summary && f.summary.length > 0,
		).length;
		console.log(
			`  build: ${map.files.length} files, ${summarized} with summaries`,
		);
		console.log(`  entryPoints: ${JSON.stringify(map.entryPoints)}`);
		for (const f of map.files)
			console.log(
				`    ${f.path} [${f.role ?? "?"}] ${(f.summary ?? "").slice(0, 80)}`,
			);
		check(
			summarized >= 2,
			`[6] expected most files to have LLM summaries, got ${summarized}/${map.files.length}`,
		);

		// Cache hit: same tree → returned as-is (generated unchanged proves no rebuild)
		const map2 = await buildMap(dir, { model: MODEL });
		check(
			map2.generated === map.generated,
			"[6] cache hit should return the cached map (generated unchanged)",
		);
		console.log("  cache hit ✓ (generated unchanged)");

		// Incremental rebuild: edit one file → only that file re-annotated;
		// unchanged files keep their cached summaries.
		const before = new Map(map.files.map((f) => [f.path, f]));
		writeFileSync(
			join(dir, "src/calculator.ts"),
			"export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function multiply(a: number, b: number): number {\n  return a * b;\n}\n",
		);
		const map3 = await buildMap(dir, { model: MODEL });
		check(
			map3.treeHash !== map.treeHash,
			"[6] treeHash should change after edit",
		);
		const calc3 = map3.files.find((f) => f.path === "src/calculator.ts");
		const calc0 = before.get("src/calculator.ts");
		check(!!calc3 && !!calc0, "[6] calculator.ts missing");
		if (calc3 && calc0) {
			check(
				calc3.contentHash !== calc0.contentHash,
				"[6] edited file contentHash should change",
			);
		}
		const utils3 = map3.files.find((f) => f.path === "src/utils.ts");
		const utils0 = before.get("src/utils.ts");
		check(
			!!utils3 && !!utils0 && utils3.summary === utils0.summary,
			"[6] unchanged file should keep its cached summary",
		);
		console.log(
			"  incremental rebuild ✓ (changed file re-annotated, unchanged preserved)",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ─── Section 7: forked adversarial review (clean task → ship) ────────

async function section7Review(): Promise<void> {
	console.log(
		"\n── 7. Forked adversarial review: clean task → verdict ship ──",
	);
	const dir = makeRepo();
	try {
		const result: TaskResult = await executeTask({
			cwd: dir,
			model: MODEL,
			spec: HELLO_SPEC,
			systemPrompt: SYSTEM_PROMPT,
			review: true,
			reviewModel: MODEL,
			maxFixIterations: 0, // review only, no fix workers — isolates the review verdict
		});
		console.log(
			`  success: ${result.success} | tests: ${result.tests} | verdict: ${result.review?.verdict}`,
		);
		console.log(
			`  findings: ${result.review?.findings.length ?? 0} | requirements: ${JSON.stringify(result.review?.requirements)}`,
		);
		for (const f of result.review?.findings ?? []) {
			console.log(
				`    [${f.priority}] (${f.category}) ${f.file}: ${f.description.slice(0, 70)}`,
			);
		}
		console.log(`  fixLoop: ${JSON.stringify(result.fixLoop)}`);

		check(
			result.review !== undefined,
			"[7] review should be present when review enabled",
		);
		check(
			result.fixLoop !== undefined,
			"[7] fixLoop metadata should be present",
		);
		check(
			result.tests === "passing",
			`[7] tests should be passing, got ${result.tests}`,
		);
		check(result.success === true, "[7] clean task should ship (success true)");
		if (result.review) {
			check(
				["ship", "fix", "escalate"].includes(result.review.verdict),
				`[7] verdict should be valid, got ${result.review.verdict}`,
			);
			check(
				result.review.verdict === "ship",
				`[7] clean task should verdict ship, got ${result.review.verdict}`,
			);
			check(
				Array.isArray(result.review.findings),
				"[7] findings should be an array",
			);
			check(
				Array.isArray(result.review.requirements) &&
					result.review.requirements.length >= 1,
				"[7] reviewer should report at least one requirement status",
			);
		}
		if (result.fixLoop) {
			check(
				result.fixLoop.fixesDispatched === 0,
				`[7] no fix workers expected (maxFixIterations 0), got ${result.fixLoop.fixesDispatched}`,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ─── Section 8: review fix loop (dispatch a fix worker → converge) ───

async function section8FixLoop(): Promise<void> {
	console.log(
		"\n── 8. Review fix loop: failing verification → fix worker → green ──",
	);
	const dir = makeRepo();
	try {
		const result: TaskResult = await executeTask({
			cwd: dir,
			model: MODEL,
			spec: FIXLOOP_SPEC,
			systemPrompt: NO_VERIFY_PROMPT, // task worker does not self-verify
			review: true,
			reviewModel: MODEL,
			maxFixIterations: 2,
		});
		console.log(
			`  success: ${result.success} | tests: ${result.tests} | verdict: ${result.review?.verdict}`,
		);
		console.log(`  fixLoop: ${JSON.stringify(result.fixLoop)}`);
		console.log(`  files_changed: ${JSON.stringify(result.files_changed)}`);
		for (const f of result.review?.findings ?? []) {
			console.log(
				`    [${f.priority}] (${f.category}) ${f.file}: ${f.description.slice(0, 70)}`,
			);
		}

		check(
			result.fixLoop !== undefined,
			"[8] fixLoop metadata should be present",
		);
		check(
			result.tests === "passing",
			`[8] tests should converge to passing, got ${result.tests}`,
		);
		check(result.success === true, "[8] fix loop should converge to success");
		check(
			result.files_changed.includes("done.txt"),
			`[8] done.txt should exist after the loop, got ${JSON.stringify(result.files_changed)}`,
		);
		if (result.fixLoop) {
			console.log(
				`  fix workers dispatched: ${result.fixLoop.fixesDispatched}`,
			);
			check(
				result.fixLoop.fixesDispatched >= 1,
				`[8] expected >= 1 fix worker (verification stricter than the task), got ${result.fixLoop.fixesDispatched}`,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ─── Section 9: RunManifest metrics (Phase 8) ────────────────────────

async function section9Metrics(): Promise<void> {
	console.log(
		"\n── 9. RunManifest: manifest built + persisted to metricsDir ──",
	);
	const dir = makeRepo();
	const metricsDir = mkdtempSync(join(tmpdir(), "pi-task-e2e-metrics-"));
	try {
		const result: TaskResult = await executeTask({
			cwd: dir,
			model: MODEL,
			spec: HELLO_SPEC,
			systemPrompt: SYSTEM_PROMPT,
			review: true,
			reviewModel: MODEL,
			maxFixIterations: 0,
			metricsDir,
			project: "e2e-proj",
		});
		console.log(
			`  success: ${result.success} | verdict: ${result.review?.verdict}`,
		);
		console.log(`  manifestPath: ${result.manifestPath}`);
		if (result.manifest) {
			console.log(
				`  run_id: ${result.manifest.run_id} | spec_hash: ${result.manifest.task.spec_hash}`,
			);
			console.log(
				`  phases.execute: ${JSON.stringify(result.manifest.phases.execute)}`,
			);
			console.log(
				`  phases.review: ${JSON.stringify(result.manifest.phases.review)}`,
			);
			console.log(`  totals: ${JSON.stringify(result.manifest.totals)}`);
		}

		check(
			result.manifest !== undefined,
			"[9] TaskResult.manifest should be present",
		);
		check(
			result.manifestPath !== undefined && existsSync(result.manifestPath),
			"[9] manifest should be persisted",
		);

		if (result.manifest) {
			const m = result.manifest;
			check(
				/^\d{8}T\d{4}-[0-9a-f]{4}$/.test(m.run_id),
				`[9] run_id format, got ${m.run_id}`,
			);
			check(
				/^[0-9a-f]{12}$/.test(m.task.spec_hash),
				`[9] spec_hash format, got ${m.task.spec_hash}`,
			);
			check(
				m.config.execute_model === MODEL,
				`[9] config.execute_model set, got ${m.config.execute_model}`,
			);
			check(
				m.config.review_forked === true,
				"[9] review_forked should be true",
			);
			check(
				m.phases.execute !== undefined && m.phases.execute.turns >= 1,
				`[9] phases.execute present with turns, got ${JSON.stringify(m.phases.execute)}`,
			);
			check(
				m.phases.review !== null && m.phases.review !== undefined,
				"[9] phases.review should be present",
			);
			if (m.phases.review) {
				check(
					m.phases.review.forked === true,
					"[9] review forked should be true",
				);
				check(
					typeof m.phases.review.by_priority === "object",
					"[9] review by_priority should be an object",
				);
				check(
					typeof m.phases.review.context_inherited_tokens === "number",
					"[9] context_inherited_tokens present",
				);
			}
			check(
				m.totals.cost_usd > 0,
				`[9] totals.cost_usd should be > 0, got ${m.totals.cost_usd}`,
			);
			check(
				typeof m.totals.read_duplication_tokens === "number",
				"[9] read_duplication_tokens present",
			);
			check(
				m.totals.duration_ms > 0,
				`[9] totals.duration_ms should be > 0, got ${m.totals.duration_ms}`,
			);
		}

		// Persisted file parses back to a manifest with the same run_id.
		if (result.manifestPath) {
			const onDisk = JSON.parse(readFileSync(result.manifestPath, "utf-8")) as {
				run_id?: string;
			};
			check(
				onDisk.run_id === result.manifest?.run_id,
				"[9] persisted manifest round-trips the run_id",
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(metricsDir, { recursive: true, force: true });
	}
}

// ─── Section 10: task tool end-to-end (Phase 9) ──────────────────────

/** Spawn a conversational pi run with the task extension; resolve the task
 *  tool's final details (null if the model never called it). */
/** Shape of the task tool's returned details asserted by section 10
 *  (subset of TaskToolReturn plus the manifest fields checked). */
interface TaskToolDetails {
	success?: boolean;
	tests?: string;
	commits?: string[];
	files_changed?: string[];
	verification?: { passed?: boolean };
	conflicts?: unknown[];
	metrics?: { config?: { budget?: string } };
}

async function runTaskToolConversation(opts: {
	cwd: string;
	prompt: string;
	budgetFlag?: string;
}): Promise<{ details: TaskToolDetails | null; exitCode: number }> {
	const args = [
		"--mode",
		"json",
		"-e",
		TASK_EXTENSION_PATH,
		...(opts.budgetFlag ? ["--task-budget", opts.budgetFlag] : []),
		"-p",
		opts.prompt,
	];
	const proc = spawn("pi", args, {
		cwd: opts.cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let lastDetails: TaskToolDetails | null = null;
	attachJsonlReader(proc.stdout, (line: unknown) => {
		const e = line as {
			type?: string;
			toolName?: string;
			result?: { details?: TaskToolDetails };
		};
		if (e?.type === "tool_execution_end" && e.toolName === "task") {
			lastDetails = e.result?.details ?? lastDetails;
		}
	});
	const exitCode = await new Promise<number>((resolve) =>
		proc.on("close", resolve),
	);
	return { details: lastDetails, exitCode };
}

async function section10TaskTool(): Promise<void> {
	console.log(
		"\n── 10. task tool end-to-end: budget-locked conversational run → typed result ──",
	);
	const dir = makeRepo();
	try {
		// Single-worker: the model calls task({ spec }) and gets the typed
		// result (success/commits/files_changed/verification/metrics).
		const single = await runTaskToolConversation({
			cwd: dir,
			prompt: SINGLE_TOOL_PROMPT,
			budgetFlag: "free",
		});
		check(
			single.exitCode === 0,
			`[10] conversational run should exit 0, got ${single.exitCode}`,
		);
		check(
			single.details !== null,
			"[10] the model should have called the task tool",
		);
		if (single.details) {
			check(
				single.details.success === true,
				`[10] task success, got ${JSON.stringify(single.details)}`,
			);
			check(
				single.details.tests === "passing",
				`[10] tests passing, got ${single.details.tests}`,
			);
			check(
				Array.isArray(single.details.commits) &&
					single.details.commits.length > 0,
				"[10] commits should be non-empty",
			);
			check(
				single.details.files_changed?.includes("hello.txt") === true,
				`[10] files_changed should include hello.txt, got ${JSON.stringify(single.details.files_changed)}`,
			);
			check(
				single.details.verification?.passed === true,
				"[10] verification should have passed",
			);
			// Phase 10: the manifest carries the resolved tier — the run is
			// budget-locked to free, so config.budget must say "free" (not
			// the "default" placeholder).
			check(
				single.details.metrics?.config?.budget === "free",
				`[10] manifest config.budget should be "free" (budget-locked run), got ${JSON.stringify(single.details.metrics?.config?.budget)}`,
			);
		}

		// sub_specs parallel: one isolated worker per sub-spec, no cross-
		// leakage (each file appears exactly once) and a clean merge.
		const par = await runTaskToolConversation({
			cwd: dir,
			prompt: SUBSPECS_TOOL_PROMPT,
			budgetFlag: "free",
		});
		check(
			par.exitCode === 0,
			`[10b] sub_specs run should exit 0, got ${par.exitCode}`,
		);
		check(
			par.details !== null,
			"[10b] the model should have called task with sub_specs",
		);
		if (par.details) {
			check(
				par.details.success === true,
				`[10b] sub_specs success, got ${JSON.stringify(par.details)}`,
			);
			check(
				par.details.conflicts !== undefined &&
					par.details.conflicts.length === 0,
				`[10b] no merge conflicts expected, got ${JSON.stringify(par.details.conflicts)}`,
			);
			const files: string[] = par.details.files_changed ?? [];
			check(
				files.includes("a.txt") && files.includes("b.txt"),
				`[10b] both files expected, got ${JSON.stringify(files)}`,
			);
			const dupes = files.filter((f, i) => files.indexOf(f) !== i);
			check(
				dupes.length === 0,
				`[10b] no duplicated files (scope leak) expected, got ${JSON.stringify(files)}`,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ─── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	console.log(
		`test-e2e: real pi + real LLM (hardcoded model: ${MODEL} — the only model in this suite)`,
	);
	const start = Date.now();

	await section1RunWorker();
	await section2Abort();
	await section3ChecklistAndPrewalk();
	await section4ExecuteTask();
	await section5Parallel();
	await section6RepoMap();
	await section7Review();
	await section8FixLoop();
	await section9Metrics();
	await section10TaskTool();

	if (errors.length > 0) {
		console.error("\nASSERTIONS FAILED:");
		for (const e of errors) console.error(`  ✗ ${e}`);
		process.exit(1);
	}
	console.log(
		`\n✓ All e2e sections passed in ${((Date.now() - start) / 1000).toFixed(0)}s (model: ${MODEL}).`,
	);
}

// Guard: only run when executed directly (never on import — this file
// drives real LLM calls and must not be triggered by test.ts or tooling).
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((err: unknown) => {
		console.error("E2E TEST FAILED:", (err as Error).message ?? err);
		process.exit(1);
	});
}
