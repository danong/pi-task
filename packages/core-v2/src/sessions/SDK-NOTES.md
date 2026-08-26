# SDK-NOTES — pi SDK survey for the session host (M1.2)

This is the investigation record that precedes the v2 session-host implementation
(`host.ts`). It surveys the installed pi SDK
(`node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts`) for one purpose:
driving a real pi agent session **in-process** — no subprocess, no RPC mode. All
quoted symbols are exported from the SDK index and cited by type name.

## Entry point

`createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>`
(the barrel export in `dist/index.d.ts`; the symbol lives in `dist/core/sdk.ts`).
The result is `{ session: AgentSession, extensionsResult, modelFallbackMessage? }`.

Relevant `CreateAgentSessionOptions` fields:

- `cwd?: string` — working directory for project-local discovery. Defaults to
  `process.cwd()`. This is how a session is bound to a specific working directory.
- `agentDir?: string` — the global config directory. Defaults to `getAgentDir()`
  (see Auth / agent-dir below).
- `model?: Model<any>` — the model to bind. Passed resolved, not by id string.
- `modelRuntime?: ModelRuntime` — canonical model/auth runtime. If omitted, the SDK
  builds one from `agentDir/auth.json` + `agentDir/models.json`.
- `thinkingLevel?: ThinkingLevel` — defaults from settings, else `'medium'`.
- `tools?: string[]` — an **allowlist**; when present, only the named tools are
  enabled (this is how tools are restricted). Default: `['read','bash','edit','write']`.
- `excludeTools?: string[]` — denylist applied after `tools`.
- `customTools?: ToolDefinition[]` — engine-side custom tool definitions.
- `resourceLoader?: ResourceLoader` — where the system prompt, skills, context
  files, and prompt templates come from. When omitted the SDK builds a
  `DefaultResourceLoader` and reloads it.
- `sessionManager?: SessionManager` — session persistence. `SessionManager.inMemory(cwd)`
  keeps the session in memory (no session files on disk); the default
  `SessionManager.create(cwd, sessionDir)` writes JSONL session files.
- `settingsManager?: SettingsManager` — defaults to `SettingsManager.create(cwd, agentDir)`.

## Model + cwd binding

Resolve the configured model id first (see Model resolution), then pass the
resolved `Model` plus a `cwd` and, optionally, the `modelRuntime` you built, to
`createAgentSession`. Example shape (see `host.ts` for the real code):

```ts
const runtime = await ModelRuntime.create();
const sessionHandle = await createAgentSession({
  cwd: cfg.cwd,
  model: model,
  modelRuntime: runtime,
  tools: [...],
  customTools: [yieldTool, checklistTool],
  sessionManager: SessionManager.inMemory(cfg.cwd),
  resourceLoader: loader,
});
```

Type names: `CreateAgentSessionOptions`, `CreateAgentSessionResult`,
`AgentSession`, `ModelRuntime`, `SessionManager`, `ToolDefinition`.
`AgentSession` has `dispose()` to tear down the session.

## Driving a prompt to completion

- `AgentSession.prompt(text: string, options?: PromptOptions): Promise<void>` sends a
  user message and runs the agent until it settles. The promise resolves only once
  the turn (plus any post-run continuations) is complete — see `_runAgentPrompt` in
  `dist/core/agent-session.js`, which awaits `agent.prompt()` and then `continue()`
  until the loop settles, then emits `agent_settled`.
- While a run is in progress `AgentSession.isStreaming` is `true`; `isIdle` is the
  complement. `AgentSession.waitForIdle()` awaits settle.
- `AgentSession.abort(): Promise<void>` cancels the current operation and waits for
  the agent to become idle. `AgentSession.executeBash(...)` runs a bash command and
  records it in the transcript.
- Custom tools whose `execute()` returns `AgentToolResult` with `terminate: true`
  request early termination after the current tool batch (used by the `yield` tool
  to end collection).

## Events for turn and tool lifecycle

`AgentSession.subscribe(listener: AgentSessionEventListener): () => void` installs a
listener and returns an unsubscribe function. The event type is the union
`AgentSessionEvent` (`dist/core/agent-session.ts`):

- `agent_start` — a run begins.
- `turn_start` — a model turn begins.
- `turn_end` — a turn ends, carrying the assistant `message` and `toolResults`.
- `message_start` / `message_update` / `message_end` — streaming assistant message
  lifecycle.
- `tool_execution_start` (with `toolCallId`, `toolName`, `args`) and
  `tool_execution_end` (with `toolCallId`, `toolName`, `result`, `isError`) — the
  exact tool start/end signals the host surfaces as `toolStart` / `toolEnd`.
- `agent_end` (with final `messages` and `willRetry`) then `agent_settled` — the
  settlement pair the host uses to emit `settled`.
- Additional session events: `queue_update`, `compaction_*`, `auto_retry_*`,
  `bash_execution_update`, etc.

`AgentSessionEvent` is `Exclude<AgentEvent, {'agent_end'}> | …` where `AgentEvent`
is the pi-agent-core event union (`@earendil-works/pi-agent-core/dist/types.ts`).

## Registering custom tools

Two paths exist; the SDK's `defineTool` is the engine-side one:

- `defineTool<TParams, TDetails, TState>(tool: ToolDefinition<TParams, TDetails, TState>)`
  from `dist/core/extensions/index.ts`. A `ToolDefinition` has `name`, `label`,
  `description`, `parameters` (a TypeBox `TSchema`), optional `promptSnippet` /
  `promptGuidelines`, and `execute(toolCallId, params, signal, onUpdate, ctx):
Promise<AgentToolResult<TDetails>>`. Pass the resulting definitions as
  `customTools` on `CreateAgentSessionOptions`.
- The v1 extension path `pi.registerTool(...)` routes through the extension runner
  and is only available inside a spawned extension host; the v2 host uses
  `customTools` because it does not run extensions.

`AgentToolResult<D>` (`@earendil-works/pi-agent-core/dist/types.ts`) has `content`
(returned to the model), `details`, `usage?`, and `terminate?: boolean` — the
flag that stops the agent after the current tool batch.

For tool parameters, v2 reuses the TypeBox schema mirrored from the canonical
`YieldSchema` (`packages/core-v2/src/contracts/payloads.ts`) and re-validates the
incoming `params` with that zod contract in the `execute` body, so the engine-side
`yield` tool and the worker-side v1 `yield` extension enforce the same contract.

## Model resolution

The SDK exposes `ModelRegistry` (a sync facade over `ModelRuntime`:
`find(providerId, modelId)`, `getAll()`, `getAvailable()`, `hasConfiguredAuth`,
`getError()`) and `resolveCliModel({ cliProvider?, cliModel?, cliThinking?,
modelRuntime })` from `dist/core/model-resolver.ts`.

`resolveCliModel` handles both bare ids and `provider/id` refs (including ids with
embedded slashes like `stealth/ox-alpha`), reports `{ model, thinkingLevel, warning,
error }`, and on a bad id returns `model: undefined` with a non-empty `error` —
never a silent fallback. That error is the typed construction error the host
surfaces (drop a `SessionHostError` with `code: 'bad_model'`).

## Auth and agent-dir resolution in-process

- `getAgentDir()` (`dist/config.ts`) returns the global agent config directory. It
  honors `ENV_AGENT_DIR = ${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`, otherwise the
  default `~/.pi/agent`. `ENV_AGENT_DIR` for this package is `PI_CODING_AGENT_DIR`.
- Model/auth runtime is created from `agentDir/auth.json` (credential store, e.g.
  OpenRouter API key) and `agentDir/models.json` (+ `agentDir/models-store.json`),
  via `ModelRuntime.create({ authPath, modelsPath })`. `ModelRuntime` in-file uses
  the `Models` interface; `ModelRuntime.getAuth`, `ModelRuntime.hasConfiguredAuth`,
  `ModelRegistry.getApiKeyAndHeaders` expose auth checks.
- `readStoredCredential(providerId, authPath?)` (`dist/core/auth-storage.ts`) reads a
  saved credential directly — used by the smoke test to decide whether to skip.
