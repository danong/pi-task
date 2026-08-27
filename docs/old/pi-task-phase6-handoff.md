> **Archive status:** Historical and non-normative. See [`README.md`](README.md) for the active source of truth.

# pi-task — Phase 6 Handoff

You are implementing **Phase 6** of `pi-task`, a task-execution engine for pi.
This doc plus the design doc plus the existing code are everything you need.
Phases 1–5 are done and committed (see "Current state" below); read the code
before writing anything — the hard problems are already solved and the
patterns are established.

## Mission

Build **`workspace.ts`**: jj workspace isolation for parallel workers, wired
into the orchestrator. `executeTask({ parallel: N })` spawns N workers in N
isolated jj workspaces (each gets a fresh working-copy commit at the task
base), runs them concurrently, merges their commits into one result, and
cleans up. Safe parallelism: workers cannot collide on the working copy, and
merge conflicts are surfaced (not silently dropped).

Everything before this was single-worker. Parallel decomposition of a spec
into independent sub-tasks is the *conversational model's* job (Phase 9 task
tool); Phase 6 is the deterministic mechanics underneath.

## Current state (verified)

- All work lives in the **pi-task-dev workspace**: `$PI_TASK_WORKSPACE`
  (a jj workspace over the shared `~/.pi/agent` repo — shared commits + op
  log, own working copy). The live config `~/.pi/agent/extensions/` is
  **untouched**.
- Feature branch (off `main` at `72d625ce`, **not pushed**, `main` not advanced):
  ```
  28acca38 feat(task): phase 5 config — repo-map.toml, build modes, main-agent piping (phase 9)
  8c7922ae feat(task): phase 5 — repo-map context seeding
  5e50eaec feat(task): phase 4 — checklist tool with context-injection steering
  6adb602f feat(task): phase 3 — prewalk event-driven model swap
  7fdc74b3 feat(task): phase 2 — orchestrator with spec validation and verification gate
  c4ddb597 refactor(task): rename test-phase1 → test-worker-runner
  d1fedcab feat(task): phase 1 — worker runner with typed yield
  ```
- Files in `extensions/task/`: `worker.ts` (WorkerSession), `orchestrator.ts`
  (`executeTask`), `prewalk.ts`, `repo-map.ts`, `tools/{yield,checklist,prewalk}.ts`,
  `schemas/{yield,spec}.ts`, and `test-{worker-runner,orchestrator,prewalk,checklist,repo-map}.ts`.
  Plus `config/repo-map.toml` and `docs/pi-task-design.md` (updated through Phase 5).

## Required reading (in order)

1. **`docs/pi-task-design.md`** — Phase 6 row of the Implementation Strategy
   table; the **"Parallel workers"** block in *Worker Lifecycle* (the
   `jj workspace add` / `jj squash` / `jj workspace remove` flow); the
   orchestrator pseudocode steps 3 (create workspaces), 7 (merge), 9
   (cleanup); File Structure (`workspace.ts`).
2. **The Phase 1 handoff** — `docs/pi-task-phase1-handoff.md`. The worker
   infrastructure (RPC spawn, JSONL parsing, yield) is built and stabilized;
   skim it to understand the foundations, then read the code.
3. **Existing code** (read fully):
   - `extensions/task/worker.ts` — `spawnWorkerSession()` returns a
     `WorkerSession` (onEvent/sendCommand/setModel/result/abort); `runWorker`
     is a one-shot wrapper. Do not reinvent the JSONL parser or
     `getPiInvocation` (both exported).
   - `extensions/task/orchestrator.ts` — `executeTask()`: spec validation →
     repo-map injection → worker spawn (prewalk/checklist/map aware) →
     verification. Phase 6 adds the parallel branch here.
   - `extensions/task/test-orchestrator.ts` + `test-prewalk.ts` — the smoke
     test conventions (temp `jj git init --colocate` repos, timeouts, models).
4. **jj skill** — `$PI_AGENT_DIR/skills/jj/SKILL.md`, especially the
   **Workspaces** section. Load it before any jj work. You will live in
   workspace mechanics this phase.

## Step 0 — get oriented

```bash
cd $PI_TASK_WORKSPACE
jj st                     # should show an empty @ on top of 28acca38
```

- Put all new code under `$PI_TASK_WORKSPACE/extensions/task/`.
- Do **not** edit anything under `$PI_AGENT_DIR/extensions/`.
- The shell cwd does **not** persist across bash tool calls — prefix every
  bash command with `cd $PI_TASK_WORKSPACE && ...`.

## Deliverables

### 1. `workspace.ts` — runtime jj workspace isolation

```typescript
createWorkspace(projectDir: string, name: string): Promise<string>   // dir path
mergeWorkspace(projectDir: string, name: string, into: string): Promise<MergeOutcome>
removeWorkspace(projectDir: string, name: string): Promise<void>
```

- `createWorkspace`: `jj workspace add <dir> --name <name>` from `projectDir`.
  The workspace's working-copy commit starts at the task base — workers in it
  commit freely without touching the main working copy. Return the workspace
  directory (the worker's `cwd`).
- `mergeWorkspace`: `jj squash --from <name> --into <target>` (design uses
  `@-` = the task base commit). **Verify the exact `--from` syntax early** —
  whether jj accepts the workspace *name* as a revset, or you must resolve
  the workspace's working-copy commit id first (see Critical details).
- `removeWorkspace`: `jj workspace remove <name>` **after** a successful
  squash (the workspace @ must be empty first), then delete the directory.
- Conflict detection: after squash, check for conflicts (`jj resolve --list`
  or parse squash output). Return them in `MergeOutcome` — never throw away.

### 2. `orchestrator.ts` — the `parallel` branch

`ExecuteTaskOptions` gains `parallel?: number` (default 1 = current path
unchanged). When `parallel > 1`:

1. Validate spec + build/load the repo-map **once** on the main repo (before
   splitting; each worker gets the same sliced map in its task prompt).
2. Create N workspaces; spawn N `WorkerSession`s concurrently (each in its
   workspace cwd, each with the full extension set: checklist always, prewalk
   if configured). The worker `task` prompt includes a per-worker sub-task —
   the orchestrator must **split the spec** (requirements partitioned by
   index: worker i gets requirements `i % N == j`… decide and document) or
   accept a per-worker task string; the design doc leaves decomposition to the
   conversational model (Phase 9), so keep Phase 6's split simple and
   deterministic.
3. `await Promise.all` the yields. Stream progress via `onUpdate` (worker
   count done/running) — no LLM tokens.
4. Merge all workspaces into the task base (`@-`). Collect merged
   `commit_ids` and `files_changed` across workers.
5. Run verification **once, after merge**, on the main cwd (the merged tree
   is what ships).
6. Cleanup workspaces in a `finally`. On merge conflicts, return them in
   `TaskResult` (e.g. `conflicts: string[]`) instead of failing silently.

Single-worker behavior must be byte-for-byte unchanged (regression tests).

### 3. `test-workspace.ts` — smoke test

- **Mechanics (free, no LLM):** create two workspaces, make a file + commit
  in each, squash both into the base, assert both files landed, workspaces
  removed cleanly, no leftover tracked files. This is where you verify the
  `--from <name>` syntax and conflict behavior deterministically.
- **Conflict case (free):** two workspaces edit the same file differently →
  squash → assert a conflict is detected and surfaced.
- **Parallel integration (2 LLM workers):** one temp repo, `executeTask({
  parallel: 2 })` with a spec partitioned into two independent sub-tasks
  (e.g. worker A creates `a.txt`, worker B creates `b.txt`). Assert: both
  files in the result, both `commit_ids` present, verification passes, and
  `usage` stats exist for both workers. Timeout generously (two real workers).
- Cost note: this is the only real-LLM part of the phase.

## Critical technical details (expensive to rediscover)

1. **Worker infrastructure is done — reuse it.** `spawnWorkerSession` from
   `worker.ts` (JSONL parser, `getPiInvocation`, usage collection, abort,
   yield capture, temp system-prompt file) handles everything per-worker.
   Phase 6 is *orchestration around* sessions, not new session code.
2. **`yield.files_changed` is repo-relative** (the yield tool normalizes
   absolute paths). Worker yields from workspaces report paths relative to
   *their* cwd — which is the workspace dir, so merged `files_changed` will
   look the same as single-worker. Don't re-normalize.
3. **jj workspace mechanics to verify empirically, early:**
   - `jj workspace add <dir> --name <name>` inside a colocated test repo —
     confirm it works with `--colocate` (jj feature, should be independent of
     git colocation, but verify).
   - `jj squash --from <name> --into @-` — does jj accept the workspace name
     as a revset, or must you resolve `jj workspace list` / the workspace's
     commit id first? Test this in a scratch repo before building on it.
   - Squash empties the workspace @ → only then `jj workspace remove`.
   - Stale-workspace hazard: if a merge rewrites history, other workspaces go
     stale → `jj workspace update-stale` (see jj skill).
4. **Extension surface per worker** is unchanged: checklist always,
   prewalk only when `prewalkModel !== executeModel`. Prewalk swap + checklist
   steering work identically in each worker's session.
5. **The repo-map** must be built on the **main repo before workspace
   creation** (its tree hash = the task base). Do not let each worker build
   its own map in its workspace — that's N duplicate annotation calls. Slice
   once, inject the same slice into every worker's task prompt.
6. **TypeBox tools use the flat schema pattern** (`StringEnum` + optional
   fields, like `checklist`/`yield`). Discriminated unions of `Type.Object`
   get rejected by providers with a 400 — do not introduce one in any new
   worker tool.
7. **Test conventions:** temp repos via `jj git init --colocate` + starter
   commit; run every test with `timeout` (they drive real LLMs and can hang);
   models: `opencode-go/deepseek-v4-flash` (execute/worker), `qwen-token-plan/
   qwen3.8-max-preview` (prewalk). **Every real-LLM test costs money** — keep
   the free deterministic sections separate from the few integration runs, and
   avoid gratuitous re-runs. `repo-map` skeleton mode and all pure functions
   are free; follow that split.
8. **Prewalk swap trigger = the first edit tool.** Workers that create files
   via bash (`echo > file`) never fire the swap. Existing tests use
   *edit-existing-content* tasks for swap-sensitive tests. Same applies to any
   parallel prewalk test.
9. **Commit format + workflow:** load the jj skill first; `jj commit -m
   "type(scope): summary\n\nBody.\n\n#PI"` (scope required, `#PI` marks agent
   commits); `jj commit` starts the next empty `@` — do not `jj new` after.
   **Do not push, do not move bookmarks** unless explicitly asked.

## Worker system prompt for Phase 6

Unchanged — the canonical default lives in `worker.ts`:
`DEFAULT_WORKER_SYSTEM_PROMPT` (includes checklist guidance). Do not add a
parallel-specific prompt; workers don't know they're parallel.

## Acceptance criteria

Phase 6 is done when:

- `workspace.ts` creates/merges/removes jj workspaces, with conflicts surfaced
  (not dropped).
- `executeTask({ parallel: 2 })` spawns two workers in isolated workspaces,
  runs them concurrently, merges both commits into one result, verifies the
  merged tree, and cleans up — single-worker behavior unchanged (all existing
  tests pass).
- The mechanics + conflict tests are deterministic and free (no LLM).
- The parallel smoke test passes against two real workers.
- All code in `$PI_TASK_WORKSPACE/extensions/task/`, committed with
  proper jj messages. Live config untouched.

## Out of scope for Phase 6 (do NOT build)

- forked review / reviewer personas / bounded fix loop (Phase 7)
- metrics persistence to `results/` (Phase 8) — collecting in-memory usage in
  `WorkerResult` is done
- the `task` tool / `index.ts` / budget flag / TUI / spec-decomposition
  heuristics for parallel (Phase 9)
- `task.toml` / budget resolution / schema locking (Phase 10)
- sandbox / bwrap; cross-worker communication; nested dispatch

## Workflow rules

- Load the jj skill before any jj/git work.
- Discussion-vs-action gate: if the user floats an idea or asks a question,
  discuss it — act only on direct imperatives.
- If you hit a genuine ambiguity that would change the design (e.g. how to
  split the spec across parallel workers, or the merge-target semantics), ask
  before improvising.
- Use `timeout` on anything that could hang (LLM tests, jj ops on big repos).
- Handle errors explicitly — no empty catch blocks, no commented-out code.

## Suggested order of work

1. Read the design doc's parallel sections + the jj skill's workspace section;
   skim `worker.ts` and `orchestrator.ts`.
2. **Scratch-test jj workspace mechanics first** (create two workspaces in a
   temp repo, commit in each, squash, remove) — resolve the `--from <name>`
   syntax and conflict behavior before writing any extension code.
3. Write `workspace.ts`; test the mechanics with a free test file.
4. Add the `parallel` branch to `orchestrator.ts` (single-worker path
   untouched).
5. Write `test-workspace.ts`; run mechanics + conflict (free), then the
   2-worker integration; iterate.
6. Run the full regression suite (all five existing test files).
7. Commit incrementally; leave clean logical commits.

## When done — report

- Files created (paths).
- Smoke test output (the parallel `TaskResult` — both workers' commits/files).
- Commit IDs (`jj log -r 'ancestors(@, 5)'`).
- Any deviations from this spec, and any blockers.
