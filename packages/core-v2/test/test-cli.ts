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
import type {
	TaskGateway,
	TaskLifecycleEvent,
	WorkspaceDriver,
} from "../src/contracts/index.ts";
import { runCli, type CliDependencies, CliUsageError } from "../src/cli.ts";
import { parseCliArgs, cliHelp, cliExitCode, CLI_EDGE_BLOCKED_EXIT, CLI_EDGE_TERMINAL_EXIT, CLI_EDGE_UNKNOWN_EXIT } from "../src/cli.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { prepareSequentialChild } from "../src/daemon/sequential.ts";
import { ContextArtifactStore } from "../src/context/artifact-store.ts";
import { deriveTaskId } from "../src/daemon/task-runner.ts";
import { JujutsuWorkspaceDriver } from "../src/workspaces/jj-driver.ts";
import {
	TraceArtifactSchema,
	type TraceArtifact,
} from "../src/contracts/index.ts";

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
			listener({
				type: "toolStart",
				toolName: "write",
				toolCallId: `write-${turn + 1}`,
			});
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
				files_changed:
					this.options.reportedFiles ??
					(this.options.writeResult === false ? [] : ["result.txt"]),
				summary:
					this.options.writeResult === false ? "no change" : "created result",
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

function providerIdentityMismatch(driver: JujutsuWorkspaceDriver): WorkspaceDriver {
	const continuation = driver.continuation;
	if (continuation === undefined) throw new Error("test driver has no continuation");
	return {
		name: driver.name,
		integrationMode: driver.integrationMode,
		continuation: { ...continuation, identity: "incompatible.provider" },
		isSupported: driver.isSupported.bind(driver),
		createWorkspace: driver.createWorkspace.bind(driver),
		mergeWorkspace: driver.mergeWorkspace.bind(driver),
		cleanupWorkspace: driver.cleanupWorkspace.bind(driver),
		...(driver.prepare === undefined ? {} : { prepare: driver.prepare.bind(driver) }),
		...(driver.finalizeWorkspace === undefined ? {} : { finalizeWorkspace: driver.finalizeWorkspace.bind(driver) }),
	};
}

class CapturingGateway implements TaskGateway {
	readonly events: TaskLifecycleEvent[] = [];
	private readonly handlers = new Set<(event: TaskLifecycleEvent) => void>();

	emit(event: TaskLifecycleEvent): void {
		this.events.push(event);
		for (const handler of this.handlers) handler(event);
	}

	on(
		_pattern: string,
		handler: (event: TaskLifecycleEvent) => void,
	): () => void {
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
	check(
		!cliHelp().includes("ox-alpha"),
		"help does not claim a product model default",
	);
	const priorModel = process.env.PI_TASK_V2_MODEL;
	try {
		delete process.env.PI_TASK_V2_MODEL;
		try {
			parseCliArgs(["--spec", "task.md"]);
			errors.push("model-less CLI arguments were accepted");
		} catch (error) {
			check(
				error instanceof CliUsageError,
				"missing model is a typed usage error",
			);
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
	check(cliHelp().includes("--child-spec <file>"), "help documents durable child continuation");
	check(cliHelp().includes("--resume <edge-id>"), "help documents durable edge resume");
	check(cliHelp().includes("terminal is a no-op"), "help documents terminal edge idempotence");
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
	check(
		parseCliArgs(["--spec", "parent.md", "--child-spec", "child.md", "--model", "fake/model"]).childSpecPath === "child.md",
		"CLI parses one explicit continuation child",
	);
	check(
		parseCliArgs(["--resume", "edge-1", "--model", "fake/model"]).resumeEdgeId === "edge-1",
		"CLI parses an explicit durable edge resume selector",
	);
	for (const argv of [
		["--spec", "parent.md", "--resume", "edge-1", "--model", "fake/model"],
		["--resume", "edge-1", "--child-spec", "child.md", "--model", "fake/model"],
		["--resume", "edge-1", "--context", "symbol-tree", "--model", "fake/model"],
		["--spec"],
		["--unknown", "x"],
	]) {
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
			[
				"--spec",
				missingPolicyPath,
				"--project-dir",
				repo,
				"--model",
				"fake/model",
			],
			ingressDependencies,
		);
		check(
			missingPolicy.exitCode === 2,
			"missing artifact policy is a usage error",
		);
		check(
			missingPolicy.error?.includes("Artifact Policy") === true,
			"missing policy error names the policy section",
		);
		const invalidPolicy = await runCli(
			[
				"--spec",
				invalidPolicyPath,
				"--project-dir",
				repo,
				"--model",
				"fake/model",
			],
			ingressDependencies,
		);
		check(
			invalidPolicy.exitCode === 2,
			"invalid artifact policy is a usage error",
		);
		check(
			invalidPolicy.error?.includes("artifact policy") === true,
			"invalid policy error identifies policy validation",
		);
		check(
			ingressDaemonCalls === 0 && ingressSpawns.value === 0,
			"policy validation precedes daemon and session providers",
		);
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
		check(
			successTrace.taskId === success.receipt?.taskId,
			"trace identity agrees with success receipt",
		);
		check(
			successTrace.runId === success.receipt?.taskId,
			"trace run identity agrees with success receipt",
		);
		check(
			successTrace.outcome === "ship",
			"successful trace records ship outcome",
		);
		const assignedModel = successTrace.events.find(
			(event) => event.type === "model.assigned",
		);
		check(
			assignedModel?.detail?.familyId === success.receipt?.taskId &&
				assignedModel?.detail?.attemptId === success.receipt?.taskId &&
				assignedModel?.detail?.attemptNumber === 1 &&
				typeof assignedModel?.detail?.engineVersion === "string" &&
				typeof assignedModel?.detail?.specHash === "string",
			"successful trace records bounded engine, spec-family, and attempt metadata",
		);
		check(
			successTrace.events.some((event) => event.type === "context.injected"),
			"successful trace records context injection",
		);
		const successVerification = successTrace.events.find(
			(event) => event.type === "verification.completed",
		);
		check(
			successVerification?.detail?.passed === true &&
				typeof successVerification?.detail?.evidence === "object",
			"successful trace records structural verification evidence",
		);
		check(
			!JSON.stringify(successTrace).includes("test -f result.txt") &&
				!JSON.stringify(successTrace).includes("cat result.txt"),
			"successful trace omits verification command text",
		);
		check(
			successTrace.events.some((event) => event.type === "turn.started"),
			"successful trace records typed turn activity",
		);
		check(
			successTrace.events.some(
				(event) =>
					event.type === "trace.delivered" && event.detail?.delivered === true,
			),
			"successful trace records delivery only after writing",
		);
		check(
			progress.some((line) => line === `run: ${success.receipt?.taskId}`),
			"progress announces the run identity before terminal delivery",
		);
		check(
			progress.some((line) => line.startsWith("receipt artifact: ")) &&
				progress.some((line) => line.startsWith("trace artifact: ")),
			"terminal progress names the durable receipt and trace artifacts",
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
		check(
			successTasks.length === 1,
			"success ledger has one canonical task row",
		);
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

		// The ordinary v2 CLI exposes the daemon-owned parent→child path as a
		// thin adapter; both sessions run through the same jj/verify pipeline.
		const sequentialRepo = join(root, "sequential-repo"); initRepo(sequentialRepo);
		const sequentialDb = join(root, "sequential.sqlite"); const sequentialArtifacts = join(root, "sequential-artifacts"); const sequentialSpawns = { value: 0 };
		const sequential = await runCli([
			"--spec", specPath, "--child-spec", specPath,
			"--project-dir", sequentialRepo, "--model", "fake/model",
			"--db", sequentialDb, "--artifacts-dir", sequentialArtifacts,
		], {
			host: fakeHost("ok", sequentialSpawns),
			workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: sequentialRepo }),
			write: () => undefined,
		});
		const sequentialLedger = new LedgerStore(sequentialDb);
		const sequentialEdges = sequential.receipt === undefined ? [] : sequentialLedger.listChildEdges(sequential.receipt.taskId);
		check(
			sequential.exitCode === 0 &&
				sequential.receipt?.verdict === "ship" &&
				sequentialSpawns.value === 2,
			`CLI parent and child complete through the normal surface (exit=${sequential.exitCode}, verdict=${sequential.receipt?.verdict}, spawns=${sequentialSpawns.value}, error=${sequential.error ?? ""})`,
		);
		check(
			sequentialEdges[0]?.status === "completed" &&
				sequential.receipt !== undefined &&
				sequentialLedger.listSessions(sequential.receipt.taskId).length === 1 &&
				sequentialLedger.listSessions(`${sequential.receipt.taskId}-child`).length === 1,
			`CLI persists separate parent/child sessions and terminal edge evidence (edge=${sequentialEdges[0]?.status ?? "missing"})`,
		);
		const sequentialTrace = readTrace(sequential.tracePath);
		const sequentialTaskId = sequential.receipt?.taskId;
		const sequentialChildTaskId =
			sequentialTaskId === undefined ? undefined : `${sequentialTaskId}-child`;
		const sequentialChildEvents = sequentialTrace.events.filter(
			(event) =>
				event.type.startsWith("child.") ||
				event.type.startsWith("continuation."),
		);
		const childCompleted = sequentialChildEvents.find(
			(event) => event.type === "child.completed",
		);
		check(
			sequentialTrace.taskId === sequentialTaskId &&
				sequentialTrace.runId === sequentialTaskId,
			"CLI sequential receipt and trace share one aggregate identity",
		);
		check(
			sequentialChildEvents.length > 0 &&
				sequentialChildEvents.every((event) => {
					const detail = event.detail;
					return event.type === "child.queued"
						? event.taskId === detail?.parentTaskId
						: event.taskId === detail?.childTaskId;
				}),
			"CLI trace preserves admitted child endpoint identities",
		);
		check(
			childCompleted?.taskId === sequentialChildTaskId &&
				childCompleted?.detail?.parentTaskId === sequentialTaskId &&
				childCompleted?.detail?.childTaskId === sequentialChildTaskId &&
				childCompleted?.detail?.status === "completed",
			"CLI trace carries the admitted terminal child lifecycle fact",
		);
		check(
			sequentialTrace.events.every(
				(event) =>
					event.type.startsWith("child.") ||
					event.type.startsWith("continuation.") ||
					event.taskId === sequentialTaskId,
			),
			"CLI trace keeps non-child events on the aggregate identity",
		);
		check(
			sequentialTrace.events.filter((event) => event.type === "session.spawned").length === 1 &&
				!sequentialTrace.events.some(
					(event) =>
						event.taskId === sequentialChildTaskId &&
						!event.type.startsWith("child.") &&
						!event.type.startsWith("continuation."),
				),
			"CLI trace does not create a second child execution lifecycle",
		);
		const sequentialTraceText = JSON.stringify(sequentialTrace);
		check(
			!sequentialTraceText.includes(sequentialRepo) &&
				!sequentialTraceText.includes("opaqueToken") &&
				!sequentialTraceText.includes("fake worker") &&
				!sequentialTraceText.includes("reasoning"),
			"CLI trace omits child workspace, provider, transcript, and reasoning data",
		);
		sequentialLedger.close();

		// The normal CLI resume operation crosses a close/reopen boundary. The
		// preparation process owns the only parent session; the fresh adapter
		// instance may add exactly one child session and must never replay it.
		const resumeRepo = join(root, "resume-repo");
		initRepo(resumeRepo);
		const resumeDb = join(root, "resume.sqlite");
		const resumeArtifacts = join(root, "resume-artifacts");
		const resumeContinuations = join(root, "continuations");
		const preparationSpawns = { value: 0 };
		const preparedResume = await prepareSequentialChild({
			parentSpecMarkdown: SPEC,
			childSpecMarkdown: SPEC,
			projectDir: resumeRepo,
			artifactsDir: join(root, "resume-failures"),
			dbPath: resumeDb,
			model: "fake/model",
			workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: resumeRepo }),
			host: fakeHost("ok", preparationSpawns),
			artifactStore: new ContextArtifactStore({ root: resumeContinuations }),
		});
		const beforeResumeLedger = new LedgerStore(resumeDb);
		const beforeParentSessions = beforeResumeLedger.listSessions(preparedResume.parentTaskId).length;
		const beforeChildSessions = beforeResumeLedger.listSessions(preparedResume.childTaskId).length;
		beforeResumeLedger.close();
		check(
			preparedResume.status === "ready" && preparedResume.edgeId !== undefined &&
			preparationSpawns.value === 1 && beforeParentSessions === 1 && beforeChildSessions === 0,
			"CLI resume fixture leaves one ready edge after one parent session",
		);
		const resumeSpawns = { value: 0 };
		const resumedCli = await runCli([
			"--resume", preparedResume.edgeId!,
			"--project-dir", resumeRepo,
			"--model", "fake/model",
			"--db", resumeDb,
			"--artifacts-dir", resumeArtifacts,
		], {
			host: fakeHost("ok", resumeSpawns, { warmRewrite: true }),
			workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: resumeRepo }),
			write: () => undefined,
		});
		const afterResumeLedger = new LedgerStore(resumeDb);
		const afterParentSessions = afterResumeLedger.listSessions(preparedResume.parentTaskId).length;
		const afterChildSessions = afterResumeLedger.listSessions(preparedResume.childTaskId).length;
		afterResumeLedger.close();
		check(
			resumedCli.exitCode === 0 && resumedCli.receipt?.taskId === preparedResume.parentTaskId &&
			resumedCli.receipt?.verdict === "ship" && resumeSpawns.value === 1 &&
			afterParentSessions === beforeParentSessions && afterChildSessions === 1 &&
			existsSync(join(resumeRepo, "result.txt")),
			`CLI resumes a ready edge without replaying its parent (exit=${resumedCli.exitCode}, verdict=${resumedCli.receipt?.verdict ?? "none"}, parent=${beforeParentSessions}/${afterParentSessions}, child=${afterChildSessions}, spawns=${resumeSpawns.value}, error=${resumedCli.error ?? ""})`,
		);

		// Selector outcomes are resolved before provider construction. A terminal
		// repeat is a successful no-op, while an absent edge is a usage error.
		const terminalOutput: string[] = [];
		const terminalBefore = new LedgerStore(resumeDb);
		const terminalSessions = terminalBefore.listSessions(preparedResume.childTaskId).length;
		const terminalParentStatus = terminalBefore.getTask(preparedResume.parentTaskId)?.status;
		const terminalChildStatus = terminalBefore.getTask(preparedResume.childTaskId)?.status;
		const terminalEdge = terminalBefore.getTaskEdge(preparedResume.edgeId!);
		const terminalStatus = terminalEdge?.status;
		const terminalCompletedAt = terminalEdge?.completedAt;
		terminalBefore.close();
		const terminalRepeat = await runCli([
			"--resume", preparedResume.edgeId!, "--project-dir", resumeRepo,
			"--model", "fake/model", "--db", resumeDb, "--artifacts-dir", resumeArtifacts,
		], {
			host: fakeHost("ok", resumeSpawns),
			workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: resumeRepo }),
			write: (line) => terminalOutput.push(line),
		});
		const terminalAfter = new LedgerStore(resumeDb);
		check(
			terminalRepeat.exitCode === CLI_EDGE_TERMINAL_EXIT &&
			terminalOutput.length === 1 &&
			terminalOutput[0] === `edge ${preparedResume.edgeId} is already terminal: ${terminalStatus}` &&
			terminalAfter.getTaskEdge(preparedResume.edgeId!)?.status === terminalStatus &&
			terminalAfter.getTaskEdge(preparedResume.edgeId!)?.completedAt === terminalCompletedAt &&
			terminalAfter.getTask(preparedResume.parentTaskId)?.status === terminalParentStatus &&
			terminalAfter.getTask(preparedResume.childTaskId)?.status === terminalChildStatus &&
			terminalAfter.listSessions(preparedResume.childTaskId).length === terminalSessions &&
			resumeSpawns.value === 1,
			"repeating a terminal edge selector is an idempotent no-op",
		);
		terminalAfter.close();
		const unknownErrors: string[] = [];
		const unknown = await runCli([
			"--resume", "missing-edge", "--project-dir", resumeRepo,
			"--model", "fake/model", "--db", resumeDb, "--artifacts-dir", resumeArtifacts,
		], {
			host: fakeHost("ok", resumeSpawns),
			workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: resumeRepo }),
			writeError: (line) => unknownErrors.push(line),
		});
		check(
			unknown.exitCode === CLI_EDGE_UNKNOWN_EXIT &&
			unknown.error === "unknown edge id: missing-edge" &&
			unknownErrors[0] === "error: unknown edge id: missing-edge" &&
			resumeSpawns.value === 1,
			"unknown edge selector has a deterministic usage error and no spawn",
		);

		// A runtime model mismatch is rejected before child spawn and leaves a
		// durable block; repeating that selector takes the stable blocked branch.
		const mismatchRepo = join(root, "mismatch-repo");
		initRepo(mismatchRepo);
		const mismatchDb = join(root, "mismatch.sqlite");
		const mismatchArtifacts = join(root, "mismatch-artifacts");
		const mismatchPrepared = await prepareSequentialChild({
			parentSpecMarkdown: SPEC, childSpecMarkdown: SPEC, projectDir: mismatchRepo,
			artifactsDir: join(root, "mismatch-failures"), dbPath: mismatchDb,
			model: "fake/model",
			workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: mismatchRepo }),
			host: fakeHost("ok", { value: 0 }),
			artifactStore: new ContextArtifactStore({ root: join(root, "mismatch-continuations") }),
		});
		const mismatchSpawns = { value: 0 };
		const mismatchErrors: string[] = [];
		const mismatched = await runCli([
			"--resume", mismatchPrepared.edgeId!, "--project-dir", mismatchRepo,
			"--model", "other/model", "--db", mismatchDb, "--artifacts-dir", mismatchArtifacts,
		], {
			host: fakeHost("ok", mismatchSpawns),
			workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: mismatchRepo }),
			writeError: (line) => mismatchErrors.push(line),
		});
		const mismatchLedger = new LedgerStore(mismatchDb);
		check(
			mismatched.exitCode === CLI_EDGE_BLOCKED_EXIT &&
			mismatchErrors[0] === `error: edge ${mismatchPrepared.edgeId} is durably blocked` &&
			mismatchLedger.getTaskEdge(mismatchPrepared.edgeId!)?.status === "blocked" &&
			mismatchSpawns.value === 0,
			"incompatible runtime model is rejected before session spawn",
		);
		mismatchLedger.close();
		const blockedErrors: string[] = [];
		const blockedRepeat = await runCli([
			"--resume", mismatchPrepared.edgeId!, "--project-dir", mismatchRepo,
			"--model", "other/model", "--db", mismatchDb, "--artifacts-dir", mismatchArtifacts,
		], {
			host: fakeHost("ok", mismatchSpawns),
			workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: mismatchRepo }),
			writeError: (line) => blockedErrors.push(line),
		});
		check(
			blockedRepeat.exitCode === CLI_EDGE_BLOCKED_EXIT &&
			blockedRepeat.error === `edge ${mismatchPrepared.edgeId} is durably blocked` &&
			blockedErrors[0] === `error: edge ${mismatchPrepared.edgeId} is durably blocked` &&
			mismatchSpawns.value === 0,
			"durably blocked edge selector has a deterministic failure message",
		);

		const providerMismatchRepo = join(root, "provider-mismatch-repo");
		initRepo(providerMismatchRepo);
		const providerMismatchDb = join(root, "provider-mismatch.sqlite");
		const providerBaseDriver = new JujutsuWorkspaceDriver({ projectDir: providerMismatchRepo });
		const providerPrepared = await prepareSequentialChild({
			parentSpecMarkdown: SPEC, childSpecMarkdown: SPEC, projectDir: providerMismatchRepo,
			artifactsDir: join(root, "provider-mismatch-failures"), dbPath: providerMismatchDb,
			model: "fake/model", workspaceDriver: providerBaseDriver,
			host: fakeHost("ok", { value: 0 }),
			artifactStore: new ContextArtifactStore({ root: join(root, "provider-mismatch-continuations") }),
		});
		const providerMismatchSpawns = { value: 0 };
		const providerMismatch = await runCli([
			"--resume", providerPrepared.edgeId!, "--project-dir", providerMismatchRepo,
			"--model", "fake/model", "--db", providerMismatchDb,
			"--artifacts-dir", join(root, "provider-mismatch-artifacts"),
		], {
			host: fakeHost("ok", providerMismatchSpawns),
			workspaceDriver: providerIdentityMismatch(new JujutsuWorkspaceDriver({ projectDir: providerMismatchRepo })),
			writeError: () => undefined,
		});
		const providerMismatchLedger = new LedgerStore(providerMismatchDb);
		check(
			providerMismatch.exitCode === CLI_EDGE_BLOCKED_EXIT &&
			providerMismatchLedger.getTaskEdge(providerPrepared.edgeId!)?.status === "blocked" &&
			providerMismatchSpawns.value === 0,
			"incompatible runtime provider identity is rejected before session spawn",
		);
		providerMismatchLedger.close();

		// A warm ledger allocates a fresh attempt while preserving the same
		// task-family identity. The trace, receipt, and artifact names must all
		// follow that attempt rather than silently reusing the first run.
		const warmArtifacts = join(root, "warm-artifacts");
		const warm = await runCli(
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
				warmArtifacts,
			],
			deps,
		);
		check(
			warm.exitCode === 0,
			`warm-ledger task exits zero (${warm.error ?? ""}, ${warm.receipt?.verdict ?? "none"}, ${progress.slice(-8).join("|")})`,
		);
		check(
			warm.receipt?.taskId !== success.receipt?.taskId,
			"warm-ledger run gets a new attempt identity",
		);
		check(
			warm.receipt?.taskId.endsWith("-a2") === true,
			"warm-ledger run uses the second attempt suffix",
		);
		const warmTrace = readTrace(warm.tracePath);
		check(
			warmTrace.taskId === warm.receipt?.taskId &&
				warmTrace.runId === warm.receipt?.taskId,
			"warm trace and receipt identities agree",
		);
		const warmAssignment = warmTrace.events.find(
			(event) => event.type === "model.assigned",
		);
		check(
			warmAssignment?.detail?.familyId === success.receipt?.taskId &&
				warmAssignment?.detail?.attemptId === warm.receipt?.taskId &&
				warmAssignment?.detail?.attemptNumber === 2,
			"warm trace correlates the second attempt with its stable task family",
		);
		check(
			existsSync(join(warmArtifacts, `${warm.receipt?.taskId}.trace.json`)),
			"warm trace uses the receipt identity in its filename",
		);

		// Content acceptance runs after otherwise-passing verification: a
		// missing required report must not ship merely because result.txt passed.
		const requiredRepo = join(root, "required-report-repo");
		initRepo(requiredRepo);
		const requiredSpecPath = join(root, "required-report.md");
		writeFileSync(requiredSpecPath, REQUIRED_REPORT_SPEC, "utf8");
		const requiredArtifacts = join(root, "required-report-artifacts");
		const required = await runCli(
			[
				"--spec",
				requiredSpecPath,
				"--project-dir",
				requiredRepo,
				"--model",
				"fake/model",
				"--db",
				join(root, "required-report.sqlite"),
				"--artifacts-dir",
				requiredArtifacts,
			],
			{
				...deps,
				workspaceDriver: new JujutsuWorkspaceDriver({
					projectDir: requiredRepo,
				}),
				write: () => undefined,
			},
		);
		check(required.exitCode !== 0, "missing required report is non-shippable");
		check(
			required.receipt?.verdict === "failed",
			"missing required report returns failed receipt",
		);
		const requiredFailurePath =
			required.receipt?.taskId === undefined
				? undefined
				: join(requiredArtifacts, `${required.receipt.taskId}.failure.json`);
		check(
			requiredFailurePath !== undefined &&
				existsSync(requiredFailurePath) &&
				JSON.parse(readFileSync(requiredFailurePath, "utf8")).cause.includes(
					"missing_file",
				),
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
				"--spec",
				emptyChangeSpecPath,
				"--project-dir",
				emptyChangeRepo,
				"--model",
				"fake/model",
				"--db",
				join(root, "empty-change.sqlite"),
				"--artifacts-dir",
				emptyChangeArtifacts,
			],
			{
				...deps,
				workspaceDriver: new JujutsuWorkspaceDriver({
					projectDir: emptyChangeRepo,
				}),
				host: fakeHost("ok", undefined, { writeResult: false }),
				write: () => undefined,
			},
		);
		check(
			emptyChange.exitCode !== 0,
			"empty change-required task is non-shippable",
		);
		check(
			emptyChange.receipt?.verdict === "failed",
			"empty change-required task returns failed receipt",
		);
		const emptyChangeFailurePath =
			emptyChange.receipt?.taskId === undefined
				? undefined
				: join(
						emptyChangeArtifacts,
						`${emptyChange.receipt.taskId}.failure.json`,
					);
		check(
			emptyChangeFailurePath !== undefined &&
				existsSync(emptyChangeFailurePath) &&
				JSON.parse(readFileSync(emptyChangeFailurePath, "utf8")).cause.includes(
					"empty_change",
				),
			"empty change exposes an actionable acceptance reason",
		);

		// A declared intentional no-change task may ship when verification passes.
		const noChangeRepo = join(root, "intentional-no-change-repo");
		initRepo(noChangeRepo);
		const noChangeSpecPath = join(root, "intentional-no-change.md");
		writeFileSync(noChangeSpecPath, INTENTIONAL_NO_CHANGE_SPEC, "utf8");
		const noChange = await runCli(
			[
				"--spec",
				noChangeSpecPath,
				"--project-dir",
				noChangeRepo,
				"--model",
				"fake/model",
				"--db",
				join(root, "intentional-no-change.sqlite"),
				"--artifacts-dir",
				join(root, "intentional-no-change-artifacts"),
			],
			{
				...deps,
				workspaceDriver: new JujutsuWorkspaceDriver({
					projectDir: noChangeRepo,
				}),
				host: fakeHost("ok", undefined, { writeResult: false }),
				write: () => undefined,
			},
		);
		check(noChange.exitCode === 0, "declared intentional no-change task ships");
		check(
			noChange.receipt?.verdict === "ship",
			"intentional no-change returns ship receipt",
		);

		const setupArtifacts = join(root, "setup-failure-artifacts");
		const unsupportedDriver = new JujutsuWorkspaceDriver({ projectDir: repo });
		unsupportedDriver.isSupported = async () => false;
		const setupOutput: string[] = [];
		const setupFailure = await runCli(
			[
				"--spec",
				specPath,
				"--project-dir",
				repo,
				"--model",
				"fake/model",
				"--db",
				join(root, "setup-failure.sqlite"),
				"--artifacts-dir",
				setupArtifacts,
			],
			{
				...deps,
				workspaceDriver: unsupportedDriver,
				write: (line) => setupOutput.push(line),
			},
		);
		check(
			setupFailure.exitCode !== 0,
			"post-validation setup failure exits nonzero",
		);
		const setupTrace = readTrace(setupFailure.tracePath);
		check(
			setupTrace.outcome === "failed",
			"setup failure trace records failed outcome",
		);
		check(
			setupTrace.events.some(
				(event) =>
					event.type === "task.failed" &&
					event.detail?.stage === "setup" &&
					event.detail?.code === "internal_error",
			),
			"setup failure trace records a stable stage and code",
		);
		check(
			setupOutput.some((line) => line.startsWith("failure artifact: ")) &&
				setupOutput.some((line) => line.startsWith("trace artifact: ")),
			"setup failure output names its diagnostic artifacts",
		);
		check(
			setupTrace.taskId === deriveTaskId(SPEC, repo),
			"first setup failure uses the canonical task identity",
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
		const failedTrace = readTrace(failed.tracePath);
		check(
			failedTrace.taskId === failed.receipt?.taskId &&
				failedTrace.runId === failed.receipt?.taskId,
			"failed trace identity agrees with receipt",
		);
		check(
			failedTrace.outcome === "failed",
			"failed trace records failed outcome",
		);
		check(
			failedTrace.events.some(
				(event) =>
					event.type === "verification.completed" &&
					event.detail?.passed === false,
			),
			"failed trace records verification failure",
		);
		check(
			failedTrace.events.some(
				(event) =>
					event.type === "verification.completed" &&
					typeof event.detail?.evidence === "object",
			),
			"failed trace records structural failure evidence",
		);
		check(
			failedTrace.events.some((event) => event.type === "task.failed"),
			"failed trace records task failure",
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

		// Receipt delivery can fail independently of trace delivery. A
		// pre-existing directory at the receipt target makes the atomic rename
		// fail while the trace remains writable; the trace must say delivered=false.
		const receiptFailureRepo = join(root, "receipt-failure-repo");
		initRepo(receiptFailureRepo);
		const receiptFailureArtifacts = join(root, "receipt-failure-artifacts");
		const receiptFailureOutput: string[] = [];
		mkdirSync(receiptFailureArtifacts, { recursive: true });
		const receiptFailureTaskId = deriveTaskId(SPEC, receiptFailureRepo);
		mkdirSync(
			join(receiptFailureArtifacts, `${receiptFailureTaskId}.receipt.json`),
		);
		const receiptFailure = await runCli(
			[
				"--spec",
				specPath,
				"--project-dir",
				receiptFailureRepo,
				"--model",
				"fake/model",
				"--db",
				join(root, "receipt-failure.sqlite"),
				"--artifacts-dir",
				receiptFailureArtifacts,
			],
			{
				...deps,
				workspaceDriver: new JujutsuWorkspaceDriver({
					projectDir: receiptFailureRepo,
				}),
				write: (line) => receiptFailureOutput.push(line),
			},
		);
		check(
			receiptFailure.exitCode === 3,
			`receipt delivery failure maps to artifact exit (${receiptFailure.exitCode}, ${receiptFailure.error ?? ""})`,
		);
		check(
			receiptFailure.receipt?.verdict === "failed",
			"receipt delivery failure returns a non-ship receipt",
		);
		check(
			!receiptFailureOutput.some((line) => line.startsWith("receipt: ")),
			"receipt delivery failure does not print a ship receipt",
		);
		const receiptFailureArtifact =
			receiptFailure.receipt?.taskId === undefined
				? undefined
				: join(
						receiptFailureArtifacts,
						`${receiptFailure.receipt.taskId}.failure.json`,
					);
		check(
			receiptFailureArtifact !== undefined &&
				existsSync(receiptFailureArtifact) &&
				JSON.parse(readFileSync(receiptFailureArtifact, "utf8")).cause.includes(
					"receipt",
				),
			"receipt delivery failure retains a durable failure explanation",
		);
		const receiptFailureTrace = readTrace(receiptFailure.tracePath);
		check(
			receiptFailureTrace.outcome === "failed",
			"receipt delivery failure trace is non-ship",
		);
		check(
			receiptFailureTrace.events.some(
				(event) =>
					event.type === "receipt.delivered" &&
					event.detail?.delivered === false,
			),
			"trace reports failed receipt delivery honestly",
		);
		check(
			!receiptFailureTrace.events.some(
				(event) =>
					event.type === "receipt.delivered" &&
					event.detail?.delivered === true,
			),
			"trace does not report a failed receipt as delivered",
		);

		// The trace target itself is unwritable, so the CLI must return the
		// dedicated artifact exit even though the receipt was delivered.
		const traceFailureRepo = join(root, "trace-failure-repo");
		initRepo(traceFailureRepo);
		const traceFailureArtifacts = join(root, "trace-failure-artifacts");
		mkdirSync(traceFailureArtifacts, { recursive: true });
		mkdirSync(
			join(
				traceFailureArtifacts,
				`${deriveTaskId(SPEC, traceFailureRepo)}.trace.json`,
			),
		);
		const traceFailure = await runCli(
			[
				"--spec",
				specPath,
				"--project-dir",
				traceFailureRepo,
				"--model",
				"fake/model",
				"--db",
				join(root, "trace-failure.sqlite"),
				"--artifacts-dir",
				traceFailureArtifacts,
			],
			{
				...deps,
				workspaceDriver: new JujutsuWorkspaceDriver({
					projectDir: traceFailureRepo,
				}),
				write: () => undefined,
			},
		);
		check(
			traceFailure.exitCode === 3,
			"trace delivery failure maps to artifact exit",
		);
		check(
			traceFailure.receipt?.verdict === "failed",
			"trace delivery failure returns a non-ship receipt",
		);
		check(
			traceFailure.error?.includes("trace artifact delivery failed") === true,
			`trace delivery failure is actionable (${traceFailure.error ?? ""})`,
		);
		check(
			traceFailure.tracePath === undefined,
			"failed trace delivery is not reported as delivered",
		);
		const traceFailureArtifact =
			traceFailure.receipt?.taskId === undefined
				? undefined
				: join(
						traceFailureArtifacts,
						`${traceFailure.receipt.taskId}.failure.json`,
					);
		check(
			traceFailureArtifact !== undefined &&
				existsSync(traceFailureArtifact) &&
				JSON.parse(readFileSync(traceFailureArtifact, "utf8")).cause.includes(
					"trace",
				),
			"trace delivery failure retains a durable failure explanation",
		);

		const unavailableRepo = join(root, "unavailable-repo");
		initRepo(unavailableRepo);
		const unavailableArtifacts = join(root, "unavailable-artifacts");
		const unavailable = await runCli(
			[
				"--spec",
				specPath,
				"--project-dir",
				unavailableRepo,
				"--model",
				"fake/model",
				"--db",
				join(root, "unavailable.sqlite"),
				"--artifacts-dir",
				unavailableArtifacts,
			],
			{
				...deps,
				workspaceDriver: new JujutsuWorkspaceDriver({
					projectDir: unavailableRepo,
				}),
				host: fakeHost("ok", undefined, { turns: 3, statsAvailable: false }),
				write: () => undefined,
			},
		);
		check(
			unavailable.exitCode === 0,
			`unavailable usage run still ships (${unavailable.exitCode}, ${unavailable.error ?? ""}, ${unavailable.receipt?.verdict ?? "none"})`,
		);
		check(
			unavailable.receipt?.turns === 3,
			`receipt retains every observed turn when stats reject (${unavailable.receipt?.turns ?? "none"})`,
		);
		check(
			unavailable.receipt?.usageStatus === "unavailable",
			"receipt distinguishes unavailable usage from measured zero",
		);
		check(
			readTrace(unavailable.tracePath).usage?.status === "unavailable",
			"trace preserves unavailable usage status",
		);
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
