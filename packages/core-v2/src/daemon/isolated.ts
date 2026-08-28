/**
 * Single-task composition for the runnable v2 slice.
 *
 * The parallel provider already owns workspace creation, atomic integration,
 * post-merge verification, and failure recovery. This seam deliberately
 * supplies exactly one spec to that provider so the shell does not copy any
 * execution policy or jj lifecycle rules.
 */

import type {
	EnvironmentDriver,
	TaskGateway,
	TaskReceipt,
	WorkspaceDriver,
} from "../contracts/index.ts";
import type { SessionHost, SessionHostEvent } from "../sessions/host.ts";
import {
	runParallelTask,
	type RunParallelOptions,
} from "./parallel.ts";

export interface RunIsolatedTaskOptions extends Omit<
	RunParallelOptions,
	"subTasks" | "onEvent"
> {
	specMarkdown: string;
	onEvent?: ((event: SessionHostEvent) => void) | undefined;
}

export interface RunIsolatedTaskResult {
	/** The only user-facing receipt for this single-task run. */
	receipt: TaskReceipt;
	conflicts: string[];
	interruption?: { reason: "budget_exceeded" | "wall_timeout" | "no_progress" | "tool_timeout" | "settled_without_yield" };
	mergedCommitId?: string;
}

/** Execute exactly one worker through the existing workspace provider.
 * Sequential composition supplies its durable task/workspace overrides through
 * this same adapter; it never creates a second session/workspace loop. */
export async function runIsolatedTask(
	options: RunIsolatedTaskOptions,
): Promise<RunIsolatedTaskResult> {
	const result = await runParallelTask({
		...options,
		subTasks: [options.specMarkdown],
		singleTask: true,
		onEvent: (_workerIndex, event) => options.onEvent?.(event),
	});
	return {
		receipt: result.aggregate,
		conflicts: result.conflicts,
		...(result.interruption === undefined ? {} : { interruption: result.interruption }),
		...(result.mergedCommitId === undefined
			? {}
			: { mergedCommitId: result.mergedCommitId }),
	};
}

export type IsolatedTaskDependencies = Pick<
	RunIsolatedTaskOptions,
	"host" | "workspaceDriver" | "environmentDriver" | "gateway"
>;

// Keep the provider contracts visible at this seam for adapters and tests.
export type { EnvironmentDriver, SessionHost, TaskGateway, WorkspaceDriver };
