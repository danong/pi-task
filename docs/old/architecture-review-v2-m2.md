> **Archive status:** Historical and non-normative. See [`README.md`](README.md) for the active source of truth.

# Architecture review: pi-task-v2 M2 (workspaces, environments, parallel pipeline)

Adversarial spec-fidelity review of the M2 milestone — environment drivers,
the jj workspace driver, the parallel pipeline, and their tests — graded
claim-by-claim against the design contract, followed by a bug hunt (with
reproductions), an M3 rework scan, and an architecture judgment in the
shared survey vocabulary. **No code was changed by this review; this
document is the only artifact.** Continues
[the M0+M1 review](architecture-review-v2.md); the disposition of each
deferred finding it touched is in the Candidates section.

## Scope & method

**Scope.** The M2 commit range only, `uqzlrzommsvy..HEAD` at review time
(4 commits, verified with `jj log -r 'uqzlrzommsvy..@-'`):

- `oovromwm` — `skills/jj/SKILL.md`: fetch-before-work + integration modes
  (solo-main vs multi-author, never-move-main, pi-task cookbook).
- `wmprnprp` — M2.b: `src/environments/drivers.ts` (Host + mise rungs),
  `test/test-environments.ts` (suite #9).
- `nmyqloyv` — M2.c: `src/workspaces/jj.ts` (v1 ladder primitives),
  `src/workspaces/jj-driver.ts` (seam implementation), the
  `src/contracts/workspace-driver.ts` interface growth
  (prepare?/prepareIntegrationBase?/combine?/publishBookmarks?,
  IntegrationMode, CombineOutcome), `test/test-jj-driver.ts` (suite #10).
- `pmppnwky` — M2.d: `src/daemon/parallel.ts` (`runParallelTask`),
  `test/test-parallel.ts` (suite #11), `test/e2e-parallel.ts` (manual
  gate), the HostEnvironmentDriver argv-preservation fix, README.

`src/daemon/task-runner.ts` was NOT touched in M2 (verified by range
diff); its review-fix state (attempt ids, raw routing rows) is baseline.
Reference semantics: `extensions/task/workspace.ts` (v1 ladder, read-only).

**Docs graded against.** `docs/pi-task-v2.md` (contract: FR-4 merge
ladder, FR-5 environment ladder, FR-6 gates on the merged tree, §5.4
repair/escalation, §8 milestone table) and
`docs/pi-task-v2-subsystems.md` (§1 kernel interfaces, §4 ledger). Note:
the subsystems-doc edits the milestone history mentions (attemptNumber
ledger-only note, M1 milestone annotation) landed in the baseline
review-fix commit `uqzlrzommsvy`, not in M2.

**Method.** Read both design docs, the prior review, then every M2 file
(~1.6k lines of src/tests) plus the v1 reference. Suspected defects were
confirmed with throwaway probes under `/tmp` (never the repo): the
parallel re-run collision (two independent failure modes) and the stale
bookmark were both reproduced against the real modules with real jj.
Gates re-run at review time: `mise run test` green (11 hermetic suites,
including the three new ones; the manual e2e gates were not run — no
network/auth assumption).

**Vocabulary.** Module/depth, seam/adapter, leverage, locality, deletion
test as defined in the survey contract; findings tagged **Strong** |
**Worth exploring** | **Speculative**, prioritized P0..P3.

## Spec-fidelity table

Verdicts: **HELD** — implemented as documented; **PARTIAL** — implemented
but quietly narrowed or incomplete; **VIOLATED** — a documented invariant
is broken. Evidence is file:line under `packages/core-v2/` unless noted;
the v1 reference is `extensions/task/workspace.ts`.

| # | Requirement | Verdict | Evidence |
| :- | :---- | :- | :---- |
| FR-4a | Atomic combine: ONE revset-union squash tracked by CHANGE id | **HELD** | `src/workspaces/jj.ts:275-297` — `mergeWorkspacesAtomic` resolves the base CHANGE id to a commit immediately before the single `jj squash --from '(base..w1)\|(base..w2)' --into <commit>`, then re-resolves the change for the new base; identical to v1 (`assertWorkspacesConsumed` at jj.ts:183-195 checks each workspace vs its OWN parent, avoiding v1's documented false-alarm class). |
| FR-4b | Per-file union resolution isolating tool failures | **HELD** | jj.ts:225-239 — one `jj resolve --tool union` invocation per file, commit id re-resolved before each (each success rewrites the base); union tool is `git merge-file --union` with the `test -s` empty-output guard (jj.ts:200-207), verbatim from v1. Exercised against real conflicting edits in test-jj-driver.ts. |
| FR-4c | Loud divergent-change failures, never a stale/arbitrary squash target | **HELD** | jj.ts:99-125 — `resolveCommitId` rejects "is divergent" and "doesn't exist" with typed loud errors and validates the 40-hex shape. Minor: v1's `assertVisibleCommit` all-zero-id defensive guard did not port (no jj version in scope is known to produce it). |
| FR-4d | `--ignore-working-copy` read discipline | **HELD** (v1 parity) | Present on every revset-evaluating read (jj.ts:101, 133, 158, 250); `jj diff` with explicit commit ids omits it exactly where v1 does (jj.ts:176, 290, 348). The discipline holds where it matters — no jj call runs during concurrent worker sessions except reads of explicit commits — but see M5 card: the op-log-fork exposure is inherited, not retired. |
| FR-4e | `JJ_EDITOR` on editor-prone calls | **HELD** | jj.ts:36 — `JJ_EDITOR: "true"` in the env of EVERY `execJj` child (broader than needed, safe). |
| FR-4f | Bounded every-call timeouts | **HELD** | jj.ts:23 `DEFAULT_JJ_TIMEOUT_MS = 120s` is the default of every call; timeouts resolve `code 1 + timedOut` with the bound named in stderr (jj.ts:42-50); `isSupported` uses a tight 10s probe (jj-driver.ts:81). |
| FR-4g | AI-authored integration base identity | **HELD** | jj.ts:140-164 — temp `[user]` TOML written per base, applied via `--config-file` (merges with user config, keeping revset aliases — the v1 empirical finding), base described with the goal. Minor: the temp identity dir is never deleted. |
| FR-4h | Consistency gate over the pre-merge file union — tree AND disk | **HELD** | jj.ts:246-271 — `jj file list -r <merged>` tree check (non-empty + union presence) plus `existsSync` disk check, invoked inside `combine()` after the union ladder (jj-driver.ts:155-159). Expected union computed pre-merge per context, deletions excluded (jj-driver.ts:144-149) — v1 parity. The disk half passes pre-checkout because `jj squash` into the working-copy commit follows the rewrite onto disk — a subtle jj behavior the interface does not document (see M5). |
| FR-4i | Failed merges PRESERVE workspaces and emit recovery artifacts | **PARTIAL** | Preservation holds only by accident — nothing ever cleans up (see M1: `cleanupWorkspace` is never called by the pipeline, success or failure). Recovery artifacts: written for residual-conflict escalation (parallel.ts:198-203) but NOT for squash/gate/checkout throws (they escape `runParallelTask` bare — no catch), and the artifact shape carries no workspace paths/commit ids/recovery guide, which v1's failure artifacts recorded (contract §1 comment promises "recovery-guide failure artifacts"; FR-8 "scripted recovery guides" still unported). Candidate M3. |
| FR-5a | argv preservation through the environment ladder | **HELD** | drivers.ts:38-68 — `execArgv` passes command+args to `execFile` untouched; the flattening `bash -c` wrapper found in M2.d's own e2e is gone and the rationale is documented in the comment. Mise wraps as `mise exec -- <cmd> <args>` (drivers.ts:108) — boundaries preserved. |
| FR-5b | Timeout kill → exit-124 convention | **HELD** | drivers.ts:32 `ENV_TIMEOUT_EXIT_CODE = 124`; killed-by-timeout resolves 124 + `timedOut` (drivers.ts:56-62); matches verify/run.ts's convention and `timeout(1)`. Tested (test-environments.ts, 250ms kill of `sleep 5`). |
| FR-5c | Mise capability detection degrades gracefully (NFR-2) | **HELD** | drivers.ts:86-92, 115-117 — `createMiseDriverIfAvailable()` returns null when the binary is absent; detection agreement tested hermetically. Zero-mise configuration remains fully functional (host rung). |
| FR-5d | ALL commands execute through an EnvironmentDriver | **PARTIAL** | True only of the parallel verification pass (parallel.ts:219). The single-task pipeline still calls the standalone `runVerification` with its own hardcoded `/bin/bash -c` (task-runner.ts:300) — the FR-5 ladder does not reach the most common path, and the VerificationDriver seam still has zero implementations (deferred C8 disposition below). |
| FR-6a | ONE verification pass on the integrated tree, through the env driver, never trusting worker claims | **HELD** (task-base mode) | parallel.ts:213-221 — after `checkoutMerged`, every sub-spec's commands (flatMap of ALL parsed specs) run once through `env.exec` on `projectDir`, after combine + consistency gate; worker yield claims contribute nothing to the verdict. |
| FR-6b | Per-command timeouts, wall expiry with bounded grace | **PARTIAL** | The parallel gate bypasses the verify runner: each command gets the env driver's 10-minute default, but there is NO suite wall (N specs × 10m is unbounded), no bounded-grace semantics, and failures surface as `"<cmd> (exit N)"` strings — no stderr tails into the failure artifact (parallel.ts:218-221, 224-227). The runner with all three properties exists and is unused here (verify/run.ts:88-112). Candidate M6. |
| FR-6c | Feature-branch mode leaves integration to the operator | **HELD** | jj-driver.ts:112-115 (mergeWorkspace bookmarks only), 138-141 (`combine()` refuses in feature-branch mode); parallel.ts:181-190 publishes bookmarks and returns without any gate — per the M2 mode contract. Consequence worth stating: the aggregate receipt can say `"ship"` with ZERO verification commands ever executed (test-parallel asserts this as intended); FR-6's "completion is a fact" then rests entirely on the operator. Tension noted, not scored against M2. |
| §5.4 | Residual conflicts escalate (verdict escalate), never ship | **HELD** | parallel.ts:196-208 — post-union `detectChangeConflicts` non-empty ⇒ failure artifact + ledger `escalated` + receipt verdict `"escalate"` carrying the merged commit id. (The path is untested end-to-end — candidate M8.) |
| §5.4 | Fetch-before-work non-fatal | **HELD** | jj.ts:64-74 — `hasGitRemote` returns false on any failure; `jj git fetch` result is ignored; wired as `prepare()` step 0 (jj-driver.ts:85-91), idempotent per driver. Local-only repos pass (tested). |
| §1 | M2 interface growth (combine/publishBookmarks/…) as documented | **PARTIAL** | The CONTRACT file grew and self-documents (contracts/workspace-driver.ts:24-63: IntegrationMode, prepare?, prepareIntegrationBase?, combine?, publishBookmarks?, CombineOutcome) — the anticipated C13(a) gap, addressed. But the normative `subsystems.md §1` (docs/pi-task-v2-subsystems.md:23-29) still shows the five-method M0 interface — the single-source-of-truth doc for kernel seams was never updated. Worse, `checkoutMerged` — load-bearing for FR-6 (materializes the integrated tree) — is in NEITHER doc nor interface; the pipeline reaches it by structural cast (parallel.ts:215). Candidate M5. |
| FR-8 | Diagnostics on the parallel failure paths | **PARTIAL** | Per-worker failures get artifacts with cause + `lastTool: "session"` (parallel.ts:156-166) — but no last-event serialization (the observation holds it), no workspace path/commit-id for the stranded work, and the failed worker's workspace content drops out of every artifact (candidate M4). Watchdog aborts are typed. |
| NFR-1 | Ledger rows per attempt + aggregate | **PARTIAL** | Rows are written (aggregate `${family}-p`, per-worker `${family}-${i}`, micro-sessions; parallel.ts:97-108) and the store is opened once per run and closed in finally (parallel.ts:71-77 — the M1 per-run-leak pattern fixed for this lane). But per-worker rows are set `completed` BEFORE combine/verify (parallel.ts:170-173), so a failed/escalated aggregate leaves "completed" children under a failed parent, and the ids are non-attempt — candidate M1/M4. |

## Candidates

### M1. A second parallel run is impossible — deterministic ids crash the ledger, leaked workspaces block jj, and an orphan AI base is left behind — **Strong**, P0

**Files:** `packages/core-v2/src/daemon/parallel.ts:87, 97-104, 108`
(deterministic inserts); `src/daemon/task-runner.ts:114-124`
(`resolveAttemptId` — exists, unused here); `src/workspaces/jj.ts:170-181`
(workspace names = `v2-task-<taskId>`); `src/daemon/parallel.ts` — no
`cleanupWorkspace` call anywhere.

**Problem.** This is the M0/M1 review's C1 (task-id collision),
**re-introduced in the M2 lane** after the single-task lane was fixed.
`runParallelTask` derives `familyBase = deriveTaskId(goals, projectDir)`
and unconditionally inserts `${familyBase}-p`, `${familyBase}-${i}`, and
`${taskId}-worker` rows — no attempt discriminator. Every id is a
content hash, so every re-run (retry, flaky-spec re-dispatch, the bench
suites 01/02 that M2's own exit criterion runs repeatedly, NFR-1
requeue once a dispatcher exists) is a collision. Reproduced with real
jj + fake workers:

- Run 1 ships. Run 2 (same specs, same DB): after `prepare()` and
  `prepareIntegrationBase()` succeed — i.e. **after creating a second
  AI-authored task-base commit in the user's repo** — the aggregate
  insert throws `UNIQUE constraint failed: tasks.id`. The throw escapes
  `runParallelTask` (only `finally { store.close() }`): no artifact, no
  receipt, no terminal ledger state, orphan commit left in `jj log`.
- Run 3 (fresh DB, same repo — so the ledger can't be the only wall):
  `jj workspace add "v2-task-<family>-0" failed: Workspace named …
  already exists`. Run 1's workspaces were never forgotten or deleted —
  `cleanupWorkspace` is never called on ANY path, success included.
  Successful runs leak two jj workspace registrations plus a temp dir
  each, forever.

So re-runs are blocked twice over, and the "preserve workspaces on
failure" invariant is indistinguishable from "we never clean up".

**Solution.** (1) Reuse the attempt pattern already in task-runner:
`resolveAttemptId` for the aggregate and per-worker rows. (2) Suffix
workspace and bookmark names with the attempt so jj names never collide
across attempts. (3) Call `cleanupWorkspace` for healthy contexts after
the consistency gate AND verification pass (v1's exact ordering), and on
feature-branch after bookmark publish; keep failed/escalated workspaces
and record them (M3/M4). (4) Move `prepareIntegrationBase` AFTER the
ledger insert so a doomed run cannot litter the repo with AI bases.

**Benefits.** Locality: one id-derivation site, one naming site, one
cleanup policy — all in/around parallel.ts. Leverage: unblocks the M2
exit criterion's own bench suites (repeated specs), FR-7 retries, NFR-1
requeue, and makes "preserved" mean something. Tests: the reproduction
above becomes a hermetic two-run test in test-parallel.

### M2. `createBookmarkAt` silently succeeds while the bookmark points at a stale (eventually hidden) commit — **Strong**, P1

**Files:** `packages/core-v2/src/workspaces/jj.ts:351-358`; consumers:
`src/workspaces/jj-driver.ts:113, 170-176` (mergeWorkspace /
publishBookmarks in feature-branch mode).

**Problem.** When `jj bookmark create` fails, the fallback runs
`jj bookmark list <name>` and treats any success as idempotent
completion. The in-code comment states the precondition — "Already-exists
is idempotent-safe only if it points at the same commit" — and the code
does not check it. Reproduced: publish `feat-x` at workspace tip T1,
advance the workspace to T2, re-publish: no error, `jj bookmark list`
reports `feat-x` at T1 — which jj has by then marked `(hidden)` — while
the pipeline reports the bookmark published. With M1's deterministic
names, a re-run in feature-branch mode re-publishes the SAME bookmark
names, so the operator is told fresh work shipped while the bookmark
points at last run's (possibly hidden) commit. Silent staleness at the
exact human-handoff surface feature-branch mode exists for.

**Solution.** In the fallback, resolve the existing bookmark's target
(`jj log -r <name> -T commit_id`) and compare with the workspace tip:
same commit → idempotent success; different → `jj bookmark move` (or a
loud typed error naming both commits). Never report success on an
unchecked fallback.

**Benefits.** Locality: one function. Leverage: makes feature-branch
mode's only output trustworthy. Tests: the reproduction is the test
(create → advance → re-publish → assert bookmark tracks the tip).

### M3. Combine/gate/checkout failures escape bare — no artifact, ledger frozen "executing", no recovery data — **Strong**, P1

**Files:** `packages/core-v2/src/daemon/parallel.ts:193-235` (no
try/catch around `combine!`, `checkoutMerged`, or the verification loop);
`src/guards/artifacts.ts:36-41` (FailureArtifact shape).

**Problem.** FR-4: "Failed merges PRESERVE the workspaces and emit
recovery artifacts." The residual-conflict branch does emit one
(parallel.ts:198-203), but every HARD failure of the merge ladder —
squash failure, `assertWorkspacesConsumed` leftover detection,
`assertMerged` consistency-gate failure, `checkoutMerged` failure, even
an env-driver throw mid-verification — propagates out of
`runParallelTask` as a bare exception: the ledger's aggregate row stays
`executing` forever (boot reconciliation will later "reap" a run that
has already half-merged), no failure artifact is written, and no receipt
is returned. Preservation only holds because nothing is ever cleaned up
(M1). Compounding it, the artifact shape itself cannot carry what a
recovery guide needs — no workspace paths, no workspace/base commit ids,
no conflicted-hunk payload (v1 exported `conflictHunks` and recorded
workspace commit ids precisely for this; neither ported), no scripted
recovery steps (FR-8's "scripted recovery guides", flagged in the M0/M1
review, still absent).

**Solution.** Wrap the integration section in a typed failure handler:
on any ladder throw, write an artifact carrying the base change id, each
workspace's dir + tip commit id (the primitives to collect them exist —
`workspaceCommitId`), the jj stderr tail, and set the aggregate row to
`failed`/`escalated` before rethrowing or returning a failed result.
Extend `FailureArtifact` with an optional `recovery` block. Then decide
the cleanup policy explicitly (preserve-and-record on failure) instead
of inheriting it from the absence of cleanup.

**Benefits.** Locality: one try/catch + one shape extension. Leverage:
restores FR-8's "every failure is diagnosable" for the most complex path
in the system; gives NFR-1 reconciliation a terminal state to read.
Tests: a driver stub whose `combine` throws asserts artifact + ledger
terminal status.

### M4. Per-worker rows are marked "completed"/"ship" BEFORE the merged-tree gate — and a failed worker's persisted work vanishes from every record — **Strong**, P1

**Files:** `packages/core-v2/src/daemon/parallel.ts:170-173` (per-worker
ship receipts + `setTaskStatus(completed)` pre-gate), :193
(`healthyContexts` filter), :206/:231 (aggregate `filesChanged: 0`),
:224-227 (aggregate artifact on worker failure).

**Problem.** Three receipt/ledger mismatches in one section.
(a) Each yielded worker gets verdict `"ship"` and ledger status
`completed` the moment prompts settle — before combine, before the gate.
When verification then fails or conflicts escalate, the ledger shows
`completed` children under a `failed`/`escalated` parent; NFR-1 says
recovery reads the ledger, and the ledger lies. (b) The aggregate
receipt reports `filesChanged: 0` on both the escalate and failed
branches even though healthy work LANDED (the merged commit id is right
there in `commitIds`) — under-reporting that poisons any manifest
aggregation, mirroring the M0/M1 cost-placeholder pattern. (c) The
`healthyContexts` filter drops the failed worker's workspace from the
combine — correct — but that workspace may hold PERSISTED commits and
uncommitted work, and nothing records it: the per-worker artifact says
"settled without yield" with `lastTool: "session"` and no path; the
aggregate artifact says "one or more workers failed" and names no one.
The work is findable only by jj archaeology — precisely what FR-8
forbids.

**Solution.** Two-phase bookkeeping: per-worker receipts/ledger go to an
intermediate state (`verifying` — the enum already has it) at yield,
promoted only when the aggregate ships; on aggregate failure, demote
with the aggregate. Report `filesChanged` from the combine's actual
union (the pre-merge expected-files set is already computed). Enrich the
failed-worker artifact with the workspace dir + tip commit id, and list
stranded workspaces in the aggregate artifact.

**Benefits.** Locality: one bookkeeping block. Leverage: receipts and
ledger become trustworthy inputs for M3's manifest/COR work and for the
operator's escalation queue. Tests: the existing mixed-failure case
extended to assert intermediate-then-demoted statuses and the artifact
contents.

### M5. The seam grew in code but not in the contract doc — and `checkoutMerged`, the FR-6 linchpin, lives behind a cast — **Strong**, P1

**Files:** `packages/core-v2/src/contracts/workspace-driver.ts:24-63`
(growth) vs `docs/pi-task-v2-subsystems.md:23-29` (stale five-method
interface); `packages/core-v2/src/daemon/parallel.ts:93-95`
(`prepareIntegrationBase as NonNullable<…>` cast), :194 (`combine!`
non-null assertion), :215 (`checkoutMerged` via structural cast).

**Problem.** The interface growth itself is the right call — it closes
the M0/M1 C13(a) gap (merge evidence and multi-worker combine had no
home). But: (a) subsystems §1 — the normative kernel-interface doc, the
one FR-2 says precedes implementation — was never updated; the next
implementer reading it builds against a five-method interface. (b)
`checkoutMerged` — the operation that materializes the integrated tree
so FR-6's gate runs on it — is on the driver class only; the pipeline
reaches it through `as { checkoutMerged?(…) }` and the `?.` means a
driver lacking it is SILENTLY skipped, running verification on an
un-materialized tree (the consistency gate's disk check would usually
catch it — usually). A behavior the contract's FR-6 depends on is
invisible to the contract. (c) The casts paper over a mode-model hole:
per the contract's own comment, `integrationMode === undefined` means
"single-workspace driver" — but parallel.ts routes exactly those drivers
into `prepareIntegrationBase as NonNullable(...)` and `combine!(…)`,
which throw TypeError/crash at runtime instead of failing typed.

**Solution.** Promote `checkoutMerged` (or a `materialize(context)`
returning the verification cwd) into the interface; make the parallel
pipeline take a `TaskBaseCapableDriver` narrowed type or feature-detect
with a typed error; update subsystems §1 to the grown interface (one doc
block). Delete the casts.

**Benefits.** Locality: one interface, one doc block, two call sites.
Leverage: the seam stops drifting the milestone after it grew; M3/M4
drivers (git-worktree, direct-directory) implement against the real
contract. Tests: a minimal single-workspace fake driver run through
`runParallelTask` must fail TYPED, not with TypeError.

### M6. The parallel gate bypasses the verification runner — no suite wall, no grace, no stderr tails; the single lane bypasses the environment ladder — **Worth exploring**, P2

**Files:** `packages/core-v2/src/daemon/parallel.ts:217-221` (inline
`env.exec` loop) vs `src/verify/run.ts:88-112` (wall + bounded grace +
capped tails); `src/daemon/task-runner.ts:300` (single lane hardcodes
the runner's own bash, skipping EnvironmentDriver).

**Problem.** FR-6 names three properties: per-command timeouts, wall
expiry, bounded grace. The parallel lane re-implements the first with
the env driver's 10-minute default, drops the wall entirely (N sub-specs
× 10m is unbounded — a hung suite in spec 1 of 5 burns 50m before spec 2
starts), drops grace, and records failures as `(exit N)` strings — the
failure artifact gets no stderr tail, so FR-8 diagnostics on the most
expensive failure class are one line. Meanwhile the single-task lane has
the runner but not the ladder (FR-5d). The two halves of FR-5+FR-6 each
exist; no path has both. This is deferred-C8's exact prediction: without
a `VerificationDriver` adapter bound to a `WorkspaceContext`, each
pipeline re-wires verification by hand.

**Solution.** One adapter: `VerificationDriver` implementation that runs
`runVerification`'s semantics THROUGH `EnvironmentDriver.exec` (argv is
already preserved; `exec("/bin/bash", ["-c", cmd])` is the documented
caller-side pattern) against the context's resolved path. Both lanes
call it; parallel gets wall/grace/tails for free; single gets the ladder.

**Benefits.** Locality: one adapter + two call sites. Leverage: FR-6
semantics stop being per-lane folklore; C8 finally closes. Tests:
adapter tests over the fake env driver asserting wall-expiry and
tail capture thread into the artifact.

### M7. `routing_feedback` from the parallel lane is dead data — wrong vocabulary, success-only — **Worth exploring**, P2

**Files:** `packages/core-v2/src/daemon/parallel.ts:238`
(`recordRoutingFeedback(repo, "task-base", 1)`); `src/router/route.ts:44-45`
(router reads ONLY `bundle`/`fork` mode keys and "ignores every other
mode as non-evidence"); `src/router/route.ts:129-146`.

**Problem.** Tracing the §5.4 loop end-to-end as R3 asks: the single
lane now feeds the router correctly (baseline fix — `store.routingRows`
raw rows into `routeTask`, task-runner.ts:220). The parallel lane writes
real rows too — but with mode `"task-base"`, an INTEGRATION mode, into a
table whose only consumers count GROUNDING modes; the router discards
them by design. The rows accumulate forever, success-only (no row on
verification failure or escalation), in a column whose semantics are
"bundle grounded turn 1 / fork clean". Two writers, one table, disjoint
vocabularies — §5.4's "the router consumes this" is true for one lane
and silently false for the other.

**Solution.** Decide what a parallel run's telemetry IS: either record
per-worker grounding-mode rows (each worker was a cold-start; that is
real evidence) and drop the integration-mode row, or move
integration-mode outcomes to the `workspaces` table where the ledger
already has room. Either way, record misses too.

**Benefits.** Locality: one record site. Leverage: keeps the ledger's
telemetry table honest before M3 starts learning from it. Tests: a
parallel run followed by `routeTask` over the repo's rows asserts the
router's evidence set contains no junk modes.

### M8. Test gaps: the escalate path is untested end-to-end (the suite header claims otherwise), and the adversarial jj paths are unprobed — **Worth exploring**, P2

**Files:** `packages/core-v2/test/test-parallel.ts:4` (header: "residual
conflicts escalate (fake workspace driver)") vs the body (three cases:
clean combine, mixed failure, feature-branch — NO escalate case, no fake
workspace driver); `test/test-jj-driver.ts`; `test/e2e-parallel.ts`
(manual gate).

**Problem.** The good news first: these suites are materially better
than happy-path fakes — real colocated jj repos, real squashes, a real
union resolution asserted on file content, a real consistency gate, real
bookmarks; the fake workers even commit via jj so the squash actually
consumes commits. The gaps are the adversarial tails: (a) the escalate
branch (parallel.ts:196-208) — artifact write, verdict, ledger
`escalated` — has zero end-to-end coverage despite the header claim;
(b) no combine-THROWS case (M3's bare-escape path); (c) no re-run case
(M1's two walls); (d) no bookmark re-publish case (M2); (e) the
consistency-gate-fails-INSIDE-combine case is simulated by calling
`assertMerged` directly after deleting a file, never through
`driver.combine`; (f) no binary-file conflict (union tool exits 255 →
residual conflict through the real ladder); (g) e2e-parallel is manual
and skips without auth — FR-11's "real-path smoke per seam" remains an
ungated manual step, as in M0/M1. The fake workers also hide everything
workers do with jj INSIDE their workspaces (op-log behavior, divergent
changes from concurrent ops), which only e2e covers.

**Solution.** Add the four hermetic cases (escalate via a driver stub
returning conflicts; combine-throws; re-run; re-publish) — each is a
direct regression test for an M1–M4 finding here; keep e2e manual but
say so in the header (fix the stale claim either way).

**Benefits.** Locality: one test file per case. Leverage: every P0/P1
finding of this review becomes a red-on-regression gate. Tests: these
ARE the tests.

### M9. M3 weakspots wired into the new seams — **Worth exploring**, P2

**Files:** `packages/core-v2/src/sessions/host.ts:90-105`
(`SessionHandle` surface); `src/daemon/parallel.ts:32, 115-126, 139-144`
(cost placeholder, spawn shape, prompt construction);
`src/ledger/store.ts:175-177` (WAL, no busy timeout).

**Problem.** What M3 must break or widen, traced now: (a) **Cost/COR:**
`SessionHandle` still exposes no usage/stats (deferred C9 unresolved);
M2 duplicated the placeholder pattern (`PARALLEL_COST_UNAVAILABLE = 0`,
serialized as an ordinary number — a genuinely-free run is
indistinguishable). M3 bundle generation and COR accounting both need
`getSessionStats()` surfaced: per-worker usage must thread observations
→ per-worker receipts → aggregate, a three-site widening one `usage()`
accessor would localize. (b) **Grounding modes:** `runParallelTask`
re-spells prompt construction inline (parallel.ts:139-144, a copy of
task-runner's private `buildWorkerPromptText`) and spawn takes only
`systemPrompt` — prewalk/bundle/fork injection has no seam to attach to
and will have to edit BOTH pipelines; fork mode additionally needs
main-session transcript access the `SessionHost` interface does not
expose, and prewalk's strong→cheap swap needs mid-session model control
the handle lacks. (c) **Routing:** M7's junk rows mean M3's learner
inherits two writers with disjoint vocabularies. (d) **Concurrency:**
the ledger has WAL (good — C7 partially addressed) but no busy timeout,
and e2e-parallel already opens TWO `LedgerStore`s on one file
(daemon + pipeline); the moment a dispatcher runs lanes concurrently,
`node:sqlite` writers will surface `SQLITE_BUSY` immediately.

**Solution.** Before M3: add `usage()` to `SessionHandle`; extract one
`buildWorkerPrompt(spec, grounding?)` shared by both lanes; define the
fork/transcript read on `SessionHost`; set a busy timeout at store open.

**Benefits.** Leverage: M3 grounding modes then attach at seams instead
of rewriting both pipelines — the exact rework C13 priced in and M2 only
half-avoided.

### M10. Architecture read: where the depth lives, what the driver earns, and the IntegrationMode deletion test — **Worth exploring**, P3

**Files:** `packages/core-v2/src/workspaces/jj.ts` (~360 lines),
`src/workspaces/jj-driver.ts` (~185), `src/daemon/parallel.ts` (~250).

**Judgment.** *Depth:* the depth is in `jj.ts` and it is real depth —
fifteen named functions hiding forty commits' worth of empirical jj 0.43
mechanics (change-id tracking, op-log-fork signatures, union-tool
contracts, WC-follows-squash behavior), each with the failure class it
prevents documented inline. `jj-driver.ts` is deliberately shallow glue:
mode branching, idempotency caches (`#prepared`, `#baseChangeId`), and
the ladder orchestration order. That split is the right shape — the
primitives are reusable by the future git-worktree/direct-directory
drivers the contract promises — but the driver's one deep decision (the
consistency gate runs BEFORE checkout; the gate's disk half relies on
the squash rewriting the working-copy commit onto disk) is inherited
implicitly and nowhere stated, which is how M5's `checkoutMerged` cast
happened. *Locality:* `runParallelTask` has genuinely good assembly
locality — provision → fan-out → combine → gate → verify → ledger in one
function — but its depth is poor in the same way the M0/M1 review found
of `runTask`: prompt construction, the verification loop, receipt
bookkeeping, and the telemetry choice are spelled inline instead of
reused (M6/M7/M9 are all children of this). The pipeline also owns its
ledger store per invocation, so a future dispatcher cannot share one
store across lanes without surgery. *IntegrationMode deletion test:*
delete it and feature-branch mode evaporates, so it carries real weight
— but the two modes share nothing but provisioning (one refuses
`combine`, the other never uses `publishBookmarks`; `mergeWorkspace`
means two unrelated things). It is two drivers in one trench coat; the
optional-method scars (`combine?`/`publishBookmarks?` plus the casts)
are the tell. Two classes over the shared primitives module would
express the same config choice with a smaller surface; the mode enum
should at least stop pretending a single-workspace driver
(`integrationMode === undefined`) can be routed through the task-base
branch (M5c). *Test quality:* the honest strength of M2 —
test-jj-driver/test-parallel exercise REAL jj (colocated repos, real
atomic squash, real union resolution asserted on file content, real gate
failures), not happy-path fakes; the gap is the adversarial tail (M8),
which is exactly where real jj has historically bitten this codebase.

**Solution.** Not a rewrite: state the gate/checkout ordering contract
in the driver's doc comment, extract the inline policy (M6/M7), and when
a second integration mode or a second driver lands, split the class
rather than growing the optional-method surface.

**Benefits.** Leverage: keeps the primitives module the shared asset and
stops the seam from accumulating casts before M4 extracts plugins
against it.

### M11. Minor edges found while reading — **Speculative**, P3

**Files / problems.** (a) `void store;` dead statement in the receipt
loop (`src/daemon/parallel.ts:152`) — leftover scaffolding. (b) Unused
imports: `SessionHostError` (parallel.ts:27), `taskBaseChangeId`
(src/workspaces/jj-driver.ts:36, test/test-jj-driver.ts:15). (c) The AI
identity temp dir (jj.ts:140-146) is never removed — one leak per
parallel run. (d) `Promise.all` over spawns (parallel.ts:114): a spawn
failure on worker k leaks handles 0..k-1 (never closed, watchdogs never
attached) and leaves their ledger rows "executing". (e) v1's
`assertVisibleCommit` all-zero-commit guard did not port (FR-4c note).
(f) `writeIdentityFile` interpolates author name/email into TOML without
escaping — safe with the defaults, a trap for configured identities.
(g) `isMiseAvailable` resolves false on any exec error — correct
degradation, but indistinguishable from "mise crashed"; fine at M2.

**Solution.** Respectively: delete; delete; rm in finally; catch-around
spawn loop that closes prior handles and terminates the typed; port the
guard; escape or validate; leave.

**Benefits.** Locality: one-liners. Leverage: removes the small lies
that accumulate into FR-8 archaeology.

### Dispositions of the deferred M0/M1 findings this review checked

- **C1 (task-id collision, P0):** FIXED for the single lane in the
  baseline commit (`resolveAttemptId`, task-runner.ts:114-124) — then
  **RE-INTRODUCED** in the parallel lane, with a second jj-level wall.
  → Candidate M1, P0 again.
- **C2 (telemetry mangling, P1):** FIXED for the single lane (raw
  `routingRows` fed to `routeTask`, task-runner.ts:220). The parallel
  lane writes rows the router ignores by vocabulary. → Candidate M7.
- **C3 (orphan suites):** RESOLVED in the baseline; all 11 suites
  registered in run-all.ts, verified green at review time.
- **C8 (VerificationDriver adapter):** UNRESOLVED — zero implementations
  still; M2 wired the parallel gate through `EnvironmentDriver.exec`
  (progress on FR-5/FR-6 coupling) but re-implemented gate semantics
  inline and left the single lane on raw bash. → Candidate M6.
- **C9 (cost/COR seam):** UNRESOLVED — no `usage()` on the handle; M2
  duplicated the zero-cost placeholder into the parallel lane. → M9(a).
- **C13 (under-specified seams):** PARTIALLY RESOLVED — (a) the merge
  outcome now has a home (`combine`/`CombineOutcome`/interface growth),
  though the doc lagged (M5); (b) shell-mode exec not added — the
  pipeline uses the caller-side `("/bin/bash", ["-c", cmd])` argv shim,
  acceptable for host/mise rungs, still open for container rungs;
  (c) verification bound to a `WorkspaceContext` still absent
  (cwd hardcoded, `checkoutMerged` behind a cast). → M5/M6.

## Top recommendation

**Fix M1 first — make parallel runs re-runnable: attempt-discriminated
ledger ids, attempt-suffixed workspace names, and gate-ordered cleanup.**
It is the only P0 and it was reproduced twice in two independent layers:
the ledger rejects any second run with `UNIQUE constraint failed:
tasks.id` (after polluting the repo with an orphan AI-authored base
commit), and even a fresh database cannot re-run because run 1's
workspaces were never forgotten — `jj workspace add` refuses the
deterministic names. No other finding blocks as much: M2's own exit
criterion (bench suites 01/02) re-runs specs by construction, FR-7
retries and NFR-1 requeue both need re-entry, and the "workspaces are
preserved on failure" guarantee is currently unprovable because nothing
is ever cleaned up on success either. It is also the cheapest strong
fix: the attempt machinery already exists one file away
(`resolveAttemptId`), workspace naming is one template string, and the
cleanup ordering (gate + verify pass → `cleanupWorkspace`) is v1's
documented semantics. M2–M4's bookkeeping and artifact fixes are real
but recoverable after the fact; a pipeline whose second invocation
cannot start cannot be built on.
