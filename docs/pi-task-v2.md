# pi-task-v2 — Design Contract

**Status:** Proposed · **Companions:**
[subsystems](pi-task-v2-subsystems.md) (kernel interfaces, payload schemas,
ledger DDL, plugin contract) · [future](pi-task-v2-future.md)
(scale-readiness, deferred mechanisms).

This document is the overview contract: the problem, the architecture,
context lifecycle, requirements, benchmarks, and milestones. Everything
implementation-shaped lives in the subsystems doc; everything not needed to
build the next version lives in the future doc.

## 1. What pi-task is

pi-task is a task-execution engine for the [pi coding agent](https://pi.dev).
A conversational agent chats with the user, decomposes engineering work into
specs (Goal / Requirements / Verification), and dispatches them to isolated
worker sessions that edit code, run tests, and commit — under gates enforced
by deterministic software rather than by prompts:

- completion requires schema-validated yields AND passing bash verification;
- parallel workers run in isolated jj workspaces combined by an atomic,
  deterministic merge ladder;
- spend is controlled structurally (budget tiers locked out of the model's
  tool schema), not conversationally;
- every run leaves typed evidence: a manifest with cost/latency/token
  phases, and on failure a diagnostic artifact with a recovery guide.

## 2. Why a v2

v1 runs entirely inside the conversational agent's process: the engine is a
pi extension, workers are child processes reached over JSON-RPC. That
substrate produced four structural problems no amount of hardening fixes:

| Problem | Consequence |
| :---- | :---- |
| Inverted ownership | the engine lives in the client session; a crash/reload/disconnect kills in-flight tasks |
| Nested process RPC | stdin/stdout serialization, fd leaks, awkward recovery between orchestrator and workers |
| Main-session inflation | the orchestrating conversation accumulates transcripts across many tasks; long-running sessions degrade and get expensive |
| Environment coupling | one host serves all projects; toolchains conflict, sandboxing fights the host |

Separately, the *economics* of multi-session agent chains have a known shape:
every process boundary duplicates expensive work (each new session re-reads
code the previous one already read), and unstructured prose handoffs make
receivers reconstruct what senders knew. Any redesign must treat context as
the scarce resource and move it across boundaries only as small typed
artifacts — or not at all.

### What changes vs. what stays

**Stays** (ported unchanged — these are solved problems): verification
gates, typed yields, budget tiers and lanes, the jj merge ladder, watchdogs
and failure diagnostics, manifests/metrics, batch processing.

**Changes:** the engine becomes a **standalone daemon** owning all task
state (workers become in-process SDK sessions, clients attach/detach
freely); a pure-code **router** selects how each task is planned and
executed; **context flow becomes explicit** — exactly five typed artifacts
may cross a session boundary, and forks pass through prune profiles; the
kernel grows **pluggable seams** so environment-specific behavior
(workspaces, containers, compression, transports) attaches without core
changes.

## 3. Requirements

### 3.1 Functional

Requirements are ordered by layer: substrate (FR-1), kernel seams (FR-2–5),
safety (FR-6–8), economics (FR-9–10), and process (FR-11). Each states its
intent first; named implementations are examples, never the requirement.

> **FR-1 (Standalone orchestrator).** *Intent: task survival is independent
> of any client.* A persistent Node.js daemon owns all task state;
> conversational clients attach and detach freely. Workers run as in-memory
> SDK sessions inside the daemon — no nested RPC. Heartbeats apply only to
> real child processes (detached jobs); in-process sessions have no pid and
> need none.
>
> **FR-2 (Pluggable seams).** *Intent: no environment assumption lives in
> core.* Five kernel interfaces — WorkspaceDriver, EnvironmentDriver,
> ContextCompressor, VerificationDriver, TaskPlugin — isolate everything
> environment-specific behind config-selected implementations. The plugin
> contract and gateway event vocabulary are specified
> ([subsystems](pi-task-v2-subsystems.md) §3) BEFORE any plugin code.
>
> **FR-3 (Typed boundary artifacts).** *Intent: context crosses boundaries
> only as small typed payloads, never implicitly.* Exactly five artifact
> types may cross a context-ownership boundary: Spec, ExecutionBundle,
> Yield, HandoffBundle, TaskReceipt ([subsystems](pi-task-v2-subsystems.md)
> §2). Transcripts never leave the session that paid for them except through
> an explicit fork with a prune profile. Fields that would break
> deterministic serialization (timestamps, ids) are ledger-only and never
> serialize into prompts.
>
> **FR-4 (Workspace isolation & deterministic merge).** *Intent: parallel
> workers can never corrupt each other, and combined work is provably
> complete.* Each parallel worker gets an isolated workspace; after all
> yield, changes combine through a DETERMINISTIC MERGE LADDER — textual
> three-way merge, union resolution of non-semantic overlaps, LLM
> micro-session for residuals, human escalation last — followed by a
> CONSISTENCY GATE proving every worker's changes landed before any cleanup.
> Failed merges PRESERVE the workspaces and emit recovery artifacts. The
> first implementation ports the current engine's jj-based ladder unchanged;
> git-worktree and plain-directory drivers follow. AST-aware merging is
> rejected ([subsystems](pi-task-v2-subsystems.md) §5).
>
> **FR-5 (Environment execution & runtime isolation).** *Intent: the daemon
> runs any project without hosting its toolchain — zero host pollution.*
> All commands execute through an EnvironmentDriver inside the project's own
> runtime. Implementation ladder, cheapest first: bare host (fallback) →
> mise-managed host (the project's pinned tool versions without
> containers) → ephemeral container (recommended where available: the repo's
> devcontainer image or an ephemeral mount holding the workspace volume).
> Capability detection selects the best available; the daemon process itself
> requires no target-project compilers, SDKs, or build tools in any case.
>
> **FR-6 (Hard verification gates).** *Intent: completion is a fact, not a
> claim.* Tasks complete only when their spec's bash commands exit zero,
> executed on the merged tree post-merge; per-command timeouts bound hung
> suites; a wall-clock expiry mid-verification grants bounded grace so work
> is never left unverified. The gate never trusts model assertions.
>
> **FR-7 (Bounded attempts).** *Intent: runaway agents fail fast and
> cheaply.* Worker bounds are wall-clock plus watchdogs plus a PER-ATTEMPT
> turn budget, config-driven, set above the cheap-model floor (§7 — budgets
> below what cheap models actually spend cause exhaustion→retry loops that
> cost more than they save). Exhaustion routes to a bounded HandoffBundle
> retry, not task failure.
>
> **FR-8 (Operational hardening).** *Intent: every failure is diagnosable
> and recoverable without archaeology.* Watchdogs (idle settle, no progress,
> wall clock, per-tool timeout, verification grace), failure diagnostics
> (cause + last action + stderr tail), and failure artifacts with scripted
> recovery guides are engine invariants, ported unchanged.
>
> **FR-9 (Layered worker grounding).** *Intent: workers start informed but
> are never constrained.* Grounding arrives in additive layers — engine
> prefix, spec with orientation notes, repo-map slice, optional
> ExecutionBundle, pruned fork content (§5.2) — while the live exploration
> tools are NEVER removed. Every layer saves turns when right and degrades
> to ordinary exploration when wrong; misses feed routing telemetry.
>
> **FR-10 (Model routing & lanes).** *Intent: spend policy is
> configuration, not conversation.* Model assignment is per-role config;
> roles are structural (session shapes, prompts, bounds) while the model per
> role is configuration — single-model operation changes no interfaces.
> Lanes: interactive (default), flex, batch; unsupported lanes degrade to
> interactive. Absolute quota and spend ceilings are never exposed to the
> engine; how aggressively a run spends is expressed entirely through
> tier/lane configuration (batch endpoints for generation-heavy items, flex
> for latency-tolerant background work, cheap models that trade more turns
> for unit cost). An exhausted run fails typed and escalates — it never
> requests budget mid-flight.
>
> **FR-11 (Engineering bar).** *Intent: the system must be safe to extend by
> cheap labor, human or model.* CI carries a typecheck gate, and every
> kernel seam has a smoke test exercising its REAL path (an actual
> end-to-end invocation, not just exported pure functions). Rationale:
> TypeScript runners that strip types without checking let undeclared
> identifiers ship green, and pure-function tests don't cover integration
> drift — the two failure classes that motivated this requirement.

### 3.2 Non-functional

> **NFR-1 (Crash recovery).** Task graphs and session state persist in
> `.pi/tasks.db`; boot reconciliation re-hydrates or reaps crashed runs.
> Recovery reads the ledger, never transcripts.
>
> **NFR-2 (Graceful degradation).** Every optimization disables cleanly and
> the system remains correct: review skipped or downgraded per budget tier;
> bundles skipped where their hit rate is poor; forks skipped where they
> pollute; sandbox off where unavailable; single free model with zero
> optional features is a fully supported configuration.
>
> **NFR-3 (Measured efficiency).** Every run records COR operationally:
> grounding tokens (fixed prefix + spec + injected codebase context) ÷ total
> input tokens, computed from manifest phase data. Cost should scale with
> diff size, not repository size. Current-engine measurements are the
> baseline to beat (§7).
>
> **NFR-4 (Cache affinity).** Request prefixes are deterministic per task;
> retries APPEND handoffs to an identical serialized prefix (append-only,
> cache-preserving).

### 3.3 Principles

1. **Code orchestrates, LLMs judge.** Routing, spawning, merging, gating are
   deterministic code; models write code and evaluate diffs.
2. **Context continuity beats handoff, by default.** Handoff artifacts are
   optimizations that earn their way in via measurement, not foundations.
3. **Every artifact is both interface and collector.** Boundary artifacts
   exist precisely so the sender may forget (§5).
4. **Scale via seams; degrade gracefully.** New capability attaches as a
   driver/plugin; every optimization has an off-switch that preserves
   correctness.

## 4. Architecture

```
 conversational agent ──┐                      ┌─ CLI/TUI ──┐
 (spec author)          ├─ local transport ────┤  scheduler │   clients
                        │                      └─ CI/cron ──┘   (attach/
                        ▼                                       detach freely)
        ┌─────────────────────────────────────────────┐
        │            pi-task-v2 daemon                │
        │  task graph + ledger (.pi/tasks.db)         │
        │  router (pure policy functions)             │
        │  kernel: workspace/env/compress/verify      │
        │          drivers + TaskGateway (plugins)    │
        │                                             │
        │  worker pipeline: route → ground → execute  │
        │  → verify → (review → fix) → receipt        │
        │  (in-process SDK sessions, v1 watchdogs)    │
        └─────────────────────────────────────────────┘
```

Model economics follow a simple rule: the token-hungry tool loop runs on a
cheap configured workhorse; stronger models are bought only for thin slices
(exploration during prewalk, bundle generation, reviews) and only when the
active budget tier pays for them.

Execution environments follow FR-5's ladder — commands always run inside
the project's own runtime (bare host fallback → mise-managed → ephemeral
container where available), never on the daemon's assumptions.

## 5. Context ownership & lifecycle

Organizing rule: **every piece of context has exactly one owner, and
crossing an ownership boundary requires a typed artifact — never implicit
flow.**

### 5.1 Roles

| Role | Who | Context fate |
| :---- | :---- | :---- |
| Spec author | conversational agent | persists across tasks; pruned via receipts + eviction |
| Router | deterministic code | none — pure decisions from spec metadata, config, past-run telemetry |
| Planner | *not a role* — a phase or thin function (§5.3) | dies with the task |
| Worker | configured model | disposable; destroyed on yield/exhaustion |
| Reviewer | configured model, budget-gated | forked, pruned, dies with the review |

There is deliberately no standing planner session: it would own the deepest
context in the system and be the hardest thing to prune.

### 5.2 Worker context injection

What a worker session receives at spawn, in order:

1. **Engine prefix** — fixed prompt: tool rules, yield contract, checklist
   protocol. This is the irreducible floor every run pays (~3.5k tokens in
   the current engine); keeping it slim is permanent work, not an incident.
2. **The Spec** — Goal, Requirements, Verification commands, plus any
   orientation notes the author attached (known file locations, verified
   facts, dead ends already ruled out).
3. **Repo-map slice** — the cached, annotated codebase map (built once per
   repo, refreshed incrementally), sliced by relevance to the spec. This is
   the DEFAULT grounding layer: it lets the worker navigate without raw
   directory scans. Depth (skeleton vs full) is config/budget-driven.
4. **ExecutionBundle** *(optional — bundle mode only)* — per-file symbol
   outlines (≤200 tokens/file), target line ranges, minimal type
   definitions, for tasks whose relevant files are predictable in advance.
5. **Pruned continuation** *(fork mode only)* — replaces 3–4: goals, active
   specs, recent receipts, and orientation facts carried over from the
   dispatching conversation through the continuation prune profile.

Grounding layers are additive optimizations with one invariant: **the live
tools (read/grep/find/bash/edit) are never removed.** Every layer exists to
save turns; none restricts capability. A wrong bundle or a stale map degrades
into ordinary exploration, and the miss is recorded as telemetry (§5.4).

### 5.3 Planning modes (router-selected)

Which grounding a task gets is a pure routing decision — inputs: requirement
count, presence of orientation notes, whether the task continues prior
conversational work, per-repo telemetry, budget tier.

**(a) Prewalk — the default for exploration-heavy tasks.**
*Use case:* the task needs genuine investigation of unfamiliar or
fast-moving code — nobody can precompute which files matter (that difficulty
is the point). The worker spawns on the STRONG model, explores, plans, and
starts working; on its FIRST EDIT the engine swaps the very same session to
the CHEAP execute model. All reads stay in one context — nothing is handed
off, nothing lost. The economic bet: pay strong-model rates for reading
once, cheap rates for the mechanical edit-test-commit loop. When the tier's
plan and execute models are identical, the machinery auto-skips (zero
overhead).

**(b) Bundle — the fast path for well-scoped tasks.**
*Use case:* the relevant files are predictable (greenfield files, surgical
fixes in stable areas). A thin one-shot call generates the ExecutionBundle
(§5.2 item 4) and the worker starts grounded on turn 1 — no exploration
phase at all. Miss-path: the worker simply explores as usual, and the miss
feeds telemetry.

**(c) Fork — continuation of interactive work.**
*Use case:* the dispatching conversation already holds the understanding
(long interactive debugging that now needs isolated execution hours of work).
Forking the raw transcript would import ballast; the fork passes through the
continuation prune profile (§5.2 item 5) so the worker inherits judgment,
not noise. One re-encode of a few thousand tokens replaces N rediscovery
turns.

**(d) Cold start** — trivial specs skip special grounding beyond the repo-map
slice.

### 5.4 Failure, repair, feedback

Verification failure routes by size/type thresholds (pure, tunable):
small failures nudge the SAME session (context hot, tens of tokens); large
failures get a FRESH worker with a HandoffBundle — diff summary, touched
files, capped error tails — appended to an identical serialized prefix
(cache-preserving). Retries are bounded per task.

Every run feeds the ledger's routing telemetry: bundle hit/miss,
fork cleanliness (from the yield's deviations field), turns, cost. The
router consumes this, so mode selection improves from accumulated evidence
rather than developer intuition.

### 5.5 Review

Optional, budget-gated (tiers may skip it entirely or run it on the
workhorse — both exist today). The reviewer FORKS THE WORKER SESSION after
yield through the review prune profile: diff + requirements + compressed
implementation rationale kept; read/tool noise dropped. Findings return
typed (verdict, priority, category, location) and feed the bounded fix loop.

### 5.6 Pruning inventory

| Context | Owner | Pruned how | Escapes as |
| :---- | :---- | :---- | :---- |
| Conversational transcript | main session | receipts replace results; writing specs externalizes facts; scorer evicts old turns | Specs, forks (through profile) |
| Exploration reads | worker session | session destroyed on yield/exhaustion | Yield payload, manifest metrics |
| Planning output | prewalk phase / bundle fn | bundle capped ≤200 tok/file; prewalk context dies with worker | ExecutionBundle |
| Failure detail | failed worker | capped tails per failure | HandoffBundle |
| Review context | reviewer fork | review prune profile | typed findings |
| Long-term insight | nobody's context | content-hash invalidation, retest circuit-breakers | episodic store (future doc) |

Each artifact is simultaneously the interface AND the collection mechanism:
the spec exists so the main session can forget; the yield exists so the
orchestrator never sees a transcript; the handoff exists so retries don't
re-read; the receipt (~150 tokens: verdict, commits, cost, turns) exists so
conversation survives many tasks.

## 6. Autonomy targets

Autonomy is scoped in levels so every release has an honest ceiling. The
scopes below are illustrations of magnitude, not commitments to specific
projects.

**Level 1 — zero-touch hours. The target of v2's core milestones.** One
repository, a human-approved plan, tens of dispatches over a few hours, no
interaction unless an escalation fires — for example, executing a planned,
verifiable-exit milestone of the kind a team would otherwise staff a day
for. Enabled by daemon durability (NFR-1), bounded attempts with handoff
retries (FR-7), hard gates (FR-6), typed receipts (§5), and the /build DAG
executor over TaskGateway (M5). The human's remaining roles: approve the
plan up front; answer escalations (merge conflicts, repeated verification
failure).

**Level 2 — supervised days. Future work.** Hundreds of dependent tasks
across days: integration waves, architecture artifacts as shared contracts,
conformance sweeps, program-level telemetry and stall detection; the human
gates plan approval and wave boundaries — for example, a training-loop
project where long-running compute jobs interleave with code tasks and
evaluation drives iteration. Designed in the future doc (E.6); requires
level-1 reliability evidence first.

**Level 3 — walked-away weeks.** Not designed. No mechanism in this document
assumes it.

## 7. Benchmarks

Acceptance is empirical. Harness extends the existing canned-spec runner;
suites:

- `01_single_file_bugfix` — edits confined to single methods
- `02_multi_file_refactor` — cross-file interface updates
- `03_grounding_heavy` — feature additions in 100K+ LOC repos; this suite
  adjudicates the grounding modes against each other

Per-run metrics: tokens, turns, wall time, cost, COR (NFR-3), first-pass
verification rate, cache hits on retried prefixes, bundle hit rate, fork
cleanliness. Configurations compared: bare long-context session, the current
in-process engine, and the v2 daemon — production default model pinned;
stronger models are additional configurations, never baseline changes.

Reference points from the current engine that motivate the design constants
(all reproducible via the bench harness): ~3.5k-token fixed worker prefix;
cheap-model turn counts of 4–10 even on trivial specs; near-equal latency
across model classes on small tasks. Cutover acceptance: v2 ≥ current on
01/02 at equal-or-lower cost; v2 > current on 03 — otherwise bundles do not
ship as a default mode.

## 8. Milestones

Ordered so the risky/uncertain parts (routing, grounding modes,
grounding-heavy measurement) come before polish:

| Phase | Scope | Exit criterion |
| :---- | :---- | :---- |
| M0 | Engineering bar: typecheck gate, real-path smoke tests per seam, bench harness extended with suite 03 | gate red→green |
| M1 | Core daemon: ledger + boot reconciliation, in-process SDK sessions, watchdog/gate/artifact port, router skeleton | current-engine-equivalent single-worker runs through the daemon |
| M2 | Workspaces & merge: JujutsuWorkspaceDriver (existing ladder verbatim), environment drivers (host, mise), parallel combine | parallel parity; suites 01/02 |
| M3 | Grounding modes: prewalk port → bundle path + miss telemetry → fork + prune profiles; COR accounting | suite 03 across all modes, with numbers |
| M4 | Plugin kernel: gateway event vocabulary, plugin contract, first plugins extracted from core | core shrinks; plugins carry real-path tests |
| M5 | Workflow modes: /plan (planning-only + human gate), /build DAG executor, /survey; cutover | parity check passes |

Migration is four-phase: inventory → shadow/dry-run beside the current
engine → flip defaults → delete superseded plumbing. M0's smoke tests are
what the shadow phase's parity checks run.

## 9. Non-goals (this document)

Multi-tenancy, remote transports, billing, episodic memory design, the
client-integration catalog (future doc), and level-2+ autonomy (§6) live out
of scope here.
