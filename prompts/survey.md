---
description: Scaffold an architecture-review dispatch from a work request
argument-hint: "<work request>"
---
Scaffold an architecture-review dispatch for this request: $@

Write the survey spec now — the deep reading happens in the worker, not
here. Use the injected codebase map and known file paths as pointers, then
keep exploration to a minimum (at most 2-3 orientation calls) before
dispatching.

## Scope

Decide the scope first — ask the user when the request is ambiguous:

- **Named area** — the request names a module, subsystem, or path; the
  survey covers exactly that area.
- **Hotspot scan** — the request is open-ended ("where is the code
  shallow, tangled, or untested?"); find hotspots by VCS churn: walk
  `jj log` (or `git log`) back over recent months, count changes per file,
  and survey the highest-churn files. State the exact log command and the
  look-back window in the spec so the worker reproduces the scan.

## Vocabulary

The survey speaks one shared vocabulary — put these definitions in the spec
so the worker and the reviewer score candidates the same way:

- **Module** — an implementation unit whose interface hides its complexity.
- **Interface** — the contract a module presents; good design pushes
  complexity behind it.
- **Depth** — a powerful implementation behind a simple interface; shallow
  modules expose nearly as much complexity as they hide.
- **Seam** — a clean line where the code can be split or restructured
  without widespread change.
- **Adapter** — a thin translation layer at a seam isolating two
  otherwise-incompatible interfaces.
- **Leverage** — how much behavior change one localized change buys.
- **Locality** — how little context a change needs; good locality means a
  change touches few nearby places.
- **The deletion test** — if this module or abstraction were deleted, how
  much value disappears with it? Little surviving value means it is shallow.

## Context

- Read `CONTEXT.md` (when present) and any ADRs FIRST — the survey uses the
  project's own domain language instead of inventing jargon.
- A conflict with an ADR is not automatically a finding: surface it only
  when the friction the recorded decision causes today warrants reopening
  it.

## Report format

The deliverable is a markdown report committed at a user-specified path
(ask the user; default `docs/architecture-review.md`), containing:

- One card per candidate: **Files** / **Problem** / **Solution** /
  **Benefits** — benefits stated in terms of locality, leverage, and tests.
- A recommendation strength on each card: **Strong** | **Worth exploring**
  | **Speculative**.
- A **Top recommendation** section: the single candidate to do first, and
  why.

## Verification

The spec's `## Verification` is plain bash, one command per line, each
exiting 0 when done — the report exists and carries the required sections,
e.g.:

    test -f docs/architecture-review.md
    grep -q '^## Candidates' docs/architecture-review.md
    grep -q '^## Top recommendation' docs/architecture-review.md

## Dispatch

Call the task tool with the survey spec and `review: "survey-reviewer"` — the
engine's adversarial review then validates the report itself (citations
traceable, candidates actionable, priorities coherent).

## No code changes

The survey changes no source code — the report file is the only file the
worker writes. Say so explicitly among the spec's requirements, and let the
verification commands (not the worker's claims) enforce it.

Then call the task tool with the spec. The run's review phase validates the
report itself (cited files exist, claims traceable, candidates prioritized).
