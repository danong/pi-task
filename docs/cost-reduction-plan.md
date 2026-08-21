# Cost-Reduction Plan

How a run pays: **turns × (fixed prompt prefix + growing history + reasoning
blobs) + thinking output**. Every wave below attacks one of those terms. The
goal: small async runs from ~$0.07–0.15 down to ~$0.015–0.03 (the realistic
target for the scheduler's many-small-jobs future), and −40–60% on medium
runs.

## Wave 1 — hermetic build (no model calls, UAT by unit tests)

1. **Fix-prompt failure-output truncation.** `buildFixPrompt` embeds each
   verification failure's raw output (multi-KB for real suites) into every
   fix-worker prompt. Cap each failure's output to the first N lines + a
   pointer. Direct input-token cut on every fix iteration. Pure, tested.
2. **Conditional prewalk.** The prewalk is a strong-model planning pass; its
   gemini-flex cost (~$0.02–0.05) is not justified for 1–2-requirement
   tasks. Add `prewalk_min_requirements` (default 3) to config; when
   `spec.requirements.length` is below it, `usePrewalk` collapses and the
   run starts directly on the execute model. Cooperates with the existing
   `auto` budget heuristic and `isPrewalkActive` (model-difference) gate.
3. **Checklist-per-tier.** The checklist ritual costs ~6 turns/run (init +
   done-per-requirement) — 10–15% of a 40-turn run, each re-reading full
   context. Make checklist tier-configurable (`checklist = false` on cheap
   tiers): the engine stops loading the checklist extension and the worker
   prompt stops mandating it. The manifest already records a checklist flag.
4. **`reasoning.exclude`, not a thinking downgrade.** Keeping the worker's
   thinking budget at low preserves reasoning quality; the cost driver is
   that the accumulated encrypted `reasoning_details` blobs (1–5KB each,
   traced) are re-sent on every later turn. Set OpenRouter
   `reasoning: { exclude: true }` on worker sessions only (scoped in the
   service-tier extension), so the model still reasons but the transcript
   stays flat. **Gated by a continuation canary** (below): reasoning
   exclusion only works if the provider is on "statues" invisible mode and
   multi-turn continuation survives — the `reasoning.exclude` field that
   previously caused our corrupted-thought-signature failure.

### Wave 1 canary (folded in, the gate for item 4)

A single multi-turn run on the **free model** with a **tiny task** (the
cheapest, highest-success-probability path): worker spawns with
`reasoning.exclude` set; each turn must survive continuation (no
corrupted-signature failure). Pass → ship item 4 in the same wave. Fail →
fall back to `--thinking minimal` for workers (accepting the quality tradeoff
you called out) and item 4 becomes the documented better-but-stuck fix.

## Wave 2 — prompt pruning (investigate → build)

- Read `docs/environment-variables.md` + config docs for the override knobs
  (config dir, skills suppression, TODO-injection switch).
- One empirical spawn on the free model dumps the worker's actual system
  prompt — measure what is injected (skills list, TODO reminders, pi-docs
  block, AGENTS.md) before cutting.
- Iterate / implement cut (engine-controlled config for worker spawns, env
  override, or flag); if TODO injection is pi-core keyed on project state,
  point workers at a clean scope or file a pi feature request.
- Target: worker fixed prefix from ~6–8k → ~2k tokens. Every turn pays this,
  so it multiplies across all runs.

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