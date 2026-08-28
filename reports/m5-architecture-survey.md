# M5 architecture survey: sequential composition, durable continuation, and self-hosting

**Scope:** implementation plan only; no implementation is proposed by this report.  Findings are ranked **Strong**, **Worth exploring**, or **Speculative** according to shipped code and hermetic evidence inspected on this branch.

## Top recommendation

**Strong — deliver one durable, strictly sequential `parent -> child` path through the existing normal task interface before wiring DAGs, parallelism, or cutover.** Add a provider-neutral child-dispatch boundary owned by the daemon. It must atomically persist a child intent, bounded handoff/checkpoint references, and a workspace continuation target before spawning the child. Resume uses that persisted record and the preserved workspace; it starts a new M4 epoch from a typed checkpoint and never reconstructs a model transcript. The CLI (and then the ordinary `task` extension adapter) should submit this same operation, not own an alternative child/session/workspace loop.

This is the smallest slice that proves the M5 product gate: a user starts a focused task on core-v2, it runs a child after its parent yields a bounded continuation request, interruption preserves inspectable work, a later normal-surface invocation resumes it, and the integrated repository produces the established receipt and trace artifacts.

## Existing foundations

### Shipped reusable foundations

| Area | Evidence and reusable ownership | Rank |
| --- | --- | --- |
| M4 control plane | `contracts/context-lifecycle.ts` supplies bounded `ContextPlan`, immutable artifact references, `WorkingCheckpoint`, and `ExecutionEpoch`; `context/checkpoint.ts` content-addresses declarative checkpoints; `context/epoch.ts` supplies deterministic interruption/retry/pressure transitions. `test-context-checkpoint.ts`, `test-context-epoch.ts`, and `test-context-integration.ts` prove bounds, persistence, raw fallback, and initial epoch injection. | **Strong** |
| Provider-neutral context boundary | `daemon/parallel.ts` plans/assembles context before session spawn and passes typed capabilities, plan, and epoch to the host. Raw is independently constructible; acquisition failure becomes bounded raw fallback. This follows the ADR’s kernel/provider split. | **Strong** |
| Isolation, integration, and recovery | `contracts/workspace-driver.ts` separates workspace semantics from jj. `workspaces/jj-driver.ts` owns task-base creation, worker finalization, atomic combine, materialization, cleanup, and `recoverFailedRun`; `failure-hygiene.ts` preserves recoverable work. `test-parallel.ts`, `test-jj-driver.ts`, and `test-failure-hygiene.ts` exercise real temporary jj repos. | **Strong** |
| Canonical run artifacts | `contracts/trace.ts`, CLI trace projection, `guards/receipts.ts`, verification evidence, and failure artifacts already provide bounded, transcript-free, provider-neutral evidence. CLI is fail-closed on receipt/trace delivery. `test-trace.ts`, `test-trace-report.ts`, and `test-cli.ts` are hermetic evidence. | **Strong** |
| Task lifecycle and execution pipeline | `daemon/parallel.ts` is the real workspace/session/finalization/combine/verify/acceptance pipeline; `daemon/isolated.ts` composes it for one worker. Worker yield is one-shot and engine VCS evidence wins over model claims. | **Strong** |
| Current external shell | `src/cli.ts` validates strict artifact policy before provider work, calls `startDaemon`, uses project-keyed external user state, runs the isolated path, emits typed progress, and delivers receipt/trace. `test-cli.ts` covers fake sessions with real jj and shell verification. | **Strong** |
| Durable basics | `ledger/store.ts` persists tasks, sessions, workspaces, routing feedback, attempt IDs, and boot reconciliation. `start.ts` runs ledger and repository hygiene reconciliation. `test-ledger.ts` proves migrations, constraints, and retry/exhaustion policy. | **Strong** |
| Bounded retry payload | `HandoffBundle` exists in `contracts/payloads.ts`; the task runner emits it on verification failure and plugins schema-revalidate transforms. The `handoff-cap` plugin and `test-plugins-handoff-cap.ts` demonstrate capping. | **Worth exploring** — useful shape, but it currently contains command/tail fields inappropriate for the canonical durable child contract. |
| Optional parallel foundation | `daemon/parallel.ts` already creates isolated workspaces, defers child completion until aggregate verification, preserves failed workspaces, and produces aggregate receipts. | **Worth exploring** — reuse its provider calls and recovery discipline, not its fan-out model, in the first sequential slice. |
| M5 workflow modules | `workflow/plan.ts`, `dag.ts`, `gate.ts`, `scheduler.ts`, and `build.ts` have pure validation, approval, ordering, concurrency limits, and skip behavior; `test-workflow-plan.ts`/`test-workflow-build.ts` cover them. | **Worth exploring** — useful future planning primitives, but their injected `runNode` seam has no real daemon/ledger/workspace binding. |
| M5 parity modules | `parity/` accepts a canonical DAG, normalizes v1/v2 results, and writes deterministic diffs; `test-parity-m5.ts` is hermetic. | **Worth exploring** — retain for shadow evidence after a real child path exists; it is not runtime execution. |
| Existing extension surface | `extensions/task/index.ts` is the established normal conversational `task` surface and owns v1 orchestration today. | **Worth exploring** — adapter target for the M5 self-hosting gate, but it must not import daemon internals or duplicate ownership. |

### Placeholders and incorrectly implied M5 completion

| Item | Actual status and required disposition |
| --- | --- |
| `workflow/build.ts` and `scheduler.ts` | **Revise/reuse later.** They are planning-only abstractions: `runNode` is injected, workflow rows contain only approvals, no child task is durable, and CLI exposes no `/plan` or `/build` surface. Do not present them as sequential runtime composition. |
| `parity/v2-build.ts` | **Retain as test/shadow tooling; revise its real executor seam after child dispatch exists.** Its default executor synthesizes zero-cost receipts and its “real” executor is caller-injected; it does not run the daemon pipeline. |
| `HandoffBundle` and `task-runner.ts` retry result | **Revise, do not use directly as child state.** It is only returned to an in-process caller after failed verification; no ledger record, artifact reference, workspace target, restart procedure, or CLI resume consumes it. Its `stderrTail` and command names belong in bounded failure artifacts, not the enduring parent-to-child prompt boundary. |
| Context checkpoint/epoch events in `parallel.ts` | **Revise runtime wiring.** Initial epochs are passed to sessions, but interruption emits only `checkpointAvailable: false`; a budget event is labelled `checkpoint.saved` without persisting a `WorkingCheckpoint`. No path loads a checkpoint to resume a workspace. |
| `TaskStatus`, `parentBranch`, and boot reconciliation | **Revise additively.** `parentBranch` is workspace/VCS lineage, not a parent task edge. Reconciliation requeues generic in-flight tasks or fails them; it cannot identify a resume intent, the last durable checkpoint, a child dependency, or an idempotent dispatch claim. |
| `runIsolatedTask` / CLI | **Reuse as child execution adapter, then revise.** It always makes one isolated task. It has no child declaration, resume selector, parent receipt, continuation target, or ordinary extension bridge. |
| Version labels | **Revise only when the complete product gate lands.** `src/version.ts` is still `M4.1`; comments calling workflow and parity “M5” describe prototypes, not shipped M5 behavior. |

### Missing runtime wiring

1. **No durable graph.** There is no `parent_task_id`, relationship kind, child ordinal, child spec hash, handoff/checkpoint artifact reference, or parent/child aggregate outcome in the ledger.
2. **No child dispatch owner.** Neither `task-runner.ts`, `parallel.ts`, `isolated.ts`, nor `workflow/build.ts` accepts a durable continuation/child request and executes it through the real pipeline.
3. **No checkpoint-to-resume path.** Checkpoints are well-typed artifacts, but no daemon operation creates one at interruption, persists its reference with workspace identity, reloads it, or starts `resumeExecutionEpoch` before a new session.
4. **No preserved-workspace selection.** Failure hygiene preserves locations/commits in failure data, yet no contract resolves a previous workspace through the configured `WorkspaceDriver`. Passing host paths from artifacts directly to the CLI would break provider neutrality.
5. **No canonical child evidence.** Trace events lack parent/relationship/continuation identities; `TaskReceipt` has no compact parent/child continuation summary. Per-worker and workflow summaries are not a durable parent receipt.
6. **No normal-surface self-hosting bridge.** The standalone `mise run v2` CLI is runnable, but the normal `extensions/task` surface cannot choose v2. The current CLI has no child/resume command.
7. **No end-to-end hermetic test.** Current tests prove individual components, parallel recovery, workflow planning, and parity normalization—not sequential parent execution, interruption between children, restart, preserved workspace reuse, and canonical receipt/trace linkage.

## Smallest end-to-end M5 slice

### User-visible contract

A parent task can declare **one ordered child continuation** after its own focused unit of work. The initial implementation should support only a single direct child (`ordinal=1`, `relationship='continuation'`), no DAG parsing, no fan-out, and no automatic retry policy. The child gets:

- its own validated task spec and task/attempt identity;
- a provider-neutral workspace continuation token that names a preserved or newly isolated workspace through the workspace driver, never a jj branch/path in a prompt;
- a bounded `ChildHandoff` containing parent receipt/verification references, changed-path evidence, declarative requirements/decisions/open questions/next actions, and immutable artifact references;
- a `WorkingCheckpoint` and a new execution epoch that references it;
- ordinary context acquisition capabilities, which may request new materialization.

The child does **not** get a transcript, arbitrary tool output, private reasoning, a parent session object, or implicit provider cache transfer.

The normal M5 command should be conceptually `task --engine v2 ...` (extension adapter) and may initially map to a CLI equivalent such as `v2 --resume <continuation-id>`. The final invocation must drive exactly the same daemon operation; command syntax is a surface decision, not a second runtime.

### Happy path

1. The normal surface validates the parent spec and selects v2. `cli.ts`/the extension adapter calls a new daemon submission operation.
2. The daemon creates the parent ledger task and runs the existing isolated pipeline through `runParallelTask(...singleTask)`. Workspace provider finalizes, integrates/materializes, verifies, accepts, and produces the existing canonical parent receipt and trace.
3. Before child dispatch, the daemon persists a typed checkpoint, a bounded handoff artifact, the provider-neutral workspace continuation record, and a `child_tasks` intent in one SQLite transaction. It records an outbox-style `ready` state only after all references exist.
4. The daemon claims that one ready child transactionally, creates a child task row, starts a new epoch from the checkpoint, and calls the existing single-worker pipeline with a workspace driver continuation method. The child is independently verified and accepted.
5. The daemon persists the child receipt/trace/failure references and atomically transitions the edge and parent to terminal `completed`, `failed`, or `escalated`. It writes a compact parent receipt that references child receipt IDs and a canonical parent trace containing relationship events.

### Interruption and recovery

- **Before durable intent:** fail the parent normally; no child is eligible to run.
- **After intent, before claim:** boot reconciliation leaves the child intent `ready`; the next normal-surface resume claims it exactly once.
- **During child session:** persist a bounded checkpoint at a safe lifecycle boundary and mark child `interrupted`; preserve the workspace through the driver. Boot reconciliation must transition it to resumable only when the checkpoint and workspace continuation record validate, otherwise terminal failed with recovery evidence.
- **After child work but before delivery:** use terminal delivery state plus existing receipt/trace delivery checks; never report parent ship without child canonical artifacts.
- **Workspace/provider missing or unsupported:** do not infer jj behavior. Mark the continuation blocked/failed with stage `workspace` or `context`, preserve references, and expose the recovery record.
- **Verification/acceptance failure:** preserve child workspace, persist a bounded failure reference, set child terminal failed, and set parent failed (not completed). A later user-directed resume creates a new child attempt linked to the same edge.

The first slice may resume only the most recent interrupted child and may require user initiation. That is sufficient to prove durable continuation without inventing background scheduling.

## Contract and ledger design

### Additive contracts

| Contract owner / likely file | Additive shape | Boundary rule |
| --- | --- | --- |
| `contracts/payloads.ts` | Add versioned `ChildHandoff` and `ChildResult` schemas. `ChildHandoff` contains IDs/immutable references, bounded declarative working state, changed paths, verification status/evidence references, and next action—not command output, transcript, or raw source. | Revalidate on create, transform, load, and session ingress. Keep attempt IDs/timestamps out of prompt-bound serialization. |
| `contracts/context-lifecycle.ts` | Add only references needed to bind child handoff to a `WorkingCheckpoint`/plan and source revision; reuse existing checkpoint and epoch schemas. | Kernel owns budgets, validation, assembly, epoch choice, and checkpoint persistence under the ADR. |
| `contracts/workspace-driver.ts` | Add provider-neutral `preserveContinuation(context)` / `resumeContinuation(token)` (or equivalent opaque handle) capability and support declaration. Return workspace context plus revision identity; never expose a jj branch as engine protocol. | Workspace provider owns VCS mechanics and preservation; daemon sequences and gates it. |
| `contracts/gateway-events.ts` and `contracts/trace.ts` | Add additive structural events such as `child.queued`, `child.claimed`, `child.completed`, `continuation.checkpointed`, and `continuation.resumed`, with `parentTaskId`, `childTaskId`, relationship, artifact IDs/hashes, and outcome only. | Event data remains bounded and transcript-free. Do not overload `task.routed` or encode relationship in strings. |
| `contracts/payloads.ts` receipt or a new receipt companion | Add a compact `children` summary: child task ID, relationship, terminal verdict, receipt/trace artifact ID. Keep full edge history in the ledger/artifacts. | Canonical receipt references evidence; it is not the trace. |

### Additive ledger migration

Advance `LEDGER_SCHEMA_VERSION` with an additive migration. Suggested minimum tables (names are implementation-owned):

- `task_edges(edge_id, parent_task_id FK, child_task_id FK nullable, ordinal, relationship, status, handoff_artifact_id, checkpoint_artifact_id, workspace_continuation_id, created_at, claimed_at, completed_at, UNIQUE(parent_task_id, ordinal))`;
- `task_artifacts(task_id FK, role, artifact_id, media_type, source_revision, created_at, UNIQUE(task_id, role, artifact_id))` for plan/checkpoint/handoff/receipt/trace/failure references;
- `workspace_continuations(id, task_id FK, driver, provider_version, opaque_token, revision, status, created_at, updated_at)`; opaque token encryption/secret handling is provider/storage policy, and no absolute path is part of the prompt contract;
- optionally `task_attempts` if attempt lineage cannot remain derived from IDs; include resume predecessor and terminal delivery state there rather than embedding it in prompt payloads.

Keep existing `tasks`, `micro_sessions`, and `workspaces` intact. Add indexes for ready child claims and parent lookup. Use SQLite transactions for (a) durable child intent plus references, (b) ready-to-claimed compare-and-set, and (c) terminal edge/parent updates. Migration tests must open an M4.1-shaped database and prove the new schema preserves all old rows.

### State transitions and ownership

```text
parent executing
  -> parent verified/accepted
  -> continuation intent persisted (edge=ready, checkpoint+handoff+workspace refs durable)
  -> child claimed -> child executing -> child verified -> child accepted
  -> child completed; edge completed; parent completed

child interrupted -> checkpoint persisted + workspace continuation preserved
                  -> edge resumable -> next explicit resume claims child attempt
child failed/escalated -> edge terminal; parent failed/escalated; workspace preserved
```

The **daemon** owns every transition and transaction. The session host owns only model execution; the context provider owns acquisition/materialization; the workspace provider owns isolation, materialization, integration, and preservation; the environment provider owns commands; CLI and extension own argument conversion/progress rendering only. This preserves the microkernel boundary and the ADR’s rule that providers cannot inject prompt text or take lifecycle control.

## Exact integration seams

1. **New `daemon/sequential.ts` (or a narrow addition to `isolated.ts`):** the sole parent/child coordinator. It invokes the established isolated execution path rather than copying `parallel.ts`; it owns edge persistence, claim, recovery, and parent aggregation.
2. **`daemon/parallel.ts`:** extract/reuse its context plan/assembly, epoch start, finalization, verification, acceptance, cleanup/preservation, and receipt construction behind an internal single-attempt executor. Do not make sequential children pretend to be parallel workers.
3. **`context/checkpoint.ts` and artifact store:** persist actual checkpoints at child handoff/interruption; pass their immutable references into `resumeExecutionEpoch`. Remove the current semantic mismatch where a trace event says checkpoint saved without a saved checkpoint.
4. **`workspaces/jj-driver.ts`:** implement the new continuation capability using jj-specific revsets/workspace names internally. Add a fake provider conformance test so daemon code is demonstrably jj-free.
5. **`ledger/store.ts` and `daemon/start.ts`:** add edge/artifact/continuation CRUD, transactional claim and recovery reconciliation. `startDaemon` returns resumable/blocked work, but it must not autonomously execute it in the first slice.
6. **`cli.ts`:** add submit/resume adapters and trace the new canonical lifecycle events. Retain existing default state path and receipt/trace delivery protocol.
7. **`extensions/task/index.ts`:** add an explicit v2 engine selection adapter after the CLI/daemon operation is hermetic. It maps ordinary task input and canonical progress/results; it does not create child sessions or manipulate workspaces.
8. **`workflow/*` and `parity/*`:** consume the real sequential executor only after it exists. Keep them outside the critical path of the first slice.

## Implementation milestones

Each milestone is independently implementable and verifiable. File lists identify likely ownership, not a requirement to preserve every existing module shape.

### 1. Durable contracts and migration

**Outcome:** a child continuation can be represented and atomically claimed without running a model or workspace.

- **Own:** `contracts/payloads.ts`, `contracts/workspace-driver.ts`, `contracts/gateway-events.ts`, `contracts/trace.ts`, `ledger/store.ts`, `contracts/index.ts`.
- **Implement:** bounded `ChildHandoff`; opaque workspace continuation contract; additive child edge/artifact tables; compare-and-set claim; terminal/recovery statuses; additive trace vocabulary.
- **Regression tests:** extend `test-contracts.ts`, `test-trace.ts`, and `test-ledger.ts` for rejection of transcript/output fields, caps, migration from v2 schema, FK/uniqueness, transactional claim racing, and idempotent terminal transitions.
- **Gate:** zero-LLM SQLite/schema suite proves an M4.1 ledger opens unchanged and one ready edge becomes exactly one claimed edge.

### 2. Provider-neutral preservation and checkpoint persistence

**Outcome:** an interrupted task has a real checkpoint artifact and a provider-owned continuation token.

- **Own:** `context/checkpoint.ts`, `context/epoch.ts`, `context/artifact-store.ts`, `contracts/workspace-driver.ts`, `workspaces/jj-driver.ts`, `workspaces/failure-hygiene.ts`.
- **Implement:** persist checkpoint at explicit handoff/interruption; jj implementation of opaque continuation preservation/resolution; unsupported-provider typed result; revision validation on resume.
- **Regression tests:** extend `test-context-checkpoint.ts`, `test-context-epoch.ts`, `test-jj-driver.ts`, and `test-failure-hygiene.ts` using real temporary jj plus a fake non-jj driver. Assert no checkpoint event is emitted without immutable storage success.
- **Gate:** a process-independent test loads checkpoint/token and recovers the same provider workspace revision without transcript input.

### 3. Sequential daemon coordinator

**Outcome:** one accepted parent dispatches one durable child through the real isolated pipeline.

- **Own:** new `daemon/sequential.ts`; narrow extraction from `daemon/parallel.ts`; `daemon/isolated.ts`; `ledger/store.ts`; `daemon/start.ts`.
- **Implement:** parent terminal-to-child-ready transaction, claim, child execution, independent receipt, parent aggregate/terminal update, and failure preservation. Reuse the existing workspace/environment/session pipeline; do not call `workflow/scheduler.ts`.
- **Regression tests:** new `test-sequential.ts` with fake host, real jj, real verification, and real SQLite. Prove order (child starts only after parent durable handoff), separate task/workspace/session rows, child canonical receipt/trace references, provider-derived commit evidence, and parent cannot ship if child fails.
- **Gate:** hermetic end-to-end sequential run yields parent and child receipts/traces with no transcript field anywhere.

### 4. Restart and bounded continuation recovery

**Outcome:** interruption between/within child execution resumes from preserved workspace plus checkpoint.

- **Own:** `daemon/sequential.ts`, `daemon/start.ts`, `ledger/store.ts`, trace/report adapters, `guards/artifacts.ts`.
- **Implement:** deterministic recovery classification (`ready`, `resumable`, `blocked`, terminal); resume command operation; exactly-once claim; failure artifact pointers; explicit cancellation behavior.
- **Regression tests:** extend `test-daemon.ts` and `test-sequential.ts` to simulate crash after intent, crash after claim, missing checkpoint, missing provider, and verification failure. Assert each has a terminal or resumable ledger state, preserves work, emits stage/code, and never spawns twice.
- **Gate:** close/reopen SQLite and reconstruct a child session configuration from artifacts/driver only; test fixture proves no parent transcript was retained or supplied.

### 5. CLI and canonical evidence

**Outcome:** `mise run v2` can submit and resume the slice and prints/delivers canonical artifacts.

- **Own:** `cli.ts`, `daemon/isolated.ts`/`sequential.ts`, `contracts/trace.ts`, `bench/trace-report.ts`, `test-cli.ts`, `test-trace-report.ts`.
- **Implement:** minimal child declaration/resume argument shape, progress projection from additive events, receipt child summary, and trace-report rendering of relationship/recovery status.
- **Regression tests:** parent/child success, interrupted then resumed, artifact-delivery failure, and invalid continuation ID. Use fake sessions plus real jj/verification; assert project state remains external and no provider-specific branch/path enters the handoff/trace prompt payload.
- **Gate:** one CLI command and one CLI resume command demonstrate the complete durable path hermetically.

### 6. Normal-surface self-hosting proof and shadow evidence

**Outcome:** ordinary pi task usage selects v2 and completes one focused core-v2 change under this repository’s actual gates.

- **Own:** `extensions/task/index.ts` plus a small adapter module; v2 CLI/daemon public API; `parity/v2-build.ts` only if needed to invoke the real operation.
- **Implement:** explicit engine selection, canonical event rendering, receipt lookup/resume mapping, and a documented focused core-v2 dogfood fixture. Do not make v2 the default.
- **Regression tests:** extension adapter unit/conformance test with injected v2 submitter; a hermetic self-hosting-shaped fixture; manual real-model dogfood that runs the repository’s declared typecheck/test/artifact policy and retains trace/receipt evidence. Then wire the parity harness to the real sequential executor for shadow runs.
- **Gate:** evidence shows normal-surface selection, a preserved-workspace resume, accepted real repository gates, and canonical child/parent artifacts. V1 remains available.

## Findings by confidence

### Strong

- M4 already has the right data model for bounded continuation: immutable artifacts, declarative checkpoints, epochs, raw fallback, and transcript-free traces.
- The daemon’s parallel pipeline and jj driver contain reusable execution, finalization, verification, acceptance, cleanup, and preservation mechanics; a sequential coordinator should call these seams rather than reproduce them.
- The current ledger cannot satisfy the M5 durability contract without additive task-edge/artifact/continuation state and transactional claims.
- The shipped CLI is an adapter, not an orchestrator; that is the correct place to expose a daemon-owned resume operation.
- Current M5-labelled workflow and parity code is hermetic planning/shadow infrastructure, not end-user sequential execution.

### Worth exploring

- Use `workflow/plan.ts` and `dag.ts` after the one-child slice to validate declarative child specifications. Keep execution bound to the sequential daemon coordinator.
- Refactor the reliable core of `parallel.ts` into a parameterized single-attempt executor shared by isolated, sequential, and parallel compositions. Do this only while adding a regression test that preserves current CLI/parallel behavior.
- Evolve the existing `HandoffBundle` into a separate child handoff rather than widening it. Its bounded-cap plugin pattern is useful, but verification command/tail fields should remain in failure artifacts.
- Have the parity harness execute the real sequential seam in a later shadow milestone. It can compare canonical outcomes but cannot establish product success by dry receipts.

### Speculative

- A parent can eventually dispatch more than one ordered child, then adopt the existing DAG scheduler. This should wait until the single-child transaction/recovery semantics are proven.
- Background automatic resume, a daemon scheduler, model swapping as a continuation feature, remote continuation tokens, or dynamic routing may be valuable later, but none is required for the bootstrap gate.
- A generic workflow grammar in Markdown may be attractive, but the first M5 slice can use a single explicit continuation request and avoid committing to a DAG user language.

## Non-goals

- Parallel child fan-out, DAG execution, workflow approval UX, or using `workflow/scheduler.ts` as the M5 runtime.
- Replaying or storing model transcripts, private reasoning, unrestricted tool output, source bodies, or secrets to resume work.
- Making jj details, host paths, branches, or commits part of prompt-bound child contracts; jj remains a default provider implementation.
- Automatic/background continuation, remote/multi-user scheduling, multi-tenant durability, cutover from v1, or making v2 the default normal surface.
- New retrieval providers, embeddings/vector stores, cache-transfer guarantees, or claims that symbol-tree/context management improves quality or cost.
- Changing acceptance semantics: child and parent still require provider-derived workspace evidence, integrated-tree verification, artifact policy acceptance, and durable receipt/trace delivery.

## Decision record

Proceed with milestones 1–4 before any normal-surface switch. They establish the only missing correctness property—durable, provider-neutral continuation—from schema through restart. Milestones 5–6 then make that property observable to users and prove self-hosting without conflating M5 with parallelism, parity dry runs, or v1 cutover.
