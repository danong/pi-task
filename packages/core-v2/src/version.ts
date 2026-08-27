/**
 * pi-task-v2 core package identity.
 *
 * The daemon, ledger, and kernel drivers land in this package per
 * docs/pi-task-v2.md. M4 established the hermetically conforming context
 * control plane; M4.1 hardens verification and trace observability on that line.
 */

/** Current implemented milestone; product validation remains separately evidenced. */
export const CORE_V2_MILESTONE = "M4.1" as const;

/** Package version — pre-release until the v2 cutover decision. */
export const CORE_V2_VERSION = "0.0.0-m4.1" as const;
