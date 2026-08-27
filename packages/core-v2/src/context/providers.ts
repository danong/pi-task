/** Raw and deterministic symbol-tree context providers (M4 experiment). */
import { createHash } from "node:crypto";
import type {
	CompiledContextArtifact,
	ContextArtifactHandle,
	ContextBudget,
	ContextProvider,
	ContextProviderFactory,
	ContextProviderIdentity,
	ContextProvenance,
} from "../contracts/context-provider.ts";
import { ContextArtifactSchema } from "../contracts/context-provider.ts";
import { DEFAULT_CONTEXT_BUDGET } from "./compiler.ts";
import { retrieveSymbolTree, type ContextRetrievalOptions } from "./retrieval.ts";
import { scanSymbolTree, type SymbolTree } from "./symbol-tree.ts";

export const RAW_CONTEXT_PROVIDER_IDENTITY: ContextProviderIdentity = { id: "raw", version: "1" };
export const SYMBOL_TREE_CONTEXT_PROVIDER_IDENTITY: ContextProviderIdentity = { id: "symbol-tree", version: "1" };

export interface ContextProviderOptions {
	root: string;
	sourceRevision: string;
	budget?: Partial<ContextBudget>;
}

function budgetFor(input: Partial<ContextBudget> | undefined): ContextBudget {
	const budget = {
		maxHandles: input?.maxHandles ?? DEFAULT_CONTEXT_BUDGET.maxHandles,
		maxCharacters: input?.maxCharacters ?? DEFAULT_CONTEXT_BUDGET.maxCharacters,
		maxTokens: input?.maxTokens ?? DEFAULT_CONTEXT_BUDGET.maxTokens,
	};
	if (Object.values(budget).some((value) => !Number.isSafeInteger(value) || value < 0)) throw new RangeError("context budgets must be non-negative safe integers");
	return budget;
}

function hashId(kind: string, path: string, symbol: string | undefined): string {
	return `h-${createHash("sha256").update(`${kind}\0${path}\0${symbol ?? ""}`).digest("hex").slice(0, 16)}`;
}

function provenance(source: string, sourceRevision: string, treeIdentity: string, selector: string): ContextProvenance {
	return { source, sourceRevision, treeIdentity, selector };
}

function artifactFromRetrieval(
	identity: ContextProviderIdentity,
	tree: SymbolTree,
	query: string,
	result: ReturnType<typeof retrieveSymbolTree>,
	budget: ContextBudget,
): CompiledContextArtifact {
	const source = provenance("symbol-tree", tree.provenance.sourceRevision, tree.treeIdentity, "lexical-structural-v1");
	const handles: ContextArtifactHandle[] = result.handles.map((handle) => ({
		...handle,
		id: hashId(handle.kind, handle.path, handle.symbol),
		provenance: source,
	}));
	return ContextArtifactSchema.parse({
		provider: identity,
		source,
		query,
		handles,
		omissions: { count: result.metadata.omittedCount, reasons: result.metadata.cappingReasons },
		estimatedSize: { characters: result.metadata.charactersUsed, tokens: result.metadata.estimatedTokensUsed },
		budget,
	});
}

class RawContextProvider implements ContextProvider {
	readonly identity = RAW_CONTEXT_PROVIDER_IDENTITY;
	readonly #source: ContextProvenance;
	readonly #budget: ContextBudget;
	constructor(options: ContextProviderOptions) {
		this.#source = provenance("raw", options.sourceRevision, `unindexed:${createHash("sha256").update(options.root).digest("hex").slice(0, 16)}`, "no-injection");
		this.#budget = budgetFor(options.budget);
	}
	async compile(input: { query: string }): Promise<CompiledContextArtifact> { return this.empty(input.query); }
	async query(input: { query: string }): Promise<CompiledContextArtifact> { return this.empty(input.query); }
	resolve(handles: readonly string[]): ContextArtifactHandle[] {
		if (handles.length > 0) throw new Error("raw context provider has no handles");
		return [];
	}
	private empty(query: string): CompiledContextArtifact {
		return ContextArtifactSchema.parse({ provider: this.identity, source: this.#source, query: query.trim(), handles: [], omissions: { count: 0, reasons: [] }, estimatedSize: { characters: 0, tokens: 0 }, budget: this.#budget });
	}
}

class SymbolTreeContextProvider implements ContextProvider {
	readonly identity = SYMBOL_TREE_CONTEXT_PROVIDER_IDENTITY;
	readonly #tree: SymbolTree;
	readonly #budget: ContextBudget;
	readonly #byId = new Map<string, ContextArtifactHandle>();
	constructor(options: ContextProviderOptions) {
		this.#tree = scanSymbolTree({ root: options.root, sourceRevision: options.sourceRevision });
		this.#budget = budgetFor(options.budget);
	}
	async compile(input: { query: string; options?: ContextRetrievalOptions }): Promise<CompiledContextArtifact> {
		return this.make(input.query, input.options);
	}
	async query(input: { query: string; options?: ContextRetrievalOptions }): Promise<CompiledContextArtifact> {
		return this.make(input.query, input.options);
	}
	resolve(handles: readonly string[]): ContextArtifactHandle[] {
		return handles.map((id) => {
			if (id.includes("..") || id.includes("/") || !/^h-[a-f0-9]{16}$/.test(id)) throw new Error(`unknown or unsafe context handle: ${id}`);
			const handle = this.#byId.get(id);
			if (handle === undefined) throw new Error(`unknown context handle: ${id}`);
			return handle;
		});
	}
	private make(query: string, options?: ContextRetrievalOptions): CompiledContextArtifact {
		const result = retrieveSymbolTree(this.#tree, query, {
			maxResults: Math.min(options?.maxResults ?? this.#budget.maxHandles, this.#budget.maxHandles),
			maxCharacters: Math.min(options?.maxCharacters ?? this.#budget.maxCharacters, this.#budget.maxCharacters),
			maxTokens: Math.min(options?.maxTokens ?? this.#budget.maxTokens, this.#budget.maxTokens),
		});
		const artifact = artifactFromRetrieval(this.identity, this.#tree, query.trim(), result, this.#budget);
		for (const handle of artifact.handles) this.#byId.set(handle.id, handle);
		return artifact;
	}
}

export function createRawContextProvider(options: ContextProviderOptions): ContextProvider { return new RawContextProvider(options); }
export function createSymbolTreeContextProvider(options: ContextProviderOptions): ContextProvider { return new SymbolTreeContextProvider(options); }
export const rawContextProviderFactory: ContextProviderFactory = { identity: RAW_CONTEXT_PROVIDER_IDENTITY, create: createRawContextProvider };
export const symbolTreeContextProviderFactory: ContextProviderFactory = { identity: SYMBOL_TREE_CONTEXT_PROVIDER_IDENTITY, create: createSymbolTreeContextProvider };
