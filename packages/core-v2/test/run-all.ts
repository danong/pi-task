/**
 * core-v2 hermetic test aggregator (M0) — invoked by `mise run test`.
 *
 * Each module below exports runTests(): Promise<void> and can also run
 * standalone. Zero LLM, zero network — same convention as v1's test.ts.
 */

import { pathToFileURL } from "node:url";

import { runTests as runArtifactTests } from "./test-artifacts.ts";
import { runTests as runBundleTests } from "./test-bundle.ts";
import { runTests as runContractTests } from "./test-contracts.ts";
import { runTests as runContinuationTests } from "./test-continuation.ts";
import { runTests as runDaemonTests } from "./test-daemon.ts";
import { runTests as runEnvironmentTests } from "./test-environments.ts";
import { runTests as runGroundingEvalTests } from "./test-grounding-eval.ts";
import { runTests as runJjDriverTests } from "./test-jj-driver.ts";
import { runTests as runParallelTests } from "./test-parallel.ts";
import { runTests as runPrewalkTests } from "./test-prewalk.ts";
import { runTests as runReviewForkTests } from "./test-review-fork.ts";
import { runTests as runLedgerTests } from "./test-ledger.ts";
import { runTests as runRouterTests } from "./test-router.ts";
import { runTests as runVerifyRunTests } from "./test-verify-run.ts";
import { runTests as runWatchdogDriverTests } from "./test-watchdog-driver.ts";
import { runTests as runWatchdogTests } from "./test-watchdogs.ts";

const SUITES: Array<{ name: string; run: () => Promise<void> }> = [
	{ name: "contracts", run: runContractTests },
	{ name: "bundle", run: runBundleTests },
	{ name: "continuation", run: runContinuationTests },
	{ name: "ledger", run: runLedgerTests },
	{ name: "router", run: runRouterTests },
	{ name: "verify-run", run: runVerifyRunTests },
	{ name: "artifacts", run: runArtifactTests },
	{ name: "watchdogs", run: runWatchdogTests },
	{ name: "watchdog-driver", run: runWatchdogDriverTests },
	{ name: "environments", run: runEnvironmentTests },
	{ name: "grounding-eval", run: runGroundingEvalTests },
	{ name: "jj-driver", run: runJjDriverTests },
	{ name: "parallel", run: runParallelTests },
	{ name: "prewalk", run: runPrewalkTests },
	{ name: "review-fork", run: runReviewForkTests },
	{ name: "daemon", run: runDaemonTests },
];

export async function runAll(): Promise<void> {
	for (const suite of SUITES) {
		process.stdout.write(`── ${suite.name} ──\n`);
		await suite.run();
	}
	console.log(`✓ core-v2: ${SUITES.length} suite(s) passed (zero LLM calls)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runAll()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
