/**
 * TaskGateway surface — subsystems §3 / R2.
 *
 * Thin re-export: the interface itself is canonically declared beside the
 * plugin contract (contracts/task-plugin.ts) so plugin code imports the
 * whole seam from one module, while the gateway directory owns its
 * implementation (in-memory.ts) and typed errors (errors.ts).
 */

export type { TaskGateway } from "../contracts/task-plugin.ts";
