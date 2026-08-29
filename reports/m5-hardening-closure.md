# M5 hardening closure report

## Executive verdict: **READY**

The repaired tree is ready to begin M5.5. The previous BLOCK verdict is superseded: M5-C1 through M5-C4 now have durable ownership, validity-authoritative boot checks, canonical terminal evidence, a terminal outbox, and an explicit delivery-pending phase. The narrow M5 contract is still the boundary under review: one daemon-owned sequential parent-to-one-child continuation, not a DAG, strategy engine, or M5.5 continuation-record implementation.

This verdict is for beginning M5.5, not for claiming that M5.5 is complete. The repository verification gate remains the required final executable check; this report records the current source and regression anchors and does not claim an unavailable local dependency install as a test run.

## Review scope and current owners

Re-reviewed the prior closure report, `reports/m5-runtime-review.md`, `reports/m5-post-land-review.md`, the M1 reports, the architecture survey, and the repaired tree. No implementation or test files were modified.

- `packages/core-v2/src/daemon/sequential.ts` owns preparation, resume, provider compatibility, child execution, evidence ordering, terminal settlement, and delivery policy.
- `packages/core-v2/src/ledger/store.ts` owns preparation reservations, edge claims/transitions, typed manifest references, terminal linkage, outbox state, and boot authority.
- `packages/core-v2/src/daemon/child-reconciliation.ts` performs artifact-byte/schema/lineage and provider-target validation before a claimed edge becomes resumable.
- `packages/core-v2/src/daemon/start.ts` runs edge validation/reconciliation before generic task retry.
- `packages/core-v2/src/cli.ts` is a thin `--resume <edge-id>` adapter and acknowledges external receipt/trace delivery.
- `packages/core-v2/src/contracts/workspace-driver.ts` and `workspaces/jj-driver.ts` carry provider-neutral opaque continuation identity and provider-owned validation/resolution.

## M5-C1 through M5-C4 closure matrix

| Repair | Current implementation anchor | Current regression anchor | Disposition |
|---|---|---|---|
| M5-C1: accepted-parent crash authority | `prepareSequentialChild()` creates `child_preparation_ownership` before parent execution. `beginChildParentExecution()` persists an execution fence before entering the provider/session boundary. Acceptance is recorded transactionally by `onAccepted`; retries reuse the durable owner and never create a fresh parent identity. Boot keeps preparation-owned tasks out of generic retry. If the process is lost after the fence but before acceptance recording, recovery conservatively blocks rather than inferring success or replaying the parent. | `test-sequential.ts` preparation/fence cases around the durable owner, `beginChildParentExecution()`, close/reopen, and the fault-boundary preparation ladder; `test-ledger.ts` authority checks. | **closed** |
| M5-C2: validity-authoritative boot classification | `child-reconciliation.ts` reads every immutable ingress reference through `ContextArtifactStore`, checks content-addressed bytes, parses schemas, verifies cross-reference IDs/source revisions/plan-checkpoint-handoff lineage, checks parent receipt and ownership, compares model/capability identity, and calls the provider read-only `validateContinuation()` when supplied. `startDaemon()` runs this before `reconcileOnBoot()`. Missing, corrupt, stale, or incompatible input is durably blocked with typed evidence; rows alone cannot make a claimed edge resumable. | `test-sequential.ts` missing-checkpoint and corrupt-handoff boot cases; `test-daemon.ts` claimed-edge fail-closed and incomplete-manifest cases; `test-ledger.ts` incomplete ingress classification. | **closed** |
| M5-C3: canonical terminal ordering and atomic outbox replay | `resumeSequentialChild()` records child terminal and aggregate parent lifecycle facts before `finishChild()`/`finishParent()`. `beginChildTerminalSettlement()` durably stores all typed evidence and payloads before the first immutable terminal write. `settleChild()` atomically links child result/receipt/trace, parent receipt/trace, edge, continuation, and both task outcomes. A pending outbox is replayed without provider validation/resume or child session creation. | `test-sequential.ts` asserts verification-before-terminal and child-before-parent trace ordering, exact `childDependency` references, injected evidence-write failure, injected settlement failure, close/reopen replay, and zero additional child sessions. `test-ledger.ts` checks idempotent terminal linkage and immutable terminal transitions. | **closed** |
| M5-C4: delivery-pending truth and retry | `settleChild(..., { deliveryAcknowledged: false })` leaves the edge and both tasks `delivery_pending` after canonical linkage. `child_terminal_settlements` persists receipt/trace/final-receipt acknowledgement bits and bounded failure details. CLI writes a provisional failed receipt, then acknowledges receipt, trace, and final rewrite independently; retries redeliver only and cannot respawn parent or child. | `test-ledger.ts` delivery state, bounded failure, partial acknowledgement, close/reopen, and idempotent final acknowledgement cases; `test-cli.ts` delivery fault ladder for receipt write, trace write, final rewrite, retry, ledger agreement, and session counts. | **closed** |

## Falsification attempts

| Boundary | Result |
|---|---|
| Accepted parent crash authority | **Passed conservatively.** The execution fence is durable before parent execution. A loss before acceptance recording leaves preparation ownership visible to boot and blocks a retry instead of replaying the accepted parent. A recorded acceptance is reused to complete child preparation. There is no path that silently treats the fenced parent as a new standalone attempt. |
| Artifact/provider-valid boot classification | **Passed.** The boot validator hashes/reads and parses the full manifest, checks lineage and provider identity, and uses the provider's read-only target probe. Damaged bytes or a missing/mismatched provider target become durable `blocked` evidence before child spawn. An unconfigured claimed edge also fails closed. |
| Canonical terminal trace/event ordering | **Passed.** Terminal child facts are admitted before child trace finalization; aggregate parent facts are admitted before parent trace finalization; the child event precedes the parent event. Persisted traces and the parent receipt carry the exact child edge, verdict, receipt, and trace references. |
| Atomic terminal outbox replay | **Passed for the terminal protocol boundary.** The outbox is installed before terminal evidence writes. Failures during any evidence write or settlement leave a durable pending record; close/reopen replays immutable payloads and links them without provider resume or another child session. |
| Delivery-pending acknowledgement/retry | **Passed.** External receipt, trace, and final-receipt writes are separately acknowledged. Any failed step records bounded failure and leaves durable `delivery_pending`; a later `--resume` retries delivery only. The CLI fault ladder reaches completed with parent session count unchanged and one child session. |

The conservative C1 disposition is intentional: recovery may block an unacknowledged parent acceptance when the process disappears at the narrow fence boundary, but it must not guess, ship, or execute the parent again. That is safer than the stale implementation's replay behavior.

## Previously closed post-land findings

These remain closed in the repaired tree:

- **CLI edge resume:** `cli.ts` parses mutually exclusive `--resume <edge-id>`, selects deterministic unknown/blocked/terminal outcomes, and routes runnable work only to `resumeSequentialChild()`. `test-cli.ts` covers close/reopen resume and terminal no-op behavior.
- **Persisted plan/checkpoint lineage:** resume loads the durable typed manifest and passes its plan/checkpoint/epoch lineage to the resumed execution; it does not replan from raw ingress. `test-sequential.ts` checks the distinctive persisted-plan marker and epoch transition IDs.
- **Unsupported `maxCostUsd` ingress:** `assertNoMaxCostUsd()` is called at task, parallel, sequential, CLI, and daemon-start ingress. Unsupported caps are rejected before ledger/provider effects rather than being advertised as live interruption budgets. `test-budget.ts` covers CLI, library, sequential, and daemon rejection/no-side-effect paths.
- **Parent `childDependency` linkage:** the aggregate receipt is built from the exact child edge, verdict, receipt reference, and trace reference and is inserted with parent terminal settlement. `test-sequential.ts` checks identity, kind, namespace, and canonical reference equality.
- **Provider-neutral opaque continuation:** the coordinator uses `workspaceContinuationOf()` and persisted provider-declared identity/version; opaque tokens are passed through the ledger and provider capability without jj-specific interpretation. `jj-driver.ts` owns discovery and revision checks. The old stale claim that the sequential coordinator lacked a restart operation is no longer true.

## M5 release gate versus M5.5 scope

There are **no exact M5 release blockers remaining in the repaired tree** for beginning M5.5. The M5 exit gate is limited to the repaired one-child path and its truthful durable outcomes. It does not require M5.5 features.

M5.5 remains future scope and must not be promoted into this gate: passive bounded visible-event continuation records, engine settlement without a model `yield`, public run-ID status, generalized branching/fan-out, corrective strategy recovery, historical checkpoint selection, or automatic background resume. The existing `--resume` operation is an M5 edge selector, not the M5.5 public run/status contract.

## Supporting, non-blocking conformance depth

The following are useful follow-ups, but are not blockers for this M5 closure or reasons to expand M5.5:

- add a successful fake non-jj provider conformance fixture; current code and contracts are provider-neutral in shape, while jj is the only full provider exercised;
- add held-lock/multi-process SQLite contention proof and forced migration-failure rollback proof;
- extend kill-point coverage around every provider/storage boundary, including the narrow pre-outbox in-memory construction interval; current tests cover the durable preparation fence, terminal evidence/settlement faults, and all CLI delivery steps;
- extract the remaining generic jj helper import in `parallel.ts` before broad provider expansion;
- decide the later normal `extensions/task` v2 adapter/self-hosting surface.

These are evidence depth and future conformance items. They do not contradict the repaired M5 invariants or add M5.5 capabilities to the M5 exit gate.

## Verification anchors

The repository gate for this report is:

```text
npx tsx packages/core-v2/test/test-sequential.ts
npx tsx packages/core-v2/test/test-daemon.ts
npx tsx packages/core-v2/test/test-ledger.ts
npx tsx packages/core-v2/test/test-cli.ts
npx tsx packages/core-v2/test/test-budget.ts
npx tsc --noEmit -p packages/core-v2/tsconfig.json
```

The report is READY subject to that required gate passing. No implementation or test change is requested by this closure update.
