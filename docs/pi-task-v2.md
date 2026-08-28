# Project Tau — Product and Runtime Contract

> **Naming:** Project Tau is the working standalone name for the engine currently
> implemented as `pi-task-v2` / `packages/core-v2`. Tau is `2π`, but the product
> name deliberately avoids `pi-task`, which already names v1. Existing package,
> command, state, and document identifiers remain unchanged until M6 extraction.

**Status: Active.** This is the current source of truth for Project Tau product
intent and runtime behavior. The companion documents are [subsystems](pi-task-v2-subsystems.md)
(the detailed capability, contract, and conformance specification) and
[future](pi-task-v2-future.md) (deferred scale and product work). Historical
reviews, handoffs, investigations, plans, and superseded workflow/testing
material is archived under [`old/`](old/README.md) and is non-normative.

## Product philosophy

Project Tau is a **context-efficient coding engine with a reliable
microkernel**. Its primary outcome is accepted-result quality per dollar and
minute, particularly when using cheaper or open-weight models. The execution
runtime supports that differentiation: it makes work durable, bounded,
observable, and recoverable, but it is not itself the product advantage.

This makes context engineering a product capability, not prompt decoration.
The engine should spend tokens on information that changes the result, retain
useful context across work, and prove that the requested artifact was delivered.
The loop is **baseline → experiment → measure → retain or delete**. Historical
v1 behavior is a useful compatibility reference, not a permanent parity gate or
a reason to duplicate real work.

## Source of truth and scope

The active design set is:

- this document: product contract, MVP, runtime responsibilities, and evidence;
- [pi-task-v2-subsystems.md](pi-task-v2-subsystems.md): detailed provider
  taxonomy, payloads, trace contract, and conformance expectations;
- [pi-task-v2-future.md](pi-task-v2-future.md): work deliberately deferred
  until measured demand justifies it;
- [pi-task-design.md](pi-task-design.md): the active v1 compatibility and
  safety contract used as a migration reference;
- [context-control-plane ADR](adr/context-control-plane.md): the accepted M4
  kernel/provider/cache/checkpoint ownership decision.

The implementation is the final authority for shipped behavior. Source paths
linked below are evidence anchors, not an inventory snapshot.

### Current state for a fresh session

- **Shipped M1–M5:** typed execution, context control plane, bounded execution,
  and durable sequential parent→child continuation exist in the current v2
  implementation.
- **Active M5 hardening:** a post-land review found gaps in crash-authoritative
  preparation, public edge resume, persisted-plan lineage, cost-cap honesty,
  and terminal evidence. Repairs may exist on an unlanded development stack;
  do not describe them as shipped until repository gates pass and `main` moves.
- **Planned M5.5:** general recovery for every admitted attempt, using passive
  Pi JSON event capture, full resume, partial fork, and engine-owned settlement.
  These public run-ID interfaces are not shipped merely because child-edge
  continuation exists.
- **Planned M6:** extract the engine under the Project Tau name, make it the
  standalone default, archive v1 outside its active context, and improve Tau
  through real-project dogfood and cohort experiments rather than shadow runs.

Tau accepts a validated task specification, runs bounded coding sessions in an
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
- context sources, indexes, retrieval, ranking, and bounded materialization;
- verification;
- artifact storage and delivery;
- user and automation interfaces.

The context **control plane** remains a kernel responsibility: it validates
provider output, allocates economic/window/attention budgets, assembles stable
prompt segments, records cache plans and actual usage, and owns execution epochs
and durable checkpoints. Providers may propose context artifacts; they may not
inject arbitrary prompt text or bypass kernel budgets. This division keeps
retrieval replaceable without making correctness, cache affinity, or resumption
provider-specific.

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

Task semantics are source-control-neutral: create an isolated task workspace,
apply work, combine or publish it, preserve failed work, identify restorable
snapshots, and report the resulting artifact. The kernel depends only on typed
workspace capabilities. Isolation, snapshot, restore/fork, integration,
preservation, and publication return opaque provider tokens; kernel contracts
must not contain jj revsets, Git refs/worktree paths, SVN working-copy details,
branch names, or host paths.

**Jujutsu is the current default provider**, implemented behind
[`packages/core-v2/src/contracts/workspace-driver.ts`](../packages/core-v2/src/contracts/workspace-driver.ts)
and [`packages/core-v2/src/workspaces/jj-driver.ts`](../packages/core-v2/src/workspaces/jj-driver.ts).
It is evidence for the contract, not a kernel dependency. Git, SVN, remote
workspace, or other providers must be selectable by configuration and pass the
same capability conformance suite without changing daemon control flow. A
provider that cannot snapshot at every turn may expose a weaker capability and
cause exact historical workspace fork to be unavailable; context resume must
still work from the latest valid provider token.

The normal sequential path is:

```text
validate → route → create workspace → run session → yield → verify
→ persist parent/child and artifacts → deliver receipt
```

A shipped M5 child receives a bounded handoff, not the parent's transcript. The
ledger records the parent/child relationship, each child has structured
artifacts and its own receipt, and handoffs contain only the bounded facts
needed to continue. M5.5 adds a separate **local operational attempt journal**
for recovery; it is not a canonical handoff, receipt, or trace and does not
change child task semantics. Parallel workers may fan out and combine
deterministically through the same provider-neutral capabilities; their
availability must never make a sequential task impossible.

## Context engineering

Context management is an information lifecycle, not a synonym for a long model
transcript. It has distinct responsibilities:

- **information acquisition:** sources, indexes, diagnostics, lexical or
  structural retrieval, and bounded materialization;
- **context planning:** select evidence against explicit information needs and
  allocate economic, context-window, and attention budgets;
- **assembly:** render deterministic segments with provenance, freshness,
  sensitivity, and stable identities;
- **execution epochs:** run a model against one context plan while keeping the
  mutable interaction tail small;
- **working state:** persist requirement status, evidence references,
  decisions, unresolved questions, verification state, and next actions
  without private chain-of-thought;
- **feedback:** connect selection and cache evidence to reads, edits,
  verification, acceptance, cost, time, and intervention.

A cached token can be cheaper while still consuming context-window and
attention capacity. The engine therefore treats local artifact reuse,
provider prompt-prefix caching, in-session prefix reuse, and environment caches
as different mechanisms. Cache behavior can influence a plan but cannot make
stale or low-value context correct. Model/provider adapters report their cache
capabilities and actual cache reads/writes when available; unavailable segment
attribution remains explicitly unavailable.

Prompt-bound context is assembled from immutable, content-addressed artifacts.
Stable kernel/tool and repository segments precede task-specific evidence;
working state and recent interaction remain a bounded mutable tail. When the
tail becomes stale, noisy, too large, or tied to an unsuitable model, the
engine persists a typed checkpoint and begins a new execution epoch. A model
swap is one possible epoch policy, not a kernel milestone or a guarantee of
cache continuity. Planning by a stronger model, when selected, must produce a
bounded plan artifact rather than leaving its useful work only in a transcript.

High-information tools should answer questions such as “where is this symbol
implemented?”, “what calls it?”, “which verification covers this behavior?”,
or “what changed since the last accepted receipt?”. They use progressive
disclosure: repository capsule, handles, outlines, selected ranges, and only
then full source. `bash`, `read`, and search remain escape hatches for unknown
or unusual repositories; they are not the target cognition interface.

The shipped deterministic symbol tree is an **information-acquisition
candidate**. It supplies bounded, provenance-bearing file and symbol handles
and a query tool. It does not by itself solve context planning, prompt cache
affinity, working-state persistence, epoch transitions, or resumption. Compare
it with v1's generated map and raw exploration. Retain, revise, or delete it
from measured accepted-result evidence; do not infer an overall context-system
win from hermetic provider conformance.

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

M5.5 recovery uses a distinct, local, bounded **attempt journal** populated
passively from Pi's visible JSON event stream. It may retain normalized visible
messages and paired tool calls/results for failed or in-flight attempts, but it
must never enter canonical traces, receipts, portable handoffs, or public
artifacts. It is versioned, size-capped, subject to retention/deletion policy,
and accessed through a replaceable journal-store capability. Successful runs
incur no extra model turns or inference tokens; replay input is paid only when a
resume or fork is requested.

The existing event and gateway foundations are at
[`packages/core-v2/src/contracts/gateway-events.ts`](../packages/core-v2/src/contracts/gateway-events.ts),
[`packages/core-v2/src/contracts/task-plugin.ts`](../packages/core-v2/src/contracts/task-plugin.ts),
and [`packages/core-v2/src/daemon/task-runner.ts`](../packages/core-v2/src/daemon/task-runner.ts).
The detailed versioning and conformance rules live in the companion subsystems
document.

## Benchmarking and proof

Benchmarking is a first-class capability, not a final demo. The harness can compare
raw execution, historical v1 evidence, baseline Tau, and context-enhanced
variants when a specific experiment requires it. M6 does not require duplicate
v1/v2 shadow execution: normal real-project tasks run one selected variant and
record an experiment identity. Repeated fixtures remain useful for regression
reproduction, while acceptance checks inspect the requested artifact. Report at least:

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
- [`packages/core-v2/src/daemon/parallel.ts`](../packages/core-v2/src/daemon/parallel.ts),
  [`workspace-driver.ts`](../packages/core-v2/src/contracts/workspace-driver.ts),
  and the current [`jj-driver.ts`](../packages/core-v2/src/workspaces/jj-driver.ts)
  for provider-neutral isolation/combination contracts and their default implementation;
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

## Roadmap baseline

### M4 — context subsystem

M4 is implementation-complete and hermetically stabilized. The kernel now owns
versioned context plans, immutable user-state artifact references, separate
economic/window/attention budgets, deterministic cache-oriented assembly,
core-enforced materialization limits, bounded working checkpoints, and per-
worker execution epochs. Planned cache strategy is recorded separately from
actual provider cache-read usage; model changes never imply cache transfer.
Attempt identities remain ledger-only, so an unchanged source snapshot and
prompt/tool configuration stay cache-affine across retries.

Information acquisition remains replaceable. `--context symbol-tree` supplies
bounded handles and a query/resolve tool through an adapter; `raw` is a
standalone empty plan with no module-load dependency on the symbol index.
Optional acquisition failures degrade explicitly, and context state is stored
outside the repository. Canonical lifecycle evidence and the dry/report
commands preserve plans, provenance, omissions, artifact reuse, epochs,
activity, acceptance, unavailable measurements, and neutral or negative
outcomes.

This status means the control plane and its deletion/failure paths pass
hermetic conformance. Kernel/session/tool code consumes explicit acquisition
and materialization capabilities; the old monolithic provider shape is confined
to a removable CLI/provider adapter.

A minimal matched Luna smoke is recorded under
[`packages/core-v2/test/fixtures/m4-proof/`](../packages/core-v2/test/fixtures/m4-proof/).
Both raw and symbol-tree runs shipped with measured usage; the neutral report
correctly makes no advantage claim. Validate future matched evidence with
`mise run m4-proof -- <evidence.json> [report.md]`. This smoke does **not** adopt
symbol-tree, establish general quality/cost improvement, or provide a user
continuation workflow.

### M4.1 — observability patch

M4.1 hardens verification and trace debuggability without adding transcripts
or private reasoning. Verification measures per-command `durationMs` (injectable
clock for determinism), emits bounded structural evidence (`index/digest/exitCode/timedOut/durationMs` with `executed/expected/omitted/capped` capped at 24), and rejects impossible counts. The CLI announces `run: <attemptId>` before execution and prints `receipt/trace/failure artifact:` paths at termination; `model.assigned` now carries `engineVersion/milestone/specHash/familyId/attemptId/attemptNumber`. Every terminal `task.failed` carries a stable `stage`/`code` taxonomy (`setup/context/session/workspace/verification/acceptance/delivery/workflow/internal` × `session_timed_out/worker_failed/verification_failed/...`) for both CLI and daemon paths, and `mise run trace-report -- <trace.json> [report.md]` renders a bounded single-run explanation. The first useful dogfood timeout (67 turns, 108 tool calls, `$0.19`, `prompt exceeded 600000ms`) is retained as `test/fixtures/dogfood/m41-verification-timeout.trace.json` — not a performance baseline, but the evidence that prompted independent execution caps for M5.

### M5 — durable sequential composition and self-hosting

M5 is shipped, but post-land hardening is active. The ordinary v2 CLI can select
one explicit raw-context continuation child with `--child-spec`. A child
receives its own validated spec, provider-owned workspace continuation, context
plan, and bounded declarative checkpoint/handoff—not a transcript. Parent/child
edges and provider compatibility are durable. The post-land review report under
`reports/` is the authority for unresolved hardening findings; passing the full
repository gates is required before claiming those repairs shipped.

M5 proved a narrow mechanism: a prepared sequential child can preserve a
workspace and bounded state across process restart. It did **not** make every
standalone/review/repair attempt resumable, preserve the useful visible Pi
session stream, or automatically settle verified work when a model misses its
final `yield`. Those gaps define M5.5 rather than being hidden under the M5
claim.

### M5.5 — useful recovery for every attempt

M5.5 generalizes recovery from child edges to every admitted attempt. A task
family contains immutable attempt lineage; each stopped attempt has a typed
disposition such as resumable, forkable, blocked, settled, or nonrecoverable.
Sequential children consume the same mechanism rather than owning a parallel
recovery design.

Normal successful runs must pay no additional model-token or model-turn cost.
The session adapter passively writes Pi's visible JSON events to a local attempt
journal. Every completed turn records a cheap checkpoint containing a journal
offset, context-plan identity, usage, and an optional opaque workspace snapshot
token supplied by the configured workspace provider. No kernel code may invoke
jj, Git, SVN, or filesystem snapshot mechanics directly.

M5.5 exposes two different operations:

- **resume** reconstructs all compatible visible history that fits, restores
  the latest valid workspace/context state, appends the typed failure reason,
  and starts a fresh session for transient provider/process/budget failures;
- **fork** selects a turn/checkpoint and a deterministic bounded subset of the
  journal, chooses current/checkpoint/clean workspace policy, and adds a bounded
  corrective instruction and optional model/budget override for spinning or
  strategically failed work.

The existing context continuation selector preserves ordering and tool-call /
tool-result invariants when a full journal does not fit. Optional model-authored
semantic compression may improve very long recovery payloads, but it is not a
baseline dependency. Hidden chain-of-thought is never required or stored.
Provider-native session continuation is an optimization; the normalized local
journal is the provider-neutral source of truth.

Engine-owned settlement is part of M5.5: when integrated changes satisfy the
artifact policy and verification passes, failure to emit a final model `yield`
must not turn objective success into manual jj recovery. The engine derives
changed paths, commit identities, verification, and usage; a missing model
summary is recorded as unavailable.

The public interface operates by run ID, not internal edge/workspace IDs, and
includes status, checkpoint listing, resume, and fork. A user should see why an
attempt stopped, what was retained, the recommended action, and any compatibility
blocker without knowing the configured workspace implementation.

M5.5 exits only when hermetic close/reopen tests and bounded real dogfood prove:
standalone provider-failure resume, mid-edit resume, spinning-worker fork from
an earlier turn with corrective instructions, compatible model replacement,
engine settlement after verification, and clear blocked outcomes for corrupt or
incompatible state. Journals remain bounded, local, temporary, and absent from
canonical evidence.

### M6 — Project Tau extraction and clean cutover

M6 extracts the v2 engine into a standalone repository under the working
**Project Tau** name and makes it the normal implementation. The existing
`pi-task` name remains associated with v1; v1 is archived outside Tau's active
source/context and retained only as a pinned manual emergency release. Tau does
not carry a runtime v1 fallback or duplicate v1 implementation that can confuse
workers.

M6 does not instrument v1 or double cost through mandatory shadow runs. Tau is
dogfooded once per real task across multiple projects and records task class,
project, model/budget, accepted outcome, verification, cost, latency,
intervention, failure phase, recovery action, and selected experiment variant.
Plugin A/B tests assign one variant to each useful real task and compare cohorts;
they do not execute duplicate artificial work.

Product investment is vertical: context acquisition/retrieval/assembly,
editing, verification, and practical recovery. Stable plugin seams cover these
capabilities plus non-authoritative evidence observers. Horizontal workflow,
remote scale, and generalized orchestration are added only when repeated real
work demonstrates a blocking need.

Each milestone gate publishes canonical traces, benchmark evidence, and
conformance results. No model/provider default or performance claim is implied
by fixtures or dry evaluation plans.

## Planning discipline and retrospective

The roadmap drifted because milestone labels mixed different kinds of progress:
a kernel foundation, a candidate implementation, hermetic conformance, and a
measured product outcome were all described as “complete.” Broad worker specs
also allowed unresolved architecture choices to be settled during
implementation, while v1 parity and prewalk vocabulary pulled v2 toward
transcript continuity. Evaluation was repeatedly placed after promotion rather
than used to decide promotion.

Future planning follows these rules:

- define one externally observable outcome and exit gate before implementation;
- record architecture decisions before dispatching cross-cutting code;
- label prototypes, conforming implementations, validated experiments, and
  adopted defaults distinctly;
- keep information acquisition, context lifecycle, workflow composition, and
  product cutover as separate capabilities even when one milestone exercises
  several of them;
- use small implementation tasks under a stable main-session design rather
  than asking a worker to discover milestone scope;
- require a runnable self-hosting increment at each roadmap boundary, not only
  internal schemas or dry harnesses;
- treat negative evidence and deletion as successful experiment outcomes;
- change a milestone only through an explicit edit to this active roadmap,
  including the reason and effect on the bootstrap gate.

These rules favor fewer, evidence-bearing milestones over frequent relabeling.
The implementation remains authoritative for what is shipped; this roadmap is
a commitment about what “done” means.

## Cutover and experiment loop

M6 uses **stabilize → extract → default → archive**. Stabilize finishes M5.5's
public recovery contract and repository gates. Extract moves only Tau's typed
kernel, providers, tests, docs, and package surfaces into the standalone
repository. Default makes Tau the normal tool. Archive keeps v1 source and a
pinned emergency release outside Tau's active repository and worker context.

Product development uses **baseline → assign one real-task variant → measure →
retain or delete**. Receipts identify the selected plugin/config variant so
context or edit approaches can be compared across useful work without doubling
inference. Historical v1 evidence may diagnose a regression but does not impose
a permanent shadow-compute tax.

## Non-goals for the MVP

Remote multi-user scale, multi-tenant isolation, episodic memory, dynamic
cost-aware routing, always-on adversarial review, and program-level autonomy
are deferred. See [pi-task-v2-future.md](pi-task-v2-future.md). They may be
implemented later only when the MVP evidence makes their demand and cost clear.
