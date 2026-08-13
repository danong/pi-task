---
name: architecture-survey
description: >-
  Dispatching big-picture architecture reviews as tasks. Load when the user
  asks for a big-picture review — "is this area shallow, tangled, or
  untested?", "where should we refactor?", "survey the codebase" — it
  covers the scope decision, the survey spec, dispatch via the task tool,
  and grilling on the report's candidates before refactoring.
---

# Architecture survey

A big-picture review is a dispatched task, not a main-session scan.

## Dispatch, do not scan

When the user asks for a big-picture review, do NOT read through the
codebase in the main session. Orientation-only applies here too: the
injected codebase map plus at most 2-3 targeted reads to fix the scope, then
dispatch. The deep reading happens in the survey worker's prewalk.

## Decide the scope

Pick one — ask the user when the request is ambiguous:

- **Named area** — the request names a module, subsystem, or path; the
  survey covers exactly that area.
- **Hotspot scan** — the request is open-ended; find hotspots by VCS churn:
  walk `jj log` (or `git log`) back over recent months, count changes per
  file, and survey the highest-churn files. State the exact log command and
  the look-back window in the spec.

## Write the survey spec

Use `/survey` to scaffold it (or write it directly in the same shape), with
the usual spec discipline — Goal / Requirements / Verification, WHAT not
HOW — plus:

- The shared vocabulary (module, interface, depth, seam, adapter, leverage,
  locality, and the deletion test) so the worker and the reviewer score
  candidates the same way.
- Context first: read `CONTEXT.md` (when present) and any ADRs before the
  code; surface an ADR conflict only when the friction the recorded
  decision causes today warrants reopening it.
- Report format: a markdown report committed at a user-specified path
  (default `docs/architecture-review.md`), one card per candidate
  (files / problem / solution / benefits in terms of locality, leverage,
  and tests), each rated Strong | Worth exploring | Speculative, plus a Top
  recommendation section.
- Verification: plain bash asserting the report exists and carries the
  required sections.
- No code changes: the report file is the only file the worker writes.

Then dispatch via the `task` tool. The run's review phase validates the
report itself (cited files exist, claims traceable, candidates prioritized).

## After the survey

1. **Grill the user on the top candidates** — same grilling step `/plan`
   uses: one open question at a time, each with the answer you will assume
   if the user does not weigh in. Which candidates matter, in what order,
   what is off-limits, what the deletion test says about each. Do not
   dispatch refactors on your own reading of the report alone.
2. **Dispatch each chosen refactor as a `/build` task** — one candidate
   per spec (Goal / Requirements / Verification as usual). Independent
   candidates with disjoint file scopes may share one parallel dispatch as
   sub_specs.
