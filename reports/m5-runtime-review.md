# M5 runtime/checkpoint review

## Scope and method

Reviewed `683791b6963f` (`task: Make M5 interruption state process-independent…`) and `d1f86c708bbe` (`task: Implement one daemon-owned durable parent-to-child sequential execution path…`), including their changed tests. Compared them with every existing report under `reports/` (`m5-architecture-survey.md`, `m5-m1-review.md`, and `m5-m1-rereview.md`), active `docs/pi-task-v2*.md`, `docs/pi-task-design.md`, and `docs/adr/context-control-plane.md`.

The checkpoint and jj-driver changes improve the components in isolation: checkpoints are bounded and round-tripped, continuation resolution does not depend on a driver instance map, revision mismatch is rejected, and the daemon source does not branch on `driver.name`. The sequential path also uses the ordinary isolated/parallel executor rather than `workflow/`.

## Verdict

**BLOCK — restart/resume wiring may not proceed.** The new path is an in-process parent/child demo, not a crash-safe, process-independent continuation. A restart has no operation that can reconstruct and execute an edge, and several crash intervals lose the only durable route to a live workspace or falsely classify a completed/cleaned child as resumable. Canonical parent/child delivery evidence is also not truthful enough to authorize a parent ship.

## Findings

### P0-1 — The durable intent is created after irreversible provider work, so a crash leaks a workspace and loses/repeats the child

**Files/symbols:** `packages/core-v2/src/daemon/sequential.ts`: `runSequentialTask()` (artifact creation through `createWorkspace()`/`preserveContinuation()` and the later `ledger.persistReadyChildIntent()`); `packages/core-v2/src/ledger/store.ts`: `persistReadyChildIntent()`.

The parent has already passed integration/verification/acceptance when the coordinator writes checkpoint and handoff artifacts, inserts the child task, creates a child workspace, and asks the provider to preserve it. None of those steps is in the ledger transaction that makes the edge ready. A process death after `createWorkspace()` or `preserveContinuation()` but before `persistReadyChildIntent()` leaves a live jj workspace with no ledger workspace row, no continuation record, and no discoverable edge. A death after the child row but before preservation leaves a queued standalone child without its edge. A later ordinary boot can requeue the parent and repeat accepted parent work; it cannot identify or clean the orphan.

The existing atomic transaction only makes its supplied SQL rows atomic; it cannot make an already-created provider workspace durable. This contradicts the survey's required ordering: durable edge + full artifact references + provider continuation record, then claim/spawn.

**Required outcome:** introduce a daemon-owned prepare/commit/reconcile protocol. Persist a durable `preparing` record before provider mutation, record a provider-owned provisional identity atomically with the provider's preservation result (or make provider preservation idempotently discoverable by that record), and reconcile every pre-ready state on boot. No child task/workspace may be created outside a record that boot can classify. Add kill-point tests after each statement/provider call and prove no orphan workspace, duplicate parent/child attempt, or unclassified row remains.

### P0-2 — No process can resume a claimed/resumable edge from the ledger and artifact store

**Files/symbols:** `packages/core-v2/src/daemon/sequential.ts`: only `runSequentialTask()`; `packages/core-v2/src/daemon/start.ts`: `startDaemon()`; `packages/core-v2/src/ledger/store.ts`: `reconcileChildEdgesOnBoot()`, `task_edges`, `task_artifacts`; `packages/core-v2/src/cli.ts`: `runCli()`/`ParsedCliArgs`.

There is no `resumeSequential…` operation, no lookup of a ready/resumable edge, and no CLI or normal-task adapter that invokes one. `startDaemon()` merely changes `claimed` to `resumable`; it never resolves a continuation or starts the shared executor. Reinvoking `runSequentialTask()` creates new random parent/child/edge IDs and runs the parent again.

More fundamentally, the ledger cannot reconstruct the values the current ingress needs. `task_edges` retains only handoff/checkpoint hash strings, and `task_artifacts` stores no namespace, kind, size, sensitivity, or source revision for the built-in handoff/checkpoint references. `ContextArtifactStore.get()` requires the complete `ImmutableArtifactReference`; the only complete references are local variables in the vanished process. The child spec, model/config identity, parent receipt/trace references, and child execution attempt/epoch are likewise not durably sufficient to recreate `RunSequentialTaskOptions`.

**Required outcome:** make one daemon resume API take an edge/continuation selector, load all typed immutable references and execution configuration from durable state, validate them, perform exactly-one claim, resolve the provider continuation, and invoke the same single-attempt executor. Persist typed full artifact references (or a schema that losslessly reconstructs them), child spec/config/provider versions, and attempt lineage. Make CLI and the eventual extension thin adapters over that API only after hermetic close/reopen tests pass.

### P1-1 — Claimed-child restart classification is not a validity check and cannot preserve actual child interruption state

**Files/symbols:** `packages/core-v2/src/ledger/store.ts`: `reconcileChildEdgesOnBoot()`, `classifyChildRestart()`; `packages/core-v2/src/daemon/sequential.ts`: handoff checkpoint construction and child execution; `packages/core-v2/src/daemon/parallel.ts`: `resumeCheckpoint`, `startExecutionEpoch()` call; `packages/core-v2/src/context/epoch.ts`: `resumeExecutionEpoch()`.

Boot calls generic `reconcileOnBoot()` before child reconciliation. It requeues/fails parent and child tasks without edge semantics; then child reconciliation checks only whether SQL rows exist, not whether the artifact bytes, checkpoint/plan relation, continuation token, workspace, or revision are valid. Thus a child that finished, had its workspace cleaned by `runParallelTask()`, and crashed before `settleChild()` is classified `resumable` merely because a continuation *row* remains. Resolution would find a missing workspace.

The only stored checkpoint is fabricated at parent handoff (`epochId: "parent-handoff"`, all parent requirements satisfied). No checkpoint is saved when the child is interrupted, no `continuation.checkpointed`/`child.resumable` event is emitted, and no interruption handler calls `markChildResumable()`. The child starts a fresh epoch with `startExecutionEpoch()`, not `resumeExecutionEpoch()`; it also plans a new raw plan while its supplied checkpoint points to a separate plan artifact. There is no validation that the handoff source revision, checkpoint workspace/plan, child context plan, and provider continuation revision identify the same accepted tree.

**Required outcome:** reconcile edges before generic task retries and make the edge state authoritative for its parent/child tasks. At a defined child safe point, persist a real child checkpoint and preserved continuation, validate immutable bytes plus checkpoint-plan-revision-continuation consistency, then atomically mark resumable. Resume must construct a new epoch from the persisted plan/checkpoint with explicit transition lineage. Missing, corrupt, stale, unsupported, or revision-mismatched dependencies must become durable `blocked`/terminal outcomes with recovery evidence, never optimistic `resumable`.

### P1-2 — The parent/child status ordering can record a terminal task before it is actually accepted or settled

**Files/symbols:** `packages/core-v2/src/daemon/parallel.ts`: `perWorker = …map(...)` (unconditional `store.setTaskStatus(ctx.taskId, "completed")`), feature-branch return, and the later `deferSuccessfulTerminal` branch; `packages/core-v2/src/daemon/sequential.ts`: parent call using `deferSuccessfulTerminal: true`.

`deferSuccessfulTerminal` suppresses only the final successful task transition/event. Earlier in the same executor, each yielded worker is unconditionally marked `completed`, before integration, verification, artifact acceptance, and child intent persistence. A crash there leaves a terminal parent/child row that boot deliberately ignores. The feature-branch success branch also completes the aggregate despite `deferSuccessfulTerminal`. The later `verifying` overwrite does not repair a process that dies in the interval.

This is particularly unsafe for the sequential parent: its receipt says `ship` after its own acceptance while its ledger state is meant to remain nonterminal until the child settles. The code has no durable parent `awaiting_child` state and no receipt type that distinguishes an accepted parent unit from a shipped aggregate parent.

**Required outcome:** use an explicit nonterminal accepted/awaiting-child state and legal compare-and-set transitions. The shared executor must not write a terminal status or terminal event before all of its own gates; sequential composition must own conversion of parent acceptance into the durable child-ready transaction and only `settleChild()` may make the aggregate parent terminal. Cover task-base and feature-branch behavior, plus crashes between yield, integration, verification, acceptance, intent, claim, and settlement.

### P1-3 — Receipt, trace, result, and artifact references are synthetic or incomplete and can falsely imply canonical evidence

**Files/symbols:** `packages/core-v2/src/daemon/sequential.ts`: `artifactResult()`, `parentOutcome()`, final `TraceCollector`; `packages/core-v2/src/contracts/trace.ts`: `TraceCollector`; `packages/core-v2/src/contracts/context-lifecycle.ts`: `ImmutableArtifactReferenceSchema`; `packages/core-v2/src/ledger/store.ts`: `TaskArtifactReference`.

The coordinator stores handoff, child result, receipt, and trace all as `tool-result` artifacts. The child result claims an empty changed-path/evidence set even when the child changed files. It creates a new trace after child execution containing only a manually recorded `child.claimed` event, then calls it the child trace; it omits the actual queued/resumed/session/verification/acceptance/settlement events emitted on the gateway. Parent receipt/trace artifacts and a compact parent-to-child receipt summary are never produced or linked. `parentOutcome()` merely changes the returned parent receipt verdict and does not add child evidence.

Consequently no artifact establishes the required causal chain or honest terminal delivery. A crash after child cleanup but before synthetic trace/result/settlement both loses the intended evidence linkage and leaves the false resumable state described above.

**Required outcome:** have one canonical trace collector subscribe to the admitted gateway/session/context events for the whole sequential run, persist parent and child traces/receipts with distinct roles and full immutable references, and atomically link their IDs with settlement. Define a compact parent receipt child summary (task ID, relationship, terminal verdict, receipt/trace IDs). Represent artifacts in namespaces/kinds that match their content, retain source revision/provenance, and derive child result paths/evidence from provider and verification facts rather than literals. Delivery failure must make parent settlement non-ship.

### P1-4 — Exceptional child paths bypass settlement and emit misleading provider failure classification

**Files/symbols:** `packages/core-v2/src/daemon/sequential.ts`: preservation `catch` and unguarded child `runIsolatedTask()`/artifact/settlement sequence; `packages/core-v2/src/ledger/store.ts`: `blockChild()`.

The preservation `catch` classifies every non-`WorkspaceContinuationError` as `unsupported`, including a provider I/O defect or local programming/storage failure. After claim, any thrown child-run, artifact-write, JSON, trace, or gateway error escapes `runSequentialTask()` without `markChildResumable()`, `blockChild()`, `settleChild()`, or a sequential failure artifact. The edge is left `claimed`; boot's row-presence-only rule later invents resumability.

**Required outcome:** define typed failure mapping for every provider/storage/session/delivery boundary; catch and settle only when evidence permits, otherwise atomically preserve checkpoint/workspace and mark resumable or blocked with a failure reference. Do not collapse unknown failures into `unsupported`. Test each thrown dependency and confirm parent cannot ship.

### P2-1 — The continuation contract is provider-neutral in shape, but conformance and provider metadata are insufficient

**Files/symbols:** `packages/core-v2/src/contracts/workspace-driver.ts`: `WorkspaceContinuationCapability`; `packages/core-v2/src/daemon/sequential.ts`: hard-coded `providerVersion: "1"`; `packages/core-v2/src/workspaces/jj-driver.ts`: `continuation`; `packages/core-v2/test/test-sequential.ts`: `unsupported()`.

The daemon does not inspect jj names or paths, and `JujutsuWorkspaceDriver.resumeContinuation()` genuinely discovers a workspace with a fresh driver and validates a 40-hex jj commit. Those are positives. But the only sequential alternative is an object that removes the capability from a jj driver; it proves the unsupported branch, not a successful non-jj provider conformance path. The durable record hard-codes provider version rather than receiving a provider-declared compatibility identity, and no resume code checks driver/provider version before token use.

**Required outcome:** add a fake non-jj continuation provider that successfully preserves/resumes and prove the coordinator never relies on jj behavior. Make provider name/version/capability identity part of the continuation record and validate compatibility during recovery. Retain the jj-specific revision test as provider conformance, not evidence that the daemon is provider-neutral.

### P2-2 — Tests demonstrate a happy-path implementation arrangement, not crash/restart behavior

**Files/symbols:** `packages/core-v2/test/test-sequential.ts`; `packages/core-v2/test/test-jj-driver.ts`; `packages/core-v2/test/test-daemon.ts`; `packages/core-v2/test/test-parallel.ts`.

`test-jj-driver.ts` correctly constructs a new driver to resolve a token, but it does not involve ledger recovery or the sequential coordinator. `test-sequential.ts` runs both sessions continuously in one function; it does not close/reopen a daemon after ready, claim, child ingress, child edits, child acceptance, cleanup, artifact creation, or settlement. Its durable-intent assertion is triggered by an in-memory gateway callback, not by a restarted process. It only checks that a fabricated trace/result reference exists, not that the trace represents execution or that a resume can load it. Existing isolated/parallel suites remain useful coverage, but no new regression exercises the added `taskId`, `reuseExistingTask`, `workspace`, `retainWorkspace`, or `deferSuccessfulTerminal` paths in either integration mode.

**Required outcome:** add fault-injection tests that terminate the coordinator at every boundary in the table below, reopen SQLite and artifact storage with new driver/daemon instances, and assert exact state, workspace disposition, single claim/spawn, revision validation, and truthful parent/child receipts/traces. Add regression suites for normal isolated and parallel task-base/feature-branch execution to prove the new escape hatches cannot alter their existing terminal/cleanup semantics.

### P3-1 — Cleanup/preservation ownership is coupled to a driver-instance side map and the new options widen a shared executor without an internal attempt abstraction

**Files/symbols:** `packages/core-v2/src/workspaces/jj-driver.ts`: `#preservedContinuations`, `recoverFailedRun()`; `packages/core-v2/src/daemon/parallel.ts`: sequential option fields and cleanup branches.

The jj driver reconstructs the preservation map only after a successful `resumeContinuation()` call. That is adequate for its local happy path, but cleanup policy is now split between daemon options, driver instance state, generic failure hygiene, and ledger rows. The broad `RunParallelOptions` additions make the parallel executor a partially sequential-aware API, while no narrow internal single-attempt/continuation contract owns validation, terminal gating, and cleanup. This coupling will make a CLI resume adapter tempted to set flags in the right combination rather than call one safe daemon operation.

**Required outcome:** extract a narrow, private single-attempt executor result that reports provider facts; keep sequential state/claim/checkpoint/cleanup policy in one coordinator and parallel policy in its own composition. Make preservation recoverable from durable provider data rather than an incidental map, and reject incompatible option combinations at the boundary.

## Ownership and ordering assessment

| Concern | Current owner | Assessment |
| --- | --- | --- |
| Parent acceptance | shared parallel executor | Provider-derived integration/verification/acceptance is reused, but task status becomes `completed` too early and parent aggregate receipt remains `ship` before child settlement. |
| Checkpoint/handoff | sequential coordinator + artifact store | Bounded artifacts are created and re-read in-process, but they are created before durable intent, are not fully reconstructible from ledger state, and do not record child interruption state. |
| Workspace preservation | jj provider | Provider hides host path/jj name and validates revision on direct resume; coordinator creates it before durable ownership, so crash recovery leaks it. |
| Intent/claim | ledger | Ready/claimed CAS is the sole strong ordering point. It is too late in the lifecycle and is not connected to a resume executor. |
| Child ingress/epoch | shared parallel executor | Handoff is schema-revalidated before prompt append, but a fresh plan/initial epoch is used without cross-validating persisted plan/checkpoint/revision or using resume epoch lineage. |
| Verification/acceptance | shared parallel executor | Child uses real integrated verification/acceptance in the happy path. Parent aggregation and durable evidence/delivery are outside that gate. |
| Settlement | ledger `settleChild()` | Atomic SQL terminal settlement is a useful owner, but exceptions bypass it and it receives synthetic result/receipt/trace data. |
| Receipt/trace | sequential coordinator | No canonical collector/delivery owner exists for sequential runs; the stored trace is not the emitted lifecycle. |
| Cleanup/preservation | parallel executor + jj driver | Success cleanup precedes sequential settlement; failure preservation depends on a driver map. No crash-safe durable owner covers all paths. |

## Crash-boundary analysis

| Boundary | Persisted state after a power loss | Restart classification / result | Required safe result |
| --- | --- | --- | --- |
| Before parent acceptance | ordinary task state | Existing isolated rules apply. | Existing failure/recovery behavior. |
| After parent acceptance, before checkpoint/handoff artifact | accepted jj tree; parent may be `executing` or prematurely `completed` | No edge; generic boot can requeue parent or regard it terminal. | Parent accepted but awaiting an atomically created continuation, never replayed/false-shipped. |
| After checkpoint/handoff artifact, before child row | orphan immutable bytes | No ledger discoverability; artifact leak. | Reclaimable preparing record or garbage-safe unreferenced artifact policy. |
| After child row, before create/preserve | queued child without edge | Generic boot can requeue a child lacking continuation semantics. | Preparing edge owns child attempt and identifies it as not spawnable. |
| After create/preserve, before `persistReadyChildIntent()` | live workspace/token only in the dead process | Leaked jj workspace; no edge/token/ledger workspace reference; parent can duplicate. | Provider workspace is durably associated with a preparing edge before it can exist. |
| Immediately after ready intent | edge/reference/token rows | Parent generic reconciliation requeues it; no resume dispatcher claims ready work. | Edge remains ready and an explicit resume claims it exactly once without rerunning parent. |
| After claim, before child ingress | claimed edge | Boot turns it resumable based on SQL presence, but cannot execute it. | Validate artifacts/provider revision then explicit resume claims one new attempt. |
| During child session/edit | jj may snapshot work; no new checkpoint | No current child state; boot only sees parent-handoff checkpoint and row presence. | Persist child checkpoint + preserved workspace at an interruption boundary, then resumable/blocked classification. |
| After child acceptance/cleanup, before result/receipt/trace linkage | child task may already be `completed`; workspace gone; edge claimed | False `resumable`: ledger continuation row exists although provider target is gone. | Either settle atomically before destructive cleanup or record terminal-delivery-pending state with durable evidence. |
| After synthetic artifacts, before `settleChild()` | orphan tool-result objects; edge claimed | Same false resumable; no ledger references to result/receipt/trace. | Atomic/linkable terminal evidence and idempotent settlement recovery. |
| After settlement, before event/return/delivery | SQL terminal only | No parent/child canonical receipt/trace delivery; external interface cannot truthfully recover outcome. | Durable receipt/trace delivery state; retry delivery without changing execution verdict. |
| Child/provider/storage exception after claim | claimed edge, possible preserved workspace | Escapes without settlement/failure record; later SQL-only reconciliation guesses resumable. | Typed blocked/resumable/failed outcome with recovery evidence and no parent ship. |

## Required before restart/resume

1. Resolve **P0-1/P0-2**: create a recoverable pre-intent protocol and a single daemon resume operation that reconstructs typed artifacts/spec/config/provider data, claims exactly once, and never replays the parent.
2. Resolve **P1-1/P1-2**: make edge-aware boot reconciliation precede generic task retry; persist real child interruption checkpoints; validate artifact bytes, plan/checkpoint/source/workspace revisions; use explicit resume epoch lineage; remove all premature terminal task transitions.
3. Resolve **P1-3/P1-4**: make parent settlement/delivery depend on truthful canonical parent and child receipts/traces, provider-derived result evidence, typed artifact references, and exhaustive exception settlement.
4. Resolve **P2-1/P2-2/P3-1**: add non-jj provider conformance, provider-version compatibility, kill-point close/reopen tests, normal isolated/parallel regression tests, and one narrow daemon-owned composition boundary before adding CLI or extension adapters.

Until these outcomes are demonstrated, CLI resume would expose an unsafe second lifecycle owner rather than a safe adapter.
