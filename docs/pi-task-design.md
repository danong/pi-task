# pi-task: Typed Task Execution with Prewalk

A task execution engine for pi coding agent sessions. Workers run in isolated
RPC sessions with schema-validated output, event-driven model swapping, and
code-enforced workflow guarantees.

## Problem

Agent workflows that decompose work across multiple LLM sessions (scout →
planner → worker chains) duplicate the expensive part: reading code. Each
isolated session re-reads the codebase from scratch because context doesn't
transfer across process boundaries. A "plan document" handed from one session
to the next is a lossy compression of 100K+ tokens of grounded exploration —
the receiving session pays to rebuild what the sender already knew.

Additionally, prose-based handoffs between stages require the orchestrating LLM
to parse free-text output, construct multi-stage call parameters, and make
workflow decisions that are better expressed as deterministic code.

## Design Principles

1. **Code orchestrates, LLMs judge.** Workflow mechanics (spawning, swapping,
   validating, merging) are deterministic code. LLMs are invoked only for tasks
   requiring understanding: writing code, exploring architecture, evaluating
   diffs against requirements.

2. **Context continuity beats handoff.** A single session that explores, plans,
   and executes retains all reads in context. Model swapping within that session
   (prewalk) captures the cost benefit of cheap execution without paying for
   duplicate reads.

3. **Tools enforce, prompts suggest.** If a behavior matters (call yield to
   finish, check off requirements, run tests), it is gated by tool mechanics or
   event handlers. Never rely on prompt instructions for correctness.

4. **Typed contracts, not prose.** Workers yield schema-validated structured
   data. The orchestrator never parses free-text to understand what happened.

5. **Graceful degradation.** Every optimization (prewalk, review, isolation)
   disables cleanly when budget or model availability doesn't support it. The
   system works with a single free model and zero overhead.

## Architecture

> **Agent-facing workflow**: what the conversational agent is supposed to do,
> the templates (`/plan`, `/build`, `/survey`), the workflow contract, and
> the run lifecycle are documented in [`workflow.md`](workflow.md). This
> section is the implementation architecture underneath it.

```
┌────────────────────────────────────────────────────────────┐
│  Conversational model (main pi session)                    │
│                                                            │
│  Role: understand user intent, decompose work, formulate   │
│  specs, dispatch via task tool, interpret results, report. │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  task tool (pi extension)                            │  │
│  │                                                      │  │
│  │  Thin interface. Calls orchestrator, streams         │  │
│  │  progress to TUI, returns typed result to model.     │  │
│  └──────────────────────┬───────────────────────────────┘  │
│                         │                                  │
│  ┌──────────────────────▼───────────────────────────────┐  │
│  │  Orchestrator (deterministic code)                   │  │
│  │                                                      │  │
│  │  - Validates spec (schema)                           │  │
│  │  - Resolves budget tier → model assignments          │  │
│  │  - Creates jj workspaces (if parallel)               │  │
│  │  - Spawns worker RPC sessions                        │  │
│  │  - Monitors events, triggers prewalk swap            │  │
│  │  - Validates yield output (zod)                      │  │
│  │  - Merges workspaces                                 │  │
│  │  - Runs verification commands (hard gate)            │  │
│  │  - Forks worker session for adversarial review       │  │
│  │  - Bounded review-fix loop                           │  │
│  │  - Collects per-phase metrics                        │  │
│  │  - Returns TaskResult                                │  │
│  └──────────────────────────────────────────────────────┘  │
│         │             │             │                      │
│    ┌────▼────┐   ┌────▼────┐   ┌────▼────┐                 │
│    │Worker 1 │   │Worker 2 │   │Worker 3 │                 │
│    │(RPC)    │   │(RPC)    │   │(RPC)    │                 │
│    │ws: @-1  │   │ws: @-2  │   │ws: @-3  │                 │
│    └─────────┘   └─────────┘   └─────────┘                 │
└────────────────────────────────────────────────────────────┘
```

## The `task` Tool

Registered as a pi extension. The conversational model sees:

```
task - Execute a coding task in an isolated worker session.

Parameters:
  spec (string, required unless sub_specs given):
    Markdown with:
      ## Goal — one sentence
      ## Requirements — numbered list (R1, R2, ...)
      ## Verification — PLAIN bash commands, one per line (no backticks/prose)
  sub_specs (string[], optional):
    Per-worker encapsulated specs — TAKES PRECEDENCE over spec + parallel.
    One isolated worker runs per sub-spec (no splitting, no shared goal,
    no scope leak by construction). Each must be fully self-contained
    (own Goal / Requirements / Verification); their verification commands
    are unioned into the single post-merge gate.
  parallel (integer, optional):
    Mechanical-split fallback: round-robins the requirements of `spec`
    across this many workers (each in an isolated jj workspace, merged
    afterwards, Scope contract applied). Ignored when sub_specs is set.
  budget (optional, ONLY when not locked):
    auto | full | economy | free. Removed from the schema entirely when
    the user locks a tier via --task-budget or /task-budget.

Returns:
  success: boolean
  commits: string[]
  tests: "passing" | "failing"
  files_changed: string[]
  review: { verdict, findings[], requirements[] } | null
  metrics: RunManifest | null        (always built in-memory — single AND
                                     parallel; parallel produces ONE
                                     aggregate manifest summing per-worker
                                     usage, see finalizeParallelMetrics)
  conflicts: string[] | omitted      (parallel runs: unresolved merge
                                     conflicts, repo-relative)
  verification: { passed, failures[] }
  duration_ms: number              (total run wall time — the completion
                                     summary's latency fallback when no
                                     manifest is present; the task tool
                                     always has one, so defensive)
```

The tool's **content text** (the only text the conversational model reliably
reads — the structured return above is chrome) is a compact summary, one
section per line:

```
task done in 1m05s · $0.0234 · 3/3 verified (full) · pre-dispatch: 2.3k tokens
Task succeeded: 1 commit(s), tests passing, 3 file(s) changed.
Tokens: 12000 in / 8000 out.
Merge conflicts: src/a.ts, src/b.ts.
Review: fix — 2 finding(s).
  Requirements: R1: met; R2: unmet
  [P1, security] src/auth.ts: tokens leaked in logs
  [P2, design] src/api.ts: error paths swallow failures
Files: src/auth.ts, src/api.ts, src/lib.ts
```

- **Completion summary (first line)** — ONE line, shown for single and
  parallel runs alike and for failures ("task failed" when the run
  failed, with the failure lines following): "task done in 1m05s ·
  $0.0234 · 3/3 verified (full)". Latency is the wall clock
  (completed_at − received_at) when the manifest carries both
  timestamps, else the worker-measured totals.duration_ms — the same
  runLatencyMs the /task-stats p50/p90 use. Cost (totals.cost_usd),
  verify status (passed verification commands / total — "3/3 verified"
  when all passed, else refined from the failure list), and tier
  (config.budget) come from the RunManifest. When the manifest records
  the main session's pre-dispatch spend (`main_session_tokens` > 0 —
  populated via readSessionTokensBefore at execute; worker tokens stay
  in `phases`), the line appends a "pre-dispatch: Nk tokens" clause;
  absent or zero → no clause (backward compatible with manifests that
  don't record it). Without a manifest the line degrades to the
  duration only. Implemented in completionSummaryLine
  (extensions/task/index.ts).
- **Tokens** — token counts when derivable: the RunManifest's prewalk +
  execute phase metrics, or, without a manifest, the workers' last
  per-turn usage snapshots aggregated across workers. Duration and cost
  live in the completion-summary line above (R4: the content text does
  not duplicate them).
- **Review report** — when a review ran (single-worker, review-enabled
  tiers), the summary carries the full report: the verdict line, the
  per-requirement status (met/unmet/uncertain), and each finding as
  `[PRIORITY, category] file: description`. Findings beyond the cap
  (`MAX_REVIEW_FINDINGS_IN_SUMMARY` in extensions/task/index.ts) are
  elided with "... and M more finding(s)" so the text stays reasonable; a
  clean review (no findings) stays compact with no finding lines. The
  structured details still hold the complete, uncapped ReviewResult.
- **Review skipped** — a requested review that did not run (parallel runs:
  review is single-worker only; axis-less shapes like analysis: the forked
  review never runs without declared axes) is surfaced as "Review requested
  but not run" instead of a console warning (see Console discipline).

Decomposition is the main agent's job: for parallel work it writes either
`sub_specs` (preferred — encapsulated, no leakage) or a single `spec` with
`parallel` (mechanical round-robin fallback under an explicit Scope
contract). Both modes share the single post-merge verification gate.

The model calls this tool when a task warrants isolated execution (multi-file
edits, test cycles, parallel work). For trivial changes, the model edits
directly without dispatching.

**Budget is not a tool parameter.** The model does not see, choose, or
deliberate over model tiers. Budget is enforced by the user via CLI flag or
session command (see Budget Enforcement). When no flag is set, the default
from `task.toml` applies. The model's intelligence goes entirely to the spec,
decomposition, and interpretation — never to model selection.

## Budget Enforcement

The user controls worker model tiers structurally, not conversationally.

### CLI flag

```bash
pi --task-budget free       # lock all workers to free tier
pi --task-budget economy    # lock to economy
pi --task-budget full       # lock to full
pi --task-budget auto       # defer to the task.toml default (same as unset)
```

When a tier is locked, the `budget` parameter is **removed from the tool's
JSON schema entirely**. The model cannot pass it, override it, or deliberate
over it. The tool description states the tier is fixed. There is no invitation
to reconsider.

**Schema-locking timing (empirically verified, Phase 9):** pi applies CLI
flag values to the extension runtime *after* extension factories run, so
`pi.getFlag("task-budget")` read at registration time returns only the
registered default. The `task` tool is therefore registered at
`session_start` — the earliest point the real value is reliably readable —
and **re-registered on every `/task-budget` change** (the re-registration
rebuilds the tool registry, so the next provider request carries the new
schema). See Implementation notes (Phase 9) below.

### Mid-session switch

```
/task-budget free     → lock to free, remove param from schema
/task-budget auto     → restore param, defer to the task.toml default
/task-budget          → show current mode
```

Status bar shows `task: free (locked)` so the user always knows the
constraint is active. The model never sees it.

### Implementation notes (Phase 9)

What was actually built (see `extensions/task/index.ts`):

- **Tier resolution.** `resolveBudgetTier` is pure: a locked CLI flag wins,
  then the model's `budget` param, then the `[defaults] budget` from
  task.toml. There is no `flag ?? param ?? config-default` chain:
  `pi.getFlag("task-budget")` never returns undefined (the flag is
  registered with default `"auto"`), so `--task-budget auto` and an unset
  flag are indistinguishable and both defer to the config default; the
  requirement-count heuristic is reached only via `[defaults] budget =
  "auto"`. Phase 9 shipped the inline
  `DEFAULT_BUDGET_TIERS` table as a placeholder; Phase 10 replaced it with
  `config/task.toml` (see Implementation notes (Phase 10) below).
- **Schema locking works by re-registration.** Because CLI flag values land
  after factories run, the tool is registered at `session_start` and
  re-registered by the `/task-budget` handler. Verified against the real
  provider payload: with `--task-budget free` the schema's properties have
  no `budget`; without it, they do. (Probe: `pi --mode json -e <ext>
  --task-budget free -p hi` + a `before_provider_request` dump.)
- **Mid-session overrides persist across `/reload`** via a session entry
  (`pi.appendEntry`); `/new` resets to the CLI flag value.
- **The status bar** shows `task: <tier> (locked)` only while locked; it is
  cleared on `auto`.
- **The task tool supplies `metricsDir`** = `<agentDir>/results` (data,
  gitignored by the deny-by-default allowlist); manifests land at
  `results/<project>/<run_id>.json` for single-worker runs (parallel runs
  have no manifest yet — Phase 8 metrics are per-worker).

### Implementation notes (Phase 10)

What replaced the Phase-9 placeholder (see `extensions/task/config.ts`,
`index.ts`):

- **`config/task.toml` is the tier source of truth.** `loadTaskConfig()`
  (config.ts, python3-tomllib parsing like the repo-map loader) resolves
  `<agent-dir>/config/task.toml` — the design's `[defaults]` +
  `[budget.full/economy/free]` shape. Validation policy: a missing file
  degrades silently to the built-in `DEFAULT_TASK_CONFIG`; an explicitly
  invalid value warns once and falls back per field. There is NO runtime
  model-availability probing — a configured model that fails at runtime
  surfaces as a task-tool error the conversational model reports.
- **Resolution chain (code, not model).** `resolveBudgetMode`:
  locked session mode > locked param > config default (the config default may
  itself be `"auto"`). The flag value participates no further — an
  unlocked `--task-budget auto` is indistinguishable from an unset flag
  (`pi.getFlag("task-budget")` never returns undefined; the flag is
  registered with default `"auto"`), and both defer to `[defaults] budget`.
  The task tool handler feeds the SESSION mode — the stored `/task-budget`
  override, else the CLI flag, resolved at `session_start` — into
  `resolveBudgetTier`, never the raw flag value: a `/task-budget` lock
  does not appear in the flag, so resolving from the raw flag would
  bypass the lock (todo #69 regression).
  The requirement-count heuristic is therefore opted into via
  `[defaults] budget = "auto"`, not via the flag. `resolveBudgetTier`
  maps the mode: locked → that tier; `auto` → `autoTierForRequirements`
  — ≤5 requirements → `economy`, ≥6 → `full`, unparseable spec → `full`;
  `free` is never auto-selected. Requirement counting is lenient
  (`countSpecRequirements` / `countSubSpecsRequirements`: parseSpec in a
  try/catch, summed across sub_specs) — resolution never throws; spec
  validation errors surface from executeTask as tool errors.
- **`max_fix_iterations` and the budget label flow from the config.** The
  task tool passes `maxFixIterations` from `[defaults]` and
  `budget: <resolved tier>` to executeTask; the manifest's
  `config.budget` is the resolved tier (`full | economy | free`) instead
  of the `"default"` placeholder. Direct executeTask callers that omit
  `budget` still get `"default"`.
- **Canonical no-prewalk shape.** A tier whose `prewalk_model ==
  execute_model` (economy/free) is normalized to `prewalkModel: null` —
  behaviorally identical to the design's equal-model auto-skip rule, and
  the byte-for-byte regression guard is that the shipped
  `config/task.toml` equals the built-in defaults (asserted hermetically).

### Implementation notes (Phase 11)

What extended Phase 10 (see `extensions/task/config.ts`, `index.ts`,
`worker.ts`, `orchestrator.ts`):

- **Config-driven tier vocabulary (todo #81).** `loadTaskConfig()`
  discovers tiers dynamically from task.toml's `[budget.*]` tables
  instead of iterating the hardcoded built-in list — every section in the
  file is a usable tier, in file order (the explicit `tierOrder` list
  keeps file order authoritative even for integer-like tier names; a file
  with no `[budget.*]` sections falls back to the built-in set). The
  "unknown tier section" warning is gone by construction. `type
  BudgetTier = string`; `tierNames`/`findTier`/`budgetModes` helpers
  replace the hardcoded `BUDGET_MODES` list.
- **The schema enum, flag choices, and command choices are dynamic.**
  `taskToolSchema(locked, tiers)`, the `--task-budget` flag description,
  and the `/task-budget` validation/error message are all built from the
  loaded config's tiers plus `"auto"`. The task tool re-loads the config
  at `session_start` and on every `/task-budget` change; editing
  task.toml mid-session needs `/reload` or a `/task-budget` command to
  refresh the enum (schema-locking — the budget param is removed when a
  tier is locked — is unchanged).
- **Resolution adapts to the loaded set.** `normalizeBudgetMode` /
  `isLockedBudget` / `resolveBudgetTier` / `autoTierForRequirements` take
  the tier set; anything outside it is not a valid mode. The auto
  heuristic keeps its well-known-name behavior (≤5 → "economy" when
  present, ≥6 → "full" when present, else the default tier — never the
  "max"/strongest tier; `DEFAULT_BUDGET_TIER` stays the missing-config
  fallback). A config default naming a tier outside the set degrades to
  auto, so resolution never yields an unusable tier.
- **Per-tool-call budget (`[defaults] tool_timeout_ms`, default 15 min).**
  A single worker tool execution exceeding the budget aborts the worker
  naming the tool + truncated args (`decideToolTimeoutAction` /
  `toolTimeoutErrorMessage` in worker.ts; a pure stack of in-flight tools
  bounded by a dedicated watchdog — fires while `toolCallDepth > 0`).
  Threaded through `ExecuteTaskOptions.toolTimeoutMs` →
  `WorkerOptions.toolTimeoutMs`, mirroring the existing timeout options.
- **Per-tier worker wall (`wall_timeout_ms`, default 45 min).** The
  worker's wall timer uses the resolved tier's wall via
  `ExecuteTaskOptions.workerTimeoutMs` → `WorkerOptions.timeoutMs`
  (`selectWorkerWallTimeout`); the shipped config shortens economy/free
  to 25 min.

### Why this matters

Models waste turns deliberating budget even when explicitly told which tier
to use. If the user is low on quota, a model overriding to a paid tier burns
precious remaining credit. If the user is out of tokens, the override is
guaranteed to fail. Removing the parameter makes both failure modes
structurally impossible. The human controls the spend; the model controls
the work.

## Spec Format

The conversational model formulates the spec. It describes *what* to build,
not *how*. The worker's prewalk phase handles exploration and planning.

```markdown
## Goal
Handle UTF-8 BOM in the CSV parser without crashing.

## Requirements
- R1: Detect and strip UTF-8 BOM (EF BB BF) before parsing
- R2: Preserve BOM-less file behavior unchanged
- R3: Add test cases for BOM-prefixed input

## Verification
- timeout 120 bash tests/run_all_tests.sh
```

Validation (code, not LLM): the orchestrator rejects specs missing
`## Requirements` with numbered items or `## Verification` with at least
one command. Error message tells the model exactly what's missing.

## Budget Tiers

```toml
# ~/.pi/agent/config/task.toml

[defaults]
budget = "full"
max_fix_iterations = 2
tool_timeout_ms = 900000   # per-tool-call budget, 15 min

[budget.full]
prewalk_model = "qwen-token-plan/qwen3.8-max-preview"
execute_model = "openrouter/~deepseek/deepseek-v4-flash-latest"
review_model = "openrouter/~deepseek/deepseek-v4-flash-latest"
review = true
wall_timeout_ms = 2700000  # per-tier worker wall, 45 min

[budget.economy]
prewalk_model = "openrouter/~deepseek/deepseek-v4-flash-latest"
execute_model = "openrouter/~deepseek/deepseek-v4-flash-latest"
review_model = "openrouter/~deepseek/deepseek-v4-flash-latest"
review = false
wall_timeout_ms = 1500000  # cheaper tiers get a shorter wall, 25 min

[budget.free]
prewalk_model = "openrouter/free"
execute_model = "openrouter/free"
review_model = "openrouter/free"
review = false
wall_timeout_ms = 1500000
```

*(The sketch above is illustrative; `config/task.toml` is the source of
truth — the drift guard pins it to the built-in defaults.)*

**Async workers (`[budget.async]`) — the efficiency doctrine.** The
token-hungry tool loop runs on the CHEAP workhorse (DeepSeek V4 Flash,
standard tier); the strong model (Gemini Flash) gets only the thin
prewalk slice, priced down via OpenRouter flex (`service_tier = "flex"`
— batch-level pricing through the synchronous endpoint). Gemini flex is
still ~3× the workhorse's input price, so it is used sparingly: never
for the loop, never for routine reviews (review runs on the workhorse).
Injection is run-scoped AND model-scoped: the engine sets
`PI_TASK_SERVICE_TIER` (+ `PI_TASK_SERVICE_TIER_EXCLUDES` naming the
workhorse) only on subprocesses it spawns for a flex-tier run, and
`tools/service-tier.ts` (loaded via `--extension` there) injects
`service_tier` into payloads whose model is not excluded — one session
runs the flex prewalk AND the standard post-swap loop correctly, and the
conversational session stays untouched. The tier pairs with the `async`
shape (channel `flex` — 25/20-min watchdog windows for flex's 1–15-min
per-call latency; 120-min wall). Flex has NO server-side fallback, so
capacity failures get client-side exponential backoff (30s/60s/120s,
`spawnWorkerSessionResilient`). The tier also pins the strong-model
calls with `provider_only = ["google-vertex/flex"]` (provider.only +
allow_fallbacks:false, same model scoping as the tier — the workhorse
is never pinned; OpenRouter's AI Studio flex endpoint 400s in
practice, Vertex serves reliably). The batch lane is untouched by all
of this — own endpoint (`/api/beta/batches`), own request body. The
manifest records the requested tier (`config.service_tier`).

**Config-driven vocabulary (Phase 11).** Every `[budget.*]` section in
task.toml is a supported tier, in file order — adding a tier requires no
code change. The task tool's `budget` schema enum, the `--task-budget`
flag choices, and the `/task-budget` command choices are all built from
the loaded config's tiers plus `"auto"`. The task tool re-loads the
config at `session_start` and on every `/task-budget` change so the enum
reflects the current task.toml; editing task.toml mid-session needs
`/reload` (which replays `session_start`) or a `/task-budget` command to
refresh the enum. A missing config file still degrades to the built-in
defaults (max/full/economy/free, in that order); a file with no
`[budget.*]` sections at all (e.g. `[defaults]`- or `[sandbox]`-only)
falls back to the built-in tier set. A custom tier's omitted keys fall
back to the default tier's built-in template; a tier sharing a built-in
name falls back to that tier's built-in config per key.

**Per-tier worker wall (`wall_timeout_ms`, Phase 11).** The worker's
wall-clock timer uses the resolved tier's `wall_timeout_ms` (default
45 min when absent) instead of a hardcoded constant — the task tool
passes it as `ExecuteTaskOptions.workerTimeoutMs` →
`WorkerOptions.timeoutMs`. The shipped config gives the cheap
(economy/free) tiers a shorter 25-min wall so a stuck run burns less
budget.

**Per-tool-call budget (`tool_timeout_ms`, Phase 11).** A single worker
tool execution (bash/read/edit/write/grep/find — tracked via
`tool_execution_start/end`) that exceeds `[defaults] tool_timeout_ms`
(default 15 min) aborts the worker with a rejection naming the tool and
its truncated arguments. This is the bound for a hung tool that the
no-progress watchdog cannot see: an in-flight tool counts as progress by
design, so only the tool-call watchdog catches a tool that never returns.

**Verification grace (`verification_timeout_ms`, bounded).** A spec's
verification commands are bounded per-command by `[defaults]
verification_timeout_ms` (default 15 min — the same as the tool-call
budget; a hung suite command dies with exit 124 and the run reports the
failure, never blocking work). Separately, when the worker wall-clock
expires while a verification command is in flight, the worker gets a
bounded grace (the same `verification_timeout_ms`) so the suite can
finish and the worker can yield a real verification result — the wall
must not kill an in-flight verification, which would leave work
unverified or a run dead at the finish line. The grace ends early if the
worker starts a non-verification tool after the wall expired.
Verification provenance is recorded in the manifest (`verify.source`:
"worker-tree" for the single-worker post-yield run, "union-gate" for the
parallel post-merge gate; `verify.timed_out` when a command hit its
bound).

**Prewalk auto-skip rule:** if `prewalk_model == execute_model`, the prewalk
machinery is disabled entirely. No planning instruction injection, no swap
listener, no checklist nagging. The worker runs on one model start to finish.
This makes economy/free tiers zero-overhead.

Workspace isolation is independent of budget. Parallel workers always get
isolated workspaces regardless of model tier — isolation prevents merge
conflicts, it doesn't cost tokens.

**Review model tier is a quality knob, not a context knob.** The review
always inherits the worker's full context via session fork (free). The model
tier determines how well it reasons over that context. Full budget gets a
strong reviewer that catches subtle flaws; economy gets a fast reviewer that
catches obvious ones.

## Worker Lifecycle

### Single worker (no prewalk)

```
spawn(execute_model) → execute task → yield result → session ends
```

### Single worker (prewalk active)

```
spawn(prewalk_model)
  │
  ├── Worker explores codebase (reads accumulate in context)
  ├── Worker creates session checklist (requirements → steps)
  ├── Worker lands first edit
  │     └── tool_execution_end event → orchestrator sees it
  │           └── orchestrator sends: set_model(execute_model)
  │                 └── Worker continues on execute_model
  │                       ├── Checklist steers remaining work
  │                       ├── Worker calls yield() with typed result
  │                       └── Session ends
```

The worker does not know it was swapped. The planning instruction is pruned
from context at swap time. As far as the execute model knows, it explored,
planned, started executing, and is continuing.

### Parallel workers

Each worker gets its own jj workspace. Lifecycle is identical to single
worker but runs concurrently. The orchestrator merges workspaces after all
workers yield.

**Commit identity (todo #84).** Worker commits are authored as the AI, never
as the user: the worker spawn carries a jj config override (JJ_CONFIG env
var pointing at a temp config in the system-prompt temp dir, bound into the
sandbox) with `user.name`/`user.email` from task.toml's `[defaults]`
`ai_author_name` / `ai_author_email` ("{model}" resolves to the execute
model's short name). Parallel runs additionally build the merge target as a
fresh AI-authored empty commit on @- described with the spec goal
(`createAiTaskBase` in workspace.ts — jj squash keeps the DESTINATION
commit's author, so squashing into @- would attribute the merged AI work to
the user; jj 0.43 has no author-reset, so the identity is set at creation
via `jj --config-file`, which merges with the user config). The user's own
jj/git commits keep their identity — the override is worker-scoped only.

Single-worker runs (the common path) apply the same identity: the worker is
rooted on a fresh AI-authored base (`createAiTaskBase` again — jj commit
preserves the working-copy commit's ORIGINAL author, so committing into the
user's WC would attribute the AI's work to the user), and after the run the
working copy is restored to the user's identity (`jj new` + abandoning the
worker's leftover empty WC) so the user's next commit is theirs.

**Spec split (Phase 6, deterministic).** Requirements are partitioned
round-robin by index — worker `j` gets requirements where `index % N === j`
— preserving original requirement ids ("R1", "R2", ...) so each worker's
checklist maps back to the source spec. The full spec's verification
commands are not splittable, so each sub-task carries a note instead and the
orchestrator runs the full verification once on the merged tree. `parallel`
is clamped to the requirement count. Decomposition semantics are
minimal: smarter decomposition is the main agent's job — Phase 9's `task`
tool takes caller-supplied `sub_specs` (one encapsulated spec per worker,
no shared goal, no scope leak; see "The `task` Tool"), and this mechanical
split remains the fallback when only `spec` + `parallel` are given.

**jj mechanics (verified on jj 0.43, implemented in `workspace.ts`).**
Workspace names are NOT revsets ("Revision `ws1` doesn't exist") — the
workspace's working-copy commit id is resolved from `jj workspace list`
(columns: name, change id, commit id). `jj squash --into <commit>` rewrites
the target in place: same change id, new commit id. The merge base is
therefore tracked by its **change id** and re-resolved to a commit id before
the single atomic squash — squashing into a stale commit id silently
diverges (both workspaces merge into the old snapshot; no conflict). A
divergent change (two or more visible commits sharing a change id — the
op-log-fork signature) makes `jj log -r <change>` fail with "Change ID ... is
divergent"; resolution never picks a stale or arbitrary revision, it fails
loudly. `JJ_EDITOR=true` is forced in the child env because jj opens the
editor for squash even with `--from/--into` when descriptions differ. jj
0.43 has no `jj workspace remove` — cleanup is `jj workspace forget` plus
deleting the directory.

**Atomic combine (R1).** All worker commits land in the task base in ONE
jj operation: a single `jj squash --from '<base>..<ws-1-@>|<base>..<ws-2-@>|…'
--into <base>` (revset union is `|` — `+` is not a binary operator in jj
0.43 revsets). There is no incremental per-workspace squash into a moving
base, so the observed failure class — a mid-loop squash failure leaving a
partial merge with dangling sibling commits — cannot occur. After the
squash, a provable-integration check verifies every workspace @ sits on
the rewritten base with zero remaining diff (the whole range was
consumed). Conflicts do not fail the squash — they land in the base commit
(jj 3-way merge is rung 1 of the R4 conflict ladder) — detected via `jj
resolve --list -r <base>` (exit 0 + "<path> N-sided conflict" lines; exit 2
+ "No conflicts found" when clean).

**Deterministic union ladder (R4).** Each remaining conflicted file is
resolved with the jj-native "union" merge tool — configured at runtime via
`--config` (`merge-tools.union.program` + `merge-args` with the
$base/$left/$right/$output placeholders; jj 0.43's merge-tools contract,
verified) — backed by `git merge-file --union` (both sides' hunks kept,
deterministic, no markers; a sh wrapper redirects `-p` stdout into
$output, and `&& test -s "$output"` keeps the binary/error case conflicted
instead of falsely "resolving" to empty content). ONE FILE PER INVOCATION:
`jj resolve --tool <tool> <p1> <p2>` aborts the whole command on the first
tool failure (a binary file makes git merge-file exit 255), which would
strand every later path's conflict — per-file, a failed file stays
conflicted (escalation) while the rest still resolve. Each successful
resolve rewrites the base commit, so its commit id is re-resolved before
every file. If no conflict markers remain → accepted and recorded as
resolved:"union" in the manifest; only files that still carry markers
escalate (LLM/manual) with just the conflicted hunks (bounded per file);
the verification gate always validates the final tree.

**Post-merge consistency gate (R3).** `assertMerged` runs BEFORE workspace
cleanup and BEFORE verification: every workspace @ must be a DESCENDANT of
the merged result (its commits reachable from it — `jj log -r
'<ws-@>..<base>'` empty, not merely diff-equal on some other chain) with
zero remaining diff, the main working copy must sit directly on the merged
base, and the merged tree must be non-empty and hold the union of the
workers' added/modified files (computed pre-merge). Fail → the run fails
loudly (never a false success) with a merge-failure artifact.

**Overlap classification (R5).** Before merging, each worker's
changed-file set is computed (`jj diff --from <base> --to <ws-@>
--summary`); files changed by ≥2 workers are classified from their `jj diff
--git` output: comment/whitespace-only overlaps (every changed line
matches a language-agnostic comment prefix or is whitespace) → the
deterministic union path (R4); substantive overlaps (any code line or
binary file) → flagged in the merge report before merging.

**Merge-failure artifact (R2).** On any merge-path failure the worker
workspaces are NEVER forgotten: a `.failure.json` (the metrics.ts
writeFailureArtifact pattern) records the workspace names, their
working-copy commit ids (dangling when the merge did not land), the
dangling commit ids, and the conflicted files (+ bounded hunks), and the
workspaces are left in place so recovery is scripted from the artifact
rather than LLM-discovered (`jj workspace list` names survive; each
dangling id can be squashed into the base manually).

**Recovery guide (R4).** The artifact carries a scripted recovery guide
(`recovery` field): the commands to stack the preserved workspaces onto
the task base (rebase in dependency order, re-resolving ids after every
command, then squash), to abandon the AI base/stubs BEFORE pushing
(description-less commits refuse push), and the add-vs-delete conflict
warning (resolve via `:ours`/`:theirs`, never mid-stack abandon — that
drops the other side's changes).

Orchestrator read-only jj commands (`jj log -r @-`, review diffs, repo-map
`jj file list`) pass `--ignore-working-copy`: jj snapshots the working copy
even for read-only commands (writing a "snapshot working copy" op), and
concurrent op writers fork the op log (jj reconciles with a "Concurrent
modification detected" op and can leave divergent/rewritten changes). The
one deliberate exception is the clean-working-copy guard, whose purpose is
the live on-disk state and which runs first, when no other writer exists.

```bash
# Orchestrator creates workspaces (dirs under a fresh temp dir; workers
# commit freely in their own working copies, rooted at the task base @-)
jj workspace add /tmp/pi-task-run/ws-1 --name pi-task-1
jj workspace add /tmp/pi-task-run/ws-2 --name pi-task-2

# Workers run in their respective workspace cwds
# After all yield, ONE atomic combine — every workspace's commits land in
# the base in a single squash (revset union |):
jj log -r '@-' -T 'change_id' --ignore-working-copy   # task base CHANGE id (stable)
jj squash --from '(<base>..<ws-1-@>)|(<base>..<ws-2-@>)' --into <base-commit-id>

# Rung 1 conflicts landed in the base (jj 3-way merge); rung 2 resolves
# each remaining conflicted file deterministically with the union tool:
jj resolve --list -r <base-commit-id>                 # "<path> N-sided conflict"
jj resolve --tool union -r <base-commit-id> -- <path> # per file (git merge-file --union)

# R3 consistency gate (before verification, before cleanup): every
# workspace @ and the main @- sit on the merged base, diff-empty, and the
# merged tree holds the union of worker file changes:
jj log -r '<ws-@>..<base-commit-id>' --no-graph        # must be EMPTY (reachability)
jj diff --from <base-commit-id> --to <ws-@> --summary  # must be empty
jj file list -r <base-commit-id>                       # non-empty, holds every worker file

# On merge failure the workspaces are PRESERVED (never forgotten) and a
# .failure.json records names + dangling commit ids + conflicted files +
# the recovery guide (stacking commands, stub-abandon, add-vs-delete
# :ours/:theirs). On worker failure WITHOUT a merge, each workspace's
# uncommitted state is rescue-committed inside the preserved workspace
# ("rescue: aborted task run (<cause>)", R3) and the artifact names the
# rescue commits. On success, cleanup: forget the (now-empty) workspace
# @s, delete the dirs
jj workspace forget pi-task-1
jj workspace forget pi-task-2
```

**No description-less stubs (R1).** The parallel finally restores the main
working copy with `jj new` (fresh empty user commit on the merged base)
ONLY when a merge actually landed. On a no-merge failure — a worker
failure before the merge path — the stub is NOT created: it is a
description-less commit and jj refuses to push description-less commits
(the observed failure mode: the stub blocked a real push and cascaded
into a conflict nightmare). Whatever remains in the ancestry (e.g. the
AI-authored task base, described with the spec goal) carries a
description.

**Finalization-incomplete aborts (R2, third outcome).** An aborted worker
whose checklist relay showed ALL requirements done at abort (the worker
committed everything and was verifying/yielding) is classified
"finalization-incomplete" (`isFinalizationIncomplete` — pure). Parallel:
when every failed worker is finalization-incomplete, the run proceeds to
the atomic combine + union verification gate instead of failing flat;
pass → success-with-caveat (merged commit id + file delta + "worker k
aborted during finalization; verified post-merge"); fail → the failure
path with preserved workspaces. Single-worker: verification runs on the
committed tree post-abort; pass → success-with-caveat with the worker's
commit ids; fail → the failure path. The gate always gates — never merge
or claim success without it.

**Bounded jj calls (R5).** Every `execJj` call is bounded by
`DEFAULT_JJ_TIMEOUT_MS` (~120s, overridable per call); the failure path
passes a tighter bound (`FAILURE_PATH_JJ_TIMEOUT_MS`) so resolving
workspace commit ids and rescue-committing wedged workspaces can never
hang the abort.

If the union ladder leaves conflicts (markers still present — typically
binary files), the orchestrator records them (escalation payload: paths +
bounded hunks, via the merge-failure artifact) and returns them in the
result (`conflicts: string[]`, repo-relative paths) with `success` `false`.
The conversational model decides how to resolve (dispatch a fix worker, or
handle interactively). Verification runs once, after the merge and after
the consistency gate — the main working copy provably sits on the merged
base holding every worker's changes; conflict markers, if any, are visible
there.

### Context-window compatibility

The prewalk swap moves the accumulated context from `prewalk_model` to
`execute_model`. If the execute model's context window is smaller than the
context already accumulated, the inherited context will not fit — and the
obvious fix (compact at swap time) is partly self-defeating, because
compaction summarizes the very reads prewalk exists to preserve.

Mitigations, in order of preference:

1. **Match windows.** Budget tiers should ensure
   `execute_model.context_window >= prewalk_model.context_window` (or at least
   the expected prewalk accumulation). The orchestrator validates this at
   startup and refuses a misconfigured tier.
2. **Context-aware swap.** Trigger the swap on first edit only if the current
   context fits the execute model's window; otherwise compact-then-swap,
   accepting bounded loss.
3. **Measure before swapping.** Read `get_session_stats` (`contextUsage.tokens`)
   and compare against the execute model's `contextWindow` (from
   `get_available_models`) before sending `set_model`.

Current tiers (deepseek-v4-flash and qwen3.8-max both ~1M context) are
unaffected, but the check is built in so a future tier with a smaller execute
model degrades gracefully instead of failing mid-swap.

### Hang protection (watchdogs)

A worker can stall in distinct ways, and each has its own watchdog in
`worker.ts` (every limit is a named constant, overridable via
`WorkerOptions`):

1. **Settled without yield** — the agent finished its turn but never called
   `yield()`. RPC sessions stay alive after settling, so this would otherwise
   hang the orchestrator forever. On the `agent_settled` event with no yield
   payload the worker is nudged once with a yield reminder; a second settle
   still without a payload fails the run (`decideIdleAction`, pure).
2. **No progress at all** — a worker that hangs emitting *no* RPC events never
   trips the settle watchdog and would otherwise burn the entire wall-clock
   budget invisibly (todo #74). A separate watchdog aborts the worker once it
   has emitted no activity (turns, tool calls, or any event) for
   `WORKER_NO_PROGRESS_TIMEOUT_MS`; any event resets the clock, and an
   in-flight tool execution counts as progress (a long silent bash/test tool
   is legitimate). The rejection names the cause and the window
   (`decideNoProgressAction` / `noProgressErrorMessage`, pure + hermetically
   tested).
3. **Wall-clock budget** — the hard cap (`WORKER_WALL_TIMEOUT_MS`): on expiry
   the worker is aborted and the rejection names the limit
   (`wallTimeoutErrorMessage`).

The no-progress window is deliberately far shorter than the wall budget so a
hung worker fails fast instead of silently consuming the whole run; the settle
watchdog and the wall timeout are otherwise unchanged.

**Failure diagnostics (todo #86).** Every fail condition (wall, no-progress,
idle, external abort) records its CAUSE and aborts; the process-close handler
produces the single, deterministic rejection carrying the cause plus the
worker's final state — turn count, idle time, the last tool call (name +
truncated args), and the stderr tail (`buildAbortError` in worker.ts; the
review runner mirrors it). The old watchdogs rejected directly, racing the
close handler, so the generic "Worker was aborted" could swallow the specific
cause. The task tool appends the last progress view to the failure text
(`failureMessageWithProgress`), and — when a metricsDir is configured — the
orchestrator writes a failure artifact to
`<metricsDir>/<project>/<run_id>.failure.json`
(`buildFailureArtifact` / `writeFailureArtifact` in metrics.ts) so a run that
dies without a manifest (worker timeout, aborted review, parallel failure) is
inspectable after the fact. Parallel failure artifacts additionally carry the
R4 recovery guide and the R3 rescue-commit records (see Parallel workers
above).

## Worker Tool Surface

Workers receive a restricted tool set:

| Tool | Purpose |
|------|---------|
| `read` | Read files |
| `bash` | Run commands (tests, builds) |
| `edit` | Edit files |
| `write` | Create files |
| `grep` | Search code |
| `find` | Find files |
| `checklist` | Session-scoped progress tracking (registered by extension) |
| `yield` | Return typed result and terminate (registered by extension) |

Workers do NOT receive: `subagent`/`task` (no nested dispatch), `memory`
(no cross-session writes), `todo` (project todos are user-owned).

### `yield` tool

```typescript
yield({
  files_changed: string[],    // paths modified
  summary: string,            // one-paragraph description of changes
  commit_ids: string[],       // jj commit IDs created
  deviations: string[],       // any spec deviations (empty if none)
})
```

Schema-validated by the orchestrator. If invalid, the tool returns an error
to the model ("missing required field: commit_ids") and the model retries.
The session cannot end without a valid yield — this is the completion gate.

### `checklist` tool

```typescript
checklist({ action: "init", items: string[] })   // create from requirements
checklist({ action: "done", index: number })     // mark item complete
checklist({ action: "status" })                  // list unchecked items
```

Stored in session state via `pi.appendEntry()`. Dies with the session.
Never touches `.pi/TODO.json`.

After prewalk swap, the orchestrator injects a context reminder when
unchecked items exist:

```
Remaining: R2 (update tests), R3 (docs). Complete before calling yield.
```

This injection only fires post-swap (the strong model doesn't need nagging)
and only when items are actually unchecked (no noise when on-track).

## Orchestrator Logic

```typescript
async function executeTask(spec, parallel): Promise<TaskResult> {
  const metrics = new RunManifest();

  // 1. Validate spec (code)
  const requirements = parseRequirements(spec);
  const verifyCmds = parseVerification(spec);
  if (requirements.length === 0) throw new SpecError("No requirements found");
  if (verifyCmds.length === 0) throw new SpecError("No verification commands");

  // 2. Resolve budget (code — locked session mode > locked param > config default; auto → heuristic)
  const tier = resolveBudget(pi.getFlag("task-budget"), spec);
  const usePrewalk = tier.prewalk_model !== tier.execute_model;
  metrics.config = { tier, usePrewalk };

  // 3. Create workspaces (if parallel)
  const workspaces = parallel ? await createWorkspaces(parallel) : [cwd()];

  // 4. Spawn workers
  const workers = workspaces.map(ws => spawnWorker(ws, {
    model: usePrewalk ? tier.prewalk_model : tier.execute_model,
    spec, requirements,
  }));

  // 5. Prewalk listeners (if active)
  if (usePrewalk) {
    for (const worker of workers) {
      worker.onToolEnd((event) => {
        if (isEditTool(event) && !event.isError && !worker.swapped) {
          worker.setModel(tier.execute_model);
          worker.swapped = true;
          worker.prunePlanningInstruction();
          metrics.recordSwap(worker.turnIndex, worker.tokensSoFar);
        }
      });
    }
  }

  // 6. Await yield (streams progress to TUI, no LLM tokens burned)
  const yields = await Promise.all(workers.map(w => w.waitForYield()));
  metrics.recordPhase("execute", workers);

  // 7. Merge workspaces — ONE atomic combine of every workspace's commits
  //    into the task base (mergeWorkspacesAtomic, R1), deterministic union
  //    ladder for conflicts (R4), then the assertMerged consistency gate (R3)
  if (parallel) await mergeWorkspacesAtomic(workspaces, baseChangeId);

  // 8. Verification + review fix loop (bounded)
  let review = null;
  const maxIter = tier.max_fix_iterations ?? 2;

  for (let i = 0; i < maxIter; i++) {
    // 8a. Run verification (bash hard gate, zero tokens)
    const testsPass = await runCommands(verifyCmds);
    metrics.recordPhase("verify", { passed: testsPass });

    // 8b. Forked adversarial review (if budget allows)
    if (tier.review) {
      review = await forkedReview(workers[0], spec, requirements, tier);
      metrics.recordPhase("review", review);
    }

    // 8c. Check if we can ship
    const blockers = review
      ? review.findings.filter(f => f.priority === "P0" || f.priority === "P1")
      : [];
    if (testsPass && blockers.length === 0) break;

    // 8d. Dispatch fix worker
    await fixWorker({
      testOutput: testsPass ? null : lastTestOutput,
      findings: blockers,
      model: tier.execute_model,
    });
    metrics.recordPhase("fix_loop", { iteration: i });
  }

  // 9. Cleanup workspaces
  if (parallel) await removeWorkspaces(workspaces);

  // 10. Determine outcome
  const remainingBlockers = review
    ? review.findings.filter(f => f.priority === "P0" || f.priority === "P1")
    : [];
  const verdict = remainingBlockers.length > 0 ? "escalate" : "ship";

  return {
    success: verdict === "ship",
    commits: yields.flatMap(y => y.commit_ids),
    tests: lastTestOutput.passed ? "passing" : "failing",
    files_changed: yields.flatMap(y => y.files_changed),
    review,
    metrics: metrics.finalize(),
  };
}
```

## Verification and Review

Two distinct concerns with different costs and purposes.

### Verification (hard gate, zero tokens)

Workers run verification commands before yielding (enforced by their system
prompt). The orchestrator re-runs the same commands after merge as a hard
gate — bash exit codes, no LLM involved. This catches workers that skip or
misreport test results.

There is no separate LLM-based "coverage check" pass. Per-requirement status
is reported by the reviewer as part of its findings (see below).

### Review (forked session, adversarial)

The review reuses the worker's grounded context via session fork, avoiding
the cost of re-reading the codebase while removing the worker's commitment
to its chosen approach.

**Fork and prune.** After yield, the orchestrator forks the worker session
at the yield entry. The fork inherits the full message history — every read,
every bash output, every file content. Then code prunes the commitment
context:

| Context type | Biased? | Kept? |
|---|---|---|
| Read tool results (file contents) | No — factual | **Yes** |
| Bash outputs (test runs, builds) | No — factual | **Yes** |
| Planning instruction | Yes — framing | **Pruned** |
| Checklist tool calls | Yes — commitment | **Pruned** |
| Assistant reasoning ("I'll approach this by...") | Yes — commitment | **Pruned** |
| Edit tool calls | Partially | **Replaced** with final diff |

The pruning is code (a `context` event filter), not LLM. The reviewer never
sees the plan, the checklist, or the implementation reasoning. It has the
knowledge of someone who read the codebase, with the detachment of someone
who didn't write the change.

**Inject review context.** The forked session receives:

```
[system: "You are an adversarial code reviewer. You did NOT write this
 code. Find problems: unmet requirements, edge cases, security issues,
 test quality, regressions, design concerns, what the implementer might
 have missed. Report per-requirement status and prioritized findings."]

[read results: inherited from worker session — 100K+ tokens, free]
[bash outputs: inherited from worker session]

[user: "Spec: <spec>"]
[user: "Diff: <jj diff -r @->"]
[user: "Worker summary: <yield.summary>"]
[user: "Worker deviations: <yield.deviations>"]
```

**Structured findings.** The reviewer outputs schema-validated findings:

```typescript
interface Finding {
  id: string;
  priority: "P0" | "P1" | "P2" | "P3";
  confidence: number;           // 0-1
  category: string;             // "security" | "edge-case" | "test-quality" |
                                // "design" | "regression" | "requirement"
  file: string;
  description: string;
  verification: string;         // how to confirm the finding is real
}

interface ReviewResult {
  verdict: "ship" | "fix" | "escalate";
  findings: Finding[];
  requirements: Array<{
    id: string;                 // "R1", "R2", ...
    status: "met" | "unmet" | "uncertain";
  }>;
}
```

The reviewer thinks freely; its report is typed. The schema gives the fix
loop actionable, deterministic input without constraining the reviewer's
analysis.

**Bounded fix loop.** Adversarial reviewers always find something. The
review-fix loop is bounded by `max_fix_iterations` (default: 2, configurable
in `task.toml`). After the limit:

- Remaining P2/P3 findings: shipped, reported to the user as informational.
- Remaining P0/P1 findings: `success: false`, verdict `"escalate"`. The
  conversational model reports the blockers and the user decides.

This prevents infinite token burn while preserving the safety net for
critical issues.

### Reviewer personas

The adversarial code reviewer above is the default in the review-fix loop,
but it is one of several review personas. A persona is a focused review
prompt plus an output contract (structured findings, or a written report
file), reusing the same fork-and-prune context inheritance.

Cadence varies by persona:

- **Automatic / frequent** — run inside workstreams without being asked,
  e.g. a PR/commit reviewer that gates every change.
- **On-demand / rare** — invoked explicitly when wanted, e.g. a performance
  review that writes its findings to a report file.

Personas differ only in prompt and output shape; the context mechanism is
shared. Specialized personas are dispatched as workers and typically produce
a report artifact rather than gate a fix loop.

### Implementation notes (Phase 7)

How the fork-and-prune review is actually realized (verified empirically
against pi's RPC surface; see `review.ts`, `prune.ts`, `personas.ts`):

- **Forking = pi's `--fork` flag.** The worker persists its session by running
  with `--session-dir <scratch>` instead of `--no-session`; the orchestrator
  owns the scratch dir and reads the path from `WorkerResult.sessionFile`
  (captured via a `get_state` request). The reviewer process starts with
  `--fork <worker-session-file>`, which creates a *new* session inheriting the
  worker's full entry history — every read and bash output — for free.
- **The planning instruction needs no pruning.** Prewalk injects it as a
  per-process system-prompt modification (`before_agent_start`), which is not
  persisted as a session message; the forked reviewer rebuilds its own system
  prompt (the persona). So `pruneReviewContext` only filters what *is* in the
  inherited messages: assistant reasoning (text/thinking blocks), edit /
  write / checklist / yield tool calls and their results, and custom extension
  state entries. Factual read/bash/grep/find results and the task user message
  are kept; the worker's edits are replaced by the final diff, injected by the
  review runner. Pruning is a `context` handler returning the filtered
  messages — the same mechanism checklist injection uses.
- **Structured report via `report_findings`.** The reviewer-side extension
  (`tools/findings.ts`) registers the `report_findings` tool (TypeBox
  `ReviewResult` schema, `terminate:true` + `ctx.shutdown()`) alongside the
  pruning `context` handler. The runner captures the schema-valid payload from
  the tool's `result.details`.
- **Bounded fix loop.** `decideFixLoop` (pure) returns ship / fix / escalate:
  ship when tests pass and there are no P0/P1 blockers; fix while fix budget
  remains; escalate otherwise. A fix worker is dispatched with the P0/P1
  findings plus the failing verification output, then the orchestrator
  re-verifies and re-reviews (the diff is recomputed from the captured
  task-base commit each iteration).
- **Reviewer watchdogs (fail-fast, not 20-min-wait).** The forked review is
  bounded by three nested limits, in this order: the first-call fail-fast
  deadline (`REVIEW_FIRST_EVENT_TIMEOUT_MS` — the first parsed RPC event
  must arrive within this window of the prompt write), the no-progress
  watchdog (`REVIEW_NO_PROGRESS_TIMEOUT_MS`, deliberately shorter than the
  worker's — a review is one fast model pass, not a 70-turn exploration;
  any event resets the clock and an in-flight tool call counts as
  progress), and the wall backstop (`REVIEW_WALL_TIMEOUT_MS`, 20 min — the
  default for `[defaults] review_wall_timeout_ms`; each review fork gets its
  OWN wall, independent of the worker's tier wall). The
  reviewer's first model call re-encodes the whole pruned fork context on
  an empty prompt cache, and a wedged call emits zero RPC events, so the
  settle-based idle watchdog never fires; the two tighter bounds kill the
  run in minutes with messages naming the cause (stalled first call / no
  progress). Windows are overridable via
  `ForkReviewOptions.firstEventTimeoutMs` / `.noProgressTimeoutMs`; the
  wall via `ExecuteTaskOptions.reviewWallTimeoutMs` (config:
  `[defaults] review_wall_timeout_ms`). Root
  cause and evidence: docs/review-timeout-investigation.md.
- **Scope limits.** Review is single-worker in Phase 7 (the fix loop operates
  on one working copy; parallel + review warns and proceeds verify-only).
  Review defaults OFF — `ExecuteTaskOptions.review` is the per-call switch;
  the `task.toml` budget wiring (`review_model`, `review`,
  `max_fix_iterations`) landed in Phase 10.

## Worker System Prompt

Minimal (~150 tokens). Behavior is enforced by tools, not prose.

```
You are implementing a coding task. Explore the codebase, make changes,
and call yield() when complete.

Use checklist() to track your progress through requirements.
Make atomic jj commits as you complete each requirement.
Run verification commands after your changes.
When the project has tests, work test-first: write a failing test, verify it fails, then implement until it passes (red-green-refactor).
Write scratch/debug probes under /tmp, never in the repo — check jj file list before yielding so no debug files are tracked.

Your first edit should be your most confident change.
```

When prewalk is active, a planning prefix is prepended (and later pruned):

```
Before editing: explore thoroughly, then capture your plan as a checklist.
Keep the checklist to 12 items maximum. Each item should have a clear
verification step.
```

## Context Seeding

Workers cold-start: with no map of the repo they explore broadly — reading
far more than the task needs — and that exploration is discarded when the
session ends, so the next worker pays it again. Exploration should be a
capital investment amortized across tasks, not a per-task expense.

The fix is a **codebase map**: a cached, machine-maintained index of the repo
injected into every worker, turning cold-start broad reads into targeted
verification reads. It is distinct from the memory store (episodic lessons);
the map is structural fact about the current code.

### Shape

```json
{
  "tree_hash": "...", "generated": "...", "generator_model": "...",
  "entry_points": ["main.tscn", "scripts/autoload/game_manager.gd"],
  "test_layout": "tests/ via tests/run_all_tests.sh",
  "patterns": ["procedural UI in scripts, .tscn as stubs"],
  "files": [
    { "path": "scripts/battle/battle_resolver.gd", "lang": "gdscript",
      "symbols": ["_process_effects", "resolve"], "loc": 1214,
      "role": "core", "summary": "Combat resolution pipeline…" }
  ]
}
```

Stored at `<project>/.pi/cache/codebase-map.json` (gitignored, atomic write).

### Build (`repo-map.ts`)

1. **Invalidate** — hash the tracked file set (minus pi-owned machine-written
   files like `settings.json` — see `MACHINE_WRITTEN_FILES` in repo-map.ts);
   compare to `tree_hash`. Match
   → return cache (milliseconds). This is the entire freshness mechanism.
2. **Deterministic skeleton** (on stale) — walk the repo respecting
   `.gitignore`, extract per-file symbols via `universal-ctags` if present,
   regex fallback otherwise. No model, fast.
3. **LLM annotation** (the only cost, amortized) — one batched call to the
   fast model: one-line summary + role per file, plus entry points, patterns,
   and test layout. **Incremental:** re-annotate only files whose content
   changed since the last map.

Because the map is regenerated from code, it cannot rot the way a
hand-maintained README does — it is only ever stale until the next tree
change triggers a rebuild.

### Hook-in

Before spawning workers, the orchestrator loads the map and injects a
compressed, relevance-sliced view into the worker prompt:

- always: global overview (entry points, patterns, test layout) — ~300 tokens;
- task-relevant: files ranked by keyword overlap with the spec, top ~15 with
  their symbol lists — ~1–2K tokens.

The worker prompt changes from "explore the codebase" to "here is the repo
map; the files most relevant to this task are [list]; read those first, and
explore beyond them only if they don't cover the task."

**Configuration (`config/repo-map.toml`).** The map pipeline is configurable:

- `[mode] default` — `"full"` (LLM-annotated, the default) or `"skeleton"`
  (zero annotation cost; reuses cached annotations when available, otherwise
  path/symbols only).
- `[mode] annotation_model` — which model performs the annotation.
- `[injection] workers` — whether task-pipeline workers get the map.
- `[injection] slice_limit` — max files per relevance slice.

**Main-agent piping (Phase 9).** The conversational (main) session is a
second consumer of the cached map — cheap context gains, since the build is
amortized. Phase 9 injects it with a hybrid mechanism:

- always-on global overview in the main session's system prompt (~300 tokens,
  refreshed on tree change) — `formatMapOverview` (entry points, patterns,
  test layout; no file list) appended from a `before_agent_start` handler;
- an on-demand `codebase_map` tool the agent calls with a query to get the
  relevance-sliced file list (`sliceRelevant` + `formatMapPrompt`);
- an always-on **workflow contract** — a compact plan-first /
  delegate-by-default / orientation-only / spec-discipline block
  (`workflowContractText`, ~120-150 words) appended to the main session's
  system prompt from the same `before_agent_start` hook, pointing at the
  delegation skill, /build, and /plan. Static text: no cache read, no LLM,
  cannot block or throw.

The corresponding `[injection] main_agent`, `[injection]
overview_in_system_prompt`, and `[injection] workflow_contract` keys exist
in the config file, consumed by Phase 9: `main_agent` gates both map
consumers; `overview_in_system_prompt` additionally gates the always-on
system-prompt overview; `workflow_contract` gates the workflow-contract
block (default ON — a missing/invalid key degrades silently to on, so the
agent-dir config opts out explicitly). All degrade gracefully (map
unavailable → no overview, no error; disabled → no block, no error). The
`codebase_map` tool is registered at factory time (no flag dependency);
the `task` tool is registered at session_start for budget-schema locking
(see Budget Enforcement → Implementation notes).

### Write-back (gated)

A worker's yield may carry structural additions (new files) for the
orchestrator to merge. Semantic summaries stay authoritative from the
annotate pass — workers do not rewrite them, which prevents drift.

Worker `reads` count (already a metric) makes this directly testable: the
hypothesis is that the map cuts per-task worker reads substantially.

## Progress Streaming

The `task` tool uses pi's `onUpdate` callback to stream progress to the TUI
without burning LLM tokens. The FIRST update is emitted synchronously at
dispatch — before any worker event or turn — and shows the resolved plan:
the budget tier name plus the phase sequence that will run, in order,
with the full configured model identifier per active phase (the models
come from config/task.toml's `[budget.*]` tiers). Phases that will not run
are omitted, mirroring the orchestrator's own resolution: no prewalk
phase when the tier has no distinct `prewalk_model` (the auto-skip rule),
and no review phase when the tier sets `review = false` or the dispatch is
parallel (review is single-worker only).

Each worker's live line then tracks, updating as events stream:

- **Phase chain with completion marks** — the plan's phases up to the
  worker's current one, with every earlier phase marked complete, e.g.
  `✓prewalk → work` while working and `✓prewalk → ✓work → ✓review` once
  the worker has yielded (review always runs after yield). Workers start
  in the plan's first phase; prewalk → work fires on the same signal as
  the model swap (the first successful edit/write); work → review fires
  when the orchestrator starts the forked review. The plan line itself
  keeps showing the full phase sequence with models as-is.
- **Checklist progress** — relayed from the worker's REAL checklist state
  by observing the checklist tool's RPC events on the worker event stream
  (checklist-relay.ts): `tool_execution_start` args correlated with
  `tool_execution_end` results via toolCallId, the same pattern worker.ts
  uses for read paths. The relay is observer-only — no commands are sent
  to the worker and no LLM tokens are burned, so the checklist tool
  behavior, the prewalk swap trigger, and the post-swap reminder injection
  are unchanged. Until the worker initializes its checklist the line shows
  an explicit "no checklist yet" instead of guessing.
- **Liveness** — turn count plus time since the worker's last event, so a
  hung worker is distinguishable from one actively working.
- **Durations** — every worker line carries the current phase's elapsed
  time plus the run's total elapsed (e.g. `work 42s | total 1m05s`),
  both live against the render's `now`. While a worker is in the review
  phase its turn count and checklist are FROZEN (the reviewer is a
  separate process — its turn events must not advance the worker's
  counters), so the line's moving feedback is the review phase's own
  elapsed time, alongside the usual liveness signal.

```
plan(full): prewalk(<prewalk model>) → work(<execute model>) → review(<review model>)
0/2 workers done
  ⏳ worker-1: ✓prewalk → work 42s | total 1m05s | checklist 3/5 | 4 turns, 12s idle
  ⏳ worker-2: prewalk 12s | total 1m05s | no checklist yet | 2 turns, 3s idle
```

Once worker-1 yields and its forked review is running, its line becomes
`⏳ worker-1: ✓prewalk → ✓work → ✓review 15s | total 1m05s | checklist 5/5 |
4 turns, 0s idle` — all phases marked, the review clock moving (the spinner
stays: the review is still running on the worker's behalf).

Rendering is a pure function of the accumulated progress state plus an
explicit `now` (buildProgressText in progress.ts) — no LLM, no subprocess
— hermetically tested in test-index.ts.

The widget also answers "what is this worker doing" without any LLM:
- a per-worker **meta line** (goal + file-scope hints) parsed mechanically
  from each worker's spec at dispatch (`worker_meta` event;
  `parseSpec().goal` + `extractFileScope` in progress.ts),
- a **live tool line** (in-flight tool name + summarized args via the
  `tool_start`/`tool_end` events),
- **wall headroom** on the total clock (`total 45s/25m` from
  `RunPlan.wallTimeoutMs`) so a wall abort is never a surprise,
- **review wall headroom** on the plan line (`· review wall 20m` from
  `RunPlan.reviewWallTimeoutMs`) when a review will run — the reminder
  that the review phase has its OWN budget, separate from the worker's.

**In-place rendering (todo #68).** The `task` tool's `renderResult`
partial-progress branch reuses the previous component instead of
allocating a fresh one per update: it follows pi's documented
`context.lastComponent` pattern (the same one pi's own built-in tools
use — e.g. `dist/core/tools/find.ts` `renderResult`/`renderCall`),
mutating the last `Text` via `setText` and falling back to a new `Text`
only when no previous component exists (see `renderInPlace` in
index.ts). A fresh `Text` per `onUpdate` would stack a new line on every
progress event — the initial render plus each live render accumulate
instead of updating in place. The reuse contract is pinned hermetically
in test-index.ts; the live stacking behavior is TUI-verified.

The conversational model only sees the final typed result (plus the
summary content text — see The `task` Tool → Returns).

## Console discipline

Extensions share the process console, and pi surfaces extension console
output in the UI (todo #73: it leaks into the prompt box). The task
extension therefore writes NO console warnings for conditions that are
expected parts of normal runs — a normal successful run (single and
parallel, codebase map available or unavailable) produces zero extension
`console.warn` output:

- **Expected-condition degradation is silent.** A missing/unavailable
  codebase map, a failed map annotation (builds degrade to a skeleton
  map and self-heal on the next build), the background map refresh at
  session_start, and a parallel run ignoring a review request (review is
  single-worker only) all proceed without console output — the signals
  live in the tool result instead (reviewSkipped, the plan line, the
  summary text).
- **User-config diagnostics stay.** Invalid task.toml / repo-map.toml
  values warn-and-fallback (the user must fix the file); see
  config.ts/repo-map.ts loaders.
- **Genuine unexpected failures may warn.** E.g. a failed jj workspace
  cleanup leaves a stale workspace in the user's repo — actionable, and
  not something a normal run produces.

## Metrics

Every run produces a structured manifest. Collection is external — the
orchestrator watches worker events on the RPC socket and accumulates. Workers
don't know they're being measured.

### RunManifest

```typescript
interface RunManifest {
  run_id: string;
  received_at?: string;         // ISO — task tool execute starts (task tool)
  dispatched_at?: string;       // ISO — worker session spawns (orchestrator)
  completed_at?: string;        // ISO — run finishes (manifest assembly)
  main_session_tokens?: number; // main-agent tokens consumed before the task
  config: {
    budget: string;
    prewalk_model: string;
    execute_model: string;
    review_model: string;
    swap_trigger: string;
    checklist: boolean;
    review_forked: boolean;
  };
  task: { spec_hash: string; requirements: number };
  phases: {
    prewalk:  PhaseMetrics | null;
    execute:  PhaseMetrics;
    verify:   { passed: boolean; commands: number; duration_ms: number };
    review:   { model: string; forked: boolean; context_inherited_tokens: number;
                findings: number; by_priority: Record<string, number>;
                cost_usd: number } | null;
    fix_loop: { iterations: number; cost_usd: number };
  };
  totals: {
    cost_usd: number;
    duration_ms: number;
    read_duplication_tokens: number;
    session_files: string[];
    files_changed: string[];   // aggregate worker-yield file lists
    insertions: number;        // added lines in the worker commit diffs
    deletions: number;         // removed lines in the worker commit diffs
  };
}

interface PhaseMetrics {
  model: string;
  turns: number;
  tokens_in: number;
  tokens_out: number;
  reads: number;
  edits: number;
  duration_ms: number;
  cost_usd: number;
}
```

**`read_duplication_tokens`** is the key validation metric. The orchestrator
tracks which files were read during prewalk and their token cost. If the
execution phase re-reads the same file, those tokens count as duplication.
If prewalk's context continuity works, this is near zero. If it's high, the
swap isn't preserving context effectively. This single number validates or
falsifies the core cost-savings claim on our models and tasks.

**`received_at` / `dispatched_at` / `completed_at`** are the wall-clock run
lifecycle (ISO strings): `received_at` is stamped when the task tool's
execute starts, `dispatched_at` when the worker session(s) spawn, and
`completed_at` when the manifest is assembled (the run finishes).
`main_session_tokens` is the main agent's cumulative token spend read from
the session entries at dispatch time (worker tokens stay in `phases`). All
four are optional: direct `executeTask` callers that don't supply them get
absent/zero fields (backward compatible). **`/task-stats` latency** (the
headline p50/p90 and the recent-run durations) is `completed_at −
received_at` when both timestamps exist — real wall time includes dispatch
overhead the worker cannot see — falling back to `totals.duration_ms`
(see `runLatencyMs` in metrics.ts).

**`totals.files_changed` / `insertions` / `deletions`** describe the worker
commits: `files_changed` is the union of the workers' schema-validated
yield lists, and `insertions`/`deletions` are line counts parsed from `jj
diff --git` over the task base..head range (added/removed lines, `+++`/
`---` hunk headers excluded — see `parseDiffStat` in orchestrator.ts).
Best-effort: a metrics jj failure records 0/0 rather than failing an
otherwise-successful run.

### Storage

```
~/.pi/agent/results/<project>/
├── 2026-07-31T1642-a3f2.json          # metrics summary
├── 2026-07-31T1642-a3f2/
│   ├── worker-1.jsonl                  # full session trace (benchmark mode)
│   └── review-1.jsonl                  # forked review session trace
└── ...
```

Metrics JSON is the summary — small, greppable, jq-able. Session files are
the detailed trace for post-hoc analysis. Normal mode: sessions ephemeral.
Benchmark mode (`--preserve-sessions`): sessions saved alongside metrics.

Config is embedded in every manifest, so A/B comparison is trivial:

```bash
jq -r '[.config.budget, .totals.cost_usd] | @tsv' results/proj/*.json
jq 'select(.totals.read_duplication_tokens > 1000)' results/proj/*.json
```

### Implementation notes (Phase 8)

How the manifest is actually produced (see `metrics.ts`, `orchestrator.ts`):

- **Per-phase split at the swap turn.** `splitPhases` divides the worker's
  per-turn cumulative usage snapshots + read log at the prewalk swap turn
  (the first edit; that turn belongs to prewalk) into `prewalk` and
  `execute` PhaseMetrics. Durations are split proportionally to turns
  (documented approximation). With no swap, `prewalk` is null.
- **`read_duplication_tokens` is approximate.** The worker's read log
  records `{path, approxTokens, turn}`, correlating the read tool's
  `args.path` (start event) with its result text length (≈ chars / 4).
  Duplication = files read in both phases; tokens = the execute-phase
  re-reads' approxTokens.
- **`context_inherited_tokens` is approximate.** The reviewer inherits the
  worker's final context ≈ the worker's last-turn input-token delta.
- **Storage.** `writeManifest` writes `<metricsDir>/<project>/<run_id>.json`
  atomically (tmp + rename); `copySessionTraces` preserves worker session
  traces under `<run_id>/` in benchmark mode (`preserveSessions`, which
  implies a metricsDir). The production default results dir
  (`~/.pi/agent/results/`) is data and must be gitignored; callers pass a
  metricsDir explicitly (Phase 9's task tool supplies the real one).
- **`config.budget` is the resolved tier** — the task tool passes
  `budget: <tier>` to executeTask (Phase 10), so persisted manifests carry
  `full | economy | free`; direct callers that omit it get `"default"`.
  The manifest is always built in-memory (`TaskResult.manifest`); it is
  persisted only when a metricsDir is set.

## File Structure

```
~/.pi/agent/
├── extensions/
│   └── task/
│       ├── index.ts            # Extension entry: registers task tool,
│       │                       # budget flag, /task-budget command
│       ├── orchestrator.ts     # Deterministic workflow engine
│       ├── worker.ts           # RPC session spawn/manage/communicate
│       ├── prewalk.ts          # Event-driven model swap logic
│       ├── checklist-relay.ts  # Observer-only checklist state relay
│       ├── progress.ts         # Dispatch plan + live progress view (pure)
│       ├── workspace.ts        # jj workspace create/merge/cleanup
│       ├── review.ts           # Forked-session adversarial review
│       ├── repo-map.ts         # Codebase map build/load (context seeding)
│       ├── metrics.ts          # RunManifest collection and storage
│       ├── config.ts           # task.toml loader + budget tier vocabulary
│       ├── personas/           # Reviewer persona prompts + output contracts
│       ├── tools/
│       │   ├── yield.ts        # yield tool (registered inside workers)
│       │   ├── checklist.ts    # checklist tool (registered inside workers)
│       │   ├── prewalk.ts      # planning-instruction injection (workers)
│       │   └── findings.ts     # report_findings tool (registered in reviewers)
│       └── schemas/
│           ├── spec.ts         # Spec parsing + validation
│           ├── yield.ts        # Worker output schema (zod)
│           └── findings.ts     # Review findings + verdict schema (zod)
├── config/
│   ├── task.toml               # Budget tiers, model assignments, defaults
│   └── repo-map.toml           # Codebase-map mode/annotation model/injection
├── results/                    # Run manifests + session traces (gitignored)
└── docs/
    └── pi-task-design.md       # This document
```

## Relationship to Existing Tooling

| Existing | Disposition |
|----------|-------------|
| `subagent` extension | Replaced by `task` extension. Subagent's fire-and-forget `pi -p` model is incompatible with prewalk, typed results, and session forking. (Retired Phase 10.) |
| `spec-build-chain` skill | Replaced. Workflow logic moves to orchestrator code. (Retired Phase 10.) |
| Agent `.md` files (scout, planner, worker, reviewer) | Retired. Worker behavior is defined by tool surface + minimal prompt. Review is a forked-session adversarial pass, not an agent persona. (Retired Phase 10.) |
| `models.md` | Replaced by `task.toml` budget tiers. (Retired Phase 10.) |
| `.pi/TODO.json` + todo extension | Unchanged. User-owned. Workers never touch it. |
| Memory store extension | Unchanged. Still captures cross-session learnings. |
| Spec format (Goal/Requirements/Non-goals/Verification) | Retained as the input contract. Now also machine-parseable. |

## Invocation Examples

### Conversational (primary UX)

The user talks to their model. The model decides when to dispatch:

```
User: "Add rate limiting to the API endpoints"
Model: [understands intent, formulates spec, calls task()]
  → task({ spec: "..." })
  → [orchestrator executes, streams progress to TUI]
  → returns { success: true, commits: ["abc123"], tests: "passing", ... }
Model: "Done. Rate limiting added with a 100 req/min default.
        One commit, tests passing."
```

### Parallel decomposition

```
User: "Refactor auth: split into OAuth and API-key modules"
Model: [recognizes two independent sub-tasks]
  → task({ spec: "OAuth module...", parallel: 2 })
  → [2 workers in isolated workspaces, both with prewalk]
  → returns merged result
```

### Budget-locked session

```bash
pi --task-budget free
```

```
User: "Fix the CSV export quoting bug"
Model: [writes spec, calls task({ spec: "..." })]
  → [single worker, no prewalk, no review — enforced by flag]
  → returns { success: true, ... }
```

The model never sees a budget parameter. It cannot override, deliberate,
or waste tokens considering model tiers.

### Model does it directly (no dispatch)

```
User: "Typo in README line 42"
Model: [just edits the file, no task() call needed]
```

## Implementation Strategy

### Development workspace

Build pi-task in a dedicated jj workspace, not the live `~/.pi/agent`
working copy. The global config is in daily use across concurrent sessions;
developing in place risks breaking the tooling those sessions depend on.

```bash
cd ~/.pi/agent
jj workspace add ../pi-task-dev    # shared commits + op log; own working copy
```

The workspace shares commits and the operation log with the main repo but has
its own working copy, so iterating on `extensions/task/` cannot break the
config your daily sessions run on. Commit normally inside the workspace; when
a phase is stable, advance `main` to that work and `jj workspace forget` the
workspace. See the jj skill for workspace mechanics.

This is **development** isolation — where pi-task is built. It is distinct
from `workspace.ts` (phase 6 below), which is **runtime** isolation:
separating parallel workers from each other during task execution.

### Phases

| Phase | Deliverable | Value |
|-------|-------------|-------|
| 1 | `worker.ts` + `yield` tool: spawn RPC sessions, typed output | Eliminates prose parsing |
| 2 | `orchestrator.ts` + spec validation + verification runner | Code-driven workflow |
| 3 | `prewalk.ts`: event-driven model swap | Cost reduction |
| 4 | `checklist.ts` + context injection | Steering for fast models |
| 5 | `repo-map.ts`: codebase map + worker prompt injection (context seeding); configurable via `config/repo-map.toml` (mode, annotation model, injection targets) | Cuts cold-start reads |
| 6 | `workspace.ts`: jj workspace isolation for parallel workers | Safe parallelism |
| 7 | `review.ts`: forked adversarial review + bounded fix loop + persona library | Quality gate |
| 8 | `metrics.ts`: RunManifest collection + storage | Observability |
| 9 | `index.ts`: task tool + budget flag + `/task-budget` command + TUI; injects the codebase map into the main session (hybrid: always-on overview + on-demand `codebase_map` tool) | User-facing integration |
| 10 | `task.toml` + budget resolution + auto heuristic + schema locking | Graceful degradation (config-driven, warn-and-fallback; done) |

Phases 1-2 are the foundation. Each subsequent phase adds value independently
and can be shipped incrementally.

## Testing

The suite is split by cost and hermeticity (see `docs/pi-task-testing-spec.md`
for the full contract):

- **Fast hermetic suite** — `timeout 120 npx tsx extensions/task/test.ts`.
  Pure-function unit tests plus real-jj / real-bash tests on temp dirs;
  zero LLM calls, deterministic, runs in seconds. Convention (enforced in
  `test.ts`'s header): fast test files never import `spawnWorkerSession` or
  `executeTask` — worker spawning is exercised only by the e2e. Each fast
  file covers one module and can run standalone; which behavior lives where:
  JSONL framing (`test-jsonl.ts`), worker event reducer + settle logic
  (`test-worker.ts`), prewalk swap decision via an in-process fake session
  (`test-prewalk.ts`), checklist state machine (`test-checklist.ts`),
  checklist relay reconstruction via an in-process fake session
  (`test-checklist-relay.ts`), spec
  parse/split + verification runner (`test-orchestrator.ts`), jj workspace
  mechanics + conflict surfacing (`test-workspace.ts`), the sandbox builder policy +
  resolution + spawn wrapping + guarded real-bwrap probes
  (`test-sandbox.ts`), repo-map skeleton /
  tree hash / cache / slicing / annotation parsing / config / skeleton mode
  (`test-repo-map.ts`), review report contract (`test-findings.ts`),
  review-context pruning (`test-prune.ts`), reviewer personas
  (`test-personas.ts`), review prompt assembly + settle logic
  (`test-review.ts`), the fix-loop decision / blocker policy / fix-prompt
  assembly (in `test-orchestrator.ts`), the RunManifest metrics — phase
  split, read duplication, storage (`test-metrics.ts`), the task.toml
  loader — defaults / warn-and-fallback / shipped-drift guard
  (`test-config.ts`), and the budget schema locking / resolution chain /
  auto heuristic / sub_specs precedence / result mapping / dispatch plan /
  progress render (`test-index.ts`). The repo root
  carries a tracked `package.json`
  (`type: module`) plus a gitignored `node_modules` symlink set into pi's own
  install so tsx can resolve pi's runtime deps (typebox, `@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent`) — recreate the symlinks on a fresh machine
  per the README's "Testing the task extension" section.
- **One real-LLM e2e** — `timeout 900 npx tsx extensions/task/test-e2e.ts`,
  run manually (several minutes; a few cents — the review sections add LLM
  sessions). Drives real pi end to end:
  worker lifecycle + abort, checklist steering + prewalk-extension pruning,
  `executeTask` single and parallel, repo-map annotation/cache/incremental,
  forked adversarial review (clean task → verdict ship), and the review fix
  loop (failing verification → fix worker → green).
  The e2e hardcodes the cheap fast model (`opencode-go/deepseek-v4-flash`)
  as the only model; the prewalk *swap* (which needs two distinct models)
  is covered hermetically by `test-prewalk.ts`, not e2e.

## Validation

### Borrowed claims

This design incorporates claims from external sources. Each is a hypothesis
to test, not an assumption:

| Claim | Source | Falsified if... |
|---|---|---|
| Prewalk saves 30-50% cost | Stencil blog (SWE-Bench Pro, Opus/GPT-5.6) | Cost delta < 15% on our models/tasks |
| Todo-list steering prevents fast models from getting lost | Same article (anecdotal) | Fast model completes without nagging |
| Pruning planning context removes reviewer bias | Our own extrapolation (zero evidence) | Pruned fork confirms known flaws as "fine" |
| Typed yield beats prose output | omp marketing | Prose parsing succeeds reliably |
| Diff-only review is insufficient | General intuition + experience | Diff + spec catches same flaws as full-context |

### Hypotheses to test first

| # | Test | Arms |
|---|---|---|
| 1 | Prewalk cost savings | Same task: prewalk vs single-model-throughout |
| 2 | Forked review catches flaws | Trap tasks: forked vs fresh diff-only reviewer |
| 3 | Pruning removes bias | Trap tasks: pruned fork vs unpruned self-review |
| 4 | Checklist steering helps | Same task: with vs without checklist nagging |

### Toy benchmark structure

Small self-contained repos (5-15 files) with existing test suites. Three
tiers: trivial (single file), medium (multi-file), and trap (passes tests
but has a known planted flaw the reviewer should catch).

Each task has an `expected.json` with pass criteria, known flaws, and
expected review findings. Run each task × each config arm × 3 repetitions.
Compare: cost, pass rate, duration, flaw detection rate, read duplication.

### Design for benchmarkability

- Headless CLI: `pi-task --spec task.md --config arm.toml --output run.json`
- Config injection per run (override budget/models/prewalk for A/B)
- Session preservation (`--preserve-sessions`) for post-hoc trace analysis
- Gradeable finding schema (compare against known-flaw list programmatically)
- `read_duplication_tokens` in every manifest (directly tests core claim)

## Worker Sandbox

Workers execute arbitrary bash commands and edit files. A confused or
compromised worker should not be able to trash the host filesystem. Workers
run inside a bubblewrap (bwrap) sandbox with an explicit mount allowlist.

### Default policy

```bash
bwrap \
  --ro-bind / /                          # read-only system (libs, tools, binaries)
  --ro-bind $AGENT_DIR $AGENT_DIR        # read-only: ~/.pi/agent (repo content, tooling)
  --bind $AGENT_DIR/settings.json ...    # rw: pi runtime-state paths (PI_RUNTIME_STATE_PATHS)
  --bind $PROJECT_DIR/.jj $PROJECT_DIR/.jj  # rw: shared jj store (parallel commits)
  --bind $PROJECT_DIR/.git $PROJECT_DIR/.git
  --bind $PROJECT_DIR $PROJECT_DIR       # read-write: the project (single-worker cwd)
  --bind $WORKSPACE_DIR $WORKSPACE_DIR   # read-write: jj workspace (parallel only)
  --tmpfs /tmp                           # isolated scratchpad per worker
  --dev /dev --proc /proc \
  --die-with-parent --new-session \
  -- pi --mode rpc ...
```

Everything outside the explicit bind mounts is read-only. Workers can read
system files, installed tools, and their tooling/extensions from the agent
dir, but can only write to the project/workspace (the worker cwd), pi's
runtime-state paths inside the agent dir (`PI_RUNTIME_STATE_PATHS` in
sandbox.ts — `settings.json`, `trust.json`, `sessions/`, `cache/`, ...),
the shared jj store (`.jj`/`.git` of the project — parallel workspace
commits write into it), and the orchestrator's temp dirs (the
system-prompt/session dirs, bound back rw after `--tmpfs /tmp`). `/tmp` is
a fresh tmpfs per worker — no cross-worker leakage.

Both exceptions are load-bearing: a read-only `settings.json` hangs the
worker's pi process on its startup write (observed P0), and a read-only
shared store fails every parallel workspace commit with EROFS (verified).
Repo CONTENT (`config/`, `extensions/`, tracked files) and `auth.json`
stay read-only — the isolation guarantee (a parallel worker cannot escape
its workspace into the main repo, issue #83) holds.

The agent dir is bound READ-ONLY (before the cwd rw bind, in mount order)
so a parallel worker cannot escape its jj workspace by writing into the
main repo through the agent dir — the isolation gap found in the issue #83
reproduction, where a worker wrote `/home/danong/.pi/agent/a.txt` via an
absolute path. EXCEPTION (todo #89): pi's own runtime-state paths inside the
agent dir (`PI_RUNTIME_STATE_PATHS` in sandbox.ts — `settings.json`,
`trust.json`, `models-store.json`, `sessions/`, `cache/`, `results/`, `tmp/`,
`npm/`, `.npm-cache`) are bound read-write, because the worker's pi process
writes them at startup and during the run — most importantly `settings.json`
(the changelog check records `lastChangelogVersion`), and a read-only bind
there hangs the worker on the first write (observed P0). These are machine
state, not repo content: `auth.json` and the tracked files (config/,
extensions/, docs/, ...) stay read-only, so the isolation guarantee still
holds. Only existing paths are bound (bwrap fails on a missing source). The
single-worker path keeps full write access: when
`cwd == $AGENT_DIR` (a project that IS the agent dir, e.g. this repo) the
later cwd rw bind shadows the ro bind for that path, so the worker still
commits to its project normally.

The checklist tool is unaffected by the read-only agent dir: its state
(init/done/status and the context-reminder injection) all lives in
session entries via `pi.appendEntry` — bound to the session (in-memory
with `--no-session`), never written to agent-dir files.

The orchestrator constructs the bwrap arguments per worker. It knows the
exact project dir, workspace paths, and agent dir — explicit paths, not
pattern matching.

### Configuration

```toml
[sandbox]
enabled = true                # false to disable (debugging, macOS)
network = "allow"             # "allow" | "isolate" (--unshare-net)
backend = "bwrap"             # "bwrap" | "container" | "none"
extra_ro_binds = []           # additional read-only paths
extra_rw_binds = []           # additional read-write paths
```

The agent dir is unconditionally read-only (see Default policy) — there is
no `agent_config` knob; the shipped `config/task.toml` carries the same
vocabulary as the code (`enabled` / `network` / `extra_ro_binds` /
`extra_rw_binds`).

**Network.** Default `"allow"` — workers often need network for verification
(`npm install`, tests hitting localhost services). `"isolate"` adds
`--unshare-net` for stricter environments.

**Agent dir is read-only.** Workers read their tooling and extensions from
`~/.pi/agent` but cannot write into it — a parallel worker must not be able
to escape its workspace through the agent dir (see Default policy). The
checklist tool keeps working because its state is session entries, not
agent-dir files.

**Extra binds.** Project-specific needs (shared data dirs, build caches)
without modifying the orchestrator.

### Platform support

bwrap requires Linux with user namespaces (`sysctl
kernel.unprivileged_userns_clone=1` on some distros). No daemon, no root,
millisecond startup.

macOS has no equivalent lightweight sandbox (`sandbox-exec` is deprecated).
The `"container"` backend (Podman/Docker with the same mount layout) is a
future portability path. `"none"` disables sandboxing with a warning.

## Non-Goals

- Nested task dispatch (workers cannot spawn their own workers)
- Cross-worker communication (workers are independent; coordination is the
  conversational model's job)
- Automatic spec generation (the conversational model writes the spec; the
  tool validates it)
- Replacing direct editing (trivial changes bypass task() entirely)
- Model-selected budget (the user controls spend; the model controls work)

## Verification lifecycle: baseline evidence (spec-defect adjudication)

Verification commands are the quality contract, but spec authors can write
broken gates (incident class: a grep substring-matching a live symbol —
fails identically before and after any change, and no fix worker can ever
satisfy it). The engine adjudicates by EVIDENCE, not prompts:

1. **Dispatch-time dry run** — `captureVerificationBaseline` runs every
   verification command once on the untouched tree (zero model tokens).
   Unambiguously broken commands (exit 127 / shell syntax errors) REJECT
   the dispatch before any worker spawns; everything else is a recorded
   baseline (a red baseline is TDD, not a defect).
2. **Baseline-aware adjudication** — post-change, each failing command is
   compared to its baseline (`classifyVerificationFailures`): identical
   exit + output signature → suspected spec defect → the fix loop spends
   ZERO iterations on it (all-suspect → escalate with evidence; mixed →
   fix only the actionable failures). The manifest's verify phase records
   `suspected_spec_defects`; the tool return + summary surface them.

Worker autonomy to challenge a gate is a structured `dispute_verification`
protocol (planned phase 2) — adjudicated by the same baseline evidence,
never unilateral.
