> **Archive status:** Historical and non-normative. See [`README.md`](README.md) for the active source of truth.

# Task dispatch vs. direct editing: what the data says

A decision aid for the conversational agent (and the human watching it):
when does dispatching to an isolated `task` worker pay, and when is editing
in the main session cheaper? The live source for everything here is
`/task-stats` in a pi session (all projects, or `/task-stats <project>` for
one); the numbers below are a point-in-time snapshot of the run manifests
under `<agent-dir>/results/<project>/<run_id>.json`, produced by
`summarizeRuns`/`renderTaskStats` in `extensions/task/metrics.ts`.

## Current snapshot (as of 2026-08-06)

33 run manifests, 5 projects, 251 requirements total, 0 failure artifacts
(no aborted runs) — from the agent-dir results. Recompute live with
`/task-stats`; the snapshot is illustrative, not authoritative.

| Metric | As of 2026-08-06 |
|---|---|
| Runs | 33 (economy 25, full 8) |
| Verify pass rate | 30/33 (91%) |
| Total cost | $1.34 (avg $0.041/run) |
| Cost per requirement | $0.0053 |
| Latency | avg 14m20s · p50 13m04s · p90 32m42s |
| Tier cost split | economy avg $0.043/run · full avg $0.033/run |

Reads: all 33 runs were single-worker (no parallel manifests yet), none
preserved session traces, and no failure artifacts exist — so the snapshot
cannot yet say anything about parallel wall-time gains or abort frequency.

## Comparison methodology

How to judge a dispatched run against the same work done directly. The
manifest fields that make each comparison are in parentheses.

- **Cost per requirement** (`task.requirements`, `totals.cost_usd`) —
  normalize across runs of different sizes; the headline unit for
  "is task cheap". Watch it per tier: a locked economy tier should beat
  full-tier per-requirement cost.
- **Cost per diff line** (planned: `files_changed`/diff size; see Missing
  data) — normalizes by *output*, catching runs that burn tokens on
  exploration without producing change. Until diff size is recorded, use
  `phases.execute.edits` (edit-tool count) as a coarse proxy, or diff the
  run's commit range against its base with `jj diff --stat`.
- **Wall-clock vs. worker duration** (`totals.duration_ms` vs.
  `phases.execute.duration_ms`) — the gap is verification + review +
  fix-loop + merge + map-build overhead. A healthy run keeps the gap small;
  a large gap means the run spent its time on gates, not work. For parallel
  runs the execute phase is the wall time of the concurrent phase, so wall
  ≈ max worker duration while summed usage stays the LLM-work total — the
  parallelism dividend lives in this comparison.
- **Main-session token savings** — dispatch moves the whole
  read-edit-test cycle into a worker; the main session pays only the spec
  write plus the completion summary (see The `task` Tool in
  `docs/pi-task-design.md`). Savings ≈ what the same work would have cost
  in the main session's context. Not directly measured yet (planned:
  pre-dispatch main-session spend) — treat as a directional argument, not
  a number.
- **Verification value** (`phases.verify`) — bash-exit-code gating is
  zero-token; count how often a dispatched run's verification caught
  something the worker thought it had finished. A pass rate under ~95%
  is evidence the gate is doing real work, not ceremony.

## What data is missing

Three planned manifest fields would close the gaps above. None exists yet;
each is listed with the exact hole it fills.

| Missing field | Hole it closes |
|---|---|
| Wall-clock timestamps (dispatch/start/end) | `run_id` is minute-granularity only; no precise latency percentiles, no time-of-day/cost correlations, no dispatch-overhead measurement |
| Pre-dispatch main-session spend | the task-vs-direct cost comparison is incomplete without the tokens the main session spent writing the spec and interpreting the result — dispatch never shows as strictly cheaper otherwise |
| `files_changed`/diff size in the manifest | cost per diff line (normalized by output), and a guard against runs that spend heavily while changing little |

## Decision framework

Dispatch to a `task` worker when:

- **The work is parallelizable** — `sub_specs` or `parallel > 1` turn
  serial work into concurrent workers; wall time collapses to the slowest
  worker. This is the clearest win: direct editing is inherently serial.
- **Verification carries value** — a spec with concrete bash-verifiable
  requirements (tests, builds, greps) gets a hard zero-token gate plus
  bounded fix-loop retries. Work with no meaningful verification check is a
  weaker dispatch candidate.
- **Context preservation matters** — prewalk model swap keeps reads in
  context (`read_duplication_tokens` near zero validates this) and the
  codebase map seeds exploration, so the worker starts targeted instead of
  cold. Bigger, multi-file tasks amortize the dispatch overhead here.
- **The main session should stay clean** — isolation (sandbox, jj
  workspaces, no worker turns in the conversation) keeps the main context
  focused on the user's intent and the result, not the churn.

Edit directly when:

- **The change is trivial and reversible** — a typo, a one-line fix, a
  value tweak. Dispatch overhead (spec, worker spawn, merge, verification
  setup) exceeds the work itself.
- **The decision needs conversation** — the user's back-and-forth is the
  point (API shape, naming, product judgment); a worker cannot see or
  contribute to that.
- **Context lives in the main session** — intent scattered across the
  conversation that a spec cannot capture. A worker gets only the spec and
  the codebase map; anything else must be written down, which is its own
  cost.

Rule of thumb: dispatch for multi-file, verifiable, or parallel work; edit
directly for single-file reversible changes. The `delegation` skill
(loaded when relevant) covers the same threshold in operational terms.

## The opacity-bias note

Task runs are invisible by design: the worker is a separate RPC session —
its turns never enter the main conversation, and only a compact progress
view streams to the TUI. Direct edits, by contrast, are fully visible. That
asymmetry biases both the human and the conversational model toward
undervaluing dispatched work (out of sight, out of the cost accounting).

Two counterweights exist and should be used together:

- **The completion summary** — the task tool's content text (duration,
  tokens, cost, review report, files changed) is the run's one-paragraph
  audit trail in the conversation; it is the only LLM-visible record of
  what the worker did.
- **`/task-stats`** — the aggregate view (count, verified, aborted, cost,
  p50/p90 latency, by-tier and by-project rollups) keeps the *system's*
  performance legible even when individual runs are not. Any claim about
  task performance in a session should cite it rather than a remembered
  run.

Decisions about dispatch vs. direct editing should be made from these two
sources, not from the visibility of the work.
