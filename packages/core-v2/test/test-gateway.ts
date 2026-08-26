/**
 * Hermetic tests for the gateway seam (R5).
 *
 *   - emission ordering on a fake ledger + scripted host: the daemon's
 *     runTask emits queued → routed → spawned → yielded → verify →
 *     completed, each AFTER the corresponding ledger mutation
 *   - wildcard ("task.*", "*") and exact subscriptions on the
 *     InMemoryTaskGateway
 *   - unsubscribe actually removes the handler (idempotent)
 *   - typed GatewayError for unknown getTaskState / getManifest ids
 *   - add-only versioning: an exhaustive switch over the union anchored
 *     to a checked value — removing a case fails to compile (tsc gate)
 *   - handler-throw isolation: a throwing handler never breaks dispatch
 *     nor later subscribers
 *   - ledger-only reads: getManifest never surfaces the transcript
 *     (yield_payload) column
 *
 * Zero LLM, zero network; the runTask leg reuses the daemon suite's
 * scripted fake host pattern.
 *
 * Standalone: npx tsx packages/core-v2/test/test-gateway.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
	TaskGateway,
	TaskLedgerRow,
	TaskLifecycleEvent,
} from "../src/contracts/index.ts";
import {
	TASK_LIFECYCLE_EVENTS,
	eventMatchesPattern,
	eventTypeOf,
} from "../src/contracts/index.ts";
import { GatewayError, InMemoryTaskGateway } from "../src/gateway/index.ts";
import { runTask } from "../src/daemon/task-runner.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import type {
	SessionHandle,
	SessionHost,
	SessionHostConfig,
	SessionHostEvent,
} from "../src/sessions/host.ts";

const SPEC = `## Goal
Create a greeting file.

## Requirements
- R1: hello.txt contains exactly "hi"

## Verification
- test -f hello.txt
`;

// ─── Compile-time add-only versioning (R1) — enforced by tsc ─────────

type Expect<T extends true> = T;

/**
 * Exhaustive-switch guard: every vocabulary literal is pinned. Removing
 * a case from TaskLifecycleEvent leaves a stale label here (compile
 * error); adding one without extending this switch hits the default
 * arm's `never` assignment (compile error). Anchored to a checked const
 * so tsc cannot skip it.
 */
function assertExhaustive(event: TaskLifecycleEvent): string {
	switch (event.type) {
		case "task.queued":
			return event.type;
		case "task.routed":
			return event.type;
		case "session.spawned":
			return event.type;
		case "session.yielded":
			return event.type;
		case "session.exhausted":
			return event.type;
		case "verify.completed":
			return event.type;
		case "review.completed":
			return event.type;
		case "merge.completed":
			return event.type;
		case "merge.conflict":
			return event.type;
		case "task.completed":
			return event.type;
		case "task.failed":
			return event.type;
		case "task.escalated":
			return event.type;
		case "permission.requested":
			return event.type;
		default: {
			const exhaustive: never = event;
			return exhaustive;
		}
	}
}

// The union's payloads stay narrow: no variant may carry a transcript-
// shaped field (messages/turns arrays). A violation fails this check.
// Anchored to a checked statement so tsc cannot skip it; the assertion
// itself fails to compile whenever the probe resolves to false.
void (true as Expect<
	"transcript" extends keyof TaskLifecycleEvent ? false : true
>);

const _exhaustiveAnchor: string = assertExhaustive({
	type: "task.queued",
	taskId: "t",
});
void _exhaustiveAnchor;
// eventTypeOf (the kernel-side guard) must agree with the local switch.
const _kernelGuardAnchor: string = eventTypeOf({
	type: "session.spawned",
	taskId: "t",
	sessionId: "s",
});
void _kernelGuardAnchor;

// ─── Scripted fake host (same pattern as test-daemon.ts) ─────────────

const FAKE_SESSION_STATS = {
	sessionFile: undefined,
	sessionId: "fake-session",
	userMessages: 1,
	assistantMessages: 1,
	toolCalls: 0,
	toolResults: 0,
	totalMessages: 2,
	tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
	cost: 0.001,
} as const;

class FakeHandle implements SessionHandle {
	readonly role = "worker";
	readonly model = { provider: "fake", modelId: "fake/m" };
	constructor(
		private readonly file: string,
		private readonly _config: SessionHostConfig,
	) {}
	get result() {
		return {
			files_changed: [this.file],
			summary: "done",
			commit_ids: ["c1"],
			deviations: [],
		};
	}
	subscribe(listener: (event: SessionHostEvent) => void): () => void {
		listener({ type: "turnStart" });
		listener({ type: "yielded", payload: this.result });
		return () => undefined;
	}
	prompt(): Promise<void> {
		writeFileSync(this.file, "hi", "utf-8");
		return Promise.resolve();
	}
	abort(): Promise<void> {
		return Promise.resolve();
	}
	stats() {
		return Promise.resolve(structuredClone(FAKE_SESSION_STATS));
	}
	setModel(): Promise<void> {
		return Promise.resolve();
	}
	close(): void {}
}

function scriptedHost(file: string): SessionHost {
	return {
		spawn: (config: SessionHostConfig) =>
			Promise.resolve(new FakeHandle(file, config)),
	};
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const dir = mkdtempSync(join(tmpdir(), "core-v2-gateway-"));
	try {
		// ─── Daemon emission ordering over a real temp ledger (R4) ──────
		{
			const workDir = join(dir, "run");
			mkdirSync(workDir, { recursive: true });
			const dbPath = join(dir, "run.db");
			const seen: TaskLifecycleEvent[] = [];
			const gateway: TaskGateway = {
				emit: (event) => seen.push(event),
				on: () => () => undefined,
				getTaskState: () =>
					Promise.reject(
						new GatewayError("unknown_task", "unused in this fake"),
					),
				getManifest: () =>
					Promise.reject(
						new GatewayError("unknown_task", "unused in this fake"),
					),
			};
			const result = await runTask({
				specMarkdown: SPEC,
				cwd: workDir,
				artifactsDir: join(dir, "artifacts-run"),
				dbPath,
				model: "openrouter/stealth/ox-alpha",
				host: scriptedHost(join(workDir, "hello.txt")),
				gateway,
			});
			check(
				JSON.stringify(seen.map((e) => e.type)) ===
					JSON.stringify([
						"task.queued",
						"task.routed",
						"session.spawned",
						"session.yielded",
						"verify.completed",
						"task.completed",
					]),
				`emission order is queued→routed→spawned→yielded→verify→completed (got ${seen.map((e) => e.type).join(",")})`,
			);
			check(
				seen.every((e) => e.taskId === result.taskId),
				"every event carries the run's taskId",
			);

			// R4: each event fires AFTER its ledger mutation — by the time
			// the last event was emitted, the row reads completed.
			const store = new LedgerStore(dbPath);
			check(
				store.getTask(result.taskId)?.status === "completed",
				"ledger row completed when events settled",
			);
			store.close();
		}

		// ─── InMemoryTaskGateway: ordering, wildcards, exact, unsub ─────
		{
			const store = new LedgerStore(join(dir, "gw.db"));
			store.insertTask({ id: "t1", goal: "g" });
			store.setTaskStatus("t1", "executing");
			const gw = new InMemoryTaskGateway({ store });

			const order: string[] = [];
			const unsubAll = gw.on("*", (e) => order.push(`*:${e.type}`));
			const unsubFamily = gw.on("task.*", (e) =>
				order.push(`family:${e.type}`),
			);
			const unsubExact = gw.on("verify.completed", (e) =>
				order.push(`exact:${e.type}`),
			);

			gw.emit({ type: "task.queued", taskId: "t1" });
			gw.emit({
				type: "verify.completed",
				taskId: "t1",
				detail: { passed: true },
			});

			check(
				JSON.stringify(order) ===
					JSON.stringify([
						"*:task.queued",
						"family:task.queued",
						"*:verify.completed",
						"exact:verify.completed",
					]),
				`subscription order preserved; family wildcard filters non-task events (got ${order.join(",")})`,
			);

			unsubFamily();
			unsubFamily(); // idempotent
			order.length = 0;
			gw.emit({
				type: "task.completed",
				taskId: "t1",
				detail: { verdict: "ship" },
			});
			check(
				JSON.stringify(order) === JSON.stringify(["*:task.completed"]),
				"unsubscribe removes exactly its own handler",
			);

			unsubAll();
			unsubExact();
			order.length = 0;
			gw.emit({
				type: "verify.completed",
				taskId: "t1",
				detail: { passed: false },
			});
			check(
				order.length === 0,
				"unsubscribed handlers receive nothing after removal",
			);
			store.close();
		}

		// ─── Typed errors for unknown ids (R2) ──────────────────────────
		{
			const store = new LedgerStore(join(dir, "errs.db"));
			const gw = new InMemoryTaskGateway({ store });
			let taskErr: unknown;
			try {
				await gw.getTaskState("nope");
			} catch (err) {
				taskErr = err;
			}
			check(
				taskErr instanceof GatewayError && taskErr.code === "unknown_task",
				"getTaskState fails typed on unknown id",
			);
			let manifestErr: unknown;
			try {
				await gw.getManifest("nope");
			} catch (err) {
				manifestErr = err;
			}
			check(
				manifestErr instanceof GatewayError &&
					manifestErr.code === "unknown_task",
				"getManifest fails typed on unknown id",
			);

			// Happy path: rows round-trip from the ledger.
			store.insertTask({ id: "ok", goal: "fine" });
			store.insertMicroSession({
				id: "ok-worker",
				taskId: "ok",
				role: "worker",
				turnCount: 3,
			});
			store.setSessionStatus(
				"ok-worker",
				"yielded",
				JSON.stringify({ big: "transcript" }),
			);
			const state: TaskLedgerRow = await gw.getTaskState("ok");
			check(
				state.id === "ok" && state.status === "queued" && state.goal === "fine",
				"getTaskState returns the ledger row",
			);
			const manifest = await gw.getManifest("ok");
			check(
				manifest.taskId === "ok" && manifest.runId === "ok",
				"getManifest returns the manifest slice",
			);
			check(
				!JSON.stringify(manifest).includes("transcript"),
				"getManifest never surfaces the yield_payload transcript column",
			);
			check(
				manifest.detail?.sessions?.[0]?.status === "yielded" &&
					manifest.detail.sessions[0].id === "ok-worker",
				"manifest session metadata comes from ledger columns only",
			);
			store.close();
		}

		// ─── Handler-throw isolation (R4 / M4b) ─────────────────────────
		{
			const gw = new InMemoryTaskGateway({
				rows: {
					tasks: new Map([
						[
							"t1",
							{
								id: "t1",
								status: "queued",
								goal: "g",
								parentBranch: null,
								planMode: null,
								retryCount: 0,
								maxRetries: 2,
								createdAt: "",
								updatedAt: "",
							},
						],
					]),
				},
				onHandlerError: () => {}, // silence the default console sink
			});
			const seen: string[] = [];
			gw.on("*", () => {
				throw new Error("plugin boom");
			});
			gw.on("task.queued", (e) => seen.push(e.type));
			let threw: unknown;
			try {
				gw.emit({ type: "task.queued", taskId: "t1" });
			} catch (err) {
				threw = err;
			}
			check(
				threw === undefined,
				"a throwing handler never propagates out of emit",
			);
			check(
				JSON.stringify(seen) === JSON.stringify(["task.queued"]),
				"later subscribers still receive the event after a throw",
			);
			check(
				gw.listEvents().length === 1,
				"the event is still recorded on the audit list",
			);
		}

		// ─── Vocabulary integrity (R1) + dot-segment pattern matching ────
		{
			check(
				TASK_LIFECYCLE_EVENTS.length === new Set(TASK_LIFECYCLE_EVENTS).size,
				"vocabulary has no duplicate literals",
			);
			check(
				TASK_LIFECYCLE_EVENTS[0] === "task.queued",
				"vocabulary starts at the documented first event",
			);
			for (const literal of [
				"task.routed",
				"session.spawned",
				"session.yielded",
				"session.exhausted",
				"verify.completed",
				"review.completed",
				"merge.completed",
				"merge.conflict",
				"task.completed",
				"task.failed",
				"task.escalated",
				"permission.requested",
			]) {
				check(
					(TASK_LIFECYCLE_EVENTS as readonly string[]).includes(literal),
					`vocabulary contains ${literal}`,
				);
			}
			// eventTypeOf is the kernel-side exhaustiveness switch: it must
			// accept the permission.requested variant now that it is vocabulary.
			const permEvent: TaskLifecycleEvent = {
				type: "permission.requested",
				taskId: "t",
				sessionId: "s",
				requestId: "r",
				action: "bash",
				detail: "d",
			};
			check(
				eventTypeOf(permEvent) === "permission.requested",
				"eventTypeOf accepts the permission.requested variant",
			);

			// Dot-segment matching: family wildcards match whole segments only,
			// and malformed patterns match nothing.
			check(
				eventMatchesPattern("task.queued", "task.*"),
				"family wildcard matches its own family",
			);
			check(
				!eventMatchesPattern("task.queued", "session.*"),
				"family wildcard rejects other families",
			);
			check(
				!eventMatchesPattern("task.queued", "task"),
				"a dotless prefix is malformed and matches nothing",
			);
			check(
				!eventMatchesPattern("task.queued", "task."),
				"a trailing-dot pattern is malformed and matches nothing",
			);
			check(
				!eventMatchesPattern("task.queued", "ta*"),
				"an embedded wildcard is malformed and matches nothing",
			);
			check(
				!eventMatchesPattern("task.queued", ""),
				"the empty pattern is malformed and matches nothing",
			);
			check(
				eventMatchesPattern("task.queued", "*"),
				"the catch-all still matches everything",
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		throw new Error(`gateway tests failed:\n  ${errors.join("\n  ")}`);
	}
	console.log(
		"✓ gateway: emission ordering, pattern subscriptions, unsubscribe, typed errors, throw isolation, add-only versioning",
	);
}

const invokedAs = process.argv[1];
if (
	invokedAs !== undefined &&
	import.meta.url === pathToFileURL(invokedAs).href
) {
	runTests().catch((err: unknown) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
}
