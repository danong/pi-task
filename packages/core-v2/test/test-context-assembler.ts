/** Hermetic cache-oriented context prompt assembly tests. */
import { pathToFileURL } from "node:url";

import { ContextItemSchema } from "../src/contracts/context-lifecycle.ts";
import { assembleContext } from "../src/context/assembler.ts";
import { createWorkingCheckpoint } from "../src/context/checkpoint.ts";
import { planContext } from "../src/context/planner.ts";

function candidate(id: string, score: number) {
	return ContextItemSchema.parse({
		version: 1,
		id,
		kind: "candidate",
		label: id,
		summary: id,
		provenance: {
			providerId: "fixture",
			providerVersion: "1",
			source: "fixture",
			sourceRevision: "rev",
			selector: "test",
		},
		freshness: { revision: "rev", observedAtRevision: "rev", state: "fresh" },
		sensitivity: "internal",
		size: { characters: 40, tokens: 10 },
		requirementIds: ["R1"],
		sourcePath: `src/${id}.ts`,
		score,
	});
}

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (value: boolean, message: string): void => {
		if (!value) errors.push(message);
	};
	const plan = planContext({
		goal: "goal",
		requirements: ["requirement"],
		candidates: [candidate("first", 2), candidate("second", 1)],
		sourceRevision: "rev",
		budgets: {
			economic: { maxUncachedTokens: 100, maxProviderCacheWriteTokens: 100 },
			window: { maxTokens: 60, reserveTokens: 30 },
			attention: { maxItems: 4, maxVolatileSegments: 0 },
		},
	});
	const first = assembleContext({ plan });
	const second = assembleContext({ plan });
	check(
		JSON.stringify(first) === JSON.stringify(second),
		"assembly is byte deterministic",
	);
	check(first.tokens <= 30, "assembly enforces the allocated window");
	check(
		first.prompt.includes("src/first.ts") &&
			first.omittedItemIds.includes("second"),
		"assembly preserves ranking and reports materialization-time omissions",
	);
	check(
		!first.prompt.includes("goal") && !first.prompt.includes("runId"),
		"assembly does not duplicate task or volatile ledger metadata",
	);
	const planRef = {
		version: 1 as const,
		id: `sha256:${"b".repeat(64)}`,
		namespace: "plan",
		kind: "plan" as const,
		mediaType: "application/json",
		sizeBytes: 1,
		sensitivity: "internal" as const,
		sourceRevision: "rev",
	};
	const checkpoint = createWorkingCheckpoint({
		epochId: "epoch-1",
		workspaceRevision: "rev",
		plan: planRef,
		summary: { nextActions: ["run focused verification"] },
	});
	const resumed = assembleContext({ plan, checkpoint });
	check(
		resumed.prompt.includes("Working checkpoint") &&
			resumed.prompt.includes("run focused verification"),
		"checkpoint state is assembled as a bounded mutable tail",
	);
	if (errors.length > 0)
		throw new Error(
			`test-context-assembler failed:\n  ✗ ${errors.join("\n  ✗ ")}`,
		);
	console.log(
		"✓ context-assembler: deterministic bounded stable segments and checkpoint tail",
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
