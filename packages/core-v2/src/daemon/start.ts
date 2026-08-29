/**
 * Daemon entry point — M1.4 / R2.
 *
 * Library-first daemon surface: start(dbPath) opens the ledger and applies
 * boot reconciliation before any work is accepted:
 *
 *   - LEDGER: stale in-flight tasks → requeue or fail per the pure
 *     reconcileCrashedTask policy;
 *   - REPO: the default working-copy lineage is swept of artifacts left by
 *     CRASHED past runs (failure-artifact contract rules 1–4): only
 *     provably engine-authored strays are abandoned — undescribed AI
 *     snapshots folded into @, empty description-less AI stubs — while the
 *     user's described history, rescue commits, and any doubtful content
 *     are preserved untouched (and reported under `repoHygiene.preserved`).
 *
 * Long-running process hosting, surface attachment, and scheduling arrive
 * in later milestones; M1's contract is the pipeline + durable state.
 */

import { LedgerStore } from "../ledger/store.ts";
import { ContextArtifactStore } from "../context/artifact-store.ts";
import type { WorkspaceDriver } from "../contracts/workspace-driver.ts";
import { validateChildEdgesOnBoot } from "./child-reconciliation.ts";
import { assertNoMaxCostUsd } from "../budget/execution-budget.ts";
import {
	reconcileRepoArtifacts,
	type RepoHygieneReport,
} from "../workspaces/failure-hygiene.ts";

/** The repo whose default lineage boot hygiene sweeps. */
export interface StartDaemonOptions {
	/** Historical compatibility only; new daemon starts reject this field. */
	maxCostUsd?: number;
	/** Repo root to reconcile at boot. When absent, NO repo sweep runs —
	 *  ledger-only boots stay side-effect free on the filesystem. */
	projectDir?: string | undefined;
	/** AI identity email — the provenance test for engine-authored strays.
	 *  Default matches the workspace driver's DEFAULT_AUTHOR_EMAIL; with an
	 *  explicit undefined override NOTHING is cleaned (report-only). */
	aiAuthorEmail?: string | undefined;
	/** Dependencies for validity-authoritative child boot reconciliation. They
	 * are optional so ordinary standalone daemon boots remain ledger-only. If
	 * omitted, active claimed edges fail closed rather than becoming resumable. */
	artifactStore?: ContextArtifactStore;
	workspaceDriver?: WorkspaceDriver;
	model?: string;
}

export interface StartedDaemon {
	store: LedgerStore;
	/** Reconciliation outcome: task ids requeued vs failed at boot. */
	reconciled: { requeued: string[]; failed: string[] };
	/** Child preparation ownership is classified before generic task retry;
	 * preparing reservations remain owned by sequential recovery. */
	childReconciled: ReturnType<LedgerStore["reconcileChildEdgesOnBoot"]>;
	/** Repo-artifact hygiene result (default-lineage strays). `undefined`
	 *  when no projectDir was configured or the sweep was skipped. */
	repoHygiene?: RepoHygieneReport | undefined;
}

const DEFAULT_AI_AUTHOR_EMAIL = "noreply@pi-task-v2.local";

/** Open the ledger at dbPath and run both reconciliations. */
export async function startDaemon(
	dbPath: string,
	options: StartDaemonOptions = {},
): Promise<StartedDaemon> {
	// Reject unsupported execution configuration before opening the ledger or
	// inspecting the workspace. This is the daemon/library ingress boundary.
	assertNoMaxCostUsd(options.maxCostUsd);
	const store = new LedgerStore(dbPath);
	// Edge ownership is authoritative: validate immutable bytes and provider
	// ownership before the generic task retry policy can see either side. The
	// provider check is outside the ledger transaction; only its typed result
	// crosses into the durable reconciliation write.
	const validationDependenciesPresent = options.artifactStore !== undefined &&
		options.workspaceDriver !== undefined && options.model !== undefined;
	const validations = await validateChildEdgesOnBoot(store, store.listRecoverableChildEdges(validationDependenciesPresent), {
		...(options.artifactStore === undefined ? {} : { artifactStore: options.artifactStore }),
		...(options.workspaceDriver === undefined ? {} : { workspaceDriver: options.workspaceDriver }),
		...(options.model === undefined ? {} : { model: options.model }),
	});
	const childReconciled = store.reconcileChildEdgesOnBoot(validations);
	const reconciled = store.reconcileOnBoot();
	let repoHygiene: RepoHygieneReport | undefined;
	if (options.projectDir !== undefined) {
		try {
			repoHygiene = await reconcileRepoArtifacts({
				projectDir: options.projectDir,
				aiAuthorEmail: options.aiAuthorEmail ?? DEFAULT_AI_AUTHOR_EMAIL,
			});
		} catch {
			// Boot must proceed regardless of repo state (never throws).
			repoHygiene = { cleaned: [], preserved: [] };
		}
	}
	return {
		store,
		reconciled,
		childReconciled,
		...(repoHygiene === undefined ? {} : { repoHygiene }),
	};
}
