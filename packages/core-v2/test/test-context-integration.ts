/** Hermetic M4 runnable-kernel integration: real jj/bash, fake sessions, zero model/network. */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	cliHelp,
	parseCliArgs,
	runCli,
	type CliDependencies,
} from "../src/cli.ts";
import { type ContextProviderFactory } from "../src/contracts/index.ts";
import { contextEvaluationRecord } from "../src/bench/context-evaluation.ts";
import { TraceArtifactSchema } from "../src/contracts/index.ts";
import type {
	SessionHandle,
	SessionHost,
	SessionHostConfig,
	SessionHostEvent,
} from "../src/sessions/host.ts";
import { JujutsuWorkspaceDriver } from "../src/workspaces/jj-driver.ts";

const SPEC = `## Goal\nCreate the result through createResult.\n\n## Requirements\n- R1: result.txt contains ok\n\n## Verification\n- test "$(cat result.txt)" = ok\n\n## Artifact Policy\n- Required: result.txt\n- Change required\n`;

function initRepo(root: string): void {
	mkdirSync(join(root, "src"), { recursive: true });
	execFileSync("jj", ["git", "init", "--colocate"], {
		cwd: root,
		stdio: "pipe",
	});
	writeFileSync(
		join(root, "src", "result.ts"),
		"export function createResult(): string { return 'SOURCE_BODY_SENTINEL'; }\n",
		"utf8",
	);
	execFileSync("jj", ["commit", "-m", "initial"], {
		cwd: root,
		stdio: "pipe",
		env: { ...process.env, JJ_EDITOR: "true" },
	});
}

class Handle implements SessionHandle {
	readonly role = "worker";
	readonly model = { provider: "fake", modelId: "fake/model" };
	result = {
		files_changed: ["result.txt"],
		summary: "created result",
		commit_ids: [],
		deviations: [],
	};
	constructor(
		private readonly config: SessionHostConfig,
		private readonly failPrompt = false,
	) {}
	subscribe(listener: (event: SessionHostEvent) => void): () => void {
		listener({ type: "turnStart" });
		listener({
			type: "toolStart",
			toolName: "read",
			toolCallId: "r1",
			path: "src/result.ts",
		});
		listener({
			type: "toolEnd",
			toolName: "read",
			toolCallId: "r1",
			isError: false,
		});
		listener({
			type: "toolStart",
			toolName: "read",
			toolCallId: "r2",
			path: "src/result.ts",
		});
		listener({
			type: "toolEnd",
			toolName: "read",
			toolCallId: "r2",
			isError: false,
		});
		listener({ type: "settled" });
		return () => undefined;
	}
	prompt(): Promise<void> {
		if (this.failPrompt)
			return Promise.reject(new Error("fixture interruption"));
		writeFileSync(join(this.config.cwd, "result.txt"), "ok", "utf8");
		execFileSync("jj", ["commit", "-m", "fake result"], {
			cwd: this.config.cwd,
			stdio: "pipe",
			env: { ...process.env, JJ_EDITOR: "true" },
		});
		return Promise.resolve();
	}
	abort(): Promise<void> {
		return Promise.resolve();
	}
	stats() {
		return Promise.resolve({
			sessionFile: undefined,
			sessionId: "fake",
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 1,
			toolResults: 1,
			totalMessages: 4,
			tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, total: 11 },
			cost: 0,
		});
	}
	setModel(): Promise<void> {
		return Promise.resolve();
	}
	close(): void {}
}

function host(captured: SessionHostConfig[], failPrompt = false): SessionHost {
	return {
		spawn: async (config) => {
			captured.push(config);
			return new Handle(config, failPrompt);
		},
	};
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (condition: boolean, message: string): void => {
		if (!condition) errors.push(message);
	};
	check(
		cliHelp().includes("--context <raw|symbol-tree>"),
		"CLI help exposes explicit provider selection",
	);
	check(
		parseCliArgs(["--spec", "task.md", "--model", "fake/model"]).context ===
			"raw",
		"raw is the default no-injection baseline",
	);
	check(
		parseCliArgs([
			"--spec",
			"task.md",
			"--model",
			"fake/model",
			"--context",
			"symbol-tree",
		]).context === "symbol-tree",
		"symbol-tree selection is explicit",
	);

	const parent = mkdtempSync(join(tmpdir(), "core-v2-context-integration-"));
	try {
		const specPath = join(parent, "task.md");
		writeFileSync(specPath, SPEC, "utf8");
		const run = async (
			name: string,
			context: "raw" | "symbol-tree",
			extra: Partial<CliDependencies> = {},
			failPrompt = false,
		) => {
			const repo = join(parent, name);
			mkdirSync(repo, { recursive: true });
			initRepo(repo);
			const captured: SessionHostConfig[] = [];
			const result = await runCli(
				[
					"--spec",
					specPath,
					"--project-dir",
					repo,
					"--model",
					"fake/model",
					"--context",
					context,
					"--db",
					join(parent, `${name}.sqlite`),
					"--artifacts-dir",
					join(parent, `${name}-artifacts`),
				],
				{
					host: host(captured, failPrompt),
					workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: repo }),
					write: () => undefined,
					...extra,
				},
			);
			return { result, captured, failure: "" };
		};

		const raw = await run("raw", "raw");
		check(
			raw.result.exitCode === 0,
			`raw fallback remains a correct task path (${raw.result.error ?? ""}; ${JSON.stringify(raw.result.receipt)})`,
		);
		check(
			!raw.captured[0]?.systemPrompt.includes("Progressive context handles"),
			"raw provider injects no context section",
		);

		const symbol = await run("symbol", "symbol-tree");
		check(
			symbol.result.exitCode === 0,
			`symbol context task ships (${symbol.result.error ?? ""}; ${JSON.stringify(symbol.result.receipt)})`,
		);
		const prompt = symbol.captured[0]?.systemPrompt ?? "";
		check(
			prompt.includes("Progressive context handles") &&
				prompt.includes("src/result.ts"),
			"initial context is compiled and injected before spawn",
		);
		check(
			!prompt.includes("SOURCE_BODY_SENTINEL"),
			"initial injection contains no source bodies",
		);
		check(
			symbol.captured[0]?.contextCapabilities?.identity.id === "symbol-tree",
			"selected capability and context tool reach the session host",
		);
		check(
			symbol.captured[0]?.contextPlan?.mode === "managed" &&
				symbol.captured[0]?.contextEpoch?.planId ===
					symbol.captured[0]?.contextPlan?.id,
			"kernel plan and execution epoch reach the session boundary",
		);
		check(
			!existsSync(join(parent, "symbol", ".local")),
			"context artifacts never pollute the repository",
		);
		const trace = TraceArtifactSchema.parse(
			JSON.parse(readFileSync(symbol.result.tracePath!, "utf8")),
		);
		const planned = trace.events.find(
			(event) =>
				event.type === "context.planned" && event.provider === "symbol-tree",
		);
		const cache = trace.events.find(
			(event) =>
				event.type === "context.cache" && event.provider === "symbol-tree",
		);
		const epoch = trace.events.find(
			(event) =>
				event.type === "epoch.started" && event.provider === "symbol-tree",
		);
		const selected = trace.events.find(
			(event) =>
				event.type === "context.selected" && event.provider === "symbol-tree",
		);
		const injected = trace.events.find(
			(event) =>
				event.type === "context.injected" && event.provider === "symbol-tree",
		);
		const omitted = trace.events.find(
			(event) =>
				event.type === "context.omitted" && event.provider === "symbol-tree",
		);
		check(
			planned?.detail?.planId === symbol.captured[0]?.contextPlan?.id &&
				cache?.detail?.localStore === "available" &&
				typeof cache.detail.storedArtifactCount === "number" &&
				epoch?.detail?.planId === planned?.detail?.planId,
			"trace projects plan, truthful local-cache availability, and epoch identity",
		);
		check(
			selected?.detail?.treeIdentity !== undefined &&
				typeof selected.detail.selectedCount === "number",
			"trace projects provider/version, tree identity, and selection count",
		);
		check(
			typeof injected?.detail?.estimatedCharacters === "number" &&
				typeof injected.detail.estimatedTokens === "number",
			"trace projects bounded estimated context size",
		);
		check(
			typeof omitted?.detail?.omittedCount === "number",
			"trace projects omission count without provider-specific events",
		);
		check(
			trace.events
				.filter(
					(event) =>
						event.type === "tool.started" && event.detail?.toolName === "read",
				)
				.every((event) => event.detail?.path === "src/result.ts"),
			"session trace preserves read paths",
		);
		check(
			contextEvaluationRecord(trace).repeatedReads === 1,
			"evaluation derives repeated reads from real session trace paths",
		);
		check(
			!JSON.stringify(trace).includes("SOURCE_BODY_SENTINEL"),
			"trace evidence contains no source body",
		);
		const spawnSequence =
			trace.events.find((event) => event.type === "session.spawned")
				?.sequence ?? 0;
		check(
			(selected?.sequence ?? Number.MAX_SAFE_INTEGER) < spawnSequence,
			"initial context compilation is observed before session spawn",
		);

		const interrupted = await run("interrupted", "raw", {}, true);
		check(
			interrupted.result.exitCode !== 0,
			"interrupted epoch remains non-ship",
		);
		const interruptedTrace = TraceArtifactSchema.parse(
			JSON.parse(readFileSync(interrupted.result.tracePath!, "utf8")),
		);
		check(
			interruptedTrace.events.some(
				(event) =>
					event.type === "epoch.transitioned" &&
					event.detail?.reason === "interruption" &&
					event.detail?.checkpointAvailable === false,
			),
			"session interruption records an explicit non-resumed epoch boundary",
		);

		const failingFactory: ContextProviderFactory = {
			identity: { id: "broken-index", version: "1" },
			create: () => {
				throw new Error("index fixture failed");
			},
		};
		const fallback = await run("fallback", "symbol-tree", {
			contextProviderFactory: failingFactory,
		});
		check(
			fallback.result.exitCode === 0,
			`provider failure degrades without failing correct work (${fallback.result.error ?? ""}; ${JSON.stringify(fallback.result.receipt)})`,
		);
		check(
			fallback.captured[0]?.contextCapabilities?.identity.id === "raw",
			"failed provider is replaced by raw capability",
		);
		const fallbackTrace = TraceArtifactSchema.parse(
			JSON.parse(readFileSync(fallback.result.tracePath!, "utf8")),
		);
		check(
			fallbackTrace.events.some(
				(event) =>
					event.type === "context.omitted" &&
					event.detail?.failureCode === "provider_failed" &&
					event.detail?.requestedProvider === "broken-index" &&
					event.detail?.fallbackProvider === "raw",
			),
			"trace records typed provider failure and raw fallback",
		);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
	if (errors.length > 0)
		throw new Error(
			`test-context-integration failed:\n  ✗ ${errors.join("\n  ✗ ")}`,
		);
	console.log(
		"✓ context-integration: explicit selection, pre-spawn injection, trace projection, and raw fallback",
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
