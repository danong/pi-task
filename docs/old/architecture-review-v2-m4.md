> **Archive status:** Historical and non-normative. See [`README.md`](README.md) for the active source of truth.

# Adversarial spec-fidelity review — M4 (plugin kernel)

Scope reviewed: everything on main since commit `d5a209b5`
(`jj diff d5a209b5..@` — 17 files, +1996/−38): `contracts/gateway-events.ts`,
`contracts/task-plugin.ts`, `contracts/control-surface.ts`, `gateway/*`,
`plugins/{loader,hooks,errors,index}.ts`, `plugins/builtin/{handoff-cap,lifecycle-collector}.ts`,
`daemon/task-runner.ts` + `daemon/parallel.ts` emission sites,
`surfaces/null-surface.ts`, and the five hermetic suites (`test-gateway.ts`,
`test-gateway-plugins.ts`, `test-surfaces.ts`, `test-plugins-handoff-cap.ts`,
`test-plugins-lifecycle.ts`). Source of truth: `docs/pi-task-v2.md`
(FR-2, FR-11, §8 M4 row), `docs/pi-task-v2-subsystems.md` §3/§3a/§3b/§4,
`packages/core-v2/README.md`. Analysis only — no source was edited.

Severity scale: **P0** blocks cutover/correctness · **P1** must-fix before M5 ·
**P2** should-fix · **P3** nit.

---

## P0 — blocks cutover / correctness

### P0-1. `registerTriggers` is never called by any production path — the trigger half of the plugin contract is dead code in the daemon

- **Doc clause:** subsystems §3 — `TaskPlugin.registerTriggers?(gateway)` is
  one of the two interaction channels ("all interaction with the engine goes
  through the gateway events and the typed transform hooks"); the M4 row in
  pi-task-v2.md §8 ships "`TaskPlugin`/`TaskGateway` … per-call-isolated hooks".
- **Evidence:** `registerPluginTriggers` exists
  (`packages/core-v2/src/plugins/hooks.ts:110`) but its only callers are tests
  (`test-gateway-plugins.ts:356`, `test-plugins-lifecycle.ts:65,103,126`).
  Neither `runTask` (`src/daemon/task-runner.ts:366-377`) nor
  `runParallelTask` (`src/daemon/parallel.ts:111`) nor `start.ts` ever wires a
  loaded plugin's triggers into the gateway. A config-loaded trigger-style
  plugin (e.g. lifecycle-collector via `registerTriggers`) loaded from
  task.toml into a real daemon run silently receives nothing through that
  hook; it only works if the host also happens to call
  `emitLifecycleEventToPlugins`, which is a *second*, parallel fan-out.
- **Counterexample (repro):** take `plugins/builtin/lifecycle-collector.ts`,
  list only its path under `[plugins]`, delete its `onLifecycleEvent` method,
  and run `runTask({ plugins: [loaded] })`. The journal stays empty forever:
  `gateway.emit` fans out to `onLifecycleEvent` (task-runner.ts:371), not to
  gateway subscriptions. The contract's canonical subscription channel is
  unreachable from configuration alone.
- **Why P0:** the milestone's headline claim — "config-loaded plugins can
  observe the kernel event stream without hardcoding" — is only true for the
  `onLifecycleEvent` escape hatch. Every downstream consumer built on
  `registerTriggers` before M5 builds on a seam nothing calls.

### P0-2. `NullSurface.connect()` delivers task-scoped events to session-scoped subscriptions — the receipts level leaks every task's Receipt/Escalation to any session subscriber, and the session filter is unenforceable at "receipts"

- **Doc clause:** subsystems §3b — `connect(sessionId, level)` "Subscribe to
  a hosted session's event stream"; SurfaceEvent carries `receipt: TaskReceipt`
  and Escalation as *that session's* stream view; §1 FR-1 says surfaces attach
  to hosted sessions. The coarsening rule is about *volume per stream*
  (delta ⊃ digest ⊃ receipts), not about scope.
- **Evidence:** `patternFor(level)`
  (`src/surfaces/null-surface.ts:71-73`) maps `"receipts"` → pattern
  `"task.*"`, so a surface connected to session `s1` of task `t1` receives
  `task.completed` for **every concurrent task** in the daemon and converts it
  to a Receipt (null-surface.ts:99-101) — with `emptyUsageReceipt` zeroes, no
  less. Meanwhile `projectLifecycleEvent`'s session filter
  (null-surface.ts:117-119) drops all `session.*` events for other sessions,
  which means at `receipts` level a subscriber sees foreign tasks' verdicts
  but none of its own session-scoped activity. There is no taskId↔sessionId
  resolution anywhere in the adapter.
- **Repro:** emit `{ type: "task.completed", taskId: "other", detail: { verdict: "ship" } }`
  while a surface is connected to `(sessionId: "s1", level: "receipts")` —
  `drain(stream, 1)` yields a Receipt for task "other". Conversely a real
  receipt for the connected task arrives even though the subscriber never
  asked for cross-task traffic. `test-surfaces.ts` never emits an unrelated
  task's terminal event, so this leak is untested.
- **Why P0:** surfaces are protocol adapters over *hosted sessions*; shipping
  an adapter whose default QoS level broadcasts all tasks' verdicts to any
  session listener is a correctness (and eventual privacy/multi-tenant) bug
  that M5's TUI/Discord cutover would inherit.

## P1 — must fix before M5

### P1-1. `permission.requested` rides the typed gateway as an untyped cast — the add-only vocabulary guard is bypassed, not extended

- **Doc clause:** subsystems §3 — the vocabulary evolution rule is
  "additive-only … guarded by `eventTypeOf`"; `TaskGateway.emit(event:
  TaskLifecycleEvent)` is the single typed channel. gateway-events.ts:15-19
  says unknown discriminants "cannot reach here".
- **Evidence:** `PermissionRequestEvent` is declared *outside* the union in
  the consumer file (`src/surfaces/null-surface.ts:50-56`) and both emitter
  and adapter traffic it as
  `as unknown as TaskLifecycleEvent` (`test-surfaces.ts:186-199`). Inside
  `InMemoryTaskGateway.emit` the guard is `void eventTypeOf(event)`
  (`gateway/in-memory.ts:79`) — a no-op on the happy path, and the raw event
  lands in `listEvents()`, poisoning the audit log with an object that
  violates the union's own exhaustiveness switch. Any plugin doing an
  exhaustive switch over received events now has a case its compiler cannot
  see.
- **Repro:** `gw.emit({ type: "permission.requested", ... } as unknown as TaskLifecycleEvent);`
  then feed `gw.listEvents()[0]` to `assertExhaustive` in test-gateway.ts — it
  falls into the `never` arm. The type-level guarantee "an unknown
  discriminant cannot reach here" is false at runtime.
- **Fix shape:** add `permission.requested` to `TASK_LIFECYCLE_EVENTS` +
  union + `eventTypeOf` + the test anchor (the whole point of additive-only
  versioning), or give the gateway a second typed side-channel. The current
  middle ground is the worst of both.

### P1-2. `getManifest` returns hardcoded zero totals and `runId = taskId` — the RunManifest slice promised by NFR-3/M4 is not honest

- **Doc clause:** subsystems §3 — `RunManifest.totals: { costUsd, durationMs,
  inputTokens, outputTokens }`; contract NFR-3 "every run records COR
  operationally … computed from manifest phase data"; the task-plugin.ts
  comment itself says "the full phase vocabulary ports with the v1 metrics
  machinery in M1" — i.e. by M4 this should be populated.
- **Evidence:** `gateway/in-memory.ts:120-133`: `totals` are four literal
  zeros, `verifyPassed` is inferred from task status, and usage measured on
  receipts (`task-runner.ts` `receiptUsageFields(usage)`) is never written
  anywhere the manifest can read. A plugin calling `getManifest` gets data
  indistinguishable from "nothing happened".
- **Repro:** run `test-gateway.ts`'s scripted-host leg, then
  `new InMemoryTaskGateway({ store }).getManifest(taskId)` → totals all zero
  although the fake session billed 100 input tokens.
- **Why P1 (not P0):** nothing consumes manifests yet, but M5's router
  feedback loop ("the system learns from manifests, not folklore") reads
  exactly this surface; landing it zeroed would make routing telemetry lie.

### P1-3. Loader shells out to `python3 -c tomllib` — an undocumented external dependency and an exec-injection-shaped design smell in the kernel

- **Doc clause:** FR-11/FR-2 engineering bar; core-v2 README "zero new
  dependencies" ethos (`node:sqlite, zero new dependencies`); mise.toml:19
  quietly adds `python3 tomllib` to the toolchain gate, confirming the dep is
  real but never documented in README or subsystems §3 loader grammar.
- **Evidence:** `readPluginPathsFromToml`
  (`src/plugins/loader.ts:36-52`) spawns `python3` synchronously to parse
  TOML. Failure modes: no python3 on PATH → raw spawn error wrapped as
  `invalid_config` (misleading guidance: "validate with python3 …"), huge
  `[plugins]` arrays capped at 1 MiB maxBuffer → same misleading code.
  Node ≥22 ships `node:sqlite`; TOML could be parsed with a tiny hand parser
  for the one supported grammar (`[plugins] paths = [...]`), or the config
  could be JSON/YAML read natively.
- **Repro:** `PATH=/usr/bin:/bin` minus python3 (or a container image without
  it) + any task.toml → typed error whose recovery guidance cannot be
  followed.
- **Why P1:** FR-5 requires the daemon to be toolchain-free w.r.t. target
  projects, but the kernel itself just gained a Python runtime requirement on
  the *host* — undocumented, untested-for-absence, and trivially avoidable.

### P1-4. Core-shrink proof is weaker than claimed: `lifecycle-collector` replaced behavior that still lives in core, and neither builtin plugin is wired by the daemon

- **Doc clause:** commit a6ee76f43b — "at least two behaviors living in the
  daemon/kernel move behind the plugin seam as real plugins";
  pi-task-v2.md M4 row exit criterion "core shrinks; plugins carry real-path
  tests".
- **Evidence:**
  1. `describeTool` moved verbatim to the plugin
     (`lifecycle-collector.ts:38-41`), but the *behavior* it fed — failure
     artifacts carrying `lastTool` — still runs inline in core:
     `task-runner.ts:514` still does `observation.lastTool = event.toolName`,
     and `artifacts.ts` still formats/caps it. The `tool:${name}` descriptor
     produced by the plugin is consumed by **no production code**
     (`grep -rn describeTool src/` → definition + doc comments only). Net
     effect: core did not shrink; a duplicate parallel bookkeeping path was
     added.
  2. Neither builtin plugin appears in any `[plugins]` config shipped in the
     repo, and neither `startDaemon`, `runTask` defaults, nor `parallel.ts`
     load them — they exist only when a caller hand-assembles
     `options.plugins`. The "before vs after" tables in both plugin files
     describe an aspiration, not the tree.
- **Repro:** remove `plugins:` from every `runTask` call site — pipeline
  output is byte-identical except stderr tails are no longer capped at 60 kB
  (they are still bounded at 2048 by verify/run.ts, so even the cap plugin is
  redundant today, as test-plugins-handoff-cap.ts:150 itself concedes).
- **Why P1:** the M4 exit criterion is "core shrinks". Two modules moved, but
  one moved a dead formatter while keeping its live behavior inline, and the
  other enforces a bound the underlying layer already enforces more tightly.
  Before M5 deletes v1 plumbing (migration inventory row "in-process
  extension hook points … M4d deletes superseded plumbing"), someone must
  decide whether these plugins are load-bearing or demos; today they are
  neither provably.

### P1-5. `transformExecutionBundleThrough` runs AFTER `isBundleUsable` gates and inside the same try/catch that records routing misses — a plugin transform failure is silently mis-telemetried as a bundle miss

- **Doc clause:** subsystems §3 hook isolation — a failing plugin "is reported
  via the configured sink … and the pipeline continues on the untransformed
  value"; NFR-2 graceful degradation; routing_feedback semantics ("hit=1 =
  bundle grounded turn 1").
- **Evidence:** `task-runner.ts:444-471`: the call chain is
  `buildExecutionBundle` → `isBundleUsable(built)` → `transform…Through` →
  `catch { bundleMissRecorded = true; recordRoutingFeedback(repo, BUNDLE_FEEDBACK_MODE, 0) }`.
  If the transform throws (or schema re-validation rejects), execution falls
  into that catch and writes a *bundle-mode miss* row plus
  `bundleHit:false`-shaped state — even though the bundle was perfectly good
  and the fault was a third-party plugin. The sink also defaults to
  `console.error` here because `ctx` is never passed
  (`transformExecutionBundleThrough(built, plugins)` — no third arg).
- **Repro:** route a repo into bundle mode with a hit-seeded ledger, attach a
  rejecting transformer, run twice: the second run un-routes out of bundle
  mode because run 1 recorded plugin-failure misses as bundle misses.
- **Why P1:** conflates operator-actionable signal (plugin bug) with mode
  telemetry (bundle quality) in the exact table the router learns from.

## P2 — should fix

### P2-1. `eventMatchesPattern("task.*", "ta.*")`-style prefix bugs: wildcard matching is raw string prefixing, not family matching

`gateway-events.ts:97`: `type.startsWith(pattern.slice(0, -1))` — pattern
`"task.*"` matches hypothetical future literal `"taskfoo.queued"` (prefix
`"task."`… actually safe today only because every family boundary is a dot;
but `"tas*"`→slice(-1)→`"tas"` matches `"task.queued"`). No test pins the
malformed-pattern behavior (`"*x"`, `"task."`, empty string). Cheap fix:
split on segments or reject patterns lacking `.`/`*` shape in `on()`.

### P2-2. NullSurface async iterator loses wakeups across concurrent `next()` calls

`null-surface.ts:216-218` stores a single `wake` resolver; two overlapping
`iterator.next()` calls (legal for AsyncIterable consumers using
`Promise.race`, and exactly what `for await ... break` does after cancel)
overwrite each other — first waiter hangs until the next event. The suite's
`drain()` helper serializes awaits, so it can't catch this. Fix: queue of
waiters, or reject a second concurrent `next()`.

### P2-3. `StatusSnapshot` projection fabricates `{ model:"unknown", tier:"unknown", activeTasks:1 }`

`null-surface.ts:139-141` emits a heartbeat with made-up field values for
every queued/routed/verify/review/merge event. The doc (§3b) describes
StatusSnapshot as daemon state ("guides daemon batching"); constant fake
values will show "1 active task" in a cron dashboard during a 8-worker
parallel run. Either drop StatusSnapshot from lifecycle projection or source
it from `getManifest`.

### P2-4. Receipts-level subscribers get `Escalation.detail === reason === cause` duplication and `task.failed` mapped to Escalation

`projectLifecycleEvent` (null-surface.ts:102-105): `task.failed` becomes
Escalation although the vocabulary distinguishes failed (terminal) from
escalated (retryable) — a cron surface cannot distinguish "give up" from
"needs human" without parsing reason strings, and both fields carry the same
string twice. Map `task.failed` → Receipt(verdict:"failed") too, keep
Escalation for `task.escalated`.

### P2-5. `RunManifest.runId = task.id` and `getManifest` sessions include `yield_payload` transitively via `structuredClone`-free mapping — fine today, but `listSessions` selects `SELECT *`

`store.listSessions` (`ledger/store.ts:269-274`) selects all columns and the
manifest comment claims "the yield_payload transcript column is deliberately
never selected" (`in-memory.ts:116-118`) — false at the SQL level; it is
dropped only afterwards in JS. One refactor away from transcripts crossing
the gateway. Push the column list into SQL.

### P2-6. Test-suite gaps against the doc's own claims

- `test-gateway.ts` "ledger-only reads" asserts `!JSON.stringify(manifest).includes("transcript")`
  — a substring check over fixture data; passes trivially if the column were
  renamed. Assert on the absence of the *field* (`yieldPayload`) instead.
- No test covers `GatewayError` code `"no_ledger"` — it is declared
  (`gateway/errors.ts:6`) and never constructed anywhere; either construct it
  in `requireStore()` (which currently reuses `unknown_task` for a
  missing-store condition, semantically wrong) or delete the code.
- `test-surfaces.ts` permission-routing leg casts through
  `as unknown as TaskLifecycleEvent` (see P1-1) — the test bakes in the
  bypass instead of catching it.
- No test exercises two plugins where the *first* transforms and the second
  throws on the ExecutionBundle path ordering + isolation combined (covered
  separately only).

### P2-7. `hooks.ts` `callIsolated` fallback swallows the distinction between "plugin threw" and "plugin returned invalid schema" at the type level

Both funnel into `report()` with different Error messages, fine — but
`emitLifecycleEventToPlugins` fires hooks with `void callIsolated(...)`:
a *rejected promise* from an async `onLifecycleEvent` is unhandled-rejection
territory if `report` itself throws (e.g., custom sink throws). Guard the
sink call.

## P3 — nits

- **P3-1.** `TASK_LIFECYCLE_EVENTS[0] === "task.queued"` assertion
  (test-gateway.ts:287) anchors ordering of a set whose order is
  meaningless; harmless but will churn on legitimate reorderings.
- **P3-2.** `version.ts` still says `CORE_V2_MILESTONE = "M0"` /
  `0.0.0-m0` while the package now contains M1–M4 machinery — stale
  identity metadata contradicts README ("M0 establishes the engineering bar
  only").
- **P3-3.** `lifecycle-collector.ts:66` — `const unsubscribe: Unsubscribe =
  gateway.on(...); void unsubscribe;` discards the unsubscribe handle
  immediately with a comment claiming "Unsubscribe stays captured so a host
  can detach". It doesn't: nothing can detach the collector's subscription.
  Store it on the plugin object or drop the claim.
- **P3-4.** README layout section lists `src/daemon/` twice (M1.4 assembly +
  M2 entry) and interleaves `- test/e2e-*` bullets mid-layout — M4 additions
  were appended rather than merged; the plugins section sits between them.
  Cosmetic drift that will confuse the next reader.
- **P3-5.** `handoff-cap.ts` caps `uncommittedDiffSummary` to 60 000 chars —
  exactly the schema max — but `capTail` keeps the *last* bytes, so the
  zod `.max(60_000)` passes only because lengths match; a future schema
  change to head-capping semantics would silently invert diagnostic value.
  Document tail-vs-head choice next to the schema, not just the plugin.
- **P3-6.** `SURFACE_LEVEL_EVENTS` types values as `readonly string[]`
  instead of `readonly (SurfaceEvent["type"])[]` — loses exhaustiveness
  checking that each level's partition covers the union.

---

## What passed (do not regress)

These were verified against the docs and hold as of this review:

1. **Add-only versioning is real, not decorative.** `eventTypeOf`
   (gateway-events.ts:75-95) is an exhaustive pinned switch with a `never`
   arm, mirrored by `assertExhaustive` in test-gateway.ts anchored to checked
   consts — removing or adding a discriminant breaks the strict tsc gate in
   both directions. Vocabulary matches the doc's 12-event initial set exactly.
2. **Plugin loading fails typed, never silent.** All four `PluginLoadError`
   codes are exercised over REAL files (.mjs and .ts imported by absolute
   path) including "one bad path among good ones fails typed"
   (test-gateway-plugins.ts loader block). Relative-path-against-cwd
   resolution is tested. This satisfies the §3 "one file, one default export,
   loaded by path, no discovery magic" clause as far as loading goes.
3. **Transform-hook isolation + schema re-validation.** Sequential
   declaration-order composition, per-call try/catch with name+hook
   attribution through a configurable sink, `ExecutionBundleSchema`/
   `HandoffBundleSchema` re-parse of every transformed output, and the
   untransformed-value-continues semantics are all covered
   (test-gateway-plugins.ts, both plugin suites) — matching subsystems §3
   hook-isolation wording precisely.
4. **Daemon wiring of transform hooks is real-path tested end-to-end.** A
   tagging plugin's bundle edit demonstrably reaches the worker system prompt
   BEFORE grounding attaches, and a throwing transformer degrades to the
   untransformed bundle without crashing the run (scripted-host legs in
   test-gateway-plugins.ts). Handoff transform precedes retry consumption.
5. **Emission-after-ledger-mutation ordering.** test-gateway.ts pins the
   exact queued→routed→spawned→yielded→verify→completed sequence over a real
   temp SQLite ledger and asserts the row status is visible to subscribers
   at emit time (the R4 invariant).
6. **Handler-throw isolation at the gateway.** A throwing subscriber never
   propagates out of `emit`, later subscribers still receive the event, the
   audit list keeps the event, and unsubscribe removes exactly its own
   handler idempotently — all directly tested.
7. **QoS coarsening partition.** delta ⊃ digest ⊃ receipts is enforced by
   `SURFACE_LEVEL_EVENTS` and verified over the live adapter with monotone
   volume checks; capability honesty (headless declares
   `interactivePermissions:false`, `attachments:false`) is asserted; close()
   unsubscribes for real.
8. **Contract-shape locks.** Compile-time `Equivalent<>` anchors pin
   `SubscriptionLevel` to exactly the documented trio and the capabilities
   field set; the ControlSurface/SurfaceEvent/SurfaceCommand unions match
   subsystems §3b verbatim (including optional `durationMs` and
   `attachments?`).

The strongest part of M4 is the loader/hooks/hermetic-test triangle; the
weakest is that half of the plugin surface (`registerTriggers`, manifest
reads, permission protocol) is shaped correctly but not yet *wired* — the
gap between "contract exists" and "kernel uses it" is where every P0/P1
above lives. Close those wirings before M5 starts building surfaces on top.
