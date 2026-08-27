# ADR: Provider-neutral context control plane

- **Status:** Accepted for M4.1–M4.6
- **Scope:** v2 execution only; symbol-tree remains an experimental acquisition provider
- **Decision date:** 2026-08-27

## Decision

The v2 kernel owns the context lifecycle: deriving information needs from the
validated task and optional working checkpoint, planning and separately
budgeting economic/window/attention use, assembling deterministic prompt
segments, validating provenance/freshness/sensitivity, recording cache
capabilities and evidence, and persisting bounded plans, checkpoints, and
execution epochs. Providers own information acquisition: source snapshots,
indexing, retrieval/ranking, and bounded materialization. A provider returns
candidates and typed materializations; it never injects prompt text.

The raw mode is a correct empty kernel context plan. It retains ordinary
read/search/bash exploration tools and does not require an index or artifact
store. The deterministic symbol-tree scanner and lexical/structural retriever
are adapted behind explicit acquisition capabilities and can be deleted without
changing raw task semantics.

Prompt payloads are versioned, deterministic, bounded, and contain identities,
provenance, freshness, sensitivity, and references rather than unrestricted
source bodies or volatile run metadata. Large derived context, checkpoint, and
source-view data is stored in the repository-scoped local content-addressed
artifact store. Writes are atomic and immutable; corruption, absence, and
invalidation are explicit outcomes. Source references are revision-pinned and
sensitivity-scoped. The store is an optimization and durability boundary, not a
requirement for raw execution.

An execution epoch binds a model compatibility profile, context plan, cache
plan, and bounded working tail. Mechanical runtime evidence owns requirement,
file, verification, and artifact state. A model may provide only a bounded
schema-validated declarative summary of decisions, open questions, and next
actions. Retry, interruption, model change, and context pressure transition
through deterministic epoch/checkpoint decisions and resume from workspace plus
artifact references, never from an unbounded transcript.

## Explicit boundaries

- **Deletion:** removing a provider, index, retrieval implementation, or local
  store leaves raw execution valid; missing optional data yields typed omission
  or fallback rather than ambient imports or prompt injection.
- **Privacy:** source bodies, transcripts, private reasoning, secrets, and
  unrestricted tool output do not cross prompt/trace/checkpoint boundaries.
  Bounded references and hashes are preferred. Sensitivity is explicit and
  incompatible artifacts are omitted.
- **Compatibility:** cache plans describe local artifact reuse, provider prefix
  caching, and in-session reuse separately. Cache transfer across models is not
  assumed, and unavailable attribution remains unavailable. Model swapping is
  an epoch transition, not the context lifecycle abstraction.
- **Deferred capabilities:** embeddings, external vector stores, learned
  routing, remote scale, M5 children, M6 cutover, and quality/cost claims are
  outside this decision. Real-model proof remains a cheap, explicitly deferred
  evaluation gate.

## Consequences

The kernel has more small contracts, but each ownership boundary can be tested
and removed independently. Context evaluation reports raw and managed traces
using canonical fixtures and preserves neutral or negative results; it does not
claim that symbol-tree is adopted or improves quality, cost, or acceptance.

The detailed TypeScript contracts and conformance tests are the source of truth
for field caps and evolution. The active subsystem description in
`docs/pi-task-v2-subsystems.md` remains the operational companion to this ADR.
