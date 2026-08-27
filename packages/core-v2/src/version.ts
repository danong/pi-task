/**
 * pi-task-v2 core package identity.
 *
 * The daemon, ledger, and kernel drivers land in this package per
 * docs/pi-task-v2.md. M4 establishes the hermetically conforming context
 * control plane on top of the runnable M1–M3 foundation.
 */

/** Current implemented milestone; product validation remains separately evidenced. */
export const CORE_V2_MILESTONE = "M4" as const;

/** Package version — pre-release until the v2 cutover decision. */
export const CORE_V2_VERSION = "0.0.0-m4" as const;
