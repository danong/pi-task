/**
 * Hermetic tests for the reviewer persona library (personas.ts) — pure data
 * + lookup, no subprocess, no LLM.
 *
 * Run standalone: npx tsx extensions/task/test-personas.ts
 */

import { pathToFileURL } from "node:url";
import { adversarialPersona, DEFAULT_PERSONA, PERSONAS, getPersona } from "./personas.ts";

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
