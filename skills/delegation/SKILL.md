---
name: delegation
description: >-
  Deciding how to approach coding work: dispatch to the task tool (isolated
  worker session) vs. doing it directly. Load before starting any multi-step
  coding task — it covers the dispatch threshold, planning, the goals +
  architecture check, the investigation budget, and spec discipline.
---

# Delegation

Implementation work gets dispatched; comprehension work is answered directly.

## Dispatch by default

Dispatch via the `task` tool when the work:

- spans multiple files or steps,
- needs iteration (tests, review feedback),
- is parallelizable into independent pieces, or
- touches code you have not already validated.

Do it directly only when the change is trivially small and reversible (one
line, one obvious fix).

## Planning

Multi-step work starts with a plan before any implementation:

- Decompose the work into milestones, each with its own Goal / Requirements /
  Verification — a milestone is one dispatchable unit.
- Sequence dependencies; independent milestones with disjoint file scopes can
  run as parallel sub_specs.
- Map each milestone to its dispatch: a `task` tool spec (scaffold with
  `/build`), independent ones batched into one parallel dispatch.
- Keep the plan in the conversation — the user reviews and adjusts it before
  anything is dispatched. Use `/plan` to scaffold it.
- The plan is a decision aid, not a design doc: short enough to read in a
  minute.

## Goals + architecture (before dispatch)

Two checks gate every dispatch — one against the user's intent, one against
the repo's recorded decisions:

- **Reference the current `/goals` before dispatching.** Goals are session
  entries: user-owned, set and updated via `/goals`, and they die with the
  session (no persistent store, nothing stale survives into a later
  session). A dispatch should visibly serve a stated goal.
- **A change serving no stated goal is raised with the user, not
  dispatched** — ask whether it should become a goal or be dropped; do not
  silently widen scope.
- **Architecture fidelity** — check the change against the repo's recorded
  decisions where they exist: `CONTEXT.md`, the ADRs (`docs/adr/`), and the
  latest `/survey` output. The review's architecture axis re-checks changes
  against exactly these, so a dispatch that fights a recorded decision gets
  flagged in review — catch it at spec time instead. If the change must
  override a decision, settle that with the user first and update the
  ADR / `CONTEXT.md` deliberately, never by drift.

## Investigation happens in workers

Your job before dispatching is orientation, not investigation:

- If the repo has a `CONTEXT.md` (the project's shared domain language), read it before deep work and use its vocabulary.
- Use the injected codebase map and known file paths as spec pointers — the
  worker reads the details.
- Spend at most 2-3 orientation calls (codebase_map + one targeted read)
  before writing the spec. Deep exploration belongs to the worker's prewalk.

## Spec discipline

- Write WHAT, not HOW. The worker plans the implementation.
- `## Goal`: one sentence. `## Requirements`: numbered WHATs. `## Verification`:
  plain bash commands, one per line, each exiting 0 when the work is done.
- Decompose: independent pieces → parallel sub_specs (self-contained, no
  cross-references); large tasks → smaller dispatched tasks. Sub_specs entries
  may be markdown strings or {goal, requirements, verification, context?}
  objects — the tool accepts both. When sub_specs is given, the top-level spec
  may be omitted.
- Parallel sub_specs must have DISJOINT file scopes: state which files each
  worker owns in its spec, and instruct workers not to edit files outside
  their scope (overlapping edits are the main source of merge conflicts).
  Shared files (docs, config) must be OWNED by exactly one sub-spec — declare
  it in the spec, or parallel workers will collide on them.
- Verification can assert hygiene: add a command that fails when scratch/debug
  files leaked into the repo (e.g. `! ls dbg-* 2>/dev/null | grep .`).
- Use `/build` to scaffold a spec from a work request.

## Recovering a failed parallel merge

When the engine reports a merge failure, the workers' commits usually still
live in the repo as siblings on the base:

1. `jj log -r all()` — find the worker commits (their descriptions match the
   sub-specs) and identify the base.
2. Stack them in dependency order: `jj rebase -s <child> -o <parent>` — one
   rebase per commit, re-resolving ids AFTER each command (rebase rewrites
   commit ids; a captured id goes stale).
3. Verify the chain with parents and files after every step:
   `jj log --no-graph -T 'commit_id.short() ++ " parents=[" ++ parents.map(|p| p.commit_id().short()).join(",") ++ "]"'` and check the
   materialized files exist (`ls`).
4. **BEFORE pushing, abandon the AI task base and any empty working-copy
   stubs** — jj refuses to push description-less commits (the empty AI base
   and stub working copies carry no description). `jj abandon <commit-id>`
   each one, then verify `jj log -r all()` shows no commit with an empty
   description.
5. Add-vs-delete conflicts (a file deleted on one side, kept on the other)
   resolve via `:ours`/`:theirs`, NOT by abandoning a commit mid-stack — a
   mid-stack abandon silently drops whichever side the abandoned commit
   held: `jj resolve --tool :ours -r <commit> <path>` (keep the modified
   side) / `jj resolve --tool :theirs -r <commit> <path>` (keep the
   deletion).
6. A pure-comment conflict (both workers edited a header comment) resolves by
   joining both sides — `git merge-file --union` over the three sides, or edit
   the markers by hand.
7. Run the full verification gate on the merged tree before considering the
   merge done.

Rescue commits: when a run aborted with uncommitted workspace state, the
engine rescue-commits it inside the preserved workspace (`rescue: aborted
task run (...)` — the failure artifact names the commit). Stack and squash
those with the workspace's other commits; do not abandon them.
