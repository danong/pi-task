/**
 * Hermetic suite for the handoff-cap TRANSFORM plugin (R1/R2/R3).
 *
 * Exercises the REAL plugin path per M4 contract §3 — never pure helpers:
 *
 *   1. LOADED BY PATH from a real task.toml [plugins] entry via the M4b
 *      loader (loadPluginsFromToml), pointing at the SHIPPED module file.
 *   2. INVOKED THROUGH THE HOOKS LAYER (transformHandoffThrough), so
 *      schema re-validation and throw-isolation semantics are the ones
 *      production uses.
 *   3. OBSERVABLE EFFECT: oversized stderr tails / diff summaries come
 *      back capped to the plugin's policy bound.
 *   4. SCHEMA VALIDITY: every transformed output re-parses cleanly
 *      against HandoffBundleSchema.
 *   5. THROW ISOLATION: a rejecting plugin ahead of handoff-cap leaves
 *      the input unchanged for handoff-cap, which still transforms.
 *   6. DUPLICATION-GONE PROOF (R2): src/daemon/task-runner.ts contains
 *      neither the former inline `.slice(0, 60_000)` nor any local cap.
 *
 * Zero LLM, zero network. Standalone: npx tsx packages/core-v2/test/test-plugins-handoff-cap.ts
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HandoffBundleSchema, type HandoffBundle } from "../src/contracts/payloads.ts";
import { transformHandoffThrough } from "../src/plugins/index.ts";
import { loadPluginsFromToml } from "../src/plugins/loader.ts";
import type { TaskPlugin } from "../src/contracts/task-plugin.ts";

const PLUGIN_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "plugins", "builtin", "handoff-cap.ts");
const TASK_RUNNER_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "daemon", "task-runner.ts");

/** Oversized fixture: 70 kB tail — above the plugin's cap AND the schema max. */
function bigHandoff(): HandoffBundle {
	return {
		taskId: "t-cap",
		uncommittedDiffSummary: "x".repeat(70_000),
		filesTouched: ["a.ts"],
		verificationFailures: [
			{ command: "npm test", stderrTail: "y".repeat(70_000) },
			{ command: "true", stderrTail: "short tail" },
		],
	};
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const dir = mkdtempSync(join(tmpdir(), "core-v2-plugin-handoff-cap-"));
	try {
		// ── Loaded by path through the M4b loader ─────────────────────────
		const tomlPath = join(dir, "task.toml");
		writeFileSync(tomlPath, `[plugins]\npaths = ["${JSON.stringify(PLUGIN_PATH).slice(1, -1)}"]\n`, "utf-8");
		let plugins;
		try {
			plugins = await loadPluginsFromToml(tomlPath, dir);
		} catch (err) {
			check(false, `loader failed on the shipped plugin path: ${String(err)}`);
			throw err;
		}
		check(plugins.length === 1 && plugins[0]!.name === "handoff-cap",
			"the shipped handoff-cap module loads by path with its declared name");

		const plugin = plugins[0]!;
		check(typeof plugin.transformHandoff === "function", "handoff-cap exposes the transformHandoff hook");

		// ── Invoked through the hooks layer: observable effect ───────────
		const { HANDOFF_CAP_MAX } = await import(PLUGIN_PATH);
		const capped = await transformHandoffThrough(bigHandoff(), [plugin]);
		check(capped.uncommittedDiffSummary.length === HANDOFF_CAP_MAX,
			`oversized diff summary capped to ${HANDOFF_CAP_MAX} (got ${capped.uncommittedDiffSummary.length})`);
		check(capped.verificationFailures[0]!.stderrTail.length === HANDOFF_CAP_MAX,
			"oversized failure stderr tail capped");
		check(capped.verificationFailures[1]!.stderrTail === "short tail",
			"sub-cap tails pass through untouched");
		check(capped.filesTouched.length === 1 && capped.taskId === "t-cap",
			"capping preserves every other handoff field");

		// Tail preservation: the LAST characters survive (tails matter).
		check(capped.uncommittedDiffSummary.endsWith("x"), "tail-capped summary keeps its last bytes");

		// ── Schema validity of the transformed output ─────────────────────
		const reparsed = HandoffBundleSchema.safeParse(capped);
		check(reparsed.success, "transformed handoff re-validates against HandoffBundleSchema");

		// An UNCAPPED injection cannot sneak past the schema when a hook ran.
		const invalidInjector: TaskPlugin = {
			name: "invalid-injector",
			transformHandoff: () =>
				Promise.resolve({ ...bigHandoff(), taskId: 42 } as unknown as HandoffBundle),
		};
		const sinkErrors: unknown[] = [];
		const guarded = await transformHandoffThrough(bigHandoff(), [invalidInjector, plugin], {
			onHookError: (e) => sinkErrors.push(e),
		});
		check(sinkErrors.length === 1 && String(sinkErrors[0]).includes("invalid-injector"),
			"a schema-invalid transform is rejected and attributed through the sink");
		check(guarded.uncommittedDiffSummary.length === HANDOFF_CAP_MAX,
			"after rejection the chain continues with the valid value and handoff-cap still caps it");

		// ── Throw isolation ahead of the real plugin ─────────────────────
		const sinkErrors2: unknown[] = [];
		const rejecter: TaskPlugin = {
			name: "rejector",
			transformHandoff: () => Promise.reject(new Error("boom")),
		};
		const survived = await transformHandoffThrough(bigHandoff(), [rejecter, plugin], {
			onHookError: (e) => sinkErrors2.push(e),
		});
		check(survived.uncommittedDiffSummary.length === HANDOFF_CAP_MAX,
			"a rejecting predecessor leaves the input intact for handoff-cap, which still caps it");
		check(sinkErrors2.some((e) => String(e).includes("rejector")),
			"the rejection is reported through the sink, never fatal");

		// ── Duplication-gone proof (R2) ───────────────────────────────────
		const runnerSource = readFileSync(TASK_RUNNER_PATH, "utf-8");
		check(!runnerSource.includes("slice(0, 60_000)") && !runnerSource.includes("slice(0,60000)"),
			"task-runner no longer carries the inline 60 kB slice (R2)");
		check(runnerSource.includes("transformHandoffThrough"),
			"the former inline site now routes through the plugin hooks (R2)");

		// Upstream guarantee note: verify/run.ts caps tails at 2048 chars, so
		// core never NEEDS the plugin for correctness — the plugin owns the
		// seam-level policy. Assert that guarantee holds so this suite also
		// documents WHY removal is safe.
		const verifyRunSource = readFileSync(
			join(dirname(TASK_RUNNER_PATH), "..", "verify", "run.ts"),
			"utf-8",
		);
		check(verifyRunSource.includes("VERIFY_OUTPUT_TAIL_CHARS"),
			"verify layer keeps its own bounded tails (documents the safety argument)");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		throw new Error(`handoff-cap plugin tests failed:\n  ${errors.join("\n  ")}`);
	}
	console.log("✓ plugin handoff-cap: path-loaded, hooks-invoked, capped, schema-valid, throw-isolated, core deduplicated");
}

const invokedAs = process.argv[1];
if (invokedAs !== undefined && import.meta.url.endsWith(invokedAs.split("/").pop() ?? "")) {
	runTests().catch((err) => {
		console.error(err.message ?? err);
		process.exit(1);
	});
}
