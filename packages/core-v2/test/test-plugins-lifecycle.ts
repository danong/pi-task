/**
 * Hermetic suite for the lifecycle-collector TRIGGER plugin (R1/R2/R3/R4).
 *
 * Exercises the REAL plugin path per M4 contract §3 — never pure helpers:
 *
 *   1. LOADED BY PATH from a real task.toml [plugins] entry via the M4b
 *      loader, pointing at the SHIPPED module file.
 *   2. TRIGGER SIDE: registerTriggers wires through a REAL InMemoryTaskGateway
 *      subscription — emitted events land in the plugin's bounded journal.
 *   3. EVENT SIDE: onLifecycleEvent receives fanned events through
 *      emitLifecycleEventToPlugins (the task-runner dispatch path).
 *   4. THROW ISOLATION: a throwing sibling plugin never blocks collection,
 *      and a throwing registerTriggers is reported, not fatal to boot.
 *   5. DUPLICATION-GONE PROOF (R2): src/daemon/task-runner.ts carries no
 *      local describeTool() copy — the helper moved verbatim into the plugin.
 *
 * Zero LLM, zero network. Standalone: npx tsx packages/core-v2/test/test-plugins-lifecycle.ts
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
	TaskLedgerRow,
	TaskPlugin,
} from "../src/contracts/task-plugin.ts";
import { InMemoryTaskGateway } from "../src/gateway/index.ts";
import {
	emitLifecycleEventToPlugins,
	registerPluginTriggers,
} from "../src/plugins/index.ts";
import { loadPluginsFromToml } from "../src/plugins/loader.ts";
import { LIFECYCLE_COLLECTOR_MAX_EVENTS } from "../src/plugins/builtin/lifecycle-collector.ts";

const PLUGIN_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"plugins",
	"builtin",
	"lifecycle-collector.ts",
);
const TASK_RUNNER_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"daemon",
	"task-runner.ts",
);

function rowsDouble(): { tasks: Map<string, TaskLedgerRow> } {
	return { tasks: new Map<string, TaskLedgerRow>() };
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const dir = mkdtempSync(join(tmpdir(), "core-v2-plugin-lifecycle-"));
	try {
		// ── Loaded by path through the M4b loader ─────────────────────────
		const tomlPath = join(dir, "task.toml");
		writeFileSync(
			tomlPath,
			`[plugins]\npaths = ["${JSON.stringify(PLUGIN_PATH).slice(1, -1)}"]\n`,
			"utf-8",
		);
		const plugins = await loadPluginsFromToml(tomlPath, dir);
		check(
			plugins.length === 1 && plugins[0]!.name === "lifecycle-collector",
			"the shipped lifecycle-collector module loads by path with its declared name",
		);

		const plugin = plugins[0]!;
		check(
			typeof plugin.registerTriggers === "function" &&
				typeof plugin.onLifecycleEvent === "function",
			"lifecycle-collector exposes both trigger and event hooks",
		);

		// ── Trigger side: REAL gateway subscription via registerTriggers ──
		const gateway = new InMemoryTaskGateway({
			rows: rowsDouble(),
			onHandlerError: () => {},
		});
		registerPluginTriggers((p) => p.registerTriggers!(gateway), [plugin]);
		gateway.emit({ type: "task.queued", taskId: "t1" });
		gateway.emit({
			type: "task.routed",
			taskId: "t1",
			detail: { planMode: "cold" },
		});
		const journal = (
			plugin as unknown as { journal: Array<{ type: string; taskId: string }> }
		).journal;
		check(
			journal.length === 2,
			`registerTriggers subscription captured gateway events (${journal.length})`,
		);
		check(
			journal[0]!.type === "task.queued" && journal[1]!.type === "task.routed",
			"journal preserves emission order",
		);
		check(
			journal.every((e) => e.taskId === "t1"),
			"journal entries carry the event payloads",
		);

		// Unsubscribe plumbing stays real and idempotent per gateway contract.
		let secondSeen = false;
		const off = gateway.on("task.completed", () => {
			secondSeen = true;
		});
		off();
		gateway.emit({
			type: "task.completed",
			taskId: "t1",
			detail: { verdict: "ship" },
		});
		check(secondSeen === false, "unsubscribe removes exactly its own handler");

		// ── Event side: onLifecycleEvent through the fan-out helper ───────
		const journalLenBefore = journal.length;
		emitLifecycleEventToPlugins(
			{ type: "verify.completed", taskId: "t2", detail: { passed: true } },
			[plugin],
		);
		check(
			journal.length === journalLenBefore + 1 &&
				journal[journal.length - 1]!.taskId === "t2",
			"onLifecycleEvent captures events fanned out by the hooks layer (task-runner path)",
		);

		// ── Bounded journal (oldest drops) ─────────────────────────────────
		for (let i = 0; i < LIFECYCLE_COLLECTOR_MAX_EVENTS + 10; i += 1) {
			emitLifecycleEventToPlugins(
				{ type: "task.queued", taskId: `burst-${i}` },
				[plugin],
			);
		}
		check(
			journal.length === LIFECYCLE_COLLECTOR_MAX_EVENTS,
			`journal stays bounded at ${LIFECYCLE_COLLECTOR_MAX_EVENTS}`,
		);
		check(
			journal[journal.length - 1]!.taskId ===
				`burst-${LIFECYCLE_COLLECTOR_MAX_EVENTS + 9}`,
			"bounded journal keeps the NEWEST events",
		);

		// ── Throw isolation: throwing siblings never block collection ─────
		const freshGateway = new InMemoryTaskGateway({
			rows: rowsDouble(),
			onHandlerError: () => {},
		});
		registerPluginTriggers((p) => p.registerTriggers!(freshGateway), [plugin]);
		const sinkErrors: unknown[] = [];
		const thrower: TaskPlugin = {
			name: "thrower-sibling",
			onLifecycleEvent: () => {
				throw new Error("sync boom");
			},
		};
		emitLifecycleEventToPlugins(
			{ type: "task.failed", taskId: "t3", detail: { cause: "x" } },
			[thrower, plugin],
			{
				onHookError: (e) => sinkErrors.push(e),
			},
		);
		check(
			sinkErrors.length === 1 &&
				String(sinkErrors[0]).includes("thrower-sibling"),
			"a throwing sibling is reported through the sink",
		);
		const lastEntry = (
			plugin as unknown as { journal: Array<{ taskId: string }> }
		).journal.at(-1);
		check(
			lastEntry?.taskId === "t3",
			"a throwing sibling never blocks lifecycle-collector's own capture",
		);

		const brokenRegistrar: TaskPlugin = {
			name: "broken-registrar",
			registerTriggers: () => {
				throw new Error("register boom");
			},
		};
		const bootSink: unknown[] = [];
		registerPluginTriggers(
			(p) => p.registerTriggers!(freshGateway),
			[brokenRegistrar, plugin],
			{
				onHookError: (e) => bootSink.push(e),
			},
		);
		check(
			bootSink.some((e) => String(e).includes("broken-registrar")),
			"a throwing registerTriggers is reported, not fatal to boot",
		);

		// ── Duplication-gone proof (R2) ───────────────────────────────────
		const runnerSource = readFileSync(TASK_RUNNER_PATH, "utf-8");
		check(
			!runnerSource.includes("function describeTool"),
			"task-runner no longer declares its own describeTool (R2)",
		);
		check(
			!/tool:\$\{toolName\}/.test(runnerSource),
			"no duplicated tool-descriptor formatting remains in core (R2)",
		);

		// The moved helper lives verbatim in the plugin module.
		const pluginSource = readFileSync(PLUGIN_PATH, "utf-8");
		check(
			pluginSource.includes("export function describeTool") &&
				/`tool:\$\{toolName\}`/.test(pluginSource),
			"describeTool moved verbatim into the plugin module (R2)",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		throw new Error(
			`lifecycle-collector plugin tests failed:\n  ${errors.join("\n  ")}`,
		);
	}
	console.log(
		"✓ plugin lifecycle-collector: path-loaded, gateway-triggered, event-fanned, bounded, throw-isolated, core deduplicated",
	);
}

const invokedAs = process.argv[1];
if (
	invokedAs !== undefined &&
	import.meta.url.endsWith(invokedAs.split("/").pop() ?? "")
) {
	runTests().catch((err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
}
