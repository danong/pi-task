# M5 self-hosting proof

## Verdict: PASS — narrow inheritance proof

This report is authored by a real Luna continuation child. The child inherited the parent workspace's accepted M5 closure state and independently cross-checked the active documentation, the closure authority, and the implementation/test anchors below. The PASS applies to that narrow parent-to-child inheritance and verification surface. It is not a performance, cost, or model-quality claim.

## Inherited facts observed

The inherited continuation state identified the accepted parent decision and source revision, recorded that parent verification and acceptance had passed, and carried bounded requirement/next-action state. It did not provide an unbounded transcript or private reasoning. The active documentation agrees with those facts:

- `packages/core-v2/README.md` names `reports/m5-hardening-closure.md` as the current M5 closure authority, marks M5 hardening closed, and documents `--child-spec` plus edge-oriented `--resume`.
- `docs/pi-task-v2.md` describes shipped durable sequential parent-to-child continuation, bounded handoff/checkpoint state, and provider-owned workspace continuation. It separately marks M5.5 as planned.
- `docs/pi-task-v2-subsystems.md` describes the self-hosting gate as the normal v2 surface selecting an explicit continuation child whose accepted output passes repository verification and artifact policy.
- `reports/m5-hardening-closure.md` records READY and closes the C1–C4 hardening boundaries: durable parent acceptance ownership, validity-authoritative boot checks, canonical terminal evidence/outbox ordering, and delivery-pending retry truth.

## Implementation and test cross-check

The inherited facts match the current tree without an implementation change:

- `packages/core-v2/src/daemon/sequential.ts` owns preparation and resume of the daemon-owned sequential edge, bounded handoff/checkpoint use, provider continuation, child execution, evidence ordering, settlement, and delivery policy.
- `packages/core-v2/src/ledger/store.ts` owns durable preparation ownership, parent/child edge transitions, typed artifact references, terminal linkage, outbox state, and boot authority.
- `packages/core-v2/src/daemon/child-reconciliation.ts` validates immutable artifact bytes, schemas, lineage, ownership, identities, and the provider continuation target before a claimed edge is resumable.
- `packages/core-v2/src/daemon/start.ts` performs child-edge validation/reconciliation before generic task retry.
- `packages/core-v2/src/cli.ts` keeps `--child-spec` and `--resume <edge-id>` as thin adapters to the sequential path.
- `packages/core-v2/test/test-sequential.ts` exercises parent acceptance, bounded handoff/checkpoint validation, provider continuation, close/reopen resume, persisted plan/checkpoint lineage, terminal evidence ordering, and no parent replay.
- `packages/core-v2/test/test-cli.ts` exercises the normal CLI parent-to-child path, edge selection after close/reopen, provider reconciliation, and delivery-only retry behavior.

## Parent-to-child mechanism exercised

The Luna continuation boundary itself was exercised: the parent accepted the closure state, and this child resumed from the inherited bounded declarative checkpoint to inspect the authoritative report and the current source/test anchors. This is the same shape required by M5: durable parent/child identity and edge state, validated structured handoff/checkpoint facts, and provider-owned continuation state rather than transcript replay. The child performed no implementation or test-file alteration; the only artifact change is this proof report.

## Scope boundary

This proves only the narrow M5 explicit parent-to-child surface. It does **not** prove M5.5 run-ID recovery, M5.5 passive failed-state continuation records, or generalized continuation/recovery. In particular, the existing M5 edge selector is not M5.5's planned public run-ID contract.

## Verification commands

The repository gate for the inherited closure and this proof is:

```sh
test -s reports/m5-self-hosting-proof.md
grep -q 'PASS' reports/m5-self-hosting-proof.md
grep -q 'M5.5' reports/m5-self-hosting-proof.md
npx tsx packages/core-v2/test/test-sequential.ts
npx tsx packages/core-v2/test/test-cli.ts
npx tsc --noEmit -p packages/core-v2/tsconfig.json
```

The isolated child workspace could not start these commands because ignored local dependencies are not materialized there. The v2 engine subsequently ran the declared post-integration verification commands in the project environment and they passed before accepting the child result. The source and regression anchors above are the child's independent cross-check; no performance or model-quality conclusion is intended.
