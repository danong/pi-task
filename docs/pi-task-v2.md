# pi-task-v2 — Product and Runtime Contract

**Status: Active.** This is a current source of truth for v2 product intent and
runtime behavior. The companion documents are [subsystems](pi-task-v2-subsystems.md)
(the detailed capability, contract, and conformance specification) and
[future](pi-task-v2-future.md) (deferred scale and product work). Historical
reviews, handoffs, investigations, plans, and superseded workflow/testing
material is archived under [`old/`](old/README.md) and is non-normative.

## Product philosophy

pi-task-v2 is a **context-efficient coding engine with a reliable microkernel**.
Its primary outcome is accepted-result quality per dollar and minute,
particularly when using cheaper or open-weight models. The execution runtime
supports that differentiation: it makes work durable, bounded, observable,
and recoverable, but it is not itself the product advantage.

This makes context engineering a product capability, not prompt decoration.
The engine should spend tokens on information that changes the result, retain
useful context across work, and prove that the requested artifact was delivered.
The loop is **baseline → experiment → measure → retain or delete**. v1 parity is
a safety gate for migration, never product success.

## Source of truth and scope

The active design set is:

- this document: product contract, MVP, runtime responsibilities, and evidence;
- [pi-task-v2-subsystems.md](pi-task-v2-subsystems.md): detailed provider
  taxonomy, payloads, trace contract, and conformance expectations;
- [pi-task-v2-future.md](pi-task-v2-future.md): work deliberately deferred
  until measured demand justifies it;
- [pi-task-design.md](pi-task-design.md): the active v1 compatibility and
  safety contract used as a migration reference.

The implementation is the final authority for shipped behavior. Source paths
linked below are evidence anchors, not an inventory snapshot.

v2 accepts a validated task specification, runs bounded coding sessions in an
isolated workspace, verifies the resulting tree, and returns a structured
receipt plus durable evidence. A task may have sequential children. Parallel
execution is an available foundation capability, but it is not required by the
MVP.

## The microkernel

The kernel owns only control-plane invariants:

- task and session lifecycle, durable state, scheduling, cancellation, and
  crash recovery;
- routing and bounded execution policy;
- schema/contract enforcement, verification gates, artifact delivery, and
  failure handling;
- recording the version and configuration that produced each run.

Explicit capability providers own replaceable effects and domain knowledge:

- VCS and workspace isolation;
- project environment and command execution;
- model/session hosting;
- context source, retrieval, compilation, and working memory;
- verification;
- artifact storage and delivery;
- user and automation interfaces.

A provider is selected by configuration and is called through a typed contract.
An **ordered transform** may change a typed payload at a named boundary and is
validated before it continues. A **non-authoritative observer** may consume
trace events, metrics, or receipts but cannot decide lifecycle, mutate a task,
or silently affect a prompt. Neither is a capability provider. This distinction
prevents a generic hook from becoming an invisible second orchestrator.

Every seam must have locality: its behavior, configuration, version, and tests
should be findable together. A deletion test demonstrates that removing a
provider or transform leaves the kernel correct, with an explicit degraded
behavior rather than a hidden dependency. Conformance suites exercise the
provider contract through its real boundary, including failure and cancellation
paths. The kernel must not route control flow through untyped, ambient,
order-dependent hooks; ordered transforms are named and observable, and
observers are non-authoritative.

## Workspace and execution model

Task semantics are VCS-neutral: create an isolated task workspace, apply work,
combine or publish it, preserve failed work for recovery, and report the
resulting artifact. **Jujutsu is the default workspace provider** and its
implementation is anchored at [`packages/core-v2/src/workspaces/jj.ts`](../packages/core-v2/src/workspaces/jj.ts)
and the parallel pipeline at
[`packages/core-v2/src/daemon/parallel.ts`](../packages/core-v2/src/daemon/parallel.ts).
The existing extension implementation remains a migration reference at
[`extensions/task/workspace.ts`](../extensions/task/workspace.ts).

A future Git provider must implement the same provider contract and be
selectable by configuration without changing kernel execution code. Model
prompts may describe task goals and resulting files, but model-facing VCS
knowledge is separate from engine-owned workspace mechanics. The model should
not need to know whether isolation used jj, Git worktrees, or another provider.

The normal sequential path is:

```text
validate → route → create workspace → run session → yield → verify
→ persist parent/child and artifacts → deliver receipt
```

A child receives a bounded handoff, not the parent's transcript. The ledger
records the parent/child relationship, each child has structured artifacts and
its own receipt, and handoffs contain only the bounded facts needed to continue.
Parallel workers may fan out and combine deterministically through the same
provider-neutral semantics; their availability must never make a sequential
MVP task impossible.

## Context engineering

Context is explicit and measurable. The runtime exposes separate capabilities
for:

- **source:** repository files, symbols, tests, task history, and verified
  project facts;
- **retrieval:** lexical, structural, and optionally semantic selection;
- **compilation:** turn selected source into outlines, slices, bundles, or
  task-specific views;
- **working memory:** bounded task state, parent/child receipts, and handoffs;
- **provenance:** source paths, revisions, selectors, freshness, and why an
  item was included;
- **token budget:** estimates and actual usage assigned to context inputs;
- **feedback:** acceptance, misses, repeated reads, corrections, and routing
  telemetry.

High-information tools should answer questions such as “where is this symbol
implemented?”, “what calls it?”, “which verification covers this behavior?”,
or “what changed since the last accepted receipt?”. They should support
progressive disclosure: a compact index first, then a symbol/tree view, then
selected source, with full-file access when needed. `bash`, `read`, and `grep`
remain escape hatches for unknown or unusual repositories; they are not the
target cognition interface.

The first context experiment is a candidate, not a mandate: a symbol graph/tree
combined with hybrid lexical/semantic retrieval. Compare it with v1's
LLM-generated codebase map and with raw exploration. Do not assume embeddings,
a vector store, or a particular index technology before measurement shows that
it helps. A candidate survives only if repeated trials improve accepted-result
quality for a justified cost/time envelope; an honest negative result is useful
and remains in the benchmark record.

## Observability contract

Every run emits a canonical, versioned event/trace contract. It must represent
lifecycle transitions, turn boundaries, tool activity, context selection and
injection, model changes, input/output/cache token usage, cost, verification,
artifact delivery, and failures. Events include run/task/session identity,
ordering, timestamps, provider/config versions, and bounded payloads suitable
for replay and aggregation. The contract is provider-neutral and additive
across versions.

Interfaces, logs, receipts, and benchmarks consume this same contract; they do
not invent parallel progress vocabularies. Observability may include summaries,
selected inputs, hashes, and provenance, but it must not require storage or
exposure of private chain-of-thought. A trace is evidence about execution, not a
request to retain hidden reasoning.

The existing event and gateway foundations are at
[`packages/core-v2/src/contracts/gateway-events.ts`](../packages/core-v2/src/contracts/gateway-events.ts),
[`packages/core-v2/src/contracts/task-plugin.ts`](../packages/core-v2/src/contracts/task-plugin.ts),
and [`packages/core-v2/src/daemon/task-runner.ts`](../packages/core-v2/src/daemon/task-runner.ts).
The detailed versioning and conformance rules live in the companion subsystems
document.

## Benchmarking and proof

Benchmarking is a first-class capability, not a final demo. The harness compares
raw pi, v1, baseline v2, and context-enhanced variants using repeated trials,
fixed task fixtures where practical, and acceptance checks that inspect the
requested artifact. Report at least:

- accepted-result success and acceptance quality;
- cost per accepted result, total cost, and time;
- human intervention and escalation;
- context volume, repeated reads, and tool-call mix;
- verification failures, regressions, and neutral or negative experiments.

A shell command exiting zero or a schema validating proves only that a command
or payload succeeded. Neither proves that the requested artifact was delivered.
Acceptance checks must inspect the artifact, its relevant behavior, and the
verification evidence. When an experiment is neutral or negative, retain the
result, diagnose its cost and failure mode, and do not promote it by enthusiasm.

The benchmark source and runnable paths are documented by the implementation's
benchmarks and tests; the active conformance expectations are in
[pi-task-v2-subsystems.md](pi-task-v2-subsystems.md). Claims about quality,
cost, or time belong to measured records rather than this design document.

## Completed M1–M3 MVP foundation

M1–M3 are complete as an evidence-backed MVP foundation. This records shipped
contracts and test/evidence coverage, not a product-success claim. Parallel
execution, grounding modes, and optional enabling modules do not make a real-
model efficiency or quality claim for the MVP.

The source-of-truth implementation paths include:

- [`packages/core-v2/src/daemon/start.ts`](../packages/core-v2/src/daemon/start.ts)
  and [`task-runner.ts`](../packages/core-v2/src/daemon/task-runner.ts) for
  assembly and lifecycle;
- [`packages/core-v2/src/daemon/parallel.ts`](../packages/core-v2/src/daemon/parallel.ts)
  and [`packages/core-v2/src/workspaces/jj.ts`](../packages/core-v2/src/workspaces/jj.ts)
  for optional parallel isolation and combination;
- [`packages/core-v2/src/contracts/`](../packages/core-v2/src/contracts/)
  and [`packages/core-v2/src/plugins/`](../packages/core-v2/src/plugins/)
  for typed boundaries and extension loading;
- [`packages/core-v2/src/workspaces/failure-hygiene.ts`](../packages/core-v2/src/workspaces/failure-hygiene.ts)
  and the colocated tests for recovery evidence;
- [`extensions/task/index.ts`](../extensions/task/index.ts) and the tests under
  `extensions/task/` for the migration reference and observable behavior.

## Runnable engine slice (shipped)

The first runnable-engine vertical slice is available through the project
command:

```sh
mise run v2 -- --spec ./task.md --project-dir . --model provider/model
```

The command accepts a markdown file containing `Goal`, `Requirements`,
`Verification`, and the required `Artifact Policy` section. It validates the
policy before provider work, boots `startDaemon()` for ledger reconciliation,
and executes one canonical task with one worker and one workspace through
`daemon/isolated.ts`. The model must be supplied as a non-empty
`--model <provider/model>` value or `PI_TASK_V2_MODEL`; the CLI value wins when
both are present. The placeholder in the example is not a product default.
The default `JujutsuWorkspaceDriver` provisions an isolated workspace,
performs engine-derived VCS finalization, integrates successful changes with
task-base semantics, and runs verification on the integrated project tree.
Progress is rendered from typed gateway and session events only. A compact
receipt and versioned trace are atomically delivered; failed runs retain typed
failure/recovery evidence. State and artifacts default to the user state
location (keyed by project, honoring `XDG_STATE_HOME`) rather than the
checkout.

Ownership is intentionally narrow: `src/cli.ts` parses/validates arguments,
selects providers, renders progress, and delivers receipts;
`src/daemon/isolated.ts` selects the single-task composition of the shared
workspace/session/integration pipeline; `src/daemon/parallel.ts` retains the
multi-worker composition and its aggregate semantics; and the workspace,
environment, session, gateway, and ledger modules own their respective
contracts. The slice is limited to a
single task and worker: cancellation, scheduling, child dispatch, remote
surfaces, and multi-worker user commands remain deferred.

A CLI spec declares mechanically checkable delivery policy, for example:

```markdown
## Artifact Policy
- Required: reports/result.json
- Change required
```

Use `- Intentional no-change` only when verification is expected to pass with
no integrated change. Required paths must be repository-relative. Strict
ingress rejects missing, empty, unsafe, duplicate, contradictory, or unknown
policy entries. Post-integration acceptance compares required and claimed
paths with the actual tree, checks the engine-derived commit identity and the
verification result, and then requires receipt and trace delivery. Rejection
reasons are typed and recovery artifacts preserve what can be recovered. This
mechanical gate does not prove semantic user intent beyond declared artifacts
and verification.

M3's worker protocol is requirement-sensitive: a checklist is enabled for
multi-requirement specs, while a single-requirement spec avoids that ceremony.
The worker makes exactly one typed `yield` call with `files_changed`, `summary`,
and `deviations`; engine code owns VCS finalization and verification after the
yield. Real-model efficiency improvement has not yet been measured.

Hermetic evidence is in `packages/core-v2/test/`, including versioned trace
fixtures under `packages/core-v2/test/fixtures/`, and is registered in
`packages/core-v2/test/run-all.ts`. It uses fake sessions with real temporary
jj repositories and real verification to prove protocol, isolation,
acceptance, trace delivery, and recovery behavior. These fixtures are evidence
inputs, not performance claims or model defaults. Run
`npx tsx packages/core-v2/test/test-cli.ts` for the CLI slice; the real-model
e2e remains a separate manual gate.

Render provider-neutral benchmark output from validated trace artifacts with:

```sh
mise run bench-report -- --traces-dir <trace-directory> --label <label>
```

The report records accepted outcomes, cost when measured, observed turns, tool
calls, repeated reads, context and elapsed metrics when available, and
verification/acceptance failures. Missing measurements remain `unavailable`;
the report does not infer them.

## M4 context experiment complete; M5–M6 deferred

M4 ships an opt-in context capability in the runnable v2 CLI. `raw` is the
correct default no-injection baseline; `symbol-tree` scans and retrieves
bounded progressive-disclosure handles before session spawn, and exposes a
bounded query/resolve worker tool. Both retain ordinary read/search/bash
escape hatches. Canonical `context.selected`, `context.injected`, and
`context.omitted` events record provider/version, source tree identity,
provenance, counts, omissions, and estimated size. Provider failures are typed
in trace evidence and degrade to raw without failing otherwise-correct work.

`mise run context-eval` renders a provider-neutral zero-model dry plan and
`mise run context-report -- <trace-jsonl>` derives comparison data from
canonical artifacts/traces. The harness includes raw, the v1 deterministic map
shape as a recorded baseline adapter, and symbol-tree; it preserves unavailable
cost, repeated-read/tool/turn activity, acceptance, neutral/negative results,
and source trace identities. It deliberately claims no unmeasured quality or
cost advantage. M5 workflow/migration work and M6 repeated proof/scale
decisions remain deferred and are not implemented here.

Each gate must publish canonical traces, benchmark results, and conformance
 evidence. No model/provider default or snapshot number is implied by the
fixtures or by a dry evaluation plan.

## Safe migration loop

Migration uses **inventory → shadow → flip → delete**. Inventory maps each v1
behavior to an owning v2 seam. Shadow runs the candidate beside v1. Flip makes
the candidate the default only after conformance and parity evidence. Delete
removes superseded paths only after a deletion test proves the capability is
still supplied by its declared owner.

Product development uses the separate loop **baseline → experiment → measure →
retain or delete**. This keeps safe migration from turning v1 behavior into an
untested product requirement. The archive index identifies historical claims
that must not override this contract.

## Non-goals for the MVP

Remote multi-user scale, multi-tenant isolation, episodic memory, dynamic
cost-aware routing, always-on adversarial review, and program-level autonomy
are deferred. See [pi-task-v2-future.md](pi-task-v2-future.md). They may be
implemented later only when the MVP evidence makes their demand and cost clear.
