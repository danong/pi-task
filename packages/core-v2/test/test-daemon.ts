/**
 * Hermetic tests for the M1.4 daemon assembly: spec parsing/validation,
 * deterministic system prompt (R5), pipeline success + failure paths with a
 * fake session handle (R6), and boot reconciliation wiring (R4). Zero LLM,
 * zero network; verification commands are fast real bash.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionHandle, SessionHost, SessionHostConfig, SessionHostEvent } from "../src/sessions/host.ts";
import { startDaemon } from "../src/daemon/start.ts";
import {
	buildWorkerSystemPrompt,
	deriveTaskId,
	parseTaskSpec,
	runTask,
	SpecValidationError,
} from "../src/daemon/task-runner.ts";
import { LedgerStore } from "../src/ledger/store.ts";

const GOOD_SPEC = `## Goal
Create a greeting file.

## Requirements
- R1: hello.txt contains exactly "hi"

## Verification
- test -f hello.txt
`;

/** Scriptable fake session host — the hermetic stand-in for SessionHost. */
class FakeHandle implements SessionHandle {
	readonly role = "worker";
	readonly model = { provider: "fake", modelId: "fake/m" };
	turns = 0;
	constructor(
		private readonly behavior: "yield" | "settle" | "error",
		public files: Array<{ path: string; content: string }> = [],
	) {}
	get result() {
		return this.behavior === "yield"
			? { files_changed: this.files.map((f) => f.path), summary: "done", commit_ids: ["c1"], deviations: [] }
			: undefined;
	}
	subscribe(listener: (event: SessionHostEvent) => void): () => void {
		listener({ type: "turnStart" });
		if (this.behavior !== "error") {
			listener({ type: "toolStart", toolName: "bash", toolCallId: "t1" });
			listener({ type: "toolEnd", toolName: "bash", toolCallId: "t1", isError: false });
			listener({ type: "settled" });
		}
		if (this.behavior === "yield") {
			listener({ type: "yielded", payload: this.result! });
		}
		return () => undefined;
	}
	async prompt(): Promise<void> {
		this.turns += 1;
		for (const f of this.files) {
			writeFileSync(f.path, f.content, "utf-8");
		}
		if (this.behavior === "error") {
			throw new Error("boom");
		}
	}
	async abort(): Promise<void> {}
	async stats(): Promise<never> {
		throw new Error("stats unavailable on the fake handle");
	}
	async setModel(): Promise<void> {
		this.turns += 0; // no-op; recorded by prewalk-specific fakes
	}
	close(): void {}
}

function fakeHost(behavior: "yield" | "settle" | "error", files: Array<{ path: string; content: string }> = []): SessionHost {
	return {
		spawn: async (_config: SessionHostConfig) => new FakeHandle(behavior, files),
	};
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const dir = mkdtempSync(join(tmpdir(), "core-v2-daemon-"));
	try {
		// ─── Spec parsing + validation (R3) ──────────────────────────────
		{
			const parsed = parseTaskSpec(GOOD_SPEC);
			check(parsed.goal.includes("greeting file"), "goal parsed");
			check(parsed.requirements.length === 1 && parsed.verificationCommands.length === 1, "sections parsed");

			let caught: SpecValidationError | undefined;
			try {
				parseTaskSpec("## Goal\ng\n");
			} catch (err) {
				caught = err instanceof SpecValidationError ? err : undefined;
			}
			check(caught?.missing === "requirements", "missing requirements rejected typed");

			caught = undefined;
			try {
				parseTaskSpec("## Goal\ng\n\n## Requirements\n- R1: x\n");
			} catch (err) {
				caught = err instanceof SpecValidationError ? err : undefined;
			}
			check(caught?.missing === "verification", "missing verification rejected typed");
		}

		// ─── Deterministic prompt + id (R5) ──────────────────────────────
		{
			check(buildWorkerSystemPrompt(GOOD_SPEC) === buildWorkerSystemPrompt(GOOD_SPEC),
				"system prompt is byte-stable for identical inputs");
			check(!/[0-9a-f]{8}-/.test(buildWorkerSystemPrompt(GOOD_SPEC)), "prompt carries no uuid-like ids");
			check(deriveTaskId(GOOD_SPEC, "/w") === deriveTaskId(GOOD_SPEC, "/w"), "task id deterministic per input");
			check(deriveTaskId(GOOD_SPEC, "/w") !== deriveTaskId(GOOD_SPEC, "/other"), "task id varies by cwd");
		}

		// ─── Success path (R6 ship) ──────────────────────────────────────
		{
			const workDir = join(dir, "success");
			mkdirSync(workDir, { recursive: true });
			const artifactsDir = join(dir, "artifacts-success");
			const result = await runTask({
				specMarkdown: GOOD_SPEC.replace("hello.txt", "hello.txt"),
				cwd: workDir,
				artifactsDir,
				dbPath: join(dir, "success.db"),
				model: "openrouter/stealth/ox-alpha",
				host: fakeHost("yield", [{ path: join(workDir, "hello.txt"), content: "hi" }]),
			});
			check(result.receipt.verdict === "ship", "ship verdict on yield + passing verify");
			check(result.receipt.bundleHit === null, "bundleHit null in M1");
			check(result.verificationPassed === true, "verification passed");
			check(existsSync(join(workDir, "hello.txt")), "worker file written");

			const store = new LedgerStore(join(dir, "success.db"));
			const task = store.getTask(result.taskId);
			check(task?.status === "completed", "task row completed");
			check(task?.planMode !== null && task?.planMode !== undefined, "plan_mode recorded");
			const session = store.getMicroSession(`${result.taskId}-worker`);
			check(session?.status === "yielded", "session row yielded");
			check(session?.yieldPayload?.includes("hello.txt") === true, "yield payload persisted");
			store.close();
		}

		// ─── Settle-without-yield failure path (R6 failed) ───────────────
		{
			const dbPath = join(dir, "settle.db");
			const result = await runTask({
				specMarkdown: GOOD_SPEC,
				cwd: (() => { const d = join(dir, "settle"); mkdirSync(d, { recursive: true }); return d; })(),
				artifactsDir: join(dir, "artifacts-settle"),
				dbPath,
				model: "openrouter/stealth/ox-alpha",
				host: fakeHost("settle"),
			});
			check(result.receipt.verdict === "failed", "failed verdict on settle without yield");
			const artifactPath = join(dir, "artifacts-settle", `${result.taskId}.failure.json`);
			check(existsSync(artifactPath), "failure artifact written");
			check(String(JSON.parse(readFileSync(artifactPath, "utf-8")).cause ?? "").length > 0, "artifact names the cause");
			const store = new LedgerStore(dbPath);
			check(store.getTask(result.taskId)?.status === "failed", "task row failed");
			check(store.getMicroSession(`${result.taskId}-worker`)?.status === "crashed", "session crashed");
			store.close();
		}

		// ─── Verification-failure path (R6 failed) ───────────────────────
		{
			const vFailDir = join(dir, "verifyfail");
			mkdirSync(vFailDir, { recursive: true });
			const result = await runTask({
				specMarkdown: GOOD_SPEC.replace("test -f hello.txt", "exit 3"),
				cwd: vFailDir,
				artifactsDir: join(dir, "artifacts-vfail"),
				dbPath: join(dir, "verifyfail.db"),
				model: "openrouter/stealth/ox-alpha",
				host: fakeHost("yield", [{ path: join(dir, "verifyfail", "hello.txt"), content: "hi" }]),
			});
			check(result.receipt.verdict === "failed", "failed verdict on failing verify");
			check(result.verificationPassed === false, "verificationPassed false");
			check(result.yieldedResult !== undefined, "yield still captured on verify failure");
		}

		// ─── Re-run collision (review C1/P0): same spec+cwd twice ────────
		{
			const rerunDir = join(dir, "rerun");
			mkdirSync(rerunDir, { recursive: true });
			const dbPath = join(dir, "rerun.db");
			const first = await runTask({
				specMarkdown: GOOD_SPEC, cwd: rerunDir, artifactsDir: join(dir, "artifacts-rerun"),
				dbPath, model: "openrouter/stealth/ox-alpha",
				host: fakeHost("yield", [{ path: join(rerunDir, "hello.txt"), content: "hi" }]),
			});
			const second = await runTask({
				specMarkdown: GOOD_SPEC, cwd: rerunDir, artifactsDir: join(dir, "artifacts-rerun"),
				dbPath, model: "openrouter/stealth/ox-alpha",
				host: fakeHost("yield", [{ path: join(rerunDir, "hello.txt"), content: "hi" }]),
			});
			check(first.receipt.verdict === "ship" && second.receipt.verdict === "ship",
				"re-running the same spec must not collide on the PK");
			check(first.taskId !== second.taskId, "attempts get distinct ids (family + discriminator)");
		}

		// ─── Boot reconciliation wiring (R4) ─────────────────────────────
		{
			const dbPath = join(dir, "reconcile.db");
			const seed = new LedgerStore(dbPath);
			seed.insertTask({ id: "stale-1", goal: "g" });
			seed.setTaskStatus("stale-1", "executing");
			seed.insertTask({ id: "stale-2", goal: "g" });
			seed.setTaskStatus("stale-2", "verifying");
			seed.incrementRetry("stale-2");
			seed.incrementRetry("stale-2");
			seed.insertTask({ id: "done-1", goal: "g" });
			seed.setTaskStatus("done-1", "completed");
			seed.close();

			const daemon = startDaemon(dbPath);
			check(daemon.reconciled.requeued.includes("stale-1"), "stale in-flight requeued");
			check(daemon.reconciled.failed.includes("stale-2"), "exhausted retries failed");
			check(daemon.store.getTask("stale-1")?.status === "queued", "requeued row is queued");
			check(daemon.store.getTask("stale-2")?.status === "failed", "exhausted row failed");
			check(daemon.store.getTask("done-1")?.status === "completed", "terminal rows untouched");
			daemon.store.close();
		}

		// ─── Spawn-failure path (typed host error → failed receipt) ──────
		{
			mkdirSync(join(dir, "spawnfail"), { recursive: true });
			const badHost: SessionHost = {
				spawn: async () => {
					throw new Error("no auth");
				},
			};
			const result = await runTask({
				specMarkdown: GOOD_SPEC,
				cwd: join(dir, "spawnfail"),
				artifactsDir: join(dir, "artifacts-spawnfail"),
				dbPath: join(dir, "spawnfail.db"),
				model: "openrouter/stealth/ox-alpha",
				host: badHost,
			});
			check(result.receipt.verdict === "failed", "failed verdict on spawn failure");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		throw new Error(`daemon tests failed:\n  ${errors.join("\n  ")}`);
	}
	console.log("✓ daemon: pipeline paths, deterministic prompt, reconciliation, failure artifacts");
}

const invokedAs = process.argv[1];
if (invokedAs !== undefined && import.meta.url.endsWith(invokedAs.split("/").pop() ?? "")) {
	runTests().catch((err) => {
		console.error(err.message ?? err);
		process.exit(1);
	});
}
