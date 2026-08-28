/**
 * Hermetic tests for independent maxTurns budget and wall-timeout CLI.
 * Zero LLM, zero network. Tests cost-cap ingress rejection, usage accounting,
 * watchdog independence, CLI parsing, daemon plumbing, trace observability
 * and report rendering.
 */
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliUsageError, parseCliArgs, runCli } from "../src/cli.ts";
import { TraceCollector, TraceArtifactSchema } from "../src/contracts/trace.ts";
import { renderTraceReport } from "../src/bench/trace-report.ts";
import { decideMaxTurnsAction, decideWallAction, DEFAULT_WATCHDOG_WALL_TIMEOUT_MS } from "../src/guards/watchdogs.ts";
import { WatchdogDriver } from "../src/guards/watchdog-driver.ts";
import {
	budgetReason,
	MAX_COST_USD_UNSUPPORTED_MESSAGE,
} from "../src/budget/execution-budget.ts";
import { runParallelTask } from "../src/daemon/parallel.ts";
import type { SessionHandle, SessionHost, SessionHostConfig, SessionHostEvent } from "../src/sessions/host.ts";
import { JujutsuWorkspaceDriver } from "../src/workspaces/jj-driver.ts";

class FakeTimers {
	nowMs = 0;
	#scheduled = new Map<number, () => void>();
	#nextId = 1;
	now(): number { return this.nowMs; }
	setInterval(cb: () => void): unknown { const id = this.#nextId++; this.#scheduled.set(id, cb); return id; }
	clearInterval(h: unknown) { this.#scheduled.delete(h as number); }
	advance(ms: number) { this.nowMs += ms; for (const cb of [...this.#scheduled.values()]) cb(); }
}

const SPEC = `## Goal
Create the result file.

## Requirements
- R1: result.txt contains the expected value

## Verification
- test -f result.txt
- test "$(cat result.txt)" = ok

## Artifact Policy
- Change required
`;

class FakeHandle implements SessionHandle {
	readonly role = "worker";
	readonly model = { provider: "fake", modelId: "fake/model" };
	result: { files_changed: string[]; summary: string; commit_ids: string[]; deviations: string[] } | undefined;
	capturedTimeoutMs: number | undefined;
	constructor(private readonly cwd: string, timeoutMs: number | undefined) {
		this.capturedTimeoutMs = timeoutMs;
	}
	subscribe(listener: (event: SessionHostEvent) => void): () => void {
		listener({ type: "turnStart" });
		listener({ type: "settled" });
		return () => undefined;
	}
	prompt(): Promise<void> {
		return Promise.resolve().then(() => {
			writeFileSync(join(this.cwd, "result.txt"), "ok", "utf8");
			execFileSync("jj", ["commit", "-m", "fake worker"], {
				cwd: this.cwd,
				stdio: "pipe",
				env: { ...process.env, JJ_EDITOR: "true" },
			});
			this.result = { files_changed: ["result.txt"], summary: "created result", commit_ids: ["fake-commit"], deviations: [] };
		});
	}
	abort(): Promise<void> { return Promise.resolve(); }
	stats() {
		return Promise.resolve({
			sessionFile: undefined,
			sessionId: "fake-session",
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 1,
			toolResults: 1,
			totalMessages: 4,
			tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
			cost: 1.25,
		});
	}
	setModel(): Promise<void> { return Promise.resolve(); }
	close(): void {}
}

function capturingHost(capture: { timeoutMs?: number | undefined }): SessionHost {
	return {
		spawn: (config: SessionHostConfig) => {
			capture.timeoutMs = config.timeoutMs;
			return Promise.resolve(new FakeHandle(config.cwd, config.timeoutMs));
		},
	};
}

function initRepo(repo: string): void {
	execFileSync("jj", ["git", "init", "--colocate"], { cwd: repo, stdio: "pipe" });
	writeFileSync(join(repo, "README.md"), "fixture\n", "utf8");
	execFileSync("jj", ["commit", "-m", "initial"], { cwd: repo, stdio: "pipe", env: { ...process.env, JJ_EDITOR: "true" } });
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string) => { if (!cond) errors.push(msg); };

	// R1: CLI parsing independent maxTurns, default unset (no cap)
	{
		const args = parseCliArgs(["--spec", "task.md", "--model", "fake/model", "--max-turns", "7"]);
		check(args.maxTurns === 7, `CLI max-turns parsed, got ${args.maxTurns}`);
		const unset = parseCliArgs(["--spec", "task.md", "--model", "fake/model"]);
		check(unset.maxTurns === undefined, "CLI maxTurns default unset (no cap)");
		const zero = parseCliArgs(["--spec", "task.md", "--model", "fake/model", "--max-turns", "0"]);
		check(zero.maxTurns === 0, "CLI max-turns 0 = no cap");
		let costError: unknown;
		try { parseCliArgs(["--spec", "task.md", "--model", "fake/model", "--max-cost-usd", "0"]); }
		catch (error) { costError = error; }
		check(costError instanceof CliUsageError && costError.message === MAX_COST_USD_UNSUPPORTED_MESSAGE, "CLI maxCostUsd rejects with stable unsupported-live-cost message");
		let threw = false;
		try { parseCliArgs(["--spec", "task.md", "--model", "fake/model", "--max-turns", "-1"]); } catch { threw = true; }
		check(threw, "negative maxTurns rejected");
	}

	// R1: CLI parsing wall-timeout-ms — positive integer only, defaults absent, rejects invalid forms
	{
		const parsed = parseCliArgs(["--spec", "task.md", "--model", "fake/model", "--wall-timeout-ms", "60000"]);
		check(parsed.wallTimeoutMs === 60000, `CLI wall-timeout-ms parsed, got ${parsed.wallTimeoutMs}`);
		const parsedEq = parseCliArgs(["--spec", "task.md", "--model", "fake/model", "--wall-timeout-ms=120000"]);
		check(parsedEq.wallTimeoutMs === 120000, `CLI wall-timeout-ms= parsed, got ${parsedEq.wallTimeoutMs}`);
		const unset = parseCliArgs(["--spec", "task.md", "--model", "fake/model"]);
		check(unset.wallTimeoutMs === undefined, "CLI wallTimeoutMs default unset (host default)");
		const expectThrow = (argv: string[], label: string) => {
			let threw = false;
			try { parseCliArgs(argv); } catch (e) { threw = e instanceof CliUsageError; }
			check(threw, label);
		};
		expectThrow(["--spec", "task.md", "--model", "fake/model", "--wall-timeout-ms", "0"], "zero wallTimeoutMs rejected");
		expectThrow(["--spec", "task.md", "--model", "fake/model", "--wall-timeout-ms", "-1"], "negative wallTimeoutMs rejected");
		expectThrow(["--spec", "task.md", "--model", "fake/model", "--wall-timeout-ms", "10.5"], "non-integer wallTimeoutMs rejected");
		expectThrow(["--spec", "task.md", "--model", "fake/model", "--wall-timeout-ms", "abc"], "non-numeric wallTimeoutMs rejected");
		expectThrow(["--spec", "task.md", "--model", "fake/model", "--wall-timeout-ms", ""], "empty wallTimeoutMs rejected");
		expectThrow(["--spec", "task.md", "--model", "fake/model", "--wall-timeout-ms="], "empty inline wallTimeoutMs rejected");
		expectThrow(["--spec", "task.md", "--model", "fake/model", "--wall-timeout-ms"], "missing value wallTimeoutMs rejected");
		expectThrow(["--spec", "task.md", "--model", "fake/model", "--wall-timeout-ms", "100", "--wall-timeout-ms", "200"], "duplicate wallTimeoutMs rejected");
		expectThrow(["--spec", "task.md", "--model", "fake/model", "--wall-timeout-ms=100", "--wall-timeout-ms", "200"], "duplicate wallTimeoutMs with equals rejected");
		// also ensure error goes through usage path when run via runCli
	}

	// Pure decision: budget_exceeded vs wall independence
	{
		const budget = decideMaxTurnsAction({ turns: 5, maxTurns: 5 });
		check(budget.kind === "abort" && budget.reason === "budget_exceeded", `maxTurns 5/5 aborts budget_exceeded, got ${JSON.stringify(budget)}`);
		const under = decideMaxTurnsAction({ turns: 4, maxTurns: 5 });
		check(under.kind === "continue", "under cap continues");
		const nocap = decideMaxTurnsAction({ turns: 100, maxTurns: 0 });
		check(nocap.kind === "continue", "0 = no cap never aborts");

		// Wall and turns are independent pure functions — same inputs do not conflate
		const wall = decideWallAction({ nowMs: 1000, startedAtMs: 0, wallTimeoutMs: 500 });
		check(wall.kind === "abort" && wall.reason === "wall_timeout", "wall decision is wall_timeout");
		const bothWall = decideWallAction({ nowMs: 2000, startedAtMs: 0, wallTimeoutMs: 1000 });
		const bothBudget = decideMaxTurnsAction({ turns: 10, maxTurns: 5 });
		check(bothWall.kind === "abort" && bothWall.reason === "wall_timeout" && bothBudget.kind === "abort" && bothBudget.reason === "budget_exceeded", "wall and budget reasons distinct");

		// execution-budget pure helper: only maxTurns can interrupt. Cost is
		// measured after settlement and is never an interruption decision.
		check(budgetReason(5, 0, { maxTurns: 5, maxCostUsd: 0 }) === "turns", "budgetReason turns");
		check(budgetReason(0, 5, { maxTurns: 0, maxCostUsd: 5 }) === null, "budgetReason ignores historical cost cap");
		check(budgetReason(1, 1, { maxTurns: 0, maxCostUsd: 0 }) === null, "no cap -> null");
	}

	// R1 daemon ingress: a configured cost cap is rejected before the daemon
	// can validate/provision a workspace or spawn a session.
	{
		let costError: unknown;
		try {
			await runParallelTask({
				subTasks: [],
				projectDir: "/does-not-exist",
				artifactsDir: "/does-not-exist/artifacts",
				dbPath: "/does-not-exist/ledger.sqlite",
				model: "fake/model",
				workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: "/does-not-exist" }),
				maxCostUsd: 0,
			});
		} catch (error) { costError = error; }
		check(costError instanceof Error && costError.message === MAX_COST_USD_UNSUPPORTED_MESSAGE, "daemon maxCostUsd rejects before workspace/session work");
	}

	// Watchdog driver: maxTurns aborts with budget_exceeded, wall with wall_timeout, independent
	{
		const timers = new FakeTimers();
		const actions: any[] = [];
		const driver = new WatchdogDriver({ timers: timers as any, limits: { maxTurns: 3, wallTimeoutMs: 900000, noProgressTimeoutMs: 900000, toolTimeoutMs: 900000 }, onAction: (a) => actions.push(a) });
		driver.start();
		driver.onEvent({ type: "turnStart" });
		driver.onEvent({ type: "turnStart" });
		check(actions.length === 0, "2 turns under cap no abort");
		driver.onEvent({ type: "turnStart" }); // 3rd turn hits cap
		check(actions.length === 1 && actions[0].reason === "budget_exceeded", `3rd turn triggers budget_exceeded, got ${JSON.stringify(actions[0])}`);
		check(driver.terminal?.reason === "budget_exceeded", "driver terminal budget_exceeded");
		driver.dispose();
	}
	{
		// wall still wall_timeout when maxTurns unset
		const timers = new FakeTimers();
		const actions: any[] = [];
		const driver = new WatchdogDriver({ timers: timers as any, limits: { maxTurns: 0, wallTimeoutMs: 500, noProgressTimeoutMs: 900000, toolTimeoutMs: 900000 }, onAction: (a) => actions.push(a) });
		driver.start();
		timers.advance(600);
		check(actions.length === 1 && actions[0].reason === "wall_timeout", `wall_timeout distinct from budget, got ${JSON.stringify(actions[0])}`);
		driver.dispose();
	}
	{
		// wall and budget both configured: turn cap fires before wall, wall fires after if turns not hit
		const timers = new FakeTimers();
		const actions: any[] = [];
		const driver = new WatchdogDriver({ timers: timers as any, limits: { maxTurns: 2, wallTimeoutMs: 500, noProgressTimeoutMs: 900000, toolTimeoutMs: 900000 }, onAction: (a) => actions.push(a) });
		driver.start();
		driver.onEvent({ type: "turnStart" });
		driver.onEvent({ type: "turnStart" }); // hits budget
		check(actions[0]?.reason === "budget_exceeded", "budget fires first");
		// latched, wall does not overwrite
		timers.advance(1000);
		check(actions.length === 1, "latched budget prevents wall overwrite");
		driver.dispose();
	}
	{
		// no-cap default: many turns never abort
		const timers = new FakeTimers();
		const actions: any[] = [];
		const driver = new WatchdogDriver({ timers: timers as any, limits: { maxTurns: 0, wallTimeoutMs: 900000, noProgressTimeoutMs: 900000, toolTimeoutMs: 900000 }, onAction: (a) => actions.push(a) });
		driver.start();
		for (let i = 0; i < 20; i++) driver.onEvent({ type: "turnStart" });
		check(actions.length === 0, "no-cap default never aborts on turns");
		driver.dispose();
	}
	{
		// wall timeout plumbing: configured value is the single wall bound, default is host default, no second timer
		const timers = new FakeTimers();
		const driverDefault = new WatchdogDriver({ timers: timers as any });
		check(driverDefault.limits.wallTimeoutMs === DEFAULT_WATCHDOG_WALL_TIMEOUT_MS, `default wall is host default, got ${driverDefault.limits.wallTimeoutMs}`);
		driverDefault.dispose();
		const timers2 = new FakeTimers();
		const driverCustom = new WatchdogDriver({ timers: timers2 as any, limits: { wallTimeoutMs: 123456 } });
		check(driverCustom.limits.wallTimeoutMs === 123456, `custom wallTimeoutMs is sole bound, got ${driverCustom.limits.wallTimeoutMs}`);
		// prove single interval: advancing once fires wall exactly once
		const actions: any[] = [];
		const timers3 = new FakeTimers();
		const driver = new WatchdogDriver({ timers: timers3 as any, limits: { wallTimeoutMs: 500, noProgressTimeoutMs: 900000, toolTimeoutMs: 900000 }, onAction: (a) => actions.push(a) });
		driver.start();
		timers3.advance(600);
		check(actions.length === 1 && actions[0].reason === "wall_timeout", "single wall timer fires once");
		driver.dispose();
		driverCustom.dispose();
	}

	// Trace observability R3: model.assigned and task.failed carry caps, report renders
	{
		const collector = new TraceCollector("run-budget", "task-budget", () => "2026-01-01T00:00:00.000Z");
		collector.record({
			type: "model.assigned",
			phase: "model",
			taskId: "task-budget",
			provider: "fake",
			config: "fake/model",
			detail: { modelId: "fake/model", maxTurns: 3, maxCostUsd: 1, wallTimeoutMs: 60000 },
		});
		collector.record({
			type: "task.failed",
			phase: "task",
			taskId: "task-budget",
			detail: { cause: "budget_exceeded:turns", stage: "session", code: "budget_exceeded", maxTurns: 3, maxCostUsd: 1 },
		});
		const trace = collector.finish("failed");
		const report = renderTraceReport(trace);
		check(report.includes("Configured maxTurns: 3"), `report shows configured maxTurns, got ${report.slice(0, 800)}`);
		check(report.includes("Budget maxTurns: 3"), "report shows budget maxTurns");
		check(report.includes("Configured maxCostUsd: 1"), "historical maxCostUsd remains readable in reports");
		check(report.includes("Stage: session"), "report stage session");
		check(report.includes("Code: budget_exceeded"), "report code budget_exceeded");
		// ensure not conflated with wall
		check(!report.includes("wall_timeout"), "report does not conflate with wall");
	}

	// R3 wall trace observability: model.assigned wallTimeoutMs rendered, distinct from budget
	{
		const collector = new TraceCollector("run-wall", "task-wall", () => "2026-01-01T00:00:00.000Z");
		collector.record({
			type: "model.assigned",
			phase: "model",
			taskId: "task-wall",
			provider: "fake",
			config: "fake/model",
			detail: { modelId: "fake/model", wallTimeoutMs: 123456 },
		});
		const trace = collector.finish("ship");
		const report = renderTraceReport(trace);
		check(report.includes("Configured wallTimeoutMs: 123456"), `report shows configured wallTimeoutMs, got ${report.slice(0, 1200)}`);
		check(report.includes("Budget wallTimeoutMs: 123456"), "report budget wallTimeoutMs mirrors configured");
		// absence case
		const collector2 = new TraceCollector("run-wall2", "task-wall2", () => "2026-01-01T00:00:00.000Z");
		collector2.record({
			type: "model.assigned",
			phase: "model",
			taskId: "task-wall2",
			provider: "fake",
			config: "fake/model",
			detail: { modelId: "fake/model" },
		});
		const trace2 = collector2.finish("ship");
		const report2 = renderTraceReport(trace2);
		check(report2.includes("Configured wallTimeoutMs: unavailable"), "report shows unavailable when wallTimeoutMs absent");
	}

	// R2 daemon/session plumbing + R3 trace via hermetic runCli
	{
		const root = mkdtempSync(join(tmpdir(), "core-v2-budget-wall-"));
		try {
			const repo = join(root, "repo");
			const { mkdirSync } = await import("node:fs");
			const specPath = join(root, "task.md");
			writeFileSync(specPath, SPEC, "utf8");

			// With wall timeout: host receives timeoutMs and trace records it
			{
				const repoWall = join(root, "repo-wall");
				mkdirSync(repoWall, { recursive: true });
				initRepo(repoWall);
				const capture: { timeoutMs?: number } = {};
				const host = capturingHost(capture);
				const artifacts = join(root, "artifacts-wall");
				const dbPath = join(root, "wall.sqlite");
				const gatewayResult: { events?: any[] } = {};
				const result = await runCli(
					["--spec", specPath, "--project-dir", repoWall, "--model", "fake/model", "--db", dbPath, "--artifacts-dir", artifacts, "--wall-timeout-ms", "98765"],
					{ host, workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: repoWall }), write: () => undefined, writeError: () => undefined },
				);
				check(result.exitCode === 0, `wall run exits zero, got ${result.exitCode} ${result.error ?? ""}`);
				check(result.receipt?.costUsd === 1.25 && result.receipt.usageStatus === "measured", "measured final cost remains in the receipt");
				check(capture.timeoutMs === 98765, `host timeoutMs threaded from CLI, got ${capture.timeoutMs}`);
				if (result.tracePath !== undefined) {
					const trace = TraceArtifactSchema.parse(JSON.parse(readFileSync(result.tracePath, "utf8")));
					const assigned = trace.events.find((e) => e.type === "model.assigned");
					check((assigned?.detail as any)?.wallTimeoutMs === 98765, `trace model.assigned wallTimeoutMs=98765, got ${JSON.stringify(assigned?.detail)}`);
					const report = renderTraceReport(trace, result.tracePath);
					check(report.includes("Configured wallTimeoutMs: 98765"), "trace-report renders wallTimeoutMs from plumbing run");
				} else {
					check(false, "wall run produced trace path");
				}
			}

			// Without wall timeout: default host timeout, trace omits wallTimeoutMs (remains default-absent)
			{
				const repoDefault = join(root, "repo-default");
				mkdirSync(repoDefault, { recursive: true });
				initRepo(repoDefault);
				const capture: { timeoutMs?: number } = { timeoutMs: 999999 };
				// use sentinel to detect undefined
				let observed: number | undefined = 999999;
				const host: SessionHost = {
					spawn: (config: SessionHostConfig) => {
						observed = config.timeoutMs;
						return Promise.resolve(new FakeHandle(config.cwd, config.timeoutMs));
					},
				};
				const artifacts2 = join(root, "artifacts-default");
				const dbPath2 = join(root, "default.sqlite");
				const result2 = await runCli(
					["--spec", specPath, "--project-dir", repoDefault, "--model", "fake/model", "--db", dbPath2, "--artifacts-dir", artifacts2],
					{ host, workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: repoDefault }), write: () => undefined, writeError: () => undefined },
				);
				check(result2.exitCode === 0, `default wall run exits zero, got ${result2.exitCode} ${result2.error ?? ""}`);
				check(observed === undefined, `default absence does not set host timeoutMs, got ${observed}`);
				if (result2.tracePath !== undefined) {
					const trace2 = TraceArtifactSchema.parse(JSON.parse(readFileSync(result2.tracePath, "utf8")));
					const assigned2 = trace2.events.find((e) => e.type === "model.assigned");
					check((assigned2?.detail as any)?.wallTimeoutMs === undefined, `trace omits wallTimeoutMs when CLI absent, got ${JSON.stringify(assigned2?.detail)}`);
				} else {
					check(false, "default run produced trace path");
				}
			}

			// Invalid via runCli usage path: zero, duplicate, empty, missing all map to exit 2
			{
				const repoInvalid = join(root, "repo-invalid");
				mkdirSync(repoInvalid, { recursive: true });
				initRepo(repoInvalid);
				const invalid1 = await runCli(["--spec", specPath, "--project-dir", repoInvalid, "--model", "fake/model", "--wall-timeout-ms", "0"], { host: capturingHost({}), workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: repoInvalid }), write: () => undefined, writeError: () => undefined });
				check(invalid1.exitCode === 2, `zero wall via runCli maps to usage exit 2, got ${invalid1.exitCode}`);
				const invalid2 = await runCli(["--spec", specPath, "--project-dir", repoInvalid, "--model", "fake/model", "--wall-timeout-ms", "100", "--wall-timeout-ms", "200"], { host: capturingHost({}), workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: repoInvalid }), write: () => undefined, writeError: () => undefined });
				check(invalid2.exitCode === 2, "duplicate wall via runCli maps to usage");
				const invalid3 = await runCli(["--spec", specPath, "--project-dir", repoInvalid, "--model", "fake/model", "--wall-timeout-ms="], { host: capturingHost({}), workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: repoInvalid }), write: () => undefined, writeError: () => undefined });
				check(invalid3.exitCode === 2, "empty inline wall via runCli maps to usage");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	if (errors.length > 0) throw new Error("test-budget failed:\n  " + errors.join("\n  "));
	console.log("✓ budget: maxCostUsd ingress rejection, measured cost accounting, maxTurns/wall independence, trace/report");
	console.log("✓ budget wall: --wall-timeout-ms parsing/validation, single wall timer, trace/report, daemon/session plumbing");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
