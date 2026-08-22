/**
 * Hermetic tests for the ControlSurface seam (subsystems §3b / M4a+M4b).
 *
 *   - contract shape: SubscriptionLevel literals are exactly the three
 *     documented QoS levels (compile-time + runtime anchors)
 *   - level coarsening over the REAL adapter: delta ⊃ digest ⊃ receipts
 *     — one gateway stream observed at three levels delivers strictly
 *     nested event sets
 *   - capability correctness: the headless surface declares
 *     interactivePermissions=false, attachments=false, bounded latency
 *   - PermissionRequest routing: an SDK-host permission request emitted
 *     through the gateway as `permission.requested` is surfaced to a
 *     delta subscriber of the matching session (not dropped), and NOT
 *     delivered to subscribers of other sessions
 *   - multi-surface multiplexing: two surfaces subscribing to the same
 *     session stream BOTH see the same Receipt
 *
 * Zero LLM, zero network; uses InMemoryTaskGateway with rows (no fs).
 *
 * Standalone: npx tsx packages/core-v2/test/test-surfaces.ts
 */

import { pathToFileURL } from "node:url";

import type {
	ControlSurface,
	SurfaceCapabilities,
	SurfaceEvent,
	SubscriptionLevel,
} from "../src/gateway/index.ts";
import { InMemoryTaskGateway } from "../src/gateway/index.ts";
import type { TaskLifecycleEvent } from "../src/contracts/index.ts";
import type { TaskReceipt } from "../src/contracts/index.ts";
import { NullSurface, SURFACE_LEVEL_EVENTS } from "../src/surfaces/null-surface.ts";

// ─── Compile-time contract-shape anchors (enforced by tsc) ───────────

type Expect<T extends true> = T;
type IsAssignable<A, B> = [A] extends [B] ? true : false;
type Equivalent<A, B> = IsAssignable<A, B> extends true ? (IsAssignable<B, A> extends true ? true : false) : false;

// The literal set is EXACTLY the documented trio — no narrower, no wider.
type DocumentedLevels = "delta" | "digest" | "receipts";
const _levelsAreExactlyDocumented: Expect<Equivalent<SubscriptionLevel, DocumentedLevels>> = true;

// Capabilities keep their documented field set.
const _capabilitiesShape: Expect<
	Equivalent<SurfaceCapabilities, { interactivePermissions: boolean; attachments: boolean; latencyToleranceMs: number }>
> = true;

// Runtime anchor for the literals (tsc skips bare type aliases).
const LEVELS: readonly SubscriptionLevel[] = ["delta", "digest", "receipts"];
void LEVELS;

// ─── Fixtures ────────────────────────────────────────────────────────

function makeGateway(): InMemoryTaskGateway {
	return new InMemoryTaskGateway({
		rows: { tasks: new Map() },
		onHandlerError: () => {}, // silence the default console sink in tests
	});
}

function makeReceipt(taskId: string): TaskReceipt {
	return {
		taskId,
		verdict: "ship",
		filesChanged: 2,
		commitIds: ["c1"],
		turns: 4,
		costUsd: 0.01,
		inputTokens: 100,
		outputTokens: 20,
		cacheReadTokens: 40,
		cor: 0.5,
		bundleHit: null,
	};
}

/** Drain up to `n` events with a bounded wait so a missing event fails
 *  fast instead of hanging the suite. */
async function drain(stream: { events: AsyncIterable<SurfaceEvent> }, n: number): Promise<SurfaceEvent[]> {
	const got: SurfaceEvent[] = [];
	const iterator = stream.events[Symbol.asyncIterator]();
	for (let i = 0; i < n; i++) {
		const result = await Promise.race([
			iterator.next(),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250)),
		]);
		if (result === "timeout" || result.done) break;
		got.push(result.value);
	}
	return got;
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// ─── Level coarsening over the real adapter (R2) ────────────────────
	{
		const gateway = makeGateway();
		const surface = new NullSurface({ gateway });

		// One shared script of lifecycle events per session.
		const script: TaskLifecycleEvent[] = [
			{ type: "session.spawned", taskId: "t1", sessionId: "s1" },
			{ type: "verify.completed", taskId: "t1", detail: { passed: true } },
			{ type: "task.completed", taskId: "t1", detail: { verdict: "ship" } },
		];

		const streams = {
			delta: surface.connect("s1", "delta"),
			digest: surface.connect("s1", "digest"),
			receipts: surface.connect("s1", "receipts"),
		};
		const pending = {
			delta: drain(streams.delta, 8),
			digest: drain(streams.digest, 8),
			receipts: drain(streams.receipts, 8),
		};

		for (const event of script) gateway.emit(event);

		const seen = {
			delta: await pending.delta,
			digest: await pending.digest,
			receipts: await pending.receipts,
		};

		for (const [level, events] of Object.entries(seen)) {
			for (const e of events) {
				check(
					SURFACE_LEVEL_EVENTS[level as SubscriptionLevel].includes(e.type),
					`${level} subscriber only receives its level's event types (got ${e.type})`,
				);
			}
		}

		const typesOf = (events: SurfaceEvent[]): string[] => events.map((e) => e.type);
		// delta sees ToolActivity (spawned) + Receipt + StatusSnapshot(verify)
		check(typesOf(seen.delta).includes("ToolActivity"), "delta sees ToolActivity");
		check(typesOf(seen.digest).includes("ToolActivity"), "digest sees ToolActivity");
		check(!typesOf(seen.receipts).includes("ToolActivity"), "receipts never sees ToolActivity");
		check(
			typesOf(seen.delta).includes("Receipt") && typesOf(seen.digest).includes("Receipt")
				&& typesOf(seen.receipts).includes("Receipt"),
			"all three levels see the Receipt",
		);
		check(typesOf(seen.delta).length >= typesOf(seen.digest).length
			&& typesOf(seen.digest).length >= typesOf(seen.receipts).length,
			"event volume coarsens monotonically: delta ≥ digest ≥ receipts");

		streams.delta.close();
		streams.digest.close();
		streams.receipts.close();
	}

	// ─── Capability correctness (R3) ────────────────────────────────────
	{
		const gateway = makeGateway();
		const surface: ControlSurface = new NullSurface({ gateway });
		const caps = surface.capabilities();
		check(caps.interactivePermissions === false, "headless surface does not claim interactivePermissions");
		check(caps.attachments === false, "headless surface does not claim attachments");
		check(Number.isFinite(caps.latencyToleranceMs) && caps.latencyToleranceMs > 0 && caps.latencyToleranceMs <= 60_000,
			`latencyToleranceMs is a sane finite bound (got ${caps.latencyToleranceMs})`);
		check(surface.name.length > 0, "surface advertises a name");

		const factoryCaps = new NullSurface({ gateway, name: "cron-null" }).capabilities();
		check(factoryCaps.interactivePermissions === false, "factory-created surface keeps headless capabilities");
	}

	// ─── PermissionRequest routing through the gateway (R3) ─────────────
	{
		const gateway = makeGateway();
		const surface = new NullSurface({ gateway });
		const stream = surface.connect("s-target", "delta");

		const pending = drain(stream, 2);

		// SDK session host permission protocol routed THROUGH the gateway:
		// an interactive surface would render this; the headless one still
		// observes it at delta without claiming interactivity.
		gateway.emit({
			type: "permission.requested",
			taskId: "t9",
			sessionId: "s-target",
			requestId: "req-1",
			action: "bash",
			detail: "rm -rf build/",
		} as unknown as TaskLifecycleEvent);
		gateway.emit({
			type: "permission.requested",
			taskId: "t9",
			sessionId: "s-other",
			requestId: "req-2",
			action: "write",
			detail: "other session",
		} as unknown as TaskLifecycleEvent);

		const got = await pending;
		check(got.length >= 1, "PermissionRequest subscribed at delta is surfaced to the listener, not dropped");
		const perm = got.find((e): e is Extract<SurfaceEvent, { type: "PermissionRequest" }> => e.type === "PermissionRequest");
		check(perm !== undefined, "the surfaced event is a typed PermissionRequest");
		check(perm?.requestId === "req-1" && perm?.action === "bash",
			"permission payload round-trips (request id + action)");
		check(!got.some((e) => e.type === "PermissionRequest" && (e as { requestId?: string }).requestId === "req-2"),
			"another session's permission request is not delivered to this subscriber");

		stream.close();
	}

	// ─── Multi-surface multiplexing (R4) ────────────────────────────────
	{
		const gateway = makeGateway();
		const surfaceA = new NullSurface({ gateway, name: "cron" });
		const surfaceB = new NullSurface({ gateway, name: "ci" });

		// Two DIFFERENT surface instances, same session, receipts level.
		const streamA = surfaceA.connect("shared-session", "receipts");
		const streamB = surfaceB.connect("shared-session", "receipts");
		const pendingA = drain(streamA, 1);
		const pendingB = drain(streamB, 1);

		gateway.emit({ type: "task.completed", taskId: "tmux", detail: { verdict: "ship" } });

		const [gotA, gotB] = await Promise.all([pendingA, pendingB]);
		check(gotA.length === 1 && gotA[0]?.type === "Receipt", "first multiplexed surface sees the Receipt");
		check(gotB.length === 1 && gotB[0]?.type === "Receipt", "second multiplexed surface sees the Receipt");
		const receiptA = gotA.find((e): e is Extract<SurfaceEvent, { type: "Receipt" }> => e.type === "Receipt");
		const receiptB = gotB.find((e): e is Extract<SurfaceEvent, { type: "Receipt" }> => e.type === "Receipt");
		check(receiptA?.receipt.taskId === receiptB?.receipt.taskId && receiptA?.receipt.verdict === receiptB?.receipt.verdict,
			"both surfaces observe the SAME receipt content");

		streamA.close();
		streamB.close();
	}

	// ─── close() unsubscribes from the gateway ──────────────────────────
	{
		const gateway = makeGateway();
		const surface = new NullSurface({ gateway });
		const stream = surface.connect("sx", "delta");
		const pending = drain(stream, 1);
		stream.close();
		gateway.emit({ type: "task.completed", taskId: "tc", detail: { verdict: "ship" } });
		const got = await pending;
		check(got.length === 0, "closed stream receives nothing after close() unsubscribes");
	}

	if (errors.length > 0) {
		throw new Error("surfaces tests failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log("✓ surfaces: QoS coarsening, capability correctness, permission routing, multiplexing, close semantics");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
