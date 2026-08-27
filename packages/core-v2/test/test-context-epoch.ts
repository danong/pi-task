/** Pure execution epoch transition and pressure tests. */
import { pathToFileURL } from "node:url";

import {
	resumeExecutionEpoch,
	shouldStartNewEpoch,
	startExecutionEpoch,
	transitionExecutionEpoch,
} from "../src/context/epoch.ts";
import { emptyContextPlan } from "../src/context/planner.ts";

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (value: boolean, message: string): void => {
		if (!value) errors.push(message);
	};
	const plan = emptyContextPlan("rev-1", { modelId: "fake/model" });
	const initial = startExecutionEpoch({
		role: "worker-0",
		modelId: "fake/model",
		plan,
		tailBudgetTokens: 100,
	});
	const same = startExecutionEpoch({
		role: "worker-0",
		modelId: "fake/model",
		plan,
		tailBudgetTokens: 100,
	});
	check(initial.id === same.id, "initial epochs are deterministic");
	const changed = transitionExecutionEpoch(initial, {
		reason: "model-change",
		modelId: "other/model",
	});
	check(
		changed.parentId === initial.id &&
			changed.modelId === "other/model" &&
			changed.status === "active" &&
			changed.transition === "model-change",
		"model change starts an explicit active child epoch",
	);
	const resumed = resumeExecutionEpoch(changed);
	check(
		resumed.parentId === changed.id && resumed.status === "active",
		"resume starts from the preceding epoch identity",
	);
	check(
		!shouldStartNewEpoch({ tailTokens: 100, tailBudgetTokens: 100 }) &&
			shouldStartNewEpoch({ tailTokens: 101, tailBudgetTokens: 100 }) &&
			shouldStartNewEpoch({
				tailTokens: 0,
				tailBudgetTokens: 100,
				interrupted: true,
			}),
		"epoch pressure uses the mutable-tail budget and explicit interruption",
	);
	if (errors.length > 0)
		throw new Error(`test-context-epoch failed:\n  ✗ ${errors.join("\n  ✗ ")}`);
	console.log(
		"✓ context-epoch: deterministic model, interruption, and pressure transitions",
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
