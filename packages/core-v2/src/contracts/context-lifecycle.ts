/** Provider-neutral M4 context lifecycle contracts.
 *
 * These are deliberately structural and bounded. Providers can discover facts,
 * but only the kernel can turn candidates into a prompt plan or an epoch.
 */
import { z } from "zod";

export const CONTEXT_LIFECYCLE_VERSION = 1 as const;
export const CONTEXT_MAX_TEXT_CHARS = 4_000;
export const CONTEXT_MAX_ITEM_SUMMARY_CHARS = 800;
export const CONTEXT_MAX_ITEMS = 256;
export const CONTEXT_MAX_REFERENCES = 64;
export const CONTEXT_MAX_REQUIREMENTS = 128;

const boundedText = (max: number) => z.string().max(max);
const identity = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const modelIdentity = z.string().min(1).max(256);

export const ContextSensitivitySchema = z.enum([
	"public",
	"internal",
	"confidential",
	"restricted",
]);
export type ContextSensitivity = z.infer<typeof ContextSensitivitySchema>;

export const ContextFreshnessSchema = z
	.object({
		revision: z.string().min(1).max(256),
		observedAtRevision: z.string().min(1).max(256),
		state: z.enum(["fresh", "stale", "unknown"]),
	})
	.strict();
export type ContextFreshness = z.infer<typeof ContextFreshnessSchema>;

export const ContextProvenanceV2Schema = z
	.object({
		providerId: identity,
		providerVersion: boundedText(128),
		source: boundedText(128),
		sourceRevision: boundedText(256),
		selector: boundedText(256),
	})
	.strict();
export type ContextProvenanceV2 = z.infer<typeof ContextProvenanceV2Schema>;

export const ImmutableArtifactReferenceSchema = z
	.object({
		version: z.literal(CONTEXT_LIFECYCLE_VERSION),
		id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
		namespace: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[a-z][a-z0-9-]*$/),
		kind: z.enum([
			"context",
			"source-view",
			"checkpoint",
			"plan",
			"tool-result",
			"handoff",
			"result",
			"receipt",
			"trace",
			"verification",
			"failure",
		]),
		mediaType: z.string().min(1).max(128),
		sizeBytes: z.number().int().nonnegative(),
		sensitivity: ContextSensitivitySchema,
		sourceRevision: z.string().min(1).max(256),
	})
	.strict();
export type ImmutableArtifactReference = z.infer<
	typeof ImmutableArtifactReferenceSchema
>;

export const ContextItemSchema = z
	.object({
		version: z.literal(CONTEXT_LIFECYCLE_VERSION),
		id: identity,
		kind: z.enum([
			"source",
			"index",
			"candidate",
			"materialization",
			"artifact",
			"checkpoint",
		]),
		label: boundedText(256),
		summary: boundedText(CONTEXT_MAX_ITEM_SUMMARY_CHARS),
		provenance: ContextProvenanceV2Schema,
		freshness: ContextFreshnessSchema,
		sensitivity: ContextSensitivitySchema,
		size: z
			.object({
				characters: z.number().int().nonnegative(),
				tokens: z.number().int().nonnegative(),
			})
			.strict(),
		requirementIds: z
			.array(z.string().min(1).max(128))
			.max(CONTEXT_MAX_REQUIREMENTS),
		artifact: ImmutableArtifactReferenceSchema.optional(),
		sourcePath: z
			.string()
			.max(512)
			.refine(
				(value) => !value.startsWith("/") && !value.split("/").includes(".."),
				"source path must be repository-relative",
			)
			.optional(),
		score: z.number().finite(),
	})
	.strict();
export type ContextItem = z.infer<typeof ContextItemSchema>;

export const ContextNeedSchema = z
	.object({
		id: identity,
		requirementId: z.string().min(1).max(128),
		query: boundedText(512),
		priority: z.number().int().nonnegative(),
	})
	.strict();
export type ContextNeed = z.infer<typeof ContextNeedSchema>;

export const EconomicBudgetSchema = z
	.object({
		maxInputCostUsd: z.number().finite().nonnegative().optional(),
		maxUncachedTokens: z.number().int().nonnegative(),
		maxProviderCacheWriteTokens: z.number().int().nonnegative(),
	})
	.strict();
export type EconomicBudget = z.infer<typeof EconomicBudgetSchema>;
export const WindowBudgetSchema = z
	.object({
		maxTokens: z.number().int().nonnegative(),
		reserveTokens: z.number().int().nonnegative(),
	})
	.strict();
export type WindowBudget = z.infer<typeof WindowBudgetSchema>;
export const AttentionBudgetSchema = z
	.object({
		maxItems: z.number().int().nonnegative(),
		maxVolatileSegments: z.number().int().nonnegative(),
	})
	.strict();
export type AttentionBudget = z.infer<typeof AttentionBudgetSchema>;
export const ContextBudgetsSchema = z
	.object({
		economic: EconomicBudgetSchema,
		window: WindowBudgetSchema,
		attention: AttentionBudgetSchema,
	})
	.strict();
export type ContextBudgets = z.infer<typeof ContextBudgetsSchema>;

export const ContextCacheCapabilitiesSchema = z
	.object({
		localArtifactReuse: z.boolean(),
		providerPrefixCaching: z.boolean(),
		inSessionReuse: z.boolean(),
		compatibleModels: z.array(modelIdentity).max(32),
		inputCostUsdPerMillion: z.number().finite().nonnegative().optional(),
		cacheReadCostUsdPerMillion: z.number().finite().nonnegative().optional(),
		cacheWriteCostUsdPerMillion: z.number().finite().nonnegative().optional(),
		attribution: z.enum(["measured", "available", "unavailable"]),
	})
	.strict();
export type ContextCacheCapabilities = z.infer<
	typeof ContextCacheCapabilitiesSchema
>;
export const ContextCachePlanSchema = z
	.object({
		version: z.literal(CONTEXT_LIFECYCLE_VERSION),
		localArtifactIds: z
			.array(z.string().regex(/^sha256:[a-f0-9]{64}$/))
			.max(CONTEXT_MAX_REFERENCES),
		providerPrefixIdentity: z.string().max(256),
		toolSchemaIdentity: z.string().min(1).max(512),
		strategy: z.enum(["none", "local", "provider-prefix", "in-session"]),
		modelId: modelIdentity,
		compatible: z.boolean(),
		attribution: z.enum(["measured", "available", "unavailable"]),
	})
	.strict();
export type ContextCachePlan = z.infer<typeof ContextCachePlanSchema>;

export const ContextPlanSchema = z
	.object({
		version: z.literal(CONTEXT_LIFECYCLE_VERSION),
		id: identity,
		mode: z.enum(["raw", "managed"]),
		needs: z.array(ContextNeedSchema).max(CONTEXT_MAX_REQUIREMENTS),
		candidates: z.array(ContextItemSchema).max(CONTEXT_MAX_ITEMS),
		selected: z.array(ContextItemSchema).max(CONTEXT_MAX_ITEMS),
		omissions: z
			.array(
				z
					.object({
						candidateId: identity,
						reason: boundedText(256),
						requirementIds: z
							.array(z.string().max(128))
							.max(CONTEXT_MAX_REQUIREMENTS),
					})
					.strict(),
			)
			.max(CONTEXT_MAX_ITEMS),
		budgets: ContextBudgetsSchema,
		reservedTokens: z.number().int().nonnegative(),
		cache: ContextCachePlanSchema,
		sourceRevision: z.string().min(1).max(256),
	})
	.strict();
export type ContextPlan = z.infer<typeof ContextPlanSchema>;

export const PromptSegmentSchema = z
	.object({
		version: z.literal(CONTEXT_LIFECYCLE_VERSION),
		id: identity,
		kind: z.enum([
			"kernel",
			"tools",
			"repository",
			"task",
			"evidence",
			"checkpoint",
			"volatile",
		]),
		stable: z.boolean(),
		text: boundedText(CONTEXT_MAX_TEXT_CHARS),
		itemIds: z.array(identity).max(CONTEXT_MAX_ITEMS),
		artifactIds: z
			.array(z.string().regex(/^sha256:[a-f0-9]{64}$/))
			.max(CONTEXT_MAX_REFERENCES),
	})
	.strict();
export type PromptSegment = z.infer<typeof PromptSegmentSchema>;
export const PromptAssemblySchema = z
	.object({
		version: z.literal(CONTEXT_LIFECYCLE_VERSION),
		identity: identity,
		planId: identity,
		segments: z.array(PromptSegmentSchema).max(32),
		prompt: z.string().max(16_000),
		tokens: z.number().int().nonnegative(),
		omittedItemIds: z.array(identity).max(CONTEXT_MAX_ITEMS),
		cache: ContextCachePlanSchema,
	})
	.strict();
export type PromptAssembly = z.infer<typeof PromptAssemblySchema>;

export const WorkingCheckpointSchema = z
	.object({
		version: z.literal(CONTEXT_LIFECYCLE_VERSION),
		id: identity,
		epochId: identity,
		workspaceRevision: z.string().min(1).max(256),
		plan: ImmutableArtifactReferenceSchema,
		evidence: z
			.array(ImmutableArtifactReferenceSchema)
			.max(CONTEXT_MAX_REFERENCES),
		requirements: z
			.array(
				z
					.object({
						id: z.string().min(1).max(128),
						status: z.enum(["unknown", "open", "satisfied", "blocked"]),
						evidenceIds: z
							.array(z.string().regex(/^sha256:[a-f0-9]{64}$/))
							.max(CONTEXT_MAX_REFERENCES),
					})
					.strict(),
			)
			.max(CONTEXT_MAX_REQUIREMENTS),
		summary: z
			.object({
				decisions: z.array(boundedText(512)).max(16),
				openQuestions: z.array(boundedText(512)).max(16),
				nextActions: z.array(boundedText(512)).max(16),
			})
			.strict(),
		verification: z
			.object({
				status: z.enum(["not-run", "passed", "failed", "unknown"]),
				evidenceIds: z
					.array(z.string().regex(/^sha256:[a-f0-9]{64}$/))
					.max(CONTEXT_MAX_REFERENCES),
			})
			.strict(),
		artifactIds: z
			.array(z.string().regex(/^sha256:[a-f0-9]{64}$/))
			.max(CONTEXT_MAX_REFERENCES),
	})
	.strict();
export type WorkingCheckpoint = z.infer<typeof WorkingCheckpointSchema>;

export const ExecutionEpochSchema = z
	.object({
		version: z.literal(CONTEXT_LIFECYCLE_VERSION),
		id: identity,
		parentId: identity.optional(),
		role: identity,
		modelId: identity,
		planId: identity,
		checkpointId: identity.optional(),
		status: z.enum([
			"active",
			"completed",
			"interrupted",
			"retrying",
			"pressured",
		]),
		transition: z
			.enum([
				"initial",
				"retry",
				"interruption",
				"model-change",
				"context-pressure",
			])
			.optional(),
		tailBudgetTokens: z.number().int().nonnegative(),
	})
	.strict();
export type ExecutionEpoch = z.infer<typeof ExecutionEpochSchema>;

export const ContextLifecycleArtifactSchema = z.union([
	ImmutableArtifactReferenceSchema,
	ContextPlanSchema,
	PromptAssemblySchema,
	WorkingCheckpointSchema,
	ExecutionEpochSchema,
]);

export const ContextAcquisitionRequestSchema = z
	.object({
		root: z.string().min(1).max(4_096),
		sourceRevision: z.string().min(1).max(256),
		needs: z.array(ContextNeedSchema).max(CONTEXT_MAX_REQUIREMENTS),
	})
	.strict();
export type ContextAcquisitionRequest = z.infer<
	typeof ContextAcquisitionRequestSchema
>;

export const ContextMaterializationRequestSchema = z
	.object({
		handles: z.array(identity).max(CONTEXT_MAX_ITEMS),
		requirementIds: z
			.array(z.string().min(1).max(128))
			.max(CONTEXT_MAX_REQUIREMENTS)
			.optional(),
	})
	.strict();
export type ContextMaterializationRequest = z.infer<
	typeof ContextMaterializationRequestSchema
>;

/** Final provider boundary: the kernel accepts only bounded, schema-valid
 * lifecycle items. Providers cannot return prompt text through this seam. */
export const ContextItemListSchema = z
	.array(ContextItemSchema)
	.max(CONTEXT_MAX_ITEMS);
export type ContextItemList = z.infer<typeof ContextItemListSchema>;

export const ContextAcquisitionCapabilitiesSchema = z
	.object({
		identity: z.object({ id: identity, version: boundedText(128) }).strict(),
		candidates: z
			.object({
				identity: z
					.object({ id: identity, version: boundedText(128) })
					.strict(),
			})
			.passthrough(),
		materializer: z
			.object({
				identity: z
					.object({ id: identity, version: boundedText(128) })
					.strict(),
			})
			.passthrough(),
	})
	.passthrough();

export interface ContextCandidateProvider {
	readonly identity: { id: string; version: string };
	acquire(
		input: ContextAcquisitionRequest,
	): Promise<readonly ContextItem[]> | readonly ContextItem[];
}

export interface ContextMaterializationProvider {
	readonly identity: { id: string; version: string };
	materialize(
		input: ContextMaterializationRequest,
	): Promise<readonly ContextItem[]> | readonly ContextItem[];
}

export interface ContextAcquisitionCapabilities {
	readonly identity: { id: string; version: string };
	readonly candidates: ContextCandidateProvider;
	readonly materializer: ContextMaterializationProvider;
}

export interface ContextAcquisitionFactory {
	readonly identity: { id: string; version: string };
	create(options: {
		root: string;
		sourceRevision: string;
	}): ContextAcquisitionCapabilities;
}

export function isRestricted(sensitivity: ContextSensitivity): boolean {
	return sensitivity === "restricted";
}
