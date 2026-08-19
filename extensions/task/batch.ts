/**
 * Batch inference lane (M2) — provider-agnostic submit → poll → collect.
 *
 * The batch CHANNEL (TaskShape.channel === "batch", declared on shapes in
 * M1) runs a task as an ASYNC batch job instead of an interactive worker:
 * batch is single-turn, no tool loop. The lane turns the spec's typed
 * requirements into one prompt item per requirement, each carrying an
 * OUTPUT CONTRACT (the typed shape the item's output must satisfy when
 * collected). The orchestrator routes to this lane (orchestrator.ts
 * routeRun/executeBatchLane), applies the validated file outputs to the
 * working copy, commits them, and runs the spec's verification gate.
 *
 * Provider interface: {@link BatchProvider} with three operations —
 * submit(job), status(jobId), results(jobId). Two implementations:
 * {@link FakeBatchProvider} (in-memory, hermetic tests) and
 * {@link OpenRouterBatchProvider} (real backend, google/gemini-3.7-flash:batch
 * per config/task.toml [batch]).
 *
 * Job state (R4): every lane run records a job-state file
 * `<metricsDir>/<project>/<run_id>.batch.json` — job id, the submitted
 * prompts, and per-item status. Failures are TYPED (BatchError with a
 * machine-readable code) and RECOVERABLE: an aborted/timed-out run leaves
 * the job id in the state file so polling can resume; an items_incomplete
 * run records exactly which items failed so only those can be resubmitted.
 *
 * The pure parts (contracts, prompt/item builders, validators, file
 * extraction) are hermetically tested in test-batch.ts; the OpenRouter
 * wire protocol below is pinned and hermetically mocked (injectable
 * fetchImpl) — the real call only happens in the guarded live test
 * (test-batch-live.ts, network + cost, never part of test.ts).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateRunId } from "./metrics.ts";
import { DEFAULT_BATCH_POLL_INTERVAL_MS, DEFAULT_BATCH_JOB_TIMEOUT_MS } from "./config.ts";
import type { Spec } from "./schemas/spec.ts";

// ─── Typed errors ────────────────────────────────────────────────────

export const BATCH_ERROR_CODES = [
	"no_api_key",
	"http_error",
	"submit_failed",
	"job_failed",
	"poll_timeout",
	"aborted",
	"items_incomplete",
	"invalid_output",
] as const;
export type BatchErrorCode = (typeof BATCH_ERROR_CODES)[number];

export interface BatchErrorDetail {
	/** The provider-side job id (present when the failure happened after
	 *  submission — the recovery handle for aborted/timed-out jobs). */
	jobId?: string;
	/** Per-item failure records (items_incomplete): exactly which items
	 *  failed and why — the resubmission subset. */
	items?: BatchItemRecord[];
}

/** Typed batch-lane failure. `code` is machine-readable; the message
 *  names the job id + what to do (resume/resubmit) where applicable. */
export class BatchError extends Error {
	readonly code: BatchErrorCode;
	readonly detail?: BatchErrorDetail;
	constructor(code: BatchErrorCode, message: string, detail?: BatchErrorDetail) {
		super(message);
		this.name = "BatchError";
		this.code = code;
		this.detail = detail;
	}
}

// ─── Output contracts ────────────────────────────────────────────────

/** The typed shape an item's output must satisfy when collected (R1/R4).
 *  "text" — any non-empty text; "json" — parseable JSON of any shape;
 *  "json_object" — a JSON object (not array) with the required keys. */
export type BatchOutputContract =
	| { kind: "text" }
	| { kind: "json" }
	| { kind: "json_object"; requiredKeys?: string[] };

/** One batch item: a well-formed single-turn prompt + its output contract. */
export interface BatchPromptItem {
	/** Stable id tying the output back to its prompt (requirement id, e.g.
	 *  "R1" — the results payload keys on it). */
	customId: string;
	/** The single-turn prompt text. */
	prompt: string;
	/** The item's output contract — validated at collection time. */
	contract: BatchOutputContract;
}

/** Strip a single markdown code fence around a model output (models love
 *  wrapping JSON in ```json fences; the fence is not part of the output). */
export function stripCodeFences(text: string): string {
	const m = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
	return m ? m[1].trim() : text.trim();
}

/**
 * Validate a raw model output against its contract. Pure — hermetically
 * tested. Returns the parsed value on success; on failure a precise
 * human-readable error (the item record stores it; the run fails typed
 * with items_incomplete so only the bad items can be resubmitted).
 */
export function validateBatchOutput(
	contract: BatchOutputContract,
	rawText: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
	const text = stripCodeFences(rawText);
	switch (contract.kind) {
		case "text":
			return text.length > 0 ? { ok: true, value: text } : { ok: false, error: "empty text output" };
		case "json":
			try {
				return { ok: true, value: JSON.parse(text) };
			} catch (err) {
				return { ok: false, error: `malformed JSON: ${(err as Error).message}` };
			}
		case "json_object": {
			let value: unknown;
			try {
				value = JSON.parse(text);
			} catch (err) {
				return { ok: false, error: `malformed JSON object: ${(err as Error).message}` };
			}
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				return {
					ok: false,
					error: `expected a JSON object, got ${Array.isArray(value) ? "an array" : `${typeof value} (${String(value).slice(0, 40)})`}`,
				};
			}
			const missing = (contract.requiredKeys ?? []).filter(
				(k) => !(k in (value as Record<string, unknown>)),
			);
			if (missing.length > 0) {
				return { ok: false, error: `missing required key(s): ${missing.join(", ")}` };
			}
			return { ok: true, value };
		}
	}
}

// ─── Item building (spec → typed prompts) ───────────────────────────

/** The output contract for a coding requirement item: a JSON object whose
 *  files array the orchestrator applies to the working copy. */
export const BATCH_FILE_CONTRACT: BatchOutputContract = {
	kind: "json_object",
	requiredKeys: ["requirement", "files", "summary"],
};

/** A file to write: repo-relative path + full content. */
export interface BatchFile {
	path: string;
	content: string;
}

/** Requirement id → customId: "R1: ..." → "R1" (the results payload keys
 *  on it); anything else → "req-<index>". Pure — tested. */
export function requirementId(requirement: string, index: number): string {
	const m = /^(R\d+)\s*[:.]/.exec(requirement.trim());
	return m ? m[1] : `req-${index + 1}`;
}

/** The single-turn prompt for one requirement — self-contained (goal +
 *  requirement + the typed output contract), no tools, no conversation. */
export function buildBatchPrompt(goal: string, requirement: string): string {
	return [
		"You are one item of a batch coding job. Implement EXACTLY ONE requirement as typed JSON.",
		"You have no tools — this is a single-turn response: think, then produce the output contract.",
		"",
		`## Goal`,
		goal,
		"",
		`## Requirement`,
		requirement,
		"",
		"## Output contract",
		'Respond with ONLY a single JSON object (no markdown fences, no commentary) with exactly these keys:',
		'- "requirement": the requirement text you implemented',
		'- "files": an array of objects, each { "path": "<repo-relative path>", "content": "<full file content>" } —',
		'  one entry per file the requirement needs; write WHOLE files, never partial edits',
		'- "summary": a one-line summary of what you produced',
	].join("\n");
}

/** Build the lane's items from a parsed spec: one item per requirement,
 *  customId = the requirement's R-id, contract = the coding files
 *  contract. Pure — hermetically tested. */
export function buildBatchItems(spec: Spec): BatchPromptItem[] {
	return spec.requirements.map((req, i) => ({
		customId: requirementId(req, i),
		prompt: buildBatchPrompt(spec.goal, req),
		contract: BATCH_FILE_CONTRACT,
	}));
}

// ─── File outputs (validated coding outputs) ─────────────────────────

/**
 * Extract the files array from a validated coding item's output. Path
 * safety is enforced mechanically: repo-relative only (no absolute paths,
 * no Windows drive prefixes, no backslashes, no ".."/"."/empty segments).
 * Throws typed BatchError("invalid_output") naming the item + the exact
 * problem — the model's output is untrusted input. Pure — tested.
 */
export function extractBatchFiles(value: unknown, customId: string): BatchFile[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new BatchError("invalid_output", `item ${customId}: output is not a JSON object`);
	}
	const files = (value as Record<string, unknown>).files;
	if (!Array.isArray(files)) {
		throw new BatchError("invalid_output", `item ${customId}: "files" is not an array`);
	}
	const out: BatchFile[] = [];
	for (let i = 0; i < files.length; i++) {
		const f = files[i];
		if (typeof f !== "object" || f === null || Array.isArray(f)) {
			throw new BatchError("invalid_output", `item ${customId}: files[${i}] is not an object`);
		}
		const rawPath = (f as Record<string, unknown>).path;
		const content = (f as Record<string, unknown>).content;
		if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
			throw new BatchError("invalid_output", `item ${customId}: files[${i}].path must be a non-empty string`);
		}
		if (typeof content !== "string") {
			throw new BatchError("invalid_output", `item ${customId}: files[${i}].content must be a string`);
		}
		const path = rawPath.trim();
		if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.includes("\\")) {
			throw new BatchError("invalid_output", `item ${customId}: files[${i}].path "${path}" is not repo-relative`);
		}
		const parts = path.split("/");
		if (parts.some((part) => part === ".." || part === "." || part.length === 0)) {
			throw new BatchError(
				"invalid_output",
				`item ${customId}: files[${i}].path "${path}" escapes the repo (no "..", ".", or empty segments)`,
			);
		}
		out.push({ path, content });
	}
	return out;
}

/** Union of per-item file lists. Two items writing the SAME path must
 *  agree on the content — a conflicting pair is a typed invalid_output
 *  error (deterministic: never silent last-wins). Pure — tested. */
export function mergeBatchFiles(items: Array<{ customId: string; files: BatchFile[] }>): BatchFile[] {
	const byPath = new Map<string, { file: BatchFile; customId: string }>();
	for (const item of items) {
		for (const file of item.files) {
			const existing = byPath.get(file.path);
			if (existing !== undefined && existing.file.content !== file.content) {
				throw new BatchError(
					"invalid_output",
					`items ${existing.customId} and ${item.customId} produced conflicting content for "${file.path}"`,
				);
			}
			byPath.set(file.path, { file, customId: item.customId });
		}
	}
	return [...byPath.values()].map((e) => e.file);
}

// ─── Job state (R4) ─────────────────────────────────────────────────

export type BatchItemStatus = "pending" | "completed" | "invalid" | "failed" | "missing";
export type BatchJobStateStatus = "submitting" | "in_progress" | "completed" | "failed" | "aborted";

/** One item's recorded lifecycle: pending → completed | invalid | failed
 *  | missing. invalid keeps the raw output for inspection; failed carries
 *  the provider error; missing = absent from the results payload. */
export interface BatchItemRecord {
	custom_id: string;
	status: BatchItemStatus;
	/** Raw model output text (completed/invalid). */
	output?: string;
	/** Precise failure reason (invalid/failed/missing). */
	error?: string;
}

/**
 * The persisted batch job state — written to
 * `<metricsDir>/<project>/<run_id>.batch.json` at every transition
 * (submitted → polled → collected), so an aborted/timed-out run leaves a
 * typed, recoverable record: the job id to resume polling + the exact
 * per-item failures to resubmit.
 */
export interface BatchJobState {
	kind: "batch-job";
	schema: 1;
	run_id: string;
	/** Provider-side job id — set once submission lands; absent when the
	 *  submit itself failed. */
	job_id?: string;
	model: string;
	provider: string;
	status: BatchJobStateStatus;
	submitted_at: string;
	updated_at: string;
	/** The submitted prompts (custom id + text + contract). */
	prompts: Array<{ custom_id: string; prompt: string; contract: BatchOutputContract }>;
	/** Per-item status, in build order. */
	items: BatchItemRecord[];
	/** Aggregate provider usage (collected items only). */
	usage?: { prompt_tokens: number; completion_tokens: number; cost_usd: number };
}

/** The job-state file path for a run. */
export function batchJobStatePath(metricsDir: string, project: string, runId: string): string {
	return join(metricsDir, project, `${runId}.batch.json`);
}

/** Write the job state atomically (tmp + rename, mirroring writeManifest).
 *  Returns the written path. */
export function writeBatchJobState(
	state: BatchJobState,
	opts: { metricsDir: string; project: string },
): string {
	const target = batchJobStatePath(opts.metricsDir, opts.project, state.run_id);
	mkdirSync(dirname(target), { recursive: true });
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
	renameSync(tmp, target);
	return target;
}

/** Read a run's job state; null when missing/unreadable. */
export function readBatchJobState(metricsDir: string, project: string, runId: string): BatchJobState | null {
	try {
		const parsed = JSON.parse(
			readFileSync(batchJobStatePath(metricsDir, project, runId), "utf-8"),
		) as BatchJobState;
		return parsed.kind === "batch-job" ? parsed : null;
	} catch {
		return null;
	}
}

/** The recoverable subset: items that did not complete (the resubmission
 *  set). Empty → the job is green. Pure — tested. */
export function incompleteItems(state: BatchJobState): BatchItemRecord[] {
	return state.items.filter((i) => i.status !== "completed");
}

// ─── Provider interface ─────────────────────────────────────────────

/** Batch job phases on the wire (provider-normalized). */
export const BATCH_JOB_PHASES = [
	"validating",
	"in_progress",
	"completed",
	"failed",
	"expired",
	"cancelled",
] as const;
export type BatchJobPhase = (typeof BATCH_JOB_PHASES)[number];

export interface BatchJobCounts {
	total: number;
	completed: number;
	failed: number;
}

/** One raw result item as the provider returns it (pre-validation). */
export interface BatchRawItem {
	customId: string;
	/** true when the provider produced an output (2xx, no provider error). */
	ok: boolean;
	/** The raw model output text (present when ok). */
	text?: string;
	statusCode?: number;
	error?: string;
	promptTokens?: number;
	completionTokens?: number;
	costUsd?: number;
}

/** A batch backend: submit a job, poll its status, collect its results.
 *  Providers are injected into the lane (runBatchLane) — the lane itself
 *  never touches the network. */
export interface BatchProvider {
	readonly name: string;
	/** Submit a job of single-turn prompts. Resolves with the provider-side
	 *  job id + its initial phase. */
	submit(model: string, items: BatchPromptItem[]): Promise<{ jobId: string; phase: BatchJobPhase }>;
	/** Poll the job's phase + request counts. */
	status(jobId: string): Promise<{ phase: BatchJobPhase; counts: BatchJobCounts }>;
	/** Retrieve the job's raw results (one entry per completed item). */
	results(jobId: string): Promise<BatchRawItem[]>;
}

// ─── Fake provider (hermetic tests) ─────────────────────────────────

export interface FakeBatchProviderOptions {
	/** Number of in_progress polls before the job completes (default 2). */
	completeAfterPolls?: number;
	/** Scripted terminal phase instead of "completed" ("failed" |
	 *  "expired" | "cancelled"). */
	terminalPhase?: Exclude<BatchJobPhase, "validating" | "in_progress" | "completed">;
	/** Scripted item outputs by customId (default: a valid files JSON
	 *  naming `<customId>.txt`). */
	outputs?: Record<string, string>;
	/** Scripted provider-level item failures by customId. */
	itemErrors?: Record<string, string>;
	/** customIds absent from the results payload (missing-item path). */
	missing?: string[];
	/** Scripted submit failure (submit_failed path). */
	submitError?: string;
}

/** In-memory batch backend for hermetic tests: submit records the job,
 *  status advances in_progress → completed over a scripted number of
 *  polls, results returns the scripted outputs. Zero network. */
export class FakeBatchProvider implements BatchProvider {
	readonly name = "fake";
	/** Last submitted job id ("fake-batch-<submitCalls>"). */
	jobId: string | null = null;
	submitCalls = 0;
	pollCalls = 0;
	private lastItems: BatchPromptItem[] = [];

	constructor(private readonly opts: FakeBatchProviderOptions = {}) {}

	async submit(model: string, items: BatchPromptItem[]): Promise<{ jobId: string; phase: BatchJobPhase }> {
		if (this.opts.submitError !== undefined) {
			throw new BatchError("submit_failed", this.opts.submitError);
		}
		this.submitCalls++;
		this.jobId = `fake-batch-${this.submitCalls}`;
		this.lastItems = items;
		return { jobId: this.jobId, phase: "validating" };
	}

	async status(jobId: string): Promise<{ phase: BatchJobPhase; counts: BatchJobCounts }> {
		this.pollCalls++;
		const done = this.pollCalls >= (this.opts.completeAfterPolls ?? 2);
		const phase: BatchJobPhase = !done
			? "in_progress"
			: (this.opts.terminalPhase ?? "completed");
		return {
			phase,
			counts: {
				total: this.lastItems.length,
				completed: phase === "completed" ? this.lastItems.length : 0,
				failed: 0,
			},
		};
	}

	async results(jobId: string): Promise<BatchRawItem[]> {
		const out: BatchRawItem[] = [];
		for (const item of this.lastItems) {
			const id = item.customId;
			if (this.opts.missing?.includes(id)) continue;
			if (this.opts.itemErrors?.[id] !== undefined) {
				out.push({ customId: id, ok: false, statusCode: 500, error: this.opts.itemErrors[id] });
				continue;
			}
			const text = this.opts.outputs?.[id] ?? this.defaultOutput(id);
			out.push({
				customId: id,
				ok: true,
				text,
				statusCode: 200,
				promptTokens: 10,
				completionTokens: 5,
				costUsd: 0.0001,
			});
		}
		return out;
	}

	/** Default scripted output: a contract-valid files JSON for `id`. */
	private defaultOutput(id: string): string {
		return JSON.stringify({
			requirement: id,
			files: [{ path: `${id}.txt`, content: `content for ${id}` }],
			summary: `created ${id}.txt`,
		});
	}
}

// ─── OpenRouter provider (real backend) ─────────────────────────────

/** OpenRouter API base URL (the batch endpoints hang off /api/v1). */
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterBatchProviderOptions {
	/** API key. Default: process.env.OPENROUTER_API_KEY. */
	apiKey?: string;
	/** API base URL override (tests). Default: DEFAULT_OPENROUTER_BASE_URL. */
	baseUrl?: string;
	/** fetch implementation override (hermetic wire tests). */
	fetchImpl?: typeof fetch;
}

/**
 * Real OpenRouter batch backend. The wire protocol (pinned here, mocked
 * hermetically via fetchImpl; the real call happens only in the guarded
 * test-batch-live.ts):
 *
 *   Submit   POST {base}/chat/batches
 *            Authorization: Bearer <apiKey>
 *            body: { "model": "<:batch model id>",
 *                    "items": [ { "custom_id": "<id>",
 *                                 "body": { "messages": [
 *                                     { "role": "user", "content": "<prompt>" } ] } } ] }
 *            → 200 { "id": "<job id>", "status": "validating" | ... }
 *
 *   Status   GET {base}/chat/batches/{id}
 *            → 200 { "id": ..., "status": "validating" | "in_progress" |
 *                    "completed" | "failed" | "expired" | "cancelled",
 *                    "request_counts": { "total", "completed", "failed" } }
 *
 *   Results  GET {base}/chat/batches/{id}/results
 *            → JSONL; one object per item:
 *              { "id": ..., "custom_id": "<id>",
 *                "response": { "status_code": 200,
 *                              "body": { "choices": [ { "message":
 *                                          { "content": "<output>" } } ],
 *                                         "usage": { "prompt_tokens", "completion_tokens" },
 *                                         "cost": <usd> } } }
 *
 * Unknown statuses map to "in_progress" (forward compatible); unparseable
 * JSONL lines are skipped (their items surface downstream as "missing",
 * typed + recoverable). Every HTTP/network failure is a typed
 * BatchError("http_error") naming the endpoint.
 */
export class OpenRouterBatchProvider implements BatchProvider {
	readonly name = "openrouter";
	private readonly apiKey: string | undefined;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;

	constructor(opts: OpenRouterBatchProviderOptions = {}) {
		this.apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
		this.baseUrl = (opts.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, "");
		this.fetchImpl = opts.fetchImpl ?? fetch;
	}

	private async request(
		path: string,
		init: { method: string; headers: Record<string, string>; body?: string },
	): Promise<Response> {
		let res: Response;
		try {
			res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
		} catch (err) {
			throw new BatchError(
				"http_error",
				`OpenRouter ${init.method} ${path} failed: ${(err as Error).message}`,
			);
		}
		if (!res.ok) {
			const excerpt = (await res.text().catch(() => "")).slice(0, 200);
			throw new BatchError(
				"http_error",
				`OpenRouter ${init.method} ${path} returned ${res.status}: ${excerpt}`,
			);
		}
		return res;
	}

	private async json(res: Response): Promise<Record<string, unknown>> {
		try {
			const data = (await res.json()) as Record<string, unknown>;
			return data ?? {};
		} catch {
			throw new BatchError("http_error", "OpenRouter returned a non-JSON response");
		}
	}

	async submit(model: string, items: BatchPromptItem[]): Promise<{ jobId: string; phase: BatchJobPhase }> {
		if (!this.apiKey) {
			throw new BatchError(
				"no_api_key",
				"OPENROUTER_API_KEY is not set — batch runs need it (see config/task.toml [batch])",
			);
		}
		const res = await this.request("/chat/batches", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
			body: JSON.stringify({
				model,
				items: items.map((it) => ({
					custom_id: it.customId,
					body: { messages: [{ role: "user", content: it.prompt }] },
				})),
			}),
		});
		const data = await this.json(res);
		if (typeof data.id !== "string" || data.id.length === 0) {
			throw new BatchError(
				"submit_failed",
				`OpenRouter batch submit response missing "id": ${JSON.stringify(data).slice(0, 200)}`,
			);
		}
		return { jobId: data.id, phase: mapPhase(data.status) };
	}

	async status(jobId: string): Promise<{ phase: BatchJobPhase; counts: BatchJobCounts }> {
		if (!this.apiKey) {
			throw new BatchError(
				"no_api_key",
				"OPENROUTER_API_KEY is not set — batch runs need it (see config/task.toml [batch])",
			);
		}
		const res = await this.request(`/chat/batches/${encodeURIComponent(jobId)}`, {
			method: "GET",
			headers: { Authorization: `Bearer ${this.apiKey}` },
		});
		const data = await this.json(res);
		const counts = (data.request_counts ?? {}) as Record<string, unknown>;
		return {
			phase: mapPhase(data.status),
			counts: {
				total: typeof counts.total === "number" ? counts.total : 0,
				completed: typeof counts.completed === "number" ? counts.completed : 0,
				failed: typeof counts.failed === "number" ? counts.failed : 0,
			},
		};
	}

	async results(jobId: string): Promise<BatchRawItem[]> {
		if (!this.apiKey) {
			throw new BatchError(
				"no_api_key",
				"OPENROUTER_API_KEY is not set — batch runs need it (see config/task.toml [batch])",
			);
		}
		const res = await this.request(`/chat/batches/${encodeURIComponent(jobId)}/results`, {
			method: "GET",
			headers: { Authorization: `Bearer ${this.apiKey}` },
		});
		const text = await res.text().catch(() => "");
		const out: BatchRawItem[] = [];
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			let rec: Record<string, unknown>;
			try {
				rec = JSON.parse(trimmed) as Record<string, unknown>;
			} catch {
				continue; // unparseable line — its item surfaces as "missing"
			}
			const response = (rec.response ?? {}) as Record<string, unknown>;
			const statusCode = typeof response.status_code === "number" ? response.status_code : 200;
			const body = (response.body ?? {}) as Record<string, unknown>;
			const choices = Array.isArray(body.choices) ? body.choices : [];
			const message = (choices[0] as Record<string, unknown> | undefined)?.message as
				| Record<string, unknown>
				| undefined;
			const content = typeof message?.content === "string" ? message.content : undefined;
			const usage = (body.usage ?? {}) as Record<string, unknown>;
			const error = response.error;
			out.push({
				customId: typeof rec.custom_id === "string" ? rec.custom_id : String(rec.id ?? ""),
				ok: statusCode >= 200 && statusCode < 300 && error === undefined,
				text: content,
				statusCode,
				error: error !== undefined ? String(error) : undefined,
				promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
				completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
				costUsd: typeof body.cost === "number" ? body.cost : undefined,
			});
		}
		return out;
	}
}

/** Normalize a provider status string; unknown → "in_progress" (forward
 *  compatible — the lane only branches on the terminal phases). */
function mapPhase(raw: unknown): BatchJobPhase {
	return typeof raw === "string" && (BATCH_JOB_PHASES as readonly string[]).includes(raw)
		? (raw as BatchJobPhase)
		: "in_progress";
}

// ─── The lane runner ────────────────────────────────────────────────

export type BatchLaneUpdate =
	| { type: "batch_submitted"; jobId: string }
	| { type: "batch_status"; phase: BatchJobPhase; counts: BatchJobCounts }
	| { type: "batch_collected"; completed: number; total: number };

export interface BatchLaneOptions {
	/** Parsed spec — the lane's item source (one item per requirement). */
	spec: Spec;
	/** Batch model id (config [batch].model). */
	model: string;
	/** The batch backend. Fake in hermetic tests; OpenRouter in production. */
	provider: BatchProvider;
	/** Poll interval (ms). Default: DEFAULT_BATCH_POLL_INTERVAL_MS (30s). */
	pollIntervalMs?: number;
	/** Wall budget for polling to a terminal phase (ms). Default:
	 *  DEFAULT_BATCH_JOB_TIMEOUT_MS (24h — the lane's advertised
	 *  turnaround; the job keeps running provider-side on timeout, and the
	 *  job-state file records the job id to resume). */
	jobTimeoutMs?: number;
	/** Metrics dir for the job-state file (R4). Omitted → state is
	 *  in-memory only (no persistence). */
	metricsDir?: string;
	/** Project name for the job-state path. Default: "batch". */
	project?: string;
	/** Run id (default: generated). The job-state file is keyed on it. */
	runId?: string;
	/** Recovery (review P2): resume polling/collection of an ALREADY
	 *  submitted provider job instead of submitting a new one — avoids the
	 *  double-spend a full re-run would incur. The job must have been
	 *  created from the same spec. */
	existingJobId?: string;
	/** Recovery: submit a NEW job carrying only the given failed customIds
	 *  (from an items_incomplete state) rather than re-submitting every
	 *  item. Ignored when existingJobId is set. */
	resubmitCustomIds?: string[];
	/** Abort signal — an abort mid-flight records the job state as
	 *  "aborted" (typed + recoverable) and throws BatchError("aborted"). */
	signal?: AbortSignal;
	/** Lane progress events (the orchestrator relays them to the task
	 *  tool's progress view; unknown event types are ignored there). */
	onUpdate?: (event: BatchLaneUpdate) => void;
	/** Injectable sleep — hermetic tests skip real poll delays. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Injectable clock (deterministic deadline tests). */
	now?: () => number;
}

export interface BatchLaneResult {
	runId: string;
	jobId: string;
	/** Per-item records in build order — every status "completed" on a
	 *  green lane; the failed subset on items_incomplete. */
	items: BatchItemRecord[];
	/** Contract-validated parsed outputs keyed by customId (completed
	 *  items only). */
	outputs: Record<string, unknown>;
	usage: { prompt_tokens: number; completion_tokens: number; cost_usd: number };
	durationMs: number;
}

/** Abort-aware sleep: resolves immediately on abort (the lane loop then
 *  observes signal.aborted and records the typed aborted state). */
export async function sleepDefault(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Run one batch lane: submit the spec's typed prompts as a job, poll to a
 * terminal phase, collect the raw results, and validate each item against
 * its output contract. Job state is persisted at every transition (R4).
 *
 * Failures are typed + recoverable:
 * - submit_failed — nothing submitted; nothing to recover.
 * - job_failed — the provider's job reached failed/expired/cancelled.
 * - poll_timeout — the job is STILL RUNNING provider-side; the job-state
 *   file records the job id so polling can resume.
 * - aborted — the caller aborted mid-flight; same recovery (job id in the
 *   state file).
 * - items_incomplete — the job completed but n items failed validation;
 *   BatchError.detail.items names exactly which (the resubmission set).
 */
export async function runBatchLane(opts: BatchLaneOptions): Promise<BatchLaneResult> {
	const runId = opts.runId ?? generateRunId();
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_BATCH_POLL_INTERVAL_MS;
	const jobTimeoutMs = opts.jobTimeoutMs ?? DEFAULT_BATCH_JOB_TIMEOUT_MS;
	const now = opts.now ?? Date.now;
	const startedMs = now();
	const project = opts.project ?? "batch";
	const allItems = buildBatchItems(opts.spec);
	// Recovery: resubmit only the failed customIds (no re-send of the batch).
	const items =
		opts.resubmitCustomIds && !opts.existingJobId
			? allItems.filter((i) => opts.resubmitCustomIds!.includes(i.customId))
			: allItems;

	const persist = (state: BatchJobState): void => {
		if (!opts.metricsDir) return;
		writeBatchJobState(state, { metricsDir: opts.metricsDir, project });
	};
	const stamp = (): string => new Date().toISOString();
	const makeState = (status: BatchJobStateStatus, extra: Partial<BatchJobState> = {}): BatchJobState => ({
		kind: "batch-job",
		schema: 1,
		run_id: runId,
		model: opts.model,
		provider: opts.provider.name,
		status,
		submitted_at: stamp(),
		updated_at: stamp(),
		prompts: items.map((i) => ({ custom_id: i.customId, prompt: i.prompt, contract: i.contract })),
		items: items.map((i) => ({ custom_id: i.customId, status: "pending" as const })),
		...extra,
	});

	let state = makeState("submitting");
	persist(state);

	// 1. Submit — or resume an existing provider job (recovery: no re-submit,
	// so no double-spend for the same work; the caller re-drives the same
	// spec through the same jobId via resumeBatchJob).
	let jobId: string;
	if (opts.existingJobId) {
		jobId = opts.existingJobId;
	} else {
		try {
			const submitted = await opts.provider.submit(opts.model, items);
			jobId = submitted.jobId;
		} catch (err) {
			persist({ ...state, status: "failed", updated_at: stamp() });
			throw err instanceof BatchError
				? err
				: new BatchError("submit_failed", `batch submit failed: ${(err as Error).message}`);
		}
	}
	state = { ...state, job_id: jobId, status: "in_progress", updated_at: stamp() };
	persist(state);
	opts.onUpdate?.({ type: "batch_submitted", jobId });

	// 2. Poll to a terminal phase.
	let phase: BatchJobPhase = "in_progress";
	let counts: BatchJobCounts = { total: items.length, completed: 0, failed: 0 };
	for (;;) {
		if (opts.signal?.aborted) {
			persist({ ...state, status: "aborted", updated_at: stamp() });
			throw new BatchError(
				"aborted",
				`batch job ${jobId} aborted mid-flight — resume by polling ${jobId} ` +
					`(recorded in ${opts.metricsDir ? batchJobStatePath(opts.metricsDir, project, runId) : "the run's job state"})`,
			);
		}
		if (now() - startedMs > jobTimeoutMs) {
			// The job is still live provider-side — do NOT mark it failed;
			// the state file records the job id so polling can resume.
			persist({ ...state, updated_at: stamp() });
			throw new BatchError(
				"poll_timeout",
				`batch job ${jobId} did not finish within ${jobTimeoutMs}ms — it keeps running ` +
					`provider-side; poll it later (job id recorded in the job-state file)`,
			);
		}
		try {
			const s = await opts.provider.status(jobId);
			phase = s.phase;
			counts = s.counts;
		} catch (err) {
			persist({ ...state, updated_at: stamp() });
			throw err instanceof BatchError
				? err
				: new BatchError("http_error", `batch status poll failed: ${(err as Error).message}`);
		}
		persist({ ...state, updated_at: stamp() });
		opts.onUpdate?.({ type: "batch_status", phase, counts });
		if (phase === "completed") break;
		if (phase === "failed" || phase === "expired" || phase === "cancelled") {
			persist({ ...state, status: "failed", updated_at: stamp() });
			throw new BatchError("job_failed", `batch job ${jobId} reached terminal phase "${phase}"`);
		}
		await (opts.sleep ?? sleepDefault)(pollIntervalMs, opts.signal);
	}

	// 3. Collect + validate against the contracts.
	let raw: BatchRawItem[];
	try {
		raw = await opts.provider.results(jobId);
	} catch (err) {
		persist({ ...state, updated_at: stamp() });
		throw err instanceof BatchError
			? err
			: new BatchError("http_error", `batch results retrieval failed: ${(err as Error).message}`);
	}
	const byId = new Map(raw.map((r) => [r.customId, r]));
	const records: BatchItemRecord[] = [];
	const outputs: Record<string, unknown> = {};
	let promptTokens = 0;
	let completionTokens = 0;
	let costUsd = 0;
	for (const item of items) {
		const rec = byId.get(item.customId);
		if (rec === undefined) {
			records.push({ custom_id: item.customId, status: "missing", error: "absent from the batch results payload" });
			continue;
		}
		promptTokens += rec.promptTokens ?? 0;
		completionTokens += rec.completionTokens ?? 0;
		costUsd += rec.costUsd ?? 0;
		if (!rec.ok) {
			records.push({
				custom_id: item.customId,
				status: "failed",
				error: rec.error ?? `provider status ${rec.statusCode ?? "?"}`,
			});
			continue;
		}
		const validated = validateBatchOutput(item.contract, rec.text ?? "");
		if (!validated.ok) {
			records.push({ custom_id: item.customId, status: "invalid", output: rec.text, error: validated.error });
			continue;
		}
		outputs[item.customId] = validated.value;
		records.push({ custom_id: item.customId, status: "completed", output: rec.text });
	}
	const failedCount = records.filter((r) => r.status !== "completed").length;
	state = {
		...state,
		status: failedCount === 0 ? "completed" : "failed",
		items: records,
		usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, cost_usd: costUsd },
		updated_at: stamp(),
	};
	persist(state);
	opts.onUpdate?.({ type: "batch_collected", completed: records.length - failedCount, total: records.length });
	if (failedCount > 0) {
		throw new BatchError(
			"items_incomplete",
			`batch job ${jobId}: ${failedCount}/${records.length} item(s) failed validation — ` +
				`resubmit only the failed items (BatchError.detail.items)`,
			{ jobId, items: records.filter((r) => r.status !== "completed") },
		);
	}

	return {
		runId,
		jobId,
		items: records,
		outputs,
		usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, cost_usd: costUsd },
		durationMs: now() - startedMs,
	};
}

/**
 * Recovery entrypoint (review P2): resume an aborted/timed-out batch job
 * from its persisted job-state file, re-driving the SAME provider job to a
 * terminal phase and collecting the results — no new submission, so no
 * double-spend. The caller re-supplies the original spec (a detached run
 * keeps it in its <run_id>.request.json sidecar next to the batch state).
 *
 * Throws BatchError("not_found") when no state file exists for the run.
 */
export async function resumeBatchJob(
	opts: {
		metricsDir: string;
		project: string;
		runId: string;
		/** The ORIGINAL spec the job was submitted with. */
		spec: Spec;
		/** Batch model id (config [batch].model). */
		model: string;
		provider: BatchProvider;
		pollIntervalMs?: number;
		jobTimeoutMs?: number;
		signal?: AbortSignal;
		onUpdate?: (event: BatchLaneUpdate) => void;
		sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
		now?: () => number;
	},
): Promise<BatchLaneResult> {
	const state = readBatchJobState(opts.metricsDir, opts.project, opts.runId);
	if (!state?.job_id) {
		throw new BatchError(
			"not_found",
			`no recoverable batch job for ${opts.project}/${opts.runId} — nothing to resume`,
		);
	}
	return runBatchLane({
		spec: opts.spec,
		model: opts.model,
		provider: opts.provider,
		metricsDir: opts.metricsDir,
		project: opts.project,
		runId: opts.runId,
		existingJobId: state.job_id,
		pollIntervalMs: opts.pollIntervalMs,
		jobTimeoutMs: opts.jobTimeoutMs,
		signal: opts.signal,
		onUpdate: opts.onUpdate,
		sleep: opts.sleep,
		now: opts.now,
	});
}

