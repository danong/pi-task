/**
 * Parity barrel — M5 shadow-phase parity harness (docs/pi-task-v2.md §8:
 * "M0's smoke tests are what the shadow phase's parity checks run").
 */

export type {
	CanonicalDag,
	CanonicalDagNode,
	AggregateParity,
	NodeParity,
	NormalizedV1Node,
	NormalizedV2Node,
	ParityExecutionMode,
	ParityReport,
} from "./types.ts";
export { CanonicalDagError, validateCanonicalDag } from "./canonical-dag.ts";
export {
	dryV1Executor,
	normalizeV1Node,
	runV1Surface,
	type V1NodeExecutor,
	type V1NodeOutcome,
	v1SubSpecFor,
} from "./v1-surface.ts";
export {
	dryReceiptFor,
	normalizeV2Node,
	runV2Build,
	type V2NodeExecutor,
} from "./v2-build.ts";
export {
	buildParityReport,
	parityExitCode,
	PARITY_EXIT_MISMATCH,
	PARITY_EXIT_OK,
	renderParityDiff,
	serializeParityReport,
	writeParityReport,
} from "./report.ts";
export { runParity, type ParityRunResult, type RunParityOptions } from "./harness.ts";
