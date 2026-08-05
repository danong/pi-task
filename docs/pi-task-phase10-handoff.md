# pi-task — Phase 10 Handoff

You are implementing **Phase 10** of `pi-task`, the task-execution engine for
pi. Phases 1–9 are complete and committed (see "Current state" below). This
phase is the final one: **`config/task.toml` + real budget resolution**
(replacing the Phase-9 placeholder tier table), the **`auto` heuristic**,
manifest budget labels — and the **retirement of the tooling pi-task
replaces**, so the branch deploys as a clean migration to the live config.
Read the code before writing anything — the mechanics are all built; this
phase is config, resolution wiring, and cleanup.

## Mission

1. **`config/task.toml` + loader** — the design doc's budget config file
   (`[defaults]` + `[budget.full/economy/free]`), loaded with
   deny-nothing defaults: missing file or keys → built-in defaults; invalid
   values → warn + per-field fallback. No availability probing, no runtime
   tier downgrade (decision 4a from planning).
2. **Real budget resolution** — replace the Phase-9 placeholder
   (`DEFAULT_BUDGET_TIERS` as the source of truth) with the config-driven
   table: locked flag > locked param > mode chain; the `auto` mode resolves
   via the **requirement-count heuristic** (≤5 → economy, ≥6 → full; free is
   never auto-selected). Wire `max_fix_iterations` from `[defaults]` and the
   resolved tier label into the `RunManifest`.
3. **Retirement commit (clean migration)** — remove what the design doc's
   "Relationship to Existing Tooling" table marks as replaced: the
   `subagent` extension, the `spec-build-chain` skill + `/spec-build`
   prompt, the `agents/*.md` personas, `models.md`, and the `review` skill
   (see the deliverable for why), plus all stale references to them.
   Rollback = reverting one commit.
4. **Docs** — design doc Phase-10 implementation notes + file-structure /
   testing updates; README rewrite for the new layout.

**Deployment is NOT part of the build.** The deploy runbook below is
executed **only on explicit user instruction** after acceptance. Do not
touch the live config (`~/.pi/agent/extensions/` etc.), do not advance
`main`, do not push.

## Decisions from planning (user-approved — do not relitigate)

- **Concurrency experiment ignored.** Commit `mmvouznx` (concurrent e2e)
  stays unmerged and is ignored. The **sequential** e2e is the acceptance
  gate; do not port its changes.
- **Auto heuristic thresholds**: ≤5 requirements → `economy`, ≥6 → `full`.
  Never `free`. Thresholds are deliberately simple; fine-tuning is future
  work.
- **Default budget**: `[defaults] budget = "full"` — stick to the design.
- **Degradation policy (4a)**: validation at config load only (invalid
  value → warn + default). Runtime model failures surface as tool errors
  the model reports; no availability probing, no auto-downgrade.
- **Deploy mechanics**: advance `main`, update the default workspace's
  working copy, **keep** the pi-task-dev workspace for soak. Manual only.
- **Retirement**: remove the replaced tooling in one commit for a clean
  migration; rollback via jj if needed.
- **Acceptance bar**: fast suite green + full sequential e2e green + one
  live-config smoke run in a scratch repo (single task + sub_specs +
  budget lock + codebase_map).
- **Deferred**: context-window compatibility check (inert for current ~1M
  tiers), sandbox/bwrap.

## Current state (verified)

- All work lives in the **pi-task-dev workspace**: `/home/danong/.pi/pi-task-dev`
  (a jj workspace over the shared `~/.pi/agent` repo). The live config is
  **untouched**. `@` is the empty "phase 10" commit; the shell cwd does not
  persist across bash calls — prefix commands with `cd /home/danong/.pi/pi-task-dev &&`.
- **Feature branch**: `main` is at `72d625ce` (change `xmmwmprqvyuz`,
  "docs(pi-task): add phase 1 handoff doc"), **not advanced, not pushed**.
  Newest → oldest since `main` (verify with
  `jj log -r 'main..@-' --no-graph -T 'commit_id.short() ++ " " ++ description.first_line()'`):

  ```
  c1a429f8 refactor(task): drop unused AgentToolResult import
  6c5c219e test(task): phase 9 e2e section 10 — task tool end-to-end
  6b82caf3 feat(task): phase 9 — task tool, budget enforcement, sub_specs, main-agent map injection
  9e2b3a79 docs(pi-task): add phase 9 handoff doc
  51723151 fix(task): parallel sub-task Scope contract — stop workers over-creating
  355aca7c test(task): phase 8 e2e — RunManifest metrics section + docs
  c743c663 feat(task): phase 8 orchestrator metrics wiring — manifest per run
  96fd2250 feat(task): phase 8 manifest + session-trace storage
  8c169e95 feat(task): phase 8 phase-split + read-duplication metrics (pure)
  24a86db4 feat(task): phase 8 worker read tracking + per-turn usage snapshots
  dd4a67d2 feat(task): phase 8 RunManifest types + pure buildRunManifest
  … (phases 1–7; see the jj log command above)
  ```

- **Test state**: fast suite green (`timeout 120 npx tsx extensions/task/test.ts`,
  ~1s, zero LLM). The sequential real-LLM e2e (`timeout 900 npx tsx
  extensions/task/test-e2e.ts`) passed at Phase 9 completion.
- **Phase-10 hooks already planted** (grep for `PHASE-10 PLACEHOLDER`):
  `index.ts` → `DEFAULT_BUDGET_TIERS` + `DEFAULT_BUDGET_TIER`;
  `metrics.ts` → `config.budget` `"default"` placeholder;
  `orchestrator.ts` → the `review` option comment.

## Required reading (in order)

1. **`docs/pi-task-design.md`** — "Budget Enforcement" (+ its Phase-9
   implementation notes), "Budget Tiers" (the task.toml shape), "The `task`
   Tool", the **Phases table** (row 10), and "Relationship to Existing
   Tooling" (the retirement table).
2. **`docs/pi-task-phase9-handoff.md`** — the conventions + everything
   Phase 9 built and verified (schema-locking timing, sub_specs precedence,
   flag mechanics).
3. **`docs/pi-task-testing-spec.md`** — fast/e2e contract + the strict
   typecheck recipe (scratch tsconfig, `target: ES2022`).
4. **The code**: `extensions/task/index.ts` (budget state, tool wiring),
   `extensions/task/repo-map.ts` (`loadRepoMapConfig` — the loader pattern
   to crib), `extensions/task/orchestrator.ts` (`ExecuteTaskOptions`,
   `TaskResult`), `extensions/task/metrics.ts` (`buildRunManifest` input
   `config.budget`), `extensions/task/schemas/spec.ts` (`parseSpec`).
5. **jj skill** — `/home/danong/.pi/agent/skills/jj/SKILL.md`. Load before
   any jj work.

## Deliverables

All under `/home/danong/.pi/pi-task-dev/` unless stated.

### 1. `config/task.toml` + `extensions/task/config.ts` (loader)

**The file** (tracked; `.gitignore` already un-ignores `config/`): mirror
the design doc's "Budget Tiers" example exactly — same models as the
Phase-9 `DEFAULT_BUDGET_TIERS` table (so deployed behavior is byte-for-byte
unchanged for every tier):

```toml
[defaults]
budget = "full"            # "full" | "economy" | "free" | "auto"
max_fix_iterations = 2

[budget.full]    # strong prewalk + review, fast execute
[budget.economy] # fast model throughout (prewalk auto-skips), review on
[budget.free]    # fast model, review off
```

Each `[budget.*]` section: `prewalk_model` (string; for `free` use the
execute model — the loader maps "prewalk == execute" through the existing
auto-skip, but keep the TOML honest: free sets `prewalk_model` =
`execute_model` and `review = false`), `execute_model`, `review_model`,
`review` (bool). Comment the file like `config/repo-map.toml`: what each
key does, that `budget = "auto"` makes the requirement-count heuristic the
everyday default, and that the loader falls back to built-in defaults on
missing/invalid values.

**The loader** (`config.ts`): crib `loadRepoMapConfig` (repo-map.ts) —
same path resolution (`<agent-dir>/config/task.toml` via `import.meta.url`,
works in the dev workspace and installed), same hand-rolled TOML parsing,
same defaults discipline. Exports:

- `TaskConfig` — `{ defaults: { budget: BudgetMode; maxFixIterations: number }; tiers: Record<BudgetTier, BudgetTierConfig> }` (reuse the existing `BudgetTierConfig` shape from index.ts; move it to config.ts if that avoids a cycle — keep index.ts re-exporting it).
- `DEFAULT_TASK_CONFIG` — built-in fallback. Its `tiers` are exactly the
  current `DEFAULT_BUDGET_TIERS` values; `defaults = { budget: "full", maxFixIterations: 2 }`.
- `loadTaskConfig(configPath?)` — missing/unreadable file → `DEFAULT_TASK_CONFIG`;
  invalid values → `console.warn` with the key name + per-field fallback
  (invalid `[defaults] budget` → `"full"`; invalid `max_fix_iterations`
  (non-integer or < 0) → `2`; unknown `[budget.<name>]` section → warn +
  ignore; missing tier key → built-in tier default). Never throws.

### 2. Budget resolution in `index.ts` — config-driven tiers + auto heuristic

Replace the placeholder wiring (`resolveBudgetTier` + direct
`DEFAULT_BUDGET_TIERS` lookup) with the config-driven chain. Keep it pure
and hermetically tested; the resolution must stay throw-free (an invalid
spec must still surface as `executeTask`'s SpecError tool-error, not a
resolution crash):

```
mode := locked flag ? flag
      : locked param ? param
      : normalize(flag ?? param ?? config.defaults.budget)     // BudgetMode; "auto" possible
tier := locked mode ? mode : autoTier(requirementCount)        // mode === "auto"
autoTier(n): n === null → "full" | n <= 5 → "economy" | n >= 6 → "full"
```

Notes:

- **Requirement counting is lenient.** New exported pure helpers:
  `countSpecRequirements(spec): number | null` (parseSpec in a try/catch →
  null on failure) and the sub_specs variant (sum across sub-specs,
  skipping unparseable ones; all unparseable → null). `autoTier` consumes
  the count. Count from `sub_specs` when present, else `spec`.
- **`[defaults] budget` may be `"auto"`** — that makes the heuristic the
  everyday default for users who edit the file. Shipped default stays
  `"full"` (the design).
- Phase-9 semantics preserved: locked flag beats locked param; a locked
  flag still removes `budget` from the schema; `/task-budget`, the status
  bar, session-entry persistence, and the session_start re-registration
  mechanics are **unchanged**.
- `execute()` passes the resolved tier's config values exactly as today
  (`prewalkModel`/`executeModel`/`reviewModel`/`review`) **plus**:
  `maxFixIterations: config.defaults.maxFixIterations` and
  `budget: tier` (the label — see §3).
- Keep `DEFAULT_BUDGET_TIERS` as the built-in fallback table (it feeds
  `DEFAULT_TASK_CONFIG`); retire the "PHASE-10 PLACEHOLDER" comments.

### 3. Budget label in the manifest

`ExecuteTaskOptions` gains `budget?: string` — a manifest label only; the
orchestrator does not interpret it. It flows into
`buildRunManifest`'s `config.budget` (metrics.ts already accepts it and
falls back to `"default"` — that fallback stays for direct `executeTask`
callers). The task tool always supplies the resolved tier name, so
persisted manifests carry `config.budget ∈ {full, economy, free}`.

### 4. Retirement commit — the clean migration

Remove, in **one commit** (rollback story: revert that commit):

```
agents/planner.md  agents/reviewer.md  agents/scout.md  agents/worker.md
models.md
skills/spec-build-chain/          (entire dir)
skills/review/                    (entire dir — see note)
prompts/spec-build.md             (the /spec-build template that drives the skill)
extensions/subagent/              (entire dir: index.ts, agents.ts)
```

**Why `skills/review` is included**: it dispatches `agent: "reviewer"` via
the `subagent` tool — both dependencies are retired in this same commit, so
the skill would be dead weight. pi-task's forked adversarial review covers
in-task review; an interactive review skill can return later built on the
`task` tool. If you discover another consumer of the review skill, flag it
in the report instead of improvising.

**Reference cleanup in the same commit** (docs must not dangle):

- `README.md` — rewrite the layout description (the `agents/` /
  `models.md` bullets become `extensions/task/` + `config/`).
- `extensions/todo-widget.ts` (~line 764) — its tool description says
  "Delegate this to a subagent using the fast model from
  ~/.pi/agent/models.md"; repoint at the `task` tool.
- Comment-only fixes for stale provenance: `extensions/memory-store.ts`
  ("Copy of subagent/index.ts getPiInvocation"), `extensions/task/worker.ts`
  ("Cribbed from subagent/index.ts"), `extensions/task/tools/checklist.ts`
  ("Matches the subagent/yield pattern").
- **Verify**: after the commit, `rg 'models\.md|spec-build|subagent'` over
  tracked files must find nothing but historical mentions in `docs/` and
  `memory.json` (data, not code). No broken references.
- `docs/pi-task-design.md` — append "(retired Phase 10)" notes to the
  Relationship-to-Existing-Tooling table rows.

Do **not** touch `settings.json` (the `extensions/` auto-load picks up
`task/`; `memory-store` stays excluded by its existing pattern), `.pi/`,
`memory.json`, or the skills `jj` / `memory`.

### 5. Design-doc + docs updates (before the final commit)

- "Budget Enforcement" → **Implementation notes (Phase 10)**: what
  replaced what (config file + loader, resolution chain, heuristic
  thresholds, label wiring), and the explicit non-goals (no availability
  probing, no runtime downgrade; context-window check deferred).
- "File Structure" → add the `config.ts` row and `config/task.toml`.
- "Testing" section → `test-config.ts` in the "which behavior lives where"
  list. Phases table row 10 marked done.

### 6. Tests

- **`test-config.ts`** (new, hermetic; wire into `test.ts`): defaults when
  the file is missing; a valid temp-file parse (all tiers + defaults);
  invalid `[defaults] budget` → warn + `"full"`; invalid
  `max_fix_iterations` → warn + 2; unknown tier section → warn + ignored;
  partial tier section → per-key fallback.
- **`test-index.ts`** extensions: `autoTier` thresholds (5 → economy, 6 →
  full, null → full); the full resolution chain (locked flag > locked param
  > config default, including `defaults.budget = "auto"` → heuristic);
  `countSpecRequirements` / sub-spec counting (valid, invalid → null,
  summed); the budget label passed to executeTask (assert via the mapping,
  not by spawning).
- **`test-metrics.ts`**: manifest carries an explicit budget label
  (the `"default"` fallback test stays).
- **`test-e2e.ts` section 8** (sequential suite): assert
  `single.details.metrics.config.budget === "free"` on the single-worker
  run. With `config/task.toml` now in the dev workspace, section 8
  exercises the real loader path (the extension's AGENT_DIR is the
  workspace root). Model policy unchanged — the only e2e model stays
  `opencode-go/deepseek-v4-flash`; the shipped `free` tier uses exactly
  that model.

## Critical technical details (expensive to rediscover)

1. **Loader pattern**: `loadRepoMapConfig` (repo-map.ts) is the working
   example — path via `dirname×3(import.meta.url) + config/<file>.toml`,
   hand-rolled section/key parser, `{ ...DEFAULT }` on missing/unreadable.
2. **Resolution must stay throw-free**: spec counting errors never surface
   from resolution; `executeTask` owns SpecError reporting (the tool's
   error-retry UX).
3. **Byte-for-byte single-worker regression**: the shipped `task.toml`
   tiers equal the Phase-9 placeholder values, so resolved models/review
   flags are unchanged for every tier. Fast suite + sequential e2e prove
   it.
4. **Schema-locking mechanics are untouched** — registered at
   session_start, re-registered on `/task-budget` (Phase-9 verified
   behavior; see the design doc's implementation notes).
5. **`config.budget` label**: metrics.ts already has the input field and
   the `"default"` fallback; only the orchestrator pass-through (`opts.budget`)
   and the tool's value are new.
6. **Retirement is deletions + reference fixes only** — no behavior
   changes in surviving files except the todo-widget description string.
7. **Typecheck** with the scratch-tsconfig recipe from the testing spec
   (`target: ES2022`). Fast suite stays <15s, zero LLM.
8. **Do not touch the live config**, do not push, do not move bookmarks,
   do not run the concurrent e2e variant.

## Deployment runbook — MANUAL, only on explicit user instruction

For reference during the build; executing it is out of scope for the
automated work.

1. Acceptance must be green (below), in the pi-task-dev workspace.
2. Load the jj skill. From pi-task-dev, after the final commit:
   `jj bookmark move main --to @-`.
3. Deploy into the live config: `cd ~/.pi/agent && jj workspace update`
   (the default workspace's working copy follows `main`). If jj reports
   "working copy is stale": `jj workspace update-stale` — never force
   (Phase-9 incident note).
4. Verify: `jj st` clean in both workspaces; `~/.pi/agent/extensions/task/`
   and `~/.pi/agent/config/task.toml` exist; `agents/`, `models.md`,
   `skills/spec-build-chain/`, `skills/review/`, `prompts/spec-build.md`,
   `extensions/subagent/` are gone.
5. **Live smoke test** in a scratch repo (cheap: lock `--task-budget free`):
   ```bash
   d=$(mktemp -d) && cd "$d" && jj git init && echo "# smoke" > README.md && jj commit -m init --no-edit
   timeout 300 pi --mode json --task-budget free -p '<prompt: call the task tool to create hello.txt containing "hi", commit it; verification: test -f hello.txt && grep -q hi hello.txt>'
   # assert: typed task result (success, commits, files_changed) in the JSON stream
   timeout 300 pi --mode json --task-budget free -p '<prompt: call the task tool with two sub_specs creating a.txt and b.txt>'
   # assert: success, both files, no duplicates, no conflicts
   timeout 300 pi --mode json -p '<prompt: call codebase_map with query "entry points">'
   # assert: map overview/files returned (one-time annotation call, cheap model)
   ls ~/.pi/agent/results/*/   # manifest persisted for the single-worker run
   ```
6. Keep the pi-task-dev workspace for the soak period (no `jj workspace
   forget`). Rollback options: full — move `main` back to `72d625ce` and
   re-update the default workspace; retirement-only — revert the cleanup
   commit.

## Acceptance criteria

Phase 10 is done when:

- `config/task.toml` exists with the design's tier shape; `loadTaskConfig`
  returns defaults on missing file, warns + falls back on invalid values
  (hermetically tested).
- Budget resolution is config-driven with the auto heuristic (≤5 economy,
  ≥6 full, null → full); locked-flag > locked-param > config-default
  precedence tested; schema locking / `/task-budget` / status bar behavior
  unchanged.
- `max_fix_iterations` comes from `[defaults]`; manifests carry the
  resolved tier as `config.budget` (e2e asserts `"free"` on the locked run).
- The retirement commit removes the replaced tooling with no dangling
  references (verified by grep); surviving behavior unchanged.
- Single-worker behavior is byte-for-byte unchanged: full fast suite green
  (<15s, zero LLM); the **sequential** e2e fully green; strict typecheck
  clean.
- Design doc carries the Phase-10 implementation notes; README describes
  the new layout. Everything committed in logical jj commits; live config
  untouched; `main` unmoved; nothing pushed.

## Out of scope for Phase 10 (do NOT build)

- Deployment itself (manual runbook above; explicit user instruction only).
- Sandbox / bwrap worker isolation.
- The context-window compatibility check (deferred; inert for current tiers).
- Concurrent e2e (commit `mmvouznx` — ignored, unmerged, do not port).
- Heuristic fine-tuning beyond the approved thresholds.
- A replacement interactive review skill (future work on the `task` tool).
- Cross-worker communication, nested task dispatch, metrics beyond the
  budget label.

## Workflow rules

- Load the jj skill before any jj/git work.
- Commit format: `jj commit -m "type(scope): summary\n\nBody.\n\n#PI"`
  (scope required; `#PI` marks agent commits). `jj commit` starts the next
  empty `@` — do not run `jj new` after it.
- Do not push, do not move bookmarks, do not touch the live config.
- Use `timeout` on anything that could hang (LLM tests, jj ops).
- Handle errors explicitly — no empty catch blocks, no commented-out code.
- Discussion-vs-action gate: discuss ideas; act only on direct imperatives.
- Genuine ambiguity that would change the design → ask before improvising.

## Suggested order of work

1. Read the design doc sections + `index.ts` + the repo-map loader.
2. `config.ts` loader + `config/task.toml` + `test-config.ts`; run the
   fast suite.
3. Resolution rewire in `index.ts` (auto heuristic + lenient counting +
   config-driven tiers) + `test-index.ts` extensions; run the fast suite.
4. Orchestrator/metrics budget-label pass-through + `test-metrics.ts`
   addition; run the fast suite.
5. Typecheck; e2e section-8 assertion; run the full sequential e2e.
6. Docs (design doc Phase-10 notes, README, File Structure/Testing).
7. The retirement commit + reference cleanup + grep verification; run the
   fast suite + typecheck again.
8. Final acceptance: fast suite + sequential e2e. Report.

## When done — report

- Files created/modified/removed (paths).
- The resolution chain as implemented + the shipped `task.toml` contents.
- What was retired and the grep-verification result.
- Fast-suite + sequential-e2e results; typecheck status.
- Commit IDs (`jj log -r 'main..@-' --no-graph -T 'commit_id.short() ++ " " ++ description.first_line()'`).
- Any deviations from this spec, and any blockers.
