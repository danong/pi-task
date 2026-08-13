# pi-task

A task-execution engine for the [pi coding agent](https://pi.dev): isolated
worker sessions, bwrap sandboxing, typed schema-validated yields, budget tiers,
and adversarial review. The user-facing experience is like other coding
harnesses: you chat, and the conversational agent decides whether to edit
directly or dispatch work to workers.

The engine is enforced by code rather than by the LLM: task completion and test
passes are gated by typed contracts and real bash exit codes; a strong model
plans, then the session swaps to a fast model on the first edit; parallel
workers run in isolated jj workspaces and are merged back with conflicts
surfaced. See `docs/pi-task-design.md` for the full design.

## Install

Requires jj (>= 0.43), node, python3 (config TOML is parsed via tomllib), and a
working `pi` install. Dev/test dependencies are provisioned through the repo's
`mise.toml`:

```sh
mise run setup     # npm ci, gated on file staleness — skipped when node_modules
                   # is newer than package.json/package-lock.json
mise run verify    # toolchain gate (tsx, pi deps, python3 tomllib,
                   # shipped-config drift)
mise run test      # full hermetic test suite, zero LLM calls
```

The repo ships `.pi/settings.json` registering itself as a project package
(`"packages": [".."]`), so any trusted checkout auto-installs — the `task`
tool, `/task-budget` command, `--task-budget` flag, the `delegation` skill,
and the `/build` spec and `/plan` work-plan templates are available on the
next session. For a
global (non-project) install instead:

```sh
pi install /path/to/this/repo
```

`pi install` adds the package to the pi agent dir's `settings.json` (`packages`)
and the `task` tool, `/task-budget` command, and `--task-budget` flag become
available after `/reload`.

## Workflow

The user-facing model is a split between orchestration and execution: the
conversational agent plans and dispatches; isolated task workers execute
under real gates (bash verification, jj commits, atomic merge). An always-on
workflow contract (config-gated, default on) keeps the agent honest: plan
first, delegate multi-step work by default, stay orientation-only before a
spec, and write WHAT not HOW.

Three user-invoked templates cover the flow — **`/plan`** (a multi-day work
plan: milestones, sequencing, dispatch order, open questions to settle
first), **`/build`** (a single task spec: Goal / Requirements / Verification),
and **`/survey`** (an architecture review: a named area or a hotspot scan,
producing a ranked report that is itself adversarially reviewed). The
`delegation` skill covers when to dispatch vs. edit directly; the
`architecture-survey` skill dispatches big-picture reviews as tasks. Large or
parallelizable work decomposes into parallel `sub_specs` (markdown strings or
{goal, requirements, verification, context?} objects; spec may be omitted
when sub_specs is given).

**See [`docs/workflow.md`](docs/workflow.md) for the full workflow** — the
contract, the flow, template-by-template guidance, the run lifecycle, and the
quality loops. `/task-stats` summarizes recorded runs (latency, cost, verify
pass rate) from the agent-dir metrics — all projects, or one with an
argument.

## Configuration

`task.toml` is the config surface: the loader (`loadTaskConfig()` in
`extensions/task/config.ts`) reads `<pi agent dir>/config/task.toml` (default
`~/.pi/agent`) — a missing file falls back to built-in defaults, so a fresh
install works without any config; the agent-dir copy is where per-machine
overrides belong. **Keep it minimal — only the keys you actually override.**
It is not auto-synced: a full mirror of the shipped file shadows every later
shipped change (a stale economy wall silently stayed at 25 min). With only
override keys present, missing sections fall back per-key to the built-in
defaults, so shipped/built-in changes propagate automatically. The sections it
can contain — see `config/task.toml` and
`extensions/task/config.ts` for the full surface, including but not limited
to:

- `[defaults]` — run-wide defaults: the effective budget mode for unlocked
  runs, the fix-loop iteration cap, the per-tool-call timeout, and the AI
  commit identity used for task-worker commits.
- `[budget.*]` — budget tiers: the models used for prewalk, execution, and
  review, plus a per-tier wall-clock budget. Tiers are dynamic: every
  `[budget.*]` section is a usable tier, in file order, so adding a tier needs
  no code change.
- `[sandbox]` — worker bwrap sandbox policy: enable/disable, network mode,
  and extra bind paths.

The shipped `config/task.toml` in this repo is the drift-guarded mirror of the
built-in defaults: a hermetic test fails if they diverge
(`testShippedConfigMatchesDefaults()` in `extensions/task/test-config.ts`,
exercised by `mise run verify` and `mise run test`). Your agent-dir copy may
legitimately diverge — that is where overrides belong. `config/repo-map.toml`
(agent dir) configures the cached codebase-map used to seed worker context,
falling back to built-in defaults when missing.

## Testing

```sh
mise run test                                    # full hermetic suite, zero LLM calls
npx tsx extensions/task/test.ts                  # same suite, run directly
timeout 900 npx tsx extensions/task/test-e2e.ts  # one real-LLM e2e, manual
```

`mise run test` runs the full hermetic suite in one process (zero LLM calls);
`npx tsx extensions/task/test.ts` is the same suite as a direct command. The
real-LLM e2e (`extensions/task/test-e2e.ts`) stays manual and is intentionally
not part of `mise run test`.

## Regression benchmarking

`extensions/task/bench-regression.ts` is a standalone canned-task regression
runner: it runs tiny deterministic specs (defined in `BENCH_SPECS` — see the
file header) against real pi + real LLM per budget tier (tiers come from
`task.toml`), then reports latency and cost against shipped per-spec-per-tier
baselines. Manifests land through the normal metrics write path
(`<agent-dir>/results/bench-<specId>/`) and are read back via `summarizeRuns`,
so `/task-stats` sees them too. Dry-run first (prints the plan, spawns nothing):

```sh
npx tsx extensions/task/bench-regression.ts --dry-run
npx tsx extensions/task/bench-regression.ts [--tier <name>]
```

Exit codes: 0 ok · 1 a run failed · 2 regressions vs. baselines (thresholds
and the baseline table live in `extensions/task/bench-regression.ts`).

## How it stays location-independent

The engine resolves the pi agent dir via `getAgentDir()` from
`@earendil-works/pi-coding-agent` (never from its own file path), so the package
works from any install location — local checkout, `~/.pi/agent/npm/`, or
`~/.pi/agent/git/`. Worker-side extension files (`tools/*.ts`) are loaded by
absolute path relative to the package, and the worker sandbox binds the agent
dir read-only (except pi's runtime-state paths) so workers never escape their
workspace.
