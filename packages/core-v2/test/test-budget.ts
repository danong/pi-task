/**
 * Hermetic tests for independent maxTurns budget (R1–R4).
 * Zero LLM, zero network. Tests pure budget decision, watchdog independence,
 * CLI parsing, daemon plumbing, trace observability and report rendering.
 */
import { pathToFileURL } from "node:url";
import { parseCliArgs } from "../src/cli.ts";
import { TraceCollector } from "../src/contracts/trace.ts";
import { renderTraceReport } from "../src/bench/trace-report.ts";
import { decideMaxTurnsAction, decideWallAction } from "../src/guards/watchdogs.ts";
import { WatchdogDriver } from "../src/guards/watchdog-driver.ts";
import { budgetReason } from "../src/budget/execution-budget.ts";

class FakeTimers {
	nowMs = 0;
	#scheduled = new Map<number, () => void>();
	#nextId = 1;
	now(): number { return this.nowMs; }
	setInterval(cb: () => void): unknown { const id = this.#nextId++; this.#scheduled.set(id, cb); return id; }
	clearInterval(h: unknown) { this.#scheduled.delete(h as number); }
	advance(ms: number) { this.nowMs += ms; for (const cb of [...this.#scheduled.values()]) cb(); }
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
		let threw = false;
		try { parseCliArgs(["--spec", "task.md", "--model", "fake/model", "--max-turns", "-1"]); } catch { threw = true; }
		check(threw, "negative maxTurns rejected");
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

		// execution-budget pure helper
		check(budgetReason(5, 0, { maxTurns: 5, maxCostUsd: 0 }) === "turns", "budgetReason turns");
		check(budgetReason(0, 5, { maxTurns: 0, maxCostUsd: 5 }) === "cost", "budgetReason cost");
		check(budgetReason(1, 1, { maxTurns: 0, maxCostUsd: 0 }) === null, "no cap -> null");
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
		check(report.includes("Stage: session"), "report stage session");
		check(report.includes("Code: budget_exceeded"), "report code budget_exceeded");
		// ensure not conflated with wall
		check(!report.includes("wall_timeout"), "report does not conflate with wall");
	}

	if (errors.length > 0) throw new Error("test-budget failed:\n  " + errors.join("\n  "));
	console.log("✓ budget: CLI maxTurns, watchdog independence, stage=session code=budget_exceeded, trace/report, no-cap default");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
