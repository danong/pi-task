/**
 * bwrap argument builder + host-side wiring for the worker sandbox
 * (design doc → Worker Sandbox).
 *
 * buildBwrapArgs() is pure — no I/O, no subprocess: it only produces the
 * argument list. The worker spawn is prefixed with `bwrap <args> --` by
 * spawnWorkerSession (worker.ts), using the wrapWorkerInvocation() decision
 * below.
 *
 * Strict policy: the whole root filesystem is mounted read-only first;
 * only the explicitly listed paths are read-write. Workers can read
 * system files, installed tools, and the agent dir (~/.pi/agent — their
 * tooling/extensions) but can only write to the worker cwd (project or
 * jj workspace), the orchestrator's temp dirs, the pi runtime-state paths
 * inside the agent dir (PI_RUNTIME_STATE_PATHS — settings.json, sessions/,
 * cache/, ...; todo #89), and any configured extra rw binds. The agent
 * dir's REPO CONTENT stays READ-ONLY: a parallel worker must not escape
 * its jj workspace by writing into the main repo through it (issue #83
 * reproduction: a worker wrote /home/danong/.pi/agent/a.txt via an
 * absolute path). This is safe for the checklist tool — its state lives
 * in session entries (pi.appendEntry → the session, in-memory with
 * --no-session), never in agent-dir files (confirmed against
 * extensions/task/tools/checklist.ts).
 *
 * Ordering is load-bearing for bwrap (mounts are applied in order):
 *   1. --ro-bind / /            read-only root FIRST
 *   2. --dev /dev --proc /proc --tmpfs /tmp
 *   3. namespace/isolation flags (--unshare-user/pid, --die-with-parent,
 *      --new-session)
 *   4. agent dir as --ro-bind — read-only, and BEFORE the cwd rw bind so
 *      that when cwd == agentDir (a single worker whose project IS the
 *      agent dir — e.g. this repo) the later rw bind wins for that path
 *   4b. pi runtime state paths in the agent dir (PI_RUNTIME_STATE_PATHS)
 *      as rw binds — settings.json/trust.json/sessions/cache/... must stay
 *      writable or the worker's pi process hangs on its first write
 *      (todo #89); repo content and auth.json stay read-only
 *   4c. the shared jj store (.jj/.git of projectDir) rw when projectDir
 *      differs from cwd — parallel workspace commits write into the shared
 *      store; a read-only store fails every commit (todo #89)
 *   5. explicit rw binds AFTER the ro root + agent-dir ro bind so they
 *      win for their paths: cwd, extra_rw_binds
 *   6. orchestrator temp dirs rw — they live under the OS tmpdir, which
 *      step 2 replaced with a fresh tmpfs, so each must be bound back
 *      explicitly or the CLI-arg paths passed to the worker vanish
 *   7. extra_ro_binds as ro binds
 *   8. --unshare-net when network = "isolate"
 *
 * Host-side wiring lives here too: probeBwrapAvailability() is the ONE
 * real user-namespace-exercising probe per run (R1); resolveSandbox()
 * resolves the effective sandbox for a run (option omitted → the built-in
 * defaults, matching loadTaskConfig's missing-file behavior); and
 * wrapWorkerInvocation() is the pure decision that prefixes a spawn with
 * `bwrap <args> --` (R2). The probe is the only I/O in this module;
 * buildBwrapArgs, resolveSandbox, and wrapWorkerInvocation stay pure
 * (the probe is injectable) and are hermetically tested.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from "./config.ts";

/** Default bwrap binary — resolved on PATH at probe/spawn time. */
export const BWRAP_BINARY = "bwrap";

/** Probe timeout (ms): a healthy bwrap answers in milliseconds. */
const PROBE_TIMEOUT_MS = 10_000;

export interface BuildBwrapOptions {
	/** Resolved [sandbox] vocabulary from task.toml (config.ts). */
	sandbox: SandboxConfig;
	/** Worker cwd — resolved absolute path (project dir or jj workspace dir). */
	cwd: string;
	/** Agent dir — resolved absolute path (~/.pi/agent). */
	agentDir: string;
	/**
	 * Orchestrator-created temp dirs that must stay visible inside the
	 * namespace: the worker system-prompt dir and, when present, the
	 * session dir. Both currently live under the OS tmpdir; --tmpfs /tmp
	 * shadows it, so each is bound explicitly rw.
	 */
	tempDirs?: string[];
	/**
	 * The project repo root (where the shared jj store lives). Needed when
	 * cwd differs from it — parallel workers run in jj workspaces under the
	 * OS tmpdir, and every workspace commit writes objects/ops into the
	 * SHARED store (the workspace's .jj/repo points at it; verified: a
	 * read-only store fails the commit with EROFS). When set and != cwd,
	 * its .jj/.git are bound rw. Omit when cwd IS the project (single
	 * workers) — the cwd rw bind already covers the store.
	 */
	projectDir?: string;
}

/**
 * Build the bwrap argument vector for one worker, or null when the
 * sandbox is disabled (the caller spawns the worker directly). Pure:
 * the caller resolves all paths to absolute form beforehand.
 */
/**
 * Agent-dir paths pi processes write at runtime — machine state, not repo
 * content (todo #89). A sandboxed worker's pi process writes settings.json
 * at startup (the changelog check records lastChangelogVersion — with these
 * read-only the worker hangs on the first write; observed P0), plus trust
 * state, the model catalog cache, session/package/cache/scratch dirs. They
 * are bound read-write below; everything else in the agent dir (config/,
 * extensions/, docs/, tracked files — and auth.json: readable for provider
 * auth, never writable) stays read-only, so the isolation guarantee (todo
 * #88: a parallel worker cannot escape its workspace into the main repo)
 * holds. Bind only what exists — bwrap fails on a missing source path.
 */
export const PI_RUNTIME_STATE_PATHS = [
	"settings.json",
	"trust.json",
	"models-store.json",
	"sessions",
	"cache",
	"results",
	"tmp",
	"npm",
	".npm-cache",
] as const;

export function buildBwrapArgs(opts: BuildBwrapOptions): string[] | null {
	const { sandbox } = opts;
	if (!sandbox.enabled) return null;

	const args: string[] = [
		// ── Strict policy base ──
		"--ro-bind", "/", "/", // read-only root FIRST; rw binds below shadow it
		"--dev", "/dev",
		"--proc", "/proc",
		"--tmpfs", "/tmp", // fresh per-worker scratchpad (no cross-worker leakage)
		"--unshare-user",
		"--unshare-pid",
		"--die-with-parent",
		"--new-session",
	];

	// ── Agent dir bound READ-ONLY, BEFORE the cwd rw bind ──
	// The agent dir (~/.pi/agent) holds the worker's tooling/extensions;
	// read-only suffices for workers to use them. The checklist tool is
	// unaffected by the read-only agent dir: init/done/status/context-
	// reminder all go through session entries via pi.appendEntry /
	// sessionManager.getEntries — state is bound to the session (in-memory
	// with --no-session), never written to agent-dir files (see
	// extensions/task/tools/checklist.ts). Mounted BEFORE the cwd rw bind:
	// when cwd == agentDir (a single worker whose project IS the agent
	// dir — e.g. this repo), the later rw bind shadows the ro bind and
	// the worker still commits to its project normally; when they differ
	// (the parallel case — cwd is the workspace dir), only the workspace
	// is writable and the agent dir stays read-only, closing the
	// isolation gap where a worker wrote into the main repo through the
	// agent dir (issue #83 reproduction: /home/danong/.pi/agent/a.txt).
	args.push("--ro-bind", opts.agentDir, opts.agentDir);

	// ── pi runtime state in the agent dir: READ-WRITE (todo #89) ──
	// Mounted AFTER the agent-dir ro bind (later binds shadow it for their
	// own paths) and BEFORE the cwd rw bind. See PI_RUNTIME_STATE_PATHS.
	for (const rel of PI_RUNTIME_STATE_PATHS) {
		const abs = join(opts.agentDir, rel);
		if (existsSync(abs)) args.push("--bind", abs, abs);
	}

	// ── Shared jj store: READ-WRITE for parallel commits (todo #89) ──
	// Workers commit via jj workspaces that share the project repo's store
	// — jj writes objects/ops there on every commit, so a read-only store
	// fails the commit with EROFS (verified empirically). Only needed when
	// cwd differs from the project (parallel runs: cwd is the workspace);
	// otherwise the cwd rw bind already covers it. Repo CONTENT stays ro —
	// this binds the store internals (.jj/.git), not the tracked files.
	if (opts.projectDir !== undefined && opts.projectDir !== opts.cwd) {
		for (const rel of [".jj", ".git"]) {
			const abs = join(opts.projectDir, rel);
			if (existsSync(abs)) args.push("--bind", abs, abs);
		}
	}

	// ── Explicit rw binds (after the ro root + agent-dir ro bind) ──
	const rwBinds = [opts.cwd, ...sandbox.extraRwBinds];
	for (const path of rwBinds) {
		args.push("--bind", path, path);
	}

	// Orchestrator temp dirs: bound rw AFTER --tmpfs /tmp (mount order) so
	// the system-prompt/session paths passed as CLI args remain visible.
	for (const path of opts.tempDirs ?? []) {
		args.push("--bind", path, path);
	}

	// ── Extra read-only binds ──
	for (const path of sandbox.extraRoBinds) {
		args.push("--ro-bind", path, path);
	}

	// ── Network isolation ──
	if (sandbox.network === "isolate") {
		args.push("--unshare-net");
	}

	return args;
}

// ─── Host-side resolution (R1) ───────────────────────────────────────

/** A spawn command + argument vector (the shape spawn() consumes). */
export interface SpawnInvocation {
	command: string;
	args: string[];
}

/**
 * The effective sandbox for one run: the [sandbox] vocabulary plus whether
 * it is actually usable on this host (enabled AND the probe passed).
 * Workers are wrapped only when `active` is true.
 */
export interface ResolvedSandbox {
	config: SandboxConfig;
	active: boolean;
}

/**
 * Host-side bwrap availability probe. Runs a REAL user-namespace-exercising
 * invocation — `bwrap --unshare-user --unshare-pid --ro-bind / / -- true` —
 * because `--version` succeeds even on kernels with user namespaces disabled.
 * The --ro-bind is required: bwrap's default rootfs is EMPTY, so a bare
 * `-- true` fails with `execvp true: No such file or directory` even when
 * userns works — the bind mount is what actually exercises the namespace.
 * Any failure (missing binary, userns disabled, seccomp policy) → unavailable.
 * bwrap is Linux-only, so non-Linux platforms are unavailable by definition.
 */
export function probeBwrapAvailability(): boolean {
	if (process.platform !== "linux") return false;
	try {
		execFileSync(
			BWRAP_BINARY,
			["--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "--", "true"],
			{
				stdio: "ignore",
				timeout: PROBE_TIMEOUT_MS,
			},
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve the effective sandbox for one run (R1). The option omitted → the
 * built-in defaults (the same shape loadTaskConfig yields for a missing
 * task.toml). When enabled, availability is probed exactly once via `probe`
 * (injectable for hermetic tests; production uses probeBwrapAvailability);
 * when disabled the host is never probed. The returned config is a defensive
 * copy — mutating it never touches the caller's or the built-in defaults.
 */
export function resolveSandbox(
	config: SandboxConfig | undefined,
	probe: () => boolean = probeBwrapAvailability,
): ResolvedSandbox {
	const cfg: SandboxConfig = config
		? { ...config, extraRoBinds: [...config.extraRoBinds], extraRwBinds: [...config.extraRwBinds] }
		: { ...DEFAULT_SANDBOX_CONFIG, extraRoBinds: [], extraRwBinds: [] };
	if (!cfg.enabled) return { config: cfg, active: false };
	return { config: cfg, active: probe() };
}

// ─── Spawn wrapping decision (R2) ────────────────────────────────────

/**
 * Pure spawn-wrapping decision (R2). When the resolved sandbox is active,
 * the spawn command becomes the bwrap binary and the args become
 * buildBwrapArgs(...) ++ ["--", <original command>, ...<original args>]
 * (bwrap execs the wrapped invocation inside the namespace). Otherwise the
 * invocation is returned byte-for-byte unchanged — the SAME object — so the
 * disabled/unavailable spawn path is provably identical to a pre-sandbox
 * spawn. `cwd` must be the resolved absolute worker cwd and `tempDirs` the
 * orchestrator temp dirs to bind back into the namespace (see
 * BuildBwrapOptions).
 */
export function wrapWorkerInvocation(opts: {
	sandbox: ResolvedSandbox | undefined;
	cwd: string;
	agentDir: string;
	tempDirs?: string[];
	projectDir?: string;
	invocation: SpawnInvocation;
	bwrapBinary?: string;
}): SpawnInvocation {
	const sb = opts.sandbox;
	if (!sb || !sb.active) return opts.invocation;
	const bwrapArgs = buildBwrapArgs({
		sandbox: sb.config,
		cwd: opts.cwd,
		agentDir: opts.agentDir,
		tempDirs: opts.tempDirs,
		projectDir: opts.projectDir,
	});
	if (bwrapArgs === null) return opts.invocation;
	return {
		command: opts.bwrapBinary ?? BWRAP_BINARY,
		args: [...bwrapArgs, "--", opts.invocation.command, ...opts.invocation.args],
	};
}
