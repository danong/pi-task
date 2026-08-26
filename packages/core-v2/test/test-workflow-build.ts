/**
 * Hermetic suite for gate-checked DAG orchestration (M5 /build):
 *   - R1 gate: an unknown or unapproved DAG refuses TYPED
 *     (BuildGateError) with guidance to re-run `plan --approve`;
 *     nothing dispatches.
 *   - R2 topological order + fan-out limiting: execution follows the
 *     synthesized order through the injected runNode seam, concurrency
 *     respects max_parallel and never exceeds the DAG's declared
 *     fan-out ceiling.
 *   - R3 short-circuit: a failed node's dependents are skipped TYPED
 *     without ever spawning; EVERY node emits task lifecycle events
 *     via the real InMemoryTaskGateway (routed -> terminal).
 *
 * Zero LLM, zero network. The only I/O is a throwaway SQLite DB for
 * the gate rows and the in-memory gateway event journal — same seams
 * as test-workflow-plan.ts / test-gateway.ts.
 *
 * Standalone: npx tsx packages/core-v2/test/test-workflow-build.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { LedgerStore } from "../src/ledger/store.ts";
import { InMemoryTaskGateway } from "../src/gateway/index.ts";
import { validateSpec } from "../src/workflow/plan.ts";
import type { DagNode } from "../src/workflow/dag.ts";
import {
	recordPlanApproval,
	requirePlanApproved,
} from "../src/workflow/gate.ts";
import { BuildGateError, runBuild } from "../src/workflow/build.ts";

const APPROVED_ID = "dag-approved";

function specWith(dependsOn: string[]): string {
	const deps =
		dependsOn.length === 0
			? ""
			: `\n## Depends On\n${dependsOn.map((d) => `- ${d}`).join("\n")}\n`;
	return `## Goal\ng\n\n## Requirements\n- R1: x\n\n## Verification\n- true${deps}`;
}

function node(id: string, dependsOn: string[] = []): DagNode {
	return { id, spec: validateSpec(specWith(dependsOn)) };
}

/** The scripted outcome a fake executor returns per node. */
interface ScriptedOutcome {
	verdict: "completed" | "failed";
}

interface FakeRun {
	/** Ids in the exact order runNode was INVOKED (not settled). */
	invocations: string[];
	/** Peak simultaneous in-flight executions observed. */
	peakInFlight: number;
}

/** Scripted executor: fails listed ids, records invocation order and
 *  live concurrency. Never touches fs/network. */
function makeRunNode(failIds: readonly string[] = []): {
	runNode: (id: string) => Promise<ScriptedOutcome>;
	fake: FakeRun;
} {
	const fake: FakeRun = { invocations: [], peakInFlight: 0 };
	let inFlight = 0;
	return {
		fake,
		runNode: async (id: string): Promise<ScriptedOutcome> => {
			fake.invocations.push(id);
			inFlight += 1;
			fake.peakInFlight = Math.max(fake.peakInFlight, inFlight);
			await new Promise<void>((resolve) => setImmediate(resolve));
			inFlight -= 1;
			return failIds.includes(id)
				? { verdict: "failed" }
				: { verdict: "completed" };
		},
	};
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const dir = mkdtempSync(join(tmpdir(), "pi-task-v2-workflow-build-"));
	try {
		const dbPath = join(dir, "tasks.db");

		// ─── R1: gate refusal — unknown DAG ──────────────────────────
		{
			const store = new LedgerStore(dbPath);
			const { runNode, fake } = makeRunNode();
			let caught: BuildGateError | undefined;
			try {
				await runBuild({
					dagId: "never-planned",
					nodes: [node("a")],
					store,
					runNode,
				});
			} catch (err) {
				if (err instanceof BuildGateError) caught = err;
			}
			check(caught !== undefined, "unknown DAG refuses typed (BuildGateError)");
			check(caught?.dagId === "never-planned", "typed error carries the dagId");
			check(
				caught?.message.includes("plan --approve") === true,
				`refusal guides to plan --approve, got ${caught?.message}`,
			);
			check(
				fake.invocations.length === 0,
				"nothing dispatched when refused at the gate",
			);
			store.close();
		}

		// ─── R1: gate refusal — dry-run (planned but NOT approved) ───
		{
			const store = new LedgerStore(dbPath);
			recordPlanApproval(store, { dagId: "dag-dry", approved: false });
			const { runNode, fake } = makeRunNode();
			let caught: BuildGateError | undefined;
			try {
				await runBuild({
					dagId: "dag-dry",
					nodes: [node("a")],
					store,
					runNode,
				});
			} catch (err) {
				if (err instanceof BuildGateError) caught = err;
			}
			check(
				caught !== undefined && caught.message.includes("NOT approved"),
				"dry-run DAG refuses typed with the not-approved guidance",
			);
			check(fake.invocations.length === 0, "dry-run DAG dispatches nothing");
			store.close();
		}

		// The gate itself stays read-only across refusals.
		{
			const store = new LedgerStore(dbPath);
			let threw = false;
			try {
				requirePlanApproved(store, "still-unknown");
			} catch {
				threw = true;
			}
			check(threw, "gate still refuses after failed builds (read-only check)");
			store.close();
		}

		// ─── R2: topological order on an approved DAG ─────────────────
		{
			const store = new LedgerStore(dbPath);
			recordPlanApproval(store, { dagId: APPROVED_ID, approved: true });
			const { runNode, fake } = makeRunNode();
			const gateway = new InMemoryTaskGateway({ store });

			const result = await runBuild({
				dagId: APPROVED_ID,
				nodes: [
					node("b", ["a"]),
					node("a"),
					node("c", ["a", "b"]),
					node("d2", []),
					node("d1", []),
				],
				store,
				runNode,
				gateway,
			});

			const pos = new Map<string, number>();
			fake.invocations.forEach((id, i) => pos.set(id, i));
			check(fake.invocations.length === 5, "every node executes exactly once");
			check(
				pos.get("a")! < pos.get("b")! &&
					pos.get("a")! < pos.get("c")! &&
					pos.get("b")! < pos.get("c")!,
				`execution order is topological, got ${fake.invocations.join(",")}`,
			);
			check(
				result.results.get("c")?.verdict === "completed" &&
					result.results.get("a")?.verdict === "completed",
				"all results completed on a clean graph",
			);

			// R3: every node emits routed -> completed via the REAL gateway.
			const events = gateway.listEvents();
			for (const id of ["a", "b", "c", "d1", "d2"]) {
				check(
					events.some((e) => e.type === "task.routed" && e.taskId === id),
					`node ${id} emitted task.routed`,
				);
				check(
					events.some((e) => e.type === "task.completed" && e.taskId === id),
					`node ${id} emitted task.completed`,
				);
			}
			check(
				events.every((e) => e.type !== "task.failed"),
				"no failure events on a clean graph",
			);
			store.close();
		}

		// ─── R2: fan-out limiting ─────────────────────────────────────
		{
			const store = new LedgerStore(dbPath);
			recordPlanApproval(store, { dagId: APPROVED_ID, approved: true });
			// Six independent roots: all ready simultaneously.
			const roots = ["r1", "r2", "r3", "r4", "r5", "r6"].map((r) => node(r));
			const { runNode, fake } = makeRunNode();

			const result = await runBuild({
				dagId: APPROVED_ID,
				nodes: [...roots],
				store,
				runNode,
				maxParallel: 3,
			});
			check(
				result.maxObservedConcurrency <= 3,
				`fan-out limited to max_parallel=3, got ${result.maxObservedConcurrency}`,
			);
			check(
				result.maxObservedConcurrency > 1,
				`ready-set actually runs concurrently, got ${result.maxObservedConcurrency}`,
			);
			check(fake.invocations.length === 6, "all six roots still executed");

			// Never above the DAG's declared ceiling even with a bigger budget.
			const capped = await runBuild({
				dagId: APPROVED_ID,
				nodes: [...roots],
				store,
				runNode,
				maxParallel: 999,
			});
			check(
				capped.maxObservedConcurrency <= 6,
				`fan-out never exceeds the ready-set size, got ${capped.maxObservedConcurrency}`,
			);

			// Invalid budgets degrade to a sane default instead of hanging.
			const degenerate = await runBuild({
				dagId: APPROVED_ID,
				nodes: [...roots],
				store,
				runNode,
				maxParallel: -2,
			});
			check(
				degenerate.results.size === 6,
				"non-positive max_parallel degrades to the default and completes",
			);
			store.close();
		}

		// ─── R3: dependent short-circuit on failure ──────────────────
		{
			const store = new LedgerStore(dbPath);
			recordPlanApproval(store, { dagId: APPROVED_ID, approved: true });
			const { runNode, fake } = makeRunNode(["a"]);
			const gateway = new InMemoryTaskGateway({ store });

			const result = await runBuild({
				dagId: APPROVED_ID,
				nodes: [
					node("a"),
					node("b", ["a"]),
					node("c", ["b"]), // transitive dependent
					node("independent"),
				],
				store,
				runNode,
				gateway,
			});

			check(
				result.results.get("a")?.verdict === "failed",
				"the scripted node failed",
			);
			check(
				result.results.get("b")?.verdict === "skipped",
				"direct dependent skipped",
			);
			check(
				result.results.get("c")?.verdict === "skipped",
				"transitive dependent skipped",
			);
			check(
				result.results.get("independent")?.verdict === "completed",
				"independent branch unaffected by short-circuit",
			);

			// Skipped dependents NEVER spawn.
			check(
				!fake.invocations.includes("b") && !fake.invocations.includes("c"),
				`skipped dependents never spawn, invocations were ${fake.invocations.join(",")}`,
			);

			// Typed skip cause names the blocker.
			check(
				result.results.get("b")?.cause?.includes('"a"') === true,
				`skip cause names the failed dependency, got ${result.results.get("b")?.cause}`,
			);

			// Every node has routed + a terminal event, including skips.
			const events = gateway.listEvents();
			for (const id of ["a", "b", "c", "independent"]) {
				check(
					events.some((e) => e.type === "task.routed" && e.taskId === id),
					`node ${id} emitted task.routed`,
				);
			}
			check(
				events.some(
					(e) => e.type === "task.completed" && e.taskId === "independent",
				),
				"completed node emits task.completed",
			);
			for (const id of ["a", "b", "c"]) {
				const terminal = events.find(
					(e) => e.type === "task.failed" && e.taskId === id,
				);
				check(
					terminal !== undefined,
					`node ${id} has a terminal task.failed event`,
				);
			}
			const skipEvent = events.find(
				(e) => e.type === "task.failed" && e.taskId === "b",
			);
			check(
				skipEvent?.type === "task.failed" &&
					skipEvent.detail.cause.includes("skipped"),
				"skipped dependent's terminal event carries the skipped cause",
			);
			store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		throw new Error(
			"test-workflow-build failed:\n  ✗ " + errors.join("\n  ✗ "),
		);
	}
	console.log(
		"✓ workflow-build: gate refusal, topological order, fan-out limiting, dependent short-circuit",
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
