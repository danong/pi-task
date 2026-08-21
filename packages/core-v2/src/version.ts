/**
 * pi-task-v2 core package identity.
 *
 * The daemon, ledger, and kernel drivers land in this package per
 * docs/pi-task-v2.md (§8 milestones). M0 establishes the engineering
 * bar only: this strict-typed subtree, the kernel contracts, the
 * ledger store, and the suite-03 bench harness.
 */

/** Current milestone of the pi-task-v2 build (docs/pi-task-v2.md §8). */
export const CORE_V2_MILESTONE = "M0" as const;

/** Package version — pre-release until the v2 cutover (contract §8 M5). */
export const CORE_V2_VERSION = "0.0.0-m0" as const;
