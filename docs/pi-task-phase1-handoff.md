# pi-task — Phase 1 Handoff

You are implementing **Phase 1** of `pi-task`, a new task-execution engine for
pi. This doc plus the design doc are everything you need. Read the design doc
first, then build Phase 1 in an isolated jj workspace.

## Mission

Build the foundation: a **worker runner** that spawns a pi RPC session, sends it
a task, and receives **schema-validated typed output** via a `yield` tool. This
replaces the current fire-and-forget `pi --mode json -p` subagent spawning with a
bidirectional, typed mechanism. Everything else in pi-task (prewalk, review,
metrics, the `task` tool) builds on this.

## Required reading (in order)

1. **`docs/pi-task-design.md`** (same directory as this file) — the full
   architecture. Phase 1 is **row 1 of the "Implementation Strategy → Phases"
   table**. Also read: "Worker System Prompt", "Worker Tool Surface → yield
   tool", and "Verification and Review". ("Context Seeding" is background only —
   not built in Phase 1.)
2. **pi RPC protocol** —
   `/home/danong/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`.
   Read it fully. The JSONL framing rules, the command set (`prompt`, `abort`,
   `get_session_stats`), and the event types (`tool_execution_end`,
   `message_end`, `agent_settled`) are essential.
3. **pi extensions API** —
   `/home/danong/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`.
   For `pi.registerTool`, TypeBox parameters, tool-result `terminate: true`, and
   `ctx.shutdown()`.
4. **Existing code to crib from** —
   `/home/danong/.pi/agent/extensions/subagent/index.ts` (see `getPiInvocation`,
   the manual JSONL line parser, and the spawn/abort pattern) and
   `/home/danong/.pi/agent/extensions/memory-store.ts` (another
   `getPiInvocation`). Reuse these patterns; do not reinvent them.
5. **jj skill** — `/home/danong/.pi/agent/skills/jj/SKILL.md`. Load it before any
   jj/git work.

## Step 0 — set up the workspace (do this first)

All Phase 1 work happens in a **jj workspace**, NOT the live global config. This
protects the config your daily sessions run on.

```bash
cd /home/danong/.pi/agent
jj workspace add ../pi-task-dev
```

The workspace lives at **`/home/danong/.pi/pi-task-dev`**. It shares commits and
the op log with the main repo but has its own working copy.

- Put all new code under `/home/danong/.pi/pi-task-dev/extensions/task/`.
- **Do not edit anything under `/home/danong/.pi/agent/extensions/`** — that is
  the live config.
- The shell cwd does **not** persist across bash tool calls. Prefix every bash
  command with `cd /home/danong/.pi/pi-task-dev && ...`.

## Deliverables

Create these under `/home/danong/.pi/pi-task-dev/extensions/task/`:

### 1. `schemas/yield.ts` — the typed contract (single source of truth)

TypeBox schema plus exported TS type for the yield payload:

```typescript
{
  files_changed: string[],   // paths modified
  summary: string,           // one-paragraph description
  commit_ids: string[],      // jj commit IDs created
  deviations: string[]       // spec deviations (empty if none)
}
```

Export both the `Type.Object(...)` schema and the inferred TS type.

### 2. `tools/yield.ts` — worker-side extension (the completion gate)

An extension that registers the `yield` tool. It is loaded **inside the worker
subprocess** via `--extension` (not in the orchestrator).

- `parameters` = the schema from `schemas/yield.ts`.
- `execute()`: pi has already validated the args against the schema before
  calling execute. Return
  `{ content: [{ type: "text", text: "Yield accepted." }], details: { ...args }, terminate: true }`
  and call `ctx.shutdown()` to end the worker session.
- `terminate: true` skips the follow-up LLM call; `ctx.shutdown()` closes the RPC
  session. Together they make `yield` a hard stop.

### 3. `worker.ts` — the worker runner

Export `runWorker(opts)`:

```typescript
runWorker({
  cwd: string,            // working dir for the worker (a jj repo)
  model: string,          // e.g. "opencode-go/deepseek-v4-flash"
  task: string,           // the task prompt
  systemPrompt?: string,  // worker system prompt (appended)
  signal?: AbortSignal,
  onUpdate?: (partial: unknown) => void,
}): Promise<WorkerResult>
```

Behavior:

- Resolve the pi invocation with `getPiInvocation` (crib from
  `subagent/index.ts` — do **not** hardcode `pi`).
- Spawn:
  `pi --mode rpc --no-session --model <model> --extension <ABS path to tools/yield.ts in the workspace> --append-system-prompt <temp prompt file>`
  (write `systemPrompt` to a temp file; pass the absolute workspace path to the
  yield extension).
- Send `{ "type": "prompt", "message": <task> }` on stdin.
- **Parse stdout as JSONL manually**: buffer incoming data, split on `\n` only,
  strip a trailing `\r` from each line, `JSON.parse` each line. **Do NOT use
  Node `readline`** — it also splits on U+2028/U+2029, which are valid inside
  JSON strings and will corrupt records. (The subagent extension already does
  this correctly — copy that parser.)
- Watch the event stream for `tool_execution_end` with `toolName === "yield"`;
  capture the typed payload from that event. (A `message_end` for the
  `toolResult` with `toolName === "yield"` also works.)
- Collect usage from `message_end` events whose message is an assistant message:
  accumulate `usage.input/output/cacheRead/cacheWrite`, `usage.cost.total`, and
  `usage.totalTokens`. Count turns (assistant messages), reads
  (`tool_execution_end` with `toolName === "read"`), and edits (`edit`/`write`).
- Resolve when you see `agent_settled` (or the process exits).
- Honor `signal`: on abort, send `{ "type": "abort" }`, then SIGTERM, then
  SIGKILL after ~5s.
- Return:

```typescript
interface WorkerResult {
  yield: YieldPayload;        // from schemas/yield.ts
  usage: {
    turns: number;
    tokens_in: number;
    tokens_out: number;
    cache_read: number;
    cache_write: number;
    cost_usd: number;
    reads: number;
    edits: number;
  };
  exitCode: number;
}
```

**Prefer type-only imports** (`import type { YieldPayload } from "./schemas/yield.ts"`)
in `worker.ts` so it has **no runtime dependency on the pi package** — it only
needs `node:child_process` and `node:fs`. This makes the smoke test trivially
runnable. (The yield tool runs inside the worker subprocess, where the pi package
is available.)

### 4. Smoke test

A standalone script (e.g. `extensions/task/test-phase1.ts`) that:

1. Creates a temp dir and initializes a jj repo in it (`jj init` or
   `jj git init --colocate`), with a starter file.
2. Calls `runWorker` with a trivial task, e.g.: *"Create a file `hello.txt`
   containing `hi`. Commit it with jj. Then call yield reporting the file you
   changed and the commit id."* Use `model: "opencode-go/deepseek-v4-flash"` and
   the minimal system prompt below.
3. Asserts: `result.yield.files_changed` includes `hello.txt`,
   `result.yield.commit_ids` is non-empty, `result.usage.turns >= 1`.
4. Prints the full `WorkerResult`.

Run it with a timeout (it drives a real LLM):
`timeout 240 bun test-phase1.ts`. The pi package is installed at
`/home/danong/.local/lib/node_modules/@earendil-works/pi-coding-agent`; if bun
cannot resolve the import, run with the same runtime pi uses or set `NODE_PATH`.

## Critical technical details (expensive to rediscover)

1. **JSONL framing is LF-only.** Split on `\n`, strip trailing `\r`, never use
   `readline`. (See `subagent/index.ts` for a correct parser.)
2. **Reuse `getPiInvocation`.** The current process may run via node/bun with a
   script path; hardcoding `pi` breaks in some environments.
3. **The orchestrator reads the yield payload from the event stream**, not from
   prose stdout. Watch `tool_execution_end` for `toolName === "yield"`.
4. **pi validates tool args before `execute()`.** If the model yields an invalid
   payload, pi returns a validation error and the model retries. So a captured
   yield payload is already schema-valid — do **not** add a second zod schema in
   Phase 1. The TypeBox tool schema is the single source of truth. (The design
   doc's File Structure mentions zod; we deliberately use TypeBox in Phase 1 to
   avoid a duplicate schema. A separate zod schema can come later if needed.)
5. **`--extension` needs an absolute path** to the workspace's `tools/yield.ts`
   (`/home/danong/.pi/pi-task-dev/extensions/task/tools/yield.ts`), so the worker
   loads the in-progress tool, not anything from the live config.
6. **Use `--no-session` for the worker** in Phase 1 (no forked review yet). For
   debugging you may temporarily point `--session-dir` at a scratch dir.
7. **Model:** `opencode-go/deepseek-v4-flash` (fast tier, confirmed available).
   If it returns a 403 RegionError, retry once; if persistent, fall back to
   `qwen-token-plan/qwen3.7-plus`.

## Worker system prompt for Phase 1

Minimal — no `checklist()` yet (that is Phase 4):

```
You are implementing a coding task. Explore the codebase, make changes,
and call yield() when complete.

Make atomic jj commits as you complete each requirement.
Run verification commands after your changes.

Your first edit should be your most confident change.
```

## Acceptance criteria

Phase 1 is done when:

- `runWorker` spawns an RPC worker, sends a trivial task, and receives a
  schema-valid typed yield payload back.
- Usage stats (turns, tokens in/out, reads, edits, cost) are collected and
  non-zero where expected.
- Abort (via `signal`) terminates the worker.
- The smoke test passes against `opencode-go/deepseek-v4-flash`.
- All code lives in `/home/danong/.pi/pi-task-dev/extensions/task/`, committed
  with proper jj messages.
- The live config (`/home/danong/.pi/agent/extensions/`) is untouched.

## Out of scope for Phase 1 (do NOT build these)

- prewalk / model swap (Phase 3)
- `checklist` tool + context injection (Phase 4)
- repo-map / context seeding (Phase 5)
- `workspace.ts` / jj workspace isolation for parallel workers (Phase 6)
- forked review / reviewer personas (Phase 7)
- persisting metrics to `results/` (Phase 8) — collecting usage in-memory in
  `WorkerResult` IS in scope
- the `task` tool / `index.ts` / budget flag / TUI rendering (Phase 9)
- `task.toml` / budget resolution / schema locking (Phase 10)
- sandbox / bwrap

## Workflow rules

- Load the jj skill before any jj/git work.
- Commit format: `jj commit -m "type(scope): summary\n\nBody.\n\n#PI"` (scope
  required; `#PI` marks an agent commit). `jj commit` already starts the next
  empty `@` — do **not** run `jj new` after it.
- **Do not push** and **do not move bookmarks** unless explicitly asked.
- Use `timeout` on any command that could hang (the smoke test, godot, network).
- Handle errors explicitly — no empty catch blocks, no commented-out code.
- Discussion-vs-action gate: if the user asks a question or floats an idea
  ("should we X?"), discuss it; don't act. Act only on direct imperatives.
- Proceed autonomously through the spec above. If you hit a genuine ambiguity
  that would change the design, ask before improvising.

## Suggested order of work

1. Read the design doc + RPC docs + extensions docs; skim `subagent/index.ts`
   and `memory-store.ts`.
2. Create the workspace (Step 0).
3. Write `schemas/yield.ts`, then `tools/yield.ts`, then `worker.ts`.
4. Write the smoke test; run it (with a timeout); iterate until it passes.
5. Commit incrementally; leave a clean commit (or a few logical commits) for
   Phase 1.

## When done — report

Report to the user:

- Files created (paths).
- Smoke test output (the printed `WorkerResult`).
- Commit IDs (`jj log -r 'ancestors(@, 5)'`).
- Any deviations from this spec, and any blockers.
