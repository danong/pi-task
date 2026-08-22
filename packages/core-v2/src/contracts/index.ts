/**
 * Kernel contracts barrel (R2 / FR-2).
 *
 * Six seams, one file each, no shared mutable state. Faithful ports of
 * docs/pi-task-v2-subsystems.md §1 (interfaces), §2 (payload schemas),
 * §3 (plugin contract), §3b (ControlSurface).
 */

export * from "./gateway-events.ts";
export * from "./payloads.ts";
export * from "./serialize.ts";
export * from "./workspace-driver.ts";
export * from "./environment-driver.ts";
export * from "./context-compressor.ts";
export * from "./verification-driver.ts";
export * from "./task-plugin.ts";
export * from "./control-surface.ts";