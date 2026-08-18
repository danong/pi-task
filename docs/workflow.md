# pi-task workflow

How the agent-facing workflow works: what the conversational agent is
supposed to do, which templates and skills exist and when to use them, and
what happens inside a task run. The deep internals (jj mechanics, merge
ladder, budget plumbing) live in `pi-task-design.md`; this document is the
surface — what a user and a conversational agent actually do.

## The split: orchestrate vs. execute

pi-task separates the *orchestrator* (the conversational agent you chat
with) from the *executors* (isolated task workers):

- The **conversational agent plans and dispatches**: it decides what to
  build, decomposes it, writes specs, and calls the `task` tool. Its job is
  orientation, not investigation — deep exploration happens in workers.
- **Task workers execute**: each runs in an isolated jj workspace (or the
  main repo for a single-worker run), commits per requirement, and its work
  is only merged after the verification gate passes.

The split is enforced partly by the always-on **workflow contract** (below),
partly by code: workers are sandboxed, verification is a real bash gate, and
the merge is atomic with deterministic conflict resolution.

## Session goals (`/goals`)

The session's vision lives in `/goals`: `/goals <statement>` sets (or
updates) it, `/goals` alone shows it. Goals are user-owned session entries —
they die with the session, and only the command writes them: the agent never
mutates them, it only reads them at dispatch time (they appear truncated on
the widget's plan line, e.g. `goals: block algorithmic feeds…`).

## The workflow contract (always-on)

At every session start, pi-task injects a compact workflow contract into the
main session's system prompt (config-gated via `[injection]
workflow_contract` in the agent-dir `repo-map.toml`; default on). It says,
in short:

- **Goals first** — every dispatch references the current `/goals`; a
  change serving no stated goal is raised with the user, not dispatched.

- **Plan first** — multi-step work starts with a plan: decompose into
  milestones, sequence them, state how each is verified, before writing code.
- **Delegate by default** — multi-step, iterative, parallelizable, or
  unvalidated work goes to the `task` tool; only trivially small, reversible
  changes are made directly.
- **Orientation only** — at most 2–3 tool calls (the injected codebase map
  plus one targeted read) before writing a spec; deep exploration belongs to
  the workers.
- **Shared domain language** — when the repo has a `CONTEXT.md`, read it
  before deep work and use its vocabulary (project-side convention; read
  when present, never required).
- **Spec discipline** — write WHAT, not HOW: `## Goal` (one sentence),
  `## Requirements` (numbered WHATs), `## Verification` (plain bash commands,
  one per line, each exits 0).

## The flow

For any non-trivial request:

1. **Plan** — run `/plan` for a multi-day/week effort (milestones,
   sequencing, dispatch order) or just decompose in-conversation for a
   one-shot. Resolve open questions with the user before dispatching
   (the grilling step — `/plan` surfaces them).
2. **Goals** — if the session has a vision (`/goals <statement>`), state
   it up front and reference it in the spec; the contract requires it.
2. **Build** — for each milestone or one-off task, scaffold a spec with
   `/build`, or write it directly following the spec format.
3. **Dispatch** — call the `task` tool with the spec. Independent milestones
   with disjoint file scopes go as parallel `sub_specs` in one dispatch.
4. **Watch** — the widget shows each worker's goal + file scope, the live
   in-flight tool, checklist progress, and wall headroom.
5. **Review the result** — the run reports the merged commit, file delta,
   verification result, and review findings (or a failure artifact with a
   scripted recovery guide).

For **big-picture architecture reviews** (one-off surveys of an area, or a
hotspot scan for deepening opportunities), dispatch `/survey` instead — the
survey runs as a worker that produces a ranked report, which is then itself
adversarially reviewed (see below).

## Templates (user-invoked)

| Template | What it does | When to use |
|---|---|---|
| `/plan` | Scaffolds a multi-day/week work plan: goal, constraints, milestones (each with its own Goal / Requirements / Verification and a disjoint file scope), dependency sequencing, dispatch order, delegation mapping, and the open questions to settle with the user before dispatching. | Before any effort bigger than one dispatch — settle the approach and get approval first. |
| `/build` | Scaffolds a single task spec from a work request: Goal / Requirements / Verification (plain bash, exit 0). | Once the plan is settled — turn one milestone or request into a dispatch. |
| `/survey` | Scaffolds an architecture-review dispatch: a named area, or a hotspot scan (VCS churn), with the report format and vocabulary. | One-off big-picture reviews — where the code is shallow, tangled, or untested. |
| `/scaffold` | Creates the standard project stubs (AGENTS.md, CONTEXT.md, docs/adr/, README.md, .gitignore, mise.toml, .pi/settings.json), then asks whether to also set up jj/git init + mise trust. | A brand-new repo — the agent shouldn't have to reverse-engineer the usual conventions. |

All three are package prompt templates (`prompts/`), so they ship wherever
pi-task is installed.

## Skills (model-invoked)

- **`delegation`** — loaded when relevant: the dispatch threshold
  (multi-step / iterative / parallelizable / unvalidated → `task`; trivial
  reversible → direct), the investigation budget, spec discipline, and
  recovering a failed parallel merge.
- **`architecture-survey`** — loaded when the user asks for a big-picture
  review: dispatch it as a survey task (scope decision, vocabulary, report
  format, verification) rather than scanning the whole codebase in the main
  session.
- **`jj`** — pi-task owns the jj skill (the general cheatsheet plus a
  pi-task cookbook: engine merge mechanics, the recovery playbook, and the
  squash/stub/push footguns). Load for any version-control work.

## Run-pipeline shapes

The pipeline itself is shape-driven and separated from the budget tiers
(which pick the models). A shape declares the phase structure, swap policy,
model slots, and review axes — so tasks fit the type of work, and the same
spec can be benchmarked across shapes (prewalk on/off, swap on/off). Shapes
are `[shapes.*]` sections in `config/task.toml`; the task tool's `shape`
param overrides the tier's default, and the manifest records which shape ran.

- **`code`** (default) — prewalk plans on the strong model, swap to the fast
  execute model on the first edit, three-axis review (standards + spec
  fidelity + architecture fidelity). Built for implementation.
- **`analysis`** — no prewalk, no swap: the STRONG model writes (the tier's
  prewalk model is promoted into the work slot) and reviews. For surveys and
  design reviews, where the report IS the thinking. `/survey` dispatches
  `shape: "analysis"` + `review: "survey-reviewer"`.

`bench-regression` accepts `--shape <name>` (default `code`; baselines key
`<tier>@<shape>` with a tier fallback) — run the same canned specs across
shapes to measure whether the prewalk pays for itself.

## Inside a run

The task tool's lifecycle, roughly in order:

1. **Plan line** — the resolved budget tier, phases, models, and the
   session's current goals (shown in the widget before any worker starts).
2. **Prewalk** (strong-model tiers only) — a planning pass on the spec; the
   session swaps to the fast execute model on the first edit.
3. **Work** — each worker explores, implements, and commits per requirement,
   tracked by a checklist.
4. **Merge** — parallel workers' commits are combined into the task base in
   ONE atomic jj operation; textual conflicts resolve deterministically via
   the union ladder (jj 3-way → `jj resolve --tool union` backed by
   `git merge-file --union`) before any LLM/manual escalation, which gets
   only the conflicted hunks.
5. **Verify** — the spec's `## Verification` commands run as a real bash gate
   on the merged tree. Unverified work never merges; a hung command dies
   mechanically (per-command timeout + wall grace), never blocking work.
6. **Review** — at review tiers, a forked adversarial review runs on the
   worker's commit, checked along two axes:
   - **Standards** — repo conventions and smell baseline.
   - **Spec fidelity** — does the change implement the originating spec?
   - **Architecture fidelity** — does the change honor the recorded
     architecture (CONTEXT.md vocabulary/conventions, docs/adr/ decisions,
     the latest docs/architecture-review.md)?
   Each axis runs as its own fork so neither pollutes the other; findings
   merge, blockers (P0/P1) drive a bounded fix loop.
   For `/survey` dispatches, a survey-reviewer persona validates the report
   itself (cited files exist, claims traceable, candidates prioritized).
7. **Result** — success-with-caveat (e.g. a worker aborted during
   finalization but the merged work verified post-merge), or a failure
   artifact recording the cause, preserved workspaces, and a scripted
   recovery guide.

Aborted runs keep their work: single-worker WIP is rescue-committed, parallel
workspaces are preserved with their commit ids in the failure artifact, and
late aborts ("work committed, finalization incomplete") attempt finalization
(merge + gate) instead of failing flat.

## Quality loops

- **Verification gate** — real bash, exit codes; never merge unverified.
- **Adversarial review** — forked, persona-driven, the shape's review axes
  (default three: standards, spec fidelity, architecture fidelity — the last
  checks each change against the repo's recorded decisions).
- **Survey review** — the report artifact gets adversarially validated.
- **Metrics** — every run writes a manifest to `<agent-dir>/results/` (phase
  breakdown, tokens, cost, wall-clock latency, merge record, verification
  provenance); `/task-stats` summarizes them. Failure artifacts (`.failure.json`)
  carry the recovery guide.
- **Detached dispatch** — the `task` tool's `detach: true` returns a `run_id`
  immediately while the run executes in a child process (`extensions/task/runner.ts`)
  with the same spec/options and the same bounds; `/task-status <run_id>` queries
  the run's live heartbeat or its final manifest / failure artifact (the same
  files a blocking run writes, keyed by the returned run_id).

## Shared domain language (CONTEXT.md)

If the repo has a `CONTEXT.md`, it is the project's shared domain language:
the agent and workers use its vocabulary instead of inventing jargon, and
survey/review work reads it before looking at code. (`CONTEXT.md` is a
project-side convention — pi-task reads it when present, never requires it.)

## Configuration

Budget tiers, wall clocks, sandbox policy, and defaults live in
`config/task.toml` (see the README's Configuration section and the file
itself); the agent-dir copy holds per-machine overrides only. The
codebase-map injection (which seeds workers) is configured in the agent-dir
`config/repo-map.toml`.
