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
| Context        | source, index, retrieve, rank, and materialize evidence  | plan, budget, validate, assemble, checkpoint, and trace context |
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

## 4. Context control plane and acquisition capabilities

Context has a kernel-owned lifecycle and provider-owned information stages:

```text
snapshot → acquire candidates → plan → materialize → assemble epoch
         → execute → checkpoint or finish → feedback
```

### Kernel control plane

The kernel owns the behavior that must remain correct when every optional
acquisition provider is removed:

- derive explicit information needs from the validated task and working state;
- validate provenance, freshness, sensitivity, and content identity;
- allocate separate economic, context-window, and attention budgets;
- select and deduplicate provider candidates under hard materialization caps;
- assemble deterministic prompt segments and keep volatile ledger fields out;
- plan cache-affine prefixes from gateway capabilities without requiring a
  provider cache for correctness;
- externalize large tool results as artifact references;
- persist bounded working checkpoints and begin a new execution epoch when the
  current tail is stale, noisy, over budget, or tied to a changed model;
- record actual usage and acceptance feedback without inventing unavailable
  cache attribution.

A context provider never writes directly into a prompt. Provider output is
schema-validated and bounded again at the model/tool boundary. Raw execution is
an empty context plan with ordinary escape-hatch tools, not an implementation
that imports every optional acquisition backend.

### Acquisition capabilities

Explicit capabilities include, but are not limited to:

- **Source:** exposes a revision-pinned snapshot of repository structure,
  files, tests, diagnostics, task artifacts, or verified project facts.
- **Index:** derives content-addressed symbol, syntax, relationship, or other
  searchable facts.
- **Retrieve/rank:** proposes handles against information needs using lexical,
  structural, diagnostic, or optional semantic signals.
- **Materialize:** resolves handles into bounded outlines or exact ranges; full
  files remain deliberate reads.
- **Artifact storage:** stores immutable source views, context plans, and
  checkpoints by identity; storage backends cannot alter their semantics.

The built-in symbol tree is the first source/index/retrieval candidate. It is
an information-gathering tool, not the context lifecycle owner. Its comparison
includes v1's generated map and raw exploration. Embeddings and external vector
stores remain optional experiments, not architectural assumptions.

### Cache and epoch model

Local artifact reuse, provider prompt-prefix caching, and in-session prefix
reuse have separate identities and evidence. A model adapter describes cache
support, compatibility, pricing, and attribution when known. The kernel emits a
provider-neutral cache plan; the adapter maps that plan to provider-specific
controls. Model changes never assume cache transfer.

Prompt segments are ordered from stable to volatile: kernel/tool contract,
repository capsule, task evidence, working checkpoint, then recent interaction.
All prompt-bound serialization is deterministic. A cache hit may reduce cost or
latency but does not reduce context-window use or attention dilution, so cached
material still has to earn inclusion.

An execution epoch binds one model/cache profile to one context plan and a
bounded mutable tail. Before an epoch ends, the engine persists structured
working state such as requirement status, evidence references, decisions,
open questions, verification state, and next actions. It does not persist or
require private chain-of-thought. A continuation or child starts from artifacts
and checkpoint state rather than replaying an unbounded transcript.

High-information tools make relationships and relevant slices cheap to ask
for. `bash`, `read`, and search remain escape hatches for discovery and unusual
repositories. Progressive disclosure is the target interface, not the removal
of those tools.

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

### Completed M1 observability behavior

M1 ships this contract as a bounded trace artifact with a versioned,
provider-neutral event vocabulary. It records observed turns as well as
lifecycle, tool, context, model, usage, verification, artifact, and recovery
activity, without requiring transcripts or private reasoning. Usage is
explicitly `measured` or `unavailable`; a zero value with the latter status is
not an observed performance result. Versioned baseline trace fixtures are
stored with the core-v2 test evidence. They are evidence inputs for validating
parsing, derivation, and reporting, not performance claims or model defaults.

The provider-neutral report command consumes validated trace files or stored
records:

```sh
mise run bench-report -- --traces-dir <trace-directory> --label <label>
```

It reports accepted outcomes, cost when measured, turns, tool activity,
repeated reads, context and elapsed values when available, verification and
acceptance failures, and unavailable metrics. It does not fill missing values
from assumptions.

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
gateway/session progress, and delivers the receipt and trace. The
`<provider/model>` example is a placeholder, not a product default.
`src/daemon/isolated.ts` selects exactly one canonical task, worker, and
workspace in the shared daemon workspace pipeline. The
`JujutsuWorkspaceDriver` owns isolation, engine-derived VCS finalization,
integration, cleanup, and recovery; `parallel.ts` owns the provider-neutral
composition flow for both isolated and multi-worker modes; the environment
driver owns verification; and the ledger/gateway/session contracts own
durability and events. The shell contains no jj commands or workspace
lifecycle policy.

The CLI requires an explicit artifact policy in the task markdown:

```markdown
## Artifact Policy
- Required: reports/result.json
- Change required
```

Use `- Intentional no-change` when a passing verification is expected with no
integrated change. Policy paths are repository-relative. Strict ingress
validation rejects missing, empty, unsafe, duplicate, contradictory, or
unrecognized entries. Post-integration acceptance mechanically compares
required and claimed paths with the integrated tree, checks the engine-derived
identity and verification result, and requires receipt and trace delivery.
Rejection and recovery evidence is typed, and any failed acceptance or
delivery is non-ship. This does not prove semantic user intent beyond declared
artifacts and verification.

The M3 worker protocol is requirement-sensitive: multi-requirement specs get
the checklist tool, while a single-requirement spec does not. Completion is a
one-shot typed `yield` with `files_changed`, `summary`, and `deviations`; the
engine owns VCS finalization and verification after that call. Real-model
efficiency improvement has not yet been measured.

The slice is deliberately limited to one task and one worker. It uses external
user-state defaults keyed by project (and `XDG_STATE_HOME` when set), writes a
portable receipt artifact, and keeps failure evidence in the existing artifact
contract. `packages/core-v2/test/test-cli.ts` is the hermetic evidence: fake
session, real temporary jj repository, real verification, typed progress,
receipt delivery, success cleanup, and verification-failure recovery.

## 10. Roadmap status and bootstrap gates

### M4 status

The deterministic symbol-tree acquisition candidate is implemented as an
opt-in experiment. The CLI records `raw` or `symbol-tree` selection, injects
bounded handles, and exposes bounded query/resolve behavior without removing
ordinary exploration tools. Scan or retrieval failure records typed evidence
and degrades to raw. The comparison harness derives context volume, selected
handles, reads, tool activity, repeated reads, turns, measured or unavailable
cost, and acceptance while retaining neutral and negative results.

This proves acquisition-provider mechanics, not completion of the context
subsystem. The current `ContextProvider` contract is a prototype seam to be
split or adapted behind the kernel control plane described above. M4 remains
open until context plans, immutable artifact references, multidimensional
budgets, cache-oriented assembly, working checkpoints, and execution epochs
have boundary schemas, deletion behavior, and runnable evidence.

### M5 status

M5 remains unimplemented. It adds durable sequential parent/child composition
using M4 context plans and checkpoints rather than transcripts. Conformance
must cover child workspace isolation, bounded handoff and return artifacts,
parent integration, interruption/recovery, provider deletion, and canonical
receipts/traces.

The product gate is self-hosting: the normal pi task surface can choose v2 and
use it for focused work on this repository; continuation reuses workspace and
structured state; accepted output passes the repository's actual verification
and artifact policy. Internal ledger rows alone do not satisfy the gate.

M6 scope is intentionally undecided until this bootstrap loop is demonstrated
and discussed. Existing remote, parallel, plugin, or benchmark foundations do
not imply a cutover or scale decision.

## 11. Evidence and migration

Every proposed optimization starts with a baseline and a falsifiable
acceptance check. Run repeated trials, measure accepted-result quality, cost,
time, intervention, context volume, repeated reads, tool mix, and regressions,
then retain or delete the candidate. Negative results are named and stored.

Migration follows **inventory → shadow → flip → delete**. v1 parity protects
users while ownership moves to the kernel, but parity is not evidence that a
context strategy or product workflow is good. The active product contract
contains the MVP proof gate; this document defines the seams that make that
gate inspectable.
