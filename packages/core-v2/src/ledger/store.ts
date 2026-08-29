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

import { existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	ImmutableArtifactReferenceSchema,
	type ImmutableArtifactReference,
} from "../contracts/context-lifecycle.ts";
import { CapPolicyIdSchema } from "../contracts/continuation-record.ts";
import {
	compareRecoveryForPruning,
	isRecoveryExpired,
	type RecoveryBlocker,
	type RecoveryPhase,
	type RecoveryStatus,
} from "../contracts/recovery-status.ts";

export const LEDGER_SCHEMA_VERSION = 12;

/** Successful runs add zero additional inference: only non-completed / non-shipped
 * terminal outcomes retain recovery state. */
export function shouldPersistRecovery(taskStatus: string): boolean {
	return taskStatus !== "completed" && taskStatus !== "ship";
}

/** Delete a continuation body file if it exists; never touches canonical
 * receipts/traces. Returns true when a file was removed. */
function deleteContinuationBodyFile(storeRoot: string, recordId: string | null): boolean {
	if (recordId === null || !/^sha256:[a-f0-9]{64}$/.test(recordId)) return false;
	const target = join(resolve(storeRoot), recordId.slice("sha256:".length));
	try {
		unlinkSync(target);
		return true;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function deleteContinuationBodyAsync(
	store: { delete(id: string): Promise<boolean> } | undefined,
	storeRoot: string | undefined,
	recordId: string | null,
): Promise<boolean> {
	if (recordId === null) return false;
	if (store !== undefined) {
		try { return await store.delete(recordId); } catch { return false; }
	}
	if (storeRoot !== undefined) return deleteContinuationBodyFile(storeRoot, recordId);
	return false;
}

export type TaskStatus =
	| "queued"
	| "planning"
	| "executing"
	| "awaiting_child"
	| "preparing"
	| "awaiting_execution"
	| "resumable"
	| "delivery_pending"
	| "verifying"
	| "reviewing"
	| "completed"
	| "failed"
	| "escalated";
export type PlanMode = "prewalk" | "bundle" | "fork" | "cold";
export type SessionRole = "worker" | "reviewer";
export type SessionStatus = "active" | "yielded" | "exhausted" | "crashed";
export type WorkspaceStatus =
	| "provisioning"
	| "active"
	| "merging"
	| "cleaning_up"
	| "released"
	| "orphaned";

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

export type ChildEdgeStatus =
	| "preparing"
	| "ready"
	| "claimed"
	| "resumable"
	| "blocked"
	| "delivery_pending"
	| "completed"
	| "failed"
	| "escalated";
export type ChildTerminalStatus = "completed" | "failed" | "escalated";
export type ChildRelationship = "continuation";
export type WorkspaceContinuationStatus = ChildEdgeStatus;

export interface ChildPreparationRow {
	preparationId: string;
	edgeId: string;
	parentTaskId: string;
	childTaskId: string;
	driver: string;
	capabilityIdentity: string;
	capabilityVersion: string;
	status: "preparing" | "ready" | "resumable" | "blocked";
	workspaceId: string | null;
	createdAt: string;
	updatedAt: string;
}

/** Parent-owned reservation. This row intentionally does not foreign-key the
 * planned child: it is the boot-discoverable owner that exists before the
 * child task, its edge, or any immutable child artifact. */
export type ChildPreparationOwnershipStatus =
	| "parent_pending" | "parent_accepted" | "artifacts_pending"
	| "provider_preparing" | "ready" | "blocked";

export interface ChildPreparationOwnershipRow {
	preparationId: string;
	edgeId: string;
	parentTaskId: string;
	plannedChildTaskId: string;
	driver: string;
	capabilityIdentity: string;
	capabilityVersion: string;
	status: ChildPreparationOwnershipStatus;
	parentRevision: string | null;
	parentReceiptJson: string | null;
	/** Set before the parent executor is entered. A marked reservation is
	 * never replayed: a crash without acceptance evidence becomes blocked. */
	parentExecutionStartedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface ChildParentExecutionClaim {
	owner: ChildPreparationOwnershipRow;
	/** True only for the caller that installed the execution fence. */
	acquired: boolean;
}

export interface NewChildPreparationOwnership {
	preparationId: string;
	edgeId: string;
	parentTaskId: string;
	plannedChildTaskId: string;
	driver: string;
	capabilityIdentity: string;
	capabilityVersion: string;
}

export interface TaskArtifactReference {
	taskId: string;
	role: string;
	artifactId: string;
	mediaType: string;
	sourceRevision: string | null;
	/** Present for M5 records; absent is retained for legacy ledger rows. */
	reference?: ImmutableArtifactReference;
	createdAt: string;
}

export interface WorkspaceContinuationRow {
	id: string;
	taskId: string;
	driver: string;
	providerVersion: string;
	capabilityIdentity: string | null;
	capabilityVersion: string | null;
	opaqueToken: string;
	revision: string;
	status: WorkspaceContinuationStatus;
	createdAt: string;
	updatedAt: string;
}

export interface TaskEdgeRow {
	edgeId: string;
	parentTaskId: string;
	childTaskId: string | null;
	ordinal: number;
	relationship: ChildRelationship;
	status: ChildEdgeStatus;
	handoffArtifactId: string;
	checkpointArtifactId: string | null;
	workspaceContinuationId: string | null;
	createdAt: string;
	claimedAt: string | null;
	completedAt: string | null;
}

export interface NewTaskArtifactReference {
	role: string;
	artifactId: string;
	mediaType: string;
	sourceRevision?: string | null;
	reference?: ImmutableArtifactReference;
}

export interface NewWorkspaceContinuation {
	id: string;
	taskId: string;
	driver: string;
	/** Legacy name retained as the provider-declared capability version. */
	providerVersion?: string;
	capabilityIdentity?: string;
	capabilityVersion?: string;
	opaqueToken: string;
	revision: string;
	status?: WorkspaceContinuationStatus;
}

/** A resumable standalone-recovery row (ADR docs/adr/m5.5-linear-recovery.md
 * seam 1). Identities and references only — never bodies. The predecessor
 * links this run to its lineage; at most one successor may exist per row. */
export interface NewStandaloneRecovery {
	runId: string;
	taskId: string;
	specHash: string;
	predecessorRunId?: string | null;
	workspaceStateId: string;
	continuationRecordId: string;
	capPolicyId: string;
	expiresAt: string;
	engineVersion: string;
	workspaceCapabilityId: string;
}

/** All references and the ready edge are committed as one SQLite unit. */
export interface SequentialEdgeConfig {
	edgeId: string;
	handoffReference: ImmutableArtifactReference;
	checkpointReference: ImmutableArtifactReference;
	childSpecReference: ImmutableArtifactReference;
	planReference: ImmutableArtifactReference;
	ingressConfigReference: ImmutableArtifactReference;
	parentReceiptReference: ImmutableArtifactReference;
	modelIdentity: string;
	sourceRevision: string;
	capabilityIdentity: string;
	capabilityVersion: string;
}

export interface NewChildIntent {
	edgeId: string;
	parentTaskId: string;
	childTaskId: string;
	ordinal: number;
	relationship?: ChildRelationship;
	handoffArtifactId: string;
	checkpointArtifactId?: string | null;
	artifacts?: readonly NewTaskArtifactReference[];
	workspaceContinuation?: NewWorkspaceContinuation;
	/** Lossless ingress manifest for process-independent sequential resume. */
	sequentialConfig?: SequentialEdgeConfig;
	/** Durable owner created before any provider mutation. */
	preparationId?: string;
	preparationDriver?: string;
	preparationCapabilityIdentity?: string;
	preparationCapabilityVersion?: string;
	initialStatus?: "preparing" | "ready";
	/** Used only by the owner attach transaction; never creates an unowned task. */
	childGoal?: string;
}

export interface ChildSettlementArtifacts {
	verificationArtifactId?: string;
	resultArtifactId: string;
	receiptArtifactId: string;
	traceArtifactId: string;
	parentReceiptArtifactId?: string;
	parentTraceArtifactId?: string;
	failureArtifactId?: string | null;
	/** Complete references are supplied by the sequential terminal protocol.
	 * IDs remain accepted for the legacy ledger API. */
	verificationReference?: ImmutableArtifactReference;
	resultReference?: ImmutableArtifactReference;
	receiptReference?: ImmutableArtifactReference;
	traceReference?: ImmutableArtifactReference;
	parentReceiptReference?: ImmutableArtifactReference;
	parentTraceReference?: ImmutableArtifactReference;
}

/** Durable terminal outbox. Payloads are retained so a process can replay an
 * immutable write after closing and reopening, without rerunning the child. */
export type ChildDeliveryFailureCode =
	| "receipt_write_failed"
	| "trace_write_failed"
	| "final_receipt_rewrite_failed"
	| "process_lost_between_delivery_steps";

export interface ChildDeliveryState {
	receiptDelivered: boolean;
	traceDelivered: boolean;
	finalReceiptDelivered: boolean;
	failureCode: ChildDeliveryFailureCode | null;
	failureDetail: string | null;
}

export interface ChildTerminalSettlement {
	edgeId: string;
	childStatus: ChildTerminalStatus;
	verificationReference: ImmutableArtifactReference;
	resultReference: ImmutableArtifactReference;
	receiptReference: ImmutableArtifactReference;
	traceReference: ImmutableArtifactReference;
	parentReceiptReference: ImmutableArtifactReference;
	parentTraceReference: ImmutableArtifactReference;
	verification: unknown;
	result: unknown;
	receipt: unknown;
	trace: unknown;
	parentReceipt: unknown;
	parentTrace: unknown;
	state: "pending" | "linked";
	delivery: ChildDeliveryState;
}

export interface ChildRestartInput {
	status: ChildEdgeStatus;
	checkpointPresent: boolean;
	continuationPresent: boolean;
}

export type ChildRestartDecision = "ready" | "resumable" | "blocked" | "delivery_pending" | ChildTerminalStatus;

export type ChildReconciliationEvidenceCode =
	| "missing" | "corrupt" | "stale" | "revision_mismatch" | "incompatible";
export type ChildReconciliationDependency =
	| "handoff" | "checkpoint" | "plan" | "ingress-manifest" | "child-spec"
	| "parent-receipt" | "continuation-ownership" | "provider-capability"
	| "provider-target" | "validator";
export interface ChildReconciliationEvidenceRow {
	edgeId: string;
	code: ChildReconciliationEvidenceCode;
	dependency: ChildReconciliationDependency;
	createdAt: string;
}
export interface ChildBootFailureEvidence {
	edgeId: string;
	code: ChildReconciliationEvidenceCode;
	dependency: ChildReconciliationDependency;
}
export type ChildBootValidationResult =
	| { valid: true }
	| { valid: false; evidence: ChildBootFailureEvidence };

/** Pure restart policy: no session is started while making this decision. */
export function classifyChildRestart(input: ChildRestartInput): ChildRestartDecision {
	if (input.status === "ready" || input.status === "blocked" || input.status === "delivery_pending" ||
		input.status === "completed" || input.status === "failed" || input.status === "escalated")
		return input.status;
	return input.checkpointPresent && input.continuationPresent ? "resumable" : "blocked";
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
	sql?: string;
	apply?: (db: DatabaseSync) => void;
}

/** Additive migrations, oldest first. Every later migration must not
 *  conflict with earlier ones (the ledger is append-only in shape). */
const V2_DDL = `
CREATE TABLE IF NOT EXISTS workflow_approvals (
    dag_id TEXT PRIMARY KEY,
    approved INTEGER NOT NULL CHECK (approved IN (0, 1)),
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

/** M5 is additive: no existing table or column is altered. */
const V3_DDL = `
CREATE TABLE IF NOT EXISTS task_artifacts (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    media_type TEXT NOT NULL,
    source_revision TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(task_id, role, artifact_id),
    UNIQUE(task_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS workspace_continuations (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    driver TEXT NOT NULL,
    provider_version TEXT NOT NULL,
    opaque_token TEXT NOT NULL,
    revision TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN (
        'ready', 'claimed', 'resumable', 'blocked', 'completed', 'failed', 'escalated')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(task_id, id)
);

CREATE TABLE IF NOT EXISTS task_edges (
    edge_id TEXT PRIMARY KEY,
    parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    child_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    relationship TEXT NOT NULL CHECK (relationship IN ('continuation')),
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN (
        'ready', 'claimed', 'resumable', 'blocked', 'completed', 'failed', 'escalated')),
    handoff_artifact_id TEXT NOT NULL,
    checkpoint_artifact_id TEXT,
    workspace_continuation_id TEXT REFERENCES workspace_continuations(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    claimed_at DATETIME,
    completed_at DATETIME,
    UNIQUE(parent_task_id, ordinal),
    -- One child has one parent edge in the sequential MVP. NULL is retained
    -- for a pre-dispatch edge, while non-null child ids are unique.
    UNIQUE(child_task_id),
    -- A continuation token is owned by exactly the edge's child task.
    FOREIGN KEY (child_task_id, workspace_continuation_id)
      REFERENCES workspace_continuations(task_id, id)
);

CREATE INDEX IF NOT EXISTS task_edges_ready_idx
    ON task_edges(status, created_at);
CREATE INDEX IF NOT EXISTS task_edges_parent_idx
    ON task_edges(parent_task_id, ordinal);
CREATE INDEX IF NOT EXISTS task_edges_child_idx
    ON task_edges(child_task_id);
CREATE INDEX IF NOT EXISTS task_artifacts_task_idx
    ON task_artifacts(task_id, created_at);
`;

/** M5 ingress manifests retain complete artifact references and the
 * provider-declared capability identity. Existing rows remain readable. */
const V4_DDL = `
ALTER TABLE task_artifacts ADD COLUMN reference_json TEXT;
ALTER TABLE workspace_continuations ADD COLUMN capability_identity TEXT;
ALTER TABLE workspace_continuations ADD COLUMN capability_version TEXT;
CREATE TABLE IF NOT EXISTS sequential_edge_configs (
    edge_id TEXT PRIMARY KEY REFERENCES task_edges(edge_id) ON DELETE CASCADE,
    handoff_reference_json TEXT NOT NULL,
    checkpoint_reference_json TEXT NOT NULL,
    child_spec_reference_json TEXT NOT NULL,
    plan_reference_json TEXT NOT NULL,
    ingress_config_reference_json TEXT NOT NULL,
    parent_receipt_reference_json TEXT NOT NULL,
    model_identity TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    capability_identity TEXT NOT NULL,
    capability_version TEXT NOT NULL
);
`;

/** State overlays keep the original M1 tables backward compatible while
 * admitting the M5 composition states. */
const V5_DDL = `
CREATE TABLE IF NOT EXISTS task_status_overrides (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS task_edge_status_overrides (
    edge_id TEXT PRIMARY KEY REFERENCES task_edges(edge_id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS continuation_status_overrides (
    continuation_id TEXT PRIMARY KEY REFERENCES workspace_continuations(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS child_preparations (
    preparation_id TEXT PRIMARY KEY,
    edge_id TEXT NOT NULL UNIQUE REFERENCES task_edges(edge_id) ON DELETE CASCADE,
    parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    child_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    driver TEXT NOT NULL,
    capability_identity TEXT NOT NULL,
    capability_version TEXT NOT NULL,
    status TEXT NOT NULL,
    workspace_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS child_preparations_status_idx ON child_preparations(status, created_at);
`;

/** V6 makes the parent-to-child reservation independently discoverable.
 * The planned child id is deliberately not a task FK: the reservation must
 * survive a crash before child creation. */
const V6_DDL = `
CREATE TABLE IF NOT EXISTS child_preparation_ownership (
    preparation_id TEXT PRIMARY KEY,
    edge_id TEXT NOT NULL UNIQUE,
    parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    planned_child_task_id TEXT NOT NULL,
    driver TEXT NOT NULL,
    capability_identity TEXT NOT NULL,
    capability_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'parent_pending', 'parent_accepted', 'artifacts_pending',
        'provider_preparing', 'ready', 'blocked')),
    parent_revision TEXT,
    parent_receipt_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS child_preparation_ownership_status_idx
    ON child_preparation_ownership(status, created_at);
`;

/** V7 records entry into the parent executor. It is deliberately separate
 * from acceptance: if the process dies anywhere after execution starts and
 * before acceptance evidence is durable, recovery blocks rather than replaying
 * work whose provider-side outcome is unknown. */
const V7_DDL = `
ALTER TABLE child_preparation_ownership ADD COLUMN parent_execution_started_at DATETIME;
`;

/** Boot validity failures are durable evidence, not transient diagnostics. */
const V8_DDL = `
CREATE TABLE IF NOT EXISTS child_reconciliation_evidence (
    edge_id TEXT PRIMARY KEY REFERENCES task_edges(edge_id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    dependency TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

/** Terminal evidence is an outbox, not a second source of task truth. It
 * holds the canonical bytes until the single SQLite linkage transaction can
 * attach every reference and terminal state together. */
const V9_DDL = `
CREATE TABLE IF NOT EXISTS child_terminal_settlements (
    edge_id TEXT PRIMARY KEY REFERENCES task_edges(edge_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'linked')),
    child_status TEXT NOT NULL CHECK (child_status IN ('completed', 'failed', 'escalated')),
    verification_reference_json TEXT NOT NULL,
    result_reference_json TEXT NOT NULL,
    receipt_reference_json TEXT NOT NULL,
    trace_reference_json TEXT NOT NULL,
    parent_receipt_reference_json TEXT NOT NULL,
    parent_trace_reference_json TEXT NOT NULL,
    verification_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    trace_json TEXT NOT NULL,
    parent_receipt_json TEXT NOT NULL,
    parent_trace_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

/** External receipt/trace delivery is a durable phase after canonical linkage.
 * The three bits make close/reopen retry idempotent at every CLI boundary. */
const V10_DDL = `
ALTER TABLE child_terminal_settlements ADD COLUMN receipt_delivered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE child_terminal_settlements ADD COLUMN trace_delivered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE child_terminal_settlements ADD COLUMN final_receipt_delivered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE child_terminal_settlements ADD COLUMN delivery_failure_code TEXT;
ALTER TABLE child_terminal_settlements ADD COLUMN delivery_failure_detail TEXT;
`;

/** M5's hardened artifact upsert targets (task_id, artifact_id). Older M5
 * ledgers only had UNIQUE(task_id, role, artifact_id), so CREATE TABLE IF NOT
 * EXISTS could leave a warm ledger without the conflict target required by
 * insertTaskArtifact. This index is deliberately a separate additive
 * migration: it also repairs ledgers that already report every prior version
 * as applied but were created by that older shape. */
const TASK_ARTIFACT_IDENTITY_INDEX = "task_artifacts_task_artifact_v11_uidx";

/** Install the conflict target only when the historical table does not
 * already have an equivalent unique key. Checking columns, rather than only
 * the index name, makes this safe for a partially migrated ledger and avoids
 * an unnecessary duplicate index on a fresh database. */
function ensureTaskArtifactIdentityIndex(db: DatabaseSync): void {
	const indexes = db.prepare("PRAGMA index_list(task_artifacts)").all() as Array<{ name: string; unique: number }>;
	for (const index of indexes) {
		if (index.unique !== 1) continue;
		const quotedName = index.name.replaceAll('"', '""');
		const columns = db.prepare(`PRAGMA index_info("${quotedName}")`).all() as Array<{ seqno: number; name: string | null }>;
		if (columns.length === 2 && columns[0]?.name === "task_id" && columns[1]?.name === "artifact_id") return;
	}
	if (indexes.some((index) => index.name === TASK_ARTIFACT_IDENTITY_INDEX))
		throw new Error(`existing ${TASK_ARTIFACT_IDENTITY_INDEX} is not the required unique artifact identity index`);
	db.exec(`CREATE UNIQUE INDEX ${TASK_ARTIFACT_IDENTITY_INDEX} ON task_artifacts(task_id, artifact_id)`);
}

/** M5.5 standalone recovery ledger (ADR docs/adr/m5.5-linear-recovery.md).
 * Run/lifecycle identities and references only — never Pi message bodies,
 * tool bodies, transcripts, hidden reasoning, or opaque continuation bodies.
 * The status overlay keeps the base table additive for the later claim and
 * expiry/pruning seams (4b/4c). */
const V12_DDL = `
CREATE TABLE IF NOT EXISTS standalone_recovery (
    run_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    spec_hash TEXT NOT NULL,
    predecessor_run_id TEXT,
    successor_run_id TEXT,
    phase TEXT NOT NULL CHECK (phase IN (
        'failed', 'resumable', 'blocked', 'claimed', 'completed')),
    resume_allowed INTEGER NOT NULL CHECK (resume_allowed IN (0, 1)),
    blocked_reason TEXT CHECK (blocked_reason IN (
        'continuation_missing', 'corrupt', 'expired', 'incompatible',
        'over_budget', 'blocked')),
    workspace_state_id TEXT,
    continuation_record_id TEXT,
    cap_policy_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    engine_version TEXT NOT NULL,
    workspace_capability_id TEXT
);
CREATE TABLE IF NOT EXISTS standalone_recovery_status_overrides (
    run_id TEXT PRIMARY KEY REFERENCES standalone_recovery(run_id) ON DELETE CASCADE,
    phase TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS standalone_recovery_family_idx
    ON standalone_recovery(task_id, created_at);
`;

const MIGRATIONS: Migration[] = [
	{ version: 1, sql: V1_DDL },
	{ version: 2, sql: V2_DDL },
	{ version: 3, sql: V3_DDL },
	{ version: 4, sql: V4_DDL },
	{ version: 5, sql: V5_DDL },
	{ version: 6, sql: V6_DDL },
	{ version: 7, sql: V7_DDL },
	{ version: 8, sql: V8_DDL },
	{ version: 9, sql: V9_DDL },
	{ version: 10, sql: V10_DDL },
	{ version: 11, apply: ensureTaskArtifactIdentityIndex },
	{ version: 12, sql: V12_DDL },
];

function migrate(db: DatabaseSync): void {
	const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
	let current = row.user_version ?? 0;
	for (const migration of MIGRATIONS) {
		if (migration.version <= current) continue;
		// DDL migrations are transactional too: a failed statement cannot leave
		// a half-created child schema that the next boot mistakes for v3.
		db.exec("BEGIN");
		try {
			if (migration.apply !== undefined) migration.apply(db);
			else if (migration.sql !== undefined) db.exec(migration.sql);
			else throw new Error(`migration v${migration.version} has no implementation`);
			db.exec(`PRAGMA user_version = ${migration.version}`);
			db.exec("COMMIT");
			current = migration.version;
		} catch (error) {
			try { db.exec("ROLLBACK"); } catch { /* preserve migration error */ }
			throw error;
		}
	}
}

export class LedgerStore {
	readonly db: DatabaseSync;

	constructor(readonly path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA foreign_keys = ON");
		// Competing daemon processes wait only briefly. Claim callers map a
		// busy loser to null; other transactions surface the bounded failure.
		this.db.exec("PRAGMA busy_timeout = 250");
		// WAL: the daemon (and future parallel writers) get reader-friendly
		// snapshots instead of whole-db write locks.
		this.db.exec("PRAGMA journal_mode = WAL");
		try {
			migrate(this.db);
		} catch (error) {
			// Do not strand a connection when an additive migration rejects old
			// data (for example, duplicate artifact identities). The transaction
			// has already rolled back; closing here lets an operator repair or
			// inspect the durable ledger without a leaked writer handle.
			this.db.close();
			throw error;
		}
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
		const row = this.db.prepare("SELECT t.*, o.status AS override_status FROM tasks t LEFT JOIN task_status_overrides o ON o.task_id = t.id WHERE t.id = ?").get(id) as
			(Record<string, unknown> & { id: string }) | undefined;
		return row ? rowToTask(row) : null;
	}

	setTaskStatus(id: string, status: TaskStatus): void {
		const extended = new Set<TaskStatus>(["awaiting_child", "preparing", "awaiting_execution", "resumable", "delivery_pending"]);
		if (extended.has(status)) {
			this.db.prepare(`INSERT INTO task_status_overrides (task_id, status) VALUES (?, ?)
				ON CONFLICT(task_id) DO UPDATE SET status = excluded.status, updated_at = CURRENT_TIMESTAMP`).run(id, status);
			return;
		}
		this.db.prepare("DELETE FROM task_status_overrides WHERE task_id = ?").run(id);
		this.db.prepare("UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, id);
	}

	setTaskPlanMode(id: string, planMode: PlanMode): void {
		this.db
			.prepare(
				"UPDATE tasks SET plan_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
			)
			.run(planMode, id);
	}

	incrementRetry(id: string): void {
		this.db
			.prepare(
				"UPDATE tasks SET retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
			)
			.run(id);
	}

	listTasks(status?: TaskStatus): TaskRow[] {
		const rows = status
			? (this.db
					.prepare("SELECT t.*, o.status AS override_status FROM tasks t LEFT JOIN task_status_overrides o ON o.task_id = t.id WHERE COALESCE(o.status, t.status) = ?")
					.all(status) as Record<string, unknown>[])
			: (this.db.prepare("SELECT t.*, o.status AS override_status FROM tasks t LEFT JOIN task_status_overrides o ON o.task_id = t.id").all() as Record<
					string,
					unknown
				>[]);
		return rows.map(rowToTask);
	}

	// ─── micro_sessions ────────────────────────────────────────────────

	insertMicroSession(session: NewMicroSession): void {
		this.db
			.prepare(
				`INSERT INTO micro_sessions (id, task_id, role, status, turn_count, yield_payload)
					 VALUES (?, ?, ?, 'active', ?, ?)`,
			)
			.run(
				session.id,
				session.taskId,
				session.role,
				session.turnCount ?? 0,
				session.yieldPayload ?? null,
			);
	}

	getMicroSession(id: string): MicroSessionRow | null {
		const row = this.db
			.prepare("SELECT * FROM micro_sessions WHERE id = ?")
			.get(id) as (Record<string, unknown> & { id: string }) | undefined;
		return row ? rowToSession(row) : null;
	}

	setSessionStatus(
		id: string,
		status: SessionStatus,
		yieldPayload?: string | null,
	): void {
		if (yieldPayload !== undefined) {
			this.db
				.prepare(
					"UPDATE micro_sessions SET status = ?, yield_payload = ? WHERE id = ?",
				)
				.run(status, yieldPayload, id);
		} else {
			this.db
				.prepare("UPDATE micro_sessions SET status = ? WHERE id = ?")
				.run(status, id);
		}
	}

	heartbeat(id: string): void {
		this.db
			.prepare(
				"UPDATE micro_sessions SET last_heartbeat_at = CURRENT_TIMESTAMP WHERE id = ?",
			)
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
		this.db
			.prepare(
				"INSERT INTO routing_feedback (repo, mode, hit) VALUES (?, ?, ?)",
			)
			.run(repo, mode, hit);
	}

	/** Raw per-observation feedback rows for a repo, oldest first — the
	 *  router's aggregateRoutingFeedback consumes these directly (§5.4);
	 *  never feed aggregated counts back into the aggregator. */
	routingRows(
		repo: string,
	): Array<{ repo: string; mode: string; hit: number }> {
		const rows = this.db
			.prepare(
				"SELECT repo, mode, hit FROM routing_feedback WHERE repo = ? ORDER BY rowid",
			)
			.all(repo) as Array<{ repo: string; mode: string; hit: number }>;
		return rows.map((r) => ({
			repo: String(r.repo),
			mode: String(r.mode),
			hit: Number(r.hit),
		}));
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
		const row = this.db
			.prepare("SELECT * FROM workspaces WHERE id = ?")
			.get(id) as (Record<string, unknown> & { id: string }) | undefined;
		return row ? rowToWorkspace(row) : null;
	}

	setWorkspaceStatus(id: string, status: WorkspaceStatus): void {
		this.db
			.prepare(
				"UPDATE workspaces SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
			)
			.run(status, id);
	}

	listWorkspaces(taskId: string): WorkspaceRow[] {
		const rows = this.db
			.prepare("SELECT * FROM workspaces WHERE task_id = ?")
			.all(taskId) as Record<string, unknown>[];
		return rows.map(rowToWorkspace);
	}

	// ─── sequential child continuation (M5) ───────────────────────────

	private transaction<T>(work: () => T): T {
		let started = false;
		try {
			this.db.exec("BEGIN IMMEDIATE");
			started = true;
			const result = work();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			if (started) {
				try { this.db.exec("ROLLBACK"); } catch { /* preserve original */ }
			}
			throw error;
		}
	}

	private isBusy(error: unknown): boolean {
		return /SQLITE_BUSY|database is locked/i.test(error instanceof Error ? error.message : String(error));
	}

	private transactionForClaim<T>(work: () => T): T | null {
		try { return this.transaction(work); }
		catch (error) {
			if (this.isBusy(error)) return null;
			throw error;
		}
	}

	insertTaskArtifact(reference: NewTaskArtifactReference & { taskId: string }): void {
		if (reference.reference !== undefined) {
			const checked = ImmutableArtifactReferenceSchema.parse(reference.reference);
			if (checked.id !== reference.artifactId)
				throw new Error("artifact id does not match its complete reference");
		}
		this.db
			.prepare(
				`INSERT INTO task_artifacts
				 (task_id, role, artifact_id, media_type, source_revision, reference_json)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(task_id, artifact_id) DO UPDATE SET
				 role = excluded.role,
				 media_type = excluded.media_type,
				 source_revision = CASE WHEN excluded.reference_json IS NULL
					THEN task_artifacts.source_revision ELSE excluded.source_revision END,
				 reference_json = COALESCE(excluded.reference_json, task_artifacts.reference_json)`,
			)
			.run(
				reference.taskId,
				reference.role,
				reference.artifactId,
				reference.mediaType,
				reference.sourceRevision ?? null,
				reference.reference === undefined ? null : JSON.stringify(reference.reference),
			);
	}

	listTaskArtifacts(taskId: string): TaskArtifactReference[] {
		const rows = this.db
			.prepare(
				"SELECT task_id, role, artifact_id, media_type, source_revision, reference_json, created_at FROM task_artifacts WHERE task_id = ? ORDER BY rowid",
			)
			.all(taskId) as Record<string, unknown>[];
		return rows.map(rowToTaskArtifact);
	}

	insertWorkspaceContinuation(continuation: NewWorkspaceContinuation): void {
		const version = continuation.capabilityVersion ?? continuation.providerVersion;
		if (version === undefined || version.length === 0)
			throw new Error("workspace continuation capability version is required");
		this.db
			.prepare(
				`INSERT INTO workspace_continuations
				 (id, task_id, driver, provider_version, capability_identity,
				  capability_version, opaque_token, revision, status)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				continuation.id,
				continuation.taskId,
				continuation.driver,
				version,
				continuation.capabilityIdentity ?? null,
				version,
				continuation.opaqueToken,
				continuation.revision,
				continuation.status ?? "ready",
			);
	}

	getWorkspaceContinuation(id: string): WorkspaceContinuationRow | null {
		const row = this.db
			.prepare("SELECT c.*, o.status AS override_status FROM workspace_continuations c LEFT JOIN continuation_status_overrides o ON o.continuation_id = c.id WHERE c.id = ?")
			.get(id) as Record<string, unknown> | undefined;
		return row ? rowToWorkspaceContinuation(row) : null;
	}

	private insertSequentialEdgeConfig(config: SequentialEdgeConfig): void {
		for (const reference of [
			config.handoffReference, config.checkpointReference,
			config.childSpecReference, config.planReference,
			config.ingressConfigReference, config.parentReceiptReference,
		]) ImmutableArtifactReferenceSchema.parse(reference);
		this.db.prepare(
			`INSERT INTO sequential_edge_configs
			 (edge_id, handoff_reference_json, checkpoint_reference_json,
			  child_spec_reference_json, plan_reference_json,
			  ingress_config_reference_json, parent_receipt_reference_json,
			  model_identity, source_revision, capability_identity, capability_version)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			config.edgeId, JSON.stringify(config.handoffReference),
			JSON.stringify(config.checkpointReference), JSON.stringify(config.childSpecReference),
			JSON.stringify(config.planReference), JSON.stringify(config.ingressConfigReference),
			JSON.stringify(config.parentReceiptReference), config.modelIdentity,
			config.sourceRevision, config.capabilityIdentity, config.capabilityVersion,
		);
	}

	/** Round-trip the complete immutable ingress manifest. */
	persistSequentialEdgeConfig(config: SequentialEdgeConfig): void {
		this.transaction(() => this.insertSequentialEdgeConfig(config));
	}

	getSequentialEdgeConfig(edgeId: string): SequentialEdgeConfig | null {
		const row = this.db.prepare(
			"SELECT * FROM sequential_edge_configs WHERE edge_id = ?",
		).get(edgeId) as Record<string, unknown> | undefined;
		if (!row) return null;
		const ref = (name: string): ImmutableArtifactReference =>
			ImmutableArtifactReferenceSchema.parse(JSON.parse(String(row[name])));
		return {
			edgeId: String(row.edge_id),
			handoffReference: ref("handoff_reference_json"),
			checkpointReference: ref("checkpoint_reference_json"),
			childSpecReference: ref("child_spec_reference_json"),
			planReference: ref("plan_reference_json"),
			ingressConfigReference: ref("ingress_config_reference_json"),
			parentReceiptReference: ref("parent_receipt_reference_json"),
			modelIdentity: String(row.model_identity), sourceRevision: String(row.source_revision),
			capabilityIdentity: String(row.capability_identity), capabilityVersion: String(row.capability_version),
		};
	}

	/** Reserve parent ownership before any child row or immutable child bytes
	 * exist. INSERT OR IGNORE makes the reservation safe to repeat after a
	 * close/reopen; a conflicting identity is rejected rather than forked. */
	persistChildPreparationOwner(owner: NewChildPreparationOwnership): ChildPreparationOwnershipRow {
		return this.transaction(() => {
			if (!this.getTask(owner.parentTaskId)) throw new Error("parent task does not exist");
			const existing = this.getChildPreparationOwnership(owner.preparationId);
			if (existing !== null) {
				if (existing.edgeId !== owner.edgeId || existing.parentTaskId !== owner.parentTaskId ||
					existing.plannedChildTaskId !== owner.plannedChildTaskId || existing.driver !== owner.driver ||
					existing.capabilityIdentity !== owner.capabilityIdentity || existing.capabilityVersion !== owner.capabilityVersion)
					throw new Error("child preparation owner identity conflicts with durable reservation");
				return existing;
			}
			const byEdge = this.db.prepare("SELECT preparation_id FROM child_preparation_ownership WHERE edge_id = ?").get(owner.edgeId);
			if (byEdge !== undefined) throw new Error("child preparation edge already has an owner");
			this.db.prepare(`INSERT INTO child_preparation_ownership
				(preparation_id, edge_id, parent_task_id, planned_child_task_id, driver,
				 capability_identity, capability_version, status)
				VALUES (?, ?, ?, ?, ?, ?, ?, 'parent_pending')`).run(
				owner.preparationId, owner.edgeId, owner.parentTaskId, owner.plannedChildTaskId,
				owner.driver, owner.capabilityIdentity, owner.capabilityVersion,
			);
			this.setTaskStatus(owner.parentTaskId, "preparing");
			return this.getChildPreparationOwnership(owner.preparationId)!;
		});
	}

	getChildPreparationOwnership(preparationId: string): ChildPreparationOwnershipRow | null {
		const row = this.db.prepare("SELECT * FROM child_preparation_ownership WHERE preparation_id = ?").get(preparationId) as Record<string, unknown> | undefined;
		return row ? rowToChildPreparationOwnership(row) : null;
	}

	getChildPreparationOwnershipByEdge(edgeId: string): ChildPreparationOwnershipRow | null {
		const row = this.db.prepare("SELECT * FROM child_preparation_ownership WHERE edge_id = ?").get(edgeId) as Record<string, unknown> | undefined;
		return row ? rowToChildPreparationOwnership(row) : null;
	}

	/** Find the one active sequential reservation for a CLI task family. A
	 * terminal edge is intentionally excluded so a fresh standalone submission
	 * still gets ordinary retry semantics. */
	getActiveChildPreparationOwnershipByParent(parentTaskId: string): ChildPreparationOwnershipRow | null {
		const row = this.db.prepare(`SELECT o.*
			FROM child_preparation_ownership o
			LEFT JOIN task_edges e ON e.edge_id = o.edge_id
			WHERE o.parent_task_id = ?
			AND (o.status IN ('parent_pending', 'parent_accepted', 'artifacts_pending', 'provider_preparing', 'ready')
				OR (o.status = 'blocked' AND o.parent_execution_started_at IS NOT NULL))
			AND (e.edge_id IS NULL OR COALESCE((SELECT status FROM task_edge_status_overrides WHERE edge_id = e.edge_id), e.status)
				IN ('preparing', 'ready', 'claimed', 'resumable', 'delivery_pending'))
			ORDER BY o.created_at, o.rowid LIMIT 1`).get(parentTaskId) as Record<string, unknown> | undefined;
		return row ? rowToChildPreparationOwnership(row) : null;
	}

	/** Mark the parent execution boundary before entering the provider. This
	 * marker is the conservative crash fence: an unacknowledged execution is
	 * never replayed, because its provider-side acceptance cannot be inferred. */
	beginChildParentExecution(preparationId: string): ChildParentExecutionClaim {
		return this.transaction(() => {
			const owner = this.getChildPreparationOwnership(preparationId);
			if (!owner) throw new Error("child preparation owner does not exist");
			if (owner.status !== "parent_pending" || owner.parentExecutionStartedAt !== null)
				return { owner, acquired: false };
			const result = this.db.prepare("UPDATE child_preparation_ownership SET parent_execution_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE preparation_id = ? AND parent_execution_started_at IS NULL AND status = 'parent_pending'").run(preparationId);
			return { owner: this.getChildPreparationOwnership(preparationId)!, acquired: Number((result as { changes?: number | bigint }).changes ?? 0) === 1 };
		});
	}

	/** Record acceptance separately from child preparation. A parent receipt is
	 * kept in the ledger until its immutable artifact reference is attached, so
	 * recovery never has to rerun the accepted parent. */
	recordChildParentAcceptance(preparationId: string, parentReceiptJson: string, parentRevision: string): ChildPreparationOwnershipRow {
		return this.transaction(() => {
			if (!parentReceiptJson || !parentRevision) throw new Error("parent acceptance requires receipt and revision");
			const owner = this.getChildPreparationOwnership(preparationId);
			if (!owner) throw new Error("child preparation owner does not exist");
			if (owner.status === "parent_accepted" || owner.status === "artifacts_pending" || owner.status === "provider_preparing" || owner.status === "ready") {
				if (owner.parentReceiptJson !== parentReceiptJson || owner.parentRevision !== parentRevision)
					throw new Error("parent acceptance conflicts with durable acceptance");
				return owner;
			}
			if (owner.status !== "parent_pending") throw new Error("child preparation is not awaiting parent acceptance");
			this.db.prepare("UPDATE child_preparation_ownership SET status = 'parent_accepted', parent_receipt_json = ?, parent_revision = ?, updated_at = CURRENT_TIMESTAMP WHERE preparation_id = ? AND status = 'parent_pending'").run(parentReceiptJson, parentRevision, preparationId);
			this.setTaskStatus(owner.parentTaskId, "awaiting_child");
			return this.getChildPreparationOwnership(preparationId)!;
		});
	}

	/** Mark the external immutable-write boundary before writing bytes. */
	beginChildArtifactPersistence(preparationId: string): ChildPreparationOwnershipRow {
		return this.transaction(() => {
			const owner = this.getChildPreparationOwnership(preparationId);
			if (!owner) throw new Error("child preparation owner does not exist");
			if (owner.status === "parent_accepted")
				this.db.prepare("UPDATE child_preparation_ownership SET status = 'artifacts_pending', updated_at = CURRENT_TIMESTAMP WHERE preparation_id = ?").run(preparationId);
			else if (!["artifacts_pending", "provider_preparing", "ready"].includes(owner.status))
				throw new Error("child artifacts cannot be started from the current preparation state");
			return this.getChildPreparationOwnership(preparationId)!;
		});
	}

	private setPreparationOwnerStatus(preparationId: string, status: ChildPreparationOwnershipStatus): void {
		this.db.prepare("UPDATE child_preparation_ownership SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE preparation_id = ?").run(status, preparationId);
	}

	blockChildPreparation(preparationId: string): ChildPreparationOwnershipRow {
		return this.transaction(() => {
			const owner = this.getChildPreparationOwnership(preparationId);
			if (!owner) throw new Error("child preparation owner does not exist");
			this.setPreparationOwnerStatus(preparationId, "blocked");
			this.setTaskStatus(owner.parentTaskId, "failed");
			return this.getChildPreparationOwnership(preparationId)!;
		});
	}

	private requireChildPreparationOwner(
		preparationId: string,
		intent: Pick<NewChildIntent, "edgeId" | "parentTaskId" | "childTaskId">,
		provider?: { driver: string; capabilityIdentity: string; capabilityVersion: string },
	): ChildPreparationOwnershipRow {
		const owner = this.getChildPreparationOwnership(preparationId);
		if (!owner || owner.edgeId !== intent.edgeId || owner.parentTaskId !== intent.parentTaskId ||
			owner.plannedChildTaskId !== intent.childTaskId ||
			(provider !== undefined && (owner.driver !== provider.driver ||
				owner.capabilityIdentity !== provider.capabilityIdentity ||
				owner.capabilityVersion !== provider.capabilityVersion)))
			throw new Error("child preparation owner does not match intent");
		return owner;
	}

	/** Unsupported providers still get an atomic child/edge attachment before
	 * the edge is blocked; no child task can escape without its ownership edge. */
	persistBlockedChildIntent(intent: NewChildIntent & { preparationId: string; childGoal: string }): TaskEdgeRow {
		return this.transaction(() => {
			this.requireChildPreparationOwner(intent.preparationId, intent);
			if (!this.getTask(intent.childTaskId)) this.insertTask({ id: intent.childTaskId, goal: intent.childGoal });
			const edge = this.persistReadyChildIntentInTransaction(intent);
			this.setPreparationOwnerStatus(intent.preparationId, "blocked");
			return edge;
		});
	}

	/** Persist the child task, edge, and references as one attach transaction. */
	persistReadyChildIntent(intent: NewChildIntent): TaskEdgeRow {
		return this.transaction(() => this.persistReadyChildIntentInTransaction(intent));
	}

	private persistReadyChildIntentInTransaction(intent: NewChildIntent): TaskEdgeRow {
			const relationship = intent.relationship ?? "continuation";
			if (intent.ordinal <= 0 || !Number.isInteger(intent.ordinal))
				throw new Error("child ordinal must be a positive integer");
			requireArtifactIdentity(intent.handoffArtifactId, "handoff artifact");
			if (intent.checkpointArtifactId !== undefined && intent.checkpointArtifactId !== null)
				requireArtifactIdentity(intent.checkpointArtifactId, "checkpoint artifact");
			if (!this.getTask(intent.parentTaskId))
				throw new Error("parent task does not exist");
			if (!this.getTask(intent.childTaskId))
				throw new Error("child task does not exist");
			if (
				intent.workspaceContinuation !== undefined &&
				intent.workspaceContinuation.taskId !== intent.childTaskId
			)
				throw new Error("workspace continuation belongs to a different task");
			if (intent.sequentialConfig !== undefined) {
				if (intent.sequentialConfig.edgeId !== intent.edgeId ||
					intent.sequentialConfig.handoffReference.id !== intent.handoffArtifactId ||
					(intent.checkpointArtifactId ?? null) !== intent.sequentialConfig.checkpointReference.id)
					throw new Error("sequential config references do not match child intent");
			}

			if (intent.workspaceContinuation !== undefined)
				this.insertWorkspaceContinuation({
					...intent.workspaceContinuation,
					status: "ready",
				});

			const references: NewTaskArtifactReference[] = [
				{
					role: "handoff",
					artifactId: intent.handoffArtifactId,
					mediaType: "application/json",
					...(intent.sequentialConfig === undefined ? {} : { reference: intent.sequentialConfig.handoffReference }),
				},
			];
			if (intent.checkpointArtifactId !== undefined && intent.checkpointArtifactId !== null)
				references.push({
					role: "checkpoint",
					artifactId: intent.checkpointArtifactId,
					mediaType: "application/json",
					...(intent.sequentialConfig === undefined ? {} : { reference: intent.sequentialConfig.checkpointReference }),
				});
			if (intent.artifacts !== undefined) references.push(...intent.artifacts);
			if (intent.sequentialConfig !== undefined) {
				const config = intent.sequentialConfig;
				for (const [role, reference] of [
					["plan", config.planReference], ["child-spec", config.childSpecReference],
					["ingress-config", config.ingressConfigReference], ["parent-receipt", config.parentReceiptReference],
				] as const)
					references.push({ role, artifactId: reference.id, mediaType: reference.mediaType, reference });
			}
			const seen = new Set<string>();
			for (const reference of references) {
				requireArtifactIdentity(reference.artifactId, `${reference.role} artifact`);
				if (reference.reference === undefined && reference.sourceRevision !== undefined && reference.sourceRevision !== null)
					requireArtifactIdentity(reference.sourceRevision, "artifact source revision");
				const key = `${intent.childTaskId}\u0000${reference.role}\u0000${reference.artifactId}`;
				if (seen.has(key)) continue;
				seen.add(key);
				this.insertTaskArtifact({ ...reference, taskId: intent.childTaskId });
			}

			this.db
				.prepare(
					`INSERT INTO task_edges
					 (edge_id, parent_task_id, child_task_id, ordinal, relationship, status,
					  handoff_artifact_id, checkpoint_artifact_id, workspace_continuation_id)
					 VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
				)
				.run(
					intent.edgeId,
					intent.parentTaskId,
					intent.childTaskId,
					intent.ordinal,
					relationship,
					intent.handoffArtifactId,
					intent.checkpointArtifactId ?? null,
					intent.workspaceContinuation?.id ?? null,
				);
			if (intent.sequentialConfig !== undefined) {
				if (intent.sequentialConfig.edgeId !== intent.edgeId)
					throw new Error("sequential config belongs to a different edge");
				this.insertSequentialEdgeConfig(intent.sequentialConfig);
			}
			if (intent.initialStatus === "preparing") {
				if (!intent.preparationId || !intent.preparationDriver || !intent.preparationCapabilityIdentity || !intent.preparationCapabilityVersion)
					throw new Error("preparing child intent requires a provider preparation identity");
				this.db.prepare("INSERT INTO child_preparations (preparation_id, edge_id, parent_task_id, child_task_id, driver, capability_identity, capability_version, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing')").run(intent.preparationId, intent.edgeId, intent.parentTaskId, intent.childTaskId, intent.preparationDriver, intent.preparationCapabilityIdentity, intent.preparationCapabilityVersion);
				this.db.prepare("INSERT INTO task_edge_status_overrides (edge_id, status) VALUES (?, 'preparing')").run(intent.edgeId);
				this.setTaskStatus(intent.parentTaskId, "awaiting_child");
				this.setTaskStatus(intent.childTaskId, "preparing");
			}
			return this.getTaskEdge(intent.edgeId)!;
	}

	/** Attach a planned child only after the parent owner exists. The child
	 * insert, edge, references, and provider-preparing state share one unit. */
	persistPreparingChildIntent(intent: NewChildIntent & {
		preparationId: string;
		preparationDriver: string;
		preparationCapabilityIdentity: string;
		preparationCapabilityVersion: string;
		sequentialConfig: SequentialEdgeConfig;
		childGoal?: string;
	}): TaskEdgeRow {
		return this.transaction(() => {
			const owner = this.requireChildPreparationOwner(intent.preparationId, intent, {
				driver: intent.preparationDriver,
				capabilityIdentity: intent.preparationCapabilityIdentity,
				capabilityVersion: intent.preparationCapabilityVersion,
			});
			if (["provider_preparing", "ready"].includes(owner.status)) {
				const existing = this.getTaskEdge(intent.edgeId);
				if (existing) return existing;
			}
			if (!["artifacts_pending", "parent_accepted"].includes(owner.status))
				throw new Error("child intent cannot be attached from the current preparation state");
			if (!this.getTask(intent.childTaskId))
				this.insertTask({ id: intent.childTaskId, goal: intent.childGoal ?? "continuation child" });
			const edge = this.persistReadyChildIntentInTransaction({ ...intent, initialStatus: "preparing" });
			this.setPreparationOwnerStatus(intent.preparationId, "provider_preparing");
			return edge;
		});
	}

	/** Commit provider facts and the complete immutable ingress atomically. */
	completeChildPreparation(
		edgeId: string,
		workspace: { id: string; taskId: string; driver: string; hostPath: string; branchName: string; containerPath?: string | null },
		continuation: NewWorkspaceContinuation,
		config: SequentialEdgeConfig,
	): TaskEdgeRow {
		return this.transaction(() => {
			const edge = this.getTaskEdge(edgeId);
			if (!edge) throw new Error("child edge is not preparing");
			const owner = this.getChildPreparationOwnershipByEdge(edgeId);
			if (edge.status === "ready" && owner?.status === "ready") return edge;
			if (edge.status !== "preparing") throw new Error("child edge is not preparing");
			if (config.edgeId !== edgeId || continuation.taskId !== edge.childTaskId || workspace.taskId !== edge.childTaskId)
				throw new Error("provider preparation identity does not match edge");
			const existingWorkspace = this.getWorkspace(workspace.id);
			if (existingWorkspace !== null && (existingWorkspace.taskId !== workspace.taskId || existingWorkspace.driver !== workspace.driver || existingWorkspace.hostPath !== workspace.hostPath || existingWorkspace.containerPath !== (workspace.containerPath ?? null) || existingWorkspace.branchName !== workspace.branchName))
				throw new Error("provider workspace identity conflicts with durable preparation");
			if (existingWorkspace === null)
				this.db.prepare("INSERT INTO workspaces (id, task_id, driver, host_path, container_path, branch_name, status) VALUES (?, ?, ?, ?, ?, ?, 'active')").run(workspace.id, workspace.taskId, workspace.driver, workspace.hostPath, workspace.containerPath ?? null, workspace.branchName);
			else
				this.db.prepare("UPDATE workspaces SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(workspace.id);
			const continuationVersion = continuation.capabilityVersion ?? continuation.providerVersion;
			if (continuationVersion === undefined) throw new Error("provider preparation has no capability version");
			const existingContinuation = this.getWorkspaceContinuation(continuation.id);
			if (existingContinuation !== null && (existingContinuation.taskId !== continuation.taskId || existingContinuation.driver !== continuation.driver || existingContinuation.capabilityIdentity !== (continuation.capabilityIdentity ?? null) || existingContinuation.capabilityVersion !== continuationVersion || existingContinuation.opaqueToken !== continuation.opaqueToken || existingContinuation.revision !== continuation.revision))
				throw new Error("provider continuation identity conflicts with durable preparation");
			if (existingContinuation === null)
				this.db.prepare(`INSERT INTO workspace_continuations
					(id, task_id, driver, provider_version, capability_identity,
					 capability_version, opaque_token, revision, status)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready')`).run(
					continuation.id, continuation.taskId, continuation.driver,
					continuationVersion,
					continuation.capabilityIdentity ?? null, continuationVersion,
					continuation.opaqueToken, continuation.revision,
					);
			else
				this.db.prepare("UPDATE workspace_continuations SET status = 'ready', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(continuation.id);
			this.db.prepare("UPDATE task_edges SET workspace_continuation_id = ?, handoff_artifact_id = ?, checkpoint_artifact_id = ? WHERE edge_id = ?").run(continuation.id, config.handoffReference.id, config.checkpointReference.id, edgeId);
			this.db.prepare("DELETE FROM task_edge_status_overrides WHERE edge_id = ?").run(edgeId);
			this.db.prepare("UPDATE child_preparations SET status = 'ready', workspace_id = ?, updated_at = CURRENT_TIMESTAMP WHERE edge_id = ?").run(workspace.id, edgeId);
			this.db.prepare("UPDATE child_preparation_ownership SET status = 'ready', updated_at = CURRENT_TIMESTAMP WHERE edge_id = ?").run(edgeId);
			this.replaceSequentialEdgeConfig(config);
			for (const [role, ref] of [["handoff", config.handoffReference], ["checkpoint", config.checkpointReference], ["plan", config.planReference], ["child-spec", config.childSpecReference], ["ingress-config", config.ingressConfigReference], ["parent-receipt", config.parentReceiptReference]] as const)
				this.insertTaskArtifact({ taskId: edge.childTaskId!, role, artifactId: ref.id, mediaType: ref.mediaType, reference: ref });
			this.setTaskStatus(edge.parentTaskId, "awaiting_child");
			this.setTaskStatus(edge.childTaskId!, "awaiting_execution");
			return this.getTaskEdge(edgeId)!;
		});
	}

	/** Refresh a claimed child at its actual provider revision. */
	updateResumableChild(
		edgeId: string,
		continuation: NewWorkspaceContinuation,
		config: SequentialEdgeConfig,
	): TaskEdgeRow {
		return this.transaction(() => {
			const edge = this.getTaskEdge(edgeId);
			if (!edge || !["claimed", "resumable"].includes(edge.status)) throw new Error("child edge is not recoverable");
			if (config.edgeId !== edgeId || continuation.taskId !== edge.childTaskId ||
				edge.workspaceContinuationId !== continuation.id)
				throw new Error("resumable continuation is not owned by the child edge");
			const version = continuation.capabilityVersion ?? continuation.providerVersion;
			if (version === undefined) throw new Error("resumable continuation requires a provider version");
			if (continuation.capabilityIdentity === undefined || continuation.capabilityIdentity.length === 0)
				throw new Error("resumable continuation requires a capability identity");
			if (config.capabilityIdentity !== continuation.capabilityIdentity || config.capabilityVersion !== version)
				throw new Error("resumable continuation capability does not match ingress");
			for (const reference of [config.handoffReference, config.checkpointReference, config.childSpecReference, config.planReference, config.ingressConfigReference, config.parentReceiptReference])
				if (reference.sourceRevision !== config.sourceRevision)
					throw new Error("resumable ingress references do not share a source revision");
			const continuationResult = this.db.prepare("UPDATE workspace_continuations SET driver = ?, provider_version = ?, capability_identity = ?, capability_version = ?, opaque_token = ?, revision = ?, status = 'resumable', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND task_id = ?").run(continuation.driver, version, continuation.capabilityIdentity, version, continuation.opaqueToken, continuation.revision, continuation.id, edge.childTaskId);
			if (Number((continuationResult as { changes?: number | bigint }).changes ?? 0) !== 1)
				throw new Error("resumable continuation does not belong to the child edge");
			this.db.prepare("INSERT INTO continuation_status_overrides (continuation_id, status) VALUES (?, 'resumable') ON CONFLICT(continuation_id) DO UPDATE SET status = 'resumable', updated_at = CURRENT_TIMESTAMP").run(continuation.id);
			this.db.prepare("UPDATE task_edges SET handoff_artifact_id = ?, checkpoint_artifact_id = ? WHERE edge_id = ?").run(config.handoffReference.id, config.checkpointReference.id, edgeId);
			this.db.prepare("INSERT INTO task_edge_status_overrides (edge_id, status) VALUES (?, 'resumable') ON CONFLICT(edge_id) DO UPDATE SET status = 'resumable', updated_at = CURRENT_TIMESTAMP").run(edgeId);
			this.replaceSequentialEdgeConfig(config);
			for (const [role, ref] of [["handoff", config.handoffReference], ["checkpoint", config.checkpointReference], ["plan", config.planReference], ["child-spec", config.childSpecReference], ["ingress-config", config.ingressConfigReference], ["parent-receipt", config.parentReceiptReference]] as const)
				this.insertTaskArtifact({ taskId: edge.childTaskId!, role, artifactId: ref.id, mediaType: ref.mediaType, reference: ref });
			this.setTaskStatus(edge.childTaskId!, "resumable");
			this.setTaskStatus(edge.parentTaskId, "awaiting_child");
			return this.getTaskEdge(edgeId)!;
		});
	}

	getChildPreparation(edgeId: string): ChildPreparationRow | null {
		const row = this.db.prepare("SELECT * FROM child_preparations WHERE edge_id = ?").get(edgeId) as Record<string, unknown> | undefined;
		if (!row) return null;
		return { preparationId: String(row.preparation_id), edgeId: String(row.edge_id), parentTaskId: String(row.parent_task_id), childTaskId: String(row.child_task_id), driver: String(row.driver), capabilityIdentity: String(row.capability_identity), capabilityVersion: String(row.capability_version), status: row.status as ChildPreparationRow["status"], workspaceId: row.workspace_id === null ? null : String(row.workspace_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
	}

	private replaceSequentialEdgeConfig(config: SequentialEdgeConfig): void {
		this.db.prepare("DELETE FROM sequential_edge_configs WHERE edge_id = ?").run(config.edgeId);
		this.insertSequentialEdgeConfig(config);
	}

	/** Active edges are exposed for boot validation; no provider facts are
	 * inferred from rows in this query. */
	listRecoverableChildEdges(includeReady = false): TaskEdgeRow[] {
		const rows = this.db.prepare(
			`SELECT e.*, o.status AS override_status
			 FROM task_edges e
			 LEFT JOIN task_edge_status_overrides o ON o.edge_id = e.edge_id
			 WHERE COALESCE(o.status, e.status) IN ('claimed', 'resumable')
			    OR (? = 1 AND COALESCE(o.status, e.status) = 'ready' AND EXISTS (
					SELECT 1 FROM sequential_edge_configs c WHERE c.edge_id = e.edge_id
				))
			 ORDER BY e.created_at, e.rowid`,
		).all(includeReady ? 1 : 0) as Record<string, unknown>[];
		return rows.map(rowToTaskEdge);
	}

	getChildReconciliationEvidence(edgeId: string): ChildReconciliationEvidenceRow | null {
		const row = this.db.prepare("SELECT * FROM child_reconciliation_evidence WHERE edge_id = ?").get(edgeId) as Record<string, unknown> | undefined;
		if (!row) return null;
		return { edgeId: String(row.edge_id), code: row.code as ChildReconciliationEvidenceCode, dependency: row.dependency as ChildReconciliationDependency, createdAt: String(row.created_at) };
	}

	private persistChildReconciliationEvidence(edgeId: string, evidence: ChildBootFailureEvidence): void {
		this.db.prepare(`INSERT INTO child_reconciliation_evidence (edge_id, code, dependency)
			VALUES (?, ?, ?) ON CONFLICT(edge_id) DO UPDATE SET code = excluded.code, dependency = excluded.dependency`).run(edgeId, evidence.code, evidence.dependency);
	}

	getTaskEdge(edgeId: string): TaskEdgeRow | null {
		const row = this.db
			.prepare("SELECT e.*, o.status AS override_status FROM task_edges e LEFT JOIN task_edge_status_overrides o ON o.edge_id = e.edge_id WHERE e.edge_id = ?")
			.get(edgeId) as Record<string, unknown> | undefined;
		return row ? rowToTaskEdge(row) : null;
	}

	listChildEdges(parentTaskId: string): TaskEdgeRow[] {
		const rows = this.db
			.prepare("SELECT e.*, o.status AS override_status FROM task_edges e LEFT JOIN task_edge_status_overrides o ON o.edge_id = e.edge_id WHERE e.parent_task_id = ? ORDER BY e.ordinal")
			.all(parentTaskId) as Record<string, unknown>[];
		return rows.map(rowToTaskEdge);
	}

	getParentEdge(childTaskId: string): TaskEdgeRow | null {
		const row = this.db
			.prepare(
				"SELECT e.*, o.status AS override_status FROM task_edges e LEFT JOIN task_edge_status_overrides o ON o.edge_id = e.edge_id WHERE e.child_task_id = ?", 
			)
			.get(childTaskId) as Record<string, unknown> | undefined;
		return row ? rowToTaskEdge(row) : null;
	}

	getParentTask(childTaskId: string): TaskRow | null {
		const edge = this.getParentEdge(childTaskId);
		return edge ? this.getTask(edge.parentTaskId) : null;
	}

	findResumableChild(parentTaskId?: string): TaskEdgeRow | null {
		const row = parentTaskId === undefined
			? this.db
					.prepare("SELECT e.*, o.status AS override_status FROM task_edges e LEFT JOIN task_edge_status_overrides o ON o.edge_id = e.edge_id WHERE COALESCE(o.status, e.status) = 'resumable' ORDER BY e.created_at, e.rowid LIMIT 1")
					.get()
			: this.db
					.prepare("SELECT e.*, o.status AS override_status FROM task_edges e LEFT JOIN task_edge_status_overrides o ON o.edge_id = e.edge_id WHERE e.parent_task_id = ? AND COALESCE(o.status, e.status) = 'resumable' ORDER BY e.ordinal LIMIT 1")
					.get(parentTaskId);
		return row ? rowToTaskEdge(row as Record<string, unknown>) : null;
	}

	listResumableChildren(parentTaskId?: string): TaskEdgeRow[] {
		const rows = parentTaskId === undefined
			? this.db
					.prepare("SELECT e.*, o.status AS override_status FROM task_edges e LEFT JOIN task_edge_status_overrides o ON o.edge_id = e.edge_id WHERE COALESCE(o.status, e.status) = 'resumable' ORDER BY e.created_at, e.rowid")
					.all()
			: this.db
					.prepare("SELECT e.*, o.status AS override_status FROM task_edges e LEFT JOIN task_edge_status_overrides o ON o.edge_id = e.edge_id WHERE e.parent_task_id = ? AND COALESCE(o.status, e.status) = 'resumable' ORDER BY e.ordinal")
					.all(parentTaskId);
		return (rows as Record<string, unknown>[]).map(rowToTaskEdge);
	}

	/** Atomically claim a ready edge. The conditional UPDATE is the ownership
	 * decision; a busy or affected-row-zero loser receives null. */
	claimReadyChild(edgeId: string): TaskEdgeRow | null;
	claimReadyChild(parentTaskId: string, ordinal: number): TaskEdgeRow | null;
	claimReadyChild(edgeOrParent: string, ordinal?: number): TaskEdgeRow | null {
		return this.transactionForClaim(() => {
			const statement = ordinal === undefined
				? this.db.prepare("UPDATE task_edges SET status = 'claimed', claimed_at = CURRENT_TIMESTAMP WHERE edge_id = ? AND COALESCE((SELECT status FROM task_edge_status_overrides WHERE edge_id = task_edges.edge_id), status) = 'ready'")
				: this.db.prepare("UPDATE task_edges SET status = 'claimed', claimed_at = CURRENT_TIMESTAMP WHERE parent_task_id = ? AND ordinal = ? AND COALESCE((SELECT status FROM task_edge_status_overrides WHERE edge_id = task_edges.edge_id), status) = 'ready'");
		const result = ordinal === undefined
				? statement.run(edgeOrParent)
				: statement.run(edgeOrParent, ordinal);
			if (Number((result as { changes?: number | bigint }).changes ?? 0) !== 1) return null;
			const claimedEdge = ordinal === undefined
				? this.getTaskEdge(edgeOrParent)
				: (() => {
						const found = this.db.prepare("SELECT * FROM task_edges WHERE parent_task_id = ? AND ordinal = ?").get(edgeOrParent, ordinal) as Record<string, unknown> | undefined;
						return found ? rowToTaskEdge(found) : null;
				  })();
			this.db.prepare("DELETE FROM task_edge_status_overrides WHERE edge_id = ?").run(claimedEdge?.edgeId ?? edgeOrParent);
			if (claimedEdge?.workspaceContinuationId !== null && claimedEdge?.workspaceContinuationId !== undefined) {
				this.db.prepare("UPDATE workspace_continuations SET status = 'claimed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(claimedEdge.workspaceContinuationId);
				this.db.prepare("DELETE FROM continuation_status_overrides WHERE continuation_id = ?").run(claimedEdge.workspaceContinuationId);
			}
			if (ordinal === undefined) return claimedEdge;
			return claimedEdge;
		});
	}

	/** Atomically claim a resumable edge for an explicit recovery attempt. */
	claimResumableChild(edgeId: string): TaskEdgeRow | null {
		return this.transactionForClaim(() => {
			const result = this.db.prepare(
				"UPDATE task_edges SET status = 'claimed', claimed_at = CURRENT_TIMESTAMP WHERE edge_id = ? AND COALESCE((SELECT status FROM task_edge_status_overrides WHERE edge_id = task_edges.edge_id), status) = 'resumable'",
			).run(edgeId);
			if (Number((result as { changes?: number | bigint }).changes ?? 0) !== 1) return null;
			this.db.prepare("DELETE FROM task_edge_status_overrides WHERE edge_id = ?").run(edgeId);
			this.db.prepare("UPDATE workspace_continuations SET status = 'claimed', updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT workspace_continuation_id FROM task_edges WHERE edge_id = ?)").run(edgeId);
			this.db.prepare("DELETE FROM continuation_status_overrides WHERE continuation_id = (SELECT workspace_continuation_id FROM task_edges WHERE edge_id = ?)").run(edgeId);
			return this.getTaskEdge(edgeId);
		});
	}

	/** Legal non-terminal transition: claimed → resumable only. */
	markChildResumable(edgeId: string): TaskEdgeRow {
		const result = this.db.prepare(
			"UPDATE task_edges SET status = 'resumable' WHERE edge_id = ? AND status = 'claimed'",
		).run(edgeId);
		if (Number((result as { changes?: number | bigint }).changes ?? 0) !== 1)
			throw new Error("child edge must be claimed before becoming resumable");
		this.db.prepare("INSERT INTO task_edge_status_overrides (edge_id, status) VALUES (?, 'resumable') ON CONFLICT(edge_id) DO UPDATE SET status = 'resumable', updated_at = CURRENT_TIMESTAMP").run(edgeId);
		this.db.prepare("UPDATE tasks SET status = 'executing', updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT child_task_id FROM task_edges WHERE edge_id = ?)").run(edgeId);
		this.db.prepare("INSERT INTO task_status_overrides (task_id, status) VALUES ((SELECT child_task_id FROM task_edges WHERE edge_id = ?), 'resumable') ON CONFLICT(task_id) DO UPDATE SET status = 'resumable', updated_at = CURRENT_TIMESTAMP").run(edgeId);
		this.db.prepare("UPDATE workspace_continuations SET status = 'resumable', updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT workspace_continuation_id FROM task_edges WHERE edge_id = ?)").run(edgeId);
		return this.getTaskEdge(edgeId)!;
	}

	/** Legal recovery transition: ready/claimed/resumable → blocked. */
	markChildBlocked(edgeId: string): TaskEdgeRow {
		const result = this.db.prepare(
			"UPDATE task_edges SET status = 'blocked' WHERE edge_id = ? AND COALESCE((SELECT status FROM task_edge_status_overrides WHERE edge_id = task_edges.edge_id), status) IN ('preparing', 'ready', 'claimed', 'resumable')",
		).run(edgeId);
		if (Number((result as { changes?: number | bigint }).changes ?? 0) !== 1)
			throw new Error("child edge cannot be blocked from its current state");
		this.db.prepare("DELETE FROM task_edge_status_overrides WHERE edge_id = ?").run(edgeId);
		this.db.prepare("UPDATE tasks SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT child_task_id FROM task_edges WHERE edge_id = ?)").run(edgeId);
		this.db.prepare("UPDATE workspace_continuations SET status = 'blocked', updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT workspace_continuation_id FROM task_edges WHERE edge_id = ?)").run(edgeId);
		return this.getTaskEdge(edgeId)!;
	}

	/** Block a continuation without starting a session. The recovery evidence
	 * already referenced by the edge remains durable; child and parent cannot
	 * be reported as shipped while the provider/checkpoint boundary is blocked. */
	blockChild(edgeId: string): TaskEdgeRow {
		return this.transaction(() => {
			const edge = this.getTaskEdge(edgeId);
			if (!edge || edge.childTaskId === null) throw new Error("unknown child edge");
			if (["completed", "failed", "escalated"].includes(edge.status))
				throw new Error("terminal child edge cannot be blocked");
			if (edge.status !== "blocked") this.markChildBlocked(edgeId);
			this.setTaskStatus(edge.childTaskId, "failed");
			this.setTaskStatus(edge.parentTaskId, "failed");
			return this.getTaskEdge(edgeId)!;
		});
	}

	/** Install the terminal outbox before the first immutable evidence write.
	 * Repeating the call must describe the exact same terminal outcome. */
	beginChildTerminalSettlement(settlement: Omit<ChildTerminalSettlement, "state" | "delivery">): ChildTerminalSettlement {
		return this.transaction(() => {
			for (const reference of [settlement.verificationReference, settlement.resultReference, settlement.receiptReference, settlement.traceReference, settlement.parentReceiptReference, settlement.parentTraceReference])
				ImmutableArtifactReferenceSchema.parse(reference);
			const edge = this.getTaskEdge(settlement.edgeId);
			if (!edge) throw new Error("unknown child edge");
			const existing = this.getChildTerminalSettlement(settlement.edgeId);
			if (existing !== null) {
				const same = existing.state === "pending" || existing.state === "linked";
				if (!same || existing.childStatus !== settlement.childStatus ||
					JSON.stringify(existing.verificationReference) !== JSON.stringify(settlement.verificationReference) ||
					JSON.stringify(existing.resultReference) !== JSON.stringify(settlement.resultReference) ||
					JSON.stringify(existing.receiptReference) !== JSON.stringify(settlement.receiptReference) ||
					JSON.stringify(existing.traceReference) !== JSON.stringify(settlement.traceReference) ||
					JSON.stringify(existing.parentReceiptReference) !== JSON.stringify(settlement.parentReceiptReference) ||
					JSON.stringify(existing.parentTraceReference) !== JSON.stringify(settlement.parentTraceReference))
					throw new Error("terminal settlement conflicts with durable evidence");
				return existing;
			}
			if (edge.status !== "claimed" && edge.status !== "resumable")
				throw new Error("child edge must be claimed before terminal settlement");
			this.db.prepare(`INSERT INTO child_terminal_settlements
				(edge_id, status, child_status, verification_reference_json, result_reference_json,
				receipt_reference_json, trace_reference_json, parent_receipt_reference_json,
				parent_trace_reference_json, verification_json, result_json, receipt_json, trace_json,
				parent_receipt_json, parent_trace_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				settlement.edgeId, "pending", settlement.childStatus,
				JSON.stringify(settlement.verificationReference), JSON.stringify(settlement.resultReference),
				JSON.stringify(settlement.receiptReference), JSON.stringify(settlement.traceReference),
				JSON.stringify(settlement.parentReceiptReference), JSON.stringify(settlement.parentTraceReference),
				JSON.stringify(settlement.verification), JSON.stringify(settlement.result),
				JSON.stringify(settlement.receipt), JSON.stringify(settlement.trace),
				JSON.stringify(settlement.parentReceipt), JSON.stringify(settlement.parentTrace),
			);
			return this.getChildTerminalSettlement(settlement.edgeId)!;
		});
	}

	getChildTerminalSettlement(edgeId: string): ChildTerminalSettlement | null {
		const row = this.db.prepare("SELECT * FROM child_terminal_settlements WHERE edge_id = ?").get(edgeId) as Record<string, unknown> | undefined;
		if (!row) return null;
		const reference = (name: string): ImmutableArtifactReference => ImmutableArtifactReferenceSchema.parse(JSON.parse(String(row[name])));
		const json = (name: string): unknown => JSON.parse(String(row[name]));
		return {
			edgeId: String(row.edge_id), childStatus: row.child_status as ChildTerminalStatus,
			verificationReference: reference("verification_reference_json"), resultReference: reference("result_reference_json"),
			receiptReference: reference("receipt_reference_json"), traceReference: reference("trace_reference_json"),
			parentReceiptReference: reference("parent_receipt_reference_json"), parentTraceReference: reference("parent_trace_reference_json"),
			verification: json("verification_json"), result: json("result_json"), receipt: json("receipt_json"), trace: json("trace_json"),
			parentReceipt: json("parent_receipt_json"), parentTrace: json("parent_trace_json"),
			state: row.status as "pending" | "linked",
			delivery: {
				receiptDelivered: Number(row.receipt_delivered) === 1,
				traceDelivered: Number(row.trace_delivered) === 1,
				finalReceiptDelivered: Number(row.final_receipt_delivered) === 1,
				failureCode: row.delivery_failure_code === null ? null : row.delivery_failure_code as ChildDeliveryFailureCode,
				failureDetail: row.delivery_failure_detail === null ? null : String(row.delivery_failure_detail),
			},
		};
	}

	/**
	 * Atomically settle the edge, child continuation/task, required evidence,
	 * and parent terminal outcome. Terminal rows are immutable and repeated
	 * identical settlement is an idempotent no-op.
	 */
	settleChild(edgeId: string, status: ChildTerminalStatus, artifacts: ChildSettlementArtifacts, options: { deliveryAcknowledged?: boolean } = {}): TaskEdgeRow {
		const deliveryPending = options.deliveryAcknowledged === false;
		return this.transaction(() => {
			const before = this.getTaskEdge(edgeId);
			if (!before) throw new Error("unknown child edge");
			if (before.status === status) return before;
			if (["completed", "failed", "escalated"].includes(before.status))
				throw new Error("child edge already has a different terminal status");
			if (before.status !== "claimed" && before.status !== "resumable")
				throw new Error("child edge must be claimed before terminal settlement");
			if (before.childTaskId === null) throw new Error("terminal child edge requires a child task");
			const pending = this.getChildTerminalSettlement(edgeId);
			if (pending !== null && pending.state === "pending") {
				if (pending.childStatus !== status || pending.resultReference.id !== artifacts.resultArtifactId ||
					pending.receiptReference.id !== artifacts.receiptArtifactId || pending.traceReference.id !== artifacts.traceArtifactId ||
					pending.parentReceiptReference.id !== artifacts.parentReceiptArtifactId || pending.parentTraceReference.id !== artifacts.parentTraceArtifactId)
					throw new Error("terminal linkage does not match the durable terminal outbox");
			}
			for (const artifactId of [artifacts.resultArtifactId, artifacts.receiptArtifactId, artifacts.traceArtifactId, artifacts.parentReceiptArtifactId, artifacts.parentTraceArtifactId, artifacts.failureArtifactId]) {
				if (artifactId !== undefined && artifactId !== null && !/^sha256:[a-f0-9]{64}$/.test(artifactId))
					throw new Error("settlement artifacts must be content addressed");
			}
			const refs: Array<[string, string, ImmutableArtifactReference | undefined, string]> = [
				...(artifacts.verificationArtifactId ? [["verification", artifacts.verificationArtifactId, artifacts.verificationReference, before.childTaskId] as [string, string, ImmutableArtifactReference | undefined, string]] : []),
				["result", artifacts.resultArtifactId, artifacts.resultReference, before.childTaskId],
				["receipt", artifacts.receiptArtifactId, artifacts.receiptReference, before.childTaskId],
				["trace", artifacts.traceArtifactId, artifacts.traceReference, before.childTaskId],
				...(artifacts.failureArtifactId ? [["failure", artifacts.failureArtifactId, undefined, before.childTaskId] as [string, string, ImmutableArtifactReference | undefined, string]] : []),
				...(artifacts.parentReceiptArtifactId ? [["receipt", artifacts.parentReceiptArtifactId, artifacts.parentReceiptReference, before.parentTaskId] as [string, string, ImmutableArtifactReference | undefined, string]] : []),
				...(artifacts.parentTraceArtifactId ? [["trace", artifacts.parentTraceArtifactId, artifacts.parentTraceReference, before.parentTaskId] as [string, string, ImmutableArtifactReference | undefined, string]] : []),
			];
			for (const [role, artifactId, reference, taskId] of refs) {
				if (reference !== undefined && reference.id !== artifactId)
					throw new Error("settlement artifact reference does not match its identity");
				this.insertTaskArtifact({ taskId, role, artifactId, mediaType: reference?.mediaType ?? "application/json", ...(reference === undefined ? {} : { reference }) });
			}
			const parentStatus: TaskStatus = deliveryPending
				? "delivery_pending"
				: status === "completed" ? "completed" : status === "failed" ? "failed" : "escalated";
			const child = this.getTask(before.childTaskId);
			if (!child) throw new Error("child task does not exist");
			if (["completed", "failed", "escalated"].includes(child.status) && child.status !== status)
				throw new Error("child task already has a different terminal status");
			const parent = this.getTask(before.parentTaskId);
			if (!parent) throw new Error("parent task does not exist");
			if (["completed", "failed", "escalated"].includes(parent.status) && parent.status !== parentStatus)
				throw new Error("parent task already has a different terminal status");
			if (deliveryPending) {
				// Canonical evidence is linked, but the external CLI artifacts are not
				// acknowledged yet. Overrides keep the base terminal schema additive.
				this.setTaskStatus(before.parentTaskId, "delivery_pending");
				this.setTaskStatus(before.childTaskId, "delivery_pending");
				this.db.prepare("INSERT INTO task_edge_status_overrides (edge_id, status) VALUES (?, 'delivery_pending') ON CONFLICT(edge_id) DO UPDATE SET status = 'delivery_pending', updated_at = CURRENT_TIMESTAMP").run(edgeId);
				this.db.prepare("INSERT INTO continuation_status_overrides (continuation_id, status) VALUES ((SELECT workspace_continuation_id FROM task_edges WHERE edge_id = ?), 'delivery_pending') ON CONFLICT(continuation_id) DO UPDATE SET status = 'delivery_pending', updated_at = CURRENT_TIMESTAMP").run(edgeId);
				this.db.prepare("UPDATE child_terminal_settlements SET status = 'linked', updated_at = CURRENT_TIMESTAMP WHERE edge_id = ?").run(edgeId);
				return this.getTaskEdge(edgeId)!;
			}
			if (!("completed" === parent.status || "failed" === parent.status || "escalated" === parent.status)) {
				const parentResult = this.db.prepare("UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status NOT IN ('completed', 'failed', 'escalated')").run(parentStatus, before.parentTaskId);
				if (Number((parentResult as { changes?: number | bigint }).changes ?? 0) !== 1) throw new Error("parent terminal transition lost");
			}
			this.db.prepare("UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status NOT IN ('completed', 'failed', 'escalated')").run(status, before.childTaskId);
			const edgeResult = this.db.prepare("UPDATE task_edges SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE edge_id = ? AND status IN ('claimed', 'resumable')").run(status, edgeId);
			if (Number((edgeResult as { changes?: number | bigint }).changes ?? 0) !== 1) throw new Error("child edge terminal transition lost");
			this.db.prepare("UPDATE workspace_continuations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT workspace_continuation_id FROM task_edges WHERE edge_id = ?)").run(status, edgeId);
			this.db.prepare("DELETE FROM task_status_overrides WHERE task_id IN (?, ?)").run(before.parentTaskId, before.childTaskId);
			this.db.prepare("DELETE FROM task_edge_status_overrides WHERE edge_id = ?").run(edgeId);
			this.db.prepare("DELETE FROM continuation_status_overrides WHERE continuation_id = (SELECT workspace_continuation_id FROM task_edges WHERE edge_id = ?)").run(edgeId);
			this.db.prepare("UPDATE child_terminal_settlements SET status = 'linked', updated_at = CURRENT_TIMESTAMP WHERE edge_id = ?").run(edgeId);
			return this.getTaskEdge(edgeId)!;
		});
	}

	/** Record one idempotent external-delivery acknowledgement. Completion is
	 * impossible until receipt, trace, and the final shipped-receipt rewrite
	 * have each been acknowledged. */
	acknowledgeChildDeliveryStep(
		edgeId: string,
		step: "receipt" | "trace" | "final_receipt",
	): TaskEdgeRow {
		return this.transaction(() => {
			const settlement = this.getChildTerminalSettlement(edgeId);
			if (settlement === null) throw new Error("terminal settlement does not exist");
			if (settlement.state !== "linked") throw new Error("canonical terminal evidence is not linked");
			const column = step === "receipt"
				? "receipt_delivered"
				: step === "trace" ? "trace_delivered" : "final_receipt_delivered";
			this.db.prepare(`UPDATE child_terminal_settlements SET ${column} = 1, updated_at = CURRENT_TIMESTAMP WHERE edge_id = ?`).run(edgeId);
			const updated = this.getChildTerminalSettlement(edgeId)!;
			if (updated.delivery.receiptDelivered && updated.delivery.traceDelivered && updated.delivery.finalReceiptDelivered) {
				const edge = this.getTaskEdge(edgeId);
				if (!edge || edge.childTaskId === null) throw new Error("unknown terminal child edge");
				const parentStatus: TaskStatus = updated.childStatus === "completed" ? "completed" : updated.childStatus === "failed" ? "failed" : "escalated";
				this.db.prepare("UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (?, ?)").run(parentStatus, edge.parentTaskId, edge.childTaskId);
				this.db.prepare("UPDATE task_edges SET status = ?, completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE edge_id = ?").run(updated.childStatus, edgeId);
				this.db.prepare("UPDATE workspace_continuations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT workspace_continuation_id FROM task_edges WHERE edge_id = ?)").run(updated.childStatus, edgeId);
				this.db.prepare("DELETE FROM task_status_overrides WHERE task_id IN (?, ?)").run(edge.parentTaskId, edge.childTaskId);
				this.db.prepare("DELETE FROM task_edge_status_overrides WHERE edge_id = ?").run(edgeId);
				this.db.prepare("DELETE FROM continuation_status_overrides WHERE continuation_id = (SELECT workspace_continuation_id FROM task_edges WHERE edge_id = ?)").run(edgeId);
			}
			return this.getTaskEdge(edgeId)!;
		});
	}

	/** Idempotent all-at-once acknowledgement for adapters that have already
	 * durably written the provisional receipt, trace, and final receipt. */
	acknowledgeChildDelivery(edgeId: string): TaskEdgeRow {
		this.acknowledgeChildDeliveryStep(edgeId, "receipt");
		this.acknowledgeChildDeliveryStep(edgeId, "trace");
		return this.acknowledgeChildDeliveryStep(edgeId, "final_receipt");
	}

	/** Persist a bounded typed delivery failure. It never changes the canonical
	 * outcome to ship and is safe to call repeatedly during recovery. */
	recordChildDeliveryFailure(edgeId: string, code: ChildDeliveryFailureCode, detail: string): ChildTerminalSettlement {
		return this.transaction(() => {
			const settlement = this.getChildTerminalSettlement(edgeId);
			if (settlement === null) throw new Error("terminal settlement does not exist");
			const bounded = detail.slice(0, 256);
			this.db.prepare("UPDATE child_terminal_settlements SET delivery_failure_code = ?, delivery_failure_detail = ?, updated_at = CURRENT_TIMESTAMP WHERE edge_id = ?").run(code, bounded, edgeId);
			return this.getChildTerminalSettlement(edgeId)!;
		});
	}

	/** Reopen evidence leaves the edge delivery-pending; the marker is durable
	 * evidence that the prior process disappeared between delivery steps. */
	noteChildDeliveryProcessLoss(edgeId: string): ChildTerminalSettlement {
		return this.recordChildDeliveryFailure(edgeId, "process_lost_between_delivery_steps", "process ended before all external delivery acknowledgements");
	}

	// ─── workflow approvals (human gate, FR-2/FR-7 planning-only workflow) ──

	getWorkflowApproval(dagId: string): WorkflowApprovalRow | null {
		const row = this.db
			.prepare(
				"SELECT dag_id, approved, updated_at FROM workflow_approvals WHERE dag_id = ?",
			)
			.get(dagId) as Record<string, unknown> | undefined;
		if (!row) return null;
		return {
			dagId: String(row.dag_id),
			approved: Number(row.approved) === 1,
			updatedAt: String(row.updated_at),
		};
	}

	isWorkflowApproved(dagId: string): boolean {
		const row = this.getWorkflowApproval(dagId);
		return row !== null && row.approved;
	}

	setWorkflowApproval(dagId: string, approved: boolean): void {
		this.db
			.prepare(
				`INSERT INTO workflow_approvals (dag_id, approved, updated_at)
				 VALUES (?, ?, CURRENT_TIMESTAMP)
				 ON CONFLICT(dag_id) DO UPDATE SET approved = excluded.approved, updated_at = CURRENT_TIMESTAMP`,
			)
			.run(dagId, approved ? 1 : 0);
	}

	clearWorkflowApproval(dagId: string): void {
		this.db
			.prepare("DELETE FROM workflow_approvals WHERE dag_id = ?")
			.run(dagId);
	}

	listWorkflowApprovals(): Array<{
		dagId: string;
		approved: boolean;
		updatedAt: string;
	}> {
		const rows = this.db
			.prepare(
				"SELECT dag_id, approved, updated_at FROM workflow_approvals ORDER BY dag_id",
			)
			.all() as Record<string, unknown>[];
		return rows.map((r) => ({
			dagId: String(r.dag_id),
			approved: Number(r.approved) === 1,
			updatedAt: String(r.updated_at),
		}));
	}

	// ─── boot reconciliation (NFR-1) ──────────────────────────────────

	/** Reclassify child preparation ownership before generic task retry. The
	 * optional validation map is produced outside the SQLite write transaction
	 * because provider target checks are asynchronous. Without it, recovery is
	 * fail-closed: ledger rows alone can never make an edge resumable. */
	reconcileChildEdgesOnBoot(validations?: ReadonlyMap<string, ChildBootValidationResult>): {
		preparing: string[];
		resumable: string[];
		blocked: string[];
		blockedEvidence: ChildReconciliationEvidenceRow[];
	} {
		return this.transaction(() => {
			const preparing: string[] = [];
			const resumable: string[] = [];
			const blocked: string[] = [];
			const blockedEvidence: ChildReconciliationEvidenceRow[] = [];
			const owners = this.db.prepare("SELECT * FROM child_preparation_ownership WHERE status IN ('parent_pending', 'parent_accepted', 'artifacts_pending', 'provider_preparing') ORDER BY created_at, rowid").all() as Record<string, unknown>[];
			for (const row of owners) {
				const owner = rowToChildPreparationOwnership(row);
				if (owner.status === "parent_pending" && owner.parentExecutionStartedAt !== null)
					this.setTaskStatus(owner.parentTaskId, "preparing");
				const edge = this.getTaskEdge(owner.edgeId);
				if (!edge || edge.status === "preparing" || edge.status === "ready") preparing.push(owner.preparationId);
			}
			const rows = this.db.prepare("SELECT e.*, o.status AS override_status FROM task_edges e LEFT JOIN task_edge_status_overrides o ON o.edge_id = e.edge_id WHERE COALESCE(o.status, e.status) IN ('preparing', 'ready', 'claimed', 'resumable', 'delivery_pending') ORDER BY e.created_at, e.rowid").all() as Record<string, unknown>[];
			for (const row of rows) {
				const edge = rowToTaskEdge(row);
				const validation = validations?.get(edge.edgeId);
				// A terminal outbox is self-contained: replaying its immutable bytes
				// does not touch the provider, so boot must not block it merely because
				// optional provider dependencies were not supplied.
				const terminalSettlement = this.getChildTerminalSettlement(edge.edgeId);
				if (terminalSettlement !== null) {
					// Canonical evidence owns this edge. Do not reclassify it as
					// executable work merely because external delivery was interrupted.
					if (terminalSettlement.delivery.failureCode === null && edge.status !== "completed" && edge.status !== "failed" && edge.status !== "escalated")
						this.db.prepare("UPDATE child_terminal_settlements SET delivery_failure_code = 'process_lost_between_delivery_steps', delivery_failure_detail = ?, updated_at = CURRENT_TIMESTAMP WHERE edge_id = ?").run("process ended before all external delivery acknowledgements".slice(0, 256), edge.edgeId);
					continue;
				}
				// Ready edges are not made resumable by boot, but a configured ready
				// edge must still fail closed when its immutable ingress is damaged.
				// Legacy/unconfigured ready rows are intentionally left untouched.
				if (edge.status === "preparing") continue;
				if (edge.status === "ready" && validation?.valid !== false) continue;
				if (validation?.valid === true) {
					if (edge.status === "claimed") {
						this.db.prepare("UPDATE task_edges SET status = 'resumable' WHERE edge_id = ? AND status = 'claimed'").run(edge.edgeId);
						this.db.prepare("INSERT INTO task_edge_status_overrides (edge_id, status) VALUES (?, 'resumable') ON CONFLICT(edge_id) DO UPDATE SET status = 'resumable', updated_at = CURRENT_TIMESTAMP").run(edge.edgeId);
						this.db.prepare("UPDATE workspace_continuations SET status = 'resumable', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(edge.workspaceContinuationId);
						this.db.prepare("INSERT INTO continuation_status_overrides (continuation_id, status) VALUES (?, 'resumable') ON CONFLICT(continuation_id) DO UPDATE SET status = 'resumable', updated_at = CURRENT_TIMESTAMP").run(edge.workspaceContinuationId);
						this.setTaskStatus(edge.childTaskId!, "resumable");
						this.setTaskStatus(edge.parentTaskId, "awaiting_child");
						resumable.push(edge.edgeId);
					}
					continue;
				}
				const evidence = validation?.valid === false
					? validation.evidence
					: { edgeId: edge.edgeId, code: "incompatible" as const, dependency: "validator" as const };
				this.db.prepare("UPDATE task_edges SET status = 'blocked' WHERE edge_id = ?").run(edge.edgeId);
				this.db.prepare("DELETE FROM task_edge_status_overrides WHERE edge_id = ?").run(edge.edgeId);
				if (edge.childTaskId !== null) this.setTaskStatus(edge.childTaskId, "failed");
				this.setTaskStatus(edge.parentTaskId, "failed");
				if (edge.workspaceContinuationId !== null) {
					this.db.prepare("UPDATE workspace_continuations SET status = 'blocked', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(edge.workspaceContinuationId);
					this.db.prepare("DELETE FROM continuation_status_overrides WHERE continuation_id = ?").run(edge.workspaceContinuationId);
				}
				this.persistChildReconciliationEvidence(edge.edgeId, evidence);
				blocked.push(edge.edgeId);
				blockedEvidence.push(this.getChildReconciliationEvidence(edge.edgeId)!);
			}
			return { preparing, resumable, blocked, blockedEvidence };
		});
	}

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
			// Active child edges own both linked task rows. A blocked edge is a
			// terminal recovery outcome, not active ownership, so its task rows
			// retain the generic retry policy below.
			const edgeOwned = this.db.prepare(
				`SELECT 1 FROM task_edges e
				 LEFT JOIN task_edge_status_overrides o ON o.edge_id = e.edge_id
				 WHERE (e.parent_task_id = ? OR e.child_task_id = ?)
				   AND COALESCE(o.status, e.status) IN ('preparing', 'ready', 'claimed', 'resumable', 'delivery_pending')
				 LIMIT 1`,
			).get(task.id, task.id);
			const preparationOwned = this.db.prepare(
				`SELECT 1 FROM child_preparation_ownership
				 WHERE (parent_task_id = ? OR planned_child_task_id = ?)
				   AND status IN ('parent_pending', 'parent_accepted', 'artifacts_pending', 'provider_preparing')
				 LIMIT 1`,
			).get(task.id, task.id);
			if (edgeOwned !== undefined || preparationOwned !== undefined) continue;
			const decision = reconcileCrashedTask({
				status: task.status,
				retryCount: task.retryCount,
				maxRetries: task.maxRetries,
			});
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

	// ─── M5.5 standalone recovery (ADR docs/adr/m5.5-linear-recovery.md) ──

	/** Insert one `resumable` standalone-recovery row from validated identities.
	 * Used by tests now; capture wiring lands in seam 4b (no claim, no
	 * pruning — those are 4b/4c). Idempotent for an identical run; a
	 * conflicting identity or a lineage fork is rejected atomically. */
	createRecoveryRecord(input: NewStandaloneRecovery): RecoveryStatus {
		return this.transaction(() => {
			validateStandaloneRecoveryIdentities(input);
			const existing = this.db.prepare(
				"SELECT run_id FROM standalone_recovery WHERE run_id = ?",
			).get(input.runId);
			if (existing !== undefined) {
				const own = recoveryRow(this.db, input.runId);
				const current = own === undefined ? null : rowToRecoveryStatus(own);
				if (current === null || current.phase !== "resumable" ||
					current.taskId !== input.taskId || current.specHash !== input.specHash ||
					current.workspaceStateId !== input.workspaceStateId ||
					current.continuationRecordId !== input.continuationRecordId ||
					current.capPolicyId !== input.capPolicyId ||
					current.engineVersion !== input.engineVersion ||
					current.workspaceCapabilityId !== input.workspaceCapabilityId)
					throw new Error("recovery record identity conflicts with durable state");
				return this.getRecoveryStatus(input.runId)!;
			}
			if (input.predecessorRunId !== undefined && input.predecessorRunId !== null &&
				input.predecessorRunId !== input.runId) {
				const predecessor = this.db.prepare(
					"SELECT run_id, successor_run_id FROM standalone_recovery WHERE run_id = ?",
				).get(input.predecessorRunId) as { run_id: string; successor_run_id: string | null } | undefined;
				if (predecessor === undefined) throw new Error("recovery predecessor run does not exist");
				// A cycle is when some EXISTING row in the chain already points at the
				// new run. The one legitimate match is the successor slot pre-allocated
				// by a linear claim (ADR seam 4b): the claimed row carries a dangling
				// successor_run_id pointing at the not-yet-created successor, and the
				// resumer walks that exact identity when creating it.
				if (predecessor.successor_run_id !== input.runId &&
					this.isRecoveryDescendant(input.predecessorRunId, input.runId))
					throw new Error("recovery lineage cycle");
				if (predecessor.successor_run_id !== null && predecessor.successor_run_id !== input.runId)
					throw new Error("recovery predecessor already has a successor");
				this.db.prepare(
					"UPDATE standalone_recovery SET successor_run_id = ? WHERE run_id = ? AND (successor_run_id IS NULL OR successor_run_id = ?)",
				).run(input.runId, input.predecessorRunId, input.runId);
			}
			this.db.prepare(
				`INSERT INTO standalone_recovery
				 (run_id, task_id, spec_hash, predecessor_run_id, successor_run_id,
				  phase, resume_allowed, blocked_reason, workspace_state_id,
				  continuation_record_id, cap_policy_id, expires_at, engine_version,
				  workspace_capability_id)
				 VALUES (?, ?, ?, ?, NULL, 'resumable', 1, NULL, ?, ?, ?, ?, ?, ?)`,
			).run(
				input.runId, input.taskId, input.specHash, input.predecessorRunId ?? null,
				input.workspaceStateId, input.continuationRecordId, input.capPolicyId,
				input.expiresAt, input.engineVersion, input.workspaceCapabilityId,
			);
			return this.getRecoveryStatus(input.runId)!;
		});
	}

	/** Atomic linear claim (ADR seam 4b): resolve `runId` to its terminal
	 * lineage member, then compare-and-set one `resumable` row with no
	 * successor to `claimed`, allocating exactly one direct successor.
	 * Concurrent claimers have one winner; losers receive the current factual
	 * status and create neither a session nor a workspace. The successor
	 * identity is supplied by the caller — a fresh family/attempt id from the
	 * existing `deriveTaskId`/`resolveAttemptId` machinery. */
	claimRecovery(runId: string, successorRunId: string): { success: boolean; status: RecoveryStatus } {
		const outcome = this.transactionForClaim(() => {
			const terminal = this.resolveToLatestFailed(runId);
			if (terminal === null) throw new Error("recovery run does not exist");
			if (isRecoveryExpired(terminal)) {
				this.db.prepare(`UPDATE standalone_recovery SET phase = 'blocked', resume_allowed = 0, blocked_reason = 'expired' WHERE run_id = ?`).run(terminal.runId);
				this.db.prepare(`INSERT INTO standalone_recovery_status_overrides (run_id, phase) VALUES (?, 'blocked') ON CONFLICT(run_id) DO UPDATE SET phase = 'blocked', updated_at = CURRENT_TIMESTAMP`).run(terminal.runId);
				return { success: false, status: this.resolveToLatestFailed(runId)! };
			}
			if (terminal.blockedReason !== null || terminal.resumeAllowed === false) {
				return { success: false, status: terminal };
			}
			if (this.db.prepare("SELECT 1 FROM standalone_recovery WHERE run_id = ?").get(successorRunId) !== undefined)
				throw new Error("recovery successor run already exists in the ledger");
			const result = this.db.prepare(
				`UPDATE standalone_recovery
				 SET successor_run_id = ?, resume_allowed = 0
				 WHERE run_id = ?
				   AND successor_run_id IS NULL
				   AND COALESCE((SELECT phase FROM standalone_recovery_status_overrides o
								 WHERE o.run_id = standalone_recovery.run_id), phase) = 'resumable'`,
			).run(successorRunId, terminal.runId);
			if (Number((result as { changes?: number | bigint }).changes ?? 0) !== 1)
				return { success: false, status: this.resolveToLatestFailed(runId)! };
			this.db.prepare(
				"INSERT INTO standalone_recovery_status_overrides (run_id, phase) VALUES (?, 'claimed') ON CONFLICT(run_id) DO UPDATE SET phase = 'claimed', updated_at = CURRENT_TIMESTAMP",
			).run(terminal.runId);
			return { success: true, status: this.resolveToLatestFailed(runId)! };
		});
		if (outcome !== null) return outcome;
		// A busy loser maps to the same factual outcome as a CAS loser.
		const status = this.resolveToLatestFailed(runId);
		if (status === null) throw new Error("recovery run does not exist");
		return { success: false, status };
	}

	/** Resolve `runId` to the terminal latest member of its recovery lineage by
	 * following the successor chain (every lineage member is a failed attempt;
	 * claimed/superseded members are returned as-is so losers receive factual
	 * status). Expiry is applied fail-closed: an expired resumable row reports
	 * blocked/expired with resume_allowed=false before any workspace restore. */
	resolveToLatestFailed(runId: string, now?: number | Date | string): RecoveryStatus | null {
		const row = recoveryRow(this.db, runId);
		if (row === undefined) return null;
		let current = rowToRecoveryStatus(row);
		const seen = new Set<string>([current.runId]);
		while (current.successorRunId !== null && !seen.has(current.successorRunId)) {
			seen.add(current.successorRunId);
			const next = recoveryRow(this.db, current.successorRunId);
			if (next === undefined) break;
			current = rowToRecoveryStatus(next);
		}
		return this.applyRecoveryExpiryIfNeeded(current, now);
	}

	/** Factual status read (4a contract): the terminal lineage member, with
	 * expiry fail-closed applied. */
	getRecoveryStatus(runId: string, now?: number | Date | string): RecoveryStatus | null {
		return this.resolveToLatestFailed(runId, now);
	}

	/** Latest recovery fact for a task family (`task_id` = familyId): the most
	 * recently created recovery row, lineage-resolved to its chain end. */
	getLatestRecoveryForFamily(familyId: string, now?: number | Date | string): RecoveryStatus | null {
		const row = this.db.prepare(
			"SELECT run_id FROM standalone_recovery WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
		).get(familyId) as { run_id: string } | undefined;
		if (row === undefined) return null;
		return this.getRecoveryStatus(String(row.run_id), now);
	}

	/** Apply expiry fail-closed without mutating the ledger (pruning persists it). */
	private applyRecoveryExpiryIfNeeded(status: RecoveryStatus, now?: number | Date | string): RecoveryStatus {
		if (status.phase !== "resumable") return status;
		const reference = now ?? Date.now();
		if (!isRecoveryExpired(status, reference)) return status;
		return { ...status, phase: "blocked", resumeAllowed: false, blockedReason: "expired" };
	}

	/** Mark a recovery run as blocked with a stable factual reason.
	 * Every blocker maps to resume_allowed=false and a stable blocked_reason
	 * (continuation_missing|corrupt|expired|incompatible|over_budget|blocked). */
	markRecoveryBlocked(runId: string, blocker: RecoveryBlocker): RecoveryStatus {
		return this.transaction(() => {
			const row = recoveryRow(this.db, runId);
			if (row === undefined) throw new Error("recovery run does not exist");
			this.db.prepare(
				`UPDATE standalone_recovery SET phase = 'blocked', resume_allowed = 0, blocked_reason = ? WHERE run_id = ?`,
			).run(blocker, runId);
			this.db.prepare(
				`INSERT INTO standalone_recovery_status_overrides (run_id, phase) VALUES (?, 'blocked') ON CONFLICT(run_id) DO UPDATE SET phase = 'blocked', updated_at = CURRENT_TIMESTAMP`,
			).run(runId);
			const updated = recoveryRow(this.db, runId);
			if (updated === undefined) throw new Error("recovery run does not exist after block");
			return rowToRecoveryStatus(updated);
		});
	}

	/** Coordination helper: delete the continuation body for a run and make the
	 * ledger reference non-resumable. Bodies in LocalContinuationStore are
	 * deleted; canonical receipts/traces are never touched. */
	deleteRecoveryRecordBody(
		runId: string,
		options: { continuationStore?: { delete(id: string): Promise<boolean> }; storeRoot?: string } = {},
	): boolean {
		return this.transaction(() => {
			const status = this.resolveToLatestFailed(runId);
			if (status === null) throw new Error("recovery run does not exist");
			if (status.continuationRecordId !== null) {
				if (options.continuationStore !== undefined) {
					void options.continuationStore.delete(status.continuationRecordId).catch(() => {});
				} else if (options.storeRoot !== undefined) {
					deleteContinuationBodyFile(options.storeRoot, status.continuationRecordId);
				}
				if (status.workspaceStateId !== null && options.storeRoot !== undefined) {
					deleteContinuationBodyFile(options.storeRoot, status.workspaceStateId);
				}
			}
			this.db.prepare(`UPDATE standalone_recovery SET resume_allowed = 0, blocked_reason = COALESCE(blocked_reason, 'blocked'), phase = CASE WHEN phase = 'resumable' THEN 'blocked' ELSE phase END WHERE run_id = ?`).run(status.runId);
			if (status.phase === "resumable") {
				this.db.prepare(`INSERT INTO standalone_recovery_status_overrides (run_id, phase) VALUES (?, 'blocked') ON CONFLICT(run_id) DO UPDATE SET phase = 'blocked', updated_at = CURRENT_TIMESTAMP`).run(status.runId);
			}
			return true;
		});
	}

	/** Async variant of deleteRecoveryRecordBody for callers with an async store. */
	async deleteRecoveryRecordBodyAsync(
		runId: string,
		options: { continuationStore?: { delete(id: string): Promise<boolean> }; storeRoot?: string } = {},
	): Promise<boolean> {
		const status = this.resolveToLatestFailed(runId);
		if (status === null) throw new Error("recovery run does not exist");
		if (status.continuationRecordId !== null) {
			await deleteContinuationBodyAsync(options.continuationStore, options.storeRoot, status.continuationRecordId);
			if (status.workspaceStateId !== null) await deleteContinuationBodyAsync(options.continuationStore, options.storeRoot, status.workspaceStateId);
		}
		this.markRecoveryBlocked(status.runId, (status.blockedReason as RecoveryBlocker | null) ?? "blocked");
		return true;
	}

	/** Deterministic prune: expired → terminal settlement → superseded lineage.
	 * Each pruned row becomes non-resumable (blocked) and its continuation body
	 * is deleted. Never deletes canonical receipts/traces. Returns pruned runIds
	 * in deterministic order. */
	pruneExpiredRecoveries(
		now: number | Date | string = Date.now(),
		options: { continuationStore?: { delete(id: string): Promise<boolean> }; storeRoot?: string } = {},
	): string[] {
		return this.transaction(() => {
			const rows = this.db.prepare(`SELECT r.*, o.phase AS override_phase FROM standalone_recovery r LEFT JOIN standalone_recovery_status_overrides o ON o.run_id = r.run_id`).all() as Record<string, unknown>[];
			const statuses = rows.map(rowToRecoveryStatus);
			const expired: RecoveryStatus[] = [];
			const terminal: RecoveryStatus[] = [];
			const superseded: RecoveryStatus[] = [];
			const nowMs = typeof now === "number" ? now : now instanceof Date ? now.getTime() : Date.parse(String(now));
			for (const s of statuses) {
				const isExpired = Number.isFinite(Date.parse(s.expiresAt)) ? Date.parse(s.expiresAt) <= (Number.isFinite(nowMs) ? nowMs : Date.now()) : true;
				if (isExpired && s.phase === "resumable") expired.push(s);
				else if (s.phase === "completed") terminal.push(s);
				else if (s.successorRunId !== null) superseded.push(s);
			}
			expired.sort(compareRecoveryForPruning);
			terminal.sort(compareRecoveryForPruning);
			superseded.sort(compareRecoveryForPruning);
			const ordered = [...expired, ...terminal, ...superseded];
			const pruned: string[] = [];
			for (const s of ordered) {
				const blocker: RecoveryBlocker = expired.includes(s) ? "expired" : (s.blockedReason as RecoveryBlocker | null) ?? "blocked";
				this.db.prepare(`UPDATE standalone_recovery SET resume_allowed = 0, blocked_reason = ?, phase = CASE WHEN phase = 'resumable' THEN 'blocked' ELSE phase END WHERE run_id = ?`).run(blocker, s.runId);
				if (s.phase === "resumable") {
					this.db.prepare(`INSERT INTO standalone_recovery_status_overrides (run_id, phase) VALUES (?, 'blocked') ON CONFLICT(run_id) DO UPDATE SET phase = 'blocked', updated_at = CURRENT_TIMESTAMP`).run(s.runId);
				}
				if (s.continuationRecordId !== null) {
					if (options.continuationStore !== undefined) {
						void options.continuationStore.delete(s.continuationRecordId).catch(() => {});
					} else if (options.storeRoot !== undefined) {
						deleteContinuationBodyFile(options.storeRoot, s.continuationRecordId);
					}
				}
				if (s.workspaceStateId !== null && options.storeRoot !== undefined) {
					deleteContinuationBodyFile(options.storeRoot, s.workspaceStateId);
				}
				pruned.push(s.runId);
			}
			return pruned;
		});
	}

	/** Async prune variant that awaits continuation-store deletes. */
	async pruneExpiredRecoveriesAsync(
		now: number | Date | string = Date.now(),
		options: { continuationStore?: { delete(id: string): Promise<boolean> }; storeRoot?: string } = {},
	): Promise<string[]> {
		const pruned = this.pruneExpiredRecoveries(now, {});
		for (const runId of pruned) {
			const status = this.getRecoveryStatus(runId);
			if (status?.continuationRecordId !== null && status !== null) {
				await deleteContinuationBodyAsync(options.continuationStore, options.storeRoot, status.continuationRecordId);
			}
		}
		return pruned;
	}

	/** Delete temporary continuation bodies after successful delivery.
	 * Successful runs add zero additional inference; this cleans the
	 * operational recovery body without touching canonical evidence. */
	cleanupOnSuccess(
		runId: string,
		options: { continuationStore?: { delete(id: string): Promise<boolean> }; storeRoot?: string } = {},
	): boolean {
		return this.transaction(() => {
			const status = this.resolveToLatestFailed(runId);
			if (status === null) throw new Error("recovery run does not exist");
			if (status.continuationRecordId !== null) {
				if (options.continuationStore !== undefined) {
					void options.continuationStore.delete(status.continuationRecordId).catch(() => {});
				} else if (options.storeRoot !== undefined) {
					deleteContinuationBodyFile(options.storeRoot, status.continuationRecordId);
				}
			}
			if (status.workspaceStateId !== null && options.storeRoot !== undefined) {
				deleteContinuationBodyFile(options.storeRoot, status.workspaceStateId);
			}
			this.db.prepare(`UPDATE standalone_recovery SET resume_allowed = 0 WHERE run_id = ?`).run(status.runId);
			return true;
		});
	}

	async cleanupOnSuccessAsync(
		runId: string,
		options: { continuationStore?: { delete(id: string): Promise<boolean> }; storeRoot?: string } = {},
	): Promise<boolean> {
		const status = this.resolveToLatestFailed(runId);
		if (status === null) throw new Error("recovery run does not exist");
		if (status.continuationRecordId !== null) {
			await deleteContinuationBodyAsync(options.continuationStore, options.storeRoot, status.continuationRecordId);
		}
		if (status.workspaceStateId !== null) await deleteContinuationBodyAsync(options.continuationStore, options.storeRoot, status.workspaceStateId);
		this.db.prepare(`UPDATE standalone_recovery SET resume_allowed = 0 WHERE run_id = ?`).run(status.runId);
		return true;
	}

	/** Instance wrapper for the module-level shouldPersistRecovery. */
	shouldPersistRecovery(taskStatus: string): boolean {
		return shouldPersistRecovery(taskStatus);
	}

	/** Factual rendering for `status <run-id>`: surfaces blocked_reason + successor_run_id. */
	renderRecoveryStatus(status: RecoveryStatus): string {
		const parts: string[] = [
			`runId=${status.runId}`,
			`taskId=${status.taskId}`,
			`phase=${status.phase}`,
			`resume_allowed=${String(status.resumeAllowed)}`,
			`blocked_reason=${status.blockedReason ?? "none"}`,
			`successor_run_id=${status.successorRunId ?? "none"}`,
		];
		return parts.join(" ");
	}

	formatRecoveryStatus(status: RecoveryStatus): string {
		return this.renderRecoveryStatus(status);
	}

	/** True when following the successor chain forward from `runId` reaches
	 * `target` — the defensive half of the no-cycle lineage invariant. */
	private isRecoveryDescendant(runId: string, target: string): boolean {
		const seen = new Set<string>();
		let cursor: string | null = runId;
		while (cursor !== null && !seen.has(cursor)) {
			if (cursor === target) return true;
			seen.add(cursor);
			const row = this.db.prepare(
				"SELECT successor_run_id FROM standalone_recovery WHERE run_id = ?",
			).get(cursor) as { successor_run_id: string | null } | undefined;
			cursor = row === undefined || row.successor_run_id === null ? null : row.successor_run_id;
		}
		return false;
	}
}

// ─── Row mappers (snake_case DDL → camelCase TS) ─────────────────────

/** Text column reader: strings pass through; other JSON scalars render
 *  via JSON so objects can never become '[object Object]'. */
function textColumn(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value) ?? "";
}

function requireArtifactIdentity(value: string, field: string): void {
	if (!/^sha256:[a-f0-9]{64}$/.test(value))
		throw new Error(`${field} must be a sha256 content address`);
}

function rowToTask(row: Record<string, unknown>): TaskRow {
	return {
		id: String(row.id),
		status: (row.override_status ?? row.status) as TaskStatus,
		goal: String(row.goal),
		parentBranch:
			row.parent_branch === null ? null : textColumn(row.parent_branch),
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
		yieldPayload:
			row.yield_payload === null ? null : textColumn(row.yield_payload),
		lastHeartbeatAt:
			row.last_heartbeat_at === null ? null : textColumn(row.last_heartbeat_at),
	};
}

function rowToWorkspace(row: Record<string, unknown>): WorkspaceRow {
	return {
		id: String(row.id),
		taskId: String(row.task_id),
		driver: String(row.driver),
		hostPath: String(row.host_path),
		containerPath:
			row.container_path === null ? null : textColumn(row.container_path),
		branchName: String(row.branch_name),
		status: row.status as WorkspaceStatus,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function rowToChildPreparationOwnership(row: Record<string, unknown>): ChildPreparationOwnershipRow {
	return {
		preparationId: String(row.preparation_id), edgeId: String(row.edge_id),
		parentTaskId: String(row.parent_task_id), plannedChildTaskId: String(row.planned_child_task_id),
		driver: String(row.driver), capabilityIdentity: String(row.capability_identity),
		capabilityVersion: String(row.capability_version), status: row.status as ChildPreparationOwnershipStatus,
		parentRevision: row.parent_revision === null ? null : String(row.parent_revision),
		parentReceiptJson: row.parent_receipt_json === null ? null : String(row.parent_receipt_json),
		parentExecutionStartedAt: row.parent_execution_started_at === null || row.parent_execution_started_at === undefined ? null : String(row.parent_execution_started_at),
		createdAt: String(row.created_at), updatedAt: String(row.updated_at),
	};
}

function rowToTaskArtifact(row: Record<string, unknown>): TaskArtifactReference {
	let reference: ImmutableArtifactReference | undefined;
	if (typeof row.reference_json === "string") {
		try { reference = ImmutableArtifactReferenceSchema.parse(JSON.parse(row.reference_json)); }
		catch { /* Resume validates the authoritative manifest and blocks it. */ }
	}
	return {
		taskId: String(row.task_id), role: String(row.role),
		artifactId: String(row.artifact_id), mediaType: String(row.media_type),
		sourceRevision: row.source_revision === null ? null : String(row.source_revision),
		...(reference === undefined ? {} : { reference }),
		createdAt: String(row.created_at),
	};
}

function rowToWorkspaceContinuation(
	row: Record<string, unknown>,
): WorkspaceContinuationRow {
	return {
		id: String(row.id),
		taskId: String(row.task_id),
		driver: String(row.driver),
		providerVersion: String(row.provider_version),
		capabilityIdentity: row.capability_identity === null ? null : String(row.capability_identity),
		capabilityVersion: row.capability_version === null ? null : String(row.capability_version),
		opaqueToken: String(row.opaque_token),
		revision: String(row.revision),
		status: (row.override_status ?? row.status) as WorkspaceContinuationStatus,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function rowToTaskEdge(row: Record<string, unknown>): TaskEdgeRow {
	return {
		edgeId: String(row.edge_id),
		parentTaskId: String(row.parent_task_id),
		childTaskId: row.child_task_id === null ? null : String(row.child_task_id),
		ordinal: Number(row.ordinal),
		relationship: row.relationship as ChildRelationship,
		status: (row.override_status ?? row.status) as ChildEdgeStatus,
		handoffArtifactId: String(row.handoff_artifact_id),
		checkpointArtifactId:
			row.checkpoint_artifact_id === null
				? null
				: String(row.checkpoint_artifact_id),
		workspaceContinuationId:
			row.workspace_continuation_id === null
				? null
				: String(row.workspace_continuation_id),
		createdAt: String(row.created_at),
		claimedAt: row.claimed_at === null ? null : String(row.claimed_at),
		completedAt: row.completed_at === null ? null : String(row.completed_at),
	};
}

// ─── Standalone recovery row helpers (M5.5, ADR seam 1) ─────────────

/** One recovery row joined with its status overlay (the overlay carries
 *  later claim/phase transitions additively; read via effective phase). */
function recoveryRow(db: DatabaseSync, runId: string): Record<string, unknown> | undefined {
	return db.prepare(
		`SELECT r.*, o.phase AS override_phase
		 FROM standalone_recovery r
		 LEFT JOIN standalone_recovery_status_overrides o ON o.run_id = r.run_id
		 WHERE r.run_id = ?`,
	).get(runId) as Record<string, unknown> | undefined;
}

function rowToRecoveryStatus(row: Record<string, unknown>): RecoveryStatus {
	return {
		runId: String(row.run_id),
		taskId: String(row.task_id),
		specHash: String(row.spec_hash),
		predecessorRunId: row.predecessor_run_id === null ? null : String(row.predecessor_run_id),
		successorRunId: row.successor_run_id === null ? null : String(row.successor_run_id),
		phase: (row.override_phase ?? row.phase) as RecoveryPhase,
		resumeAllowed: Number(row.resume_allowed) === 1,
		blockedReason: row.blocked_reason === null ? null : (row.blocked_reason as RecoveryBlocker),
		workspaceStateId: row.workspace_state_id === null ? null : String(row.workspace_state_id),
		continuationRecordId: row.continuation_record_id === null ? null : String(row.continuation_record_id),
		capPolicyId: String(row.cap_policy_id),
		createdAt: String(row.created_at),
		expiresAt: String(row.expires_at),
		engineVersion: String(row.engine_version),
		workspaceCapabilityId: row.workspace_capability_id === null ? null : String(row.workspace_capability_id),
	};
}

/** Resumable rows must carry complete validated identities; nothing here
 *  admits a body. `capPolicyId` follows the shared cap-policy vocabulary. */
function validateStandaloneRecoveryIdentities(input: NewStandaloneRecovery): void {
	if (!input.runId || !input.taskId || !input.engineVersion || !input.workspaceStateId ||
		!input.continuationRecordId || !input.workspaceCapabilityId)
		throw new Error("recovery record requires run, task, engine, workspace and continuation identities");
	for (const [value, field] of [
		[input.runId, "run"], [input.taskId, "task"], [input.workspaceStateId, "workspace state"],
		[input.continuationRecordId, "continuation record"], [input.workspaceCapabilityId, "workspace capability"],
	] as const) {
		if (value.length > 256) throw new Error(`recovery ${field} identity exceeds the supported bound`);
	}
	if (input.engineVersion.length > 128)
		throw new Error("recovery engine version exceeds the supported bound");
	requireArtifactIdentity(input.specHash, "recovery spec hash");
	CapPolicyIdSchema.parse(input.capPolicyId);
	if (!Number.isFinite(Date.parse(input.expiresAt)))
		throw new Error("recovery record expires_at must be a valid timestamp");
}

// ─── Workflow approvals (human gate, planning-only workflow) ──────────

/** One workflow_approvals row (dagId → approved flag + last update). */
export interface WorkflowApprovalRow {
	dagId: string;
	approved: boolean;
	updatedAt: string;
}

// ─── Boot reconciliation policy (pure, unit-testable) ────────────────

/** Statuses that indicate a task was mid-flight when the daemon died. */
export const IN_FLIGHT_STATUSES: TaskStatus[] = [
	"planning",
	"executing",
	"verifying",
	"reviewing",
];

export function isInFlight(status: TaskStatus): boolean {
	return (IN_FLIGHT_STATUSES as string[]).includes(status);
}

export type ReconcileDecision =
	{ action: "keep" } | { action: "requeue" } | { action: "fail" };

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
	return task.retryCount < task.maxRetries
		? { action: "requeue" }
		: { action: "fail" };
}
