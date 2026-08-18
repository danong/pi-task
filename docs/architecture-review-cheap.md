# Architecture review (cheap): pi-task — VCS-churn hotspot scan

A cheap hotspot survey of the pi-task codebase looking for deepening
opportunities: where the code is shallow, tangled, or under-tested, and
where one localized change buys the most. This is the follow-up to
[`docs/architecture-review.md`](architecture-review.md) (2026-08-14) — same
method, refreshed churn data (8 new commits since), a leaner report. The
scan is churn-driven: the files the project keeps rewriting are the files
whose structure costs the most.

Context was read first, per the survey contract: `docs/pi-task-design.md`
(the design doc — the project's closest thing to ADRs) and
`docs/workflow.md` (the agent-facing surface). There is no `CONTEXT.md`
and no `docs/adr/` in this repo. No candidate below conflicts with a
recorded design decision in a way that warrants reopening it: the design
principles (code orchestrates / typed contracts / tools enforce / graceful
degradation) are orthogonal to every proposal; the candidates sharpen the
file-structure section's module boundaries rather than cross them.

## Method

**Churn scan.** The request was open-ended, so hotspots were located by VCS
churn: every commit in the look-back window was walked and per-file change
counts aggregated. The exact commands (run from the repo root, jj 0.43):

```sh
# Dump every commit's file-change stat.
jj log --no-graph -r 'all()' --stat > /tmp/churn.txt

# Per-file aggregation: commits-touching + added/deleted markers, parsed
# from the file-stat lines ("<path> | <N> +++--").
python3 - <<'EOF'
import re, collections
touching, added, deleted = collections.Counter(), collections.Counter(), collections.Counter()
for line in open('/tmp/churn.txt'):
    m = re.match(r'^(\S.*?)\s+\|\s+(\d+)\s+([+\-]+)\s*$', line)
    if m:
        p = m.group(1).strip()
        touching[p] += 1
        added[p] += m.group(3).count('+')
        deleted[p] += m.group(3).count('-')
for c, a, d, p in sorted(((touching[p], added[p], deleted[p], p) for p in touching), reverse=True):
    print(f"{c:3d} commits  +{a:5d} -{d:5d}  {p}")
EOF
```

**Look-back window.** The spec asked for roughly three months of commits;
the repo is younger than that, so the window is the **entire history**: 41
commits from 2026-08-05 (first commit) to 2026-08-18, `all()` minus the
root and the current (empty) working-copy commit → 38 substantive commits.
Nearly all of them touch `extensions/task/`.

**Reading the hotspots.** Highest-churn code files in commit-count order:

| Commits | +/− | File | Note |
|---|---|---|---|
| 16 | +189/−35 | `extensions/task/index.ts` | most-touched file; grew 12→16 since the last survey (/goals, workflow contract, review + shape params) |
| 13 | +217/−38 | `extensions/task/orchestrator.ts` | largest module (2316 lines) |
| 13 | +195/−8 | `extensions/task/test-index.ts` | second-largest test file (1299 lines) |
| 9 | +84/−3 | `extensions/task/metrics.ts` | |
| 8 | +211/−12 | `extensions/task/test-workspace.ts` | third-highest test churn (1576 lines) |
| 6 | +143/−61 | `extensions/task/workspace.ts` | atomic-merge path landed and was reworked |
| 6 | +55/−7 | `extensions/task/config.ts` | shapes feature (+129 in one commit) |
| 5 | +50/−1 | `extensions/task/worker.ts` | stable since the last survey — the reviewer absorbed its change traffic instead |
| 5 | +67/−8 | `extensions/task/progress.ts` | |

README (13) and design-doc/workflow churn (12 + 6) is documentation
tracking the code and was not scored. `extensions/task/dbg-tmp.ts` (2
commits, −45) is a removed debug probe — noise, not a hotspot. Each
hotspot source file was read or grep-verified; candidates below are what
the reading surfaced, with every factual claim traceable to the cited
lines.

## Vocabulary

Every candidate is scored with the shared survey vocabulary:

- **Module** — an implementation unit whose interface hides its complexity.
- **Interface** — the contract a module presents; good design pushes
  complexity behind it.
- **Depth** — a powerful implementation behind a simple interface; shallow
  modules expose nearly as much complexity as they hide.
- **Seam** — a clean line where the code can be split or restructured
  without widespread change.
- **Adapter** — a thin translation layer at a seam isolating two
  otherwise-incompatible interfaces.
- **Leverage** — how much behavior change one localized change buys.
- **Locality** — how little context a change needs; good locality means a
  change touches few nearby places.
- **The deletion test** — if this module or abstraction were deleted, how
  much value disappears with it? Little surviving value means it is
  shallow. Deleting something that merely *moves* complexity is shallow
  work; deleting something whose complexity *concentrates* into a deeper
  module is deepening.

## Candidates

### 1. A shared pi-RPC session runner for workers and reviewers — Strong

**Files.** `extensions/task/worker.ts` (1257 lines; `spawnWorkerSession` is
a ~480-line closure) and `extensions/task/review.ts` (522 lines;
`forkedReview`).

**Problem.** `forkedReview` re-implements the imperative shell of
`spawnWorkerSession`: the JSONL event loop, stderr capture, the
settle-without-payload idle watchdog, the no-progress watchdog, the wall
timer, the abort → SIGTERM → SIGKILL ladder, the `buildAbortError` unified
failure path, and the close/error handlers with their per-timer teardowns
(duplicated within each file too). The pure decision cores are already
shared — review.ts imports `attachJsonlReader`, `buildAbortError`,
`decideIdleAction`, `decideNoProgressAction`, and `reduceWorkerEvent` from
worker.ts — which is exactly why the remaining duplication stands out: the
two runners are the same module wearing two costumes. The design doc's
todo trail shows the cost: every lifecycle fix has been made twice, the
second site citing the first (the SIGKILL dead-code fix, todo #86's unified
failure path). Watchdog races are this project's recurring bug class (todos
#74, #80, #86), so two copies of the wiring is two places for the next one
to land. Churn confirms the drift: worker.ts (5 commits) has gone quiet
while review.ts kept consuming lifecycle changes.

**Solution.** Extract one **session-runner module** — an adapter over a pi
RPC subprocess with a simple interface: spawn (invocation + env), capture
(which tool payload settles the run — `yield` for workers,
`report_findings` for reviewers), and a watchdog set (wall / no-progress /
idle / first-event / tool-timeout, each with its own window). Worker and
reviewer become configurations of it; the arg builders stay as their
parameterizers. The seam already exists — the shared deciders are the
proof.

**Benefits.** *Locality:* lifecycle correctness lives in one module; the
next watchdog fix is written once. *Leverage:* high — the design doc's
reviewer-persona note ("personas differ only in prompt and output shape;
the context mechanism is shared") means every future specialized session
inherits the full watchdog suite for free, and the recurring bug class
(raced rejections swallowing causes) is eliminated structurally. *Tests:*
the runner's wiring is today exercised only by the real-LLM e2e; one runner
means one fake-process harness can cover spawn/settle/abort/watchdog
interactions hermetically for both consumers. *Deletion test:* deleting
review.ts's bespoke plumbing and running the reviewer through the shared
runner concentrates all session-lifecycle complexity into one deeper module
— deepening, not relocation.

### 2. One jj seam and one metrics finalize in orchestrator.ts — Strong

**Files.** `extensions/task/orchestrator.ts` (2316 lines — the largest
module, 13 commits, +217), `extensions/task/workspace.ts`,
`extensions/task/metrics.ts`.

**Problem.** The orchestrator is a deep module doing four jobs at once:
(a) pure decision functions (fix-loop, spec split, overlap classification,
finalization triage — well tested), (b) jj access, (c) metrics assembly,
and (d) two large run closures (`executeTask`'s parallel path,
`executeSingle`). Jobs (b) and (c) leak complexity into the interface:

- **A broken jj seam.** workspace.ts owns the bounded jj adapter (`execJj`:
  timeout bound, `JJ_EDITOR=true`, timeout detection) — but the orchestrator
  bypasses it with two raw `execFile("jj", …)` helpers, `headCommitId`
  (line 814) and `computeDiff` (line 837), which carry none of that
  discipline: no timeout bound, no editor guard. `computeDiff` feeds the
  review gate and can hang indefinitely while every other jj call in the
  system is bounded.
- **Triple metrics assembly.** `finalizeMetrics` is called from two sites
  in `executeSingle` (lines 2015, 2084 — finalization-incomplete recovery,
  no-review path, review path) plus `finalizeParallelMetrics` (line 1761),
  each spelling out a ~25-field assembly object whose fields are nearly
  identical.
- **Duplicated identity setup.** The AI-identity temp-config block
  (`mkdtemp` + `aiIdentityToml` + `createAiTaskBase`) appears in both the
  parallel path and `executeSingle`, and a third copy of the identity file
  is written inside worker.ts's spawn.

**Solution.** Move `headCommitId`/`computeDiff` into workspace.ts through
`execJj` (the bounded adapter becomes the *only* jj seam); collapse the
finalize call sites into one call fed by a single run-state record
accumulated as the run progresses; extract the identity-base setup/restore
into one helper used by both paths and by worker.ts. The pure decision
functions stay where they are.

**Benefits.** *Locality:* jj-call discipline (timeouts, snapshot-op rules)
is enforced in one module by construction instead of by remembering at each
call site; identity mechanics live once. *Leverage:* one finalize path
feeds every outcome (single, parallel, caveat, failure) — every future
manifest field is added in one place, which is the change this module's
churn (13 commits) says happens most. *Tests:* the collapsed finalize
becomes hermetically testable with fake `WorkerResult`s across all
outcomes; today only the e2e exercises the wiring. *Deletion test:*
deleting the three raw/triplicated paths concentrates jj and metrics
complexity into their existing deep modules — the orchestrator keeps only
orchestration and gets deeper as its interface shrinks.

### 3. Extract index.ts's pure core from the extension wiring — Worth exploring

**Files.** `extensions/task/index.ts` (1231 lines; 16 commits — the
most-churned file in the repo) and `extensions/task/test-index.ts` (1299
lines, 13 commits — the second-largest test file).

**Problem.** index.ts mixes two jobs: pi-runtime wiring (tool registration,
flags, `/task-budget`, `/goals`, `/task-stats`, session-start hooks, map
injection) and a large pure core (budget resolution chain, `taskToolSchema`,
`taskResultToToolReturn`, `summarizeResult`, `completionSummaryLine`,
`deriveRunMetrics`, `readBudgetOverride`, `readGoals`,
`readSessionTokensBefore`, workflow-contract text). Every feature lands in
the same file — since the last survey it grew 16th-commit worth of /goals
handling, pre-dispatch token reading, review/`shape` params — making it the
likeliest overlap-collision point for parallel sub_specs workers
dispatching against disjoint scopes. The pure core is hermetically tested
*through* the wiring file, so test-index.ts has grown to mirror it. The
codebase already proved the extraction pattern works: progress.ts was
pulled out the same way and stays clean (its churn is 5 commits, all
feature-driven).

**Solution.** Move the pure core into one or two leaf modules (budget
resolution + tool schema in one; result mapping + summary rendering in
another) with zero pi imports; index.ts keeps only the `default export`
wiring and re-exports. No behavior change.

**Benefits.** *Locality:* summary/budget/goals changes stop touching the
extension entry point; parallel workers collide less often on the hottest
file. *Leverage:* moderate — mostly risk reduction and clarity, not new
capability. *Tests:* the pure suite imports leaf modules directly;
wiring-shape tests shrink to the registration surface. *Deletion test:*
borderline — the logic moves rather than concentrates, which makes this the
weakest of the strong candidates by that test; its value is churn-risk
reduction on the most-touched file, not depth.

### 4. Delete the legacy single-workspace merge path — Worth exploring

**Files.** `extensions/task/workspace.ts` (`mergeWorkspace`, ~50 lines) and
`extensions/task/test-workspace.ts` (1576 lines, 8 commits — the
third-highest test churn).

**Problem.** `mergeWorkspace` (one workspace squashed per call) was
superseded by `mergeWorkspacesAtomic` (R1: every workspace's commits land
in ONE jj operation — the design doc explicitly retired the incremental
shape because a mid-loop squash failure leaves a partial merge). Production
calls only the atomic variant; `mergeWorkspace` survives solely inside
test-workspace.ts scenarios (verified: its only importers are test lines).
Two merge entry points sharing `assertWorkspacesConsumed` means merge
invariants are exercised through a shape production never runs — a shallow
module whose interface promises behavior nobody consumes, and a
contributor to test-workspace.ts's churn.

**Solution.** Delete `mergeWorkspace`; re-express its test scenarios
(conflict surfacing, id re-resolution, stale-target divergence) as
one-workspace calls through `mergeWorkspacesAtomic`, which accepts a single
workspace unchanged.

**Benefits.** *Locality:* one merge entry point, one set of invariants to
reason about. *Leverage:* small but structural — future merge changes can
no longer drift between two implementations. *Tests:* the suite exercises
the production shape exclusively. *Deletion test:* clean pass — deleting
it removes duplicated invariant surface and its scenarios survive on the
real path; nothing of value disappears.

### 5. Resolve the run shape once — Speculative

**Files.** `extensions/task/config.ts` (`TaskShape` loading +
`resolveTaskShape`; 707 lines, 6 commits, +55 — the shapes feature landed
+129 lines in a single commit), `extensions/task/index.ts` (lines 891-913:
`resolveTaskShape` + the shape→model derivation + `reviewWillRun`),
`extensions/task/orchestrator.ts` (lines 1150-1162: re-resolves the shape
and re-derives `workModel`), `extensions/task/progress.ts` (mirrors the
result via `buildRunPlan` model inputs).

**Problem.** The shape feature is one commit old and its logic is already
spread across four files with duplicated derivation: the effective-model
rule (`workModel === "prewalk" ? prewalkModel : executeModel`) is computed
in index.ts (892-894) *and again* in orchestrator.ts `executeTask`
(1158-1162); `reviewWillRun` is derived in index.ts while the orchestrator
"warns and skips" review on its own conditions; progress.ts takes the
pre-resolved models and re-mirrors the phase sequence. Every future shape
tweak has three or four places to drift. This is the newest hotspot in the
data (config.ts's growth is the shapes commit) and the cheapest to get
wrong.

**Solution.** Resolve the shape once — in config.ts or a small shape.ts —
into a concrete `{prewalkModel, workModel, reviewModel, reviewAxes, wall,
…}` record and pass that down; execution re-derives nothing. index.ts and
orchestrator.ts consume the record; progress.ts keeps building its plan
from the same record.

**Benefits.** *Locality:* shape growth (the design doc expects shapes to be
benchmarked and extended — `bench-regression --shape`) stays in one module.
*Leverage:* moderate — removes duplicated derivation before it accrues
churn. *Tests:* shape resolution becomes one pure function with a hermetic
golden table over the loaded `[shapes.*]` set. *Deletion test:* weak-ish —
the copies are mechanical and typed, so deletion concentrates little
complexity. Listed because the churn data points at this new area; it
should be done *as part of* candidates 2 and 3 (which already touch all
three consumers), never standalone.

## Top recommendation

**Do candidate 1 first — the shared pi-RPC session runner**
(worker.ts + review.ts).

Why this one over the others:

- **It attacks the project's recurring bug class.** The design doc's
  failure-path history (todo #74 no-progress, todo #80 first-event, todo
  #86 unified diagnostics, the R4 SIGKILL dead-code fix) is almost entirely
  session-lifecycle bugs — and every fix was implemented twice, once per
  runner, the second site citing the first. Two copies of error-prone
  wiring is not a style issue; it is the demonstrated failure mode. The
  churn data agrees: worker.ts's lifecycle fixes have stopped landing
  there and show up in review.ts instead — the duplication is alive.
- **The seam is already half built.** The pure cores (`decideIdleAction`,
  `decideNoProgressAction`, `reduceWorkerEvent`, `attachJsonlReader`,
  `buildAbortError`) are shared today; only the imperative shell
  duplicates. That makes the refactor bounded and reviewable — the shared
  deciders' hermetic tests already pin the decision logic.
- **It unlocks the documented next step for free.** Personas are the design
  doc's stated extension point ("personas differ only in prompt and output
  shape; the context mechanism is shared"). A shared runner is exactly
  that shared context mechanism; every future reviewer or specialized
  session inherits the full watchdog suite instead of re-deriving it.
- **Candidates 2 and 5 can run alongside it.** They touch disjoint files
  (worker.ts/review.ts vs orchestrator.ts/workspace.ts/metrics.ts and
  config.ts), so they can be dispatched as parallel sub_specs. Candidate
  2's finalize consolidation is the natural second ticket; candidate 3 is
  a smaller follow-up; candidate 4 is a clean deletion; candidate 5 rides
  on 2 and 3.