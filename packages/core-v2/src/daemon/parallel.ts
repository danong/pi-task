/**
 * Parallel task pipeline — M2.d.
 *
 * Fan out N worker sessions across WorkspaceDriver-created workspaces,
 * combine deterministically (task-base mode) or bookmark (feature-branch),
 * then verify ONCE on the integrated tree through the selected
 * EnvironmentDriver (FR-6's "merged tree post-merge", FR-5 ladder).
 *
 * Receipts: one TaskReceipt per attempt (verdict mirrors that attempt)
 * plus an AGGREGATE receipt whose filesChanged sums the yields and whose
 * commitIds carries the merged base commit id. Usage (NFR-3): every
 * attempt's measured tokens/USD ride its own receipt; the aggregate sums
 * them and RECOMPUTES cor from summed grounding over summed total input
 * (never an average of ratios). Residual merge conflicts after union
 * resolution → verdict "escalated" (the contract's third outcome), never
 * silently shipped.
 */

import { mkdirSync } from "node:fs";

import type {
	EnvironmentDriver,
	TaskBaseWorkspaceDriver,
	WorkspaceContext,
	WorkspaceDriver,
} from "../contracts/index.ts";
import type { TaskReceipt } from "../contracts/index.ts";
import { writeFailureArtifact } from "../guards/artifacts.ts";
import {
	attachWatchdogs,
	type WatchdogEnd,
} from "../guards/watchdog-driver.ts";

import { workspaceCommitId } from "../workspaces/jj.ts";
import { LedgerStore } from "../ledger/store.ts";
import type { TaskGateway } from "../contracts/index.ts";
import type { TaskPlugin } from "../contracts/task-plugin.ts";
import { InMemoryTaskGateway } from "../gateway/index.ts";
import { registerPluginTriggers } from "../plugins/index.ts";
import { HostEnvironmentDriver } from "../environments/drivers.ts";
import { verifyThroughEnvironment } from "../verify/adapter.ts";
import { createSessionHost, type SessionHost } from "../sessions/host.ts";
import {
	buildWorkerSystemPrompt,
	collectUsage,
	deriveTaskId,
	emptyUsage,
	estimateGroundingTokens,
	parseTaskSpec,
	receiptUsageFields,
	resolveAttemptId,
	SpecValidationError,
	sumUsage,
	type UsageSnapshot,
} from "./task-runner.ts";

export interface RunParallelOptions {
	/** One spec markdown per worker (self-contained, per contract §5.4). */
	subTasks: readonly string[];
	/** The repo (main working copy) workers integrate into. */
	projectDir: string;
	artifactsDir: string;
	dbPath: string;
	model: string;
	workspaceDriver: WorkspaceDriver;
	environmentDriver?: EnvironmentDriver;
	/** Dependency injection for tests. */
	host?: SessionHost;
	/** Lifecycle event sink (R4); defaults to an InMemoryTaskGateway over
	 *  this run's ledger so getTaskState awaits the same mutations. */
	gateway?: TaskGateway | undefined;
	/** Config-loaded lifecycle plugins: registerTriggers subscribes through
	 *  the gateway BEFORE the run starts; each registration isolated so one
	 *  throwing plugin never blocks later registrations (subsystems §3). */
	plugins?: readonly TaskPlugin[] | undefined;
	/** Sink for plugin hook failures (defaults to console.error). */
	onPluginHookError?: ((err: unknown) => void) | undefined;
	sessionTimeoutMs?: number;
	onEvent?: (workerIndex: number, event: unknown) => void;
}

interface WorkerObservation {
	lastEvent: unknown;
	turns: number;
	watchdogAbort: WatchdogEnd | undefined;
}

/** 1 for a family's first attempt; k+1 when the id carries `-a{k+1}`. */
function attemptNumberOf(taskId: string): number {
	const m = /-a(\d+)$/.exec(taskId);
	return m?.[1] ? Number(m[1]) : 1;
}

/** Receipt builder shared by every outcome path; usage comes pre-summed
 *  or per-attempt (see sumUsage / collectUsage in task-runner). */
function makeReceipt(
	taskId: string,
	verdict: TaskReceipt["verdict"],
	filesChanged: number,
	commitIds: string[],
	turns: number,
	usage: UsageSnapshot = emptyUsage(),
): TaskReceipt {
	return {
		taskId,
		verdict,
		filesChanged,
		commitIds,
		turns,
		...receiptUsageFields(usage),
		bundleHit: null,
	};
}

export interface RunParallelResult {
	aggregate: TaskReceipt;
	perWorker: TaskReceipt[];
	/** The combined base commit id (task-base mode; undefined in feature-branch). */
	mergedCommitId?: string;
	conflicts: string[];
}

/** Run all subtasks in parallel through the workspace driver. */
export async function runParallelTask(
	options: RunParallelOptions,
): Promise<RunParallelResult> {
	if (options.subTasks.length === 0)
		throw new Error("runParallelTask: no subTasks");
	const store = new LedgerStore(options.dbPath);
	try {
		return await runWithStore(store, options);
	} finally {
		store.close();
	}
}

async function runWithStore(
	store: LedgerStore,
	options: RunParallelOptions,
): Promise<RunParallelResult> {
	const env = options.environmentDriver ?? new HostEnvironmentDriver();
	// R4: events flow AFTER their ledger mutation — subscribers reading
	// getTaskState already see the row the event announces.
	const gateway = options.gateway ?? new InMemoryTaskGateway({ store });
	// Trigger half of the plugin contract: registerTriggers-style plugins
	// subscribe through the SAME gateway the pipeline emits into, BEFORE
	// the first event fires — per-plugin isolation keeps a throwing
	// registerTriggers from blocking later registrations.
	const pluginHookCtx =
		options.onPluginHookError === undefined
			? undefined
			: { onHookError: options.onPluginHookError };
	if ((options.plugins?.length ?? 0) > 0) {
		registerPluginTriggers(
			(plugin) => plugin.registerTriggers?.(gateway),
			options.plugins ?? [],
			pluginHookCtx,
		);
	}

	// Validate every spec BEFORE provisioning anything (fail fast, typed).
	const parsed = options.subTasks.map((spec) => parseTaskSpec(spec));
	mkdirSync(options.artifactsDir, { recursive: true });

	const familyBase = deriveTaskId(
		parsed.map((p) => p.goal).join("\n"),
		options.projectDir,
	);

	// M5: task-base runs REQUIRE a TaskBaseWorkspaceDriver — a driver
	// lacking prepareIntegrationBase/combine/materialize fails TYPED here
	// instead of TypeError at combine time.
	const isTaskBase =
		options.workspaceDriver.integrationMode === undefined ||
		options.workspaceDriver.integrationMode === "task-base";
	let taskBase: TaskBaseWorkspaceDriver | undefined;
	if (isTaskBase) {
		const candidate =
			options.workspaceDriver as Partial<TaskBaseWorkspaceDriver>;
		if (
			!candidate.prepareIntegrationBase ||
			!candidate.combine ||
			!candidate.materialize
		) {
			throw new Error(
				`runParallelTask: workspace driver "${options.workspaceDriver.name}" does not support ` +
					"task-base integration (missing prepareIntegrationBase/combine/materialize)",
			);
		}
		taskBase = candidate as TaskBaseWorkspaceDriver;
	}

	// Attempt-discriminated ids FIRST (review M1/P0): every re-run of the
	// same specs gets fresh ledger rows and fresh jj workspace names —
	// before any repo mutation (an orphan AI base must be impossible).
	const aggregateId = resolveAttemptId(store, `${familyBase}-p`);
	const attemptNumber = attemptNumberOf(aggregateId);
	const workerIds = parsed.map((_p, i) =>
		attemptNumber === 1
			? `${familyBase}-${i}`
			: `${familyBase}-${i}-a${attemptNumber}`,
	);

	store.insertTask({
		id: aggregateId,
		goal: parsed[0]?.goal ?? "parallel",
		planMode: null,
	});
	store.setTaskStatus(aggregateId, "executing");
	gateway.emit({ type: "task.queued", taskId: aggregateId });
	const contexts: WorkspaceContext[] = [];
	for (let i = 0; i < options.subTasks.length; i += 1) {
		store.insertTask({
			id: workerIds[i]!,
			goal: parsed[i]?.goal ?? `worker ${i}`,
		});
		store.setTaskStatus(workerIds[i]!, "executing");
		gateway.emit({ type: "task.queued", taskId: workerIds[i]! });
		contexts.push(await options.workspaceDriver.createWorkspace(workerIds[i]!));
	}

	// Provision: fetch/guards, then the AI-authored base — only after the
	// ledger accepted this attempt (a doomed run cannot litter the repo).
	await options.workspaceDriver.prepare?.();
	let baseChangeId: string | undefined;
	if (taskBase) {
		baseChangeId = await taskBase.prepareIntegrationBase(
			parsed[0]?.goal ?? "parallel task",
		);
	}

	for (const ctx of contexts) {
		store.insertMicroSession({
			id: `${ctx.taskId}-worker`,
			taskId: ctx.taskId,
			role: "worker",
		});
	}

	// Spawn + drive every worker concurrently under its own watchdogs.
	const observations: WorkerObservation[] = contexts.map(() => ({
		lastEvent: undefined,
		turns: 0,
		watchdogAbort: undefined,
	}));
	const host = options.host ?? createSessionHost();
	const handles = await Promise.all(
		contexts.map(async (_ctx, i) => {
			const handle = await host.spawn({
				role: `worker-${i}`,
				modelId: options.model,
				cwd: contexts[i]!.hostPath,
				systemPrompt: buildWorkerSystemPrompt(options.subTasks[i]!),
				...(options.sessionTimeoutMs === undefined
					? {}
					: { timeoutMs: options.sessionTimeoutMs }),
			});
			gateway.emit({
				type: "session.spawned",
				taskId: contexts[i]!.taskId,
				sessionId: `${contexts[i]!.taskId}-worker`,
			});
			handle.subscribe((event) => {
				options.onEvent?.(i, event);
				const obs = observations[i]!;
				if (event.type === "turnStart") obs.turns += 1;
				obs.lastEvent = event;
			});
			return handle;
		}),
	);
	const watchdogHandles = handles.map((h, i) =>
		attachWatchdogs(h, {
			...(options.sessionTimeoutMs === undefined
				? {}
				: { limits: { wallTimeoutMs: options.sessionTimeoutMs } }),
			onAction: (action) => {
				if (action.kind === "abort") observations[i]!.watchdogAbort = action;
			},
		}),
	);

	const promptTexts = parsed.map((p) =>
		[
			`Goal: ${p.goal}`,
			`Requirements (${p.requirements.length}):`,
			...p.requirements.map((r, i) => `${i + 1}. ${r}`),
			"When done, call yield.",
		].join("\n"),
	);

	const promptResults = await Promise.allSettled(
		handles.map((h, i) => h.prompt(promptTexts[i]!)),
	);
	// NFR-3: capture every attempt's measured usage while its session is
	// still live — even failed attempts get their real numbers; a
	// rejecting stats() zeroes inside collectUsage.
	const groundings = options.subTasks.map((spec) =>
		estimateGroundingTokens(buildWorkerSystemPrompt(spec), spec),
	);
	const usages = await Promise.all(
		handles.map((h, i) => collectUsage(h, groundings[i]!)),
	);
	for (const h of handles) h.close();
	for (const w of watchdogHandles) w.dispose();

	// Per-worker receipts: failed attempts named first.
	const perWorker: TaskReceipt[] = contexts.map((ctx, i) => {
		const settled = promptResults[i]!;
		const yieldPayload =
			settled.status === "fulfilled" ? handles[i]?.result : undefined;
		const obs = observations[i]!;
		if (settled.status === "rejected" || obs.watchdogAbort || !yieldPayload) {
			const cause = obs.watchdogAbort
				? `worker ${i} watchdog abort: ${obs.watchdogAbort.reason}`
				: settled.status === "rejected"
					? `worker ${i} prompt failed: ${String(settled.reason)}`
					: `worker ${i} settled without yield`;
			writeFailureArtifact({
				artifactsDir: options.artifactsDir,
				runId: ctx.taskId,
				cause,
				lastTool: "session",
			});
			gateway.emit({
				type: "session.exhausted",
				taskId: ctx.taskId,
				sessionId: `${ctx.taskId}-worker`,
			});
			return makeReceipt(ctx.taskId, "failed", 0, [], obs.turns, usages[i]);
		}
		const receipt = makeReceipt(
			ctx.taskId,
			"ship",
			yieldPayload.files_changed.length,
			yieldPayload.commit_ids,
			obs.turns,
			usages[i],
		);
		store.setTaskStatus(ctx.taskId, "completed");
		store.setSessionStatus(
			`${ctx.taskId}-worker`,
			"yielded",
			JSON.stringify(yieldPayload),
		);
		gateway.emit({
			type: "session.yielded",
			taskId: ctx.taskId,
			sessionId: `${ctx.taskId}-worker`,
		});
		return receipt;
	});
	for (let i = 0; i < contexts.length; i += 1) {
		if (perWorker[i]!.verdict === "failed") {
			store.setTaskStatus(contexts[i]!.taskId, "failed");
		}
	}
	for (const receipt of perWorker) {
		if (receipt.verdict === "ship") {
			gateway.emit({
				type: "task.completed",
				taskId: receipt.taskId,
				sessionId: `${receipt.taskId}-worker`,
				detail: { verdict: "ship" },
			});
		} else {
			gateway.emit({
				type: "task.failed",
				taskId: receipt.taskId,
				sessionId: `${receipt.taskId}-worker`,
				detail: { cause: "worker attempt failed" },
			});
		}
	}

	// ── Integrate. ────────────────────────────────────────────────────────
	const anyFailed = perWorker.some((r) => r.verdict !== "ship");

	if (!baseChangeId) {
		// Feature-branch mode: bookmarks only; no automatic integration.
		const published =
			(await options.workspaceDriver.publishBookmarks?.(contexts)) ?? [];
		for (const ctx of contexts)
			await options.workspaceDriver.cleanupWorkspace?.(ctx);
		store.setTaskStatus(aggregateId, anyFailed ? "failed" : "completed");
		if (anyFailed) {
			gateway.emit({
				type: "task.failed",
				taskId: aggregateId,
				sessionId: `${aggregateId}-worker`,
				detail: { cause: "one or more workers failed" },
			});
		} else {
			gateway.emit({
				type: "task.completed",
				taskId: aggregateId,
				sessionId: `${aggregateId}-worker`,
				detail: { verdict: "ship" },
			});
		}
		return {
			aggregate: makeReceipt(
				aggregateId,
				anyFailed ? "failed" : "ship",
				0,
				published,
				observations.reduce((a, o) => a + o.turns, 0),
				sumUsage(usages),
			),
			perWorker,
			conflicts: [],
		};
	}

	const healthyContexts = contexts.filter(
		(_c, i) => perWorker[i]!.verdict === "ship",
	);

	/** Best-effort recovery snapshot of every PRESERVED workspace (M3). */
	const recoverySnapshot = async () => ({
		baseChangeId,
		workspaces: await Promise.all(
			contexts.map(async (c) => {
				let commitId: string | undefined;
				try {
					commitId = await workspaceCommitId(options.projectDir, c.branchName);
				} catch {
					commitId = undefined;
				}
				return { name: c.branchName, path: c.hostPath, commitId };
			}),
		),
		steps: [
			"jj log -r all() --no-graph   # locate worker commits + merged base",
			"...stack each preserved workspace onto the base (jj rebase), then squash",
			"...resolve residual conflicts by hand, then jj new <merged base>",
		],
	});

	// M3: hard ladder failures are CAPTURED — recovery artifact, terminal
	// ledger rows, typed failed result — never a bare escape freezing
	// 'executing'.
	let combineOutcome;
	try {
		combineOutcome = await taskBase!.combine(baseChangeId, healthyContexts);
	} catch (err) {
		const cause = `merge ladder failed: ${err instanceof Error ? err.message : String(err)}`;
		writeFailureArtifact({
			artifactsDir: options.artifactsDir,
			runId: aggregateId,
			cause,
			recovery: await recoverySnapshot(),
		});
		store.setTaskStatus(aggregateId, "failed");
		for (const ctx of contexts) store.setTaskStatus(ctx.taskId, "failed");
		gateway.emit({
			type: "task.failed",
			taskId: aggregateId,
			sessionId: `${aggregateId}-worker`,
			detail: { cause },
		});
		return {
			aggregate: makeReceipt(aggregateId, "failed", 0, [], 0, sumUsage(usages)),
			perWorker,
			conflicts: [],
		};
	}

	// M4: yielded workers sit in `verifying` until the aggregate ships —
	// no completed children under a failed parent.
	for (const ctx of healthyContexts)
		store.setTaskStatus(ctx.taskId, "verifying");
	gateway.emit({
		type: "merge.completed",
		taskId: aggregateId,
		detail: { commitId: combineOutcome.commitId },
	});

	if (combineOutcome.conflicts.length > 0) {
		// Escalation: residual conflicts after deterministic union. Preserve
		// everything; the operator resolves by hand (contract §3.5 rung 3).
		writeFailureArtifact({
			artifactsDir: options.artifactsDir,
			runId: aggregateId,
			cause: `residual merge conflicts after union resolution: ${combineOutcome.conflicts.join(", ")}`,
			lastEvent: `preserved workspaces: ${healthyContexts.map((c) => `${c.branchName} @ ${c.hostPath}`).join("; ")}`,
			recovery: await recoverySnapshot(),
		});
		store.setTaskStatus(aggregateId, "escalated");
		for (const ctx of healthyContexts)
			store.setTaskStatus(ctx.taskId, "failed");
		store.recordRoutingFeedback(
			options.projectDir.split("/").pop() ?? options.projectDir,
			"cold",
			0,
		);
		gateway.emit({
			type: "merge.conflict",
			taskId: aggregateId,
			detail: { conflicts: combineOutcome.conflicts },
		});
		gateway.emit({
			type: "task.escalated",
			taskId: aggregateId,
			sessionId: `${aggregateId}-worker`,
			detail: { verdict: "escalate" },
		});
		return {
			aggregate: makeReceipt(
				aggregateId,
				"escalate",
				combineOutcome.filesChanged,
				[combineOutcome.commitId],
				0,
				sumUsage(usages),
			),
			perWorker,
			mergedCommitId: combineOutcome.commitId,
			conflicts: combineOutcome.conflicts,
		};
	}

	// Materialize the merged tree and verify ONCE, through the environment
	// driver (FR-6: the gate runs on the integrated tree, not a snapshot).
	// M6: the runner's full semantics (suite wall, bounded grace, capped
	// tails) now execute THROUGH the environment ladder.
	await taskBase!.materialize(baseChangeId);
	const allCommands = parsed.flatMap((p) => p.verificationCommands);
	const failures: string[] = [];
	let verifyStderrTail: string | undefined;
	const verification = await verifyThroughEnvironment(
		env,
		options.projectDir,
		allCommands,
	);
	gateway.emit({
		type: "verify.completed",
		taskId: aggregateId,
		detail: {
			passed:
				failures.length === 0 &&
				verification.commands.length >= allCommands.length,
		},
	});
	for (const cmd of verification.commands) {
		if (cmd.exitCode !== 0) {
			failures.push(
				`${cmd.command} (exit ${cmd.exitCode}${cmd.timedOut ? ", timed out" : ""})`,
			);
			verifyStderrTail = verifyStderrTail ?? cmd.stderrTail;
		}
	}
	if (verification.commands.length < allCommands.length) {
		failures.push(
			`suite wall expired — ${allCommands.length - verification.commands.length} command(s) never ran`,
		);
	}

	// Gate-ordered cleanup (v1 semantics): healthy workspaces are removed
	// only after the consistency gate AND verification passed. Failed or
	// escalated runs PRESERVE their workspaces and name them in the artifact.
	const cleanupHealthy = async (): Promise<void> => {
		for (const ctx of healthyContexts)
			await options.workspaceDriver.cleanupWorkspace?.(ctx);
	};

	if (anyFailed || failures.length > 0) {
		writeFailureArtifact({
			artifactsDir: options.artifactsDir,
			runId: aggregateId,
			cause:
				failures.length > 0
					? `verification failed: ${failures.join("; ")}`
					: "one or more workers failed",
			stderrTail: verifyStderrTail,
			lastEvent: `stranded/preserved workspaces: ${contexts.map((c) => `${c.branchName} @ ${c.hostPath}`).join("; ")}`,
			recovery: await recoverySnapshot(),
		});
		store.setTaskStatus(aggregateId, "failed");
		const repoKey = options.projectDir.split("/").pop() ?? options.projectDir;
		store.recordRoutingFeedback(repoKey, "cold", 0);
		for (const ctx of healthyContexts)
			store.setTaskStatus(ctx.taskId, "failed");
		gateway.emit({
			type: "task.failed",
			taskId: aggregateId,
			sessionId: `${aggregateId}-worker`,
			detail: {
				cause:
					failures.length > 0
						? "verification failed"
						: "one or more workers failed",
			},
		});
		return {
			aggregate: makeReceipt(
				aggregateId,
				"failed",
				combineOutcome.filesChanged,
				[combineOutcome.commitId],
				0,
				sumUsage(usages),
			),
			perWorker,
			mergedCommitId: combineOutcome.commitId,
			conflicts: [],
		};
	}

	await cleanupHealthy();
	for (const ctx of healthyContexts)
		store.setTaskStatus(ctx.taskId, "completed");
	store.recordRoutingFeedback(
		options.projectDir.split("/").pop() ?? options.projectDir,
		"task-base",
		1,
	);
	store.setTaskStatus(aggregateId, "completed");
	gateway.emit({
		type: "task.completed",
		taskId: aggregateId,
		sessionId: `${aggregateId}-worker`,
		detail: { verdict: "ship" },
	});
	return {
		aggregate: makeReceipt(
			aggregateId,
			"ship",
			perWorker.reduce((a, r) => a + r.filesChanged, 0),
			[combineOutcome.commitId],
			observations.reduce((a, o) => a + o.turns, 0),
			sumUsage(usages),
		),
		perWorker,
		mergedCommitId: combineOutcome.commitId,
		conflicts: [],
	};
}

// Re-export for callers composing parallel runs with single-run validation.
export { SpecValidationError };
