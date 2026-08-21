/**
 * Orchestrator hermetic tests — spec parsing, spec splitting, and the
 * verification runner against real bash on a temp dir. No worker spawns,
 * no LLM. (executeTask's worker-facing wiring is e2e territory.)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseSpec, SpecError } from "./schemas/spec.ts";
import {
	runVerification,
	splitSpec,
	aggregateSubSpecs,
	decideFixLoop,
	blockersOf,
	isBlocker,
	buildFixPrompt,
	capFixOutput,
	parseDiffStat,
	classifyOverlapDiffs,
	isFinalizationIncomplete,
	classifyWorkerFailures,
	buildRecoveryGuide,
	resolveReviewGate,
	resolveReviewAxes,
	PARALLEL_REVIEW_PERSONA,
	decideTurnBudgetAction,
	turnBudgetNudgeMessage,
	outputSignature,
	isBrokenVerificationCommand,
	captureVerificationBaseline,
	classifyVerificationFailures,
	adjudicateDisputes,
	BASELINE_SIGNATURE_CAP,
	type VerificationBaselineEntry,
} from "./orchestrator.ts";
import { DEFAULT_PERSONA, getPersona, type Persona } from "./personas.ts";
import { DEFAULT_TASK_SHAPES } from "./config.ts";
import type { ChecklistProgress } from "./checklist-relay.ts";
import type { Finding, ReviewResult } from "./schemas/findings.ts";

const SPEC = `## Goal
Create a file hello.txt containing the text "hi".

## Requirements
- R1: Create hello.txt with content "hi"
- R2: Commit the change with jj using the message "add hello.txt"

## Verification
- test -f hello.txt && grep -q hi hello.txt
`;

/** Spec parsing: good spec + SpecError messages for bad specs. */
function testSpecParsing(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const good = parseSpec(SPEC);
	check(good.requirements.length === 2, `expected 2 requirements, got ${good.requirements.length}`);
	check(good.verification.length === 1, `expected 1 verification command, got ${good.verification.length}`);
	check(good.goal.includes("hello.txt"), "goal should mention hello.txt");

	const cases: Array<[string, string]> = [
		["## Goal\nNothing here.\n", "Requirements"],
		["## Goal\nX\n## Requirements\n- R1: do thing\n", "Verification"],
		["## Goal\nX\n## Verification\n- true\n", "Requirements"],
	];
	for (const [markdown, expected] of cases) {
		try {
			parseSpec(markdown);
			errors.push(`expected SpecError mentioning "${expected}" for: ${markdown.trim().split("\n")[0]}`);
		} catch (e) {
			if (!(e instanceof SpecError)) errors.push(`expected SpecError, got ${(e as Error).constructor.name}`);
			else if (!e.message.includes(expected)) errors.push(`SpecError should mention "${expected}", got: ${e.message}`);
		}
	}
	console.log("✓ parseSpec: good spec + SpecError messages");
}

/** splitSpec: round-robin partitioning preserves requirement ids. */
function testSplitSpec(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const spec = parseSpec(
		"## Goal\nG\n## Requirements\n- R1: one\n- R2: two\n- R3: three\n- R4: four\n## Verification\n- true\n",
	);
	const parts = splitSpec(spec, 2);

	check(parts[0].includes("R1: one") && parts[0].includes("R3: three"),
		`worker 0 should get R1, R3 (round-robin), got: ${parts[0]}`);
	check(parts[1].includes("R2: two") && parts[1].includes("R4: four"),
		`worker 1 should get R2, R4 (round-robin), got: ${parts[1]}`);
	check(!parts[0].includes("R2: two") && !parts[1].includes("R1: one"), "requirements must not leak across workers");
	check(parts[0].includes("## Goal") && parts[0].includes("## Verification"), "sub-task should keep Goal and Verification sections");
	check(parts[0].includes("## Scope") && parts[0].toLowerCase().includes("implement only the requirements listed"),
		"sub-task should carry the Scope contract pinning the listed requirements");
	check(parts.length === 2, `expected 2 sub-tasks, got ${parts.length}`);
	console.log("✓ splitSpec: round-robin partitioning");
}

/** aggregateSubSpecs: per-sub-spec validation + union aggregation (Phase 9). */
function testAggregateSubSpecs(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// Two self-contained sub-specs → unioned requirements + verification.
	const agg = aggregateSubSpecs([
		`## Goal\nCreate a.txt.\n## Requirements\n- R1: create a.txt\n## Verification\n- test -f a.txt\n`,
		`## Goal\nCreate b.txt.\n## Requirements\n- R1: create b.txt\n- R2: commit it\n## Verification\n- test -f b.txt\n`,
	]);
	check(agg.requirements.length === 3, `expected 3 unioned requirements, got ${agg.requirements.length}`);
	check(agg.verification.length === 2, `expected 2 unioned verification commands, got ${agg.verification.length}`);
	check(agg.goal === "Create a.txt.", `goal should be the first sub-spec's, got "${agg.goal}"`);
	check(agg.verification.includes("test -f a.txt") && agg.verification.includes("test -f b.txt"),
		"union verification should include both sub-specs' commands");

	// Invalid sub-spec → SpecError naming the index.
	try {
		aggregateSubSpecs([
			`## Goal\nOk.\n## Requirements\n- R1: x\n## Verification\n- true\n`,
			`## Goal\nMissing verification.\n## Requirements\n- R1: y\n`,
		]);
		errors.push("aggregateSubSpecs should reject a sub-spec without Verification");
	} catch (e) {
		if (!(e instanceof SpecError)) errors.push(`expected SpecError, got ${(e as Error).constructor.name}`);
		else if (!e.message.includes("sub_specs[1]")) errors.push(`error should name sub_specs[1], got: ${e.message}`);
	}

	// Empty requirement in the FIRST sub-spec → index 0 named.
	try {
		aggregateSubSpecs([`## Goal\nNo requirements.\n## Verification\n- true\n`]);
		errors.push("aggregateSubSpecs should reject a sub-spec without Requirements");
	} catch (e) {
		if (!(e instanceof SpecError)) errors.push(`expected SpecError, got ${(e as Error).constructor.name}`);
		else if (!e.message.includes("sub_specs[0]")) errors.push(`error should name sub_specs[0], got: ${e.message}`);
	}

	console.log("✓ aggregateSubSpecs: union aggregation + index-named errors");
}

/** runVerification: real bash on a temp dir — passing/failing/timeout. */
async function testRunVerification(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const dir = mkdtempSync(join(tmpdir(), "pi-task-verify-"));
	try {
		// Passing command
		const pass = await runVerification(["true"], dir, 5000);
		check(pass.passed === true, "true should pass");
		check(pass.failures.length === 0, "passing run should have no failures");
		check(pass.commands === 1, `commands should be 1, got ${pass.commands}`);

		// Failing command: exit code captured
		const fail = await runVerification(["exit 3"], dir, 5000);
		check(fail.passed === false, "exit 3 should fail");
		check(fail.failures.length === 1, `expected 1 failure, got ${fail.failures.length}`);
		check(fail.failures[0].exitCode === 3, `exit code should be 3, got ${fail.failures[0].exitCode}`);
		check(fail.failures[0].command === "exit 3", "failure should carry the command");

		// Output captured (stdout + stderr joined)
		const noisy = await runVerification(["echo oops && echo more 1>&2 && exit 1"], dir, 5000);
		check(noisy.failures[0].exitCode === 1, `exit code should be 1, got ${noisy.failures[0].exitCode}`);
		check(noisy.failures[0].output.includes("oops") && noisy.failures[0].output.includes("more"),
			`output should capture stdout+stderr, got: ${JSON.stringify(noisy.failures[0].output)}`);

		// Multiple commands: all run, failures aggregated
		const multi = await runVerification(["true", "exit 7", "false"], dir, 5000);
		check(multi.commands === 3, `commands should be 3, got ${multi.commands}`);
		check(multi.failures.length === 2, `expected 2 failures, got ${multi.failures.length}`);
		check(multi.failures[0].exitCode === 7 && multi.failures[1].exitCode === 1,
			"failures should be in command order with correct codes");

		// Empty command list passes vacuously
		const empty = await runVerification([], dir, 5000);
		check(empty.passed === true && empty.commands === 0, "empty command list should pass");

		// Timeout path: sleep killed → exit code 124
		const timeout = await runVerification(["sleep 5"], dir, 300);
		check(timeout.failures[0].exitCode === 124, `timeout should report exit code 124, got ${timeout.failures[0].exitCode}`);
		check(timeout.timed_out === true, "timed_out flag set when a command hits its bound");
		check(pass.timed_out === undefined || pass.timed_out === false, "timed_out not set on a clean pass");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("✓ runVerification: pass, fail, output, aggregate, timeout");
}

/** Fix-loop control + blocker policy + fix-prompt assembly (pure). */
function testFixLoop(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const reviewWith = (...priorities: Array<"P0" | "P1" | "P2" | "P3">): ReviewResult => ({
		verdict: "fix",
		findings: priorities.map((p, i) => ({
			id: `F${i + 1}`, priority: p, confidence: 0.9, category: "test-quality",
			file: `f${i}.ts`, description: `issue ${i}`, verification: "run the test",
		})),
		requirements: [{ id: "R1", status: "met" }],
	});

	// isBlocker / blockersOf: P0/P1 block, P2/P3 do not
	check(isBlocker({ priority: "P0" } as Finding) && isBlocker({ priority: "P1" } as Finding), "P0/P1 are blockers");
	check(!isBlocker({ priority: "P2" } as Finding) && !isBlocker({ priority: "P3" } as Finding), "P2/P3 are not blockers");
	check(blockersOf(reviewWith("P0", "P2", "P1", "P3")).length === 2, "blockersOf keeps only P0/P1");

	// decideFixLoop: clean → ship
	check(decideFixLoop({ testsPass: true, review: reviewWith(), fixesUsed: 0, maxFixes: 2 }) === "ship", "clean (pass, no findings) → ship");
	check(decideFixLoop({ testsPass: true, review: reviewWith("P2", "P3"), fixesUsed: 0, maxFixes: 2 }) === "ship", "pass + only P2/P3 → ship");

	// not clean + budget → fix
	check(decideFixLoop({ testsPass: false, review: reviewWith(), fixesUsed: 0, maxFixes: 2 }) === "fix", "failing tests + budget → fix");
	check(decideFixLoop({ testsPass: true, review: reviewWith("P1"), fixesUsed: 1, maxFixes: 2 }) === "fix", "P1 blocker + budget → fix");

	// not clean + out of budget → escalate
	check(decideFixLoop({ testsPass: false, review: reviewWith(), fixesUsed: 2, maxFixes: 2 }) === "escalate", "failing + no budget → escalate");
	check(decideFixLoop({ testsPass: true, review: reviewWith("P0"), fixesUsed: 2, maxFixes: 2 }) === "escalate", "P0 + no budget → escalate");
	check(decideFixLoop({ testsPass: false, review: null, fixesUsed: 0, maxFixes: 0 }) === "escalate", "maxFixes 0 + failing → escalate");

	// review disabled (null): verification-only loop
	check(decideFixLoop({ testsPass: true, review: null, fixesUsed: 0, maxFixes: 2 }) === "ship", "review off + pass → ship");
	check(decideFixLoop({ testsPass: false, review: null, fixesUsed: 0, maxFixes: 2 }) === "fix", "review off + fail + budget → fix");

	// buildFixPrompt assembly
	const prompt = buildFixPrompt({
		specMarkdown: "## Goal\nG\n## Requirements\n- R1: x\n## Verification\n- true",
		failures: [{ command: "npm test", exitCode: 1, output: "FAIL boom" }],
		findings: blockersOf(reviewWith("P0")),
	});
	check(prompt.includes("## Spec") && prompt.includes("R1: x"), "fix prompt carries the spec");
	check(prompt.includes("## Verification failures") && prompt.includes("npm test") && prompt.includes("FAIL boom"), "fix prompt carries failures");
	check(prompt.includes("## Review findings") && prompt.includes("[P0]"), "fix prompt carries P0/P1 findings");
	check(prompt.includes("yield()"), "fix prompt instructs yield");

	const noFail = buildFixPrompt({ specMarkdown: "s", failures: [], findings: blockersOf(reviewWith("P1")) });
	check(!noFail.includes("Verification failures"), "no failures section when failures empty");
	const noFind = buildFixPrompt({ specMarkdown: "s", failures: [], findings: [] });
	check(!noFind.includes("Review findings"), "no findings section when findings empty");

	// capFixOutput: long suite output is truncated for the fix prompt.
	const verbose = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
	const capped = capFixOutput(verbose);
	check(capped.includes("line 0") && capped.includes("more lines truncated"), "verbose output is capped with a pointer");
	const short = capFixOutput("one line");
	check(short === "one line" && !short.includes("truncated"), "short output is untouched");
	const exact = Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n");
	check(capFixOutput(exact) === exact, "output at the cap is untouched");

	console.log("✓ fix loop: decideFixLoop, blocker policy, buildFixPrompt");
}

/** parseDiffStat: added/removed line counts from `jj diff --git` output
 *  (R1 diff stats — the pure half of the orchestrator's diff-stat wiring). */
function testParseDiffStat(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// Added/removed lines counted; +++/--- hunk headers excluded.
	const diff = [
		"diff --git a/a.ts b/a.ts",
		"--- a/a.ts",
		"+++ b/a.ts",
		"@@ -1,1 +1,3 @@",
		" unchanged",
		"+added line",
		"-removed line",
		"+another added",
		"",
	].join("\n");
	const s = parseDiffStat(diff);
	check(s.insertions === 2 && s.deletions === 1,
		`expected 2 insertions / 1 deletion, got ${s.insertions}/${s.deletions}`);

	// New-file diff: +++ header at content start must not count.
	const newFile = [
		"diff --git a/new.txt b/new.txt",
		"new file mode 100644",
		"index 0000000..3b18e5d",
		"--- /dev/null",
		"+++ b/new.txt",
		"@@ -0,0 +1,2 @@",
		"+one",
		"+two",
	].join("\n");
	check(parseDiffStat(newFile).insertions === 2 && parseDiffStat(newFile).deletions === 0,
		"new-file diff: only content lines count");

	// Empty / header-only / binary diffs count nothing.
	check(parseDiffStat("").insertions === 0 && parseDiffStat("").deletions === 0, "empty diff → 0/0");
	const headersOnly = "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n";
	check(parseDiffStat(headersOnly).insertions === 0 && parseDiffStat(headersOnly).deletions === 0,
		"header-only diff → 0/0");
	const binary = "diff --git a/img.png b/img.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files differ\n";
	check(parseDiffStat(binary).insertions === 0 && parseDiffStat(binary).deletions === 0, "binary diff → 0/0");

	// Multi-file diff sums across files.
	const multi = [
		"diff --git a/x.ts b/x.ts",
		"--- a/x.ts",
		"+++ b/x.ts",
		"@@ -1 +1 @@",
		"-old",
		"+new",
		"diff --git a/y.ts b/y.ts",
		"--- a/y.ts",
		"+++ b/y.ts",
		"@@ -1 +1,2 @@",
		"+one",
		"+two",
	].join("\n");
	const ms = parseDiffStat(multi);
	check(ms.insertions === 3 && ms.deletions === 1,
		`multi-file sums (3/1), got ${ms.insertions}/${ms.deletions}`);

	console.log("✓ parseDiffStat: added/removed line counts (hunk headers excluded)");
}

/** classifyOverlapDiffs: R5 pre-merge overlap classification — comment/
 *  whitespace-only overlaps take the deterministic union path (R4),
 *  substantive overlaps are flagged in the merge report before merging. */
function testClassifyOverlapDiffs(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// All changed lines are comments (any language prefix) → union path.
	const commentDiffs = [
		"diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-// old note\n+// new note\n",
		"diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-/* block */\n+/* other */\n",
	];
	check(classifyOverlapDiffs(commentDiffs) === "comment-only",
		"comment-only lines (// and /*) → comment-only");

	// Language-agnostic prefixes: # -- ; ' <!-- and whitespace-only lines.
	const prefixDiffs = [
		"--- a/a.py\n+++ b/a.py\n-# old\n+# new\n",
		"--- a/a.sql\n+++ b/a.sql\n--- old\n+-- new\n",
		"--- a/a.ini\n+++ b/a.ini\n-; old\n+; new\n",
	];
	check(classifyOverlapDiffs(prefixDiffs) === "comment-only", "# -- ; comment prefixes → comment-only");
	const wsDiffs = ["--- a/a.ts\n+++ b/a.ts\n-   \n+    \n"];
	check(classifyOverlapDiffs(wsDiffs) === "comment-only", "whitespace-only lines → comment-only");
	check(classifyOverlapDiffs([]) === "comment-only", "empty diffs → comment-only (vacuous)");

	// Headers and context lines are never treated as changed lines.
	const headerOnly = ["diff --git a/x b/x\nindex 000..111\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n context\n"];
	check(classifyOverlapDiffs(headerOnly) === "comment-only", "headers/context only → comment-only");

	// ANY worker changing a code line (or a binary file) → substantive.
	const codeDiffs = [
		"--- a/x.ts\n+++ b/x.ts\n-// note\n+// note\n",
		"--- a/x.ts\n+++ b/x.ts\n-const a = 1;\n+const a = 2;\n",
	];
	check(classifyOverlapDiffs(codeDiffs) === "substantive", "one worker's code line → substantive");
	check(classifyOverlapDiffs(["--- a/x\n+++ b/x\n+code()\n"]) === "substantive", "added code line → substantive");
	check(classifyOverlapDiffs(["Binary files differ\n"]) === "substantive", "binary diff → substantive");
	// A comment-only worker plus a code-changing worker → substantive.
	check(classifyOverlapDiffs([commentDiffs[0], codeDiffs[1]]) === "substantive", "mixed comment + code → substantive");

	console.log("✓ classifyOverlapDiffs: comment/whitespace → union path, code/binary → substantive (R5)");
}

/** isFinalizationIncomplete / classifyWorkerFailures: the R2 third-outcome
 *  classification — an aborted worker whose checklist relay showed ALL
 *  requirements done at abort (the worker committed everything and was
 *  verifying/yielding) drives the merge attempt instead of a flat failure. */
function testFinalizationIncomplete(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// Null / uninitialized / partial progress → NOT finalization-incomplete.
	check(isFinalizationIncomplete(null) === false, "null progress → not finalization-incomplete");
	check(isFinalizationIncomplete({ done: 0, total: 3 } as ChecklistProgress) === false, "0/3 → not");
	check(isFinalizationIncomplete({ done: 2, total: 3 } as ChecklistProgress) === false, "2/3 (mid-work) → not");
	check(isFinalizationIncomplete({ done: 0, total: 0 } as ChecklistProgress) === false,
		"0/0 (never initialized) → not");

	// All requirements done at abort → finalization-incomplete (defensive:
	// done >= total — the relay never over-reports, but a stale total must
	// not flip the class back to mid-work).
	check(isFinalizationIncomplete({ done: 3, total: 3 } as ChecklistProgress) === true, "3/3 → finalization-incomplete");
	check(isFinalizationIncomplete({ done: 5, total: 3 } as ChecklistProgress) === true,
		"done ≥ total → finalization-incomplete (defensive)");

	// classifyWorkerFailures: EVERY failed worker must be
	// finalization-incomplete for the run to attempt the merge.
	check(classifyWorkerFailures([]) === "abort", "no failed workers → abort (vacuous)");
	check(classifyWorkerFailures([null]) === "abort", "unclassified failed worker → abort");
	check(classifyWorkerFailures([{ done: 1, total: 2 } as ChecklistProgress]) === "abort", "mid-work failed worker → abort");
	check(
		classifyWorkerFailures([
			{ done: 2, total: 2 } as ChecklistProgress,
			{ done: 1, total: 1 } as ChecklistProgress,
		]) === "merge",
		"all failed workers finalization-incomplete → merge",
	);
	check(
		classifyWorkerFailures([
			{ done: 2, total: 2 } as ChecklistProgress,
			null,
		]) === "abort",
		"one unclassified failed worker → abort",
	);
	check(
		classifyWorkerFailures([
			{ done: 2, total: 2 } as ChecklistProgress,
			{ done: 1, total: 2 } as ChecklistProgress,
		]) === "abort",
		"one mid-work failed worker → abort (mixed class)",
	);

	console.log("✓ finalization-incomplete classification: all-done-at-abort drives the merge attempt (R2)");
}

/** buildRecoveryGuide: the R4 scripted recovery guide the merge/worker-
 *  failure artifact carries — stacking commands, the stub-abandon-before-
 *  push warning, and the add-vs-delete :ours/:theirs warning. */
function testRecoveryGuide(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const guide = buildRecoveryGuide({
		cause: "Parallel workers failed: wall-clock budget expired",
		workspaces: [
			{ name: "pi-task-ab1-0", commit_id: "aaaa", rescue_commit_id: "bbbb" },
			{ name: "pi-task-ab1-1", commit_id: "cccc" },
		],
	});

	// Stacking commands: discover → rebase in dependency order → squash.
	check(guide.includes("jj workspace list"), "guide names the workspace discovery command");
	check(guide.includes("jj log -r all()"), "guide names the commit discovery command");
	check(guide.includes("jj rebase -s"), "guide stacks the workspaces with jj rebase");
	check(guide.includes("jj squash --from"), "guide squashes the stacked commits into the base");
	check(guide.includes("Re-resolve ids AFTER every command"), "guide warns about stale ids after rebase");

	// Stub-abandon-before-push warning (description-less commits refuse push).
	check(guide.includes("BEFORE pushing"), "guide warns about pushing");
	check(guide.includes("description-less"), "guide warns that description-less commits refuse push");
	check(guide.includes("jj abandon"), "guide abandons the AI base/stubs");
	check(guide.includes("empty description"), "guide tells how to verify no empty descriptions remain");

	// Add-vs-delete conflict warning (:ours/:theirs, not mid-stack abandon).
	check(guide.includes("Add-vs-delete"), "guide warns about add-vs-delete conflicts");
	check(guide.includes(":ours") && guide.includes(":theirs"), "guide resolves via :ours/:theirs");
	check(guide.includes("mid-stack abandon"), "guide warns against mid-stack abandon");

	// The rescued uncommitted state is named where it lives.
	check(guide.includes("bbbb") && guide.includes("pi-task-ab1-0"), "guide names the rescue commit + workspace");

	console.log("✓ recovery guide: stacking + stub-abandon + add-vs-delete warnings (R4)");
}

/** resolveReviewGate (R1/R6): the forked nested review runs ONLY on shapes
 *  that declare review axes — the axes are a required precondition for the
 *  tier's review flag AND the persona override alike. An axis-less shape
 *  (analysis: surveys are a single task, the worker IS the review) never
 *  forks, whatever is requested; the request surfaces as the skipped
 *  disposition instead. Gating keys on DECLARED AXES, never the shape name. */
function testReviewGate(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// Analysis shape (review: []): NEVER forks — persona, flag, or both.
	{
		const none = resolveReviewGate({}, DEFAULT_TASK_SHAPES.analysis);
		const flag = resolveReviewGate({ review: true }, DEFAULT_TASK_SHAPES.analysis);
		const persona = resolveReviewGate({ persona: "adversarial" }, DEFAULT_TASK_SHAPES.analysis);
		const both = resolveReviewGate({ review: true, persona: "adversarial" }, DEFAULT_TASK_SHAPES.analysis);
		for (const [name, gate] of Object.entries({ none, flag, persona, both })) {
			check(gate.enabled === false, `analysis + ${name}: no forked review`);
		}
		check(none.requested === false && none.skipped === false,
			"analysis + nothing requested: not requested, not skipped");
		for (const [name, gate] of Object.entries({ flag, persona, both })) {
			check(gate.requested === true && gate.skipped === true,
				`analysis + ${name}: requested but skipped (the result's reviewSkipped disposition)`);
		}
	}

	// Code shape (declares axes): the flag or a persona forks; nothing → no review.
	{
		const none = resolveReviewGate({}, DEFAULT_TASK_SHAPES.code);
		check(none.enabled === false && none.requested === false && none.skipped === false,
			"code + nothing: no review requested");
		const flag = resolveReviewGate({ review: true }, DEFAULT_TASK_SHAPES.code);
		check(flag.enabled === true && flag.skipped === false, "code + review flag: forks");
		const persona = resolveReviewGate({ persona: "adversarial" }, DEFAULT_TASK_SHAPES.code);
		check(persona.enabled === true && persona.skipped === false, "code + persona: forks");
		const off = resolveReviewGate({ review: false }, DEFAULT_TASK_SHAPES.code);
		check(off.enabled === false && off.requested === false, "code + explicit false: not requested");
	}

	// Declared axes, not the shape name, decide: a hypothetical custom shape
	// with axes still forks; the batch shape (no axes) never does.
	{
		const custom = { ...DEFAULT_TASK_SHAPES.code, review: ["adversarial"] };
		check(resolveReviewGate({ review: true }, custom).enabled === true,
			"custom shape declaring axes still forks");
		check(resolveReviewGate({ persona: "adversarial" }, custom).enabled === true,
			"custom shape declaring axes forks on a persona too");
		check(resolveReviewGate({ review: true, persona: "adversarial" }, DEFAULT_TASK_SHAPES.batch).enabled === false,
			"batch shape (no axes) never forks");
	}

	console.log("✓ resolveReviewGate: axes are the fork precondition (analysis never forks; code/custom-axes do)");
}

/** resolveReviewAxes (R1/R2/R6): fork selection for a single-run review. */
function testReviewAxes(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const names = (axes: Persona[]): string[] => axes.map((p) => p.name);

	// Default (R1): NO persona override → EXACTLY ONE adversarial fork,
	// regardless of how many axes the shape declares.
	{
		const axes = resolveReviewAxes(undefined, DEFAULT_TASK_SHAPES.code);
		check(JSON.stringify(names(axes)) === JSON.stringify(["adversarial"]),
			`default code shape must fork ONE adversarial reviewer, got ${JSON.stringify(names(axes))}`);
		check(axes[0] === DEFAULT_PERSONA, "the default fork IS the DEFAULT_PERSONA");
		check(axes.length === 1 && axes[0]?.output.kind === "findings", "exactly one findings fork");
		// Undefined shape → the code default, still one adversarial fork.
		check(JSON.stringify(names(resolveReviewAxes(undefined, undefined))) === JSON.stringify(["adversarial"]),
			"undefined shape → one adversarial fork");
	}

	// Explicit opt-in (R2): persona "parallel" → the shape's FULL declared
	// axis set as parallel forks (the old default); falls back to the single
	// adversarial fork when none of the declared axes resolve.
	{
		const axes = resolveReviewAxes(PARALLEL_REVIEW_PERSONA, DEFAULT_TASK_SHAPES.code);
		check(JSON.stringify(names(axes)) === JSON.stringify(["standards", "spec-fidelity", "architecture"]),
			`persona "parallel" must fork the full shape axis set, got ${JSON.stringify(names(axes))}`);
		const emptyAxes = resolveReviewAxes(PARALLEL_REVIEW_PERSONA, { ...DEFAULT_TASK_SHAPES.code, review: [] });
		check(JSON.stringify(names(emptyAxes)) === JSON.stringify(["adversarial"]),
			`"parallel" with unresolvable axes falls back to [DEFAULT_PERSONA], got ${JSON.stringify(names(emptyAxes))}`);
		// "parallel" is NOT resolved via getPersona — it is a sentinel.
		check(getPersona(PARALLEL_REVIEW_PERSONA) === undefined, '"parallel" is not a registered persona');
	}

	// A single named persona → exactly that one axis (never the full set).
	{
		const adv = resolveReviewAxes("adversarial", DEFAULT_TASK_SHAPES.code);
		check(JSON.stringify(names(adv)) === JSON.stringify(["adversarial"]),
			`named "adversarial" → one adversarial fork, got ${JSON.stringify(names(adv))}`);
		const arch = resolveReviewAxes("architecture", DEFAULT_TASK_SHAPES.code);
		check(JSON.stringify(names(arch)) === JSON.stringify(["architecture"]),
			`named "architecture" → one architecture fork, got ${JSON.stringify(names(arch))}`);
		// Unknown persona name → falls back to the single default adversarial fork.
		const unknown = resolveReviewAxes("not-a-persona", DEFAULT_TASK_SHAPES.code);
		check(JSON.stringify(names(unknown)) === JSON.stringify(["adversarial"]),
			`unknown persona name → single valid default fork, got ${JSON.stringify(names(unknown))}`);
	}

	// R3: the manifest must record the ACTUAL axes — the default one-adversarial
	// tuple, or the full set under "parallel" (drive the same mapping the
	// orchestrator uses for personas: effectiveAxes.map((p) => p.name)).
	{
		check(JSON.stringify(names(resolveReviewAxes(undefined, DEFAULT_TASK_SHAPES.code))) === JSON.stringify(["adversarial"]),
			"manifest personas for a default run = ['adversarial']");
		check(JSON.stringify(names(resolveReviewAxes(PARALLEL_REVIEW_PERSONA, DEFAULT_TASK_SHAPES.code))) ===
			JSON.stringify(["standards", "spec-fidelity", "architecture"]),
			"manifest personas for a 'parallel' run = the full axis set");
	}

	console.log("✓ resolveReviewAxes: default = one adversarial fork; 'parallel' = full axis set; named = one axis");
}


// ─── Verification lifecycle: baseline evidence (spec-defect adjudication) ──

function testVerificationLifecycle(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// outputSignature: head-bounded.
	check(outputSignature("short") === "short", "short output → unchanged");
	const long = "x".repeat(BASELINE_SIGNATURE_CAP + 500);
	check(outputSignature(long).length === BASELINE_SIGNATURE_CAP, "long output → capped");

	// isBrokenVerificationCommand: narrow (only unambiguous shell breakage).
	const entry = (exitCode: number, signature: string): VerificationBaselineEntry => ({ command: "c", exitCode, signature });
	check(isBrokenVerificationCommand(entry(127, "not found")) === true, "exit 127 (command not found) → broken");
	check(isBrokenVerificationCommand(entry(2, "bash: line 1: syntax error near unexpected token")) === true, "exit 2 + syntax error → broken");
	check(isBrokenVerificationCommand(entry(2, "grep: no match")) === false, "exit 2 without syntax error → NOT broken");
	check(isBrokenVerificationCommand(entry(1, "FAIL some test")) === false, "exit 1 (legit red) → NOT broken");
	check(isBrokenVerificationCommand(entry(0, "")) === false, "exit 0 → NOT broken");

	// classifyVerificationFailures: baseline evidence splits the failures.
	const baseline: VerificationBaselineEntry[] = [
		{ command: "good", exitCode: 1, signature: "old failure text" },
		{ command: "badgrep", exitCode: 1, signature: "" },
	];
	const split = classifyVerificationFailures(
		[
			{ command: "good", exitCode: 1, output: "real failure" }, // output differs from baseline → actionable
			{ command: "badgrep", exitCode: 1, output: "" }, // identical to baseline → spec defect
			{ command: "unknown", exitCode: 1, output: "x" }, // not in baseline → actionable (conservative)
		],
		baseline,
	);
	check(split.specDefectSuspected.length === 1 && split.specDefectSuspected[0].command === "badgrep",
		`baseline-identical failure → spec defect, got ${JSON.stringify(split.specDefectSuspected.map((f) => f.command))}`);
	check(split.actionable.length === 2, `the rest are actionable, got ${split.actionable.length}`);
	// A failure whose OUTPUT changed vs baseline is actionable (the change mattered).
	const split2 = classifyVerificationFailures([{ command: "badgrep", exitCode: 1, output: "now it matches something" }], baseline);
	check(split2.actionable.length === 1 && split2.specDefectSuspected.length === 0, "output changed vs baseline → actionable");
}

async function testVerificationBaselineCapture(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-task-vbaseline-"));
	try {
		// Healthy commands record a baseline (exit 0 and a legit red), no throw.
		const baseline = await captureVerificationBaseline(
			["test -f " + join(dir, "nope.txt"), "true"],
			dir,
			10_000,
		);
		check(baseline.length === 2, "baseline records every command");
		check(baseline[0].exitCode === 1, `legit red recorded (test -f missing), got exit ${baseline[0].exitCode}`);
		check(baseline[1].exitCode === 0, "green recorded");

		// A broken command (exit 127) rejects the dispatch BEFORE any worker.
		let threw = "";
		try {
			await captureVerificationBaseline(["definitely-not-a-real-cmd-xyz"], dir, 10_000);
		} catch (err) {
			threw = (err as Error).message;
		}
		check(threw.includes("broken") && threw.includes("definitely-not-a-real-cmd-xyz"),
			`broken command rejects dispatch, got: ${threw.slice(0, 80)}`);

		// A shell syntax error (exit 2) also rejects.
		let threw2 = "";
		try {
			await captureVerificationBaseline(["if then fi (((("], dir, 10_000);
		} catch (err) {
			threw2 = (err as Error).message;
		}
		check(threw2.includes("broken"), `syntax error rejects dispatch, got: ${threw2.slice(0, 80)}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ─── dispute_verification adjudication (never unilateral) ────────────

function testDisputeAdjudication(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const baseline: VerificationBaselineEntry[] = [
		{ command: "badgrep", exitCode: 1, signature: "" },
		{ command: "flaky", exitCode: 1, signature: "attempt A output" },
	];
	const failures = [
		{ command: "badgrep", exitCode: 1, output: "" }, // baseline-identical
		{ command: "flaky", exitCode: 1, output: "attempt B output" }, // differs from baseline
	];
	const adjudicated = adjudicateDisputes(
		[
			{ command: "badgrep", reason: "pattern substring-matches a live symbol" },
			{ command: "flaky", reason: "I think it is wrong" },
			{ command: "passing", reason: "disliked" }, // not even failing
		],
		failures,
		baseline,
	);
	check(JSON.stringify(adjudicated.upheld) === JSON.stringify(["badgrep"]),
		`only the baseline-identical dispute is upheld, got ${JSON.stringify(adjudicated.upheld)}`);
	check(adjudicated.rejected.length === 2 && adjudicated.rejected.some((d) => d.command === "flaky"),
		`differs-from-baseline and non-failing disputes are rejected, got ${JSON.stringify(adjudicated.rejected.map((d) => d.command))}`);
	check(adjudicateDisputes([], failures, baseline).upheld.length === 0, "no disputes → nothing upheld");
}

// ─── Turn budget (Phase 3): bounded autonomy ─────────────────────────

function testTurnBudget(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	// No budget → never acts.
	check(decideTurnBudgetAction(500, undefined, false) === "none", "no budget → none");
	check(decideTurnBudgetAction(500, 0, false) === "none", "zero budget → none");
	// Under the soft threshold → none.
	check(decideTurnBudgetAction(34, 50, false) === "none", "under 70% → none");
	// At the soft threshold (ceil(50*0.7)=35) → nudge, once.
	check(decideTurnBudgetAction(35, 50, false) === "nudge", "at 70% → nudge");
	check(decideTurnBudgetAction(40, 50, true) === "none", "already nudged → none");
	// At the hard limit → abort, regardless of nudge state.
	check(decideTurnBudgetAction(50, 50, true) === "abort", "at budget → abort");
	check(decideTurnBudgetAction(64, 50, false) === "abort", "over budget → abort");
	// The nudge message carries the numbers + the converge instruction.
	const msg = turnBudgetNudgeMessage(35, 50);
	check(msg.includes("35/50") && msg.includes("yield()"), `nudge message, got: ${msg.slice(0, 60)}`);
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	console.log("── test-orchestrator: spec parse + splitSpec + aggregateSubSpecs + runVerification + fix loop ──");
	testSpecParsing(errors);
	testSplitSpec(errors);
	testAggregateSubSpecs(errors);
	await testRunVerification(errors);
	testFixLoop(errors);
	testReviewGate(errors);
	testReviewAxes(errors);
	testParseDiffStat(errors);
	testClassifyOverlapDiffs(errors);
	testFinalizationIncomplete(errors);
	testRecoveryGuide(errors);
	testVerificationLifecycle(errors);
	await testVerificationBaselineCapture(errors);
	testDisputeAdjudication(errors);
	testTurnBudget(errors);

	if (errors.length > 0) {
		throw new Error("test-orchestrator failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log("✓ orchestrator hermetic assertions passed");
}

// Direct execution support: `npx tsx extensions/task/test-orchestrator.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
