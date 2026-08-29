# core-v2 — Project Tau bootstrap package

Strict-typed kernel for [Project Tau](../../docs/pi-task-v2.md), the agent-facing execution substrate currently identified in code as `pi-task-v2`. Tau's north star is verified delegated software work per inference spend and developer attention. Tau is the working M6 standalone product name; package, CLI, and state identifiers remain unchanged until extraction. This subtree holds the typed contract seams, ledger, context lifecycle, providers, daemon, and hermetic tests. It is a type-checked island **excluded** from the v1 `pi-task` engine under [`extensions/`](../../extensions/).

Source of truth is [`docs/pi-task-v2.md`](../../docs/pi-task-v2.md) and [`docs/pi-task-v2-subsystems.md`](../../docs/pi-task-v2-subsystems.md); [`docs/pi-task-v2-future.md`](../../docs/pi-task-v2-future.md) is deferred work. Historical material is archived under [`../../docs/old/`](../../docs/old/README.md) and is non-normative. The accepted context ownership decision is [`adr/context-control-plane.md`](../../docs/adr/context-control-plane.md). The current M5 closure authority is [`reports/m5-hardening-closure.md`](../../reports/m5-hardening-closure.md); older M5 review reports remain historical evidence with their original findings.

## Status

**Active M5 hardening: closed; ready to begin M5.5 subject to repository gates.**
Implementation is authoritative for shipped behavior.

| Milestone                                 | State                  | What it proves                                                                                                                                                                      |
| ----------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1** trace + ledger + router            | ✓ shipped              | Versioned, bounded, provider-neutral trace; `measured`/`unavailable` usage; routing                                                                                                 |
| **M2** policy + workspace                 | ✓ shipped              | Strict `## Artifact Policy` ingress; engine-owned jj finalization + verification; acceptance                                                                                        |
| **M3** worker + yield                     | ✓ shipped              | Requirement-sensitive checklist; one-shot `yield`; engine-owned VCS/verification                                                                                                    |
| **M4** context control plane              | ✓ shipped              | Kernel-owned plans, artifact store, economic/window/attention budgets, cache-affine assembly, checkpoints, epochs                                                                   |
| **M4.1** verification + observability     | ✓ shipped              | Measured verification duration, bounded structural evidence, `stage/code` taxonomy, `run:` announcement + artifact paths, `trace-report` |
| **M4.2** independent execution budgets    | ✓ shipped              | `maxTurns` and wall timeout remain independent (`--max-turns`/`--wall-timeout-ms`); `budget_exceeded` vs `wall_timeout` stay distinct; final usage remains measured in receipts/metrics. `maxCostUsd` is rejected until provider-neutral live cost signals exist. |
| **M5** durable sequential continuation    | ✓ shipped; hardening closed | Bounded parent→child handoff and provider-owned workspace continuation; repaired hardening is ready for M5.5 subject to repository gates |
| **M5.5** cheaper linear retry                 | planned (not implemented) | Engine settlement, bounded continuation-relevant failed state, and run-ID resume of the latest failure; no strategy recovery              |
| **M6** Project Tau default/cutover            | planned                 | Tau default, external v1 archive, and systematic capture of real-task outcomes/failures                                                    |

`src/version.ts` is the source of the current engine milestone and version.

Fixtures under [`test/fixtures/`](./test/fixtures/) are evidence inputs for derivation/reporting, not performance claims. The retained timeout fixture under `test/fixtures/dogfood/` motivated execution caps; consult the fixture and source for its details.

## Quickstart

```sh
mise run v2 -- --spec ./task.md --project-dir . --model provider/model
# One bounded durable continuation child (raw context in the M5 surface):
mise run v2 -- --spec ./parent.md --child-spec ./child.md --project-dir . --model provider/model
# M5 exposes edge-oriented resume for a durable child; this is distinct from
# M5.5's planned public factual status and linear run-ID resume:
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

Context: `--context raw` (default, empty plan) or `--context symbol-tree` (opt-in bounded handles + `context` query/resolve tool). Raw has no index dependency; symbol-tree failures degrade explicitly. The M5 edge-oriented interface `--resume <edge-id>` is mutually exclusive with submission options; unknown edges are usage errors, durably blocked edges fail, and selecting a terminal edge is an idempotent success. This edge-oriented surface is not the final planned M5.5 run-ID recovery UX. See [context-control-plane ADR](../../docs/adr/context-control-plane.md).

### Execution bounds and cost accounting

`--max-turns` and `--wall-timeout-ms` are supported independently, including durable sequential checkpoint/preserve and resume behavior. `maxCostUsd` / `--max-cost-usd` is not an execution cap: new CLI and daemon submissions reject it with an actionable unsupported-live-cost error because provider-neutral live cost interruption signals do not exist yet. The engine still records measured final usage, including cost, in receipts and metrics; it does not add live cost telemetry or relabel settled work as a cost interruption. Historical serialized receipts and configuration remain readable where applicable.

## Observability

Every run emits a canonical, versioned, provider-neutral trace ([`src/contracts/trace.ts`](./src/contracts/trace.ts), [`src/contracts/gateway-events.ts`](./src/contracts/gateway-events.ts)). Canonical traces, receipts, and handoffs never store transcripts or private reasoning. Planned M5.5 continuation records are separate local recovery state: deterministic caps retain only task authority, complete selected tool-call/result pairs, latest work/context state, and failure evidence. Old chat and observability-only events are pruned first. Records expire by policy and never become canonical artifacts.

- **Verification:** per-command `durationMs` (injectable clock), bounded structural `VerificationEvidence` (`index/digest/exitCode/timedOut/durationMs`, `executed/expected/omitted/capped`), never `command`/`stdout`/`stderr` text — tails stay in `.failure.json`; limits are implementation-owned.
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

## Implementation map

The current source tree is authoritative; this map names ownership anchors
without attempting to snapshot every file. The typed contracts live under
[`src/contracts/`](./src/contracts/); context planning and acquisition under
[`src/context/`](./src/context/); durable state under
[`src/ledger/store.ts`](./src/ledger/store.ts); daemon composition under
[`src/daemon/`](./src/daemon/); sessions under [`src/sessions/`](./src/sessions/);
verification under [`src/verify/`](./src/verify/); and workspace providers under
[`src/workspaces/`](./src/workspaces/). Consult those source directories for
the current implementation and tests.

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

**Core boundary:** preserve value from failed inference; do not build generalized recovery.

- **Engine settlement:** preserved work satisfying artifact policy, clean integration, and engine verification can ship without final model `yield`; explicit rejection/cancellation remains non-ship and summaries may be unavailable.
- **Minimal passive record:** capture continuation-relevant visible Pi JSON state with zero additional successful-run model turns/tokens. Prefer Pi persistence or the simplest bounded append-only store—no general event sourcing.
- **Deterministic compiler:** preserve task authority, complete selected tool-call/result pairs, latest work state, recent useful context, and failure evidence; prune old chat and observability-only events first under declared byte/token caps.
- **Linear resume:** factual `status <run-id>` exposes fields such as `resume_allowed` and `blocked_reason`; `resume <run-id>` creates one successor from the latest failed state and opens a new model/provider session over preserved Tau state.
- **Latest workspace only:** use the configured provider's existing opaque continuation token. M5.5 adds no historical snapshots, arbitrary checkpoints, recovery branches, or VCS-specific kernel mechanics.
- **Dogfood proof:** the resumed worker must demonstrably avoid repeating investigation retained from the failed attempt.
- **Non-goal:** reasoning/strategy failure, forking, corrective branches, semantic memory, and generalized recovery sophistication are deferred to failure-driven M7 consideration.

These bullets are an approved design target, not shipped CLI documentation. The product contract defines the exit gates.

## Plugins

1. One file, one default export `TaskPlugin` ([`src/contracts/task-plugin.ts`](./src/contracts/task-plugin.ts)): `name` + optional `registerTriggers`/`transformExecutionBundle`/`transformHandoff`/`onLifecycleEvent`.
2. List under `[plugins] paths = [...]` in `task.toml` (relative to `cwd`); bad entries fail typed (`PluginLoadError` in [`src/plugins/errors.ts`](./src/plugins/errors.ts)).
3. One hermetic test via `loadPluginsFromToml`/`importPluginAt` ([`src/plugins/loader.ts`](./src/plugins/loader.ts)) + `src/plugins/hooks.ts` — pure-helper-only coverage does not pass review (FR-11). See [`test/test-gateway-plugins.ts`](./test/test-gateway-plugins.ts).
4. Do not implement replaceable effects as generic lifecycle hooks. Workspace/VCS, journal storage, session continuation, context acquisition/selection, editing, verification, and artifact delivery are explicit capability providers selected by configuration. Observers remain non-authoritative.

Further reading: [product contract](../../docs/pi-task-v2.md), [subsystems](../../docs/pi-task-v2-subsystems.md), [future](../../docs/pi-task-v2-future.md), [v1 design](../../docs/pi-task-design.md).
