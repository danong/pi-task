/**
 * lifecycle-collector — trigger/event-style extraction (R1/R5).
 *
 * MOVED FROM CORE: two behaviors previously lived INLINED in
 * src/daemon/task-runner.ts:
 *
 *   1. `describeTool` — the `tool:${name}` descriptor used by the failure
 *      artifact path (`lastTool: describeTool(observation.lastTool)`),
 *      plus the observation bookkeeping that fed it (the subscribe-side
 *      `if (event.type === "toolEnd") observation.lastTool = ...` line).
 *   2. The generic "record every lifecycle event" observability loop the
 *      daemon inlined as ad-hoc pushes onto local arrays.
 *
 * Now the core emits lifecycle events through the M4b gateway and this
 * plugin subscribes via registerTriggers — the canonical gateway-
 * subscription side of the TaskPlugin seam (R4's second half). The
 * tool-descriptor formatting itself moved here verbatim.
 *
 * Responsibility table (before vs after):
 *   | Concern                       | Before (core)            | After (plugin)          |
 *   |-------------------------------|--------------------------|-------------------------|
 *   | toolEnd → lastTool capture    | inline in subscribe cb   | registerTriggers hook   |
 *   | `tool:${name}` formatting     | describeTool() helper    | moved here verbatim     |
 *   | lifecycle event journal       | ad-hoc arrays per caller | plugin-internal ring    |
 *   | throw isolation               | n/a                      | hooks.ts callIsolatedSync|
 *
 * Loaded by path from task.toml [plugins] via the M4b loader; invoked
 * through registerPluginTriggers / emitLifecycleEventToPlugins in
 * hooks.ts (throw-isolated, never crashes the pipeline).
 */

import type { EventPattern, TaskLifecycleEvent, Unsubscribe, TaskGateway, TaskPlugin } from "../../contracts/task-plugin.ts";

/** Bounded event journal — oldest entries drop off first. */
export const LIFECYCLE_COLLECTOR_MAX_EVENTS = 256;

/**
 * Human-readable descriptor of the last tool activity.
 * Moved VERBATIM from src/daemon/task-runner.ts (was `describeTool`).
 */
export function describeTool(toolName: string | undefined): string | undefined {
	return toolName === undefined ? undefined : `tool:${toolName}`;
}

/** Plugin object typed with its journal so the export keeps the extra
 *  surface without widening TaskPlugin itself. */
interface LifecycleCollectorPlugin extends TaskPlugin {
	/** Bounded journal of observed lifecycle events (oldest drops first). */
	journal: TaskLifecycleEvent[];
}

const plugin: LifecycleCollectorPlugin = {
	name: "lifecycle-collector",
	journal: [],
	registerTriggers(gateway: TaskGateway): void {
		// Subscribe to every lifecycle event via the wildcard pattern and
		// keep a bounded in-memory journal. Unsubscribe stays captured so a
		// host can detach (idempotent per the gateway contract).
		const pattern: EventPattern = "*";
		const unsubscribe: Unsubscribe = gateway.on(pattern, (event: TaskLifecycleEvent) => {
			record(plugin, event);
		});
		void unsubscribe;
	},
	onLifecycleEvent(event: TaskLifecycleEvent): void {
		// Mirror of the registerTriggers path for pipelines that fan events
		// directly through emitLifecycleEventToPlugins (task-runner does).
		record(plugin, event);
	},
};

function record(target: LifecycleCollectorPlugin, event: TaskLifecycleEvent): void {
	target.journal.push(event);
	if (target.journal.length > LIFECYCLE_COLLECTOR_MAX_EVENTS) {
		target.journal.shift();
	}
}

export default plugin;
