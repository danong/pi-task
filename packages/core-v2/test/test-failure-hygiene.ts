/**
 * Failure-hygiene CONTRACT tests for core-v2 (zero LLM) — the v2 port of
 * v1's extensions/task/test-failure-hygiene.ts, pinning the required
 * end-state per termination kind from docs/pi-task-design.md
 * ("Failure-artifact contract"). Real jj on temp repos; fakes only for
 * session handles. Covered fixtures:
 *
 *   - single-run wall-timeout footprint: one goal-named rescue commit,
 *     engine-authored empty stubs abandoned, undescribed snapshots folded,
 *     machine-readable recovery in the .failure.json;
 *   - user-abort graceful degradation: identical preservation rules, user
 *     content + doubtful stubs NEVER destroyed and listed in recovery;
 *   - idempotent second recovery: a second hygiene/post-mortem pass moves
 *     nothing (tree fingerprint identical);
 *   - driver post-mortem: workspace chains stacked onto the dispatch base,
 *     workspaces forgotten, no dangling stubs;
 *   - boot repo reconciliation: engine strays cleaned, user work intact.
 *
 * Run: timeout 300 npx tsx packages/core-v2/test/test-failure-hygiene.ts
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	parallelRunPostMortem,
	reconcileRepoArtifacts,
	singleRunFailureHygiene,
	serializeSingleRunRecovery,
} from "../src/workspaces/failure-hygiene.ts";
import { JujutsuWorkspaceDriver } from "../src/workspaces/jj-driver.ts";
import { createAiTaskBase } from "../src/workspaces/jj.ts";
import { runTask } from "../src/daemon/task-runner.ts";
import type {
	SessionHandle,
	SessionHost,
	SessionHostConfig,
	SessionHostEvent,
} from "../src/sessions/host.ts";

const AI_EMAIL = "ai@test.dev";
const AI_NAME = "Pi (test-model)";
const GOAL = "Build the widget.";
const SPEC = `## Goal\n${GOAL}\n\n## Requirements\n- R1: hello.txt says hi\n\n## Verification\n- false\n`;

// ─── jj helpers (real binary on temp repos) ───────────────────────────

function jj(args: string[], cwd: string): string {
	return execFileSync("jj", args, {
		cwd,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, JJ_EDITOR: "true" },
	});
}

function initRepo(dir: string): void {
	mkdirSync(dir, { recursive: true });
	jj(
		[
			"--config",
			'user.name="Test User"',
			"--config",
			'user.email="user@test.dev"',
			"git",
			"init",
			"--colocate",
		],
		dir,
	);
	jj(["config", "set", "--repo", "user.name", "Test User"], dir);
	jj(["config", "set", "--repo", "user.email", "user@test.dev"], dir);
	writeFileSync(join(dir, "README.md"), "# Test repo\n", "utf-8");
	jj(["commit", "-m", "init"], dir);
}

/** Write the AI identity TOML OUTSIDE the repo (v1 discipline: a
 *  config-file read must never interact with the working copy). */
const identityDirs: string[] = [];
/** Temp dirs created for workspace fixtures — removed when the suite ends. */
const wsDirs: string[] = [];
function writeIdentityFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "core-v2-fh-id-"));
	identityDirs.push(dir);
	const file = join(dir, "jj-identity.toml");
	writeFileSync(
		file,
		`[user]\nname = "${AI_NAME}"\nemail = "${AI_EMAIL}"\n`,
		"utf-8",
	);
	return file;
}

/** Visible commits that are EMPTY and DESCRIPTION-LESS, with authors. */
function emptyUndescribedWithAuthors(dir: string): Array<{
	changeId: string;
	authorEmail: string;
}> {
	return jj(
		[
			"log",
			"-r",
			"all() ~ root()",
			"--no-graph",
			"--ignore-working-copy",
			"-T",
			'if(empty, if(description.first_line() == "", change_id ++ "|" ++ author.email() ++ "\\n", ""), "")',
		],
		dir,
	)
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.map((l) => {
			const [changeId, authorEmail] = l.split("|");
			return { changeId: changeId!, authorEmail: authorEmail! };
		});
}

function hasEngineStub(dir: string): boolean {
	return emptyUndescribedWithAuthors(dir).some(
		(s) => s.authorEmail === AI_EMAIL,
	);
}

/** All visible non-empty first-line descriptions. */
function descriptions(dir: string): string[] {
	return jj(
		[
			"log",
			"-r",
			"all()",
			"--no-graph",
			"-T",
			'description.first_line() ++ "\\n"',
		],
		dir,
	)
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

/** Visible commits carrying CONTENT but NO description (taxonomy class 3). */
function countNonEmptyUndescribed(dir: string): number {
	return jj(
		[
			"log",
			"-r",
			"all() ~ root()",
			"--no-graph",
			"--ignore-working-copy",
			"-T",
			'if(empty, "", if(description.first_line() == "", "BAD\\n", ""))',
		],
		dir,
	)
		.split("\n")
		.filter((l) => l.trim() === "BAD").length;
}

/** Tracked files (read-only). */
function fileList(dir: string): string[] {
	return jj(["file", "list", "--ignore-working-copy"], dir)
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.sort();
}

/** Change id of @- (the dispatch base). */
function dispatchBaseChangeId(dir: string): string {
	return jj(["log", "-r", "@-", "--no-graph", "-T", "change_id"], dir).trim();
}

/** Visible-tree fingerprint for IDEMPOTENCE comparison: (change id, first
 *  description line, emptiness) sorted — a second recovery pass must
 *  reproduce this exactly (commit ids may legitimately rewrite; change
 *  ids are the identity the contract reasons over). */
function treeFingerprint(dir: string): string[] {
	return jj(
		[
			"log",
			"-r",
			"all() ~ root()",
			"--no-graph",
			"--ignore-working-copy",
			"-T",
			'change_id ++ "|" ++ description.first_line() ++ "|" ++ if(empty, "E", "F") ++ "\\n"',
		],
		dir,
	)
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.sort();
}

// ─── Session fakes (worker dies mid-edit, never yields) ───────────────

class TimeoutHandle implements SessionHandle {
	readonly role: string;
	readonly model = { provider: "fake", modelId: "fake/m" };
	result: undefined;
	constructor(config: SessionHostConfig) {
		this.role = config.role;
	}
	subscribe(listener: (event: SessionHostEvent) => void): () => void {
		listener({ type: "turnStart" });
		return () => undefined;
	}
	prompt(): Promise<void> {
		// The worker died mid-edit: dirty tail in the working copy, no yield.
		return Promise.resolve().then(() => {
			writeFileSync(
				join(this.cwd(), "wip.txt"),
				"half-done feature\n",
				"utf-8",
			);
		});
	}
	private cwd(): string {
		return process.env.__FAKE_CWD ?? "";
	}
	async abort(): Promise<void> {}
	async stats() {
		return Promise.resolve({
			sessionFile: undefined,
			sessionId: "fake",
			userMessages: 1,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 1,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		});
	}
	setModel(): Promise<void> {
		return Promise.resolve();
	}
	close(): void {}
}

// ─── Fixtures ─────────────────────────────────────────────────────────

/**
 * SINGLE-RUN WALL-TIMEOUT footprint through the REAL runner failure path:
 * a worker that edits but never yields → watchdog-less settle → failRun →
 * single-run hygiene + artifact.
 *
 * rule 1: partial work preserved as ONE `rescue: <goal> (<cause>)` commit.
 * rule 2: NO engine-authored empty stub survives.
 * rule 3: no undescribed full-tree snapshot remains.
 * rule 6: recovery block (rescue change id + exact jj commands) greppable
 *   in the .failure.json artifact.
 */
async function testSingleRunTimeoutFootprint(
	errors: string[],
	baseDir: string,
): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const repo = join(baseDir, "timeout");
	initRepo(repo);
	const artifactsDir = join(baseDir, "artifacts-timeout");

	const timeoutHost: SessionHost = {
		spawn: (config) => {
			const handle = new TimeoutHandle(config);
			const realPrompt = handle.prompt.bind(handle);
			handle.prompt = () => {
				process.env.__FAKE_CWD = config.cwd;
				return realPrompt();
			};
			return Promise.resolve(handle);
		},
	};

	const result = await runTask({
		specMarkdown: SPEC,
		cwd: repo,
		artifactsDir,
		dbPath: join(baseDir, "timeout.db"),
		model: "openrouter/stealth/ox-alpha",
		host: timeoutHost,
	});
	check(result.receipt.verdict === "failed", "run without yield fails");

	// The runner's default AI email swept its own empties.
	check(
		!hasEngineStub(repo),
		`no engine-authored empty stub survives, got ${JSON.stringify(emptyUndescribedWithAuthors(repo))}`,
	);

	const rescues = descriptions(repo).filter((d) => d.startsWith("rescue:"));
	check(
		rescues.length === 1,
		`exactly ONE rescue commit, got ${JSON.stringify(descriptions(repo))}`,
	);
	check(
		rescues[0] === `rescue: ${GOAL} (settled without yield)`,
		`rescue names goal + cause, got "${rescues[0]}"`,
	);

	// Rule 3: the dirty tail was folded into the DESCRIBED rescue.
	check(
		countNonEmptyUndescribed(repo) === 0,
		"no undescribed full-tree snapshot remains",
	);
	// Rule 1's other half: the partial work itself survives.
	check(
		fileList(repo).includes("wip.txt"),
		"partial work survives inside the rescue commit",
	);

	// Rule 6: machine-readable recovery in the artifact.
	const artifacts = readdirSync(artifactsDir).filter((f) =>
		f.endsWith(".failure.json"),
	);
	check(artifacts.length === 1, "exactly one failure artifact written");
	const raw = readFileSync(join(artifactsDir, artifacts[0]!), "utf-8");
	check(
		/rescued_commit=/.test(raw),
		"artifact carries the grep-able rescued_commit=<id> line",
	);
	check(
		raw.includes("jj show ") && raw.includes("jj new "),
		"artifact carries the exact inspect/continue jj commands",
	);
	console.log("✓ single-run timeout footprint [CONTRACT]");
}

/**
 * USER-ABORT graceful degradation at the HYGIENE layer: a null-code abort
 * ("Worker was aborted") mid-edit must preserve the user's own described
 * work AND any doubtful (non-engine) empty stubs — only provably
 * engine-authored empties go. Identical end-state to a watchdog abort.
 */
async function testUserAbortGracefulDegradation(
	errors: string[],
): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "core-v2-fh-userabort-"));
	try {
		initRepo(dir);

		// The user's OWN prior described work must never be touched.
		writeFileSync(join(dir, "user.txt"), "user prior work\n", "utf-8");
		jj(["commit", "-m", "feat: user prior work"], dir);

		// AI base + the worker's mid-edit working copy at Ctrl-C time, plus
		// one DOUBTFUL (user-authored, empty, undescribed) commit that
		// provenance doubt forbids deleting.
		await createAiTaskBase(dir, writeIdentityFile(), GOAL);
		jj(["--config-file", writeIdentityFile(), "new", "@"], dir); // empty AI stub
		jj(["new", "@"], dir); // fresh resting @ (user side)

		const info = await singleRunFailureHygiene({
			cwd: dir,
			cause: "Worker was aborted",
			goal: GOAL,
			aiAuthorEmail: AI_EMAIL,
		});

		// Rule 1: ONE goal-named rescue naming the user-abort cause. (The
		// working copy here was clean, so nothing needed rescuing — the
		// rescue-free clean-abort case is covered by the timeout fixture;
		// this fixture pins the stub/user-content half.)
		check(
			descriptions(dir).includes("feat: user prior work") &&
				fileList(dir).includes("user.txt"),
			"user's pre-existing described work untouched",
		);
		check(
			descriptions(dir).includes(`task: ${GOAL}`),
			"described AI base history untouched",
		);
		check(
			!hasEngineStub(dir),
			`no AI-authored empty stub survives, got ${JSON.stringify(emptyUndescribedWithAuthors(dir))}`,
		);
		// Doubtful survivors are listed, never silently dropped.
		for (const s of info?.preserved_stubs ?? []) {
			check(
				s.length > 0 && !s.includes("|"),
				"preserved-by-doubt stubs are listed by change id",
			);
		}
		check(
			(info?.commands ?? []).some((c) => c.startsWith("jj log -r all()")),
			"recovery carries the exact jj inspection commands",
		);
		check(
			serializeSingleRunRecovery({
				rescued_commit: "qqqrrrsss",
			}).startsWith("rescued_commit=qqqrrrsss"),
			"serialized recovery is grep-able (leading rescued_commit line)",
		);

		// Clean-tree abort adds NO rescue (at-most-one, not always-one).
		const rescuesBefore = descriptions(dir).filter((d) =>
			d.startsWith("rescue:"),
		).length;
		const second = await singleRunFailureHygiene({
			cwd: dir,
			cause: "Worker was aborted",
			goal: GOAL,
			aiAuthorEmail: AI_EMAIL,
		});
		check(
			second === undefined ||
				descriptions(dir).filter((d) => d.startsWith("rescue:")).length ===
					rescuesBefore,
			"clean abort → zero additional rescue commits",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("✓ user-abort graceful degradation [CONTRACT]");
}

/**
 * USER-ABORT with a DIRTY tree: the interrupted uncommitted work IS
 * rescued into ONE goal-named commit (a manual Ctrl-C is first-class).
 */
async function testUserAbortDirtyTreeRescue(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "core-v2-fh-abort-dirty-"));
	try {
		initRepo(dir);
		const identityFile = writeIdentityFile();
		await createAiTaskBase(dir, identityFile, GOAL);
		// The worker's mid-edit working copy at Ctrl-C time: an undescribed
		// AI-authored stub (the same shape spawnWorkerSession aborts leave)
		// holding the uncommitted work.
		jj(["--config-file", identityFile, "new", "@"], dir);
		writeFileSync(join(dir, "partial.txt"), "user-interrupted work\n", "utf-8");

		const info = await singleRunFailureHygiene({
			cwd: dir,
			cause: "Worker was aborted",
			goal: GOAL,
			aiAuthorEmail: AI_EMAIL,
		});

		const rescues = descriptions(dir).filter((d) => d.startsWith("rescue:"));
		check(
			rescues.length === 1 &&
				rescues[0] === `rescue: ${GOAL} (Worker was aborted)`,
			`dirty abort preserves partial work as ONE goal-named commit, got ${JSON.stringify(rescues)}`,
		);
		check(
			typeof info?.rescued_commit === "string" &&
				info.rescued_commit.length > 0,
			"recovery names the rescue commit (change id)",
		);
		check(
			(info?.commands ?? []).some((c) =>
				c.startsWith(`jj new ${info!.rescued_commit}`),
			),
			"recovery tells the user how to continue the rescued work",
		);
		check(countNonEmptyUndescribed(dir) === 0, "no anonymous snapshot left");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("✓ user-abort dirty-tree rescue [CONTRACT]");
}

/**
 * R3 IDEMPOTENCE of the recovery machinery: running the parallel
 * post-mortem TWICE leaves the tree identical the second time — the first
 * pass consumed everything, so pass 2 moves nothing, abandons nothing
 * twice, and cannot fork divergent duplicate copies (chains move by
 * stable CHANGE id).
 */
async function testIdempotentSecondRecovery(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "core-v2-fh-idem-"));
	try {
		const dir = mkdtempSync(join(tmpdir(), "core-v2-fh-idem-repo-"));
		initRepo(dir);
		const base = dispatchBaseChangeId(dir);

		// Two workspaces: one committed + dirty tail, one committed clean.
		// Workspace dirs live under the repo's own temp parent (unique per
		// run — fixed /tmp names collide across suite invocations).
		const outer = mkdtempSync(join(tmpdir(), "core-v2-fh-idem-ws-"));
		wsDirs.push(outer);
		const ws1 = join(outer, "ws1");
		execFileSync("jj", ["workspace", "add", ws1, "--name", "ws-1"], {
			cwd: dir,
			stdio: "pipe",
			env: { ...process.env, JJ_EDITOR: "true" },
		});
		writeFileSync(join(ws1, "done.txt"), "committed part\n", "utf-8");
		jj(["commit", "-m", "task: worker 1 part"], ws1);
		writeFileSync(join(ws1, "tail.txt"), "uncommitted tail\n", "utf-8");
		jj(["status"], ws1); // snapshot the dirty tail (taxonomy class 3)

		const ws2 = join(outer, "ws2");
		execFileSync("jj", ["workspace", "add", ws2, "--name", "ws-2"], {
			cwd: dir,
			stdio: "pipe",
			env: { ...process.env, JJ_EDITOR: "true" },
		});
		writeFileSync(join(ws2, "other.txt"), "worker 2\n", "utf-8");
		jj(["commit", "-m", "task: worker 2 part"], ws2);

		const opts = {
			projectDir: dir,
			workspaceNames: ["ws-1", "ws-2"],
			baseChangeId: base,
			dispatchBaseChangeId: base,
			cause: "worker wall-clock budget expired",
			aiAuthorEmail: AI_EMAIL,
			workspaceDirs: { "ws-1": ws1, "ws-2": ws2 },
		};

		// Pass 1: full engine-side recovery.
		const r1 = await parallelRunPostMortem(opts);
		check(
			r1.stacked.some((s) => s.name === "ws-1") &&
				r1.stacked.some((s) => s.name === "ws-2"),
			`pass 1 stacks BOTH workspace chains, got ${JSON.stringify(r1.stacked)}`,
		);
		check(
			!existsSync(ws1) || !jj(["workspace", "list"], dir).includes("ws-1:"),
			"pass 1 forgets the consumed workspaces",
		);
		check(
			countNonEmptyUndescribed(dir) === 0 && !hasEngineStub(dir),
			"pass 1 leaves no undescribed snapshot and no engine stub",
		);
		const fpAfterPass1 = treeFingerprint(dir);
		const filesAfterPass1 = fileList(dir);
		const rescuesAfterPass1 = descriptions(dir).filter((d) =>
			d.startsWith("rescue:"),
		).length;

		// Pass 2: same call again — must be a NO-OP on the tree.
		const r2 = await parallelRunPostMortem(opts);
		check(
			r2.stacked.length === 0,
			`pass 2 stacks nothing (everything consumed), got ${JSON.stringify(r2.stacked)}`,
		);
		check(
			JSON.stringify(treeFingerprint(dir)) === JSON.stringify(fpAfterPass1),
			`visible tree identical after the second pass:\n  pass1=${JSON.stringify(fpAfterPass1)}\n  pass2=${JSON.stringify(treeFingerprint(dir))}`,
		);
		check(
			JSON.stringify(fileList(dir)) === JSON.stringify(filesAfterPass1),
			"tracked files identical after the second pass",
		);
		check(
			descriptions(dir).filter((d) => d.startsWith("rescue:")).length ===
				rescuesAfterPass1,
			"no second rescue / no multiplied artifacts after the second pass",
		);
		check(
			descriptions(dir).includes("task: worker 1 part") &&
				descriptions(dir).includes("task: worker 2 part"),
			"both workers' content survives stacked in the main ancestry",
		);
		check(
			r1.commands.some((c) => c.startsWith("jj new ")) &&
				r1.commands.some((c) => c.startsWith(`jj log -r ${base}::`)),
			"recovery carries the exact continue/inspect jj commands",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("✓ idempotent second recovery [CONTRACT]");
}

/**
 * DRIVER-level post-mortem wiring: JujutsuWorkspaceDriver.recoverFailedRun
 * performs the reconciliation behind the driver contract and returns the
 * machine-readable ParallelRecoveryInfo (stack tip hangs off the dispatch
 * base, per-workspace heads, exact commands).
 */
async function testDriverRecoverFailedRun(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "core-v2-fh-driver-"));
	try {
		initRepo(dir);
		const driver = new JujutsuWorkspaceDriver({
			projectDir: dir,
			authorName: AI_NAME,
			authorEmail: AI_EMAIL,
		});
		const base = await driver.prepareIntegrationBase(GOAL);
		const ctx = await driver.createWorkspace("t1");
		writeFileSync(join(ctx.hostPath, "part.txt"), "partial work\n", "utf-8");
		jj(["commit", "-m", "task: t1 part"], ctx.hostPath);
		writeFileSync(
			join(ctx.hostPath, "tail.txt"),
			"uncommitted tail\n",
			"utf-8",
		);
		jj(["status"], ctx.hostPath); // dirty-tail snapshot

		const info = await driver.recoverFailedRun({
			workspaceNames: [ctx.branchName],
			cause: "wall_timeout",
			workspaceDirs: { [ctx.branchName]: ctx.hostPath },
		});

		check(
			info.base_change === base,
			"recovery names the integration base as anchor",
		);
		check(
			info.stack_tip !== undefined && info.stack_tip !== base,
			`stack tip advanced past the dispatch base, got ${JSON.stringify(info.stack_tip)}`,
		);
		check(
			info.stacked.length === 1 && info.stacked[0]!.name === ctx.branchName,
			`the workspace chain is stacked, got ${JSON.stringify(info.stacked)}`,
		);
		check(
			!jj(["workspace", "list"], dir).includes(`${ctx.branchName}:`),
			"consumed workspace forgotten",
		);
		check(
			descriptions(dir).includes("task: t1 part") &&
				descriptions(dir).includes("rescue: aborted task run (wall_timeout)"),
			"content + dirty-tail rescue live in the main ancestry",
		);
		check(
			countNonEmptyUndescribed(dir) === 0 && !hasEngineStub(dir),
			"no anonymous snapshots or engine stubs survive",
		);
		check(
			driver.authorEmail === AI_EMAIL,
			"driver exposes its AI identity email for provenance tests",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("✓ driver recoverFailedRun post-mortem [CONTRACT]");
}

/**
 * BOOT reconciliation (startDaemon projectDir): crashed past runs'
 * strays in the default lineage are cleaned (engine stub + undescribed AI
 * snapshot), the user's described history and rescue commits survive, and
 * genuine user work-in-progress still blocks nothing here (report-only
 * sweep) — the strict dispatch gate remains the runner's prepare().
 */
async function testBootRepoReconciliation(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};
	const dir = mkdtempSync(join(tmpdir(), "core-v2-fh-boot-"));
	try {
		initRepo(dir);
		const identityFile = writeIdentityFile();
		// User history + a past run's rescue commit (ignorable base history).
		writeFileSync(join(dir, "user.txt"), "user prior work\n", "utf-8");
		jj(["commit", "-m", "feat: user prior work"], dir);
		writeFileSync(join(dir, "salvaged.txt"), "rescued partial work\n", "utf-8");
		jj(
			[
				"--config-file",
				identityFile,
				"commit",
				"-m",
				`rescue: ${GOAL} (wall_timeout)`,
			],
			dir,
		);
		// Rescue-opened empty AI stub, then an undescribed AI snapshot.
		jj(["--config-file", identityFile, "new", "@"], dir);
		writeFileSync(join(dir, "wip.txt"), "half-done feature\n", "utf-8");
		jj(["status"], dir);
		jj(["--config-file", identityFile, "new", "@"], dir); // another empty AI stub
		jj(["new", "@"], dir); // fresh resting @ (user side)

		const report = await reconcileRepoArtifacts({
			projectDir: dir,
			aiAuthorEmail: AI_EMAIL,
		});

		check(
			report.cleaned.filter((c) => c.kind === "engine_stub").length >= 2 &&
				report.cleaned.some((c) => c.kind === "engine_snapshot"),
			`engine stubs + snapshot classified and cleaned, got ${JSON.stringify(report.cleaned)}`,
		);
		check(
			report.preserved.length === 0,
			`nothing preserved when all strays are engine-authored, got ${JSON.stringify(report.preserved)}`,
		);
		check(
			descriptions(dir).includes(`rescue: ${GOAL} (wall_timeout)`),
			"the past run's rescue commit is never swept as junk",
		);
		check(
			fileList(dir).includes("salvaged.txt") &&
				fileList(dir).includes("user.txt"),
			"rescued content + user content stay on disk",
		);
		check(
			!hasEngineStub(dir) && countNonEmptyUndescribed(dir) === 0,
			"after boot the lineage holds no engine strays",
		);

		// Pass 2 is a no-op (idempotent boot).
		const report2 = await reconcileRepoArtifacts({
			projectDir: dir,
			aiAuthorEmail: AI_EMAIL,
		});
		check(
			report2.cleaned.length === 0 && report2.preserved.length === 0,
			`second boot pass finds nothing to clean, got ${JSON.stringify(report2)}`,
		);

		// No AI identity configured → NOTHING is deleted (report-only).
		const report3 = await reconcileRepoArtifacts({ projectDir: dir });
		check(
			report3.cleaned.length === 0,
			"absent aiAuthorEmail → report-only sweep (nothing deleted)",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("✓ boot repo reconciliation [CONTRACT]");
}

// ─── Runner ───────────────────────────────────────────────────────────

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	let jjAvailable = true;
	try {
		execFileSync("jj", ["--version"], { stdio: "pipe" });
	} catch {
		jjAvailable = false;
	}
	if (!jjAvailable) {
		console.log("SKIPPED (no jj binary)");
		return;
	}

	const dir = mkdtempSync(join(tmpdir(), "core-v2-failure-hygiene-"));
	try {
		await testSingleRunTimeoutFootprint(errors, dir);
		await testUserAbortGracefulDegradation(errors);
		await testUserAbortDirtyTreeRescue(errors);
		await testIdempotentSecondRecovery(errors);
		await testDriverRecoverFailedRun(errors);
		await testBootRepoReconciliation(errors);
	} finally {
		if (errors.length === 0) rmSync(dir, { recursive: true, force: true });
	}

	for (const d of [...identityDirs, ...wsDirs]) {
		rmSync(d, { recursive: true, force: true });
	}
	if (errors.length > 0) {
		throw new Error(
			"failure-hygiene tests failed:\n  ✗ " + errors.join("\n  ✗ "),
		);
	}
	console.log(
		"✓ failure-hygiene: contract footprints pinned (timeout / user-abort / idempotence)",
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		});
}
