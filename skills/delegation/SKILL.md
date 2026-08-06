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
  cross-references); large tasks → smaller dispatched tasks.
- Use `/build` to scaffold a spec from a work request.
