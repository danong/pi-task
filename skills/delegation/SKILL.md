---
name: delegation
description: >-
  Deciding how to approach coding work: dispatch to the task tool (isolated
  worker session) vs. doing it directly. Load before starting any multi-step
  coding task — it covers the dispatch threshold, the investigation budget,
  and spec discipline.
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

## Investigation happens in workers

Your job before dispatching is orientation, not investigation:

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
