/** Typed context-provider capability used by the execution kernel (M4). */
import { z } from "zod";

export const ContextProviderIdentitySchema = z
	.object({
		id: z.string().min(1).max(128),
		version: z.string().min(1).max(128),
	})
	.strict();
export type ContextProviderIdentity = z.infer<
	typeof ContextProviderIdentitySchema
>;

export const ContextProvenanceSchema = z
	.object({
		source: z.string().min(1).max(128),
		sourceRevision: z.string().min(1).max(256),
		treeIdentity: z.string().min(1).max(256),
		selector: z.string().min(1).max(256),
	})
	.strict();
export type ContextProvenance = z.infer<typeof ContextProvenanceSchema>;

export const ContextArtifactHandleSchema = z
	.object({
		id: z.string().min(1).max(256),
		kind: z.enum(["file", "symbol"]),
		path: z
			.string()
			.min(1)
			.max(512)
			.refine(
				(value) => !value.startsWith("/") && !value.split("/").includes(".."),
				"handle path must be repository-relative",
			),
		symbol: z.string().max(256).optional(),
		language: z.string().min(1).max(64),
		status: z.enum([
			"indexed",
			"binary",
			"unsupported",
			"oversized",
			"unreadable",
		]),
		sourceIdentity: z.string().min(1).max(256),
		contentIdentityScope: z.enum(["full", "prefix"]),
		sourceRevision: z.string().min(1).max(256),
		matchReasons: z.array(z.string().min(1).max(64)).max(16),
		score: z.number().finite(),
		provenance: ContextProvenanceSchema,
	})
	.strict();
export type ContextArtifactHandle = z.infer<typeof ContextArtifactHandleSchema>;

export const ContextBudgetSchema = z
	.object({
		maxHandles: z.number().int().nonnegative(),
		maxCharacters: z.number().int().nonnegative(),
		maxTokens: z.number().int().nonnegative(),
	})
	.strict();
export type ContextBudget = z.infer<typeof ContextBudgetSchema>;

export const ContextArtifactSchema = z
	.object({
		provider: ContextProviderIdentitySchema,
		source: ContextProvenanceSchema,
		query: z.string().max(2000),
		handles: z.array(ContextArtifactHandleSchema),
		omissions: z
			.object({
				count: z.number().int().nonnegative(),
				reasons: z.array(z.string().min(1).max(64)).max(16),
			})
			.strict(),
		estimatedSize: z
			.object({
				characters: z.number().int().nonnegative(),
				tokens: z.number().int().nonnegative(),
			})
			.strict(),
		budget: ContextBudgetSchema,
	})
	.strict();
export type CompiledContextArtifact = z.infer<typeof ContextArtifactSchema>;
/** Descriptive alias used by provider consumers and conformance tests. */
export const CompiledContextArtifactSchema = ContextArtifactSchema;

/** Provider-neutral query budgets; implementations may apply stricter limits. */
export interface ContextQueryOptions {
	maxResults?: number;
	maxCharacters?: number;
	maxTokens?: number;
}

export interface ContextQuery {
	query: string;
	options?: ContextQueryOptions;
}

export interface ContextProvider {
	readonly identity: ContextProviderIdentity;
	compile(input: ContextQuery): Promise<CompiledContextArtifact>;
	query(input: ContextQuery): Promise<CompiledContextArtifact>;
	resolve(
		handles: readonly string[],
	): ContextArtifactHandle[] | Promise<ContextArtifactHandle[]>;
}

export interface ContextProviderFactory {
	readonly identity: ContextProviderIdentity;
	create(options: { root: string; sourceRevision: string }): ContextProvider;
}
