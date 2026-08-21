# pi-task-v2 — Future Work & Scale-Readiness

Companion to the [contract](pi-task-v2.md). Everything deliberately NOT
needed to build v1's successor, kept so that future scale never requires a
core rewrite. Nothing in this document blocks or shapes the M0–M5 milestones.

## Scale-readiness constraints (zero-cost now)

1. **Portable SQL.** Ledger DDL avoids SQLite-only features; Postgres
   migration needs no rewrites.
2. **Transport behind an interface.** Local sockets now; an authenticated
   remote transport attaches as a plugin later.
3. **Meter everything.** Tokens and cost per task/session in the ledger —
   the future source of truth for billing/analytics.
4. **Models are endpoints.** Provider changes are config; self-hosted
   open-weight providers attach without core changes.

## Client integration modes (after M4)

All subscribe via TaskGateway — no core changes:

- **Discord bridge** (threads/embeds) — port of v1's bridge.
- **CLI/TUI client** (Unix socket / localhost ws).
- **CI/CD runner** (PR webhooks, inline annotations).
- **Scheduled cron** (recurring audits) — v1's scheduler ports here.

## Deferred mechanisms

> **E.1 On-demand adversarial review.** Always-on review stays OFF (v2 keeps
> v1's budget-gated default); per-task opt-in for high-risk changes via
> `/v2 review`. Uses the reviewer role + prune profiles.

> **E.2 Hash-keyed context injection cache.** Successor to v1's annotated
> code map: persistent per-file AST annotations keyed by content hash.
> v1's version underperformed; retry only if suite 03 shows compressor
> latency (not token cost) dominating.

> **E.3 Cross-task episodic memory.** Verified insights per repo (build
> quirks, test layouts, gotchas), content-hash invalidated,
> circuit-breaker re-tested. Stored in the ledger; injected ONLY through a
> prune profile — it is state, never ambient prompt.

> **E.4 Multi-tenant isolation.** microVM sandboxes (Firecracker/bwrap) for
> untrusted workloads. Blocked only by the constraints above, not core design.

> **E.5 Automated cost-aware model selection.** Dynamic routing on live
> latency/pricing/difficulty scoring. Builds on contract FR-10 lanes + the
> routing_feedback table; supersedes manual per-role upgrades once measured.

> **E.6 Program layer & level-2 autonomy.** The layer above tasks that turns
> a scope like *"build and train a deep-Q-learning bot until it reaches ELO
> 2000"* into hundreds of dependent, multi-day dispatches under human wave
> boundaries. Pieces, in dependency order:
>
> 1. **Recursive decomposition** — goal → architecture artifacts → work
>    graph → waves of specs; each level is itself a verified planning task,
>    with replanning when a wave contradicts the plan.
> 2. **Architecture-as-artifact** — interfaces and conventions committed
>    FIRST and referenced by every spec; the repo is the shared memory, not
>    anyone's context.
> 3. **Wave executor** — plan wave → dispatch bounded-parallel workers →
>    merge → global verify → re-baseline → replan (the v2 merge ladder per
>    wave).
> 4. **Gate hierarchy** — per-task gates plus system-level ones: full build
>    + integration suite each wave, deterministic conformance checks,
>    sampled LLM conformance review, regression detection across waves.
> 5. **Program telemetry** — stall detection, completion criteria at the
>    goal level (system verification passes, not "all tasks shipped"),
>    escalation policy, async progress reporting (Discord bridge becomes
>    load-bearing here).
>
> Spend posture stays quota-blind (contract §6): tier/lane configuration is
> the only lever, including mid-run degradation to cheaper tiers when the
> operator tightens them. Entry requirement: level-1 autonomy running
> reliably (multi-hour, zero-touch scopes).

## Explicit non-goals

- Monetization/billing (metering only, constraint 3).
- Remote multi-user transports before M5 cutover.
- Any optimization without an off-switch (contract NFR-2 governs everything
  proposed here too).
