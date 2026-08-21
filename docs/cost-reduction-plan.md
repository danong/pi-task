# Cost-Reduction Plan

How a run pays: **turns × (fixed prompt prefix + growing history + reasoning
blobs) + thinking output**. Every wave below attacks one of those terms. The
goal: small async runs from ~$0.07–0.15 down to ~$0.015–0.03 (the realistic
target for the scheduler's many-small-jobs future), and −40–60% on medium
runs.

## Wave 1 — hermetic build (landed; items 1-3 shipped, item 4 pending verification)

1. **Fix-prompt failure-output truncation.** `buildFixPrompt` embeds each
   verification failure's raw output (multi-KB for real suites) into every
   fix-worker prompt. **DONE:** `capFixOutput` caps each failure's output to
   40 lines + a pointer, used in `buildFixPrompt`. Hermetic test.
2. **Conditional prewalk.** **DONE:** `[defaults] prewalk_min_requirements`
   (default 3) — `usePrewalk` collapses when `spec.requirements.length` is
   below it, so small tasks start straight on the execute model. Cooperates
   with the `auto` budget heuristic and `isPrewalkActive` (model-difference)
   gate.
3. **Checklist-per-tier.** **DONE:** per-tier `checklist` bool
   (`[budget.*]`, default true). false → the checklist tool is not loaded
   and the worker prompt drops the mandate (fewer turns on cheap tiers); the
   manifest records `checklist: false`. The relay degrades safely when the
   tool is absent (aborts fall to the flat path).
4. **`reasoning.exclude`, not a thinking downgrade.** **MECHANISM LANDED,**
   **CONTINUATION VERIFICATION PENDING.** Worker and reviewer subprocesses
   set `PI_TASK_EXCLUDE_REASONING=1`; the always-loaded
   `tools/reasoning-exclude.ts` extension injects `reasoning.exclude: true`
   into every provider payload. The model still reasons at budget; the
   transcript stops re-sending the `reasoning_details` blobs — context stays
   flat. Continuation-safety is unconfirmed (see the dropped canary below).

### Wave 1 canary (dropped — passive verification instead)

Attempted a continuation canary on the **free model**; it was not decisive —
the free model is too weak to sustain the multi-turn, tool-using session the
canary exists to test (`worker ended without calling yield`; the probe fired
no provider calls). Proving a negative with a model that cannot exercise the
mechanism is the wrong tool. **Adopted: passive verification** — confirm
multi-turn continuation survives on the NEXT real task run (any capable
model, watching for a corrupted-signature failure). If it breaks, flip the
env var off or gate it in config. The mechanism lands now; judgment on
continuation is deferred to a real run.

## Wave 2 — prompt pruning (LANDED)

**Shipped:** worker + reviewer subprocesses now pin pi's native `--no-skills`
flag, pruning the skills-discovery list (~1.5-2k tokens per turn) pi injects
into a worker's fixed system-prompt prefix. Config: `[defaults]
slim_worker_prompt` (default true); false restores the verbose prompt.
Threaded through `extensions/task/worker.ts` (buildWorkerArgs) and
`extensions/task/review.ts` (reviewer args); the worker still loads all its
extensions exactly as before (the change is additive to the args array).

- **Per-wave decision:** the pi docs (skills.md, prompt-templates.md,
  environment-variables.md) are the source of truth for the knobs pi
  supports; no pi-core feature was added. `--no-skills` was chosen because a
  worker explores on its own and never uses skills discovery.
- **Live-by-default:** `slimWorkerPrompt` is undefined at spawn → the
  `=== false` guard leaves `--no-skills` present, so workers now start slim
  unconditionally. Wiring the config key into the orchestrator spawn calls
  (the operator-restore flip) is the deferred adapter — the orchestrator was
  out of the task's protocol scoped.

---
## Wave 3 — exploration duplication (the big structural one)

We (the conversational agent) and the workers re-explore the same codebase —
paying twice. Escalating options:

1. **Cheap now:** specs carry an *orientation section* — facts already
   established (file pointers, verified claims, dead ends), so the worker
   doesn't re-derive. Formalize in the build spec template.
2. **Medium:** repo-map quality push (annotations already free-model);
   richer slices mean less raw exploration on both sides.
3. **Architectural — context-carrying dispatch:** workers fork from the
   conversation session (`--fork`, like review forks) instead of cold-start,
   inheriting pruned exploration context for one re-encode instead of N
   turns of re-discovery. Design pass first (when to fork vs cold-start,
   context-pollution risk, cache behavior).

## Wave 4 — session_id (correlation)

Determine what OpenRouter does with a session identifier (cache routing /
attribution), then wire `run_id` into it via the existing payload-mutation
extension if useful — gives per-run correlation in OpenRouter's dashboard,
which would have cheapened today's debugging.

## Usage policy (no build)

Route-by-shape (batch for greenfield parallelizable, review-less economy for
routine, review tiers for risky) + spec-size discipline + the
deterministic-prefix cache rule (never add timestamps/ids/variable content
ahead of the conversation — the prefix must stay stable for implicit
caching). Worth a short section in the design doc's cost note so it survives.

## Shipped/taken so far

- `reasoning.exclude` is **the** wave-1 item-4 approach (approved over a
  thinking-level downgrade): quality preserved, context flattened.
- Wave-1 canary folded into wave 1 (single commit, UAT by the free-model
  tiny task).