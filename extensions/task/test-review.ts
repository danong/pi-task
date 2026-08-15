/**
 * Hermetic tests for the review runner's pure logic (review.ts):
 * buildReviewPrompt (review-context assembly), settleReview (outcome
 * settling), and the watchdog decisions (todo #80: decideFirstEventAction,
 * the review no-progress decision reusing worker.ts's decideNoProgressAction,
 * and the first-event/no-progress error messages). forkedReview itself
 * spawns a real pi process and is covered by test-e2e.ts. No subprocess,
 * no LLM here.
 *
 * Run standalone: npx tsx extensions/task/test-review.ts
 */

import { pathToFileURL } from "node:url";
import {
	buildReviewPrompt,
	settleReview,
	mergeReviewOutcomes,
	decideFirstEventAction,
	firstEventTimeoutErrorMessage,
	reviewNoProgressErrorMessage,
	REVIEW_FIRST_EVENT_TIMEOUT_MS,
	REVIEW_NO_PROGRESS_TIMEOUT_MS,
	REVIEW_WALL_TIMEOUT_MS,
} from "./review.ts";
import { decideNoProgressAction, WORKER_NO_PROGRESS_TIMEOUT_MS } from "./worker.ts";
import type { Finding, ReviewResult } from "./schemas/findings.ts";

const REVIEW: ReviewResult = {
	verdict: "ship",
	findings: [],
	requirements: [{ id: "R1", status: "met" }],
};

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// ─── buildReviewPrompt ───
	{
		const prompt = buildReviewPrompt({
			specMarkdown: "## Goal\nDo X\n## Requirements\n- R1: x\n## Verification\n- true",
			diff: "diff --git a/f b/f\n+line",
			summary: "did the thing",
			deviations: [],
		});
		check(prompt.includes("report_findings"), "prompt should instruct report_findings");
		check(prompt.includes("## Spec") && prompt.includes("Do X"), "prompt should carry the spec");
		check(prompt.includes("## Final diff") && prompt.includes("+line"), "prompt should carry the diff in a fence");
		check(prompt.includes("## Worker summary") && prompt.includes("did the thing"), "prompt should carry the summary");
		check(!prompt.toLowerCase().includes("deviation"), "no deviations section when deviations empty");
	}
	{
		const prompt = buildReviewPrompt({ specMarkdown: "s", diff: "d", summary: "m", deviations: ["skipped R2", "used lib Y"] });
		check(prompt.includes("## Worker-declared deviations"), "deviations section present when non-empty");
		check(prompt.includes("- skipped R2") && prompt.includes("- used lib Y"), "deviations listed");
	}

	// ─── mergeReviewOutcomes (parallel review axes) ───
	{
		const mk = (over: Partial<ReviewResult> = {}): ReviewResult => ({
			verdict: "ship",
			findings: [],
			requirements: [],
			...over,
		});
		const finding = (id: string, priority: "P0" | "P1" | "P2"): Finding => ({
			id, priority, confidence: 0.8, category: "design", file: "a.ts",
			description: id, verification: "grep",
		});
		// Single axis → passthrough, cost carried.
		const single = mergeReviewOutcomes([{ result: mk({ verdict: "fix" }), usage: { cost_usd: 0.01 } }]);
		check(single.result.verdict === "fix" && single.costUsd === 0.01, "single axis passes through verdict + cost");
		// Two axes: findings concatenated, verdict = worst, requirements worst per id.
		const merged = mergeReviewOutcomes([
			{ result: mk({ verdict: "ship", findings: [finding("F1", "P2")], requirements: [{ id: "R1", status: "met" }] }), usage: { cost_usd: 0.01 } },
			{ result: mk({ verdict: "fix", findings: [finding("F2", "P1")], requirements: [{ id: "R1", status: "uncertain" }, { id: "R2", status: "unmet" }] }), usage: { cost_usd: 0.02 } },
		]);
		check(merged.result.verdict === "fix", "verdict = worst across axes");
		check(merged.result.findings.length === 2 && merged.result.findings.some((f) => f.id === "F2"),
			"findings concatenated across axes");
		check(merged.result.requirements.find((r) => r.id === "R1")?.status === "uncertain",
			"R1 worst status (uncertain > met) wins");
		check(merged.result.requirements.find((r) => r.id === "R2")?.status === "unmet", "R2 unmet survives");
		check(Math.abs(merged.costUsd - 0.03) < 1e-9, "review cost summed across axes");
		// Escalate wins over everything.
		const worst = mergeReviewOutcomes([
			{ result: mk({ verdict: "fix" }), usage: { cost_usd: 0 } },
			{ result: mk({ verdict: "escalate" }), usage: { cost_usd: 0 } },
		]);
		check(worst.result.verdict === "escalate", "escalate is the worst verdict");
		// Empty → vacuous ship.
		const empty = mergeReviewOutcomes([]);
		check(empty.result.verdict === "ship" && empty.result.findings.length === 0 && empty.costUsd === 0,
			"empty outcomes → ship, no findings, zero cost");
		console.log("✓ mergeReviewOutcomes: verdict worst, findings concat, requirements worst-per-id, cost summed");
	}

	{
		const ok = settleReview(REVIEW, 0, "");
		check(ok.ok === true, "captured report → ok");
		if (ok.ok) check(ok.result === REVIEW, "settled result is the captured report");
	}
	{
		const fail = settleReview(null, 2, "boom\nstack");
		check(fail.ok === false, "no report → failure");
		if (!fail.ok) {
			check(fail.error.message.includes("Reviewer exited (code 2) without reporting findings."),
				`error includes exit code, got: ${fail.error.message}`);
			check(fail.error.message.includes("stderr: boom"), `error includes stderr, got: ${fail.error.message}`);
		}
	}
	{
		const quiet = settleReview(null, 1, "   ");
		if (!quiet.ok) check(!quiet.error.message.includes("stderr:"), `empty stderr omitted, got: ${quiet.error.message}`);
	}
	{
		const long = settleReview(null, 1, "x".repeat(700));
		if (!long.ok) {
			const detail = long.error.message.split("stderr: ")[1] ?? "";
			check(detail.length === 500, `stderr sliced to 500, got ${detail.length}`);
		}
	}

	// ─── Reviewer watchdogs (todo #80: fail-fast, not 20-min-wait) ───

	// 1. Window ordering contract: first-call < no-progress < wall, and the
	//    review no-progress window is shorter than the worker's
	{
		const ordered =
			REVIEW_FIRST_EVENT_TIMEOUT_MS < REVIEW_NO_PROGRESS_TIMEOUT_MS &&
			REVIEW_NO_PROGRESS_TIMEOUT_MS < REVIEW_WALL_TIMEOUT_MS;
		check(ordered, `watchdog ordering violated: first-call ${REVIEW_FIRST_EVENT_TIMEOUT_MS} < no-progress ${REVIEW_NO_PROGRESS_TIMEOUT_MS} < wall ${REVIEW_WALL_TIMEOUT_MS}`);
		check(
			REVIEW_NO_PROGRESS_TIMEOUT_MS < WORKER_NO_PROGRESS_TIMEOUT_MS,
			`review no-progress window (${REVIEW_NO_PROGRESS_TIMEOUT_MS}) must be shorter than the worker's (${WORKER_NO_PROGRESS_TIMEOUT_MS})`,
		);
	}

	// 2. No-progress decision (reuses worker.ts's decideNoProgressAction):
	//    any event resets the clock; silence past the window → abort
	{
		check(
			decideNoProgressAction({ nowMs: 1_000, lastActivityMs: 500, timeoutMs: 1_000, inToolCall: false }) === null,
			"recent event resets the no-progress clock → null",
		);
		check(
			decideNoProgressAction({ nowMs: 1_500, lastActivityMs: 500, timeoutMs: 1_000, inToolCall: false }) === "abort",
			"no activity past the window → abort",
		);
	}

	// 3. An in-flight tool execution counts as progress even far past the window
	{
		check(
			decideNoProgressAction({ nowMs: 1_000_000, lastActivityMs: 0, timeoutMs: 1_000, inToolCall: true }) === null,
			"in-flight tool call counts as progress (long silent bash/test tools are legit)",
		);
	}

	// 4. Option overrides: the decisions honor custom (non-default) windows
	{
		check(
			decideNoProgressAction({ nowMs: 90_000, lastActivityMs: 0, timeoutMs: 60_000, inToolCall: false }) === "abort",
			"custom noProgressTimeoutMs (shorter) honored → abort",
		);
		check(
			decideNoProgressAction({ nowMs: 90_000, lastActivityMs: 0, timeoutMs: 120_000, inToolCall: false }) === null,
			"custom noProgressTimeoutMs (longer) honored → still within window",
		);
		check(
			decideFirstEventAction({ nowMs: 120_000, promptWrittenAtMs: 0, deadlineMs: 60_000, firstEventArrived: false }) === "abort",
			"custom firstEventTimeoutMs honored → abort at custom deadline",
		);
	}

	// 5. reviewNoProgressErrorMessage names the cause + window + wall
	{
		const msg = reviewNoProgressErrorMessage(REVIEW_NO_PROGRESS_TIMEOUT_MS, REVIEW_WALL_TIMEOUT_MS);
		check(msg.includes("no progress"), `no-progress message names the cause, got: ${msg}`);
		check(msg.includes("5m"), `no-progress message names the window, got: ${msg}`);
		check(msg.includes("20m"), `no-progress message names the wall limit, got: ${msg}`);
	}

	// 6. decideFirstEventAction: fires when nothing arrives, not when an event arrives
	{
		check(
			decideFirstEventAction({ nowMs: 59_000, promptWrittenAtMs: 0, deadlineMs: 60_000, firstEventArrived: false }) === null,
			"no first event within the deadline → still waiting",
		);
		check(
			decideFirstEventAction({ nowMs: 60_000, promptWrittenAtMs: 0, deadlineMs: 60_000, firstEventArrived: false }) === "abort",
			"no first event exactly at the deadline → abort",
		);
		check(
			decideFirstEventAction({ nowMs: 100_000, promptWrittenAtMs: 0, deadlineMs: 60_000, firstEventArrived: false }) === "abort",
			"no first event past the deadline → abort",
		);
		check(
			decideFirstEventAction({ nowMs: 100_000, promptWrittenAtMs: 0, deadlineMs: 60_000, firstEventArrived: true }) === null,
			"first event arrived → deadline no longer applies",
		);
	}

	// 7. firstEventTimeoutErrorMessage names the stalled first call
	{
		const msg = firstEventTimeoutErrorMessage(REVIEW_FIRST_EVENT_TIMEOUT_MS, REVIEW_WALL_TIMEOUT_MS);
		check(msg.includes("first model call"), `first-event message names the stalled call, got: ${msg}`);
		check(msg.includes("no events"), `first-event message names the cause, got: ${msg}`);
		check(msg.includes("3m"), `first-event message names the deadline, got: ${msg}`);
	}

	if (errors.length > 0) {
		throw new Error("test-review failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log("✓ review: buildReviewPrompt assembly + settleReview branches + watchdog decisions");
}

// Direct execution support: `npx tsx extensions/task/test-review.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
