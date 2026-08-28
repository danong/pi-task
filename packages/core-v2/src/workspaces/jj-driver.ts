/**
 * JujutsuWorkspaceDriver — M2.c (seam 1 implementation).
 *
 * The v1 ladder behind the M0 WorkspaceDriver contract, plus the parallel
 * combine the contract grew in M2 (prepareIntegrationBase / combine /
 * publishBookmarks) and the fetch-before-work convention (M2.a).
 *
 * Integration modes (config-selected, contract FR-4):
 *   - "task-base" (default): workers commit in isolated workspaces rooted
 *     at an AI-authored base; combine() lands everything in ONE atomic
 *     squash; union ladder resolves textual conflicts; residual conflicts
 *     are returned (escalation), never silently accepted.
 *   - "feature-branch": no combine — each worker's tip gets a named
 *     bookmark for human review; integration is the operator's act.
 *
 * The driver NEVER pushes. Publishing is the operator's act in both modes.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
	dispatchBaseOf,
	parallelRunPostMortem,
	type ParallelRecoveryInfo,
} from "./failure-hygiene.ts";

import type {
	CombineOutcome,
	IntegrationMode,
	WorkspaceContext,
	WorkspaceContinuation,
	WorkspaceContinuationCapability,
	WorkspaceContinuationPreparation,
	WorkspaceDriver,
	WorkspaceFinalization,
} from "../contracts/index.ts";
import { WorkspaceContinuationError } from "../contracts/workspace-driver.ts";
import {
	assertCleanWorkingCopy,
	assertMerged,
	changedPathEvidence,
	changedPathsBetween,
	commitWorkspaceEdits,
	createAiTaskBase,
	createBookmarkAt,
	createWorkerWorkspace,
	execJj,
	fetchIfRemote,
	removeWorkspace,
	resolveCommitId,
	revisionIdentity,
	workspaceRevision,
	parseMachineWorkspaceList,
	writeIdentityFile,
} from "./jj.ts";

export interface JujutsuDriverOptions {
	/** The repo the workspaces belong to (the main working copy). */
	projectDir: string;
	/** AI commit identity (task-base mode). */
	authorName?: string;
	authorEmail?: string;
	/** Integration mode. Default "task-base". */
	integrationMode?: IntegrationMode;
	/** Prefix for workspace/bookmark names. Default "v2-task". */
	namePrefix?: string;
}

const DEFAULT_AUTHOR_NAME = "pi-task-v2";
const DEFAULT_AUTHOR_EMAIL = "noreply@pi-task-v2.local";

/** Versioned provider-owned token format. The workspace name is only an
 * input to the digest; it is never serialized into the continuation. */
export const JUJUTSU_CONTINUATION_VERSION = "1" as const;
const CONTINUATION_TOKEN_PREFIX = `jjc${JUJUTSU_CONTINUATION_VERSION}_`;
const CONTINUATION_TOKEN_RE = /^jjc1_[a-f0-9]{64}$/;

function continuationToken(
	taskId: string,
	workspaceName: string,
	revision: string,
): string {
	const digest = createHash("sha256")
		.update(
			`jj\u0000${JUJUTSU_CONTINUATION_VERSION}\u0000${taskId}\u0000${workspaceName}\u0000${revision}`,
		)
		.digest("hex");
	return `${CONTINUATION_TOKEN_PREFIX}${digest}`;
}

function malformedContinuation(message: string): WorkspaceContinuationError {
	return new WorkspaceContinuationError("malformed_token", message);
}

export class JujutsuWorkspaceDriver implements WorkspaceDriver {
	readonly name = "jj";
	readonly integrationMode: IntegrationMode;
	readonly #opts: Required<
		Pick<
			JujutsuDriverOptions,
			| "projectDir"
			| "authorName"
			| "authorEmail"
			| "integrationMode"
			| "namePrefix"
		>
	>;
	#prepared = false;
	readonly #contexts = new Map<string, WorkspaceContext>();
	/** A live continuation is a preservation boundary: failure hygiene must
	 * not stack/forget that workspace after its token has been handed off. */
	readonly #preservedContinuations = new Map<string, string>();
	#baseChangeId: string | undefined;
	/** Optional capability is present for jj, but reports typed unsupported
	 * failures when the provider executable is unavailable. */
	readonly continuation: WorkspaceContinuationCapability = {
		supported: true,
		identity: "jj.workspace-continuation",
		version: JUJUTSU_CONTINUATION_VERSION,
		prepareContinuation: (taskId, preparationId) =>
			this.prepareContinuation(taskId, preparationId),
		preserveContinuation: (context) => this.preserveContinuation(context),
		resumeContinuation: (taskId, token) =>
			this.resumeContinuation(taskId, token),
	};

	constructor(options: JujutsuDriverOptions) {
		if (!existsSync(options.projectDir)) {
			throw new Error(
				`JujutsuWorkspaceDriver: projectDir does not exist: ${options.projectDir}`,
			);
		}
		const mode: IntegrationMode = options.integrationMode ?? "task-base";
		this.#opts = {
			projectDir: options.projectDir,
			authorName: options.authorName ?? DEFAULT_AUTHOR_NAME,
			authorEmail: options.authorEmail ?? DEFAULT_AUTHOR_EMAIL,
			integrationMode: mode,
			namePrefix: options.namePrefix ?? "v2-task",
		};
		this.integrationMode = mode;
	}

	async isSupported(): Promise<boolean> {
		const r = await execJj(["--version"], this.#opts.projectDir, {
			timeoutMs: 10_000,
		});
		return r.code === 0;
	}

	/** Fetch-if-remote once per driver (M2.a convention; non-fatal), then
	 *  the R1 clean-working-copy guard — the run's first snapshotting op. */
	async prepare(): Promise<void> {
		if (this.#prepared) return;
		await fetchIfRemote(this.#opts.projectDir);
		await assertCleanWorkingCopy(this.#opts.projectDir);
		this.#prepared = true;
	}

	async createWorkspace(taskId: string): Promise<WorkspaceContext> {
		if (!this.#prepared) await this.prepare();
		const name = `${this.#opts.namePrefix}-${taskId}`;
		const dir = await createWorkerWorkspace(this.#opts.projectDir, name);
		const context: WorkspaceContext = {
			taskId,
			hostPath: dir,
			branchName: name,
			status: "active",
		};
		this.#contexts.set(name, context);
		return context;
	}

	/** Discover-or-create the workspace owned by a durable preparation id.
	 * The id is never a path or a daemon-side jj name; it is reduced to a
	 * provider-owned stable workspace identity here. */
	private async prepareContinuation(
		taskId: string,
		preparationId: string,
	): Promise<WorkspaceContinuationPreparation> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(preparationId))
			throw new WorkspaceContinuationError("malformed_token", "continuation preparation identity is malformed");
		if (!this.#prepared) await this.prepare();
		const stableName = `${this.#opts.namePrefix}-continuation-${createHash("sha256").update(preparationId).digest("hex").slice(0, 24)}`;
		let context: WorkspaceContext | undefined;
		try {
			const listed = await execJj(["workspace", "list", "--ignore-working-copy"], this.#opts.projectDir);
			if (listed.code === 0 && listed.stdout.split(/\r?\n/).some((line) => line.includes(stableName))) {
				const root = await execJj(["workspace", "root", "--name", stableName, "--ignore-working-copy"], this.#opts.projectDir);
				if (root.code === 0 && root.stdout.trim()) context = {
					taskId, hostPath: resolve(root.stdout.trim()), branchName: stableName, status: "active",
				};
			}
		} catch { /* the create/reconcile attempt below supplies the typed result */ }
		if (context === undefined) {
			try {
				const dir = await createWorkerWorkspace(this.#opts.projectDir, stableName);
				context = { taskId, hostPath: dir, branchName: stableName, status: "active" };
			} catch {
				// A concurrent daemon may have won the add. Reconcile by the
				// provider-owned identity rather than creating a second workspace.
				const root = await execJj(["workspace", "root", "--name", stableName, "--ignore-working-copy"], this.#opts.projectDir);
				if (root.code !== 0 || !root.stdout.trim()) throw new WorkspaceContinuationError("missing", "prepared workspace could not be reconciled");
				context = { taskId, hostPath: resolve(root.stdout.trim()), branchName: stableName, status: "active" };
			}
		}
		this.#contexts.set(stableName, context);
		const continuation = await this.preserveContinuation(context);
		return Object.freeze({ context, continuation });
	}

	/** Snapshot and preserve a workspace without putting its jj name or host
	 * path into the provider-neutral handle. Repeating this operation for the
	 * same tree returns the same token and does not create another commit. */
	private async preserveContinuation(
		context: WorkspaceContext,
	): Promise<WorkspaceContinuation> {
		if (!(await this.isSupported()))
			throw new WorkspaceContinuationError(
				"unsupported",
				"jj continuation is unsupported because jj is unavailable",
			);
		if (
			!context.taskId ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(context.branchName)
		)
			throw new WorkspaceContinuationError(
				"missing",
				"workspace is not owned by this jj driver",
			);
		const root = await execJj(
			["workspace", "root", "--name", context.branchName, "--ignore-working-copy"],
			this.#opts.projectDir,
		);
		if (root.code !== 0)
			throw new WorkspaceContinuationError(
				"missing",
				"workspace continuation target is missing",
			);
		if (resolve(root.stdout.trim()) !== resolve(context.hostPath))
			throw new WorkspaceContinuationError(
				"missing",
				"workspace continuation target is not owned by this context",
			);
		// A status probe is intentionally the only snapshotting operation here:
		// it captures an interrupted dirty tail while preserving all user files.
		const status = await execJj(["status"], context.hostPath);
		if (status.code !== 0)
			throw new WorkspaceContinuationError(
				"missing",
				"workspace continuation target cannot be read",
			);
		let revision: string;
		try {
			revision = (await workspaceRevision(this.#opts.projectDir, context.branchName)).commitId;
		} catch {
			throw new WorkspaceContinuationError(
				"missing",
				"workspace continuation revision is unavailable",
			);
		}
		const opaqueToken = continuationToken(
			context.taskId,
			context.branchName,
			revision,
		);
		this.#preservedContinuations.set(context.branchName, opaqueToken);
		return Object.freeze({ opaqueToken, revision });
	}

	/** Resolve a token after restart by checking every provider-owned workspace
	 * identity. No driver instance state, path supplied by the caller, or jj
	 * branch name crosses this API. */
	private async resumeContinuation(
		taskId: string,
		continuation: WorkspaceContinuation,
	): Promise<WorkspaceContext> {
		if (
			taskId.length === 0 ||
			taskId.length > 256 ||
			/[\u0000-\u001f]/.test(taskId) ||
			typeof continuation !== "object" ||
			continuation === null ||
			typeof continuation.opaqueToken !== "string" ||
			typeof continuation.revision !== "string"
		)
			throw malformedContinuation("continuation identity is malformed");
		if (!CONTINUATION_TOKEN_RE.test(continuation.opaqueToken))
			throw malformedContinuation("continuation token has an unknown provider or version");
		if (!/^[0-9a-f]{40}$/.test(continuation.revision))
			throw malformedContinuation("continuation revision is malformed");
		if (!(await this.isSupported()))
			throw new WorkspaceContinuationError(
				"unsupported",
				"jj continuation is unsupported because jj is unavailable",
			);
		const listed = await execJj(
			[
				"workspace",
				"list",
				"-T",
				'self.name() ++ "\\t" ++ self.target().change_id() ++ "\\t" ++ self.target().commit_id() ++ "\\n"',
				"--ignore-working-copy",
			],
			this.#opts.projectDir,
		);
		if (listed.code !== 0)
			throw new WorkspaceContinuationError(
				"missing",
				"workspace continuation registry is unavailable",
			);
		const workspaces = parseMachineWorkspaceList(listed.stdout);
		let ownedName: string | undefined;
		for (const [name, revision] of workspaces) {
			if (
				continuationToken(taskId, name, continuation.revision) ===
				continuation.opaqueToken
			) {
				ownedName = name;
				if (revision.commitId !== continuation.revision)
					throw new WorkspaceContinuationError(
						"stale",
						"workspace continuation revision no longer matches",
					);
				break;
			}
		}
		if (ownedName === undefined) {
			const sameRevision = [...workspaces.values()].some(
				(revision) => revision.commitId === continuation.revision,
			);
			throw new WorkspaceContinuationError(
				sameRevision ? "malformed_token" : "missing",
				sameRevision
					? "continuation token is not owned by this jj provider"
					: "workspace continuation target is missing",
			);
		}
		const root = await execJj(
			["workspace", "root", "--name", ownedName, "--ignore-working-copy"],
			this.#opts.projectDir,
		);
		if (root.code !== 0 || root.stdout.trim().length === 0)
			throw new WorkspaceContinuationError(
				"missing",
				"workspace continuation root is missing",
			);
		const context = {
			taskId,
			hostPath: resolve(root.stdout.trim()),
			branchName: ownedName,
			status: "active" as const,
		};
		this.#contexts.set(ownedName, context);
		this.#preservedContinuations.set(ownedName, continuation.opaqueToken);
		return context;
	}

	/** Finalize a worker without trusting model-reported VCS evidence. A
	 * normal jj diff snapshots pending edits; only those edits receive an
	 * engine-authored commit. Existing model commits remain untouched. */
	async finalizeWorkspace(
		context: WorkspaceContext,
		baseChangeId: string,
	): Promise<WorkspaceFinalization> {
		const pendingPaths = await changedPathsBetween(
			context.hostPath,
			"@-",
			"@",
			{ snapshotWorkingCopy: true },
		);
		if (pendingPaths.length > 0) {
			const identityFile = writeIdentityFile(
				this.#opts.authorName,
				this.#opts.authorEmail,
			);
			await commitWorkspaceEdits(
				context.hostPath,
				identityFile,
				`engine: finalize ${context.taskId}`,
				{ name: this.#opts.authorName, email: this.#opts.authorEmail },
			);
		}

		const tip = await revisionIdentity(context.hostPath, "@-");
		const baseCommit = await resolveCommitId(
			this.#opts.projectDir,
			baseChangeId,
		);
		const evidence = await changedPathEvidence(
			context.hostPath,
			baseCommit,
			tip.commitId,
		);
		return {
			changeId: tip.changeId,
			commitId: tip.commitId,
			...evidence,
			hasChanges: evidence.changedPaths.length > 0,
		};
	}

	/**
	 * Single-workspace merge (contract method): for task-base mode this is
	 * the atomic combine of ONE workspace into the base; conflicts are
	 * union-resolved first, residual conflicts are returned (escalation).
	 * feature-branch mode: bookmark the tip; nothing merges.
	 */
	async mergeWorkspace(
		context: WorkspaceContext,
	): Promise<{ success: boolean; conflicts?: string[] }> {
		if (this.#opts.integrationMode === "feature-branch") {
			await createBookmarkAt(
				this.#opts.projectDir,
				context.branchName,
				context.branchName,
			);
			return { success: true, conflicts: [] };
		}
		const base = this.#requireBase();
		const outcome = await this.combine(base, [context]);
		return {
			success: outcome.conflicts.length === 0,
			conflicts: outcome.conflicts,
		};
	}

	async cleanupWorkspace(context: WorkspaceContext): Promise<void> {
		await removeWorkspace(
			this.#opts.projectDir,
			context.branchName,
			context.hostPath,
		);
		this.#contexts.delete(context.branchName);
		this.#preservedContinuations.delete(context.branchName);
	}

	/** AI-authored empty base parented on @- (task-base mode). */
	async prepareIntegrationBase(goal: string): Promise<string> {
		// A driver can be reused for warm attempts. The integration base is
		// attempt-scoped, so never reuse a prior run's change id after the main
		// working copy has been materialized.
		if (!this.#prepared) await this.prepare();
		const identityFile = writeIdentityFile(
			this.#opts.authorName,
			this.#opts.authorEmail,
		);
		this.#baseChangeId = await createAiTaskBase(
			this.#opts.projectDir,
			identityFile,
			goal,
		);
		return this.#baseChangeId;
	}

	/** R1 atomic combine across ALL contexts, then the R4 union ladder,
	 *  then the R3 consistency gate over the expected file union. */
	async combine(
		baseChangeId: string,
		contexts: readonly WorkspaceContext[],
	): Promise<CombineOutcome> {
		if (this.#opts.integrationMode === "feature-branch") {
			throw new Error(
				"combine() is unavailable in feature-branch integration mode",
			);
		}
		const {
			mergeWorkspacesAtomic,
			resolveConflictsWithUnion,
			workspaceFileChanges,
		} = await import("./jj.ts");
		const names = contexts.map((c) => c.branchName);
		// Pre-merge union of worker file changes — the consistency gate's input.
		const expected = new Set<string>();
		for (const c of contexts) {
			for (const change of await workspaceFileChanges(
				this.#opts.projectDir,
				baseChangeId,
				c.branchName,
			)) {
				if (change.kind !== "D") expected.add(change.file);
			}
		}
		const outcome = await mergeWorkspacesAtomic(
			this.#opts.projectDir,
			names,
			baseChangeId,
		);
		if (outcome.conflicts.length > 0) {
			await resolveConflictsWithUnion(
				this.#opts.projectDir,
				baseChangeId,
				outcome.conflicts,
			);
			const { detectChangeConflicts } = await import("./jj.ts");
			outcome.conflicts = await detectChangeConflicts(
				this.#opts.projectDir,
				baseChangeId,
			);
		}
		await assertMerged(this.#opts.projectDir, baseChangeId, {
			expectedFiles: [...expected],
		});
		return outcome;
	}

	/** Materialize the integrated tree (contract TaskBaseWorkspaceDriver):
	 *  place the main working copy on a child of the merged base so
	 *  verification (and the operator) see the integrated work. */
	async materialize(baseChangeId: string): Promise<void> {
		const { resolveCommitId } = await import("./jj.ts");
		const commitId = await resolveCommitId(this.#opts.projectDir, baseChangeId);
		const result = await execJj(["new", commitId], this.#opts.projectDir);
		if (result.code !== 0)
			throw new Error(
				`jj new <merged> failed (${result.code}): ${result.stderr.trim()}`,
			);
	}

	/**
	 * Failure-artifact contract rules 1–6 (engine-side post-mortem): on ANY
	 * failed/aborted run the driver performs the repo reconciliation itself —
	 * undescribed dirty snapshots become described rescue commits, each
	 * workspace's commits are stacked onto the dispatch base in ONE linear
	 * chain, engine-authored empty stubs are abandoned, consumed workspaces
	 * are forgotten — and returns the machine-readable recovery info for the
	 * failure artifact (stack tip, per-workspace heads, preserved-by-doubt
	 * stubs, exact jj commands). Best-effort and bounded; never throws.
	 */
	async recoverFailedRun(opts: {
		workspaceNames: string[];
		cause: string;
		/** Working-copy dirs by workspace name — enables the content-bearing-@
		 *  detach before the forget; a name without a dir is stacked but kept
		 *  live on any failure. */
		workspaceDirs?: Record<string, string> | undefined;
	}): Promise<ParallelRecoveryInfo> {
		const base = this.#requireBase();
		// A handed-off continuation is intentionally left live. The post-mortem
		// still applies all existing cleanup rules to workspaces that were not
		// explicitly preserved, while the opaque token remains resumable.
		const disposableNames = opts.workspaceNames.filter(
			(name) => !this.#preservedContinuations.has(name),
		);
		return parallelRunPostMortem({
			projectDir: this.#opts.projectDir,
			workspaceNames: disposableNames,
			protectedWorkspaceNames: opts.workspaceNames.filter((name) =>
				this.#preservedContinuations.has(name),
			),
			// The workspaces branched from the AI base's PARENT in identity
			// mode (createAiTaskBase parents it on @-) — that is the dispatch
			// base the chains hang off.
			baseChangeId: base,
			dispatchBaseChangeId: await dispatchBaseOf(this.#opts.projectDir, base),
			cause: opts.cause,
			aiAuthorEmail: this.#opts.authorEmail,
			...(opts.workspaceDirs === undefined
				? {}
				: { workspaceDirs: opts.workspaceDirs }),
		});
	}

	/** The configured AI identity email — the provenance test callers use
	 *  when running single-run hygiene against this driver's repo. */
	get authorEmail(): string {
		return this.#opts.authorEmail;
	}

	async publishBookmarks(
		contexts: readonly WorkspaceContext[],
	): Promise<string[]> {
		const created: string[] = [];
		for (const c of contexts) {
			await createBookmarkAt(this.#opts.projectDir, c.branchName, c.branchName);
			created.push(c.branchName);
		}
		return created;
	}

	#requireBase(): string {
		if (this.#baseChangeId === undefined) {
			throw new Error(
				"no integration base prepared — call prepareIntegrationBase(goal) first",
			);
		}
		return this.#baseChangeId;
	}
}
