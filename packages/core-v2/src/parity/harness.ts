/**
 * Parity harness (M5 shadow phase) — one canonical spec DAG into both
 * engines, one typed report out.
 *
 * R1 oracle reuse: the v1 side is driven through the SAME surface the
 * M0 smoke tests cover (v1's exported parseSpec/splitSpec via
 * parity/v1-surface.ts) and the v2 side through the real /build
 * pipeline (workflow/build.ts → dag.ts + scheduler.ts via
 * parity/v2-build.ts). No new oracle is invented.
 *
 * R2: `runParity` feeds ONE CanonicalDag to both executors and
 * normalizes each side to comparable manifests/receipts before diffing.
 * The mode flag ("dry" | "real") selects execution without mutating any
 * v1 file; dry runs require zero LLM calls.
 *
 * R3: the report comes from parity/report.ts — typed per-node pass/
 * fail, cost/turns deltas, NFR-3/COR evidence preserved from receipts,
 * a single exit code, and a diff file written only on mismatch.
 */

import { synthesizeDag } from "../workflow/dag.ts";
import type { LedgerStore } from "../ledger/store.ts";
import { validateCanonicalDag } from "./canonical-dag.ts";
import { dryV1Executor, runV1Surface, type V1NodeExecutor } from "./v1-surface.ts";
import { runV2Build, type V2NodeExecutor } from "./v2-build.ts";
import { buildParityReport, parityExitCode, PARITY_EXIT_MISMATCH, PARITY_EXIT_OK } from "./report.ts";
import type { CanonicalDag, NormalizedV2Node, ParityReport } from "./types.ts";

export interface RunParityOptions {
	dag: CanonicalDag;
	/** The ledger fixture the v2 gate reads its approval row from. */
	store: LedgerStore;
	mode?: "dry" | "real" | undefined;
	/** Real-mode seams. Dry mode ignores both. */
	v1Executor?: V1NodeExecutor | undefined;
	v2Executor?: V2NodeExecutor | undefined;
	maxParallel?: number | undefined;
}

export interface ParityRunResult {
	report: ParityReport;
	/** The single exit code (R3): 0 = parity, 1 = mismatch. */
	exitCode: typeof PARITY_EXIT_OK | typeof PARITY_EXIT_MISMATCH;
}

/**
 * Execute the canonical DAG on BOTH engines and diff (R2 + R3).
 *
 * Both sides run over the DAG's stable topological order (workflow/dag.ts
 * synthesis — deterministic Kahn order), so node execution order can
 * never be the source of a parity mismatch.
 */
export async function runParity(options: RunParityOptions): Promise<ParityRunResult> {
	validateCanonicalDag(options.dag);

	const order = synthesizeDag(
		options.dag.nodes.map((n) => ({
			id: n.id,
			spec: {
				goal: "",
				requirements: [],
				verificationCommands: [],
				dependsOn: [...n.dependsOn],
			},
		})),
	).order;

	const mode = options.mode ?? "dry";
	const v1Exec = options.v1Executor ?? (mode === "dry" ? dryV1Executor : undefined);
	if (v1Exec === undefined) {
		throw new Error("runParity: real mode requires v1Executor");
	}
	const v1 = await runV1Surface({
		dag: options.dag,
		order,
		executor: v1Exec,
	});
	const v2: readonly NormalizedV2Node[] = await runV2Build({
		dag: options.dag,
		store: options.store,
		executor: options.v2Executor,
		maxParallel: options.maxParallel,
	});

	const report = buildParityReport({ dag: options.dag, mode, v1, v2 });
	return { report, exitCode: parityExitCode(report) };
}