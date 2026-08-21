# **Architecture Design Document: pi-task-v2**

**Author:** danong **Status:** Proposed **Version:** 3.1 **Date:** August 2026

> Main body is the overview contract. Code samples, payload schemas, SQL DDL,
> alternatives, and deferred work live in Appendices A–E.

## **1. Background**

### **1.1 The Problem**

Multi-LLM agent chains (scout → planner → worker) duplicate enormous context at every process boundary: each downstream session re-reads files and re-parses dependency graphs, wasting 100K+ tokens per workflow turn. Prose-based plan handoffs compound the waste — receivers parse unstructured text, reconstruct invocation parameters, and make control-flow decisions that deterministic software executes more reliably.

### **1.2 Lessons from pi-task-v1**

pi-task-v1 ran as an extension inside a Pi agent session, delegating work via a `task()` tool over JSON-RPC. What worked: hard bash-exit-code verification gates, jj workspace isolation, a private Discord bridge. Structural flaws that motivate v2:

> 1. **Inverted ownership** — client crashes/reloads killed background tasks mid-flight.
> 2. **Nested RPC overhead** — stdin/stdout serialization, fd leaks, brittle recovery.
> 3. **Monolithic environment pollution** — one container's toolchain conflicted across target projects.
> 4. **Main-session context inflation** — un-pruned transcripts across multi-task runs.

**Disposition of v1 mechanisms:**

| v1 Mechanism | Disposition in v2 |
| :---- | :---- |
| Hard verification gates (bash exit codes) | **Kept** — FR-6 |
| Mid-session frontier→cheap model swap | **Superseded** — separate planner/worker sessions achieve the same economics structurally (§3.1) |
| bwrap sandboxing | **Shifted** — abstracted behind EnvironmentDriver (§3.6) |
| Hash-gated annotated code maps | **Deferred** — underperformed in practice; revisited as Appendix E.2 |
| Always-on adversarial review | **Deferred** — optional/on-demand only; see Appendix E.1 |
| session_id cache threading | **Kept** — generalized into NFR-5 cache-affine prefixes |
| Batch / flex provider lanes | **Kept** — lane-aware model assignment (§3.1, FR-8) |
| /plan · /build workflow modes | **Kept** — Milestone 5, workflow modes over the task graph |

## **2. Requirements**

### **2.1 Problem-to-Requirement Mapping**

| v1 Bottleneck | Requirement | Primary Mechanism |
| :---- | :---- | :---- |
| Client disconnect kills tasks | FR-1 / NFR-1 | Root orchestrator daemon; SQLite boot reconciliation |
| 100K+ redundant reads per worker | FR-2 / NFR-2 | Paginated AST outlines (≤200 tok/file); JIT ExecutionBundle |
| Unbounded loops & transcript bloat | FR-3 / FR-4 | 3–5 turn budgets; Zod yields; typed HandoffBundle |
| Cross-project toolchain conflicts | NFR-3 | Ephemeral project containers (EnvironmentDriver) |
| Workspace/tooling lock-in | FR-7 | Five pluggable driver/plugin abstractions |
| Unbounded spend | NFR-4 | COR < 0.20; cost ∝ diff size |
| Cold-cache re-reads across retries | NFR-5 | Deterministic cache-affine request prefixes |
| Cost/latency inflexibility | FR-8 | Per-role model routing with interactive/flex/batch lanes |

### **2.2 Functional Requirements**

> * **FR-1 (Standalone Host Orchestrator):** Persistent Node.js root process embedding Pi as in-memory SDK sessions (@mariozechner/pi-agent-core). No child RPC processes.
> * **FR-2 (Execution Bundles & Paginated Outlines):** Planning yields a structured ExecutionBundle whose per-file AST outlines are capped at ~200 tokens. Workers begin editing on Turn 1 with zero exploratory reads.
> * **FR-3 (Bounded Micro-Sessions):** Hard 3–5 tool-turn budget; workers yield Zod-validated payloads; sessions are destroyed on yield or exhaustion.
> * **FR-4 (Handoff Bundles):** On verification failure, uncommitted diffs, touched files, and error tails pass forward via a typed HandoffBundle.
> * **FR-5 (Merge Ladder & Tiered Conflict Resolution):** Changes combine via AST-aware 3-way merge. Residual conflicts surface as structured data → LLM resolution micro-session → human escalation.
> * **FR-6 (Hard Verification Gates):** Completion is gated by real bash exit codes executed post-merge.
> * **FR-7 (Pluggable Drivers):** Workspaces (jj, git worktree, plain directory), Environments (Docker, mise, host), and Compressors (Tree-sitter, ctags, regex) decoupled behind TypeScript interfaces.
> * **FR-8 (Model Routing & Lanes):** Model assignment is per-role configuration with defaults. Requests may target interactive, flex, or batch lanes; unsupported lanes degrade to interactive.

### **2.3 Non-Functional Requirements**

> * **NFR-1 (Crash Recovery):** Task graphs and session states persist in `.pi/tasks.db`; automatic reconciliation on daemon reboot.
> * **NFR-2 (Context Efficiency):** Worker COR = grounding tokens ÷ total tokens must stay **< 0.20**.
> * **NFR-3 (Zero Host Pollution):** The orchestrator requires no target-project compilers, SDKs, or build tools on the host.
> * **NFR-4 (Cost Ceiling):** Token cost scales with diff size, not repository size. Every optimization degrades gracefully to a single-model, git-only run.
> * **NFR-5 (Cache Affinity):** Request prefixes are deterministic per task. Retries append HandoffBundles to an identical serialized prefix; provider cache/session handles are threaded through SDK session config where supported.

### **2.4 Guiding Principles**

> 1. **Code orchestrates, LLMs judge.** Spawning, routing, merging, and gating are deterministic code; LLMs are invoked only where understanding is required.
> 2. **Graceful degradation.** Every optimization disables cleanly under budget or environment constraints.
> 3. **Scale via seams.** New capabilities — transports, providers, tenancy, billing — attach as drivers or plugins. The core kernel stays small.

### **2.5 Scale-Readiness Constraints**

Monetization is explicitly out of scope. These constraints cost nothing now; they exist so that future scale (hosted, multi-tenant, open-weight models) never requires a rewrite:

> 1. **Portable SQL.** The DDL avoids SQLite-only features; the ledger must migrate to Postgres without rewrites.
> 2. **Transport behind an interface.** Local sockets/WebSockets now; an authenticated remote transport later attaches as a plugin, not a core change.
> 3. **Meter everything.** Tokens and cost are recorded per task and per session in the ledger — the future source of truth for billing or analytics.
> 4. **Models are endpoints.** Provider changes are configuration. Self-hosted open-weight providers attach without core changes.

## **3. Architecture**

### **3.1 Host Orchestrator & Model Role Routing**

```text
┌────────────────────────────────────────────────────────────┐
│                pi-task-v2 Orchestrator Host                │
│             (Node.js App / State Machine Kernel)           │
│                                                            │
│  - Task Graph & SQLite Ledger State                        │
│  - Abstract Workspace Engine (WorkspaceDriver Interface)   │
│  - Environment Execution Engine (EnvironmentDriver)        │
│  - Plugin & Driver Middleware Manager                      │
└──────────────┬──────────────────────────────┬──────────────┘
               │                              │
               ▼                              ▼
┌──────────────────────────────┐┌──────────────────────────────┐
│  Planner Session (SDK)       ││  Worker Micro-Session (SDK)  │
│  - Planner model             ││  - Worker model              │
│    (default: deepseek-       ││    (default: deepseek-       │
│     v4-flash)                ││     v4-flash)                │
│  - Decomposes goals & specs  ││  - Pristine session          │
│  - Builds ExecutionBundles   ││  - Strict 3–5 turn limit     │
└──────────────────────────────┘└──────────────────────────────┘
```

**Cheap by default.** Roles are structurally separate — distinct session shapes, prompts, and turn budgets — but model class per role is *configuration, not architecture*. The default is `deepseek-v4-flash` for every role; single-model operation changes no interfaces or invariants. Upgrade per role when measured quality demands it (e.g., Gemini Flash/Pro, Claude, GPT class — planner first, workers for hard diffs).

**Lanes (FR-8):** assignments may request `interactive` (default), `flex` (relaxed latency, lower cost), or `batch` (async bulk). Lanes are provider capabilities: drivers report what's supported, and unsupported lanes degrade to interactive. Default lane policy — planner/worker turns run interactive; verification re-runs, benchmark sweeps, cron audits, and E.2 cache regeneration use flex/batch where available.

**Key advantages:** process stability (client drops never kill execution), zero RPC serialization (sessions instantiated in-memory), pristine worker lifecycles (no history accumulation).

### **3.2 Kernel & Driver System**

Five abstractions form the kernel (full signatures in **Appendix A**):

> 1. **WorkspaceDriver** — isolated workspace contexts (jj / git worktree / direct directory).
> 2. **EnvironmentDriver** — command execution inside the project's runtime, with path resolution and timeouts.
> 3. **ContextCompressor** — paginated AST outlines and symbol extraction.
> 4. **VerificationDriver** — post-merge gate execution with structured failure results.
> 5. **TaskPlugin** — lifecycle triggers, bundle transforms, event subscription.

**Integration modes** (all subscribe via TaskGateway): Discord bridge (threads/embeds), CLI/TUI client (Unix socket or `ws://localhost:8080`), CI/CD runner (PR webhooks, inline annotations), scheduled cron (recurring audits). *CI/CD and cron modes ship after Milestone 3.*

### **3.3 Context Engineering**

```text
[Raw Codebase] ──► [ContextCompressor] ──► [Paginated ExecutionBundle] ──► [Micro-Session Worker]
                         │                                                      │
            (Tree-sitter / ctags / regex)                           Zod-validated yield
                         │                                                      │
[SQLite Ledger] ◄─────────┴────────── [Deterministic Merge & Verification] ◄────┘
```

> 1. **Paginated symbol outlines:** ≤200 tokens per file; cursor-based continuation replaces whole-file dumps.
> 2. **Execution Bundles:** target paths + line ranges, minimal type definitions, explicit requirements, and verification commands — injected into the worker's initial system prompt, so the worker is fully grounded on Turn 1. Bundles serialize deterministically (NFR-5) so retries reuse identical prefixes.
> 3. **Bounded micro-sessions:** 3–5 turns; on failure, a HandoffBundle carries diffs, touched files, and error tails to the next attempt (retry count bounded per task).
> 4. **Tool output distillation:** test/lint/build output is filtered to errors, failure lines, and file offsets; success noise is stripped.

### **3.4 State Persistence**

SQLite ledger `.pi/tasks.db` holds `tasks`, `micro_sessions`, and `workspaces` (**DDL in Appendix C**, portable per §2.5). Heartbeats detect dead sessions; boot reconciliation re-hydrates or reaps crashed runs. Retries are bounded per task (default max 2).

### **3.5 Workspaces & Merge Ladder**

**Workspace drivers:** JujutsuWorkspaceDriver (preferred — non-blocking snapshot isolation), GitWorktreeDriver (standard-git fallback), DirectDirectoryDriver (zero-dependency fallback).

**Merge ladder (FR-5):**

> 1. **Deterministic:** AST-aware merge → standard text 3-way merge → automatic union resolution of whitespace/comment-only overlaps.
> 2. **LLM:** residual conflicts surface as a structured ConflictSet (file paths, hunk ranges, both sides' content); a bounded conflict-resolution micro-session attempts a fix.
> 3. **Human:** unresolved conflicts escalate — task status → `escalated`, ConflictSet attached, gateway notifies configured channels.

### **3.6 Runtime Isolation**

**EnvironmentDrivers:** DockerEnvironmentDriver (recommended — attaches to the repo's devcontainer image or spawns an ephemeral container, mounting the workspace volume), HostMiseEnvironmentDriver (`mise exec --` per workspace, enforcing `.mise.toml` tool versions without containers), DirectHostEnvironmentDriver (bare-host fallback). The orchestrator process stays lean and toolchain-free in all cases (NFR-3).

### **3.7 Main-Session Context Contracts**

Conversational sessions record compact TaskReceipts (verdict, file counts, commit IDs — **Appendix B**) instead of free-text summaries. Pluggable multi-axis pruning scores historical turns for eviction (**Appendix A**), keeping long-running main sessions lean.

## **4. Migration & Bootstrapping (v1 → v2)**

**Rules:** non-breaking coexistence in `packages/core-v2`; v1 continues running production workflows and builds v2; a single dispatch-point router separates surfaces; cutover is incremental.

> **Port inventory first.** Before writing new code, inventory v1 modules — session/cache plumbing, verification gate, jj merge logic, Discord bridge, model-swap logic, /plan /build flows — and map each to its v2 seam (port vs. rewrite). No v1 capability is dropped without an explicit disposition (§1.2).

```text
        ┌────────────────────────────────────┐
        │      Discord Gateway Bridge        │
        └─────────────────┬──────────────────┘
                          │
        ┌─────────────────┴──────────────────┐
        │    Single Dispatch Point Router    │
        └─────────┬─────────────────┬────────┘
                  │                 │
      (default)   │                 │  (/v2 prefix)
                  ▼                 ▼
        ┌────────────────────┐   ┌────────────────────┐
        │  pi-task-v1 Engine │   │  pi-task-v2 Engine │
        │  (until Phase C)   │   │  (packages/core-v2)│
        └────────────────────┘   └────────────────────┘
```

> * **Phase A:** Port inventory; build `packages/core-v2` using pi-task-v1.
> * **Phase B:** Shadow/dry-run — v2 mirrors live v1 tasks, validating AST extraction, path resolution, and bundle generation without executing writes.
> * **Phase C:** Flip default `/task` routing to v2 once Phase B reaches parity on the §5 suites; retain `/v1` fallback.
> * **Phase D:** Deprecate and delete v1 RPC code.

`/v2` is a prefix namespace (`/v2 task …`, `/v2 status …`, later `/v2 plan …`, `/v2 build …`), so operational commands never collide with v1's command surface.

## **5. Verification & Microbenchmarking**

**Metrics:** total tokens per completed task · turns to verified fix · COR (target < 0.20) · first-pass verification rate · cost normalized per KB of diff (NFR-4) · cache hit rate on retried sessions (NFR-5).

**Suites** (harness in `packages/benchmarks`):

> * `01_single_file_bugfix` — edits confined to single methods
> * `02_multi_file_refactor` — cross-file interface updates
> * `03_large_repo_grounding` — feature additions in 100K+ LOC repositories

**Baselines:** every suite runs against three configurations with the production default model (`deepseek-v4-flash`) pinned across all: (1) baseline single long-context Pi session, (2) pi-task-v1 extension, (3) pi-task-v2 orchestrator. Model upgrades (frontier planner variants) are run as *additional* configurations, never as baseline changes. Reporters emit token/latency/cache comparison tables.

## **6. Milestones & Token Budgets**

| Phase | Scope | Target Deliverables | Budget |
| :---- | :---- | :---- | :---- |
| **M1** | Core Engine & SDK Inversion | Standalone orchestrator, SQLite ledger + boot reconciliation, `resolvePath` contract, per-role model routing with defaults | ~10M |
| **M2** | Drivers & Execution Bundles | Workspace/Environment drivers (jj, worktree, direct; Docker, mise, host), paginated compressor (≤200 tok/file), ExecutionBundle + HandoffBundle, deterministic serialization (NFR-5), distillation middleware | ~15M |
| **M3** | Plugin Kernel & Routing | TaskGateway + event pipeline, `/v2` dispatch router, CLI/TUI client | ~10M |
| **M4** | Benchmarks & Cutover | Suite harness, turn-budget/routing tuning, default cutover, v1 removal | ~15M |
| **M5** | Workflow Modes | PlanDocument schema, `/plan` planner-only mode with human review gate, `/build` DAG executor over TaskGateway | ~10M |

**Total estimated development budget:** ~60M tokens (USD cost dominated by provider pricing; expected at the low end of commodity tiers at `deepseek-v4-flash` defaults).

---

## **Appendix A: Driver & Plugin Interfaces (TypeScript)**

```typescript
// 1. Workspace Isolation Driver
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

// 2. Project Environment Execution Driver
export interface PathResolution {
  resolvedPath: string;
  translated: boolean;
}

export interface ExecOptions {
  cwd: WorkspaceContext;
  env?: Record<string, string>;
  timeoutMs: number;
}

export interface EnvironmentDriver {
  name: string;
  resolvePath(context: WorkspaceContext): Promise<PathResolution>;
  exec(command: string, args: string[], options: ExecOptions): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}

export class PathResolutionError extends Error {
  constructor(public readonly context: WorkspaceContext, reason: string) {
    super(`Cannot resolve path for task ${context.taskId}: ${reason}`);
  }
}

// 3. Context Compression & AST Indexer Driver
export interface OutlinePage {
  outline: string;
  truncated: boolean;
  nextCursor: string | null;
}

export interface ContextCompressor {
  name: string;
  isSupported(): Promise<boolean>;
  /** Paginated symbol outline; page sizes honor the ~200-token-per-file budget (§3.3). */
  generateOutline(filePath: string, options: { maxTokens: number; cursor?: string | null }): Promise<OutlinePage>;
  extractSymbols(filePath: string, symbolQuery: string): Promise<string>;
}

// 4. Verification & Safety Driver
export interface VerificationResult {
  success: boolean;
  /** Semantic outcome, e.g. "typecheck_failed", "tests_failed", "timeout". */
  reason?: string;
  failedCommand?: string;
  stderrTail?: string;
}

export interface VerificationDriver {
  name: string;
  runVerification(context: WorkspaceContext, commands: string[]): Promise<VerificationResult>;
}

// 5. Lifecycle & Trigger Plugin
export interface TaskPlugin {
  name: string;
  registerTriggers?: (gateway: TaskGateway) => void;
  transformExecutionBundle?: (bundle: ExecutionBundle) => Promise<ExecutionBundle>;
  onLifecycleEvent?: (event: TaskLifecycleEvent) => void;
}
```

## **Appendix B: Payload Schemas (Zod)**

```typescript
import { z } from "zod";

export const TargetFileSchema = z.object({
  hostPath: z.string(),
  astOutline: z.string().max(800), // ≈200 tokens @ ~4 chars/token — keep outlines small (§3.3)
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

// FR-8: model choice and lane are per-request configuration with per-role defaults.
export const ModelAssignmentSchema = z.object({
  model: z.string().optional(), // overrides the per-role default (default: deepseek-v4-flash)
  lane: z.enum(["interactive", "flex", "batch"]).optional(), // unsupported lanes degrade to interactive
});

// Per-role routing defaults — single cheap model everywhere by default (§3.1).
export const ModelRoutingDefaults = {
  planner: { model: "deepseek-v4-flash" },
  worker: { model: "deepseek-v4-flash" },
  reviewer: { model: "deepseek-v4-flash" },
} as const;

export const HandoffBundleSchema = z.object({
  taskId: z.string(),
  precedingSessionId: z.string(),
  uncommittedDiffSummary: z.string().max(60000),
  filesTouched: z.array(z.string()),
  verificationFailures: z.array(z.object({
    command: z.string(),
    reason: z.string().optional(),   // semantic outcome, matches VerificationResult.reason
    stderrTail: z.string(),
  })),
  attemptNumber: z.number().int().min(1),
});

export const TaskReceiptSchema = z.object({
  taskId: z.string(),
  verdict: z.enum(["ship", "escalate", "failed"]),
  filesChanged: z.number(),
  commitIds: z.array(z.string()),
  timestamp: z.string(),
});
```

## **Appendix C: Ledger Schema (SQLite)**

```sql
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN (
        'queued', 'planning', 'executing', 'verifying',
        'reviewing',              -- optional on-demand review (Appendix E.1)
        'completed', 'failed',
        'escalated'               -- human escalation rung of the merge ladder (§3.5)
    )),
    goal TEXT NOT NULL,
    parent_branch TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 2,
    last_heartbeat_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE micro_sessions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    worker_role TEXT NOT NULL CHECK (worker_role IN ('planner', 'worker', 'reviewer')),
    status TEXT NOT NULL CHECK (status IN ('active', 'yielded', 'exhausted', 'crashed')),
    pid INTEGER,
    turn_count INTEGER DEFAULT 0,
    max_turns INTEGER NOT NULL,
    yield_payload JSON,
    last_heartbeat_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workspaces (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    host_path TEXT NOT NULL,
    container_path TEXT,
    driver_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('provisioning', 'active', 'merging', 'cleaning_up', 'released', 'orphaned'))
);
```

## **Appendix D: Alternatives Considered**

| Approach | Mechanics | Reasons for Rejection |
| :---- | :---- | :---- |
| **In-Process Extension (pi-task-v1)** | pi-task runs inside Pi via extension hooks, communicating with workers over JSON-RPC. | Inverted ownership; tool calls block the main session loop; network drops crash active background workers. |
| **Big Bang Rewrite** | Tear down pi-task-v1 completely before writing v2. | Destroys the active development setup; removes the primary agent harness used to build the new system. |
| **Monolithic Server Container** | Install all languages, SDKs, and build tools into one massive host container. | Image size explodes; system library version conflicts arise across target repos. |
| **Hardcoded jj Workspaces** | Bake jj workspace commands directly into core engine logic. | Fails without jj installed; breaks Git-only workflows. |
| **Pure Subprocess Daemon** | Main Pi session calls external CLI subprocesses over OS processes. | Higher launch latency; complex fd piping; prone to process leakage on aborts. |

## **Appendix E: Deferred Mechanisms & Future Work**

> **E.1 On-Demand Adversarial Review.** Forked, context-inherited review session with implementation reasoning pruned out. Not an always-on gate in v2; enable per-task for complex or high-risk changes, or invoke via `/v2 review`. Uses the existing `reviewer` session role.

> **E.2 Hash-Keyed Context Injection Cache.** Successor to v1's annotated code map: persistent per-file AST annotations keyed by content hash, regenerated only when the hash changes, injected into both conversational and worker sessions for faster ramp-up and fewer duplicate reads. v1's version underperformed in practice; retry with finer-grained invalidation and stricter per-file budgets.

> **E.3 Cross-Task Episodic Memory.** Persist verified insights per repository (build quirks, test layouts, project gotchas) across independent tasks, with circuit-breaker re-testing to expire stale entries.

> **E.4 Multi-Tenant SaaS Isolation.** Wrap worker execution in microVM sandboxes (Firecracker / Bubblewrap) for untrusted or multi-tenant workloads. *Blocked only by the §2.5 constraints, not by any core design decision.*

> **E.5 Automated Cost-Aware Model Selection.** Route sub-tasks dynamically based on live API latency, context-window pricing, and task-difficulty scoring. *Supersedes manual per-role upgrades; builds on the FR-8 lane abstraction.*
