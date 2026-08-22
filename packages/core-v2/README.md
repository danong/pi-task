# core-v2 — pi-task-v2 core package

The strict-typed engineering bar for pi-task-v2 (docs/pi-task-v2.md §8, M0).
This subtree holds the kernel contract seams and the ledger store — the
surfaces the v2 daemon builds on — plus their hermetic tests. It is a
type-checked island deliberately **excluded** from the v1 engine under
`extensions/`, whose procedural modules are intentionally out of scope for
the strict gate.

## Layout

- `src/contracts/` — the six kernel seams and their typed boundary payloads
  (FR-2 / FR-3). Each seam is one file with no shared mutable state:
  - `payloads.ts` — the five prompt-bound artifact schemas
    (`Spec`, `ExecutionBundle`, `Yield`, `HandoffBundle`, `TaskReceipt`)
    as zod schemas (deterministic-serialization rule, NFR-3/NFR-4)
  - `serialize.ts` — byte-stable prompt serialization
  - `workspace-driver.ts`, `environment-driver.ts`, `context-compressor.ts`,
    `verification-driver.ts`, `task-plugin.ts`, `control-surface.ts`
  - `index.ts` — the contracts barrel re-exporting every seam (import from
    here, not individual files)
- `src/ledger/store.ts` — the SQLite ledger (`node:sqlite`, zero new
  dependencies): tasks, micro-sessions, routing feedback, workspaces; a
  versioned additive migration (opening an older DB upgrades in place), the
  in-flight status vocabulary, and boot-reconciliation (`reconcileOnBoot`).
- `src/router/route.ts` — the M1.1 router skeleton (docs/pi-task-v2.md
  §5.3/§5.4): `routeTask`, a pure decision function mapping spec metadata,
  the resolved tier config, and per-repo `routing_feedback` telemetry to
  `{ planMode, tier, lane }`, plus the feedback-aggregation helpers and
  the named (config-overridable) routing thresholds.
- `src/sessions/` — the M1.2 in-process session host: `host.ts` spawns one
  pi SDK `AgentSession` per role (no subprocess, no RPC; model resolution
  is typed and never silent), `tools.ts` registers the engine-side `yield`
  and `checklist` tools, and `SDK-NOTES.md` records the surveyed SDK
  surface the host relies on.
- `src/guards/` — the M1.3 safety layer: `watchdogs.ts` (pure settle /
  no-progress / wall / per-tool-timeout decisions), `watchdog-driver.ts`
  (injectable-timer driver carrying out the decisions on a session
  handle), and `artifacts.ts` (capped `.failure.json` diagnostics).
- `src/daemon/` — the M1.4 assembly: `task-runner.ts` runs the full pipeline
  (validate → route → host → guard → yield → verify → ledger → receipt),
  `start.ts` opens the ledger and reconciles stale in-flight tasks at boot.
- `src/verify/run.ts` — the M1.3 verification runner: per-command timeout,
  suite wall with bounded grace, typed per-command results with capped
  output tails.
- `src/environments/` — the M2.b environment ladder's first rungs:
  `HostEnvironmentDriver` (bare exec, hard per-command timeout → exit 124,
  capped tails) and `MiseEnvironmentDriver` (`mise exec --` for project-
  pinned tools; capability-detected, null when absent). argv is preserved
  exactly — the driver never re-wraps through a shell.
- `src/workspaces/` — the M2.c workspace seam: `jj.ts` ports v1's ladder
  primitives verbatim (change-id-tracked atomic revset-union squash,
  per-file union resolution via git merge-file --union, consistency gate
  over the pre-merge file union, clean-WC guard, fetch-if-remote,
  bounded every-call timeouts), and `jj-driver.ts` implements the
  WorkspaceDriver seam on top with two integration modes: `task-base`
  (AI-authored base + atomic combine + checkoutMerged) and
  `feature-branch` (per-worker bookmarks; integration is the operator's
  act). The driver NEVER pushes.
- `src/daemon/` — the M1.4 assembly: `task-runner.ts` (`runTask`: validate
  → route → guarded session → yield → verify → ledger → receipt;
  deterministic worker prompt; injectable host for tests),
  `parallel.ts` (`runParallelTask`: N workers across driver-created
  workspaces → one combine → ONE verification gate on the integrated tree
  through the EnvironmentDriver; residual conflicts escalate, never ship),
  and `start.ts` (`startDaemon`: open ledger + boot reconciliation).
- `test/e2e-parity.ts` — the M1 exit gate: one real single-worker run on
  `openrouter/stealth/ox-alpha` against a temp jj repo, asserting ship
  receipt + verification + ledger rows. Manual/network gate — NOT part of
  `mise run test`; run it with
  `timeout 1200 npx tsx packages/core-v2/test/e2e-parity.ts`.
- `test/e2e-parallel.ts` — the M2 exit gate: TWO real ox-alpha workers
  through the real jj driver in a temp jj repo (disjoint files, atomic
  combine, aggregate receipt). Same manual-gate rules:
  `timeout 1800 npx tsx packages/core-v2/test/e2e-parallel.ts`.
- `src/guards/` — M1.3 operational hardening (FR-7/FR-8):
  - `watchdogs.ts` — pure watchdog decisions over observed session events
    + elapsed time (`continue` / `nudge(text)` / `abort(reason)`), every
    bound a named constant
  - `watchdog-driver.ts` — the stateful driver applying those decisions
    (injectable timer source; `attachWatchdogs` propagates nudges/aborts
    to a live session handle)
  - `artifacts.ts` — failure artifacts (R4): bounded atomic
    `<artifactsDir>/<runId>.failure.json` writes ({ cause, lastEvent?,
    lastTool?, stderrTail? }, each field capped by a named constant,
    never throws on write failure)
- `src/verify/run.ts` — the verification runner (M1.3 R3, FR-6): runs a
  spec's bash commands sequentially with per-command timeouts, a suite
  wall clock, and bounded grace for the command in flight at expiry;
  typed `{ passed, failures: [{ command, exitCode, stderrTail }] }`
  with capped output tails.
- `src/version.ts` — the package identity (milestone `CORE_V2_MILESTONE`,
  version `CORE_V2_VERSION`).
- `test/` — hermetic tests mirroring the layout:
  - `test-contracts.ts` — schema round-trips, deterministic serialization,
    ControlSurface typing, and per-seam smoke tests over in-memory fakes
  - `test-ledger.ts` — migration-on-open, CRUD round-trips, constraint
    rejection, boot reconciliation
  - `test-router.ts` — pure router decisions: every plan mode reachable,
    feedback switching (hit-rate/deviation thresholds), empty-feedback
    defaults, threshold overrides, and determinism
  - `test-watchdogs.ts`, `test-watchdog-driver.ts` — the watchdog decision
    matrix and driver behavior over fake timers
  - `test-verify-run.ts`, `test-artifacts.ts` — real-bash verification
    semantics (pass/fail/timeout/wall/grace, capped tails) and failure-
    artifact shape/caps/never-throw
  - `run-all.ts` — the aggregator (see below)

## Gates

Everything below is hermetic (zero LLM, zero network); run in the repo root.

- **Typecheck** — `mise run typecheck`
  - Strictly typechecks ONLY `packages/core-v2` (`src` + `test`) via
    `packages/core-v2/tsconfig.json` — the same gate contract FR-11 enforces.
    tsx-style runners strip types without checking them, so this is the
    gate that actually catches undeclared identifiers in this subtree.
- **Test** — `mise run test`
  - The full hermetic suite: v1's suites first, then core-v2 via
    `run-all.ts` (the suite list lives in `run-all.ts`; expect exactly
    the suites it lists there).
- **Core suite directly** — `npx tsx packages/core-v2/test/run-all.ts`
  - The aggregate runs every module's exported `runTests()`; each module
    can also run standalone (`npx tsx packages/core-v2/test/<suite>.ts`).
- **Parity e2e (manual, real LLM)** — `timeout 1200 npx tsx packages/core-v2/test/e2e-parity.ts`
  - One real single-worker `runTask` on openrouter/stealth/ox-alpha against
    a temp jj repo; asserts ship verdict, committed file, and ledger rows.
    Skips with exit 0 when no OpenRouter auth is configured. On failure the
    workspace, ledger, and failure artifact are kept for diagnosis.

### Bench runner (suite-03 baselines)

The bench regression runner lives in the v1 tree but is part of M0's
engineering bar (docs/pi-task-v2.md §7). It spawns real pi + a real LLM on
the configured bench tiers, so it is a manual, network/LLM gate — never part
of the hermetic `mise run test` suite.

- **Run one tier/spec** — in the repo root, e.g.
  `npx tsx extensions/task/bench-regression.ts --tier bench-good --spec grounding-anchor`
  - `--tier <name>` — which budget tier's models to benchmark (repeatable)
  - `--spec <id>` — narrow to a named spec (repeatable; matches canned and
    suite-03 grounding specs)
  - `--metrics-dir <path>` — where run manifests land/are read (always pass
    a temp dir for baseline-recording runs so untouched results stay put;
    default is the agent dir's results)
  - `--dry-run` — print the plan (tiers × specs × expected cost/time) with
    no spawns
- **Suite-03 recorded baselines** live in the `baseline` table of each
  spec in `extensions/task/bench-regression.ts` (`BENCH_SPECS` then
  `GROUNDING_SPECS`). There is a "default" fallback entry for custom tiers
  plus a RECORDED `bench-good` entry per grounding spec, transcribed from a
  real run. Re-measure with `--tier bench-good --metrics-dir <temp-dir>`
  and refresh the RECORDED entries when the numbers move.