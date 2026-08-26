/**
 * Session host — M1.2 / R2,R4.
 *
 * Spawns and drives one pi SDK agent session **in process** (no subprocess,
 * no RPC mode). Where v1 workers are isolated child pi processes driven over
 * an RPC socket, the v2 session host binds a real `AgentSession` (from the
 * installed pi SDK) to a model + cwd and drives prompts to settlement,
 * surfacing a typed event stream and a schema-valid `yield`.
 *
 * Boundary rules:
 *   - Per-role configuration (model, cwd, system prompt, timeout bounds) is
 *     supplied per spawn; the host itself is provider-agnostic.
 *   - Tools are restricted by construction: only the named allowlist is
 *     enabled, plus the engine-side custom tools (yield, checklist) bound in
 *     tools.ts. No extensions/skills/prompts/themes/context files are loaded
 *     (`noExtensions` & co.), so the v1 engine under extensions/ is never even
 *     discovered at runtime and R6 keeps this module free of `extensions/task`
 *     imports.
 *   - Model resolution is explicit and typed: an unresolvable model id is a
 *     construction error (`SessionHostError`, code `bad_model`), never a
 *     silent fallback (R4).
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	resolveCliModel,
} from "@earendil-works/pi-coding-agent";
import type {
	AgentSession,
	AgentSessionEvent,
	SessionStats,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { Yield } from "../contracts/index.ts";
import { makeChecklistTool, makeYieldTool } from "./tools.ts";
import type { ChecklistState } from "./tools.ts";

/** Default per-prompt wall-clock bound (R2 "timeout bounds"). */
export const DEFAULT_WALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Typed error codes for construction and prompt-drive failures. */
export type SessionHostErrorCode =
	"bad_model" | "missing_auth" | "prompt_failed" | "timed_out";

/** Typed error raised for construction and prompt-drive failures. */
export class SessionHostError extends Error {
	constructor(
		public readonly code: SessionHostErrorCode,
		message: string,
		public override readonly cause?: unknown,
	) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SessionHostError";
	}
}

/** Per-role session host configuration. */
export interface SessionHostConfig {
	/** Role name for this session (observability/diagnostics only). */
	role: string;
	/** Model id resolved against the SDK model registry (OpenRouter). */
	modelId: string;
	/** Working directory the session's tool calls operate in. */
	cwd: string;
	/** System prompt the session uses (replaces the pi default). */
	systemPrompt: string;
	/**
	 * Tool allowlist restricting the tools the model may call. Built-in tool
	 * names (read/bash/edit/write) plus the custom tools registered by this
	 * package. Defaults to all built-ins plus yield and checklist.
	 */
	tools?: string[];
	/** Per-prompt wall-clock timeout in ms. Defaults to ten minutes. */
	timeoutMs?: number;
}

/** Default tool allowlist: the four built-ins plus the two custom tools. */
export const DEFAULT_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"edit",
	"write",
	"yield",
	"checklist",
];

/** Settle/turn/tool lifecycle event the host streams to listeners. */
export type SessionHostEvent =
	| { type: "turnStart" }
	| { type: "toolStart"; toolName: string; toolCallId: string }
	| { type: "toolEnd"; toolName: string; toolCallId: string; isError: boolean }
	| { type: "settled" }
	| { type: "yielded"; payload: Yield }
	| { type: "error"; message: string; code: SessionHostErrorCode };

/** Typed listener for the host's event stream. */
export type SessionHostEventListener = (event: SessionHostEvent) => void;

/** A spawned session handle: the typed surface over `AgentSession`. */
export interface SessionHandle {
	/** The role this session was spawned for. */
	readonly role: string;
	/** Fully-qualified resolved model (provider/modelId). */
	readonly model: { provider: string; modelId: string };
	/** Schema-valid yield captured by the yield tool, once invoked. */
	readonly result: Yield | undefined;
	/** Drive a prompt to settlement. Rejects with SessionHostError on failure. */
	prompt(text: string): Promise<void>;
	/** Subscribe to the typed event stream; returns an unsubscriber. */
	subscribe(listener: SessionHostEventListener): () => void;
	/** Abort the current run and wait for the agent to become idle. */
	abort(): Promise<void>;
	/** Cumulative token usage (input/output/cacheRead/cacheWrite) — the
	 *  grounding/cost-policy input surface (FR-9, NFR-3). */
	stats(): Promise<SessionStats>;
	/** Switch the session's model mid-flight (prewalk policy mechanism).
	 *  Resolves the id against the registry; typed error on failure. */
	setModel(modelId: string): Promise<void>;
	/** Tear down the underlying session and free resources. */
	close(): void;
}

/** In-process session host. All state is per `spawn()` call. */
export interface SessionHost {
	/** Resolve modelId and spawn a bound session. Throws SessionHostError. */
	spawn(config: SessionHostConfig): Promise<SessionHandle>;
}

/**
 * Build the deterministic resource loader feeding the session's system
 * prompt: custom prompt plus no extensions/skills/packages/themes/context
 * files, so the host is a hermetic, role-specific island.
 */
export function buildSessionLoader(
	cwd: string,
	systemPrompt: string,
): DefaultResourceLoader {
	const agentDir = getAgentDir();
	return new DefaultResourceLoader({
		cwd,
		agentDir,
		systemPrompt,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
}

/** Concrete SessionHost backed by a shared ModelRuntime. */
export class DefaultSessionHost implements SessionHost {
	readonly #modelRuntime: ModelRuntime | undefined;

	constructor(modelRuntime?: ModelRuntime) {
		this.#modelRuntime = modelRuntime;
	}

	async spawn(config: SessionHostConfig): Promise<SessionHandle> {
		const runtime = this.#modelRuntime ?? (await ModelRuntime.create());

		// R4 — typed, never-silent model resolution.
		const resolved = resolveCliModel({
			cliModel: config.modelId,
			modelRuntime: runtime,
		});
		if (!resolved.model || resolved.error) {
			throw new SessionHostError(
				"bad_model",
				resolved.error ??
					`Model "${config.modelId}" not found in the model registry.`,
			);
		}
		const model = resolved.model;

		if (!runtime.hasConfiguredAuth(model.provider)) {
			throw new SessionHostError(
				"missing_auth",
				`No credentials configured for provider "${model.provider}".`,
			);
		}

		// Session-scoped state for the custom tools.
		const checklistStore: { state: ChecklistState | undefined } = {
			state: undefined,
		};
		const yielder: { payload: Yield | undefined } = { payload: undefined };

		const loader = buildSessionLoader(config.cwd, config.systemPrompt);
		await loader.reload();

		const agentDir = getAgentDir();
		const { session } = await createAgentSession({
			cwd: config.cwd,
			agentDir,
			model,
			modelRuntime: runtime,
			tools: [...(config.tools ?? DEFAULT_TOOLS)],
			customTools: [
				makeYieldTool(config.cwd, {
					onYield: (payload) => {
						yielder.payload = payload;
					},
				}),
				makeChecklistTool(checklistStore),
			],
			sessionManager: SessionManager.inMemory(config.cwd),
			resourceLoader: loader,
		});

		return new LiveSession(
			config,
			session,
			{ provider: model.provider, modelId: model.id },
			yielder,
			config.timeoutMs,
			runtime,
		);
	}
}

/**
 * Create a session host with an optional prebuilt model runtime. When omitted,
 * a runtime is created lazily from the active agent directory on first spawn.
 */
export function createSessionHost(modelRuntime?: ModelRuntime): SessionHost {
	return new DefaultSessionHost(modelRuntime);
}

/** Mutable session instance returned to owners; the observable host. */
class LiveSession implements SessionHandle {
	readonly role: string;
	readonly model: { provider: string; modelId: string };
	#result: Yield | undefined;
	readonly #session: AgentSession;
	#unsubscribe: () => void;
	readonly #listeners = new Set<SessionHostEventListener>();
	readonly #timeoutMs: number;
	readonly #yielder: { payload: Yield | undefined };

	readonly #runtime: ModelRuntime | undefined;

	constructor(
		config: SessionHostConfig,
		session: AgentSession,
		model: { provider: string; modelId: string },
		yielder: { payload: Yield | undefined },
		timeoutMs: number | undefined,
		runtime?: ModelRuntime,
	) {
		this.role = config.role;
		this.model = model;
		this.#session = session;
		this.#timeoutMs = timeoutMs ?? DEFAULT_WALL_TIMEOUT_MS;
		this.#yielder = yielder;
		this.#runtime = runtime;
		this.#unsubscribe = session.subscribe((event) => this.#forward(event));
	}

	stats(): Promise<SessionStats> {
		return Promise.resolve(this.#session.getSessionStats());
	}

	async setModel(modelId: string): Promise<void> {
		const runtime = this.#runtime ?? (await ModelRuntime.create());
		const resolved = resolveCliModel({
			cliModel: modelId,
			modelRuntime: runtime,
		});
		if (!resolved.model || resolved.error) {
			throw new SessionHostError(
				"bad_model",
				resolved.error ?? `Model "${modelId}" not found.`,
			);
		}
		await this.#session.setModel(resolved.model);
	}

	/** Schema-valid yield from the yield tool, once the session yields. */
	get result(): Yield | undefined {
		return this.#result;
	}

	#emit(event: SessionHostEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// A listener must never tear down the running session.
			}
		}
	}

	/** Map SDK agent events to the host's typed event stream. */
	#forward(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_settled":
				// Yield BEFORE settle: downstream guards treat settled-without-
				// yield as a failure signal, so the ordering here is contract.
				if (this.#yielder.payload && !this.#result) {
					this.#result = this.#yielder.payload;
					this.#emit({ type: "yielded", payload: this.#result });
				}
				this.#emit({ type: "settled" });
				break;
			case "turn_start":
				this.#emit({ type: "turnStart" });
				break;
			case "tool_execution_start":
				this.#emit({
					type: "toolStart",
					toolName: event.toolName,
					toolCallId: event.toolCallId,
				});
				break;
			case "tool_execution_end":
				this.#emit({
					type: "toolEnd",
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					isError: event.isError,
				});
				break;
			case "agent_start":
			case "agent_end":
			case "turn_end":
			case "message_start":
			case "message_update":
			case "message_end":
			case "tool_execution_update":
			case "queue_update":
			case "compaction_start":
			case "entry_appended":
			case "session_info_changed":
			case "thinking_level_changed":
			case "compaction_end":
			case "auto_retry_start":
			case "auto_retry_end":
			case "summarization_retry_scheduled":
			case "summarization_retry_attempt_start":
			case "summarization_retry_finished":
			case "bash_execution_update":
				// SDK-internal progress events carry nothing the host's typed
				// stream needs.
				break;
			default:
				break;
		}
	}

	subscribe(listener: SessionHostEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async prompt(text: string): Promise<void> {
		// If a previous run already yielded, surface that result immediately.
		if (this.#yielder.payload && !this.#result) {
			this.#result = this.#yielder.payload;
			this.#emit({ type: "yielded", payload: this.#result });
			return;
		}
		if (this.#result) {
			return;
		}

		const work = this.#session.prompt(text);
		const onAbort = new Promise<never>((_resolve, reject) => {
			const signal = AbortSignal.timeout(this.#timeoutMs);
			signal.addEventListener("abort", () =>
				reject(new Error(`prompt exceeded ${this.#timeoutMs}ms`)),
			);
		});

		let outcome: "ok" | "error" | "timeout" = "ok";
		try {
			await Promise.race([work, onAbort]);
		} catch (err) {
			outcome =
				err instanceof Error && err.message.includes("exceeded")
					? "timeout"
					: "error";
			if (outcome === "timeout") {
				// Release the still-running session so close() is safe.
				await this.#session.abort();
			}
			const message = err instanceof Error ? err.message : String(err);
			this.#emit({
				type: "error",
				message,
				code: outcome === "timeout" ? "timed_out" : "prompt_failed",
			});
			throw new SessionHostError(
				outcome === "timeout" ? "timed_out" : "prompt_failed",
				message,
				err,
			);
		}

		if (this.#yielder.payload && !this.#result) {
			this.#result = this.#yielder.payload;
			this.#emit({ type: "yielded", payload: this.#result });
		}
	}

	async abort(): Promise<void> {
		await this.#session.abort();
	}

	close(): void {
		this.#unsubscribe();
		this.#listeners.clear();
		this.#session.dispose();
	}
}
