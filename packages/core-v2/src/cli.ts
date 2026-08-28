/**
 * The first runnable v2 interface: one spec, one worker, one jj workspace.
 *
 * This module is intentionally an adapter. Validation uses the daemon's spec
 * parser; execution uses the daemon's isolated composition; jj, environment,
 * session, gateway, and receipt behavior remain owned by their providers.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type {
	EnvironmentDriver,
	TaskGateway,
	WorkspaceDriver,
} from "./contracts/index.ts";
import {
	TraceCollector,
	finalizeArtifactAcceptance,
	projectCliGatewayEvent,
	writeTraceArtifact,
	type TraceWriteResult,
} from "./contracts/index.ts";
import {
	buildWorkerSystemPrompt,
	deriveTaskId,
	estimateGroundingTokens,
	resolveAttemptId,
} from "./daemon/task-runner.ts";
import { InMemoryTaskGateway } from "./gateway/index.ts";
import { writeReceiptArtifact } from "./guards/receipts.ts";
import { writeFailureArtifact } from "./guards/artifacts.ts";
import { startDaemon } from "./daemon/start.ts";
import { runIsolatedTask } from "./daemon/isolated.ts";
import { resumeSequentialChild, runSequentialTask } from "./daemon/sequential.ts";
import { parseTaskSpecForCli } from "./daemon/task-runner.ts";
import { JujutsuWorkspaceDriver } from "./workspaces/jj-driver.ts";
import { LedgerStore } from "./ledger/store.ts";
import type { SessionHost, SessionHostEvent } from "./sessions/host.ts";
import type { TaskLifecycleEvent } from "./contracts/gateway-events.ts";
import type { ContextProviderFactory } from "./contracts/context-provider.ts";
import { acquisitionFactoryFromLegacy } from "./context/provider-adapter.ts";
import { rawContextProviderFactory } from "./context/raw-provider.ts";
import { ContextArtifactStore } from "./context/artifact-store.ts";
import type { ContextEvidenceEvent } from "./daemon/parallel.ts";
import { CORE_V2_MILESTONE, CORE_V2_VERSION } from "./version.ts";

const DEFAULT_STATE_ROOT = ".local/state";

export const CLI_USAGE_EXIT = 2;
export const CLI_TASK_EXIT = 1;
export const CLI_ARTIFACT_EXIT = 3;
/** Stable selector outcomes: an absent edge is a usage error, a durable
 * block is a task failure, and a terminal edge is an idempotent success. */
export const CLI_EDGE_UNKNOWN_EXIT = CLI_USAGE_EXIT;
export const CLI_EDGE_BLOCKED_EXIT = CLI_TASK_EXIT;
export const CLI_EDGE_TERMINAL_EXIT = 0;

export class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

export interface ParsedCliArgs {
	help: boolean;
	specPath?: string;
	childSpecPath?: string;
	resumeEdgeId?: string;
	projectDir: string;
	model: string;
	dbPath?: string;
	artifactsDir?: string;
	stateDir?: string;
	context: "raw" | "symbol-tree";
	maxTurns?: number;
	maxCostUsd?: number;
	wallTimeoutMs?: number;
}

export interface CliPaths {
	dbPath: string;
	artifactsDir: string;
}

export interface CliDependencies {
	/** Provider injection used by hermetic tests; production uses real hosts. */
	host?: SessionHost;
	workspaceDriver?: WorkspaceDriver;
	environmentDriver?: EnvironmentDriver;
	gateway?: TaskGateway;
	startDaemon?: typeof startDaemon;
	write?: (line: string) => void;
	writeError?: (line: string) => void;
	contextProviderFactory?: ContextProviderFactory;
}

export interface CliResult {
	exitCode: number;
	receipt?: Awaited<ReturnType<typeof runIsolatedTask>>["receipt"];
	receiptPath?: string;
	tracePath?: string;
	error?: string;
}

/** Stable help text for `mise run v2 -- --help`. */
export function cliHelp(): string {
	return `Usage: mise run v2 -- --spec <file> [options]

Execute exactly one pi-task-v2 task in an isolated jj workspace.

Options:
  --spec, -s <file>             Task markdown file (Goal, Requirements, Verification)
  --child-spec <file>           One durable continuation child (raw context only)
  --resume <edge-id>            Resume one durable continuation edge (raw context only; terminal is a no-op)
  --project-dir <directory>     Project jj repository (default: current directory)
  --model, -m <provider/model>  Worker model (required unless PI_TASK_V2_MODEL is set)
  --state-dir <directory>       State root for the ledger and artifacts
  --db <file>                   Ledger SQLite path (overrides --state-dir)
  --artifacts-dir <directory>   Receipt and failure-artifact directory
  --context <raw|symbol-tree>   Explicit context provider (default: raw)
  --max-turns <n>               Independent maxTurns cap (0 = no cap, default unset)
  --max-cost-usd <n>            Independent maxCostUsd cap in USD (0 = no cap, default unset)
  --wall-timeout-ms <n>         Session wall timeout in ms (positive integer, default host timeout)
  --help, -h                    Show this help

Defaults are outside the repository: XDG_STATE_HOME/pi-task-v2/<project>/.
The worker is committed and verified on the integrated jj tree.\n`;
}

function valueFor(
	argv: readonly string[],
	index: number,
	option: string,
): { value: string; next: number } {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--"))
		throw new CliUsageError(`${option} requires a value`);
	return { value, next: index + 1 };
}

/** Parse only CLI syntax. Filesystem and spec validation happen separately. */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
	let help = false;
	let specPath: string | undefined;
	let childSpecPath: string | undefined;
	let resumeEdgeId: string | undefined;
	let projectDir = process.cwd();
	let model = process.env.PI_TASK_V2_MODEL ?? "";
	let dbPath: string | undefined;
	let artifactsDir: string | undefined;
	let stateDir: string | undefined;
	let context: "raw" | "symbol-tree" = "raw";
	let maxTurns: number | undefined;
	let maxCostUsd: number | undefined;
	let wallTimeoutMs: number | undefined;
	const seen = new Set<string>();

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]!;
		if (arg === "--") continue;
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		const equals = arg.indexOf("=");
		const name = equals < 0 ? arg : arg.slice(0, equals);
		const inline = equals < 0 ? undefined : arg.slice(equals + 1);
		const key =
			name === "-s"
				? "--spec"
				: name === "-m"
					? "--model"
					: name === "--project"
						? "--project-dir"
						: name;
		if (
			![
				"--spec",
				"--child-spec",
				"--resume",
				"--project-dir",
				"--model",
				"--state-dir",
				"--db",
				"--artifacts-dir",
				"--context",
				"--max-turns",
				"--max-cost-usd",
				"--wall-timeout-ms",
			].includes(key)
		)
			throw new CliUsageError(`unknown option: ${arg}`);
		if (seen.has(key))
			throw new CliUsageError(`option specified more than once: ${key}`);
		seen.add(key);
		let value: string;
		if (inline !== undefined) {
			if (inline.length === 0)
				throw new CliUsageError(`${key} requires a value`);
			value = inline;
		} else {
			const selected = valueFor(argv, i, key);
			value = selected.value;
			i = selected.next;
		}
		switch (key) {
			case "--spec":
				specPath = value;
				break;
			case "--child-spec":
				childSpecPath = value;
				break;
			case "--resume":
				resumeEdgeId = value;
				break;
			case "--project-dir":
				projectDir = value;
				break;
			case "--model":
				model = value;
				break;
			case "--state-dir":
				stateDir = value;
				break;
			case "--context":
				if (value !== "raw" && value !== "symbol-tree")
					throw new CliUsageError("--context must be raw or symbol-tree");
				context = value;
				break;
			case "--db":
				dbPath = value;
				break;
			case "--artifacts-dir":
				artifactsDir = value;
				break;
			case "--max-turns": {
				const n = Number(value);
				if (!Number.isInteger(n) || n < 0)
					throw new CliUsageError("--max-turns must be an integer >= 0");
				maxTurns = n;
				break;
			}
			case "--max-cost-usd": {
				const n = Number(value);
				if (!Number.isFinite(n) || n < 0)
					throw new CliUsageError("--max-cost-usd must be a finite number >= 0");
				maxCostUsd = n;
				break;
			}
			case "--wall-timeout-ms": {
				const n = Number(value);
				if (!Number.isInteger(n) || n <= 0)
					throw new CliUsageError("--wall-timeout-ms must be a positive integer");
				wallTimeoutMs = n;
				break;
			}
		}
	}
	if (!help && specPath === undefined && resumeEdgeId === undefined)
		throw new CliUsageError("--spec is required unless --resume is selected");
	if (!help && resumeEdgeId !== undefined && specPath !== undefined)
		throw new CliUsageError("--resume cannot be combined with --spec");
	if (!help && resumeEdgeId !== undefined && childSpecPath !== undefined)
		throw new CliUsageError("--resume cannot be combined with --child-spec");
	if (!help && childSpecPath !== undefined && context !== "raw")
		throw new CliUsageError("--child-spec currently requires --context raw");
	if (!help && resumeEdgeId !== undefined && context !== "raw")
		throw new CliUsageError("--resume currently requires --context raw");
	if (!help && model.trim().length === 0)
		throw new CliUsageError(
			"--model is required (or set PI_TASK_V2_MODEL to a non-empty model id)",
		);
	return {
		help,
		...(specPath === undefined ? {} : { specPath }),
		...(childSpecPath === undefined ? {} : { childSpecPath }),
		...(resumeEdgeId === undefined ? {} : { resumeEdgeId }),
		projectDir,
		model,
		...(dbPath === undefined ? {} : { dbPath }),
		...(artifactsDir === undefined ? {} : { artifactsDir }),
		...(stateDir === undefined ? {} : { stateDir }),
		context,
		...(maxTurns === undefined ? {} : { maxTurns }),
		...(maxCostUsd === undefined ? {} : { maxCostUsd }),
		...(wallTimeoutMs === undefined ? {} : { wallTimeoutMs }),
	};
}

/** Compute repository-independent default locations. Injectable environment
 * and home arguments make the location rule directly testable. */
export function defaultCliPaths(
	projectDir: string,
	environment: NodeJS.ProcessEnv = process.env,
	home = homedir(),
): CliPaths {
	const projectKey = createHash("sha256")
		.update(resolve(projectDir))
		.digest("hex")
		.slice(0, 16);
	const stateRoot =
		environment.XDG_STATE_HOME?.trim() === undefined ||
		environment.XDG_STATE_HOME.trim().length === 0
			? join(home, DEFAULT_STATE_ROOT)
			: resolve(environment.XDG_STATE_HOME);
	const runRoot = join(stateRoot, "pi-task-v2", projectKey);
	return {
		dbPath: join(runRoot, "ledger.sqlite"),
		artifactsDir: join(runRoot, "artifacts"),
	};
}

function resolvePath(value: string, base = process.cwd()): string {
	return isAbsolute(value) ? value : resolve(base, value);
}

function pathsFor(args: ParsedCliArgs, projectDir: string): CliPaths {
	const defaults = defaultCliPaths(projectDir);
	const state =
		args.stateDir === undefined ? undefined : resolvePath(args.stateDir);
	return {
		dbPath: resolvePath(
			args.dbPath ??
				(state === undefined ? defaults.dbPath : join(state, "ledger.sqlite")),
		),
		artifactsDir: resolvePath(
			args.artifactsDir ??
				(state === undefined
					? defaults.artifactsDir
					: join(state, "artifacts")),
		),
	};
}

function renderGatewayEvent(event: TaskLifecycleEvent): string {
	switch (event.type) {
		case "task.queued":
			return "task queued";
		case "task.routed":
			return `task routed: ${event.detail.planMode}`;
		case "session.spawned":
			return "session spawned";
		case "session.yielded":
			return "session yielded";
		case "session.exhausted":
			return "session exhausted";
		case "verify.completed":
			return `verification ${event.detail.passed ? "passed" : "failed"}`;
		case "merge.completed":
			return "merge completed";
		case "merge.conflict":
			return `merge conflict: ${event.detail.conflicts.join(", ")}`;
		case "task.completed":
			return `outcome: ${event.detail.verdict}`;
		case "task.failed":
			return `outcome: failed (${event.detail.cause})`;
		case "task.escalated":
			return "outcome: escalate";
		case "review.completed":
			return `review: ${event.detail.verdict}`;
		case "permission.requested":
			return "permission requested";
		case "child.queued":
			return "child queued";
		case "child.claimed":
			return "child claimed";
		case "child.resumable":
			return "child resumable";
		case "child.blocked":
			return "child blocked";
		case "child.completed":
			return "child completed";
		case "child.failed":
			return "child failed";
		case "child.escalated":
			return "child escalated";
		case "continuation.checkpointed":
			return "continuation checkpointed";
		case "continuation.resumed":
			return "continuation resumed";
	}
}

/** Render only structural gateway activity; no transcript or reasoning. */
export function renderProgress(
	event: TaskLifecycleEvent | SessionHostEvent,
): string {
	if (event.type === "turnStart") return "turn start";
	if (event.type === "toolStart") return `tool start: ${event.toolName}`;
	if (event.type === "toolEnd")
		return `tool end: ${event.toolName}${event.isError ? " (error)" : ""}`;
	if (event.type === "settled") return "session settled";
	if (event.type === "yielded") return "worker yielded";
	if (event.type === "error") return `session error: ${event.message}`;
	return renderGatewayEvent(event);
}

export function cliExitCode(
	verdict: "ship" | "failed" | "escalate",
	conflicts: readonly string[] = [],
): number {
	if (verdict === "ship") return 0;
	if (conflicts.length > 0 || verdict === "escalate") return CLI_TASK_EXIT;
	return CLI_TASK_EXIT;
}

function validationError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function recordSessionEvent(
	trace: TraceCollector,
	event: SessionHostEvent,
	turnState: { active: boolean },
): void {
	if (event.type === "turnStart") {
		if (turnState.active)
			trace.record({ type: "turn.ended", phase: "turn", taskId: trace.taskId });
		turnState.active = true;
		trace.record({ type: "turn.started", phase: "turn", taskId: trace.taskId });
		return;
	}
	if (event.type === "toolStart" || event.type === "toolEnd") {
		trace.record({
			type: event.type === "toolStart" ? "tool.started" : "tool.ended",
			phase: "tool",
			taskId: trace.taskId,
			sessionId: `${trace.taskId}-worker`,
			detail: {
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				...(event.type === "toolStart" && event.path === undefined
					? {}
					: event.type === "toolStart"
						? { path: event.path }
						: {}),
				...(event.type === "toolEnd" ? { isError: event.isError } : {}),
			},
		});
		return;
	}
	if (
		event.type === "settled" ||
		event.type === "yielded" ||
		event.type === "error"
	) {
		if (turnState.active) {
			trace.record({ type: "turn.ended", phase: "turn", taskId: trace.taskId });
			turnState.active = false;
		}
	}
	if (event.type === "error") {
		trace.record({
			type: "failure",
			phase: "session",
			taskId: trace.taskId,
			sessionId: `${trace.taskId}-worker`,
			detail: {
				cause: event.message,
				stage: "session",
				code:
					event.code === "timed_out" ? "session_timed_out" : "session_failed",
				hostCode: event.code,
			},
		});
	} else if (event.type === "yielded") {
		trace.record({
			type: "session.ended",
			phase: "session",
			taskId: trace.taskId,
			sessionId: `${trace.taskId}-worker`,
			detail: { outcome: "yielded" },
		});
	} else if (event.type === "settled") {
		trace.record({
			type: "session.ended",
			phase: "session",
			taskId: trace.taskId,
			sessionId: `${trace.taskId}-worker`,
			detail: { outcome: "settled" },
		});
	}
}

function createCliTrace(
	taskId: string,
	familyId: string,
	model: string,
	specMarkdown: string,
	caps: { maxTurns?: number; maxCostUsd?: number; wallTimeoutMs?: number } = {},
): TraceCollector {
	const trace = new TraceCollector(taskId, taskId);
	const provider = model.split("/")[0]?.trim() || "unknown";
	trace.record({
		type: "model.assigned",
		phase: "model",
		taskId,
		provider,
		config: model.trim(),
		detail: {
			modelId: model,
			engineVersion: CORE_V2_VERSION,
			milestone: CORE_V2_MILESTONE,
			specHash: `sha256:${createHash("sha256").update(specMarkdown).digest("hex")}`,
			familyId,
			attemptId: taskId,
			attemptNumber:
				taskId === familyId
					? 1
					: Number.parseInt(taskId.slice(familyId.length + 2), 10),
			...(caps.maxTurns === undefined ? {} : { maxTurns: caps.maxTurns }),
			...(caps.maxCostUsd === undefined ? {} : { maxCostUsd: caps.maxCostUsd }),
			...(caps.wallTimeoutMs === undefined ? {} : { wallTimeoutMs: caps.wallTimeoutMs }),
		},
	});
	// Context lifecycle evidence is emitted by the selected capability before
	// the worker spawn; the task prompt itself is not a context artifact.
	return trace;
}

/** Write once to establish the artifact, then record delivery and rewrite it.
 * The first snapshot is always failed: if the final rewrite cannot be
 * delivered, the durable trace cannot falsely claim that a task shipped. */
function finishTrace(
	trace: TraceCollector,
	artifactsDir: string,
	outcome: "ship" | "failed" | "escalate",
): TraceWriteResult {
	const initial = writeTraceArtifact(trace.finish("failed"), artifactsDir);
	if (!initial.ok) return initial;
	try {
		trace.record({
			type: "trace.delivered",
			phase: "artifact",
			taskId: trace.taskId,
			detail: { delivered: true },
		});
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	return writeTraceArtifact(trace.finish(outcome), artifactsDir);
}

/** Execute the adapter without calling process.exit; suitable for tests. */
export async function runCli(
	argv: readonly string[],
	dependencies: CliDependencies = {},
): Promise<CliResult> {
	const write =
		dependencies.write ?? ((line: string) => process.stdout.write(`${line}\n`));
	const writeError =
		dependencies.writeError ??
		((line: string) => process.stderr.write(`${line}\n`));
	let args: ParsedCliArgs;
	try {
		args = parseCliArgs(argv);
	} catch (error) {
		const message = validationError(error);
		writeError(`error: ${message}`);
		return { exitCode: CLI_USAGE_EXIT, error: message };
	}
	if (args.help) {
		write(cliHelp().trimEnd());
		return { exitCode: 0 };
	}

	const projectDir = resolvePath(args.projectDir);
	// Resume reads the child specification and all other ingress data from the
	// durable edge; it must not require, validate, or reconstruct the parent
	// submission.
	let specMarkdown = "";
	let childSpecMarkdown: string | undefined;
	try {
		const projectStat = statSync(projectDir);
		if (!projectStat.isDirectory())
			throw new CliUsageError("--project-dir is not a directory");
		if (args.resumeEdgeId === undefined) {
			if (args.specPath === undefined)
				throw new CliUsageError("--spec is required");
			const specPath = resolvePath(args.specPath);
			specMarkdown = readFileSync(specPath, "utf8");
			// Strict policy validation is the CLI ingress boundary. Keep it before
			// path resolution for runtime state and before daemon/workspace/session
			// construction so providers cannot observe an invalid task input.
			parseTaskSpecForCli(specMarkdown);
			if (args.childSpecPath !== undefined) {
				childSpecMarkdown = readFileSync(resolvePath(args.childSpecPath), "utf8");
				parseTaskSpecForCli(childSpecMarkdown);
			}
		}
	} catch (error) {
		const message = validationError(error);
		writeError(`error: ${message}`);
		return { exitCode: CLI_USAGE_EXIT, error: message };
	}

	const paths = pathsFor(args, projectDir);
	let familyId = args.resumeEdgeId ?? deriveTaskId(childSpecMarkdown === undefined ? specMarkdown : `${specMarkdown}\n<!-- continuation -->\n${childSpecMarkdown}`, projectDir);
	let trace: TraceCollector | undefined;
	let traceTaskId = familyId;
	let runAnnounced = false;
	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	const announceRun = (): void => {
		if (runAnnounced) return;
		write(`run: ${traceTaskId}`);
		runAnnounced = true;
	};
	const deliverFailureTrace = (
		cause: string,
		classification: {
			stage: "setup" | "internal";
			code: "internal_error";
		} = { stage: "internal", code: "internal_error" },
	): CliResult => {
		trace ??= createCliTrace(traceTaskId, familyId, args.model, specMarkdown, {
			...(args.maxTurns === undefined ? {} : { maxTurns: args.maxTurns }),
			...(args.maxCostUsd === undefined ? {} : { maxCostUsd: args.maxCostUsd }),
			...(args.wallTimeoutMs === undefined ? {} : { wallTimeoutMs: args.wallTimeoutMs }),
		});
		announceRun();
		trace.record({
			type: "failure",
			phase: "task",
			taskId: trace.taskId,
			detail: { cause, ...classification },
		});
		trace.record({
			type: "task.failed",
			phase: "task",
			taskId: trace.taskId,
			detail: { cause, ...classification },
		});
		const failurePath = writeFailureArtifact({
			artifactsDir: paths.artifactsDir,
			runId: trace.taskId,
			cause,
		});
		const traceDelivery = finishTrace(trace, paths.artifactsDir, "failed");
		if (failurePath === undefined)
			writeError("error: failure artifact delivery failed");
		if (traceDelivery.error !== undefined)
			writeError(
				`error: trace artifact delivery failed: ${traceDelivery.error}`,
			);
		if (failurePath !== undefined) write(`failure artifact: ${failurePath}`);
		if (traceDelivery.path !== undefined)
			write(`trace artifact: ${traceDelivery.path}`);
		const deliveryError =
			traceDelivery.error === undefined
				? undefined
				: `trace artifact delivery failed: ${traceDelivery.error}`;
		return {
			exitCode:
				failurePath === undefined || deliveryError !== undefined
					? CLI_ARTIFACT_EXIT
					: CLI_TASK_EXIT,
			error: deliveryError ?? cause,
			...(traceDelivery.path === undefined
				? {}
				: { tracePath: traceDelivery.path }),
		};
	};
	try {
		mkdirSync(dirname(paths.dbPath), { recursive: true });
		const daemonStarter = dependencies.startDaemon ?? startDaemon;
		if (args.resumeEdgeId === undefined) {
			// Resolve the attempt before daemon/workspace/provider setup so even a
			// setup failure can use the same first/warm-ledger identity as a run.
			const identityStore = new LedgerStore(paths.dbPath);
			try {
				traceTaskId = resolveAttemptId(identityStore, familyId);
			} finally {
				identityStore.close();
			}
		}
		daemon = await daemonStarter(paths.dbPath, { projectDir });
		if (args.resumeEdgeId !== undefined) {
			// Select non-runnable states before constructing providers or traces. This
			// keeps selector outcomes deterministic and makes terminal selection a
			// genuinely side-effect-free idempotent operation.
			const selectedEdge = daemon.store.getTaskEdge(args.resumeEdgeId);
			if (selectedEdge === null) {
				const message = `unknown edge id: ${args.resumeEdgeId}`;
				writeError(`error: ${message}`);
				return { exitCode: CLI_EDGE_UNKNOWN_EXIT, error: message };
			}
			if (selectedEdge.status === "blocked") {
				const message = `edge ${args.resumeEdgeId} is durably blocked`;
				writeError(`error: ${message}`);
				return { exitCode: CLI_EDGE_BLOCKED_EXIT, error: message };
			}
			if (["completed", "failed", "escalated"].includes(selectedEdge.status)) {
				const message = `edge ${args.resumeEdgeId} is already terminal: ${selectedEdge.status}`;
				write(message);
				return { exitCode: CLI_EDGE_TERMINAL_EXIT };
			}
			// The parent id is only a correlation identity for the adapter trace;
			// all executable child inputs remain inside resumeSequentialChild's
			// durable manifest.
			traceTaskId = selectedEdge.parentTaskId;
			familyId = traceTaskId;
		} else {
			const daemonAttemptId = resolveAttemptId(daemon.store, familyId);
			if (daemonAttemptId !== traceTaskId)
				throw new Error(
					`attempt identity changed during daemon setup: ${traceTaskId} -> ${daemonAttemptId}`,
				);
		}
		trace = createCliTrace(traceTaskId, familyId, args.model, specMarkdown, {
			...(args.maxTurns === undefined ? {} : { maxTurns: args.maxTurns }),
			...(args.maxCostUsd === undefined ? {} : { maxCostUsd: args.maxCostUsd }),
			...(args.wallTimeoutMs === undefined ? {} : { wallTimeoutMs: args.wallTimeoutMs }),
		});
		announceRun();
		const workspaceDriver =
			dependencies.workspaceDriver ??
			new JujutsuWorkspaceDriver({ projectDir });
		if (!(await workspaceDriver.isSupported()))
			throw new Error(
				"jj is unavailable or project-dir is not a jj repository",
			);
		const gateway =
			dependencies.gateway ?? new InMemoryTaskGateway({ store: daemon.store });
		const tracedGateway: TaskGateway = {
			emit: (event) => {
				gateway.emit(event);
				const projected = projectCliGatewayEvent(
					event,
					trace!.runId,
					trace!.taskId,
				);
				if (projected !== undefined) trace!.record(projected);
			},
			on: (pattern, handler) => gateway.on(pattern, handler),
			getTaskState: (taskId) => gateway.getTaskState(taskId),
			getManifest: (taskId) => gateway.getManifest(taskId),
		};
		const unsubscribe = gateway.on("*", (event) =>
			write(renderProgress(event)),
		);
		const turnState = { active: false };
		write(`starting v2 task in ${projectDir}`);
		try {
			const selectedContextFactory =
				dependencies.contextProviderFactory ??
				(args.context === "symbol-tree"
					? (await import("./context/providers.ts"))
							.symbolTreeContextProviderFactory
					: rawContextProviderFactory);
			const contextArtifactStore =
				selectedContextFactory.identity.id === "raw"
					? undefined
					: new ContextArtifactStore({
							root: join(dirname(paths.artifactsDir), "context-cache"),
						});
			const sharedExecution = {
				projectDir,
				artifactsDir: paths.artifactsDir,
				dbPath: paths.dbPath,
				model: args.model,
				...(args.maxTurns === undefined ? {} : { maxTurns: args.maxTurns }),
				...(args.maxCostUsd === undefined ? {} : { maxCostUsd: args.maxCostUsd }),
				...(args.wallTimeoutMs === undefined ? {} : { sessionTimeoutMs: args.wallTimeoutMs }),
				workspaceDriver,
				...(dependencies.environmentDriver === undefined ? {} : { environmentDriver: dependencies.environmentDriver }),
				...(dependencies.host === undefined ? {} : { host: dependencies.host }),
				gateway: tracedGateway,
			};
			let resumeBlocked = false;
			const result = args.resumeEdgeId !== undefined
				? await (async () => {
						const sequential = await resumeSequentialChild(args.resumeEdgeId!, {
							...sharedExecution,
							artifactStore: new ContextArtifactStore({ root: join(dirname(paths.artifactsDir), "continuations") }),
							contextCapabilitiesFactory: acquisitionFactoryFromLegacy(selectedContextFactory),
							...(contextArtifactStore === undefined ? {} : { contextArtifactStore }),
							onContextEvent: (event: ContextEvidenceEvent) =>
								trace!.record({
									type: event.type,
									phase: event.type.startsWith("epoch") || event.type.startsWith("checkpoint") ? "recovery" : "context",
									taskId: trace!.taskId,
									provider: event.provider.id,
									config: event.provider.version,
									detail: event.detail,
								}),
							onEvent: (event) => {
								write(renderProgress(event));
								recordSessionEvent(trace!, event, turnState);
							},
						});
						resumeBlocked = sequential.status === "blocked";
						return { receipt: sequential.parent, conflicts: sequential.status === "escalated" ? ["child escalation"] : [] };
					})()
				: childSpecMarkdown === undefined
					? await runIsolatedTask({
							...sharedExecution,
							specMarkdown,
							contextCapabilitiesFactory: acquisitionFactoryFromLegacy(selectedContextFactory),
							...(contextArtifactStore === undefined ? {} : { contextArtifactStore }),
							onContextEvent: (event: ContextEvidenceEvent) =>
								trace!.record({
									type: event.type,
									phase: event.type.startsWith("epoch") || event.type.startsWith("checkpoint") ? "recovery" : "context",
									taskId: trace!.taskId,
									provider: event.provider.id,
									config: event.provider.version,
									detail: event.detail,
								}),
							onEvent: (event) => {
								write(renderProgress(event));
								recordSessionEvent(trace!, event, turnState);
							},
						})
					: await (async () => {
							const sequential = await runSequentialTask({
								...sharedExecution,
								parentSpecMarkdown: specMarkdown,
								childSpecMarkdown,
								artifactStore: new ContextArtifactStore({ root: join(dirname(paths.artifactsDir), "continuations") }),
								parentTaskId: traceTaskId,
								childTaskId: `${traceTaskId}-child`,
								edgeId: `${traceTaskId}-edge`,
								contextCapabilitiesFactory: acquisitionFactoryFromLegacy(selectedContextFactory),
								...(contextArtifactStore === undefined ? {} : { contextArtifactStore }),
								onEvent: (event) => write(renderProgress(event)),
							});
							return { receipt: sequential.parent, conflicts: sequential.status === "escalated" ? ["child escalation"] : [] };
						})();
			if (resumeBlocked) {
				const message = `edge ${args.resumeEdgeId!} is durably blocked`;
				writeError(`error: ${message}`);
				return { exitCode: CLI_EDGE_BLOCKED_EXIT, error: message };
			}
			const receipt = result.receipt;
			if (receipt.taskId !== trace.taskId)
				throw new Error(
					`trace task identity ${trace.taskId} disagrees with receipt ${receipt.taskId}`,
				);
			trace.setUsage({
				status: receipt.usageStatus === "measured" ? "measured" : "unavailable",
				costUsd: receipt.costUsd,
				inputTokens: receipt.inputTokens,
				outputTokens: receipt.outputTokens,
				cacheReadTokens: receipt.cacheReadTokens,
				cacheWriteTokens: 0,
			});

			// Establish a truthful non-ship receipt first. It is upgraded only
			// after the trace has also been durably delivered, preventing a
			// trace failure from leaving a shipped receipt behind.
			const provisionalReceipt =
				receipt.verdict === "ship"
					? { ...receipt, verdict: "failed" as const }
					: receipt;
			const receiptPath = writeReceiptArtifact(
				provisionalReceipt,
				paths.artifactsDir,
			);
			const receiptDelivered = receiptPath !== undefined;
			trace.record({
				type: "receipt.delivered",
				phase: "artifact",
				taskId: trace.taskId,
				detail: { delivered: receiptDelivered },
			});
			if (!receiptDelivered) {
				writeError("error: receipt artifact delivery failed");
				trace.record({
					type: "failure",
					phase: "artifact",
					taskId: trace.taskId,
					detail: {
						cause: "receipt artifact delivery failed",
						stage: "delivery",
						code: "delivery_failed",
					},
				});
				trace.record({
					type: "task.failed",
					phase: "task",
					taskId: trace.taskId,
					detail: {
						cause: "receipt artifact delivery failed",
						stage: "delivery",
						code: "delivery_failed",
					},
				});
			}

			// Content acceptance is owned by the runner and deliberately remains
			// semantic-free here. This finalization stage adds only transport
			// facts; a task ships iff the runner shipped and both artifacts exist.
			const traceOutcome =
				receipt.verdict === "ship"
					? receiptDelivered
						? "ship"
						: "failed"
					: receipt.verdict;
			const traceDelivery = finishTrace(
				trace,
				paths.artifactsDir,
				traceOutcome,
			);
			const finalized = finalizeArtifactAcceptance(
				{
					accepted: true,
					reasons: [],
					actualFiles: [],
					...(receipt.commitIds[0] === undefined
						? {}
						: { commitId: receipt.commitIds[0] }),
				},
				{ receiptDelivered, traceDelivered: traceDelivery.ok },
			);
			const deliveryError = [
				...(receiptDelivered
					? []
					: [`receipt artifact delivery failed at ${paths.artifactsDir}`]),
				...(traceDelivery.ok
					? []
					: [
							`trace artifact delivery failed: ${traceDelivery.error ?? "unknown error"}`,
						]),
			].join("; ");
			const contentAccepted = receipt.verdict === "ship";
			const ships = contentAccepted && finalized.accepted;
			const finalReceipt = ships
				? receipt
				: { ...receipt, verdict: "failed" as const };
			if (traceDelivery.error !== undefined)
				writeError(
					`error: trace artifact delivery failed: ${traceDelivery.error}`,
				);

			if (!ships && (!contentAccepted || !finalized.accepted)) {
				const deliveryReasons = finalized.reasons
					.filter(
						(reason) =>
							reason.code === "receipt_missing" ||
							reason.code === "trace_missing",
					)
					.map((reason) => `${reason.code}: ${reason.detail}`);
				if (deliveryReasons.length > 0) {
					writeFailureArtifact({
						artifactsDir: paths.artifactsDir,
						runId: trace.taskId,
						cause: `artifact delivery failed after content acceptance: ${deliveryError || deliveryReasons.join("; ")}`,
					});
				}
			}
			if (!ships && (!receiptDelivered || !traceDelivery.ok)) {
				return {
					exitCode: CLI_ARTIFACT_EXIT,
					receipt: finalReceipt,
					...(receiptPath === undefined ? {} : { receiptPath }),
					...(traceDelivery.path === undefined
						? {}
						: { tracePath: traceDelivery.path }),
					error: deliveryError || "artifact delivery failed",
				};
			}
			if (receiptPath === undefined) {
				return {
					exitCode: CLI_ARTIFACT_EXIT,
					receipt: finalReceipt,
					error: "receipt artifact delivery failed",
				};
			}
			// Replace the provisional receipt only after both delivery checks
			// passed. A failed rewrite leaves the already durable failed receipt.
			const deliveredReceiptPath = ships
				? writeReceiptArtifact(finalReceipt, paths.artifactsDir)
				: receiptPath;
			if (deliveredReceiptPath === undefined) {
				writeFailureArtifact({
					artifactsDir: paths.artifactsDir,
					runId: trace.taskId,
					cause: "receipt artifact delivery failed during finalization",
				});
				return {
					exitCode: CLI_ARTIFACT_EXIT,
					receipt: { ...receipt, verdict: "failed" as const },
					error: "receipt artifact delivery failed during finalization",
				};
			}
			write(`receipt: ${JSON.stringify(finalReceipt)}`);
			write(`receipt artifact: ${deliveredReceiptPath}`);
			if (traceDelivery.path !== undefined)
				write(`trace artifact: ${traceDelivery.path}`);
			return {
				exitCode: cliExitCode(finalReceipt.verdict, result.conflicts),
				receipt: finalReceipt,
				receiptPath: deliveredReceiptPath,
				...(traceDelivery.path === undefined
					? {}
					: { tracePath: traceDelivery.path }),
			};
		} catch (error) {
			const message = validationError(error);
			return deliverFailureTrace(message);
		} finally {
			unsubscribe();
		}
	} catch (error) {
		const message = validationError(error);
		return deliverFailureTrace(message, {
			stage: "setup",
			code: "internal_error",
		});
	} finally {
		if (daemon !== undefined) daemon.store.close();
	}
}

/** Real command entry point. */
if (
	process.argv[1]?.endsWith("/src/cli.ts") ||
	process.argv[1]?.endsWith("\\src\\cli.ts")
) {
	runCli(process.argv.slice(2)).then((result) => process.exit(result.exitCode));
}
