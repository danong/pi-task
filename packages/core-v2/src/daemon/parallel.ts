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
	WorkspaceFinalization,
	Yield,
} from "../contracts/index.ts";
import { acceptArtifacts } from "../contracts/index.ts";
import type { TaskReceipt } from "../contracts/index.ts";
import { writeFailureArtifact } from "../guards/artifacts.ts";
import {
	attachWatchdogs,
	type WatchdogEnd,
} from "../guards/watchdog-driver.ts";

import { workspaceCommitId } from "../workspaces/jj.ts";
import {
	serializeParallelRecovery,
	type ParallelRecoveryInfo,
} from "../workspaces/failure-hygiene.ts";
import { LedgerStore } from "../ledger/store.ts";
import type { TaskGateway } from "../contracts/index.ts";
import type { TaskPlugin } from "../contracts/task-plugin.ts";
import type { ContextAcquisitionFactory } from "../contracts/context-lifecycle.ts";
import { rawContextAcquisitionFactory } from "../context/raw-provider.ts";
import { assembleContext } from "../context/assembler.ts";
import { deriveInformationNeeds, planContext } from "../context/planner.ts";
import { startExecutionEpoch } from "../context/epoch.ts";
import type { ContextPlan } from "../contracts/context-lifecycle.ts";
import type { ContextArtifactStore } from "../context/artifact-store.ts";
import type { SessionHostEvent } from "../sessions/host.ts";
import { InMemoryTaskGateway } from "../gateway/index.ts";
import { registerPluginTriggers } from "../plugins/index.ts";
import { HostEnvironmentDriver } from "../environments/drivers.ts";
import { verifyThroughEnvironment } from "../verify/adapter.ts";
import {
	createSessionHost,
	workerToolSchemaIdentity,
	type SessionHost,
} from "../sessions/host.ts";
import {
	buildWorkerPromptText,
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
	onEvent?: (workerIndex: number, event: SessionHostEvent) => void;
	/** Single-task composition reuses this core without parallel identities. */
	singleTask?: boolean;
	/** Explicit acquisition/materialization capability; raw is the default. */
	contextCapabilitiesFactory?: ContextAcquisitionFactory;
	/** Optional user-state artifact store. Raw execution never requires it. */
	contextArtifactStore?: ContextArtifactStore;
	/** Canonical trace projection for context lifecycle evidence. */
	onContextEvent?: (event: ContextEvidenceEvent) => void;
}

export interface ContextEvidenceEvent {
	type:
		| "context.planned"
		| "context.selected"
		| "context.injected"
		| "context.omitted"
		| "context.cache"
		| "checkpoint.saved"
		| "epoch.started"
		| "epoch.transitioned";
	provider: { id: string; version: string };
	detail: Record<string, unknown>;
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

	const singleTask = options.singleTask === true;
	const familyBase = singleTask
		? deriveTaskId(options.subTasks[0]!, options.projectDir)
		: deriveTaskId(parsed.map((p) => p.goal).join("\n"), options.projectDir);

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
	const aggregateId = resolveAttemptId(
		store,
		singleTask ? familyBase : `${familyBase}-p`,
	);
	const attemptNumber = attemptNumberOf(aggregateId);
	const workerIds = singleTask
		? [aggregateId]
		: parsed.map((_p, i) =>
				attemptNumber === 1
					? `${familyBase}-${i}`
					: `${familyBase}-${i}-a${attemptNumber}`,
			);

	store.insertTask({
		id: aggregateId,
		goal: parsed[0]?.goal ?? (singleTask ? "task" : "parallel"),
		planMode: null,
	});
	store.setTaskStatus(aggregateId, "executing");
	gateway.emit({ type: "task.queued", taskId: aggregateId });

	// Compile one bounded initial artifact from the validated task before any
	// worker session is spawned. Index/retrieval failure is an explicit raw
	// fallback, never a task failure.
	const requestedFactory =
		options.contextCapabilitiesFactory ?? rawContextAcquisitionFactory;
	const requestedIdentity = requestedFactory.identity;
	let contextCapabilities = rawContextAcquisitionFactory.create({
		root: options.projectDir,
		sourceRevision: aggregateId,
	});
	let contextItems: Awaited<
		ReturnType<typeof contextCapabilities.candidates.acquire>
	> = [];
	const contextGoal = parsed[0]?.goal ?? "task";
	const contextRequirements = parsed.flatMap((item) => item.requirements);
	const informationNeeds = deriveInformationNeeds({
		goal: contextGoal,
		requirements: contextRequirements,
	}).needs;
	try {
		contextCapabilities = requestedFactory.create({
			root: options.projectDir,
			sourceRevision: aggregateId,
		});
		contextItems = await contextCapabilities.candidates.acquire({
			root: options.projectDir,
			sourceRevision: aggregateId,
			needs: informationNeeds,
		});
	} catch (error) {
		contextCapabilities = rawContextAcquisitionFactory.create({
			root: options.projectDir,
			sourceRevision: aggregateId,
		});
		contextItems = [];
		options.onContextEvent?.({
			type: "context.omitted",
			provider: contextCapabilities.identity,
			detail: {
				failureCode: "provider_failed",
				requestedProvider: requestedIdentity.id,
				requestedVersion: requestedIdentity.version,
				fallbackProvider: contextCapabilities.identity.id,
				message:
					error instanceof Error
						? error.message.slice(0, 256)
						: String(error).slice(0, 256),
				selectedCount: 0,
				omittedCount: 0,
				estimatedCharacters: 0,
				estimatedTokens: 0,
			},
		});
	}
	const sourceRevision =
		contextItems[0]?.provenance.sourceRevision ??
		`unindexed:${contextCapabilities.identity.id}`;
	const contextPlan = planContext({
		goal: contextGoal,
		requirements: contextRequirements,
		candidates: contextItems,
		sourceRevision,
		modelId: options.model,
		toolSchemaIdentity: parsed
			.map((task) => workerToolSchemaIdentity(task.requirements.length))
			.join("|"),
		mode: contextCapabilities.identity.id === "raw" ? "raw" : "managed",
	});
	// Compatibility-shaped evidence is ledger/trace metadata only; lifecycle
	// decisions above use the explicit capabilities and ContextItems.
	const contextProvider = { identity: contextCapabilities.identity };
	const contextArtifact = {
		source: { treeIdentity: sourceRevision, sourceRevision },
		handles: contextPlan.selected,
		omissions: {
			count: contextPlan.omissions.length,
			reasons: [...new Set(contextPlan.omissions.map((entry) => entry.reason))],
		},
		estimatedSize: {
			characters: contextPlan.selected.reduce(
				(sum, item) => sum + item.size.characters,
				0,
			),
			tokens: contextPlan.selected.reduce(
				(sum, item) => sum + item.size.tokens,
				0,
			),
		},
	};
	let storedContextArtifactId: string | undefined;
	let storedPlanId: string | undefined;
	if (
		contextCapabilities.identity.id !== "raw" &&
		options.contextArtifactStore !== undefined
	) {
		try {
			const contextRef = options.contextArtifactStore.putJson(contextItems, {
				namespace: "context",
				kind: "context",
				mediaType: "application/json",
				sensitivity: "internal",
				sourceRevision,
			});
			const planRef = options.contextArtifactStore.putJson(contextPlan, {
				namespace: "plan",
				kind: "plan",
				mediaType: "application/json",
				sensitivity: "internal",
				sourceRevision: contextPlan.sourceRevision,
			});
			storedContextArtifactId = contextRef.id;
			storedPlanId = planRef.id;
		} catch (error: unknown) {
			options.onContextEvent?.({
				type: "context.omitted",
				provider: contextProvider.identity,
				detail: {
					failureCode: "artifact_store_unavailable",
					message:
						error instanceof Error
							? error.message.slice(0, 256)
							: String(error).slice(0, 256),
					selectedCount: contextPlan.selected.length,
					omittedCount: contextPlan.omissions.length,
				},
			});
		}
	}
	options.onContextEvent?.({
		type: "context.planned",
		provider: contextProvider.identity,
		detail: {
			planId: contextPlan.id,
			mode: contextPlan.mode,
			selectedCount: contextPlan.selected.length,
			omittedCount: contextPlan.omissions.length,
			storedPlanId,
			storedContextArtifactId,
		},
	});
	options.onContextEvent?.({
		type: "context.cache",
		provider: contextProvider.identity,
		detail: {
			planId: contextPlan.id,
			strategy: contextPlan.cache.strategy,
			attribution: contextPlan.cache.attribution,
			compatible: contextPlan.cache.compatible,
			localStore:
				options.contextArtifactStore === undefined
					? "unavailable"
					: "available",
			storedArtifactCount: [storedPlanId, storedContextArtifactId].filter(
				(id) => id !== undefined,
			).length,
		},
	});
	options.onContextEvent?.({
		type: "context.selected",
		provider: contextProvider.identity,
		detail: {
			planId: contextPlan.id,
			treeIdentity: contextArtifact.source.treeIdentity,
			sourceRevision: contextArtifact.source.sourceRevision,
			selectedCount: contextArtifact.handles.length,
			omittedCount: contextArtifact.omissions.count,
			estimatedCharacters: contextArtifact.estimatedSize.characters,
			estimatedTokens: contextArtifact.estimatedSize.tokens,
		},
	});
	options.onContextEvent?.({
		type: "context.injected",
		provider: contextProvider.identity,
		detail: {
			planId: contextPlan.id,
			treeIdentity: contextArtifact.source.treeIdentity,
			selectedCount: contextArtifact.handles.length,
			omittedCount: contextArtifact.omissions.count,
			estimatedCharacters: contextArtifact.estimatedSize.characters,
			estimatedTokens: contextArtifact.estimatedSize.tokens,
		},
	});
	options.onContextEvent?.({
		type: "context.omitted",
		provider: contextProvider.identity,
		detail: {
			planId: contextPlan.id,
			treeIdentity: contextArtifact.source.treeIdentity,
			selectedCount: contextArtifact.handles.length,
			omittedCount: contextArtifact.omissions.count,
			reasons: contextArtifact.omissions.reasons,
			estimatedCharacters: contextArtifact.estimatedSize.characters,
			estimatedTokens: contextArtifact.estimatedSize.tokens,
		},
	});
	const contextPrompt = assembleContext({ plan: contextPlan }).prompt;
	const contexts: WorkspaceContext[] = [];
	for (let i = 0; i < options.subTasks.length; i += 1) {
		if (!singleTask) {
			store.insertTask({
				id: workerIds[i]!,
				goal: parsed[i]?.goal ?? `worker ${i}`,
			});
			store.setTaskStatus(workerIds[i]!, "executing");
			gateway.emit({ type: "task.queued", taskId: workerIds[i]! });
		}
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
	// Create workspaces from this attempt's base. A reused provider may leave
	// the main working copy on an empty child of the previous merged base.
	for (let i = 0; i < options.subTasks.length; i += 1) {
		const context = await options.workspaceDriver.createWorkspace(
			workerIds[i]!,
		);
		contexts.push(context);
		store.insertWorkspace({
			id: `${workerIds[i]}-workspace`,
			taskId: workerIds[i]!,
			driver: options.workspaceDriver.name,
			hostPath: context.hostPath,
			...(context.containerPath === undefined
				? {}
				: { containerPath: context.containerPath }),
			branchName: context.branchName,
		});
		store.setWorkspaceStatus(`${workerIds[i]}-workspace`, "active");
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
	const contextEpochs = contexts.map((_context, index) =>
		startExecutionEpoch({
			role: `worker-${index}`,
			modelId: options.model,
			plan: contextPlan,
		}),
	);
	for (const epoch of contextEpochs) {
		options.onContextEvent?.({
			type: "epoch.started",
			provider: contextProvider.identity,
			detail: {
				epochId: epoch.id,
				role: epoch.role,
				planId: epoch.planId,
				modelId: epoch.modelId,
				transition: epoch.transition,
			},
		});
	}
	const host = options.host ?? createSessionHost();
	const handles = await Promise.all(
		contexts.map(async (_ctx, i) => {
			const handle = await host.spawn({
				role: `worker-${i}`,
				modelId: options.model,
				cwd: contexts[i]!.hostPath,
				systemPrompt: `${contextPrompt}${contextPrompt.length > 0 ? "\n\n" : ""}${buildWorkerSystemPrompt(
					options.subTasks[i]!,
					parsed[i]!.requirements.length,
				)}`,
				requirementCount: parsed[i]!.requirements.length,
				contextCapabilities,
				contextFallbackCapabilities: rawContextAcquisitionFactory.create({
					root: options.projectDir,
					sourceRevision: aggregateId,
				}),
				onContextFallback: (event) =>
					options.onContextEvent?.({
						type: "context.omitted",
						provider: event.fallbackProvider,
						detail: {
							failureCode: "retrieval_failed",
							requestedProvider: event.requestedProvider.id,
							requestedVersion: event.requestedProvider.version,
							fallbackProvider: event.fallbackProvider.id,
							fallbackVersion: event.fallbackProvider.version,
							message: event.error,
							treeIdentity: "unindexed:session-fallback",
							selectedCount: 0,
							omittedCount: 0,
							estimatedCharacters: 0,
							estimatedTokens: 0,
						},
					}),
				contextPlan,
				contextEpoch: contextEpochs[i]!,
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

	const promptTexts = parsed.map((p) => buildWorkerPromptText(p));

	const promptResults = await Promise.allSettled(
		handles.map((h, i) => h.prompt(promptTexts[i]!)),
	);
	for (const [index, result] of promptResults.entries()) {
		if (result.status !== "rejected") continue;
		options.onContextEvent?.({
			type: "epoch.transitioned",
			provider: contextProvider.identity,
			detail: {
				fromEpochId: contextEpochs[index]!.id,
				role: contextEpochs[index]!.role,
				reason: "interruption",
				checkpointAvailable: false,
			},
		});
	}
	// NFR-3: capture every attempt's measured usage while its session is
	// still live — even failed attempts get their real numbers; a
	// rejecting stats() zeroes inside collectUsage.
	const groundings = options.subTasks.map((spec, i) =>
		estimateGroundingTokens(
			buildWorkerSystemPrompt(spec, parsed[i]!.requirements.length),
			spec,
		),
	);
	const usages = await Promise.all(
		handles.map((h, i) => collectUsage(h, groundings[i]!)),
	);
	// Turn starts are lifecycle observations, not a derived usage metric. Keep
	// them on every aggregate outcome even when stats() is unavailable.
	const observedTurns = observations.reduce(
		(total, observation) => total + observation.turns,
		0,
	);
	for (const h of handles) h.close();
	for (const w of watchdogHandles) w.dispose();

	// Finalization is provider-owned evidence. It runs before any integration
	// operation, so model commit/path claims never become the source of truth.
	// Providers without this optional seam retain the legacy claim-based
	// fallback; this is deliberately limited to compatibility with old/fake
	// providers and is never used when the provider supplies evidence.
	const finalizations: Array<WorkspaceFinalization | undefined> = contexts.map(
		() => undefined,
	);
	const finalizationErrors: Array<string | undefined> = contexts.map(
		() => undefined,
	);
	if (baseChangeId !== undefined && options.workspaceDriver.finalizeWorkspace) {
		const finalized = await Promise.allSettled(
			contexts.map((context) =>
				options.workspaceDriver.finalizeWorkspace!(context, baseChangeId),
			),
		);
		for (let i = 0; i < finalized.length; i += 1) {
			const result = finalized[i]!;
			if (result.status === "fulfilled") finalizations[i] = result.value;
			else
				finalizationErrors[i] =
					result.reason instanceof Error
						? result.reason.message
						: String(result.reason);
		}
	}

	const yieldPayloads: Array<Yield | undefined> = handles.map((handle, i) =>
		promptResults[i]?.status === "fulfilled" ? handle.result : undefined,
	);

	// Per-worker receipts: failed attempts named first.
	const perWorker: TaskReceipt[] = contexts.map((ctx, i) => {
		const settled = promptResults[i]!;
		const yieldPayload = yieldPayloads[i];
		const obs = observations[i]!;
		if (
			settled.status === "rejected" ||
			obs.watchdogAbort ||
			!yieldPayload ||
			finalizationErrors[i] !== undefined
		) {
			const cause =
				finalizationErrors[i] !== undefined
					? `worker ${i} finalization failed: ${finalizationErrors[i]}`
					: obs.watchdogAbort
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
		const finalization = finalizations[i];
		const receipt = makeReceipt(
			ctx.taskId,
			"ship",
			finalization?.changedPaths.length ?? yieldPayload.files_changed.length,
			finalization === undefined
				? yieldPayload.commit_ids
				: [finalization.commitId],
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
	if (!singleTask) {
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
					detail: {
						cause: "worker attempt failed",
						stage: "session",
						code: "worker_failed",
					},
				});
			}
		}
	}

	// ── Integrate. ────────────────────────────────────────────────────────
	const anyFailed = perWorker.some((r) => r.verdict !== "ship");

	if (!baseChangeId) {
		// Feature-branch mode: bookmarks only; no automatic integration.
		const published =
			(await options.workspaceDriver.publishBookmarks?.(contexts)) ?? [];
		for (const ctx of contexts) {
			await options.workspaceDriver.cleanupWorkspace?.(ctx);
			store.setWorkspaceStatus(`${ctx.taskId}-workspace`, "released");
		}
		store.setTaskStatus(aggregateId, anyFailed ? "failed" : "completed");
		if (anyFailed) {
			gateway.emit({
				type: "task.failed",
				taskId: aggregateId,
				sessionId: `${aggregateId}-worker`,
				detail: {
					cause: "one or more workers failed",
					stage: "session",
					code: "worker_failed",
				},
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
				observedTurns,
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

	/**
	 * Failure-artifact contract rules 1–6, engine-side reconciliation: run
	 * the driver's post-mortem (describe dirty snapshots as rescue commits,
	 * stack every workspace chain onto the dispatch base, abandon only
	 * engine-authored empty stubs, forget consumed workspaces) and serialize
	 * the machine-readable result into the artifact's recovery steps.
	 * Best-effort — never masks the original failure.
	 */
	const reconcileFailedRun = async (
		cause: string,
	): Promise<ReturnType<typeof recoverySnapshot>> => {
		const snapshot = await recoverySnapshot();
		try {
			const taskBaseDriver = options.workspaceDriver as Partial<{
				recoverFailedRun: (o: {
					workspaceNames: string[];
					cause: string;
					workspaceDirs?: Record<string, string>;
				}) => Promise<ParallelRecoveryInfo>;
			}>;
			if (taskBaseDriver.recoverFailedRun === undefined) return snapshot;
			const dirs: Record<string, string> = {};
			for (const c of contexts) dirs[c.branchName] = c.hostPath;
			const info = await taskBaseDriver.recoverFailedRun({
				workspaceNames: contexts.map((c) => c.branchName),
				cause,
				workspaceDirs: dirs,
			});
			return { ...snapshot, steps: [serializeParallelRecovery(info)] };
		} catch {
			// Degrade toward the scripted snapshot — preservation > movement.
			return snapshot;
		}
	};

	// M3: hard ladder failures are CAPTURED — recovery artifact, terminal
	// ledger rows, typed failed result — never a bare escape freezing
	// 'executing'.
	let combineOutcome;
	try {
		combineOutcome = await taskBase!.combine(baseChangeId, healthyContexts);
	} catch (err) {
		const cause = `merge ladder failed: ${err instanceof Error ? err.message : String(err)}`;
		for (const ctx of contexts)
			store.setWorkspaceStatus(`${ctx.taskId}-workspace`, "orphaned");
		writeFailureArtifact({
			artifactsDir: options.artifactsDir,
			runId: aggregateId,
			cause,
			recovery: await reconcileFailedRun(cause),
		});
		store.setTaskStatus(aggregateId, "failed");
		for (const ctx of contexts) store.setTaskStatus(ctx.taskId, "failed");
		gateway.emit({
			type: "task.failed",
			taskId: aggregateId,
			sessionId: `${aggregateId}-worker`,
			detail: { cause, stage: "workspace", code: "merge_failed" },
		});
		return {
			aggregate: makeReceipt(
				aggregateId,
				"failed",
				0,
				[],
				observedTurns,
				sumUsage(usages),
			),
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
		for (const ctx of contexts)
			store.setWorkspaceStatus(`${ctx.taskId}-workspace`, "orphaned");
		writeFailureArtifact({
			artifactsDir: options.artifactsDir,
			runId: aggregateId,
			cause: `residual merge conflicts after union resolution: ${combineOutcome.conflicts.join(", ")}`,
			lastEvent: `preserved workspaces: ${healthyContexts.map((c) => `${c.branchName} @ ${c.hostPath}`).join("; ")}`,
			recovery: await reconcileFailedRun(
				`residual merge conflicts: ${combineOutcome.conflicts.join(", ")}`,
			),
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
				observedTurns,
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
		detail: { passed: verification.passed, evidence: verification.evidence },
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

	// Content acceptance consumes only provider evidence after integration. A
	// combine implementation from before this seam has no path evidence, so
	// legacy/fake providers fall back to their yield claims and combine count.
	// The real jj provider supplies all three authoritative lists, including D.
	const finalizedChangedPaths = [
		...new Set(finalizations.flatMap((f) => f?.changedPaths ?? [])),
	].sort();
	const authoritativeChangedPaths =
		combineOutcome.changedPaths ??
		(finalizedChangedPaths.length > 0 || finalizations.some(Boolean)
			? finalizedChangedPaths
			: [
					...new Set(yieldPayloads.flatMap((y) => y?.files_changed ?? [])),
				].sort());
	const authoritativePresentFiles =
		combineOutcome.presentFiles ??
		[...new Set(finalizations.flatMap((f) => f?.presentFiles ?? []))].sort();
	const authoritativeDeletedFiles =
		combineOutcome.deletedFiles ??
		[...new Set(finalizations.flatMap((f) => f?.deletedFiles ?? []))].sort();
	const claimedFiles = [
		...new Set(yieldPayloads.flatMap((y) => y?.files_changed ?? [])),
	].sort();
	const contentAcceptance = acceptArtifacts({
		policy: parsed[0]!.artifactPolicy,
		claimedFiles,
		actualFiles: authoritativeChangedPaths,
		presentFiles:
			authoritativePresentFiles.length > 0
				? authoritativePresentFiles
				: authoritativeChangedPaths,
		deletedFiles: authoritativeDeletedFiles,
		hasIntegratedChange:
			combineOutcome.changedPaths !== undefined
				? authoritativeChangedPaths.length > 0
				: combineOutcome.filesChanged > 0 ||
					authoritativeChangedPaths.length > 0,
		commitId: combineOutcome.commitId,
		verificationPassed: verification.passed,
	});
	const contentRejected =
		!anyFailed && failures.length === 0 && !contentAcceptance.accepted;
	const contentFailureCause = contentRejected
		? `content acceptance rejected: ${contentAcceptance.reasons
				.map((reason) => `${reason.code}: ${reason.detail}`)
				.join("; ")}`
		: undefined;

	// Gate-ordered cleanup (v1 semantics): healthy workspaces are removed
	// only after the consistency gate AND verification passed. Failed or
	// escalated runs PRESERVE their workspaces and name them in the artifact.
	const cleanupHealthy = async (): Promise<void> => {
		for (const ctx of healthyContexts) {
			await options.workspaceDriver.cleanupWorkspace?.(ctx);
			store.setWorkspaceStatus(`${ctx.taskId}-workspace`, "released");
		}
	};

	if (anyFailed || failures.length > 0 || contentRejected) {
		const finalizationFailureDetail = finalizationErrors
			.filter((error): error is string => error !== undefined)
			.join("; ");
		const cause =
			contentFailureCause ??
			(failures.length > 0
				? `verification failed: ${failures.join("; ")}`
				: finalizationFailureDetail.length > 0
					? `one or more workers failed: ${finalizationFailureDetail}`
					: "one or more workers failed");
		for (const ctx of contexts)
			store.setWorkspaceStatus(`${ctx.taskId}-workspace`, "orphaned");
		writeFailureArtifact({
			artifactsDir: options.artifactsDir,
			runId: aggregateId,
			cause,
			stderrTail: verifyStderrTail,
			lastEvent: `stranded/preserved workspaces: ${contexts.map((c) => `${c.branchName} @ ${c.hostPath}`).join("; ")}`,
			recovery: await reconcileFailedRun(cause),
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
				cause,
				stage:
					contentFailureCause !== undefined
						? "acceptance"
						: failures.length > 0
							? "verification"
							: "session",
				code:
					contentFailureCause !== undefined
						? "artifact_rejected"
						: failures.length > 0
							? "verification_failed"
							: "worker_failed",
			},
		});
		return {
			aggregate: makeReceipt(
				aggregateId,
				"failed",
				authoritativeChangedPaths.length,
				[combineOutcome.commitId],
				observedTurns,
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
			authoritativeChangedPaths.length,
			[combineOutcome.commitId],
			observedTurns,
			sumUsage(usages),
		),
		perWorker,
		mergedCommitId: combineOutcome.commitId,
		conflicts: [],
	};
}

// Re-export for callers composing parallel runs with single-run validation.
export { SpecValidationError };
