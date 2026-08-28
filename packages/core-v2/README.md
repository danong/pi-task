# core-v2 — Project Tau bootstrap package

Strict-typed kernel for [Project Tau](../../docs/pi-task-v2.md), the engine currently identified in code as `pi-task-v2`. Tau is the working M6 standalone product name; package, CLI, and state identifiers remain unchanged until extraction. This subtree holds the typed contract seams, ledger, context lifecycle, providers, daemon, and hermetic tests. It is a type-checked island **excluded** from the v1 `pi-task` engine under [`extensions/`](../../extensions/).

Source of truth is [`docs/pi-task-v2.md`](../../docs/pi-task-v2.md) and [`docs/pi-task-v2-subsystems.md`](../../docs/pi-task-v2-subsystems.md); [`docs/pi-task-v2-future.md`](../../docs/pi-task-v2-future.md) is deferred work. Historical material is archived under [`../../docs/old/`](../../docs/old/README.md) and is non-normative. The accepted context ownership decision is [`adr/context-control-plane.md`](../../docs/adr/context-control-plane.md).

## Status

Implementation is authoritative for shipped behavior.

| Milestone                                 | State                  | What it proves                                                                                                                                                                      |
| ----------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1** trace + ledger + router            | ✓ shipped              | Versioned, bounded, provider-neutral trace; `measured`/`unavailable` usage; routing                                                                                                 |
| **M2** policy + workspace                 | ✓ shipped              | Strict `## Artifact Policy` ingress; engine-owned jj finalization + verification; acceptance                                                                                        |
| **M3** worker + yield                     | ✓ shipped              | Requirement-sensitive checklist; one-shot `yield`; engine-owned VCS/verification                                                                                                    |
| **M4** context control plane              | ✓ shipped              | Kernel-owned plans, artifact store, economic/window/attention budgets, cache-affine assembly, checkpoints, epochs                                                                   |
| **M4.1** verification + observability     | ✓ shipped (`b10b3636`) | Measured `durationMs`, bounded `VerificationEvidence` (24 digests, `executed/expected/omitted/capped`), `stage/code` taxonomy, `run:` announcement + artifact paths, `trace-report` |
| **M4.2** independent execution budgets    | ✓ shipped              | `maxTurns` and wall timeout remain independent (`--max-turns`/`--wall-timeout-ms`); `budget_exceeded` vs `wall_timeout` stay distinct; final usage remains measured in receipts/metrics. `maxCostUsd` is rejected until provider-neutral live cost signals exist. |
| **M5** durable sequential continuation       | shipped; hardening active | Bounded parent→child handoff and provider-owned workspace continuation; post-land blockers must pass repository gates before hardening is shipped |
| **M5.5** practical attempt recovery           | planned                 | Passive JSON journal, provider-neutral checkpoints, run-ID resume/fork for every attempt, and engine-owned settlement                      |
| **M6** Project Tau extraction/cutover         | planned                 | Standalone Tau repository/default, external v1 archive, real-task dogfood, and cohort plugin experiments                                  |

`src/version.ts` is `CORE_V2_MILESTONE="M5"` / `CORE_V2_VERSION="0.0.0-m5"`.

Fixtures under [`test/fixtures/`](./test/fixtures/) are evidence inputs for derivation/reporting, not performance claims. `test/fixtures/m4-proof/` holds a minimal matched Luna smoke (neutral report); `test/fixtures/dogfood/m41-verification-timeout.trace.json` is a retained timeout (`67 turns, $0.19, prompt exceeded 600000ms`) that motivated execution caps.

## Quickstart

```sh
mise run v2 -- --spec ./task.md --project-dir . --model provider/model
# One bounded durable continuation child (raw context in the M5 surface):
mise run v2 -- --spec ./parent.md --child-spec ./child.md --project-dir . --model provider/model
# Active M5 hardening exposes edge resume; M5.5 will replace this internal
# selector with public status/resume/fork operations by run ID:
mise run v2 -- --resume <edge-id> --project-dir . --model provider/model
# or PI_TASK_V2_MODEL=provider/model mise run v2 -- --spec ./task.md --project-dir .
```

Spec must contain `Goal`, `Requirements`, `Verification`, and a strict `## Artifact Policy`:

```markdown
## Artifact Policy

- Required: reports/result.json
- Change required

# or: - Intentional no-change
```

Paths are repository-relative; strict ingress rejects missing/empty/unsafe/duplicate/contradictory/unknown entries. The CLI validates before provider work, provisions an isolated jj workspace, runs and verifies the task, and atomically delivers `<runId>.trace.json` + `<runId>.receipt.json` under project-keyed user state (`XDG_STATE_HOME` when set, else `~/.local/state`). `--child-spec` selects the M5 daemon-owned parent→child path: the child receives bounded declarative state, not a transcript; its workspace continuation and checkpoint can be resumed from durable state after restart. The aggregate receipt ships only after child settlement and admitted evidence persistence. It announces `run: <attemptId>` early and prints `receipt/trace/failure artifact:` at termination. `attemptId` is `familyId` or `familyId-a2…`; `specHash`/`familyId`/`engineVersion` are on `model.assigned`.

Context: `--context raw` (default, empty plan) or `--context symbol-tree` (opt-in bounded handles + `context` query/resolve tool). Raw has no index dependency; symbol-tree failures degrade explicitly. The active hardening interface `--resume <edge-id>` is mutually exclusive with submission options; unknown edges are usage errors, durably blocked edges fail, and selecting a terminal edge is an idempotent success. This edge-oriented surface is not the final M5.5 run-ID recovery UX. See [context-control-plane ADR](../../docs/adr/context-control-plane.md).

### Execution bounds and cost accounting

`--max-turns` and `--wall-timeout-ms` are supported independently, including durable sequential checkpoint/preserve and resume behavior. `maxCostUsd` / `--max-cost-usd` is not an execution cap: new CLI and daemon submissions reject it with an actionable unsupported-live-cost error because provider-neutral live cost interruption signals do not exist yet. The engine still records measured final usage, including cost, in receipts and metrics; it does not add live cost telemetry or relabel settled work as a cost interruption. Historical serialized receipts and configuration remain readable where applicable.

## Observability

Every run emits a canonical, versioned, provider-neutral trace ([`src/contracts/trace.ts`](./src/contracts/trace.ts), [`src/contracts/gateway-events.ts`](./src/contracts/gateway-events.ts)). Canonical traces, receipts, and handoffs never store transcripts or private reasoning. Planned M5.5 local attempt journals are a separate operational recovery store: they passively retain bounded visible Pi JSON messages/tool pairs for failed or in-flight attempts, are deleted/expired by policy, and never become canonical artifacts.

- **Verification:** per-command `durationMs` (injectable clock), bounded `VerificationEvidence` (`index/digest/exitCode/timedOut/durationMs`, `executed/expected/omitted/capped` with `executed ≤ expected` and `capped == omitted>0`, capped at 24), never `command`/`stdout`/`stderr` text — tails stay in `.failure.json`.
- **Failures:** every terminal `task.failed` carries `stage` (`setup/context/session/workspace/verification/acceptance/delivery/workflow/internal`) and `code` (`session_timed_out/budget_exceeded/worker_failed/verification_failed/...`) across CLI, single-run, parallel, and scheduler paths; supported `budget_exceeded` (`maxTurns`) never conflates with `wall_timeout`, and settled cost is never converted into an interruption. `FORBIDDEN_DETAIL_KEY` blocks `transcript`/`reasoning`/`stdoutTail`/`output` etc. while allowing legitimate `tool.started:command`.
- **Debug one run:**
  ```sh
  mise run trace-report -- <trace.json> [report.md]
  ```
  Renders outcome, model/engine/specHash/family/attempt, elapsed, turns/tools/errors/repeated-reads, context `selected/omitted/tokens/cache`, verification `executed/expected` + measured time, failure `stage/code/cause`, usage, and sibling `receipt`/`failure` presence — no output tails.
- **Aggregate:**
  ```sh
  mise run bench-report -- --traces-dir <dir> --label <label>
  mise run m4-proof -- <evidence.json> [report.md]   # matched raw vs symbol-tree proof
  mise run context-eval                             # dry plan, no LLM
  mise run context-report -- <trace.jsonl>          # canonical evidence only
  ```

## Layout

| Path                                           | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/contracts/`](./src/contracts/)           | Six seams, one file each, no shared mutable state: `payloads.ts` (Spec/ExecutionBundle/Yield/HandoffBundle/TaskReceipt as zod, `serialize.ts` byte-stable), `context-lifecycle.ts` (M4.1 plans, budgets, cache, checkpoints, epochs) + `context-provider.ts` (compat) + `verification-driver.ts` (bounded evidence, 24 digests), `workspace-driver.ts`, `environment-driver.ts`, `context-compressor.ts`, `task-plugin.ts`, `control-surface.ts`, `gateway-events.ts` (`stage/code`), `trace.ts`, `index.ts` barrel |
| [`src/context/`](./src/context/)               | M4.1 lifecycle: `acquisition.ts` / `provider-adapter.ts` (explicit acquisition/materialization caps), `raw-provider.ts` / `symbol-tree.ts` + `providers.ts`, `artifact-store.ts` (content-addressed, project-keyed user state), `planner.ts`/`assembler.ts`, `checkpoint.ts`, `epoch.ts`, `retrieval.ts`                                                                                                                                                                                                            |
| [`src/ledger/store.ts`](./src/ledger/store.ts) | SQLite (`node:sqlite`, zero deps): tasks, attempts/sessions, edges, provider-owned workspaces/continuations, and additive boot reconciliation. M5.5 attempt journals remain behind a separate typed store capability rather than embedding provider/session bodies in ledger rows.                                                                                                                                                                                                                                                     |
| [`src/router/route.ts`](./src/router/route.ts) | Pure `routeTask(spec,tier,feedback) → {planMode,tier,lane}` + thresholds                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| [`src/sessions/`](./src/sessions/)             | `host.ts` (one pi SDK `AgentSession` per role, typed model resolution), `tools.ts` (`yield`/`checklist`), `context-tool.ts` (bounded acquisition tool)                                                                                                                                                                                                                                                                                                                                                              |
| [`src/guards/`](./src/guards/)                 | `watchdogs.ts` (pure settle/no-progress/wall/per-tool/maxTurns decisions) + `watchdog-driver.ts` + `artifacts.ts` (capped `.failure.json`)                                                                                                                                                                                                                                                                                                                                                  |
| [`src/daemon/`](./src/daemon/)                 | `task-runner.ts` (validate→route→guarded session→yield→verify→ledger→receipt, NFR-3 `SessionHandle.stats()` + COR, execution budgets), `parallel.ts` (isolated vs N-worker combine→single verify gate, budget cap gate), `isolated.ts` (single-task adapter), `sequential.ts` (M5 durable parent→child prepare/resume/settlement), `start.ts` (edge-aware boot reconcile)                                                                                                                                        |
| [`src/verify/`](./src/verify/)                 | `run.ts` (per-command timeout, suite wall + bounded grace, capped tails, `durationMs`) + `adapter.ts`                                                                                                                                                                                                                                                                                                                                                                                                               |
| [`src/environments/`](./src/environments/)     | `HostEnvironmentDriver` + `MiseEnvironmentDriver` (capability-detected)                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [`src/workspaces/`](./src/workspaces/)         | Current Jujutsu provider (`jj-driver.ts`) plus failure hygiene. Kernel code consumes `contracts/workspace-driver.ts`; isolation, snapshot, restore/fork, preservation, integration, and publication use opaque capability tokens so Git, SVN, remote, or other providers can conform without daemon branches.                                                                                                                                                                                                        |
| [`src/bench/`](./src/bench/)                   | `benchmark.ts`/`report.ts` (trace→BenchmarkRecord), `trace-report.ts` (single-run explainer), `context-evaluation.ts`/`m4-proof.ts`, `grounding-*` (M3 suite-03)                                                                                                                                                                                                                                                                                                                                                    |
| [`src/version.ts`](./src/version.ts)           | `CORE_V2_MILESTONE` / `CORE_V2_VERSION`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [`src/plugins/`](./src/plugins/)               | Config-driven loader (`loader.ts` typed `PluginLoadError`, `hooks.ts` throw-isolated + re-validated)                                                                                                                                                                                                                                                                                                                                                                                                                |

## Gates

Hermetic (zero LLM, zero network) unless noted. Run from repo root.

| Gate                                    | Command                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Typecheck (only this subtree)           | `mise run typecheck` (`packages/core-v2/tsconfig.json`)                                                             |
| All hermetic suites                       | `mise run test` (`run-all.ts` is the source of the current suite list)                                            |
| Core-v2 only                            | `npx tsx packages/core-v2/test/run-all.ts` or `npx tsx packages/core-v2/test/<suite>.ts`                            |
| Context dry plan                        | `mise run context-eval`                                                                                             |
| Single-run explainer                    | `mise run trace-report -- <trace.json> [report.md]`                                                                 |
| Matched proof                           | `mise run m4-proof -- <evidence.json> [report.md]`                                                                  |
| Benchmark aggregate                     | `mise run bench-report -- --traces-dir <dir> --label <label>`                                                       |
| Grounding (M3 suite-03, dry by default) | `mise run eval-grounding` / `mise run eval-grounding -- --run` (real LLM, needs `--allow-strong` for strong models) |
| Parity e2e (manual, real LLM)           | `timeout 1200 npx tsx packages/core-v2/test/e2e-parity.ts` (skips 0 without auth)                                   |

Bench regression runner (`extensions/task/bench-regression.ts --tier bench-good --spec grounding-anchor --dry-run`) is a manual LLM gate, never part of `mise run test`.

## M5.5 target architecture

- **Attempt lineage:** every admitted task, reviewer, repair worker, and sequential child has resumable/forkable attempt state; continuation is not owned by child edges.
- **Passive journal:** the session-host adapter writes normalized visible Pi JSON events with zero additional successful-run model turns/tokens.
- **Cheap checkpoints:** each completed turn records a journal cursor, context identity, usage, and optional opaque workspace snapshot token.
- **Full resume:** compatible visible history and current workspace continue after transient provider/process/budget failure.
- **Partial fork:** deterministic context selection starts from a chosen turn/checkpoint with current/checkpoint/clean workspace policy, optional model/budget changes, and corrective instructions.
- **Engine settlement:** integrated work satisfying artifact policy and verification can ship without a final model-authored `yield`; summaries may be unavailable.
- **Public UX:** status, checkpoints, resume, and fork use run IDs and explain preserved state or blockers without exposing provider internals.
- **Boundaries:** journal store, session continuation, context compilation, and workspace snapshot/restore are typed replaceable capabilities with deletion and conformance tests.

These bullets are an approved design target, not shipped CLI documentation. The product contract defines the exit gates.

## Plugins

1. One file, one default export `TaskPlugin` ([`src/contracts/task-plugin.ts`](./src/contracts/task-plugin.ts)): `name` + optional `registerTriggers`/`transformExecutionBundle`/`transformHandoff`/`onLifecycleEvent`.
2. List under `[plugins] paths = [...]` in `task.toml` (relative to `cwd`); bad entries fail typed (`PluginLoadError` in [`src/plugins/errors.ts`](./src/plugins/errors.ts)).
3. One hermetic test via `loadPluginsFromToml`/`importPluginAt` ([`src/plugins/loader.ts`](./src/plugins/loader.ts)) + `src/plugins/hooks.ts` — pure-helper-only coverage does not pass review (FR-11). See [`test/test-gateway-plugins.ts`](./test/test-gateway-plugins.ts).
4. Do not implement replaceable effects as generic lifecycle hooks. Workspace/VCS, journal storage, session continuation, context acquisition/selection, editing, verification, and artifact delivery are explicit capability providers selected by configuration. Observers remain non-authoritative.

Further reading: [product contract](../../docs/pi-task-v2.md), [subsystems](../../docs/pi-task-v2-subsystems.md), [future](../../docs/pi-task-v2-future.md), [v1 design](../../docs/pi-task-design.md).
