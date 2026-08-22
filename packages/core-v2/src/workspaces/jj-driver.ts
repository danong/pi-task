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

import { existsSync } from "node:fs";

import type {
	CombineOutcome,
	IntegrationMode,
	WorkspaceContext,
	WorkspaceDriver,
} from "../contracts/index.ts";
import {
	assertCleanWorkingCopy,
	assertMerged,
	createAiTaskBase,
	createBookmarkAt,
	createWorkerWorkspace,
	execJj,
	fetchIfRemote,
	removeWorkspace,
	taskBaseChangeId,
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

export class JujutsuWorkspaceDriver implements WorkspaceDriver {
	readonly name = "jj";
	readonly integrationMode: IntegrationMode;
	readonly #opts: Required<Pick<JujutsuDriverOptions, "projectDir" | "authorName" | "authorEmail" | "integrationMode" | "namePrefix">>;
	#prepared = false;
	readonly #contexts = new Map<string, WorkspaceContext>();
	#baseChangeId: string | undefined;

	constructor(options: JujutsuDriverOptions) {
		if (!existsSync(options.projectDir)) {
			throw new Error(`JujutsuWorkspaceDriver: projectDir does not exist: ${options.projectDir}`);
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
		const r = await execJj(["--version"], this.#opts.projectDir, { timeoutMs: 10_000 });
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

	async createWorkspace(taskId: string, _parentBranch?: string): Promise<WorkspaceContext> {
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

	/**
	 * Single-workspace merge (contract method): for task-base mode this is
	 * the atomic combine of ONE workspace into the base; conflicts are
	 * union-resolved first, residual conflicts are returned (escalation).
	 * feature-branch mode: bookmark the tip; nothing merges.
	 */
	async mergeWorkspace(context: WorkspaceContext): Promise<{ success: boolean; conflicts?: string[] }> {
		if (this.#opts.integrationMode === "feature-branch") {
			await createBookmarkAt(this.#opts.projectDir, context.branchName, context.branchName);
			return { success: true, conflicts: [] };
		}
		const base = this.#requireBase();
		const outcome = await this.combine(base, [context]);
		return { success: outcome.conflicts.length === 0, conflicts: outcome.conflicts };
	}

	async cleanupWorkspace(context: WorkspaceContext): Promise<void> {
		await removeWorkspace(this.#opts.projectDir, context.branchName, context.hostPath);
		this.#contexts.delete(context.branchName);
	}

	/** AI-authored empty base parented on @- (task-base mode). */
	async prepareIntegrationBase(goal: string): Promise<string> {
		if (this.#baseChangeId !== undefined) return this.#baseChangeId;
		if (!this.#prepared) await this.prepare();
		const identityFile = writeIdentityFile(this.#opts.authorName, this.#opts.authorEmail);
		this.#baseChangeId = await createAiTaskBase(this.#opts.projectDir, identityFile, goal);
		return this.#baseChangeId;
	}

	/** R1 atomic combine across ALL contexts, then the R4 union ladder,
	 *  then the R3 consistency gate over the expected file union. */
	async combine(baseChangeId: string, contexts: readonly WorkspaceContext[]): Promise<CombineOutcome> {
		if (this.#opts.integrationMode === "feature-branch") {
			throw new Error("combine() is unavailable in feature-branch integration mode");
		}
		const { mergeWorkspacesAtomic, resolveConflictsWithUnion, workspaceFileChanges } = await import("./jj.ts");
		const names = contexts.map((c) => c.branchName);
		// Pre-merge union of worker file changes — the consistency gate's input.
		const expected = new Set<string>();
		for (const c of contexts) {
			for (const change of await workspaceFileChanges(this.#opts.projectDir, baseChangeId, c.branchName)) {
				if (change.kind !== "D") expected.add(change.file);
			}
		}
		const outcome = await mergeWorkspacesAtomic(this.#opts.projectDir, names, baseChangeId);
		if (outcome.conflicts.length > 0) {
			await resolveConflictsWithUnion(this.#opts.projectDir, baseChangeId, outcome.conflicts);
			const { detectChangeConflicts } = await import("./jj.ts");
			outcome.conflicts = await detectChangeConflicts(this.#opts.projectDir, baseChangeId);
		}
		await assertMerged(this.#opts.projectDir, baseChangeId, { expectedFiles: [...expected] });
		return outcome;
	}

	/** Place the main working copy on a child of the merged base so
	 *  verification (and the operator) see the integrated tree. */
	async checkoutMerged(baseChangeId: string): Promise<void> {
		const { resolveCommitId } = await import("./jj.ts");
		const commitId = await resolveCommitId(this.#opts.projectDir, baseChangeId);
		const result = await execJj(["new", commitId], this.#opts.projectDir);
		if (result.code !== 0) throw new Error(`jj new <merged> failed (${result.code}): ${result.stderr.trim()}`);
	}

	async publishBookmarks(contexts: readonly WorkspaceContext[]): Promise<string[]> {
		const created: string[] = [];
		for (const c of contexts) {
			await createBookmarkAt(this.#opts.projectDir, c.branchName, c.branchName);
			created.push(c.branchName);
		}
		return created;
	}

	#requireBase(): string {
		if (this.#baseChangeId === undefined) {
			throw new Error("no integration base prepared — call prepareIntegrationBase(goal) first");
		}
		return this.#baseChangeId;
	}
}
