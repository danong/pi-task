/**
 * Hermetic tests for the reviewer persona library (personas.ts) — pure data
 * + lookup, no subprocess, no LLM.
 *
 * Run standalone: npx tsx extensions/task/test-personas.ts
 */

import { pathToFileURL } from "node:url";
import { adversarialPersona,
	architecturePersona,
	DEFAULT_PERSONA,
	DEFAULT_REVIEW_PERSONAS,
	getPersona,
	PERSONAS,
	standardsPersona,
	specFidelityPersona,
} from "./personas.ts";
import { DEFAULT_TASK_SHAPES } from "./config.ts";

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// 1. Adversarial persona shape
	check(adversarialPersona.name === "adversarial", "adversarial persona name");
	check(adversarialPersona.description.length > 0, "adversarial persona has a description");
	check(adversarialPersona.systemPrompt.trim().length > 0, "adversarial persona has a non-empty system prompt");
	check(adversarialPersona.output.kind === "findings", "adversarial persona reports structured findings");

	// 2. Prompt carries the key instructions the fix loop relies on
	const p = adversarialPersona.systemPrompt;
	for (const needle of ["report_findings", "verdict", "P0", "P3", "requirements", "adversarial"]) {
		check(p.includes(needle), `adversarial prompt should mention "${needle}"`);
	}

	// 3. Registry + default + lookup
	check(DEFAULT_PERSONA === adversarialPersona, "default persona is the adversarial reviewer");
	check(PERSONAS.some((x) => x.name === "adversarial"), "adversarial persona is registered");
	check(getPersona("adversarial") === adversarialPersona, "getPersona finds adversarial");
	check(getPersona("does-not-exist") === undefined, "getPersona returns undefined for unknown");

	// 3b. The DEFAULT review axes, all resolving through the registry.
	check(standardsPersona.name === "standards" && specFidelityPersona.name === "spec-fidelity",
		"standards/spec-fidelity personas named");
	check(JSON.stringify(DEFAULT_TASK_SHAPES.code.review) === JSON.stringify(DEFAULT_REVIEW_PERSONAS),
		"the code shape's review axes match the default axes");
	check(DEFAULT_TASK_SHAPES.code.review.includes("architecture"),
		`the code shape's review axes include architecture, got ${JSON.stringify(DEFAULT_TASK_SHAPES.code.review)}`);
	check(DEFAULT_REVIEW_PERSONAS.length === 3 && DEFAULT_REVIEW_PERSONAS.every((n) => getPersona(n) !== undefined),
		`every default axis resolves in the registry, got ${JSON.stringify(DEFAULT_REVIEW_PERSONAS)}`);
	check(JSON.stringify(DEFAULT_REVIEW_PERSONAS) === JSON.stringify(["standards", "spec-fidelity", "architecture"]),
		`default axes are standards + spec-fidelity + architecture, got ${JSON.stringify(DEFAULT_REVIEW_PERSONAS)}`);
	check(
		standardsPersona.systemPrompt.includes("standards") &&
			specFidelityPersona.systemPrompt.includes("SPEC"),
		"each default persona has a focused non-empty prompt",
	);

	// 3c. The architecture-fidelity persona (R1): registered, resolvable,
	//     findings contract; its prompt is anchored to the RECORDED
	//     architecture (CONTEXT.md + docs/adr/ + docs/architecture-review.md),
	//     reads those files itself, and stays off goals/vision.
	check(architecturePersona.name === "architecture", "architecture persona named");
	check(architecturePersona.output.kind === "findings", "architecture persona reports structured findings");
	check(architecturePersona.description.length > 0, "architecture persona has a description");
	check(getPersona("architecture") === architecturePersona, "getPersona finds architecture");
	check(PERSONAS.some((x) => x.name === "architecture"), "architecture persona is registered");
	{
		const ap = architecturePersona.systemPrompt;
		for (const needle of [
			"CONTEXT.md",
			"docs/adr/",
			"docs/architecture-review.md",
			"report_findings",
			"verdict",
		]) {
			check(ap.includes(needle), `architecture prompt should mention "${needle}"`);
		}
		// The reviewer reads the recorded architecture ITSELF before judging
		// (the forked reviewer has tools), and does NOT judge goals/vision.
		check(/READ .*yourself/s.test(ap), "architecture prompt tells the reviewer to read the recorded files itself");
		check(ap.includes("goals") && ap.includes("vision"), "architecture prompt excludes goals/vision judging");
	}

	// 4. Every registered persona has a unique name + a valid output contract
	{
		const names = PERSONAS.map((x) => x.name);
		check(new Set(names).size === names.length, "persona names must be unique");
		for (const persona of PERSONAS) {
			check(
				persona.output.kind === "findings" || persona.output.kind === "report",
				`persona ${persona.name} has a valid output contract`,
			);
		}
	}

	if (errors.length > 0) {
		throw new Error("test-personas failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log("✓ personas: adversarial shape, prompt instructions, registry/lookup");
}

// Direct execution support: `npx tsx extensions/task/test-personas.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
