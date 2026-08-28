/** Hermetic conformance for provider-neutral M4 lifecycle payloads. */
import { pathToFileURL } from "node:url";

import {
	ContextItemSchema,
	ContextPlanSchema,
	ExecutionEpochSchema,
	ImmutableArtifactReferenceSchema,
	PromptAssemblySchema,
	WorkingCheckpointSchema,
} from "../src/contracts/index.ts";
import { stableStringify } from "../src/contracts/serialize.ts";
import { CORE_V2_MILESTONE, CORE_V2_VERSION } from "../src/version.ts";
import { assembleContext } from "../src/context/assembler.ts";
import { planContext } from "../src/context/planner.ts";

const sourceRef = {
	version: 1 as const,
	id: `sha256:${"a".repeat(64)}`,
	namespace: "source-view",
	kind: "source-view" as const,
	mediaType: "text/plain",
	sizeBytes: 12,
	sensitivity: "internal" as const,
	sourceRevision: "rev-1",
};

function item(id: string) {
	return ContextItemSchema.parse({
		version: 1,
		id,
		kind: "candidate",
		label: "result symbol",
		summary: "bounded descriptor",
		provenance: {
			providerId: "fixture",
			providerVersion: "1",
			source: "fixture",
			sourceRevision: "rev-1",
			selector: "lexical",
		},
		freshness: {
			revision: "rev-1",
			observedAtRevision: "rev-1",
			state: "fresh",
		},
		sensitivity: "internal",
		size: { characters: 20, tokens: 5 },
		requirementIds: ["R1"],
		artifact: sourceRef,
		sourcePath: "src/result.ts",
		score: 10,
	});
}

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (value: boolean, message: string): void => {
		if (!value) errors.push(message);
	};
	check(
		CORE_V2_MILESTONE === "M5" && CORE_V2_VERSION === "0.0.0-m5",
		"package identity records the implemented M5 milestone",
	);
	const candidate = item("candidate-1");
	const planningInput = {
		goal: "create result",
		requirements: ["R1 result is valid"],
		candidates: [candidate, candidate],
		sourceRevision: "rev-1",
		modelId: "fake/model",
		toolSchemaIdentity: "worker-tools-v1:read,yield",
	};
	const plan = planContext(planningInput);
	ContextPlanSchema.parse(plan);
	const assembly = assembleContext({ plan });
	PromptAssemblySchema.parse(assembly);
	check(
		plan.mode === "managed" && plan.selected.length === 1,
		"planner deduplicates typed candidates",
	);
	check(
		plan.omissions.some((entry) => entry.reason === "duplicate"),
		"planner records omissions",
	);
	check(
		assembly.prompt.includes("src/result.ts") &&
			!assembly.prompt.includes("run-id"),
		"assembly is bounded and has no volatile run metadata input",
	);
	check(
		assembly.tokens <=
			plan.budgets.window.maxTokens - plan.budgets.window.reserveTokens,
		"assembly respects the context-window allocation",
	);
	const raw = planContext({
		...planningInput,
		mode: "raw" as const,
	});
	check(
		raw.selected.length === 0 &&
			raw.omissions.some((entry) => entry.reason === "raw-mode") &&
			assembleContext({ plan: raw }).prompt === "",
		"raw is a correct empty plan even when candidates exist",
	);
	check(
		stableStringify(plan) === stableStringify(planContext(planningInput)),
		"plans are deterministic",
	);
	check(
		plan.cache.toolSchemaIdentity === "worker-tools-v1:read,yield",
		"cache identity records the actual tool schema",
	);
	ImmutableArtifactReferenceSchema.parse(sourceRef);
	const checkpoint = {
		version: 1 as const,
		id: "checkpoint-1",
		epochId: "epoch-1",
		workspaceRevision: "rev-1",
		plan: { ...sourceRef, namespace: "plan", kind: "plan" as const },
		evidence: [],
		requirements: [],
		summary: { decisions: [], openQuestions: [], nextActions: [] },
		verification: { status: "not-run" as const, evidenceIds: [] },
		artifactIds: [],
	};
	WorkingCheckpointSchema.parse(checkpoint);
	ExecutionEpochSchema.parse({
		version: 1,
		id: "epoch-1",
		role: "worker-0",
		modelId: "fake/model",
		planId: plan.id,
		status: "active",
		transition: "initial",
		tailBudgetTokens: 100,
	});
	check(
		!ContextItemSchema.safeParse({ ...candidate, sourceBody: "secret" })
			.success &&
			!ContextItemSchema.safeParse({ ...candidate, sourcePath: "../secret" })
				.success,
		"context items reject undeclared source bodies and unsafe paths",
	);
	if (errors.length > 0)
		throw new Error(
			`test-context-lifecycle-contracts failed:\n  ✗ ${errors.join("\n  ✗ ")}`,
		);
	console.log(
		"✓ context-lifecycle-contracts: bounded deterministic raw/managed lifecycle payloads",
	);
	return Promise.resolve();
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
