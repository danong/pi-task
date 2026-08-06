---
description: Build a task spec from a work request and dispatch it via the task tool
argument-hint: "<work request>"
---
Dispatch a worker for this work request: $@

Write the spec now — investigation happens in the worker, not here. Use the
injected codebase map and known file paths as pointers, then keep exploration
to a minimum (at most 2-3 orientation calls) before dispatching.

The spec:

- `## Goal` — one sentence describing the outcome.
- `## Requirements` — numbered list of WHAT must be true when done (not HOW).
  If the work decomposes into independent pieces, dispatch them in parallel as
  separate self-contained sub_specs (each with its own Goal / Requirements /
  Verification, no cross-references); otherwise keep a single spec.
- `## Verification` — PLAIN bash commands, one per line (no backticks, no
  quotes, no prose). Each line must exit 0 when the work is done.

Then call the task tool with the spec (and sub_specs when parallelizing).
