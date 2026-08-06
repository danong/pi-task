/**
 * Fast hermetic test runner — the entire fast suite in one process.
 *
 * Guarantees:
 * - ZERO LLM calls. Convention: fast test files never import
 *   `spawnWorkerSession` or `executeTask` (worker spawning and task
 *   execution are exercised only by test-e2e.ts, which is NOT imported
 *   here). test.ts itself imports only the fast test modules listed below.
 * - Hermetic + deterministic: pure-function unit tests plus real jj /
 *   real bash on temp dirs. No network. The run's own timing line is
 *   authoritative (the real-jj workspace suite dominates).
 * - Each module exports `runTests(): Promise<void>` and can also be run
 *   standalone (`npx tsx extensions/task/test-<name>.ts`).
 *
 * Run: timeout 120 npx tsx extensions/task/test.ts
 *
 * The one real-LLM test is extensions/task/test-e2e.ts (manual, ~$0.01-0.03):
 * timeout 900 npx tsx extensions/task/test-e2e.ts
 */

import { runTests as runJsonlTests } from "./test-jsonl.ts";
import { runTests as runConfigTests } from "./test-config.ts";
import { runTests as runFindingsTests } from "./test-findings.ts";
import { runTests as runPruneTests } from "./test-prune.ts";
import { runTests as runPersonasTests } from "./test-personas.ts";
import { runTests as runReviewTests } from "./test-review.ts";
import { runTests as runMetricsTests } from "./test-metrics.ts";
import { runTests as runWorkerTests } from "./test-worker.ts";
import { runTests as runPrewalkTests } from "./test-prewalk.ts";
import { runTests as runChecklistTests } from "./test-checklist.ts";
import { runTests as runChecklistRelayTests } from "./test-checklist-relay.ts";
import { runTests as runOrchestratorTests } from "./test-orchestrator.ts";
import { runTests as runWorkspaceTests } from "./test-workspace.ts";
import { runTests as runSandboxTests } from "./test-sandbox.ts";
import { runTests as runRepoMapTests } from "./test-repo-map.ts";
import { runTests as runIndexTests } from "./test-index.ts";
import { runTests as runBenchRegressionTests } from "./test-bench-regression.ts";

const SUITES: Array<{ name: string; run: () => Promise<void> }> = [
	{ name: "jsonl", run: runJsonlTests },
	{ name: "config", run: runConfigTests },
	{ name: "findings", run: runFindingsTests },
	{ name: "prune", run: runPruneTests },
	{ name: "personas", run: runPersonasTests },
	{ name: "review", run: runReviewTests },
	{ name: "metrics", run: runMetricsTests },
	{ name: "worker", run: runWorkerTests },
	{ name: "prewalk", run: runPrewalkTests },
	{ name: "checklist", run: runChecklistTests },
	{ name: "checklist-relay", run: runChecklistRelayTests },
	{ name: "orchestrator", run: runOrchestratorTests },
	{ name: "workspace", run: runWorkspaceTests },
	{ name: "sandbox", run: runSandboxTests },
	{ name: "repo-map", run: runRepoMapTests },
	{ name: "index", run: runIndexTests },
	{ name: "bench-regression", run: runBenchRegressionTests },
];

async function main(): Promise<void> {
	const start = Date.now();

	for (const suite of SUITES) {
		const t0 = Date.now();
		try {
			await suite.run();
			console.log(`  ✓ ${suite.name} (${Date.now() - t0}ms)\n`);
		} catch (err) {
			console.error(`  ✗ ${suite.name} FAILED after ${Date.now() - t0}ms\n`);
			console.error(err instanceof Error ? err.message : err);
			process.exit(1);
		}
	}

	const elapsed = ((Date.now() - start) / 1000).toFixed(1);
	console.log(`All fast suites passed in ${elapsed}s (zero LLM calls).`);
}

main().catch((err) => {
	console.error("TEST RUNNER FAILED:", err.message ?? err);
	process.exit(1);
});
