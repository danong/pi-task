/**
 * Seam 3/6 — Context compression (subsystems §1, contract FR-9 layer 4).
 *
 * Produces the per-file symbol outlines of an ExecutionBundle without a
 * full read. Implementations are a fallback chain, cheapest adequate
 * first: TreeSitterCompressor → CtagsCompressor → RegexCompressor. The
 * compressor enforces the ≈200 token/file cap (≤800 chars, enforced by
 * TargetFileSchema.astOutline.max).
 */

/** One page of a file's symbol outline (bundle generator input). */
export interface OutlinePage {
	/** The generated outline text, capped at ~maxTokens. */
	outline: string;
	/** True when generation stopped at maxTokens and more exists. */
	truncated: boolean;
	/** Opaque continuation cursor; null when the outline is complete. */
	cursor: string | null;
}

export interface ContextCompressor {
	name: string;
	isSupported(): Promise<boolean>;
	generateOutline(
		filePath: string,
		options: { maxTokens: number; cursor?: string | null },
	): Promise<OutlinePage>;
	extractSymbols(filePath: string, symbolQuery: string): Promise<string>;
}