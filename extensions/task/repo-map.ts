/**
 * Codebase map — build, cache, and inject a machine-maintained index of
 * the repo into worker prompts (Phase 5, context seeding).
 *
 * Pipeline: invalidate (tree hash) → skeleton (deterministic, no model)
 * → annotate (one batched LLM call, amortized + incremental) → cache.
 *
 * The map turns worker cold-start broad exploration into targeted
 * verification reads. It is structural fact about the current code —
 * distinct from the episodic memory store.
 *
 * The annotation is the only LLM cost; everything else is deterministic.
 * If annotation fails, a skeleton-mode map is shipped so the next full build
 * retries annotation on the summary-less files (graceful, self-healing).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getPiInvocation } from "./worker.ts";

// ─── Types ───────────────────────────────────────────────────────────

export interface MapFileEntry {
	path: string;
	lang: string;
	symbols: string[];
	loc: number;
	/** sha256 of file content — the incremental-annotation key. */
	contentHash: string;
	role?: string;
	summary?: string;
}

export interface CodebaseMap {
	treeHash: string;
	generated: string;
	generatorModel: string;
	/** Build mode this map was produced with ("skeleton" caches must not satisfy "full" requests). */
	mode: "full" | "skeleton";
	entryPoints: string[];
	patterns: string[];
	testLayout: string;
	files: MapFileEntry[];
}

export interface SkeletonFile {
	path: string;
	lang: string;
	symbols: string[];
	loc: number;
	contentHash: string;
}

export interface MapAnnotation {
	entryPoints: string[];
	patterns: string[];
	testLayout: string;
	files: Array<{ path: string; role: string; summary: string }>;
}

// ─── Language / symbol tables (deterministic, no model) ──────────────

const LANG_BY_EXT: Record<string, string> = {
	".ts": "typescript", ".tsx": "typescript",
	".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
	".py": "python",
	".gd": "gdscript",
	".rs": "rust",
	".go": "go",
	".java": "java",
	".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp",
	".rb": "ruby", ".php": "php", ".swift": "swift", ".kt": "kotlin",
	".sh": "shell", ".bash": "shell",
	".md": "markdown", ".json": "json", ".toml": "toml", ".yaml": "yaml", ".yml": "yaml",
	".css": "css", ".html": "html",
};

const BINARY_EXTS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".svg", ".pdf",
	".zip", ".gz", ".tar", ".tgz", ".bz2", ".xz", ".wasm", ".woff", ".woff2",
	".ttf", ".eot", ".mp3", ".mp4", ".mov", ".avi", ".exe", ".dll", ".so", ".a", ".o", ".bin",
]);

const SYMBOL_RE: Record<string, RegExp> = {
	python: /^\s*(?:def|async\s+def|class)\s+([A-Za-z_]\w*)/,
	gdscript: /^\s*(?:func|class_name|signal|const)\s+([A-Za-z_]\w*)/,
	rust: /^\s*(?:fn|struct|enum|impl|trait|type)\s+([A-Za-z_]\w*)/,
	go: /^\s*(?:func|type)\s+([A-Za-z_]\w*)/,
	typescript: /^\s*(?:export\s+)?(?:default\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$]\w*)/,
	javascript: /^\s*(?:export\s+)?(?:default\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$]\w*)/,
	java: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum)\s+([A-Za-z_]\w*)/,
	c: /^\s*(?:int|void|char|long|float|double|size_t|static|struct|typedef)\s+([A-Za-z_]\w*)\s*\(/,
	cpp: /^\s*(?:int|void|char|long|float|double|size_t|static|auto|const|struct|class)\s+([A-Za-z_]\w*)\s*\(/,
	shell: /^\s*([A-Za-z_]\w*)\s*\(\)/,
};

const GENERIC_SYMBOL_RE =
	/^\s*(?:def|func|function|class|class_name|fn|struct|enum|impl|trait|export|interface|type)\s+([A-Za-z_]\w*)/;

function langFor(path: string): string {
	return LANG_BY_EXT[extname(path).toLowerCase()] ?? "plain";
}

function isBinary(path: string, content: Buffer): boolean {
	if (BINARY_EXTS.has(extname(path).toLowerCase())) return true;
	// Null-byte sniff on the first 8KB as a fallback.
	return content.subarray(0, 8192).includes(0);
}

function extractSymbols(text: string, lang: string, max = 50): string[] {
	const re = SYMBOL_RE[lang] ?? GENERIC_SYMBOL_RE;
	const symbols: string[] = [];
	for (const line of text.split("\n")) {
		const m = re.exec(line);
		if (m && m[1]) {
			const sym = m[1];
			if (!symbols.includes(sym)) symbols.push(sym);
			if (symbols.length >= max) break;
		}
	}
	return symbols;
}

function sha256(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

// ─── Config (config/repo-map.toml) ────────────────────────────────────

export interface RepoMapConfig {
	mode: "full" | "skeleton";
	annotationModel: string;
	injectWorkers: boolean;
	sliceLimit: number;
	/** Consumed in Phase 9 (main-agent piping). */
	mainAgent: boolean;
	/** Consumed in Phase 9 (always-on overview in the main session). */
	overviewInSystemPrompt: boolean;
}

const DEFAULT_MAP_CONFIG: RepoMapConfig = {
	mode: "full",
	annotationModel: "opencode-go/deepseek-v4-flash",
	injectWorkers: true,
	sliceLimit: 15,
	mainAgent: true,
	overviewInSystemPrompt: true,
};

const TOML_TO_JSON_SCRIPT =
	"import tomllib, json, sys; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb'))))";

/**
 * Parse a TOML file via Python's built-in tomllib (zero JS dependencies;
 * python3 is a system tool, available at runtime as well as in tests).
 */
function parseTomlFile(path: string): Record<string, Record<string, string | boolean | number>> {
	const out = execFileSync("python3", ["-c", TOML_TO_JSON_SCRIPT, path], {
		encoding: "utf8",
		maxBuffer: 1 << 20,
		// stderr piped (not inherited): a malformed file throws, and the
		// python traceback is replaced by our own one-line warning (same as
		// parseTomlFile in config.ts).
		stdio: ["ignore", "pipe", "pipe"],
	});
	return JSON.parse(out);
}

function str(sections: Record<string, Record<string, string | boolean | number>>, section: string, key: string): string | undefined {
	const v = sections[section]?.[key];
	return typeof v === "string" ? v : undefined;
}
function bool(sections: Record<string, Record<string, string | boolean | number>>, section: string, key: string): boolean | undefined {
	const v = sections[section]?.[key];
	return typeof v === "boolean" ? v : undefined;
}
function int(sections: Record<string, Record<string, string | boolean | number>>, section: string, key: string): number | undefined {
	const v = sections[section]?.[key];
	return typeof v === "number" ? v : undefined;
}

/** Load repo-map config. Optional path overrides the code-relative default. */
export function loadRepoMapConfig(configPath?: string): RepoMapConfig {
	const path = configPath ?? join(getAgentDir(), "config", "repo-map.toml");
	let sections: Record<string, Record<string, string | boolean | number>> = {};
	try {
		// Check existence first so a missing config degrades to defaults
		// silently (no python traceback for a normal missing file).
		if (existsSync(path)) {
			sections = parseTomlFile(path);
		}
	} catch (err) {
		// An existing-but-unreadable/invalid file warns once and falls back to
		// defaults (mirrors loadTaskConfig in config.ts); a MISSING file
		// degrades silently — the existsSync guard above handles that.
		console.warn(
			`repo-map.toml: unreadable/invalid TOML at ${path} — using built-in defaults (${(err as Error).message})`,
		);
		return { ...DEFAULT_MAP_CONFIG };
	}

	const mode = str(sections, "mode", "default");
	return {
		mode: mode === "skeleton" ? "skeleton" : "full",
		annotationModel: str(sections, "mode", "annotation_model") ?? DEFAULT_MAP_CONFIG.annotationModel,
		injectWorkers: bool(sections, "injection", "workers") ?? DEFAULT_MAP_CONFIG.injectWorkers,
		sliceLimit: int(sections, "injection", "slice_limit") ?? DEFAULT_MAP_CONFIG.sliceLimit,
		mainAgent: bool(sections, "injection", "main_agent") ?? DEFAULT_MAP_CONFIG.mainAgent,
		overviewInSystemPrompt:
			bool(sections, "injection", "overview_in_system_prompt") ?? DEFAULT_MAP_CONFIG.overviewInSystemPrompt,
	};
}

// ─── Tracked file list / tree hash ───────────────────────────────────

const MAX_SYMBOL_EXTRACT_BYTES = 512 * 1024;

/**
 * Files pi owns and rewrites out from under the repo (agent settings writes,
 * memory extraction). Tracking them is fine, but they must not churn the tree
 * hash — a machine write would invalidate the codebase-map cache every session
 * (see the prior memory.json/settings.json churn finding). They carry no
 * structural code facts the map summarizes anyway.
 */
const MACHINE_WRITTEN_FILES = new Set(["settings.json", "memory.json"]);

function listTrackedFiles(projectDir: string): string[] {
	// --ignore-working-copy (todo #70): read-only commands must not write
	// snapshot ops — the map is built around the worker run and a snapshot
	// op could race a worker's commits and fork the op log. The recorded @
	// tree is the task base either way (the guard snapshotted it fresh).
	const out = execFileSync("jj", ["file", "list", "--ignore-working-copy"], {
		cwd: projectDir,
		encoding: "utf8",
	});
	return out
		.split("\n")
		.map((l) => l.trim())
		.filter(
			(p) =>
				p &&
				!p.startsWith(".pi/") &&
				!p.startsWith(".jj/") &&
				!p.split("/").pop()!.startsWith(".") && // skip dotfiles (.gitignore etc.)
				!MACHINE_WRITTEN_FILES.has(p.split("/").pop()!), // see MACHINE_WRITTEN_FILES
		);
}

/**
 * Hash of the tracked file set (paths + contents). Any tracked content
 * change produces a different hash — the entire freshness mechanism.
 */
export function getTreeHash(projectDir: string): string {
	const hash = createHash("sha256");
	for (const rel of listTrackedFiles(projectDir)) {
		hash.update(rel);
		try {
			hash.update(readFileSync(join(projectDir, rel)));
		} catch {
			// File deleted between list and read — skip.
		}
	}
	return hash.digest("hex").slice(0, 16);
}

// ─── Skeleton (deterministic) ────────────────────────────────────────

export function buildSkeleton(projectDir: string): SkeletonFile[] {
	const files: SkeletonFile[] = [];
	for (const rel of listTrackedFiles(projectDir)) {
		let content: Buffer;
		try {
			content = readFileSync(join(projectDir, rel));
		} catch {
			continue; // Race — file disappeared.
		}
		if (isBinary(rel, content)) continue;

		const text = content.toString("utf8");
		const lang = langFor(rel);
		const symbols = content.byteLength <= MAX_SYMBOL_EXTRACT_BYTES ? extractSymbols(text, lang) : [];
		files.push({
			path: rel,
			lang,
			symbols,
			loc: text.split("\n").length,
			contentHash: sha256(content),
		});
	}
	files.sort((a, b) => a.path.localeCompare(b.path));
	return files;
}

// ─── Cache (tree-hash invalidation, atomic write, agent-dir scoped) ──

/**
 * Map cache root — inside the agent dir (pi's getAgentDir, the same
 * source loadTaskConfig uses), NOT inside any task repo, so map builds
 * never mutate a project working copy.
 */
const CACHE_ROOT = join(getAgentDir(), "cache", "codebase-map");

/**
 * Cache path for a project: `<agentDir>/cache/codebase-map/<key>.json` where
 * `<key>` is the first 16 hex chars of sha256 over the project's absolute
 * path — stable per directory, distinct across directories. Orphan-cache
 * eviction (stale keys from deleted repos) is intentionally out of scope;
 * they accumulate under the gitignored cache root.
 */
export function mapCachePath(projectDir: string): string {
	const key = sha256(resolve(projectDir)).slice(0, 16);
	return join(CACHE_ROOT, `${key}.json`);
}

/**
 * Cache-usable rule: a cached map satisfies a build request only when the
 * tree hashes match AND the request is "skeleton" (any cache works) or the
 * cache is "full" (a skeleton cache lacks summaries and a full request must
 * rebuild + re-annotate it). Exported for hermetic tests.
 */
export function isCacheUsableFor(cached: CodebaseMap | null, mode: "full" | "skeleton", treeHash: string): boolean {
	return !!cached && cached.treeHash === treeHash && (mode === "skeleton" || (cached.mode ?? "full") === "full");
}

export function loadCachedMap(projectDir: string): CodebaseMap | null {
	try {
		const raw = readFileSync(mapCachePath(projectDir), "utf8");
		const map = JSON.parse(raw) as CodebaseMap;
		if (!map || typeof map.treeHash !== "string" || !Array.isArray(map.files)) return null;
		return map;
	} catch {
		return null;
	}
}

export function saveMap(projectDir: string, map: CodebaseMap): void {
	const path = mapCachePath(projectDir);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `codebase-map.json.tmp-${process.pid}`);
	writeFileSync(tmp, JSON.stringify(map, null, 2));
	renameSync(tmp, path);
}

// ─── Annotation (the only LLM cost) ──────────────────────────────────

const MAX_ANNOTATE_FILES = 200;
const MAX_SYMBOLS_IN_PROMPT = 20;

/**
 * Annotation wall-clock budget (2 min). A hung annotation would otherwise
 * leave the index.ts session_start map-refresh guard set forever and block
 * the task tool's map build (R5).
 */
export const ANNOTATE_TIMEOUT_MS = 120_000;

/** Spawn `pi --mode json -p` and return the final assistant text. */
export async function callModel(prompt: string, model: string): Promise<string> {
	const invocation = getPiInvocation(["--mode", "json", "-p", "--no-session", "--model", model, prompt]);
	return new Promise<string>((resolve, reject) => {
		const proc = spawn(invocation.command, invocation.args, {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffer = "";
		let lastAssistantText = "";
		let stderr = "";
		let settled = false;

		// R5: kill the child and reject on expiry; cleared on close/error.
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			proc.kill("SIGKILL");
			reject(new Error(`Model call timed out after ${ANNOTATE_TIMEOUT_MS} ms`));
		}, ANNOTATE_TIMEOUT_MS);

		const processLine = (line: string): void => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const textParts = (event.message.content ?? [])
					.filter((p: any) => p.type === "text")
					.map((p: any) => p.text);
				if (textParts.length > 0) lastAssistantText = textParts.join("");
			}
		};

		proc.stdout.on("data", (data: Buffer) => {
			buffer += data.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString("utf8");
		});

		proc.on("close", (code) => {
			clearTimeout(timer);
			if (settled) return;
			settled = true;
			if (buffer.trim()) processLine(buffer);
			if (lastAssistantText) resolve(lastAssistantText);
			else reject(new Error(`Model call produced no assistant text (exit ${code}): ${stderr.slice(0, 300)}`));
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			if (settled) return;
			settled = true;
			reject(new Error(`Failed to spawn model process: ${err.message}`));
		});
	});
}

function buildAnnotationPrompt(
	projectDir: string,
	skeleton: SkeletonFile[],
	toAnnotate: SkeletonFile[],
): string {
	const projectName = projectDir.split("/").filter(Boolean).pop() ?? projectDir;
	const files = skeleton
		.slice(0, MAX_ANNOTATE_FILES)
		.map((f) => {
			let snippet = "";
			try {
				const text = readFileSync(join(projectDir, f.path), "utf8");
				snippet = text.slice(0, 400).replace(/\s+/g, " ").trim();
			} catch {
				// File vanished — leave snippet empty.
			}
			const sym = f.symbols.slice(0, MAX_SYMBOLS_IN_PROMPT).join(", ") || "(none)";
			return `- ${f.path} [lang: ${f.lang}, loc: ${f.loc}, symbols: ${sym}]
  snippet: ${snippet || "(empty)"}`;
		})
		.join("\n");
	const targets = toAnnotate.slice(0, MAX_ANNOTATE_FILES).map((f) => f.path);

	return `You are analyzing the codebase "${projectName}". Every file listed below exists in the repo and its snippet is its actual content. Summarize what each file DOES based on its snippet.

Skeleton (paths, symbols, content snippets):

${files}

Produce a JSON object with exactly this shape (no markdown fences, no commentary, JSON only):
{
  "entryPoints": ["<paths of entry-point files>"],
  "patterns": ["<brief codebase patterns, e.g. 'procedural UI in scripts, .tscn as stubs'>"],
  "testLayout": "<one line on where tests live and how to run them, or empty string>",
  "files": [
    {"path": "<file path>", "role": "<core|support|test|config|docs|other>", "summary": "<one-line summary of what this file does>"}
  ]
}

Annotate ONLY the files in this list (others are unchanged from a previous annotation):
${targets.length > 0 ? targets.map((p) => `- ${p}`).join("\n") : "(none — return entryPoints/patterns/testLayout only)"}`;
}

export function parseAnnotation(text: string): MapAnnotation {
	let json = text.trim();
	const fence = json.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) json = fence[1].trim();
	const start = json.indexOf("{");
	const end = json.lastIndexOf("}");
	if (start !== -1 && end > start) json = json.slice(start, end + 1);

	const data = JSON.parse(json);
	return {
		entryPoints: Array.isArray(data.entryPoints) ? data.entryPoints.map(String) : [],
		patterns: Array.isArray(data.patterns) ? data.patterns.map(String) : [],
		testLayout: typeof data.testLayout === "string" ? data.testLayout : "",
		files: Array.isArray(data.files)
			? data.files
					.filter((f: any) => f && typeof f.path === "string")
					.map((f: any) => ({
						path: f.path,
						role: typeof f.role === "string" ? f.role : "",
						summary: typeof f.summary === "string" ? f.summary : "",
					}))
			: [],
	};
}

async function annotate(
	projectDir: string,
	skeleton: SkeletonFile[],
	toAnnotate: SkeletonFile[],
	model: string,
): Promise<MapAnnotation> {
	const output = await callModel(buildAnnotationPrompt(projectDir, skeleton, toAnnotate), model);
	return parseAnnotation(output);
}

// ─── Build / load (the orchestrator entry point) ─────────────────────

export interface BuildMapOptions {
	/**
	 * "full" (default): LLM-annotate summaries/roles (incremental on change).
	 * "skeleton": never call the LLM; reuse cached annotations when
	 * available, otherwise path/symbols only. Zero annotation cost.
	 */
	mode?: "full" | "skeleton";
	/** Annotation model (required in "full" mode). Ignored in "skeleton". */
	model?: string;
}

export interface BuildMapDeps {
	/**
	 * Test seam: overrides the real annotate (which spawns `pi`). Defaults to
	 * the module-level annotate; production behavior is unchanged when
	 * omitted. Hermetic tests stub this to drive the annotation-failure
	 * path without any LLM call.
	 */
	annotate?: (
		projectDir: string,
		skeleton: SkeletonFile[],
		toAnnotate: SkeletonFile[],
		model: string,
	) => Promise<MapAnnotation>;
}

export async function buildMap(
	projectDir: string,
	opts: BuildMapOptions,
	deps: BuildMapDeps = {},
): Promise<CodebaseMap> {
	const treeHash = getTreeHash(projectDir);
	const mode = opts.mode ?? "full";
	// A full build whose annotation fails is persisted as "skeleton" (see the
	// catch below) so the next full request retries annotation.
	let savedMode: "full" | "skeleton" = mode;

	const cached = loadCachedMap(projectDir);
	// Skeleton requests accept any cache; full requests reject skeleton caches
	// (they lack summaries) and rebuild with annotation.
	const cachedUsable = isCacheUsableFor(cached, mode, treeHash);
	// Re-check `cached` so TS narrows it to non-null (isCacheUsableFor only
	// returns true for a non-null cache).
	if (cached && cachedUsable) return cached;

	const skeleton = buildSkeleton(projectDir);
	const prevFiles = new Map((cached?.files ?? []).map((f) => [f.path, f]));

	// Seed annotations from cache, then overlay fresh ones for changed files.
	const annotationByPath = new Map<string, { role: string; summary: string }>();
	for (const [path, f] of prevFiles) {
		annotationByPath.set(path, { role: f.role ?? "", summary: f.summary ?? "" });
	}

	let entryPoints = cached?.entryPoints ?? [];
	let patterns = cached?.patterns ?? [];
	let testLayout = cached?.testLayout ?? "";

	if (mode === "full") {
		if (!opts.model) {
			throw new Error('buildMap: "model" is required in full mode');
		}
		const toAnnotate = skeleton.filter((f) => {
			const prev = prevFiles.get(f.path);
			// Re-annotate: new/changed files, OR files whose cached entry has no
			// summary (e.g. the cache was built in skeleton mode).
			return !prev || prev.contentHash !== f.contentHash || !prev.summary;
		});

		// MAX_ANNOTATE_FILES truncates both the prompt file list and the target
		// list; files beyond the cap get no summaries this pass and are
		// re-annotated on the next build (todo #73: previously warned via
		// console.warn — exceeding the cap is an expected condition on large
		// diffs and must stay silent).

		if (toAnnotate.length > 0) {
			try {
				const ann = await (deps.annotate ?? annotate)(projectDir, skeleton, toAnnotate, opts.model);
				entryPoints = ann.entryPoints;
				patterns = ann.patterns;
				testLayout = ann.testLayout;
				// Incremental contract: only changed files accept new annotations.
				// The model may return extras; ignore them so cached summaries hold.
				const changedPaths = new Set(toAnnotate.map((f) => f.path));
				for (const f of ann.files) {
					if (changedPaths.has(f.path)) {
						annotationByPath.set(f.path, { role: f.role, summary: f.summary });
					}
				}
			} catch (err) {
				// Annotation-failure retry contract: persist the map as "skeleton"
				// (not "full") so the next full build's cachedUsable check rejects
				// it and re-annotates exactly the summary-less (changed) files.
				// One transient failure therefore poisons at most a single build,
				// not the cache indefinitely. Seeded (cached) annotations are
				// preserved as today. todo #73: the failure is silent — a
				// console.warn here fires on every normal run whose annotation
				// model is unavailable, and would leak into the prompt box.
				savedMode = "skeleton";
			}
		}
	}
	// skeleton mode: no annotation — cached annotations (seeded above) hold.


	const map: CodebaseMap = {
		treeHash,
		generated: new Date().toISOString(),
		generatorModel: opts.model ?? "",
		mode: savedMode,
		entryPoints,
		patterns,
		testLayout,
		files: skeleton.map((f) => {
			const a = annotationByPath.get(f.path);
			return { ...f, role: a?.role, summary: a?.summary };
		}),
	};

	// Retry contract (save site): a full build whose annotation failed is
	// persisted as mode:"skeleton", so cachedUsable rejects it for the next
	// full request and annotation runs again on exactly the summary-less
	// (changed) files — a transient annotation failure never sticks.
	saveMap(projectDir, map);
	return map;
}

// ─── Relevance slicing + prompt injection (deterministic) ────────────

const STOPWORDS = new Set([
	"the", "and", "for", "with", "this", "that", "from", "into", "file", "files",
	"create", "using", "your", "should", "make", "then", "call", "when", "after",
	"add", "new", "its", "are", "was", "have", "has", "not", "but",
]);

function tokenize(text: string): Set<string> {
	const words = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
	return new Set(words.filter((w) => w.length >= 2 && !STOPWORDS.has(w)));
}

/** Score a file by keyword overlap with the spec (path + symbols + summary). */
export function scoreFileRelevance(f: MapFileEntry, tokens: Set<string>): number {
	const haystack = `${f.path} ${f.symbols.join(" ")} ${f.summary ?? ""}`.toLowerCase();
	let score = 0;
	for (const t of tokens) {
		if (haystack.includes(t)) score++;
	}
	return score;
}

export function sliceRelevant(map: CodebaseMap, spec: string, limit = 15): MapFileEntry[] {
	const tokens = tokenize(spec);
	const scored = map.files
		.map((f) => ({ f, score: scoreFileRelevance(f, tokens) }))
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score || a.f.loc - b.f.loc);
	return scored.slice(0, limit).map((s) => s.f);
}

/**
 * The always-on global overview for the main session's system prompt
 * (Phase 9): entry points, patterns, test layout — ~300 tokens, no file
 * list. Empty string when the map has nothing to say (callers skip the
 * injection). Pure — tested hermetically.
 */
export function formatMapOverview(map: CodebaseMap): string {
	const lines: string[] = ["## Codebase overview"];
	if (map.entryPoints.length > 0) lines.push(`Entry points: ${map.entryPoints.join(", ")}`);
	if (map.patterns.length > 0) lines.push(`Patterns: ${map.patterns.join("; ")}`);
	if (map.testLayout) lines.push(`Test layout: ${map.testLayout}`);
	return lines.length > 1 ? lines.join("\n") : "";
}

/** The "Codebase map" section prepended to the worker's task prompt. */
export function formatMapPrompt(map: CodebaseMap, relevant: MapFileEntry[]): string {
	const lines: string[] = [];
	lines.push("## Codebase map");
	if (map.entryPoints.length > 0) lines.push(`Entry points: ${map.entryPoints.join(", ")}`);
	if (map.patterns.length > 0) lines.push(`Patterns: ${map.patterns.join("; ")}`);
	if (map.testLayout) lines.push(`Test layout: ${map.testLayout}`);
	if (relevant.length > 0) {
		lines.push("");
		lines.push("Files most relevant to this task (read these first):");
		for (const f of relevant) {
			const sym = f.symbols.length > 0 ? ` [symbols: ${f.symbols.slice(0, 15).join(", ")}]` : "";
			const summary = f.summary ? ` — ${f.summary}` : "";
			lines.push(`- ${f.path}${summary}${sym}`);
		}
		lines.push("");
		lines.push("Read the files above first; explore beyond them only if they do not cover the task.");
	}
	return lines.join("\n");
}
