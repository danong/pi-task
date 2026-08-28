/**
 * Failure-artifact hygiene — the v2 port of the contract in
 * docs/pi-task-design.md ("Failure-artifact contract") and v1's
 * orchestrator rescue/post-mortem machinery (extensions/task/orchestrator.ts,
 * read-only reference; no v1 import).
 *
 * On ANY termination (wall-timeout, watchdog abort, user abort) the engine
 * upholds six required end-state rules:
 *   1. partial work preserved as AT MOST ONE described commit per affected
 *      tree — `rescue: <goal> (<cause>)`;
 *   2. NO engine-created empty stub commits survive (empty +
 *      description-less + the run's configured AI identity — provenance
 *      doubt always preserves);
 *   3. NO undescribed full-tree snapshot commits survive (folded into /
 *      renamed to the described rescue);
 *   4. NO divergent duplicate copies (chains move by CHANGE id, stable
 *      across rewrites — idempotent re-runs cannot fork copies);
 *   5. workspaces handled per exit path (forgotten once their content is
 *      stacked into the main ancestry, kept live and named otherwise);
 *   6. machine-readable recovery travels with the failure output: commit
 *      ids plus the exact jj commands (grep-able key=value lines).
 *
 * Every step is BEST-EFFORT and bounded (FAILURE_PATH_JJ_TIMEOUT_MS): a
 * wedged repo degrades toward preservation, never masks the original
 * failure, and never throws. User-authored content is NEVER destroyed —
 * only provably engine-authored empties are abandoned.
 */

import {
	execJj,
	resolveCommitId,
	taskBaseChangeId,
	workspaceCommitId,
} from "./jj.ts";

/** Tighter jj bound for the failure path: hygiene must never stall an
 *  abort — every call is bounded well under the default timeout. */
const FAILURE_PATH_JJ_TIMEOUT_MS = 30_000;

// ─── Single-run hygiene ──────────────────────────────────────────────

/**
 * Rescue a dirty working copy into ONE goal-named commit. Only commits
 * when the working copy is dirty (a clean abort leaves nothing to save).
 * Returns the rescue CHANGE id (null when clean / best-effort failed) —
 * change ids survive rebases that rewrite commit ids. Never throws.
 */
export async function rescueAbortedWork(
	cwd: string,
	cause: string,
	goal?: string,
	opts?: { timeoutMs?: number },
): Promise<string | null> {
	try {
		const timeout = {
			timeoutMs: opts?.timeoutMs ?? FAILURE_PATH_JJ_TIMEOUT_MS,
		};
		const status = await execJj(["status"], cwd, timeout);
		if (status.code !== 0 || /has no changes/i.test(status.stdout)) return null;
		const reason = (cause || "task run failed").slice(0, 140);
		const summary = (goal ?? "aborted task run")
			.trim()
			.split("\n")[0]!
			.slice(0, 100);
		await execJj(
			["commit", "-m", `rescue: ${summary} (${reason})`],
			cwd,
			timeout,
		);
		// After jj commit the rescue commit is @- (the commit finalizes the
		// working copy and opens a fresh empty @ on top).
		const id = await execJj(
			[
				"log",
				"-r",
				"@-",
				"-T",
				"change_id",
				"--no-graph",
				"--ignore-working-copy",
			],
			cwd,
			timeout,
		);
		return id.code === 0 && /^[a-z0-9]+$/.test(id.stdout.trim())
			? id.stdout.trim()
			: null;
	} catch {
		return null;
	}
}

/** Machine-readable single-run recovery info (contract rule 6): where the
 *  rescued partial work lives plus the exact jj commands to inspect or
 *  continue it. Serialized deterministically via serializeSingleRunRecovery. */
export interface SingleRunRecoveryInfo {
	/** Change id of the goal-named rescue commit holding the WIP (absent
	 *  when the tree was clean or the rescue failed best-effort). */
	rescued_commit?: string | undefined;
	/** Empty description-less commits PRESERVED by doubt (provenance not
	 *  provably the engine's) — listed, never silently dropped. */
	preserved_stubs?: string[] | undefined;
	/** Exact jj commands to inspect/continue/repair the rescued work. */
	commands?: string[] | undefined;
}

/** Assemble the recovery record + scripted command list (pure). */
function buildSingleRunRecovery(
	rescued: string | null,
	preserved: string[],
): SingleRunRecoveryInfo {
	const commands = [
		"jj log -r all()   # locate the rescue: commit and any leftover stubs",
	];
	if (rescued !== null) {
		commands.push(
			`jj show ${rescued}   # inspect the rescued partial work`,
			`jj new ${rescued}   # continue work on top of the rescue`,
		);
	}
	for (const stub of preserved) {
		commands.push(
			`jj abandon ${stub}   # verified empty + undescribed — drop manually if unwanted`,
		);
	}
	return {
		...(rescued === null ? {} : { rescued_commit: rescued }),
		...(preserved.length === 0 ? {} : { preserved_stubs: [...preserved] }),
		commands,
	};
}

/** Serialize single-run recovery info into the artifact's `recovery`
 *  string field (pure): machine-grep-able key=value lines + the exact jj
 *  commands, matching the v1 format contract. */
export function serializeSingleRunRecovery(
	info: SingleRunRecoveryInfo,
): string {
	const lines: string[] = [];
	if (info.rescued_commit !== undefined)
		lines.push(`rescued_commit=${info.rescued_commit}`);
	for (const s of info.preserved_stubs ?? []) lines.push(`preserved_stub=${s}`);
	lines.push(...(info.commands ?? []));
	return lines.join("\n");
}

/**
 * Single-run termination hygiene (contract rules 1–6 for the SINGLE-worker
 * lane): rescue the dirty working copy into ONE goal-named commit on the
 * dispatch base, remove ONLY engine-authored empty stubs, and produce
 * machine-readable recovery info. Stub removal is CONSERVATIVE: a commit
 * qualifies only when it is empty, description-less, AND authored by the
 * AI identity configured for the run — any provenance doubt preserves it
 * and lists it under `preserved_stubs` instead (a user abort mid-work must
 * never destroy user content). With no aiAuthorEmail NOTHING is deleted.
 * Never throws — the original failure propagates regardless.
 *
 * @returns the recovery record for the failure artifact, or undefined
 * when there is nothing to report (clean tree, no stubs).
 */
export async function singleRunFailureHygiene(opts: {
	cwd: string;
	/** Termination cause (watchdog kind, "Worker was aborted", …) — names
	 *  the rescue commit. */
	cause: string;
	/** Spec goal — its first line names the rescue commit. */
	goal?: string;
	/** AI identity configured for the run — the provenance test for
	 *  engine-authored empties. Absent → nothing is deleted. */
	aiAuthorEmail?: string | undefined;
}): Promise<SingleRunRecoveryInfo | undefined> {
	const rescued = await rescueAbortedWork(opts.cwd, opts.cause, opts.goal);
	const preserved: string[] = [];
	try {
		// all() ~ root(): the immutable root is empty + undescribed by
		// construction — never an engine artifact, never ours to abandon.
		const log = await execJj(
			[
				"log",
				"-r",
				"all() ~ root()",
				"--no-graph",
				"-T",
				'change_id ++ "|" ++ if(empty, if(description.first_line() == "", "STUB", "OK"), "OK") ++ "|" ++ author.email() ++ "\\n"',
			],
			opts.cwd,
			{ timeoutMs: FAILURE_PATH_JJ_TIMEOUT_MS },
		);
		if (log.code === 0) {
			for (const line of log.stdout.split("\n")) {
				const m = /^([^|]+)\|STUB\|(.+)$/.exec(line.trim());
				if (!m) continue; // described or non-empty → not ours to touch
				const changeId = m[1]!;
				const authorEmail = m[2]!.trim();
				const engineAuthored =
					opts.aiAuthorEmail !== undefined &&
					authorEmail === opts.aiAuthorEmail;
				if (!engineAuthored) {
					preserved.push(changeId); // doubt → preserve + report
					continue;
				}
				await execJj(["abandon", changeId], opts.cwd, {
					timeoutMs: FAILURE_PATH_JJ_TIMEOUT_MS,
				});
			}
		}
	} catch {
		// Best effort — stub hygiene must never mask the original failure.
	}
	if (rescued === null && preserved.length === 0) return undefined;
	return buildSingleRunRecovery(rescued, preserved);
}

// ─── Parallel post-mortem ────────────────────────────────────────────

/** Machine-readable PARALLEL-run recovery info (contract rule 6): where
 *  each workspace's work was stacked plus the exact jj commands to inspect
 *  or continue it. Serialized via serializeParallelRecovery. */
export interface ParallelRecoveryInfo {
	/** The dispatch-base change id every stacked chain hangs off. */
	base_change?: string | undefined;
	/** Change id of the stack TIP after the post-mortem — `jj new <id>`
	 *  continues from all workers' combined work. */
	stack_tip?: string | undefined;
	/** One entry per processed workspace, dependency order: the workspace
	 *  name and the change id its stacked chain now ends at. */
	stacked: Array<{ name: string; change_id: string }>;
	/** Empty description-less commits PRESERVED by doubt (provenance not
	 *  provably the engine's) — listed, never silently dropped. */
	preserved_stubs?: string[] | undefined;
	/** Exact jj commands to inspect/continue/repair the stacked work. */
	commands: string[];
}

/** Serialize parallel recovery info into the artifact's `recovery`
 *  string field (pure): machine-grep-able key=value lines + the exact jj
 *  commands, matching serializeSingleRunRecovery's format contract. */
export function serializeParallelRecovery(info: ParallelRecoveryInfo): string {
	const lines: string[] = [];
	if (info.base_change !== undefined)
		lines.push(`base_change=${info.base_change}`);
	if (info.stack_tip !== undefined) lines.push(`stack_tip=${info.stack_tip}`);
	for (const s of info.stacked) lines.push(`stacked=${s.name}:${s.change_id}`);
	for (const s of info.preserved_stubs ?? []) lines.push(`preserved_stub=${s}`);
	lines.push(...info.commands);
	return lines.join("\n");
}

/** Parsed `jj workspace list` entry: the workspace @'s stable ids. */
interface WorkspaceEntry {
	changeId: string;
	commitId: string;
}

/** Parse `jj workspace list` output into name → entry ("name: <change-id>
 *  <commit-id>" — this jj build prints no working-copy path). */
function parseWorkspaceList(stdout: string): Map<string, WorkspaceEntry> {
	const result = new Map<string, WorkspaceEntry>();
	for (const line of stdout.split("\n")) {
		const match = /^(\S+):\s+(\S+)\s+(\S+)/.exec(line.trim());
		if (match)
			result.set(match[1] ?? "", {
				changeId: match[2] ?? "",
				commitId: match[3] ?? "",
			});
	}
	return result;
}

/** Visible empty + description-less commits BY AUTHOR EMAIL (the stub
 *  classifier shared by the single-run and parallel paths). Returns the
 *  engine-authored ids and the doubtful survivors separately. Never
 *  throws — classification problems degrade toward preservation. */
async function listStubsByProvenance(opts: {
	projectDir: string;
	aiAuthorEmail: string | undefined;
}): Promise<{ engine: string[]; preserved: string[] }> {
	const result = { engine: [] as string[], preserved: [] as string[] };
	if (opts.aiAuthorEmail === undefined) return result;
	try {
		const log = await execJj(
			[
				"log",
				"-r",
				"all() ~ root()",
				"--no-graph",
				"-T",
				'change_id ++ "|" ++ if(empty, if(description.first_line() == "", "STUB", "OK"), "OK") ++ "|" ++ author.email() ++ "\\n"',
			],
			opts.projectDir,
			{ timeoutMs: FAILURE_PATH_JJ_TIMEOUT_MS },
		);
		if (log.code !== 0) return result;
		for (const line of log.stdout.split("\n")) {
			const m = /^([^|]+)\|STUB\|(.+)$/.exec(line.trim());
			if (!m) continue; // described or non-empty → not a stub
			const changeId = m[1]!;
			const authorEmail = m[2]!.trim();
			if (authorEmail === opts.aiAuthorEmail) {
				result.engine.push(changeId);
			} else {
				result.preserved.push(changeId); // doubt → preserve + report
			}
		}
	} catch {
		// Best effort — degrade toward preservation.
	}
	return result;
}

/**
 * The PARALLEL post-mortem (contract rules 1–6, engine-side recovery): on
 * any parallel termination the engine performs the recovery itself —
 *
 *  1. DESCRIBES every workspace working-copy commit that is NON-empty but
 *     UNDEScribed (taxonomy class 3 — the full-tree snapshot jj wrote when
 *     the worker died mid-edit) as `rescue: aborted task run (<cause>)` —
 *     partial uncommitted work becomes a described commit, never an
 *     anonymous snapshot;
 *  2. STACKS every workspace's commits ONTO THE DISPATCH BASE in order:
 *     one `jj rebase -s roots(<chain>) -o <tip>` per workspace with the tip
 *     advancing — ONE linear chain, no sibling litter, every worker change
 *     reachable from exactly one named commit id (rule 4);
 *  3. ABANDONS ONLY engine-authored empty stubs (empty + description-less
 *     + the run's AI identity); anything doubtful survives and is listed
 *     under `preserved_stubs` — user-authored content is never destroyed;
 *  4. FORGETS every workspace whose leftovers were provably detached from
 *     their content (stacked or consumed) — a workspace whose rebase
 *     FAILED stays live and is named in the recovery commands (rule 5).
 *
 * IDEMPOTENCE (rule 4): chains move by CHANGE id (stable across
 * rewrites) and a workspace missing from the live list contributes
 * nothing — a second pass moves nothing that already moved, abandons
 * nothing twice, and cannot fork divergent copies.
 *
 * Every step is best-effort and bounded — never throws, never masks the
 * original failure.
 */
export async function parallelRunPostMortem(opts: {
	projectDir: string;
	workspaceNames: string[];
	/** The task base's change id the recovery hangs off. */
	baseChangeId: string;
	/** The DISPATCH base the workspaces branched from (the AI base's
	 *  parent in identity mode). Defaults to baseChangeId. */
	dispatchBaseChangeId?: string | undefined;
	cause: string;
	/** AI identity configured for the run — the provenance test for
	 *  engine-authored empties. Absent → NOTHING is deleted. */
	aiAuthorEmail?: string | undefined;
	/** Working-copy directories by workspace name — REQUIRED for the
	 *  content-bearing-@ detach step (`jj new` inside the workspace before
	 *  the forget). A workspace without a dir here is stacked but kept
	 *  live. */
	workspaceDirs?: Record<string, string> | undefined;
	/** Provider-owned continuations remain live and must be excluded from
	 *  global empty-stub cleanup as well as workspace stacking. */
	protectedWorkspaceNames?: string[] | undefined;
}): Promise<ParallelRecoveryInfo> {
	const timeout = { timeoutMs: FAILURE_PATH_JJ_TIMEOUT_MS };
	const cause = (opts.cause || "task run failed").slice(0, 140);
	const dispatchBase = opts.dispatchBaseChangeId ?? opts.baseChangeId;
	const stacked: Array<{ name: string; change_id: string }> = [];
	const preserved: string[] = [];
	// Workspaces whose leftovers were provably detached from their content
	// (stacked or consumed) — ONLY these are forgotten below.
	const forgotten: string[] = [];
	let tipChangeId = opts.baseChangeId;

	// Live-workspace snapshot, read ONCE up front: a workspace missing here
	// was already forgotten (an earlier pass or the success-path cleanup) —
	// the natural idempotence boundary for a second pass.
	const wsEntries = await (async () => {
		try {
			const list = await execJj(
				["workspace", "list"],
				opts.projectDir,
				timeout,
			);
			return list.code === 0
				? parseWorkspaceList(list.stdout)
				: new Map<string, WorkspaceEntry>();
		} catch {
			return new Map<string, WorkspaceEntry>();
		}
	})();

	for (const name of opts.workspaceNames) {
		try {
			const entry = wsEntries.get(name);
			if (!entry) continue; // already forgotten — nothing left to recover
			const wsAt = entry.commitId;
			const state = await execJj(
				[
					"log",
					"-r",
					wsAt,
					"--no-graph",
					"--ignore-working-copy",
					"-T",
					'if(empty, if(description.first_line() == "", "STUB", "DESCRIBED"), if(description.first_line() == "", "SNAPSHOT", "DESCRIBED"))',
				],
				opts.projectDir,
				timeout,
			);
			let wsState = state.code === 0 ? state.stdout.trim() : "UNKNOWN";
			if (wsState === "SNAPSHOT") {
				// Taxonomy class 3: describe the dirty-tail snapshot IN PLACE —
				// it becomes the rescue commit carrying the uncommitted work.
				await execJj(
					["describe", "-r", wsAt, "-m", `rescue: aborted task run (${cause})`],
					opts.projectDir,
					timeout,
				);
				wsState = "DESCRIBED";
			}
			// The workspace's OWN chain: the ancestors of its @ that are not
			// ancestors of the dispatch base. The workspace's own EMPTY
			// undescribed @ carries no work and is excluded (`~ wsAt`) — the
			// creation-time stub is cleaned up by the workspace forget below.
			const chainRev =
				wsState === "STUB"
					? `::${wsAt} ~ ::${dispatchBase} ~ ${wsAt}`
					: `::${wsAt} ~ ::${dispatchBase}`;
			{
				const probe = await execJj(
					[
						"log",
						"-r",
						chainRev,
						"--no-graph",
						"--ignore-working-copy",
						"-T",
						'change_id ++ "\\n"',
					],
					opts.projectDir,
					timeout,
				);
				if (probe.code !== 0 || probe.stdout.trim().length === 0) {
					// Nothing to stack — the workspace never produced work or its
					// commits were consumed by an earlier pass. Leftover empty @
					// is cleaned up by the forget below.
					forgotten.push(name);
					continue;
				}
			}
			// Tip of THIS workspace's chain, captured BEFORE the rebase: jj
			// rebase keeps CHANGE ids stable across rewrites, so the stacked
			// chain's head keeps this exact change id at its new position.
			const tipQuery = await execJj(
				[
					"log",
					"-r",
					`heads(${chainRev})`,
					"--no-graph",
					"--ignore-working-copy",
					"-T",
					'change_id ++ "\\n"',
				],
				opts.projectDir,
				timeout,
			);
			const chainTipChangeId =
				tipQuery.stdout
					.split("\n")
					.map((l) => l.trim())
					.filter((l) => l.length > 0)[0] ?? "";
			const rebase = await execJj(
				["rebase", "-s", `roots(${chainRev})`, "-o", tipChangeId],
				opts.projectDir,
				timeout,
			);
			if (rebase.code !== 0 || chainTipChangeId.length === 0) continue; // preserve > move: workspace stays live
			if (wsState !== "STUB") {
				// The workspace's @ IS content-bearing (the described rescue
				// snapshot, just stacked into the main ancestry). `jj workspace
				// forget` abandons the workspace's @, so detach it first: a fresh
				// empty working-copy commit takes the abandonment instead. Any
				// failure leaves the workspace live rather than risking content.
				const wsDir = opts.workspaceDirs?.[name];
				if (wsDir === undefined) continue;
				const fresh = await execJj(["new"], wsDir, timeout);
				if (fresh.code !== 0) continue;
			}
			forgotten.push(name);
			stacked.push({ name, change_id: chainTipChangeId });
			tipChangeId = chainTipChangeId;
		} catch {
			// Best effort — degrade toward preservation.
		}
	}

	// Stub hygiene (rule 2): abandon ONLY provably engine-authored empties;
	// doubtful ones survive and are listed. Runs AFTER stacking so a
	// just-stacked workspace's leftover empty @ is classified on its final
	// position.
	if (opts.aiAuthorEmail !== undefined) {
		const stubs = await listStubsByProvenance({
			projectDir: opts.projectDir,
			aiAuthorEmail: opts.aiAuthorEmail,
		});
		const protectedChangeIds = new Set(
			(opts.protectedWorkspaceNames ?? [])
				.map((name) => wsEntries.get(name)?.changeId ?? "")
				.filter((id) => id.length > 0),
		);
		for (const changeId of stubs.engine) {
			if (protectedChangeIds.has(changeId)) continue;
			try {
				await execJj(["abandon", changeId], opts.projectDir, timeout);
			} catch {
				// Best effort.
			}
		}
		// Doubtful survivors EXCLUDING workspace working-copy @s: those are
		// removed by design via the forget below and are never recovery
		// anchors — listing them would send the user hunting for commits the
		// engine itself is about to hide.
		const wsAtChangeIds = new Set(
			[...(opts.workspaceNames), ...(opts.protectedWorkspaceNames ?? [])].map(
				(n) => wsEntries.get(n)?.changeId ?? "",
			),
		);
		preserved.push(...stubs.preserved.filter((id) => !wsAtChangeIds.has(id)));
	}

	// Workspace forget (rule 5): stacked/consumed workspaces' commits are
	// live in the main ancestry — their working copies are disposable.
	// Workspaces whose rebase failed stay live for manual recovery.
	for (const name of forgotten) {
		try {
			await execJj(["workspace", "forget", name], opts.projectDir, timeout);
		} catch {
			// Best effort.
		}
	}
	const keptLive = opts.workspaceNames.filter((n) => !forgotten.includes(n));

	return {
		base_change: opts.baseChangeId,
		stack_tip: tipChangeId,
		stacked,
		...(preserved.length === 0 ? {} : { preserved_stubs: [...preserved] }),
		commands: [
			`jj log -r ${opts.baseChangeId}::   # inspect the stacked worker commits`,
			`jj show ${tipChangeId}   # inspect the combined work`,
			`jj new ${tipChangeId}   # continue work on top of the stack`,
			...(keptLive.length > 0
				? [
						`jj workspace list   # ${keptLive.join(", ")} kept live — ` +
							"their commits could not be stacked automatically; recover manually",
					]
				: []),
			...preserved.map(
				(s) =>
					`jj abandon ${s}   # verified empty + undescribed — drop manually if unwanted`,
			),
		],
	};
}

// ─── Boot reconciliation (default-lineage strays) ────────────────────

export type CleanedStrayKind = "engine_stub" | "engine_snapshot";
export type PreservedStrayKind = "stub" | "snapshot";

export interface RepoHygieneReport {
	cleaned: Array<{ kind: CleanedStrayKind; changeId: string }>;
	preserved: Array<{ kind: PreservedStrayKind; changeId: string }>;
}

/**
 * Boot-time repo reconciliation (contract rules 1–4 applied to repos
 * carrying artifacts of CRASHED past runs): classify the DEFAULT
 * working-copy lineage (`::@` — the only lineage a dispatch builds on;
 * off-lineage leftovers belong to live/preserved workspaces and are never
 * ours to judge here), then abandon ONLY provably engine-authored strays:
 *
 *   - empty + description-less + AI identity → engine_stub (jj-mechanical,
 *     zero content);
 *   - CONTENT-BEARING + undescribed + AI identity → engine_snapshot (the
 *     dead run's dirty tail — abandoning drops it from the working copy
 *     while the content stays recoverable in the hidden commit);
 *   - anything else (described history, rescue commits, doubtful
 *     authorship, the resting empty @) → untouched; genuine doubt is
 *     reported under `preserved`, never destroyed.
 *
 * The live default-@ is exempt when empty + undescribed: that is jj's
 * normal resting state after every command, not a stray. Abandons are
 * content-safe (descendants rebase onto the abandoned commit's parents)
 * and idempotent (an already-hidden id fails its abandon and is skipped).
 * Never throws — boot must proceed regardless of repo state.
 */
export async function reconcileRepoArtifacts(opts: {
	projectDir: string;
	/** AI identity configured for the engine — the provenance test for
	 *  engine-authored strays. Absent → nothing is cleaned (report-only). */
	aiAuthorEmail?: string | undefined;
}): Promise<RepoHygieneReport> {
	const report: RepoHygieneReport = { cleaned: [], preserved: [] };
	const timeout = { timeoutMs: FAILURE_PATH_JJ_TIMEOUT_MS };
	try {
		// Snapshot-triggering read FIRST (folds unsnapshotted tails into @),
		// then resolve the live @ against the now-current view.
		const log = await execJj(
			[
				"log",
				"-r",
				"(::@) ~ root()",
				"--no-graph",
				"-T",
				'change_id ++ "|" ++ if(empty, if(description.first_line() == "", "STUB", "OK"), "OK") ++ "|" ++ author.email() ++ "|" ++ description.first_line() ++ "\\n"',
			],
			opts.projectDir,
			timeout,
		);
		if (log.code !== 0) return report;
		const at = await execJj(
			[
				"log",
				"-r",
				"@",
				"--no-graph",
				"--ignore-working-copy",
				"-T",
				"change_id",
			],
			opts.projectDir,
			timeout,
		);
		const liveAt = at.code === 0 ? at.stdout.trim() : null;
		const toAbandon: Array<{ kind: CleanedStrayKind; changeId: string }> = [];
		for (const line of log.stdout.split("\n")) {
			// Split (not regex): the description is last and may contain "|".
			const parts = line.trim().split("|");
			if (parts.length < 4) continue;
			const [changeId, emptyClass, authorEmail] = parts as [
				string,
				string,
				string,
			];
			const description = parts.slice(3).join("|");
			const isEmptyUndescribed = emptyClass === "STUB";
			// 1. Any DESCRIBED commit: a rescue-prefix marks a past run's
			// deliberate preservation (ignorable base history, never junk);
			// any other description is history. Neither is ours to touch.
			if (description !== "") continue;
			// 2. Undescribed from here on. An EMPTY live tip is the working
			// copy itself (jj's resting state) — exempt. A CONTENT-BEARING
			// live tip is the wedged-run shape itself (a dead run's
			// unsnapshotted tail folded into @) — it falls through to the
			// ownership rules below, or every future dispatch stays blocked.
			if (isEmptyUndescribed && liveAt !== null && changeId === liveAt) {
				continue;
			}
			const engineAuthored =
				opts.aiAuthorEmail !== undefined && authorEmail === opts.aiAuthorEmail;
			if (isEmptyUndescribed) {
				// 3. Empty + undescribed, off-tip: a jj-mechanical artifact with
				// ZERO content. Engine-authored → swept; anything else blocks
				// nothing and is ignored.
				if (engineAuthored) {
					toAbandon.push({ kind: "engine_stub", changeId });
				}
				continue;
			}
			// 4. Content-bearing + undescribed: engine junk when provably the
			// engine's; REAL doubt (potential interrupted user work) is
			// preserved untouched and reported.
			if (engineAuthored) {
				toAbandon.push({ kind: "engine_snapshot", changeId });
			} else {
				report.preserved.push({ kind: "snapshot", changeId });
			}
		}
		for (const item of toAbandon) {
			try {
				const r = await execJj(
					["abandon", item.changeId],
					opts.projectDir,
					timeout,
				);
				if (r.code === 0) report.cleaned.push(item);
			} catch {
				// Best effort — an already-hidden id simply skips.
			}
		}
	} catch {
		// Best effort — boot proceeds regardless of repo state.
	}
	return report;
}

// ─── Driver-facing convenience wrapper ───────────────────────────────

/**
 * Resolve a driver's DISPATCH base for recovery: the AI base's parent in
 * identity mode (workspaces branch from the pre-base head). Falls back to
 * the base itself when the parent cannot be resolved. Best effort.
 */
export async function dispatchBaseOf(
	projectDir: string,
	baseChangeId: string,
): Promise<string> {
	try {
		const baseCommit = await resolveCommitId(projectDir, baseChangeId);
		const parent = await execJj(
			[
				"log",
				"-r",
				`${baseCommit}-`,
				"--no-graph",
				"--ignore-working-copy",
				"-T",
				"change_id",
			],
			projectDir,
			{ timeoutMs: FAILURE_PATH_JJ_TIMEOUT_MS },
		);
		const id = parent.stdout.trim();
		if (parent.code === 0 && id.length > 0) return id;
	} catch {
		// Fall through to the base itself.
	}
	return baseChangeId;
}

/** Convenience re-export so daemon callers can locate a fallback base. */
export { taskBaseChangeId, workspaceCommitId };
