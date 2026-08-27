# pi-task-v2 — Subsystems and Conformance

**Status: Active and normative for v2 implementation shape.** This companion
to [the product contract](pi-task-v2.md) defines the detailed
capability taxonomy, boundary artifacts, context pipeline, observability
contract, and conformance expectations. Historical material under
[`old/`](old/README.md) is non-normative.

## 1. Capability taxonomy

The microkernel controls lifecycle and contracts; providers own effects. Keep
these capabilities separate so locality and deletion are testable:

| Capability     | Provider responsibility                                  | Kernel responsibility                     |
| -------------- | -------------------------------------------------------- | ----------------------------------------- |
| VCS/workspaces | isolate, combine/publish, preserve failed work           | choose, sequence, gate, recover           |
| Environments   | resolve project runtime and execute commands             | bound, cancel, and record calls           |
| Sessions       | host model sessions and expose typed events              | schedule, stop, retry, and enforce yields |
| Context        | source, retrieve, compile, and score context             | apply budgets and boundary schemas        |
| Verification   | run checks and return evidence                           | decide completion from the contract       |
| Artifacts      | persist manifests, receipts, failures, and recovery data | require delivery and link it to a run     |
| Interfaces     | accept commands and stream canonical events              | authorize lifecycle operations            |

An ordered transform is a named, schema-validated payload operation. It is not
a provider and cannot own lifecycle. An observer is read-only and
non-authoritative: it consumes canonical events and cannot alter scheduling,
verification, context, or receipts. Generic hooks that can do either are not a
kernel seam.

Every provider records its name, version, configuration identity, and support
features in the run evidence. Provider conformance includes the unsupported
case and the degraded fallback. A deletion test removes the provider or
transform from an assembled test graph and verifies that the kernel still
terminates safely, emits the expected failure/degradation event, and leaves no
orphaned state.

## 2. Boundary artifacts and handoffs

Only explicit, schema-validated artifacts cross ownership boundaries. The
artifact vocabulary is defined in the source contracts and includes the task
specification, execution bundle, yield, bounded handoff, receipt, verification
evidence, and recovery artifact. Attempt-specific identifiers and timestamps
belong in the ledger/trace envelope, not deterministic prompt payloads.

A sequential child task must persist:

- a parent task id and relationship kind;
- its own spec, bounded context selection, and provenance;
- structured yield, verification, failure, and delivery artifacts;
- a bounded handoff containing facts needed to continue, not a transcript.

The child can request more source through the context provider. It must not
inherit an unbounded parent conversation merely because that is convenient.
Schemas are validated at ingress and again after every ordered transform.
Invalid transformed data fails closed or falls back to the untransformed value
according to the named transform policy; it never silently reaches a model.

## 3. Provider contracts

The contracts below are conceptual requirements; the canonical TypeScript
signatures live under [`packages/core-v2/src/contracts/`](../packages/core-v2/src/contracts/)
and the shipped implementations are the evidence for their exact shape.

### Workspace provider

Workspace semantics are VCS-neutral. A provider supports capability detection,
creation, status, integration, materialization of the verified tree, cleanup,
and preservation/recovery on failure. The default is the jj provider at
[`packages/core-v2/src/workspaces/jj.ts`](../packages/core-v2/src/workspaces/jj.ts),
with orchestration in
[`packages/core-v2/src/daemon/parallel.ts`](../packages/core-v2/src/daemon/parallel.ts).
A future Git worktree provider must conform and be selected by configuration;
no kernel execution branch may mention jj-specific mechanics. Model prompts
must not become a VCS control API.

### Environment and session providers

Environment providers execute through the project's selected runtime and
return bounded stdout/stderr, exit status, timing, and cancellation evidence.
Session providers expose turns, tool activity, model changes, usage, and yield
events without leaking private reasoning. The daemon runner at
[`packages/core-v2/src/daemon/task-runner.ts`](../packages/core-v2/src/daemon/task-runner.ts)
is the assembly evidence.

### Verification and artifact providers

Verification runs against the materialized integrated tree, not a model claim.
Artifact providers persist the receipt, manifest, canonical trace, and failure
recovery evidence. A passing process exit or valid yield is not artifact
acceptance: delivery checks inspect the requested files/behavior and link the
result to verification evidence.

### Interface providers

A shell or bridge interface submits specs, streams the same canonical events,
accepts cancellation, and retrieves receipts. Interfaces are adapters, not
session owners. A disconnect cannot cancel a durable task unless the command
explicitly requests cancellation.

## 4. Context pipeline

Context is a typed pipeline with measurable stages:

```text
source → retrieve → compile → budget → inject → execute → feedback
```

- **Source** exposes repository structure, symbols, files, tests, task ledger
  facts, and verified prior artifacts.
- **Retrieve** combines lexical and structural selection and may add semantic
  signals when a configured experiment supports them.
- **Compile** produces progressive-disclosure views: index/tree, symbol
  outline, selected ranges, and only then full source. It attaches provenance
  and freshness.
- **Budget** predicts and records context tokens, reserves room for work, and
  reports what was omitted. It never hides the escape-hatch tools.
- **Inject** places the selected context into a deterministic, versioned
  boundary payload.
- **Feedback** records repeated reads, misses, acceptance, cost, time, and
  intervention so routing and retrieval can be evaluated.

The first candidate experiment is a symbol graph/tree plus hybrid
lexical/semantic retrieval. Its index technology is intentionally open. The
comparison must include v1's LLM-generated codebase map, baseline v2, and raw
exploration; embeddings are neither required nor presumed. A context provider
must support a no-index/raw fallback and report when its selection was stale or
missed the changed files.

High-information tools make relationships and relevant slices cheap to ask
for. `bash`, `read`, and `grep` remain escape hatches for discovery and unusual
repos. Progressive disclosure is the target interface, not the removal of
those tools.

## 5. Canonical observability contract

The trace is versioned, provider-neutral, and additive. Each event carries a
schema version, run/task/session identity, monotonic sequence, timestamp,
phase, provider/config versions, and a bounded typed payload. Events include,
but are not limited to:

- task/session lifecycle and cancellation/recovery;
- turn start/end and tool start/end, including bounded arguments and result
  summaries;
- context selection, provenance, budget, injection, omission, and feedback;
- model assignment/change and lane;
- input, output, cache usage, and cost when available;
- verification command/result and artifact delivery;
- failures, escalation, and recovery actions.

The event vocabulary is additive and versioned at
[`packages/core-v2/src/contracts/gateway-events.ts`](../packages/core-v2/src/contracts/gateway-events.ts).
The gateway and daemon consume it; logs, interfaces, receipts, and benchmark
adapters must consume it too. No consumer may require private chain-of-thought
storage or expose it as an interface obligation. Summaries and hashes are
sufficient when content would be private or too large.

Observers can lag, drop optional detail, or subscribe at a coarser level, but
must not change authoritative state. Transforms and observers emit their own
provider identity and ordering so an operator can explain how a result was
produced.

## 6. Plugins and ordered transforms

Plugin loading is explicit and configuration-selected. A plugin declares its
capabilities, version, and hooks; the loader reports typed failures. Each
transform runs in a declared order, re-validates its output, and has an
explicit error policy. Each observer is isolated per event and reports handler
failures without taking over the task lifecycle. There is no discovery magic,
ambient mutable registry, or generic hook that can secretly schedule work.

The implementation anchors are
[`packages/core-v2/src/plugins/loader.ts`](../packages/core-v2/src/plugins/loader.ts),
[`packages/core-v2/src/plugins/hooks.ts`](../packages/core-v2/src/plugins/hooks.ts),
and the gateway contracts. Tests must cover successful loading, bad config,
missing exports/import failures, transform ordering, invalid transformed
payloads, observer isolation, and actual gateway wiring.

## 7. Conformance expectations

A provider is conforming only when its real boundary is exercised. The suite
must cover:

1. valid lifecycle from submission through receipt;
2. cancellation at a turn, tool, verification, and interface boundary;
3. timeout, provider failure, malformed payload, and unsupported capability;
4. durable restart/reconciliation with no orphaned task or workspace;
5. artifact delivery and acceptance checks, not just exit status/schema checks;
6. version/config recording and replayable canonical trace;
7. deletion/degraded-path behavior when optional providers or transforms are
   absent;
8. sequential parent/child persistence with bounded handoffs;
9. jj default behavior plus provider-neutral selection boundaries.

Tests should be hermetic where possible and use real subprocess/VCS paths for
those boundaries. The colocated core-v2 tests and extension tests are the
current harness anchors; benchmark experiments add repeated acceptance trials
rather than replacing conformance tests.

## 8. Ledger and durability minimum

The durable store must represent tasks, parent/child edges, attempts, sessions,
workspace ownership, artifacts, provider/config versions, and trace offsets.
The exact schema is implementation-owned and may evolve without changing the
provider-neutral contract. Boot reconciliation must identify active work,
resume or safely fail it, preserve partial work, and make recovery explicit.

A receipt is not the whole trace. The receipt is a compact user-facing outcome;
the trace and artifacts explain lifecycle, cost, context, verification, and
failure without requiring a transcript. Recovery data must be sufficient for a
human or interface to continue or inspect the preserved work.

## 9. Runnable shell slice

The current runnable composition is exposed as:

```sh
mise run v2 -- --spec ./task.md --project-dir . --model provider/model
```

`packages/core-v2/src/cli.ts` is only an interface adapter: it validates the
file and arguments, requires a non-empty model from `--model` or
`PI_TASK_V2_MODEL` (CLI precedence), selects the typed providers, renders
gateway/session progress, and delivers the receipt. The `<provider/model>`
example is a placeholder, not a product default. `src/daemon/isolated.ts`
selects exactly one canonical task, worker, and workspace in the shared daemon
workspace pipeline. The `JujutsuWorkspaceDriver` owns isolation, integration,
cleanup, and recovery; `parallel.ts` owns the provider-neutral composition
flow for both isolated and multi-worker modes; the environment driver owns
verification; and the ledger/gateway/session contracts own durability and
events. The shell
contains no jj commands or workspace lifecycle policy.

The slice is deliberately limited to one task and one worker. It uses external
user-state defaults keyed by project (and `XDG_STATE_HOME` when set), writes a
portable receipt artifact, and keeps failure evidence in the existing artifact
contract. `packages/core-v2/test/test-cli.ts` is the hermetic evidence: fake
session, real temporary jj repository, real verification, typed progress,
receipt delivery, success cleanup, and verification-failure recovery.

## 10. Evidence and migration

Every proposed optimization starts with a baseline and a falsifiable
acceptance check. Run repeated trials, measure accepted-result quality, cost,
time, intervention, context volume, repeated reads, tool mix, and regressions,
then retain or delete the candidate. Negative results are named and stored.

Migration follows **inventory → shadow → flip → delete**. v1 parity protects
users while ownership moves to the kernel, but parity is not evidence that a
context strategy or product workflow is good. The active product contract
contains the MVP proof gate; this document defines the seams that make that
gate inspectable.
