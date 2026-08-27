/**
 * Deterministic lexical and structural retrieval over a SymbolTree.
 *
 * Retrieval is intentionally a separate, synchronous context source: it reads
 * only the already-built symbol tree, performs no filesystem reads, and never
 * calls a model, embedding service, VCS, or network. Results are compact
 * handles; source bodies remain available only to a later explicit tool.
 */

import type { SymbolTree, SymbolTreeEntry } from "./symbol-tree.ts";

export const DEFAULT_MAX_RETRIEVAL_RESULTS = 50;
export const DEFAULT_MAX_RETRIEVAL_CHARACTERS = 12_000;
export const DEFAULT_MAX_RETRIEVAL_TOKENS = 3_000;

export type RetrievalHandleKind = "file" | "symbol";
export type RetrievalQueryStatus = "empty" | "unknown" | "matched";
export type RetrievalMatchReason =
	| "exact-path"
	| "exact-symbol"
	| "filename-token"
	| "path-segment-token"
	| "language-token"
	| "symbol-token"
	| "test-source-adjacent";
export type RetrievalCappingReason =
	"result-limit" | "character-budget" | "token-budget";

/** A progressive-disclosure reference. It contains no source body or outline. */
export interface ContextHandle {
	kind: RetrievalHandleKind;
	/** Canonical repository-relative POSIX path from the symbol tree. */
	path: string;
	/** Present only for a symbol handle. */
	symbol?: string | undefined;
	language: string;
	status: SymbolTreeEntry["status"];
	/** Content identity from the source tree; callers can use this to validate a later read. */
	sourceIdentity: string;
	contentIdentityScope: SymbolTreeEntry["contentIdentityScope"];
	sourceRevision: string;
	matchReasons: RetrievalMatchReason[];
	/** Integer relevance score; larger values rank first. */
	score: number;
}

export interface ContextRetrievalOptions {
	/** Maximum number of returned handles. Zero intentionally returns no handles. */
	maxResults?: number;
	/** Maximum UTF-8 bytes in the compact serialized handles. */
	maxCharacters?: number;
	/** Approximate token budget, using four UTF-8 bytes per token. */
	maxTokens?: number;
}

export interface ContextRetrievalMetadata {
	query: string;
	queryStatus: RetrievalQueryStatus;
	treeIdentity: string;
	sourceRevision: string;
	/** Number of unique candidate handles before budgets are applied. */
	candidateCount: number;
	returnedCount: number;
	omittedCount: number;
	deduplicatedCount: number;
	capped: boolean;
	cappingReasons: RetrievalCappingReason[];
	charactersUsed: number;
	estimatedTokensUsed: number;
	maxResults: number;
	maxCharacters: number;
	maxTokens: number;
}

export interface ContextRetrievalResult {
	handles: ContextHandle[];
	metadata: ContextRetrievalMetadata;
}

interface Candidate {
	handle: ContextHandle;
	key: string;
}

const REASON_ORDER: readonly RetrievalMatchReason[] = [
	"exact-path",
	"exact-symbol",
	"filename-token",
	"path-segment-token",
	"language-token",
	"symbol-token",
	"test-source-adjacent",
];

function finiteLimit(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}

/** Split ordinary names and camelCase names into stable lower-case tokens. */
function lexicalTokens(value: string): string[] {
	const expanded = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
	return expanded
		.toLocaleLowerCase("en-US")
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0);
}

function normalized(value: string): string {
	return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function compareNumbersDescending(a: number, b: number): number {
	return b - a;
}

function basename(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? path : path.slice(slash + 1);
}

function filenameTokens(path: string): string[] {
	return lexicalTokens(basename(path).replace(/\.[^.]+$/, ""));
}

function pathSegmentTokens(path: string): string[] {
	const parts = path.split("/");
	return parts.slice(0, -1).flatMap((part) => lexicalTokens(part));
}

function entryStem(path: string): string {
	let name = basename(path).replace(/\.[^.]+$/, "");
	name = name.replace(/(?:^|[-_.])(?:test|spec)(?:$|[-_.])/gi, "-");
	name = name.replace(/^(?:test|spec)[-_.]/i, "");
	return lexicalTokens(name).join("");
}

function isTestPath(path: string): boolean {
	const name = basename(path).replace(/\.[^.]+$/, "");
	return (
		/(?:^|[-_.])(?:test|spec)(?:$|[-_.])/i.test(name) ||
		/^test[-_.]/i.test(name)
	);
}

function sameStem(a: string, b: string): boolean {
	const left = entryStem(a);
	const right = entryStem(b);
	return left.length > 0 && left === right;
}

function hasToken(
	tokens: readonly string[],
	queryTokens: readonly string[],
): boolean {
	const available = new Set(tokens);
	return queryTokens.some((token) => available.has(token));
}

function addReason(
	reasons: RetrievalMatchReason[],
	reason: RetrievalMatchReason,
): void {
	if (!reasons.includes(reason)) reasons.push(reason);
}

function scoreFor(reasons: readonly RetrievalMatchReason[]): number {
	let score = 0;
	for (const reason of reasons) {
		score +=
			reason === "exact-symbol"
				? 10_000
				: reason === "exact-path"
					? 9_000
					: reason === "symbol-token"
						? 600
						: reason === "filename-token"
							? 500
							: reason === "path-segment-token"
								? 450
								: reason === "language-token"
									? 400
									: 250;
	}
	return score;
}

function serializedSize(handle: ContextHandle): number {
	return Buffer.byteLength(JSON.stringify(handle), "utf8");
}

function candidateKey(
	kind: RetrievalHandleKind,
	path: string,
	symbol?: string,
): string {
	return `${kind}\0${path}\0${symbol ?? ""}`;
}

function makeHandle(
	entry: SymbolTreeEntry,
	queryTokens: readonly string[],
	queryPath: string,
	symbol?: string,
): ContextHandle | null {
	const reasons: RetrievalMatchReason[] = [];
	if (symbol === undefined) {
		if (queryPath === entry.path.toLocaleLowerCase("en-US"))
			addReason(reasons, "exact-path");
		if (hasToken(filenameTokens(entry.path), queryTokens))
			addReason(reasons, "filename-token");
		if (hasToken(pathSegmentTokens(entry.path), queryTokens))
			addReason(reasons, "path-segment-token");
		if (hasToken(lexicalTokens(entry.language), queryTokens))
			addReason(reasons, "language-token");
	} else {
		if (normalized(symbol) === normalized(queryPath))
			addReason(reasons, "exact-symbol");
		if (hasToken(lexicalTokens(symbol), queryTokens))
			addReason(reasons, "symbol-token");
	}
	if (reasons.length === 0) return null;
	reasons.sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b));
	return {
		kind: symbol === undefined ? "file" : "symbol",
		path: entry.path,
		...(symbol === undefined ? {} : { symbol }),
		language: entry.language,
		status: entry.status,
		sourceIdentity: entry.contentIdentity,
		contentIdentityScope: entry.contentIdentityScope,
		sourceRevision: "", // filled from the containing tree below
		matchReasons: reasons,
		score: scoreFor(reasons),
	};
}

function mergeCandidates(
	candidates: readonly Candidate[],
	tree: SymbolTree,
): { candidates: Candidate[]; deduplicatedCount: number } {
	const byKey = new Map<string, Candidate>();
	for (const candidate of candidates) {
		const previous = byKey.get(candidate.key);
		if (previous === undefined) {
			byKey.set(candidate.key, candidate);
			continue;
		}
		const reasons = [...previous.handle.matchReasons];
		for (const reason of candidate.handle.matchReasons)
			addReason(reasons, reason);
		reasons.sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b));
		previous.handle.matchReasons = reasons;
		previous.handle.score = scoreFor(reasons);
	}
	const unique = [...byKey.values()];
	for (const candidate of unique) {
		candidate.handle.sourceRevision = tree.provenance.sourceRevision;
	}
	return {
		candidates: unique,
		deduplicatedCount: candidates.length - unique.length,
	};
}

function sortCandidates(a: Candidate, b: Candidate): number {
	return (
		compareNumbersDescending(a.handle.score, b.handle.score) ||
		compareText(a.handle.path, b.handle.path) ||
		compareText(a.handle.kind, b.handle.kind) ||
		compareText(a.handle.symbol ?? "", b.handle.symbol ?? "")
	);
}

/**
 * Retrieve compact file and symbol handles from a symbol tree.
 *
 * Exact full-path and exact-symbol matches dominate lexical token matches.
 * Filename, directory-segment, language, symbol, and test/source adjacency
 * signals are all mechanical and explainable. Empty or unmatched queries do
 * not fall back to returning the tree.
 */
export function retrieveSymbolTree(
	tree: SymbolTree,
	query: string,
	options: ContextRetrievalOptions = {},
): ContextRetrievalResult {
	const maxResults = finiteLimit(
		options.maxResults,
		DEFAULT_MAX_RETRIEVAL_RESULTS,
	);
	const maxCharacters = finiteLimit(
		options.maxCharacters,
		DEFAULT_MAX_RETRIEVAL_CHARACTERS,
	);
	const maxTokens = finiteLimit(
		options.maxTokens,
		DEFAULT_MAX_RETRIEVAL_TOKENS,
	);
	const trimmedQuery = query.trim();
	const queryTokens = lexicalTokens(trimmedQuery);
	const queryPath = trimmedQuery
		.replaceAll("\\", "/")
		.replace(/^\.\//, "")
		.replace(/^\/+|\/+$/g, "")
		.toLocaleLowerCase("en-US");
	const baseMetadata = {
		query: trimmedQuery,
		treeIdentity: tree.treeIdentity,
		sourceRevision: tree.provenance.sourceRevision,
		maxResults,
		maxCharacters,
		maxTokens,
	};
	if (trimmedQuery.length === 0 || queryTokens.length === 0) {
		return {
			handles: [],
			metadata: {
				...baseMetadata,
				queryStatus: "empty",
				candidateCount: 0,
				returnedCount: 0,
				omittedCount: 0,
				deduplicatedCount: 0,
				capped: false,
				cappingReasons: [],
				charactersUsed: 0,
				estimatedTokensUsed: 0,
			},
		};
	}

	const rawCandidates: Candidate[] = [];
	const directlyMatchedEntries = new Set<string>();
	for (const entry of tree.entries) {
		const file = makeHandle(entry, queryTokens, queryPath);
		if (file !== null) {
			rawCandidates.push({
				handle: file,
				key: candidateKey("file", entry.path),
			});
			directlyMatchedEntries.add(entry.path);
		}
		if (entry.status !== "indexed") continue;
		for (const symbol of entry.symbols) {
			const symbolHandle = makeHandle(entry, queryTokens, trimmedQuery, symbol);
			if (symbolHandle === null) continue;
			rawCandidates.push({
				handle: symbolHandle,
				key: candidateKey("symbol", entry.path, symbol),
			});
			directlyMatchedEntries.add(entry.path);
		}
	}

	// One structural expansion pass: a directly matching source/test file
	// contributes its mechanically paired counterpart, never an unrelated file.
	for (const source of tree.entries) {
		if (!directlyMatchedEntries.has(source.path)) continue;
		const sourceIsTest = isTestPath(source.path);
		for (const adjacent of tree.entries) {
			if (
				adjacent.path === source.path ||
				isTestPath(adjacent.path) === sourceIsTest
			)
				continue;
			if (!sameStem(source.path, adjacent.path)) continue;
			const handle: ContextHandle = {
				kind: "file",
				path: adjacent.path,
				language: adjacent.language,
				status: adjacent.status,
				sourceIdentity: adjacent.contentIdentity,
				contentIdentityScope: adjacent.contentIdentityScope,
				sourceRevision: tree.provenance.sourceRevision,
				matchReasons: ["test-source-adjacent"],
				score: scoreFor(["test-source-adjacent"]),
			};
			rawCandidates.push({
				handle,
				key: candidateKey("file", adjacent.path),
			});
		}
	}

	const merged = mergeCandidates(rawCandidates, tree);
	const ranked = merged.candidates.sort(sortCandidates);
	const cappingReasons: RetrievalCappingReason[] = [];
	const handles: ContextHandle[] = [];
	let charactersUsed = 0;
	let estimatedTokensUsed = 0;
	let budgetOmitted = false;
	for (const candidate of ranked) {
		if (handles.length >= maxResults) {
			if (!cappingReasons.includes("result-limit"))
				cappingReasons.push("result-limit");
			continue;
		}
		const characters = serializedSize(candidate.handle);
		const tokens = Math.max(1, Math.ceil(characters / 4));
		if (charactersUsed + characters > maxCharacters) {
			budgetOmitted = true;
			if (!cappingReasons.includes("character-budget"))
				cappingReasons.push("character-budget");
			continue;
		}
		if (estimatedTokensUsed + tokens > maxTokens) {
			budgetOmitted = true;
			if (!cappingReasons.includes("token-budget"))
				cappingReasons.push("token-budget");
			continue;
		}
		handles.push(candidate.handle);
		charactersUsed += characters;
		estimatedTokensUsed += tokens;
	}
	if (
		ranked.length > handles.length &&
		maxResults === 0 &&
		!cappingReasons.includes("result-limit")
	)
		cappingReasons.push("result-limit");
	const omittedCount = ranked.length - handles.length;
	if (budgetOmitted && omittedCount === 0) budgetOmitted = false;
	return {
		handles,
		metadata: {
			...baseMetadata,
			queryStatus: ranked.length > 0 ? "matched" : "unknown",
			candidateCount: ranked.length,
			returnedCount: handles.length,
			omittedCount,
			deduplicatedCount: merged.deduplicatedCount,
			capped: omittedCount > 0,
			cappingReasons: [...cappingReasons],
			charactersUsed,
			estimatedTokensUsed,
		},
	};
}

/** Alias emphasizing that the result is a context-source operation. */
export const retrieveContext = retrieveSymbolTree;
