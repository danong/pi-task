/**
 * Isolated plugin hook execution — subsystems §3 / R4.
 *
 * Every hook call is wrapped per-call: a throwing or rejecting plugin is
 * caught, attributed (plugin name + hook), reported through a sink
 * (console.error by default), and NEVER crashes the pipeline — the
 * untransformed value proceeds. Transformed bundles are RE-VALIDATED
 * against their zod schema so an invalid bundle can never reach the
 * prompt prefix.
 */

import { ExecutionBundleSchema } from "../contracts/payloads.ts";
import type { ExecutionBundle, HandoffBundle } from "../contracts/payloads.ts";
import { HandoffBundleSchema } from "../contracts/payloads.ts";
import type { TaskLifecycleEvent, TaskPlugin } from "../contracts/task-plugin.ts";

export interface PluginHookContext {
	/** Sink for per-hook failures (defaults to console.error). */
	onHookError?: ((err: unknown) => void) | undefined;
}

function report(ctx: PluginHookContext | undefined, err: unknown): void {
	const sink = ctx?.onHookError ?? ((e: unknown) => console.error("plugin: hook failed", e));
	sink(err);
}

async function callIsolated(
	plugin: TaskPlugin,
	hook: string,
	run: () => Promise<unknown> | unknown,
	fallback: () => unknown,
	ctx: PluginHookContext | undefined,
): Promise<unknown> {
	try {
		return await run();
	} catch (err) {
		report(ctx, new Error(`plugin "${plugin.name}" hook ${hook} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
		return fallback();
	}
}

/**
 * Run every plugin's transformExecutionBundle sequentially, each awaited,
 * re-validating the output through ExecutionBundleSchema. A throwing
 * plugin leaves the input value unchanged for the remaining chain.
 */
export async function transformExecutionBundleThrough(
	bundle: ExecutionBundle,
	plugins: readonly TaskPlugin[],
	ctx?: PluginHookContext,
): Promise<ExecutionBundle> {
	let current = bundle;
	for (const plugin of plugins) {
		if (!plugin.transformExecutionBundle) continue;
		current = await callIsolated(
			plugin,
			"transformExecutionBundle",
			async () => ExecutionBundleSchema.parse(await plugin.transformExecutionBundle!(current)),
			() => current,
			ctx,
		) as ExecutionBundle;
	}
	return current;
}

/**
 * Run every plugin's transformHandoff sequentially, each awaited,
 * re-validating the output through HandoffBundleSchema. A throwing
 * plugin leaves the input value unchanged for the remaining chain.
 */
export async function transformHandoffThrough(
	handoff: HandoffBundle,
	plugins: readonly TaskPlugin[],
	ctx?: PluginHookContext,
): Promise<HandoffBundle> {
	let current = handoff;
	for (const plugin of plugins) {
		if (!plugin.transformHandoff) continue;
		current = await callIsolated(
			plugin,
			"transformHandoff",
			async () => HandoffBundleSchema.parse(await plugin.transformHandoff!(current)),
			() => current,
			ctx,
		) as HandoffBundle;
	}
	return current;
}

/**
 * Fan one lifecycle event to every plugin's onLifecycleEvent, each call
 * isolated — one throwing plugin never blocks the rest.
 */
export function emitLifecycleEventToPlugins(
	event: TaskLifecycleEvent,
	plugins: readonly TaskPlugin[],
	ctx?: PluginHookContext,
): void {
	for (const plugin of plugins) {
		if (!plugin.onLifecycleEvent) continue;
		void callIsolated(plugin, "onLifecycleEvent", () => plugin.onLifecycleEvent!(event), () => undefined, ctx);
	}
}

/**
 * Register every plugin that declares triggers with the gateway.
 * Registration itself is isolated: a throwing registerTriggers is
 * reported and skipped, never fatal to boot.
 */
export function registerPluginTriggers(
	register: (plugin: TaskPlugin) => void,
	plugins: readonly TaskPlugin[],
	ctx?: PluginHookContext,
): void {
	for (const plugin of plugins) {
		if (!plugin.registerTriggers) continue;
		callIsolatedSync(plugin, register, ctx);
	}
}

function callIsolatedSync(plugin: TaskPlugin, run: (p: TaskPlugin) => void, ctx?: PluginHookContext): void {
	try {
		run(plugin);
	} catch (err) {
		report(ctx, new Error(`plugin "${plugin.name}" hook registerTriggers failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
	}
}
