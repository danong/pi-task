/**
 * Deterministic, read-only symbol-tree context source.
 *
 * The scanner is deliberately independent of jj, models, and network access.
 * It walks only real filesystem entries beneath a canonical repository root,
 * reads a configured prefix for parsing while hashing the complete file in
 * bounded chunks. Unsupported,
 * binary, oversized, and unreadable files remain visible as explicit entries
 * rather than making the whole index fail.
 */

import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { extname, relative, resolve, sep } from "node:path";

export const SYMBOL_TREE_SOURCE = "filesystem" as const;
export const SYMBOL_TREE_IDENTITY_KIND = "content-addressed" as const;

export type SymbolTreeStatus =
	"indexed" | "binary" | "unsupported" | "oversized" | "unreadable";

export type ContentIdentityScope = "full" | "prefix";

export interface SymbolTreeEntry {
	/** Canonical repository-relative POSIX path. */
	path: string;
	/** Stable language label inferred from the file name. */
	language: string;
	status: SymbolTreeStatus;
	/** sha256 over the read content, or unavailable for unreadable files. */
	contentIdentity: string;
	contentIdentityScope: ContentIdentityScope;
	sizeBytes: number | null;
	/** Null when line metadata is intentionally omitted (oversized, binary, or unreadable). */
	lineCount: number | null;
	/** Unique, source-order symbols, capped by the scan limits. */
	symbols: string[];
}

export interface SymbolTreeFreshness {
	kind: typeof SYMBOL_TREE_IDENTITY_KIND;
	treeIdentity: string;
}

export interface SymbolTreeProvenance {
	source: typeof SYMBOL_TREE_SOURCE;
	/** Caller-owned source revision, such as a jj change id or checkout label. */
	sourceRevision: string;
	freshness: SymbolTreeFreshness;
}

export interface SymbolTreeLimits {
	maxFileBytes: number;
	maxSymbolsPerFile: number;
	maxSymbolBytes: number;
}

export interface SymbolTree {
	root: string;
	entries: SymbolTreeEntry[];
	treeIdentity: string;
	provenance: SymbolTreeProvenance;
	limits: SymbolTreeLimits;
}

export interface ScanSymbolTreeOptions {
	root: string;
	/** Provenance supplied by the caller; the scanner never shells out to VCS. */
	sourceRevision?: string;
	/** Maximum bytes read from any one file, including the oversized probe byte. */
	maxFileBytes?: number;
	maxSymbolsPerFile?: number;
	maxSymbolBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_SYMBOLS_PER_FILE = 50;
const DEFAULT_MAX_SYMBOL_BYTES = 128;

/** Includes but is not limited to VCS, dependency, generated, and state paths. */
const IGNORED_DIRECTORY_NAMES = new Set([
	".git",
	".hg",
	".jj",
	".svn",
	".cache",
	".next",
	".nuxt",
	".pi",
	".turbo",
	".local",
	"__pycache__",
	"artifacts",
	"bower_components",
	"build",
	"coverage",
	"deps",
	"dist",
	"generated",
	"gen",
	"node_modules",
	"out",
	"target",
	"tmp",
	"vendor",
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	".bash": "shell",
	".c": "c",
	".cc": "cpp",
	".cjs": "javascript",
	".cpp": "cpp",
	".css": "css",
	".go": "go",
	".graphql": "graphql",
	".h": "c",
	".hpp": "cpp",
	".html": "html",
	".java": "java",
	".js": "javascript",
	".json": "json",
	".jsonc": "json",
	".jsx": "javascript",
	".kt": "kotlin",
	".less": "css",
	".md": "markdown",
	".mjs": "javascript",
	".mts": "typescript",
	".php": "php",
	".proto": "protobuf",
	".py": "python",
	".rb": "ruby",
	".rs": "rust",
	".sass": "css",
	".scss": "css",
	".sh": "shell",
	".sql": "sql",
	".swift": "swift",
	".toml": "toml",
	".ts": "typescript",
	".tsx": "typescript",
	".vue": "vue",
	".xml": "xml",
	".yaml": "yaml",
	".yml": "yaml",
};

const BINARY_EXTENSIONS = new Set([
	".7z",
	".a",
	".avi",
	".bin",
	".bmp",
	".class",
	".dll",
	".eot",
	".exe",
	".gif",
	".gz",
	".ico",
	".jar",
	".jpeg",
	".jpg",
	".mov",
	".mp3",
	".mp4",
	".o",
	".pdf",
	".png",
	".so",
	".tar",
	".tgz",
	".ttf",
	".wasm",
	".webp",
	".woff",
	".woff2",
	".zip",
]);

const SYMBOL_PATTERNS: Record<string, RegExp> = {
	c: /^\s*(?:static\s+|extern\s+|inline\s+|const\s+)*(?:[A-Za-z_]\w*\s+)+([A-Za-z_]\w*)\s*\(/,
	cpp: /^\s*(?:static\s+|extern\s+|inline\s+|const\s+)*(?:[A-Za-z_:<>]+\s+)+([A-Za-z_]\w*)\s*\(/,
	go: /^\s*(?:func|type)\s+([A-Za-z_]\w*)/,
	java: /^\s*(?:public|private|protected|abstract|static|final\s+)*\s*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/,
	javascript:
		/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/,
	kotlin:
		/^\s*(?:fun|class|interface|object|typealias|val|var)\s+([A-Za-z_]\w*)/,
	php: /^\s*(?:public|private|protected|static\s+)*(?:function|class|interface|trait)\s+([A-Za-z_]\w*)/,
	python: /^\s*(?:async\s+def|def|class)\s+([A-Za-z_]\w*)/,
	ruby: /^\s*(?:def|class|module)\s+([A-Za-z_]\w*)/,
	rust: /^\s*(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|impl|trait|type|mod)\s+([A-Za-z_]\w*)/,
	shell: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)/,
	swift:
		/^\s*(?:public\s+|private\s+|internal\s+|static\s+)*(?:func|class|struct|enum|protocol)\s+([A-Za-z_]\w*)/,
	typescript:
		/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/,
};

function positiveInteger(
	value: number | undefined,
	fallback: number,
	name: string,
): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
	return resolved;
}

function canonicalRoot(root: string): string {
	return realpathSync(resolve(root));
}

function isWithinRoot(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function languageFor(path: string): string {
	const basename = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	if (basename === "dockerfile") return "dockerfile";
	if (basename === "makefile") return "makefile";
	return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] ?? "unknown";
}

function isBinary(path: string, prefix: Buffer): boolean {
	return (
		BINARY_EXTENSIONS.has(extname(path).toLowerCase()) || prefix.includes(0)
	);
}

const HASH_CHUNK_BYTES = 64 * 1024;

interface HashedContent {
	prefix: Buffer;
	contentIdentity: string;
}

/**
 * Hash the complete file in bounded chunks while retaining only the bounded
 * descriptor prefix for parsing. The descriptor is opened once by the caller,
 * so a path replacement cannot redirect a later read to a different file.
 */
function hashContent(fd: number, byteLimit: number): HashedContent {
	const hash = createHash("sha256");
	const prefixChunks: Buffer[] = [];
	let prefixBytes = 0;
	while (true) {
		const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
		const count = readSync(fd, chunk, 0, chunk.length, null);
		if (count === 0) break;
		const bytes = chunk.subarray(0, count);
		hash.update(bytes);
		if (prefixBytes < byteLimit) {
			const retained = bytes.subarray(
				0,
				Math.min(bytes.length, byteLimit - prefixBytes),
			);
			if (retained.length > 0) {
				prefixChunks.push(Buffer.from(retained));
				prefixBytes += retained.length;
			}
		}
	}
	return {
		prefix: Buffer.concat(prefixChunks, prefixBytes),
		contentIdentity: `sha256:${hash.digest("hex")}`,
	};
}

function isNoFollowViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ELOOP"
	);
}

interface OpenedFile {
	fd: number;
	sizeBytes: number;
}

/**
 * Open and validate one candidate atomically with respect to its final path
 * component. O_NOFOLLOW blocks a raced final symlink; the descriptor's proc
 * path check also rejects a parent-directory swap that resolves outside root.
 */
function openFileInRoot(root: string, path: string): OpenedFile | null {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error: unknown) {
		if (isNoFollowViolation(error)) return null;
		throw error;
	}
	try {
		const stats = fstatSync(fd);
		if (!stats.isFile()) {
			closeSync(fd);
			return null;
		}
		const descriptorPath = realpathSync(`/proc/self/fd/${fd}`);
		if (!isWithinRoot(root, descriptorPath)) {
			closeSync(fd);
			return null;
		}
		return { fd, sizeBytes: stats.size };
	} catch (error: unknown) {
		closeSync(fd);
		throw error;
	}
}

function configSymbols(text: string, language: string): string[] {
	if (language === "toml") {
		return text.split(/\r?\n/).flatMap((line) => {
			const match = /^\s*\[([^\]]+)\]/.exec(line);
			return match?.[1] === undefined ? [] : [match[1]];
		});
	}
	if (language === "yaml") {
		return text.split(/\r?\n/).flatMap((line) => {
			const match = /^\s*([A-Za-z_][\w.-]*)\s*:/.exec(line);
			return match?.[1] === undefined ? [] : [match[1]];
		});
	}
	if (language === "json") {
		return text.split(/\r?\n/).flatMap((line) => {
			const match = /^\s*["']([^"']+)["']\s*:/.exec(line);
			return match?.[1] === undefined ? [] : [match[1]];
		});
	}
	if (language === "markdown") {
		return text.split(/\r?\n/).flatMap((line) => {
			const match = /^\s{0,3}#{1,6}\s+(.+?)\s*$/.exec(line);
			return match?.[1] === undefined ? [] : [match[1]];
		});
	}
	return [];
}

function extractSymbols(
	text: string,
	language: string,
	limits: SymbolTreeLimits,
): string[] {
	const pattern = SYMBOL_PATTERNS[language];
	const candidates: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = pattern?.exec(line);
		const config = configSymbols(line, language);
		const symbol = match?.[1] ?? config[0];
		if (
			symbol === undefined ||
			Buffer.byteLength(symbol, "utf8") > limits.maxSymbolBytes
		)
			continue;
		if (!candidates.includes(symbol)) candidates.push(symbol);
		if (candidates.length >= limits.maxSymbolsPerFile) break;
	}
	return candidates;
}

function lineCount(bytes: Buffer): number {
	if (bytes.length === 0) return 0;
	return bytes.toString("utf8").split(/\r?\n/).length;
}

function relativePath(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

function readEntry(
	root: string,
	path: string,
	fd: number,
	_sizeBytes: number,
	limits: SymbolTreeLimits,
): SymbolTreeEntry {
	const relPath = relativePath(root, path);
	const language = languageFor(relPath);
	const readLimit = Math.min(Number.MAX_SAFE_INTEGER, limits.maxFileBytes + 1);
	const hashed = hashContent(fd, readLimit);
	const bytes = hashed.prefix;
	const oversized =
		_sizeBytes > limits.maxFileBytes || bytes.length > limits.maxFileBytes;
	const scope: ContentIdentityScope = "full";
	const binary = isBinary(relPath, bytes);
	if (oversized) {
		return {
			path: relPath,
			language,
			status: "oversized",
			contentIdentity: hashed.contentIdentity,
			contentIdentityScope: scope,
			sizeBytes: _sizeBytes,
			lineCount: null,
			symbols: [],
		};
	}
	if (binary) {
		return {
			path: relPath,
			language,
			status: "binary",
			contentIdentity: hashed.contentIdentity,
			contentIdentityScope: scope,
			sizeBytes: _sizeBytes,
			lineCount: null,
			symbols: [],
		};
	}
	if (language === "unknown") {
		return {
			path: relPath,
			language,
			status: "unsupported",
			contentIdentity: hashed.contentIdentity,
			contentIdentityScope: scope,
			sizeBytes: _sizeBytes,
			lineCount: lineCount(bytes),
			symbols: [],
		};
	}
	const text = bytes.toString("utf8");
	return {
		path: relPath,
		language,
		status: "indexed",
		contentIdentity: hashed.contentIdentity,
		contentIdentityScope: scope,
		sizeBytes: _sizeBytes,
		lineCount: lineCount(bytes),
		symbols: extractSymbols(text, language, limits),
	};
}

function unreadableEntry(
	root: string,
	path: string,
	language: string,
	sizeBytes: number | null,
): SymbolTreeEntry {
	return {
		path: relativePath(root, path),
		language,
		status: "unreadable",
		contentIdentity: "sha256:unavailable",
		contentIdentityScope: "prefix",
		sizeBytes,
		lineCount: null,
		symbols: [],
	};
}

function treeIdentity(entries: readonly SymbolTreeEntry[]): string {
	const hash = createHash("sha256");
	for (const entry of entries) {
		hash.update(
			JSON.stringify([
				entry.path,
				entry.language,
				entry.status,
				entry.contentIdentity,
				entry.contentIdentityScope,
				entry.sizeBytes,
				entry.lineCount,
				entry.symbols,
			]) + "\n",
		);
	}
	return `sha256:${hash.digest("hex")}`;
}

/** Scan a repository root into a stable, bounded symbol tree. */
export function scanSymbolTree(options: ScanSymbolTreeOptions): SymbolTree {
	const root = canonicalRoot(options.root);
	if (!statSync(root).isDirectory())
		throw new Error(`symbol tree root is not a directory: ${options.root}`);
	const limits: SymbolTreeLimits = {
		maxFileBytes: positiveInteger(
			options.maxFileBytes,
			DEFAULT_MAX_FILE_BYTES,
			"maxFileBytes",
		),
		maxSymbolsPerFile: positiveInteger(
			options.maxSymbolsPerFile,
			DEFAULT_MAX_SYMBOLS_PER_FILE,
			"maxSymbolsPerFile",
		),
		maxSymbolBytes: positiveInteger(
			options.maxSymbolBytes,
			DEFAULT_MAX_SYMBOL_BYTES,
			"maxSymbolBytes",
		),
	};
	const entries: SymbolTreeEntry[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const directory = pending.pop()!;
		let children: import("node:fs").Dirent[];
		try {
			children = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
				a.name.localeCompare(b.name),
			);
		} catch {
			continue;
		}
		for (const child of children) {
			// Git worktree metadata is a file in linked worktrees and a directory
			// in ordinary repositories; neither form belongs in the symbol tree.
			if (child.name === ".git") continue;
			if (child.isDirectory() && IGNORED_DIRECTORY_NAMES.has(child.name))
				continue;
			const fullPath = resolve(directory, child.name);
			if (!isWithinRoot(root, fullPath) || child.isSymbolicLink()) continue;
			if (child.isDirectory()) {
				try {
					if (isWithinRoot(root, realpathSync(fullPath)))
						pending.push(fullPath);
				} catch {
					// A directory removed or replaced during traversal is simply absent.
				}
				continue;
			}
			if (!child.isFile()) continue;
			let opened: OpenedFile | null = null;
			try {
				opened = openFileInRoot(root, fullPath);
				if (opened === null) continue;
				entries.push(
					readEntry(root, fullPath, opened.fd, opened.sizeBytes, limits),
				);
			} catch {
				entries.push(
					unreadableEntry(
						root,
						fullPath,
						languageFor(relativePath(root, fullPath)),
						opened?.sizeBytes ?? null,
					),
				);
			} finally {
				if (opened !== null) closeSync(opened.fd);
			}
		}
	}
	entries.sort((a, b) => a.path.localeCompare(b.path));
	const identity = treeIdentity(entries);
	return {
		root,
		entries,
		treeIdentity: identity,
		provenance: {
			source: SYMBOL_TREE_SOURCE,
			sourceRevision: options.sourceRevision ?? "unspecified",
			freshness: { kind: SYMBOL_TREE_IDENTITY_KIND, treeIdentity: identity },
		},
		limits,
	};
}
