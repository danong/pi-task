# pi-task

A task-execution engine for the [pi coding agent](https://pi.dev): isolated
worker sessions, typed schema-validated results, durable evidence, and
context-efficient execution. The user-facing experience is like other coding
harnesses: you chat, and the conversational agent decides whether to edit
directly or dispatch work to workers.

The repository contains the production v1 engine and the v2 bootstrap path.
V1 includes prewalk model swapping, sandboxing, review, and parallel jj
workspaces; its compatibility contract is `docs/pi-task-design.md`. V2 treats
model swapping as one optional execution policy inside a broader context
lifecycle built from acquisition providers, explicit context plans, cache-aware
prompt segments, working checkpoints, and accepted-artifact evidence. Its
active contract is `docs/pi-task-v2.md`.

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

### v2 status: M1–M3 foundation and M4 context control plane

M1–M3 are the completed evidence-backed MVP foundation. M1 provides a
versioned, bounded, provider-neutral trace artifact with lifecycle, observed
turns, tool activity, verification, delivery, and failure events. Usage is
explicitly marked `measured` or `unavailable`; zero-valued usage is not a
performance measurement when the status is unavailable. Versioned baseline
trace fixtures live with the core-v2 test evidence. They are evidence inputs
for exercising derivation and reporting, not performance claims or model
defaults.

M2 adds the required `## Artifact Policy` section to CLI specs. The strict
ingress parser accepts repository-relative required files and an explicit
change mode, then post-integration mechanical acceptance checks declared
artifacts, changed paths, engine-derived jj identity, and verification. VCS
finalization is engine-owned rather than a model claim. Typed rejection and
recovery evidence, including receipt/trace delivery failures, makes a result
non-ship when delivery or acceptance fails. This gate cannot prove user intent
beyond declared artifacts and verification.

M3 adds requirement-sensitive checklist use (only multi-requirement tasks need
it), a one-shot typed `yield` containing `files_changed`, `summary`, and
`deviations`, and engine-owned VCS finalization and verification. Real-model
efficiency improvement has not yet been measured; the grounding harness and
trace reports provide measurement infrastructure, not a result claim.

A minimal spec policy is:

```markdown
## Artifact Policy

- Required: reports/result.json
- Change required
```

For a verified no-diff task, use `- Intentional no-change` instead. Paths must
be repository-relative and the CLI rejects missing, contradictory, duplicate,
unsafe, or unrecognized policy entries. The current runnable command is:

```sh
mise run v2 -- --spec ./task.md --project-dir . --model provider/model
```

The model value is a placeholder, not a product default; use an explicit model
or `PI_TASK_V2_MODEL`. The CLI returns the receipt and trace artifact paths.
The default user-state artifact directory contains `<run-id>.trace.json`, the
receipt, and failure/recovery evidence without requiring repository-local
state. Explain one run or aggregate validated traces with:

```sh
mise run trace-report -- <trace.json> [report.md]
mise run bench-report -- --traces-dir <trace-directory> --label <label>
```

The CLI announces the run identity before execution and names durable receipt,
trace, and failure artifacts at termination. Verification events contain
bounded command identities, exit/timeout status, and measured durations without
command text or output. Terminal failures carry a provider-neutral stage and
code. The single-run report makes those facts, context/cache evidence, tool
activity, and sibling artifacts directly inspectable.

The aggregate report derives accepted outcome, cost when measured, turns, tool calls,
repeated reads, context, elapsed time, verification/acceptance failures, and
unavailable metrics from validated traces. M3's grounding comparison is a
separate dry-by-default command:

```sh
mise run eval-grounding
mise run eval-grounding -- --run
```

The first command makes no LLM calls; real runs require the configured model
and network. Evidence is written under the selected metrics directory in
`eval-grounding/records.jsonl` and `eval-grounding/summary.md`.

M4's context control plane is implementation-complete under hermetic gates.
The kernel owns deterministic plans, immutable user-state artifacts,
economic/window/attention budgets, cache-oriented prompt assembly, bounded
checkpoints, and per-worker execution epochs. Planned cache strategy is kept
separate from measured provider cache usage, and unchanged snapshots remain
cache-affine across attempt identities.

The v2 CLI still selects `raw` (default) or the experimental `symbol-tree` with
`--context`. Symbol-tree supplies bounded progressive-disclosure handles and
the bounded `context` tool; raw is a standalone empty plan that does not load
the index. Provider or local-store failure degrades explicitly, and no context
state is written into the repository. `mise run context-eval` remains a zero-
model dry plan; `mise run context-report -- <jsonl>` reports canonical evidence
including artifact/epoch activity and actual cache reads when available.

Kernel/session/tool code now consumes explicit acquisition/materialization
capabilities; legacy provider translation is confined to the CLI/provider edge.
A minimal matched Luna smoke is retained under the core-v2 M4 proof fixtures
and validated with `mise run m4-proof -- <evidence.json> [report.md]`. It records
measured accepted runs without claiming a general quality or cost advantage or
adopting symbol-tree as the default. The first useful implementation dogfood
failure is retained under `packages/core-v2/test/fixtures/dogfood/`; it exposed
that the CLI prompt wall was not paired with an independent turn bound.
Continued dogfood therefore requires the supported turn and wall-time bounds;
measured final cost remains reporting-only until provider-neutral live cost
signals exist. M5 will use the checkpoint/epoch contracts for
typed sequential children and a usable v2 self-hosting loop. M6 scope remains
intentionally open.

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
