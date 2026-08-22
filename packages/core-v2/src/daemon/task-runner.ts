/**
 * Task runner — M1.4 / R1–R6.
 *
 * Assembles the v2 pipeline into one entry point:
 *   validate spec → route → host session (guarded) → yield → verify
 *   → persist ledger rows → TaskReceipt.
 *
 * Deterministic-prefix rule (R5): the worker system prompt is a pure
 * function of the spec markdown — no timestamps, ids, or clocks are ever
 * interpolated. Ledger ids may vary; prompt bytes may not.
 *
 * Cost accounting note: the M1 session host does not surface provider
 * usage yet (M3 adds COR/token accounting), so receipts carry
 * TASK_RUNNER_COST_UNAVAILABLE until then.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { TaskReceipt, Yield } from "../contracts/index.ts";
import { writeFailureArtifact } from "../guards/artifacts.ts";
import { attachWatchdogs, type WatchdogEnd } from "../guards/watchdog-driver.ts";
import { LedgerStore } from "../ledger/store.ts";
import { routeTask, type RoutingFeedbackRow } from "../router/route.ts";
import { createSessionHost, SessionHostError, type SessionHandle, type SessionHost, type SessionHostEvent } from "../sessions/host.ts";
import { runVerification } from "../verify/run.ts";

/** Receipt cost placeholder until M3 wires usage accounting (FR-9/NFR-3). */
export const TASK_RUNNER_COST_UNAVAILABLE = 0;

/** Typed spec-validation failure naming what is missing (R3). */
export class SpecValidationError extends Error {
	constructor(public readonly missing: "requirements" | "verification") {
		super(`Spec is missing ${missing}`);
		this.name = "SpecValidationError";
	}
}

export interface ParsedTaskSpec {
	goal: string;
	requirements: string[];
	verificationCommands: string[];
}

/**
 * Parse the Goal / Requirements / Verification sections from a task spec.
 * Requirements are non-empty bullet/numbered lines under `## Requirements`;
 * verification commands are non-empty lines under `## Verification` with a
 * leading bullet stripped.
 */
export function parseTaskSpec(specMarkdown: string): ParsedTaskSpec {
	const sections = new Map<string, string[]>();
	let current: string | undefined;
	for (const line of specMarkdown.split("\n")) {
		const heading = line.match(/^##\s+(.+?)\s*$/);
		if (heading) {
			current = (heading[1] ?? "").trim().toLowerCase();
			sections.set(current, []);
			continue;
		}
		if (current !== undefined) {
			sections.get(current)!.push(line);
		}
	}

	const goalLines = (sections.get("goal") ?? []).map((l) => l.trim()).filter((l) => l.length > 0);
	const firstGoal = goalLines[0] ?? "(no goal line)";
	const requirementLines = (sections.get("requirements") ?? [])
		.map((l) => l.replace(/^\s*(?:[-*]|\d+[.:)])\s*/, "").trim())
		.filter((l) => l.length > 0);
	const commandLines = (sections.get("verification") ?? [])
		.map((l) => l.replace(/^\s*-\s*/, "").trim())
		.filter((l) => l.length > 0);

	if (requirementLines.length === 0) throw new SpecValidationError("requirements");
	if (commandLines.length === 0) throw new SpecValidationError("verification");

	return {
		goal: firstGoal,
		requirements: requirementLines,
		verificationCommands: commandLines,
	};
}

/** The worker system prompt: byte-stable pure function of the spec (R5). */
export function buildWorkerSystemPrompt(specMarkdown: string): string {
	return [
		"You are a focused coding-task worker.",
		"Complete every requirement of the task spec below inside the current working directory.",
		"Use your tools to inspect and edit files and to run commands.",
		"When every requirement is met and commits are made, call the yield tool with",
		"files_changed, summary, commit_ids, and deviations (empty list if none).",
		"Do not call yield before the work is done.",
		"",
		"## Task spec",
		"",
		specMarkdown.trimEnd(),
		"",
	].join("\n");
}

/** Derive a stable task id from the spec content + cwd (prompt-independent). */
export function deriveTaskId(specMarkdown: string, cwd: string): string {
	return createHash("sha256").update(`${cwd}\n${specMarkdown}`).digest("hex").slice(0, 12);
}

export interface RunTaskOptions {
	specMarkdown: string;
	cwd: string;
	artifactsDir: string;
	dbPath: string;
	/** Model id resolved against the SDK registry (e.g. openrouter/stealth/ox-alpha). */
	model: string;
	/** Tier name carried into routing decisions. Default "local". */
	tierName?: string;
	/** Dependency injection for tests — defaults to a real in-process host. */
	host?: SessionHost;
	/** Observability sink for session events (progress UIs, debugging). */
	onEvent?: (event: SessionHostEvent) => void;
	/** Wall-clock bound forwarded to the session host. */
	sessionTimeoutMs?: number;
}

/** Outcome of one run beyond the receipt itself. */
export interface RunTaskResult {
	receipt: TaskReceipt;
	yieldedResult?: Yield | undefined;
	verificationPassed: boolean;
	taskId: string;
}

interface RunObservation {
	lastEvent: SessionHostEvent | undefined;
	lastTool: string | undefined;
	turns: number;
	watchdogAbort: WatchdogEnd | undefined;
	hostError: string | undefined;
}

function describeTool(toolName: string | undefined): string | undefined {
	return toolName === undefined ? undefined : `tool:${toolName}`;
}

/** Run one task end-to-end (R1). See module docstring for the pipeline. */
export async function runTask(options: RunTaskOptions): Promise<RunTaskResult> {
	if (!existsSync(options.cwd)) {
		throw new Error(`runTask: cwd does not exist: ${options.cwd}`);
	}
	const parsed = parseTaskSpec(options.specMarkdown);
	const taskId = deriveTaskId(options.specMarkdown, options.cwd);
	mkdirSync(options.artifactsDir, { recursive: true });

	const store = new LedgerStore(options.dbPath);
	store.insertTask({ id: taskId, goal: parsed.goal });

	const observation: RunObservation = {
		lastEvent: undefined,
		lastTool: undefined,
		turns: 0,
		watchdogAbort: undefined,
		hostError: undefined,
	};

	const failRun = (cause: string): RunTaskResult => {
		writeFailureArtifact({
			artifactsDir: options.artifactsDir,
			runId: taskId,
			cause,
			lastEvent: observation.lastEvent,
			lastTool: observation.lastTool,
		});
		store.setSessionStatus(`${taskId}-worker`, "crashed");
		store.setTaskStatus(taskId, "failed");
		return {
			receipt: {
				taskId,
				verdict: "failed",
				filesChanged: 0,
				commitIds: [],
				turns: observation.turns,
				costUsd: TASK_RUNNER_COST_UNAVAILABLE,
				bundleHit: null,
			},
			verificationPassed: false,
			taskId,
		};
	};

	// ── Route (§5.4): feedback comes from this repo's ledger rows. ──────
	const repo = options.cwd.split("/").filter(Boolean).pop() ?? options.cwd;
	const feedbackRows: RoutingFeedbackRow[] = [];
	for (const [mode, rate] of store.routingSummary(repo)) {
		feedbackRows.push({ repo, mode, hit: rate.hits });
		feedbackRows.push({ repo, mode, hit: rate.total - rate.hits });
	}
	const decision = routeTask({
		spec: {
			requirementCount: parsed.requirements.length,
			hasOrientationNotes: /orientation/i.test(options.specMarkdown),
			continuesPriorWork: false,
			hasLiveParentSession: false,
		},
		tier: { name: options.tierName ?? "local", lane: "interactive" },
		repo,
		feedback: feedbackRows,
	});
	store.setTaskPlanMode(taskId, decision.planMode);

	// ── Host the worker session. ────────────────────────────────────────
	store.insertMicroSession({ id: `${taskId}-worker`, taskId, role: "worker" });
	store.setTaskStatus(taskId, "executing");

	const host = options.host ?? createSessionHost();
	let handle: SessionHandle;
	try {
		handle = await host.spawn({
			role: "worker",
			modelId: options.model,
			cwd: options.cwd,
			systemPrompt: buildWorkerSystemPrompt(options.specMarkdown),
			...(options.sessionTimeoutMs === undefined ? {} : { timeoutMs: options.sessionTimeoutMs }),
		});
	} catch (err) {
		const cause = err instanceof SessionHostError
			? `session host error (${err.code}): ${err.message}`
			: `session spawn failed: ${err instanceof Error ? err.message : String(err)}`;
		return failRun(cause);
	}

	const unsubscribeEvents = handle.subscribe((event) => {
		options.onEvent?.(event);
		if (event.type === "turnStart") observation.turns += 1;
		if (event.type === "toolEnd") observation.lastTool = event.toolName;
		observation.lastEvent = event;
	});
	const watchdogs = attachWatchdogs(handle, {
		onAction: (action) => {
			if (action.kind === "abort") observation.watchdogAbort = action;
		},
	});

	try {
		await handle.prompt(buildWorkerPromptText(parsed));
	} catch (err) {
		const cause = err instanceof SessionHostError
			? `prompt failed (${err.code}): ${err.message}`
			: `prompt failed: ${err instanceof Error ? err.message : String(err)}`;
		handle.close();
		watchdogs.dispose();
		unsubscribeEvents();
		return failRun(cause);
	} finally {
		watchdogs.dispose();
		unsubscribeEvents();
	}

	const yieldPayload: Yield | undefined = handle.result;
	handle.close();

	if (!yieldPayload) {
		const cause = observation.watchdogAbort
			? `watchdog abort: ${observation.watchdogAbort.reason}`
			: "settled without yield";
		return failRun(cause);
	}

	// ── Verify on the working tree (FR-6 semantics via verify runner). ──
	store.setSessionStatus(`${taskId}-worker`, "yielded", JSON.stringify(yieldPayload));
	const verification = await runVerification(parsed.verificationCommands, { cwd: options.cwd });

	if (!verification.passed) {
		const firstFailure = verification.commands.find((c) => c.exitCode !== 0);
		writeFailureArtifact({
			artifactsDir: options.artifactsDir,
			runId: taskId,
			cause: "verification failed",
			stderrTail: firstFailure?.stderrTail,
		});
		store.setTaskStatus(taskId, "failed");
		return {
			receipt: {
				taskId,
				verdict: "failed",
				filesChanged: yieldPayload.files_changed.length,
				commitIds: yieldPayload.commit_ids,
				turns: observation.turns,
				costUsd: TASK_RUNNER_COST_UNAVAILABLE,
				bundleHit: null,
			},
			yieldedResult: yieldPayload,
			verificationPassed: false,
			taskId,
		};
	}

	store.recordRoutingFeedback(repo, decision.planMode, 1);
	store.setTaskStatus(taskId, "completed");
	return {
		receipt: {
			taskId,
			verdict: "ship",
			filesChanged: yieldPayload.files_changed.length,
			commitIds: yieldPayload.commit_ids,
			turns: observation.turns,
			costUsd: TASK_RUNNER_COST_UNAVAILABLE,
			bundleHit: null,
		},
		yieldedResult: yieldPayload,
		verificationPassed: true,
		taskId,
	};
}

/** The user turn driving the worker: spec echo + yield reminder. Pure. */
function buildWorkerPromptText(parsed: ParsedTaskSpec): string {
	return [
		`Goal: ${parsed.goal}`,
		`Requirements (${parsed.requirements.length}):`,
		...parsed.requirements.map((r, i) => `${i + 1}. ${r}`),
		`When done, call yield. Verification that must pass afterwards:`,
		...parsed.verificationCommands.map((c) => `- ${c}`),
	].join("\n");
}
