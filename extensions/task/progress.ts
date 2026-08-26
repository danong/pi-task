/**
 * Task-tool progress view — pure functions, no LLM, no subprocess (R5).
 *
 * Two parts:
 *
 * 1. Dispatch plan (R1). buildRunPlan() mirrors the orchestrator's own
 *    resolution and derives the phase sequence that will run — prewalk →
 *    work → review — plus the fully configured model identifier for each
 *    active phase. Phases that will not run are omitted: no prewalk when
 *    there is no distinct prewalk model (the orchestrator's auto-skip
 *    rule), no review when the tier disables it or the dispatch is
 *    parallel (review is single-worker only). The task tool emits the
 *    plan as its FIRST progress update, synchronously at dispatch time,
 *    before any worker event or turn.
 *
 * 2. Live worker view (R2/R3). Each worker line shows the current phase,
 *    checklist progress relayed from the worker's real checklist state
 *    (checklist-relay.ts), and liveness: turn count plus time since the
 *    worker's last event. applyProgressEvent() folds each streamed event
 *    into ProgressState; buildProgressText() renders it deterministically
 *    given an explicit `now` — both are hermetically tested in
 *    test-index.ts.
 */

import type { ChecklistProgress } from "./checklist-relay.ts";

export type WorkerPhase = "prewalk" | "work" | "review";

// ─── Dispatch plan (R1) ──────────────────────────────────────────────

export interface PlanPhase {
	name: WorkerPhase;
	/** Full configured model identifier (e.g. "provider/model-id"). */
	model: string;
}

export interface RunPlan {
	/** Resolved budget tier name (full | economy | free). */
	tier: string;
	/** Phases in run order: prewalk → work → review (omitting skipped ones). */
	phases: PlanPhase[];
	/** The tier's wall-clock budget (ms) — shown as the total-clock
	 *  headroom ("total 45s/25m") so a wall abort is never a surprise.
	 *  Optional AND nullable under exactOptionalPropertyTypes — callers
	 *  forward their own `T | undefined` options verbatim. */
	wallTimeoutMs?: number | undefined;
	/** R5: the per-review-fork wall budget (ms) — shown on the plan line
	 *  as the review phase's own budget headroom ("· review wall 20m").
	 *  Only rendered when the plan INCLUDES a review phase; independent of
	 *  wallTimeoutMs (the worker and review phases have separate walls). */
	reviewWallTimeoutMs?: number | undefined;
	/** The session's current /goals statement (resolved at execute via
	 *  readGoals; absent → no goals clause anywhere). */
	goals?: string | undefined;
}

export interface BuildRunPlanOptions {
	/** Resolved budget tier name. */
	tier: string;
	/** Strong exploration model; undefined/null = no prewalk. */
	prewalkModel?: string;
	/** Model the worker executes on (always present). */
	executeModel: string;
	/** Reviewer model; defaults to the execute model. */
	reviewModel?: string;
	/** Whether the forked review will run (tier flag AND single-worker path). */
	review?: boolean;
	/** The tier's wall-clock budget (ms) — rendered as total-clock headroom. */
	wallTimeoutMs?: number;
	/** R5: the per-review-fork wall (ms) — rendered on the plan line ONLY
	 *  when the review phase is included (see RunPlan.reviewWallTimeoutMs). */
	reviewWallTimeoutMs?: number;
	/** The session's current /goals statement (readGoals at execute). */
	goals?: string;
}

/**
 * Derive the dispatched plan from the same inputs the orchestrator uses:
 * prewalk is active only when a prewalk model distinct from the execute
 * model is configured (auto-skip rule); review runs only when enabled AND
 * the run takes the single-worker path. Pure — tested hermetically.
 */
export function buildRunPlan(opts: BuildRunPlanOptions): RunPlan {
	const phases: PlanPhase[] = [];
	if (
		opts.prewalkModel !== undefined &&
		opts.prewalkModel !== opts.executeModel
	) {
		phases.push({ name: "prewalk", model: opts.prewalkModel });
	}
	phases.push({ name: "work", model: opts.executeModel });
	if (opts.review) {
		phases.push({
			name: "review",
			model: opts.reviewModel ?? opts.executeModel,
		});
	}
	return {
		tier: opts.tier,
		phases,
		wallTimeoutMs: opts.wallTimeoutMs,
		reviewWallTimeoutMs: opts.reviewWallTimeoutMs,
		goals: opts.goals,
	};
}

/** The phase a fresh worker starts in (the plan's first phase). */
export function initialPhaseOf(plan: RunPlan): WorkerPhase {
	return plan.phases[0]?.name ?? "work";
}

// ─── Live worker state (R2/R3) ───────────────────────────────────────

export interface WorkerProgress {
	turns: number;
	done: boolean;
	/** Current phase: prewalk | work | review. */
	phase: WorkerPhase;
	/** Real checklist state relayed from the worker; null = not initialized. */
	checklist: ChecklistProgress | null;
	/** Timestamp (ms) of the worker's last observed event; undefined = none. */
	lastEventMs?: number;
	/** Timestamp (ms) of when the worker's CURRENT phase started — the base
	 *  of the per-worker phase-elapsed clock (R1). Updated on every phase
	 *  transition (incl. each review-fix iteration's review_start). */
	phaseStartMs: number;
	/** Dispatch-time context (worker_meta event): the worker's goal line +
	 *  file-scope hints from its spec — the "what is this worker doing"
	 *  answer, extracted mechanically (no LLM). */
	meta?: { goal: string; scope: string[] };
	/** Most recent in-flight tool (tool_start/tool_end): name + summarized
	 *  args — the live "what is it touching right now" answer. */
	lastTool?: { name: string; args: string } | null;
}

export interface ProgressState {
	/** The dispatched plan (shown on the first line). */
	plan: RunPlan;
	/** 0-based worker index → live state. */
	workers: Map<number, WorkerProgress>;
	/** Workers that have yielded. */
	done: number;
	/** Total worker count. */
	total: number;
	/** Run start timestamp (ms) — the base of the total-elapsed clock (R1). */
	startMs: number;
	/** Parallel-merge outcome (set once by the "merge" event; R1 success
	 *  line: merged commit id + files changed vs the pre-merge base). */
	merge?: { commit_id: string; files_changed: number };
}

export function createProgressState(
	total: number,
	plan: RunPlan,
	nowMs: number,
): ProgressState {
	const workers = new Map<number, WorkerProgress>();
	const phase = initialPhaseOf(plan);
	for (let i = 0; i < total; i++) {
		workers.set(i, {
			turns: 0,
			done: false,
			phase,
			checklist: null,
			lastEventMs: nowMs,
			phaseStartMs: nowMs,
		});
	}
	return { plan, workers, done: 0, total, startMs: nowMs };
}

/** Recompute the done count from the workers map (a yield carries no count). */
function recountDone(state: ProgressState): void {
	let n = 0;
	for (const w of state.workers.values()) {
		if (w.done) n++;
	}
	state.done = n;
}

/**
 * File-scope hints: path-like tokens (with a dot-extension) found in a
 * spec's markdown — the dispatcher's own prose names the files workers
 * should touch. Deterministic, zero LLM. Deduped, noise-filtered
 * (URLs, numeric/version tokens), capped. Pure — tested hermetically.
 */
export function extractFileScope(markdown: string, max = 5): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of markdown.matchAll(/[\w./-]+\.[A-Za-z0-9]{1,5}/g)) {
		const tok = m[0];
		if (tok.startsWith("http") || tok.startsWith("www") || tok.startsWith("/"))
			continue;
		// A match that starts mid-URL ("https://example.com/x.md" matches at
		// "example…") — the char(s) right before it include "//".
		if (
			m.index !== undefined &&
			markdown.slice(Math.max(0, m.index - 3), m.index).includes("//")
		)
			continue;
		const ext = tok.split(".").pop() ?? "";
		if (ext.length > 0 && /^\d+$/.test(ext)) continue; // versions like 0.83.0
		if (!seen.has(tok)) {
			seen.add(tok);
			out.push(tok);
			if (out.length >= max) break;
		}
	}
	return out;
}

/**
 * Fold one streamed progress event into the state. `index` defaults to 0
 * (single-worker runs and fix/review sessions carry no index). Unknown
 * event types (workspace_created, merge, review verdicts) never throw and
 * change nothing; worker-scoped events update the worker's liveness
 * timestamp. Pure — tested hermetically.
 */
export function applyProgressEvent(
	state: ProgressState,
	rawEvent: unknown,
	nowMs: number,
): void {
	const ev = rawEvent as Record<string, unknown> | null;
	if (!ev || typeof ev.type !== "string") return;

	const index = typeof ev.index === "number" ? ev.index : 0;
	const worker = (): WorkerProgress => {
		const w = state.workers.get(index) ?? {
			turns: 0,
			done: false,
			phase: initialPhaseOf(state.plan),
			checklist: null,
			phaseStartMs: nowMs,
		};
		state.workers.set(index, w);
		w.lastEventMs = nowMs;
		return w;
	};

	switch (ev.type) {
		case "worker_meta": {
			// Dispatch-time worker context (goal + file scope per worker) —
			// emitted once before the workers start; the widget answers
			// "what is this worker doing" without any LLM.
			if (Array.isArray(ev.metas)) {
				(ev.metas as Array<{ goal?: string; scope?: string[] }>).forEach(
					(meta, i) => {
						const w = state.workers.get(i);
						if (w) w.meta = { goal: meta.goal ?? "", scope: meta.scope ?? [] };
					},
				);
			}
			return;
		}
		case "merge": {
			// R1 success line: the atomic combine landed — record the merged
			// commit id + file delta for the progress render.
			if (typeof ev.commit_id === "string") {
				state.merge = {
					commit_id: ev.commit_id,
					files_changed:
						typeof ev.files_changed === "number" ? ev.files_changed : 0,
				};
			}
			return;
		}
		case "turn": {
			const w = worker();
			// R3: the reviewer is a separate process — its turn events must
			// not advance the worker's turn counter while in review (liveness
			// still updates via worker()).
			if (w.phase !== "review" && typeof ev.turns === "number")
				w.turns = ev.turns;
			break;
		}
		case "tool_start": {
			const w = worker();
			// Live "what is it touching" — the tool name + summarized args
			// (surface only the summary; full args stay worker-side).
			w.lastTool = {
				name:
					typeof ev.toolName === "string" ||
					(typeof ev.toolName === "number" && Number.isFinite(ev.toolName))
						? String(ev.toolName)
						: "tool",
				args: typeof ev.args === "string" ? ev.args : "",
			};
			break;
		}
		case "tool_end": {
			const w = worker();
			w.lastTool = null;
			// prewalk → work on the same signal as the model swap: the first
			// SUCCESSFUL edit/write (an errored edit does not swap, so it must
			// not transition the display either).
			if (
				(ev.toolName === "edit" || ev.toolName === "write") &&
				ev.isError !== true &&
				w.phase === "prewalk"
			) {
				w.phase = "work";
				w.phaseStartMs = nowMs;
			}
			break;
		}
		case "checklist": {
			const w = worker();
			// R3: frozen during review (the worker's checklist is final; the
			// reviewer never sends checklist events anyway).
			if (
				w.phase !== "review" &&
				typeof ev.done === "number" &&
				typeof ev.total === "number"
			) {
				w.checklist = { done: ev.done, total: ev.total };
			}
			break;
		}
		case "yield": {
			const w = worker();
			w.done = true;
			recountDone(state);
			break;
		}
		case "workers_progress": {
			if (typeof ev.done === "number") state.done = ev.done;
			break;
		}
		case "review_start": {
			const w = worker();
			w.phase = "review";
			// The review clock starts here — each fix-loop iteration restarts it.
			w.phaseStartMs = nowMs;
			break;
		}
		default:
			break;
	}
}

// ─── Rendering (pure, deterministic given `now`) ─────────────────────

/**
 * Format a duration compactly and readably, e.g. "250ms", "42s", "1m05s", "7m12s", "1h2m".
 * Clamps negative numbers to "0s". Pure.
 */
export function formatDuration(ms: number): string {
	if (ms <= 0) return "0s";
	const roundedMs = Math.round(ms);
	if (roundedMs === 0) return "0s";
	if (roundedMs < 1000) return `${roundedMs}ms`;
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) {
		return seconds > 0
			? `${minutes}m${String(seconds).padStart(2, "0")}s`
			: `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;
}

/** The plan line: `plan(<tier>): prewalk(<model>) → work(<model>) → ...`,
 *  with optional clauses: the session goals and — when a review phase will
 *  run — the per-review fork's own wall budget ("· review wall 20m", R5). */
export function renderPlanLine(plan: RunPlan): string {
	const base = `plan(${plan.tier}): ${plan.phases.map((p) => `${p.name}(${p.model})`).join(" → ")}`;
	const clauses: string[] = [];
	const goals = renderGoalsClause(plan.goals);
	if (goals) clauses.push(goals);
	if (
		plan.phases.some((p) => p.name === "review") &&
		plan.reviewWallTimeoutMs !== undefined
	) {
		clauses.push(`review wall ${formatDuration(plan.reviewWallTimeoutMs)}`);
	}
	return clauses.length > 0 ? `${base} · ${clauses.join(" · ")}` : base;
}

/** Max goals characters kept on the plan line before the ellipsis. */
export const PLAN_LINE_GOALS_MAX = 60;

/**
 * Truncate a goals statement for the plan line: keep at most
 * PLAN_LINE_GOALS_MAX characters (the existing tool-arg cut convention:
 * max−3 chars + "…" when cut). Pure — tested hermetically.
 */
export function truncateGoals(
	goals: string,
	max: number = PLAN_LINE_GOALS_MAX,
): string {
	// Collapse whitespace (incl. newlines) to a single line FIRST: a
	// multi-line goals statement must never embed a newline into the
	// plan line or a notify message (the RPC crash vector).
	const g = goals.replace(/\s+/g, " ").trim();
	return g.length > max ? `${g.slice(0, max - 3)}…` : g;
}

/**
 * The plan-line goals clause: "goals: <truncated>" for a present, non-blank
 * statement; "" otherwise — so absent goals keep the plan line backward
 * compatible (no goals clause). Pure — tested hermetically.
 */
export function renderGoalsClause(goals: string | undefined | null): string {
	if (!goals) return "";
	const g = goals.trim();
	return g.length > 0 ? `goals: ${truncateGoals(g)}` : "";
}

/**
 * R2: the per-worker phase chain with completion marks, e.g. "✓prewalk → work"
 * while working, "✓prewalk → ✓work → ✓review" when the worker is done (review
 * runs after yield). Phases BEFORE the current one are completed; the current
 * phase is marked only once the worker has yielded (a done worker's phases are
 * all marked). A phase outside the plan (defensive; can't happen in practice)
 * renders bare. The plan line itself keeps showing models as-is.
 */
export function renderPhaseChain(
	plan: RunPlan,
	phase: WorkerPhase,
	done: boolean,
): string {
	const idx = plan.phases.findIndex((p) => p.name === phase);
	if (idx === -1) return phase;
	return plan.phases
		.slice(0, idx + 1)
		.map((p, i) => (i < idx || (done && i === idx) ? `✓${p.name}` : p.name))
		.join(" → ");
}

/**
 * Render the full progress view. Pure function of (state, nowMs) — no LLM,
 * no subprocess; `nowMs` is explicit so tests are deterministic. Done
 * workers outside the review phase show no idle (they are terminal); a done
 * worker in review shows liveness because the forked review is still
 * running on its behalf.
 */
export function buildProgressText(
	state: ProgressState,
	nowMs: number = Date.now(),
): string {
	const lines: string[] = [
		renderPlanLine(state.plan),
		`${state.done}/${state.total} workers done`,
	];
	for (let i = 0; i < state.total; i++) {
		lines.push(...renderWorkerLine(state, i, nowMs));
	}
	// R1: the atomic-combine success line — merged N worker commits → id
	// (X files vs base; worker commits consumed by the squash). This is
	// the unambiguous "the merge worked" signal (the false-alarm error
	// class reported deltas against a non-base reference instead).
	if (state.merge) {
		lines.push(
			`merged ${state.total} worker commit(s) → ${state.merge.commit_id} ` +
				`(${state.merge.files_changed} file(s) changed vs base; worker commits consumed)`,
		);
	}
	return lines.join("\n");
}

function renderWorkerLine(
	state: ProgressState,
	index: number,
	nowMs: number,
): string[] {
	const label = `worker-${index + 1}`;
	const w = state.workers.get(index) ?? {
		turns: 0,
		done: false,
		phase: initialPhaseOf(state.plan),
		checklist: null,
		phaseStartMs: state.startMs,
	};
	// R1: per-worker current-phase elapsed + the run's total elapsed (with
	// the tier wall as headroom — "total 45s/25m" — so a wall abort is
	// never a surprise).
	const chain = renderPhaseChain(state.plan, w.phase, w.done);
	const phaseElapsed = formatDuration(nowMs - w.phaseStartMs);
	const totalElapsed = formatDuration(nowMs - state.startMs);
	const wall = state.plan.wallTimeoutMs
		? `/${formatDuration(state.plan.wallTimeoutMs)}`
		: "";
	const clocks = `${phaseElapsed} | total ${totalElapsed}${wall}`;
	const checklistText = w.checklist
		? `checklist ${w.checklist.done}/${w.checklist.total}`
		: "no checklist yet";
	const turnsText = `${w.turns} turn${w.turns === 1 ? "" : "s"}`;

	const lines: string[] = [];
	if (w.done && w.phase !== "review") {
		lines.push(
			`  ✓ ${label}: ${chain} ${clocks} | ${checklistText} | ${turnsText}`,
		);
	} else {
		const idleSeconds =
			w.lastEventMs === undefined
				? null
				: Math.max(0, Math.floor((nowMs - w.lastEventMs) / 1000));
		const liveness =
			idleSeconds === null ? turnsText : `${turnsText}, ${idleSeconds}s idle`;
		lines.push(
			`  ⏳ ${label}: ${chain} ${clocks} | ${checklistText} | ${liveness}`,
		);
	}

	// A: dispatch-time context — the worker's goal + file scope, extracted
	// mechanically from its spec (no LLM): "what is this worker doing".
	const meta = w.meta;
	if (meta && (meta.goal || meta.scope.length > 0)) {
		const scope =
			meta.scope.length > 0
				? ` [${meta.scope.slice(0, 3).join(", ")}${meta.scope.length > 3 ? ", …" : ""}]`
				: "";
		lines.push(`  ${label} → ${meta.goal || "(no goal)"}${scope}`);
	}
	// B: live "what is it touching right now" — the in-flight tool.
	if (w.lastTool && !(w.done && w.phase !== "review")) {
		const args =
			w.lastTool.args.length > 60
				? w.lastTool.args.slice(0, 57) + "…"
				: w.lastTool.args;
		lines.push(`  ⎈ ${w.lastTool.name}${args ? `: ${args}` : ""}`);
	}
	return lines;
}
