/**
 * Forked adversarial review (Phase 7).
 *
 * After a worker yields, the reviewer reuses the worker's grounded context by
 * FORKING its persisted session (pi --fork): the reviewer inherits every read
 * and bash output for free, then a `context` handler (tools/findings.ts →
 * prune.ts) strips the worker's commitment (reasoning/edits/checklist) so the
 * review is adversarial, not self-confirming. The reviewer reports structured
 * findings via the report_findings tool; this runner captures that payload.
 *
 * forkedReview() is the runner (spawns a real pi RPC process — exercised by
 * test-e2e.ts). buildReviewPrompt() and settleReview() are pure and tested
 * hermetically (test-review.ts).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
	attachJsonlReader,
	buildAbortError,
	createWorkerEventState,
	decideIdleAction,
	decideNoProgressAction,
	formatDuration,
	getPiInvocation,
	reduceWorkerEvent,
	STDERR_TAIL_CHARS,
	type WorkerUsage,
} from "./worker.ts";
import type { RequirementStatus, ReviewResult } from "./schemas/findings.ts";
import { DEFAULT_PERSONA, type Persona } from "./personas.ts";
import {
	REASONING_EXCLUDE_EXTENSION_PATH,
	SERVICE_TIER_EXTENSION_PATH,
	SESSION_ID_EXTENSION_PATH,
	TOOL_GUARD_EXTENSION_PATH,
} from "./worker.ts";

/** Absolute path to the reviewer-side extension (report_findings + pruning). */
export const FINDINGS_EXTENSION_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"tools",
	"findings.ts",
);

const SIGKILL_DELAY_MS = 5000;

/** Wall-clock budget for a forked review (20 min). Mirrors WORKER_WALL_TIMEOUT_MS. */
export const REVIEW_WALL_TIMEOUT_MS = 20 * 60_000;

/**
 * Default no-progress window for a forked review (5 min — HALF the worker's
 * 10 min): a reviewer that emits NO RPC activity for this long is aborted as
 * hung (todo #80). A review is supposed to be one fast model pass, not a
 * 70-turn exploration, so the window is deliberately shorter than
 * WORKER_NO_PROGRESS_TIMEOUT_MS. Overridable via
 * ForkReviewOptions.noProgressTimeoutMs.
 */
export const REVIEW_NO_PROGRESS_TIMEOUT_MS = 5 * 60_000;

/** Poll interval for the review no-progress watchdog (mirrors worker.ts). */
const REVIEW_NO_PROGRESS_CHECK_INTERVAL_MS = 30_000;

/**
 * First-call fail-fast deadline (3 min): after the review prompt is written,
 * the FIRST parsed RPC event (any turn/tool/agent event) must arrive within
 * this window. The dominant observed hang signature is ONE stalled
 * multi-hundred-K-token first call — the fork re-encodes the pruned context
 * on an empty prompt cache — that emits nothing; this kills it in minutes
 * instead of letting the 20-min wall elapse. Overridable via
 * ForkReviewOptions.firstEventTimeoutMs.
 */
export const REVIEW_FIRST_EVENT_TIMEOUT_MS = 3 * 60_000;

/** Follow-up prompt nudging a settled reviewer that forgot report_findings(). */
const REVIEW_IDLE_NUDGE_PROMPT =
	"Your review turn ended without calling report_findings(). Call report_findings() now with your structured findings — the review cannot complete without it.";

export interface ForkReviewOptions {
	/** Repo cwd (the reviewer runs here; the fork source is an absolute path). */
	cwd: string;
	/** Worker's persisted session file — the fork source. */
	sessionFile: string;
	/** Session dir for the forked reviewer (where the new session is written). */
	sessionDir: string;
	/** Reviewer model, e.g. "opencode-go/deepseek-v4-flash". */
	model: string;
	/** The spec markdown (Goal / Requirements / Verification). */
	specMarkdown: string;
	/** Final diff of the change (e.g. `jj diff -r @- --git`). */
	diff: string;
	/** Worker's yield summary. */
	summary: string;
	/** Worker's yield deviations (empty if none). */
	deviations: string[];
	/** Reviewer persona. Default: adversarial. */
	persona?: Persona;
	/**
	 * No-progress window (ms): a reviewer that emits NO RPC activity for this
	 * long is aborted as hung. Default: {@link REVIEW_NO_PROGRESS_TIMEOUT_MS}
	 * (5 min — half the worker's window). Mirrors WorkerOptions.noProgressTimeoutMs.
	 */
	noProgressTimeoutMs?: number;
	/**
	 * Wall-clock budget for THIS review fork (ms). Default:
	 * {@link REVIEW_WALL_TIMEOUT_MS} (20 min). The config-driven value
	 * ([defaults] review_wall_timeout_ms) arrives here as
	 * ExecuteTaskOptions.reviewWallTimeoutMs, threaded through as this
	 * per-fork wall. Per-assessment: every review fork gets its own budget,
	 * independent of (never subtracted from) the worker's tier wall
	 * (workerTimeoutMs).
	 */
	wallTimeoutMs?: number;
	/**
	 * First-call fail-fast deadline (ms): the first parsed RPC event must
	 * arrive within this window of the prompt write. Default:
	 * {@link REVIEW_FIRST_EVENT_TIMEOUT_MS}.
	 */
	firstEventTimeoutMs?: number;
	/** OpenRouter service tier (the run's budget tier declares it) — set →
	 *  the reviewer subprocess injects service_tier into every call. */
	serviceTier?: string;
	/**
	 * Slim the subprocess system-prompt prefix (wave-2 cost): pass
	 * --no-skills to prune pi's injected skills-discovery list the reviewer
	 * never uses. Default true. False → the flag is omitted so the verbose
	 * prefix returns.
	 */
	slimWorkerPrompt?: boolean;
	/** Model ids exempt from the tier (the standard-priced workhorse). */
	serviceTierExcludes?: string[];
	/** OpenRouter endpoint slugs for provider.only (the flex pin). */
	providerOnly?: string[];
	/** Session correlation id (wave-4 cost): set → the reviewer spawn carries
	 *  PI_TASK_SESSION_ID so its calls get the run id as session_id (mirrors
	 *  the worker). Unset → the extension injects only pi's ambient session id. */
	sessionId?: string;
	signal?: AbortSignal;
	onUpdate?: (partial: unknown) => void;
}

export interface ReviewOutcome {
	/** Schema-valid structured report (pi validated report_findings args). */
	result: ReviewResult;
	/** Reviewer token/cost usage. */
	usage: WorkerUsage;
}

/**
 * Build the review prompt injected as the reviewer's task message. The
 * inherited pruned context (reads/bash) comes from the fork and the persona
 * is the system prompt; this carries the spec, the final diff, and the
 * worker's self-report. Pure — tested hermetically.
 */
export function buildReviewPrompt(opts: {
	specMarkdown: string;
	diff: string;
	summary: string;
	deviations: string[];
}): string {
	const parts = [
		"Review the following change against its spec, then call report_findings() exactly once.",
		`## Spec\n${opts.specMarkdown}`,
		`## Final diff of the change\n\`\`\`diff\n${opts.diff}\n\`\`\``,
		`## Worker summary\n${opts.summary}`,
	];
	if (opts.deviations.length > 0) {
		parts.push(
			`## Worker-declared deviations\n${opts.deviations.map((d) => `- ${d}`).join("\n")}`,
		);
	}
	return parts.join("\n\n");
}

/**
 * Settle the review outcome on process close (pure — mirrors settleWorker).
 * A captured report → ok; otherwise an error carrying the exit code + stderr.
 */
export function settleReview(
	reportPayload: ReviewResult | null,
	exitCode: number,
	stderr: string,
): { ok: true; result: ReviewResult } | { ok: false; error: Error } {
	if (reportPayload) {
		return { ok: true, result: reportPayload };
	}
	const detail = stderr.trim() ? `\nstderr: ${stderr.slice(0, 500)}` : "";
	return {
		ok: false,
		error: new Error(
			`Reviewer exited (code ${exitCode}) without reporting findings.${detail}`,
		),
	};
}

/** Verdict order for merging: ship < fix < escalate. */
const VERDICT_ORDER: Record<ReviewResult["verdict"], number> = {
	ship: 0,
	fix: 1,
	escalate: 2,
};
/** Requirement status order for merging: met < uncertain < unmet. */
const STATUS_ORDER: Record<RequirementStatus["status"], number> = {
	met: 0,
	uncertain: 1,
	unmet: 2,
};

/**
 * Merge the outcomes of PARALLEL review axes (the default axes: standards +
 * spec-fidelity + architecture) into one ReviewResult: findings concatenated
 * (each axis carries its own priorities/categories), verdict = the worst,
 * requirement statuses merged per id (worst status wins: unmet > uncertain >
 * met), and the summed review cost. Pure — hermetically tested.
 */
export function mergeReviewOutcomes(
	outcomes: Array<{ result: ReviewResult; usage: { cost_usd: number } }>,
): { result: ReviewResult; costUsd: number } {
	const findings = outcomes.flatMap((o) => o.result.findings);
	const requirementsById = new Map<string, RequirementStatus>();
	for (const o of outcomes) {
		for (const req of o.result.requirements) {
			const existing = requirementsById.get(req.id);
			if (
				!existing ||
				STATUS_ORDER[req.status] > STATUS_ORDER[existing.status]
			) {
				requirementsById.set(req.id, req);
			}
		}
	}
	const verdict = outcomes.reduce<ReviewResult["verdict"]>(
		(worst, o) =>
			VERDICT_ORDER[o.result.verdict] > VERDICT_ORDER[worst]
				? o.result.verdict
				: worst,
		"ship",
	);
	return {
		result: {
			verdict,
			findings,
			requirements: [...requirementsById.values()].sort((a, b) =>
				a.id < b.id ? -1 : 1,
			),
		},
		costUsd: outcomes.reduce((sum, o) => sum + (o.usage.cost_usd ?? 0), 0),
	};
}

/**
 * First-call fail-fast decision (pure, todo #80): abort when the FIRST
 * parsed RPC event (any turn/tool/agent event) has not arrived within
 * `deadlineMs` of the review prompt write. The dominant observed hang
 * signature is one stalled multi-hundred-K-token first call that emits
 * nothing — neither the settle-based idle watchdog nor the no-progress
 * watchdog can see it (both post-date the first event) — so this closes the
 * gap at the prompt boundary. Hermetically tested.
 */
export function decideFirstEventAction(opts: {
	nowMs: number;
	promptWrittenAtMs: number;
	deadlineMs: number;
	firstEventArrived: boolean;
}): "abort" | null {
	if (opts.firstEventArrived) return null;
	return opts.nowMs - opts.promptWrittenAtMs >= opts.deadlineMs
		? "abort"
		: null;
}

/**
 * Rejection message when the first-call fail-fast deadline expires: names
 * the CAUSE (the initial model call emitted nothing) and the deadline, plus
 * the wall limit for context. Pure — hermetically tested.
 */
export function firstEventTimeoutErrorMessage(
	deadlineMs: number,
	wallTimeoutMs: number,
): string {
	return (
		`Reviewer aborted: the first model call produced no events — no turn, tool, or ` +
		`agent activity within ${formatDuration(deadlineMs)} (${deadlineMs} ms) of the ` +
		`review prompt; wall limit is ${formatDuration(wallTimeoutMs)}. The initial model ` +
		`call appears stalled and was killed to avoid burning the whole budget.`
	);
}

/**
 * Rejection message when the review no-progress watchdog aborts a hung
 * reviewer: names the CAUSE (no activity observed) and the window, plus the
 * wall limit. Review-specific counterpart of worker.ts's
 * noProgressErrorMessage (its "Worker aborted" wording doesn't fit the
 * reviewer). Pure — hermetically tested.
 */
export function reviewNoProgressErrorMessage(
	windowMs: number,
	wallTimeoutMs: number,
): string {
	return (
		`Reviewer aborted: no progress — no RPC activity (turns, tool calls, or events) ` +
		`observed for ${formatDuration(windowMs)} (${windowMs} ms); wall limit is ` +
		`${formatDuration(wallTimeoutMs)}. The reviewer appears hung and was killed to ` +
		`avoid burning the whole budget.`
	);
}

/**
 * Fork the worker session and run an adversarial review, resolving with the
 * structured report. Only supports personas with the 'findings' output
 * contract (report-style personas are a future concern).
 */
export async function forkedReview(
	opts: ForkReviewOptions,
): Promise<ReviewOutcome> {
	const persona = opts.persona ?? DEFAULT_PERSONA;
	if (persona.output.kind !== "findings") {
		throw new Error(
			`forkedReview supports only the 'findings' output contract; persona "${persona.name}" is '${persona.output.kind}'`,
		);
	}

	// Persona system prompt → temp file (pi reads file contents when the
	// --append-system-prompt arg is an existing path).
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-task-review-"));
	const promptPath = join(tmpDir, "persona.md");
	writeFileSync(promptPath, persona.systemPrompt, "utf-8");
	const cleanup = (): void => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	};

	const args = [
		"--mode",
		"rpc",
		"--fork",
		opts.sessionFile,
		"--session-dir",
		opts.sessionDir,
		"--model",
		opts.model,
		// --no-extensions: the reviewer loads ONLY the findings extension (see
		// worker.ts buildWorkerArgs for why discovery must be disabled).
		"--no-extensions",
		// --no-skills (wave-2 cost, [defaults] slim_worker_prompt): prune pi's
		// injected skills-discovery list from the reviewer system prompt;
		// omitted when the flag is disabled so an operator can restore the
		// verbose prefix.
		...(opts.slimWorkerPrompt === false ? [] : ["--no-skills"]),
		"--extension",
		FINDINGS_EXTENSION_PATH,
		"--extension",
		TOOL_GUARD_EXTENSION_PATH,
		"--extension",
		REASONING_EXCLUDE_EXTENSION_PATH,
		"--extension",
		SESSION_ID_EXTENSION_PATH,
		...(opts.serviceTier ? ["--extension", SERVICE_TIER_EXTENSION_PATH] : []),
		"--append-system-prompt",
		promptPath,
	];
	const invocation = getPiInvocation(args);
	const proc: ChildProcess = spawn(invocation.command, invocation.args, {
		cwd: opts.cwd,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			...(opts.serviceTier ? { PI_TASK_SERVICE_TIER: opts.serviceTier } : {}),
			...(opts.serviceTierExcludes?.length
				? { PI_TASK_SERVICE_TIER_EXCLUDES: opts.serviceTierExcludes.join(",") }
				: {}),
			...(opts.providerOnly?.length
				? { PI_TASK_PROVIDER_ONLY: opts.providerOnly.join(",") }
				: {}),
			// Session-id (wave-4): only when PI_TASK_ENABLE_SESSION_ID=1.
			...(process.env.PI_TASK_ENABLE_SESSION_ID === "1"
				? {
						PI_TASK_ENABLE_SESSION_ID: "1",
						...(opts.sessionId ? { PI_TASK_SESSION_ID: opts.sessionId } : {}),
					}
				: {}),
			// Reasoning-exclusion (wave-1): only when PI_TASK_ENABLE_REASONING_EXCLUDE=1.
			...(process.env.PI_TASK_ENABLE_REASONING_EXCLUDE === "1"
				? { PI_TASK_ENABLE_REASONING_EXCLUDE: "1" }
				: {}),
		},
	});

	const state = createWorkerEventState();
	let reportPayload: ReviewResult | null = null;
	let stderrOutput = "";
	// Idle watchdog (R2, mirrors spawnWorkerSession): settled-without-report
	// → nudge once, then fail. `aborted` guards the watchdog during abort.
	let nudged = false;
	let failed = false;
	let aborted = false;
	let wallTimer: NodeJS.Timeout | null = null;
	// No-progress watchdog + first-call fail-fast (todo #80): the reviewer's
	// first model call re-encodes the whole pruned fork context on an empty
	// prompt cache, and a wedged call emits ZERO RPC events — the idle
	// watchdog keys off agent_settled and never fires, so only the 20-min
	// wall would catch it. Two tighter bounds close that gap, in this order:
	//   first-call (REVIEW_FIRST_EVENT_TIMEOUT_MS)
	//     < no-progress (REVIEW_NO_PROGRESS_TIMEOUT_MS)
	//     < wall (REVIEW_WALL_TIMEOUT_MS).
	let lastActivityMs = Date.now();
	let toolCallDepth = 0;
	let firstEventArrived = false;
	// Failure diagnostics (todo #86): the cause recorded by whichever watchdog
	// fired first — the close handler produces the deterministic rejection.
	let failureCause: string | null = null;
	let noProgressTimer: NodeJS.Timeout | null = null;
	let noProgressFired = false;
	let firstEventTimer: NodeJS.Timeout | null = null;

	// The JSONL RPC stream is untyped at this seam (worker.ts exposes raw
	// events); narrow to the fields the reducer and report capture inspect.
	const processEvent = (raw: unknown): void => {
		const event = raw as {
			type?: string;
			toolName?: string;
			isError?: boolean;
			result?: { details?: unknown };
		};
		// Any RPC line on stdout counts as activity: resets the no-progress
		// watchdog's clock and satisfies the first-call fail-fast deadline.
		lastActivityMs = Date.now();
		if (!firstEventArrived) {
			firstEventArrived = true;
			if (firstEventTimer) {
				clearTimeout(firstEventTimer);
				firstEventTimer = null;
			}
		}
		// An in-flight tool execution counts as progress even when it streams
		// nothing (a long silent bash/test tool is legitimate); track depth.
		if (
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_end"
		) {
			toolCallDepth = Math.max(
				0,
				toolCallDepth + (event.type === "tool_execution_start" ? 1 : -1),
			);
		}
		// Reuse the worker reducer for usage accumulation (turns/tokens/cost).
		const { updates } = reduceWorkerEvent(state, event);
		for (const u of updates) opts.onUpdate?.(u);
		// Capture the structured report (pi already validated it).
		if (
			event.type === "tool_execution_end" &&
			event.toolName === "report_findings" &&
			!event.isError &&
			event.result?.details
		) {
			reportPayload = event.result.details as ReviewResult;
		}
		// Idle watchdog (R2): the reviewer settled without reporting — nudge
		// once with a report_findings reminder, then fail the review. Reuses
		// worker.ts's exported decideIdleAction + AGENT_SETTLED_EVENT.
		if (!aborted && !failed) {
			const action = decideIdleAction(
				event.type ?? "",
				reportPayload !== null,
				nudged,
			);
			if (action === "nudge") {
				nudged = true;
				try {
					proc.stdin!.write(
						JSON.stringify({
							type: "prompt",
							message: REVIEW_IDLE_NUDGE_PROMPT,
						}) + "\n",
					);
				} catch {
					// stdin may already be closed — the close handler reports the exit.
				}
			} else if (action === "fail") {
				failReview("reviewer ended without calling report_findings");
			}
		}
	};

	attachJsonlReader(proc.stdout!, processEvent);
	proc.stderr!.on("data", (d: Buffer) => (stderrOutput += d.toString()));

	let resolveOutcome!: (o: ReviewOutcome) => void;
	let rejectOutcome!: (e: Error) => void;
	const outcome = new Promise<ReviewOutcome>((resolve, reject) => {
		resolveOutcome = resolve;
		rejectOutcome = reject;
	});

	proc.on("close", (code) => {
		if (wallTimer) {
			clearTimeout(wallTimer);
			wallTimer = null;
		}
		if (noProgressTimer) {
			clearInterval(noProgressTimer);
			noProgressTimer = null;
		}
		if (firstEventTimer) {
			clearTimeout(firstEventTimer);
			firstEventTimer = null;
		}
		opts.signal?.removeEventListener("abort", onSignalAbort);
		cleanup();
		if (aborted) {
			// Deterministic abort rejection with diagnostics (todo #86) — the
			// close handler is the single rejection point for watchdog aborts.
			rejectOutcome(
				buildAbortError({
					code: null,
					cause: failureCause,
					turns: state.usage.turns,
					idleMs: Math.max(0, Date.now() - lastActivityMs),
					lastTool: null,
					stderrTail: stderrOutput.slice(-STDERR_TAIL_CHARS),
				}),
			);
			return;
		}
		const settled = settleReview(reportPayload, code ?? 1, stderrOutput);
		if (settled.ok)
			resolveOutcome({ result: settled.result, usage: state.usage });
		else rejectOutcome(settled.error);
	});
	proc.on("error", (err) => {
		if (wallTimer) {
			clearTimeout(wallTimer);
			wallTimer = null;
		}
		if (noProgressTimer) {
			clearInterval(noProgressTimer);
			noProgressTimer = null;
		}
		if (firstEventTimer) {
			clearTimeout(firstEventTimer);
			firstEventTimer = null;
		}
		opts.signal?.removeEventListener("abort", onSignalAbort);
		cleanup();
		rejectOutcome(new Error(`Failed to spawn reviewer: ${err.message}`));
	});

	// ─── Unified failure path (todo #86) ────────────────────────
	// Same contract as worker.ts's failWorker: record the cause, abort, and
	// let the close handler produce the single deterministic rejection with
	// diagnostics (the old direct rejects raced the close handler).
	const failReview = (cause: string): void => {
		failureCause = cause;
		failed = true;
		abort();
	};

	const abort = (): void => {
		aborted = true;
		try {
			proc.stdin!.write(JSON.stringify({ type: "abort" }) + "\n");
		} catch {
			/* stdin may be closed */
		}
		proc.kill("SIGTERM");
		// Gate the SIGKILL escalation on exitCode (not proc.killed, which is
		// true as soon as SIGTERM was sent) — same fix as worker.ts (R4).
		setTimeout(() => {
			if (proc.exitCode === null) proc.kill("SIGKILL");
		}, SIGKILL_DELAY_MS);
	};
	// Named handler so the close/error handlers can detach it (R7).
	const onSignalAbort = (): void => {
		abort();
	};
	if (opts.signal) {
		if (opts.signal.aborted) abort();
		else opts.signal.addEventListener("abort", onSignalAbort, { once: true });
	}

	// ─── Wall-clock timeout (R3) ─────────────────────────────────
	// Bounds the review the same way worker.ts bounds workers (a reviewer
	// that neither settles nor reports must not hang the orchestrator);
	// cleared on close/error (see the close handler above). Per-assessment:
	// every review fork carries its own budget (opt.wallTimeoutMs —
	// default REVIEW_WALL_TIMEOUT_MS), independent of the worker's wall.
	const wallTimeoutMs = opts.wallTimeoutMs ?? REVIEW_WALL_TIMEOUT_MS;
	wallTimer = setTimeout(() => {
		wallTimer = null;
		failReview(`Reviewer timed out after ${wallTimeoutMs} ms`);
	}, wallTimeoutMs);

	// Send the review prompt — the reviewer settles after report_findings
	// (terminate:true + ctx.shutdown() in the tool). Guard the write: an
	// unguarded throw (e.g. EPIPE) would surface as an unhandled error
	// instead of a precise spawn-write rejection (R8).
	try {
		proc.stdin!.write(
			JSON.stringify({ type: "prompt", message: buildReviewPrompt(opts) }) +
				"\n",
		);
	} catch (err) {
		proc.kill("SIGKILL");
		rejectOutcome(
			new Error(
				`Failed to write review prompt to reviewer: ${(err as Error).message}`,
			),
		);
		return outcome;
	}

	// ─── First-call fail-fast (R2) ─────────────────────────────
	// The dominant observed hang signature: ONE stalled first model call
	// (the fork re-encodes the pruned context on an empty prompt cache)
	// emitting zero RPC events. Any first event disarms this one-shot timer;
	// expiry aborts and rejects naming the stalled call — minutes, not the
	// 20-min wall. Cleared on close/error (see the close handler above).
	const firstEventTimeoutMs =
		opts.firstEventTimeoutMs ?? REVIEW_FIRST_EVENT_TIMEOUT_MS;
	const promptWrittenAtMs = Date.now();
	firstEventTimer = setTimeout(() => {
		firstEventTimer = null;
		if (
			decideFirstEventAction({
				nowMs: Date.now(),
				promptWrittenAtMs,
				deadlineMs: firstEventTimeoutMs,
				firstEventArrived,
			}) === "abort"
		) {
			failReview(
				firstEventTimeoutErrorMessage(firstEventTimeoutMs, wallTimeoutMs),
			);
		}
	}, firstEventTimeoutMs);

	// ─── No-progress watchdog (R1, todo #80) ───────────────────
	// Mirrors worker.ts's watchdog (todo #74) with a SHORTER window: a
	// reviewer is one fast model pass, not a 70-turn exploration. Any parsed
	// event resets the clock; an in-flight tool execution counts as progress
	// (a long silent bash/test tool is legitimate). Reuses worker.ts's
	// decideNoProgressAction (generic — fits the review path unchanged).
	const noProgressTimeoutMs =
		opts.noProgressTimeoutMs ?? REVIEW_NO_PROGRESS_TIMEOUT_MS;
	noProgressTimer = setInterval(() => {
		if (
			!noProgressFired &&
			!aborted &&
			!failed &&
			decideNoProgressAction({
				nowMs: Date.now(),
				lastActivityMs,
				timeoutMs: noProgressTimeoutMs,
				inToolCall: toolCallDepth > 0,
			}) === "abort"
		) {
			noProgressFired = true;
			if (noProgressTimer) clearInterval(noProgressTimer);
			noProgressTimer = null;
			failReview(
				reviewNoProgressErrorMessage(noProgressTimeoutMs, wallTimeoutMs),
			);
		}
	}, REVIEW_NO_PROGRESS_CHECK_INTERVAL_MS);

	return outcome;
}
