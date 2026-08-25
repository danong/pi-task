# Architecture review: the worker no-yield failure handling

An adversarial review of the three-layer fix for the "worker ended without
calling yield()" failure class — commits `qknrrwxysyup` (`0ab3c58e`, advertise /
salvage / prompt) and `tkwwlnqryxku` (`d5338b52`, diagnostics.cause matching).
The question: is the layered design good architecture, or three patches over
one missing interface?

**Verdict up front.** Tactically the fix is excellent — each layer is small,
tested, and independently justified, and the verified-salvage gate refuses to
claim success without evidence. Strategically it is papering. All three layers
treat symptoms of a single interface gap: **the worker's completion protocol is
not a first-class typed contract**. The prompt references yield() in prose
(`WORKER_SYSTEM_PROMPT_BASE`, extensions/task/worker.ts:365-387), the tool's
visibility depends on an optional string field filtered silently in another
package (extensions/task/tools/yield.ts:40-46; pi's
`dist/core/system-prompt.js:39-41`), and the orchestrator recognizes the
failure by matching a string constant smuggled through an `Error.diagnostics`
property (extensions/task/orchestrator.ts:198-201,
extensions/task/worker.ts:354). The second commit exists precisely because the
third seam broke silently: `buildAbortError` decorates the message into a
multi-line diagnostic (worker.ts:572-597), strict message equality never
matched, and the salvage path stayed dead in production while looking tested.
That is the signature of a string-typed interface: it compiles, it tests green
against synthetic inputs, and it still fails against the real shape.

Grounding read: `docs/pi-task-design.md` principles (typed contracts, tools
enforce behavior) and the prior `docs/architecture-review.md` survey vocabulary.
No CONTEXT.md exists in the repo.

## Vocabulary

Shared definition set used by every candidate below:

- **Module** — an implementation unit whose interface hides its complexity.
- **Interface** — the contract a module presents; good design pushes
  complexity behind it.
- **Depth** — a powerful implementation behind a simple surface; shallow
  modules expose nearly as much complexity as they hide.
- **Seam** — a clean split line where code can be restructured without
  widespread change.
- **Adapter** — a thin translation layer at a seam isolating two otherwise-
  incompatible interfaces.
- **Leverage** — behavior change per localized edit.
- **Locality** — context needed per change; good locality means a change
  touches few nearby places.
- **Deletion test** — how much value disappears if this module, constant, or
  abstraction were deleted? Deleting something that merely moves complexity is
  shallow; deleting something whose complexity concentrates into a deeper
  module is deepening.

## Candidates

### 1. Replace the string-matched failure cause with a typed failure hierarchy — Strong

**Files:** extensions/task/worker.ts (`NO_YIELD_FAILURE` :354,
`failWorker` :1212, `buildAbortError` :583-597, `WorkerFailureDiagnostics`
:562-568); extensions/task/orchestrator.ts (`isNoYieldFailure` :198-201,
import of `NO_YIELD_FAILURE` :33, gate at :2829-2830);
extensions/task/test-orchestrator.ts :391-408;
extensions/task/test-worker.ts :709-725.

**Problem.** The worker→orchestrator failure seam is a string. `failWorker`
stores a human-readable sentence, `buildAbortError` bakes it into a multi-line
message and attaches it as an undeclared `diagnostics` property on a plain
`Error`, and `isNoYieldFailure` recovers it with a cast-and-compare
(`diag?.cause === NO_YIELD_FAILURE`). This *is* an adapter — a thin translation
isolating the orchestrator from the abort-error shape — and adapters are fine;
what is not fine is that the adapted contract has no compiler-visible
existence. Commit `d5338b52` is the proof: the message-decoration change in
worker.ts broke the orchestrator's equality check, the salvage net went dead,
and nothing failed until a real free-tier run threw away verified work. Two
modules now coordinate through a sentence. The deletion test on
`NO_YIELD_FAILURE`: delete it and four sites break immediately (worker.ts:1080,
orchestrator.ts:33/:200, both test files) — so the constant carries genuine
cross-module coordination value and is *not* shallow decoration. But its value
is exactly the value a type would carry, with none of a type's guarantees:
rename the sentence today and `tsc` passes, the hermetic suite still passes
(tests construct errors *from the same constant*, test-orchestrator.ts:391, so
they can never drift), and only production discovers the silence. Note also
the asymmetry at the gate (orchestrator.ts:2829-2830): the no-yield branch
classifies from the error object while the sibling branch classifies from
session side-state (`checklistCtrl.latest`) — two orthogonal signals OR'd at
the call site because neither channel was designed to carry a structured
outcome.

**Solution.** Introduce a discriminated union of worker failure codes
(e.g. `WorkerFailureCode = "no-yield" | "wall-timeout" | "no-progress" |
"tool-timeout" | "turn-budget" | …` — derive the full set from the `failWorker`
call sites, worker.ts:1042/:1080/:1272/:1280/:1308/:1337). Attach the code as a
declared field on a `WorkerAbortError extends Error` (or keep
`WorkerFailureDiagnostics` but add `code` next to `cause`). `isNoYieldFailure`
shrinks to `err.code === "no-yield"`; the human sentence stays for messages and
failure artifacts. Hermetically testable with zero LLM: the existing
test-orchestrator.ts checks convert mechanically.

**Benefits.**
- *Locality:* adding a new watchdog failure mode becomes one place in
  worker.ts plus one union member, instead of prose-plus-matcher coordinated
  across two files.
- *Leverage:* every future consumer (failure artifacts, parallel-run
  `classifyWorkerFailures` at orchestrator.ts:217, metrics tagging) gets
  machine-readable causes for free.
- *Tests:* the current tests are tautological against string constants; a
  union makes drift a compile error, which is the regression test `d5338b52`
  actually needed.

### 2. Extract the salvaged-success synthesis block — Worth exploring

**Files:** extensions/task/orchestrator.ts, salvage block :2823-2892 vs the
review-disabled success path :2931-3006; `abortedWorkerResult` :355-370;
`finalizeMetrics` call sites at :2862, :2946, :3146.

**Problem.** Commit `0ab3c58e` created the ~70-line salvaged-success block by
cloning the existing success tail: rescue (:2831), `runVerification` (:2832),
commit-id recovery, diff stat, `finalizeMetrics({…assemble…})` (:2862-2888),
and the big return object — all mirrored at :2932-3006 with the yield-payload
fields substituted. Commit `d5338b52` changed none of that structure. The clone
is mostly faithful, which is the problem: the `assemble` payloads (:2862-2888
vs :2946-2972) are ~26 near-identical lines where the meaningful deltas (zeroed
`worker` from `abortedWorkerResult()` vs the real payload, recovered
`commitIds` vs `worker.yield.commit_ids`, synthesized `filesChanged` via
`filesChangedBetween` vs the reported list) sit inline among boilerplate. The
seams show: a stray trailing space inside the caveat template literal
(orchestrator.ts:2900) and the mis-indented `shape:` line (:2866, same glitch
in both blocks) are classic copy-paste fossils. Is the extraction clean?
Partially — the *metrics assembly* half extracts trivially (a
`buildAssembleInput(...)` helper absorbing the identical ~25 lines); the
*return-object* half differs more (disputes, defect adjudication, and
suspected-spec-defect fields exist only in the non-salvage path), and forcing
one function over both risks a flag-riddled shallow abstraction that fails the
deletion test. There is also a third sibling at :3146 (fix-loop path) that
would anchor the helper.

**Solution.** Extract only the stable core: a `finalizeRunMetrics(...)`
helper owning the `assemble` payload construction, parameterized by
`(worker, verification, commits/filesChanged/diffStat, caveat)`. Leave the two
return objects separate — their divergent fields are real information, not
duplication. Do this *after* candidate 1, so the helper can key off a typed
failure code instead of the `noYieldFailure` boolean threaded through the
block.

**Benefits.**
- *Locality:* manifest-shape changes (which happen — see the
  `suspectedSpecDefects`/`disputes` fields added between the two copies)
  touch one site instead of three.
- *Leverage:* moderate; the payoff grows every time a fourth success path
  appears.
- *Tests:* test-metrics.ts already pins `buildRunManifest` purely, so the
  helper inherits hermetic coverage with no new harness.

### 3. Make the promptSnippet enumeration contract explicit — Worth exploring

**Files:** extensions/task/tools/yield.ts :40-46 (snippet + contract comment);
pi's `node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js`
:39-41 (`visibleTools = tools.filter((name) => !!toolSnippets?.[name])`);
extensions/task/tools/checklist.ts :172; extensions/task/test-worker.ts
:715-725.

**Problem.** Layer 1 of the fix (advertise) works by adding an optional string
field. The mechanism is silent omission: register a tool without
`promptSnippet` and it remains fully functional — callable, schema-validated —
yet invisible in the system prompt's Available-tools list. Nothing warns;
the only enforcement is a comment in yield.ts explaining the trap, plus a
hermetic assertion that *this one* tool has the field (test-worker.ts:724-725).
Where does locality break? To understand why a worker ignores yield(), a reader
must hold three facts from three places: the prose instruction in
`WORKER_SYSTEM_PROMPT_BASE` (worker.ts:365-368), the registration detail in
yield.ts:45, and pi's filter behavior in another package's compiled dist. That
is exactly the failure `0ab3c58e` shipped with: the prompt said "call yield()
when complete" while the enumerated toolset omitted yield, and weak models
concluded the tool did not exist. The interface is shallow in the vocabulary's
sense — the complexity (visibility rules) leaks out of the module entirely.

**Solution.** Options in ascending scope: (a) a local registration wrapper in
this extension that throws (or logs loudly) when a tool marked as
completion-critical lacks a `promptSnippet`; (b) extend the hermetic suite to
enumerate every tool file under `tools/` and assert a snippet, so the next
tool cannot regress; (c) upstream: make `promptSnippet` required in
`registerTool`, converting silent omission into a load-time error. (a)+(b) are
an afternoon; (c) is the deep fix and belongs in pi itself, since the
filter-at-a-distance design burns every embedding, not just this one.

**Benefits.**
- *Locality:* tool visibility becomes decidable inside the tool's own file.
- *Leverage:* one guard protects all future worker-side tools (checklist,
  dispute, findings already carry snippets — checklist.ts:172 — so the pattern
  is established but unenforced).
- *Tests:* option (b) is a pure fs+assert addition to test-worker.ts; zero
  LLM, microseconds.

### 4. Move the nudge-once-then-fail policy out of the session runner — Speculative

**Files:** extensions/task/worker.ts (`decideIdleAction` :440-448, dispatch in
the event loop :1069-1083, `WORKER_IDLE_NUDGE_PROMPT` :347-348,
`AGENT_SETTLED_EVENT` :338-344); consumer at orchestrator.ts:2823-2830.

**Problem.** Detection and policy are fused. Detection genuinely belongs in
worker.ts: only the RPC event stream observes `agent_settled` without a
captured payload (worker.ts:338-344 documents why the watchdog must exist —
settled sessions otherwise hang the orchestrator forever). But the *policy* —
nudge exactly once with a specific prose reminder, then fail the run — is a
workflow decision, and it lives inline in `spawnWorkerSession`'s event loop
beside stdin writes and listener dispatch (:1073-1081). Meanwhile the
compensating policy (salvage instead of accept the failure) lives in the
orchestrator, reachable only through the string-matching adapter of candidate
1. The session-lifecycle concern and the run-management concern meet at the
worst possible point: a thrown, decorated `Error`. The pure
`decideIdleAction` extraction is good (hermetically tested, cited in the
comment at :1069-1071) — the residual leak is that its output drives a hard
`failWorker(NO_YIELD_FAILURE)` instead of surfacing a structured terminal
outcome the caller could weigh.

**Solution.** Give `WorkerSession` a typed terminal outcome — a union such as
`{ kind: "yielded", payload } | { kind: "failed", code: WorkerFailureCode, diagnostics }` —
consumed by the orchestrator, with `throw` reserved for truly exceptional
transport failures. The idle-watchdog policy (nudge count, prompt text) becomes
a `WorkerOptions` knob defaulting to current behavior, so future tiers can
tighten or loosen it without touching the event loop. Note honestly: this is
candidate 1's type hierarchy carried one level up the stack; on its own it is
rearrangement, which is why it is Speculative alone and Strong as the second
half of candidate 1.

**Benefits.**
- *Locality:* retry/nudge policy edits stop requiring comprehension of the
  JSONL pump.
- *Leverage:* the same outcome union serves parallel workers
  (packages/core-v2/src/daemon/parallel.ts consumes failures today) and the
  review fork (review.ts), which currently re-derive failure meaning from
  error objects.
- *Tests:* `decideIdleAction` tests survive unchanged; outcome mapping adds
  pure cases.

## Top recommendation

**Do candidate 1 first — the typed failure-code hierarchy**, folded forward
into candidate 4's terminal-outcome union when time allows.

Why this one:

- **It is the seam that demonstrably broke.** `d5338b52` is not a hypothetical:
  the string-matched salvage net was dead in production while the hermetic
  suite stayed green, because tests built their errors from the same constant
  they asserted against (test-orchestrator.ts:391-397). Every other candidate
  improves code that already works; this one removes a proven silent-failure
  mode from the critical path between a worker's death and the run's verdict.
- **Everything else hangs off it.** The salvage gate
  (orchestrator.ts:2829-2830), the failure artifact, the caveat wording
  (:2886-2890), and any future parallel-run classification
  (`classifyWorkerFailures`, :217) all consume the failure's identity. Making
  identity a union member raises the floor for all of them at once — maximum
  leverage per localized edit.
- **It matches the project's own stated principle.** The design doc's "typed
  contracts" rule is applied rigorously everywhere else (YieldSchema,
  BatchOutputContract, RunManifest); the failure channel is the one boundary
  still negotiated in prose. Candidate 2 should follow immediately (its
  extraction is cleaner once keyed on a code, not a boolean), candidates 3 and
  4 queue behind them.
