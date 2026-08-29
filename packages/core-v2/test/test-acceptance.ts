/**
 * Hermetic M2 artifact-policy and content-acceptance contract tests.
 *
 * These tests are pure: no model, network, filesystem, or VCS calls. The
 * acceptance gate observes paths and engine/verification facts; it does not
 * prove semantic user intent.
 */

import {
	ArtifactPolicyError,
	acceptArtifacts,
	finalizeArtifactAcceptance,
	hasArtifactPolicyDeclaration,
	parseArtifactPolicy,
	parseArtifactPolicyStrict,
} from "../src/contracts/index.ts";
import {
	parseTaskSpec,
	parseTaskSpecForCli,
} from "../src/daemon/task-runner.ts";

const BASE = `## Goal
Make the report.

## Requirements
- R1: produce the report

## Verification
- test -f report.md
`;

const errors: string[] = [];
function check(condition: boolean, message: string): void {
	if (!condition) errors.push(message);
}
function rejects(
	thunk: () => unknown,
	code: ArtifactPolicyError["code"],
	message: string,
): void {
	try {
		thunk();
		errors.push(`${message}: accepted invalid policy`);
	} catch (error) {
		check(error instanceof ArtifactPolicyError, `${message}: typed policy error`);
		check(
			error instanceof ArtifactPolicyError && error.code === code,
			`${message}: rejection code ${code}`,
		);
	}
}
function hasCode(
	result: ReturnType<typeof acceptArtifacts>,
	code: string,
): boolean {
	return result.reasons.some((reason) => reason.code === code);
}

export async function runTests(): Promise<void> {
	// Valid strict policies and the task-spec strict entry point.
	const requiredSpec = `${BASE}\n## Artifact Policy\n- Required: report.md\n- Change required\n`;
	const parsed = parseTaskSpecForCli(requiredSpec);
	check(parsed.artifactPolicy.changeRequired, "strict task parser exposes change-required");
	check(
		parsed.artifactPolicy.requiredFiles[0] === "report.md",
		"strict task parser exposes required report",
	);
	check(
		parseTaskSpec(requiredSpec, { artifactPolicyMode: "strict" }).artifactPolicy.changeRequired,
		"explicit strict parser mode works",
	);
	const noChangeSpec = `${BASE}\n## Artifact Policy\n- Intentional no-change\n`;
	check(
		parseArtifactPolicyStrict(noChangeSpec).intentionalNoChange,
		"strict intentional-no-change policy is valid",
	);
	check(hasArtifactPolicyDeclaration(requiredSpec), "policy declaration is detectable");

	// Strict CLI-facing rejection is exhaustive over missing, empty, unsafe,
	// duplicate, contradictory, and unrecognized policy input.
	rejects(() => parseArtifactPolicyStrict(BASE), "missing_policy", "missing policy");
	rejects(
		() => parseArtifactPolicyStrict(`${BASE}\n## Artifact Policy\n`),
		"empty_policy",
		"empty policy",
	);
	for (const unsafe of [
		"/tmp/report.md",
		"../report.md",
		"reports/../../report.md",
		"C:\\report.md",
		"\\\\server\\report.md",
		"",
		"reports//report.md",
		"reports/\0report.md",
	]) {
		rejects(
			() => parseArtifactPolicyStrict(`${BASE}\n## Artifact Policy\n- Required: ${unsafe}\n- Change required\n`),
			"unsafe_path",
			`unsafe path ${JSON.stringify(unsafe)}`,
		);
	}
	rejects(
		() => parseArtifactPolicyStrict(`${BASE}\n## Artifact Policy\n- Required: report.md\n- Required: ./report.md\n- Change required\n`),
		"duplicate_path",
		"duplicate policy paths",
	);
	rejects(
		() => parseArtifactPolicyStrict(`${BASE}\n## Artifact Policy\n- Change required\n- Intentional no-change\n`),
		"contradictory_policy",
		"contradictory policy",
	);
	rejects(
		() => parseArtifactPolicyStrict(`${BASE}\n## Artifact Policy\n- Maybe report.md\n`),
		"unrecognized_policy",
		"unrecognized policy entry",
	);
	check(
		parseArtifactPolicy(BASE).changeRequired,
		"legacy library fallback safely requires a change",
	);

	const policy = {
		requiredFiles: ["report.md"],
		changeRequired: true,
		intentionalNoChange: false,
	} as const;
	const common = {
		policy,
		claimedFiles: ["report.md"],
		actualFiles: ["report.md"],
		presentFiles: ["report.md"],
		hasIntegratedChange: true,
		commitId: "engine-change-1",
		verificationPassed: true,
	};
	const valid = acceptArtifacts(common);
	check(valid.accepted, "valid policy and observable facts are accepted");
	check(valid.actualFiles[0] === "report.md", "authoritative paths are returned");

	// A requested report is checked for presence independently of whether it
	// appears in the changed-path list.
	const missingReport = acceptArtifacts({
		...common,
		actualFiles: [],
		claimedFiles: [],
		presentFiles: [],
		hasIntegratedChange: true,
	});
	check(hasCode(missingReport, "missing_file"), "missing requested report is rejected");

	// An explicitly non-change-required task can pass verification with no diff.
	const noDiff = acceptArtifacts({
		policy: { requiredFiles: ["report.md"], changeRequired: false, intentionalNoChange: false },
		claimedFiles: [],
		actualFiles: [],
		presentFiles: ["report.md"],
		hasIntegratedChange: false,
		verificationPassed: true,
	});
	check(noDiff.accepted, "passing verification with no required diff ships");

	const intentionalDiff = acceptArtifacts({
		policy: { requiredFiles: [], changeRequired: false, intentionalNoChange: true },
		claimedFiles: ["report.md"],
		actualFiles: ["report.md"],
		presentFiles: ["report.md"],
		hasIntegratedChange: true,
		commitId: "engine-change-2",
		verificationPassed: true,
	});
	check(
		hasCode(intentionalDiff, "changed_tree_no_change"),
		"intentional no-change with a diff is rejected",
	);

	const deletedRequired = acceptArtifacts({
		...common,
		presentFiles: [],
		deletedFiles: ["report.md"],
	});
	check(
		hasCode(deletedRequired, "missing_file"),
		"deleted required file is rejected as missing",
	);

	// Claims are compared with authoritative changed paths, while a declared
	// required path is an expected artifact even when the yield omitted it.
	const declaredClaim = acceptArtifacts(common);
	check(!hasCode(declaredClaim, "yield_path_mismatch"), "declared model claim matches");
	const undeclaredClaim = acceptArtifacts({
		...common,
		claimedFiles: ["not-changed.md"],
		actualFiles: ["report.md"],
	});
	check(hasCode(undeclaredClaim, "yield_path_mismatch"), "undeclared model claim is rejected");
	const unexpected = acceptArtifacts({
		...common,
		actualFiles: ["report.md", "surprise.txt"],
	});
	check(hasCode(unexpected, "unexpected_change"), "unexpected changed artifact is rejected");

	const invalidCommit = acceptArtifacts({
		...common,
		commitId: "   ",
	});
	check(hasCode(invalidCommit, "invalid_commit"), "missing engine commit identity is rejected");
	const verificationFailure = acceptArtifacts({
		...common,
		verificationPassed: false,
	});
	check(hasCode(verificationFailure, "verification_failed"), "verification failure is rejected");

	// Engine-derived settlement has no model claims. Every tree fact needed by
	// the policy gate must be supplied by the provider and must agree.
	const engineCommon = {
		...common,
		settlementSource: "engine_derived" as const,
		claimedFiles: [] as const,
		deletedFiles: [] as const,
	};
	const engineValid = acceptArtifacts(engineCommon);
	check(engineValid.accepted, "valid authoritative engine tree is accepted without claims");
	check(
		!hasCode(engineValid, "yield_path_mismatch"),
		"engine settlement does not invent a missing-claim mismatch",
	);
	const engineChangeRequired = acceptArtifacts({
		...engineCommon,
		policy: { requiredFiles: [], changeRequired: true, intentionalNoChange: false },
		actualFiles: ["provider-observed.txt"],
		presentFiles: ["provider-observed.txt"],
	});
	check(
		engineChangeRequired.accepted,
		"provider-observed engine changes need no model claim",
	);
	for (const [label, override, code] of [
		["missing required", { actualFiles: [], presentFiles: [] }, "missing_file"],
		["deleted required", { actualFiles: ["report.md"], presentFiles: [], deletedFiles: ["report.md"] }, "missing_file"],
		["empty required change", { actualFiles: [], presentFiles: ["report.md"], hasIntegratedChange: false }, "empty_change"],
		["missing commit", { commitId: undefined }, "invalid_commit"],
		["failed verification", { verificationPassed: false }, "verification_failed"],
	] as const) {
		const rejected = acceptArtifacts({ ...engineCommon, ...override });
		check(!rejected.accepted && hasCode(rejected, code), `engine ${label} rejects`);
	}
	const absentEvidence = acceptArtifacts({
		...engineCommon,
		actualFiles: undefined,
		presentFiles: undefined,
		deletedFiles: undefined,
	});
	check(!absentEvidence.accepted, "absent authoritative tree evidence rejects");
	check(
		hasCode(absentEvidence, "authoritative_evidence_missing"),
		"absent authoritative evidence has a typed rejection",
	);
	const inconsistentEvidence = acceptArtifacts({
		...engineCommon,
		actualFiles: ["report.md"],
		presentFiles: [],
	});
	check(
		!inconsistentEvidence.accepted && hasCode(inconsistentEvidence, "authoritative_evidence_insufficient"),
		"internally insufficient authoritative evidence rejects",
	);

	// Delivery is a separate stage and either missing transport artifact makes
	// the final result non-ship.
	const deliveryFailure = finalizeArtifactAcceptance(valid, {
		receiptDelivered: false,
		traceDelivered: true,
	});
	check(!deliveryFailure.accepted, "receipt delivery failure is non-ship");
	check(hasCode(deliveryFailure, "receipt_missing"), "receipt failure has typed code");
	const traceFailure = finalizeArtifactAcceptance(valid, {
		receiptDelivered: true,
		traceDelivered: false,
	});
	check(!traceFailure.accepted, "trace delivery failure is non-ship");
	check(hasCode(traceFailure, "trace_missing"), "trace failure has typed code");

	const SEMANTIC_LIMIT = "Acceptance does not prove semantic user intent.";
	check(
		SEMANTIC_LIMIT.includes("does not prove semantic user intent"),
		"test-facing contract documents the semantic acceptance limit",
	);

	if (errors.length > 0) throw new Error(`test-acceptance failed:\n  ✗ ${errors.join("\n  ✗ ")}`);
	console.log("✓ acceptance: strict policy, pure content gate, and delivery finalization");
}

if (process.argv[1]?.endsWith("test-acceptance.ts")) {
	runTests()
		.then(() => process.exit(0))
		.catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		});
}
