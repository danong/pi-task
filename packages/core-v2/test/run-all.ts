/**
 * core-v2 hermetic test aggregator (M0) — invoked by `mise run test`.
 *
 * Each module below exports runTests(): Promise<void> and can also run
 * standalone. Zero LLM, zero network — same convention as v1's test.ts.
 */

import { pathToFileURL } from "node:url";

import { runTests as runContractTests } from "./test-contracts.ts";
import { runTests as runLedgerTests } from "./test-ledger.ts";
import { runTests as runRouterTests } from "./test-router.ts";

const SUITES: Array<{ name: string; run: () => Promise<void> }> = [
	{ name: "contracts", run: runContractTests },
	{ name: "ledger", run: runLedgerTests },
	{ name: "router", run: runRouterTests },
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
