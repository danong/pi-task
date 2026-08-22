/**
 * Gateway seam (R2) — one directory, three concerns:
 *   - surface.ts: the TaskGateway interface (canonically declared beside
 *     the plugin contract, contracts/task-plugin.ts)
 *   - errors.ts: typed read failures (unknown ids, missing ledger)
 *   - in-memory.ts: the InMemoryTaskGateway used by tests and the daemon
 *
 * Reads are LEDGER-ONLY (tasks / micro_sessions / routing_feedback rows
 * via LedgerStore) — never transcripts.
 */

export type { TaskGateway } from "./surface.ts";
export type {
	EventPattern,
	RunManifest,
	TaskLedgerRow,
	TaskLifecycleEvent,
	Unsubscribe,
} from "../contracts/task-plugin.ts";
export { GatewayError } from "./errors.ts";
export type { GatewayErrorCode } from "./errors.ts";
export { InMemoryTaskGateway } from "./in-memory.ts";
export type { InMemoryTaskGatewayOptions } from "./in-memory.ts";
export {
	TASK_LIFECYCLE_EVENTS,
	eventMatchesPattern,
	eventTypeOf,
} from "../contracts/gateway-events.ts";
export type { TaskLifecycleEventType } from "../contracts/gateway-events.ts";
