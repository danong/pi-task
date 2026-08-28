/**
 * pi-task-v2 core package identity.
 *
 * The daemon, ledger, and kernel drivers land in this package per
 * docs/pi-task-v2.md. M5 adds durable sequential continuation and the
 * self-hosting normal surface on top of the M4 control plane.
 */

/** Current implemented milestone; product validation remains separately evidenced. */
export const CORE_V2_MILESTONE = "M5" as const;

/** Package version — pre-release until the v2 cutover decision. */
export const CORE_V2_VERSION = "0.0.0-m5" as const;
