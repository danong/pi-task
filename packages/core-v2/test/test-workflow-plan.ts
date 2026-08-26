/**
 * Hermetic suite for the M5 planning-only workflow (R4):
 *   - R1 spec validation is side-effect-free: Goal/Requirements/
 *     Verification well-formedness, bash-line parsing, depends_on
 *     linkage fields, typed errors — no spawns/merges/writes
 *   - R2 DAG synthesis: topological order, typed cycle error with the
 *     cycle path, configurable max-fan-out guard
 *   - R3 human gate: dry-run writes approved=false, --approve flips to
 *     true, build refuses unapproved DAGs via the same ledger surface
 *
 * Zero LLM, zero network; the only I/O is a throwaway SQLite DB for the
 * gate tests (the existing LedgerStore seam, schema-v2 approvals table).
 *
 * Standalone: npx tsx packages/core-v2/test/test-workflow-plan.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { LEDGER_SCHEMA_VERSION, LedgerStore } from "../src/ledger/store.ts";
import {
	isWellFormedBashLine,
	parseDependsOn,
	validateSpec,
} from "../src/workflow/plan.ts";
import {
	DEFAULT_MAX_FAN_OUT,
	DagCycleError,
	synthesizeDag,
	type DagNode,
} from "../src/workflow/dag.ts";
import {
	GateError,
	planApprovalStatus,
	recordPlanApproval,
	requirePlanApproved,
} from "../src/workflow/gate.ts";

const GOOD_SPEC = `## Goal
Ship the feature.

## Requirements
- R1: do the thing
- R2: commit it

## Verification
- npx tsc --noEmit
- npx tsx test/run-all.ts

## Depends On
- setup-spec
`;

function specWith(dependsOn?: string[]): string {
	const deps =
		dependsOn === undefined
			? ""
			: `\n## Depends On\n${dependsOn.map((d) => `- ${d}`).join("\n")}\n`;
	return `## Goal\ng\n\n## Requirements\n- R1: x\n\n## Verification\n- true\n${deps}`;
}

function node(id: string, dependsOn: string[] = []): DagNode {
	return { id, spec: validateSpec(specWith(dependsOn)) };
}

/** Run fn expecting a typed workflow error; returns its code (or class name). */
function expectTypedError(fn: () => unknown): string {
	try {
		fn();
		return "";
	} catch (err) {
		if (!(err instanceof Error)) return "";
		const coded = err as { code?: string };
		return coded.code ?? err.name;
	}
}

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// ─── R1: side-effect-free spec validation ──────────────────────
	{
		const parsed = validateSpec(GOOD_SPEC);
		check(parsed.goal === "Ship the feature.", "goal line parsed");
		check(parsed.requirements.length === 2, "requirements nonempty");
		check(
			parsed.verificationCommands.length === 2,
			"verification commands parsed",
		);
		check(
			JSON.stringify(parsed.dependsOn) === JSON.stringify(["setup-spec"]),
			"depends_on linkage field parsed",
		);

		// Typed failures per missing/malformed dimension.
		check(
			expectTypedError(() =>
				validateSpec("## Requirements\n- x\n\n## Verification\n- true\n"),
			) === "missing_goal",
			"missing goal fails typed",
		);
		check(
			expectTypedError(() =>
				validateSpec("## Goal\ng\n\n## Verification\n- true\n"),
			) === "missing_requirements",
			"empty requirements fail typed",
		);
		check(
			expectTypedError(() =>
				validateSpec("## Goal\ng\n\n## Requirements\n- x\n"),
			) === "missing_verification",
			"missing verification fails typed",
		);
		check(
			expectTypedError(() =>
				validateSpec(specWith().replace("- true", "- echo 'unterminated")),
			) === "bad_verification_command",
			"unterminated quote fails typed",
		);

		// Bash-line well-formedness is syntax-only and never executes.
		check(
			isWellFormedBashLine("true && false"),
			"compound command accepted syntactically",
		);
		check(!isWellFormedBashLine(""), "empty command rejected");
		check(
			!isWellFormedBashLine("echo \\"),
			"trailing line-continuation rejected",
		);
		check(
			!isWellFormedBashLine('echo "open'),
			"unterminated double quote rejected",
		);
		check(
			!isWellFormedBashLine("echo 'open"),
			"unterminated single quote rejected",
		);
		check(
			!isWellFormedBashLine("echo `open"),
			"unterminated backtick rejected",
		);
		check(
			isWellFormedBashLine(`echo "it's closed"`),
			"nested quote closed correctly accepted",
		);

		// depends_on validated where present: absent section tolerated.
		check(
			parseDependsOn("## Goal\ng\n").length === 0,
			"absent depends_on parses as empty",
		);
	}

	// ─── R2: pure DAG synthesis ────────────────────────────────────
	{
		check(
			DEFAULT_MAX_FAN_OUT > 0,
			"default fan-out guard is a positive sane limit",
		);

		const dag = synthesizeDag([
			node("b", ["a"]),
			node("a"),
			node("c", ["a", "b"]),
		]);
		const pos = new Map(dag.order.map((id, i) => [id, i]));
		check(dag.order.length === 3, "all nodes ordered exactly once");
		check(
			pos.get("a")! < pos.get("b")! &&
				pos.get("a")! < pos.get("c")! &&
				pos.get("b")! < pos.get("c")!,
			`topological order respects dependencies, got ${dag.order.join(",")}`,
		);

		// Determinism: same input list → same order across calls.
		const again = synthesizeDag([
			node("b", ["a"]),
			node("a"),
			node("c", ["a", "b"]),
		]);
		check(
			again.order.join(",") === dag.order.join(","),
			"synthesis is deterministic",
		);

		// Cycle detection with the path in the typed error.
		let cyclePath: readonly string[] = [];
		try {
			synthesizeDag([node("a", ["c"]), node("b", ["a"]), node("c", ["b"])]);
		} catch (err) {
			if (err instanceof DagCycleError) cyclePath = err.cyclePath;
		}
		check(
			cyclePath.length >= 3,
			`cycle surfaced with a path, got ${cyclePath.join(" → ")}`,
		);
		check(
			expectTypedError(() => synthesizeDag([node("a", ["a"])])) === "cycle",
			"self-edge detected as cycle",
		);

		// Fan-out guard is configurable.
		check(
			expectTypedError(() =>
				synthesizeDag(
					[node("x", ["d1", "d2", "d3"]), node("d1"), node("d2"), node("d3")],
					{ maxFanOut: 2 },
				),
			) === "fan_out_exceeded",
			"fan-out over the configured limit fails typed",
		);
		check(
			synthesizeDag([
				node("x", ["d1", "d2", "d3"]),
				node("d1"),
				node("d2"),
				node("d3"),
			]).order.length === 4,
			"same graph passes under the default guard",
		);

		check(
			expectTypedError(() => synthesizeDag([node("a", ["ghost"])])) ===
				"unknown_dependency",
			"dangling dependency fails typed",
		);
		check(
			expectTypedError(() => synthesizeDag([node("a"), node("a")])) ===
				"duplicate_id",
			"duplicate ids fail typed",
		);
	}

	// ─── R3: human gate — dry vs real persistence on the ledger seam ──
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-task-v2-workflow-gate-"));
		try {
			const store = new LedgerStore(join(dir, "tasks.db"));
			check(
				store.db.prepare("PRAGMA user_version").get()!.user_version ===
					LEDGER_SCHEMA_VERSION,
				"fresh DB migrated to the current schema (approvals table present)",
			);

			// Unknown DAG: build refuses with guidance.
			let refused = "";
			try {
				requirePlanApproved(store, "dag-1");
			} catch (err) {
				refused = err instanceof GateError ? err.message : String(err);
			}
			check(
				refused.includes("plan first") && refused.includes("--approve"),
				`build refuses an unplanned DAG with re-run guidance, got ${refused}`,
			);

			// Dry plan: writes an approval row that is NOT approved.
			recordPlanApproval(store, { dagId: "dag-1", approved: false });
			check(
				planApprovalStatus(store, "dag-1").status === "pending",
				"dry plan records pending approval",
			);
			let stillRefused = "";
			try {
				requirePlanApproved(store, "dag-1");
			} catch (err) {
				stillRefused = err instanceof GateError ? err.message : String(err);
			}
			check(
				stillRefused.includes("NOT approved") &&
					stillRefused.includes("--approve"),
				"build refuses a dry-run (non-approved) DAG",
			);

			// Real plan (--approve): same row flips to approved — build proceeds.
			recordPlanApproval(store, { dagId: "dag-1", approved: true });
			check(
				planApprovalStatus(store, "dag-1").status === "approved",
				"--approve flips the row to approved",
			);
			let threw = false;
			try {
				requirePlanApproved(store, "dag-1");
			} catch {
				threw = true;
			}
			check(!threw, "approved DAG passes the build gate");

			// Withholding again revokes.
			recordPlanApproval(store, { dagId: "dag-1", approved: false });
			check(
				planApprovalStatus(store, "dag-1").status === "pending",
				"re-plan without approval revokes",
			);

			// Per-DAG isolation on the shared ledger.
			recordPlanApproval(store, { dagId: "dag-2", approved: true });
			check(
				planApprovalStatus(store, "dag-1").status === "pending" &&
					planApprovalStatus(store, "dag-2").status === "approved",
				"approvals are keyed per DAG id",
			);

			store.close();

			// Persistence survives reopen (ledger is the source of truth).
			const reopened = new LedgerStore(join(dir, "tasks.db"));
			check(
				planApprovalStatus(reopened, "dag-2").status === "approved",
				"approval row persists across reopen",
			);
			reopened.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	if (errors.length > 0) {
		throw new Error("test-workflow-plan failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log(
		"✓ workflow-plan: side-effect-free validation, DAG order/cycle/fan-out, dry-vs-real human gate",
	);
	return Promise.resolve();
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
