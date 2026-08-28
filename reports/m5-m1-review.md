# M5 M1 contract and ledger review

## Scope and method

Reviewed only `8ff2af2771e3` (`task: Add the bounded provider-neutral child continuation contracts and durable transactional ledger state required for one sequential parent-to-child M5 path.`). Compared its changed contract, trace/gateway, workspace, CLI, ledger, and test files against `reports/m5-architecture-survey.md`, active `docs/pi-task-v2*.md`, and `docs/adr/context-control-plane.md`.

## Verdict

**Block runtime wiring.** The additive migration and event names are directionally compatible, and `persistReadyChildIntent()` does roll back its writes on an in-transaction failure. However, the prompt boundary can still carry the prohibited classes of content, the child-edge state machine permits illegal terminal rewrites, and the gateway child details have no runtime bounds. These are contract-level defects, not implementation polish.

## Findings

### P0 — `ChildHandoff` is not a safe bounded prompt boundary

**Files/symbols:** `packages/core-v2/src/contracts/payloads.ts`: `childText`, `ChildRequirementStateSchema`, `childStateArrays`, `ChildHandoffSchema`; `packages/core-v2/src/contracts/serialize.ts`: `serializeForPrompt`.

`childText` accepts arbitrary 2,000-character strings. A producer can therefore put a transcript, private reasoning, command/output tail, or source body in `summary`, `decisions`, `openQuestions`, or `nextActions`; splitting content across the 64-entry arrays bypasses any single-field cap. This is not prevented by `.strict()`, which only rejects unknown keys. There is also no cap on the complete serialized handoff: the four 64×2,000 text collections alone allow 512,000 characters before changed-path and reference payloads, and JSON escaping can expand that further. `serializeForPrompt()` makes key ordering stable but has no size/admission control.

This conflicts with the ADR and active docs' requirement that prompts contain bounded declarative state and never carry transcripts, private reasoning, unrestricted tool output, or source bodies. The tests only prove that fields *named* `transcript`, `privateReasoning`, and `commandOutput` are rejected; they do not prove the actual content boundary.

**Required outcome:** before any prompt/session ingress uses this schema, impose and test a hard serialized-byte/token budget and replace unrestricted free-text collections with a kernel-produced, bounded declarative representation whose producer/revalidation policy rejects prohibited content. If semantic content cannot be mechanically distinguished, document and enforce an explicit trusted-producer boundary rather than claiming the schema itself makes such carriage impossible. Add adversarial tests placing sentinel transcript/output/source text in every admitted text field and across multiple entries.

### P1 — Identity and path fields can encode branches and host paths; prompt identity is not canonical

**Files/symbols:** `packages/core-v2/src/contracts/payloads.ts`: `childIdentity`, `relativePath`, `ChildHandoffSchema`, `ChildArtifactReferenceSchema`; `packages/core-v2/src/contracts/serialize.ts`: `stableStringify`.

`childIdentity` accepts strings such as `refs/heads/feature-x` and `C:/Users/name/work`; `relativePath` accepts Windows absolute/UNC-style paths such as `C:\\Users\\name\\work` because it only rejects leading `/` and `..` path segments. Thus `sourceRevision`, IDs, and changed paths remain carriers for branches and host paths, contrary to the M5 non-goal. `checkpointId` and `planId` are also arbitrary identities rather than immutable artifact references.

Further, arrays are preserved in caller order. The same requirement states, changed paths, and artifact references in different insertion orders serialize to different prompt bytes. The M4 serialization contract only sorts object keys, so this commit does not establish deterministic prompt identity for the new handoff.

**Required outcome:** use an explicit provider-neutral, revision-pinned/content-addressed identity for prompt-bound revision/checkpoint/plan references; reject drive-letter, UNC, absolute, traversal, and branch/ref syntax everywhere a child handoff accepts an identity or path. Define canonical ordering (and uniqueness where appropriate) for every handoff array before serialization, or reject noncanonical order. Add byte-identity and hostile-value tests.

### P1 — Child-edge APIs do not enforce the required state machine or atomically finalize the parent

**Files/symbols:** `packages/core-v2/src/ledger/store.ts`: `setChildStatus`, `transitionChildTerminal`, `setChildTerminal`, `reconcileOnBoot`.

`setChildStatus()` accepts every non-`ready` status from every prior status, without a transaction or source-state predicate. It can change a `completed` edge back to `resumable`, change one terminal result to another through an intermediate status, or mark a ready edge terminal without a claim. `transitionChildTerminal()` likewise permits a ready edge to become terminal. This defeats its own terminal idempotency guarantee and the survey's `ready → claimed → resumable/terminal` ownership model.

The terminal transaction updates the edge and optional workspace-continuation record but never updates the parent task. The survey requires the child edge and parent terminal outcome to be committed together. Boot reconciliation also only requeues/fails generic tasks; it does not classify claimed child edges as resumable/blocked based on checkpoint and continuation validity.

**Required outcome:** replace the general status setter with explicit compare-and-set transitions that encode allowed source states and make all terminal states immutable. Provide one transaction that writes the edge, child/continuation state, parent terminal state, and required result/receipt/trace references together. Add restart tests for each crash point and illegal-transition tests, including terminal-to-resumable and ready-to-terminal rejection.

### P1 — The claimed-once contract is not robust for competing SQLite callers

**Files/symbols:** `packages/core-v2/src/ledger/store.ts`: `transaction`, `claimReadyChild`, `claimResumableChild`; `packages/core-v2/test/test-ledger.ts`: M5 child-edge block.

`BEGIN IMMEDIATE` serializes a successful same-database writer, so two completed sequential calls will not both claim an edge. But a genuinely competing `LedgerStore`/process can receive `SQLITE_BUSY` at `BEGIN IMMEDIATE` (there is no busy timeout/retry/result mapping) rather than the documented `null` loser result. The tests invoke the same store sequentially and do not exercise two database connections or a held write lock. Consequently the public exactly-once API is neither proven nor specified for the competing callers required by the survey.

**Required outcome:** implement a bounded busy policy and a single conditional claim (`UPDATE ... WHERE status = ?` with a checked affected-row count/`RETURNING`) so one caller receives the claim and a competing, completed call deterministically receives no claim. Test two independent connections/processes for both ready and resumable claims, including rollback/busy handling.

### P1 — Child gateway/trace metadata is additive but not runtime-bounded or privacy-safe

**Files/symbols:** `packages/core-v2/src/contracts/gateway-events.ts`: `ChildLifecycleDetail`, `TaskLifecycleEvent`; `packages/core-v2/src/gateway/in-memory.ts`: `InMemoryTaskGateway.emit`; `packages/core-v2/src/contracts/trace.ts`: `traceEventFromGateway`.

Adding discriminants and updating the CLI/trace exhaustive switches preserves the existing vocabulary; that part is additive. The added detail, however, is a TypeScript-only interface: IDs and artifact IDs are unbounded strings, `ordinal` need not be a positive integer, `status` is optional on every event, and the outer `taskId` need not equal either relationship endpoint. `InMemoryTaskGateway.emit()` retains this unvalidated data. `traceEventFromGateway()` copies it verbatim; its generic key-name filter does not reject a transcript/output/host path placed in an allowed value such as `handoffArtifactId`.

The later generic 4,000-character trace fallback is not a substitute for typed gateway admission: it allows smaller sensitive values through and leaves gateway memory unbounded.

**Required outcome:** introduce a strict runtime schema for child lifecycle details with bounded canonical IDs, a positive ordinal, event-specific required fields/statuses, and an invariant tying the outer task ID to the declared parent or child. Parse it before gateway retention and trace projection; use only safe IDs/hashes in the trace. Add malformed, oversized, relationship-mismatch, and sensitive-value tests.

### P2 — Edge/continuation relational invariants are incomplete

**Files/symbols:** `packages/core-v2/src/ledger/store.ts`: `V3_DDL`, `getParentEdge`, `insertWorkspaceContinuation`, `persistReadyChildIntent`.

The migration correctly enables foreign keys per connection and has the required parent/ordinal unique constraint. It does not ensure that a non-null `task_edges.child_task_id` has one parent edge, although `getParentEdge()` silently chooses the first when duplicate parentage is possible. It also cannot enforce that `workspace_continuation_id` belongs to the edge's child task: the foreign key proves only that the continuation row exists. The high-level persist method checks the latter for its inline input, but the public lower-level insertion API leaves the database invariant absent.

**Required outcome:** decide and encode child-parent cardinality for the one-child runtime (normally a unique non-null child edge), and use a composite key/foreign key or remove the independently writable continuation linkage so an edge can only reference its child's continuation.

### P2 — Public continuation APIs are duplicated and overbuilt for the first slice

**Files/symbols:** `packages/core-v2/src/contracts/workspace-driver.ts`: `WorkspaceContinuationCapability`, `WorkspaceContinuationSupport`, `WorkspaceDriver.continuation`, `WorkspaceDriver.preserveContinuation`, `WorkspaceDriver.resumeContinuation`; `packages/core-v2/src/ledger/store.ts`: `NewChildIntent.artifacts`, `NewChildIntent.references`, `lookupParent`, `setChildTerminal`.

There are two equivalent workspace capability shapes (nested `continuation` and direct optional methods), an unused support wrapper, two names for the same intent reference list, and aliases that add no invariant. No driver implements either continuation method in this commit. This leaves the first coordinator to choose precedence and unsupported behavior, which is avoidable API surface rather than useful extensibility.

**Required outcome:** select one optional continuation-capability shape, one reference input name, and one name per ledger operation. Keep only the operations required to persist, claim, resume, and terminally settle one child; add a fake provider conformance test for supported and unsupported cases.

### P2 — Migration and rollback tests do not prove the claimed compatibility guarantees

**Files/symbols:** `packages/core-v2/test/test-ledger.ts`: M5 migration and duplicate-ordinal probes; `packages/core-v2/src/ledger/store.ts`: `migrate`, `persistReadyChildIntent`.

The purported v2 migration test first opens a current v3 database, then only rewrites `PRAGMA user_version = 2`; the v3 tables already exist. It does not open an actual pre-v3 schema. The duplicate-ordinal probe exercises the transactional failure path but does not assert that the inserted handoff/reference/continuation rows were rolled back. There is no test of the new child-table foreign keys, partial migration failure, or competing connections.

**Required outcome:** build a database from the actual v2 DDL (or a checked-in v2 fixture), migrate it, and verify all legacy rows and new DDL. Assert zero child artifacts/continuations/edges remain after each intentional partial-failure point, and add FK and multi-connection claim coverage.

## Required before runtime wiring

1. Resolve P0: make the handoff admission boundary genuinely bounded and incapable of accepting prohibited content, with a whole-payload budget and adversarial tests.
2. Resolve P1 identity/path canonicalization and deterministic array ordering.
3. Resolve P1 state transitions, atomic parent settlement, and restart classification.
4. Resolve P1 competing-claim behavior and typed gateway/trace admission.
5. Add the P2 migration/rollback tests as evidence for the preceding changes; settle the relational and API simplifications before exposing the coordinator surface.

## Non-blocking positives

- V3 uses additive `CREATE TABLE IF NOT EXISTS` DDL, leaves existing tables intact, enables foreign keys, and provides the requested parent/ordinal uniqueness and ready-state index.
- `persistReadyChildIntent()` groups its new continuation, reference, and edge writes in a rollback-on-error transaction.
- `claimReadyChild()`/`claimResumableChild()` use status predicates, and `transitionChildTerminal()` is idempotent only when called through that method with the same already-terminal result.
- The child lifecycle event literals were added rather than renaming existing literals, and the changed CLI and trace switches were updated for them.
