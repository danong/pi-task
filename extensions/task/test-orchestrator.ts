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
} from "./orchestrator.ts";
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

	console.log("✓ fix loop: decideFixLoop, blocker policy, buildFixPrompt");
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	console.log("── test-orchestrator: spec parse + splitSpec + aggregateSubSpecs + runVerification + fix loop ──");
	testSpecParsing(errors);
	testSplitSpec(errors);
	testAggregateSubSpecs(errors);
	await testRunVerification(errors);
	testFixLoop(errors);

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
