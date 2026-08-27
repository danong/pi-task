/**
 * core-v2 hermetic test aggregator (M0) — invoked by `mise run test`.
 *
 * Each module below exports runTests(): Promise<void> and can also run
 * standalone. Zero LLM, zero network — same convention as v1's test.ts.
 */

import { pathToFileURL } from "node:url";

import { runTests as runArtifactTests } from "./test-artifacts.ts";
import { runTests as runAcceptanceTests } from "./test-acceptance.ts";
import { runTests as runBenchmarkTests } from "./test-benchmark.ts";
import { runTests as runBundleTests } from "./test-bundle.ts";
import { runTests as runContractTests } from "./test-contracts.ts";
import { runTests as runContinuationTests } from "./test-continuation.ts";
import { runTests as runCliTests } from "./test-cli.ts";
import { runTests as runDaemonTests } from "./test-daemon.ts";
import { runTests as runEnvironmentTests } from "./test-environments.ts";
import { runTests as runFailureHygieneTests } from "./test-failure-hygiene.ts";
import { runTests as runGatewayTests } from "./test-gateway.ts";
import { runTests as runGatewayPluginsTests } from "./test-gateway-plugins.ts";
import { runTests as runGroundingEvalTests } from "./test-grounding-eval.ts";
import { runTests as runJjDriverTests } from "./test-jj-driver.ts";
import { runTests as runParallelTests } from "./test-parallel.ts";
import { runTests as runPrewalkTests } from "./test-prewalk.ts";
import { runTests as runReviewForkTests } from "./test-review-fork.ts";
import { runTests as runLedgerTests } from "./test-ledger.ts";
import { runTests as runLifecycleCollectorPluginTests } from "./test-plugins-lifecycle.ts";
import { runTests as runHandoffCapPluginTests } from "./test-plugins-handoff-cap.ts";
import { runTests as runRouterTests } from "./test-router.ts";
import { runTests as runSurfacesTests } from "./test-surfaces.ts";
import { runTests as runTraceTests } from "./test-trace.ts";
import { runTests as runVerifyRunTests } from "./test-verify-run.ts";
import { runTests as runWatchdogDriverTests } from "./test-watchdog-driver.ts";
import { runTests as runWatchdogTests } from "./test-watchdogs.ts";
import { runTests as runWorkflowPlanTests } from "./test-workflow-plan.ts";
import { runTests as runWorkflowBuildTests } from "./test-workflow-build.ts";
import { runTests as runWorkflowReceiptsTests } from "./test-workflow-receipts.ts";
import { runTests as runWorkflowSurveyTests } from "./test-workflow-survey.ts";
import { runTests as runParityM5Tests } from "./test-parity-m5.ts";
import { runTests as runWorkerProtocolTests } from "./test-worker-protocol.ts";

const SUITES: Array<{ name: string; run: () => Promise<void> }> = [
	{ name: "contracts", run: runContractTests },
	{ name: "bundle", run: runBundleTests },
	{ name: "continuation", run: runContinuationTests },
	{ name: "cli", run: runCliTests },
	{ name: "ledger", run: runLedgerTests },
	{ name: "router", run: runRouterTests },
	{ name: "verify-run", run: runVerifyRunTests },
	{ name: "artifacts", run: runArtifactTests },
	{ name: "acceptance", run: runAcceptanceTests },
	{ name: "benchmark", run: runBenchmarkTests },
	{ name: "watchdogs", run: runWatchdogTests },
	{ name: "watchdog-driver", run: runWatchdogDriverTests },
	{ name: "environments", run: runEnvironmentTests },
	{ name: "gateway", run: runGatewayTests },
	{ name: "surfaces", run: runSurfacesTests },
	{ name: "trace", run: runTraceTests },
	{ name: "workflow-plan", run: runWorkflowPlanTests },
	{ name: "workflow-build", run: runWorkflowBuildTests },
	{ name: "workflow-receipts", run: runWorkflowReceiptsTests },
	{ name: "workflow-survey", run: runWorkflowSurveyTests },
	{ name: "parity-m5", run: runParityM5Tests },
	{ name: "gateway-plugins", run: runGatewayPluginsTests },
	{ name: "plugin-handoff-cap", run: runHandoffCapPluginTests },
	{ name: "plugin-lifecycle-collector", run: runLifecycleCollectorPluginTests },
	{ name: "grounding-eval", run: runGroundingEvalTests },
	{ name: "jj-driver", run: runJjDriverTests },
	{ name: "failure-hygiene", run: runFailureHygieneTests },
	{ name: "parallel", run: runParallelTests },
	{ name: "prewalk", run: runPrewalkTests },
	{ name: "review-fork", run: runReviewForkTests },
	{ name: "daemon", run: runDaemonTests },
	{ name: "worker-protocol", run: runWorkerProtocolTests },
];

export async function runAll(): Promise<void> {
	for (const suite of SUITES) {
		process.stdout.write(`── ${suite.name} ──\n`);
		await suite.run();
	}
	console.log(`✓ core-v2: ${SUITES.length} suite(s) passed (zero LLM calls)`);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runAll()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		});
}
