/**
 * Failure artifacts (M1.3 R4 — docs/pi-task-v2.md FR-8).
 *
 * On an abort or irrecoverable failure the engine writes one bounded
 * diagnostic artifact per run: `<artifactsDir>/<runId>.failure.json`
 * carrying `{ cause, lastEvent?, lastTool?, stderrTail? }`.
 *
 * Invariants:
 *   - Every field is capped by a named constant (giant tails cannot bloat
 *     the store); caps keep the LAST characters (the interesting end).
 *   - Writes are ATOMIC (temp sibling + rename) so readers never see a
 *     half-written artifact.
 *   - Writing NEVER throws: artifact I/O must not mask the original
 *     failure — a write error reports to stderr and returns undefined.
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionHostEvent } from "../sessions/host.ts";

// ─── Named caps ──────────────────────────────────────────────────────

/** Max chars for the `cause` field (abort reason / failure summary). */
export const FAILURE_CAUSE_MAX_CHARS = 500;
/** Max chars for the serialized `lastEvent` field. */
export const FAILURE_LAST_EVENT_MAX_CHARS = 2000;
/** Max chars for the `lastTool` field (tool name + args preview). */
export const FAILURE_LAST_TOOL_MAX_CHARS = 500;
/** Max chars for the `stderrTail` field. */
export const FAILURE_STDERR_TAIL_CHARS = 2048;
/** Max chars of `runId` used in the artifact filename. */
export const FAILURE_RUN_ID_MAX_CHARS = 128;

/** The diagnostic payload written to `<runId>.failure.json`. */
/** One preserved workspace in a recovery block (v1 ladder FR-4/FR-8). */
export interface FailureArtifactWorkspace {
	name: string;
	path: string;
	/** Best-effort working-copy commit id at failure time. */
	commitId?: string | undefined;
}

/** Scripted recovery payload (FR-8): what survived and how to stack it. */
export interface FailureArtifactRecovery {
	baseChangeId?: string | undefined;
	workspaces: FailureArtifactWorkspace[];
	steps?: string[];
}

export interface FailureArtifact {
	cause: string;
	lastEvent?: string;
	lastTool?: string;
	stderrTail?: string;
	recovery?: FailureArtifactRecovery;
}

export interface WriteFailureArtifactOptions {
	artifactsDir: string;
	runId: string;
	/** Why the run failed (capped to {@link FAILURE_CAUSE_MAX_CHARS}). */
	cause: string;
	/** Last session-host event observed (serialized, capped). */
	lastEvent?: SessionHostEvent | string | undefined;
	/** Human-readable descriptor of the last tool activity (capped). */
	lastTool?: string | undefined;
	/** Stderr tail captured around the failure (capped). */
	stderrTail?: string | undefined;
	/** Scripted recovery block (FR-8): preserved workspaces + base id. */
	recovery?: FailureArtifactRecovery;
}

/**
 * Keep the LAST `maxChars` characters (tails matter more than heads for
 * diagnostics). Pure — shared by the verification runner's stderr tails.
 */
export function capTail(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : value.slice(-maxChars);
}

function serializeLastEvent(event: SessionHostEvent | string): string {
	if (typeof event === "string") return event;
	try {
		return JSON.stringify(event);
	} catch {
		// A cyclic/unserializable event degrades to its string form.
		return String(event);
	}
}

/**
 * Write `<artifactsDir>/<runId>.failure.json` atomically.
 *
 * Never throws: on write failure it reports to stderr and returns
 * `undefined`; on success returns the artifact path.
 */
export function writeFailureArtifact(options: WriteFailureArtifactOptions): string | undefined {
	const payload: FailureArtifact = {
		cause: capTail(options.cause ?? "", FAILURE_CAUSE_MAX_CHARS),
	};
	if (options.lastEvent !== undefined) {
		payload.lastEvent = capTail(serializeLastEvent(options.lastEvent), FAILURE_LAST_EVENT_MAX_CHARS);
	}
	if (options.lastTool !== undefined) {
		payload.lastTool = capTail(options.lastTool, FAILURE_LAST_TOOL_MAX_CHARS);
	}
	if (options.stderrTail !== undefined) {
		payload.stderrTail = capTail(options.stderrTail, FAILURE_STDERR_TAIL_CHARS);
	}
	if (options.recovery !== undefined) {
		payload.recovery = options.recovery;
	}

	const fileName = `${capTail(options.runId, FAILURE_RUN_ID_MAX_CHARS)}.failure.json`;
	const target = join(options.artifactsDir, fileName);
	const tmp = `${target}.tmp`;
	try {
		mkdirSync(options.artifactsDir, { recursive: true });
		writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf-8");
		renameSync(tmp, target);
		return target;
	} catch (err) {
		console.error(
			`[pi-task-v2] failed to write failure artifact ${target}: ${err instanceof Error ? err.message : String(err)}`,
		);
		try {
			unlinkSync(tmp);
		} catch {
			// Temp cleanup is best-effort; nothing else to do.
		}
		return undefined;
	}
}
