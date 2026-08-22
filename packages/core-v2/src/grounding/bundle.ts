/**
 * ExecutionBundle policy — M3 mode (b) (contract §5.3 b, FR-9 layer 4).
 *
 * A bundle is a ONE-SHOT artifact: it packages the relevant files' symbol
 * outlines for one spec, is VERSIONED and CONTENT-HASHED, and building it
 * is fully isolated from choosing to USE it. The builder here is pure
 * assembly + validation + hashing; the ROUTER (router/route.ts) decides
 * per-run whether a bundle grounds the worker, guided by per-repo
 * hit-rate telemetry (see recordBundleMiss/hit wiring in the task runner).
 *
 * MEASUREMENT CONTRACT (FR-9/NFR-2): a bundle run ends in exactly one of
 *   - hit    — the run shipped and every yielded file stayed inside the
 *              bundled target set (the shortcut paid);
 *   - miss   — the bundle was empty, the worker drifted outside the
 *              bundled files, the run failed after bundling, or
 *              verification failed post-bundle. EVERY miss is recorded
 *              into routing_feedback as hit=0: a never-tried path records
 *              its misses, never silence.
 * The receipt advertises the outcome as TaskReceipt.bundleHit (null when
 * no bundle was used at all).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ExecutionBundleSchema, type ExecutionBundle, type TargetFile } from "../contracts/index.ts";
import { stableStringify } from "../contracts/serialize.ts";

/** Schema version of the bundle format — bumped when the prompt-bound
 *  shape changes meaningfully; hashes are namespaced by it. */
export const EXECUTION_BUNDLE_VERSION = 1;

/** Builder input: everything comes from the parsed spec + candidate
 *  paths; nothing here knows about routing or sessions (R1 isolation). */
export interface BuildBundleInput {
	taskId: string;
	goal: string;
	requirements: readonly string[];
	verificationCommands: readonly string[];
	/** Candidate target files to package. Missing files are skipped, not
	 *  fatal — a bundle that cannot read a candidate simply excludes it. */
	targetPaths: readonly string[];
}

/**
 * ≈200-token outline fallback for environments without a compressor seam:
 * the file's leading bytes, capped at the schema's 800-char limit. Real
 * deployments plug a ContextCompressor instead.
 */
export function outlineFromFile(hostPath: string, maxChars = 800): TargetFile | undefined {
	let text: string;
	try {
		text = readFileSync(hostPath, "utf-8");
	} catch {
		return undefined;
	}
	const outline = text.slice(0, maxChars);
	return {
		hostPath,
		astOutline: outline,
		outlineTruncated: text.length > maxChars,
		outlineCursor: text.length > maxChars ? `${hostPath}@${maxChars}` : null,
	};
}

/** Assemble + validate a bundle. Throws on schema violations (typed). */
export function buildExecutionBundle(input: BuildBundleInput): ExecutionBundle {
	const targetFiles: TargetFile[] = [];
	for (const p of input.targetPaths) {
		const t = outlineFromFile(p);
		if (t !== undefined) targetFiles.push(t);
	}
	return ExecutionBundleSchema.parse({
		taskId: input.taskId,
		goal: input.goal,
		targetFiles,
		requirements: [...input.requirements],
		verificationCommands: [...input.verificationCommands],
	});
}

/**
 * Content hash over the PROMPT-BOUND bytes (deterministic serialization,
 * NFR-4): identical semantic bundles hash identically regardless of key
 * order or construction time. Namespaced by the format version.
 */
export function hashExecutionBundle(bundle: ExecutionBundle): string {
	const canonical = stableStringify(ExecutionBundleSchema.parse(bundle));
	const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
	return `v${EXECUTION_BUNDLE_VERSION}:${digest}`;
}

/** Is a bundle usable as grounding? Empty bundles cannot ground anything
 *  and are treated as immediate misses by the runner. */
export function isBundleUsable(bundle: ExecutionBundle): boolean {
	return ExecutionBundleSchema.safeParse(bundle).success && bundle.targetFiles.length > 0;
}

/** Deterministic grounding section appended to the worker system prompt
 *  when the bundle constrains the run. Pure function of the bundle. */
export function bundleGroundingSection(bundle: ExecutionBundle): string {
	return [
		"",
		"## Grounding bundle",
		`Pre-computed context for this task (${hashExecutionBundle(bundle)}).`,
		"The following files were selected as relevant to this spec:",
		...bundle.targetFiles.map((t) => `- ${t.hostPath}${t.outlineTruncated ? " (outline truncated)" : ""}`),
		"Prefer working inside these files; explore beyond them only if the",
		"bundle proves insufficient.",
		"",
	].join("\n");
}

/**
 * Focus check (pure): did every changed file stay inside the bundled
 * target set? Paths are resolved against `cwd` on both sides so relative
 * yields compare cleanly against bundle entries.
 */
export function isBundleFocused(
	bundle: ExecutionBundle,
	changedFiles: readonly string[],
	cwd: string,
): boolean {
	const scoped = new Set(bundle.targetFiles.map((t) => resolve(cwd, t.hostPath)));
	return changedFiles.every((f) => scoped.has(resolve(cwd, f)));
}
