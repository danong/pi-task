/**
 * Parallel task pipeline — M2.d.
 *
 * Fan out N worker sessions across WorkspaceDriver-created workspaces,
 * combine deterministically (task-base mode) or bookmark (feature-branch),
 * then verify ONCE on the integrated tree through the selected
 * EnvironmentDriver (FR-6's "merged tree post-merge", FR-5 ladder).
 *
 * Receipts: one TaskReceipt per attempt (verdict mirrors that attempt) plus
 * an AGGREGATE receipt whose filesChanged sums the yields and whose
 * commitIds carries the merged base commit id. Residual merge conflicts
 * after union resolution → verdict "escalated" (the contract's third
 * outcome), never silently shipped.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { EnvironmentDriver, WorkspaceContext, WorkspaceDriver } from "../contracts/index.ts";
import type { TaskReceipt } from "../contracts/index.ts";
import { writeFailureArtifact } from "../guards/artifacts.ts";
import { attachWatchdogs, type WatchdogEnd } from "../guards/watchdog-driver.ts";
import { LedgerStore } from "../ledger/store.ts";
import { HostEnvironmentDriver } from "../environments/drivers.ts";
import {
	createSessionHost,
	SessionHostError,
	type SessionHost,
} from "../sessions/host.ts";
import { deriveTaskId, parseTaskSpec, buildWorkerSystemPrompt, resolveAttemptId, SpecValidationError } from "./task-runner.ts";

/** Receipt cost placeholder until M3 wires usage accounting. */
export const PARALLEL_COST_UNAVAILABLE = 0;

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

function makeReceipt(taskId: string, verdict: TaskReceipt["verdict"], filesChanged: number, commitIds: string[], turns: number): TaskReceipt {
	return { taskId, verdict, filesChanged, commitIds, turns, costUsd: PARALLEL_COST_UNAVAILABLE, bundleHit: null };
}

export interface RunParallelResult {
	aggregate: TaskReceipt;
	perWorker: TaskReceipt[];
	/** The combined base commit id (task-base mode; undefined in feature-branch). */
	mergedCommitId?: string;
	conflicts: string[];
}

/** Run all subtasks in parallel through the workspace driver. */
export async function runParallelTask(options: RunParallelOptions): Promise<RunParallelResult> {
	if (options.subTasks.length === 0) throw new Error("runParallelTask: no subTasks");
	const store = new LedgerStore(options.dbPath);
	try {
		return await runWithStore(store, options);
	} finally {
		store.close();
	}
}

async function runWithStore(store: LedgerStore, options: RunParallelOptions): Promise<RunParallelResult> {
	const env = options.environmentDriver ?? new HostEnvironmentDriver();

	// Validate every spec BEFORE provisioning anything (fail fast, typed).
	const parsed = options.subTasks.map((spec) => parseTaskSpec(spec));
	mkdirSync(options.artifactsDir, { recursive: true });

	const familyBase = deriveTaskId(parsed.map((p) => p.goal).join("\n"), options.projectDir);

	// Attempt-discriminated ids FIRST (review M1/P0): every re-run of the
	// same specs gets fresh ledger rows and fresh jj workspace names —
	// before any repo mutation (an orphan AI base must be impossible).
	const aggregateId = resolveAttemptId(store, `${familyBase}-p`);
	const attemptNumber = attemptNumberOf(aggregateId);
	const workerIds = parsed.map((_p, i) =>
		attemptNumber === 1 ? `${familyBase}-${i}` : `${familyBase}-${i}-a${attemptNumber}`,
	);

	store.insertTask({ id: aggregateId, goal: parsed[0]?.goal ?? "parallel", planMode: null });
	store.setTaskStatus(aggregateId, "executing");
	const contexts: WorkspaceContext[] = [];
	for (let i = 0; i < options.subTasks.length; i += 1) {
		store.insertTask({ id: workerIds[i]!, goal: parsed[i]?.goal ?? `worker ${i}` });
		store.setTaskStatus(workerIds[i]!, "executing");
		contexts.push(await options.workspaceDriver.createWorkspace(workerIds[i]!));
	}

	// Provision: fetch/guards, then the AI-authored base — only after the
	// ledger accepted this attempt (a doomed run cannot litter the repo).
	await options.workspaceDriver.prepare?.();
	let baseChangeId: string | undefined;
	if (options.workspaceDriver.integrationMode === undefined || options.workspaceDriver.integrationMode === "task-base") {
		baseChangeId = await (options.workspaceDriver.prepareIntegrationBase as NonNullable<typeof options.workspaceDriver.prepareIntegrationBase>)(
			parsed[0]?.goal ?? "parallel task",
		);
	}

	for (const ctx of contexts) {
		store.insertMicroSession({ id: `${ctx.taskId}-worker`, taskId: ctx.taskId, role: "worker" });
	}

	// Spawn + drive every worker concurrently under its own watchdogs.
	const observations: WorkerObservation[] = contexts.map(() => ({ lastEvent: undefined, turns: 0, watchdogAbort: undefined }));
	const host = options.host ?? createSessionHost();
	const handles = await Promise.all(contexts.map(async (_ctx, i) => {
		const handle = await host.spawn({
			role: `worker-${i}`,
			modelId: options.model,
			cwd: contexts[i]!.hostPath,
			systemPrompt: buildWorkerSystemPrompt(options.subTasks[i]!),
			...(options.sessionTimeoutMs === undefined ? {} : { timeoutMs: options.sessionTimeoutMs }),
		});
		handle.subscribe((event) => {
			options.onEvent?.(i, event);
			const obs = observations[i]!;
			if (event.type === "turnStart") obs.turns += 1;
			obs.lastEvent = event;
		});
		return handle;
	}));
	const watchdogHandles = handles.map((h, i) =>
		attachWatchdogs(h, {
			...(options.sessionTimeoutMs === undefined ? {} : { limits: { wallTimeoutMs: options.sessionTimeoutMs! } }),
			onAction: (action) => {
				if (action.kind === "abort") observations[i]!.watchdogAbort = action;
			},
		}),
	);

	const promptTexts = parsed.map((p) => [
		`Goal: ${p.goal}`,
		`Requirements (${p.requirements.length}):`,
		...p.requirements.map((r, i) => `${i + 1}. ${r}`),
		"When done, call yield.",
	].join("\n"));

	const promptResults = await Promise.allSettled(handles.map((h, i) => h.prompt(promptTexts[i]!)));
	for (const h of handles) h.close();
	for (const w of watchdogHandles) w.dispose();

	// Per-worker receipts: failed attempts named first.
	const perWorker: TaskReceipt[] = contexts.map((ctx, i) => {
		const settled = promptResults[i]!;
		const yieldPayload = settled.status === "fulfilled" ? handles[i]?.result : undefined;
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
			return makeReceipt(ctx.taskId, "failed", 0, [], obs.turns);
		}
		const receipt = makeReceipt(ctx.taskId, "ship", yieldPayload.files_changed.length, yieldPayload.commit_ids, obs.turns);
		store.setTaskStatus(ctx.taskId, "completed");
		store.setSessionStatus(`${ctx.taskId}-worker`, "yielded", JSON.stringify(yieldPayload));
		return receipt;
	});
	for (let i = 0; i < contexts.length; i += 1) {
		if (perWorker[i]!.verdict === "failed") store.setTaskStatus(contexts[i]!.taskId, "failed");
	}

	// ── Integrate. ────────────────────────────────────────────────────────
	const anyFailed = perWorker.some((r) => r.verdict !== "ship");

	if (!baseChangeId) {
		// Feature-branch mode: bookmarks only; no automatic integration.
		const published = (await options.workspaceDriver.publishBookmarks?.(contexts)) ?? [];
		for (const ctx of contexts) await options.workspaceDriver.cleanupWorkspace?.(ctx);
		store.setTaskStatus(aggregateId, anyFailed ? "failed" : "completed");
		return {
			aggregate: makeReceipt(aggregateId, anyFailed ? "failed" : "ship", 0, published, observations.reduce((a, o) => a + o.turns, 0)),
			perWorker,
			conflicts: [],
		};
	}

	const healthyContexts = contexts.filter((_c, i) => perWorker[i]!.verdict === "ship");
	const combineOutcome = await options.workspaceDriver.combine!(baseChangeId, healthyContexts);

	if (combineOutcome.conflicts.length > 0) {
		// Escalation: residual conflicts after deterministic union. Preserve
		// everything; the operator resolves by hand (contract §3.5 rung 3).
		writeFailureArtifact({
			artifactsDir: options.artifactsDir,
			runId: aggregateId,
			cause: `residual merge conflicts after union resolution: ${combineOutcome.conflicts.join(", ")}`,
			lastEvent: `preserved workspaces: ${healthyContexts.map((c) => `${c.branchName} @ ${c.hostPath}`).join("; ")}`,
		});
		store.setTaskStatus(aggregateId, "escalated");
		return {
			aggregate: makeReceipt(aggregateId, "escalate", 0, [combineOutcome.commitId], 0),
			perWorker,
			mergedCommitId: combineOutcome.commitId,
			conflicts: combineOutcome.conflicts,
		};
	}

	// Materialize the merged tree and verify ONCE, through the environment
	// driver (FR-6: the gate runs on the integrated tree, not a snapshot).
	await (options.workspaceDriver as { checkoutMerged?(id: string): Promise<void> }).checkoutMerged?.(baseChangeId);
	const allCommands = parsed.flatMap((p) => p.verificationCommands);
	const failures: string[] = [];
	for (const command of allCommands) {
		const result = await env.exec("/bin/bash", ["-c", command], { cwd: options.projectDir });
		if (result.exitCode !== 0) failures.push(`${command} (exit ${result.exitCode})`);
	}

	// Gate-ordered cleanup (v1 semantics): healthy workspaces are removed
	// only after the consistency gate AND verification passed. Failed or
	// escalated runs PRESERVE their workspaces and name them in the artifact.
	const cleanupHealthy = async (): Promise<void> => {
		for (const ctx of healthyContexts) await options.workspaceDriver.cleanupWorkspace?.(ctx);
	};

	if (anyFailed || failures.length > 0) {
		writeFailureArtifact({
			artifactsDir: options.artifactsDir,
			runId: aggregateId,
			cause: failures.length > 0 ? `verification failed: ${failures.join("; ")}` : "one or more workers failed",
			lastEvent: `preserved workspaces: ${healthyContexts.map((c) => `${c.branchName} @ ${c.hostPath}`).join("; ")}`,
		});
		store.setTaskStatus(aggregateId, "failed");
		return {
			aggregate: makeReceipt(aggregateId, "failed", 0, [combineOutcome.commitId], 0),
			perWorker,
			mergedCommitId: combineOutcome.commitId,
			conflicts: [],
		};
	}

	await cleanupHealthy();
	store.recordRoutingFeedback(options.projectDir.split("/").pop() ?? options.projectDir, "task-base", 1);
	store.setTaskStatus(aggregateId, "completed");
	return {
		aggregate: makeReceipt(
			aggregateId,
			"ship",
			perWorker.reduce((a, r) => a + r.filesChanged, 0),
			[combineOutcome.commitId],
			observations.reduce((a, o) => a + o.turns, 0),
		),
		perWorker,
		mergedCommitId: combineOutcome.commitId,
		conflicts: [],
	};
}

// Re-export for callers composing parallel runs with single-run validation.
export { SpecValidationError };
