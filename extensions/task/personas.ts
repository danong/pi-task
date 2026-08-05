/**
 * Reviewer personas (Phase 7).
 *
 * A persona is a focused review prompt plus an output contract, reusing the
 * same fork-and-prune context inheritance (review.ts). The adversarial code
 * reviewer is the default in the review-fix loop; specialized personas
 * (performance, architecture) are dispatched as workers and typically produce
 * a written report artifact rather than gate a fix loop.
 *
 * The persona supplies the reviewer's ROLE (system prompt). The spec, final
 * diff, worker summary, and deviations are injected as separate user messages
 * by the review runner; the inherited (pruned) reads/bash come from the fork.
 */

/** How a persona reports its result. */
export type OutputContract =
	| { kind: "findings" } // structured ReviewResult via the report_findings tool
	| { kind: "report"; path: string }; // written report artifact (future personas)

export interface Persona {
	/** Stable id, e.g. "adversarial". */
	name: string;
	/** One-line description of the persona's focus. */
	description: string;
	/** Reviewer role instruction (appended as the reviewer system prompt). */
	systemPrompt: string;
	/** How the reviewer reports its result. */
	output: OutputContract;
}

const ADVERSARIAL_SYSTEM_PROMPT = `You are an adversarial code reviewer. You did NOT write this code.

You are reviewing a change against its spec. You inherit the implementer's
codebase reads and command outputs (factual context) but NOT their reasoning,
plan, or step-by-step edits — assess the change with detachment.

Find problems: unmet requirements, edge cases, security issues, weak or
no-op tests, regressions, design concerns, and what the implementer might
have missed. When judging error handling, prefer propagation over local
recovery and flag handlers that hide failures (swallowed errors, log-and-
continue, pretending success).

When your review is complete, call report_findings() exactly once with:
- verdict: "ship" (no blockers), "fix" (addressable findings), or "escalate"
  (critical findings you doubt a quick fix loop can resolve).
- findings: prioritized P0-P3. P0/P1 block ship — reserve them for issues
  with provable impact on correctness, security, or maintainability. Give
  each finding a concrete verification step.
- requirements: a met / unmet / uncertain status for every spec requirement.

Base every finding on verifiable evidence from the change; do not manufacture
issues or pad the list. If the change is sound, return verdict "ship" with
few or no findings.`;

/** Default reviewer: adversarial code review gating the fix loop. */
export const adversarialPersona: Persona = {
	name: "adversarial",
	description: "Adversarial code reviewer; gates the review-fix loop with structured P0-P3 findings.",
	systemPrompt: ADVERSARIAL_SYSTEM_PROMPT,
	output: { kind: "findings" },
};

/** Registered personas (extensible: add performance/architecture/report personas here). */
export const PERSONAS: Persona[] = [adversarialPersona];

/** The persona used when none is specified. */
export const DEFAULT_PERSONA: Persona = adversarialPersona;

/** Look up a persona by name (undefined if unknown). */
export function getPersona(name: string): Persona | undefined {
	return PERSONAS.find((p) => p.name === name);
}
