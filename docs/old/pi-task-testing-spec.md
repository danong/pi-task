> **Archive status:** Historical and non-normative. See [`README.md`](README.md) for the active source of truth.

# pi-task — Test Suite Restructuring Spec (Phase 6.5)

## Mission

Replace the six LLM-driven smoke test files with a **fast, hermetic, deterministic suite**
(pure-function unit tests + real-jj / real-bash tests, zero LLM calls, ≤15s), plus **one
consolidated e2e test** that exercises real pi + real LLM and is run manually. The 450s
runtime is ~100% LLM latency; removing LLM calls removes it. All product changes are
behavior-preserving extractions that make existing logic testable — no new seams, no fakes,
no PATH/env tricks, no subprocess stubs.

**E2E model policy:** the e2e hardcodes **`opencode-go/deepseek-v4-flash`** — the cheap,
no-thinking fast model — as the only model, everywhere. No frontier/reasoning models
(e.g. `qwen-token-plan/qwen3.8-max-preview`) anywhere in the test suite. The prewalk
*swap* (two distinct models) is therefore **not** e2e-tested; the swap decision logic is
already covered hermetically (see `test-prewalk.ts`).

## Current state (verified)

Six test files, all driving real LLMs (`opencode-go/deepseek-v4-flash`,
`qwen-token-plan/qwen3.8-max-preview`):

| File | LLM-dependent parts | Already-hermetic parts |
|---|---|---|
| `test-worker-runner.ts` | runWorker yield capture; abort (3s real worker) | — |
| `test-orchestrator.ts` | executeTask single worker | spec parsing checks |
| `test-prewalk.ts` | swap mechanics (real session); orchestrator wiring | auto-skip unit |
| `test-checklist.ts` | steering via setStatus signals; orchestrator wiring | — |
| `test-repo-map.ts` | full build (annotation); incremental (annotation); reads A/B (2 workers) | skeleton, tree hash, cache, slicing, config, skeleton-mode, parseAnnotation |
| `test-workspace.ts` | 2-worker parallel integration | splitSpec, workspace mechanics, conflict (real jj) |

## Target structure

```
extensions/task/
├── worker.ts            # + exported pure logic (below)
├── tools/checklist.ts   # + exported pure state machine (below)
├── orchestrator.ts      # + export runVerification (already hermetic)
├── test-jsonl.ts        # JSONL framing unit tests
├── test-worker.ts       # event reducer + settle logic
├── test-prewalk.ts      # swap logic via in-process fake session
├── test-checklist.ts    # pure checklist state machine
├── test-orchestrator.ts # spec parse + splitSpec + verification runner
├── test-workspace.ts    # splitSpec, mechanics, conflict (real jj)
├── test-repo-map.ts     # hermetic repo-map surface
├── test.ts              # fast runner: runs all of the above, <15s
└── test-e2e.ts          # THE one real-LLM test (manual, generous timeout)
```

Old `test-worker-runner.ts`, `test-orchestrator.ts`, `test-prewalk.ts`, `test-checklist.ts`,
`test-repo-map.ts`, `test-workspace.ts` are **deleted**; their hermetic assertions move to the
new files, their LLM assertions consolidate into `test-e2e.ts`.

## 1. Pure-function extractions (all behavior-preserving)

### `worker.ts`
- **Export `attachJsonlReader(stream, onLine)`** (currently private). Already takes a
  `ReadableStream` — tests feed it an in-process `Readable.from([chunks])`; **no subprocess
  needed**.
- **Extract the event reducer.** The `processEvent` closure accumulates `usage` (turns,
  tokens in/out, cache read/write, cost), counts reads/edits, captures the yield payload, and
  emits `onUpdate` events. Extract:
  ```typescript
  export interface WorkerEventState {
    usage: WorkerUsage;                 // zeroed initial
    yieldPayload: YieldPayload | null;
  }
  export function reduceWorkerEvent(
    state: WorkerEventState,
    event: unknown,
  ): { state: WorkerEventState; updates: WorkerUpdate[] };
  ```
  `spawnWorkerSession` keeps exactly the same observable behavior, now implemented as
  `state = reduceWorkerEvent(...).state` + dispatching `updates` to `onUpdate`.
- **Extract exit settling.** The `proc.on("close")` decision is pure:
  ```typescript
  export function settleWorker(
    state: WorkerEventState,
    exitCode: number,
    wasAborted: boolean,
    stderr: string,
  ): { ok: true; result: WorkerResult } | { ok: false; error: Error };
  ```

### `tools/checklist.ts` — extract the state machine (extension delegates)
```typescript
export interface ChecklistState { items: { text: string; done: boolean }[] }
export function createChecklistState(items: string[], maxItems?: number): ChecklistState; // default 12, truncates
export function markChecklistDone(state: ChecklistState, index: number):
  { ok: true; state: ChecklistState; remaining: number } | { ok: false; error: string };   // dup + out-of-range → ok:false
export function checklistRemaining(state: ChecklistState): number;
export function checklistStatusText(state: ChecklistState): string;   // "remaining:N"
export function checklistReminder(state: ChecklistState): string;     // "Remaining checklist items (complete before calling yield):\n1. ..."
export function shouldInjectChecklistReminder(firstEditDone: boolean, state: ChecklistState | null): boolean;
```
The extension's `execute()` and `context` handler call these (identical behavior); the
`readState`/`appendEntry` plumbing stays in the extension.

### `orchestrator.ts`
- **Export `runVerification(commands, cwd, timeoutMs, signal)`** (keep `runCommand` private).
  Already hermetic — real bash on a temp repo. No change to `executeTask`.
- `parseSpec`, `splitSpec` — already exported/pure, no change.

### `prewalk.ts` / `repo-map.ts`
- **No extraction needed.** `attachPrewalk` already depends only on a `{ onEvent, setModel }`
  interface — tests use an in-process fake session (capture listeners, record `setModel`
  calls). `parseAnnotation`, `buildSkeleton`, `getTreeHash`, `loadCachedMap`, `saveMap`,
  `sliceRelevant`, `formatMapPrompt`, `loadRepoMapConfig` are already exported and hermetic.

## 2. Fast test files (what each covers)

- **`test-jsonl.ts`** — `attachJsonlReader` over in-process `Readable.from` chunks: `\n`-only
  splitting; trailing `\r` stripped; **U+2028/U+2029 inside a JSON string must NOT split** (the
  readline bug); partial line flushed on `end`; non-JSON lines skipped; empty lines skipped.
- **`test-worker.ts`** — `reduceWorkerEvent`: turn counting only for
  `message_end.role==="assistant"`; usage accumulation sums input/output/cacheRead/cacheWrite/
  cost across messages; missing `usage`/`cost` fields handled (no NaN); `read` counts reads;
  `edit`/`write` count edits; yield captured from `tool_execution_end` `result.details` (not on
  `isError`); unrelated events produce no updates. `settleWorker`: the three exit branches.
- **`test-prewalk.ts`** — fake session: emit `message_end`×2 then `tool_execution_end(edit)` →
  `setModel(executeModel)` recorded once, `onSwap` info `{turns:2, toolName:"edit"}`, `swapped`
  true, no further swaps on later events; `write` also triggers; `isError` edit does not;
  auto-skip (already exists, keep). (Pruning `setStatus("prewalk")` is pi-extension behavior →
  e2e §3.)
- **`test-checklist.ts`** — `createChecklistState` truncation at 12; `markChecklistDone`
  happy/dup/out-of-range; `checklistRemaining`; `checklistStatusText` format; `checklistReminder`
  format; `shouldInjectChecklistReminder` matrix (no firstEdit → false; null state → false;
  remaining 0 → false; else true).
- **`test-orchestrator.ts`** — spec parsing (existing assertions incl. `SpecError` messages);
  `splitSpec` round-robin (moved from test-workspace); `runVerification` against a temp repo:
  passing command, failing command (exit code + output captured), multiple commands (failure
  aggregated), timeout path. **No worker spawns.**
- **`test-workspace.ts`** — unchanged free sections: mechanics (2 workspaces, multi-commit
  range, clean merge, clean removal, no leftover commits), conflict (both edits land,
  `conflicts: ["shared.txt"]`, markers in WC). `splitSpec` moves to test-orchestrator.
- **`test-repo-map.ts`** — keep skeleton/hash/cache/slicing/config/`parseAnnotation` (add:
  fence-stripping, braces-slicing, malformed-JSON throws, missing-field defaults). Skeleton-mode
  section rewritten to avoid the LLM: `saveMap(dir, fakeFullMap)` (exported, hermetic) → edit
  one file → `buildMap({mode:"skeleton"})` → unchanged file keeps cached summary, edited file
  has none. Drop sections 4–6 (needs annotation) and 8 (needs workers) — both move to e2e.

**Convention:** fast tests never import `spawnWorkerSession` or `executeTask` (documented in
`test.ts` header; `test.ts` imports only the listed fast modules).

## 3. The single e2e test — `test-e2e.ts`

Real pi + real LLM, run manually: `timeout 900 npx tsx extensions/task/test-e2e.ts`
(~3–5 min, ~$0.01–0.03). Not imported by `test.ts`.

**Model:** `const MODEL = "opencode-go/deepseek-v4-flash"` — hardcoded, single model, no
thinking/reasoning mode, no frontier models anywhere. The prewalk *swap* is not tested here
(it needs two distinct models; the swap decision logic is covered hermetically by
`test-prewalk.ts`).

Sections (consolidating all six old files' LLM coverage):
1. **runWorker** — trivial task → typed yield, non-empty commits, `usage.turns ≥ 1` (from
   test-worker-runner).
2. **Abort** — runWorker on a long task, abort after 3s → rejects with "abort" (from
   test-worker-runner).
3. **Checklist steering + prewalk-extension pruning** — one direct session with
   `CHECKLIST_EXTENSION_PATH` + `PREWALK_EXTENSION_PATH` (no `attachPrewalk` — models are
   equal): checklist `remaining:N` signals non-increasing to 0 AND `setStatus("prewalk")`
   flips `active` → `pruned` at the first edit and stays pruned. Assert files+commits present.
   (Replaces the old two-model swap sections of test-prewalk A and test-checklist A/B; the
   model-flip assertion is dropped — swap is hermetic-covered.)
4. **executeTask single** — success, verification passing, files/commits (from test-orchestrator
   + test-checklist C).
5. **executeTask parallel 2** — both files, both commit_ids, `workers.length===2`,
   `conflicts: []`, usage per worker (from test-workspace integration).
6. **repo-map full** — one annotation build: `map.files.length`, summaries present,
   `entryPoints` array; cache hit (`generated` unchanged); incremental rebuild re-annotates only
   the edited file (from test-repo-map 4–6).

Explicitly **dropped**: reads A/B (test-repo-map 8) — already declared benchmark-harness
territory in its own comment, not a smoke gate; map mechanics are validated hermetically.

Each section: labeled output, aggregated `errors` array, exit 1 on failure, `rmSync` cleanup
in `finally`. Headers document the hardcoded model.

## 4. Fast runner — `test.ts`

Imports each fast test file's exported `runTests()` (each fast file exports
`runTests(): Promise<void>`; direct execution also works via a `main()` guard checking
`process.argv[1]`), runs them sequentially, prints per-suite timing, exits 1 on first failure.
Header documents the no-LLM guarantee and the convention above.

**Time budget:** tsx startup ~1s + pure tests (ms) + ~20 real-jj ops (~0.1s each) + a few
real-bash verification runs ≈ **5–10s total**, comfortably under 15s. No network, no LLM,
fully deterministic.

## 5. Out of scope

- Abort signal escalation (SIGTERM→SIGKILL timing) — needs a real subprocess; e2e §2 only.
- Orchestrator's worker-facing wiring (spawn args, prompt file, extension paths, merge loop) —
  e2e is the only place a real worker exists; merge/conflict *mechanics* are hermetic via
  workspace tests.
- The checklist/prewalk extension wiring inside pi (setStatus, context reminders) — e2e §3.
- The model swap itself (two distinct models) — hermetic logic only; no second model in tests.
- Reads-reduction benchmark — future harness, not a smoke test.

## 6. Worker constraints (IMPORTANT — the implementing agent)

- Work **only** in `$PI_TASK_WORKSPACE` — the pi-task-dev jj workspace (a workspace
  over the shared `~/.pi/agent` repo: shared commits + op log, its own working copy).
- **Do NOT modify anything under `$PI_AGENT_DIR/`** (the live config) or the main
  working copy. **Do NOT touch the `main` bookmark, do NOT push, do NOT rebase.**
- Commit **in this workspace's `@` chain** with jj: load the jj skill first; commit format
  `jj commit -m "type(scope): summary\n\nBody.\n\n#PI"`; `jj commit` starts the next empty `@`
  — do not run `jj new` after. Current top of chain: `e729a232` (phase 6). The spec doc
  (`docs/pi-task-testing-spec.md`) is part of the work and is committed with the implementation.
- The shell cwd does not persist across tool calls — prefix every bash command with
  `cd $PI_TASK_WORKSPACE && ...`.

## 7. Acceptance criteria

- `timeout 120 npx tsx extensions/task/test.ts` passes in **<15s**, zero LLM calls (verifiable:
  no `spawnWorkerSession`/`executeTask` imports in fast files).
- All six old LLM test files deleted; hermetic assertions preserved; LLM assertions present in
  `test-e2e.ts` with the single hardcoded `opencode-go/deepseek-v4-flash` model.
- `test-e2e.ts` passes once against the real model (manual run, documented cost).
- Strict typecheck clean (recipe: scratch tsconfig — module `ESNext`, `target: "ES2022"` (default
  target errors on Set/Map iteration, TS2802), moduleResolution
  `bundler`, `allowImportingTsExtensions`, `noEmit`, `skipLibCheck`, `strict`,
  `typeRoots: ["$PI_PACKAGE_ROOT/node_modules/@types"]`,
  `types: ["node"]`, and `paths` mapping `typebox` /
  `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` to their locations under
  `$PI_PACKAGE_ROOT/node_modules/`; run via
  `npx -y -p typescript@5.9.3 tsc -p <scratch-tsconfig>` — recreate it at `/tmp`).
- `docs/pi-task-design.md` updated: short "Testing" note (fast hermetic suite + one manual e2e;
  where each behavior is verified; no hardcoded counts — point at the test files).
- All code in `$PI_TASK_WORKSPACE/extensions/task/`, live config untouched, jj commits
  per logical chunk.

## 8. Suggested order

1. Extractions: `worker.ts` (3 exports) → `tools/checklist.ts` state machine →
   `orchestrator.ts` export; typecheck stays green before tests change.
2. Fast tests per file; run `test.ts`; keep <15s.
3. Delete old LLM test files; write `test-e2e.ts`.
4. Run e2e once (real LLM); typecheck; docs; commit.
