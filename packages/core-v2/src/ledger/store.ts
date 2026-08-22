/**
 * Ledger — task/session/feedback/workspace persistence (subsystems §4,
 * contract NFR-1).
 *
 * SQLite via node:sqlite's DatabaseSync (zero new dependencies; Node v24).
 * The ledger is the SINGLE source of truth for task graphs and session
 * state (`.pi/tasks.db` in a real deployment, temp-dir DBs in tests).
 * Recovery reads the ledger, never transcripts (NFR-1).
 *
 * Fields that vary per attempt (timestamps, session ids, run ids) live
 * HERE, not in prompt-bound payloads (deterministic-serialization rule).
 *
 * Migration model: a versioned, additive schema. user_version tracks the
 * applied version; opening an older DB applies the newer migrations
 * idempotently. The first version creates all four tables.
 */

import { DatabaseSync } from "node:sqlite";

export const LEDGER_SCHEMA_VERSION = 1;

export type TaskStatus =
	| "queued"
	| "planning"
	| "executing"
	| "verifying"
	| "reviewing"
	| "completed"
	| "failed"
	| "escalated";
export type PlanMode = "prewalk" | "bundle" | "fork" | "cold";
export type SessionRole = "worker" | "reviewer";
export type SessionStatus = "active" | "yielded" | "exhausted" | "crashed";
export type WorkspaceStatus = "provisioning" | "active" | "merging" | "cleaning_up" | "released" | "orphaned";

export interface NewTask {
	id: string;
	goal: string;
	parentBranch?: string | null;
	planMode?: PlanMode | null;
	retryCount?: number;
	maxRetries?: number;
}

export interface TaskRow {
	id: string;
	status: TaskStatus;
	goal: string;
	parentBranch: string | null;
	planMode: PlanMode | null;
	retryCount: number;
	maxRetries: number;
	createdAt: string;
	updatedAt: string;
}

export interface NewMicroSession {
	id: string;
	taskId: string;
	role: SessionRole;
	turnCount?: number;
	yieldPayload?: string | null;
}

export interface MicroSessionRow {
	id: string;
	taskId: string;
	role: SessionRole;
	status: SessionStatus;
	turnCount: number;
	yieldPayload: string | null;
	lastHeartbeatAt: string | null;
}

export interface NewWorkspace {
	id: string;
	taskId: string;
	driver: string;
	hostPath: string;
	containerPath?: string | null;
	branchName: string;
}

export interface WorkspaceRow {
	id: string;
	taskId: string;
	driver: string;
	hostPath: string;
	containerPath: string | null;
	branchName: string;
	status: WorkspaceStatus;
	createdAt: string;
	updatedAt: string;
}

/** The four-table DDL from subsystems §4 (plus `workspaces`, whose columns
 *  mirror WorkspaceContext; timestamps/session ids stay ledger-side). */
const V1_DDL = `
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN (
        'queued', 'planning', 'executing', 'verifying', 'reviewing',
        'completed', 'failed', 'escalated')),
    goal TEXT NOT NULL,
    parent_branch TEXT,
    plan_mode TEXT CHECK (plan_mode IN ('prewalk', 'bundle', 'fork', 'cold')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 2,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS micro_sessions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('worker', 'reviewer')),
    status TEXT NOT NULL CHECK (status IN ('active', 'yielded', 'exhausted', 'crashed')),
    turn_count INTEGER DEFAULT 0,
    yield_payload JSON,
    last_heartbeat_at DATETIME  -- child processes only (detached/scheduler);
                                -- NULL for in-process sessions (no pid exists)
);

CREATE TABLE IF NOT EXISTS routing_feedback (
    -- Per-repo telemetry feeding the route function (bundle_hit_rate,
    -- fork_deviation_rate). The system learns from manifests, not folklore.
    repo TEXT NOT NULL,
    mode TEXT NOT NULL,
    hit INTEGER NOT NULL,        -- 1 = bundle grounded turn 1 / fork clean
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    driver TEXT NOT NULL,
    host_path TEXT NOT NULL,
    container_path TEXT,
    branch_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN (
        'provisioning', 'active', 'merging', 'cleaning_up', 'released', 'orphaned')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

interface Migration {
	version: number;
	sql: string;
}

/** Additive migrations, oldest first. Every later migration must not
 *  conflict with earlier ones (the ledger is append-only in shape). */
const MIGRATIONS: Migration[] = [{ version: 1, sql: V1_DDL }];

function migrate(db: DatabaseSync): void {
	const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
	const current = row.user_version ?? 0;
	for (const migration of MIGRATIONS) {
		if (migration.version > current) {
			db.exec(migration.sql);
		}
	}
	if (current < LEDGER_SCHEMA_VERSION) {
		db.exec(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION}`);
	}
}

export class LedgerStore {
	readonly db: DatabaseSync;

	constructor(readonly path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA foreign_keys = ON");
		migrate(this.db);
	}

	close(): void {
		this.db.close();
	}

	// ─── tasks ─────────────────────────────────────────────────────────

	insertTask(task: NewTask): void {
		this.db
			.prepare(
				`INSERT INTO tasks (id, status, goal, parent_branch, plan_mode, retry_count, max_retries)
				 VALUES (?, 'queued', ?, ?, ?, ?, ?)`,
			)
			.run(
				task.id,
				task.goal,
				task.parentBranch ?? null,
				task.planMode ?? null,
				task.retryCount ?? 0,
				task.maxRetries ?? 2,
			);
	}

	getTask(id: string): TaskRow | null {
		const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
			| (Record<string, unknown> & { id: string })
			| undefined;
		return row ? rowToTask(row) : null;
	}

	setTaskStatus(id: string, status: TaskStatus): void {
		this.db
			.prepare("UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
			.run(status, id);
	}

	setTaskPlanMode(id: string, planMode: PlanMode): void {
		this.db
			.prepare("UPDATE tasks SET plan_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
			.run(planMode, id);
	}

	incrementRetry(id: string): void {
		this.db
			.prepare("UPDATE tasks SET retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
			.run(id);
	}

	listTasks(status?: TaskStatus): TaskRow[] {
		const rows = status
			? (this.db.prepare("SELECT * FROM tasks WHERE status = ?").all(status) as Record<string, unknown>[])
			: (this.db.prepare("SELECT * FROM tasks").all() as Record<string, unknown>[]);
		return rows.map(rowToTask);
	}

	// ─── micro_sessions ────────────────────────────────────────────────

	insertMicroSession(session: NewMicroSession): void {
		this.db
			.prepare(
				`INSERT INTO micro_sessions (id, task_id, role, status, turn_count, yield_payload)
					 VALUES (?, ?, ?, 'active', ?, ?)`,
			)
			.run(session.id, session.taskId, session.role, session.turnCount ?? 0, session.yieldPayload ?? null);
	}

	getMicroSession(id: string): MicroSessionRow | null {
		const row = this.db.prepare("SELECT * FROM micro_sessions WHERE id = ?").get(id) as
			| (Record<string, unknown> & { id: string })
			| undefined;
		return row ? rowToSession(row) : null;
	}

	setSessionStatus(id: string, status: SessionStatus, yieldPayload?: string | null): void {
		if (yieldPayload !== undefined) {
			this.db
				.prepare("UPDATE micro_sessions SET status = ?, yield_payload = ? WHERE id = ?")
				.run(status, yieldPayload, id);
		} else {
			this.db.prepare("UPDATE micro_sessions SET status = ? WHERE id = ?").run(status, id);
		}
	}

	heartbeat(id: string): void {
		this.db
			.prepare("UPDATE micro_sessions SET last_heartbeat_at = CURRENT_TIMESTAMP WHERE id = ?")
			.run(id);
	}

	listSessions(taskId: string): MicroSessionRow[] {
		const rows = this.db
			.prepare("SELECT * FROM micro_sessions WHERE task_id = ?")
			.all(taskId) as Record<string, unknown>[];
		return rows.map(rowToSession);
	}

	// ─── routing_feedback ──────────────────────────────────────────────

	recordRoutingFeedback(repo: string, mode: string, hit: number): void {
		this.db.prepare("INSERT INTO routing_feedback (repo, mode, hit) VALUES (?, ?, ?)").run(repo, mode, hit);
	}

	/** Aggregate hit counts per mode for a repo (bundle_hit_rate /
	 *  fork_deviation_rate feeding, §5.4). */
	routingSummary(repo: string): Map<string, { total: number; hits: number }> {
		const rows = this.db
			.prepare("SELECT mode, hit, COUNT(*) AS n FROM routing_feedback WHERE repo = ? GROUP BY mode, hit")
			.all(repo) as Record<string, unknown>[];
		const out = new Map<string, { total: number; hits: number }>();
		for (const row of rows) {
			const mode = String(row.mode);
			const isHit = Number(row.hit) === 1;
			const count = Number(row.n);
			const cur = out.get(mode) ?? { total: 0, hits: 0 };
			cur.total += count;
			if (isHit) cur.hits += count;
			out.set(mode, cur);
		}
		return out;
	}

	// ─── workspaces ────────────────────────────────────────────────────

	insertWorkspace(workspace: NewWorkspace): void {
		this.db
			.prepare(
				`INSERT INTO workspaces (id, task_id, driver, host_path, container_path, branch_name)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				workspace.id,
				workspace.taskId,
				workspace.driver,
				workspace.hostPath,
				workspace.containerPath ?? null,
				workspace.branchName,
			);
	}

	getWorkspace(id: string): WorkspaceRow | null {
		const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
			| (Record<string, unknown> & { id: string })
			| undefined;
		return row ? rowToWorkspace(row) : null;
	}

	setWorkspaceStatus(id: string, status: WorkspaceStatus): void {
		this.db
			.prepare("UPDATE workspaces SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
			.run(status, id);
	}

	listWorkspaces(taskId: string): WorkspaceRow[] {
		const rows = this.db
			.prepare("SELECT * FROM workspaces WHERE task_id = ?")
			.all(taskId) as Record<string, unknown>[];
		return rows.map(rowToWorkspace);
	}

	// ─── boot reconciliation (NFR-1) ──────────────────────────────────

	/**
	 * Mark every in-flight task from a crashed daemon as requeued (when
	 * attempts remain) or failed (when retries are exhausted), applying the
	 * pure reconcileCrashedTask policy. Idempotent: tasks already in a
	 * terminal/queued state are untouched. Returns the touched ids.
	 */
	reconcileOnBoot(): { requeued: string[]; failed: string[] } {
		const inFlight = this.listTasks().filter((t) => isInFlight(t.status));
		const requeued: string[] = [];
		const failed: string[] = [];
		const requeueStmt = this.db.prepare(
			"UPDATE tasks SET status = 'queued', retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
		);
		const failStmt = this.db.prepare(
			"UPDATE tasks SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
		);
		for (const task of inFlight) {
			const decision = reconcileCrashedTask({ status: task.status, retryCount: task.retryCount, maxRetries: task.maxRetries });
			if (decision.action === "requeue") {
				requeueStmt.run(task.id);
				requeued.push(task.id);
			} else if (decision.action === "fail") {
				failStmt.run(task.id);
				failed.push(task.id);
			}
		}
		return { requeued, failed };
	}
}

// ─── Row mappers (snake_case DDL → camelCase TS) ─────────────────────

function rowToTask(row: Record<string, unknown>): TaskRow {
	return {
		id: String(row.id),
		status: row.status as TaskStatus,
		goal: String(row.goal),
		parentBranch: row.parent_branch === null ? null : String(row.parent_branch),
		planMode: row.plan_mode === null ? null : (row.plan_mode as PlanMode),
		retryCount: Number(row.retry_count),
		maxRetries: Number(row.max_retries),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function rowToSession(row: Record<string, unknown>): MicroSessionRow {
	return {
		id: String(row.id),
		taskId: String(row.task_id),
		role: row.role as SessionRole,
		status: row.status as SessionStatus,
		turnCount: Number(row.turn_count),
		yieldPayload: row.yield_payload === null ? null : String(row.yield_payload),
		lastHeartbeatAt: row.last_heartbeat_at === null ? null : String(row.last_heartbeat_at),
	};
}

function rowToWorkspace(row: Record<string, unknown>): WorkspaceRow {
	return {
		id: String(row.id),
		taskId: String(row.task_id),
		driver: String(row.driver),
		hostPath: String(row.host_path),
		containerPath: row.container_path === null ? null : String(row.container_path),
		branchName: String(row.branch_name),
		status: row.status as WorkspaceStatus,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

// ─── Boot reconciliation policy (pure, unit-testable) ────────────────

/** Statuses that indicate a task was mid-flight when the daemon died. */
export const IN_FLIGHT_STATUSES: TaskStatus[] = ["planning", "executing", "verifying", "reviewing"];

export function isInFlight(status: TaskStatus): boolean {
	return (IN_FLIGHT_STATUSES as string[]).includes(status);
}

export type ReconcileDecision =
	| { action: "keep" }
	| { action: "requeue" }
	| { action: "fail" };

/**
 * Pure crash-recovery policy (subsystems §4 / NFR-1): a task that was
 * mid-flight is requeued when attempts remain (retry_count < max_retries),
 * else failed. Queued/terminal tasks are left alone.
 */
export function reconcileCrashedTask(task: {
	status: TaskStatus;
	retryCount: number;
	maxRetries: number;
}): ReconcileDecision {
	if (!isInFlight(task.status)) return { action: "keep" };
	return task.retryCount < task.maxRetries ? { action: "requeue" } : { action: "fail" };
}