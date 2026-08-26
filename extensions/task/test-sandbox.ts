/**
 * Sandbox builder tests — pure-function unit tests + one guarded real-bwrap
 * probe, no LLM:
 *
 * 1. Disabled config → null (plain spawn path).
 * 2. Strict policy arg set: ro root FIRST, --dev/--proc/--tmpfs /tmp,
 *    --unshare-user/--unshare-pid/--die-with-parent/--new-session.
 * 3. Agent dir bound READ-ONLY (--ro-bind) BEFORE the cwd rw bind, which
 *    must come AFTER it so it shadows the ro bind when cwd == agentDir;
 *    when they differ the agent dir is never rw-bound.
 * 4. Orchestrator temp dirs bound rw, each AFTER --tmpfs /tmp.
 * 5. network "isolate" appends --unshare-net; "allow" omits it.
 * 6. extra_ro_binds appended as ro binds, extra_rw_binds as rw binds.
 * 7. Real bwrap (skipped when the binary is not on PATH): the built args
 *    actually sandbox — rw cwd writable, agent dir NOT writable when it
 *    differs from cwd, $HOME/.ssh NOT writable, /tmp writable (tmpfs).
 * 8. Sandbox resolution (R1, hermetic): omitted option → built-in defaults;
 *    disabled → never probes; enabled → probes exactly once with the
 *    injected probe; the resolved config is a defensive copy.
 * 9. Spawn wrapping decision (R2, hermetic): active → `bwrap <args> --
 *    <invocation>` with the cwd/agent/temp-dir binds; disabled/unavailable/
 *    absent → the SAME invocation object, byte-for-byte unchanged.
 * 10. Real bwrap kill propagation (R4b, skipped when bwrap or user
 *    namespaces are unavailable): SIGTERM to a bwrap'd long-running child
 *    terminates it promptly — the worker abort path keeps working through
 *    the sandbox.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from "./config.ts";
import {
	PI_RUNTIME_STATE_PATHS,
	buildBwrapArgs,
	probeBwrapAvailability,
	resolveSandbox,
	wrapWorkerInvocation,
} from "./sandbox.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Index of the triple [flag, dest, dest] (or [flag, arg]) in args, else -1. */
function findTriple(args: string[], a: string, b: string, c?: string): number {
	for (let i = 0; i < args.length; i++) {
		if (
			args[i] === a &&
			args[i + 1] === b &&
			(c === undefined || args[i + 2] === c)
		)
			return i;
	}
	return -1;
}

function sandboxConfig(overrides: Partial<SandboxConfig>): SandboxConfig {
	return { ...DEFAULT_SANDBOX_CONFIG, ...overrides };
}

/** Run a jj command (host side) and return stdout. Throws on failure. */
function jj(args: string[], cwd: string): string {
	return execFileSync("jj", args, { cwd, encoding: "utf8" }).trim();
}

/** True when the bwrap binary is runnable on this machine. */
function bwrapAvailable(): boolean {
	try {
		execFileSync("bwrap", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
		return true;
	} catch {
		return false;
	}
}

// ─── Section 1: disabled → null (R3) ────────────────────────────────

function testDisabled(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const args = buildBwrapArgs({
		sandbox: sandboxConfig({ enabled: false }),
		cwd: "/proj",
		agentDir: "/home/u/.pi/agent",
	});
	check(
		args === null,
		`disabled sandbox must return null, got ${JSON.stringify(args)}`,
	);
	console.log("✓ disabled sandbox → null (R3)");
}

// ─── Section 2: strict policy arg set (R1) ──────────────────────────

function testStrictPolicy(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const args = buildBwrapArgs({
		sandbox: sandboxConfig({}),
		cwd: "/proj",
		agentDir: "/home/u/.pi/agent",
	});
	check(args !== null, "enabled sandbox must return args");
	if (args === null) return;

	// ro root FIRST — exactly the first three entries.
	check(
		args[0] === "--ro-bind" && args[1] === "/" && args[2] === "/",
		`first triple must be --ro-bind / /, got ${JSON.stringify(args.slice(0, 3))}`,
	);
	// Strict base set in order after the ro root.
	const roRoot = findTriple(args, "--ro-bind", "/", "/");
	const dev = findTriple(args, "--dev", "/dev");
	const proc = findTriple(args, "--proc", "/proc");
	const tmp = findTriple(args, "--tmpfs", "/tmp");
	check(
		dev > roRoot && proc > dev && tmp > proc,
		`--dev /dev, --proc /proc, --tmpfs /tmp must follow the ro root in order, got ${JSON.stringify(args)}`,
	);
	for (const flag of [
		"--unshare-user",
		"--unshare-pid",
		"--die-with-parent",
		"--new-session",
	]) {
		check(args.includes(flag), `strict policy must include ${flag}`);
	}
	// Default network mode "allow" → no network isolation.
	check(
		!args.includes("--unshare-net"),
		`network "allow" must not add --unshare-net`,
	);
	console.log(
		"✓ strict policy arg set: ro root first, dev/proc/tmpfs, unshare-user/pid, die-with-parent, new-session (R1)",
	);
}

// ─── Section 3: agent dir ro-bind + cwd rw bind ordering (R1) ────────

function testRwBinds(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const cwd = "/work/proj";
	const agentDir = "/home/u/.pi/agent";
	const args = buildBwrapArgs({ sandbox: sandboxConfig({}), cwd, agentDir });
	check(args !== null, "enabled sandbox must return args");
	if (args === null) return;

	const roRoot = findTriple(args, "--ro-bind", "/", "/");
	const agentRo = findTriple(args, "--ro-bind", agentDir, agentDir);
	const cwdBind = findTriple(args, "--bind", cwd, cwd);
	check(
		agentRo > roRoot,
		`agent dir ro bind must come after the ro root bind, got ${JSON.stringify(args)}`,
	);
	check(
		cwdBind > agentRo,
		`cwd rw bind must come AFTER the agent-dir ro bind (so it shadows it when cwd == agentDir), got ${JSON.stringify(args)}`,
	);
	check(
		cwdBind !== -1 && agentRo !== -1,
		`cwd must be --bind rw and the agent dir --ro-bind, got ${JSON.stringify(args)}`,
	);
	// The agent dir is NEVER rw-bound: a parallel worker must not write
	// into the main repo through it (issue #83 reproduction).
	check(
		findTriple(args, "--bind", agentDir, agentDir) === -1,
		`agent dir must not be rw-bound, got ${JSON.stringify(args)}`,
	);
	console.log("✓ agent dir ro-bind before cwd rw bind (R1)");
}

// cwd == agentDir (a single worker whose project IS the agent dir): the
// later cwd rw bind shadows the ro bind for that path, so the worker
// keeps full write access to its project.
function testCwdEqualsAgentDir(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const p = "/home/u/.pi/agent";
	const args = buildBwrapArgs({
		sandbox: sandboxConfig({}),
		cwd: p,
		agentDir: p,
	});
	check(args !== null, "enabled sandbox must return args");
	if (args === null) return;

	const ro = findTriple(args, "--ro-bind", p, p);
	const rw = findTriple(args, "--bind", p, p);
	check(
		ro !== -1,
		`agent-dir ro bind must be present when cwd == agentDir, got ${JSON.stringify(args)}`,
	);
	check(
		rw !== -1 && rw > ro,
		`the cwd rw bind must come AFTER the ro bind for the same path (it shadows it), got ${JSON.stringify(args)}`,
	);
	check(
		rw === args.lastIndexOf("--bind"),
		`the cwd rw bind must be the last rw bind for that path (nothing later shadows it), got ${JSON.stringify(args)}`,
	);
	console.log("✓ cwd == agentDir: cwd rw bind shadows the ro bind (R1)");
}

// ─── Section 3.5: pi runtime-state rw binds (todo #89) ──────────────

function testRuntimeStateBinds(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const root = mkdtempSync(join(tmpdir(), "pi-task-sbx-rt-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "cwd");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	try {
		// Runtime state that EXISTS → must be rw-bound; repo content +
		// auth.json exist too → must NOT be rw-bound.
		writeFileSync(join(agentDir, "settings.json"), "{}", "utf-8");
		writeFileSync(join(agentDir, "trust.json"), "{}", "utf-8");
		mkdirSync(join(agentDir, "sessions"));
		mkdirSync(join(agentDir, "cache"));
		writeFileSync(join(agentDir, "auth.json"), "{}", "utf-8");
		mkdirSync(join(agentDir, "config"));
		writeFileSync(join(agentDir, "config", "task.toml"), "", "utf-8");

		const args = buildBwrapArgs({ sandbox: sandboxConfig({}), cwd, agentDir });
		check(args !== null, "enabled sandbox must return args");
		if (args === null) return;

		const roAgent = findTriple(args, "--ro-bind", agentDir, agentDir);
		const rwCwd = findTriple(args, "--bind", cwd, cwd);
		check(roAgent !== -1, "agent-dir ro bind present");
		for (const rel of ["settings.json", "trust.json", "sessions", "cache"]) {
			const p = join(agentDir, rel);
			const rw = findTriple(args, "--bind", p, p);
			check(
				rw !== -1 && rw > roAgent && rw < rwCwd,
				`runtime state ${rel} must be rw-bound between the agent-dir ro bind and the cwd rw bind, got ${JSON.stringify(args)}`,
			);
		}
		// Absent runtime paths are skipped (bwrap fails on missing sources):
		// results/ was not created above.
		check(
			findTriple(
				args,
				"--bind",
				join(agentDir, "results"),
				join(agentDir, "results"),
			) === -1,
			"absent runtime paths must not be bound",
		);
		// Repo content + secrets stay out of the rw binds.
		check(
			findTriple(
				args,
				"--bind",
				join(agentDir, "auth.json"),
				join(agentDir, "auth.json"),
			) === -1,
			"auth.json must not be rw-bound (secrets: readable for provider auth, never writable)",
		);
		check(
			findTriple(
				args,
				"--bind",
				join(agentDir, "config"),
				join(agentDir, "config"),
			) === -1,
			"repo content (config/) must not be rw-bound",
		);
		// The runtime list is the contract — guard against accidental edits.
		check(
			PI_RUNTIME_STATE_PATHS.includes("settings.json") &&
				PI_RUNTIME_STATE_PATHS.includes("sessions"),
			"PI_RUNTIME_STATE_PATHS carries the pi runtime state entries",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	console.log(
		"✓ pi runtime state: rw binds for existing state paths only; repo content + auth.json stay ro (todo #89)",
	);
}

// ─── Section 3.6: shared jj store rw bind for parallel commits (todo #89) ──

function testProjectDirStoreBinds(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const root = mkdtempSync(join(tmpdir(), "pi-task-sbx-store-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const cwd = join(root, "ws");
	mkdirSync(agentDir);
	mkdirSync(projectDir);
	mkdirSync(cwd);
	try {
		writeFileSync(join(agentDir, "settings.json"), "{}", "utf-8");
		mkdirSync(join(projectDir, ".jj"));
		mkdirSync(join(projectDir, ".git"));

		// projectDir differs from cwd (the parallel case): the shared store
		// (.jj/.git) must be rw-bound, after the runtime binds and before
		// the cwd rw bind.
		const args = buildBwrapArgs({
			sandbox: sandboxConfig({}),
			cwd,
			agentDir,
			projectDir,
		});
		check(args !== null, "enabled sandbox must return args");
		if (args === null) return;
		const rwCwd = findTriple(args, "--bind", cwd, cwd);
		for (const rel of [".jj", ".git"]) {
			const p = join(projectDir, rel);
			const rw = findTriple(args, "--bind", p, p);
			check(
				rw !== -1 && rw < rwCwd,
				`shared store ${rel} must be rw-bound before the cwd rw bind, got ${JSON.stringify(args)}`,
			);
		}

		// projectDir == cwd (single worker): the cwd rw bind already covers
		// the store — no extra binds.
		const single = buildBwrapArgs({
			sandbox: sandboxConfig({}),
			cwd: projectDir,
			agentDir,
			projectDir,
		});
		check(
			single !== null &&
				findTriple(
					single,
					"--bind",
					join(projectDir, ".jj"),
					join(projectDir, ".jj"),
				) === -1,
			"no store binds when projectDir == cwd (the cwd rw bind covers it)",
		);

		// Missing store paths are skipped (bwrap fails on missing sources).
		const noStore = mkdtempSync(join(tmpdir(), "pi-task-sbx-nostore-"));
		try {
			const bare = buildBwrapArgs({
				sandbox: sandboxConfig({}),
				cwd,
				agentDir,
				projectDir: noStore,
			});
			check(
				bare !== null &&
					findTriple(
						bare,
						"--bind",
						join(noStore, ".jj"),
						join(noStore, ".jj"),
					) === -1,
				"absent store paths must not be bound",
			);
		} finally {
			rmSync(noStore, { recursive: true, force: true });
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	console.log(
		"✓ shared jj store: rw binds when projectDir != cwd, skipped otherwise (todo #89)",
	);
}

// ─── Section 4: temp dirs bound after --tmpfs /tmp (R2) ─────────────

function testTempDirs(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const promptDir = "/tmp/pi-task-worker-abc123";
	const sessionDir = "/tmp/pi-task-session-def456";
	const args = buildBwrapArgs({
		sandbox: sandboxConfig({}),
		cwd: "/proj",
		agentDir: "/home/u/.pi/agent",
		tempDirs: [promptDir, sessionDir],
	});
	check(args !== null, "enabled sandbox must return args");
	if (args === null) return;

	const tmp = findTriple(args, "--tmpfs", "/tmp");
	check(tmp !== -1, "--tmpfs /tmp must be present");
	for (const dir of [promptDir, sessionDir]) {
		const bind = findTriple(args, "--bind", dir, dir);
		check(
			bind !== -1,
			`temp dir ${dir} must be bound rw, got ${JSON.stringify(args)}`,
		);
		check(
			bind > tmp,
			`temp dir ${dir} bind must come AFTER --tmpfs /tmp (mount order), got ${JSON.stringify(args)}`,
		);
	}

	// No temp dirs → only cwd is a rw bind (the agent dir is ro, not rw).
	const none = buildBwrapArgs({
		sandbox: sandboxConfig({}),
		cwd: "/proj",
		agentDir: "/home/u/.pi/agent",
	});
	check(
		none !== null && none.filter((a) => a === "--bind").length === 1,
		`without tempDirs only cwd is a rw bind, got ${JSON.stringify(none)}`,
	);
	console.log("✓ temp dirs bound rw, ordered after --tmpfs /tmp (R2)");
}

// ─── Section 5: network isolate (R1) ────────────────────────────────

function testNetworkIsolate(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const args = buildBwrapArgs({
		sandbox: sandboxConfig({ network: "isolate" }),
		cwd: "/proj",
		agentDir: "/home/u/.pi/agent",
	});
	check(args !== null, "enabled sandbox must return args");
	if (args === null) return;
	check(
		args.includes("--unshare-net"),
		`network "isolate" must append --unshare-net, got ${JSON.stringify(args)}`,
	);
	check(
		args[args.length - 1] === "--unshare-net",
		`--unshare-net must be appended last, got ${JSON.stringify(args.slice(-3))}`,
	);
	console.log('✓ network "isolate" appends --unshare-net (R1)');
}

// ─── Section 6: extra ro/rw binds (R1) ──────────────────────────────

function testExtraBinds(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const args = buildBwrapArgs({
		sandbox: sandboxConfig({
			extraRoBinds: ["/data/models", "/opt/cache"],
			extraRwBinds: ["/scratch/build"],
		}),
		cwd: "/proj",
		agentDir: "/home/u/.pi/agent",
	});
	check(args !== null, "enabled sandbox must return args");
	if (args === null) return;

	const cwdBind = findTriple(args, "--bind", "/proj", "/proj");
	for (const p of ["/data/models", "/opt/cache"]) {
		const ro = findTriple(args, "--ro-bind", p, p);
		check(
			ro !== -1,
			`extra_ro_binds entry ${p} must be a --ro-bind, got ${JSON.stringify(args)}`,
		);
	}
	const extraRw = findTriple(
		args,
		"--bind",
		"/scratch/build",
		"/scratch/build",
	);
	check(
		extraRw !== -1,
		`extra_rw_binds entry must be a --bind, got ${JSON.stringify(args)}`,
	);
	check(
		extraRw > cwdBind,
		`extra_rw_binds must come after the cwd bind, got ${JSON.stringify(args)}`,
	);
	// The ro root stays the FIRST ro bind at the head; the agent-dir ro
	// bind and extras never shadow it.
	check(
		args[0] === "--ro-bind" && args[1] === "/",
		"ro root must remain first",
	);
	console.log("✓ extra_ro_binds as ro binds, extra_rw_binds as rw binds (R1)");
}

// ─── Section 7: real bwrap probe (R5, guarded) ──────────────────────

function testRealBwrap(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	if (!bwrapAvailable()) {
		console.log("○ real-bwrap probe skipped (bwrap not on PATH)");
		return;
	}

	const root = mkdtempSync(join(tmpdir(), "pi-task-sbx-"));
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	// mkdtempSync only creates `root`; create the bind targets too — bwrap
	// needs the sources to exist. settings.json + config/ exercise the
	// runtime-state rw exception (todo #89) vs repo-content ro.
	mkdirSync(cwd);
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), "{}", "utf-8");
	mkdirSync(join(agentDir, "config"));
	writeFileSync(join(agentDir, "config", "task.toml"), "", "utf-8");

	try {
		const args = buildBwrapArgs({
			sandbox: sandboxConfig({}),
			cwd,
			agentDir,
		});
		check(args !== null, "enabled sandbox must return args");
		if (args === null) return;

		// Inside the namespace: probe writability of the rw-bound cwd, the
		// READ-ONLY agent dir (parallel case: differs from cwd), the fresh
		// /tmp, and a strict-policy target ($HOME/.ssh). Markers on stdout
		// keep the assertions independent of exit codes.
		const script = [
			`touch "$CWD/w" && echo cwd-rw || echo cwd-ro`,
			`touch "$AGENT/a" && echo agent-rw || echo agent-ro`,
			`touch "$AGENT/settings.json" && echo settings-rw || echo settings-ro`,
			`touch "$AGENT/config/task.toml" && echo config-rw || echo config-ro`,
			`touch /tmp/t && echo tmp-rw || echo tmp-ro`,
			`touch "$HOME/.ssh/pi-task-sbx-probe" 2>/dev/null && echo ssh-rw || echo ssh-ro`,
		].join("; ");

		let stdout = "";
		try {
			stdout = execFileSync("bwrap", [...args, "--", "sh", "-c", script], {
				encoding: "utf8",
				timeout: 30_000,
				env: { ...process.env, CWD: cwd, AGENT: agentDir },
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			const e = err as Error & { stdout?: string; stderr?: string };
			errors.push(
				`bwrap probe run failed: ${e.message}\nstdout: ${e.stdout}\nstderr: ${e.stderr}`,
			);
			return;
		}

		const lines = stdout
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		check(
			lines.includes("cwd-rw"),
			`rw-bound cwd must be writable inside the sandbox, got: ${JSON.stringify(lines)}`,
		);
		check(
			lines.includes("agent-ro"),
			`agent dir must be READ-ONLY inside the sandbox when it differs from cwd (issue #83), got: ${JSON.stringify(lines)}`,
		);
		check(
			!lines.includes("agent-rw"),
			`agent dir write must not succeed, got: ${JSON.stringify(lines)}`,
		);
		check(
			lines.includes("settings-rw"),
			`settings.json (pi runtime state) must be writable inside the sandbox (todo #89), got: ${JSON.stringify(lines)}`,
		);
		check(
			lines.includes("config-ro"),
			`repo content (config/) must stay READ-ONLY inside the sandbox, got: ${JSON.stringify(lines)}`,
		);
		check(
			lines.includes("tmp-rw"),
			`/tmp (tmpfs) must be writable inside the sandbox, got: ${JSON.stringify(lines)}`,
		);
		check(
			lines.includes("ssh-ro"),
			`$HOME/.ssh must NOT be writable (strict policy: only cwd is rw), got: ${JSON.stringify(lines)}`,
		);
		check(
			!lines.includes("ssh-rw"),
			`$HOME/.ssh write must not succeed, got: ${JSON.stringify(lines)}`,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	console.log(
		"✓ real-bwrap probe: cwd rw, agent dir ro, $HOME/.ssh ro, /tmp writable (R5)",
	);
}

// ─── Section 7.5: real-bwrap parallel workspace commit (todo #89) ────

/**
 * The decisive regression for the ro-agent-dir sandbox (todo #89): a
 * parallel worker commits through a jj workspace whose shared store lives
 * in the (read-only) agent dir. Under the strict ro bind, `jj commit`
 * fails with EROFS (verified: "Could not create named temp file in
 * .../.git/objects"); the projectDir store bind (.jj/.git rw) must make
 * the commit work while the repo's tracked files stay read-only and pi's
 * runtime state (settings.json) stays writable.
 */
function testRealWorkspaceCommit(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	if (!bwrapAvailable()) {
		console.log(
			"○ real-bwrap workspace-commit probe skipped (bwrap not on PATH)",
		);
		return;
	}

	const root = mkdtempSync(join(tmpdir(), "pi-task-sbx-commit-"));
	const projectDir = join(root, "project"); // agent dir AND project dir (this repo's layout)
	const wsDir = join(root, "ws");
	try {
		mkdirSync(projectDir); // jj git init needs its cwd to exist
		// Colocated jj repo with a committed tracked file + a workspace.
		jj(["git", "init", "--colocate"], projectDir);
		writeFileSync(join(projectDir, "tracked.txt"), "base\n", "utf-8");
		jj(["commit", "-m", "base"], projectDir);
		jj(["workspace", "add", wsDir, "--name", "w1"], projectDir);
		// pi runtime state the worker's pi process writes at startup.
		writeFileSync(join(projectDir, "settings.json"), "{}", "utf-8");

		const args = buildBwrapArgs({
			sandbox: sandboxConfig({}),
			cwd: wsDir,
			agentDir: projectDir,
			projectDir,
		});
		check(args !== null, "enabled sandbox must return args");
		if (args === null) return;

		// Inside the namespace: commit in the workspace (writes the shared
		// store), probe repo-content ro and runtime-state rw. Markers on
		// stdout keep the assertions independent of exit codes.
		const script = [
			`cd "$WS" && echo w > w.txt && jj commit -m "worker work" >/dev/null 2>&1 && echo commit-ok || echo commit-fail`,
			`touch "$PROJ/tracked.txt" 2>/dev/null && echo tracked-rw || echo tracked-ro`,
			`touch "$PROJ/settings.json" && echo settings-rw || echo settings-ro`,
		].join("; ");

		let stdout = "";
		try {
			stdout = execFileSync("bwrap", [...args, "--", "sh", "-c", script], {
				encoding: "utf8",
				timeout: 30_000,
				env: { ...process.env, WS: wsDir, PROJ: projectDir },
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			const e = err as Error & { stdout?: string; stderr?: string };
			errors.push(
				`bwrap commit probe failed: ${e.message}\nstdout: ${e.stdout}\nstderr: ${e.stderr}`,
			);
			return;
		}

		const lines = stdout
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		check(
			lines.includes("commit-ok"),
			`parallel workspace commit must succeed (shared store rw), got: ${JSON.stringify(lines)}`,
		);
		check(
			lines.includes("tracked-ro"),
			`tracked repo content must stay READ-ONLY, got: ${JSON.stringify(lines)}`,
		);
		check(
			lines.includes("settings-rw"),
			`settings.json (pi runtime state) must be writable, got: ${JSON.stringify(lines)}`,
		);

		// The commit must actually exist in the shared store (not just exit 0)
		// — the orchestrator's merge resolves it host-side afterwards.
		const log = jj(
			["log", "--no-graph", "-T", 'description.first_line() ++ "\n"'],
			projectDir,
		);
		check(
			log.includes("worker work"),
			`worker commit must land in the shared store, got: ${JSON.stringify(log)}`,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	console.log(
		"✓ real-bwrap parallel workspace commit: store rw, tracked content ro, settings.json rw (todo #89)",
	);
}

// ─── Section 8: sandbox resolution (R1, hermetic) ───────────────────

function testResolveSandbox(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// Omitted option → built-in defaults (enabled), probed exactly once.
	let probeCalls = 0;
	const probe = (): boolean => {
		probeCalls++;
		return true;
	};
	const omitted = resolveSandbox(undefined, probe);
	check(
		omitted.config.enabled === true,
		`omitted sandbox → built-in defaults (enabled), got ${JSON.stringify(omitted.config)}`,
	);
	check(
		omitted.active === true && probeCalls === 1,
		`enabled default probes exactly once, got active=${omitted.active} calls=${probeCalls}`,
	);
	check(
		omitted.config.extraRoBinds.length === 0 &&
			omitted.config.extraRwBinds.length === 0,
		"omitted sandbox → default bind lists are empty",
	);

	// Disabled → never probes, never active.
	probeCalls = 0;
	const disabled = resolveSandbox(sandboxConfig({ enabled: false }), probe);
	check(
		disabled.active === false && probeCalls === 0,
		`disabled sandbox never probes, got active=${disabled.active} calls=${probeCalls}`,
	);

	// Enabled + failed probe → inactive (the graceful-fallback path).
	const failed = resolveSandbox(sandboxConfig({}), () => false);
	check(
		failed.config.enabled === true && failed.active === false,
		"enabled sandbox with a failed probe → inactive (fallback)",
	);

	// Defensive copy: mutating the resolved config never touches the built-in
	// defaults or the caller's object.
	const callerCfg = sandboxConfig({ extraRoBinds: ["/x"] });
	const resolved = resolveSandbox(callerCfg, () => true);
	resolved.config.extraRoBinds.push("/y");
	check(
		DEFAULT_SANDBOX_CONFIG.extraRoBinds.length === 0,
		"mutating the resolved config must not touch DEFAULT_SANDBOX_CONFIG",
	);
	check(
		callerCfg.extraRoBinds.length === 1,
		"mutating the resolved config must not touch the caller's config",
	);
	console.log(
		"✓ sandbox resolution: omitted → defaults + one probe; disabled → no probe; failed probe → inactive (R1)",
	);
}

// ─── Section 9: spawn wrapping decision (R2, hermetic) ──────────────

function testWrapInvocation(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const invocation = { command: "pi", args: ["--mode", "rpc", "--model", "m"] };
	const cwd = "/work/proj";
	const agentDir = "/home/u/.pi/agent";

	// Enabled + probe passed → `bwrap <buildBwrapArgs> -- <command> <args>`.
	const wrapped = wrapWorkerInvocation({
		sandbox: { config: sandboxConfig({}), active: true },
		cwd,
		agentDir,
		tempDirs: ["/tmp/pi-task-worker-abc", "/tmp/pi-task-session-def"],
		invocation,
	});
	check(
		wrapped.command === "bwrap",
		`wrapped command must be bwrap, got ${wrapped.command}`,
	);
	const sep = wrapped.args.indexOf("--");
	check(sep !== -1, "wrapped args must contain the `--` separator");
	check(
		JSON.stringify(wrapped.args.slice(sep + 1)) ===
			JSON.stringify([invocation.command, ...invocation.args]),
		`the original invocation must follow the separator verbatim, got ${JSON.stringify(wrapped.args.slice(sep + 1))}`,
	);
	// The bwrap arg vector is exactly buildBwrapArgs(...) ++ ["--", ...].
	const expected = buildBwrapArgs({
		sandbox: sandboxConfig({}),
		cwd,
		agentDir,
		tempDirs: ["/tmp/pi-task-worker-abc", "/tmp/pi-task-session-def"],
	});
	check(
		expected !== null &&
			JSON.stringify(wrapped.args.slice(0, sep)) === JSON.stringify(expected),
		`bwrap args must be exactly buildBwrapArgs output, got ${JSON.stringify(wrapped.args.slice(0, sep))}`,
	);
	// The cwd/agent/temp-dir rw binds are present.
	const findTriple = (
		args: string[],
		a: string,
		b: string,
		c: string,
	): number => {
		for (let i = 0; i < args.length; i++) {
			if (args[i] === a && args[i + 1] === b && args[i + 2] === c) return i;
		}
		return -1;
	};
	const roRoot = findTriple(wrapped.args, "--ro-bind", "/", "/");
	check(roRoot !== -1, "ro root bind present");
	const tmp = findTriple(wrapped.args, "--tmpfs", "/tmp", "/tmp");
	// The agent dir is ro-bound (before the cwd rw bind); cwd + temp dirs
	// are rw-bound after the ro root and after --tmpfs /tmp.
	const agentRo = findTriple(wrapped.args, "--ro-bind", agentDir, agentDir);
	check(
		agentRo !== -1 && agentRo > roRoot,
		`agent dir ro bind present after the ro root, got ${JSON.stringify(wrapped.args)}`,
	);
	check(
		findTriple(wrapped.args, "--bind", agentDir, agentDir) === -1,
		`agent dir must never be rw-bound, got ${JSON.stringify(wrapped.args)}`,
	);
	const cwdBind = findTriple(wrapped.args, "--bind", cwd, cwd);
	check(
		cwdBind !== -1 && cwdBind > agentRo,
		`cwd rw bind must come after the agent-dir ro bind, got ${JSON.stringify(wrapped.args)}`,
	);
	for (const dir of [
		cwd,
		"/tmp/pi-task-worker-abc",
		"/tmp/pi-task-session-def",
	]) {
		const bind = findTriple(wrapped.args, "--bind", dir, dir);
		check(bind !== -1 && bind > roRoot, `rw bind for ${dir} after the ro root`);
		check(bind > tmp, `rw bind for ${dir} after --tmpfs /tmp (mount order)`);
	}

	// Disabled / unavailable / absent → the SAME invocation object (byte-for-byte
	// unchanged spawn path).
	const disabled = wrapWorkerInvocation({
		sandbox: { config: sandboxConfig({ enabled: false }), active: false },
		cwd,
		agentDir,
		invocation,
	});
	check(
		disabled === invocation,
		"disabled sandbox must return the SAME invocation object",
	);
	const inactive = wrapWorkerInvocation({
		sandbox: { config: sandboxConfig({}), active: false },
		cwd,
		agentDir,
		invocation,
	});
	check(
		inactive === invocation,
		"unavailable sandbox (probe failed) must return the SAME invocation object",
	);
	const absent = wrapWorkerInvocation({
		sandbox: undefined,
		cwd,
		agentDir,
		invocation,
	});
	check(
		absent === invocation,
		"no sandbox option must return the SAME invocation object",
	);

	// Custom bwrap binary is respected.
	const custom = wrapWorkerInvocation({
		sandbox: { config: sandboxConfig({}), active: true },
		cwd,
		agentDir,
		invocation,
		bwrapBinary: "/usr/local/bin/bwrap",
	});
	check(
		custom.command === "/usr/local/bin/bwrap",
		`custom bwrap binary respected, got ${custom.command}`,
	);

	console.log(
		"✓ spawn wrapping: active → bwrap <args> -- <invocation> with binds; disabled/unavailable → unchanged (R2)",
	);
}

// ─── Section 10: real-bwrap kill propagation (R4b, guarded) ─────────

/** Wait for the child's exit; resolves its duration in ms. */
function waitForExit(
	child: ReturnType<typeof spawn>,
	timeoutMs: number,
): Promise<number> {
	return new Promise((resolveP) => {
		const started = Date.now();
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolveP(Date.now() - started);
		}, timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolveP(Date.now() - started);
		});
	});
}

async function testKillPropagation(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	if (!probeBwrapAvailability()) {
		console.log(
			"○ kill-propagation test skipped (bwrap or user namespaces unavailable)",
		);
		return;
	}

	const root = mkdtempSync(join(tmpdir(), "pi-task-sbx-kill-"));
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);

	try {
		// Build the exact args the worker would use (rw cwd/agent binds).
		const args = buildBwrapArgs({ sandbox: sandboxConfig({}), cwd, agentDir });
		check(args !== null, "enabled sandbox must return args");
		if (args === null) return;

		// A long-running child inside the sandbox, like a hung worker. The child
		// must HANDLE SIGTERM — as PID 1 of the new pid namespace it would
		// otherwise ignore a default-disposition SIGTERM (kernel init
		// semantics); the real worker (node/pi) installs a SIGTERM handler,
		// and the worker's abort escalation to SIGKILL covers the rest (SIGKILL
		// is always delivered to namespace init). SIGTERM to the bwrap process
		// must terminate the child promptly — worker abort paths (watchdogs,
		// wall timeout) kill the bwrap process and rely on this propagation.
		const child = spawn(
			"bwrap",
			[...args, "--", "sh", "-c", 'trap "exit 0" TERM; sleep 60'],
			{ stdio: "ignore" },
		);
		// Give the namespace + child a moment to start.
		await new Promise((r) => setTimeout(r, 300));
		check(
			child.exitCode === null,
			"sandboxed child must still be running before SIGTERM",
		);

		// SIGTERM the bwrap process — the same signal worker.ts's abort() sends
		// (watchdogs, wall timeout). The sandboxed child must exit promptly.
		child.kill("SIGTERM");
		const elapsed = await waitForExit(child, 5_000);
		check(
			elapsed < 5_000,
			`SIGTERM to bwrap must terminate the sandboxed child promptly, took ${elapsed}ms`,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	console.log(
		"✓ real-bwrap kill propagation: SIGTERM to bwrap terminates the sandboxed child promptly (R4b)",
	);
}

// ─── Runner ──────────────────────────────────────────────────────────

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	console.log(
		"── test-sandbox: builder policy (pure) + guarded real-bwrap probe ──",
	);
	testDisabled(errors);
	testStrictPolicy(errors);
	testRwBinds(errors);
	testCwdEqualsAgentDir(errors);
	testRuntimeStateBinds(errors);
	testProjectDirStoreBinds(errors);
	testTempDirs(errors);
	testNetworkIsolate(errors);
	testExtraBinds(errors);
	testResolveSandbox(errors);
	testWrapInvocation(errors);
	testRealBwrap(errors);
	testRealWorkspaceCommit(errors);
	await testKillPropagation(errors);

	if (errors.length > 0) {
		throw new Error("test-sandbox failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log("✓ sandbox assertions passed");
}

// Direct execution support: `npx tsx extensions/task/test-sandbox.ts`
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error((err as Error).message ?? err);
			process.exit(1);
		});
}
