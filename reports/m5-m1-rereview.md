# M5 M1 contract and ledger rereview

## Scope and method

Reviewed `e7ec76a07202065c842ef9087119f8fa9fd65922` (`task: Resolve every P0/P1 blocker…`) against every P0/P1 and supporting P2 item in `reports/m5-m1-review.md`. Inspected the changed contracts, ledger migration/state operations, gateway/trace admission, daemon, CLI, workspace driver, and targeted tests.

## Verdict

**BLOCK RUNTIME WIRING.** The prior P0 is closed at the contract layer, and the ledger/gateway hardening resolves most prior P1s. One P1 canonical-path defect remains, and there is still no runtime owner that makes the trusted-producer, checkpoint/resume, claim, settlement, and event contracts true in an execution. Do **not** state `READY FOR RUNTIME WIRING`.

## Finding closure

| Prior finding | Result | Evidence / limitation |
| --- | --- | --- |
| P0 handoff prompt boundary | **Closed at contract layer; runtime enforcement outstanding** | `payloads.ts` caps item/text counts and a 32,768-byte whole JSON payload; hashes replace prompt-bound checkpoint/plan/revision identities. `buildChildHandoff()` canonicalizes, deduplicates, freezes, and `serializeForPrompt()` routes the exported handoff schema through it. The documentation is now honest that lexical checks cannot detect hidden reasoning/source prose and requires a trusted kernel producer. No producer/session ingress exists yet to enforce that promise. |
| P1 identity/path safety and deterministic identity | **Partially closed; see P1-1** | Content-addressed identities, drive/UNC/absolute/traversal/ref rejection, and canonical collection serialization are present. `relativePath` still accepts a noncanonical `.` segment. |
| P1 legal child transitions and atomic parent settlement | **Closed in the ledger API; runtime use outstanding** | `claim*` uses conditional updates; `markChildResumable`, `markChildBlocked`, and `settleChild` constrain edge states; `settleChild` transactionally writes child evidence, edge, continuation, child task, and parent task and rejects conflicting terminal outcomes. `reconcileChildEdgesOnBoot()` classifies claimed edges from ledger references. A coordinator has not wired these operations to actual execution/recovery. |
| P1 competing claims/busy policy | **Implementation closed; evidence incomplete** | `busy_timeout = 250`, conditional `UPDATE ... status = ...`, affected-row checking, and busy-to-`null` claim mapping are present for ready and resumable claims. The supplied two-connection tests are sequential, not a held-lock/concurrent race. |
| P1 gateway/trace child admission | **Closed at the admission boundary; runtime emission outstanding** | `ChildLifecycleEventSchema` enforces bounded logical IDs, hash artifacts, ordinal 1, event-specific status/references, and parent/child outer-ID linkage. `InMemoryTaskGateway.emit()` and `traceEventFromGateway()` admit before retention/projection. No coordinator emits these events. |
| P2 relational invariants/API surface | **Closed** | V3 gives non-null children one parent edge and uses `(child_task_id, workspace_continuation_id)` FK ownership. The duplicate continuation API shapes and ledger aliases were removed. |
| P2 true migration and rollback proof | **Partially closed; see P2-1/P2-2** | The test now creates a pre-v3-shaped database without opening `LedgerStore`, preserves legacy task/session rows, and verifies child DDL. Intent duplicate failure asserts reference/continuation rollback. It does not force a V3 migration failure or a held-lock busy case. |

## Remaining findings

### P1-1 — `relativePath` accepts noncanonical dot segments

**Files/symbols:** `packages/core-v2/src/contracts/payloads.ts`, `relativePath`, `ChildChangedPathSchema`.

`foo/./bar.ts` passes because the guard rejects `..` and empty segments but not `.`. It denotes the same repository path as `foo/bar.ts`, so semantically identical handoffs can retain different changed-path values and different prompt bytes. This is a remaining canonicalization defect at the prompt boundary.

**Required outcome:** reject `.` segments (and add `foo/./bar.ts` plus equivalent-path byte-identity/rejection coverage) before any runtime wiring consumes this contract.

### P1-2 — No sequential runtime owns the hardened contract

**Files/symbols:** absent `packages/core-v2/src/daemon/sequential.ts` (or equivalent); `packages/core-v2/src/daemon/start.ts:startDaemon`; `packages/core-v2/src/daemon/isolated.ts`; `packages/core-v2/src/daemon/parallel.ts`; `packages/core-v2/src/workspaces/jj-driver.ts`; `packages/core-v2/src/cli.ts`; `extensions/task/index.ts`.

Search finds no child handoff construction/serialization consumer outside `payloads.ts`/`serialize.ts`, no child dispatcher, no workspace continuation implementation, and no submit/resume surface. `startDaemon()` only classifies ledger rows. Thus no real session ingress can establish the documented trusted-producer boundary, no actual checkpoint/token is persisted and revalidated with its provider, no claim drives a child through the isolated pipeline, no settlement is reached from child evidence, and no child gateway event is emitted.

**Required outcome:** add one daemon-owned sequential coordinator that: builds and persists the handoff/checkpoint/token atomically after parent acceptance; revalidates the handoff at child session ingress; claims exactly once; invokes the provider continuation capability and the existing isolated pipeline; atomically calls `settleChild`; emits admitted lifecycle events; and exposes the same operation through CLI and the normal task extension. Add hermetic parent→child success, interruption/restart, unsupported/missing provider, and child-failure tests with real SQLite and provider-derived workspace evidence.

### P2-1 — Claim-race/busy test is a false-positive description

**Files/symbols:** `packages/core-v2/test/test-ledger.ts`, M5 claim blocks; `packages/core-v2/src/ledger/store.ts`, `transactionForClaim`.

The test labels sequential calls through two independently opened connections as “two connections make … exactly once.” It opens the second connection only after the first claim commits; it never holds `BEGIN IMMEDIATE`, runs concurrently, or observes the 250-ms busy policy. It proves the already-claimed predicate returns `null`, not the claimed competing-writer behavior.

**Required outcome:** use a separate connection/process to hold the write lock while a ready and then resumable claim runs; assert bounded `null`/documented busy result, rollback recovery, and that exactly one post-release claimant owns the edge.

### P2-2 — Migration rollback remains untested

**Files/symbols:** `packages/core-v2/test/test-ledger.ts`, pre-v3 fixture; `packages/core-v2/src/ledger/store.ts`, `migrate`.

The actual pre-v3 fixture is a material improvement, and `migrate()` now wraps each migration in a transaction. There is no test that forces V3 DDL failure and then proves no partial V3 schema/user-version survives before a corrected reopen. The fixture also duplicates private legacy DDL rather than deriving it from a checked-in versioned fixture, so drift remains possible.

**Required outcome:** add a checked-in v2 fixture (or exported versioned fixture builder), force a V3 failure, assert rollback of all V3 objects and unchanged `user_version`, then reopen successfully and verify legacy rows plus all V3 constraints.

### P3-1 — Targeted contract/gateway/trace execution was unavailable here

**Files/symbols:** `packages/core-v2/test/test-contracts.ts`, `test-gateway.ts`, `test-trace.ts`.

`npx tsx packages/core-v2/test/test-ledger.ts` passed. The other three targeted commands could not start because this checkout has no installed `zod` package (`ERR_MODULE_NOT_FOUND`), not because their assertions failed. Their source was inspected, but their passing status is unverified in this environment.

**Required outcome:** restore/install locked dependencies in CI/local test setup and record successful execution of the three tests; add the P1/P2 adversarial cases above rather than treating static inspection as execution evidence.

## Targeted evidence

- **Passed:** `timeout 120 npx tsx packages/core-v2/test/test-ledger.ts` — real `node:sqlite` migration, FK, transaction, and ledger API suite.
- **Could not execute:** `test-contracts.ts`, `test-gateway.ts`, and `test-trace.ts` — missing `zod` from the checkout.
- **Inspected false-positive/unverified claims:** the two-connection claim labels do not exercise contention/busy; migration rollback failure is untested; literal `transcript`/`source body` sentinel tests do not prove semantic content recognition and must remain framed as trusted-producer/lexical defense, which the implementation documentation now correctly does.

## Non-blocking positives

- Content-addressed prompt-bound revision/checkpoint/plan and artifact identities replace free-form ref/path carriers.
- Edge/continuation cardinality and ownership are database-enforced, including lower-level SQL attempts.
- Terminal settlement carries required result/receipt/trace references and makes conflicting terminal states immutable.
- Child event admission happens before in-memory retention and trace projection.
