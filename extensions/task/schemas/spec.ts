/**
 * Spec parsing and validation.
 *
 * The spec is the input contract between the conversational model and the
 * orchestrator. It describes WHAT to build, not HOW. Validation is code,
 * not LLM — the orchestrator rejects malformed specs with a precise error
 * that tells the model exactly what is missing.
 *
 * Format:
 *   ## Goal            — one sentence (informational; not hard-validated)
 *   ## Requirements    — numbered list ("- R1: ..." or "1. ...")
 *   ## Verification    — one or more bash commands
 */

export interface Spec {
	goal: string;
	requirements: string[];
	verification: string[];
}

export class SpecError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SpecError";
	}
}

/** Split the markdown into sections keyed by (lowercased) heading text. */
function extractSections(markdown: string): Map<string, string[]> {
	const sections = new Map<string, string[]>();
	let current: string | null = null;

	for (const rawLine of markdown.split("\n")) {
		const match = /^##\s+(.+)$/.exec(rawLine.trim());
		if (match) {
			current = match[1].trim().toLowerCase();
			sections.set(current, []);
		} else if (current !== null) {
			sections.get(current)!.push(rawLine);
		}
	}

	return sections;
}

/** Strip list markers ("- ", "* ", "1. ") and blank lines. */
function cleanItem(line: string): string {
	return line
		.trim()
		.replace(/^[-*]\s+/, "")
		.replace(/^\d+\.\s+/, "")
		.trim();
}

export function parseSpec(markdown: string): Spec {
	const sections = extractSections(markdown);

	const goal = (sections.get("goal") ?? [])
		.map((l) => l.trim())
		.filter(Boolean)
		.join(" ");

	const requirements = (sections.get("requirements") ?? [])
		.map(cleanItem)
		.filter(Boolean);

	const verification = (sections.get("verification") ?? [])
		.map(cleanItem)
		.filter(Boolean);

	const missing: string[] = [];
	if (requirements.length === 0) {
		missing.push('"## Requirements" with a numbered list (e.g. "- R1: ...")');
	}
	if (verification.length === 0) {
		missing.push('"## Verification" with at least one command');
	}
	if (missing.length > 0) {
		throw new SpecError(`Invalid spec: missing ${missing.join(" and ")}.`);
	}

	return { goal, requirements, verification };
}
