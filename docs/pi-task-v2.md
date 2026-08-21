# pi-task-v2 — Design Contract

**Status:** Proposed (v4) · **Supersedes:** v3.1 (2026-08; see `jj log` for the
prior revision) · **Companions:**
[subsystems](pi-task-v2-subsystems.md) (interfaces, schemas, ledger DDL,
plugin contract) · [future](pi-task-v2-future.md) (scale-readiness, deferred
mechanisms).

This document is the overview contract: invariants, role responsibilities,
context lifecycle, requirements, benchmarks, and milestones. Everything
implementation-shaped lives in the subsystems doc; everything not needed to
build v1's successor lives in the future doc.

## 1. Background

### 1.1 What v1 proved

pi-task-v1 runs as a pi extension: the conversational agent plans and
dispatches; isolated worker sessions execute under real gates (typed yields,
bash verification, atomic jj merges). It works and it is cheap where it
matters. Its measured floor (bench-regression, canned specs, 2026-08):

- ~3.5k input tokens is the minimum for ANY run — the fixed worker prompt
  dominates at small task sizes. Grounding overhead, not model price, is the
  cost term to attack.
- Turn counts are model-dependent: a frontier-class model holds ~4 turns on
  trivial specs; a cheap workhorse varies 4–10 turns on the same spec.
  Any hard turn budget below the cheap-model floor causes systematic
  exhaustion→retry loops that cost more than the turns saved.
- Latency on small tasks is model-insensitive (~20–25s); the good model buys
  turn efficiency, not speed.
- Cost per trivial run: $0.0005–0.0013 (deepseek-flash class), effective
  $0.0030–0.0037 for a frontier-class model at assumed discount rates.

These numbers are v2's bar. A proposal that cannot state its predicted
numbers against them does not get built.

### 1.2 Lessons from v1 — full disposition table

Rule: no v1 capability is dropped without an explicit disposition.

| v1 mechanism | Disposition in v2 |
| :---- | :---- |
| Hard bash-exit-code verification gates | **Kept** — FR-5 |
| Typed Zod yields / "tools enforce, prompts suggest" | **Kept** — FR-7 |
| jj workspace isolation + atomic revset-union squash merge | **Ported verbatim** as the first WorkspaceDriver — FR-4. Not redesigned. |
| Deterministic union ladder + consistency gate (`assertMerged`) + recovery artifacts | **Ported verbatim** with FR-4 |
| Prewalk (strong explore → cheap execute swap within one session) | **Kept** — planning mode (a), §3.4 |
| Forked adversarial review w/ context inheritance | **Kept, budget-gated** — §3.6 |
| Budget tiers, schema-locked spend control | **Kept** — FR-8 |
| Batch/flex lanes (OpenRouter batch lane, service_tier flex) | **Kept, generalized** — FR-8 |
| Watchdogs (settle/no-progress/wall/tool-timeout/verification grace) | **Ported verbatim** — FR-6 |
| Failure artifacts + scripted recovery guides | **Kept** — FR-6 |
| Run manifests + `/task-stats` metrics path | **Kept, extended** — NFR-3 (COR accounting) |
| Session-id correlation, reasoning.exclude, slim prompts, conditional prewalk, checklist-per-tier | **Kept as-is** (cost waves; orthogonal to architecture) |
| Detached dispatch (`detach: true` + runner child) | **Superseded structurally** — the daemon IS detached by default; per-run detach remains for interactive progress |
| Inverted ownership (client crash kills tasks) | **Fixed** — FR-1 standalone daemon |
| Nested RPC worker spawn | **Superseded** — FR-1 in-process SDK sessions |
| Context-carrying dispatch (Wave-3 fork idea) | **Designed** — planning mode (c), §3.4 |
| Orientation sections in specs (Wave-3 item 1) | **Formalized** — §3.3 |

## 2. Requirements

### 2.1 Functional

> **FR-1 (Standalone Host Orchestrator).** A persistent Node.js daemon owns
> all task state; conversational clients attach and detach freely. Workers
> run as in-memory SDK sessions inside the daemon — no nested RPC, no pid
> bookkeeping for interactive workers. Heartbeats apply only to real child
> processes (detached runners, scheduler jobs).
>
> **FR-2 (Typed boundary artifacts).** Exactly five artifact types cross a
> context-ownership boundary: Spec, ExecutionBundle, Yield, HandoffBundle,
> TaskReceipt. All are Zod-schema'd ([subsystems](pi-task-v2-subsystems.md)
> §2). Transcripts never leave the session that paid for them except through
> an explicit fork with a prune profile. Artifact fields that would break
> deterministic serialization (timestamps, session ids, run ids) never
> serialize into prompts.
>
> **FR-3 (Bounded attempts, not bounded turns).** Worker bounds are
> wall-clock + watchdogs (ported from v1) plus a PER-ATTEMPT turn budget,
> config-driven, defaulting above the measured cheap-model floor (≥10;
> see §1.1). Exhaustion routes to HandoffBundle retry (bounded), not task
> failure.
>
> **FR-4 (Workspace & merge = v1's proven ladder).** The first
> JujutsuWorkspaceDriver ports v1's merge machinery unchanged: AI-authored
> task base, single atomic squash over a revset union, deterministic union
> ladder, post-merge consistency gate, preserved-workspace failure artifacts
> with recovery guides. AST-aware merging is explicitly rejected
> ([subsystems](pi-task-v2-subsystems.md) §4 — Alternatives).
>
> **FR-5 (Hard verification gates).** Completion gated by real bash exit
> codes executed post-merge, per-command timeout, grace when the wall
> expires mid-verification. Unchanged from v1.
>
> **FR-6 (Operational hardening, ported).** The full v1 watchdog taxonomy,
> failure diagnostics (cause + last tool + stderr tail), and failure
> artifacts are engine invariants, not optional middleware.
>
> **FR-7 (Pluggable seams).** Five kernel interfaces — WorkspaceDriver,
> EnvironmentDriver, ContextCompressor, VerificationDriver, TaskPlugin —
> behind which all environment-specific behavior lives. Plugin contract
> (one file, one interface, one hermetic test, no shared mutable state) and
> the TaskGateway event vocabulary are specified in
> [subsystems](pi-task-v2-subsystems.md) §3 before any plugin code exists.
>
> **FR-8 (Model routing & lanes).** Model assignment is per-role config
> with graceful degradation (§2.2). Lanes: interactive (default), flex,
> batch; unsupported lanes degrade to interactive. Roles are structural
> (session shapes, prompts, budgets); the MODEL per role is configuration.
>
> **FR-9 (Engineering bar).** The repo carries a typecheck gate (tsc or
> equivalent) in CI, and every kernel seam has a smoke test that exercises
> its REAL path (the orchestrator invocation, not just exported pure
> functions). Rationale: two drift bugs shipped green because tsx strips
> types without checking and hermetic tests covered only pure parts. Cheap
> models building plug-ins produce exactly this defect class; the gate is
> what makes FR-7 safe.

### 2.2 Non-functional

> **NFR-1 (Crash recovery).** Task graphs and session state persist in
> `.pi/tasks.db`; boot reconciliation re-hydrates or reaps crashed runs.
> Recovery reads the ledger, never transcripts.
>
> **NFR-2 (Graceful degradation).** Every optimization disables cleanly:
> reviewer skipped or downgraded per budget tier (v1's `[budget.*].review`
> flag semantics carry over), bundles skipped when `bundle_hit_rate` is low,
> forks skipped when fork-deviation rate is high, sandbox disabled where
> bwrap is absent, single-model single-lane operation changes no interfaces.
> The system must run correctly with one free model and zero optional
> features enabled.
>
> **NFR-3 (Measured efficiency).** Every run records COR operationally:
> grounding tokens (spec + bundle/orientation + fixed prefix) ÷ total input
> tokens, computed from manifest phase data. Target < 0.20 on grounding-heavy
> suites. Cost ∝ diff size, not repo size. v1's §1.1 numbers are the baseline.
>
> **NFR-4 (Cache affinity).** Request prefixes are deterministic per task;
> retries APPEND handoffs to an identical serialized prefix (append-only,
> cache-preserving). No timestamps/ids ahead of the conversation.

### 2.3 Guiding principles

1. **Code orchestrates, LLMs judge.** Routing, spawning, merging, gating are
   deterministic code; models write code and evaluate diffs.
2. **Context continuity beats handoff — by default.** Handoffs (bundles,
   handoff bundles) are optimizations that must earn their way in per-repo
   via measured hit rates, not foundations the system depends on.
3. **Every artifact is both interface and collector.** Each typed boundary
   artifact exists so the sender may forget (§3).
4. **Scale via seams; degrade gracefully.** New capability attaches as a
   driver or plugin; every optimization has an off-switch that keeps the
   system correct (NFR-2).

## 3. Context ownership & lifecycle

The organizing rule: **every piece of context has exactly one owner, and
crossing an ownership boundary requires a typed artifact — never implicit
flow.**

### 3.1 Roles

| Role | Who | Context fate |
| :---- | :---- | :---- |
| Spec author | conversational agent (main session) | persists across tasks, pruned via receipts + eviction |
| Router | deterministic code | none — pure decisions from spec metadata + config + manifest feedback |
| Planner | *not a peer role* — a phase inside the worker, or a thin one-shot function | dies with the task |
| Worker | cheap/fast model (config) | destroyed on yield/exhaustion |
| Reviewer | strong model (config), budget-gated | forked, pruned, dies with review |

There is no standing planner session. Planning is either a phase in the
executing session (continuity) or a thin function producing an ExecutionBundle
(fast path). A persistent planner would own the deepest context in the system
and be the hardest thing to prune.

### 3.2 The cycle

```
 user intent
     │
[1] SPEC          main agent writes Goal / Requirements / Verification
     │            + orientation section (known facts, dead ends)
     │            → licenses the main session to FORGET those facts
     ▼
[2] ROUTE         pure code picks planning mode + shape + lane
     │            inputs: requirement count, continuation signal,
     │            bundle_hit_rate, fork_deviation_rate, budget tier
     ▼
[3] PLAN+EXECUTE  one of three modes (§3.4), inside a disposable session
     │
     ├─ fail small → nudge same session (hot context, ~tens of tokens)
     ├─ fail large → fresh worker + HandoffBundle (append-only, cache-safe)
     ▼
[4] REVIEW        optional; fork of the WORKER session through the
     │            review prune profile; typed findings; budget-gated
     ▼
[5] RECEIPT       TaskReceipt (~150 tok) to the main session;
                  verified insights → episodic memory store (future doc E.3)
```

### 3.3 Pruning inventory

| Context | Owner | Pruned how | Escapes as |
| :---- | :---- | :---- | :---- |
| Conversational transcript | main session | receipts replace results; spec-writing externalizes facts; pluggable scorer evicts old turns | specs, forks (through profile) |
| Exploration reads | worker session | session destroyed on yield/exhaustion | Yield payload, manifest metrics |
| Planning output | prewalk phase or bundle fn | bundle capped ≤200 tok/file; prewalk context dies with worker | ExecutionBundle |
| Failure detail | failed worker | capped tails (`capFixOutput` semantics) | HandoffBundle |
| Review context | reviewer fork | review prune profile | typed findings |
| Long-term insight | nobody's context | content-hash invalidation + circuit-breaker retest | episodic memory store |

Each artifact is simultaneously the interface AND the collection mechanism:
the spec exists to let the main session forget; the yield exists so the
orchestrator never sees a transcript; the handoff exists so retries don't
re-read; the receipt exists so conversation survives many tasks.

### 3.4 Planning modes (router-selected)

**(a) Prewalk-in-session — default for continuation/complex tasks.**
Strong model explores INSIDE the session that executes; swap to the cheap
execute model on first edit. Zero handoff loss. This is v1's mechanism,
unchanged, and the reason there is no planner role.

**(b) Bundle fast path — well-scoped self-contained tasks.** Thin one-shot
call (strong model, few turns) emits an ExecutionBundle: target files, line
ranges, minimal type defs, verify commands. Worker starts grounded turn 1.
Miss-path is specified: workers never lose explore tools, so a wrong bundle
degrades into mode (a) mid-run; the miss increments the repo's
bundle_hit_rate and the router stops offering bundles until the compressor
improves. Bundles are an optimization that earns its way in per-repo.

**(c) Fork-from-conversation — interactive work continuing into dispatch.**
Worker forks the main session through the CONTINUATION PRUNE PROFILE: goals +
active spec + recent receipts + orientation facts; implementation chatter,
tool output, resolved deliberation dropped. One re-encode of ~2–5k tokens
instead of N discovery turns. Pollution risk handled like bundle misses: the
yield's deviations field records it, the router tracks fork_deviation_rate,
cooling-off is automatic.

### 3.5 Repair policy

Verification failure size/type thresholds (pure, testable, tunable) choose:
small → nudge the same session (context hot); large → fresh worker +
HandoffBundle appended to an identical serialized prefix (cache-preserving,
NFR-4). Retry count bounded per task (v1 semantics).

### 3.6 Review

Reviewer forks the WORKER session post-yield through the review prune
profile (diff + requirements + compressed implementation rationale; read and
tool noise dropped). Findings return typed. Budget-gated per NFR-2: tiers may
skip review entirely (v1's economy/free already do) or run it on the
workhorse instead of a strong model (v1's full tier already does).

## 4. Architecture

Standalone daemon (FR-1) embedding pi as SDK sessions; conversational
clients (pi extension, CLI/TUI, later others — see future doc) attach over a
local transport. Kernel = the five FR-7 interfaces + TaskGateway + SQLite
ledger + the routing/policy functions (pure). Worker pipeline per task =
route → plan/execute → verify → (review → fix loop) → receipt, with v1's
watchdogs, gates, and artifacts ported verbatim.

Model-per-role defaults follow v1's measured economics: cheap workhorse for
the token-hungry loop; strong model only for thin slices (prewalk, bundles,
reviews) — and only when the tier pays for it.

## 5. Benchmarks

Harness: `packages/benchmarks`, extending `extensions/task/bench-regression.ts`
(now functional; its 2026-08 drift bugs motivate FR-9).

Suites — note the added grounding class, which is where bundle economics
actually live:

- `01_single_file_bugfix` — edits confined to single methods
- `02_multi_file_refactor` — cross-file interface updates
- `03_grounding_heavy` — feature additions in 100K+ LOC repos (NEW: this is
  the suite that adjudicates bundles vs continuity vs cold-start)

Metrics per run: total tokens, turns, wall time, cost, COR (operationalized
per NFR-3), first-pass verification rate, cache hit rate on retried prefixes,
bundle_hit_rate, fork_deviation_rate. Manifests land through v1's existing
metrics write path; `/task-stats` reads them.

Configurations: (1) bare long-context session, (2) pi-task-v1, (3) pi-task-v2
— production default model pinned across all; stronger models are additional
configurations, never baseline changes. Acceptance for cutover: v2 ≥ v1 on
01/02 at equal-or-lower cost; v2 > v1 on 03 (else bundles don't ship as a
default mode).

## 6. Milestones

Reordered against the stated goal (one-shot large engineering tasks): the
hard part — routing, modes, grounding measurement — comes before polish.

| Phase | Scope | Exit criterion |
| :---- | :---- | :---- |
| M0 | FR-9 engineering bar: typecheck gate, real-path smoke tests, bench harness repaired + extended with suite 03 | gate red today, green at M0 exit |
| M1 | Core daemon: ledger + boot reconciliation, in-process SDK sessions, v1 watchdog/gate/artifact port, route function skeleton | v1-equivalent single-worker runs through the daemon |
| M2 | Workspaces & merge: JujutsuWorkspaceDriver (v1 ladder verbatim), EnvironmentDrivers (host, mise; docker later), parallel combine | v1-equivalent parallel runs; suite 01/02 parity |
| M3 | Context modes: prewalk (port) → bundle fast path + miss-path telemetry → fork + prune profiles; COR accounting in manifests | suite 03 run across all three modes with numbers |
| M4 | Plugin kernel: TaskGateway event vocabulary, TaskPlugin contract, first plugins extracted from core | core shrinks; plugins carry hermetic tests |
| M5 | Workflow modes: /plan (planner-only + human gate), /build DAG executor, /survey over the gateway; cutover per the migration section | Phase C parity check |

Migration stays four-phase as proposed in v3.1 (inventory → shadow/dry-run →
flip default → delete v1 RPC), with the addition that M0's smoke tests are
what Phase B's parity check runs.

## 7. Non-goals (this document)

Multi-tenancy, remote transports, billing, episodic memory design, and the
gateway integration catalog live in the [future doc](pi-task-v2-future.md).
Monetization remains out of scope.
