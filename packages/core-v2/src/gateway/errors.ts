/**
 * Typed gateway read failures — subsystems §3 / R2.
 *
 * Narrow reads surface typed errors instead of nulls so plugins can
 * distinguish "unknown id" from transport failure without string parsing.
 */

export type GatewayErrorCode = "unknown_task" | "no_ledger";

export class GatewayError extends Error {
	constructor(
		public readonly code: GatewayErrorCode,
		message: string,
		public override readonly cause?: unknown,
	) {
		super(message);
		this.name = "GatewayError";
	}
}
