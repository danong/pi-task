# pi-task-v2 — Subsystems

Companion to the [contract](pi-task-v2.md). Everything implementation-shaped:
kernel interfaces, payload schemas, ledger DDL, the TaskPlugin/TaskGateway
contract, and rejected alternatives. Nothing here is normative until the
contract references it.

## 1. Kernel interfaces

Six seams. Each is one file, one interface, hermetically testable in
isolation, no shared mutable state (the FR-2/FR-11 buildability rule).

```typescript
// 1. Workspace isolation — v1's jj ladder ports behind this interface.
export interface WorkspaceContext {
  taskId: string;
  hostPath: string;
  containerPath?: string;
  branchName: string;
  status: "provisioning" | "active" | "merging" | "cleaning_up" | "released" | "orphaned";
}

export interface WorkspaceDriver {
  name: string;
  isSupported(): Promise<boolean>;
  createWorkspace(taskId: string, parentBranch?: string): Promise<WorkspaceContext>;
  mergeWorkspace(context: WorkspaceContext): Promise<{ success: boolean; conflicts?: string[] }>;
  cleanupWorkspace(context: WorkspaceContext): Promise<void>;
}
// JujutsuWorkspaceDriver (first): ports extensions/task/workspace.ts VERBATIM —
// AI-authored task base, atomic revset-union squash tracked by CHANGE id,
// per-file union resolution, assertMerged consistency gate, preserved
// workspaces + recovery-guide failure artifacts, bounded execJj timeouts,
// --ignore-working-copy for read-only calls.
// GitWorktreeDriver, DirectDirectoryDriver follow.

// 2. Project environment execution
export interface EnvironmentDriver {
  name: string;
  resolvePath(context: WorkspaceContext): Promise<PathResolution>;
  exec(command: string, args: string[], options: ExecOptions): Promise<ExecResult>;
}
// Environment ladder (contract FR-5): bare host (fallback) →
// HostMiseEnvironmentDriver (mise exec --, project-pinned tool versions
// without containers) → DockerEnvironmentDriver (recommended where
// available: devcontainer image or ephemeral mount; WorkspaceContext
// .containerPath carries the in-container path). Capability detection
// selects the best available; the daemon itself stays toolchain-free.

// 3. Context compression
export interface ContextCompressor {
  name: string;
  isSupported(): Promise<boolean>;
  generateOutline(filePath: string, options: { maxTokens: number; cursor?: string | null }): Promise<OutlinePage>;
  extractSymbols(filePath: string, symbolQuery: string): Promise<string>;
}
// TreeSitterCompressor → CtagsCompressor → RegexCompressor fallback chain.

// 4. Verification
export interface VerificationDriver {
  name: string;
  runVerification(context: WorkspaceContext, commands: string[]): Promise<VerificationResult>;
}

// 5. Lifecycle & trigger plugins — contract in §3.
export interface TaskPlugin { /* §3 */ }
```

## 2. Payload schemas (Zod)

The five boundary artifacts (contract FR-3). Deterministic serialization rule: fields
that vary per attempt (timestamps, session ids, run ids) are ledger-only and
never enter prompt serialization.

```typescript
export const TargetFileSchema = z.object({
  hostPath: z.string(),
  astOutline: z.string().max(800), // ≈200 tokens; compressor enforces
  outlineTruncated: z.boolean(),
  outlineCursor: z.string().nullable(),
});

export const ExecutionBundleSchema = z.object({
  taskId: z.string(),
  goal: z.string(),
  targetFiles: z.array(TargetFileSchema).max(50),
  requirements: z.array(z.string()),
  verificationCommands: z.array(z.string()),
  modelAssignment: ModelAssignmentSchema.optional(),
});

export const HandoffBundleSchema = z.object({
  taskId: z.string(),
  uncommittedDiffSummary: z.string().max(60000), // capFixOutput semantics apply per failure
  filesTouched: z.array(z.string()),
  verificationFailures: z.array(z.object({
    command: z.string(),
    reason: z.string().optional(),
    stderrTail: z.string(),
  })),
  attemptNumber: z.number().int().min(1),
});
// precedingSessionId removed from the serialized schema — ledger-only field
// (deterministic-prefix rule, contract NFR-4).

export const YieldSchema = z.object({
  files_changed: z.array(z.string()),
  summary: z.string(),
  commit_ids: z.array(z.string()),
  deviations: z.array(z.string()), // empty if none; feeds fork_deviation_rate
});

export const TaskReceiptSchema = z.object({
  taskId: z.string(),
  verdict: z.enum(["ship", "escalate", "failed"]),
  filesChanged: z.number(),
  commitIds: z.array(z.string()),
  turns: z.number(),            // NEW: router feedback
  costUsd: z.number(),          // NEW: router feedback
  bundleHit: z.boolean().nullable(), // NEW: mode-(b) telemetry; null = bundle not used
});

export const ModelAssignmentSchema = z.object({
  model: z.string().optional(), // overrides per-role default
  lane: z.enum(["interactive", "flex", "batch"]).optional(),
});
```

## 3. TaskPlugin & TaskGateway contract

The buildability contract — specified BEFORE any plugin code exists. A plugin:

1. **One file, one default export implementing `TaskPlugin`.** Loaded by
   path from config (`[plugins]` in task.toml); no discovery magic.
2. **One hermetic test** exercising its real path (contract FR-11) — a plugin whose
   test only covers pure helpers does not pass review.
3. **No shared mutable state**: all interaction with the engine goes through
   the gateway events and the typed transform hooks below.

```typescript
export interface TaskGateway {
  emit(event: TaskLifecycleEvent): void;
  on(pattern: EventPattern, handler: (event: TaskLifecycleEvent) => void): Unsubscribe;
  // Narrow, typed reads — never transcripts:
  getTaskState(taskId: string): Promise<TaskLedgerRow>;
  getManifest(taskId: string): Promise<RunManifest>;
}

export interface TaskPlugin {
  name: string;
  registerTriggers?(gateway: TaskGateway): void;
  transformExecutionBundle?(bundle: ExecutionBundle): Promise<ExecutionBundle>;
  transformHandoff?(handoff: HandoffBundle): Promise<HandoffBundle>;
  onLifecycleEvent?(event: TaskLifecycleEvent): void;
}
```

Event vocabulary (initial set; additive-only evolution, versioned):
`task.queued`, `task.routed`, `session.spawned`, `session.yielded`,
`session.exhausted`, `verify.completed`, `review.completed`,
`merge.completed`, `merge.conflict`, `task.completed`, `task.failed`,
`task.escalated`.

Prune profiles (continuation + review forks) are pluggable scorers with the
same discipline: pure functions over a transcript-shaped input, returning the
pruned form; hermetically testable; selected by config.

## 3b. ControlSurface contract

Control surfaces (pi TUI, Discord bridge, CLI, CI/cron) are protocol
adapters over hosted sessions — never session owners. Separate from
TaskPlugin because the lifecycle differs: long-lived bidirectional streaming
vs task-scoped hooks.

```typescript
export type SubscriptionLevel = "delta" | "digest" | "receipts";

export interface SurfaceCapabilities {
  /** Can render interactive PermissionRequests (TUI: yes; cron: no). */
  interactivePermissions: boolean;
  /** Can carry file/image attachments on UserMessage. */
  attachments: boolean;
  /** Tolerated event latency — guides daemon batching. */
  latencyToleranceMs: number;
}

/** A live subscription: typed events downstream, commands upstream.
 *  Events are the union described below; each subscription level delivers
 *  a coarsening view of the SAME stream (delta ⊃ digest ⊃ receipts). */
export interface SurfaceStream {
  events: AsyncIterable<
    | { type: "TurnDelta"; text: string }
    | { type: "ToolActivity"; tool: string; argsPreview: string; phase: "start" | "done"; durationMs?: number }
    | { type: "PermissionRequest"; requestId: string; action: string; detail: string }
    | { type: "Receipt"; receipt: TaskReceipt }
    | { type: "Escalation"; taskId: string; reason: string; detail: string }
    | { type: "StatusSnapshot"; model: string; tier: string; activeTasks: number }
  >;
  send(command:
    | { type: "UserMessage"; text: string; attachments?: string[] }
    | { type: "Approve"; requestId: string; grant: boolean }
    | { type: "Interrupt"; scope: "turn" | "task" }
    | { type: "InvokeCommand"; name: string; args?: Record<string, unknown> }
  ): void;
  close(): void;
}

export interface ControlSurface {
  name: string;
  /** Subscribe to a hosted session's event stream at a QoS level:
   *  "delta" (token-level, TUI), "digest" (coarse, Discord),
   *  "receipts" (escalations + verdicts only, cron/CI). */
  connect(sessionId: string, level: SubscriptionLevel): SurfaceStream;
  capabilities(): SurfaceCapabilities;
}
```

Design consequences worth stating once:

- **Slash commands invert.** Extensions register commands engine-side;
  surfaces discover them via a schema event and render natively (TUI
  autocomplete, Discord native slash commands). The extension model is
  untouched; surfaces stay dumb.
- **Permission prompts become protocol.** A PermissionRequest answered by
  Approve/Deny lets permission POLICY move engine-side (per session type and
  surface trust) — which is also what headless/zero-touch sessions need:
  auto-approve policy plus an escalation queue instead of a human modal.
- **Multi-surface multiplexing** falls out of hosting: broadcast events to
  all subscribers of a session, serialize inputs first-writer-wins per turn.
- **Migration:** through Phase C the familiar pi-session-with-extension
  remains the primary surface; the remote-TUI cutover is the LAST surface to
  flip. The contract above must exist first — it defines what a "session
  event" means for every other surface.

## 4. Ledger schema (SQLite)

Portable DDL (no SQLite-only features — future-doc constraint).

```sql
CREATE TABLE tasks (
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

CREATE TABLE micro_sessions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('worker', 'reviewer')),
    status TEXT NOT NULL CHECK (status IN ('active', 'yielded', 'exhausted', 'crashed')),
    turn_count INTEGER DEFAULT 0,
    yield_payload JSON,
    last_heartbeat_at DATETIME  -- child processes only (detached/scheduler);
                                -- NULL for in-process sessions (no pid exists)
);

CREATE TABLE routing_feedback (
    -- Per-repo telemetry feeding the route function (bundle_hit_rate,
    -- fork_deviation_rate). The system learns from manifests, not folklore.
    repo TEXT NOT NULL,
    mode TEXT NOT NULL,
    hit INTEGER NOT NULL,        -- 1 = bundle grounded turn 1 / fork clean
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

(`workspaces` table as in v3.1; timestamps/session ids live here, not in
prompt-bound payloads.)

## 5. Alternatives considered

| Approach | Rejection reason |
| :---- | :---- |
| **AST-aware 3-way merge** | Research-grade problem replacing a battle-tested ladder that took many commits to harden (see jj history: divergent changes, stale squash targets, union-tool aborts). Textual 3-way + union + LLM residual micro-session is what actually works. Revisit only after suite 03 shows merge failures dominating. |
| **Persistent planner session/role** | Would own the system's deepest context and be the hardest thing to prune; its output (a bundle) is exactly what a thin one-shot function or an in-session prewalk phase produces without the standing state. |
| **Hard 3–5 turn budgets** | Below the cheap-model floor (cheap models spend 4–10 turns even on trivial specs — reproducible via the bench harness). Causes systematic exhaustion→retry loops costing more than they save. Superseded by contract FR-7 per-attempt budgets. |
| **Big-bang rewrite** | Destroys the active harness used to build v2. Four-phase migration instead. |
| **Monolithic server container** | Image bloat + cross-repo toolchain conflicts; EnvironmentDrivers exist for this. |
| **In-process extension forever (v1)** | Inverted ownership; fixed by the daemon (contract FR-1) while keeping the extension as the first client. |
