---
description: Scaffold a multi-day work plan from a work request before dispatching
argument-hint: "<work request>"
---
Plan this work request before dispatching anything: $@

Produce a work plan for a multi-day or week-long effort. It is a decision aid
for dispatching, not a design doc — short enough to read in a minute. Write
the plan in the conversation so the user can review and adjust it before any
implementation starts.

## Goal

One sentence describing the end state.

## Constraints

Budget, deadlines, compatibility, and anything off-limits. One line each.

## Milestones

Decompose the goal into milestones — each one independently dispatchable and
verifiable. For each milestone:

- **Goal** — one sentence.
- **Requirements** — numbered WHATs that must be true when it is done.
- **Verification** — plain bash commands, one per line, each exiting 0 when
  the milestone is done.
- **File scope** — the files the milestone owns; scopes must be disjoint
  across milestones intended to run in parallel.

## Sequencing

Order the milestones by dependency — which milestones block which. Mark
which are independent and can run concurrently.

## Dispatch sequence

An ordered list of dispatches: day-by-day for calendar-bound work, otherwise
by dependency. Note which entries can be dispatched simultaneously.

## Delegation mapping

Map each milestone to its dispatch:

- Milestone → `task` tool dispatch; scaffold its spec with `/build`.
- Independent milestones with disjoint file scopes → parallel `sub_specs` in
  a single dispatch.

## Rabbit-hole guards

Investigation while planning is orientation only: the injected codebase map
plus at most 2-3 targeted reads. When understanding a milestone would need
deeper exploration, do not dig here — put the exploration in that milestone's
spec and let the worker's prewalk cover it. If a milestone is too uncertain
to write requirements for, split or defer it and say so in the plan.
