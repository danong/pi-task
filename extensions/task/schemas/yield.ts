/**
 * Schema for the worker yield payload — the typed contract between
 * worker sessions and the orchestrator.
 *
 * This is the single source of truth for what a worker must produce
 * to complete a task. Pi validates tool args against this schema
 * before calling execute(), so a captured yield payload is always
 * schema-valid.
 */

import { Type } from "typebox";
import type { Static } from "typebox";

export const YieldSchema = Type.Object({
	files_changed: Type.Array(Type.String(), {
		description: "Paths of files modified during this task",
	}),
	summary: Type.String({
		description: "One-paragraph description of the changes made",
	}),
	commit_ids: Type.Array(Type.String(), {
		description: "jj commit IDs created during this task",
	}),
	deviations: Type.Array(Type.String(), {
		description: "Any deviations from the spec (empty array if none)",
	}),
	disputes: Type.Optional(
		Type.Array(
			Type.Object({
				command: Type.String(),
				reason: Type.String(),
			}),
			{
				description:
					"Verification commands disputed via dispute_verification (the engine merges tool-recorded disputes in automatically; omit unless you also dispute inline)",
			},
		),
	),
});

export type YieldPayload = Static<typeof YieldSchema>;
