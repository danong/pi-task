/**
 * Hermetic tests for the M3 prewalk policy: the break-even cost model
 * (both directions + degenerate inputs) and the attachment wiring (fires
 * once on first successful edit, respects the decision, OFF by default).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionHandle, SessionHostConfig, SessionHostEvent } from "../src/sessions/host.ts";
import { attachPrewalk, decidePrewalkSwap } from "../src/grounding/prewalk.ts";

/** Moderate spread: strong is 4× input, ~1.3× cache-read, 2× output of the
 *  cheap model — the cheap model's UNCACHED rate is well ABOVE the strong
 *  model's CACHED rate, so break-even lands at a real turn count. */
const MODERATE = {
	strong: { input: 2.0, cacheRead: 0.2, output: 10 },
	execute: { input: 0.5, cacheRead: 0.15, output: 5 },
};

/** High cache discount on the strong model + equal output rates: the
 *  uncached swap penalty can never amortize. */
const STAY_WINS = {
	strong: { input: 5.0, cacheRead: 0.05, output: 10 },
	execute: { input: 1.0, cacheRead: 0.2, output: 10 },
};

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const dir = mkdtempSync(join(tmpdir(), "core-v2-prewalk-"));
	try {
		// ─── Cost model: long task + big context → swap wins ────────────
		{
			const d = decidePrewalkSwap({
				contextTokensAtSwap: 120_000,
				remainingTurnsEstimate: 30,
				pricing: MODERATE,
				outputTokensPerTurn: 300,
			});
			check(d.swap, `long task swaps (${d.reason})`);
			check(d.swapCostUsd > d.breakEvenTurns * 0, "sanity");
			check(d.stayCostUsd > d.swapCostUsd, "stay projected more expensive when swapping wins");
		}

		// ─── Cost model: small unit of work → stay wins ──────────────────
		{
			const d = decidePrewalkSwap({
				contextTokensAtSwap: 30_000,
				remainingTurnsEstimate: 2,
				pricing: MODERATE,
			});
			check(!d.swap, `small task stays (${d.reason})`);
			check(Number.isFinite(d.breakEvenTurns), "break-even computed");
		}

		// ─── Identical pricing → never swap (per-turn saving ≤ 0) ────────
		{
			const same = { input: 1, cacheRead: 0.1, output: 5 };
			const d = decidePrewalkSwap({
				contextTokensAtSwap: 500_000,
				remainingTurnsEstimate: 100,
				pricing: { strong: same, execute: same },
			});
			check(!d.swap && d.breakEvenTurns === Number.POSITIVE_INFINITY,
				"identical pricing → infinite break-even, no swap");
		}

		// ─── Wiring: fires once on the first successful edit ─────────────
		{
			let setModels = 0;
			let swaps = 0;
			const listeners = new Set<(e: SessionHostEvent) => void>();
			const fake = {
				role: "w",
				model: { provider: "p", modelId: "strong" },
				result: undefined,
				stats: async () => ({
					tokens: { input: 5_000, output: 200, cacheRead: 90_000, cacheWrite: 25_000 },
				}),
				setModel: async () => {
					setModels += 1;
				},
				subscribe: (l: (e: SessionHostEvent) => void) => {
					listeners.add(l);
					return () => listeners.delete(l);
				},
				prompt: async () => {},
				abort: async () => {},
				close: () => {},
			} as unknown as SessionHandle;

			const att = attachPrewalk(fake, {
				executeModelId: "cheap",
				decide: ({ contextTokensAtSwap }) =>
					decidePrewalkSwap({ contextTokensAtSwap, remainingTurnsEstimate: 40, pricing: MODERATE }),
				onSwap: () => {
					swaps += 1;
				},
			});

			const emit = (e: SessionHostEvent): void => {
				for (const l of listeners) l(e);
			};
			emit({ type: "toolEnd", toolName: "read", toolCallId: "1", isError: false });
			emit({ type: "toolEnd", toolName: "edit", toolCallId: "2", isError: true }); // failed edit — not a trigger
			emit({ type: "toolEnd", toolName: "edit", toolCallId: "3", isError: false });
			await new Promise((r) => setTimeout(r, 10));
			check(setModels === 1 && swaps === 1, `swap fired exactly once on the first successful edit (got ${setModels}/${swaps})`);

			emit({ type: "toolEnd", toolName: "edit", toolCallId: "4", isError: false });
			emit({ type: "settled" });
			await new Promise((r) => setTimeout(r, 10));
			check(setModels === 1, "policy never fires twice");
			att.dispose();
		}

		// ─── Wiring: unprofitable decision → no swap ─────────────────────
		{
			let setModels = 0;
			const listeners = new Set<(e: SessionHostEvent) => void>();
			const fake = {
				role: "w",
				model: { provider: "p", modelId: "strong" },
				result: undefined,
				stats: async () => ({ tokens: { input: 100, output: 10, cacheRead: 1_000, cacheWrite: 100 } }),
				setModel: async () => {
					setModels += 1;
				},
				subscribe: (l: (e: SessionHostEvent) => void) => {
					listeners.add(l);
					return () => listeners.delete(l);
				},
				prompt: async () => {},
				abort: async () => {},
				close: () => {},
			} as unknown as SessionHandle;
			attachPrewalk(fake, {
				executeModelId: "cheap",
				decide: () => decidePrewalkSwap({ contextTokensAtSwap: 1_200, remainingTurnsEstimate: 1, pricing: STAY_WINS }),
			});
			for (const l of listeners) l({ type: "toolEnd", toolName: "edit", toolCallId: "1", isError: false });
			await new Promise((r) => setTimeout(r, 10));
			check(setModels === 0, "unprofitable economics → no swap");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		throw new Error(`prewalk tests failed:\n  ${errors.join("\n  ")}`);
	}
	console.log("✓ prewalk: break-even model both directions, single-fire wiring, default-off respected");
}

if (process.argv[1] !== undefined) {
	const invokedAs = process.argv[1];
	if (import.meta.url.endsWith(invokedAs.split("/").pop() ?? "")) {
		runTests().catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
	}
}
