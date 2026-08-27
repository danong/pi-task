/** Core raw/no-injection acquisition baseline with no optional index imports. */
import { createHash } from "node:crypto";

import {
	ContextArtifactSchema,
	ContextBudgetSchema,
	type CompiledContextArtifact,
	type ContextArtifactHandle,
	type ContextBudget,
	type ContextProvider,
	type ContextProviderFactory,
	type ContextProviderIdentity,
	type ContextProvenance,
} from "../contracts/context-provider.ts";
import { DEFAULT_CONTEXT_BUDGET } from "./compiler.ts";

export const RAW_CONTEXT_PROVIDER_IDENTITY: ContextProviderIdentity = {
	id: "raw",
	version: "1",
};

export interface RawContextProviderOptions {
	root: string;
	sourceRevision: string;
	budget?: Partial<ContextBudget>;
}

function budgetFor(input: Partial<ContextBudget> | undefined): ContextBudget {
	return {
		maxHandles: input?.maxHandles ?? DEFAULT_CONTEXT_BUDGET.maxHandles,
		maxCharacters: input?.maxCharacters ?? DEFAULT_CONTEXT_BUDGET.maxCharacters,
		maxTokens: input?.maxTokens ?? DEFAULT_CONTEXT_BUDGET.maxTokens,
	};
}

class RawContextProvider implements ContextProvider {
	readonly identity = RAW_CONTEXT_PROVIDER_IDENTITY;
	readonly #source: ContextProvenance;
	readonly #budget: ContextBudget;

	constructor(options: RawContextProviderOptions) {
		const treeIdentity = `unindexed:${createHash("sha256").update(options.root).digest("hex").slice(0, 16)}`;
		this.#source = {
			source: "raw",
			sourceRevision: treeIdentity,
			treeIdentity,
			selector: "no-injection",
		};
		this.#budget = ContextBudgetSchema.parse(budgetFor(options.budget));
	}

	async compile(input: { query: string }): Promise<CompiledContextArtifact> {
		return this.empty(input.query);
	}

	async query(input: { query: string }): Promise<CompiledContextArtifact> {
		return this.empty(input.query);
	}

	resolve(handles: readonly string[]): ContextArtifactHandle[] {
		if (handles.length > 0)
			throw new Error("raw context provider has no handles");
		return [];
	}

	private empty(query: string): CompiledContextArtifact {
		return ContextArtifactSchema.parse({
			provider: this.identity,
			source: this.#source,
			query: query.trim(),
			handles: [],
			omissions: { count: 0, reasons: [] },
			estimatedSize: { characters: 0, tokens: 0 },
			budget: this.#budget,
		});
	}
}

export function createRawContextProvider(
	options: RawContextProviderOptions,
): ContextProvider {
	return new RawContextProvider(options);
}

export const rawContextProviderFactory: ContextProviderFactory = {
	identity: RAW_CONTEXT_PROVIDER_IDENTITY,
	create: createRawContextProvider,
};
