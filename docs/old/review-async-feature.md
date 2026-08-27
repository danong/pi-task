> **Archive status:** Historical and non-normative. See [`README.md`](README.md) for the active source of truth.

# Review: async/cost-optimization feature set (M1–M4)

Point-in-time adversarial review (2026-08-19) of the channel-aware shapes
(M1), detached dispatch + `/task-status`, the OpenRouter batch lane (M2),
completion records (M3), and the standalone scheduler (M4). Scope:
`extensions/task/config.ts` (shapes' `channel` + `[jobs.*]`),
`extensions/task/runner.ts`, `extensions/task/batch.ts`, the batch routing in
`extensions/task/orchestrator.ts` (`routeRun`/`executeBatchLane`),
`extensions/task/metrics.ts` (`recentCompletions` + manifest channel), and
`extensions/task/scheduler.ts`. Method: full code read of the lanes above,
dynamic probes under `/tmp` (never in the repo), and the hermetic suite
(`npx tsx extensions/task/test.ts` — green at review time). No source changes
were made. Findings name the file and a concrete verification step each; the
line numbers are approximate by design — follow the named symbol.

## Findings

### P0 — `[jobs.*]` config is never loaded: the scheduler has zero jobs

**File:** `extensions/task/config.ts`, `loadJobs`.

The guard condition is inverted:

```ts
const parent = sections["jobs"];
if (parent === undefined || typeof parent !== "object" || parent !== null) return out;
```

For any real TOML table, `parent !== null` is `true`, so the function returns
the empty record on every call — the loop that would parse `[jobs.<name>]`
sections is unreachable. Compare the correct pattern used a few lines away for
`[budget.*]`/`[shapes.*]`:
`if (budgetParent !== undefined && typeof budgetParent === "object" && budgetParent !== null)`.

Consequence: `TaskConfig.jobs` is always `{}`, `dueJobs` is always empty, and
the M4 scheduler — the whole automation milestone — dispatches nothing for any
configuration. Nothing else notices: `--once` exits 0, `--loop` polls forever.
No test exercises `loadJobs` (test-config.ts and test-scheduler.ts build
`JobConfig` objects in code and never round-trip a TOML `[jobs.*]` section).

**Verify:** write `/tmp/probe-jobs.mts`:

```ts
import { loadTaskConfig } from "<repo>/extensions/task/config.ts";
import { writeFileSync } from "node:fs";
writeFileSync("/tmp/j.toml", '[jobs.a]\nspec = "x"\nevery_ms = 1000\n');
console.log("jobs loaded:", JSON.stringify(loadTaskConfig("/tmp/j.toml").jobs));
```

run `npx tsx /tmp/probe-jobs.mts` from the repo root → prints `jobs loaded: {}`
(expected: one job). Static check: `grep -n 'parent !== null) return out' extensions/task/config.ts`.

### P1 — Scheduler flex dispatch writes an unrunnable run request

**File:** `extensions/task/scheduler.ts`, `buildJobRequest`.

The request carries `model: input.tier` — the tier's NAME (e.g. `"economy"`),
never the tier's execute model. `buildJobRequest` never consults
`config.tiers[job.tier]`: no `prewalkModel`/`executeModel`/`reviewModel`, no
`workerTimeoutMs` (the tier wall), no `toolTimeoutMs`, no AI commit identity.
`runner.ts`'s child only checks that `options.model` is present, then runs the
orchestrator with model id `"economy"` — the worker session fails to start
against any provider. So even with the P0 fixed, every flex/sync job dies in
the child before the first model call, and the job's interval is consumed
(state is recorded on spawn success).

**Verify:** probe `buildJobRequest` with `tier: "economy"` and print
`request.options.model` → `"economy"`; or statically:
`grep -n 'model: input.tier' extensions/task/scheduler.ts`.

### P1 — Scheduler batch dispatch submits model `"batch"` and is fire-and-forget

**File:** `extensions/task/scheduler.ts`, `dispatchJob` (batch branch).

Two independent defects:

1. `opts.batchProvider.submit("batch", items)` sends the literal string
   `"batch"` as the model — `OpenRouterBatchProvider.submit` puts its `model`
   argument verbatim into the request body (there is no "ambient batch model"
   in the provider, contrary to the code comment). `config.batch.model`
   (e.g. `google/gemini-3.7-flash:batch`) is never read. Every scheduled batch
   job fails at submit with an OpenRouter `http_error` (invalid model).
2. Even if the submit landed, `dispatchJob` bypasses `runBatchLane` entirely:
   no job-state file, no polling, no collection, no file application, no
   commit, no verification, no manifest. The scheduler records the provider
   job id in its state and forgets it — spend without effect and without the
   recovery handle the batch lane otherwise provides.

**Verify:** `grep -n 'submit("batch"' extensions/task/scheduler.ts` and
confirm `dispatchJob` never references `opts.config.batch`; compare
`OpenRouterBatchProvider.submit` (body `{ model, items }`) in
`extensions/task/batch.ts`.

### P1 — Detached batch runs lose their run_id: three ids for one run

**Files:** `extensions/task/orchestrator.ts` (`executeTask` batch branch,
`executeBatchLane`), `extensions/task/runner.ts`.

`executeTask` documents and honors the injected `runId` ("the manifest and any
failure artifact must land under that same id") on the single and parallel
paths — but the batch branch calls `executeBatchLane` without it, and
`executeBatchLane` has no `runId` parameter: it runs
`const runId = generateRunId()`. A detached dispatch therefore produces:

- id **X** — returned to the caller, keyed in `.request.json`/`.live.json`;
- id **Y** — the lane's own id, keyed in the manifest and `.batch.json` job state;
- id **Z** — the `BatchError` failure artifact, written via
  `writeFailureArtifactBestEffort` without a `runId` (a third generated id).

`/task-status X` then reports `STARTING` forever (request present, live file
removed on exit, manifest under Y), and the runner child's catch may write
`X.failure.json` for a run that "succeeded" as manifest Y. The documented
invariant "detach changes only WHO waits" and "the returned run_id IS the
manifest's run_id" is broken exactly on the channel most likely to be detached
(batch jobs run up to 24h — nobody blocks on them).

**Verify:** `grep -n 'runId' extensions/task/orchestrator.ts | sed -n '/executeBatchLane/,/generateRunId/p'`
— the batch-branch call site (~line 1269) passes no `runId`;
`executeBatchLane`'s options type has none; its first act is
`const runId = generateRunId()`. Hermetic repro: call `executeTask` with
`shape.channel === "batch"`, a fake provider, and `runId: "X"` →
`result.manifest.run_id !== "X"`.

### P1 — `recentCompletions` surfaces dispatch sidecars and job-state files as completed runs

**File:** `extensions/task/metrics.ts`, `recentCompletions`.

The M3 view filters only `*.json` (minus `*.tmp`) and derives
`runId`/`status` from the suffix — it does not skip the detached-dispatch
sidecars that `summarizeRuns` explicitly learned to skip:

- `<run_id>.request.json` and `<run_id>.live.json` each surface as separate
  "completed ✓" runs with runIds `…request` / `…live`; the live file is
  rewritten every 2s while a run is in flight, so a RUNNING detached run shows
  as the newest *completion*.
- `<run_id>.batch.json` job-state files surface as completed runs on channel
  `"sync"` (they have no `config.channel`) with a `.batch`-suffixed runId;
  `summarizeRuns` additionally counts them as `unreadable` manifests.

Probe result (one real batch manifest + its sidecars + one job-state file):
4 "completions" instead of 1; `summarizeRuns` reported `unreadable: 1`.
The completion surface feeding `/task-stats` — the only place a Discord-only
user sees outcomes — is actively misleading whenever a detached run exists.

**Verify:** create `<metricsDir>/<project>/X.json` (any valid manifest),
`X.request.json`, `X.live.json`, `Y.batch.json`, then
`npx tsx` a probe calling `recentCompletions(dir, 10)` → four rows. Static:
`grep -n 'request.json\|live.json' extensions/task/metrics.ts` — the skips
exist only in `summarizeRuns`.

### P2 — Batch lane: the active checkout is exposed for up to 24h; commit never re-checks cleanness

**File:** `extensions/task/orchestrator.ts`, `executeBatchLane`.

`assertCleanWorkingCopy` runs once, before submission. Collection, file
application, and `jj commit` happen up to `job_timeout_ms` later (default 24h).
`jj commit` commits everything in the working copy — any user work-in-progress
started during the polling window is swept into the AI-identity batch commit.
The interactive pipeline has the same shape but a minutes-scale window; batch's
window is a day. Related: nothing steers batch runs to `detach: true` —
`index.ts` never reads the shape's channel, so a non-detached batch dispatch
blocks the calling pi session for up to 24h (the tool awaits `executeTask`).

**Verify:** trace `executeBatchLane`: cleanness check is inherited from
`executeTask`'s head (`assertCleanWorkingCopy`); the apply/commit steps after
`runBatchLane` perform no second check; `grep -n 'channel' extensions/task/index.ts`
→ no batch-channel handling at dispatch.

### P2 — Context-free single-turn items overwrite WHOLE files from untrusted output

**Files:** `extensions/task/batch.ts` (`buildBatchPrompt`),
`extensions/task/orchestrator.ts` (apply loop).

Each item's prompt carries only the goal + one requirement + the contract: no
codebase map, no current file contents. The contract demands whole-file
content ("write WHOLE files, never partial edits"), and the apply step is a
plain `writeFileSync` overwrite. For any requirement touching an existing
file, the model must reproduce the entire file from nothing — silent content
loss unless a verification command happens to catch it. Path safety
(`extractBatchFiles`) blocks traversal only: `.pi/settings.json`,
`config/task.toml`, CI configs are all legal "repo-relative" targets, and the
batch lane has no sandbox (no subprocess) and no review axes. This is the
batch lane's real quality envelope: greenfield file generation, not edits.

**Verify:** read `buildBatchPrompt` (no codebase context is available to add —
the lane receives only `spec`); `grep -n 'writeFileSync(target' extensions/task/orchestrator.ts`
(apply loop); `extractBatchFiles` checks in `extensions/task/batch.ts`.

### P2 — "Recoverable" batch failures have no recovery mechanism

**Files:** `extensions/task/batch.ts`, `extensions/task/orchestrator.ts`.

`poll_timeout`/`aborted` messages say "resume by polling <jobId>";
`items_incomplete` says "resubmit only the failed items" and even carries the
subset in `BatchError.detail.items`. But no entrypoint exists that resumes a
job from a job-state file or submits an item subset — `runBatchLane` always
builds items from the full spec. The only available recovery is a full re-run:
double spend for the same work. Compounding: the failure artifact is written
without the lane's `runId` (see the detached-run finding), so the artifact →
job-state pointer chain starts from an id that matches nothing else on disk.

**Verify:** `grep -rn 'resume\|resubmit' extensions/task/batch.ts extensions/task/orchestrator.ts`
— hits are doc comments and error strings only; `runBatchLane` has no
"start from existing job id" parameter.

### P2 — `--loop --dry-run` dispatches real jobs

**File:** `extensions/task/scheduler.ts`, `main`.

The loop branch calls `runOnce` without `dryRun` (and with a real
`OpenRouterBatchProvider`), so the flag combination `--loop --dry-run` —
plausible when smoke-testing a daemon config — dispatches for real, every
minute. Only `--once` honors the flag.

**Verify:** read `main()` in `extensions/task/scheduler.ts`: the
`args.mode === "loop"` branch omits `dryRun: args.dryRun`.

### P3 — The flex channel is watchdog calibration only — no pricing/endpoint mechanism

**Files:** `extensions/task/config.ts` (`channelWatchdogWindows`),
`config/task.toml`.

M1's flex story ("synchronous endpoint, 1–15 min per call, ~50% off") is only
watchdog windows (25/20 min instead of 3/10): the channel changes no model,
endpoint, or price, no shipped `[budget.*]` tier points at a flex endpoint,
and nothing validates that a flex-shaped run actually uses a flex-priced
model. The cost goal rides entirely on the user hand-building a tier of
flex-priced models; the shipped config has no example. (Batch, by contrast,
has a real lane behind its channel.)

**Verify:** `grep -rn 'channelWatchdogWindows\|\.channel' extensions/task/orchestrator.ts`
— channel is consumed only by watchdog windows and manifest recording.

### P3 — Scheduler operational gaps: no logs, no backoff, spawn-success ≠ run-success

**File:** `extensions/task/scheduler.ts`.

- Flex dispatch spawns the runner with `stdio: "ignore"` — unlike the task
  tool's dispatch, which redirects the child to `<run_id>.log`. A scheduled
  run's stdout/stderr goes nowhere; failures are visible only as
  manifest/failure artifacts after the fact.
- Dispatch "success" is spawn success: a child that dies immediately (e.g.
  `assertCleanWorkingCopy` on a dirty checkout — the common state of a dev
  repo) consumes the job's whole interval (a week for a weekly survey) with
  no retry.
- Conversely, a permanently failing dispatch (unreadable `file:` spec) is
  retried every 60s under `--loop` with no backoff and no state recorded.
- Job `channel` is an unvalidated string; a typo (e.g. `"bacth"`) silently
  routes to the flex path.

**Verify:** `grep -n 'stdio' extensions/task/scheduler.ts` vs the `openSync(logPath...)`
spawn in `extensions/task/index.ts`; `runOnce` records `state[name]` right
after `dispatchJob` resolves.

### P3 — Leftover duplicate `kind` member in `writeFailureArtifactBestEffort`

**File:** `extensions/task/orchestrator.ts` (the helper's options type).

The inline options type declares `kind` twice (`"worker" | "review" |
"parallel"` and again with `| "batch"`) — M2 merge residue. Runtime is fine,
but a `tsc` typecheck would reject the file (tsx only transpiles, so the
suite can't see it). Worth cleaning with the other fixes.

**Verify:** `grep -n -A4 'writeFailureArtifactBestEffort(opts' extensions/task/orchestrator.ts`.

### P3 — Progress view and dispatch plan are channel-blind

**Files:** `extensions/task/progress.ts`, `extensions/task/index.ts`.

`buildRunPlan` builds the same prewalk/work/review phase list regardless of
channel, so a detached batch run's request plan (shown by `/task-status`)
advertises work/review phases on the tier's interactive models while the run
is actually a single-turn job; `applyProgressEvent` ignores the lane's
`batch_*` events, so the live progress text never changes until the run ends.

**Verify:** `grep -n 'channel\|batch' extensions/task/progress.ts` → no hits
in the plan/progress builders.

## Goal fit

**(a) flex/batch cost savings with the $10 OpenRouter budget — PARTIAL.**
The batch lane works on the interactive path (submit → poll → collect →
contract-validate → apply → verify, with typed job-state records), and the
batch channel is correctly unbound from interactive watchdogs. But: the flex
half is only watchdog plumbing (P3); no dollar cap or credit check exists
anywhere — a batch job of N whole-file items costs what it costs, and cost is
recorded only when the provider returns `cost` per item (absent → silent
$0.0000 in the manifest); and the repeat-spend automation that would actually
exercise the budget (scheduler) cannot run any job today (P0 + both dispatch
lanes broken).

**(b) Zero manual update steps (Discord-only interaction) — NOT MET today.**
The intended chain — scheduler picks up `[jobs.*]`, dispatches detached/batch,
completions surface via the manifest-derived recent view — is broken at its
first link (P0: jobs never load) and at both dispatch lanes (P1/P1). Even
with those fixed, the completion surface a remote user would rely on is
polluted by sidecar "completions" (P1), scheduled runs leave no logs (P3),
and a dirty dev checkout silently burns a whole weekly interval. The design
direction (manifests as the only record, zero new state to sync) is right;
the execution isn't there yet.

**(c) No injection into active sessions — MOSTLY MET, one hole.**
Detached runs and scheduler dispatches are separate processes (`detached +
unref`), workers stay sandboxed in isolated jj workspaces, and the
clean-working-copy fail-fast protects the single/parallel paths. The hole is
the batch lane: it applies untrusted whole-file output directly to the
invoking checkout up to 24h after the cleanness check (P2), and scheduled
flex runs execute in the scheduler's cwd — correct separation, but it means
the automation competes with the user for one checkout.

**(d) Settings portability (machine-local settings.json) — MET.**
Per-machine overrides live in the agent-dir `config/task.toml` with per-key
warn-and-fallback, the shipped file is a drift-guarded mirror (hermetic test),
secrets are env vars (`OPENROUTER_API_KEY`), machine-written files like
`settings.json` are already excluded from the map machinery, and a missing
config degrades to built-ins. Minor blemish: the shipped `[jobs.*]` example
embeds a machine-specific `file:` spec path.

**(e) Always-current dev-checkout workflow — MET with a daemon caveat.**
`getAgentDir()` resolution + the self-registering `.pi/settings.json`
(`"packages": [".."]`) make any trusted checkout live immediately, and
detached dispatch resolves `node_modules/.bin/tsx` per spawn, so new
dispatches always run current code. Caveat: a `--loop` scheduler holds its
loaded module graph until restarted — an always-on daemon is the one place
the checkout can go stale under the running engine (plus the P2 footgun that
`--loop --dry-run` dispatches for real).

## Regression check

The DEFAULT interactive sync pipeline is untouched: `channel` defaults to
`"sync"` on every built-in shape and `channelWatchdogWindows("sync")` returns
the pre-M1 windows (3 min first-event / 10 min no-progress); `routeRun` routes
everything but a batch-channel shape to the interactive path; batch artifacts
(`.batch.json`, `verify.source: "batch"`, `FailureArtifact.kind: "batch"`,
optional `config.channel`) are additive manifest surfaces; the multi-axis
review machinery only receives per-channel windows (unchanged for sync). The
full hermetic suite passes. The only user-visible blast radius of the new
code on existing flows is `/task-stats`' recent-completions section, which the
sidecar pollution (P1 above) distorts as soon as any detached run exists.

## Top recommendation

Stop adding async surface area and fix the scheduler→run seam end to end —
it is currently a pipeline in which no stage works: (1) invert the `loadJobs`
guard (P0); (2) resolve the job's tier in `buildJobRequest` — models, wall,
tool timeout, AI identity — instead of writing the tier name into
`options.model` (P1); (3) route scheduler batch jobs through `runBatchLane`
with `config.batch.model`, or drop `channel = "batch"` from `[jobs.*]` until
a collect/apply story exists (P1); (4) thread `ExecuteTaskOptions.runId`
through `executeBatchLane` (and into its failure artifact) so detached batch
runs keep their id (P1). Add the three missing seam tests with the fixes —
a `[jobs.*]` TOML round-trip, a scheduler-request model assertion, and
`executeTask(batch, runId)` id-stability — because every finding above sat in
a seam that no hermetic test crosses. Until then, treat the batch lane as
interactive-detached-only and document the 24h-checkout-exposure caveat.

## Resolution (2026-08-19)

All P0–P2 findings addressed; this doc is the point-in-time review, so the
details above are as-found, and this section records what changed after.

### P0 — `[jobs.*]` never loaded
Fixed with the one-line guard inversion in `config.ts`
(`parent !== null` → `parent === null`). Probe now returns the job; the
scheduler sees `TaskConfig.jobs`. Commit `c20c98df`.

### P1 — scheduler flex request unrunnable
`buildJobRequest` now carries the tier's real `executeModel`/`prewalkModel`/
`reviewModel`, the tier wall, the shared tool timeout, and the AI identity
into the run request — instead of `model: <tier name>`. (Request-shape
regression assertions added in `test-scheduler.ts`.)

### P1 — scheduler batch submit fire-and-forget with model `"batch"`
`dispatchJob` no longer submits a bare batch job. Flex AND batch dispatch
through the detached runner; the child's orchestrator routes by the shape's
channel and `executeBatchLane` (which reads `config.batch.model`) runs the
full lane — poll, collect, validate, apply, commit, verify, manifest.

### P1 — batch runs lose their run_id
`executeTask`'s batch branch passes `runId` into `executeBatchLane`, which
uses `opts.runId ?? generateRunId()` — the manifest, job-state file, and
failure artifact all land under the ONE injected id.

### P1 — `recentCompletions` surfaces sidecars as completions
Now skips `<run_id>.request.json` / `.live.json` / `.batch.json` (and their
failure variants), matching `summarizeRuns`. Regression: a RUNNING detached
run no longer shows as the newest completion in `/task-stats`.

### P2 — `--loop --dry-run` dispatched real jobs
The loop branch now passes `--dry-run` through.

### P2 — 24h checkout exposure
`executeBatchLane` re-runs `assertCleanWorkingCopy` immediately before
applying files, so user work-in-progress started during the polling window
is never swept into the batch commit.

### P2 — context-free whole-file overwrite
The batch lane is now **greenfield-only**: the apply loop refuses to write to
an existing file (typed `BatchError("existing_file")`) rather than silently
replacing content the model never saw. Batch specs for edits must stub/remove
the target first.

### P2 — no recovery mechanism
`runBatchLane` accepts `existingJobId` (re-drive the SAME provider job — no
re-submit/double-spend) and `resubmitCustomIds` (submit only the failed
subset). New `resumeBatchJob()` entrypoint in `batch.ts` reads the persisted
`<run>.batch.json` state and resumes that job (the caller re-supplies the
original spec, kept in the run's `*.request.json` sidecar). Regression tests in
`test-batch.ts`.

### P2 — batch channel could block the session
`index.ts` now forces detachment for any batch-channel dispatch (the shape's
`channel === "batch"`), since the lane polls for up to 24h — a non-detached
batch dispatch can no longer block the calling session.

### P3 — flex is watchdog-only (no pricing/endpoint mechanism)
Left as-is: flex remains M1's calibration-only story until the user builds a
tier of flex-priced models. Not a code defect.

### Design lesson (see the surrounding conversation)
This review was wrongly dispatched as a default code-shaped task: the engine's
three-axis code review then validated the worker's REPORT prose ("ship — 5
P3s") instead of the report's claims about the code, masking the P0/P1s above.
Reviews/analysis must use `shape: "analysis"` + `review: "survey-reviewer"`
(report validation), and its verdict means "the report is well-formed", never
"the code is sound".

*(Superseded by the final design: a review/survey is a SINGLE task — the
analysis shape declares no review axes at all, the "survey-reviewer" persona
was removed, and there is no nested report validator. The worker writes the
report and the spec's Verification commands plus the conversational agent's
judgment are the quality gate.)*
