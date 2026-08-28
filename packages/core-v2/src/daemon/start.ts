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
import {
	reconcileRepoArtifacts,
	type RepoHygieneReport,
} from "../workspaces/failure-hygiene.ts";

/** The repo whose default lineage boot hygiene sweeps. */
export interface StartDaemonOptions {
	/** Repo root to reconcile at boot. When absent, NO repo sweep runs —
	 *  ledger-only boots stay side-effect free on the filesystem. */
	projectDir?: string | undefined;
	/** AI identity email — the provenance test for engine-authored strays.
	 *  Default matches the workspace driver's DEFAULT_AUTHOR_EMAIL; with an
	 *  explicit undefined override NOTHING is cleaned (report-only). */
	aiAuthorEmail?: string | undefined;
}

export interface StartedDaemon {
	store: LedgerStore;
	/** Reconciliation outcome: task ids requeued vs failed at boot. */
	reconciled: { requeued: string[]; failed: string[] };
	/** Child preparation ownership is classified before generic task retry;
	 * preparing reservations remain owned by sequential recovery. */
	childReconciled: { preparing: string[]; resumable: string[]; blocked: string[] };
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
	const store = new LedgerStore(dbPath);
	// Edge ownership is authoritative: classify/recover child work before the
	// generic task retry policy can see either side of the composition. The
	// ledger method leaves preparing/ready edges untouched for sequential
	// recovery and blocks incomplete claimed/resumable ingress.
	const childReconciled = store.reconcileChildEdgesOnBoot();
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
