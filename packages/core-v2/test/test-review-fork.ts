/**
 * Hermetic tests for the review-fork file-budget scorer (M3 review-fork
 * mode — packages/core-v2/src/grounding/review-fork.ts). Zero LLM, zero
 * network, zero fs: pure-function coverage of
 *   - anchors/key files never dropped (R1)
 *   - budget caps respected for optional files, mandatory overflow ships (R1)
 *   - union-after-merge: attemptFiles survive even when the combined tree's
 *     diff is dominated by other workers' files (R2)
 *   - determinism: same input → identical output, order-independent (R3)
 *
 * Standalone: npx tsx packages/core-v2/test/test-review-fork.ts
 */

import { pathToFileURL } from "node:url";

import { defaultReviewForkScorer, pruneReviewFiles } from "../src/grounding/review-fork.ts";
import type { FileEntry, ReviewForkScorer } from "../src/grounding/review-fork.ts";

const f = (path: string, bytes: number): FileEntry => ({ path, bytes });
const paths = (files: readonly FileEntry[]): string[] => files.map((x) => x.path);

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// ─── Anchors / key files never dropped (R1) ──────────────────────
	{
		const out = pruneReviewFiles({
			files: [f("a.ts", 100), f("b.ts", 100), f("c.ts", 100)],
			anchors: ["b.ts"],
			keyFiles: ["c.ts"],
			budget: { maxFiles: 1, maxBytes: 50 },
		});
		check(paths(out.kept).includes("b.ts"), "anchor kept despite maxFiles=1");
		check(paths(out.kept).includes("c.ts"), "keyFile kept despite caps");
		check(!paths(out.kept).includes("a.ts"), "optional file dropped under tight caps");
	}

	// ─── Budget caps respected for optional files ─────────────────────
	{
		const out = pruneReviewFiles({
			files: [f("a.ts", 10), f("b.ts", 10), f("c.ts", 10)],
			budget: { maxFiles: 2 },
		});
		check(paths(out.kept).length === 2, `maxFiles cap respected (got ${out.kept.length})`);
		check(JSON.stringify(paths(out.dropped)) === JSON.stringify(["c.ts"]),
			"lexicographic fill keeps a,b drops c");
	}
	{
		const out = pruneReviewFiles({
			files: [f("big.ts", 900), f("small.ts", 100), f("tiny.ts", 10)],
			budget: { maxBytes: 120 },
		});
		check(out.keptBytes === 110, `maxBytes cap respected (kept ${out.keptBytes})`);
		check(JSON.stringify(paths(out.kept)) === JSON.stringify(["small.ts", "tiny.ts"]),
			"byte cap fills lexicographically until exhausted");
		check(paths(out.dropped).includes("big.ts"), "oversized optional file dropped");
	}

	// ─── Mandatory set alone over budget → still ships (R2 invariant) ─
	{
		const out = pruneReviewFiles({
			files: [f("must-a.ts", 500), f("must-b.ts", 500)],
			anchors: ["must-a.ts", "must-b.ts"],
			budget: { maxFiles: 0, maxBytes: 1 },
		});
		check(paths(out.kept).length === 2, `anchors ship even over impossible caps (got ${out.kept.length})`);
		check(out.dropped.length === 0, "nothing to drop beyond anchors");
	}

	// ─── Union-after-merge: never hide the attempt under review (R2) ──
	{
		// Two workers squashed into the integration base; worker k changed
		// only src/k.ts while the union carries five files.
		const unionDiff = [
			f("src/a.ts", 400),
			f("src/b.ts", 400),
			f("src/c.ts", 400),
			f("src/d.ts", 400),
			f("src/k.ts", 300),
		];
		const out = pruneReviewFiles({
			files: unionDiff,
			attemptFiles: ["src/k.ts"],
			budget: { maxFiles: 2 },
		});
		check(paths(out.kept).includes("src/k.ts"),
			`attempt file survives the merge union under maxFiles=2 (kept ${JSON.stringify(paths(out.kept))})`);
		check(paths(out.kept).length === 2,
			"cap still bounds total files around the mandatory attempt set");
		check(paths(out.dropped).length === 3 && !paths(out.dropped).includes("src/k.ts"),
			"only non-attempt files were dropped");

		// Per-worker commit + combined tree views dedupe into one entry.
		const mergedViews = [...unionDiff, f("src/k.ts", 350)];
		const deduped = pruneReviewFiles({ files: mergedViews, budget: {} });
		check(deduped.kept.filter((x) => x.path === "src/k.ts").length === 1,
			"same path from per-worker commit and combined tree collapses to one entry");
	}

	// ─── Attempt/anchor files absent from the union still surface ─────
	{
		const out = pruneReviewFiles({
			files: [f("other.ts", 10)],
			anchors: ["docs/spec.md"],
			attemptFiles: ["src/gone.ts"],
			budget: {},
		});
		check(paths(out.kept).includes("docs/spec.md") && paths(out.kept).includes("src/gone.ts"),
			"union-missing anchor + attempt file synthesized as kept entries");
	}

	// ─── Determinism (R3) ─────────────────────────────────────────────
	{
		const input = {
			files: [f("z.ts", 5), f("m.ts", 7), f("a.ts", 3), f("q.ts", 11)],
			anchors: ["q.ts"],
			attemptFiles: ["m.ts"],
			budget: { maxFiles: 3, maxBytes: 20 },
		};
		const first = JSON.stringify(pruneReviewFiles(input));
		for (let i = 0; i < 10; i += 1) {
			if (JSON.stringify(pruneReviewFiles(input)) !== first) {
				errors.push("repeated calls on the same input diverged");
				break;
			}
		}
		// Structurally equal input built independently decides identically.
		const rebuilt = {
			files: [f("m.ts", 7), f("a.ts", 3), f("q.ts", 11), f("z.ts", 5)],
			anchors: ["q.ts"],
			attemptFiles: ["m.ts"],
			budget: { maxFiles: 3, maxBytes: 20 },
		};
		check(JSON.stringify(pruneReviewFiles(rebuilt)) === first,
			"structurally-equal inputs decide identically regardless of input order");
	}

	// ─── Degenerate inputs stay pure and typed ─────────────────────────
	{
		const empty = pruneReviewFiles({ files: [], budget: { maxFiles: 5 } });
		check(empty.kept.length === 0 && empty.dropped.length === 0 && empty.keptBytes === 0,
			"empty diff prunes to an empty result");

		const negative = pruneReviewFiles({
			files: [f("neg.ts", -50)],
			budget: { maxBytes: 100 },
		});
		check(negative.kept.length === 1 && negative.kept[0]?.bytes === 0,
			"negative byte counts clamp to zero (never inflate the budget)");

		const dupes = pruneReviewFiles({
			files: [f("d.ts", 10), f("d.ts", 30)],
			budget: {},
		});
		check(dupes.kept.length === 1 && dupes.kept[0]?.bytes === 30,
			"duplicate paths keep the largest observed size");
	}

	// ─── Pluggable scorer interface stays symmetric (R1) ──────────────
	{
		check(defaultReviewForkScorer.name === "bounded-file-budget",
			"default scorer is named for config selection");
		const custom: ReviewForkScorer = {
			name: "keep-nothing",
			prune: (input) => ({
				kept: [],
				dropped: [...input.files],
				keptBytes: 0,
			}),
		};
		const viaInterface = custom.prune({
			files: [f("x.ts", 1)],
			budget: { maxFiles: 1 },
		});
		check(viaInterface.dropped.length === 1 && viaInterface.kept.length === 0,
			"alternative strategies plug in behind the same interface");
	}

	// ─── Input arrays are not mutated (pure) ───────────────────────────
	{
		const files = [f("b.ts", 2), f("a.ts", 1)];
		const before = JSON.stringify(files);
		pruneReviewFiles({ files, budget: { maxFiles: 1 } });
		check(JSON.stringify(files) === before, "pruneReviewFiles must not mutate its input");
	}

	if (errors.length > 0) {
		throw new Error("test-review-fork failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log("✓ review-fork: anchors/attempt files pinned, caps bounded, merge-union safe, deterministic");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
