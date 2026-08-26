/**
 * /plan R1 — side-effect-free spec validation (M5 planning-only workflow).
 *
 * Validates one spec markdown for well-formedness WITHOUT touching task
 * state: no ledger writes, no sessions, no merges, no fs. Parsing reuses
 * the runner's `parseTaskSpec` (Goal / Requirements / Verification) and
 * layers on top:
 *   - a non-empty goal line,
 *   - verification commands that parse as non-empty bash lines
 *     (`isWellFormedBashLine` — rejects shell-breaking syntax),
 *   - optional DAG linkage fields (`depends_on`), validated where present.
 *
 * Typed errors only (`PlanValidationError`) so callers can branch on code.
 */

import { parseTaskSpec, SpecValidationError } from "../daemon/task-runner.ts";

/** A literal backslash, spelled without an escape sequence. */
const BACKSLASH = String.fromCharCode(92);

/** Typed spec-validation failure with a stable machine-readable code. */
export type PlanValidationCode =
	| "missing_goal"
	| "missing_requirements"
	| "missing_verification"
	| "bad_verification_command"
	| "bad_depends_on";

export class PlanValidationError extends Error {
	constructor(
		public readonly code: PlanValidationCode,
		message: string,
		/** The offending command / dependency entry, when one exists. */
		public readonly offending?: string,
	) {
		super(message);
		this.name = "PlanValidationError";
	}
}

/**
 * Pure bash-line well-formedness check (R1): a verification command must
 * be non-empty, must not contain an unterminated quote or backtick, and
 * must not end on a line-continuation backslash. This is SYNTAX only —
 * commands are never executed here (the FR-6 gate runs them later).
 */
export function isWellFormedBashLine(command: string): boolean {
	const trimmed = command.trim();
	if (trimmed.length === 0) return false;
	if (trimmed.endsWith(BACKSLASH)) return false;
	let quote: '"' | "'" | "`" | undefined;
	for (const ch of trimmed) {
		if (quote !== undefined) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") quote = ch;
	}
	return quote === undefined;
}

/** Split markdown into `## Name` sections; returns the named section's cleaned lines. */
function sectionLines(markdown: string, sectionName: string): string[] {
	const wanted = sectionName.toLowerCase();
	let collecting = false;
	const lines: string[] = [];
	for (const rawLine of markdown.split("\n")) {
		const line = rawLine.trim();
		if (line.startsWith("##")) {
			collecting = line.slice(2).trim().toLowerCase() === wanted;
			continue;
		}
		if (collecting && line.length > 0) {
			lines.push(cleanListItem(line));
		}
	}
	return lines.filter((l) => l.length > 0);
}

/** Strip one leading list marker ("- ", "* ", "1. ", "2)") from a line. */
function cleanListItem(line: string): string {
	const s = line.trim();
	if (s.startsWith("- ") || s.startsWith("* ")) return s.slice(2).trim();
	let digitsEnd = 0;
	while (
		digitsEnd < s.length &&
		s.charCodeAt(digitsEnd) >= 48 &&
		s.charCodeAt(digitsEnd) <= 57
	) {
		digitsEnd += 1;
	}
	if (digitsEnd > 0) {
		const marker = s.charAt(digitsEnd);
		if (marker === "." || marker === ":" || marker === ")") {
			return s.slice(digitsEnd + 1).trim();
		}
	}
	return s;
}

/**
 * Parse the spec's optional `## Depends On` section into dependency ids.
 * One id per bullet/numbered line; empty entries dropped. Pure.
 */
export function parseDependsOn(specMarkdown: string): string[] {
	return sectionLines(specMarkdown, "depends on");
}

/** The parsed-and-validated shape /plan carries forward to DAG synthesis. */
export interface ValidatedSpec {
	goal: string;
	requirements: string[];
	verificationCommands: string[];
	/** Dependency ids from `## Depends On` (empty when the section is absent). */
	dependsOn: string[];
}

/**
 * Validate one spec markdown (R1). Side-effect-free by construction: it
 * reads nothing but the argument string and returns either a ValidatedSpec
 * or throws a typed PlanValidationError. Never spawns/merges/writes.
 */
export function validateSpec(specMarkdown: string): ValidatedSpec {
	const goal = parseTaskSpecGoal(specMarkdown);
	let parsed;
	try {
		parsed = parseTaskSpec(specMarkdown);
	} catch (err) {
		if (err instanceof SpecValidationError) {
			throw new PlanValidationError(
				err.missing === "requirements"
					? "missing_requirements"
					: "missing_verification",
				err.message,
			);
		}
		throw err;
	}

	const badCommand = parsed.verificationCommands.find(
		(c) => !isWellFormedBashLine(c),
	);
	if (badCommand !== undefined) {
		throw new PlanValidationError(
			"bad_verification_command",
			`verification command does not parse as a complete non-empty bash line: ${JSON.stringify(badCommand)}`,
			badCommand,
		);
	}

	const dependsOn = parseDependsOn(specMarkdown);
	return {
		goal,
		requirements: parsed.requirements,
		verificationCommands: parsed.verificationCommands,
		dependsOn,
	};
}

/** Extract the first non-empty Goal-section line; typed error when absent. */
function parseTaskSpecGoal(specMarkdown: string): string {
	const goal = sectionLines(specMarkdown, "goal").find((l) => l.length > 0);
	if (goal === undefined) {
		throw new PlanValidationError(
			"missing_goal",
			'spec has no "## Goal" section with a non-empty line',
		);
	}
	return goal;
}
