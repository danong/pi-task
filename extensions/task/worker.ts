/**
 * Worker runner — spawns a pi RPC session, sends a task, and receives
 * schema-validated typed output via the yield tool.
 *
 * Exposes a WorkerSession handle so callers can listen to events and
 * send commands mid-run (used by prewalk for the model swap). runWorker()
 * is a one-shot convenience wrapper over the session.
 *
 * No runtime dependency on the pi package. Uses only node builtins.
 * The yield tool extension runs inside the worker subprocess where pi
 * is available.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	writeFileSync,
	unlinkSync,
	rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { YieldPayload } from "./schemas/yield.ts";
import { wrapWorkerInvocation, type ResolvedSandbox } from "./sandbox.ts";
import {
	DEFAULT_TIER_WALL_TIMEOUT_MS,
	DEFAULT_TOOL_TIMEOUT_MS,
	aiIdentityToml,
} from "./config.ts";
import { formatDuration } from "./progress.ts";
export { formatDuration };

// ─── Types ───────────────────────────────────────────────────────────

export interface WorkerOptions {
	/** Working directory for the worker (must be a jj repo). */
	cwd: string;
	/** Model identifier, e.g. "openrouter/~deepseek/deepseek-v4-flash-latest". */
	model: string;
	/**
	 * OpenRouter service tier for this run (task.toml `[budget.*]
	 * service_tier` — "flex" | "priority"). Set → the spawn carries
	 * PI_TASK_SERVICE_TIER + the service-tier injection extension, so every
	 * provider call of this subprocess requests the tier. Unset → standard
	 * tier, extension not loaded. Flex never falls back server-side:
	 * capacity errors surface as typed failures — see
	 * spawnWorkerSessionResilient (exponential backoff retry).
	 */
	serviceTier?: string;
	/**
	 * Slim the subprocess system-prompt prefix (wave-2 cost): pass
	 * --no-skills to prune pi's injected skills-discovery list (~1.5-2k
	 * tokens per turn) the worker never uses. Default true. False → the
	 * flag is omitted so a worker runs with the verbose prefix.
	 */
	slimWorkerPrompt?: boolean;
	/** OpenRouter session correlation id (wave-4 cost): set → the spawn carries
	 *  PI_TASK_SESSION_ID so every provider call of this subprocess gets the
	 *  run id as a top-level session_id. Unset → the session-id extension
	 *  still loads but injects only pi's ambient session id (a no-op unless
	 *  one is present). */
	sessionId?: string;
	/**
	 * Model ids EXEMPT from serviceTier (comma-joined into
	 * PI_TASK_SERVICE_TIER_EXCLUDES): the cheap workhorse stays
	 * standard-priced inside a flex run — the tier applies only to the
	 * strong-model calls (prewalk). Unset → the tier applies to every call.
	 */
	serviceTierExcludes?: string[];
	/**
	 * OpenRouter endpoint slugs for provider.only (the flex pin) — set →
	 * PI_TASK_PROVIDER_ONLY env; the injection extension pins non-excluded
	 * models to these endpoints. Unset → default routing.
	 */
	providerOnly?: string[];
	/** The task prompt sent to the worker. */
	task: string;
	/** Worker system prompt (appended to pi's default). */
	systemPrompt?: string;
	/** Extra extension files to load in the worker (absolute paths). */
	extensions?: string[];
	/**
	 * AI commit identity (todo #84): when both are set, the worker's jj
	 * commits are authored as aiAuthorName / aiAuthorEmail (via a JJ_CONFIG
	 * env override pointing at a temp config file — see spawn). Unset =
	 * the worker commits with the ambient (user) identity. The orchestrator
	 * passes the FORMATTED name (the "{model}" placeholder already
	 * resolved) and the email from task.toml's [defaults].
	 */
	aiAuthorName?: string;
	aiAuthorEmail?: string;
	/**
	 * The project repo root for the sandbox's shared-jj-store bind (todo
	 * #89). Parallel runs: the workspace dir (cwd) differs from the project
	 * root, and workspace commits write into the project's shared store —
	 * the sandbox must bind it rw. Single runs: omit (cwd IS the project).
	 */
	projectDir?: string;
	/**
	 * Persist the session into this directory (for review forking) instead of
	 * running ephemeral (--no-session). The caller owns the directory's
	 * lifecycle — the worker does not delete it, because a forked reviewer
	 * needs the session file after the worker exits. Unset (default) =
	 * ephemeral session, zero overhead.
	 */
	sessionDir?: string;
	/** Abort signal — terminates the worker on abort. */
	signal?: AbortSignal;
	/**
	 * Wall-clock budget for the whole run (ms). Default:
	 * {@link WORKER_WALL_TIMEOUT_MS} (45 min). On expiry the worker is
	 * aborted and `result` rejects with a timeout error naming the limit.
	 * The task tool passes the resolved tier's wall_timeout_ms here
	 * (Phase 11, via ExecuteTaskOptions.workerTimeoutMs →
	 * selectWorkerWallTimeout); direct callers may override.
	 */
	timeoutMs?: number;
	/**
	 * Per-tool-call budget (ms, Phase 11): a single worker tool execution
	 * (tracked via tool_execution_start/end) that runs this long is aborted
	 * as hung — the bound the no-progress watchdog cannot see, because an
	 * in-flight tool counts as progress. Default:
	 * {@link WORKER_TOOL_TIMEOUT_MS} (15 min, [defaults] tool_timeout_ms).
	 */
	toolTimeoutMs?: number;
	/**
	 * The spec's verification commands (## Verification). When the wall
	 * clock expires while one of these is in flight, the worker gets a
	 * bounded grace (verificationTimeoutMs) so the suite can finish and the
	 * worker can yield a real verification result — the wall must not kill
	 * an in-flight verification (that produced the "merged unverified work"
	 * failure class). The grace is capped and ends early if the worker
	 * leaves the verification phase.
	 */
	verificationCommands?: string[];
	/** Grace cap (ms) for the in-flight-verification wall extension. Default:
	 *  {@link WORKER_VERIFICATION_GRACE_MS} (10 min). */
	verificationTimeoutMs?: number;
	/**
	 * No-progress window (ms): a worker that emits NO RPC activity for this
	 * long is aborted as hung (todo #74). Default:
	 * {@link WORKER_NO_PROGRESS_TIMEOUT_MS}. Independent of the wall
	 * timeout and the settle-based idle watchdog — this one catches a
	 * worker that emits nothing at all, fail-fast.
	 */
	noProgressTimeoutMs?: number;
	/** Progress callback (no LLM tokens burned). */
	onUpdate?: (partial: WorkerUpdate) => void;
	/**
	 * Resolved worker sandbox (R1: the orchestrator resolves it once per run
	 * via resolveSandbox). Present AND active → the pi spawn is wrapped in
	 * bwrap (sandbox.ts wrapWorkerInvocation); absent or inactive → the spawn
	 * is byte-for-byte unchanged. The worker never probes the host itself.
	 */
	sandbox?: ResolvedSandbox;
}

export interface WorkerUpdate {
	type: "turn" | "tool_start" | "tool_end" | "yield" | "capacity_backoff";
	turns?: number;
	toolName?: string;
	/** tool_start only: truncated argument summary (diagnostics). */
	args?: string;
	/** tool_end only: whether the tool call errored. Consumers key off the
	 *  first SUCCESSFUL edit/write (the same signal as the prewalk swap). */
	isError?: boolean;
	yieldPayload?: YieldPayload;
	/** capacity_backoff only: resilient-spawn retry bookkeeping. */
	attempt?: number;
	delayMs?: number;
	error?: string;
}

export interface WorkerUsage {
	turns: number;
	tokens_in: number;
	tokens_out: number;
	cache_read: number;
	cache_write: number;
	cost_usd: number;
	reads: number;
	edits: number;
}

/** A single file read by the worker (for read-duplication metrics). */
export interface ReadRecord {
	/** File path (undefined if the read's start event wasn't observed). */
	path: string | undefined;
	/** Estimated tokens in the read content (≈ chars / 4). */
	approxTokens: number;
	/** Assistant turn count when the read completed (0 = before any turn). */
	turn: number;
}

/** The settled core outcome (what {@link settleWorker} produces). */
export interface WorkerOutcome {
	yield: YieldPayload;
	usage: WorkerUsage;
	exitCode: number;
}

export interface WorkerResult extends WorkerOutcome {
	/**
	 * Persisted session file path — present only when the worker ran with a
	 * sessionDir (review forking). Captured via get_state during the run.
	 */
	sessionFile?: string;
	/** Per-file reads in event order (for read-duplication metrics). */
	reads: ReadRecord[];
	/** Cumulative usage snapshot after each assistant turn (prewalk/execute split). */
	turnUsage: WorkerUsage[];
}

/** A live worker subprocess handle. */
export interface WorkerSession {
	/** Register an event listener (raw RPC events). Returns unsubscribe. */
	onEvent(listener: (event: unknown) => void): () => void;
	/** Write an RPC command to the worker's stdin (fire-and-forget). */
	sendCommand(command: Record<string, unknown>): void;
	/** Send an RPC command and await its correlated response (matched by id).
	 *  Untyped: callers narrow the response payload themselves. */
	request(command: Record<string, unknown>): Promise<unknown>;
	/**
	 * Switch the worker model: "provider/model-id" → set_model command.
	 * Resolves with the set_model response; REJECTS on failure (e.g. unknown
	 * model) — callers must surface the failure rather than let the run
	 * silently continue on the old model.
	 */
	setModel(model: string): Promise<unknown>;
	/** Resolves with the typed result when the worker finishes. */
	result: Promise<WorkerResult>;
	/** Terminate the worker (abort command → SIGTERM → SIGKILL). */
	abort(): void;
}

// ─── Constants ───────────────────────────────────────────────────────

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const YIELD_EXTENSION_PATH = join(THIS_DIR, "tools", "yield.ts");
/** Absolute path to the worker-side checklist extension (always loaded). */
export const CHECKLIST_EXTENSION_PATH = join(THIS_DIR, "tools", "checklist.ts");
/** Tool guard (Phase 2): bash timeout cap + root-scoped search block.
 *  Enforcement for EVERY worker/reviewer, whatever its prompt says. */
export const TOOL_GUARD_EXTENSION_PATH = join(
	THIS_DIR,
	"tools",
	"tool-guard.ts",
);
/** dispute_verification: the worker's structured challenge against a
 *  defective verification command (engine-adjudicated, never unilateral). */
export const DISPUTE_EXTENSION_PATH = join(THIS_DIR, "tools", "dispute.ts");
/** Reasoning-exclusion (wave-1 cost): injects reasoning:false into every
 *  provider payload when PI_TASK_ENABLE_REASONING_EXCLUDE=1 — the model still
 *  reasons at its budget but the transcript stops accreting the
 *  reasoning_details blobs. Loaded on every worker/reviewer (no-op without
 *  the enable flag). */
export const REASONING_EXCLUDE_EXTENSION_PATH = join(
	THIS_DIR,
	"tools",
	"reasoning-exclude.ts",
);
/** Service-tier injection extension — loaded only when the run's tier
 *  declares one (the extension is a no-op without the env var anyway, but
 *  skipping the load keeps ordinary runs extension-count-stable). */
export const SERVICE_TIER_EXTENSION_PATH = join(
	THIS_DIR,
	"tools",
	"service-tier.ts",
);
/** Session-id injection extension (wave-4 cost) — always loaded; it is a no-op
 *  unless PI_TASK_ENABLE_SESSION_ID=1 and an identifier is present
 *  (the run's session id via env, or pi's own ambient session id), so
 *  ordinary runs pay nothing. */
export const SESSION_ID_EXTENSION_PATH = join(
	THIS_DIR,
	"tools",
	"session-id.ts",
);
const SIGKILL_DELAY_MS = 5000;

/** Default wall-clock budget for a worker run (45 min) — mirrors the config
 *  default tier wall (config.ts DEFAULT_TIER_WALL_TIMEOUT_MS). See
 *  WorkerOptions.timeoutMs and selectWorkerWallTimeout. */
export const WORKER_WALL_TIMEOUT_MS = DEFAULT_TIER_WALL_TIMEOUT_MS;

/** Default per-tool-call budget for a single worker tool execution (15 min,
 *  Phase 11) — mirrors [defaults] tool_timeout_ms (config.ts
 *  DEFAULT_TOOL_TIMEOUT_MS). See WorkerOptions.toolTimeoutMs. */
export const WORKER_TOOL_TIMEOUT_MS = DEFAULT_TOOL_TIMEOUT_MS;

/** Poll interval for the tool-call timeout watchdog (finer than the
 *  no-progress poll: a hung tool must be aborted close to its bound). */
const TOOL_TIMEOUT_CHECK_INTERVAL_MS = 10_000;

/**
 * Default wall-clock grace for an in-flight verification (10 min — the
 * worker wall may not kill a verification that is about to finish; the
 * per-command verification timeout bounds each command, this bounds the
 * whole extension). Mirrors the orchestrator's DEFAULT_VERIFICATION_
 * TIMEOUT_MS fallback; the task tool passes [defaults]
 * verification_timeout_ms instead.
 */
export const WORKER_VERIFICATION_GRACE_MS = 10 * 60 * 1000;

/**
 * True when a worker tool invocation matches one of the spec's
 * verification commands. Lenient prefix/suffix matching covers the
 * common wrappers ("cd … && <cmd>", "timeout 300 <cmd>", …); the exact
 * string also matches. Pure — tested hermetically.
 */
export function isVerificationCommand(
	args: string,
	commands: string[],
): boolean {
	const a = args.trim();
	return commands.some((cmd) => {
		const c = cmd.trim();
		return a === c || a.endsWith(c) || a.startsWith(c);
	});
}

/**
 * Pure wall-grace decision for the worker watchdog. The wall expiry
 * aborts the worker UNLESS it is mid-verification (in flight) — then it
 * continues until the grace is exhausted or the worker leaves the
 * verification phase (starts a non-verification tool). Returns "abort"
 * or "continue".
 */
export function decideWallGraceAction(opts: {
	/** Wall already expired (grace active). */
	wallExpired: boolean;
	/** now - wallExpiredAt >= graceMs. */
	graceExhausted: boolean;
	/** A verification command is currently in flight. */
	verificationInFlight: boolean;
	/** Newly started tool is a verification command; null when no new tool. */
	newToolIsVerification: boolean | null;
}): "abort" | "continue" {
	if (!opts.wallExpired) return "continue";
	if (opts.graceExhausted) return "abort";
	// The worker left the verification phase after the wall expired — it
	// would keep burning budget on new work; the grace was only for the
	// suite to finish.
	if (opts.newToolIsVerification === false) return "abort";
	if (!opts.verificationInFlight) return "abort";
	return "continue";
}

/**
 * Default no-progress window (10 min — much shorter than the wall): a
 * worker that emits NO RPC activity — no turn, no tool call, no event of
 * any kind — for this long is aborted as hung (todo #74). The settle-based
 * idle watchdog keys off `agent_settled` and never fires for a worker that
 * emits nothing at all; this watchdog closes that gap, fail-fast. Any RPC
 * event resets the clock and an in-flight tool execution counts as
 * progress (a long-running bash/test tool may legitimately stream
 * nothing). Overridable via WorkerOptions.noProgressTimeoutMs.
 */
export const WORKER_NO_PROGRESS_TIMEOUT_MS = 10 * 60_000;

/** Poll interval for the no-progress watchdog (cheap; events reset the clock). */
const NO_PROGRESS_CHECK_INTERVAL_MS = 30_000;

/**
 * RPC event type emitted when the agent run is fully settled — no automatic
 * retry, compaction retry, or queued continuation remains (docs/rpc.md).
 * RPC sessions stay alive waiting for commands after settling, so a worker
 * that settles without calling yield() would otherwise hang the orchestrator
 * forever; the idle watchdog (R1) keys off this event.
 */
export const AGENT_SETTLED_EVENT = "agent_settled";

/** Follow-up prompt nudging a settled worker that forgot to call yield(). */
const WORKER_IDLE_NUDGE_PROMPT =
	"Your task turn ended without calling yield(). Call yield() now with your typed result — the run cannot complete without it.";

/**
 * The exact failure cause for a worker that settled twice without calling
 * yield() (idle watchdog). Exported so the orchestrator can recognize this
 * failure class and salvage a verified tree instead of hard-failing — the
 * work is often already done (the failure is purely a completion-signal
 * gap, seen on weak models that end turns with prose).
 */
export const NO_YIELD_FAILURE = "worker ended without calling yield";

/**
 * The worker system prompt (design doc: minimal, ~150 tokens). Behavior is
 * enforced by tools, not prose — this only orients the worker. Callers can
 * override via WorkerOptions.systemPrompt.
 *
 * WAVE-1 (cost): the checklist line is TIER-CONTROLLED — buildWorkerSystemPrompt(false)
 * drops it (the checklist tool is not loaded on cheap tiers). The exported
 * DEFAULT_WORKER_SYSTEM_PROMPT is the checklist-enabled variant (back-compat).
 */
const WORKER_SYSTEM_PROMPT_BASE = `You are implementing a coding task. Explore the codebase, make changes,
and call yield() when complete.

TERMINATION RULE: never end a turn with plain prose. Every turn must end by
calling a tool; when all requirements are met and verification passes, call
yield() — a turn that ends without a tool call fails the run.

Make atomic jj commits as you complete each requirement.
Run verification commands after your changes.
When the project has tests, work test-first: write a failing test, verify it fails, then implement until it passes (red-green-refactor).
Write scratch/debug probes under /tmp, never in the repo — check jj file list before yielding so no debug files are tracked.

Efficiency — make every tool call count:
- Batch independent tool calls into one turn; never run sequential calls you could run together.
- Never dump large outputs: truncate bash (head/tail/grep, head -c ~2000), never cat whole files or logs.
- Never re-run an identical command; re-derive with a smaller query if you lost context.
- Run the full test suite at most twice (after your changes and before yield); use targeted files otherwise.
- Each turn must visibly advance the task — finish in the fewest turns you can.

Your first edit should be your most confident change.`;

/** Pure: the worker system prompt with (or without) the checklist mandate. */
export function buildWorkerSystemPrompt(useChecklist: boolean): string {
	return useChecklist
		? `${WORKER_SYSTEM_PROMPT_BASE}\n\nUse checklist() to track your progress through requirements.`
		: WORKER_SYSTEM_PROMPT_BASE;
}

export const DEFAULT_WORKER_SYSTEM_PROMPT = buildWorkerSystemPrompt(true);

// ─── Helpers ─────────────────────────────────────────────────────────

/** Split "provider/model-id" into { provider, modelId }. */
export function splitModel(model: string): {
	provider: string;
	modelId: string;
} {
	const slash = model.indexOf("/");
	if (slash === -1) {
		throw new Error(`Invalid model "${model}": expected "provider/model-id"`);
	}
	return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

/**
 * Resolve how to invoke pi.
 * Handles: direct pi binary, node/bun running a script, custom runtimes.
 * Exported so other modules (repo-map annotation) can spawn pi too.
 */
export function getPiInvocation(args: string[]): {
	command: string;
	args: string[];
} {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	// Only reuse the current script if it IS pi (running inside a pi process).
	// Standalone scripts (tests, CLI tools) fall through to "pi".
	const isPiScript =
		currentScript?.includes("pi-coding-agent") ||
		basename(currentScript ?? "") === "pi";
	if (
		currentScript &&
		!isBunVirtualScript &&
		isPiScript &&
		existsSync(currentScript)
	) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

// ─── Idle watchdog decision (pure) ────────────────────────────────────

/**
 * Idle-watchdog decision (pure): given an RPC event type and whether the
 * worker's payload (yield / report_findings) has been captured, decide the
 * next action. An `agent_settled` event with no payload means the agent
 * finished but never reported — the first occurrence nudges the worker with
 * a follow-up prompt; a second settle with still no payload fails the run.
 * Any other event type, or a captured payload, is a no-op (null).
 */
export function decideIdleAction(
	eventType: string,
	hasPayload: boolean,
	alreadyNudged: boolean,
): "nudge" | "fail" | null {
	if (eventType !== AGENT_SETTLED_EVENT) return null;
	if (hasPayload) return null;
	return alreadyNudged ? "fail" : "nudge";
}

/**
 * No-progress watchdog decision (pure, todo #74): abort when the worker
 * has emitted NO RPC activity for the full window. Any event (turn, tool
 * call, streamed update) resets `lastActivityMs`; an in-flight tool
 * execution (`inToolCall`) also counts as progress — a long-running
 * bash/test tool may legitimately stream nothing, so only a worker that is
 * idle BETWEEN tool calls can be deemed hung. Hermetically tested.
 */
export function decideNoProgressAction(opts: {
	nowMs: number;
	lastActivityMs: number;
	timeoutMs: number;
	inToolCall: boolean;
}): "abort" | null {
	if (opts.inToolCall) return null;
	return opts.nowMs - opts.lastActivityMs >= opts.timeoutMs ? "abort" : null;
}

/**
 * Tool-call timeout decision (pure, Phase 11 — R4): abort when a single
 * tool execution has been in flight for the full per-tool budget. This is
 * the bound the no-progress watchdog cannot see — an in-flight tool counts
 * as progress by design (see decideNoProgressAction), so only this watchdog
 * catches a tool that never returns (e.g. a hung bash/test command). The
 * caller feeds the OLDEST in-flight tool's start time; the wall fires while
 * toolCallDepth > 0 by construction (a non-empty tool stack).
 * Hermetically tested.
 */
export function decideToolTimeoutAction(opts: {
	nowMs: number;
	startedAtMs: number;
	timeoutMs: number;
}): "abort" | null {
	return opts.nowMs - opts.startedAtMs >= opts.timeoutMs ? "abort" : null;
}

/**
 * Rejection message when a single tool execution exceeds its per-tool-call
 * budget (Phase 11 — R4): names the tool and its truncated arguments, and
 * why the no-progress watchdog could not catch it. Pure — hermetically
 * tested so stuck runs surface precisely, not generically.
 */
export function toolTimeoutErrorMessage(
	timeoutMs: number,
	toolName: string,
	toolArgs: string,
): string {
	return (
		`Worker aborted: tool "${toolName}" exceeded the per-tool-call budget of ` +
		`${formatDuration(timeoutMs)} (${timeoutMs} ms) — a hung tool the no-progress ` +
		`watchdog cannot see (in-flight tool calls count as progress). ` +
		`Tool call: ${toolName}(${toolArgs})`
	);
}

/**
 * The worker's wall-clock budget (Phase 11 — R5): the resolved tier's
 * wall_timeout_ms when given, else the built-in WORKER_WALL_TIMEOUT_MS
 * (45 min). Pure — hermetically tested. The orchestrator passes the
 * resolved tier's wall via WorkerOptions.timeoutMs.
 */
export function selectWorkerWallTimeout(
	tierWallTimeoutMs: number | undefined,
): number {
	return tierWallTimeoutMs ?? WORKER_WALL_TIMEOUT_MS;
}

/**
 * Rejection message when the no-progress watchdog aborts a hung worker
 * (todo #74): names the CAUSE (no activity observed) and the window in
 * human-readable form, plus the wall limit for context. Pure — the content
 * is hermetically tested so stuck runs surface precisely, not generically.
 */
export function noProgressErrorMessage(
	windowMs: number,
	wallTimeoutMs: number,
): string {
	return (
		`Worker aborted: no progress — no RPC activity (turns, tool calls, or events) ` +
		`observed for ${formatDuration(windowMs)} (${windowMs} ms); wall limit is ` +
		`${formatDuration(wallTimeoutMs)}. The worker appears hung and was killed to ` +
		`avoid burning the whole budget.`
	);
}

/**
 * Rejection message when the worker hits its wall-clock budget: names the
 * CAUSE (wall-timeout) and the limit in human-readable form. Pure — tested.
 */
export function wallTimeoutErrorMessage(timeoutMs: number): string {
	return (
		`Worker wall-timeout: the run reached its full wall-clock budget of ` +
		`${formatDuration(timeoutMs)} (${timeoutMs} ms) without finishing.`
	);
}

// ─── Failure diagnostics (todo #86) ──────────────────────────────────

/** Chars of stderr kept in failure diagnostics. */
export const STDERR_TAIL_CHARS = 2048;

/**
 * Truncate a tool call's arguments for diagnostics (~150 chars). Pure.
 */
export function summarizeToolArgs(args: unknown): string {
	if (args === undefined) return "";
	let s: string;
	if (typeof args === "string") s = args;
	else {
		try {
			s = JSON.stringify(args);
		} catch {
			// Non-stringifyable value (e.g. a cyclic structure): fall back to the
			// default Object stringification (no-base-to-string).
			s = Object.prototype.toString.call(args);
		}
	}
	return s.length > 150 ? `${s.slice(0, 147)}...` : s;
}

export interface WorkerFailureDiagnostics {
	/** Human-readable cause line (the message's first section). */
	cause: string;
	/**
	 * Structured failure identity — the contract consumers must match on
	 * (architecture-review candidate 1): the message is multi-line and
	 * decorative, so string-matching it is how the no-yield salvage went
	 * silently dead. Null = external/generic abort (no watchdog fired).
	 */
	code: WorkerFailureCode | null;
	turns: number;
	idleMs: number;
	lastTool: { name: string; args: string } | null;
	stderrTail: string;
}

/**
 * The watchdog failure classes a worker run can die of. Consumers
 * (orchestrator salvage/artifacts) switch on this union instead of
 * matching cause text — adding a class is a compile-guided change.
 */
export type WorkerFailureCode =
	"no_yield" | "wall_timeout" | "no_progress" | "tool_timeout";

/**
 * The failure message a worker abort produces (todo #86): the cause line
 * plus the worker's final state — turns, idle time, the last tool call,
 * and the stderr tail. Pure — hermetically tested.
 */
export function workerFailureMessage(d: WorkerFailureDiagnostics): string {
	const parts = [
		d.cause,
		`turns: ${d.turns} | idle: ${formatDuration(d.idleMs)}`,
	];
	if (d.lastTool)
		parts.push(`last tool: ${d.lastTool.name}(${d.lastTool.args})`);
	if (d.stderrTail.trim())
		parts.push(`stderr (last ${STDERR_TAIL_CHARS} chars):\n${d.stderrTail}`);
	return parts.join("\n");
}

/**
 * Build the abort rejection: the message plus a structured `diagnostics`
 * property the orchestrator reads for the failure artifact (todo #86).
 * `code` is the structured identity (null = generic/external abort); the
 * cause is display text only.
 */
export function buildAbortError(
	opts: Omit<WorkerFailureDiagnostics, "cause" | "code"> & {
		code: WorkerFailureCode | null;
		cause: string | null;
	},
): Error {
	const diagnostics: WorkerFailureDiagnostics = {
		cause: opts.cause ?? "Worker was aborted",
		code: opts.code,
		turns: opts.turns,
		idleMs: opts.idleMs,
		lastTool: opts.lastTool,
		stderrTail: opts.stderrTail,
	};
	const err = new Error(workerFailureMessage(diagnostics));
	(err as unknown as { diagnostics: WorkerFailureDiagnostics }).diagnostics =
		diagnostics;
	return err;
}

// ─── Event reducer (pure) ─────────────────────────────────────────────

/**
 * Accumulated worker-event state: usage counters, the captured yield
 * payload, per-file reads, and per-turn usage snapshots. Feed it through
 * {@link reduceWorkerEvent} as RPC events arrive; settle the outcome with
 * {@link settleWorker} when the process closes.
 *
 * Exported so tests can drive the reducer with synthetic events — the
 * observable behavior is identical to the pre-extraction processEvent
 * closure inside spawnWorkerSession.
 */
export interface WorkerEventState {
	usage: WorkerUsage;
	yieldPayload: YieldPayload | null;
	/** Per-file reads in event order (Phase 8 read-duplication metric). */
	reads: ReadRecord[];
	/** Cumulative usage snapshot after each assistant turn (phase split). */
	turnUsage: WorkerUsage[];
	/** Transient: read toolCallId → path, correlating start → end events. */
	pendingReadPaths: Map<string, string>;
}

/** Zeroed initial state (identical to what spawnWorkerSession used). */
export function createWorkerEventState(): WorkerEventState {
	return {
		usage: {
			turns: 0,
			tokens_in: 0,
			tokens_out: 0,
			cache_read: 0,
			cache_write: 0,
			cost_usd: 0,
			reads: 0,
			edits: 0,
		},
		yieldPayload: null,
		reads: [],
		turnUsage: [],
		pendingReadPaths: new Map(),
	};
}

/**
 * Estimate the token count of a read tool result from its text content
 * (≈ 4 chars per token). Sums text blocks; ignores non-text (e.g. images).
 * Exported for tests.
 */
export function estimateReadTokens(result: unknown): number {
	const content = (result as { content?: unknown })?.content;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		const b = block as { type?: string; text?: unknown };
		if (b?.type === "text" && typeof b.text === "string")
			chars += b.text.length;
	}
	return Math.ceil(chars / 4);
}

/**
 * Reduce one raw RPC event into worker state + the onUpdate events it
 * produces (if any). Mutates and returns `state`; `updates` are dispatched
 * to the caller's onUpdate callback — pure function of (state, event).
 */
export function reduceWorkerEvent(
	state: WorkerEventState,
	event: unknown,
): { state: WorkerEventState; updates: WorkerUpdate[] } {
	const updates: WorkerUpdate[] = [];
	const { usage } = state;
	// The RPC stream is untyped at this seam; narrow to the fields the
	// reducer branches on (runtime shape comes from pi's event emitter).
	const ev = event as {
		type: string;
		message?: {
			role?: string;
			usage?: {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				cost?: { total?: number };
			};
		};
		toolName?: unknown;
		toolCallId?: unknown;
		args?: { path?: unknown };
		result?: { details?: unknown };
		isError?: boolean;
	};

	switch (ev.type) {
		case "message_end": {
			const msg = ev.message;
			if (msg?.role === "assistant") {
				usage.turns++;
				if (msg.usage) {
					usage.tokens_in += msg.usage.input || 0;
					usage.tokens_out += msg.usage.output || 0;
					usage.cache_read += msg.usage.cacheRead || 0;
					usage.cache_write += msg.usage.cacheWrite || 0;
					usage.cost_usd += msg.usage.cost?.total || 0;
				}
				// Cumulative usage snapshot after this turn (prewalk/execute split).
				state.turnUsage.push({ ...usage });
				updates.push({ type: "turn", turns: usage.turns });
			}
			break;
		}

		case "tool_execution_start": {
			// Track read paths (correlated by toolCallId) for read-duplication.
			if (
				ev.toolName === "read" &&
				typeof ev.toolCallId === "string" &&
				typeof ev.args?.path === "string"
			) {
				state.pendingReadPaths.set(ev.toolCallId, ev.args.path);
			}
			updates.push({
				type: "tool_start",
				...(typeof ev.toolName === "string" && {
					toolName: ev.toolName,
				}),
				args: summarizeToolArgs(ev.args),
			});
			break;
		}

		case "tool_execution_end": {
			const toolName = ev.toolName as string;

			// Count reads and edits; record per-file reads for the duplication metric.
			if (toolName === "read") {
				usage.reads++;
				const callId =
					typeof ev.toolCallId === "string" ? ev.toolCallId : undefined;
				const path = callId ? state.pendingReadPaths.get(callId) : undefined;
				if (callId) state.pendingReadPaths.delete(callId);
				state.reads.push({
					path,
					approxTokens: estimateReadTokens(ev.result),
					turn: usage.turns,
				});
			}
			if (toolName === "edit" || toolName === "write") usage.edits++;

			// Capture yield payload
			if (toolName === "yield" && !ev.isError && ev.result?.details) {
				state.yieldPayload = ev.result.details as YieldPayload;
				updates.push({ type: "yield", yieldPayload: state.yieldPayload });
			}

			updates.push({
				type: "tool_end",
				toolName,
				isError: ev.isError === true,
			});
			break;
		}

		default:
			break;
	}

	return { state, updates };
}

/**
 * Settle the worker outcome on process close. Three branches, matching
 * the pre-extraction close handler exactly:
 * - yielded → ok with the typed result (exitCode defaults to 1 when null);
 * - aborted without yield → "Worker was aborted";
 * - exited without yield → error with exit code + first 500 chars of stderr.
 */
export function settleWorker(
	state: WorkerEventState,
	exitCode: number,
	wasAborted: boolean,
	stderr: string,
): { ok: true; result: WorkerOutcome } | { ok: false; error: Error } {
	if (state.yieldPayload) {
		return {
			ok: true,
			result: { yield: state.yieldPayload, usage: state.usage, exitCode },
		};
	}
	if (wasAborted) {
		return { ok: false, error: new Error("Worker was aborted") };
	}
	const detail = stderr.trim() ? `\nstderr: ${stderr.slice(0, 500)}` : "";
	return {
		ok: false,
		error: new Error(
			`Worker exited (code ${exitCode}) without yielding a result.${detail}`,
		),
	};
}

// ─── JSONL parser ────────────────────────────────────────────────────

/**
 * Attach a JSONL reader to a stream. Splits on \n only, strips trailing \r.
 * Does NOT use readline (it splits on U+2028/U+2029 which corrupt JSON).
 * Exported so tests can feed an in-process Readable (no subprocess).
 */
export function attachJsonlReader(
	stream: NodeJS.ReadableStream,
	onLine: (parsed: unknown) => void,
): void {
	let buffer = "";

	stream.on("data", (chunk: Buffer | string) => {
		buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");

		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) break;

			let line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line) continue;

			try {
				onLine(JSON.parse(line));
			} catch {
				// Non-JSON line (e.g. debug output) — skip silently
			}
		}
	});

	stream.on("end", () => {
		if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1);
		if (buffer.trim()) {
			try {
				onLine(JSON.parse(buffer));
			} catch {
				// Ignore trailing non-JSON
			}
		}
	});
}

/**
 * Build the pi CLI args for a worker session (pure — extracted for tests).
 * With `sessionDir` the session is persisted for review forking (the caller
 * owns the directory); without it the session is ephemeral (--no-session),
 * the default zero-overhead path. The yield extension is always loaded.
 */
export function buildWorkerArgs(opts: {
	model: string;
	sessionDir?: string;
	extensions?: string[];
	systemPromptPath?: string;
	/** When set, load the service-tier injection extension. */
	serviceTier?: string;
	/**
	 * Prune pi's injected skills-discovery list from the subprocess system
	 * prompt: pass --no-skills (wave-2 cost). Default true. False → the flag
	 * is omitted so the verbose prefix returns.
	 */
	slimWorkerPrompt?: boolean;
}): string[] {
	// --no-extensions: workers must run with ONLY the explicitly-passed
	// extensions (yield + checklist/prewalk). Without it, pi auto-discovers
	// global extensions — after deploy that includes task/index.ts itself,
	// which would register the recursive `task` tool in workers and fire the
	// session-start map refresh per worker. Explicit --extension paths still
	// load with discovery disabled.
	// --no-skills (wave-2 cost, [defaults] slim_worker_prompt): pi injects a
	// skills-discovery list (~1.5-2k tokens) into the system prompt; a worker
	// explores on its own and never uses it. Prune it here. Explicit --skill
	// paths would still load, but we pass none.
	const args: string[] = [
		"--mode",
		"rpc",
		"--model",
		opts.model,
		"--no-extensions",
		"--no-skills",
		"--extension",
		YIELD_EXTENSION_PATH,
		"--extension",
		TOOL_GUARD_EXTENSION_PATH,
		"--extension",
		DISPUTE_EXTENSION_PATH,
		"--extension",
		REASONING_EXCLUDE_EXTENSION_PATH,
		"--extension",
		SESSION_ID_EXTENSION_PATH,
	];
	if (opts.slimWorkerPrompt === false) {
		const i = args.indexOf("--no-skills");
		if (i !== -1) args.splice(i, 1);
	}

	if (opts.serviceTier) args.push("--extension", SERVICE_TIER_EXTENSION_PATH);
	for (const ext of opts.extensions ?? []) {
		args.push("--extension", ext);
	}
	if (opts.sessionDir) {
		args.push("--session-dir", opts.sessionDir);
	} else {
		args.push("--no-session");
	}
	if (opts.systemPromptPath) {
		args.push("--append-system-prompt", opts.systemPromptPath);
	}
	return args;
}

// ─── Session ─────────────────────────────────────────────────────────

export function spawnWorkerSession(opts: WorkerOptions): WorkerSession {
	const {
		cwd,
		model,
		task,
		systemPrompt,
		extensions,
		sessionDir,
		signal,
		onUpdate,
	} = opts;

	// Write system prompt to temp file (pi reads file contents when the
	// --append-system-prompt arg is a path to an existing file).
	let tmpDir: string | null = null;
	let tmpPromptPath: string | null = null;
	if (systemPrompt) {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-task-worker-"));
		tmpPromptPath = join(tmpDir, "system-prompt.md");
		writeFileSync(tmpPromptPath, systemPrompt, "utf-8");
	}

	// AI commit identity (todo #84): write a jj config with the identity and
	// point JJ_CONFIG at it, so the worker's `jj commit` calls author its
	// commits as the AI ("Pi (<model>)"), never as the user. The file lives
	// in tmpDir — already bound into the bwrap sandbox (tempDirs), so it
	// stays visible despite the tmpfs /tmp. The user's own jj/git sessions
	// are unaffected (the override is this spawn's env only).
	let identityConfigPath: string | null = null;
	if (opts.aiAuthorName && opts.aiAuthorEmail) {
		if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), "pi-task-worker-"));
		identityConfigPath = join(tmpDir, "jj-identity.toml");
		writeFileSync(
			identityConfigPath,
			aiIdentityToml(opts.aiAuthorName, opts.aiAuthorEmail),
			"utf-8",
		);
	}

	// Build CLI args (pure helper). sessionDir persists the session for
	// review forking; otherwise the session is ephemeral (--no-session).
	// Optional props are spread conditionally: exactOptionalPropertyTypes
	// forbids assigning `undefined` explicitly.
	const args = buildWorkerArgs({
		model,
		...(sessionDir !== undefined && { sessionDir }),
		...(extensions !== undefined && { extensions }),
		...(tmpPromptPath !== null && { systemPromptPath: tmpPromptPath }),
		...(opts.serviceTier !== undefined && { serviceTier: opts.serviceTier }),
		...(opts.slimWorkerPrompt !== undefined && {
			slimWorkerPrompt: opts.slimWorkerPrompt,
		}),
	});

	const invocation = getPiInvocation(args);
	// R2: sandbox wrapping — a pure decision (sandbox.ts wrapWorkerInvocation,
	// hermetically tested). Active → the spawn becomes `bwrap <args> --
	// <invocation>`; absent/inactive → the SAME invocation object is returned,
	// so the disabled/unavailable path is byte-for-byte unchanged. The stdio
	// pipes (worker RPC over stdin/stdout) pass through bwrap untouched: bwrap
	// execs the wrapped invocation on its own inherited stdio. Orchestrator
	// temp dirs must be bound back into the namespace (--tmpfs /tmp shadows
	// the OS tmpdir they live under): the system-prompt dir and, when
	// present, the session dir.
	const tempDirs = [
		...(tmpDir ? [tmpDir] : []),
		...(sessionDir ? [sessionDir] : []),
	];
	const wrapped = wrapWorkerInvocation({
		sandbox: opts.sandbox,
		cwd: resolve(cwd),
		// The real agent dir (pi's getAgentDir, not the package root) — bound
		// ro except the runtime-state paths, so workers write jj commits
		// through the agent dir's repo config and the checklist/yield tools
		// (which live in this package) resolve for the worker's pi.
		agentDir: getAgentDir(),
		tempDirs,
		...(opts.projectDir !== undefined && {
			projectDir: resolve(opts.projectDir),
		}),
		invocation,
	});
	const proc: ChildProcess = spawn(wrapped.command, wrapped.args, {
		cwd,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			// AI commit identity (todo #84): the worker's jj reads this config
			// for author+committer; the user's own sessions are untouched.
			...(identityConfigPath ? { JJ_CONFIG: identityConfigPath } : {}),
			// Service tier (flex infra): the service-tier extension reads this
			// and injects service_tier into every provider payload.
			...(opts.serviceTier ? { PI_TASK_SERVICE_TIER: opts.serviceTier } : {}),
			...(opts.serviceTierExcludes?.length
				? { PI_TASK_SERVICE_TIER_EXCLUDES: opts.serviceTierExcludes.join(",") }
				: {}),
			...(opts.providerOnly?.length
				? { PI_TASK_PROVIDER_ONLY: opts.providerOnly.join(",") }
				: {}),
			// Session-id (wave-4 cost): only when PI_TASK_ENABLE_SESSION_ID=1 —
			// disabled by default, no injection otherwise (including interactive).
			...(process.env.PI_TASK_ENABLE_SESSION_ID === "1"
				? {
						PI_TASK_ENABLE_SESSION_ID: "1",
						...(opts.sessionId ? { PI_TASK_SESSION_ID: opts.sessionId } : {}),
					}
				: {}),
			// Reasoning-exclusion (wave-1 cost): only when
			// PI_TASK_ENABLE_REASONING_EXCLUDE=1 — disabled by default.
			...(process.env.PI_TASK_ENABLE_REASONING_EXCLUDE === "1"
				? { PI_TASK_ENABLE_REASONING_EXCLUDE: "1" }
				: {}),
		},
	});

	// ─── State ───────────────────────────────────────────────────
	const listeners = new Set<(event: unknown) => void>();
	const state = createWorkerEventState();
	let wasAborted = false;
	let stderrOutput = "";
	// Idle watchdog (R1): settled-without-yield → nudge once, then fail.
	let nudged = false;
	let failed = false;
	// Wall-clock budget (R3, Phase 11: per-tier wall), cleared on close/error.
	let wallTimer: NodeJS.Timeout | null = null;
	// No-progress watchdog (R1, todo #74): last observed activity + in-flight
	// tool depth + fired flag, polled by a cheap interval (events reset).
	let lastActivityMs = Date.now();
	let toolCallDepth = 0;
	let noProgressTimer: NodeJS.Timeout | null = null;
	let noProgressFired = false;
	// Tool-call timeout (Phase 11, R4): stack of in-flight tool executions
	// (name/args/startMs, pushed on tool_execution_start, popped on end) —
	// the OLDEST entry is the one the tool-timeout watchdog bounds. A hung
	// tool is invisible to the no-progress watchdog (an in-flight tool
	// counts as progress), so this watchdog is the bound for a tool that
	// never returns.
	const toolStack: Array<{ name: string; args: string; startMs: number }> = [];
	let toolTimeoutTimer: NodeJS.Timeout | null = null;
	let toolTimeoutFired = false;
	// Failure diagnostics (todo #86): the cause recorded by whichever watchdog
	// fired first, plus the last observed tool call for the abort message.
	let failureCause: string | null = null;
	let failureCode: WorkerFailureCode | null = null;
	let lastTool: { name: string; args: string } | null = null;

	// Request/response correlation for RPC commands (e.g. get_state, used to
	// capture the persisted session file). Responses are routed to `pending`
	// in processEvent before the reducer; everything else is an agent event.
	// Track timer handles alongside the pending requests so close can reject
	// them AND clear their timers (R7 — no orphaned 30s timers after close).
	const pending = new Map<
		string,
		{
			resolve: (v: unknown) => void;
			reject: (e: Error) => void;
			timer: NodeJS.Timeout;
		}
	>();
	let rpcId = 0;
	let capturedSessionFile: string | undefined;

	const request = (command: Record<string, unknown>): Promise<unknown> => {
		const id = `pi-task-${++rpcId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (pending.has(id)) {
					pending.delete(id);
					reject(
						new Error(
							`Timeout waiting for response to "${String(command.type)}"`,
						),
					);
				}
			}, 30000);
			pending.set(id, { resolve, reject, timer });
			try {
				proc.stdin!.write(JSON.stringify({ ...command, id }) + "\n");
			} catch (err) {
				clearTimeout(timer);
				pending.delete(id);
				reject(
					new Error(
						`Failed to send command to worker: ${(err as Error).message}`,
					),
				);
			}
		});
	};

	// ─── Temp cleanup ────────────────────────────────────────────
	const cleanupTemp = (): void => {
		if (tmpPromptPath) {
			try {
				unlinkSync(tmpPromptPath);
			} catch {
				/* best effort */
			}
		}
		if (tmpDir) {
			// rmSync recursive: the dir may hold the identity config too.
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
		tmpPromptPath = null;
		tmpDir = null;
	};

	// ─── Event processing ────────────────────────────────────────
	const processEvent = (raw: unknown): void => {
		// The JSONL RPC stream is untyped at this seam; narrow to the fields
		// the watchdogs, response router and reducer inspect.
		const event = raw as {
			type?: string;
			toolName?: unknown;
			args?: unknown;
			id?: unknown;
			success?: boolean;
			error?: string;
		};
		// Any RPC line on stdout counts as activity (responses included) —
		// resets the no-progress watchdog's clock.
		lastActivityMs = Date.now();
		// An in-flight tool execution counts as progress even when it streams
		// nothing (long silent bash/test tools); track start→end depth + the
		// in-flight stack (the tool-call timeout bounds its oldest entry).
		if (event.type === "tool_execution_start") {
			lastTool = {
				name: typeof event.toolName === "string" ? event.toolName : "tool",
				args: summarizeToolArgs(event.args),
			};
			toolStack.push({
				name: lastTool.name,
				args: lastTool.args,
				startMs: Date.now(),
			});
			toolCallDepth = toolStack.length;
			// Wall expired during verification (grace active): the worker may
			// only keep running verification commands — a new NON-verification
			// tool means it left the suite and would burn budget on new work.
			if (wallExpiredAt !== null && wallGraceTimer !== null) {
				const action = decideWallGraceAction({
					wallExpired: true,
					graceExhausted: false,
					verificationInFlight: true,
					newToolIsVerification: isVerificationCommand(
						lastTool.args,
						verificationCommands,
					),
				});
				if (action === "abort") {
					clearTimeout(wallGraceTimer);
					wallGraceTimer = null;
					failWorker("wall_timeout", wallTimeoutErrorMessage(wallTimeoutMs));
				}
			}
		}
		if (event?.type === "tool_execution_end") {
			if (toolStack.length > 0) toolStack.pop();
			toolCallDepth = toolStack.length;
		}

		// Route RPC command responses to their pending requests (by id). They
		// are not agent events and must not reach the reducer or listeners.
		const rawId: unknown = event.id;
		const responseId =
			typeof rawId === "string" || typeof rawId === "number"
				? String(rawId)
				: undefined;
		if (
			event.type === "response" &&
			responseId !== undefined &&
			pending.has(responseId)
		) {
			const p = pending.get(responseId)!;
			pending.delete(responseId);
			clearTimeout(p.timer);
			if (event.success === false)
				p.reject(new Error(event.error ?? "RPC command failed"));
			else p.resolve(event);
			return;
		}

		// Pure reducer: state accumulates, updates dispatch to onUpdate.
		const { updates } = reduceWorkerEvent(state, event);
		for (const update of updates) onUpdate?.(update);

		// Idle watchdog (R1): the agent settled but no yield payload arrived —
		// nudge once with a yield reminder, then fail the run on the second
		// settle. Never fires during abort, after payload capture, or on any
		// other event type (decideIdleAction is pure + hermetically tested).
		if (!wasAborted && !failed) {
			const action = decideIdleAction(
				event.type ?? "",
				state.yieldPayload !== null,
				nudged,
			);
			if (action === "nudge") {
				nudged = true;
				try {
					proc.stdin!.write(
						JSON.stringify({
							type: "prompt",
							message: WORKER_IDLE_NUDGE_PROMPT,
						}) + "\n",
					);
				} catch {
					// stdin may already be closed — the close handler reports the exit.
				}
			} else if (action === "fail") {
				failWorker("no_yield", NO_YIELD_FAILURE);
			}
		}

		// Dispatch raw event to external listeners (e.g. prewalk)
		for (const listener of listeners) {
			try {
				listener(event);
			} catch (err) {
				// A listener error must not break the event stream
				console.error("worker: event listener error:", err);
			}
		}
	};

	// ─── stdout: JSONL events ────────────────────────────────────
	attachJsonlReader(proc.stdout!, processEvent);

	// ─── stderr: collect for error reporting ─────────────────────
	proc.stderr!.on("data", (chunk: Buffer) => {
		stderrOutput += chunk.toString("utf-8");
	});

	// ─── Result promise ──────────────────────────────────────────
	let resolveResult!: (r: WorkerResult) => void;
	let rejectResult!: (e: Error) => void;
	const result = new Promise<WorkerResult>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
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
		if (toolTimeoutTimer) {
			clearInterval(toolTimeoutTimer);
			toolTimeoutTimer = null;
		}
		signal?.removeEventListener("abort", onSignalAbort);
		// The worker can no longer respond — reject pending RPC requests and
		// clear their timers (R7: no orphaned timers, no never-settling request).
		for (const [, p] of pending) {
			clearTimeout(p.timer);
			p.reject(
				new Error("Worker closed before responding to a pending RPC request"),
			);
		}
		pending.clear();
		cleanupTemp();
		if (wasAborted) {
			// Deterministic abort rejection with diagnostics (todo #86): the
			// specific cause recorded by whichever watchdog fired, plus the
			// worker's final state. The watchdogs no longer reject directly —
			// the old direct rejects raced this close handler and the generic
			// "Worker was aborted" could swallow the specific cause.
			rejectResult(
				buildAbortError({
					code: failureCode,
					cause: failureCause,
					turns: state.usage.turns,
					idleMs: Math.max(0, Date.now() - lastActivityMs),
					lastTool,
					stderrTail: stderrOutput.slice(-STDERR_TAIL_CHARS),
				}),
			);
			return;
		}
		const settled = settleWorker(state, code ?? 1, false, stderrOutput);
		if (settled.ok) {
			resolveResult({
				...settled.result,
				// exactOptionalPropertyTypes: only carry the session file when one
				// was actually captured (spread adds nothing otherwise).
				...(capturedSessionFile !== undefined && {
					sessionFile: capturedSessionFile,
				}),
				reads: state.reads,
				turnUsage: state.turnUsage,
			});
		} else {
			rejectResult(settled.error);
		}
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
		if (toolTimeoutTimer) {
			clearInterval(toolTimeoutTimer);
			toolTimeoutTimer = null;
		}
		signal?.removeEventListener("abort", onSignalAbort);
		cleanupTemp();
		rejectResult(new Error(`Failed to spawn worker: ${err.message}`));
	});

	// ─── Send the task prompt ────────────────────────────────────
	// RPC mode reads stdin immediately; no handshake needed. An unguarded
	// write can throw (e.g. EPIPE when the process died instantly) — surface
	// a precise spawn-write error instead of an unhandled throw (R8).
	try {
		proc.stdin!.write(JSON.stringify({ type: "prompt", message: task }) + "\n");
	} catch (err) {
		proc.kill("SIGKILL");
		rejectResult(
			new Error(
				`Failed to write task prompt to worker: ${(err as Error).message}`,
			),
		);
	}

	// When persisting a session (review forking), capture its file path once.
	// get_state is a direct command that resolves immediately — long before
	// the run settles — so capturedSessionFile is set well before close.
	if (sessionDir) {
		request({ type: "get_state" })
			.then((res) => {
				const data = (res as { data?: { sessionFile?: unknown } } | null)?.data;
				if (typeof data?.sessionFile === "string") {
					capturedSessionFile = data.sessionFile;
				}
			})
			.catch(() => {
				/* non-fatal: review degrades to no fork if this fails */
			});
	}

	// ─── Abort handling ──────────────────────────────────────────
	// ─── Unified failure path (todo #86) ────────────────────────
	// Every fail condition (wall, no-progress, idle, external abort) records
	// its CAUSE and aborts; the process-close handler produces the single,
	// deterministic rejection with diagnostics. Previously each watchdog
	// rejected directly, racing the close handler — the generic "Worker was
	// aborted" (settleWorker) could swallow the specific cause.
	const failWorker = (code: WorkerFailureCode, cause: string): void => {
		failureCode = code;
		failureCause = cause;
		failed = true;
		abort();
	};

	const abort = (): void => {
		wasAborted = true;
		// Send abort command first (graceful)
		try {
			proc.stdin!.write(JSON.stringify({ type: "abort" }) + "\n");
		} catch {
			/* stdin may already be closed */
		}
		// Then escalate to signals. Gate the SIGKILL escalation on the exit
		// code, not proc.killed: `killed` flips true as soon as SIGTERM was
		// sent, so the old `!proc.killed` guard made SIGKILL dead code (R4).
		proc.kill("SIGTERM");
		setTimeout(() => {
			if (proc.exitCode === null) proc.kill("SIGKILL");
		}, SIGKILL_DELAY_MS);
	};

	// Named handler so the close handler can detach it from the caller's
	// signal (R7: no listener left attached to a foreign AbortSignal).
	const onSignalAbort = (): void => {
		abort();
	};

	if (signal) {
		if (signal.aborted) {
			abort();
		} else {
			signal.addEventListener("abort", onSignalAbort, { once: true });
		}
	}

	// ─── Wall-clock timeout (R3, Phase 11: per-tier wall) ────────────────
	// A worker that hangs (neither settles nor yields) must not block the
	// orchestrator forever: on expiry, abort the process and reject `result`
	// naming the limit. The resolved tier's wall_timeout_ms arrives via
	// opts.timeoutMs (selectWorkerWallTimeout); cleared on close/error (see
	// the close handler).
	const wallTimeoutMs = selectWorkerWallTimeout(opts.timeoutMs);
	const verificationCommands = opts.verificationCommands ?? [];
	const wallGraceMs =
		opts.verificationTimeoutMs ?? WORKER_VERIFICATION_GRACE_MS;
	let wallExpiredAt: number | null = null;
	let wallGraceTimer: NodeJS.Timeout | null = null;
	const verificationInFlight = (): boolean =>
		toolStack.some((t) => isVerificationCommand(t.args, verificationCommands));
	wallTimer = setTimeout(() => {
		wallTimer = null;
		// Wall expired mid-verification: grant a bounded grace so the suite
		// can finish and the worker can yield a real verification result
		// (each verification command is additionally bounded by the per-tool
		// timeout). The grace ends early if the worker starts a
		// non-verification tool (tool_execution_start handler) or when it
		// exhausts the cap (this timer).
		if (
			verificationCommands.length > 0 &&
			wallExpiredAt === null &&
			verificationInFlight()
		) {
			wallExpiredAt = Date.now();
			wallGraceTimer = setTimeout(() => {
				wallGraceTimer = null;
				failWorker(
					"wall_timeout",
					`worker wall-clock budget (${formatDuration(wallTimeoutMs)}) expired during verification; ` +
						`the verification grace (${formatDuration(wallGraceMs)}) was also exhausted — aborting. ` +
						`A verification suite that consistently outruns the tier wall needs a larger wall_timeout_ms.`,
				);
			}, wallGraceMs);
			return;
		}
		failWorker("wall_timeout", wallTimeoutErrorMessage(wallTimeoutMs));
	}, wallTimeoutMs);

	// ─── No-progress watchdog (R1, todo #74) ────────────────────
	// The settle-based idle watchdog only fires on an `agent_settled` event
	// (a worker that settled but forgot yield); a worker that hangs emitting
	// NO events at all never trips it and would silently burn the whole
	// 45-min wall budget. This watchdog aborts after a bounded window of
	// zero RPC activity (any event resets the clock; an in-flight tool
	// execution counts as progress — see decideNoProgressAction) and rejects
	// `result` with a message naming the window and the wall limit.
	// Unchanged: the wall timeout and the settle-based idle watchdog.
	const noProgressTimeoutMs =
		opts.noProgressTimeoutMs ?? WORKER_NO_PROGRESS_TIMEOUT_MS;
	noProgressTimer = setInterval(() => {
		if (
			!noProgressFired &&
			!wasAborted &&
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
			failWorker(
				"no_progress",
				noProgressErrorMessage(noProgressTimeoutMs, wallTimeoutMs),
			);
		}
	}, NO_PROGRESS_CHECK_INTERVAL_MS);

	// ─── Tool-call timeout (Phase 11, R4) ────────────────────────
	// A single tool execution that never returns (e.g. a hung bash/test
	// command) is INVISIBLE to the no-progress watchdog above — an in-flight
	// tool counts as progress by design. This watchdog bounds the OLDEST
	// in-flight tool: on expiry the worker is aborted naming the tool and its
	// truncated arguments (decideToolTimeoutAction is pure; the wall fires
	// only while toolCallDepth > 0 — the stack is non-empty). The failWorker
	// guard records whichever watchdog fires first.
	const toolTimeoutMs = opts.toolTimeoutMs ?? WORKER_TOOL_TIMEOUT_MS;
	toolTimeoutTimer = setInterval(() => {
		const oldest = toolStack[0];
		if (
			!toolTimeoutFired &&
			!wasAborted &&
			!failed &&
			oldest !== undefined &&
			decideToolTimeoutAction({
				nowMs: Date.now(),
				startedAtMs: oldest.startMs,
				timeoutMs: toolTimeoutMs,
			}) === "abort"
		) {
			toolTimeoutFired = true;
			if (toolTimeoutTimer) clearInterval(toolTimeoutTimer);
			toolTimeoutTimer = null;
			failWorker(
				"tool_timeout",
				toolTimeoutErrorMessage(toolTimeoutMs, oldest.name, oldest.args),
			);
		}
	}, TOOL_TIMEOUT_CHECK_INTERVAL_MS);

	return {
		onEvent(listener: (event: unknown) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		sendCommand(command: Record<string, unknown>): void {
			try {
				proc.stdin!.write(JSON.stringify(command) + "\n");
			} catch (err) {
				throw new Error(
					`Failed to send command to worker: ${(err as Error).message}`,
				);
			}
		},

		request,

		// request() (not sendCommand): a rejected set_model (e.g. unknown
		// model) must surface to the caller — fire-and-forget made the run
		// silently continue on the prewalk model (R6).
		setModel(targetModel: string): Promise<unknown> {
			const { provider, modelId } = splitModel(targetModel);
			return this.request({ type: "set_model", provider, modelId });
		},

		result,
		abort,
	};
}

// ─── One-shot wrapper ────────────────────────────────────────────────

export async function runWorker(opts: WorkerOptions): Promise<WorkerResult> {
	const session = spawnWorkerSession(opts);
	return session.result;
}

// ─── Flex capacity resilience ────────────────────────────────────────
// OpenRouter flex processing has NO server-side fallback: capacity
// shortages surface as typed errors, and Google's guidance is client-side
// exponential backoff. Worker volume is low, so we build the retry in
// rather than wait for production data (design decision 2026-08-19).

/** Retry delays for capacity failures: 30s → 60s → 120s (3 retries). */
export const CAPACITY_BACKOFF_DELAYS_MS = [30_000, 60_000, 120_000];

/**
 * Pure classifier (hermetic-tested): is a failure message a
 * capacity/availability error worth retrying with backoff? Broad by
 * design — flex capacity error shapes are provider-rendered strings; a
 * false positive costs one retry, a false negative fails a recoverable
 * run. Aborts/timeouts are NOT capacity errors (never matched: the
 * message must name a capacity condition).
 */
export function isRetryableCapacityError(message: string): boolean {
	return /capacity|overloaded|too many requests|rate.?limit|service unavailable|no (flex )?endpoint|flex.*unavailable|\b503\b|\b429\b/i.test(
		message,
	);
}

/** Abort-aware sleep (shared shape with batch.ts sleepDefault). */
export async function sleepForBackoff(
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) return;
	await new Promise<void>((resolve) => {
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(t);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * spawnWorkerSession with exponential-backoff retry on capacity errors:
 * flex-tier runs can hit "no capacity" failures that a re-spawn after a
 * delay recovers from. Returns a SYNCHRONOUS facade with the exact
 * WorkerSession contract — callers subscribe onEvent immediately after
 * spawn (progress), so the retry must not block the handle. The facade
 * delegates to the CURRENT attempt and re-attaches listeners on re-spawn;
 * `result` resolves/rejects from whichever attempt settles. Non-capacity
 * failures propagate unchanged. Abort kills the current attempt and stops
 * the retry loop.
 */
export function spawnWorkerSessionResilient(
	opts: WorkerOptions,
	delaysMs: number[] = CAPACITY_BACKOFF_DELAYS_MS,
	sleep: (ms: number, signal?: AbortSignal) => Promise<void> = sleepForBackoff,
): WorkerSession {
	let current = spawnWorkerSession(opts);
	let attempt = 0;
	let facadeAborted = false;
	const listeners: Array<(event: unknown) => void> = [];

	const result: Promise<WorkerResult> = (async () => {
		for (;;) {
			try {
				return await current.result;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (
					facadeAborted ||
					opts.signal?.aborted ||
					attempt >= delaysMs.length ||
					!isRetryableCapacityError(msg)
				) {
					throw err;
				}
				const delayMs = delaysMs[attempt];
				if (delayMs === undefined) throw err;
				opts.onUpdate?.({
					type: "capacity_backoff",
					attempt: attempt + 1,
					delayMs,
					error: msg,
				});
				await sleep(delayMs, opts.signal);
				if (opts.signal?.aborted) throw err;
				attempt++;
				current = spawnWorkerSession(opts);
				for (const l of listeners) current.onEvent(l);
			}
		}
	})();

	return {
		onEvent: (listener) => {
			listeners.push(listener);
			return current.onEvent(listener);
		},
		sendCommand: (command) => current.sendCommand(command),
		request: (command) => current.request(command),
		setModel: (model) => current.setModel(model),
		result,
		abort: () => {
			facadeAborted = true;
			current.abort();
		},
	};
}
