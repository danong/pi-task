/**
 * Workflow survey — read-only repository reconnaissance (R1–R3).
 *
 * A survey answers "what does this tree look like right now?" WITHOUT
 * mutating anything: no worker sessions, no ledger task-graph rows, no
 * file writes. It walks three read-only input sources and folds them into
 * one typed, bounded, deterministically ordered Report:
 *
 *   1. bundle inputs    — an ExecutionBundle built by the EXISTING builder
 *                         (grounding/bundle.ts buildExecutionBundle) plus
 *                         the raw candidate paths it was built from, so
 *                         dropped/unusable/truncated targets are visible;
 *   2. continuation     — the ContinuationEntry[] / budgetTokens shapes
 *                         from continuation/pruner.ts, re-using its
 *                         exported token estimator so budgets stay
 *                         comparable across the pipeline;
 *   3. a bounded fs scan— a capped walk of a root directory (file count,
 *                         depth, and per-file byte caps; skip-listed
 *                         directories such as node_modules/.git/.jj are
 *                         never entered).
 *
 * DETERMINISM (R3): every loop runs over finite input in sorted order,
 * findings dedupe and sort under a total order (severity rank → location
 * → message), and output is capped at budget.maxFindings with an honest
 * truncated flag in the summary. Same inputs → byte-identical rendered
 * report; the report deliberately carries NO timestamp/id fields at all,
 * so re-runs on an unchanged tree are byte-stable outright (R2's
 * "modulo timestamps" clause is satisfied vacuously by construction —
 * the deterministic-prefix rule applied to reports).
 *
 * HUMAN GATE (R3): when invoked from a planned context the survey is
 * gated through the same permission surface as everything else — a
 * SurveyGate seam whose gateway adapter emits the additive
 * `permission.requested` lifecycle event (contracts/gateway-events.ts),
 * so ControlSurfaces witness the request exactly as they witness any
 * other permission request. A denied gate yields a typed denial result
 * instead of a scan; the survey never bypasses a refused gate.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import type { ExecutionBundle } from "../contracts/index.ts";
import { isBundleUsable } from "../grounding/bundle.ts";
import { estimateEntryTokens, type ContinuationEntry } from "../continuation/pruner.ts";

// ─── Report shape ─────────────────────────────────────────────────────

/** Finding severities, most urgent first. */
export const SURVEY_SEVERITIES = ["critical", "warn", "info"] as const;
export type SurveySeverity = (typeof SURVEY_SEVERITIES)[number];

/** One located observation. `category` is optional free-form tagging. */
export interface SurveyFinding {
	/** Where the observation lives — a repo-relative path (fs scan), a
	 *  bundle hostPath, or a logical locator like "continuation". */
	location: string;
	severity: SurveySeverity;
	message: string;
	category?: string;
}

/** How the permission gate resolved for this run. */
export type SurveyGateDecision = "ungated" | "granted" | "denied";

export interface SurveySummary {
	filesScanned: number;
	dirsScanned: number;
	/** Total bytes of regular files SEEN during the scan (stat only). */
	bytesSeen: number;
	findingsReported: number;
	/** Findings produced BEFORE the maxFindings cap was applied. */
	findingsProduced: number;
	truncated: boolean;
	gateDecision: SurveyGateDecision;
}

export interface SurveyReport {
	root: string;
	findings: SurveyFinding[];
	summary: SurveySummary;
}

// ─── Budgets ──────────────────────────────────────────────────────────

/** Scan/output caps. Every field bounds one dimension of the work; all
 *  defaults are finite so an unconfigured survey cannot blow up. */
export interface SurveyBudget {
	/** Regular files visited by the fs walk (default 2000). */
	maxFiles?: number;
	/** Directory depth below root (default 12). */
	maxDepth?: number;
	/** Per-file byte ceiling that raises a "size" finding (default 1 MiB). */
	maxFileBytes?: number;
	/** Cap on reported findings AFTER sorting (default 200). */
	maxFindings?: number;
}

const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_FINDINGS = 200;

/** Directories never entered by the scan. Includes but not limited to
 *  dependency/vcs/build noise — extend here, not at call sites. */
const SKIP_DIR_NAMES = new Set([
	"node_modules",
	".git",
	".jj",
	".cache",
	"dist",
	"build",
	"coverage",
	"target",
]);

// ─── Input ────────────────────────────────────────────────────────────

export interface SurveyInput {
	/** Root of the bounded fs scan. Never written to. */
	root: string;
	/** An ExecutionBundle from the existing builder (optional). */
	bundle?: ExecutionBundle | undefined;
	/** The raw candidate paths the bundle was built from (optional);
	 *  candidates absent from bundle.targetFiles become findings. */
	bundleCandidates?: readonly string[] | undefined;
	/** Continuation transcript shape + its token budget (optional). */
	continuation?: { entries: readonly ContinuationEntry[]; budgetTokens: number } | undefined;
	budget?: SurveyBudget | undefined;
}

// ─── Severity ordering ────────────────────────────────────────────────

function severityRank(severity: SurveySeverity): number {
	return SURVEY_SEVERITIES.indexOf(severity);
}

/** Total order over findings: severity (critical first), then location,
 *  then message. Two distinct findings never compare equal, so Array
 *  sort stability is irrelevant — the order is a pure function of the
 *  finding content alone. */
function compareFindings(a: SurveyFinding, b: SurveyFinding): number {
	const sev = severityRank(a.severity) - severityRank(b.severity);
	if (sev !== 0) return sev;
	const loc = a.location.localeCompare(b.location);
	if (loc !== 0) return loc;
	return a.message.localeCompare(b.message);
}

function dedupeFindings(findings: SurveyFinding[]): SurveyFinding[] {
	const seen = new Set<string>();
	const out: SurveyFinding[] = [];
	for (const f of [...findings].sort(compareFindings)) {
		const key = `${f.severity}\u0000${f.category ?? ""}\u0000${f.location}\u0000${f.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(f);
	}
	return out;
}

// ─── Bounded read-only fs walk ────────────────────────────────────────

interface WalkResult {
	findings: SurveyFinding[];
	filesScanned: number;
	dirsScanned: number;
	bytesSeen: number;
}

/** Iterative bounded walk. Sorted directory entries at every level keep
 *  visit order — and therefore any limit-truncation point — stable. */
function walkTree(root: string, budget: Required<SurveyBudget>): WalkResult {
	const findings: SurveyFinding[] = [];
	let filesScanned = 0;
	let dirsScanned = 0;
	let bytesSeen = 0;
	let fileLimitHit = false;

	type Dir = { path: string; depth: number };
	const queue: Dir[] = [{ path: root, depth: 0 }];
	while (queue.length > 0 && !fileLimitHit) {
		const dir = queue.shift()!;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir.path, { withFileTypes: true });
		} catch {
			findings.push({
				location: relative(root, dir.path) || ".",
				severity: "warn",
				category: "scan",
				message: "directory unreadable",
			});
			continue;
		}
		dirsScanned += 1;
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const full = join(dir.path, entry.name);
			if (entry.isDirectory()) {
				if (dir.depth >= budget.maxDepth || SKIP_DIR_NAMES.has(entry.name)) continue;
				queue.push({ path: full, depth: dir.depth + 1 });
				continue;
			}
			if (!entry.isFile()) continue;
			if (filesScanned >= budget.maxFiles) {
				fileLimitHit = true;
				break;
			}
			filesScanned += 1;
			let size = 0;
			try {
				size = statSync(full).size;
			} catch {
				findings.push({
					location: relative(root, full),
					severity: "info",
					category: "scan",
					message: "file stat failed",
				});
				continue;
			}
			bytesSeen += size;
			if (size > budget.maxFileBytes) {
				findings.push({
					location: relative(root, full),
					severity: "warn",
					category: "size",
					message: `file exceeds ${budget.maxFileBytes} bytes (${size} bytes)`,
				});
			}
		}
	}
	if (fileLimitHit) {
		findings.push({
			location: ".",
			severity: "info",
			category: "scan",
			message: `file scan stopped at maxFiles=${budget.maxFiles}`,
		});
	}
	return { findings, filesScanned, dirsScanned, bytesSeen };
}

// ─── Bundle-derived findings ──────────────────────────────────────────

function findingsFromBundle(
	bundle: ExecutionBundle,
	candidates: readonly string[] | undefined,
	root: string,
): SurveyFinding[] {
	const out: SurveyFinding[] = [];
	if (!isBundleUsable(bundle)) {
		out.push({
			location: bundle.taskId,
			severity: "warn",
			category: "bundle",
			message: "execution bundle is unusable (no usable target files)",
		});
	}
	for (const t of bundle.targetFiles) {
		if (!t.outlineTruncated) continue;
		out.push({
			location: t.hostPath,
			severity: "info",
			category: "bundle-outline",
			message: "target file outline truncated",
		});
	}
	if (candidates !== undefined) {
		const bundled = new Set(bundle.targetFiles.map((t) => resolve(root, t.hostPath)));
		for (const c of candidates) {
			if (!bundled.has(resolve(root, c))) {
				out.push({
					location: c,
					severity: "warn",
					category: "bundle-candidate",
					message: "candidate path missing from bundle targets",
				});
			}
		}
	}
	return out;
}

// ─── Continuation-derived findings ────────────────────────────────────

function findingsFromContinuation(entries: readonly ContinuationEntry[], budgetTokens: number): SurveyFinding[] {
	let total = 0;
	for (const e of entries) total += estimateEntryTokens(e);
	if (total <= budgetTokens) return [];
	return [
		{
			location: "continuation",
			severity: "warn",
			category: "continuation-budget",
			message: `estimated ${total} tokens exceed budget ${budgetTokens}`,
		},
	];
}

// ─── Gate seam ────────────────────────────────────────────────────────

/** A permission request surfaced for human/machine approval. */
export interface SurveyPermissionRequest {
	action: string;
	detail: string;
}

/** The same human-gate/permissions surface every other pipeline mode
 *  goes through. Returns true when the survey may proceed. */
export interface SurveyGate {
	request(permission: SurveyPermissionRequest): boolean;
}

export const SURVEY_PERMISSION_ACTION = "workflow.survey";

/**
 * Gateway-backed gate for planned contexts: emits the additive
 * `permission.requested` lifecycle event through the TaskGateway so
 * ControlSurfaces witness the request through their normal stream, then
 * defers the decision to the supplied decider (a headless observer
 * grants; an interactive surface routes the decision to the operator).
 */
export function gatewaySurveyGate(
	gateway: { emit(event: unknown): void },
	taskId: string,
	sessionId: string,
	decide: (permission: SurveyPermissionRequest) => boolean = () => true,
): SurveyGate {
	return {
		request(permission) {
			const requestId = `${SURVEY_PERMISSION_ACTION}:${taskId}`;
			gateway.emit({
				type: "permission.requested",
				taskId,
				sessionId,
				requestId,
				action: permission.action,
				detail: permission.detail,
			});
			return decide(permission);
		},
	};
}

// ─── Entry point ──────────────────────────────────────────────────────

/** Denial outcome: typed, inspectable, and still side-effect-free. */
export type SurveyOutcome =
	| { kind: "report"; report: SurveyReport }
	| { kind: "denied"; reason: string };

/**
 * Run a read-only survey. Pure with respect to the tree: reads only,
 * writes nothing, spawns nothing, touches no ledger. Sync by design —
 * there is no session, retry, or clock anywhere under this call.
 */
export function runWorkflowSurvey(input: SurveyInput, gate?: SurveyGate | undefined): SurveyOutcome {
	const permission: SurveyPermissionRequest = {
		action: SURVEY_PERMISSION_ACTION,
		detail: `read-only survey of ${input.root}`,
	};
	if (gate !== undefined && !gate.request(permission)) {
		return { kind: "denied", reason: `survey gate denied ${permission.action} on ${input.root}` };
	}
	const gateDecision: SurveyGateDecision = gate === undefined ? "ungated" : "granted";

	const budget: Required<SurveyBudget> = {
		maxFiles: input.budget?.maxFiles ?? DEFAULT_MAX_FILES,
		maxDepth: input.budget?.maxDepth ?? DEFAULT_MAX_DEPTH,
		maxFileBytes: input.budget?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
		maxFindings: input.budget?.maxFindings ?? DEFAULT_MAX_FINDINGS,
	};

	const findings: SurveyFinding[] = [];
	const walk = walkTree(input.root, budget);
	findings.push(...walk.findings);
	if (input.bundle !== undefined) {
		findings.push(...findingsFromBundle(input.bundle, input.bundleCandidates, input.root));
	}
	if (input.continuation !== undefined) {
		findings.push(...findingsFromContinuation(input.continuation.entries, input.continuation.budgetTokens));
	}

	const deduped = dedupeFindings(findings);
	const reported = deduped.slice(0, budget.maxFindings);

	return {
		kind: "report",
		report: {
			root: resolve(input.root),
			findings: reported,
			summary: {
				filesScanned: walk.filesScanned,
				dirsScanned: walk.dirsScanned,
				bytesSeen: walk.bytesSeen,
				findingsReported: reported.length,
				findingsProduced: deduped.length,
				truncated: deduped.length > reported.length,
				gateDecision,
			},
		},
	};
}

// ─── Deterministic render ─────────────────────────────────────────────

/**
 * Render a report to stable text. A pure function of the report: no
 * clocks, no ids, no locale-dependent formatting beyond the explicit
 * sort already applied to findings — so repeated runs on an unchanged
 * tree produce byte-identical output (R2).
 */
export function renderSurveyReport(report: SurveyReport): string {
	const s = report.summary;
	const lines: string[] = [
		"workflow-survey report",
		`root: ${report.root}`,
		`gate: ${s.gateDecision}`,
		`scanned: ${s.filesScanned} files / ${s.dirsScanned} dirs / ${s.bytesSeen} bytes`,
		`findings: ${s.findingsReported} reported of ${s.findingsProduced}${s.truncated ? " (truncated)" : ""}`,
	];
	for (const f of report.findings) {
		const cat = f.category === undefined ? "" : ` [${f.category}]`;
		lines.push(`  ${f.severity}${cat} ${f.location}: ${f.message}`);
	}
	lines.push(`verdict: ${s.findingsProduced === 0 ? "clean" : s.truncated ? "bounded-findings" : "complete"}`);
	return lines.join("\n");
}
