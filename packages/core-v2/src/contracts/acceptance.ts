/**
 * Pure M2 content acceptance and delivery finalization.
 *
 * Acceptance consumes only facts supplied by trusted/mechanical boundaries:
 * the policy, the integrated tree's changed paths (including deletions), the
 * current tree's present paths, the model's yield claims, the engine-derived
 * commit identity, and verification's result. It does not and cannot prove
 * semantic user intent; that remains outside this contract.
 */

import {
	normalizeArtifactPath,
	type ArtifactPolicy,
} from "./artifact-policy.ts";
import {
	ENGINE_DERIVED_SETTLEMENT_SOURCE,
	MODEL_YIELD_SETTLEMENT_SOURCE,
	type SettlementSource,
} from "./settlement.ts";

/** Typed rejection vocabulary for the content gate. */
export type AcceptanceReasonCode =
	| "missing_file"
	| "empty_change"
	| "changed_tree_no_change"
	| "yield_path_mismatch"
	| "unexpected_change"
	| "authoritative_evidence_missing"
	| "authoritative_evidence_insufficient"
	| "invalid_commit"
	| "invalid_path"
	| "duplicate_path"
	| "verification_failed"
	| "receipt_missing"
	| "trace_missing";

/** Descriptive alias for consumers that call these rejection codes. */
export type AcceptanceRejectionCode = AcceptanceReasonCode;

export interface AcceptanceReason {
	code: AcceptanceReasonCode;
	detail: string;
}

export interface AcceptanceDelivery {
	receiptDelivered: boolean;
	traceDelivered: boolean;
}

export interface ArtifactAcceptance {
	accepted: boolean;
	reasons: AcceptanceReason[];
	/** Authoritative changed paths, including paths that were deleted. */
	actualFiles: string[];
	/** The engine-derived identity, never a model-provided commit claim. */
	commitId?: string;
	delivery?: AcceptanceDelivery;
}

export interface ArtifactAcceptanceInput {
	/** Defaults to model_yield for existing callers. */
	settlementSource?: SettlementSource;
	policy: {
		readonly requiredFiles: readonly string[];
		readonly changeRequired: boolean;
		readonly intentionalNoChange: boolean;
	};
	/** Files claimed by the model's yield; absent for engine-derived settlement. */
	claimedFiles?: readonly string[] | undefined;
	/** Authoritative changed paths on the integrated tree, including deletions. */
	actualFiles?: readonly string[] | undefined;
	/** Current paths present after integration; needed to distinguish a deletion. */
	presentFiles?: readonly string[] | undefined;
	/** Changed paths known to be deletions. */
	deletedFiles?: readonly string[] | undefined;
	/** Whether the engine observed an integrated change. */
	hasIntegratedChange?: boolean | undefined;
	/** Identity obtained from the engine after integration, not from yield. */
	commitId?: string | undefined;
	/** Result returned by the verification driver. */
	verificationPassed?: boolean | undefined;
}

function normalizedPaths(
	paths: readonly string[],
	kind: string,
	reasons: AcceptanceReason[],
): string[] {
	const normalized: string[] = [];
	for (const path of paths) {
		try {
			normalized.push(normalizeArtifactPath(path));
		} catch (error) {
			reasons.push({
				code: "invalid_path",
				detail: `${kind}: ${path} (${error instanceof Error ? error.message : String(error)})`,
			});
		}
	}
	const duplicates = normalized.filter(
		(path, index) => normalized.indexOf(path) !== index,
	);
	for (const path of [...new Set(duplicates)])
		reasons.push({ code: "duplicate_path", detail: `${kind}: ${path}` });
	return [...new Set(normalized)].sort();
}

/**
 * Evaluate content only. Delivery is deliberately a separate stage so a
 * receipt/trace transport problem cannot be confused with repository content.
 */
export function acceptArtifacts(
	input: ArtifactAcceptanceInput,
): ArtifactAcceptance {
	const reasons: AcceptanceReason[] = [];
	const source = input.settlementSource ?? MODEL_YIELD_SETTLEMENT_SOURCE;
	if (source === MODEL_YIELD_SETTLEMENT_SOURCE) {
		if (input.claimedFiles === undefined)
			reasons.push({
				code: "authoritative_evidence_missing",
				detail: "model-yield file claims were not supplied",
			});
		if (input.actualFiles === undefined)
			reasons.push({
				code: "authoritative_evidence_missing",
				detail: "authoritative changed paths were not supplied",
			});
	}
	if (source === ENGINE_DERIVED_SETTLEMENT_SOURCE) {
		for (const [name, value] of [
			["actualFiles", input.actualFiles],
			["presentFiles", input.presentFiles],
			["deletedFiles", input.deletedFiles],
			["hasIntegratedChange", input.hasIntegratedChange],
			["verificationPassed", input.verificationPassed],
		] as const) {
			if (value === undefined || value === null)
				reasons.push({
					code: "authoritative_evidence_missing",
					detail: `${name} was not supplied by the provider`,
				});
		}
	}
	const actual = normalizedPaths(input.actualFiles ?? [], "actual", reasons);
	const claimed = normalizedPaths(input.claimedFiles ?? [], "yield", reasons);
	const required = normalizedPaths(input.policy.requiredFiles, "required", reasons);
	const present = normalizedPaths(
		input.presentFiles ?? (source === MODEL_YIELD_SETTLEMENT_SOURCE ? input.actualFiles ?? [] : []),
		"present",
		reasons,
	);
	const deleted = new Set(
		normalizedPaths(input.deletedFiles ?? [], "deleted", reasons),
	);

	if (source === ENGINE_DERIVED_SETTLEMENT_SOURCE && claimed.length > 0)
		reasons.push({
			code: "authoritative_evidence_insufficient",
			detail: "engine-derived settlement cannot carry model file claims",
		});
	if (source === ENGINE_DERIVED_SETTLEMENT_SOURCE) {
		const actualSet = new Set(actual);
		const presentSet = new Set(present);
		for (const path of deleted) {
			if (!actualSet.has(path) || presentSet.has(path))
				reasons.push({
					code: "authoritative_evidence_insufficient",
					detail: `deleted path is not represented consistently: ${path}`,
				});
		}
		for (const path of actual) {
			if (!deleted.has(path) && !presentSet.has(path))
				reasons.push({
					code: "authoritative_evidence_insufficient",
					detail: `changed path is absent from the final tree: ${path}`,
				});
		}
		if (input.hasIntegratedChange !== actual.length > 0)
			reasons.push({
				code: "authoritative_evidence_insufficient",
				detail: "integrated-change flag disagrees with changed paths",
			});
	}

	for (const path of required) {
		if (!present.includes(path) || deleted.has(path))
			reasons.push({ code: "missing_file", detail: path });
	}
	if (source === MODEL_YIELD_SETTLEMENT_SOURCE) {
		for (const path of claimed) {
			if (!actual.includes(path))
				reasons.push({ code: "yield_path_mismatch", detail: path });
		}
	}
	if (source === MODEL_YIELD_SETTLEMENT_SOURCE) {
		for (const path of actual) {
			if (!claimed.includes(path) && !required.includes(path))
				reasons.push({ code: "unexpected_change", detail: path });
		}
	}
	if (input.policy.changeRequired && !input.hasIntegratedChange) {
		reasons.push({
			code: "empty_change",
			detail: "policy requires an integrated change",
		});
	}
	if (input.policy.intentionalNoChange && input.hasIntegratedChange) {
		reasons.push({
			code: "changed_tree_no_change",
			detail: "intentional no-change policy found an integrated change",
		});
	}
	if (!input.verificationPassed)
		reasons.push({
			code: "verification_failed",
			detail: "verification did not pass",
		});
	if (
		input.hasIntegratedChange &&
		(input.commitId === undefined || input.commitId.trim().length === 0)
	) {
		reasons.push({
			code: "invalid_commit",
			detail: "integrated change has no engine-derived commit identity",
		});
	}

	return {
		accepted: reasons.length === 0,
		reasons,
		actualFiles: actual,
		...(input.commitId === undefined ? {} : { commitId: input.commitId }),
	};
}

/** Name emphasizing that this is the content stage of the contract. */
export const acceptContent = acceptArtifacts;

/**
 * Finalize a content result with transport outcomes. Shipping requires both
 * content acceptance and successful receipt and trace delivery.
 */
export function finalizeArtifactAcceptance(
	content: ArtifactAcceptance,
	delivery: AcceptanceDelivery,
): ArtifactAcceptance {
	const reasons = [...content.reasons];
	if (!delivery.receiptDelivered)
		reasons.push({ code: "receipt_missing", detail: "receipt delivery failed" });
	if (!delivery.traceDelivered)
		reasons.push({ code: "trace_missing", detail: "trace delivery failed" });
	return {
		...content,
		accepted: reasons.length === 0,
		reasons,
		delivery,
	};
}

/** Shorter name for the separate finalization stage. */
export const finalizeAcceptance = finalizeArtifactAcceptance;
