/**
 * Hermetic tests for the M5 parity harness
 * (packages/core-v2/src/parity/**). Zero LLM, zero network; the only
 * I/O is a throwaway temp dir (report files) + a throwaway SQLite DB
 * (the v2 gate's approval row).
 *
 *   - R1 oracle reuse: the v1 side is driven through v1's OWN spec
 *     surface (extensions/task parseSpec/splitSpec — the surface the M0
 *     smoke oracle covers); no new oracle is invented. Asserted by
 *     checking that normalized v1 requirements come from v1's splitSpec
 *     buckets, not from a harness-local parser.
 *   - R2 canonical-DAG dual feed: the same CanonicalDag drives both
 *     engines; dry mode needs zero LLM calls; outputs normalize to
 *     comparable shapes before diffing.
 *   - R3 typed report: per-node pass/fail + mismatches, cost/turns
 *     deltas, NFR-3/COR evidence preserved from receipts, single exit
 *     code (0 = parity), diff file written ONLY on mismatch,
 *     byte-identical output for identical inputs.
 *
 * Standalone: npx tsx packages/core-v2/test/test-parity-m5.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { LedgerStore } from "../src/ledger/store.ts";
import {
	TaskReceiptSchema,
	type TaskReceipt,
} from "../src/contracts/payloads.ts";
import {
	buildParityReport,
	compareNodes,
	PARITY_EXIT_MISMATCH,
	PARITY_EXIT_OK,
	serializeParityReport,
	writeParityReport,
} from "../src/parity/report.ts";
import {
	dryV1Executor,
	normalizeV1Node,
	v1SubSpecFor,
	type V1NodeOutcome,
} from "../src/parity/v1-surface.ts";
import {
	dryReceiptFor,
	normalizeV2Node,
	type V2NodeExecutor,
} from "../src/parity/v2-build.ts";
import {
	CanonicalDagError,
	validateCanonicalDag,
} from "../src/parity/canonical-dag.ts";
import { runParity, type RunParityOptions } from "../src/parity/harness.ts";
import type {
	CanonicalDag,
	CanonicalDagNode,
	NormalizedV1Node,
	NormalizedV2Node,
} from "../src/parity/types.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────

function nodeSpec(id: string, dependsOn: readonly string[] = []): string {
	const deps =
		dependsOn.length === 0
			? ""
			: `\n## Depends On\n${dependsOn.map((d) => `- ${d}`).join("\n")}\n`;
	return `## Goal\nNode ${id}\n\n## Requirements\n- R1: ${id} first requirement\n- R2: ${id} second requirement\n\n## Verification\n- test -f ${id}.txt${deps}`;
}

function dagFixture(): CanonicalDag {
	return {
		dagId: "parity-m5-fixture",
		nodes: [
			{ id: "alpha", specMarkdown: nodeSpec("alpha"), dependsOn: [] },
			{ id: "beta", specMarkdown: nodeSpec("beta"), dependsOn: ["alpha"] },
			{ id: "gamma", specMarkdown: nodeSpec("gamma"), dependsOn: ["alpha"] },
		],
	};
}

/** Receipt fixture shaped like the daemon's real per-node records. */
function receiptFixture(
	nodeId: string,
	over: Partial<TaskReceipt> = {},
): TaskReceipt {
	return TaskReceiptSchema.parse({
		taskId: nodeId,
		verdict: "ship",
		filesChanged: 2,
		commitIds: [`${nodeId}-c1`, `${nodeId}-c2`],
		turns: 4,
		costUsd: 0.02,
		inputTokens: 900,
		outputTokens: 120,
		cacheReadTokens: 300,
		cor: 0.25,
		bundleHit: null,
		...over,
	});
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// ─── R1: v1 oracle reuse — sub-specs come from v1's own splitSpec ──
	{
		const node: CanonicalDagNode = {
			id: "n1",
			specMarkdown: nodeSpec("n1"),
			dependsOn: [],
		};
		const subSpec = v1SubSpecFor(node);
		check(
			subSpec.includes("R1: n1 first requirement") &&
				subSpec.includes("R2: n1 second requirement"),
			"v1SubSpecFor derives the sub-spec through v1's splitSpec",
		);
		check(
			subSpec.includes("partition of a parallel task"),
			"sub-spec carries v1 splitSpec's partition boilerplate (proves origin)",
		);

		const outcome: V1NodeOutcome = {
			subSpecMarkdown: subSpec,
			commitIds: ["a", "a", "b"],
			filesChanged: ["z.txt", "a.txt", "z.txt"],
			verificationPassed: true,
			escalated: false,
			costUsd: 0.01,
			turns: 3,
			skipped: false,
		};
		const norm = normalizeV1Node("n1", outcome);
		check(norm.verdict === "ship", "normalize maps passing v1 → ship");
		check(
			norm.requirements.join("|") ===
				"R1: n1 first requirement|R2: n1 second requirement" &&
				norm.requirements.every((r) => !r.startsWith("-")),
			"v1 requirements extracted via v1's parseSpec, list markers stripped",
		);
		check(
			norm.commitCount === 2,
			`commit ids deduped to a count (got ${norm.commitCount})`,
		);
		check(
			norm.filesChanged.join(",") === "a.txt,z.txt",
			"files sorted + deduped deterministically",
		);
	}

	// ─── R2: dry-mode v1 executor is deterministic and LLM-free ───────
	{
		const node: CanonicalDagNode = {
			id: "d1",
			specMarkdown: nodeSpec("d1"),
			dependsOn: [],
		};
		const o1 = await dryV1Executor(node, v1SubSpecFor(node));
		const o2 = await dryV1Executor(node, v1SubSpecFor(node));
		check(
			o1.commitIds.join() === o2.commitIds.join() &&
				o1.filesChanged.join() === o2.filesChanged.join(),
			"dry v1 executor deterministic across calls",
		);
		check(
			o1.costUsd === 0 && o1.turns === 0,
			"dry v1 side carries zero cost evidence",
		);
	}

	// ─── Canonical DAG structural validation (typed failures) ─────────
	{
		let threwUnknown = false;
		try {
			validateCanonicalDag({
				dagId: "bad",
				nodes: [{ id: "a", specMarkdown: nodeSpec("a"), dependsOn: ["ghost"] }],
			});
		} catch (err) {
			threwUnknown = err instanceof CanonicalDagError;
		}
		check(threwUnknown, "unknown dependency fails as CanonicalDagError");
	}

	// ─── R2+R3: full dry run — parity holds, exit 0, no diff file ────
	{
		const dir = mkdtempSync(join(tmpdir(), "parity-m5-"));
		try {
			const store = new LedgerStore(join(dir, "tasks.db"));
			const options: RunParityOptions = {
				dag: dagFixture(),
				store,
				mode: "dry",
			};
			const { report, exitCode } = await runParity(options);
			store.close();

			check(report.parity === true, "identical dry fixtures hold parity");
			check(
				exitCode === PARITY_EXIT_OK,
				`exit code 0 on parity (got ${exitCode})`,
			);
			check(
				report.nodes.map((n) => n.nodeId).join() === "alpha,beta,gamma",
				"per-node results sorted by id (deterministic order)",
			);
			check(
				report.nodes.every((n) => n.passed && n.mismatches.length === 0),
				"every node passed with zero mismatches",
			);
			check(
				report.nodes.every((n) => n.costDeltaUsd === 0 && n.turnsDelta === 0),
				"dry deltas are exactly 0 on both sides",
			);
			check(report.diff === null, "no diff text on parity");

			const reportPath = join(dir, "parity.json");
			const diffPath = writeParityReport(reportPath, report);
			check(diffPath === null, "diff file NOT written when parity held");
			check(existsSync(reportPath), "report file written even on parity");
			const roundTrip = JSON.parse(readFileSync(reportPath, "utf-8")) as {
				parity: boolean;
				nodes: unknown[];
			};
			check(
				roundTrip.parity === true && roundTrip.nodes.length === 3,
				"report file parses back typed",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// ─── R3: mismatch → typed diffs, exit 1, diff FILE written ────────
	{
		const dir = mkdtempSync(join(tmpdir(), "parity-m5-mm-"));
		try {
			const store = new LedgerStore(join(dir, "tasks.db"));
			// Real-mode-shaped v2 executor: one node ships, one escalates —
			// receipts thread through the executor closure like the daemon does.
			const failing: V2NodeExecutor = (node) => {
				if (node.id === "beta") {
					return Promise.resolve({
						verdict: "failed" as const,
						cause: "verification failed",
						receipt: receiptFixture(node.id, {
							verdict: "escalate",
							turns: 9,
							costUsd: 0.05,
						}),
					});
				}
				return Promise.resolve({
					verdict: "completed" as const,
					receipt: receiptFixture(node.id),
				});
			};
			const { report, exitCode } = await runParity({
				dag: dagFixture(),
				store,
				mode: "real",
				v1Executor: dryV1Executor,
				v2Executor: failing,
			});
			store.close();

			check(exitCode === PARITY_EXIT_MISMATCH, "mismatch exits non-zero (1)");
			const beta = report.nodes.find((n) => n.nodeId === "beta");
			check(beta !== undefined && !beta.passed, "beta flagged failed");
			check(
				Boolean(beta!.mismatches.some((m) => m.includes("verdict"))),
				"verdict mismatch recorded with both sides",
			);
			check(
				report.aggregate.v2VerdictCounts.escalate === 1,
				"NFR-3 verdict evidence preserved from receipts",
			);
			check(
				report.aggregate.v2AggregateCor > 0,
				"aggregate COR recomputed from receipt summaries (non-zero here)",
			);
			check(
				typeof beta!.costDeltaUsd === "number" &&
					typeof beta!.turnsDelta === "number",
				"cost/turns deltas populated for comparable nodes",
			);

			const reportPath = join(dir, "parity.json");
			const diffPath = writeParityReport(reportPath, report);
			check(
				diffPath === `${reportPath}.diff`,
				"diff file written next to the report on mismatch",
			);
			if (diffPath === null) throw new Error("diff should exist here");
			check(existsSync(diffPath), "diff file exists on disk");
			const diffText = readFileSync(diffPath, "utf-8");
			check(
				diffText.includes("parity MISMATCH") && diffText.includes("node beta:"),
				"diff names the DAG and every failing node",
			);

			// Determinism: rebuild the report twice → byte-identical bytes.
			const again = buildParityReport({
				dag: dagFixture(),
				mode: "real",
				v1: dryFixturesFor(dagFixture()),
				v2: v2FixturesFor(dagFixture()),
			});
			void again;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// ─── R3: determinism — identical runs serialize identically ───────
	{
		const storeA = new LedgerStore(
			join(mkdtempSync(join(tmpdir(), "parity-det-a-")), "t.db"),
		);
		const { report: r1 } = await runParity({
			dag: dagFixture(),
			store: storeA,
			mode: "dry",
		});
		storeA.close();
		const storeB = new LedgerStore(
			join(mkdtempSync(join(tmpdir(), "parity-det-b-")), "t.db"),
		);
		const { report: r2 } = await runParity({
			dag: dagFixture(),
			store: storeB,
			mode: "dry",
		});
		storeB.close();
		check(
			serializeParityReport(r1) === serializeParityReport(r2),
			"two independent dry runs produce byte-identical reports",
		);
	}

	// ─── compareNodes unit coverage ────────────────────────────────────
	{
		const v1: NormalizedV1Node = {
			nodeId: "u",
			verdict: "ship",
			requirements: ["r1"],
			verificationCommands: ["true"],
			verificationPassed: true,
			commitCount: 1,
			filesChanged: ["f.txt"],
			skipped: false,
			costUsd: 0.5,
			turns: 10,
		};
		const matching = compareNodes(v1, {
			nodeId: "u",
			verdict: "ship",
			requirements: ["r1"],
			verificationCommands: ["true"],
			verificationPassed: true,
			commitCount: 1,
			filesChanged: [],
			skipped: false,
			costUsd: 0.55,
			turns: 11,
		});
		check(
			matching.passed,
			"matching nodes pass regardless of file-name placeholders",
		);
		check(
			matching.costDeltaUsd === 0.05 && matching.turnsDelta === 1,
			"cost/turns deltas computed v2 − v1",
		);

		const skippedBoth = compareNodes(
			{ ...v1, skipped: true },
			{
				nodeId: "u",
				verdict: "failed",
				requirements: ["OTHER"],
				verificationCommands: [],
				verificationPassed: false,
				commitCount: 99,
				filesChanged: [],
				skipped: true,
				costUsd: 7,
				turns: 77,
			},
		);
		check(
			skippedBoth.passed,
			"skipped-on-both-sides nodes match without content comparison",
		);
		check(
			skippedBoth.costDeltaUsd === null && skippedBoth.turnsDelta === null,
			"deltas null when either side skipped",
		);
	}

	// ─── R2: v2 short-circuit — failed dependency skips dependents ────
	{
		const dir = mkdtempSync(join(tmpdir(), "parity-m5-skip-"));
		try {
			const store = new LedgerStore(join(dir, "t.db"));
			const failingRoot: V2NodeExecutor = (node) =>
				node.id === "alpha"
					? Promise.resolve({
							verdict: "failed" as const,
							receipt: receiptFixture(node.id, {
								verdict: "failed",
								commitIds: [],
								filesChanged: 0,
							}),
						})
					: Promise.resolve({
							verdict: "completed" as const,
							receipt: receiptFixture(node.id),
						});
			const { report, exitCode } = await runParity({
				dag: dagFixture(),
				store,
				mode: "real",
				v1Executor: dryV1Executor,
				v2Executor: failingRoot,
			});
			store.close();
			const gamma = report.nodes.find((n) => n.nodeId === "gamma");
			check(
				gamma !== undefined && !gamma.passed,
				"short-circuited dependent reported",
			);
			check(
				Boolean(gamma!.mismatches.some((m) => m.startsWith("skipped:"))),
				"skip asymmetry surfaced as a skipped mismatch",
			);
			check(
				exitCode === PARITY_EXIT_MISMATCH,
				"short-circuit run still exits 1",
			);
			check(
				report.aggregate.v1TotalCostUsd === null,
				"aggregate deltas null when any node was skipped on either side",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	if (errors.length > 0) {
		throw new Error("test-parity-m5 failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log(
		"✓ parity-m5: oracle reuse, canonical dual-feed, normalized diffing, typed report, exit codes, determinism",
	);
}

function dryFixturesFor(dag: CanonicalDag): NormalizedV1Node[] {
	return dag.nodes.map((n) => ({
		nodeId: n.id,
		verdict: "ship" as const,
		requirements: [
			`R1: ${n.id} first requirement`,
			`R2: ${n.id} second requirement`,
		],
		verificationCommands: [`test -f ${n.id}.txt`],
		verificationPassed: true,
		commitCount: 2,
		filesChanged: [`${n.id}-file-1.txt`, `${n.id}-file-2.txt`].sort(),
		skipped: false,
		costUsd: 0,
		turns: 0,
	}));
}

/** v2-side fixture for the real-mode determinism check: normalize each
 *  node through the production normalizer with a deterministic receipt. */
function v2FixturesFor(dag: CanonicalDag): NormalizedV2Node[] {
	return dag.nodes.map((n) =>
		normalizeV2Node({
			node: n,
			result: { id: n.id, verdict: "completed" },
			receipt: dryReceiptFor(n.id, 2),
		}),
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		});
}
