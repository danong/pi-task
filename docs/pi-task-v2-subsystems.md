# pi-task-v2 — Subsystems

Companion to the [contract](pi-task-v2.md). Everything implementation-shaped:
kernel interfaces, payload schemas, ledger DDL, the TaskPlugin/TaskGateway
contract, and rejected alternatives. Nothing here is normative until the
contract references it.

## 1. Kernel interfaces

Seven seams. Each is one file, one interface, hermetically testable in
isolation, no shared mutable state (the FR-2/FR-11 buildability rule);
seam 7 (continuation pruning) attaches to the handoff path without touching
the session host.

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
  /** The driver's integration mode when it declares one; undefined =
   *  single-workspace driver (cannot run the parallel pipeline). */
  readonly integrationMode?: IntegrationMode | undefined; // "task-base" | "feature-branch"
  isSupported(): Promise<boolean>;
  /** Fetch remotes / pre-flight checks. Non-fatal failures must not throw. */
  prepare?(): Promise<void>;
  createWorkspace(taskId: string, parentBranch?: string): Promise<WorkspaceContext>;
  mergeWorkspace(context: WorkspaceContext): Promise<{ success: boolean; conflicts?: string[] }>;
  cleanupWorkspace(context: WorkspaceContext): Promise<void>;
  prepareIntegrationBase?(goal: string): Promise<string>; // task-base mode
  combine?(baseChangeId: string, contexts: readonly WorkspaceContext[]): Promise<CombineOutcome>;
  publishBookmarks?(contexts: readonly WorkspaceContext[]): Promise<string[]>; // feature-branch
}

export interface CombineOutcome {
  commitId: string;
  conflicts: string[];
  filesChanged: number; // honest filesChanged for aggregate receipts
}

/** Required shape for task-base runs — runParallelTask narrows to this and
 *  fails typed when a driver lacks the capability (never silent casts). */
export interface TaskBaseWorkspaceDriver extends WorkspaceDriver {
  integrationMode: IntegrationMode;
  prepareIntegrationBase(goal: string): Promise<string>;
  combine(baseChangeId: string, contexts: readonly WorkspaceContext[]): Promise<CombineOutcome>;
  /** Place the main working copy on the integrated tree so FR-6's gate
   *  runs on merged work (the FR-6 linchpin). */
  materialize(baseChangeId: string): Promise<void>;
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

// 7. Continuation pruning — turn-limit handoffs (contract §5.3(c), FR-7).
// One file/interface: src/continuation/pruner.ts in packages/core-v2.
// Pure over transcript-shaped entries — no LLM, no AgentSession reach-in;
// hermetically testable; selection is config-driven by scorer name.
export interface ContinuationEntry {
  role: string;
  content?: unknown;
  toolName?: string;
  /** Optional pre-computed token estimate; derived from content size
   *  when omitted (≈4 utf-8 bytes per token, matching the runner's
   *  grounding estimate so budgets stay comparable). */
  tokens?: number;
}

/** Second-layer signal (R3 of the continuation mode): a fork that has
 *  ALREADY pruned once must not re-prune identically on immediate retry.
 *  attemptNumber rides the ledger envelope (never prompt-bound). */
export interface ScorerContext {
  attemptNumber?: number;      // >1 = retry budget partially spent
  alreadyPruned?: boolean;     // predecessor fork was pruned
  retryBudgetSpent?: number;   // alternative proportional shape
}

export type ContinuationScorer = (
  entries: readonly ContinuationEntry[],
  budgetTokens: number,
  context?: ScorerContext,
) => ContinuationEntry[];

// Shipped scorers (registry is config-selected via selectScorer(name);
// unknown names fail typed instead of silently defaulting):
//   recencyTool — recency × position + tool-use bonus (DEFAULT)
//   uniform     — flat score, recency tie-break (oldest dropped first)
// Both enforce shared invariants in one greedy budget pass:
//   • total kept tokens ≤ budgetTokens
//   • original ordering preserved (kept entries returned in order)
//   • at least one toolResult survives whenever the input contains one
// On the retry signal both scorers shift their keep-window forward
// (recencyTool drops the oldest entry from candidacy outright) so the
// second-layer fork never re-prunes byte-identically.
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
// Bundle-mode implementation (contract §5.3b implemented shape):
// building lives in grounding/bundle.ts as a PURE one-shot operation —
// assemble + schema-validate + content-hash over the deterministic
// serialization (`hashExecutionBundle`, namespaced by format version),
// with NO routing or session knowledge. Choosing to USE a bundle stays
// in the router (per-repo hit-rate telemetry gates planMode="bundle")
// and the runner (attaches grounding + advertises TaskReceipt.bundleHit:
// true = shipped focused inside the target set; false = any miss — empty
// bundle, worker drift, failed run, failing verification; null = unused).
// Every miss lands in routing_feedback as hit=0 so a never-tried path
// counts its failures instead of silence.

export const HandoffBundleSchema = z.object({
  taskId: z.string(),
  uncommittedDiffSummary: z.string().max(60000), // capFixOutput semantics apply per failure
  filesTouched: z.array(z.string()),
  verificationFailures: z.array(z.object({
    command: z.string(),
    reason: z.string().optional(),
    stderrTail: z.string(),
  })),
});
// precedingSessionId AND attemptNumber are ledger-only fields (carried on
// the envelope, never prompt-bound): a retried handoff appends byte-
// identical content to an identical prefix (deterministic-prefix rule,
// contract NFR-4).

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
  inputTokens: z.number(),      // NFR-3 measured usage (SDK stats())
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cor: z.number(),              // grounding ÷ total input tokens
  bundleHit: z.boolean().nullable(), // mode-(b) telemetry; null = bundle not used
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
pruned form; hermetically testable; selected by config. The continuation
profile ships first (see seam 7 above); the review profile reuses the same
`ContinuationScorer` shape once the reviewer forks move behind the gateway.

### 3a. Review-fork file budget (second pluggable prune scorer)

The review side of fork-and-prune: a bounded FILE budget that thins the
diff context a reviewer fork receives so parallel reviews finish within
the same cost envelope as execution. Implemented in
`packages/core-v2/src/grounding/review-fork.ts`; symmetric with the
continuation scorer (changed set + anchors/key files + caps → pruned
subset) so both can be swapped/configured.

```typescript
export interface FileEntry { path: string; bytes: number }
export interface FileBudget { maxFiles?: number; maxBytes?: number } // undefined = unbounded

export interface ReviewForkPruneInput {
  /** Union changed files — diff(base..merged) after the atomic squash. */
  files: readonly FileEntry[];
  /** Anchor / key files — never dropped when present. */
  anchors?: readonly string[];
  keyFiles?: readonly string[];
  /** The attempt under review's own changed files — never hidden. */
  attemptFiles?: readonly string[];
  budget: FileBudget;
}

export interface ReviewForkScorer {
  name: string;                       // config-selection key
  prune(input: ReviewForkPruneInput): {
    kept: FileEntry[]; dropped: FileEntry[]; keptBytes: number;
  };
}
// Default implementation: defaultReviewForkScorer ("bounded-file-budget")
// via pruneReviewFiles — mandatory files (anchors + keyFiles + attemptFiles)
// are pinned; optional files fill remaining budget lexicographically; caps
// bind ONLY optional files (a mandatory set alone over cap still ships).
```

Union-after-merge invariant (contract §5.5): when N workers' diffs are
squashed into the integration base, "changed files" is diff(base..merged)
— every worker at once. A reviewer for worker k therefore passes k's own
diff through `attemptFiles`, and the scorer never drops those paths even
when the union dwarfs the budget; per-worker and combined-tree views of the
same path dedupe to one entry.

Daemon wiring: `runParallelTask`
(`packages/core-v2/src/daemon/parallel.ts`) already computes the pre-merge
per-workspace file union (`workspaceFileChanges(base, ctx)`) for its
consistency gate and returns `mergedCommitId` on success — the review step
feeds exactly those inputs to the selected `ReviewForkScorer`: the union
diff base..merged as `files`, the spec's anchor/key files, and the attempt
under review's changed files from its receipt/yield. Budget tiers select
the scorer by name (default off-switch: an unbounded budget keeps every
file — graceful degradation, contract NFR-2). Hermetic suite:
`packages/core-v2/test/test-review-fork.ts`.

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
