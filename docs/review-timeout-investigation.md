# Review Timeout Investigation — forked adversarial review hangs

Status: investigation (read-only; no extension code changed). Companion to todo #80.
Follow-ups landed: the P0 fixes (no-progress + first-call review watchdogs) and
the failure-artifact/diagnostics work (todo #86) now ensure failed reviews and
workers leave an inspectable record.

## Executive summary

Forked reviews hang until the 20-minute wall (`REVIEW_WALL_TIMEOUT_MS`): two confirmed
incidents surfaced as `Reviewer timed out after 1200000 ms`, plus one user-interrupted
reviewer killed with SIGTERM (`Reviewer exited (code 143) without reporting findings`).
The root cause is a three-way interaction:

1. **The forked reviewer inherits the worker's FULL session** — evidence shows ~100K–486K
   tokens of accumulated reads/bash outputs at fork time, not the 156–903 tokens the
   manifests report (`context_inherited_tokens` measures the last turn's input *delta*,
   a ~100–1000× undercount).
2. **review.ts has no no-progress watchdog.** Workers got `WORKER_NO_PROGRESS_TIMEOUT_MS`
   (10 min, todo #74, `worker.ts`); reviews never did. A reviewer wedged *inside* a single
   model call emits zero RPC events, so the settled-without-report idle watchdog (which
   keys off `agent_settled`) never fires and only the 20-min wall timer catches it.
3. **The old full tier reviewed with `qwen-token-plan/qwen3.8-max-preview`** — a slow
   model whose first post-fork call re-encodes the whole pruned context (the new session
   has no prompt cache). Both 20-min timeouts ran under this tier; the largest
   fork contexts observed on it were ~406K–486K tokens.

Observability gaps hid all of this: `ReviewPhaseMetrics` has **no `duration_ms`**,
failed runs write **no manifest at all**, and no preserved review traces exist in
production (no `--preserve-sessions` runs on record).

---

## Evidence

### Where the data lives

- Run manifests: `<agent-dir>/results/<project>/<run_id>.json` (written by
  `writeManifest`, `extensions/task/metrics.ts`).
- Main-session traces (the tool-result payloads quoted below):
  `<agent-dir>/sessions/<dir>/<session>.jsonl` (pi's default session store).
- Preserved worker/review traces (`results/<project>/<run_id>/<prefix>-N.jsonl`,
  `copySessionTraces`): none exist on record — no production run used `--preserve-sessions`.

### Confirmed incidents

| When (UTC) | Project | What happened | Review model |
|---|---|---|---|
| 2026-08-04 22:37:57 | agent (sandbox-integration run) | Task tool errored: `Reviewer timed out after 1200000 ms`. Worker's 3 commits landed anyway; **no manifest written** | qwen (old full tier) |
| 2026-08-04 23:07:55 | pi-discord-bridge (step-4 run) | Task tool errored: `Reviewer timed out after 1200000 ms`. Dispatched 22:43:51, worker ~4 min, review hung the full 20 min; **no manifest written** | qwen (old full tier) |
| 2026-08-04 23:39:55 | agent (UI/UX run) | `Reviewer exited (code 143) without reporting findings` — user SIGTERM'd a "stuck" reviewer. Hangs are not qwen-only (economy tier used deepseek-v4-flash) | deepseek-v4-flash |

Sources: session traces under `<agent-dir>/sessions/` (tool-result messages with
`"text": "Reviewer timed out after 1200000 ms"`, `isError: true`; and the SIGTERM exit
for the interrupted run).

### Manifest review data (all completed reviews)

Every completed review produced findings (1–4) and, for deepseek reviewers, non-zero
cost (0.046–0.068 USD); qwen reviewers reported cost 0. **No manifest records review
duration** — `ReviewPhaseMetrics` (`extensions/task/metrics.ts:46`) carries only
`model / forked / context_inherited_tokens / findings / by_priority / cost_usd`.

Fork-context audit (per manifest; `~fork_total` = prewalk + execute `tokens_in`,
i.e. the accumulated context the fork replays; `ctx_reported` = the manifest's
`context_inherited_tokens`):

| run | ~fork_total | ctx_reported |
|---|---|---|
| 20260803T2352-e9ef | 262,033 | 673 |
| 20260804T0037-7f07 | 406,526 | 208 |
| 20260804T0145-964e | 134,277 | 359 |
| 20260804T0223-9878 | 84,070 | 903 |
| 20260804T2149-45c2 | 98,778 | 188 |
| 20260804T2158-4535 | 109,153 | 571 |
| 20260804T2311-a8eb | 22,467 | 156 |
| 20260804T2130-359b | 118,348 | 579 |
| 20260804T2202-ed97 | 445,354 | 214 |
| 20260804T2236-4e33 | 485,642 | 720 |

`contextInheritedTokens` (`metrics.ts:350-353`) returns the *delta* between the last two
turns' cumulative `tokens_in` — 156–903 here — while the reviewer actually loads the
whole accumulated session (the fork replays every message; each message's tokens were
introduced as "new input" exactly once, so cumulative `tokens_in` ≈ the replayed size).
The metric underreports the real fork context by roughly 100–1000×.

Even successful reviews are slow: subtracting prewalk/execute/verify from
`totals.duration_ms` leaves review+fix-loop at ~3–26 min per run, with the qwen-review
runs at the top of that range. The timeouts are the tail of a slow-but-mostly-working
distribution, not a separate failure mode.

### The hung-review signature

- Both 20-min timeouts ran the old full tier: review model
  `qwen-token-plan/qwen3.8-max-preview`. Fork contexts on that tier were large: the
  bridge timeout's immediately preceding run forked 485,642 tokens; the agent
  session's own preceding runs forked 98K/109K, and the same project/tier carried up
  to 406K the day before.
- **Zero events during the hang**: the runner observes only what the reviewer's RPC
  session writes to stdout. While the reviewer is inside one model call there is nothing
  to observe — no `message_end`, no `tool_execution_start/end`, no `agent_settled` — so
  neither the idle watchdog nor the TUI sees any activity for the full 20 minutes.

---

## Root-cause analysis

### R1 — Review lifecycle: the missing no-progress watchdog

review.ts's lifecycle bounds, in order of specificity:

- **Idle watchdog (settled-without-report)** — `review.ts:183-196`: reuses
  `decideIdleAction` (worker.ts) keyed off the `agent_settled` RPC event. It nudges once
  with `REVIEW_IDLE_NUDGE_PROMPT` (`review.ts:41`) and fails on a second settle without a
  captured report. It only fires for a reviewer that *settled a turn* without calling
  `report_findings` — a reviewer wedged inside a model call never settles, so this
  watchdog is silent for the entire hang.
- **Wall timer** — `REVIEW_WALL_TIMEOUT_MS = 20 * 60_000` (`review.ts:38`, armed at
  `review.ts:259-263`): the only bound that actually caught the incidents, at 20 minutes
  each.
- **No-progress watchdog** — **absent.** Workers gained `WORKER_NO_PROGRESS_TIMEOUT_MS`
  (10 min), `decideNoProgressAction` (`worker.ts:271-285`), a 30s poll
  (`worker.ts:172`, wired at `worker.ts:838-857`) in todo #74; review.ts has no
  equivalent (no `noProgress` / `NO_PROGRESS` symbol exists anywhere in review.ts). The
  exact case the worker watchdog closes — "emits nothing at all, fail-fast" — is
  unhandled for reviews, so a wedged review burns the full 20-minute wall.

### R2 — Context size × model choice

- Fork mechanics: `pi --mode rpc --fork <worker sessionFile> --session-dir <scratch>`
  (`review.ts:138-149`). The fork loads the worker's entire persisted session; pruning
  (`extensions/task/prune.ts`) drops assistant reasoning, edit/write/checklist/yield
  calls and results, but **keeps every read and bash tool result** — and in agentic runs
  the bash outputs and file reads *are* the token bulk (the evidence runs forked
  22K–486K tokens; the bridge timeout's preceding run forked 485K).
- First call cost: the forked session starts with an empty prompt cache, so the
  reviewer's first request re-encodes the full pruned context. A large context on a slow
  model (old full tier: `qwen-token-plan/qwen3.8-max-preview`) means the first call can
  legitimately take many minutes — and, per the incidents, occasionally never returns
  within the wall.
- `contextInheritedTokens` (`metrics.ts:350`) made this invisible by reporting a
  ~100–1000× undercount of the actual inherited context.
- The fix loop is not a compounding factor: each iteration re-forks the *original*
  worker `sessionFile` (constant across iterations in `orchestrator.ts`), so the fork
  context does not grow per iteration; only the injected diff does.

### R3 — Fork mechanics and the report_capture path

- The reviewer runner never issues RPC `request()`s — no pending-request correlation, no
  timeout, and no 30s timer on the review path (the 30s pending timer lives in worker.ts
  `request()` at `worker.ts:618-623` and is used only for the worker's `get_state`
  capture). The `report_findings` result is captured from the `tool_execution_end` event
  (`review.ts:174-180`), so there is **no RPC-pending hang path in review.ts** — the hang
  is entirely the model call before any tool event.
- One correctness edge: the capture keys off `tool_execution_end` for `report_findings`.
  If pi executed the tool but the event never reached stdout (e.g. the process is killed
  between execute and event flush), `settleReview` (`review.ts:102-112`) reports
  "exited without reporting" even though the review produced a valid report — the fix
  loop then never sees it. Low probability, but it would masquerade as a review failure.

---

## Prioritized fix recommendations

### P0 — Port the no-progress watchdog to review.ts

- **Where**: `extensions/task/review.ts` — mirror `worker.ts:838-857`; reuse the
  already-exported `decideNoProgressAction` (`worker.ts:271`) and
  `noProgressErrorMessage` (`worker.ts:287`).
- **Sketch**: in the JSONL event callback (`review.ts:201`) track `lastActivityMs` on
  every parsed event and `toolCallDepth` from `tool_execution_start/end`; poll every 30s
  (reuse `NO_PROGRESS_CHECK_INTERVAL_MS`); on expiry `abort()` + `rejectOutcome` with a
  message naming the no-activity window. Use a **shorter window than workers** — e.g.
  5 min — because a review is supposed to be one fast model pass, not a 70-turn
  exploration.
- **Effect**: a wedged review (the observed zero-events signature) is killed in ≤5 min
  with a precise "no progress" error instead of 20 min and a bare wall-timeout message.

### P0 — Fail fast when the first model call produces no events

- **Where**: `extensions/task/review.ts` — around the prompt write (`review.ts:270`) and
  `processEvent` (`review.ts:173`).
- **Sketch**: after writing the review prompt, require any first event within a short
  deadline (e.g. 2–3 min). No `message_start`/turn/tool event → `abort()` +
  `rejectOutcome("reviewer made no progress after the initial prompt")`. This is the
  precise observed failure mode: one stalled 400K-token call.
- **Effect**: turns the 20-min wall into a ~3-min fail-fast for the dominant hang
  signature, independent of the watchdog window.

### P1 — Measure and cap/prune the forked context

- **Where**: `extensions/task/metrics.ts:46` (`ReviewPhaseMetrics` — add `duration_ms`
  and the true inherited size); `metrics.ts:350-353` (`contextInheritedTokens` — report
  the last turn's *cumulative* input, not the delta); `extensions/task/review.ts:138-149`
  (fork args); `extensions/task/prune.ts` (keeps all bash/read results).
- **Sketch**: (a) record real review wall time (start → close in `forkedReview`) and the
  true inherited context so regressions become visible; (b) cap the fork context — keep
  only the most recent N reads/bash outputs (or a token budget) in the pruned context, or
  size-check the session file before forking; (c) write a failure-status manifest on
  review errors so timed-out runs stop vanishing from `results/`.
- **Effect**: the next hang is measurable (duration + real context), and the worst-case
  fork size is bounded.

### P1 — Review model and wall-budget per tier

- **Where**: `extensions/task/config.ts` `DEFAULT_BUDGET_TIERS` (review_model per tier);
  `extensions/task/review.ts:38` (`REVIEW_WALL_TIMEOUT_MS`).
- **Sketch**: both 20-min timeouts used `qwen-token-plan/qwen3.8-max-preview` (old full
  tier); the deepseek reviewers completed in the evidence. Keep the fast reviewer on the
  default tier (the current `<agent-dir>/config/task.toml` full tier already does) and
  reserve qwen for the explicit `max` tier; once the no-progress watchdog lands, tighten
  `REVIEW_WALL_TIMEOUT_MS` (e.g. 10 min) so the wall is a backstop, not the primary
  bound.
- **Effect**: lower hang probability and lower worst-case latency per run.

### P2 — Surface review progress in the TUI

- **Where**: the task-tool progress view (`extensions/task/index.ts` /
  `extensions/task/progress.ts`); `forkedReview`'s `onUpdate` is already wired
  (`review.ts:173-177` forwards the worker reducer's `turn`/`tool_end` updates).
- **Sketch**: render reviewer turns/tools as they arrive (the reducer already produces
  them) and emit a periodic "still waiting for the model" heartbeat when idle. This
  directly answers the reported UX complaint ("the review stage is pretty slow and
  there's no feedback while it is running" — the freeze-frame view made a 20-min hang
  look like a dead run).
- **Effect**: a hung review is distinguishable from a slow one at a glance, and the
  freeze state stops masking stalls.

### P2 — Don't lose the run when the review fails

- **Where**: `extensions/task/orchestrator.ts:1087` (`forkedReview` rejection propagates
  out of `executeSingle`'s try block, skipping manifest assembly) and the `TaskResult`
  mapping in `extensions/task/index.ts`.
- **Sketch**: on review failure, still write a manifest carrying `review.status =
  "error"` + the error string + partial usage, and return a `TaskResult` that surfaces
  the review failure alongside the worker's success data (commits/tests). Incident 1
  showed the main agent salvaging the worker's landed commits by hand; the tool should do
  that structurally.
- **Effect**: failed reviews stop being opaque, and landed worker work is not hidden
  behind a bare error string.

---

## Verification / reproduction

- Fast suite (must stay green — nothing but this doc changed):
  `timeout 120 npx tsx extensions/task/test.ts`.
- Manual real-LLM e2e: `timeout 900 npx tsx extensions/task/test-e2e.ts`.
- Reproduce the hang deterministically: instrument `forkedReview` with an artificial
  delay before the first event, or run a review against a large repo (many large reads)
  under a slow review model; with P0 fixes in place the run should abort in minutes with
  a "no progress" error instead of 20 minutes of silence.
