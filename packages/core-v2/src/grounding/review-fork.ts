/**
 * Review-fork file-budget pruning — bounded scorer (M3 review-fork mode).
 *
 * After parallel workers squash (jj squash + merge) the "changed files" are
 * diff(base..merged) — the union of every worker's diff. A reviewer for
 * worker k must still see k's own changed files even when the union is
 * huge. This module is the SECOND pluggable file budget on top of the
 * continuation scorer: same shape (changed set + optional anchors/key
 * files + byte/file caps → pruned subset), symmetric so both can be
 * swapped/configured, pure and hermetically testable.
 *
 * Strategy: mandatory files (anchors + keyFiles + attemptFiles) are never
 * dropped; optional files fill the remaining budget deterministically
 * (lexicographic). Caps are respected for optional files; a mandatory set
 * that alone exceeds the caps still ships — hiding the attempt under review
 * would break R2. Chose lexicographic over relevance scoring because it is
 * deterministic, zero-dependency, and hermetically testable; a relevance
 * scorer can replace it behind the same interface when measured.
 */

export interface FileEntry {
	path: string;
	bytes: number;
}

export interface FileBudget {
	/** Max files to keep (excluding mandatory overflow). Undefined = unbounded. */
	maxFiles?: number | undefined;
	/** Max total bytes to keep (excluding mandatory overflow). Undefined = unbounded. */
	maxBytes?: number | undefined;
}

export interface ReviewForkPruneInput {
	/** Union changed files: diff(base..merged) after atomic squash. */
	files: readonly FileEntry[];
	/** Optional anchor files — never dropped if present. */
	anchors?: readonly string[] | undefined;
	/** Optional key files — never dropped if present (alias for anchors). */
	keyFiles?: readonly string[] | undefined;
	/**
	 * Files changed by the attempt under review — never hidden (R2).
	 * When N workers are squashed into the integration base the scorer sees
	 * both the per-worker commit and the combined tree; this set names the
	 * attempt's own files so the union never hides them.
	 */
	attemptFiles?: readonly string[] | undefined;
	budget: FileBudget;
}

export interface ReviewForkPruneResult {
	/** Pruned subset to ship to the reviewer (sorted lexicographically). */
	kept: FileEntry[];
	/** Files from the input that were pruned (sorted lexicographically). */
	dropped: FileEntry[];
	/** Total bytes of kept entries. */
	keptBytes: number;
}

export interface ReviewForkScorer {
	name: string;
	prune(input: ReviewForkPruneInput): ReviewForkPruneResult;
}

function normalizeFiles(files: readonly FileEntry[]): Map<string, FileEntry> {
	const m = new Map<string, FileEntry>();
	for (const f of files) {
		const bytes = Math.max(0, Math.floor(f.bytes));
		const existing = m.get(f.path);
		if (existing === undefined || bytes > existing.bytes)
			m.set(f.path, { path: f.path, bytes });
	}
	return m;
}

function dedupStrings(values: readonly string[] | undefined): string[] {
	if (!values) return [];
	const s = new Set<string>();
	for (const v of values) if (v) s.add(v);
	return [...s];
}

/**
 * Pure bounded prune: mandatory (anchors+keyFiles+attemptFiles) never
 * dropped; optional files fill remaining budget deterministically by
 * lexicographic path. Caps are enforced on optional files only.
 */
export function pruneReviewFiles(
	input: ReviewForkPruneInput,
): ReviewForkPruneResult {
	const fileMap = normalizeFiles(input.files);
	const anchors = dedupStrings(input.anchors);
	const keyFiles = dedupStrings(input.keyFiles);
	const attemptFiles = dedupStrings(input.attemptFiles);
	const mandatoryPaths = new Set<string>([
		...anchors,
		...keyFiles,
		...attemptFiles,
	]);

	// Partition: mandatory entries (including synthesized anchors not in diff)
	const mandatory: FileEntry[] = [];
	const optional: FileEntry[] = [];
	const seenMandatory = new Set<string>();

	for (const [path, entry] of fileMap) {
		if (mandatoryPaths.has(path)) {
			mandatory.push(entry);
			seenMandatory.add(path);
		} else {
			optional.push(entry);
		}
	}
	// Anchors/key/attempt files not in the diff are still kept (synthetic 0-byte
	// entry makes "never dropped" observable even for union-missing cases).
	for (const p of mandatoryPaths) {
		if (!seenMandatory.has(p)) {
			mandatory.push({ path: p, bytes: 0 });
		}
	}

	mandatory.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	optional.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	const maxFiles = input.budget.maxFiles;
	const maxBytes = input.budget.maxBytes;
	const capFiles =
		maxFiles !== undefined
			? Math.max(0, Math.floor(maxFiles))
			: Number.POSITIVE_INFINITY;
	const capBytes =
		maxBytes !== undefined
			? Math.max(0, Math.floor(maxBytes))
			: Number.POSITIVE_INFINITY;

	let keptBytes = 0;
	for (const f of mandatory) keptBytes += f.bytes;
	let keptCount = mandatory.length;

	const keptOptional: FileEntry[] = [];
	const dropped: FileEntry[] = [];

	for (const f of optional) {
		const nextCount = keptCount + 1;
		const nextBytes = keptBytes + f.bytes;
		if (nextCount > capFiles || nextBytes > capBytes) {
			dropped.push(f);
		} else {
			keptOptional.push(f);
			keptCount = nextCount;
			keptBytes = nextBytes;
		}
	}

	const kept = [...mandatory, ...keptOptional];
	kept.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	dropped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	return { kept, dropped, keptBytes };
}

/** Default pluggable scorer — bounded file-budget strategy. */
export const defaultReviewForkScorer: ReviewForkScorer = {
	name: "bounded-file-budget",
	prune: pruneReviewFiles,
};
