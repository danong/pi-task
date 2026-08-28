# M5 post-land review

**Scope/method.** Reviewed the committed delta `301c0b5b..fa69c74c` (M5 is `fa69c74c`) against active `docs/pi-task-v2.md`, `docs/pi-task-v2-subsystems.md`, `docs/pi-task-design.md`, the context-control-plane ADR, the four prior M5 reports, contracts, and hermetic suites. No `CONTEXT.md` exists. Findings below are demonstrated control-flow/contract defects, not feature requests.

## Executive verdict

**BLOCK — do not retain M5 on `main` as shipped.** The happy path, bounded handoff, typed ingress references, jj restart resolution, admitted child events, and v1’s untouched fallback are positive. But a crash can replay an accepted parent before any durable edge exists; the normal CLI cannot resume an edge; resumed work does not use its persisted plan; `maxCostUsd` cannot interrupt spend; and persisted terminal evidence omits its own terminal lifecycle facts/parent-child receipt link. These violate the active durable-continuation and truthful-evidence contract.

## Findings

### P0-1 — Child identity is durable too late; a crash can replay accepted parent work

- **Scenario:** `prepareSequentialChild()` accepts/integrates the parent, then calls `ledger.insertTask(childTaskId)` before `buildArtifacts()` and `persistPreparingChildIntent()`. Power loss in that interval leaves a standalone queued child and an executing accepted parent with no edge. `startDaemon()` sees no edge and `reconcileOnBoot()` requeues the parent. A normal retry redoes accepted parent work; the orphan child ID also collides with a deterministic CLI retry.
- **Anchors:** `packages/core-v2/src/daemon/sequential.ts:prepareSequentialChild()` (`ledger.insertTask` immediately before `buildArtifacts`/`persistPreparingChildIntent`); `packages/core-v2/src/ledger/store.ts:reconcileOnBoot()` (only edge-owned rows bypass generic retry); `packages/core-v2/test/test-sequential.ts` (no kill point in this interval).
- **Violated invariant:** Parent acceptance may advance to child preparation only through a boot-discoverable durable edge; no accepted parent is replayed and no child exists outside edge ownership.
- **Smallest safe repair boundary:** Ledger preparation protocol only: atomically record a parent-owned `preparing` intent (including planned child identity) *before* creating the child task or artifacts, then atomically attach child/artifact/provider facts when complete. Reconcile incomplete preparation explicitly before generic task retry; do not make the daemon infer a replacement parent.
- **Regression test needed:** Fault-inject after parent acceptance, after preliminary preparation commit, after child row creation, and after each immutable write; close/reopen SQLite/artifact store. Assert one discoverable preparation/edge, no parent session replay, no duplicate child identity, and deterministic blocked/retry disposition.
- **Focused verification:** `npx tsx packages/core-v2/test/test-sequential.ts && npx tsx packages/core-v2/test/test-daemon.ts && npx tsx packages/core-v2/test/test-ledger.ts`

### P1-1 — `--child-spec` submits work but supplies no normal-surface resume operation

- **Scenario:** A CLI child is left `preparing`, `ready`, or `resumable` after a crash/cap. On the next CLI invocation there is no `--resume <edge-id>`/selector and `runCli()` always calls `runSequentialTask()`. It attempts `prepareSequentialChild()` with the same deterministic parent/child/edge IDs, beginning with `insertTask(parentTaskId)`, rather than calling the existing `resumeSequentialChild()`; this fails on the existing parent row or would replay the parent.
- **Anchors:** `packages/core-v2/src/cli.ts:ParsedCliArgs`, `parseCliArgs()`, and `runCli()` (only `--child-spec`; calls `runSequentialTask()`); `packages/core-v2/src/daemon/sequential.ts:resumeSequentialChild()` (library-only operation); `packages/core-v2/test/test-cli.ts` (success-only `--child-spec` coverage).
- **Violated invariant:** A durable edge is resumed by an interface adapter using the one daemon-owned resume operation, never by replaying its parent.
- **Smallest safe repair boundary:** Add a mutually exclusive CLI resume selector and adapter that boots, selects one durable edge, and calls `resumeSequentialChild()` with reconstructed providers; keep child-spec submission separate. Define terminal/idempotent and missing/blocked selector results.
- **Regression test needed:** Prepare, close/reopen, then resume through `runCli()` with fresh ledger/store/driver/host; assert only the child spawns. Cover preparing reconciliation, resumable cap, terminal idempotence, missing selector, and incompatible model/provider.
- **Focused verification:** `npx tsx packages/core-v2/test/test-cli.ts && npx tsx packages/core-v2/test/test-sequential.ts`

### P1-2 — Resume validates a persisted plan then silently executes a newly planned epoch

- **Scenario:** `resumeSequentialChild()` loads and cross-validates `config.planReference`/checkpoint, but passes only `resumeCheckpoint` to `runIsolatedTask()`. `runParallelTask()` always derives `contextPlan` afresh from the new attempt/raw acquisition and calls `startExecutionEpoch({ plan: contextPlan, checkpoint })`. The child prompt and epoch therefore use a different plan (and a fresh `initial` transition), despite a checkpoint whose plan ID was validated as authoritative.
- **Anchors:** `packages/core-v2/src/daemon/sequential.ts:resumeSequentialChild()` (loaded `plan`, `runIsolatedTask({... resumeCheckpoint })`); `packages/core-v2/src/daemon/parallel.ts:runParallelTask()` (fresh `planContext`, `startExecutionEpoch`); `packages/core-v2/src/context/epoch.ts:startExecutionEpoch()`.
- **Violated invariant:** Resume starts a new lineage from the persisted checkpoint **and its referenced context plan**, not a fresh plan carrying an unrelated checkpoint ID.
- **Smallest safe repair boundary:** Add a narrow validated-resume input to the shared single-task executor: accept the loaded `ContextPlan` and use `resumeExecutionEpoch()` (or an explicitly equivalent transition) only after plan/checkpoint/revision validation. Do not replan or reacquire on this path unless a separately persisted/revalidated transition says so.
- **Regression test needed:** Persist a non-raw/distinctive plan, close/reopen, resume, and assert the session receives that plan’s assembled prompt and an epoch with its plan ID/checkpoint lineage. Reject a mismatched plan before host spawn.
- **Focused verification:** `npx tsx packages/core-v2/test/test-sequential.ts && npx tsx packages/core-v2/test/test-context-epoch.ts && npx tsx packages/core-v2/test/test-context-checkpoint.ts`

### P1-3 — `maxCostUsd` is a post-spend verdict, not an interruption budget

- **Scenario:** A child with `--max-cost-usd 1` can run arbitrarily over $1: watchdog construction passes wall timeout and `maxTurns`, never cost; cost is read only after `handle.prompt()` settles, then checked after finalization, combine, materialization, and verification. The function may finally return an interruption, but cannot prevent the overspend or stop irreversible provider work before it.
- **Anchors:** `packages/core-v2/src/daemon/parallel.ts:attachWatchdogs()` (no `maxCostUsd`), `runParallelTask()` (`collectUsage` then post-verification `budgetReason` block); `packages/core-v2/src/sessions/host.ts:SessionHostEvent` (no live usage event); `packages/core-v2/test/test-budget.ts` (cost is pure-helper coverage only).
- **Violated invariant:** An advertised independent cost cap must stop admission/spend at a safe interruption boundary, preserve a sequential child as resumable, and not be represented as an after-the-fact budget interruption.
- **Smallest safe repair boundary:** Either add provider-neutral cumulative usage events to the session/watchdog boundary and abort before the next turn/tool once cost reaches the cap, or remove/reject `maxCostUsd` until that signal exists. Make the sequential interruption path checkpoint/preserve before return; do not combine/verify a budget-aborted child.
- **Regression test needed:** Fake host emits increasing measured cost across turns; assert host aborts at cap, no combine/materialize/verification occurs after abort, and fresh-process child resume preserves partial work. Cover unavailable usage as an explicit documented policy.
- **Focused verification:** `npx tsx packages/core-v2/test/test-budget.ts && npx tsx packages/core-v2/test/test-sequential.ts && npx tsx packages/core-v2/test/test-parallel.ts`

### P1-4 — Terminal receipt/trace evidence is neither causally complete nor atomically linked to settlement

- **Scenario:** On child success, `resumeSequentialChild()` calls `stream.finish()` and writes child/parent trace and receipt objects *before* `settleChild()` and before emitting `child.completed`/parent terminal gateway events. Thus stored sequential traces exclude their claimed terminal lifecycle facts. A crash after immutable writes/`insertTaskArtifact()` but before `settleChild()` leaves orphan terminal evidence and a claimed edge; recovery cannot use that evidence as a terminal delivery record. Separately, `TaskReceiptSchema` and `parentOutcome()` have no child task/verdict/receipt/trace summary, so the returned parent receipt cannot establish its child dependency.
- **Anchors:** `packages/core-v2/src/daemon/sequential.ts:resumeSequentialChild()` (the `stream.finish`/artifact loop/`settleChild`/terminal `gateway.emit` order; `parentOutcome()`); `packages/core-v2/src/contracts/payloads.ts:TaskReceiptSchema`; `packages/core-v2/src/ledger/store.ts:settleChild()`; `packages/core-v2/test/test-sequential.ts` (checks verification in trace, not terminal trace facts or crash interval).
- **Violated invariant:** Parent settlement/delivery is supported by truthful canonical child and parent evidence: terminal relationship events and child receipt/trace identities are durable and causally linked before a parent can ship.
- **Smallest safe repair boundary:** Define an additive compact child summary on the parent receipt. Introduce a terminal-evidence/delivery-pending ledger state (or equivalent outbox) that records complete typed references atomically with settlement, then emits/delivers terminal events idempotently. Build canonical traces only after their terminal facts are admitted; recovery must finish delivery rather than rerun child work.
- **Regression test needed:** Assert persisted parent/child traces contain terminal events in order and parent receipt contains the matching child IDs/verdict/references. Kill after each terminal artifact write and after settlement; reopen and prove exactly-once terminal delivery/no child respawn.
- **Focused verification:** `npx tsx packages/core-v2/test/test-sequential.ts && npx tsx packages/core-v2/test/test-trace.ts && npx tsx packages/core-v2/test/test-ledger.ts && npx tsx packages/core-v2/test/test-cli.ts`

## Repair packets

### Luna-1 — Make parent-to-child preparation crash-authoritative (P0-1)

**Goal:** No crash after parent acceptance can produce an edge-less child or replay accepted parent work.

**WHAT:** Persist a parent-owned preliminary preparation record before child task creation/artifact writes; atomically attach child identity and all references before provider preparation; reconcile every preliminary state before generic task retry; make retry/idempotence explicit.

**Owned files:** `packages/core-v2/src/ledger/store.ts`, `packages/core-v2/src/daemon/sequential.ts`, `packages/core-v2/src/daemon/start.ts`, `packages/core-v2/test/test-sequential.ts`, `packages/core-v2/test/test-daemon.ts`, `packages/core-v2/test/test-ledger.ts`.

**Verify:**
```bash
npx tsx packages/core-v2/test/test-ledger.ts
npx tsx packages/core-v2/test/test-daemon.ts
npx tsx packages/core-v2/test/test-sequential.ts
```

### Luna-2 — Expose edge resume through the v2 CLI (P1-1; depends on Luna-1)

**Goal:** A normal CLI invocation resumes one durable edge without executing its parent again.

**WHAT:** Add a resume selector mutually exclusive with child submission; resolve it only through `resumeSequentialChild()`; give missing/blocked/terminal edges deterministic adapter results; preserve existing `--child-spec` behavior and raw-only restriction.

**Owned files:** `packages/core-v2/src/cli.ts`, `packages/core-v2/src/daemon/sequential.ts`, `packages/core-v2/test/test-cli.ts`, `packages/core-v2/test/test-sequential.ts`.

**Verify:**
```bash
npx tsx packages/core-v2/test/test-cli.ts
npx tsx packages/core-v2/test/test-sequential.ts
```

### Luna-3 — Execute resumed/capped children at a real safe boundary (P1-2, P1-3)

**Goal:** Resume consumes the persisted plan/checkpoint lineage, and configured cost limits stop work before post-session integration.

**WHAT:** Pass a validated persisted plan into the resumed executor and create an explicit resumed epoch; add provider-neutral live cost accounting or reject unavailable cost caps; on any cap, checkpoint/preserve before combine/materialize/verify and return resumable state.

**Owned files:** `packages/core-v2/src/daemon/parallel.ts`, `packages/core-v2/src/daemon/isolated.ts`, `packages/core-v2/src/daemon/sequential.ts`, `packages/core-v2/src/context/epoch.ts`, `packages/core-v2/src/sessions/host.ts`, `packages/core-v2/test/test-sequential.ts`, `packages/core-v2/test/test-budget.ts`, `packages/core-v2/test/test-context-epoch.ts`.

**Verify:**
```bash
npx tsx packages/core-v2/test/test-context-epoch.ts
npx tsx packages/core-v2/test/test-budget.ts
npx tsx packages/core-v2/test/test-parallel.ts
npx tsx packages/core-v2/test/test-sequential.ts
```

### Luna-4 — Make sequential terminal evidence truthful and recoverable (P1-4; depends on Luna-1)

**Goal:** Parent settlement is backed by terminal child/parent traces and a compact linked receipt, including across delivery crashes.

**WHAT:** Add parent receipt child summary; durably link complete typed evidence and terminal state before reporting ship; record terminal lifecycle facts in the canonical traces; recover terminal delivery idempotently without rerunning child execution.

**Owned files:** `packages/core-v2/src/contracts/payloads.ts`, `packages/core-v2/src/contracts/trace.ts`, `packages/core-v2/src/ledger/store.ts`, `packages/core-v2/src/daemon/sequential.ts`, `packages/core-v2/src/cli.ts`, `packages/core-v2/test/test-sequential.ts`, `packages/core-v2/test/test-trace.ts`, `packages/core-v2/test/test-cli.ts`, `packages/core-v2/test/test-ledger.ts`.

**Verify:**
```bash
npx tsx packages/core-v2/test/test-trace.ts
npx tsx packages/core-v2/test/test-ledger.ts
npx tsx packages/core-v2/test/test-sequential.ts
npx tsx packages/core-v2/test/test-cli.ts
```

## Test blind spots

- `test-sequential.ts` proves continuous happy path, direct library close/reopen, and one cap path; it has no kill-point coverage before `persistPreparingChildIntent()` or between terminal artifact writes, settlement, and delivery.
- `test-cli.ts` proves `--child-spec` success only. It does not invoke a resumed edge because no CLI resume surface exists.
- `test-budget.ts` proves parsing, watchdog turns, and a pure cost predicate; it does not prove live cost cancellation or prevent combine/verification after a cap.
- No successful non-jj continuation-provider conformance test exists (only jj plus an unsupported wrapper). This is a **coverage P2**, not a demonstrated kernel jj branch: add it after the P0/P1 repair boundaries rather than expanding this release with speculative provider features.
- Existing v1 extension code is untouched and v2 remains explicit, so v1 fallback compatibility is preserved by delta inspection; no M5 test demonstrates user-level v1/v2 fallback selection.

## Disposition

M5 **cannot remain on `main`** with the four blockers above. Land Luna-1 first; Luna-2 and Luna-4 depend on its authoritative preparation state. Luna-3 is independent of CLI syntax but must land before claiming budget-safe resumable continuation. Do not treat workflow/parity expansion, multi-child DAGs, automatic background resume, or a new provider as blockers; they are outside the demonstrated defects.
