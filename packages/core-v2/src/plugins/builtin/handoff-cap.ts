/**
 * handoff-cap — transform-style extraction (R1/R5).
 *
 * MOVED FROM CORE: the 60 kB capping of verify-failure stderr tails and
 * uncommittedDiffSummary in the HandoffBundle path lived INLINED in
 * src/daemon/task-runner.ts as
 *   `(firstFailure?.stderrTail ?? "").slice(0, 60_000)` plus the per-
 *   HandoffBundleSchema max(60_000). Now the schema alone lives in core;
 *   this plugin owns the truncation. The core verifies the shape; the
 *   plugin decides the cap policy.
 *
 * Before (in task-runner.ts buildHandoffForRetry):
 *   uncommittedDiffSummary: (firstFailure?.stderrTail ?? "").slice(0,60k)
 * After:
 *   core builds uncapped → transformHandoffThrough() → here.
 *
 * Responsibility table (M1.c vs now):
 *   | Concern                 | Before (core) | After (plugin) |
 *   |-------------------------|---------------|----------------|
 *   | schema max 60k          | schema in core| unchanged      |
 *   | explicit slice(0,60k)   | inline        | plugin helper  |
 *   | cap policy choice       | hardcoded     | configurable   |
 *   | schema validity         | core          | revalidated    |
 *
 * Loaded by path from task.toml [plugins] via the M4b loader; invoked
 * through transformHandoffThrough in hooks.ts (throw-isolated, schema
 * re-validated, never crashes pipeline).
 */

import type { HandoffBundle } from "../../contracts/payloads.ts";
import type { TaskPlugin } from "../../contracts/task-plugin.ts";

export const HANDOFF_CAP_MAX = 60_000;

/** Keep the LAST cap chars (tail cap) — diagnostic tails read tail-first. */
function capTail(s: string, cap: number): string {
	return s.length <= cap ? s : s.slice(-cap);
}

function capOne(b: HandoffBundle, cap: number): HandoffBundle {
	const summary =
		b.uncommittedDiffSummary.length > cap
			? capTail(b.uncommittedDiffSummary, cap)
			: b.uncommittedDiffSummary;
	const cappedFailures = b.verificationFailures.map((f) => {
		if (f.stderrTail.length <= cap) return f;
		return { ...f, stderrTail: capTail(f.stderrTail, cap) };
	});
	if (
		summary === b.uncommittedDiffSummary &&
		cappedFailures.every((f, i) => f.stderrTail === b.verificationFailures[i]!.stderrTail)
	) {
		return b;
	}
	return { ...b, uncommittedDiffSummary: summary, verificationFailures: cappedFailures };
}

const plugin: TaskPlugin = {
	name: "handoff-cap",
	async transformHandoff(bundle: HandoffBundle): Promise<HandoffBundle> {
		return capOne(bundle, HANDOFF_CAP_MAX);
	},
};

export default plugin;
