/**
 * Tool guard — worker-side enforcement extension (Phase 2).
 *
 * Loaded into every worker/reviewer subprocess via --extension. Uses pi's
 * tool_call hook (event.input is mutable; mutations affect execution;
 * returning { block: true, reason } cancels the call and feeds the reason
 * back to the model). Enforcement, not prompt text: it applies to every
 * pi agent that runs on pi-task, whatever its system prompt says.
 *
 * Two guards on bash:
 *   1. TIMEOUT CAP — event.input.timeout is clamped to a bound (default
 *      TOOL_GUARD_BASH_TIMEOUT_CAP_MS, overridable via the env var of the
 *      same name): a hung worker-initiated command can never outlive the
 *      bound (the engine's own verification timeout is separate).
 *   2. ROOT-SCOPED SEARCH BLOCK — grep/rg/find aimed at the repo root
 *      sweeps .pi/sessions (full conversation dumps) and returns tens of
 *      KB of garbage that rides in context forever (the incident class).
 *      Blocked with an instructive reason; a scoped re-issue costs ~50
 *      tokens instead of ~12k. Commands that already carry an --exclude
 *      are the author's own scoping decision and pass.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TOOL_GUARD_BASH_TIMEOUT_CAP_ENV_VAR = "PI_TASK_BASH_TIMEOUT_CAP_MS";
export const TOOL_GUARD_BASH_TIMEOUT_CAP_MS = 300_000;

/** Pure: clamp a requested bash timeout to the cap (absent → the cap). */
export function capBashTimeout(requested: number | undefined, cap: number): number {
	if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return cap;
	return Math.min(requested, cap);
}

/** Commands the root-scope policy applies to. */
const SEARCH_TOOLS = "(?:grep|rg|fgrep|egrep|find)";

/**
 * Pure: is this bash command a root-scoped search — a grep/rg/find whose
 * path arguments include the bare repo root (`.` as a standalone path
 * token)? Tolerates leading `cd ...;` / `timeout N` wrappers. Commands
 * that already carry an --exclude flag are deliberate scoping and pass.
 * Deterministic by design: a false positive costs a blocked call + a
 * scoped retry; a false negative costs the session-dump garbage class.
 */
export function isRootScopedSearch(command: string): boolean {
	if (/--exclude/.test(command)) return false;
	// Strip leading `cd <dir> ;` segments and one optional `timeout N` prefix.
	const stripped = command
		.replace(/^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*[;&]+\s*)+/, "")
		.replace(/^\s*timeout\s+\S+\s+/, "");
	const head = new RegExp(`^${SEARCH_TOOLS}\\b`).test(stripped);
	if (!head) return false;
	// A standalone `.` path token anywhere in the arguments (before a pipe
	// or redirection boundary counts too: `grep x . | head`).
	return /(?:^|\s)\.(?:\s|$|\||;|>)/.test(stripped.replace(/^grep\b|^rg\b|^fgrep\b|^egrep\b|^find\b/, ""));
}

/** The block reason fed back to the model (teaches inside the loop). */
export function rootScopedSearchReason(command: string): string {
	const tool = command.trim().split(/\s+/)[0];
	return (
		`Blocked: ${tool} over the repo root sweeps .pi/sessions (full conversation dumps) and floods the context with garbage. ` +
		`Re-run scoped to the relevant directory (e.g. extensions/, docs/, config/), or add --exclude-dir=.pi.`
	);
}

export default function (pi: ExtensionAPI) {
	const capRaw = Number(process.env[TOOL_GUARD_BASH_TIMEOUT_CAP_ENV_VAR]);
	const cap =
		Number.isFinite(capRaw) && capRaw > 0 ? capRaw : TOOL_GUARD_BASH_TIMEOUT_CAP_MS;

	pi.on("tool_call", async (event) => {
		const ev = event as { toolName?: string; input?: { command?: string; timeout?: number } };
		if (ev.toolName !== "bash" || !ev.input) return;
		if (typeof ev.input.command === "string" && isRootScopedSearch(ev.input.command)) {
			return { block: true, reason: rootScopedSearchReason(ev.input.command) };
		}
		ev.input.timeout = capBashTimeout(ev.input.timeout, cap);
	});
}
