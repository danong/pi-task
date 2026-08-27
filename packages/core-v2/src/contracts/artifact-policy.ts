/**
 * Repository-relative artifact policy (M2).
 *
 * The policy is deliberately small: it names files whose presence can be
 * checked mechanically and says whether an integrated change is required or
 * explicitly not expected. It never attempts to encode semantic user intent.
 *
 * Markdown grammar accepted by the strict parser:
 *
 *   - Required: reports/result.json
 *   - Change required
 *
 * or:
 *
 *   - Intentional no-change
 *
 * `Change required: true|false` and
 * `Intentional no-change: true|false` are also accepted. A missing policy is
 * a safe legacy-library fallback, not a strict CLI policy.
 */

import { z } from "zod";

export const ArtifactPolicySchema = z
	.object({
		requiredFiles: z.array(z.string()).max(100),
		changeRequired: z.boolean(),
		intentionalNoChange: z.boolean(),
	})
	.refine((policy) => !(policy.changeRequired && policy.intentionalNoChange), {
		message: "artifact policy cannot require and forbid a change",
	});
export type ArtifactPolicy = z.infer<typeof ArtifactPolicySchema>;

export type ArtifactPolicyParseCode =
	| "missing_policy"
	| "empty_policy"
	| "unsafe_path"
	| "duplicate_path"
	| "contradictory_policy"
	| "unrecognized_policy";

export class ArtifactPolicyError extends Error {
	readonly code: ArtifactPolicyParseCode;

	constructor(code: ArtifactPolicyParseCode, message: string) {
		super(message);
		this.name = "ArtifactPolicyError";
		this.code = code;
	}
}

/** Normalize a repository-relative path, rejecting every escape route. */
export function normalizeArtifactPath(path: string): string {
	const value = path.replaceAll("\\", "/").trim();
	if (
		value.length === 0 ||
		value.includes("\0") ||
		value.startsWith("/") ||
		/^[A-Za-z]:\//.test(value) ||
		value.startsWith("//")
	) {
		throw new Error(`invalid artifact path: ${path}`);
	}
	const parts = value.split("/");
	if (parts.some((part) => part === ".." || part === "")) {
		throw new Error(`invalid artifact path: ${path}`);
	}
	const normalized = parts.filter((part) => part !== ".").join("/");
	if (!normalized || normalized.startsWith("../")) {
		throw new Error(`invalid artifact path: ${path}`);
	}
	return normalized;
}

function policySection(markdown: string): string[] | undefined {
	const lines = markdown.split("\n");
	const start = lines.findIndex((line) =>
		/^##\s+artifact policy\s*$/i.test(line.trim()),
	);
	if (start < 0) return undefined;
	const body: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^##\s+/.test(line.trim())) break;
		body.push(line);
	}
	return body;
}

/** Whether the markdown has an Artifact Policy heading. */
export function hasArtifactPolicyDeclaration(markdown: string): boolean {
	return policySection(markdown) !== undefined;
}

function cleanPolicyLine(line: string): string {
	return line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim();
}

function booleanValue(value: string | undefined): boolean | undefined {
	if (value === undefined || value.length === 0) return true;
	if (/^(?:true|yes|required|on)$/i.test(value)) return true;
	if (/^(?:false|no|off)$/i.test(value)) return false;
	return undefined;
}

interface ParsedPolicyEntries {
	requiredFiles: string[];
	changeRequired?: boolean;
	intentionalNoChange?: boolean;
	meaningful: boolean;
}

function readPolicyEntries(lines: readonly string[], strict: boolean): ParsedPolicyEntries {
	const entries: ParsedPolicyEntries = { requiredFiles: [], meaningful: false };
	for (const rawLine of lines) {
		const text = cleanPolicyLine(rawLine);
		if (!text) continue;
		entries.meaningful = true;

		const required = /^(?:required(?:-file)?|file)\s*:\s*(.*)$/i.exec(text);
		if (required) {
			const path = required[1]?.trim() ?? "";
			try {
				entries.requiredFiles.push(normalizeArtifactPath(path));
			} catch (error) {
				throw new ArtifactPolicyError(
					"unsafe_path",
					`artifact policy path is unsafe: ${path} (${error instanceof Error ? error.message : String(error)})`,
				);
			}
			continue;
		}

		const change = /^(?:change[- ]required|required[- ]change|requires[- ]change)(?:\s*:\s*(.*))?$/i.exec(text);
		if (change) {
			const value = booleanValue(change[1]?.trim());
			if (value === undefined)
				throw new ArtifactPolicyError("unrecognized_policy", `unrecognized change-required value: ${text}`);
			entries.changeRequired = value;
			continue;
		}

		const noChange = /^(?:intentional[- ]no[- ]change|no[- ]change|unchanged)(?:\s*:\s*(.*))?$/i.exec(text);
		if (noChange) {
			const value = booleanValue(noChange[1]?.trim());
			if (value === undefined)
				throw new ArtifactPolicyError("unrecognized_policy", `unrecognized intentional-no-change value: ${text}`);
			entries.intentionalNoChange = value;
			continue;
		}

		if (strict)
			throw new ArtifactPolicyError("unrecognized_policy", `unrecognized artifact policy entry: ${text}`);
	}
	return entries;
}

function buildPolicy(entries: ParsedPolicyEntries, strict: boolean): ArtifactPolicy {
	if (!entries.meaningful)
		throw new ArtifactPolicyError("empty_policy", "Artifact Policy is empty");
	const unique = [...new Set(entries.requiredFiles)];
	if (unique.length !== entries.requiredFiles.length)
		throw new ArtifactPolicyError("duplicate_path", "artifact policy contains duplicate paths");

	const intentionalNoChange = entries.intentionalNoChange === true;
	const changeRequired =
		entries.changeRequired ?? (!intentionalNoChange && entries.requiredFiles.length === 0);
	if (changeRequired && intentionalNoChange)
		throw new ArtifactPolicyError("contradictory_policy", "artifact policy cannot require and forbid a change");
	if (strict && entries.changeRequired === undefined && entries.intentionalNoChange === undefined)
		throw new ArtifactPolicyError("empty_policy", "artifact policy must declare change-required or intentional-no-change");

	return ArtifactPolicySchema.parse({
		requiredFiles: unique,
		changeRequired,
		intentionalNoChange,
	});
}

/**
 * Parse a policy for library callers. Missing policy uses the safe legacy
 * fallback: an open-ended task requires a real integrated change.
 */
export function parseArtifactPolicy(markdown: string): ArtifactPolicy {
	const lines = policySection(markdown);
	if (lines === undefined)
		return { requiredFiles: [], changeRequired: true, intentionalNoChange: false };
	return buildPolicy(readPolicyEntries(lines, false), false);
}

/** Strict policy parser for the CLI-facing validation boundary. */
export function parseArtifactPolicyStrict(markdown: string): ArtifactPolicy {
	const lines = policySection(markdown);
	if (lines === undefined)
		throw new ArtifactPolicyError("missing_policy", "spec is missing ## Artifact Policy");
	return buildPolicy(readPolicyEntries(lines, true), true);
}

/** Explicit mode form for callers that want one parser entry point. */
export function parseArtifactPolicyWithMode(
	markdown: string,
	mode: "legacy" | "strict",
): ArtifactPolicy {
	return mode === "strict" ? parseArtifactPolicyStrict(markdown) : parseArtifactPolicy(markdown);
}
