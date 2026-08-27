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

### Run the v2 engine

The first v2 vertical slice is a shell adapter for one task and one worker.
It validates the markdown spec, starts the durable ledger, creates a temporary
jj workspace, integrates and verifies the result, streams compact progress, and
writes a durable receipt outside the checkout:

```sh
mise run v2 -- --spec ./task.md --project-dir . --model provider/model
```

`--model <provider/model>` is required unless `PI_TASK_V2_MODEL` contains a non-empty provider/model id; an explicit CLI value takes precedence. The placeholder above is not a product default. Use `mise run v2 --
--help` for all options, including explicit ledger and artifact locations.
Defaults use `XDG_STATE_HOME` (or the user state directory) keyed by the
project, so normal runs do not pollute the repository. The v2 adapter owns only
argument/input validation, progress rendering, and receipt delivery;
`daemon/isolated.ts`, the workspace driver, session host, environment driver,
and gateway remain the execution owners. Cancellation, multiple workers,
parallel scheduling, and remote interfaces are not part of this slice.

The repo ships `.pi/settings.json` registering itself as a project package
(`"packages": [".."]`), so any trusted checkout auto-installs — the `task`
tool, `/task-budget`, `/goals`, `/task-stats` and `/task-status` commands,
`--task-budget` flag, the
`delegation` and
`architecture-survey` skills, and the `/build`, `/plan`, and `/survey`
templates are available on the next session. For a
global (non-project) install instead:

```sh
pi install /path/to/this/repo
```

`pi install` adds the package to the pi agent dir's `settings.json` (`packages`)
and the `task` tool, `/task-budget`, `/goals`, `/task-stats` and `/task-status`
commands, and `--task-budget`
flag become available after `/reload`.

## Workflow

The user-facing model is a split between orchestration and execution: the
conversational agent plans and dispatches; isolated task workers execute
under real gates (bash verification, jj commits, atomic merge). An always-on
workflow contract (config-gated, default on) keeps the agent honest: plan
first, delegate multi-step work by default, stay orientation-only before a
spec, and write WHAT not HOW — and every dispatch references the session's
`/goals` (a change serving no stated goal is raised with the user, not
dispatched).

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

**See [`docs/old/workflow.md`](docs/old/workflow.md) for the historical workflow** — the
contract, the flow, template-by-template guidance, the run lifecycle, and the
quality loops. `/task-stats` summarizes recorded runs (latency, cost, verify
pass rate) from the agent-dir metrics — all projects, or one with an
argument. A task dispatch can also be **detached**: the `task` tool's
`detach: true` param returns a `run_id` immediately while the run executes
in a child process (`extensions/task/runner.ts`) with the same spec/options
and the same bounds (wall clock, verification gate, failure artifacts) —
`/task-status <run_id>` shows the run's live progress (phases, elapsed,
goals) or its final manifest summary (verify result, findings, cost).

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

## Batch lane

A shape whose `channel = "batch"` (the built-in `batch` shape) runs the
task as an ASYNC batch job instead of an interactive worker: the spec's
typed requirements become one single-turn prompt item each, submitted to
OpenRouter's batch endpoint on the `[batch]` model, polled to completion,
and validated against per-item output contracts (`extensions/task/batch.ts`
— the wire protocol is pinned in the `OpenRouterBatchProvider` doc
comment). Validated outputs are applied to the working copy as files,
committed under the AI identity, and gated by the spec's verification
commands. Batch is single-turn: no tool loop, no prewalk, no review.

Failures are typed (`BatchError` codes) and recoverable: every run records
a job-state file (`<metricsDir>/<project>/<run>.batch.json`) with the job
id + per-item statuses, so an aborted or timed-out job can be polled later
and failed items can be resubmitted alone — the failure artifact carries
the state-file path. Batch runs need `OPENROUTER_API_KEY` (a missing key
is the typed `no_api_key` failure).

## Testing

```sh
mise run test                                    # full hermetic suite, zero LLM calls
npx tsx extensions/task/test.ts                  # same suite, run directly
timeout 900 npx tsx extensions/task/test-e2e.ts  # one real-LLM e2e, manual
OPENROUTER_API_KEY=<key> timeout 2400 npx tsx extensions/task/test-batch-live.ts  # guarded real batch call
```

`mise run test` runs the full hermetic suite in one process (zero LLM calls);
`npx tsx extensions/task/test.ts` is the same suite as a direct command. The
real-LLM e2e (`extensions/task/test-e2e.ts`) stays manual and is intentionally
not part of `mise run test`, and so does the guarded real-OpenRouter batch
test (`extensions/task/test-batch-live.ts`, network + cost — skips with exit
0 when `OPENROUTER_API_KEY` is unset).

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
