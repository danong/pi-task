/**
 * Hermetic tests for the plugin kernel (R1–R4).
 *
 *   - loader typed failures: missing file (not_found), malformed TOML /
 *     wrong-shaped [plugins] (invalid_config), bad default export
 *     (invalid_export), module that throws on import (import_failed) —
 *     each a typed PluginLoadError with recoverable guidance
 *   - valid load round-trip: REAL plugin files (.mjs and .ts) imported by
 *     absolute path, hooks callable
 *   - transform ordering: ExecutionBundle transforms compose sequentially,
 *     each awaited, in declaration order
 *   - schema surfacing: an invalid transformed bundle is REJECTED by
 *     ExecutionBundleSchema re-validation and never reaches the chain
 *   - throw isolation: a throwing/rejecting hook is caught per-call,
 *     attributed (plugin name + hook), reported through the sink, and the
 *     UNTRANSFORMED value proceeds
 *   - daemon wiring: runTask fires transformExecutionBundle BEFORE
 *     grounding attaches (the worker system prompt carries the
 *     transformed bundle) and produces a plugin-transformed HandoffBundle
 *     when verification fails
 *
 * Zero LLM, zero network. Standalone: npx tsx packages/core-v2/test/test-gateway-plugins.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ExecutionBundle } from "../src/contracts/index.ts";
import type {
	TaskLedgerRow,
	TaskLifecycleEvent,
	TaskPlugin,
} from "../src/contracts/task-plugin.ts";
import { InMemoryTaskGateway } from "../src/gateway/index.ts";
import {
	emitLifecycleEventToPlugins,
	PluginLoadError,
	registerPluginTriggers,
	transformExecutionBundleThrough,
	transformHandoffThrough,
} from "../src/plugins/index.ts";
import {
	importPluginAt,
	loadPluginsFromToml,
	readPluginPathsFromToml,
} from "../src/plugins/loader.ts";
import { runTask } from "../src/daemon/task-runner.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import type {
	SessionHandle,
	SessionHost,
	SessionHostConfig,
	SessionHostEvent,
} from "../src/sessions/host.ts";

const BUNDLE_SPEC = `## Goal
Create a greeting file.

Orientation: the greeting lives in a single flat file next to the seed.

## Requirements
- R1: hello.txt contains exactly "hi"
- R2: hello.txt stays plain ASCII

## Verification
- test -f hello.txt
`;

const FAILING_VERIFY_SPEC = `## Goal
Produce a file the gate rejects.

## Requirements
- R1: missing.txt exists

## Verification
- test -f missing.txt
`;

const FAKE_SESSION_STATS = {
	sessionFile: undefined,
	sessionId: "fake-session",
	userMessages: 1,
	assistantMessages: 1,
	toolCalls: 0,
	toolResults: 0,
	totalMessages: 2,
	tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
	cost: 0.001,
} as const;

/** Scripted fake host capturing every spawn's systemPrompt. */
class CapturingHandle implements SessionHandle {
	readonly role = "worker";
	readonly model = { provider: "fake", modelId: "fake/m" };
	constructor(
		private readonly file: string,
		private readonly spawns: string[],
	) {}
	get result() {
		return {
			files_changed: [this.file],
			summary: "done",
			commit_ids: ["c1"],
			deviations: [],
		};
	}
	subscribe(listener: (event: SessionHostEvent) => void): () => void {
		listener({ type: "turnStart" });
		listener({ type: "yielded", payload: this.result });
		return () => undefined;
	}
	prompt(): Promise<void> {
		writeFileSync(this.file, "hi", "utf-8");
		return Promise.resolve();
	}
	abort(): Promise<void> {
		return Promise.resolve();
	}
	stats() {
		return Promise.resolve(structuredClone(FAKE_SESSION_STATS));
	}
	setModel(): Promise<void> {
		return Promise.resolve();
	}
	close(): void {}
}

function capturingHost(file: string, spawns: string[]): SessionHost {
	return {
		spawn: (config: SessionHostConfig) => {
			spawns.push(config.systemPrompt);
			return Promise.resolve(new CapturingHandle(file, spawns));
		},
	};
}

function makeBundle(): ExecutionBundle {
	return {
		taskId: "t1",
		goal: "base",
		targetFiles: [],
		requirements: ["r"],
		verificationCommands: ["true"],
	};
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const dir = mkdtempSync(join(tmpdir(), "core-v2-plugins-"));
	try {
		mkdirSync(join(dir, "proj"), { recursive: true });

		// ─── Loader typed failures (R2) ──────────────────────────────────
		{
			check(
				JSON.stringify(readPluginPathsFromToml(join(dir, "nope.toml"), dir)) ===
					"[]",
				"missing task.toml yields no plugins",
			);

			writeFileSync(join(dir, "bad.toml"), "[plugins\npaths = []", "utf-8");
			let err: unknown;
			try {
				await loadPluginsFromToml(join(dir, "bad.toml"), dir);
			} catch (e) {
				err = e;
			}
			check(
				err instanceof PluginLoadError && err.code === "invalid_config",
				"malformed TOML fails typed (invalid_config)",
			);
			check(
				err instanceof PluginLoadError && err.guidance.length > 0,
				"invalid_config carries recoverable guidance",
			);

			writeFileSync(
				join(dir, "shape.toml"),
				'[plugins]\npaths = "not-an-array"\n',
				"utf-8",
			);
			err = undefined;
			try {
				await loadPluginsFromToml(join(dir, "shape.toml"), dir);
			} catch (e) {
				err = e;
			}
			check(
				err instanceof PluginLoadError && err.code === "invalid_config",
				"[plugins] with a non-array paths fails typed",
			);

			const relToml = join(dir, "rel.toml");
			writeFileSync(relToml, '[plugins]\npaths = ["./ghost.mjs"]\n', "utf-8");
			err = undefined;
			try {
				await loadPluginsFromToml(relToml, join(dir, "proj"));
			} catch (e) {
				err = e;
			}
			check(
				err instanceof PluginLoadError && err.code === "not_found",
				"a declared-but-missing plugin file fails typed (not_found)",
			);
			check(
				err instanceof PluginLoadError &&
					err.path === join(dir, "proj", "ghost.mjs"),
				"relative [plugins] paths resolve against cwd",
			);

			const ghost = join(dir, "ghost.mjs");
			err = undefined;
			try {
				await importPluginAt(ghost);
			} catch (e) {
				err = e;
			}
			check(
				err instanceof PluginLoadError && err.code === "not_found",
				"direct import of a missing file fails typed",
			);

			const badExport = join(dir, "bad-export.mjs");
			writeFileSync(badExport, "export default 42;\n", "utf-8");
			err = undefined;
			try {
				await importPluginAt(badExport);
			} catch (e) {
				err = e;
			}
			check(
				err instanceof PluginLoadError && err.code === "invalid_export",
				"a default export without a string name fails typed (invalid_export)",
			);

			const boom = join(dir, "boom.mjs");
			writeFileSync(
				boom,
				"throw new Error('module-level explosion');\n",
				"utf-8",
			);
			err = undefined;
			try {
				await importPluginAt(boom);
			} catch (e) {
				err = e;
			}
			check(
				err instanceof PluginLoadError && err.code === "import_failed",
				"a module that throws on import fails typed (import_failed)",
			);

			// A toml listing BOTH a good and a bad plugin fails typed rather
			// than silently skipping the bad entry.
			const good = join(dir, "good.mjs");
			writeFileSync(good, 'export default { name: "good" };\n', "utf-8");
			writeFileSync(
				relToml,
				`[plugins]\npaths = ["${JSON.stringify(good).slice(1, -1)}", "./ghost.mjs"]\n`,
				"utf-8",
			);
			err = undefined;
			try {
				await loadPluginsFromToml(relToml, dir);
			} catch (e) {
				err = e;
			}
			check(
				err instanceof PluginLoadError,
				"one bad path among good ones fails typed (never silent skip)",
			);
		}

		// ─── Valid load round-trip over REAL plugin files (FR-11) ────────
		{
			const mjs = join(dir, "real.mjs");
			writeFileSync(
				mjs,
				[
					"export default {",
					'  name: "real-mjs-plugin",',
					"  async transformExecutionBundle(bundle) {",
					'    return { ...bundle, goal: bundle.goal + "|mjs" };',
					"  },",
					"};",
				].join("\n"),
				"utf-8",
			);
			const mjsPlugin = await importPluginAt(mjs);
			check(
				mjsPlugin.name === "real-mjs-plugin",
				".mjs plugin loads with its declared name",
			);
			const out = await mjsPlugin.transformExecutionBundle!(makeBundle());
			check(
				out.goal === "base|mjs",
				".mjs plugin hook executes on a real bundle",
			);

			const ts = join(dir, "real.ts");
			writeFileSync(
				ts,
				[
					"import type { TaskPlugin } from '../src/contracts/task-plugin.ts';",
					"const plugin: TaskPlugin = {",
					'  name: "real-ts-plugin",',
					"  async transformExecutionBundle(bundle) {",
					'    return { ...bundle, goal: bundle.goal + "|ts" };',
					"  },",
					"};",
					"export default plugin;",
				].join("\n"),
				"utf-8",
			);
			const tsPlugin = await importPluginAt(ts);
			check(
				tsPlugin.name === "real-ts-plugin",
				".ts plugin loads through the same loader",
			);
			const tsOut = await tsPlugin.transformExecutionBundle!(makeBundle());
			check(
				tsOut.goal === "base|ts",
				".ts plugin hook executes on a real bundle",
			);

			const roundtrip = await loadPluginsFromToml(
				(() => {
					const p = join(dir, "ok.toml");
					writeFileSync(
						p,
						`[plugins]\npaths = ["${JSON.stringify(mjs).slice(1, -1)}"]\n`,
						"utf-8",
					);
					return p;
				})(),
				dir,
			);
			check(
				roundtrip.length === 1 && roundtrip[0]!.name === "real-mjs-plugin",
				"loadPluginsFromToml round-trips a valid configuration",
			);
		}

		// ─── Transform ordering + schema surfacing (R3) ──────────────────
		{
			const p1: TaskPlugin = {
				name: "first",
				transformExecutionBundle: (b) =>
					Promise.resolve({ ...b, goal: `${b.goal}|p1` }),
			};
			const p2: TaskPlugin = {
				name: "second",
				transformExecutionBundle: (b) =>
					Promise.resolve({ ...b, goal: `${b.goal}|p2` }),
			};
			const ordered = await transformExecutionBundleThrough(makeBundle(), [
				p1,
				p2,
			]);
			check(
				ordered.goal === "base|p1|p2",
				"transforms compose sequentially in declaration order",
			);

			// Schema surfacing: a plugin cannot inject an invalid bundle.
			const sinkErrors: unknown[] = [];
			const invalid: TaskPlugin = {
				name: "invalid-injector",
				transformExecutionBundle: () =>
					Promise.resolve({
						...makeBundle(),
						taskId: 42,
					} as unknown as ExecutionBundle),
			};
			const guarded = await transformExecutionBundleThrough(
				makeBundle(),
				[invalid],
				{
					onHookError: (e) => sinkErrors.push(e),
				},
			);
			check(
				guarded.taskId === "t1" && guarded.goal === "base",
				"an invalid transformed bundle is rejected and the untransformed value proceeds",
			);
			check(
				sinkErrors.length === 1 &&
					String(sinkErrors[0]).includes("invalid-injector") &&
					String(sinkErrors[0]).includes("transformExecutionBundle"),
				"the rejection is attributed to the plugin name + hook through the sink",
			);
		}

		// ─── Throw isolation (R4) ────────────────────────────────────────
		{
			const seen: string[] = [];
			const sinkErrors: unknown[] = [];
			const throwing: TaskPlugin = {
				name: "thrower",
				onLifecycleEvent: () => {
					throw new Error("sync boom");
				},
			};
			const rejecting: TaskPlugin = {
				name: "rejector",
				transformHandoff: () => Promise.reject(new Error("async boom")),
			};
			const after: TaskPlugin = {
				name: "after",
				onLifecycleEvent: (e: TaskLifecycleEvent) => seen.push(e.type),
			};
			emitLifecycleEventToPlugins(
				{ type: "task.queued", taskId: "t" },
				[throwing, after],
				{
					onHookError: () => {},
				},
			);
			check(
				JSON.stringify(seen) === JSON.stringify(["task.queued"]),
				"a throwing onLifecycleEvent never blocks later plugins",
			);

			const survived = await transformHandoffThrough(
				{
					taskId: "t",
					uncommittedDiffSummary: "d",
					filesTouched: ["a.ts"],
					verificationFailures: [],
				},
				[
					rejecting,
					{
						name: "tagger",
						transformHandoff: (h) =>
							Promise.resolve({
								...h,
								filesTouched: [...h.filesTouched, "late.ts"],
							}),
					},
				],
				{ onHookError: (e) => sinkErrors.push(e) },
			);
			check(
				JSON.stringify(survived.filesTouched) ===
					JSON.stringify(["a.ts", "late.ts"]),
				"a rejecting transformHandoff yields the untransformed value to later plugins",
			);
			check(
				sinkErrors.length === 1 &&
					String(sinkErrors[0]).includes("rejector") &&
					String(sinkErrors[0]).includes("transformHandoff"),
				"hook failures are attributed (name + hook) through the configured sink",
			);

			// registerTriggers isolation through the real gateway.
			const gw = new InMemoryTaskGateway({
				rows: { tasks: new Map<string, TaskLedgerRow>() },
				onHandlerError: () => {},
			});
			let triggered = false;
			const triggerPlugin: TaskPlugin = {
				name: "triggered",
				registerTriggers: (g) => {
					g.on("task.queued", () => {
						triggered = true;
					});
				},
			};
			const brokenTrigger: TaskPlugin = {
				name: "broken-trigger",
				registerTriggers: () => {
					throw new Error("register boom");
				},
			};
			registerPluginTriggers(
				(p) => p.registerTriggers!(gw),
				[brokenTrigger, triggerPlugin],
				{
					onHookError: () => {},
				},
			);
			gw.emit({ type: "task.queued", taskId: "t1" });
			check(
				triggered,
				"registerTriggers wires subscriptions through the real gateway",
			);
			void gw.on; // keep the unsubscribe surface referenced for typing clarity
		}

		// ─── Daemon wiring: bundle transform BEFORE grounding attach ─────
		{
			const workDir = join(dir, "bundle-run");
			mkdirSync(workDir, { recursive: true });
			const seed = join(workDir, "seed.txt");
			writeFileSync(seed, "export const seed = 1;\n", "utf-8");
			const dbPath = join(dir, "bundle.db");
			const store = new LedgerStore(dbPath);
			store.recordRoutingFeedback("bundle-run", "bundle", 1);
			store.close();

			const spawns: string[] = [];
			const tagging: TaskPlugin = {
				name: "bundle-tagger",
				transformExecutionBundle: (b) =>
					Promise.resolve({
						...b,
						targetFiles: [
							...b.targetFiles,
							{
								hostPath: "plugin-marker.ts",
								astOutline: "PLUGIN_MARKER_OUTLINE",
								outlineTruncated: false,
								outlineCursor: null,
							},
						],
					}),
			};
			const result = await runTask({
				specMarkdown: BUNDLE_SPEC,
				cwd: workDir,
				artifactsDir: join(dir, "artifacts-bundle"),
				dbPath,
				model: "openrouter/stealth/ox-alpha",
				host: capturingHost(join(workDir, "hello.txt"), spawns),
				bundle: { targetPaths: [seed] },
				plugins: [tagging],
			});
			check(
				result.receipt.bundleHit !== null,
				"the routed bundle run grounded on a bundle",
			);
			check(
				spawns.length === 1 && spawns[0]!.includes("plugin-marker.ts"),
				"transformExecutionBundle ran BEFORE grounding attached (prompt prefix carries the transformed bundle)",
			);
			check(
				!spawns[0]!.includes("base|"),
				"the grounding section stays deterministic over the transformed bundle",
			);

			// A THROWING bundle transformer must not break the run nor leak
			// its payload into the prompt prefix. Fresh ledger: run 1's miss
			// telemetry must not un-route run 2 out of bundle mode.
			const spawns2: string[] = [];
			const db2 = join(dir, "bundle2.db");
			const store2 = new LedgerStore(db2);
			store2.recordRoutingFeedback("bundle-run", "bundle", 1);
			store2.close();
			const broken: TaskPlugin = {
				name: "broken-transformer",
				transformExecutionBundle: () =>
					Promise.reject(new Error("bundle boom")),
			};
			const result2 = await runTask({
				specMarkdown: BUNDLE_SPEC,
				cwd: workDir,
				artifactsDir: join(dir, "artifacts-bundle-2"),
				dbPath: db2,
				model: "openrouter/stealth/ox-alpha",
				host: capturingHost(join(workDir, "hello2.txt"), spawns2),
				bundle: { targetPaths: [seed] },
				plugins: [broken],
			});
			check(
				result2.receipt.bundleHit !== null,
				"a throwing transformer degrades to the built bundle",
			);
			check(
				spawns2.length === 1 && !spawns2[0]!.includes("plugin-marker.ts"),
				"the untransformed bundle grounds the prompt when a transformer throws",
			);
		}

		// ─── Daemon wiring: HandoffBundle transform before retry ─────────
		{
			const workDir = join(dir, "handoff-run");
			mkdirSync(workDir, { recursive: true });
			const dbPath = join(dir, "handoff.db");
			const spawns: string[] = [];
			const tagging: TaskPlugin = {
				name: "handoff-tagger",
				transformHandoff: (h) =>
					Promise.resolve({
						...h,
						filesTouched: [...h.filesTouched, "plugin-added.ts"],
					}),
			};
			const result = await runTask({
				specMarkdown: FAILING_VERIFY_SPEC,
				cwd: workDir,
				artifactsDir: join(dir, "artifacts-handoff"),
				dbPath,
				model: "openrouter/stealth/ox-alpha",
				host: capturingHost(join(workDir, "hello.txt"), spawns),
				plugins: [tagging],
			});
			check(
				result.verificationPassed === false,
				"the failing-verification leg failed as scripted",
			);
			check(
				result.handoff !== undefined,
				"a failed verification produces a retry HandoffBundle",
			);
			check(
				result.handoff?.filesTouched.includes("plugin-added.ts") === true,
				"transformHandoff ran BEFORE the retry consumes the handoff",
			);
			check(
				result.handoff?.verificationFailures.length === 1,
				"the transformed handoff keeps the schema-required failure records",
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		throw new Error(`gateway-plugins tests failed:\n  ${errors.join("\n  ")}`);
	}
	console.log(
		"✓ gateway-plugins: typed loader failures, real-path round-trips, transform ordering, schema surfacing, throw isolation, daemon bundle+handoff wiring",
	);
}

const invokedAs = process.argv[1];
if (
	invokedAs !== undefined &&
	import.meta.url === pathToFileURL(invokedAs).href
) {
	runTests().catch((err: unknown) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
}
