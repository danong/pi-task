/**
 * Schema for the reviewer's structured report — the typed contract between
 * a forked review session and the orchestrator's fix loop (Phase 7).
 *
 * Single source of truth for what a reviewer must produce. Pi validates
 * report_findings args against this schema before execute(), so a captured
 * ReviewResult is always schema-valid — the fix loop never parses prose.
 *
 * Shape follows docs/pi-task-design.md → "Structured findings". `category`
 * is an open string (suggested values in its description) so new categories
 * don't require a schema change; priority/verdict/status are closed enums
 * because the fix loop branches on them.
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

export const FindingSchema = Type.Object({
	id: Type.String({ description: "Stable finding id (e.g. F1, F2)" }),
	priority: StringEnum(["P0", "P1", "P2", "P3"] as const, {
		description: "P0/P1 block ship and drive the fix loop; P2/P3 are informational",
	}),
	confidence: Type.Number({ minimum: 0, maximum: 1, description: "Reviewer confidence, 0-1" }),
	category: Type.String({
		description:
			"Finding kind — e.g. security | edge-case | test-quality | design | regression | requirement (open set)",
	}),
	file: Type.String({ description: "Primary file the finding concerns" }),
	description: Type.String({ description: "What the problem is" }),
	verification: Type.String({ description: "How to confirm the finding is real" }),
});

export const RequirementStatusSchema = Type.Object({
	id: Type.String({ description: "Requirement id from the spec (e.g. R1)" }),
	status: StringEnum(["met", "unmet", "uncertain"] as const, {
		description: "Whether the requirement is satisfied by the change",
	}),
});

export const ReviewResultSchema = Type.Object({
	verdict: StringEnum(["ship", "fix", "escalate"] as const, {
		description:
			"ship = no blockers; fix = addressable findings remain; escalate = unresolved P0/P1 after the fix budget",
	}),
	findings: Type.Array(FindingSchema, { description: "Prioritized findings (may be empty for a clean review)" }),
	requirements: Type.Array(RequirementStatusSchema, { description: "Per-requirement status" }),
});

export type Finding = Static<typeof FindingSchema>;
export type RequirementStatus = Static<typeof RequirementStatusSchema>;
export type ReviewResult = Static<typeof ReviewResultSchema>;
