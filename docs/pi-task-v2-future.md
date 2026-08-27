# pi-task-v2 — Deferred Future Work

**Status: Active, non-MVP companion.** This document records capabilities that
are intentionally deferred. It must not shape the MVP before demand and
benchmark evidence justify them. The current v2 source of truth is the
[product contract](pi-task-v2.md) and its [subsystems](pi-task-v2-subsystems.md);
historical documents under [`old/`](old/README.md) are non-normative.

## Deferral rule

A future capability enters planning only after the MVP proof gate has measured
accepted-result quality, cost, time, and intervention. It needs a demand signal,
a bounded experiment, an off-switch, and a conformance/recovery story. Scale
readiness is useful only when it is cheap and does not add invisible control
flow to the microkernel.

## Deferred capabilities

### Remote and multi-surface scale

Authenticated remote transports, richer TUI/CLI clients, Discord, CI
annotations, and scheduled dispatch can consume the same interface and
canonical trace contract. They remain adapters over durable sessions rather
than new session owners. Start with the smallest usable shell or bridge
interface and add surfaces only when observed workflows require them.

### Larger execution programs

Multi-day graphs, recursive decomposition, wave scheduling, architecture
artifacts, and level-two autonomy are deferred. Parallel execution is already
an available foundation capability, but wider parallel waves should follow
measured task demand and merge/intervention data. Sequential typed children are
the MVP path and must not be bypassed by a program layer that passes
transcripts.

### Context memory and richer indexing

The MVP context control plane includes local content-addressed storage for its
own immutable context artifacts, plans, and checkpoints; that is durability and
cache correctness, not a semantic-memory product. Cross-task episodic memory,
richer persistent indexes, semantic retrieval, and learned ranking remain
deferred. They must be provenance-bearing, freshness-checked, sensitivity-
scoped, budgeted, and removable. A memory entry is delivered through an
explicit acquisition capability and selected by the kernel context plan, never
ambient prompt text. Do not select an embedding or external index technology
until benchmark evidence explains its benefit.

### Quality and review expansion

On-demand adversarial review, specialized reviewers, and broader fix loops may
be useful for high-risk tasks. They are optional quality providers, not proof
of MVP success. Their cost, context volume, intervention rate, and accepted
artifact quality must be measured separately from ordinary execution.

### Environment and isolation scale

Container or microVM isolation, multi-tenant policy, remote workspaces, and
richer runtime capability detection are deferred until environment failures,
trust boundaries, or concurrency make them necessary. The provider contract
must remain VCS/environment neutral; adding one must not change kernel task
semantics.

### Economic automation

Dynamic model routing, live latency/pricing optimization, and batch generation
are deferred until durable usage traces and baselines exist. The MVP may model
provider cache capabilities and emit provider-neutral cache plans because
correct context assembly depends on truthful costs and stable prefixes; learned
routing and provider-specific optimization policy remain deferred.
Configuration can select a model or lane today. Automatic selection must earn
its complexity against cost per accepted result, not token cost or cache-hit
rate alone.

## Guardrails for future work

- preserve **baseline → experiment → measure → retain or delete**;
- preserve **inventory → shadow → flip → delete** for migrations;
- require provider locality, version/config recording, deletion tests, and
  conformance coverage;
- keep observers non-authoritative and ordered transforms explicit;
- never require private chain-of-thought storage;
- never make shell status or schema validity stand in for artifact acceptance;
- keep v1 parity as a safety gate, not as the definition of product success.
