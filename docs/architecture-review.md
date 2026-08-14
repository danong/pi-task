# Architecture review: pi-task (VCS-churn hotspot scan)

A hotspot survey of the pi-task codebase looking for deepening
opportunities: where the code is shallow, tangled, or under-tested, and
where one localized change would buy the most. The scan is churn-driven —
the files the project keeps rewriting are the files whose structure costs
the most. Context was read first: `docs/pi-task-design.md` (the design
doc, the project's closest thing to ADRs) and `docs/workflow.md` (the
agent-facing surface), per the survey contract.

## Method

**Churn scan.** The request was open-ended, so hotspots were located by
VCS churn: every commit in the look-back window was walked and the number
of commits touching each file was counted. The exact commands (run from
the repo root; jj 0.43):

```sh
# Commits touching each file, most-churned first
for c in $(jj log -r 'all() ~ root() ~ @' --no-graph -T 'commit_id ++ "\n"'); do
  jj diff --summary -r "$c" 2>/dev/null | awk '{print $2}'
done | sort | uniq -c | sort -rn

# Line-weighted churn (insertions/deletions per file across the same range)
for c in $(jj log -r 'all() ~ root() ~ @' --no-graph -T 'commit_id ++ "\n"'); do
  jj diff --git -r "$c" 2>/dev/null
done | awk '/^diff --git /{f=substr($3,3);next} /^\+\+\+/||/^---/{next}
            /^\+/{ins[f]++} /^-/{del[f]++}
            END{for(f in ins) printf "%6d %6d  %s\n",ins[f],del[f],f}' \
     | sort -k1,1 -rn
```

**Look-back window.** The spec asked for roughly two months; the repo is
younger than that, so the window is the entire history — 33 commits from
2026-08-05 (first commit) to 2026-08-13 (`all() ~ root() ~ @` excludes
the root and the working copy). Nearly all of it touches
`extensions/task/`.

**Reading the hotspots.** The highest-churn code files, in commit-count
order: `extensions/task/index.ts` (12 commits, ~1175 lines added),
`extensions/task/orchestrator.ts` (10, ~2434 added — the largest code
churn), `extensions/task/test-index.ts` (10), `extensions/task/metrics.ts`
(8), `extensions/task/workspace.ts` (6, ~917 added), and
`extensions/task/worker.ts` (5, ~1258 added). README and design-doc churn
(12 and 11 commits) is documentation tracking that code and was not
scored as candidates. Each hotspot file was read in full; the candidates
below are what the reading surfaced.

**Context check.** No candidate conflicts with a documented design
decision in `docs/pi-task-design.md` in a way that warrants reopening it:
the design principles (code orchestrates / typed contracts / tools
enforce / graceful degradation) are orthogonal to every proposal here,
and the file-structure section describes module boundaries the candidates
sharpen rather than cross.

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

**Files.** `extensions/task/worker.ts` (~1260 lines; `spawnWorkerSession`
is a ~480-line closure) and `extensions/task/review.ts`
(`forkedReview`, ~275 lines of the same machinery).

**Problem.** `forkedReview` re-implements the imperative shell of
`spawnWorkerSession`: the JSONL event loop, stderr capture, the
settle-without-payload idle watchdog, the no-progress watchdog, the wall
timer, the abort → SIGTERM → SIGKILL ladder, AbortSignal wiring, the
`buildAbortError` unified failure path, and the close/error handlers with
their per-timer cleanup blocks (duplicated *within* each file, too — the
close and error handlers repeat the same three-timer teardown). The pure
decision cores were already shared (`decideIdleAction`,
`decideNoProgressAction`, `reduceWorkerEvent`, `attachJsonlReader` — all
from worker.ts), which is exactly why the remaining duplication stands
out: the two runners are the same module wearing two costumes. The design
doc's todo trail shows the cost — every lifecycle fix has been made twice
and the second site cites the first: the SIGKILL dead-code fix
("same fix as worker.ts (R4)") and the todo-#86 unified failure path
("same contract as worker.ts's failWorker"). Watchdog races are this
project's recurring bug class (todos #74, #80, #86; design-doc Rs), so
two copies of the wiring is two places for the next one to land.

**Solution.** Extract one **session-runner module** — an adapter over a
pi RPC subprocess with a simple interface: spawn (invocation + env),
capture (which tool payload settles the run — `yield` for workers,
`report_findings` for reviewers), and a watchdog set (wall / no-progress /
idle / first-event / tool-timeout, each with its own window). Worker and
reviewer become configurations of it; `buildWorkerArgs` and the review
arg builder stay as their parameterizers. The seam already exists — the
pure deciders and the reducer are shared; only the imperative shell
moves.

**Benefits.** *Locality:* lifecycle correctness lives in one module; the
next watchdog fix is written once. *Leverage:* high — future session
types (the design doc's reviewer personas note "personas differ only in
prompt and output shape; the context mechanism is shared") inherit the
full watchdog suite for free, and the historical bug class (raced
rejections swallowing causes) is eliminated structurally instead of
patched per-site. *Tests:* the runner's wiring is today exercised only by
the real-LLM e2e; one runner means one fake-process harness can cover
spawn/settle/abort/watchdog interactions hermetically for both consumers.
*Deletion test:* deleting review.ts's bespoke plumbing and running the
reviewer through the shared runner concentrates all session-lifecycle
complexity into one deeper module — deepening, not relocation.

### 2. Split orchestrator.ts: one jj seam, one metrics finalize — Strong

**Files.** `extensions/task/orchestrator.ts` (2268 lines — the largest
module and the largest code churn: 10 commits, ~2434 lines added),
`extensions/task/workspace.ts`, `extensions/task/metrics.ts`.

**Problem.** The orchestrator is a deep module doing four jobs at once:
(a) pure decision functions (fix-loop, spec split, overlap
classification, finalization triage — well tested), (b) jj access, (c)
metrics assembly, and (d) two ~480-line run closures (`executeTask`'s
parallel path, `executeSingle`). Jobs (b) and (c) leak complexity into
the interface:

- **A broken jj seam.** workspace.ts owns the bounded jj adapter
  (`execJj`: timeout bound, `JJ_EDITOR=true`, timeout detection) — but
  the orchestrator bypasses it with two raw `execFile("jj", …)` helpers,
  `headCommitId` and `computeDiff`, which carry *none* of that
  discipline (no timeout bound, no editor guard). The review-diff path
  (`computeDiff`) can hang indefinitely while every other jj call in the
  system is bounded. The `-ignore-working-copy` op-log discipline is
  documented in both files separately.
- **Triple metrics assembly.** `finalizeMetrics` is called from three
  sites in `executeSingle` (finalization-incomplete recovery, no-review
  path, review path), each spelling out a ~25-field `assemble` object
  whose fields are nearly identical; `finalizeParallelMetrics` is a
  fourth near-copy of the same shape.
- **Duplicated identity setup.** The AI-identity temp-config block
  (`mkdtemp` + `aiIdentityToml` + `createAiTaskBase`) is written out in
  both the parallel path and `executeSingle`, and a third copy of the
  identity file is written inside worker.ts's spawn. The parallel path
  already extracted its restore (`restoreParallelWorkingCopy`); the
  single path still inlines its own.

**Solution.** Move `headCommitId`/`computeDiff` into workspace.ts through
`execJj` (the bounded adapter becomes the *only* jj seam); collapse the
three `finalizeMetrics` call sites into one call fed by a single
run-state record accumulated as the run progresses; extract the
identity-base setup/restore into one helper used by both paths and by
worker.ts. The pure decision functions stay where they are.

**Benefits.** *Locality:* jj-call discipline (timeouts, snapshot-op
rules) is enforced in one module by construction instead of by
remembering at each call site; identity mechanics live once. *Leverage:*
one finalize path feeds every outcome (single, parallel, caveat,
failure) — every future manifest field is added in one place, which is
the change the module's churn history says happens most. *Tests:* the
collapsed finalize becomes hermetically testable with fake
`WorkerResult`s across all four outcomes (today only the e2e exercises
the wiring). *Deletion test:* deleting the three raw/triplicated paths
concentrates jj and metrics complexity into their existing deep modules
— the orchestrator keeps only orchestration and gets deeper as its
interface shrinks.

### 3. Extract index.ts's pure core from the extension wiring — Worth exploring

**Files.** `extensions/task/index.ts` (1133 lines; the most-touched file
— 12 commits) and `extensions/task/test-index.ts` (1189 lines, 10
commits — the second-largest test file).

**Problem.** index.ts mixes two jobs: pi-runtime wiring (tool
registration, flags, `/task-budget`, session-start hooks, map injection)
and a large pure core (budget resolution chain, `taskToolSchema`,
`taskResultToToolReturn`, `summarizeResult`, `completionSummaryLine`,
`deriveRunMetrics`, `readBudgetOverride`, `readSessionTokensBefore`,
workflow-contract text). The pure core is hermetically tested *through*
the wiring file, so test-index.ts has grown to mirror it. Two concrete
frictions: every feature (tiers, personas, summaries, pre-dispatch
tokens) lands in the same file, making it the likeliest overlap-conflict
point for parallel sub_specs workers; and the file's interface (what the
extension runtime needs) is buried under logic the runtime never sees.
The codebase already proved the pattern works: progress.ts was extracted
the same way and stayed clean.

**Solution.** Move the pure core into one or two leaf modules (e.g.
budget resolution + tool schema in one, result mapping + summary
rendering in another) with zero pi imports; index.ts keeps only the
`default export` wiring and re-exports. No behavior change.

**Benefits.** *Locality:* summary/budget changes stop touching the
extension entry point; parallel workers dispatching against disjoint
scopes collide less often on the hottest file. *Leverage:* moderate —
this is mostly risk reduction and clarity, not new capability. *Tests:*
the pure suite imports leaf modules directly; wiring-shape tests shrink
to the registration surface. *Deletion test:* borderline — the logic
moves rather than concentrates, so this is the weakest of the three
"Strong/Worth exploring" candidates by the deletion test; its value is
churn-risk reduction on the most-touched file, not depth.

### 4. Delete the legacy single-workspace merge path — Worth exploring

**Files.** `extensions/task/workspace.ts` (`mergeWorkspace`, ~50 lines)
and `extensions/task/test-workspace.ts` (its only caller).

**Problem.** `mergeWorkspace` (one workspace squashed per call) was
superseded by `mergeWorkspacesAtomic` (R1: every workspace's commits
land in ONE jj operation — the design doc explicitly retired the
incremental shape because a mid-loop squash failure leaves a partial
merge). Production calls only the atomic variant; `mergeWorkspace`
survives solely inside test-workspace.ts scenarios. Two merge entry
points sharing `assertWorkspacesConsumed` means merge invariants are
exercised through a shape production never runs — a shallow module whose
interface promises behavior nobody consumes.

**Solution.** Delete `mergeWorkspace`; re-express its test scenarios
(conflict surfacing, id re-resolution, stale-target divergence) as
one-workspace calls through `mergeWorkspacesAtomic` (the atomic variant
accepts a single workspace unchanged).

**Benefits.** *Locality:* one merge entry point, one set of invariants
to reason about. *Leverage:* small but structural — future merge changes
can no longer drift between two implementations. *Tests:* the test
suite exercises the production shape exclusively (its churn — 8 commits,
third-highest among tests — partly reflects maintaining both).
*Deletion test:* clean pass — deleting it removes duplicated invariant
surface and its scenarios survive on the real path; nothing of value
disappears.

### 5. Collapse the options-plumbing chain into a resolved run config — Speculative

**Files.** `extensions/task/index.ts` → `extensions/task/orchestrator.ts`
(`ExecuteTaskOptions`, ~30 fields) → `extensions/task/worker.ts`
(`WorkerOptions`).

**Problem.** Every new knob (tier wall, tool timeout, verification
grace, AI identity, sandbox, lifecycle timestamps) is hand-threaded as
optional fields through three or four layers, re-mapped at each hop
(index.ts maps `tierConfig` → `ExecuteTaskOptions`; `executeTask`
re-maps ~20 of them into `executeSingle`'s opts). This plumbing is a
contributor to the orchestrator/index churn ranking — it is the part of
those files that grows even when no logic changes.

**Solution.** Resolve one immutable run-config object at the top
(tier + defaults + overrides, all fields required) and pass it down;
layers read fields instead of re-mapping them.

**Benefits.** *Locality:* a new knob is added once, at resolution.
*Leverage:* moderate; mostly removes boilerplate. *Tests:* resolution
becomes one pure function with a hermetic golden shape. *Deletion test:*
weak — the threading is explicit and typed, and the design doc's "code
orchestrates" principle favors visible plumbing over clever indirection;
deleting it concentrates little complexity because the copies are
mechanical. Listed because the churn data points at it, but it should be
done only *as part of* candidate 2 — standalone, it risks a premature
abstraction.

## Top recommendation

**Do candidate 1 first — the shared pi-RPC session runner**
(worker.ts + review.ts).

Why this one over the others:

- **It attacks the project's recurring bug class.** The design doc's
  failure-path history (todo #74 no-progress, todo #80 first-event,
  todo #86 unified diagnostics, the R4 SIGKILL dead-code fix, the R7/R8
  cleanup rules) is almost entirely session-lifecycle bugs — and every
  fix was implemented twice, once per runner, with the second site
  citing the first. Two copies of error-prone wiring is not a style
  issue; it is the demonstrated failure mode.
- **The seam is already half built.** The pure cores (`decideIdleAction`,
  `decideNoProgressAction`, `reduceWorkerEvent`, `attachJsonlReader`,
  `buildAbortError`) are shared today; only the imperative shell
  duplicates. That makes the refactor bounded and reviewable — and the
  shared deciders' hermetic tests already pin the decision logic, so the
  extraction can be verified against them.
- **It unlocks the documented next step for free.** Personas are the
  design doc's stated extension point ("personas differ only in prompt
  and output shape; the context mechanism is shared"). A shared runner
  is exactly that shared context mechanism; every future reviewer or
  specialized session inherits the full watchdog suite instead of
  re-deriving it.
- **Candidate 2 can run alongside it.** The two touch disjoint files
  (worker.ts/review.ts vs orchestrator.ts/workspace.ts/metrics.ts), so
  they can be dispatched as parallel sub_specs; candidate 2's
  finalize-consolidation is the natural second ticket. Candidates 3-4
  are smaller follow-ups; candidate 5 waits for candidate 2.
