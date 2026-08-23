# pi-task — Phase 11 Handoff

You are implementing **Phase 11** of `pi-task`, the task-execution engine for
the [pi coding agent](https://pi.dev). Phases 1–10 built the v1 engine in
`extensions/task/`; the v2 redesign (`packages/core-v2/`, milestones M0–M5) now
carries the future. This handoff is the **fresh-dev briefing**: project state,
doc map, toolchain, completed work per milestone with exact commits, the TODO
backlog with disposition, and what to do next.

## What pi-task is (one paragraph)

A declarative spec (`## Goal` / `## Requirements` / `## Verification` — plain
bash, exits 0) is dispatched to isolated worker sessions that edit code, run
tests, and commit under deterministic gates. Completion requires schema-validated
`Yield` + passing verification on the merged tree; parallel workers run in
isolated `jj` workspaces combined by an atomic deterministic merge ladder; spend
is controlled structurally by budget tiers locked out of the model's tool schema;
every run leaves typed evidence (manifest + cost/latency/token phases, failure
artifact + recovery guide on failure).

## Where to look

| Path | Role |
| :--- | :--- |
| `docs/pi-task-v2.md` | **Contract** (523 lines) — problem, architecture, FR-1–FR-11, §5 context lifecycle (prewalk/bundle/fork/cold + prune profiles), §6 autonomy L1/L2/L3, §7 benchmarks (suite-03), §8 milestones table + four-phase migration. Read first. |
| `docs/pi-task-v2-subsystems.md` | **Implementation spec** (521 lines) — 7 kernel seams (§1), 5 payload schemas (§2), TaskPlugin/TaskGateway + ControlSurface contracts (§3/3a/3b), ledger DDL (§4), migration inventory table (§5, 15 rows, owns deletion ownership), rejected alternatives (§6). |
| `docs/pi-task-v2-future.md` | Scale-readiness / E.1–E.6 deferred mechanisms (L2+, not needed to build M0–M5). |
| `extensions/task/` | **v1 live engine** — `index.ts` (task tool registration), `orchestrator.ts` (spec split/aggregation), `workspace.ts` (jj ladder source of truth), `config.ts` (task.toml loader), `runner.ts`, `worker.ts`, `test.ts` (hermetic suite), `test-e2e.ts` (real-LLM sequential e2e), `bench-regression.ts` (owner file for `GROUNDING_SPECS` + baselines). Tagged `// @ts-ignore` / `../../../../extensions/...` when v2 needs to import it — `packages/core-v2/tsconfig.json` deliberately excludes `extensions/task/**`. |
| `packages/core-v2/` | **v2 package** — strict island, `npx tsc --noEmit -p packages/core-v2/tsconfig.json` is the FR-11 gate. `src/` + `test/run-all.ts` (26 suites, zero LLM). `README.md` = layout + gates + plugin how-to (<25 lines). |
| `docs/pi-task-design.md` | v1 design doc (budget tiers, task tool, phases table rows 1–10). |
| `docs/pi-task-testing-spec.md` | v1 fast/e2e contract + strict typecheck recipe. |
| `docs/architecture-review-v2{,-m2,-m4}.md` | Adversarial spec-fidelity reviews for M0+M1, M2, M4. |
| `docs/cost-reduction-plan.md` | Bench tier economics + residual verification checklist (session_id / reasoning.exclude). |
| `mise.toml` | Tasks: `setup` (npm ci), `verify` (toolchain), `test` (`extensions/task/test.ts && packages/core-v2/test/run-all.ts`, zero LLM), `typecheck` (core-v2 strict), `eval-grounding` (dry plan by default, `-- --run` for real LLM). |
| `~/.pi/agent/config/task.toml` | **Live config — do NOT edit without explicit permission (drift-guarded).** Tiers `[budget.bench-good]` / `[budget.bench-fast]` map to `openrouter/stealth/ox-alpha` / `free`. |

## Toolchain & gates

```bash
mise run verify                      # toolchain gate (tsx, pi deps, tomllib, drift)
mise run typecheck                   # strict gate over packages/core-v2 only (= FR-11)
mise run test                        # hermetic suite, zero LLM — the CI gate
npx tsx packages/core-v2/test/run-all.ts   # core-v2 26 suites directly
npx tsx extensions/task/test.ts      # v1 suite directly
mise run eval-grounding              # suite-03 dry plan (zero LLM)
mise run eval-grounding -- --run     # suite-03 real runs (LLM-gated; strong needs --allow-strong)
timeout 1200 npx tsx packages/core-v2/test/e2e-parity.ts   # M1 single-worker gate (manual, openrouter/stealth/ox-alpha)
timeout 1800 npx tsx packages/core-v2/test/e2e-parallel.ts # M2 two-worker gate (manual, same model)
# Allowed smoke models: openrouter/stealth/ox-alpha, openrouter/free, openrouter/meta/muse-spark-1.2-contributor
```

## Model / budget constraints

* Smoke/e2e/reviews use only `openrouter/stealth/ox-alpha` (+ `openrouter/free` for tiny probes, `openrouter/meta/muse-spark-1.2-contributor`; `muse-spark-1.2` non-contributor is forbidden).
* `openrouter/free` is very low limit — tiny smoke tests only.
* `~/.pi/agent/config/task.toml` tiers normalized to `openrouter/stealth/ox-alpha`/`free`; budget tiers: `bench-good` ↔ `full`, `bench-fast` ↔ `economy` (scheduler test needed `[jobs] unknown tier "full"` fix already landed).
* Dispatches via `task` tool specify `budget: "bench-good"` (= `full` tier, 50 turns). Economy (8–29 turns) proved too small for M5 — bench-good required.

## Model-id naming rule

Provider-prefixed: `openrouter/stealth/ox-alpha`, `openrouter/meta/muse-spark-1.2-contributor` (95% discount vs. plain `muse-spark-1.2`). Never use the non-contributor id in tests or reviews without explicit approval.

## Spec & dispatch conventions

* Spec markdown: `## Goal` (one sentence) + `## Requirements` (numbered WHATs) + `## Verification` (plain bash, one per line, each exits 0). No backticks/prose in verification.
* `task` tool spawns isolated `jj` workspaces at `/tmp/pi-task-parallel-*` as `pi-task-<id>-0/1` workspaces; parallel workers land via `sub_specs` with **disjoint file scopes** (preferred over single large task). Budget via `task.toml`.
* Verification-gated + `jj`-committed: workers must `yield` typed + pass verification to ship.
* This handoff's "Next steps" tasks should be dispatched via `task` with `budget: "bench-good"` (or `bench-fast` for pure doc tasks). Do **not** hand-edit `config/task.toml`.

## Code quality bar (enforced at commit)

* Handle errors explicitly — no empty catches. No commented-out code in committed files. Docs updated **before** `jj commit`. Regression test per fix.
* Pre-commit self-check: tested (regression test fails without change), non-fragile (derive from source of truth, no hardcoded counts/paths), minimal complexity, maintainable, extensible.

## Repo state as of this handoff

```
@  nrqxvkvn 74362835 (empty) (no description set)
◆  vlklrxkv e8e28d6d main — task: An automated parity harness …
◆  qzqomltz babae49e      — task: Build DAG orchestration …
◆  sutqzulw 3ea5f025      — fix(v2): recover M5a commit …
◆  ylslztxy 913bf44c      — feat(v2): read-only workflow survey …
…
```

* `main` = `vlklrxkv e8e28d6d` ("An automated parity harness feeds the same spec DAG to v1 and to v2's /build and reports parity using M0 smoke tests as oracle"). `jj git push --bookmark main` done. `jj workspace list` = `default` only; `@` empty with `@- = main`. `/tmp/pi-task-parallel-*` dirs are stale engine artifacts (do not manually delete — engines GC them; `jj workspace forget` is the cleanup path).
* Total commits: ~115 (`jj log -r 'all()' | wc -l`). No divergent heads.

### jj hygiene (required reading before any jj work)

* Skill: `skills/jj/SKILL.md` — `fetchIfRemote` before work, solo-main vs multi-author bookmarks, `execJj` timeouts, `jj operation restore` for turn-exhaustion left-behind commits.
* Push: `jj bookmark move main --to @- && jj git push --bookmark main`. Solo repos push `main`; `--change` only for PR-style.
* Parallel workspaces respawn: `task` tool creates `pi-task-<id>-0/1` workspaces via `jj workspace add`; they vanish only after `jj abandon` + `jj workspace forget` (+ engine GC of `/tmp/.../.jj`). Order matters — forget before the underlying `.jj` is gone respawns. If you see reappearing heads, check `jj workspace list` and `jj op log`.
* Empty scaffold commits left by aborted `task` runs are expected — recover via `jj operation restore <id>` then `JJ_EDITOR=true jj squash` into the original change id, move `main`, push, abandon empties.

## What is done (M0–M5 + reviews)

### Docs reshaping

* 427-line original spec split into 3 docs: `pi-task-v2.md` (contract) + `pi-task-v2-subsystems.md` (schemas/seams/DDL) + `pi-task-v2-future.md` (E.1–E.6). Full v1 disposition table (§5), per-attempt turn budgets, verbatim merge ladder, layered grounding. Follow-up fixes: FR reordering FR-1–FR-11 + FR-5 ladder, autonomy L1/L2/L3 with quota-blind spend (FR-10), hosted-session architecture (daemon hosts ALL sessions), `ControlSurface` 6th seam, `attemptNumber` ledger-only.

### M0 — Engineering bar

* `packages/core-v2/tsconfig.json` strict (`src/**/*.ts` + `test/**/*.ts` only; `extensions/task/**` excluded).
* 6 kernel contracts + Zod payloads (`contracts/`), `node:sqlite` `LedgerStore` (tables `tasks`, `micro_sessions`, `routing_feedback`, `workspaces`; WAL + migrations), suite-03 bench harness (210 files ~100k LOC, `GROUNDING_SPECS`), baselines 33s/53s $0, `mise run test` includes core-v2.

### M1 — Core daemon

* `src/router/route.ts` (`routeTask` pure), `src/sessions/host.ts`+`tools.ts` (`yield`/`checklist`), `src/guards/watchdogs.ts`+`watchdog-driver.ts`+`artifacts.ts`, `src/verify/run.ts`, `src/daemon/task-runner.ts` (`deriveTaskId`+`resolveAttemptId`, `SpecValidationError`, `emptyUsage/collectUsage/receiptUsageFields`), `src/daemon/start.ts` (`reconcileOnBoot`), `test/e2e-parity.ts` 11s ship. Hermetic suites green; architecture review `docs/architecture-review-v2.md` filed, P0 id collision + P1s fixed.

### M2 — Workspaces & environments

* `src/environments/drivers.ts` (`HostEnvironmentDriver`/`MiseEnvironmentDriver`, `ENV_TIMEOUT_EXIT_CODE` 124), `src/workspaces/jj.ts`+`jj-driver.ts` (`execJj`, `mergeWorkspacesAtomic`, `resolveConflictsWithUnion` via `git merge-file --union`, `assertMerged`, `fetchIfRemote`), `src/daemon/parallel.ts` (`runParallelTask`), `test/e2e-parallel.ts`. 11 suites green.
* Review `docs/architecture-review-v2-m2.md`: P0 re-run impossible (gate-ordered cleanup, `resolveAttemptId`) + P1s (stale bookmark, ladder bare escape, per-worker premature `completed`, `checkoutMerged`→`materialize`) fixed.
* P2s (`10fd1860`): M6 `EnvironmentVerificationDriver`+`verifyThroughEnvironment` (injectable `VerifyOptions.exec`), M7 `routing_feedback` vocabulary (`cold` per-worker hit/miss, single-lane miss), M8 escalate path + binary conflict via real union ladder (`git merge-file` exits 255) + suite header. Pushed.

### M3 — Grounding & economics

* **Part 1** (`5e0ef5a7`): prewalk as off-by-default swappable policy — `SessionHandle.stats()` (`AgentSession.getSessionStats` `tokens.{input,output,cacheRead,cacheWrite,total}` + `cost`) + `setModel(modelId)` (`AgentSession.setModel`), `src/grounding/prewalk.ts` pure `decidePrewalkSwap` (stay `N×(strong cacheRead+output)` vs swap `ctx×cheap uncached + (N-1)×cheap cached`; break-even `swapPenalty/perTurnSaving`), fires once on first successful `edit`/`write`, `options.prewalk?: {enabled, modelId, pricing, remainingTurnsEstimate}` on the runner.
* **Part 2** (`9748e74b`): COR/token/USD on `TaskReceipt` (NFR-3) — `contracts/payloads.ts` adds `inputTokens/outputTokens/cacheReadTokens/cor` (cor=`groundingTokens/totalInput`, `totalInput=input+cacheRead+cacheWrite`, `costUsd` from `SessionStats.cost`), helpers `emptyUsage/collectUsage/sumUsage/receiptUsageFields`, watchdog-abort preserves usage.
* **Remainder** (4 workers merged `72cfc197`→`0afdc6ba`): `src/grounding/bundle.ts`+`test-bundle.ts` (`ExecutionBundle` + `bundleHit` + `routing_feedback` miss), `src/continuation/pruner.ts`+`test-continuation.ts` (pluggable `ContinuationScorer` `(entries[],budget)`→`entries[]`, `recencyTool`/`uniform`, retry-shift), `src/grounding/review-fork.ts`+`test-review-fork.ts` (file-budget scorer, anchors pinned, merge-union safe), `src/bench/grounding-*`+`extensions/task/grounding-eval.ts`+`test-grounding-eval.ts` (`mise run eval-grounding` dry plan, NFR-3/4 normalized). 16 suites green.

### M4 — Plugin kernel

* `d5a209b5`: `contracts/gateway-events.ts` (`TaskLifecycleEvent` union + `TASK_LIFECYCLE_EVENTS`/`eventTypeOf`), `src/gateway/{in-memory.ts,surface.ts,errors.ts,index.ts}` (`InMemoryTaskGateway` `emit/on(pattern,* wildcard)/getTaskState/getManifest`), daemon emission after ledger writes, `test/test-gateway.ts`. 17 suites.
* `1025cafc` (parallel with next): `src/plugins/{loader.ts,hooks.ts,errors.ts,index.ts}` (`task.toml [plugins] paths`, `PluginLoadError`, `transformExecutionBundle/transformHandoff` sequential + schema re-validation + per-call isolate), `src/surfaces/null-surface.ts` (QoS `delta⊃digest⊃receipts`, `permission.requested` routed), `test/test-gateway-plugins.ts`, `test/test-surfaces.ts`. 19 suites.
* `a6ee76f4` (parallel): `src/plugins/builtin/handoff-cap.ts` (60kB cap) + `lifecycle-collector.ts` (`registerTriggers/onLifecycleEvent`), deduped from `daemon/task-runner.ts`; `test/test-plugins-handoff-cap.ts`, `test/test-plugins-lifecycle.ts`; docs aligned + migration inventory + `packages/core-v2/README.md` plugin guide. 21 suites, pushed.
* Review `docs/architecture-review-v2-m4.md` (ox-alpha economy, 0 commits): P0-1 dead `registerTriggers`, P0-2 `NullSurface` leak/filter, P1-1 `permission.requested` bypass, P1-2 `getManifest` zeroes, P1-3 `python3 -c tomllib` dep, P1-4 core-shrink overstated, P1-5 bundle-miss conflation + P2s.
* Fix `7ef5dcf6` (15 files): `permission.requested` added to events/union, `loader.ts` pure hand-parser (no `python3`), `hooks.ts:110` `registerPluginTriggers` wired before run, bundle-miss `hit=0`/`onHandlerError`, `eventMatchesPattern` dot-segment, surface session filtering/waiter/StatusSnapshot honesty. Then `fad6a634`: deduplicate gateway union (bare `task.completed/failed/escalated` trio removed, `;` terminator fix for `TS1109`). `mise run test` green, `main` at `fad6a634`.

### M5 — Workflows (a → (b+c) → d → e)

* **Wave 1** (2-way `sub_specs` bench-good): `M5c` survey `ylslztxy 913bf44c` (`src/workflow/survey.ts` 430 lines bounded read-only reconnaissance + typed `SurveyReport`, `test/test-workflow-survey.ts` 295 lines, `gatewaySurveyGate` via `permission.requested`); `M5a` planning-only 68-turn yield left as invisible head `sutqzulw` then recovered via `jj rebase -r sutqzulwookn --onto szzoxqux` + `test/run-all.ts` union resolve (`runWorkflowPlanTests` + `runWorkflowSurveyTests`), squashed `3ea5f025` (`src/workflow/plan.ts` 159 lines `parseTaskSpec`, `dag.ts` 143 lines Kahn + cycle/fan-out, `gate.ts` 61 lines `workflow_approvals` ledger v2 `approved=false` dry / `true` --approve, `test/test-workflow-plan.ts` 221 lines). 23 suites green, pushed.
* **Wave 2** (`/build`) three economy failures (51/8/8 turns, 0/6 verified) abandoned via `jj op restore 82ec0f2e8c25`; split bench-good 2-way succeeded `babae49e` 19m22s 6/6 (`src/workflow/build.ts` 77 lines `BuildGateError`, `src/workflow/scheduler.ts` 172 lines ready-set + `max_parallel` + failed→skipped with `routed→completed/failed/skipped`, `src/workflow/receipts.ts` 222 lines `BuildSummary` over `TaskReceipt` usage/COR, `test/test-workflow-build.ts` 298 lines, `test/test-workflow-receipts.ts` 247 lines). `test/run-all.ts` now 25 suites. Push confirmed (`PUT 105` fix — `verificationCommands` field).
* **Wave 3** (parity harness) bench-good single task 50-turn exhaustion aborted; left commit `vlklrxkv 24d97ee2` (8 files 1269 ins: `src/parity/{canonical-dag.ts,harness.ts,index.ts,report.ts,types.ts,v1-surface.ts,v2-build.ts}`, `test/test-parity-m5.ts` 424 lines). Recovered via `jj operation restore 0e61bdebc169/9785e809d9cc/c03df8c9e1c4/ca16c41f5556/5a154e655ae4` + direct patch/squash (`JJ_EDITOR=true jj squash`) into `vlklrxkv e8e28d6d` (44 ins/27 del): `v1-surface.ts` normalize from original spec not `splitSpec` sub-spec (which replaces Verification), `canonical-dag.ts` typed `CanonicalDagError`, `harness.ts` dry→`dryV1Executor` default, `report.ts` both-skipped short-circuit + `round6`, `v2-build.ts` `DagNode.dependsOn` from canonical `dependsOn` array (scheduler short-circuit), `test/run-all.ts` registers `parity-m5`. 26 suites `✓ core-v2: 26 suite(s) passed (zero LLM)`, `mise run test` green, `main` → `e8e28d6d`.

### jj cleanup (post-M5)

Orphan `pi-task-54se-*` commits (`lmzynxuw 51084fba`, `nttyrqpx 7a4bc53b`, `svonmtyw 644a551d`, `opvunwpk 45361297`) + respawned heads (`xutonomo/rxunxkzk`, `lnmkrwxl/rspqrnqx`, `qvuvrpvl/tvuotzup`, `tsormlpt/vpyrtlvr`) abandoned + workspaces forgotten; invisible `sutqzulw` rebased; empties abandoned. Leaves `main` linear and `visible_heads()` = `@` only. See `jj op log` for operation ids (`0e737db07c85` etc.).

## Current TODOs (13 open — `todo list`)

| # | Pri | Title | Disposition |
|---|---:|---|---|
| 29 | P1 | Wave 4 / session_id residual — passive real-run confirmations (docs/cost-reduction-plan.md "Residual verification"): (1) session_id in outbound payload, (2) `reasoning.exclude` multi-turn continuation survives. One `test-e2e.ts` real run covers both. | **Do next** — manual `openrouter/stealth/ox-alpha` smoke, mark "confirmed" in cost-reduction-plan. |
| 31 | P1 | v2/M3 grounding modes | **Stale** — M3 landed (prewalk/bundle/fork+prune/COR/eval-harness). Close or re-scope. |
| 32 | P1 | v2/M2 workspaces & environments | **Stale** — M2 landed (jj ladder + env drivers + parallel). Close. |
| 35 | P1 | Diagnose `/task-budget` lock (bench-good) not taking effect | Needs `before_provider_request` dump or `resolveBudgetTier` probe; see `extensions/task/bench-regression.ts` + `~/.pi/agent/config/task.toml`. |
| 12–14 | P2 | Architecture candidates Strong/Worth (1–3): shared pi-RPC session runner, split `orchestrator.ts` (preserve `computeDiff` fail-fast), extract `index.ts` pure core | From `docs/architecture-review.md`; consider after M5. |
| 20 | P2 | Discord-bridge completion notifications (`results/` watch) | After M5 settlement. |
| 23 | P2 | Detached-run shape serialization — `shape.name` missing in child → manifest records `code/sync` for `async/flex` run | Hermetic fix, no LLM. |
| 15–16 | P3 | Architecture candidates 4–5: delete dead `mergeWorkspace`, collapse options-plumbing | Speculative. |
| 18–19 | P3 | Review findings: report cards 3–5 vocabulary, `computeDiff` rejection semantics in card 2 | Doc cosmetics. |

## Next steps (recommended order)

1. **Hygiene: close stale TODOs** — `todo done` for #31, #32 (or one verification run: `mise run test` + `mise run typecheck`).
2. **M5e — Migration inventory / cutover docs / flip** (owns §8 four-phase transition; no deletions in M5 — `docs/pi-task-v2-subsystems.md §5` already lists the rows).
   - Update `docs/pi-task-v2-subsystems.md §5` shadow→flip state where the v2 home now carries a real-path test.
   - `packages/core-v2/README.md` <25-line "how to shadow then flip" guide (where parity harness lives, how to run dry vs real, what flip flips).
   - `mise.toml` `parity-m5` task entry (`scripts/parity-m5.sh` is optional — harness is the source of truth).
   - `config/task.toml` gateway: `[workflow] engine="v2"` flag (assumed; do not edit without permission — propose in the spec).
   - Dispatch as one `bench-good` task (4–7 files, 300–600 lines) — do not delete v1 code in this milestone.
   - Verify: `mise run test`, `mise run typecheck`, harness dry run (`npx tsx packages/core-v2/test/test-parity-m5.ts`).
3. **M5f — Reviewer loop + headless dispatchers** (post-flip) — gateway-driven review fork + `ControlSurface` consumers (scheduler/cron/CI). Deferred until flip evidence exists.
4. **P1 hygiene in parallel (small dispatches):**
   - **#29**: one real `timeout 1200 npx tsx packages/core-v2/test/e2e-parity.ts` (or `test-e2e.ts`) on `openrouter/stealth/ox-alpha`; inspect `before_provider_request` payload for `session_id` and verify `reasoning.exclude` continuation does not corrupt signatures. Then mark `docs/cost-reduction-plan.md` sections "confirmed".
   - **#35**: reproduce budget-lock dispatch via `before_provider_request` dump or `resolveBudgetTier` unit probe; fix in v1 (`extensions/task/index.ts` / `config.ts`) or document as won't-fix.
   - **#23**: hermetic shape `name` round-trip fix (serialize `shape.name`, re-resolve in child, `TaskShape` carries `name`).

## Key files for the next milestone

* `docs/pi-task-v2.md` §8 — exit criteria; `docs/pi-task-v2-subsystems.md` §5 — migration inventory (authoritative per-row phase ownership).
* `packages/core-v2/src/workflow/{plan.ts,dag.ts,gate.ts,build.ts,scheduler.ts,receipts.ts,survey.ts}` — M5 workflow.
* `packages/core-v2/src/parity/{canonical-dag.ts,harness.ts,report.ts,types.ts,v1-surface.ts,v2-build.ts,index.ts}` — parity harness; `test/test-parity-m5.ts` (R1–R5, oracle reuse, dual-feed dry/real, report diffs, exit 0 parity).
* `packages/core-v2/src/contracts/gateway-events.ts` (`TASK_LIFECYCLE_EVENTS`, `permission.requested`), `contracts/task-plugin.ts` (`registerTriggers/transform*`), `contracts/control-surface.ts`, `gateway/in-memory.ts`, `plugins/loader.ts` (hand-parser), `plugins/hooks.ts:110` `registerPluginTriggers`, `surfaces/null-surface.ts`.
* `src/workspaces/jj.ts` / `jj-driver.ts` (ladder verbatim), `src/environments/drivers.ts`, `src/daemon/{task-runner.ts,parallel.ts,start.ts}`, `src/grounding/{prewalk.ts,bundle.ts,review-fork.ts}`, `src/continuation/pruner.ts`, `src/verify/run.ts`+`verify/adapter.ts`, `src/ledger/store.ts` (`workflow_approvals`, `routing_feedback` `cold` vocabulary).
* `test/run-all.ts` (26 suites), `packages/core-v2/tsconfig.json` (FR-11 gate).

## Verification checklist (run after every change)

* `npx tsc --noEmit -p packages/core-v2/tsconfig.json` (core-v2 strict)
* `npx tsx packages/core-v2/test/run-all.ts` (26 suites, zero LLM)
* `npx tsx packages/core-v2/test/test-parity-m5.ts` (harness, hermetic)
* `mise run test` (v1 + core-v2 aggregate)
* `mise run eval-grounding` (dry plan, zero LLM) — after grounding changes
* For the next dispatch: `task` tool with `budget: "bench-good"` (or `bench-fast` for doc-only), 50 turns, model `openrouter/stealth/ox-alpha`.

## Known gotchas

* `extensions/task/bench-regression.ts`: `spec: opts.spec.specMarkdown` (not bare spec), `reviewRequested` ReferenceError guard already fixed; always use a temp `--metrics-dir` for baseline-recording runs.
* `extensions/task/test.ts` is read-only for v2 harness (import via `// @ts-ignore` or `../../../../extensions/...` relativity).
* `splitSpec` lives in `extensions/task/orchestrator.ts:971` and replaces Verification with Scope boilerplate — parity harness must normalize from the **original** canonical spec (`originalSpecMarkdown`), not sub-spec.
* `parallel.ts` uses `DagNode.dependsOn` from canonical DAG `dependsOn` array, not `## Depends On` markdown parse, so scheduler short-circuit fires.
* `compareNodes` short-circuits both-skipped (`passed:true, mismatches:[]`), `round6` cost delta, no file-name `filesChanged.length` noise (NFR-4).
* Economy workers (8–29 turns) yield 0/6 on M5 — bench-good required.
* Turn-exhaustion leaves behind a scaffold commit — recover via `jj operation restore` + patch + `JJ_EDITOR=true jj squash`.

## Contacts / history

* Owner: `danielong1@gmail.com` (jj author), `noreply@danong.dev` for task-engine commits.
* v1 phases 1–10: see `docs/pi-task-phase{1,6,9,10}-handoff.md`.
* v2 milestones: `docs/pi-task-v2.md` §8, commits `e7cc7a9c → 5e0ef5a7 → 72cfc197 → d5a209b5 → ylslztxy/3ea5f025 → babae49e → e8e28d6d` (M0→M5 parity harness).

