/**
 * Hermetic tests for the review report contract (schemas/findings.ts).
 *
 * Zero LLM, zero subprocess: drives TypeBox Value.Check against the schema
 * to lock the contract the reviewer's report_findings tool and the fix loop
 * depend on. Valid shapes pass; malformed shapes (missing fields, bad enums,
 * out-of-range confidence) are rejected.
 *
 * Run standalone: npx tsx extensions/task/test-findings.ts
 */

import { pathToFileURL } from "node:url";
import { Value } from "typebox/value";
import {
	ReviewResultSchema,
	FindingSchema,
	type ReviewResult,
	type Finding,
} from "./schemas/findings.ts";

function sampleFinding(over: Partial<Finding> = {}): Finding {
	return {
		id: "F1",
		priority: "P1",
		confidence: 0.8,
		category: "edge-case",
		file: "src/parser.ts",
		description: "Off-by-one on empty input",
		verification: "Call parse('') and observe the crash",
		...over,
	};
}

function sampleReview(over: Partial<ReviewResult> = {}): ReviewResult {
	return {
		verdict: "fix",
		findings: [sampleFinding()],
		requirements: [
			{ id: "R1", status: "met" },
			{ id: "R2", status: "unmet" },
		],
		...over,
	};
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const ok = (v: unknown): boolean => Value.Check(ReviewResultSchema, v);
	const findingOk = (v: unknown): boolean => Value.Check(FindingSchema, v);

	// 1. Valid shapes pass
	check(ok(sampleReview()), "well-formed ReviewResult should validate");
	check(ok(sampleReview({ findings: [] })), "empty findings (clean review) should validate");
	check(ok(sampleReview({ verdict: "ship" })), "verdict 'ship' should validate");
	check(ok(sampleReview({ verdict: "escalate" })), "verdict 'escalate' should validate");
	check(findingOk(sampleFinding()), "well-formed Finding should validate");
	for (const p of ["P0", "P1", "P2", "P3"] as const) {
		check(findingOk(sampleFinding({ priority: p })), `priority ${p} should validate`);
	}
	for (const s of ["met", "unmet", "uncertain"] as const) {
		check(ok(sampleReview({ requirements: [{ id: "R1", status: s }] })), `requirement status '${s}' should validate`);
	}

	// 2. Missing required fields are rejected
	{
		const r = sampleReview() as Record<string, unknown>;
		delete r.verdict;
		check(!ok(r), "missing verdict should be rejected");
	}
	{
		const f = sampleFinding() as Record<string, unknown>;
		delete f.verification;
		check(!findingOk(f), "finding missing 'verification' should be rejected");
	}
	check(!ok(sampleReview({ requirements: [{ id: "R1" } as never] })), "requirement missing 'status' should be rejected");

	// 3. Closed enums reject unknown values
	check(!findingOk(sampleFinding({ priority: "P5" as never })), "priority 'P5' should be rejected");
	check(!ok(sampleReview({ verdict: "maybe" as never })), "verdict 'maybe' should be rejected");
	check(!ok(sampleReview({ requirements: [{ id: "R1", status: "done" as never }] })), "requirement status 'done' should be rejected");

	// 4. confidence is bounded [0,1]
	check(!findingOk(sampleFinding({ confidence: 1.5 })), "confidence 1.5 should be rejected");
	check(!findingOk(sampleFinding({ confidence: -0.1 })), "confidence -0.1 should be rejected");
	check(findingOk(sampleFinding({ confidence: 0 })), "confidence 0 should validate");
	check(findingOk(sampleFinding({ confidence: 1 })), "confidence 1 should validate");

	// 5. Wrong container types are rejected
	check(!ok(sampleReview({ findings: "none" as never })), "non-array findings should be rejected");

	if (errors.length > 0) {
		throw new Error("test-findings failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log("✓ ReviewResult/Finding schema: valid shapes pass, malformed rejected");
}

// Direct execution support: `npx tsx extensions/task/test-findings.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
