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
 * Cost accounting (NFR-3): after the session settles the runner reads
 * `SessionHandle.stats()` — the SDK already prices usage — and records
 * tokens/USD plus the COR grounding ratio on the receipt. Accounting is
 * best-effort: a failing stats() read zeroes the usage fields instead of
 * failing the run (see collectUsage).
 *
 * Bundle telemetry (FR-9 mode b / NFR-2): when the ROUTER selects
 * planMode="bundle" AND the caller supplied bundle candidates, the run is
 * grounded on a one-shot versioned/hashed ExecutionBundle and the receipt
 * advertises the outcome via bundleHit — true when the run shipped with
 * every changed file inside the bundled target set, false on ANY miss
 * (unusable bundle, worker drift outside the set, failed run, failing
 * verification). Every miss is recorded into routing_feedback as hit=0:
 * a never-tried path records its misses, never silence.
 *
 * Plugin extractions (R1/R2/R4/R5): two former INLINE core behaviors now
 * live behind the TaskPlugin seam as one-file one-default-export modules
 * loaded by path from task.toml [plugins] (M4b) and invoked exclusively
 * through the M4b hooks below:
 *
 *   | Behavior                    | Before (lived here)                | After (plugin)                          |
 *   |-----------------------------|------------------------------------|-----------------------------------------|
 *   | handoff 60 kB tail capping  | inline slice-to-60k on             | plugins/builtin/handoff-cap.ts          |
 *   |                             | firstFailure.stderrTail            | (transformHandoff, schema-revalidated)  |
 *   | toolEnd descriptor +        | `describeTool()` helper + ad-hoc   | plugins/builtin/lifecycle-collector.ts  |
 *   | lifecycle event journaling  | observation bookkeeping            | (registerTriggers/onLifecycleEvent)     |
 *
 * The runner only builds the UNCAPPED handoff and emits lifecycle events;
 * both behaviors are reachable ONLY through transformHandoffThrough /
 * emitLifecycleEventToPlugins — there is no second inline copy in core.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";

import type {
	ExecutionBundle,
	HandoffBundle,
	TaskReceipt,
	Yield,
} from "../contracts/index.ts";
import { writeFailureArtifact } from "../guards/artifacts.ts";
import {
	attachWatchdogs,
	type WatchdogEnd,
} from "../guards/watchdog-driver.ts";
import {
	buildExecutionBundle,
	bundleGroundingSection,
	isBundleFocused,
	isBundleUsable,
} from "../grounding/bundle.ts";
import { LedgerStore } from "../ledger/store.ts";
import {
	BUNDLE_FEEDBACK_MODE,
	routeTask,
	type RoutingFeedbackRow,
} from "../router/route.ts";
import {
	createSessionHost,
	SessionHostError,
	type SessionHandle,
	type SessionHost,
	type SessionHostEvent,
} from "../sessions/host.ts";
import {
	singleRunFailureHygiene,
	serializeSingleRunRecovery,
	type SingleRunRecoveryInfo,
} from "../workspaces/failure-hygiene.ts";
import {
	attachPrewalk,
	decidePrewalkSwap,
	type PrewalkPricing,
} from "../grounding/prewalk.ts";
import { verifyThroughEnvironment } from "../verify/adapter.ts";
import { HostEnvironmentDriver } from "../environments/drivers.ts";
import type { TaskGateway } from "../contracts/index.ts";
import type { TaskPlugin } from "../contracts/task-plugin.ts";
import {
	emitLifecycleEventToPlugins,
	registerPluginTriggers,
	transformExecutionBundleThrough,
	transformHandoffThrough,
} from "../plugins/index.ts";
import { InMemoryTaskGateway } from "../gateway/index.ts";

/** Default AI identity email — the provenance test failure hygiene
 *  applies before abandoning empty stubs (matches the workspace driver's
 *  default so both engines sweep only their own empties). */
const DEFAULT_AI_AUTHOR_EMAIL = "noreply@pi-task-v2.local";

/**
 * Usage sentinel (FR-9/NFR-3): every usage field on a receipt carries
 * this when no measurement exists — stats() rejected mid-run or no
 * session ever spawned. Accounting never fails a run.
 */
export const USAGE_UNAVAILABLE = 0;

/** Measured session usage as it lands on a receipt, plus the COR inputs
 *  the receipt itself does not carry (cacheWrite feeds the denominator;
 *  groundingTokens feeds per-worker sums in the parallel aggregator). */
export interface UsageSnapshot {
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	groundingTokens: number;
	cor: number;
}

/** Everything billed as prompt, cached or not — the NFR-3 denominator. */
export function totalInputTokens(tokens: {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}): number {
	return tokens.input + tokens.cacheRead + tokens.cacheWrite;
}

/** COR grounding ratio: grounding ÷ total input (0 when nothing billed). */
export function computeCor(
	groundingTokens: number,
	totalInput: number,
): number {
	return totalInput === 0 ? 0 : groundingTokens / totalInput;
}

/**
 * Approximate the fixed grounding prefix in tokens (NFR-3): the exact
 * denominator wants manifest phase data that does not exist yet, so the
 * runner approximates honestly — ≈4 utf-8 bytes per token over the
 * worker system prompt plus the spec markdown.
 */
export function estimateGroundingTokens(
	systemPrompt: string,
	specMarkdown: string,
): number {
	return Math.ceil(Buffer.byteLength(systemPrompt + specMarkdown, "utf-8") / 4);
}

/** All-zero snapshot for runs with no measurable session. */
export function emptyUsage(): UsageSnapshot {
	return {
		costUsd: USAGE_UNAVAILABLE,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		groundingTokens: 0,
		cor: 0,
	};
}

/**
 * Read a settled session's usage into a snapshot. Failure tolerance
 * (NFR-3): a rejecting stats() yields the zeroed sentinel snapshot —
 * accounting must never fail a run.
 */
export async function collectUsage(
	handle: SessionHandle,
	groundingTokens: number,
): Promise<UsageSnapshot> {
	try {
		const stats = await handle.stats();
		return {
			costUsd: stats.cost,
			inputTokens: stats.tokens.input,
			outputTokens: stats.tokens.output,
			cacheReadTokens: stats.tokens.cacheRead,
			cacheWriteTokens: stats.tokens.cacheWrite,
			groundingTokens,
			cor: computeCor(groundingTokens, totalInputTokens(stats.tokens)),
		};
	} catch {
		return emptyUsage();
	}
}

/** Sum snapshots and RECOMPUTE the aggregate cor from summed grounding
 *  over summed total input — never average the per-worker ratios. */
export function sumUsage(usages: readonly UsageSnapshot[]): UsageSnapshot {
	const total = emptyUsage();
	for (const u of usages) {
		total.costUsd += u.costUsd;
		total.inputTokens += u.inputTokens;
		total.outputTokens += u.outputTokens;
		total.cacheReadTokens += u.cacheReadTokens;
		total.cacheWriteTokens += u.cacheWriteTokens;
		total.groundingTokens += u.groundingTokens;
	}
	total.cor = computeCor(
		total.groundingTokens,
		totalInputTokens({
			input: total.inputTokens,
			cacheRead: total.cacheReadTokens,
			cacheWrite: total.cacheWriteTokens,
		}),
	);
	return total;
}

/** The flat receipt fields carrying measured usage (receipt stays ≈150
 *  tokens, §5.6 — compact numbers only, no nested objects). */
export function receiptUsageFields(
	usage: UsageSnapshot,
): Pick<
	TaskReceipt,
	"costUsd" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cor"
> {
	return {
		costUsd: usage.costUsd,
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens,
		cor: usage.cor,
	};
}

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

	const goalLines = (sections.get("goal") ?? [])
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	const firstGoal = goalLines[0] ?? "(no goal line)";
	const requirementLines = (sections.get("requirements") ?? [])
		.map((l) => l.replace(/^\s*(?:[-*]|\d+[.:)])\s*/, "").trim())
		.filter((l) => l.length > 0);
	const commandLines = (sections.get("verification") ?? [])
		.map((l) => l.replace(/^\s*-\s*/, "").trim())
		.filter((l) => l.length > 0);

	if (requirementLines.length === 0)
		throw new SpecValidationError("requirements");
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

/**
 * Derive the stable task FAMILY id from the spec content + cwd
 * (prompt-independent). Attempts append a discriminator — retries, fix
 * loops, and reconciliation requeues must never collide on the PK.
 */
export function deriveTaskId(specMarkdown: string, cwd: string): string {
	return createHash("sha256")
		.update(`${cwd}\n${specMarkdown}`)
		.digest("hex")
		.slice(0, 12);
}

/** First free attempt id for a family: `family`, then `family-a2`,
 *  `family-a3`, … Reads existing rows so re-runs never hit the PK. */
export function resolveAttemptId(store: LedgerStore, familyId: string): string {
	if (store.getTask(familyId) === null) return familyId;
	for (let attempt = 2; ; attempt += 1) {
		const candidate = `${familyId}-a${attempt}`;
		if (store.getTask(candidate) === null) return candidate;
	}
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
	/**
	 * Prewalk policy (§5.3 mode a) — OFF by default (undefined). When
	 * enabled AND the router selects planMode=prewalk AND the tier's
	 * models differ, the worker spawns on prewalkModel and swaps to
	 * `model` on the first successful edit IF the break-even cost model
	 * says the uncached swap penalty amortizes over the remaining turns.
	 */
	prewalk?: {
		enabled: boolean;
		/** The strong model to explore on (execute model = options.model). */
		modelId: string;
		pricing: PrewalkPricing;
		/** Estimated remaining turns at the swap point. Default 12. */
		remainingTurnsEstimate?: number;
	};
	/**
	 * Bundle-mode candidates (§5.3 b): files believed relevant to the spec.
	 * Building a bundle is isolated from using one (R1) — the runner only
	 * attaches bundle grounding when the ROUTER selected planMode="bundle";
	 * with any other plan mode (or when the assembled bundle comes out
	 * empty) the candidates are ignored and the run proceeds normally.
	 */
	bundle?: { targetPaths?: readonly string[] } | undefined;
	/** Config-loaded lifecycle plugins (subsystems §3): transform hooks
	 *  fire on the bundle/handoff paths, registerTriggers subscribes through
	 *  the gateway BEFORE the run, onLifecycleEvent fans out per emit — each
	 *  call isolated, never fatal (R4). */
	plugins?: readonly TaskPlugin[] | undefined;
	/** Sink for plugin hook failures (defaults to console.error). Wired
	 *  through every hook invocation site so operators can route plugin
	 *  diagnostics instead of scraping stderr. */
	onPluginHookError?: ((err: unknown) => void) | undefined;
	/** Observability sink for session events (progress UIs, debugging). */
	onEvent?: (event: SessionHostEvent) => void;
	/** Lifecycle event sink (R4); defaults to an InMemoryTaskGateway over
	 *  this run's ledger so getTaskState awaits the same mutations. */
	gateway?: TaskGateway | undefined;
	/** Wall-clock bound forwarded to the session host. */
	sessionTimeoutMs?: number;

	/** AI identity email configured for the run's jj commits (the
	 *  provenance test failure hygiene applies before abandoning empty
	 *  stubs). Default {@link DEFAULT_AUTHOR_EMAIL}. */
	aiAuthorEmail?: string;
	/** Opt-out of the engine-side repo reconciliation on termination. */
	skipFailureHygiene?: boolean;
}

/**
 * Single-run termination hygiene (failure-artifact contract rules 1–6,
 * docs/pi-task-design.md "Failure-artifact contract"): rescue partial work
 * as ONE goal-named commit, abandon ONLY provably engine-authored empty
 * stubs, never destroy user content, and return the machine-readable
 * recovery info for the artifact. Best-effort + bounded; never throws.
 */
async function runSingleRunHygiene(options: {
	cwd: string;
	cause: string;
	goal: string;
	aiAuthorEmail: string | undefined;
}): Promise<SingleRunRecoveryInfo | undefined> {
	try {
		return await singleRunFailureHygiene({
			cwd: options.cwd,
			cause: options.cause,
			goal: options.goal,
			...(options.aiAuthorEmail === undefined
				? {}
				: { aiAuthorEmail: options.aiAuthorEmail }),
		});
	} catch {
		return undefined;
	}
}

/** Outcome of one run beyond the receipt itself. */
export interface RunTaskResult {
	receipt: TaskReceipt;
	yieldedResult?: Yield | undefined;
	/** Schema-revalidated, plugin-transformed handoff for the caller's
	 *  retry attempt (present only when verification failed). */
	handoff?: HandoffBundle | undefined;
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

/** Run one task end-to-end (R1). See module docstring for the pipeline.
 *  Note: the former inline describeTool() helper moved verbatim to
 *  plugins/builtin/lifecycle-collector.ts (R2 — no duplicated copy). */
export async function runTask(options: RunTaskOptions): Promise<RunTaskResult> {
	if (!existsSync(options.cwd)) {
		throw new Error(`runTask: cwd does not exist: ${options.cwd}`);
	}
	const parsed = parseTaskSpec(options.specMarkdown);
	const familyId = deriveTaskId(options.specMarkdown, options.cwd);
	mkdirSync(options.artifactsDir, { recursive: true });

	const store = new LedgerStore(options.dbPath);
	try {
		return await runWithStore(store, options, familyId, parsed);
	} finally {
		store.close();
	}
}

async function runWithStore(
	store: LedgerStore,
	options: RunTaskOptions,
	familyId: string,
	parsed: ParsedTaskSpec,
): Promise<RunTaskResult> {
	const taskId = resolveAttemptId(store, familyId);
	store.insertTask({ id: taskId, goal: parsed.goal });
	// R4: events flow AFTER their ledger mutation — a subscriber reading
	// getTaskState on task.queued already sees the queued row. Every emit
	// ALSO fans out to the plugins' onLifecycleEvent, each call isolated
	// (a throwing plugin never breaks dispatch — same handler-throw rule
	// as the gateway itself).
	const baseGateway = options.gateway ?? new InMemoryTaskGateway({ store });
	const plugins = options.plugins ?? [];
	const pluginHookCtx =
		options.onPluginHookError === undefined
			? undefined
			: { onHookError: options.onPluginHookError };
	const gateway: TaskGateway = {
		emit: (event) => {
			baseGateway.emit(event);
			if (plugins.length > 0)
				emitLifecycleEventToPlugins(event, plugins, pluginHookCtx);
		},
		on: (pattern, handler) => baseGateway.on(pattern, handler),
		getTaskState: (taskId) => baseGateway.getTaskState(taskId),
		getManifest: (taskId) => baseGateway.getManifest(taskId),
	};
	// Trigger half of the plugin contract (subsystems §3): registerTriggers-
	// style plugins subscribe through the SAME gateway the pipeline emits
	// into, BEFORE the first event fires — registration itself is isolated,
	// so one throwing registerTriggers cannot prevent later plugins from
	// registering nor break the run.
	if (plugins.length > 0) {
		registerPluginTriggers(
			(plugin) => plugin.registerTriggers?.(gateway),
			plugins,
			pluginHookCtx,
		);
	}
	gateway.emit({ type: "task.queued", taskId });

	const observation: RunObservation = {
		lastEvent: undefined,
		lastTool: undefined,
		turns: 0,
		watchdogAbort: undefined,
		hostError: undefined,
	};
	// Failure-artifact contract rule 6: machine-readable recovery travels
	// with the failure output. The hygiene runs INSIDE failRun so every
	// termination path carries it.
	const skipHygiene = options.skipFailureHygiene === true;
	const hygiene = async (cause: string): Promise<void> => {
		if (skipHygiene) return;
		const recovery = await runSingleRunHygiene({
			cwd: options.cwd,
			cause,
			goal: parsed.goal,
			aiAuthorEmail: options.aiAuthorEmail ?? DEFAULT_AI_AUTHOR_EMAIL,
		});
		if (recovery !== undefined) singleRunRecoveryInfo = recovery;
	};

	// Bundle telemetry state (R2/R3): resolved after routing, read by every
	// receipt-building path below. `bundleMissRecorded` marks an ATTEMPTED
	// but unusable bundle (already written a miss row at build time);
	// `bundleUsed` marks grounding that actually attached to the prompt.
	let bundleAttempted = false;
	let bundleUsed = false;
	let bundleMissRecorded = false;
	let bundle: ExecutionBundle | undefined;
	/** Recovery block captured by this run's own hygiene step. */
	let singleRunRecoveryInfo: SingleRunRecoveryInfo | undefined;

	// NFR-3: when usage was already measured before the failure, carry it
	// into the failed receipt instead of discarding it (defaults to zeroes
	// for failures that happen before any session activity).
	const failRun = async (
		cause: string,
		usage: UsageSnapshot = emptyUsage(),
	): Promise<RunTaskResult> => {
		await hygiene(cause);
		writeFailureArtifact({
			artifactsDir: options.artifactsDir,
			runId: taskId,
			cause,
			...(observation.lastEvent === undefined
				? {}
				: { lastEvent: observation.lastEvent }),
			...(observation.lastTool === undefined
				? {}
				: { lastTool: observation.lastTool }),
			...(singleRunRecoveryInfo === undefined
				? {}
				: {
						recovery: {
							steps: [serializeSingleRunRecovery(singleRunRecoveryInfo)],
						},
					}),
		});
		store.setSessionStatus(`${taskId}-worker`, "crashed");
		store.setTaskStatus(taskId, "failed");
		// Session stamp (review M4 P0-2): terminal task.* events carry the
		// owning session id so session-scoped surface subscribers can filter.
		gateway.emit({
			type: "task.failed",
			taskId,
			sessionId: `${taskId}-worker`,
			detail: { cause },
		});
		// R3: a bundled run that dies anywhere is a MISS. When the bundle was
		// merely attempted (never grounded), the miss row was already written
		// at build time — do not double-count it.
		if (bundleUsed || !bundleAttempted)
			store.recordRoutingFeedback(repo, decision.planMode, 0);
		return {
			receipt: {
				taskId,
				verdict: "failed",
				filesChanged: 0,
				commitIds: [],
				turns: observation.turns,
				...receiptUsageFields(usage),
				bundleHit: bundleUsed || bundleMissRecorded ? false : null,
			},
			verificationPassed: false,
			taskId,
		};
	};

	// ── Route (§5.4): feedback comes from this repo's ledger rows. ──────
	const repo = options.cwd.split("/").filter(Boolean).pop() ?? options.cwd;
	const feedbackRows: RoutingFeedbackRow[] = store.routingRows(repo);
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
	gateway.emit({
		type: "task.routed",
		taskId,
		detail: { planMode: decision.planMode },
	});

	// ── Bundle assembly (R1): building is isolated from USING. The router's
	// planMode gates attachment; the caller only supplies candidates.
	bundleAttempted =
		decision.planMode === "bundle" && options.bundle !== undefined;
	if (bundleAttempted) {
		let built: ExecutionBundle | undefined;
		try {
			built = buildExecutionBundle({
				taskId,
				goal: parsed.goal,
				requirements: parsed.requirements,
				verificationCommands: parsed.verificationCommands,
				targetPaths: options.bundle!.targetPaths ?? [],
			});
		} catch {
			built = undefined;
		}
		if (built === undefined || !isBundleUsable(built)) {
			// An EMPTY/unusable bundle grounds nothing: record the miss up front
			// and proceed ungrounded rather than pretending the shortcut fired.
			bundleMissRecorded = true;
			store.recordRoutingFeedback(repo, BUNDLE_FEEDBACK_MODE, 0);
		} else {
			// Plugin transform (R3): BEFORE grounding attaches. The helper
			// re-validates through ExecutionBundleSchema, so a plugin cannot
			// inject an invalid bundle into the prompt prefix; its isolation
			// means a failing plugin yields the BUILT bundle, never a miss row.
			bundle = await transformExecutionBundleThrough(
				built,
				plugins,
				pluginHookCtx,
			);
			bundleUsed = true;
		}
	}

	// ── Host the worker session. ────────────────────────────────────────
	store.insertMicroSession({ id: `${taskId}-worker`, taskId, role: "worker" });
	store.setTaskStatus(taskId, "executing");

	const host = options.host ?? createSessionHost();
	// Grounding figure (NFR-3 approximation): fixed prefix = system prompt
	// + spec bytes, computed once where the prompt is built.
	let systemPrompt = buildWorkerSystemPrompt(options.specMarkdown);
	let groundingTokens = estimateGroundingTokens(
		systemPrompt,
		options.specMarkdown,
	);
	if (bundleUsed && bundle) {
		const section = bundleGroundingSection(bundle);
		systemPrompt += section;
		groundingTokens += Math.ceil(Buffer.byteLength(section, "utf-8") / 4);
	}
	const prewalkActive =
		options.prewalk?.enabled === true &&
		decision.planMode === "prewalk" &&
		options.prewalk.modelId !== options.model;
	let handle: SessionHandle;
	try {
		handle = await host.spawn({
			role: "worker",
			modelId: prewalkActive ? options.prewalk!.modelId : options.model,
			cwd: options.cwd,
			systemPrompt,
			...(options.sessionTimeoutMs === undefined
				? {}
				: { timeoutMs: options.sessionTimeoutMs }),
		});
		gateway.emit({
			type: "session.spawned",
			taskId,
			sessionId: `${taskId}-worker`,
		});
	} catch (err) {
		const cause =
			err instanceof SessionHostError
				? `session host error (${err.code}): ${err.message}`
				: `session spawn failed: ${err instanceof Error ? err.message : String(err)}`;
		return await failRun(cause);
	}

	const unsubscribeEvents = handle.subscribe((event) => {
		options.onEvent?.(event);
		if (event.type === "turnStart") observation.turns += 1;
		if (event.type === "toolEnd") observation.lastTool = event.toolName;
		observation.lastEvent = event;
	});
	if (prewalkActive && options.prewalk) {
		const pricing: PrewalkPricing = options.prewalk.pricing;
		const remainingTurnsEstimate = options.prewalk.remainingTurnsEstimate ?? 12;
		void attachPrewalk(handle, {
			executeModelId: options.model,
			decide: ({ contextTokensAtSwap }) =>
				decidePrewalkSwap({
					contextTokensAtSwap,
					remainingTurnsEstimate,
					pricing,
				}),
			onSwap: ({ decision: d }) => {
				store.recordRoutingFeedback(repo, "prewalk", 1);
				console.error(`prewalk: swapped to ${options.model} (${d.reason})`);
			},
		});
	}
	const watchdogs = attachWatchdogs(handle, {
		// One wall, not two: when the host carries a per-session timeout,
		// the watchdog wall mirrors it so the tighter bound always wins
		// (review C6 — shadowed wall budgets never fire).
		...(options.sessionTimeoutMs === undefined
			? {}
			: { limits: { wallTimeoutMs: options.sessionTimeoutMs } }),
		onAction: (action) => {
			if (action.kind === "abort") observation.watchdogAbort = action;
		},
	});

	try {
		await handle.prompt(buildWorkerPromptText(parsed));
	} catch (err) {
		const cause =
			err instanceof SessionHostError
				? `prompt failed (${err.code}): ${err.message}`
				: `prompt failed: ${err instanceof Error ? err.message : String(err)}`;
		handle.close();
		watchdogs.dispose();
		unsubscribeEvents();
		return await failRun(cause);
	} finally {
		watchdogs.dispose();
		unsubscribeEvents();
	}

	// NFR-3: read measured usage once the session has settled (never on
	// spawn failure — there is no session to read). A rejecting stats()
	// zeroes the snapshot inside collectUsage.
	const usage = await collectUsage(handle, groundingTokens);
	const yieldPayload: Yield | undefined = handle.result;
	handle.close();

	if (!yieldPayload) {
		const cause = observation.watchdogAbort
			? `watchdog abort: ${observation.watchdogAbort.reason}`
			: "settled without yield";
		gateway.emit({
			type: "session.exhausted",
			taskId,
			sessionId: `${taskId}-worker`,
		});
		return await failRun(cause, usage);
	}

	// ── Verify on the working tree through the environment ladder (M6). ──
	store.setSessionStatus(
		`${taskId}-worker`,
		"yielded",
		JSON.stringify(yieldPayload),
	);
	gateway.emit({
		type: "session.yielded",
		taskId,
		sessionId: `${taskId}-worker`,
	});
	const verification = await verifyThroughEnvironment(
		new HostEnvironmentDriver(),
		options.cwd,
		parsed.verificationCommands,
	);
	gateway.emit({
		type: "verify.completed",
		taskId,
		detail: { passed: verification.passed },
	});

	if (!verification.passed) {
		const firstFailure = verification.commands.find((c) => c.exitCode !== 0);
		// Retry-handoff transform (R3): the handoff the fix-loop/retry driver
		// consumes passes through the plugins FIRST — awaited sequentially,
		// schema-revalidated, throw-isolated (a failing plugin yields the
		// untransformed value).
		// R2: the 60 kB tail capping that used to sit INLINE on the next
		// lines (a slice-to-60k over firstFailure.stderrTail) lives in
		// plugins/builtin/handoff-cap.ts, reached only through this
		// transformHandoffThrough call. The runner hands over the raw tails;
		// the plugin owns the cap policy.
		const handoffForRetry = await transformHandoffThrough(
			{
				taskId,
				uncommittedDiffSummary: firstFailure?.stderrTail ?? "",
				filesTouched: [...yieldPayload.files_changed],
				verificationFailures: verification.commands
					.filter((c) => c.exitCode !== 0)
					.map((c) => ({
						command: c.command,
						...(c.timedOut ? { reason: "timed out" } : {}),
						stderrTail: c.stderrTail,
					})),
			},
			plugins,
			pluginHookCtx,
		);
		writeFailureArtifact({
			artifactsDir: options.artifactsDir,
			runId: taskId,
			cause: "verification failed",
			stderrTail: firstFailure?.stderrTail,
			...(singleRunRecoveryInfo === undefined
				? {}
				: {
						recovery: {
							steps: [serializeSingleRunRecovery(singleRunRecoveryInfo)],
						},
					}),
		});
		store.setTaskStatus(taskId, "failed");
		// Same miss discipline as failRun (see above).
		if (bundleUsed || !bundleAttempted)
			store.recordRoutingFeedback(repo, decision.planMode, 0);
		gateway.emit({
			type: "task.failed",
			taskId,
			sessionId: `${taskId}-worker`,
			detail: { cause: "verification failed" },
		});
		return {
			receipt: {
				taskId,
				verdict: "failed",
				filesChanged: yieldPayload.files_changed.length,
				commitIds: yieldPayload.commit_ids,
				turns: observation.turns,
				...receiptUsageFields(usage),
				bundleHit: bundleUsed || bundleMissRecorded ? false : null,
			},
			yieldedResult: yieldPayload,
			handoff: handoffForRetry,
			verificationPassed: false,
			taskId,
		};
	}

	// R2/R3: a bundled run that SHIPPED is a hit only when every changed
	// file stayed inside the bundled target set — drift is a miss even
	// though verification passed. Unusable bundles keep their early miss
	// row; unbundled runs keep the generic planMode feedback untouched.
	let shippedBundleHit: boolean | null = bundleMissRecorded ? false : null;
	if (bundleUsed && bundle) {
		shippedBundleHit = isBundleFocused(
			bundle,
			yieldPayload.files_changed,
			options.cwd,
		);
	}
	if (bundleUsed) {
		store.recordRoutingFeedback(
			repo,
			BUNDLE_FEEDBACK_MODE,
			shippedBundleHit === true ? 1 : 0,
		);
	} else if (!bundleAttempted) {
		store.recordRoutingFeedback(repo, decision.planMode, 1);
	}
	store.setTaskStatus(taskId, "completed");
	gateway.emit({
		type: "task.completed",
		taskId,
		sessionId: `${taskId}-worker`,
		detail: { verdict: "ship" },
	});
	return {
		receipt: {
			taskId,
			verdict: "ship",
			filesChanged: yieldPayload.files_changed.length,
			commitIds: yieldPayload.commit_ids,
			turns: observation.turns,
			...receiptUsageFields(usage),
			bundleHit: shippedBundleHit,
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
