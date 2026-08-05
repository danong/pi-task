# pi-task — Phase 9 Handoff

You are implementing **Phase 9** of `pi-task`, a task-execution engine for pi.
Phases 1–8 are complete and committed (see "Current state" below). This phase
builds the **user-facing integration**: the `task` tool the conversational
(main) agent calls, the budget flag + `/task-budget` command, TUI progress
streaming, and codebase-map injection into the main session. Read the code
before writing anything — the hard problems (worker sessions, prewalk, review,
metrics) are already solved and the patterns are established.

## Mission

Build **`extensions/task/index.ts`** — the pi extension entry point that exposes
pi-task to the main session:

1. **The `task` tool** (primary UX). The main agent calls it with a spec — or a
   set of per-worker sub-specs — and it runs `executeTask`, returning the typed
   result. This is where the conversational model meets the orchestrator.
2. **Budget enforcement surface**: the `--task-budget` CLI flag + `/task-budget`
   session command, with **schema locking** (when a tier is locked the model
   never sees a `budget` parameter and cannot override it).
3. **TUI progress streaming**: stream worker/review progress via `onUpdate` and
   render the final result via `renderResult` (no LLM tokens for the chrome).
4. **Main-session codebase-map injection** (hybrid): an always-on global
   overview in the main session's system prompt + an on-demand `codebase_map`
   tool for relevance-sliced queries.
5. **`sub_specs` support in `executeTask`** — the structural fix for the
   parallel spec-leakage problem. **Read the dedicated section below carefully;
   it changes how parallel decomposition is driven.**

## Current state (verified)

- All work lives in the **pi-task-dev workspace**: `/home/danong/.pi/pi-task-dev`
  (a jj workspace over the shared `~/.pi/agent` repo — shared commits + op log,
  own working copy). The live config `~/.pi/agent/extensions/` is **untouched**.
  Both workspaces are clean. (A stale-working-copy incident on the *default*
  workspace was recovered with `jj workspace update-stale` — the op log had
  diverged and an old op was pruned; `jj st` / `jj log` are correct now. If you
  ever see "working copy is stale", run `jj workspace update-stale` in that
  workspace; do **not** force anything.)
- **Feature branch**: the commits listed below, branched off `main`. `main` is
  at `72d625ce`, **not advanced, not pushed**. `@` is an empty commit on
  `eac839bf`. Newest → oldest:

  ```
  eac839bf fix(task): parallel sub-task Scope contract — stop workers over-creating
  239df3e6 test(task): phase 8 e2e — RunManifest metrics section + docs
  deca2faf feat(task): phase 8 orchestrator metrics wiring — manifest per run
  e09f850a feat(task): phase 8 manifest + session-trace storage
  13d9f167 feat(task): phase 8 phase-split + read-duplication metrics (pure)
  0efaf222 feat(task): phase 8 worker read tracking + per-turn usage snapshots
  9936ae3d feat(task): phase 8 RunManifest types + pure buildRunManifest
  29578fcf docs(task): phase 7 review implementation notes + testing coverage
  a6422e8e test(task): phase 7 e2e — forked review + bounded fix loop
  07253338 feat(task): phase 7 bounded review-fix loop wired into the orchestrator
  26d0a6d5 feat(task): phase 7 forkedReview — adversarial review runner
  f225faf3 feat(task): phase 7 reviewer persona library (adversarial default)
  ffdbf8a2 feat(task): phase 7 review-context pruning — strip worker bias from the fork
  4e460c5f feat(task): phase 7 worker session persistence for review forking
  e6e849c1 feat(task): phase 7 review report contract — findings schema + report_findings tool
  e4d7f339 docs(task): typecheck recipe needs target ES2022
  91cd956e fix(task): restore benign duplicate checklist done result
  4e7bdfde fix(task): checklist context handler delegates to extracted helpers
  e2d5889d test(task): consolidated real-LLM e2e; retire the six LLM smoke tests
  d6b76344 test(task): fast hermetic suite — pure unit tests + real jj/bash, zero LLM
  54a9bf3a fix(task): runCommand timeout mapping — Node 22 killed/SIGTERM → 124
  b90095ac refactor(task): extract testable pure logic for hermetic tests
  e729a232 feat(task): phase 6 — jj workspace isolation for parallel workers
  285ead66 docs(pi-task): add phase 6 handoff doc
  28acca38 feat(task): phase 5 config — repo-map.toml, build modes, main-agent piping (phase 9)
  8c7922ae feat(task): phase 5 — repo-map context seeding
  5e50eaec feat(task): phase 4 — checklist tool with context-injection steering
  6adb602f feat(task): phase 3 — prewalk event-driven model swap
  7fdc74b3 feat(task): phase 2 — orchestrator with spec validation and verification gate
  c4ddb597 refactor(task): rename test-phase1 → test-worker-runner
  d1fedcab feat(task): phase 1 — worker runner with typed yield
  ```

- **Files in `extensions/task/`**: `worker.ts`, `orchestrator.ts`, `prewalk.ts`,
  `repo-map.ts`, `workspace.ts`, `review.ts`, `prune.ts`, `personas.ts`,
  `metrics.ts`, `schemas/{spec,yield,findings}.ts`, `tools/{yield,checklist,
  prewalk,findings}.ts`, `config/repo-map.toml`, the fast tests
  (`test-{jsonl,findings,prune,personas,review,metrics,worker,prewalk,checklist,
  orchestrator,workspace,repo-map}.ts` wired in `test.ts`), and `test-e2e.ts`.
  There is **no `index.ts` yet** — that is this phase.
- **Test state**: the fast suite is the 12 hermetic suites wired in `test.ts`
  (`timeout 120 npx tsx extensions/task/test.ts`, ~1s, zero LLM). The manual
  real-LLM e2e is `test-e2e.ts` (9 sections). Last full e2e run: sections
  1–4 and 6–9 passed; **section 5 (parallel) failed once** due to the
  goal-leakage issue, which is now **fixed** (`eac839bf`, Scope contract) and
  verified **3/3 clean** in isolated reproductions. The full e2e has **not**
  been re-run since that fix.
- **What `executeTask` already does** (your tool wraps this): single + parallel
  workers in isolated jj workspaces, prewalk model swap, checklist steering,
  repo-map injection into worker prompts, forked adversarial review + bounded
  fix loop, and a per-run `RunManifest` (`TaskResult.manifest`, persisted when
  `metricsDir` is set). See `ExecuteTaskOptions` / `TaskResult` in
  `orchestrator.ts` for the exact surface.

## Required reading (in order)

1. **`docs/pi-task-design.md`** — especially: **"The `task` Tool"** (parameters
   + return shape), **"Budget Enforcement"** (CLI flag, schema locking,
   `/task-budget`, status bar), **"Progress Streaming"**, **"Context Seeding →
   Main-agent piping (Phase 9)"**, **"File Structure"** (the `index.ts` row),
   and the **Phases table** (rows 9 and 10, for the boundary with Phase 10).
2. **`docs/pi-task-phase6-handoff.md`** — the handoff conventions and the
   parallel mechanics you are building the user-facing layer on top of.
3. **`docs/pi-task-testing-spec.md`** — the fast/e2e test contract and the
   **strict-typecheck recipe** (scratch tsconfig; remember `target: ES2022`).
4. **The code**: `orchestrator.ts` (`executeTask`, `ExecuteTaskOptions`,
   `TaskResult`, `splitSpec`), `repo-map.ts` (`buildMap`, `formatMapPrompt`,
   `sliceRelevant`, `loadRepoMapConfig`), `metrics.ts` (`RunManifest`),
   `worker.ts` (`DEFAULT_WORKER_SYSTEM_PROMPT`).
5. **pi extensions API** —
   `/home/danong/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`:
   `pi.registerTool` (+ `execute(toolCallId, params, signal, onUpdate, ctx)` and
   `renderResult`), `pi.registerFlag` + `pi.getFlag`, `pi.registerCommand`,
   `ctx.ui.setStatus`, and `pi.on("before_agent_start")` with
   `event.systemPromptOptions`.
6. **jj skill** — `/home/danong/.pi/agent/skills/jj/SKILL.md`. Load before any
   jj work.

## Step 0 — get oriented

```bash
cd /home/danong/.pi/pi-task-dev
jj st                     # should show an empty @ on top of eac839bf
```

- Put all new code under `/home/danong/.pi/pi-task-dev/extensions/task/`.
- Do **not** edit anything under `/home/danong/.pi/agent/extensions/` (live config).
- The shell cwd does **not** persist across bash calls — prefix every command
  with `cd /home/danong/.pi/pi-task-dev && ...`.

## Parallel decomposition & spec encapsulation — READ CAREFULLY

This is the key design implication from the phase-8 debugging session and it
**changes how Phase 9 drives parallelism**. Understand it before touching the
`task` tool's parallel parameters.

### The problem (discovered + empirically verified)

`executeTask`'s mechanical `splitSpec` round-robins the requirements across
workers **but passes the shared Goal verbatim to every worker**. A goal that
names the deliverables leaks the other partitions' work:

```
Spec goal:  "Create two independent files in the repo root: a.txt and b.txt."
Worker 1's sub-task = Goal (names BOTH files) + only "R2: create b.txt".
```

A fast worker reads the goal's explicit file list and **over-creates** — it
makes `a.txt` too, even though only `b.txt` is in its requirements. When two
workers both create the same file, the merge conflicts whenever their copies
diverge. This was verified: **before the fix, both workers created both files
in 100% of reproduction runs.** This is neither random LLM noise nor an
orchestrator-mechanics bug — it is the sub-task prompt leaking scope via the
goal.

### The stopgap (already committed: `eac839bf`)

`splitSpec` now appends an explicit **Scope contract** to every sub-task:
*"This is one partition of a parallel task. Implement ONLY the requirements
listed in this sub-task; other partitions handle the rest."* This makes the
listed requirements binding over the goal. Verified **3/3 repro clean** (each
worker creates only its assigned file). **It is a behavioral nudge** — it
relies on the model obeying the instruction. It hardens the mechanical path but
does not remove the leak.

### The structural fix for Phase 9 (what you must build)

Decomposition is the **main agent's job** (design doc). So the `task` tool must
let the main agent write **encapsulated per-worker sub-specs**, so that no
worker ever sees another's work-unit:

- Add **`sub_specs: string[]`** to the `task` tool and **`subSpecs?: string[]`**
  to `ExecuteTaskOptions`. When provided, spawn **one worker per sub-spec**
  (`parallel = sub_specs.length`), each receiving **its own sub-spec as the task
  prompt** — **no `splitSpec`, no shared goal, no leak by construction.** Each
  sub-spec must be fully self-contained (its own goal + requirements, no
  cross-references to the other partitions).
- The mechanical path (**one `spec` + `parallel`** → `splitSpec`) remains as the
  **fallback** when the model passes a single spec, with the Scope contract.
- **Cost note**: writing N sub-specs is **not** an extra LLM call — it is the
  same `task` invocation producing a richer payload.
- **Correction to a common misconception**: the orchestrator does **not** decide
  to split based on spec size. `parallel` (or `sub_specs`) is **caller-supplied
  by the main agent in the same `task` call**. The code only runs the mechanics.
- **Verification stays a single post-merge gate** in both modes (sub-specs and
  mechanical split share the merged-tree verification).

**Precedence rule**: if `sub_specs` is provided it wins (`parallel` is derived
from its length; ignore/validate any `parallel` arg against it). If only `spec`
+ `parallel`, use `splitSpec`.

## Deliverables

Create/modify under `/home/danong/.pi/pi-task-dev/extensions/task/`:

### 1. `index.ts` — extension entry point

- **Register the `task` tool.** Parameters:
  - `spec` (string, required unless `sub_specs` given): markdown with
    `## Goal` / `## Requirements` / `## Verification`.
  - `sub_specs` (string[], optional): per-worker encapsulated specs (see the
    section above). Takes precedence over `spec`+`parallel`.
  - `parallel` (integer, optional): mechanical-split fallback worker count.
  - `budget` (optional, **only when not locked** — see §2): one of
    `auto|full|economy|free`.
  - **Return** (map from `TaskResult`): `success`, `commits`, `tests`,
    `files_changed`, `review`, `metrics` (the `RunManifest`). Match the design
    doc's "The `task` Tool" return shape.
- **`execute()`** resolves models (see §2), calls `executeTask({ cwd, model,
  spec | subSpecs, parallel, review…, onUpdate })`, and returns the typed
  result. Stream progress via the `onUpdate` callback.
- **`renderResult(result, options, theme, context)`** renders the final result
  and any streamed progress in the TUI, per the design doc's "Progress
  Streaming" format.

### 2. Budget flag + `/task-budget` command + schema locking

- `pi.registerFlag("task-budget", …)` accepting `free|economy|full|auto`.
- `pi.getFlag("task-budget")` gates the tool schema: when a concrete tier is
  locked, **remove the `budget` parameter from the tool's TypeBox schema** so
  the model cannot see or override it; when `auto`/unset, include it. Follow the
  design doc's "Budget Enforcement" sketch.
- `pi.registerCommand("task-budget", …)` for mid-session switching
  (`/task-budget free`, `/task-budget auto`, bare `/task-budget` to show the
  current mode). Reflect the state via `ctx.ui.setStatus("task", "<tier>
  (locked)")` so the user always sees the constraint.
- **Phase boundary (be explicit):** the design's Phases table lists
  "schema locking" under Phase 10, but the flag is only meaningful *with*
  locking, so implement **flag + command + schema locking together here**.
  Defer `task.toml` + the full tier→model resolution table to Phase 10. For
  Phase 9 model resolution, use a **small inline default budget table** (the
  design doc's `[budget.full/economy/free]` tiers) clearly marked as a
  **Phase-10 placeholder**. This keeps the `task` tool functional end-to-end now.

### 3. Extend `executeTask` for `subSpecs` (the structural spec-leak fix)

- `ExecuteTaskOptions` gains `subSpecs?: string[]`. When set, spawn one worker
  per sub-spec (`parallel = subSpecs.length`), each with its own sub-spec as the
  task prompt; **skip `splitSpec`**. Keep the existing `splitSpec` path for
  `spec` + `parallel`. Single-worker (`parallel <= 1`, no `subSpecs`) must stay
  byte-for-byte unchanged.

### 4. Main-session codebase-map injection (hybrid)

- **Always-on overview**: `pi.on("before_agent_start", …)` appends the map's
  global overview (entry points, patterns, test layout — ~300 tokens) to the
  main session's system prompt, gated by `config/repo-map.toml` `[injection]
  main_agent` and `overview_in_system_prompt` (both keys already exist). The map
  cache handles freshness on tree change. (The `before_agent_start` pattern is
  already used by `tools/prewalk.ts` — crib it.)
- **On-demand `codebase_map` tool**: `pi.registerTool("codebase_map", { query })`
  → returns the relevance-sliced file list (`sliceRelevant` + `formatMapPrompt`)
  for the query.

### 5. Tests

- `test-index.ts` (hermetic): pure parts of the tool wiring — e.g. the
  budget-schema-locking decision (locked tier ⇒ no `budget` param), the
  `sub_specs`-vs-`spec` precedence/parallel derivation, and the task-result →
  tool-return mapping. No worker spawns.
- `test-e2e.ts` **section 10**: the `task` tool end-to-end — a single-worker
  task via the tool returns a typed result, and (if cheap) a `sub_specs`
  parallel run shows isolated, non-duplicating workers. Model policy unchanged:
  only `opencode-go/deepseek-v4-flash`.

## Critical technical details (expensive to rediscover)

1. **Reuse, don't reinvent.** `executeTask` already does everything the tool
   needs (workers, prewalk, review, metrics). The tool is a thin adapter +
   schema + TUI. Do not re-implement orchestration.
2. **Verify the flag→schema-locking mechanism early.** Confirm a
   `pi.registerFlag` value read via `pi.getFlag` at registration time can gate
   the tool's TypeBox schema (this is the one genuinely unverified API behavior
   in this phase). Scratch-test it before building the tool around it.
3. **`sub_specs` precedence**: `sub_specs` wins; derive `parallel` from its
   length; do not run `splitSpec` when `sub_specs` is present. Keep each
   sub-spec fully isolated (own goal + requirements).
4. **Budget is a Phase-10 placeholder.** Use an inline default tier table for
   model resolution now; mark it clearly. Do **not** create `task.toml` here.
5. **Map injection is gated by config.** Respect `[injection] main_agent` /
   `overview_in_system_prompt`; degrade gracefully if the map is unavailable
   (same `try/catch → continue without it` pattern `executeTask` uses).
6. **`before_agent_start` for the overview**; `tools/prewalk.ts` is the working
   example of modifying the system prompt from that hook.
7. **TUI**: `onUpdate` streams progress without LLM tokens; `renderResult`
   renders it. Match the design doc's "Progress Streaming" example format.
8. **Typecheck** with the scratch-tsconfig recipe from the testing spec
   (`target: ES2022`). Keep the fast suite hermetic (<15s, zero LLM) and the
   e2e manual.
9. **Do not touch the live config** (`~/.pi/agent/extensions/`), do not push,
   do not move bookmarks.

## Worker system prompt for Phase 9

Unchanged — `DEFAULT_WORKER_SYSTEM_PROMPT` in `worker.ts`. The `task` tool does
not alter worker prompts.

## Acceptance criteria

Phase 9 is done when:

- The `task` tool runs a single-worker task end-to-end and returns the typed
  result (`success`, `commits`, `tests`, `files_changed`, `review`, `metrics`).
- `sub_specs` spawns one isolated worker per sub-spec with no cross-leakage
  (verified in e2e), and the mechanical `spec`+`parallel` fallback still works
  with the Scope contract.
- The `--task-budget` flag + `/task-budget` command work; a locked tier removes
  `budget` from the tool schema; the status bar reflects the lock.
- The main session gets the always-on map overview (when config-enabled) and a
  working `codebase_map` tool.
- Single-worker behavior is byte-for-byte unchanged (regression); the full fast
  suite passes (<15s, zero LLM); strict typecheck is clean.
- All code is in `/home/danong/.pi/pi-task-dev/extensions/task/`, committed with
  proper jj messages; the live config is untouched.

## Out of scope for Phase 9 (do NOT build)

- `task.toml` + the full budget-tier→model resolution table + the `auto`
  requirement-count heuristic (Phase 10). Use the inline placeholder table.
- Anything already delivered in Phases 1–8.
- Sandbox / bwrap worker isolation.
- Cross-worker communication or nested task dispatch.
- Metrics persistence beyond what Phase 8 already does.

## Workflow rules

- Load the jj skill before any jj/git work.
- Commit format: `jj commit -m "type(scope): summary\n\nBody.\n\n#PI"` (scope
  required; `#PI` marks agent commits). `jj commit` starts the next empty `@` —
  do **not** run `jj new` after it.
- **Do not push, do not move bookmarks** unless explicitly asked.
- Use `timeout` on anything that could hang (LLM tests, jj ops).
- Handle errors explicitly — no empty catch blocks, no commented-out code.
- Discussion-vs-action gate: if the user floats an idea or asks a question,
  discuss it; act only on direct imperatives.
- If you hit a genuine ambiguity that would change the design (e.g. how
  `sub_specs` interacts with `parallel`, or the budget placeholder shape), ask
  before improvising.

## Suggested order of work

1. Read the design doc sections + the extensions API; skim `orchestrator.ts`,
   `repo-map.ts`, `metrics.ts`.
2. **Scratch-test the flag→schema-locking mechanism** (register a flag, read it,
   gate a tool schema) before committing to the design.
3. Extend `executeTask` with `subSpecs` (smallest change; keep single-worker
   unchanged) + a hermetic test.
4. Build `index.ts`: the `task` tool (execute + renderResult), then budget
   flag + command + schema locking, then map injection (overview + `codebase_map`).
5. Write `test-index.ts` (hermetic); run the fast suite; typecheck.
6. Add e2e section 10; run the fast suite again. (Leave the real-LLM e2e run to
   the user unless told otherwise.)
7. Commit incrementally; leave clean logical commits.

## When done — report

- Files created/modified (paths).
- The `task` tool's final parameter/return schema and the budget-locking
  behavior.
- How `sub_specs` vs `spec`+`parallel` is resolved.
- e2e section 10 output (single-worker + any parallel run).
- Commit IDs (`jj log -r 'ancestors(@, 6)'`).
- Any deviations from this spec, and any blockers.
