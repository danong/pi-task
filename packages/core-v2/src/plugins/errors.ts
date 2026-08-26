/**
 * Typed plugin load failures — subsystems §3 / R2.
 *
 * A bad plugin path never silently skips: it fails typed with a code
 * and recoverable guidance so the operator can fix task.toml.
 */

export type PluginLoadErrorCode =
	"not_found" | "invalid_config" | "invalid_export" | "import_failed";

export class PluginLoadError extends Error {
	constructor(
		public readonly code: PluginLoadErrorCode,
		message: string,
		public readonly path: string,
		public readonly guidance: string,
		public override readonly cause?: unknown,
	) {
		super(message);
		this.name = "PluginLoadError";
	}
}
