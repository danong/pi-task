/**
 * Hermetic first-engine-slice tests: CLI parsing/help, typed progress,
 * one-worker jj isolation, receipt delivery, verification failure, and exit
 * codes. The fake session never calls a model or network; jj and bash are real.
 */

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
import { dirname, join } from "node:path";
import type {
	SessionHandle,
	SessionHost,
	SessionHostConfig,
	SessionHostEvent,
} from "../src/sessions/host.ts";
import type { TaskGateway, TaskLifecycleEvent } from "../src/contracts/index.ts";
import { runCli, type CliDependencies, CliUsageError } from "../src/cli.ts";
import { parseCliArgs, cliHelp, cliExitCode } from "../src/cli.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { deriveTaskId } from "../src/daemon/task-runner.ts";
import { JujutsuWorkspaceDriver } from "../src/workspaces/jj-driver.ts";

const SPEC = `## Goal
Create the result file.

## Requirements
- R1: result.txt contains the expected value

## Verification
- test -f result.txt
- test "$(cat result.txt)" = ok
`;

class FakeHandle implements SessionHandle {
	readonly role = "worker";
	readonly model = { provider: "fake", modelId: "fake/model" };
	result:
		| {
				files_changed: string[];
				summary: string;
				commit_ids: string[];
				deviations: string[];
		  }
		| undefined;

	constructor(
		private readonly cwd: string,
		private readonly value: "ok" | "bad",
	) {}

	subscribe(listener: (event: SessionHostEvent) => void): () => void {
		listener({ type: "turnStart" });
		listener({ type: "toolStart", toolName: "write", toolCallId: "write-1" });
		listener({
			type: "toolEnd",
			toolName: "write",
			toolCallId: "write-1",
			isError: false,
		});
		listener({ type: "settled" });
		return () => undefined;
	}

	prompt(): Promise<void> {
		return Promise.resolve().then(() => {
			writeFileSync(join(this.cwd, "result.txt"), this.value, "utf8");
			execFileSync("jj", ["commit", "-m", "fake worker"], {
				cwd: this.cwd,
				stdio: "pipe",
				env: { ...process.env, JJ_EDITOR: "true" },
			});
			this.result = {
				files_changed: ["result.txt"],
				summary: "created result",
				commit_ids: ["fake-commit"],
				deviations: [],
			};
		});
	}

	abort(): Promise<void> {
		return Promise.resolve();
	}

	stats() {
		return Promise.resolve({
			sessionFile: undefined,
			sessionId: "fake-session",
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 1,
			toolResults: 1,
			totalMessages: 4,
			tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
			cost: 0,
		});
	}

	setModel(): Promise<void> {
		return Promise.resolve();
	}

	close(): void {}
}

function fakeHost(
	value: "ok" | "bad",
	spawnCount?: { value: number },
): SessionHost {
	return {
		spawn: (config: SessionHostConfig) => {
			if (spawnCount !== undefined) spawnCount.value += 1;
			return Promise.resolve(new FakeHandle(config.cwd, value));
		},
	};
}

class CapturingGateway implements TaskGateway {
	readonly events: TaskLifecycleEvent[] = [];
	private readonly handlers = new Set<(event: TaskLifecycleEvent) => void>();

	emit(event: TaskLifecycleEvent): void {
		this.events.push(event);
		for (const handler of this.handlers) handler(event);
	}

	on(_pattern: string, handler: (event: TaskLifecycleEvent) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	getTaskState(): Promise<never> {
		return Promise.reject(new Error("test gateway does not serve reads"));
	}

	getManifest(): Promise<never> {
		return Promise.reject(new Error("test gateway does not serve reads"));
	}
}

function initRepo(repo: string): void {
	mkdirSync(repo, { recursive: true });
	execFileSync("jj", ["git", "init", "--colocate"], {
		cwd: repo,
		stdio: "pipe",
	});
	writeFileSync(join(repo, "README.md"), "fixture\n", "utf8");
	execFileSync("jj", ["commit", "-m", "initial"], {
		cwd: repo,
		stdio: "pipe",
		env: { ...process.env, JJ_EDITOR: "true" },
	});
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (value: boolean, message: string): void => {
		if (!value) errors.push(message);
	};

	check(cliHelp().includes("--spec <file>"), "help documents the spec file");
	check(
		cliHelp().includes("required unless PI_TASK_V2_MODEL is set"),
		"help documents provider-neutral required model selection",
	);
	check(!cliHelp().includes("ox-alpha"), "help does not claim a product model default");
	const priorModel = process.env.PI_TASK_V2_MODEL;
	try {
		delete process.env.PI_TASK_V2_MODEL;
		try {
			parseCliArgs(["--spec", "task.md"]);
			errors.push("model-less CLI arguments were accepted");
		} catch (error) {
			check(error instanceof CliUsageError, "missing model is a typed usage error");
			check(
				error instanceof Error && error.message.includes("--model"),
				"missing model error names --model",
			);
		}
		process.env.PI_TASK_V2_MODEL = "environment/provider-model";
		check(
			parseCliArgs(["--spec", "task.md"]).model ===
				"environment/provider-model",
			"environment model is accepted",
		);
		check(
			parseCliArgs(["--spec", "task.md", "--model", "cli/provider-model"])
				.model === "cli/provider-model",
			"explicit CLI model takes precedence over the environment",
		);
		process.env.PI_TASK_V2_MODEL = "   ";
		let emptyEnvRejected = false;
		try {
			parseCliArgs(["--spec", "task.md"]);
		} catch (error) {
			emptyEnvRejected = error instanceof CliUsageError;
		}
		check(emptyEnvRejected, "empty environment model is a typed usage error");
	} finally {
		if (priorModel === undefined) delete process.env.PI_TASK_V2_MODEL;
		else process.env.PI_TASK_V2_MODEL = priorModel;
	}
	check(
		cliHelp().includes("--project-dir <directory>"),
		"help documents project dir",
	);
	check(cliExitCode("ship") === 0, "ship maps to zero");
	check(
		cliExitCode("failed") !== 0 && cliExitCode("escalate") !== 0,
		"failure verdicts map nonzero",
	);
	check(
		parseCliArgs(["--spec", "task.md", "--model", "fake/model"]).specPath ===
			"task.md",
		"CLI parses required values",
	);
	for (const argv of [["--spec"], ["--unknown", "x"]]) {
		try {
			parseCliArgs(argv);
			errors.push(`invalid arguments accepted: ${argv.join(" ")}`);
		} catch {
			// expected
		}
	}

	const root = mkdtempSync(join(tmpdir(), "core-v2-cli-"));
	try {
		const specPath = join(root, "task.md");
		writeFileSync(specPath, SPEC, "utf8");
		const invalid = await runCli(["--spec", join(root, "missing.md")]);
		check(invalid.exitCode === 2, "missing spec maps to usage error");

		const repo = join(root, "repo");
		initRepo(repo);
		const artifacts = join(root, "artifacts");
		const dbPath = join(root, "ledger.sqlite");
		const progress: string[] = [];
		const gateway = new CapturingGateway();
		const successSpawns = { value: 0 };
		const deps: CliDependencies = {
			host: fakeHost("ok", successSpawns),
			workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: repo }),
			gateway,
			write: (line) => progress.push(line),
		};
		const success = await runCli(
			[
				"--spec",
				specPath,
				"--project-dir",
				repo,
				"--model",
				"fake/model",
				"--db",
				dbPath,
				"--artifacts-dir",
				artifacts,
			],
			deps,
		);
		check(
			success.exitCode === 0,
			`successful isolated task exits zero (${success.error ?? ""})`,
		);
		check(
			success.receipt?.verdict === "ship",
			"successful CLI returns ship receipt",
		);
		check(
			existsSync(join(repo, "result.txt")),
			"worker result lands in integrated tree",
		);
		check(
			readFileSync(join(repo, "result.txt"), "utf8") === "ok",
			"integrated result is correct",
		);
		check(
			success.receiptPath !== undefined && existsSync(success.receiptPath),
			"receipt artifact is delivered",
		);
		check(
			progress.some((line) => line.includes("task queued")),
			"progress includes task lifecycle",
		);
		check(
			progress.some((line) => line.includes("turn start")),
			"progress includes turn activity",
		);
		check(
			progress.some((line) => line.includes("tool start: write")),
			"progress includes tool activity",
		);
		check(
			progress.some((line) => line.includes("verification passed")),
			"progress includes verification",
		);
		check(
			progress.some((line) => line.includes("outcome: ship")),
			"progress includes final outcome",
		);
		const successLedger = new LedgerStore(dbPath);
		const successTasks = successLedger.listTasks();
		const successTaskId = success.receipt?.taskId;
		check(successTasks.length === 1, "success ledger has one canonical task row");
		check(
			successTaskId !== undefined && successTasks[0]?.id === successTaskId,
			"success ledger task is the receipt identity",
		);
		check(
			successTaskId === deriveTaskId(SPEC, repo),
			"single task identity is derived from the spec and project",
		);
		check(
			successTaskId !== undefined &&
			!successTaskId.endsWith("-p") &&
			!successTaskId.endsWith("-0"),
			"single task identity is not a parallel aggregate or indexed worker",
		);
		check(successSpawns.value === 1, "success creates one worker session");
		check(
			successTaskId !== undefined &&
			successLedger.listSessions(successTaskId).length === 1,
			"success ledger has one worker session row",
		);
		check(
			successTaskId !== undefined &&
			successLedger.listWorkspaces(successTaskId).length === 1,
			"success ledger has one workspace",
		);
		const successLifecycle = gateway.events.filter((event) =>
			event.type.startsWith("task."),
		);
		check(
			successTaskId !== undefined &&
			successLifecycle.length === 2 &&
			successLifecycle.every((event) => event.taskId === successTaskId),
			"success event stream has one canonical task lifecycle",
		);
		check(
			successTaskId !== undefined &&
			existsSync(join(artifacts, `${successTaskId}.receipt.json`)),
			"success receipt filename agrees with task identity",
		);
		successLedger.close();
		check(
			!progress.some((line) => line.includes("reasoning")),
			"progress does not expose reasoning",
		);
		const workspaces = execFileSync("jj", ["workspace", "list"], {
			cwd: repo,
			encoding: "utf8",
		});
		check(
			!workspaces.includes("v2-task-"),
			"successful worker workspace is cleaned up",
		);

		const failArtifacts = join(root, "fail-artifacts");
		const failureGateway = new CapturingGateway();
		const failureSpawns = { value: 0 };
		const failed = await runCli(
			[
				"--spec",
				specPath,
				"--project-dir",
				repo,
				"--model",
				"fake/model",
				"--db",
				join(root, "fail.sqlite"),
				"--artifacts-dir",
				failArtifacts,
			],
			{
				...deps,
				host: fakeHost("bad", failureSpawns),
				gateway: failureGateway,
				write: () => undefined,
			},
		);
		check(failed.exitCode !== 0, "verification failure exits nonzero");
		check(
			failed.receipt?.verdict === "failed",
			"verification failure returns failed receipt",
		);
		check(
			failed.receiptPath !== undefined && existsSync(failed.receiptPath),
			"failed run still delivers a durable receipt",
		);
		check(
			existsSync(join(failArtifacts, `${failed.receipt?.taskId}.failure.json`)),
			"verification failure retains failure evidence",
		);
		const failureLedger = new LedgerStore(join(root, "fail.sqlite"));
		const failedTaskId = failed.receipt?.taskId;
		check(
			failureLedger.listTasks().length === 1,
			"failure ledger has one canonical task row",
		);
		check(failureSpawns.value === 1, "failure creates one worker session");
		check(
			failedTaskId !== undefined &&
			failureLedger.listSessions(failedTaskId).length === 1,
			"failure ledger has one worker session row",
		);
		check(
			failedTaskId !== undefined &&
			failureLedger.listWorkspaces(failedTaskId).length === 1,
			"failure ledger has one preserved workspace record",
		);
		const failureLifecycle = failureGateway.events.filter((event) =>
			event.type.startsWith("task."),
		);
		check(
			failedTaskId !== undefined &&
			failureLifecycle.length === 2 &&
			failureLifecycle.every((event) => event.taskId === failedTaskId),
			"failure event stream has one canonical task lifecycle",
		);
		failureLedger.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	if (errors.length > 0)
		throw new Error(`test-cli failed:\n  ${errors.join("\n  ")}`);
	console.log(
		"✓ cli: parsing, progress, jj isolation, receipts, verification, exit codes",
	);
}

if (process.argv[1]?.endsWith("test-cli.ts")) {
	runTests().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
