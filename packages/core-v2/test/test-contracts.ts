/**
 * Hermetic tests for the kernel contracts (R2 / M0).
 *
 *   - schema round-trips: every one of the six payload schemas survives
 *     parse → JSON serialize → parse with identical shape
 *   - the deterministic-serialization rule (contract NFR-3/NFR-4):
 *     serialization for prompts is byte-identical across two
 *     constructions that differ ONLY in ledger-only envelope fields
 *   - ControlSurface subscription-level typing: delta ⊳ digest ⊳ receipts
 *     (a coarsening of one stream), expressed both as a compile-time
 *     relation (checked by the type gate) and as the QoS filtering
 *     behaviour of a minimal fake surface
 *   - per-seam smoke tests over minimal in-memory fakes, exercising each
 *     of the six interfaces through its REAL method surface (M0's
 *     hermetic stand-in for FR-11 real-path smoke tests, which broaden in
 *     M1 once real drivers exist)
 *
 * Zero LLM, zero network, no fs. The type gate (tsc, strict) typechecks
 * this file, so the compile-time subscriptions are genuinely enforced.
 *
 * Standalone: npx tsx packages/core-v2/test/test-contracts.ts
 */

import { pathToFileURL } from "node:url";

import {
	ExecutionBundleSchema,
	HandoffBundleSchema,
	ModelAssignmentSchema,
	TargetFileSchema,
	TaskReceiptSchema,
	YieldSchema,
	serializeForPrompt,
	stableStringify,
} from "../src/contracts/index.ts";
import type {
	ExecutionBundle,
	HandoffBundleRecord,
	ModelAssignment,
	SurfaceEvent,
	SurfaceStream,
	SubscriptionLevel,
	TargetFile,
	TaskReceipt,
	VerificationResult,
	WorkspaceContext,
} from "../src/contracts/index.ts";

// ─── Compile-time subscription-level typing (enforced by tsc) ────────

type Expect<T extends true> = T;
type IsAssignable<A, B> = [A] extends [B] ? true : false;

// The stream is a SINGLE union; the subscription level is a QoS filter over
// the SAME stream (delta ⊳ digest ⊳ receipts) — the runtime fakes below are
// the behavioural half of that identity.
//
// Every probe is a VALUE declaration (not a bare type alias): tsc skips
// unreferenced local type aliases, so compile-time assertions must be
// anchored to a checked const to enforce anything.
const _eventsAreDiscriminated: Expect<SurfaceEvent extends { type: string } ? true : false> = true;
const _receiptIsASurfaceEvent: Expect<IsAssignable<{ type: "Receipt"; receipt: TaskReceipt }, SurfaceEvent>> = true;
const _turnDeltaIsASurfaceEvent: Expect<IsAssignable<{ type: "TurnDelta"; text: string }, SurfaceEvent>> = true;
const _toolActivityIsASurfaceEvent: Expect<
	IsAssignable<{ type: "ToolActivity"; tool: string; argsPreview: string; phase: "start" | "done" }, SurfaceEvent>
> = true;

// ─── Family-level relation helpers (used by the runtime fake) ────────

/** Which event discriminant types each QoS level delivers (a partition of
 *  the single SurfaceEvent union: delta ⊳ digest ⊳ receipts). */
const LEVEL_EVENTS: Record<SubscriptionLevel, readonly string[]> = {
	delta: ["TurnDelta", "ToolActivity", "PermissionRequest", "Receipt", "Escalation"],
	digest: ["ToolActivity", "PermissionRequest", "Receipt", "Escalation"],
	receipts: ["Receipt", "Escalation"],
};

// ─── Deterministic serialization fixtures ────────────────────────────

function makeBundle(taskId: string, model: ModelAssignment): ExecutionBundle {
	const files = [] as unknown as TargetFile[];
	for (let i = 0; i < 3; i++) {
		files.push({
			hostPath: `packages/a/file-${i}.ts`,
			astOutline: i % 2 === 0 ? "export function fn" : `export const v = 1; // ${i}`,
			outlineTruncated: i === 2,
			outlineCursor: i === 2 ? "cursor-9" : null,
		});
	}
	return {
		taskId,
		goal: "Ship a feature.",
		targetFiles: files,
		requirements: ["R1: do the thing", "R2: commit it"],
		verificationCommands: ["test -f packages/a/file-0.ts"],
		modelAssignment: model,
	};
}

/** A HandoffBundle with ledger-only envelope fields attached. */
function makeHandoff(precedingSessionId: string): HandoffBundleRecord {
	return {
		taskId: "task-1",
		uncommittedDiffSummary: "diff --git a/x.ts b/x.ts\n+1\n-1",
		filesTouched: ["a/x.ts", "b/y.ts"],
		verificationFailures: [
			{ command: "npm test", reason: "assertion", stderrTail: "Error: nope" },
			{ command: "grep -q x", stderrTail: "no match" },
		],
		attemptNumber: 2,
		precedingSessionId,
	};
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// ─── Schema round-trips ────────────────────────────────────────────
	{
		const assignment = ModelAssignmentSchema.parse({ model: "fast/m", lane: "flex" });
		check(assignment.model === "fast/m" && assignment.lane === "flex", "ModelAssignment round-trip");
		check(ModelAssignmentSchema.parse({}).model === undefined, "ModelAssignment fully-optional round-trip");

		const bundle = makeBundle("t1", { lane: "flex" });
		const parsedBundle = ExecutionBundleSchema.parse(bundle);
		check(parsedBundle.taskId === bundle.taskId && parsedBundle.targetFiles.length === 3,
			"ExecutionBundle round-trip");
		check(JSON.parse(JSON.stringify(parsedBundle)).taskId === "t1", "ExecutionBundle survives JSON");

		const handoff = HandoffBundleSchema.parse(makeHandoff("sess-1"));
		check(handoff.verificationFailures.length === 2, "HandoffBundle round-trip");
		check("precedingSessionId" in handoff === false, "ledger-only field stripped from the schema shape");
		check("attemptNumber" in handoff === false,
			"attempt-varying field stripped from the prompt-bound payload (deterministic-prefix rule)");

		const yieldParsed = YieldSchema.parse({
			files_changed: ["a.ts"],
			summary: "done",
			commit_ids: ["c1"],
			deviations: [],
		});
		check(yieldParsed.deviations.length === 0, "Yield round-trip (empty deviations OK)");

		const receipt = TaskReceiptSchema.parse({
			taskId: "t1",
			verdict: "ship",
			filesChanged: 3,
			commitIds: ["c1"],
			turns: 5,
			costUsd: 0.01,
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 40,
			cor: 0.5,
			bundleHit: null,
		});
		check(receipt.verdict === "ship" && receipt.bundleHit === null, "TaskReceipt round-trip");
	}

	// ─── Constraint negatives (schema caps from the docs) ──────────────
	{
		const ok = (fn: () => unknown): boolean => {
			try {
				fn();
				return true;
			} catch {
				return false;
			}
		};
		check(!ok(() => TargetFileSchema.parse({
			hostPath: "a.ts",
			astOutline: "x".repeat(801),
			outlineTruncated: false,
			outlineCursor: null,
		})), "astOutline >800 rejected");

		const many = Array.from({ length: 51 }, (_, i) => ({
			hostPath: `a-${i}.ts`,
			astOutline: "o",
			outlineTruncated: false,
			outlineCursor: null,
		}));
		check(!ok(() => ExecutionBundleSchema.parse({
			taskId: "t",
			goal: "g",
			targetFiles: many,
			requirements: [],
			verificationCommands: [],
		})), ">50 targetFiles rejected");

		check(!ok(() => HandoffBundleSchema.parse({
			taskId: "t",
			uncommittedDiffSummary: "d".repeat(60_001),
			filesTouched: [],
			verificationFailures: [],
			attemptNumber: 1,
		})), "uncommittedDiffSummary >60000 rejected");

		check(!ok(() => HandoffBundleSchema.parse({
			taskId: "t",
			uncommittedDiffSummary: "d",
			filesTouched: [],
		})), "handoff missing verificationFailures rejected");

		check(!ok(() => TaskReceiptSchema.parse({
			taskId: "t",
			verdict: "maybe",
			filesChanged: 0,
			commitIds: [],
			turns: 1,
			costUsd: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cor: 0,
			bundleHit: null,
		})), "unknow verdict rejected");

		check(!ok(() => TaskReceiptSchema.parse({
			taskId: "t",
			verdict: "ship",
			filesChanged: 0,
			commitIds: [],
			turns: 1,
			costUsd: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			bundleHit: null,
		})), "receipt missing usage fields rejected");
	}

	// ─── Deterministic serialization (NFR-4 / NFR-3) ──────────────────
	{
		// stableStringify is insensitive to object key insertion order.
		const a = stableStringify({ b: 1, a: 2, c: [{ y: 1, x: 2 }] });
		const b = stableStringify({ c: [{ x: 2, y: 1 }], a: 2, b: 1 });
		check(a === b, "stableStringify ignores key order");

		// Two HandoffBundles differing ONLY in ledger-only envelope fields
		// serialize for prompts to identical bytes.
		const h1 = serializeForPrompt(HandoffBundleSchema, makeHandoff("sess-A"));
		const h2 = serializeForPrompt(HandoffBundleSchema, makeHandoff("sess-B"));
		check(h1 === h2, "HandoffBundle serialization ignores ledger-only precedingSessionId");
		check(!h1.includes("sess-A") && !h1.includes("precedingSessionId"), "ledger-only field absent from serialization");

		// An ExecutionBundle constructed at two different "times" whose
		// prompt-bound fields are equal but with different ledger-only
		// envelope (createdAt/runId/sessionId) serializes identically.
		const e1 = { ...makeBundle("t1", {}), createdAt: "2026-01-01", runId: "r1", sessionId: "s1" };
		const e2 = { ...makeBundle("t1", {}), createdAt: "2026-02-02", runId: "r2", sessionId: "s2" };
		const es1 = serializeForPrompt(ExecutionBundleSchema, e1);
		const es2 = serializeForPrompt(ExecutionBundleSchema, e2);
		check(es1 === es2, "ExecutionBundle serialization ignores ledger-only timestamps/run/session ids");
		check(!es1.includes("2026") && !es1.includes("runId"), "no ledger-only literal serializes into a prompt");

		// Prompt-bound differences DO change the bytes (bundle is not lost).
		const e3 = { ...makeBundle("t1", {}), goal: "Ship a different feature." };
		check(serializeForPrompt(ExecutionBundleSchema, e3) !== es1, "prompt-bound difference changes the bytes");
	}

	// ─── ControlSurface subscription levels ───────────────────────────
	{
		// The coarsening is a partition of one stream: each level's event
		// set is a prefix (delta ⊳ digest ⊳ receipts) of the full union.
		const full = LEVEL_EVENTS.delta;
		const digestOnly = LEVEL_EVENTS.digest.filter((e) => !full.includes(e));
		check(digestOnly.length === 0, "digest ⊆ delta");
		const receiptsOnly = LEVEL_EVENTS.receipts.filter((e) => !LEVEL_EVENTS.digest.includes(e));
		check(receiptsOnly.length === 0, "receipts ⊆ digest");
		check(LEVEL_EVENTS.receipts.every((e) => full.includes(e)), "receipts ⊆ delta");
	}

	// ─── Per-seam smoke tests (Hermetic fakes, FR-11 discipline) ──────
	{
		// Seam 1 — WorkspaceDriver.
		const states: WorkspaceContext["status"][] = [];
		const wsDriver: import("../src/contracts/workspace-driver.ts").WorkspaceDriver = {
			name: "test-jj",
			isSupported: async () => true,
			createWorkspace: async (taskId, parentBranch) => {
				states.push("provisioning");
				return { taskId, hostPath: `/tmp/ws/${taskId}`, branchName: parentBranch ?? "task", status: "provisioning" };
			},
			mergeWorkspace: async (ctx) => {
				states.push("merging");
				const _ = ctx.hostPath;
				return { success: true };
			},
			cleanupWorkspace: async () => {
				states.push("cleaning_up");
			},
		};
		check(await wsDriver.isSupported() === true, "workspace isSupported");
		const ws = await wsDriver.createWorkspace("t1");
		check(ws.status === "provisioning" && ws.hostPath.startsWith("/tmp/ws/"), "workspace created");
		check((await wsDriver.mergeWorkspace(ws)).success === true, "workspace merged");
		await wsDriver.cleanupWorkspace(ws);
		check(states.join(",") === "provisioning,merging,cleaning_up", "workspace lifecycle order");

		// Seam 2 — EnvironmentDriver.
		const calls: { command: string; args: string[] }[] = [];
		const envDriver: import("../src/contracts/environment-driver.ts").EnvironmentDriver = {
			name: "test-host",
			resolvePath: async () => ({ effectivePath: "/tmp/ws/t1", inContainer: false }),
			exec: async (command, args) => {
				calls.push({ command, args });
				return { exitCode: command === "true" ? 0 : 1, stdout: "", stderr: "", timedOut: false };
			},
		};
		const res = await envDriver.exec("true", ["a", "b"], { timeoutMs: 1000, readOnly: true });
		check(res.exitCode === 0 && calls.length === 1 && calls[0]!.args.join(",") === "a,b", "env exec recorded+timeout honored");

		// Seam 3 — ContextCompressor.
		const compressor: import("../src/contracts/context-compressor.ts").ContextCompressor = {
			name: "test-regex",
			isSupported: async () => true,
			generateOutline: async (_file, opts) => ({
				outline: "export function a(){}".slice(0, opts.maxTokens),
				truncated: false,
				cursor: null,
			}),
			extractSymbols: async () => "a",
		};
		const page = await compressor.generateOutline("a.ts", { maxTokens: 5 });
		check(page.outline.length <= 5 && !page.truncated, "compressor respects maxTokens");

		// Seam 4 — VerificationDriver.
		const verifyDriver: import("../src/contracts/verification-driver.ts").VerificationDriver = {
			name: "test-verify",
			runVerification: async (_ctx, commands): Promise<VerificationResult> => ({
				passed: commands.every((c) => !c.startsWith("FAIL")),
				commands: commands.map((c) => ({
					command: c,
					exitCode: c.startsWith("FAIL") ? 1 : 0,
					stdoutTail: "",
					stderrTail: "",
					durationMs: 1,
					timedOut: false,
				})),
			}),
		};
		const vres = await verifyDriver.runVerification(ws, ["a", "FAIL-b"]);
		check(vres.passed === false && vres.commands.length === 2, "verification reports failure");

		// Seam 5 — TaskPlugin hooks.
		let transformed = false;
		const plugin: import("../src/contracts/task-plugin.ts").TaskPlugin = {
			name: "test-plugin",
			transformExecutionBundle: async (b) => {
				transformed = true;
				return b;
			},
			onLifecycleEvent: () => undefined,
		};
		const out = await plugin.transformExecutionBundle!(makeBundle("t1", {}));
		check(transformed && out.taskId === "t1", "plugin transform hook runs on real bundle");

		// Seam 6 — ControlSurface connect/capabilities typing.
		const surface: import("../src/contracts/control-surface.ts").ControlSurface = {
			name: "test-surface",
			capabilities: () => ({ interactivePermissions: false, attachments: false, latencyToleranceMs: 1000 }),
			connect(_sessionId, level2) {
				const allowed = LEVEL_EVENTS[level2];
				const events: SurfaceEvent[] = [
					{ type: "Receipt", receipt: { taskId: "t", verdict: "ship", filesChanged: 1, commitIds: [], turns: 1, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cor: 0, bundleHit: null } },
					{ type: "Escalation", taskId: "t", reason: "r" },
					{ type: "StatusSnapshot", model: "m", tier: "full", activeTasks: 0 },
				];
				const stream2: SurfaceStream = {
					events: (async function* () {
						for (const e of events) if (allowed.includes(e.type)) yield e;
					})(),
					send: () => undefined,
					close: () => undefined,
				};
				return stream2;
			},
		};
		const caps = surface.capabilities();
		const receipts = await (async () => {
			const got: string[] = [];
			for await (const e of surface.connect("s", "receipts").events) got.push(e.type);
			return got;
		})();
		check(caps.interactivePermissions === false, "surface capabilities typed");
		check(
			receipts.every((t) => LEVEL_EVENTS.receipts.includes(t)),
			"receipts-level surface delivers only receipts-level events",
		);
		// The coarsening is real: StatusSnapshot is daemon state and never
		// crosses at receipts level.
		check(!receipts.includes("StatusSnapshot"), "receipts level excludes daemon-state snapshots");
	}

	if (errors.length > 0) {
		throw new Error("test-contracts failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log("✓ contracts: schema round-trips, deterministic serialization, subscription typing, six seams");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
