/** Deterministic initial context compilation and compact prompt rendering. */
import { capTraceText } from "../contracts/trace.ts";
import type { CompiledContextArtifact, ContextBudget } from "../contracts/context-provider.ts";

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
	maxHandles: 24,
	maxCharacters: 8000,
	maxTokens: 2000,
};

export function buildInitialContextQuery(goal: string, requirements: readonly string[]): string {
	return [goal.trim(), ...requirements.map((requirement) => requirement.trim())]
		.filter((value) => value.length > 0)
		.join("\n");
}

/** Prompt contains only handles and bounded metadata; source is read later by tools. */
export function renderInitialContextArtifact(artifact: CompiledContextArtifact): string {
	if (artifact.handles.length === 0) return "";
	const lines = [
		"## Progressive context handles",
		`Provider: ${artifact.provider.id}@${artifact.provider.version}`,
		`Source: ${artifact.source.treeIdentity} (${artifact.source.sourceRevision})`,
		"Use the context tool to query or resolve handles; read/search/bash remain available.",
		...artifact.handles.map((handle) =>
			`- ${handle.id} ${handle.kind} ${handle.path}${handle.symbol === undefined ? "" : `#${handle.symbol}`} [${handle.language}; ${handle.matchReasons.join(",")}]`,
		),
	];
	return capTraceText(lines.join("\n"), artifact.budget.maxCharacters);
}
