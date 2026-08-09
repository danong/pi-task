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
}

/**
 * Derive the dispatched plan from the same inputs the orchestrator uses:
 * prewalk is active only when a prewalk model distinct from the execute
 * model is configured (auto-skip rule); review runs only when enabled AND
 * the run takes the single-worker path. Pure — tested hermetically.
 */
export function buildRunPlan(opts: BuildRunPlanOptions): RunPlan {
	const phases: PlanPhase[] = [];
	if (opts.prewalkModel !== undefined && opts.prewalkModel !== opts.executeModel) {
		phases.push({ name: "prewalk", model: opts.prewalkModel });
	}
	phases.push({ name: "work", model: opts.executeModel });
	if (opts.review) {
		phases.push({ name: "review", model: opts.reviewModel ?? opts.executeModel });
	}
	return { tier: opts.tier, phases };
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

export function createProgressState(total: number, plan: RunPlan, nowMs: number): ProgressState {
	const workers = new Map<number, WorkerProgress>();
	const phase = initialPhaseOf(plan);
	for (let i = 0; i < total; i++) {
		workers.set(i, { turns: 0, done: false, phase, checklist: null, lastEventMs: nowMs, phaseStartMs: nowMs });
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
 * Fold one streamed progress event into the state. `index` defaults to 0
 * (single-worker runs and fix/review sessions carry no index). Unknown
 * event types (workspace_created, merge, review verdicts) never throw and
 * change nothing; worker-scoped events update the worker's liveness
 * timestamp. Pure — tested hermetically.
 */
export function applyProgressEvent(state: ProgressState, rawEvent: unknown, nowMs: number): void {
	const ev = rawEvent as Record<string, unknown> | null;
	if (!ev || typeof ev.type !== "string") return;

	const index = typeof ev.index === "number" ? ev.index : 0;
	const worker = (): WorkerProgress => {
		const w =
			state.workers.get(index) ?? {
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
		case "merge": {
			// R1 success line: the atomic combine landed — record the merged
			// commit id + file delta for the progress render.
			if (typeof ev.commit_id === "string") {
				state.merge = {
					commit_id: ev.commit_id,
					files_changed: typeof ev.files_changed === "number" ? ev.files_changed : 0,
				};
			}
			return;
		}
		case "turn": {
			const w = worker();
			// R3: the reviewer is a separate process — its turn events must
			// not advance the worker's turn counter while in review (liveness
			// still updates via worker()).
			if (w.phase !== "review" && typeof ev.turns === "number") w.turns = ev.turns;
			break;
		}
		case "tool_start": {
			worker();
			break;
		}
		case "tool_end": {
			// prewalk → work on the same signal as the model swap: the first
			// SUCCESSFUL edit/write (an errored edit does not swap, so it must
			// not transition the display either).
			const w = worker();
			if ((ev.toolName === "edit" || ev.toolName === "write") && ev.isError !== true && w.phase === "prewalk") {
				w.phase = "work";
				w.phaseStartMs = nowMs;
			}
			break;
		}
		case "checklist": {
			const w = worker();
			// R3: frozen during review (the worker's checklist is final; the
			// reviewer never sends checklist events anyway).
			if (w.phase !== "review" && typeof ev.done === "number" && typeof ev.total === "number") {
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
 * Format a duration for the progress view, e.g. "42s", "1m05s", "12m".
 * Whole seconds (rounded); minutes carry zero-padded seconds. Pure.
 */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (seconds === 0) return `${minutes}m`;
	return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** The plan line: `plan(<tier>): prewalk(<model>) → work(<model>) → ...` */
export function renderPlanLine(plan: RunPlan): string {
	return `plan(${plan.tier}): ${plan.phases.map((p) => `${p.name}(${p.model})`).join(" → ")}`;
}

/**
 * R2: the per-worker phase chain with completion marks, e.g. "✓prewalk → work"
 * while working, "✓prewalk → ✓work → ✓review" when the worker is done (review
 * runs after yield). Phases BEFORE the current one are completed; the current
 * phase is marked only once the worker has yielded (a done worker's phases are
 * all marked). A phase outside the plan (defensive; can't happen in practice)
 * renders bare. The plan line itself keeps showing models as-is.
 */
export function renderPhaseChain(plan: RunPlan, phase: WorkerPhase, done: boolean): string {
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
export function buildProgressText(state: ProgressState, nowMs: number = Date.now()): string {
	const lines: string[] = [renderPlanLine(state.plan), `${state.done}/${state.total} workers done`];
	for (let i = 0; i < state.total; i++) {
		lines.push(renderWorkerLine(state, i, nowMs));
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

function renderWorkerLine(state: ProgressState, index: number, nowMs: number): string {
	const label = `worker-${index + 1}`;
	const w = state.workers.get(index) ?? {
		turns: 0,
		done: false,
		phase: initialPhaseOf(state.plan),
		checklist: null,
		phaseStartMs: state.startMs,
	};
	// R1: per-worker current-phase elapsed + the run's total elapsed.
	const chain = renderPhaseChain(state.plan, w.phase, w.done);
	const phaseElapsed = formatDuration(nowMs - w.phaseStartMs);
	const totalElapsed = formatDuration(nowMs - state.startMs);
	const clocks = `${phaseElapsed} | total ${totalElapsed}`;
	const checklistText = w.checklist ? `checklist ${w.checklist.done}/${w.checklist.total}` : "no checklist yet";
	const turnsText = `${w.turns} turn${w.turns === 1 ? "" : "s"}`;

	if (w.done && w.phase !== "review") {
		return `  ✓ ${label}: ${chain} ${clocks} | ${checklistText} | ${turnsText}`;
	}
	const idleSeconds =
		w.lastEventMs === undefined ? null : Math.max(0, Math.floor((nowMs - w.lastEventMs) / 1000));
	const liveness = idleSeconds === null ? turnsText : `${turnsText}, ${idleSeconds}s idle`;
	return `  ⏳ ${label}: ${chain} ${clocks} | ${checklistText} | ${liveness}`;
}
