> **Archive status:** Historical and non-normative. See [`README.md`](README.md) for the active source of truth.

# Architecture review: pi-task-v2 M0+M1 (adversarial spec-fidelity survey)

An adversarial review of everything the v2 subtree claims to implement,
graded claim-by-claim against the two design docs, followed by a bug hunt,
a future-rework scan (M2/M3), and an architecture judgment in the shared
survey vocabulary. No code was changed by this review; this document is the
only artifact.

## Scope & method

**Scope.** The v2 subtree only:

- `packages/core-v2/src/**` — contracts (payloads, serialization, six
  seams), ledger, router, session host + tools, guards (watchdogs,
  watchdog driver, failure artifacts), verification runner, daemon
  (task-runner, start), version.
- `packages/core-v2/test/**` — the hermetic suites, the two manual
  real-LLM gates (`smoke-session.ts`, `e2e-parity.ts`), and the
  aggregator `run-all.ts`.
- The ADDITIVE suite-03 parts of `extensions/task/bench-regression.ts`
  (`GroundingBody`/`GROUNDING_SPECS`/fixture synthesis) and
  `extensions/task/test-bench-regression.ts` (grounding assertions only;
  v1 behavior out of scope).
- `mise.toml` (typecheck/test tasks) and `packages/core-v2/README.md`.

**Commit range.** Everything after `uwqwppskxxpq` ("docs(v2): fix stray
word…") on main: 13 commits, `nslplprn` (M0 R1 type gate) through
`rylzyszr` (M1.4 daemon assembly), verified with
`jj log -r 'uwqwppskxxpq..@'`.

**Docs graded against.** `docs/pi-task-v2.md` (the contract: FR-1..FR-11,
NFR-1..4, §5 context lifecycle) and `docs/pi-task-v2-subsystems.md`
(§1 kernel interfaces, §2 payload schemas + deterministic-serialization
rule, §3 plugin contract, §3b ControlSurface, §4 ledger DDL). Note: the
task brief's FR numbers differ from the contract's (brief FR-2 = contract
FR-3, brief FR-3 = FR-7, brief FR-6 = FR-6+FR-8, brief FR-7 = FR-2); the
table below uses the **contract's** numbering.

**Method.** Read both design docs first, then every file in scope
(~2.8k lines of src, ~2.3k lines of tests). Suspected runtime defects
were confirmed with throwaway probes under `/tmp` (never the repo):
the task-id collision and the telemetry-mangling bugs below were both
reproduced against the real modules. Gates were run: `mise run typecheck`
(strict tsc) and `mise run test` both pass as of the review commit; the
two unregistered watchdog suites were run standalone and also pass.

**Vocabulary.** Module/depth, seam/adapter, leverage, locality, and the
deletion test are used as defined in the survey contract; findings are
tagged **Strong** | **Worth exploring** | **Speculative** and prioritized
P0..P3.

## Spec-fidelity table

Verdicts: **HELD** — implemented as documented; **PARTIAL** — implemented
but quietly narrowed or incomplete; **VIOLATED** — a documented invariant
is broken. Evidence is file:line under `packages/core-v2/` unless noted.

| # | Requirement | Verdict | Evidence |
| :- | :---- | :- | :---- |
| FR-1 | Standalone daemon hosting ALL sessions in process | **PARTIAL** | In-process hosting is real: `sessions/host.ts` binds a live SDK `AgentSession` per spawn (no subprocess/RPC; `createAgentSession` at src/sessions/host.ts:170-183). But the "daemon" is a library surface: `startDaemon` opens the ledger and reconciles, then stops (src/daemon/start.ts:20-24) — no dispatch loop consumes requeued tasks, no gateway/control-surface attachment, no main-session hosting. Acceptable for M1's exit criterion ("single-worker runs through the daemon"), but requeued tasks (ledger `status='queued'`) have no consumer — NFR-1's requeue is currently write-only. |
| FR-2 | Six pluggable kernel seams | **HELD** (interfaces) | All six files exist and are faithful ports of subsystems §1/§3/§3b: workspace-driver.ts, environment-driver.ts, context-compressor.ts, verification-driver.ts, task-plugin.ts (all 12 lifecycle events, src/contracts/task-plugin.ts:16-30), control-surface.ts (QoS levels, capabilities). See Candidates §"Contracts are decorative" for the implementation-side gap. |
| FR-3 | Exactly five typed boundary artifacts | **PARTIAL** | Four of five exist as zod schemas (src/contracts/payloads.ts: ExecutionBundle, Yield, HandoffBundle, TaskReceipt). **Spec has no schema** — it crosses the boundary as raw markdown parsed by regex (src/daemon/task-runner.ts:52-82). Yield enforcement is real: the yield tool re-validates against `YieldSchema` (src/sessions/tools.ts:88-96). HandoffBundle exists but is constructed nowhere — the retry path that would use it is absent (see FR-7). |
| FR-4 | Workspace isolation & deterministic merge | **NOT STARTED** (out of M0/M1 scope) | Interface only (src/contracts/workspace-driver.ts); no driver implementation. Correctly deferred to M2 — recorded for completeness. |
| FR-5 | Environment execution ladder | **NOT STARTED** (out of M0/M1 scope) | Interface only (src/contracts/environment-driver.ts). Deferred to M2. |
| FR-6 | Hard verification gates | **HELD** (M1 scope) | src/verify/run.ts: per-command timeout (:53-79), suite wall with bounded grace (:91-104), exit-code gate never trusts model claims, capped tails. M1 runs verification on the worker's cwd rather than "the merged tree post-merge" — there is no merge yet, so this is scope-correct. Vacuous-pass hole (empty command list passes, :106) is plugged upstream: `parseTaskSpec` throws on zero verification commands (src/daemon/task-runner.ts:78). |
| FR-7 | Bounded attempts → bounded HandoffBundle retry | **PARTIAL** | Bounds exist as watchdog wall/no-progress/per-tool limits (src/guards/watchdogs.ts:56-64) but there is **no per-attempt turn budget and no retry path**: `runTask` is single-attempt — watchdog abort, settle-without-yield, or verification failure all end in `verdict: "failed"` (src/daemon/task-runner.ts:160-181, 262-290). `HandoffBundleSchema` and ledger `retry_count/max_retries` are wired only into boot reconciliation (src/ledger/store.ts:344-371), never into execution. §5.4's "small failure nudges the SAME session" is also absent. M1's exit criterion is *current-engine equivalence* and v1 has a fix loop, so this is a narrowing the milestone table does not document. |
| FR-8 | Watchdogs + diagnostics + failure artifacts "ported unchanged" | **PARTIAL** | Watchdogs: clean port of v1's taxonomy, pure decisions + side-effecting driver split (src/guards/watchdogs.ts, watchdog-driver.ts) — but see Candidates #5 (yield/settle event ordering makes the settle-nudge path misfire against the REAL host). Failure artifacts exist, capped, atomic, never-throw (src/guards/artifacts.ts) — but carry only `{cause, lastEvent?, lastTool?, stderrTail?}`; FR-8's "**scripted recovery guides**" (present in v1's artifacts) did not port. Also the artifact is written for session/verification failures but `lastTool` is only ever the last *completed* tool name (src/daemon/task-runner.ts:236), never args — weaker than v1 diagnostics. |
| FR-9 | Layered grounding; live tools NEVER removed | **VIOLATED** (tool clause) / PARTIAL (layers) | The invariant "the live tools (read/grep/find/bash/edit) are never removed" is broken by the host's own default: `DEFAULT_TOOLS = ["read","bash","edit","write","yield","checklist"]` (src/sessions/host.ts:75) **omits `grep` and `find`**, which are built-in pi tools the SDK ships (dist/core/tools/grep.js, find.js) and v1 workers keep. Grounding layers (repo-map slice, bundles, forks) are absent — scope-correct for M1 (cold start), but cold start is specified to keep "the repo-map slice", which also does not exist yet. Candidate #4. |
| FR-10 | Model routing & lanes | **HELD** (skeleton) | `routeTask` is pure, deterministic, hermetically tested (src/router/route.ts:181-230); unsupported lanes degrade to interactive (`normalizeLane`, :163-169); no quota/budget ever surfaces to the engine; tier passes through as config. The decided `planMode` is recorded (src/daemon/task-runner.ts:213) but nothing consumes it yet — a skeleton per M1's scope. |
| FR-11 | Typecheck gate + real-path smoke test per seam | **PARTIAL** | Typecheck gate: real and enforced (mise.toml `[tasks.typecheck]`, tsconfig.json strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes). Real-path seam smokes: **not hermetic and not gated** — `smoke-session.ts` and `e2e-parity.ts` are manual, skip without OpenRouter auth, and are excluded from `mise run test` by design. Worse, the in-gate "per-seam smoke tests" (test/test-contracts.ts:256-379) instantiate inline fakes and exercise *the fakes*, which is exactly the happy-path pattern FR-11's rationale rejects. And the two watchdog suites are missing from `run-all.ts` entirely — Candidate #3. |
| NFR-1 | Crash recovery via ledger; boot reconciliation | **HELD** (record) / PARTIAL (re-run) | DDL + `PRAGMA user_version` migration on open (src/ledger/store.ts:156-171), pure `reconcileCrashedTask` policy, idempotent `reconcileOnBoot` (:344-371), hermetically tested. Gap: requeued tasks are never picked up (no dispatcher), and a requeued task re-dispatched by any future loop crashes on the deterministic task id — Candidate #1. |
| NFR-2 | Graceful degradation | **HELD** (vacuously at M1) | Every optimization (bundles, forks, review, sandbox) is absent, and the pipeline still completes tasks — the zero-features configuration works, as required. |
| NFR-3 | COR measured per run | **PARTIAL** | `turns` is counted from `turnStart` events (src/daemon/task-runner.ts:233). `costUsd` is hardcoded to `TASK_RUNNER_COST_UNAVAILABLE = 0` (:30) and serialized into receipts as an ordinary number — indistinguishable from a genuinely free run. Token usage is available from the SDK (`AgentSession.getSessionStats(): SessionStats` with input/output/cache tokens) but `LiveSession` never surfaces it. Candidate #10. |
| NFR-4 | Deterministic request prefixes; append-only retries | **HELD** (what exists) | `buildWorkerSystemPrompt` is a pure function of spec markdown — no clocks, ids, or randomness (src/daemon/task-runner.ts:87-100; test-daemon asserts byte-stability). `stableStringify` sorts keys recursively; `serializeForPrompt` strips ledger-envelope fields via zod parse (src/contracts/serialize.ts; test-contracts proves byte-identical serialization across varying envelopes). Caveat: no production code path calls `serializeForPrompt` yet — the rule is tested, not yet enforced anywhere (§2 rule). |
| §2 | Payload schemas vs subsystems §2 | **PARTIAL** | TargetFile, ExecutionBundle, Yield, TaskReceipt, ModelAssignment match the doc field-for-field. **HandoffBundle drifted**: subsystems §2 keeps `attemptNumber: z.number().int().min(1)` in the prompt-bound schema (only `precedingSessionId` is ledger-only there); the implementation moved `attemptNumber` into the ledger envelope too (src/contracts/payloads.ts:60-74, 108-115). The code comment justifies it via NFR-4, but NFR-4 only requires the *prefix* to be identical — the appended handoff may vary per attempt. The doc was not updated. Candidate #11. |
| §3/§3b | Plugin + ControlSurface contracts | **HELD** | task-plugin.ts and control-surface.ts reproduce the doc interfaces verbatim (gateway reads are typed rows, never transcripts; subscription levels form the delta ⊃ digest ⊃ receipts partition — verified by test-contracts). No plugin or surface implementation exists yet — per FR-2 the contract precedes plugin code by design (M4). |
| §4 | Ledger DDL | **HELD** | V1_DDL (src/ledger/store.ts:95-149) reproduces the doc's `tasks`, `micro_sessions`, `routing_feedback` byte-for-byte in semantics (same CHECK enums, FK ON DELETE CASCADE, `last_heartbeat_at` child-process-only comment), plus a `workspaces` table whose columns mirror `WorkspaceContext` (the doc defers its shape to "v3.1", which is not in this repo — implementation-defined). One forward-compat edge: a DB with `user_version > LEDGER_SCHEMA_VERSION` (written by a newer build) opens silently unmigrated (:156-171). |
| §5.3 | Router modes | **HELD** (function) / **VIOLATED** (telemetry wiring) | The four modes are reachable in `routeTask` and the pure decision matches §5.3's most-specific-first ordering (src/router/route.ts:197-224). But the pipeline's feed of routing telemetry is wrong — `runTask` reconstructs feedback rows from aggregates in a way that turns hits into misses, making `bundle` unreachable through the real pipeline and corrupting the §5.4 learning loop. Reproduced; Candidate #2. |

## Candidates

### C1. Re-running any spec crashes on a deterministic task-id collision — **Strong**, P0

**Files:** `packages/core-v2/src/daemon/task-runner.ts:104-106, 151-155`;
`src/ledger/store.ts:178-181` (PK insert).

**Problem.** `deriveTaskId` hashes `cwd + specMarkdown` to the task's
PRIMARY KEY, and `runTask` unconditionally `INSERT`s a new `tasks` row.
Any re-run of the same spec in the same cwd — a retry, a fix loop, the
boot-reconciliation requeue this ledger already commits to, or simply
running a flaky bench spec twice — throws
`SQLITE_CONSTRAINT: UNIQUE constraint failed: tasks.id`. Reproduced: a
second `runTask` with identical spec+cwd rejects with exactly that error.
The throw escapes `runTask` *before* `failRun`, so there is no failure
artifact, no failed receipt, no ledger terminal status — and the opened
`LedgerStore` is never closed (no `store.close()` anywhere in `runTask`).
NFR-1's requeue path (`reconcileOnBoot` sets `status='queued'`) is headed
straight into this wall the moment a dispatcher exists (M2).

**Solution.** Make attempts addressable: keep the content hash as a
*task family* id and append an attempt discriminator (e.g.
`<hash>-<attempt>` or a separate `attempt` column with PK
`(family, attempt)`); on insert, read the existing family state and bump
the attempt. Alternatively `INSERT ... ON CONFLICT` into a re-run with a
typed "already terminal" receipt — but attempt rows are what retry
accounting (FR-7) needs anyway. Wrap the store in try/finally + `close()`.

**Benefits.** Locality: one id-derivation site + insert site. Leverage:
unblocks retry/requeue, the entire FR-7 machinery, and M2 dispatch with a
single localized change. Tests: the reproduction above becomes a
hermetic two-run test in test-daemon.ts.

### C2. Routing telemetry is mangled between ledger and router — bundle mode is unreachable — **Strong**, P1

**Files:** `packages/core-v2/src/daemon/task-runner.ts:193-197` (feed
construction) vs `src/router/route.ts:130-146` (`aggregateRoutingFeedback`
counts a row as a hit only when `hit === true || hit === 1`).

**Problem.** `runTask` converts `routingSummary()` aggregates
(`{total, hits}` per mode) back into `RoutingFeedbackRow[]` by pushing
`{hit: rate.hits}` and `{hit: rate.total - rate.hits}`. Each pushed row
counts as ONE sample, and any value other than exactly `1` is a miss — so
3 recorded hits become two "miss" rows (`hit: 3`, `hit: 0`). Reproduced:
with 3/3 real bundle hits recorded, `routeTask` sees rate 0 and routes
`prewalk`; the same data fed as raw rows routes `bundle`. Consequences:
(a) planning mode (b) — the economic core of §5.3 that suite-03 exists to
adjudicate — is unreachable through the only pipeline that records
telemetry; (b) the fork-deviation kill-switch is equally corrupted;
(c) the router's own tests pass because they feed raw rows — a textbook
unit-tested/integration-broken split. Compounding it,
`recordRoutingFeedback(repo, mode, 1)` is called only on success
(task-runner.ts:297): misses (verification failure, exhaustion) are never
recorded, so even once fixed the hit-rate is success-biased. Minor:
`repo` is the cwd basename (:191), so same-named repos share telemetry.

**Solution.** Feed the router what the ledger has: either query raw
`routing_feedback` rows (`SELECT repo, mode, hit ... WHERE repo = ?`)
straight into `RouteInput.feedback`, or change `RoutingFeedbackRow` to
carry weights. Record `hit=0` on verification failure / watchdog abort
per §5.4 ("bundle hit/miss … feed the ledger's routing telemetry").

**Benefits.** Locality: one loop + one record site. Leverage: restores
the §5.4 learning loop the router's entire design depends on before M3
bundles land on top of it. Tests: a daemon-level test that records
feedback through the store and asserts the resulting `planMode`.

### C3. The two watchdog suites are not wired into `run-all.ts` — the CI gate skips them — **Strong**, P1

**Files:** `packages/core-v2/test/run-all.ts:17-24` (SUITES list omits
`test-watchdogs.ts` and `test-watchdog-driver.ts`); README "Layout →
test/" lists them as part of the hermetic suites.

**Problem.** M1.3's watchdog work (pure decisions + driver, ~490 lines of
tests, fully hermetic via fake timers) runs standalone but is absent from
the aggregator, so `mise run test` — the gate FR-11 hangs on — does not
execute it. Commit history shows how: the watchdog files landed in
`nqussxwu` without touching run-all.ts, and the later "suite
registration" commit (`zmnwwouw`) registered only verify-run + artifacts.
A regression in guards/ now ships green. The README overstates the gate
at the same time.

**Solution.** Add both modules to `SUITES`; assert the suite count
matches the number of `test-*.ts` modules (or glob-register) so the next
orphan is a red gate, not a silent skip.

**Benefits.** Locality: two lines + a guard. Leverage: restores the
"every module gated" invariant FR-11 exists to enforce. Tests: the
orphan-detector check itself.

### C4. `DEFAULT_TOOLS` omits `grep` and `find` — FR-9's "never removed" invariant is broken — **Strong**, P1

**Files:** `packages/core-v2/src/sessions/host.ts:75`.

**Problem.** The contract is explicit (§5.2): "the live tools
(read/grep/find/bash/edit) are NEVER removed … none restricts
capability." The host's default allowlist is
`["read","bash","edit","write","yield","checklist"]` — no `grep`, no
`find`, though the SDK ships both as built-in tools and v1 workers keep
them. On grounding-heavy tasks (exactly what suite-03 measures) workers
are forced to shell out to `bash grep`/`find`, which is slower,
token-heavier, and silently degrades the very capability the grounding
layers are supposed to *add to*, not replace. This is a quiet narrowing
of a documented invariant with no note in code or docs.

**Solution.** Default to the contract's live-tool set plus the custom
tools (`read, grep, find, bash, edit, write, yield, checklist`); keep
`SessionHostConfig.tools` as the per-role override.

**Benefits.** Locality: one constant. Leverage: restores the FR-9
invariant before M3 grounding modes start measuring against it. Tests: a
host-level assertion that the default allowlist is a superset of the
contract's live tools.

### C5. `yielded` is emitted after `settled` — spurious nudges, a dead recovery path, and a mid-turn prompt race — **Strong**, P1

**Files:** `packages/core-v2/src/sessions/host.ts:259-298` (event
forwarding vs post-await yield emit); `src/guards/watchdog-driver.ts:292-295`
(nudge fires `handle.prompt`); `src/daemon/task-runner.ts:242-261`
(single-prompt lifecycle).

**Problem.** `LiveSession.#forward` streams `settled` the moment the SDK
emits it, but `yielded` is only emitted *after* `prompt()`'s await
resolves — so the watchdog always sees `settled` with `hasYielded=false`,
even when the yield tool already ran. Against the REAL host this means:
(1) every successful yield run triggers a spurious settle-nudge (a second
`handle.prompt` call racing the first's unwinding); (2) the nudge
recovery is dead by construction — on settle-without-yield the runner's
single `await handle.prompt()` has already resolved, `handle.result` is
undefined, `failRun("settled without yield")` fires and `handle.close()`
disposes the session while the nudge prompt is still in flight
(swallowed by `.catch(() => {})`); the watchdog's designed "nudge once,
abort on second settle" behavior can never actually recover a run;
(3) `prompt()` short-circuits to a no-op once a yield exists
(host.ts:262-267), so the same session can never be re-prompted — this
also forecloses §5.4's "small failures nudge the SAME session" for M3.
The hermetic tests miss all of this: test-daemon's `FakeHandle` emits
`yielded` synchronously inside `subscribe`, and test-watchdog-driver
feeds events by hand — neither reproduces the host's real ordering.

**Solution.** Emit `yielded` from the tool callback path (the yielder
fires *during* the run) or at least before forwarding `settled` when the
payload is already present; make settle-nudge a runner-visible action
(the runner owns the retry/re-prompt decision) instead of a fire-and-
forget concurrent prompt; define prompt-during-prompt explicitly (reject
typed, or queue).

**Benefits.** Locality: host event plumbing + one wiring site. Leverage:
makes FR-8's settle watchdog mean what it says and clears the path for
same-session repair in M3. Tests: a fake handle that reproduces the
settled-before-yielded ordering catches the nudge; an integration-style
test over the real ordering belongs in test-daemon.

### C6. Two wall clocks, one shadowing the other — the watchdog's wall budget never fires — **Worth exploring**, P2

**Files:** `packages/core-v2/src/sessions/host.ts:33`
(`DEFAULT_WALL_TIMEOUT_MS = 10m` per prompt); `src/guards/watchdogs.ts:57`
(watchdog wall `45m`); `src/daemon/task-runner.ts:242` (prompt failure →
`failRun`).

**Problem.** `runTask` drives one prompt with the host's 10-minute
per-prompt timeout and attaches watchdogs with a 45-minute wall. The
host timeout always fires first, rejecting the prompt with a string the
host classifies as `timed_out` via `err.message.includes("exceeded")`
(host.ts:284) — so the run dies as `prompt failed (timed_out)` with a
generic cause, never as a typed `wall_timeout` abort with the watchdog's
named-limit message. The 45m wall, the 10m no-progress window, and the
host's 10m timeout are three overlapping budgets whose precedence is
nowhere documented. Related fragile bit: any provider error containing
"exceeded" (e.g. context-length) is misclassified as a timeout.

**Solution.** One owner of wall time: let the watchdog wall be the limit
and give the host prompt a strictly larger (or no) timeout, or derive
both from one `limits` object passed down by the runner. Classify
timeouts by an error type/code, not message substring.

**Benefits.** Locality: one limits object threaded runner→host→driver.
Leverage: failure artifacts name the real bound; diagnostics stop lying.
Tests: a fake-timer driver test asserting which clock wins.

### C7. Ledger lifecycle: never-closed stores, per-run connections, no WAL — **Worth exploring**, P2

**Files:** `packages/core-v2/src/daemon/task-runner.ts:154` (open, never
`close()`); `src/ledger/store.ts:172-177` (`DatabaseSync`, no journal
mode); `src/daemon/start.ts:20-24` (daemon store separate from runTask
stores).

**Problem.** `runTask` opens a `LedgerStore` per invocation and never
closes it — file handles live until GC, which in a long-lived daemon is
a slow leak. Each run opens its own connection to the same DB the daemon
holds; `node:sqlite`'s sync API blocks the event loop on every call
(fine at M1 write rates, but the daemon hosts ALL sessions in-process —
FR-1 — so every ledger write is a stall for every hosted session), and
without WAL or a busy timeout concurrent writers will surface
`SQLITE_BUSY` the moment M2 runs parallel workers. `migrate()` also runs
each migration outside a transaction (safe today only because V1_DDL is
`CREATE TABLE IF NOT EXISTS` — a property future additive migrations
must preserve).

**Solution.** One shared store owned by the daemon, injected into
`runTask` (it already accepts DI via `options.host`); `close()` in
finally until then; `PRAGMA journal_mode=WAL` + busy timeout at open;
wrap migrations in a transaction.

**Benefits.** Locality: constructor/parameter changes in two files.
Leverage: removes the structural blocker for M2 parallel writes and for
daemon-wide telemetry queries. Tests: two concurrent runTask calls on one
DB path.

### C8. Contracts gate nothing: no seam has an implementation, and `runVerification` is not a `VerificationDriver` — **Worth exploring**, P2

**Files:** `packages/core-v2/src/contracts/verification-driver.ts` vs
`src/verify/run.ts:87-109`; contract consumers limited to type imports in
task-runner/tools.

**Problem.** Zero of the six seams has a concrete implementation — not
even an in-memory adapter — and the one real engine behavior that should
satisfy a seam, the verification runner, doesn't: `runVerification(
commands, {cwd})` has no `name`, takes no `WorkspaceContext`, and is
called directly by the pipeline. The contracts' only enforcement today is
`YieldSchema` in the yield tool and type-imports; the seam interfaces are
decorative — nothing fails to compile if `WorkspaceDriver` drifts. The
deletion test is telling: delete all six interface files and the entire
M1 pipeline still compiles and runs. Meanwhile M2's JujutsuWorkspaceDriver
must port v1's ladder "VERBATIM" behind `WorkspaceContext`, and the
verification runner will need an adapter to flow through
`EnvironmentDriver.exec` — the seam/adapters mismatch guarantees rework
unless resolved first.

**Solution.** Make `runVerification` (or a thin wrapper) implement
`VerificationDriver` with a `HostEnvironmentDriver` underneath, so FR-6's
gate already flows through the FR-2 seam; add one in-memory driver per
seam in test/ that the pipeline tests use (turning the fake smoke tests
into real adapter tests).

**Benefits.** Locality: one wrapper + adapters. Leverage: M2 plugs into
a seam that is already load-bearing instead of retrofitting. Tests:
pipeline verification through the driver interface.

### C9. Cost/COR accounting is absent at the seam that must carry it — **Worth exploring**, P2

**Files:** `packages/core-v2/src/daemon/task-runner.ts:30`
(`TASK_RUNNER_COST_UNAVAILABLE = 0`); `src/sessions/host.ts:95-105`
(`SessionHandle` exposes no usage); SDK `AgentSession.getSessionStats():
SessionStats` (input/output/cacheRead/cacheWrite tokens) unused.

**Problem.** Receipts carry `costUsd: 0` as an ordinary number —
indistinguishable from a genuinely free run, so router feedback and any
manifest aggregation built on receipts are silently poisoned. NFR-3
requires COR "computed from manifest phase data", but the host — the only
place usage data exists — exposes no capability for it, and its event
forwarder drops every SDK event except four (no `entry_appended`, no
retry/compaction events either). Every M3 feature priced in the contract
(COR accounting, per-role model economics, receipt-driven routing) must
first widen `SessionHandle`, `SessionHostEvent`, and the runner's
observation struct — three coupled edits that a `usage()` accessor on the
handle would have localized.

**Solution.** Add `usage(): {inputTokens, outputTokens, cacheRead,
cacheWrite}` (backed by `getSessionStats()`) to `SessionHandle` now,
thread it into the receipt, and make the cost placeholder `null`-able in
the envelope rather than a fake zero (schema keeps `number`; ledger
stores the sentinel).

**Benefits.** Locality: one accessor + one field. Leverage: M3 COR drops
in without touching the session seam again. Tests: fake handle returning
usage; receipt carries it.

### C10. Spec handling in the worker prompt: double echo + untyped injection surface — **Speculative**, P3

**Files:** `packages/core-v2/src/daemon/task-runner.ts:87-100` (system
prompt embeds the raw spec) and :309-318 (user prompt re-echoes goal +
requirements + verification).

**Problem.** Two smaller smells than defects. (a) The spec is paid for
twice — verbatim in the system prompt and re-serialized in the first user
turn — directly against NFR-3's grounding-token goal; one of the two
copies is redundant (the system copy is the cache-affine one). (b) The
spec is interpolated raw into the *system* prompt with no boundary
markers; a spec body containing "ignore the above" instructions is
indistinguishable from engine rules. The trust model (spec authored by
the daemon-hosted main session) makes this internal today, but surfaces
publish user intent that becomes specs (FR-1), so the boundary should be
explicit before surfaces multiply. (c) `hasOrientationNotes` is decided
by `/orientation/i.test(specMarkdown)` (:200) — a substring heuristic
that quietly redefines a §5.3 router input.

**Solution.** Drop the user-turn re-echo (keep the yield reminder only);
fence the embedded spec in named markers; detect orientation notes from
a parsed section, not a substring.

**Benefits.** Locality: prompt builders only. Leverage: cheaper prefixes
and a defensible trust boundary before M5 surfaces arrive. Tests: prompt
byte-comparison + a spec containing a fake "## Orientation" section.

### C11. `HandoffBundle.attemptNumber` was quietly moved ledger-only — doc/code drift — **Worth exploring**, P3

**Files:** `docs/pi-task-v2-subsystems.md` §2 (schema keeps
`attemptNumber`) vs `packages/core-v2/src/contracts/payloads.ts:60-74,
108-115` (envelope-only).

**Problem.** The subsystems doc removes only `precedingSessionId` from
the prompt-bound schema; the implementation removed `attemptNumber` too,
justifying it in comments via NFR-4. But NFR-4 protects the *prefix* —
the appended handoff may vary per attempt without breaking cache
affinity — and §5.4 implies the retried worker should know its attempt
number. The change may well be right, but it is a silent narrowing of a
normative schema with the doc left stale; the next implementer reading
§2 will build the wrong thing.

**Solution.** Decide: restore `attemptNumber` to the schema, or update
§2 and the NFR-4 argument. Either way, one of the two artifacts changes.

**Benefits.** Locality: one schema or one doc paragraph. Leverage:
keeps the contract the single source of truth — the whole point of
writing it before plugin code. Tests: test-contracts already pins
whichever shape wins.

### C13. M2/M3 seams are under-specified where the port is "VERBATIM" — rework is priced in — **Worth exploring**, P2

**Files:** `packages/core-v2/src/contracts/workspace-driver.ts:28-37`;
`src/contracts/environment-driver.ts:44`; `src/contracts/verification-driver.ts:28`
vs `src/verify/run.ts:53-56`; `src/daemon/task-runner.ts:270`.

**Problem.** Three capability gaps that M2/M3 will hit the moment they
try to build on these seams. (a) FR-4 demands the jj ladder port
"VERBATIM" — atomic revset-union squash tracked by CHANGE id, per-file
union resolution, an `assertMerged` consistency gate, *preserved
workspaces + recovery-guide failure artifacts* on merge failure — but
`WorkspaceDriver.mergeWorkspace` returns only
`{success, conflicts?}`. There is no place for the consistency-gate
evidence, the preserved-workspace handle, or the recovery artifact, so
the first real driver must either bloat the interface or leak the ladder
out of the seam. (b) Verification commands are arbitrary shell strings
(`runVerification` shells `bash -c`, verify/run.ts:53-56), but
`EnvironmentDriver.exec` is argv-shaped (`exec(command, args,[])`,
environment-driver.ts:44) with no shell mode — routing FR-6 through the
FR-5 ladder forces a lossy `exec("bash",["-c",cmd])` shim that drops the
`readOnly`/timeout mapping on every non-host driver. (c) FR-6 says verify
runs "on the merged tree post-merge", and `VerificationDriver.runVerification`
takes a `WorkspaceContext` — but the pipeline hardcodes the runner to
`{cwd: options.cwd}` (task-runner.ts:270) and calls the standalone
function, not the seam, so the context-carrying path the interface
promises is wired to nothing.

**Solution.** Before M2 lands the JujutsuWorkspaceDriver: widen
`mergeWorkspace` to return a typed merge outcome (gate evidence, preserved
workspace id, recovery-artifact path); give `ExecOptions` an explicit
`shell?: string` mode; and make `runTask` call a `VerificationDriver`
bound to a `WorkspaceContext` (even a single in-process directory context)
so FR-6 already flows through the FR-2 seam.

**Benefits.** Locality: three interface edits before any driver exists.
Leverage: the "port unchanged" milestone stops guaranteeing a second
rewrite of the same seams. Tests: a fake driver asserting the widened
outcome shape is threaded through `runTask`.

### C14. `runTask` is the whole pipeline and none of its policy — shallow assembly, good locality — **Worth exploring**, P3

**Files:** `packages/core-v2/src/daemon/task-runner.ts:146-324` (the
~180-line `runTask`).

**Problem.** An honest depth/locality read of the pipeline, since R4 asks
for it. *Locality is genuinely good:* validate→route→host→guard→yield→
verify→ledger→receipt lives in one function, so the M1 behavior has a
single home — that is a real asset and the right shape for assembly. The
weakness is *depth*: `runTask` hides almost nothing behind an interface.
The deletion test is instructive — delete `runTask` and the pipeline
evaporates (so it carries value), but delete the *policy* it inlines and
nothing moves: the orientation-notes heuristic (:200), the feedback-row
reconstruction (:193-197), the repo-basename derivation (:191), the
deterministic-prompt builder (:87-100) are all spelled inline in the
assembly instead of living in the router or a spec-artifact module. That
is why C2's telemetry bug sits in the runner at all — routing policy that
belongs in `router/` is hand-assembled in `daemon/`. Deeper still: the
function returns a receipt but also writes the ledger, writes artifacts,
*and* owns the store's lifecycle, so it cannot be reused for the
batch/flex lanes (FR-10) without re-spelling those side effects.

**Solution.** Not a rewrite — a thinning: move spec parsing + orientation
detection into a typed Spec artifact (fixes FR-3 too), move feedback
assembly into a `router`-side helper that reads raw ledger rows, and
split "decide + execute" from "persist + receipt" so lanes can share the
former. Each step is testable in isolation against the existing fakes.

**Benefits.** Locality: preserves the single assembly point while deepening
the modules it calls. Leverage: M2 parallel lanes and M3 modes reuse the
policy instead of re-inlining it. Tests: the extracted helpers get the
unit coverage the inlined policy currently lacks.

### C15. Minor gate edges: verify output overflow, version/README staleness, artifact path surface — **Speculative**, P3

**Files:** `packages/core-v2/src/verify/run.ts:56-72`; `src/version.ts`;
`packages/core-v2/README.md`; `src/guards/artifacts.ts:94-96`.

**Problem.** A grab-bag of low-severity edges found while reading:
(a) `execFile` with `maxBuffer: 16MB` kills the child on overflow with an
error that is neither `ETIMEDOUT` nor `killed+SIGTERM`, so a
verification command flooding stdout fails as generic exit 1 with empty
tails — misattributed in artifacts; (b) `CORE_V2_MILESTONE` is still
`"M0"`/`"0.0.0-m0"` after M1 completed, and the README has duplicated
layout bullets (`src/daemon/`, `src/guards/` twice) and documents a
verification result shape (`{ passed, failures }`) that differs from the
code (`{ passed, commands }`); (c) `writeFailureArtifact` joins an
uncapped-content-checked `runId` into a filename — engine-generated today
(12 hex chars), but `capTail` keeps the *tail* of an over-long id without
sanitizing separators; (d) the watchdog's in-flight-tool set never
shrinks if a `toolEnd` event is dropped, permanently suppressing
no-progress and letting the per-tool watchdog abort on a tool that
actually finished (oldest-only check).

**Solution.** Respectively: detect buffer-overflow kills and mark them
typed; bump version + de-dup/fix README; sanitize runId to `[A-Za-z0-9_-]`;
cap in-flight age (a toolStart older than the tool bound is already the
abort condition — also treat it as stale-bookkeeping cleanup).

**Benefits.** Locality: each is one function. Leverage: prevents the
small diagnostic-lies that accumulate into FR-8's "archaeology". Tests:
one-liners each in the existing suites.

## Top recommendation

**Fix C1 first — make attempts addressable instead of crashing on a
deterministic task id.** It is the only P0: an uncaught throw on the most
basic operation after "run once" (re-run, retry, requeue), and it sits at
the exact junction where three documented invariants meet — NFR-1's
requeue (which already writes `status='queued'` rows nothing consumes and
which will detonate here), FR-7's bounded retries (whose ledger columns
exist precisely for re-attempts of the same task), and FR-8's "every
failure is diagnosable" (this failure produces no artifact, no receipt,
no terminal row, and leaks the store). It is also the cheapest strong
finding: id derivation + insert are two localized sites, the fix
(family id + attempt discriminator) is the shape the retry machinery
needs anyway, and the reproduction in this review is already the failing
test. Everything else is either a silent-corruption bug that tests can
catch next sprint (C2, C3) or a seam that M2/M3 can still absorb — but a
ledger whose primary key forbids its own retry story cannot be built on.
