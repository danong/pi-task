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
import { InMemoryTaskGateway } from "./gateway/index.ts";
import { writeReceiptArtifact } from "./guards/receipts.ts";
import { startDaemon } from "./daemon/start.ts";
import { runIsolatedTask } from "./daemon/isolated.ts";
import { parseTaskSpec } from "./daemon/task-runner.ts";
import { JujutsuWorkspaceDriver } from "./workspaces/jj-driver.ts";
import type { SessionHost, SessionHostEvent } from "./sessions/host.ts";
import type { TaskLifecycleEvent } from "./contracts/gateway-events.ts";

const DEFAULT_STATE_ROOT = ".local/state";

export const CLI_USAGE_EXIT = 2;
export const CLI_TASK_EXIT = 1;
export const CLI_ARTIFACT_EXIT = 3;

export class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

export interface ParsedCliArgs {
	help: boolean;
	specPath?: string;
	projectDir: string;
	model: string;
	dbPath?: string;
	artifactsDir?: string;
	stateDir?: string;
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
}

export interface CliResult {
	exitCode: number;
	receipt?: Awaited<ReturnType<typeof runIsolatedTask>>["receipt"];
	receiptPath?: string;
	error?: string;
}

/** Stable help text for `mise run v2 -- --help`. */
export function cliHelp(): string {
	return `Usage: mise run v2 -- --spec <file> [options]

Execute exactly one pi-task-v2 task in an isolated jj workspace.

Options:
  --spec, -s <file>             Task markdown file (Goal, Requirements, Verification)
  --project-dir <directory>     Project jj repository (default: current directory)
  --model, -m <provider/model>  Worker model (required unless PI_TASK_V2_MODEL is set)
  --state-dir <directory>       State root for the ledger and artifacts
  --db <file>                   Ledger SQLite path (overrides --state-dir)
  --artifacts-dir <directory>   Receipt and failure-artifact directory
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
	let projectDir = process.cwd();
	let model = process.env.PI_TASK_V2_MODEL ?? "";
	let dbPath: string | undefined;
	let artifactsDir: string | undefined;
	let stateDir: string | undefined;
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
				"--project-dir",
				"--model",
				"--state-dir",
				"--db",
				"--artifacts-dir",
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
			case "--project-dir":
				projectDir = value;
				break;
			case "--model":
				model = value;
				break;
			case "--state-dir":
				stateDir = value;
				break;
			case "--db":
				dbPath = value;
				break;
			case "--artifacts-dir":
				artifactsDir = value;
				break;
		}
	}
	if (!help && specPath === undefined)
		throw new CliUsageError("--spec is required");
	if (!help && model.trim().length === 0)
		throw new CliUsageError(
			"--model is required (or set PI_TASK_V2_MODEL to a non-empty model id)",
		);
	return {
		help,
		...(specPath === undefined ? {} : { specPath }),
		projectDir,
		model,
		...(dbPath === undefined ? {} : { dbPath }),
		...(artifactsDir === undefined ? {} : { artifactsDir }),
		...(stateDir === undefined ? {} : { stateDir }),
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
	let specMarkdown: string;
	try {
		const projectStat = statSync(projectDir);
		if (!projectStat.isDirectory())
			throw new CliUsageError("--project-dir is not a directory");
		if (args.specPath === undefined)
			throw new CliUsageError("--spec is required");
		const specPath = resolvePath(args.specPath);
		specMarkdown = readFileSync(specPath, "utf8");
		parseTaskSpec(specMarkdown);
	} catch (error) {
		const message = validationError(error);
		writeError(`error: ${message}`);
		return { exitCode: CLI_USAGE_EXIT, error: message };
	}

	const paths = pathsFor(args, projectDir);
	try {
		mkdirSync(dirname(paths.dbPath), { recursive: true });
		const daemonStarter = dependencies.startDaemon ?? startDaemon;
		const daemon = await daemonStarter(paths.dbPath, { projectDir });
		try {
			const workspaceDriver =
				dependencies.workspaceDriver ??
				new JujutsuWorkspaceDriver({ projectDir });
			if (!(await workspaceDriver.isSupported()))
				throw new Error(
					"jj is unavailable or project-dir is not a jj repository",
				);
			const gateway =
				dependencies.gateway ??
				new InMemoryTaskGateway({ store: daemon.store });
			const unsubscribe = gateway.on("*", (event) =>
				write(renderProgress(event)),
			);
			write(`starting v2 task in ${projectDir}`);
			try {
				const result = await runIsolatedTask({
					specMarkdown,
					projectDir,
					artifactsDir: paths.artifactsDir,
					dbPath: paths.dbPath,
					model: args.model,
					workspaceDriver,
					...(dependencies.environmentDriver === undefined
						? {}
						: { environmentDriver: dependencies.environmentDriver }),
					...(dependencies.host === undefined
						? {}
						: { host: dependencies.host }),
					gateway,
					onEvent: (event) => write(renderProgress(event)),
				});
				const receiptPath = writeReceiptArtifact(
					result.receipt,
					paths.artifactsDir,
				);
				if (receiptPath === undefined) {
					const message = "receipt artifact delivery failed";
					writeError(`error: ${message}`);
					return {
						exitCode: CLI_ARTIFACT_EXIT,
						receipt: result.receipt,
						error: message,
					};
				}
				write(`receipt: ${JSON.stringify(result.receipt)}`);
				return {
					exitCode: cliExitCode(result.receipt.verdict, result.conflicts),
					receipt: result.receipt,
					receiptPath,
				};
			} finally {
				unsubscribe();
			}
		} finally {
			daemon.store.close();
		}
	} catch (error) {
		const message = validationError(error);
		writeError(`error: ${message}`);
		return { exitCode: CLI_TASK_EXIT, error: message };
	}
}

/** Real command entry point. */
if (
	process.argv[1]?.endsWith("/src/cli.ts") ||
	process.argv[1]?.endsWith("\\src\\cli.ts")
) {
	runCli(process.argv.slice(2)).then((result) => process.exit(result.exitCode));
}
