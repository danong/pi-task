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
import { TraceArtifactSchema, type TraceArtifact } from "../src/contracts/index.ts";

const SPEC = `## Goal
Create the result file.

## Requirements
- R1: result.txt contains the expected value

## Verification
- test -f result.txt
- test "$(cat result.txt)" = ok

## Artifact Policy
- Change required
`;
const MISSING_POLICY_SPEC = `## Goal
Create the result file.

## Requirements
- R1: result.txt contains the expected value

## Verification
- test -f result.txt
`;
const INVALID_POLICY_SPEC = `${MISSING_POLICY_SPEC}
## Artifact Policy
- Maybe result.txt
`;
const REQUIRED_REPORT_SPEC = `## Goal
Produce the report.

## Requirements
- R1: report.md exists

## Verification
- test -f result.txt

## Artifact Policy
- Required: report.md
- Change required
`;
const INTENTIONAL_NO_CHANGE_SPEC = `## Goal
Confirm the existing state.

## Requirements
- R1: no files are changed

## Verification
- test ! -e result.txt

## Artifact Policy
- Intentional no-change
`;
const EMPTY_CHANGE_SPEC = `## Goal
Produce the report.

## Requirements
- R1: a report change is required

## Verification
- test ! -e result.txt

## Artifact Policy
- Change required
`;

interface FakeSessionOptions {
	turns?: number;
	statsAvailable?: boolean;
	writeResult?: boolean;
	reportedFiles?: string[];
	/** Make a warm rewrite observable while keeping shell verification equal. */
	warmRewrite?: boolean;
}

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
		private readonly options: FakeSessionOptions = {},
	) {}

	subscribe(listener: (event: SessionHostEvent) => void): () => void {
		for (let turn = 0; turn < (this.options.turns ?? 1); turn += 1) {
			listener({ type: "turnStart" });
			listener({ type: "toolStart", toolName: "write", toolCallId: `write-${turn + 1}` });
			listener({
				type: "toolEnd",
				toolName: "write",
				toolCallId: `write-${turn + 1}`,
				isError: false,
			});
		}
		listener({ type: "settled" });
		return () => undefined;
	}

	prompt(): Promise<void> {
		return Promise.resolve().then(() => {
			if (this.options.writeResult !== false) {
				const resultPath = join(this.cwd, "result.txt");
				const content =
					this.options.warmRewrite && existsSync(resultPath)
						? `${this.value}\n`
						: this.value;
				writeFileSync(resultPath, content, "utf8");
				execFileSync("jj", ["commit", "-m", "fake worker"], {
					cwd: this.cwd,
					stdio: "pipe",
					env: { ...process.env, JJ_EDITOR: "true" },
				});
			}
			this.result = {
				files_changed: this.options.reportedFiles ?? (this.options.writeResult === false ? [] : ["result.txt"]),
				summary: this.options.writeResult === false ? "no change" : "created result",
				commit_ids: ["fake-commit"],
				deviations: [],
			};
		});
	}

	abort(): Promise<void> {
		return Promise.resolve();
	}

	stats() {
		if (this.options.statsAvailable === false)
			return Promise.reject(new Error("stats unavailable"));
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
	options: FakeSessionOptions = {},
): SessionHost {
	return {
		spawn: (config: SessionHostConfig) => {
			const warmRewrite = spawnCount !== undefined && spawnCount.value > 0;
			if (spawnCount !== undefined) spawnCount.value += 1;
			return Promise.resolve(
				new FakeHandle(config.cwd, value, {
					...options,
					warmRewrite: options.warmRewrite ?? warmRewrite,
				}),
			);
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

function readTrace(path: string | undefined): TraceArtifact {
	if (path === undefined) throw new Error("expected trace path");
	return TraceArtifactSchema.parse(JSON.parse(readFileSync(path, "utf8")));
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
		const missingPolicyPath = join(root, "missing-policy.md");
		writeFileSync(missingPolicyPath, MISSING_POLICY_SPEC, "utf8");
		const invalidPolicyPath = join(root, "invalid-policy.md");
		writeFileSync(invalidPolicyPath, INVALID_POLICY_SPEC, "utf8");
		let ingressDaemonCalls = 0;
		const ingressSpawns = { value: 0 };
		const ingressDependencies: CliDependencies = {
			host: fakeHost("ok", ingressSpawns),
			startDaemon: async () => {
				ingressDaemonCalls += 1;
				throw new Error("daemon must not start during ingress validation");
			},
			write: () => undefined,
		};
		const missingPolicy = await runCli(
			["--spec", missingPolicyPath, "--project-dir", repo, "--model", "fake/model"],
			ingressDependencies,
		);
		check(missingPolicy.exitCode === 2, "missing artifact policy is a usage error");
		check(missingPolicy.error?.includes("Artifact Policy") === true, "missing policy error names the policy section");
		const invalidPolicy = await runCli(
			["--spec", invalidPolicyPath, "--project-dir", repo, "--model", "fake/model"],
			ingressDependencies,
		);
		check(invalidPolicy.exitCode === 2, "invalid artifact policy is a usage error");
		check(invalidPolicy.error?.includes("artifact policy") === true, "invalid policy error identifies policy validation");
		check(ingressDaemonCalls === 0 && ingressSpawns.value === 0, "policy validation precedes daemon and session providers");
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
		const successTrace = readTrace(success.tracePath);
		check(successTrace.taskId === success.receipt?.taskId, "trace identity agrees with success receipt");
		check(successTrace.runId === success.receipt?.taskId, "trace run identity agrees with success receipt");
		check(successTrace.outcome === "ship", "successful trace records ship outcome");
		check(successTrace.events.some((event) => event.type === "model.assigned"), "successful trace records model assignment");
		check(successTrace.events.some((event) => event.type === "context.injected"), "successful trace records context injection");
		check(successTrace.events.some((event) => event.type === "turn.started"), "successful trace records typed turn activity");
		check(successTrace.events.some((event) => event.type === "trace.delivered" && event.detail?.delivered === true), "successful trace records delivery only after writing");
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

		// A warm ledger allocates a fresh attempt while preserving the same
		// task-family identity. The trace, receipt, and artifact names must all
		// follow that attempt rather than silently reusing the first run.
		const warmArtifacts = join(root, "warm-artifacts");
		const warm = await runCli(
			[
				"--spec", specPath, "--project-dir", repo, "--model", "fake/model",
				"--db", dbPath, "--artifacts-dir", warmArtifacts,
			],
			deps,
		);
		check(warm.exitCode === 0, `warm-ledger task exits zero (${warm.error ?? ""}, ${warm.receipt?.verdict ?? "none"}, ${progress.slice(-8).join("|")})`);
		check(warm.receipt?.taskId !== success.receipt?.taskId, "warm-ledger run gets a new attempt identity");
		check(warm.receipt?.taskId.endsWith("-a2") === true, "warm-ledger run uses the second attempt suffix");
		const warmTrace = readTrace(warm.tracePath);
		check(warmTrace.taskId === warm.receipt?.taskId && warmTrace.runId === warm.receipt?.taskId, "warm trace and receipt identities agree");
		check(existsSync(join(warmArtifacts, `${warm.receipt?.taskId}.trace.json`)), "warm trace uses the receipt identity in its filename");

		// Content acceptance runs after otherwise-passing verification: a
		// missing required report must not ship merely because result.txt passed.
		const requiredRepo = join(root, "required-report-repo");
		initRepo(requiredRepo);
		const requiredSpecPath = join(root, "required-report.md");
		writeFileSync(requiredSpecPath, REQUIRED_REPORT_SPEC, "utf8");
		const requiredArtifacts = join(root, "required-report-artifacts");
		const required = await runCli(
			[
				"--spec", requiredSpecPath, "--project-dir", requiredRepo,
				"--model", "fake/model", "--db", join(root, "required-report.sqlite"),
				"--artifacts-dir", requiredArtifacts,
			],
			{
				...deps,
				workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: requiredRepo }),
				write: () => undefined,
			},
		);
		check(required.exitCode !== 0, "missing required report is non-shippable");
		check(required.receipt?.verdict === "failed", "missing required report returns failed receipt");
		const requiredFailurePath = required.receipt?.taskId === undefined
			? undefined
			: join(requiredArtifacts, `${required.receipt.taskId}.failure.json`);
		check(
			requiredFailurePath !== undefined && existsSync(requiredFailurePath) &&
			JSON.parse(readFileSync(requiredFailurePath, "utf8")).cause.includes("missing_file"),
			"missing required report exposes an actionable acceptance reason",
		);

		// Change-required content with passing verification still fails when the
		// provider finalizes an empty workspace.
		const emptyChangeRepo = join(root, "empty-change-repo");
		initRepo(emptyChangeRepo);
		const emptyChangeSpecPath = join(root, "empty-change.md");
		writeFileSync(emptyChangeSpecPath, EMPTY_CHANGE_SPEC, "utf8");
		const emptyChangeArtifacts = join(root, "empty-change-artifacts");
		const emptyChange = await runCli(
			[
				"--spec", emptyChangeSpecPath, "--project-dir", emptyChangeRepo,
				"--model", "fake/model", "--db", join(root, "empty-change.sqlite"),
				"--artifacts-dir", emptyChangeArtifacts,
			],
			{
				...deps,
				workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: emptyChangeRepo }),
				host: fakeHost("ok", undefined, { writeResult: false }),
				write: () => undefined,
			},
		);
		check(emptyChange.exitCode !== 0, "empty change-required task is non-shippable");
		check(emptyChange.receipt?.verdict === "failed", "empty change-required task returns failed receipt");
		const emptyChangeFailurePath = emptyChange.receipt?.taskId === undefined
			? undefined
			: join(emptyChangeArtifacts, `${emptyChange.receipt.taskId}.failure.json`);
		check(
			emptyChangeFailurePath !== undefined && existsSync(emptyChangeFailurePath) &&
			JSON.parse(readFileSync(emptyChangeFailurePath, "utf8")).cause.includes("empty_change"),
			"empty change exposes an actionable acceptance reason",
		);

		// A declared intentional no-change task may ship when verification passes.
		const noChangeRepo = join(root, "intentional-no-change-repo");
		initRepo(noChangeRepo);
		const noChangeSpecPath = join(root, "intentional-no-change.md");
		writeFileSync(noChangeSpecPath, INTENTIONAL_NO_CHANGE_SPEC, "utf8");
		const noChange = await runCli(
			[
				"--spec", noChangeSpecPath, "--project-dir", noChangeRepo,
				"--model", "fake/model", "--db", join(root, "intentional-no-change.sqlite"),
				"--artifacts-dir", join(root, "intentional-no-change-artifacts"),
			],
			{
				...deps,
				workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: noChangeRepo }),
				host: fakeHost("ok", undefined, { writeResult: false }),
				write: () => undefined,
			},
		);
		check(noChange.exitCode === 0, "declared intentional no-change task ships");
		check(noChange.receipt?.verdict === "ship", "intentional no-change returns ship receipt");

		const setupArtifacts = join(root, "setup-failure-artifacts");
		const unsupportedDriver = new JujutsuWorkspaceDriver({ projectDir: repo });
		unsupportedDriver.isSupported = async () => false;
		const setupFailure = await runCli(
			[
				"--spec", specPath, "--project-dir", repo, "--model", "fake/model",
				"--db", join(root, "setup-failure.sqlite"), "--artifacts-dir", setupArtifacts,
			],
			{ ...deps, workspaceDriver: unsupportedDriver, write: () => undefined },
		);
		check(setupFailure.exitCode !== 0, "post-validation setup failure exits nonzero");
		const setupTrace = readTrace(setupFailure.tracePath);
		check(setupTrace.outcome === "failed", "setup failure trace records failed outcome");
		check(setupTrace.events.some((event) => event.type === "task.failed"), "setup failure trace records task failure");
		check(setupTrace.taskId === deriveTaskId(SPEC, repo), "first setup failure uses the canonical task identity");

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
		const failedTrace = readTrace(failed.tracePath);
		check(failedTrace.taskId === failed.receipt?.taskId && failedTrace.runId === failed.receipt?.taskId, "failed trace identity agrees with receipt");
		check(failedTrace.outcome === "failed", "failed trace records failed outcome");
		check(failedTrace.events.some((event) => event.type === "verification.completed" && event.detail?.passed === false), "failed trace records verification failure");
		check(failedTrace.events.some((event) => event.type === "task.failed"), "failed trace records task failure");
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

		// Receipt delivery can fail independently of trace delivery. A
		// pre-existing directory at the receipt target makes the atomic rename
		// fail while the trace remains writable; the trace must say delivered=false.
		const receiptFailureRepo = join(root, "receipt-failure-repo");
		initRepo(receiptFailureRepo);
		const receiptFailureArtifacts = join(root, "receipt-failure-artifacts");
		const receiptFailureOutput: string[] = [];
		mkdirSync(receiptFailureArtifacts, { recursive: true });
		const receiptFailureTaskId = deriveTaskId(SPEC, receiptFailureRepo);
		mkdirSync(join(receiptFailureArtifacts, `${receiptFailureTaskId}.receipt.json`));
		const receiptFailure = await runCli(
			[
				"--spec", specPath, "--project-dir", receiptFailureRepo, "--model", "fake/model",
				"--db", join(root, "receipt-failure.sqlite"), "--artifacts-dir", receiptFailureArtifacts,
			],
			{
				...deps,
				workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: receiptFailureRepo }),
				write: (line) => receiptFailureOutput.push(line),
			},
		);
		check(receiptFailure.exitCode === 3, `receipt delivery failure maps to artifact exit (${receiptFailure.exitCode}, ${receiptFailure.error ?? ""})`);
		check(receiptFailure.receipt?.verdict === "failed", "receipt delivery failure returns a non-ship receipt");
		check(!receiptFailureOutput.some((line) => line.startsWith("receipt: ")), "receipt delivery failure does not print a ship receipt");
		const receiptFailureArtifact = receiptFailure.receipt?.taskId === undefined
			? undefined
			: join(receiptFailureArtifacts, `${receiptFailure.receipt.taskId}.failure.json`);
		check(
			receiptFailureArtifact !== undefined && existsSync(receiptFailureArtifact) &&
			JSON.parse(readFileSync(receiptFailureArtifact, "utf8")).cause.includes("receipt"),
			"receipt delivery failure retains a durable failure explanation",
		);
		const receiptFailureTrace = readTrace(receiptFailure.tracePath);
		check(receiptFailureTrace.outcome === "failed", "receipt delivery failure trace is non-ship");
		check(receiptFailureTrace.events.some((event) => event.type === "receipt.delivered" && event.detail?.delivered === false), "trace reports failed receipt delivery honestly");
		check(!receiptFailureTrace.events.some((event) => event.type === "receipt.delivered" && event.detail?.delivered === true), "trace does not report a failed receipt as delivered");

		// The trace target itself is unwritable, so the CLI must return the
		// dedicated artifact exit even though the receipt was delivered.
		const traceFailureRepo = join(root, "trace-failure-repo");
		initRepo(traceFailureRepo);
		const traceFailureArtifacts = join(root, "trace-failure-artifacts");
		mkdirSync(traceFailureArtifacts, { recursive: true });
		mkdirSync(join(traceFailureArtifacts, `${deriveTaskId(SPEC, traceFailureRepo)}.trace.json`));
		const traceFailure = await runCli(
			[
				"--spec", specPath, "--project-dir", traceFailureRepo, "--model", "fake/model",
				"--db", join(root, "trace-failure.sqlite"), "--artifacts-dir", traceFailureArtifacts,
			],
			{ ...deps, workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: traceFailureRepo }), write: () => undefined },
		);
		check(traceFailure.exitCode === 3, "trace delivery failure maps to artifact exit");
		check(traceFailure.receipt?.verdict === "failed", "trace delivery failure returns a non-ship receipt");
		check(traceFailure.error?.includes("trace artifact delivery failed") === true, `trace delivery failure is actionable (${traceFailure.error ?? ""})`);
		check(traceFailure.tracePath === undefined, "failed trace delivery is not reported as delivered");
		const traceFailureArtifact = traceFailure.receipt?.taskId === undefined
			? undefined
			: join(traceFailureArtifacts, `${traceFailure.receipt.taskId}.failure.json`);
		check(
			traceFailureArtifact !== undefined && existsSync(traceFailureArtifact) &&
			JSON.parse(readFileSync(traceFailureArtifact, "utf8")).cause.includes("trace"),
			"trace delivery failure retains a durable failure explanation",
		);

		const unavailableRepo = join(root, "unavailable-repo");
		initRepo(unavailableRepo);
		const unavailableArtifacts = join(root, "unavailable-artifacts");
		const unavailable = await runCli(
			[
				"--spec", specPath, "--project-dir", unavailableRepo, "--model", "fake/model",
				"--db", join(root, "unavailable.sqlite"), "--artifacts-dir", unavailableArtifacts,
			],
			{
				...deps,
				workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: unavailableRepo }),
				host: fakeHost("ok", undefined, { turns: 3, statsAvailable: false }),
				write: () => undefined,
			},
		);
		check(unavailable.exitCode === 0, `unavailable usage run still ships (${unavailable.exitCode}, ${unavailable.error ?? ""}, ${unavailable.receipt?.verdict ?? "none"})`);
		check(unavailable.receipt?.turns === 3, `receipt retains every observed turn when stats reject (${unavailable.receipt?.turns ?? "none"})`);
		check(unavailable.receipt?.usageStatus === "unavailable", "receipt distinguishes unavailable usage from measured zero");
		check(readTrace(unavailable.tracePath).usage?.status === "unavailable", "trace preserves unavailable usage status");
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
