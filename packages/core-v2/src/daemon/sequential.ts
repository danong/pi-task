/** Daemon-owned sequential composition: prepare one durable child edge, then
 * resume that edge independently of the process which accepted its parent. */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import type {
	EnvironmentDriver,
	TaskGateway,
	TaskReceipt,
	WorkspaceDriver,
	WorkspaceContext,
	WorkspaceFinalization,
	CombineOutcome,
} from "../contracts/index.ts";
import {
	buildChildHandoff,
	CHILD_MAX_ITEMS,
	ChildResultSchema,
	ChildDependencySummarySchema,
	type ChildDependencySummary,
	type ChildHandoff,
	type ChildResult,
} from "../contracts/payloads.ts";
import {
	ImmutableArtifactReferenceSchema,
	ContextPlanSchema,
	type ContextPlan,
	type ImmutableArtifactReference,
} from "../contracts/context-lifecycle.ts";
import type { TaskLifecycleEvent } from "../contracts/gateway-events.ts";
import {
	TRACE_MAX_EVENTS,
	TraceCollector,
	traceEventFromGateway,
} from "../contracts/trace.ts";
import { admitTaskLifecycleEvent } from "../contracts/gateway-events.ts";
import { VerificationEvidenceSchema } from "../contracts/verification-driver.ts";
import {
	isWorkspaceContinuationError,
	workspaceContinuationOf,
	WorkspaceContinuationError,
} from "../contracts/workspace-driver.ts";
import { TaskReceiptSchema } from "../contracts/payloads.ts";
import { stableStringify } from "../contracts/serialize.ts";
import { ContextArtifactStore } from "../context/artifact-store.ts";
import {
	createWorkingCheckpoint,
	loadWorkingCheckpoint,
	persistWorkingCheckpoint,
} from "../context/checkpoint.ts";
import { planContext } from "../context/planner.ts";
import { InMemoryTaskGateway } from "../gateway/in-memory.ts";
import {
	LedgerStore,
	type SequentialEdgeConfig,
	type ChildTerminalSettlement,
} from "../ledger/store.ts";
import { assertNoMaxCostUsd } from "../budget/execution-budget.ts";
import { parseTaskSpec } from "./task-runner.ts";
import { runIsolatedTask } from "./isolated.ts";
import type { SessionHost } from "../sessions/host.ts";
import type { SessionHostEvent } from "../sessions/host.ts";
import type { ContextAcquisitionFactory } from "../contracts/context-lifecycle.ts";
import type { ContextEvidenceEvent } from "./parallel.ts";

interface SequentialExecutionFacts {
	finalizations: WorkspaceFinalization[];
	combine?: CombineOutcome;
	verification?: { passed: boolean; evidence?: unknown } | undefined;
}

/** Capture provider and gateway facts without widening the shared pipeline.
 * The wrapper delegates every provider call to the original object, while
 * retaining only the bounded structural facts needed for terminal evidence. */
function evidenceDriver(
	driver: WorkspaceDriver,
	facts: SequentialExecutionFacts,
): WorkspaceDriver {
	return new Proxy(driver, {
		get(target, property) {
			if (property === "finalizeWorkspace") {
				const finalize = target.finalizeWorkspace;
				if (finalize === undefined) return undefined;
				return async (context: WorkspaceContext, baseChangeId: string) => {
					const result = await finalize.call(target, context, baseChangeId);
					facts.finalizations.push(result);
					return result;
				};
			}
			if (property === "combine") {
				const combine = target.combine;
				if (combine === undefined) return undefined;
				return async (baseChangeId: string, contexts: readonly WorkspaceContext[]) => {
					const result = await combine.call(target, baseChangeId, contexts);
					facts.combine = result;
					return result;
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as WorkspaceDriver;
}

/** One bounded projection of the admitted gateway stream. Parent and child
 * traces are views of this same stream, not synthetic lifecycle records. */
class SequentialEvidenceStream {
	private count = 0;
	private readonly parentTrace: TraceCollector;
	private readonly childTrace: TraceCollector;
	private readonly unsubscribe: () => void;
	verification: { passed: boolean; evidence?: unknown } | undefined;

	constructor(
		private readonly parentTaskId: string,
		private readonly childTaskId: string,
		gateway: TaskGateway,
	) {
		this.parentTrace = new TraceCollector(parentTaskId, parentTaskId);
		this.childTrace = new TraceCollector(childTaskId, childTaskId);
		this.unsubscribe = gateway.on("*", (event) => this.record(event));
		if (gateway instanceof InMemoryTaskGateway)
			for (const event of gateway.listEvents()) this.record(event);
	}

	private relevant(event: TaskLifecycleEvent): boolean {
		if (event.taskId === this.parentTaskId || event.taskId === this.childTaskId)
			return true;
		if ("detail" in event && event.detail !== undefined && typeof event.detail === "object") {
			const detail = event.detail as Record<string, unknown>;
			return detail.parentTaskId === this.parentTaskId && detail.childTaskId === this.childTaskId;
		}
		return false;
	}

	private record(event: TaskLifecycleEvent): void {
		if (this.count >= TRACE_MAX_EVENTS || !this.relevant(event)) return;
		this.count += 1;
		if (event.type === "verify.completed" && event.taskId === this.childTaskId)
			this.verification = event.detail;
		const isChildLifecycle = event.type.startsWith("child.") || event.type.startsWith("continuation.");
		if (isChildLifecycle || event.taskId === this.parentTaskId)
			this.parentTrace.record(traceEventFromGateway(event, this.parentTaskId));
		if (isChildLifecycle || event.taskId === this.childTaskId)
			this.childTrace.record(traceEventFromGateway(event, this.childTaskId));
	}

	/** Record a canonical terminal event without making gateway delivery part
	 * of the trace hash. It is admitted exactly like a gateway event. */
	recordCanonical(event: TaskLifecycleEvent): void {
		this.record(admitTaskLifecycleEvent(event));
	}

	recordUsage(parentReceipt: TaskReceipt, childReceipt: TaskReceipt): void {
		const usageFor = (receipt: TaskReceipt) => ({
			status: receipt.usageStatus === "measured" ? "measured" as const : "unavailable" as const,
			costUsd: receipt.costUsd,
			inputTokens: receipt.inputTokens,
			outputTokens: receipt.outputTokens,
			cacheReadTokens: receipt.cacheReadTokens,
			// TaskReceipt intentionally stays compact and does not carry cache-write
			// tokens; zero is the truthful compatibility value for this projection.
			cacheWriteTokens: 0,
		});
		this.parentTrace.setUsage(usageFor(parentReceipt));
		this.childTrace.setUsage(usageFor(childReceipt));
	}

	finishChild(outcome: TaskReceipt["verdict"]): ReturnType<TraceCollector["finish"]> {
		return this.childTrace.finish(outcome);
	}
	finishParent(outcome: TaskReceipt["verdict"]): ReturnType<TraceCollector["finish"]> {
		this.unsubscribe();
		return this.parentTrace.finish(outcome);
	}
}

export interface SequentialTaskSpec {
	parentSpecMarkdown: string;
	childSpecMarkdown: string;
}
export type SequentialDeliveryPolicy = "canonical" | "pending";

/** `canonical` is an explicit direct-library policy: immutable canonical
 * artifacts are the caller's delivery boundary. CLI callers use `pending`
 * and acknowledge their external receipt/trace writes separately. */
export interface RunSequentialTaskOptions extends SequentialTaskSpec {
	projectDir: string;
	artifactsDir: string;
	dbPath: string;
	model: string;
	workspaceDriver: WorkspaceDriver;
	environmentDriver?: EnvironmentDriver;
	host?: SessionHost;
	gateway?: TaskGateway;
	artifactStore: ContextArtifactStore;
	maxTurns?: number;
	/** Historical config compatibility only; new execution rejects this field. */
	maxCostUsd?: number;
	sessionTimeoutMs?: number;
	/** Leave the durable edge in `preparing`; a later resume reconciles the provider. */
	deferProviderPreparation?: boolean;
	/** Optional adapter-owned identities; omitted callers receive fresh opaque ids. */
	parentTaskId?: string;
	childTaskId?: string;
	edgeId?: string;
	contextCapabilitiesFactory?: ContextAcquisitionFactory;
	contextArtifactStore?: ContextArtifactStore;
	onContextEvent?: (event: ContextEvidenceEvent) => void;
	onEvent?: (event: SessionHostEvent) => void;
	deliveryPolicy?: SequentialDeliveryPolicy;
}

/** Everything required by a new daemon to resume an already-ready edge. */
export interface SequentialRuntimeDependencies {
	projectDir: string;
	artifactsDir: string;
	dbPath: string;
	model: string;
	workspaceDriver: WorkspaceDriver;
	environmentDriver?: EnvironmentDriver;
	host?: SessionHost;
	gateway?: TaskGateway;
	artifactStore: ContextArtifactStore;
	maxTurns?: number;
	/** Historical config compatibility only; new execution rejects this field. */
	maxCostUsd?: number;
	sessionTimeoutMs?: number;
	contextCapabilitiesFactory?: ContextAcquisitionFactory;
	contextArtifactStore?: ContextArtifactStore;
	onContextEvent?: (event: ContextEvidenceEvent) => void;
	onEvent?: (event: SessionHostEvent) => void;
	deliveryPolicy?: SequentialDeliveryPolicy;
}

export interface SequentialPrepareResult {
	parent: TaskReceipt;
	parentTaskId: string;
	childTaskId: string;
	edgeId?: string;
	status: "preparing" | "ready" | "completed" | "failed" | "escalated" | "blocked" | "delivery_pending";
	failureCode?: SequentialFailureCode;
}

export type SequentialFailureCode =
	| "unsupported" | "missing" | "stale" | "revision_mismatch"
	| "malformed_token" | "checkpoint_missing" | "handoff_invalid"
	| "corrupt" | "incompatible" | "provider_error" | "delivery_failed";

export interface SequentialRunResult {
	parent: TaskReceipt;
	child?: TaskReceipt;
	parentTaskId: string;
	childTaskId: string;
	edgeId?: string;
	status: "completed" | "failed" | "escalated" | "blocked" | "resumable" | "delivery_pending";
	failureCode?: SequentialFailureCode;
}

function sha(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function id(prefix: string): string {
	return `${prefix}-${randomUUID().replaceAll("-", "")}`;
}
function terminalStatus(receipt: TaskReceipt): "completed" | "failed" | "escalated" {
	return receipt.verdict === "ship" ? "completed" : receipt.verdict === "escalate" ? "escalated" : "failed";
}
function parentOutcome(receipt: TaskReceipt, status: SequentialRunResult["status"], child?: TaskReceipt, childDependency?: ChildDependencySummary): TaskReceipt {
	const verdict = status === "completed" ? "ship" : status === "escalated" ? "escalate" : "failed";
	if (child === undefined) return TaskReceiptSchema.parse({ ...receipt, verdict });
	return TaskReceiptSchema.parse({
		...receipt,
		verdict,
		filesChanged: receipt.filesChanged + child.filesChanged,
		commitIds: [...new Set([...receipt.commitIds, ...child.commitIds])],
		turns: receipt.turns + child.turns,
		costUsd: receipt.costUsd + child.costUsd,
		inputTokens: receipt.inputTokens + child.inputTokens,
		outputTokens: receipt.outputTokens + child.outputTokens,
		cacheReadTokens: receipt.cacheReadTokens + child.cacheReadTokens,
		cor: receipt.inputTokens + receipt.cacheReadTokens + child.inputTokens + child.cacheReadTokens === 0 ? 0 : (receipt.cor * (receipt.inputTokens + receipt.cacheReadTokens) + child.cor * (child.inputTokens + child.cacheReadTokens)) / (receipt.inputTokens + receipt.cacheReadTokens + child.inputTokens + child.cacheReadTokens),
		usageStatus: receipt.usageStatus === "measured" && child.usageStatus === "measured" ? "measured" : "unavailable",
		...(childDependency === undefined ? {} : { childDependency: ChildDependencySummarySchema.parse(childDependency) }),
	});
}
function artifactJson(
	store: ContextArtifactStore,
	value: unknown,
	sourceRevision: string,
	kind: ImmutableArtifactReference["kind"],
	namespace: string = kind,
) {
	return store.putJson(value, { namespace, kind, sensitivity: "internal", sourceRevision });
}

/** Compute the same immutable identity as putJson without touching storage.
 * This lets the terminal event carry causal result/receipt identities while
 * deliberately omitting its own trace identity. */
function artifactJsonReference(
	store: ContextArtifactStore,
	value: unknown,
	sourceRevision: string,
	kind: ImmutableArtifactReference["kind"],
	namespace: string = kind,
): ImmutableArtifactReference {
	const bytes = Buffer.from(`${stableStringify(value)}\n`, "utf8");
	return store.reference(bytes, { namespace, kind, mediaType: "application/json", sensitivity: "internal", sourceRevision });
}

function providerChangedPaths(facts: SequentialExecutionFacts): string[] {
	const paths = facts.combine?.changedPaths ?? facts.finalizations.flatMap((item) => item.changedPaths);
	return [...new Set(paths)].sort().slice(0, CHILD_MAX_ITEMS);
}

function providerDeletedPaths(facts: SequentialExecutionFacts): Set<string> {
	const deleted = facts.combine?.deletedFiles ?? facts.finalizations.flatMap((item) => item.deletedFiles ?? []);
	return new Set(deleted);
}

function terminalChildResult(
	facts: SequentialExecutionFacts,
	parentTaskId: string,
	childTaskId: string,
	child: TaskReceipt,
	verificationReference: ImmutableArtifactReference,
): ChildResult {
	const status = terminalStatus(child);
	const changedPaths = providerChangedPaths(facts).map((path) => ({
		path,
		change: providerDeletedPaths(facts).has(path) ? "deleted" as const : "modified" as const,
		evidenceReferences: [verificationReference],
	}));
	if (child.filesChanged > 0 && changedPaths.length === 0)
		throw new Error("provider reported changed work without changed-path evidence");
	if (facts.verification === undefined || facts.verification.evidence === undefined)
		throw new Error("verification provider did not return structural evidence");
	return ChildResultSchema.parse({
		version: 1,
		parentTaskId,
		childTaskId,
		status,
		summary: status === "completed" ? "child accepted" : "child did not ship",
		requirementState: [],
		changedPaths,
		verification: {
			status: facts.verification.passed ? "passed" : "failed",
			evidenceReferences: [verificationReference],
		},
		artifactReferences: [verificationReference],
	});
}

function fallbackReceipt(taskId: string): TaskReceipt {
	return { taskId, verdict: "failed", filesChanged: 0, commitIds: [], turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cor: 0, bundleHit: null, usageStatus: "unavailable" };
}
function capabilityIdentity(capability: { identity?: string; capabilityIdentity?: string }): string | undefined {
	return capability.identity ?? capability.capabilityIdentity;
}
function capabilityVersion(capability: { version?: string; capabilityVersion?: string }): string | undefined {
	return capability.version ?? capability.capabilityVersion;
}

const IngressConfigSchema = z.object({
	version: z.literal(1),
	parentTaskId: z.string().min(1), childTaskId: z.string().min(1),
	modelIdentity: z.string().min(1), sourceRevision: z.string().min(1),
	capabilityIdentity: z.string().min(1), capabilityVersion: z.string().min(1),
	handoffReference: ImmutableArtifactReferenceSchema,
	checkpointReference: ImmutableArtifactReferenceSchema,
	childSpecReference: ImmutableArtifactReferenceSchema,
	planReference: ImmutableArtifactReferenceSchema,
}).strict();
type IngressConfig = z.infer<typeof IngressConfigSchema>;

class DurableDependencyError extends Error {
	readonly code: SequentialFailureCode;
	constructor(code: SequentialFailureCode, message: string) {
		super(message);
		this.name = "DurableDependencyError";
		this.code = code;
	}
}
function equalReference(left: ImmutableArtifactReference, right: ImmutableArtifactReference): boolean {
	return stableStringify(left) === stableStringify(right);
}
function readArtifact(store: ContextArtifactStore, reference: ImmutableArtifactReference, label: string, missingCode: SequentialFailureCode = "missing"): Buffer {
	const checked = ImmutableArtifactReferenceSchema.parse(reference);
	const result = store.read(checked);
	if (result.status === "absent" || result.status === "invalidated") throw new DurableDependencyError(missingCode, `${label} is missing`);
	if (result.status === "corrupt") throw new DurableDependencyError("corrupt", `${label} is corrupt: ${result.error}`);
	return result.bytes;
}
function parseJson<T>(store: ContextArtifactStore, reference: ImmutableArtifactReference, label: string, parse: (value: unknown) => T, missingCode?: SequentialFailureCode): T {
	let value: unknown;
	try { value = JSON.parse(readArtifact(store, reference, label, missingCode).toString("utf8")); }
	catch (error) {
		if (error instanceof DurableDependencyError) throw error;
		throw new DurableDependencyError("corrupt", `${label} is not valid JSON`);
	}
	try { return parse(value); }
	catch { throw new DurableDependencyError("corrupt", `${label} has an invalid schema`); }
}

/** Prepare parent acceptance and leave exactly one durable, unclaimed child. */
export async function prepareSequentialChild(options: RunSequentialTaskOptions): Promise<SequentialPrepareResult> {
	assertNoMaxCostUsd(options.maxCostUsd);
	const parentSpec = parseTaskSpec(options.parentSpecMarkdown);
	const childSpec = parseTaskSpec(options.childSpecMarkdown);
	const requestedParentTaskId = options.parentTaskId ?? id("seq");
	const requestedChildTaskId = options.childTaskId ?? id("child");
	const requestedEdgeId = options.edgeId ?? id("edge");
	const ledger = new LedgerStore(options.dbPath);
	const gateway = options.gateway ?? new InMemoryTaskGateway({ store: ledger });
	try {
		// Reuse the durable owner when a retry supplies any stable library
		// identity. This keeps explicit retries from accidentally pairing a
		// previous edge with freshly generated parent/child ids.
		const ownerByEdge = ledger.getChildPreparationOwnershipByEdge(requestedEdgeId);
		const ownerByParent = options.parentTaskId === undefined
			? null
			: ledger.getActiveChildPreparationOwnershipByParent(options.parentTaskId);
		const existingOwner = ownerByEdge ?? ownerByParent;
		if (existingOwner !== null &&
			(options.parentTaskId !== undefined && options.parentTaskId !== existingOwner.parentTaskId ||
			 options.childTaskId !== undefined && options.childTaskId !== existingOwner.plannedChildTaskId ||
			 options.edgeId !== undefined && options.edgeId !== existingOwner.edgeId))
			throw new Error("sequential retry identity conflicts with durable preparation");
		const parentTaskId = existingOwner?.parentTaskId ?? requestedParentTaskId;
		const childTaskId = existingOwner?.plannedChildTaskId ?? requestedChildTaskId;
		const edgeId = existingOwner?.edgeId ?? requestedEdgeId;
		// Reserve ownership before the parent session starts. The reservation is
		// the recovery boundary: an accepted parent can never look standalone
		// merely because the process died before child rows were attached.
		if (!ledger.getTask(parentTaskId)) ledger.insertTask({ id: parentTaskId, goal: parentSpec.goal });
		let continuationCapability: ReturnType<typeof workspaceContinuationOf> | undefined;
		let providerError: unknown;
		try { continuationCapability = workspaceContinuationOf(options.workspaceDriver); }
		catch (error) { providerError = error; }
		const reservedProviderIdentity = capabilityIdentity(continuationCapability ?? {}) ?? "unavailable";
		const reservedProviderVersion = capabilityVersion(continuationCapability ?? {}) ?? "unavailable";
		const preparationId = existingOwner?.preparationId ?? id("prep");
		const owner = ledger.persistChildPreparationOwner({
			preparationId, edgeId, parentTaskId, plannedChildTaskId: childTaskId,
			driver: options.workspaceDriver.name, capabilityIdentity: reservedProviderIdentity,
			capabilityVersion: reservedProviderVersion,
		});
		const existingEdge = ledger.getTaskEdge(owner.edgeId);
		if (owner.status === "blocked") {
			return { parent: fallbackReceipt(owner.parentTaskId), parentTaskId: owner.parentTaskId, childTaskId: owner.plannedChildTaskId, edgeId: owner.edgeId, status: "blocked", failureCode: "provider_error" };
		}
		if (existingEdge !== null && (existingEdge.status === "delivery_pending" || ["completed", "failed", "escalated"].includes(existingEdge.status))) {
			const durableParent = owner.parentReceiptJson === null
				? fallbackReceipt(owner.parentTaskId)
				: TaskReceiptSchema.parse(JSON.parse(owner.parentReceiptJson));
			return { parent: durableParent, parentTaskId: owner.parentTaskId, childTaskId: owner.plannedChildTaskId, edgeId: owner.edgeId, status: existingEdge.status as "completed" | "failed" | "escalated" | "delivery_pending" };
		}
		let parentReceipt: TaskReceipt;
		let parentRevision: string;
		if (owner.status === "parent_pending") {
			// Mark execution before the provider/session boundary. If the process
			// disappears before acceptance is recorded, the next invocation sees
			// this fence and blocks instead of replaying the parent.
			const hadPriorParentSession = ledger.listSessions(parentTaskId).length > 0;
			const executionClaim = ledger.beginChildParentExecution(preparationId);
			if (!executionClaim.acquired) {
				// A pre-existing marker/session belongs to an earlier process and is
				// not safe to execute again. This also fences databases created by
				// the pre-hardening implementation. A losing concurrent caller does
				// not block the winner; it observes preparation ownership instead.
				if (owner.parentExecutionStartedAt !== null || hadPriorParentSession) {
					ledger.blockChildPreparation(preparationId);
					return { parent: fallbackReceipt(parentTaskId), parentTaskId, childTaskId, edgeId, status: "blocked", failureCode: "provider_error" };
				}
				return { parent: fallbackReceipt(parentTaskId), parentTaskId, childTaskId, edgeId, status: "preparing", failureCode: "provider_error" };
			}
			const parent = await runIsolatedTask({
				specMarkdown: options.parentSpecMarkdown, projectDir: options.projectDir,
				artifactsDir: options.artifactsDir, dbPath: options.dbPath, model: options.model,
				workspaceDriver: options.workspaceDriver,
				...(options.environmentDriver === undefined ? {} : { environmentDriver: options.environmentDriver }),
				...(options.host === undefined ? {} : { host: options.host }), gateway,
				...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
				...(options.sessionTimeoutMs === undefined ? {} : { sessionTimeoutMs: options.sessionTimeoutMs }),
				...(options.contextCapabilitiesFactory === undefined ? {} : { contextCapabilitiesFactory: options.contextCapabilitiesFactory }),
				...(options.contextArtifactStore === undefined ? {} : { contextArtifactStore: options.contextArtifactStore }),
				...(options.onContextEvent === undefined ? {} : { onContextEvent: options.onContextEvent }),
				...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
				taskId: parentTaskId, reuseExistingTask: true, deferSuccessfulTerminal: true,
				onAccepted: ({ receipt, revision }) => {
					ledger.recordChildParentAcceptance(preparationId, JSON.stringify(receipt), revision);
				},
			});
			if (parent.receipt.verdict !== "ship") {
				ledger.blockChildPreparation(preparationId);
				return { parent: parent.receipt, parentTaskId, childTaskId, status: parent.receipt.verdict === "escalate" ? "escalated" : "failed" };
			}
			parentReceipt = parent.receipt;
			parentRevision = parent.mergedCommitId ?? sha(parentTaskId).slice("sha256:".length);
			ledger.recordChildParentAcceptance(preparationId, JSON.stringify(parentReceipt), parentRevision);
		} else {
			if (!owner.parentReceiptJson || !owner.parentRevision) {
				ledger.blockChildPreparation(preparationId);
				return { parent: fallbackReceipt(parentTaskId), parentTaskId, childTaskId, edgeId, status: "blocked", failureCode: "missing" };
			}
			try {
				parentReceipt = TaskReceiptSchema.parse(JSON.parse(owner.parentReceiptJson));
			} catch {
				ledger.blockChildPreparation(preparationId);
				return { parent: fallbackReceipt(parentTaskId), parentTaskId, childTaskId, edgeId, status: "blocked", failureCode: "corrupt" };
			}
			parentRevision = owner.parentRevision;
		}
		const parent = { receipt: parentReceipt, mergedCommitId: parentRevision };
		if (!continuationCapability || providerError !== undefined) {
			const sourceRevision = sha(parentRevision);
			const plan = planContext({ goal: childSpec.goal, requirements: childSpec.requirements, candidates: [], sourceRevision: parentRevision, modelId: options.model, toolSchemaIdentity: "sequential-child", mode: "raw" });
			ledger.beginChildArtifactPersistence(preparationId);
			const planRef = options.artifactStore.putJson(plan, { namespace: "plan", kind: "plan", sensitivity: "internal", sourceRevision: parentRevision });
			const checkpointRef = persistWorkingCheckpoint(options.artifactStore, createWorkingCheckpoint({ epochId: "parent-handoff", workspaceRevision: parentRevision, plan: planRef, requirements: [], verification: { status: "passed" }, summary: { nextActions: ["select a continuation-capable workspace provider"] } }));
			const handoffRef = artifactJson(options.artifactStore, buildChildHandoff({ version: 1, parentTaskId, childTaskId, relationship: "continuation", checkpointId: checkpointRef.id, planId: planRef.id, sourceRevision, requirementState: [], decisions: [], openQuestions: ["workspace continuation provider unavailable"], nextActions: ["select a continuation-capable workspace provider"], changedPaths: [], artifactReferences: [], verification: { status: "passed", evidenceReferences: [] } }), parentRevision, "handoff");
			const edge = ledger.persistBlockedChildIntent({ edgeId, parentTaskId, childTaskId, ordinal: 1, handoffArtifactId: handoffRef.id, checkpointArtifactId: checkpointRef.id, preparationId, childGoal: childSpec.goal });
			ledger.blockChild(edge.edgeId);
			return { parent: parentOutcome(parent.receipt, "blocked"), parentTaskId, childTaskId, edgeId, status: "blocked", failureCode: providerError !== undefined && isWorkspaceContinuationError(providerError) ? providerError.code : "provider_error" };
		}
		const providerIdentity = capabilityIdentity(continuationCapability);
		const providerVersion = capabilityVersion(continuationCapability);
		if (!providerIdentity || !providerVersion) {
			throw new Error("continuation provider identity is incomplete");
		}

		// Build a complete, bounded manifest before provider mutation. If the
		// provider observes a different revision the same manifest is rebuilt
		// and replaced in the completion transaction.
		const buildArtifacts = (workspaceRevision: string) => {
			const sourceRevision = sha(workspaceRevision);
			const plan = planContext({ goal: childSpec.goal, requirements: childSpec.requirements, candidates: [], sourceRevision: workspaceRevision, modelId: options.model, toolSchemaIdentity: "sequential-child", mode: "raw" });
			const planRef = options.artifactStore.putJson(plan, { namespace: "plan", kind: "plan", sensitivity: "internal", sourceRevision: workspaceRevision });
			// This checkpoint belongs to the child execution epoch. Parent
			// acceptance is represented by the handoff decision, not by marking
			// unrelated child requirements satisfied.
			const checkpoint = createWorkingCheckpoint({ epochId: "child-handoff", workspaceRevision, plan: planRef, requirements: childSpec.requirements.map((_, index) => ({ id: `r${index + 1}`, status: "open" as const })), verification: { status: "unknown" }, summary: { nextActions: ["continue accepted parent work"] } });
			const checkpointRef = persistWorkingCheckpoint(options.artifactStore, checkpoint);
			const handoff: ChildHandoff = buildChildHandoff({ version: 1, parentTaskId, childTaskId, relationship: "continuation", checkpointId: checkpointRef.id, planId: planRef.id, sourceRevision, requirementState: childSpec.requirements.map((_, index) => ({ id: `r${index + 1}`, status: "pending" as const, summary: "child requirement pending" })), decisions: ["parent verification and acceptance passed"], openQuestions: [], nextActions: ["execute direct continuation"], changedPaths: [], artifactReferences: [], verification: { status: "passed", evidenceReferences: [] } });
			const handoffRef = artifactJson(options.artifactStore, handoff, workspaceRevision, "handoff");
			const childSpecRef = artifactJson(options.artifactStore, { version: 1, kind: "sequential-child-spec", markdown: options.childSpecMarkdown }, workspaceRevision, "context", "context");
			const parentReceiptRef = artifactJson(options.artifactStore, parent.receipt, workspaceRevision, "receipt");
			const ingressConfigValue: IngressConfig = { version: 1, parentTaskId, childTaskId, modelIdentity: options.model, sourceRevision: workspaceRevision, capabilityIdentity: providerIdentity!, capabilityVersion: providerVersion!, handoffReference: handoffRef, checkpointReference: checkpointRef, childSpecReference: childSpecRef, planReference: planRef };
			const ingressConfigRef = artifactJson(options.artifactStore, ingressConfigValue, workspaceRevision, "context", "context");
			const config: SequentialEdgeConfig = { edgeId, handoffReference: handoffRef, checkpointReference: checkpointRef, childSpecReference: childSpecRef, planReference: planRef, ingressConfigReference: ingressConfigRef, parentReceiptReference: parentReceiptRef, modelIdentity: options.model, sourceRevision: workspaceRevision, capabilityIdentity: providerIdentity!, capabilityVersion: providerVersion! };
			return { plan, planRef, checkpointRef, handoffRef, childSpecRef, parentReceiptRef, ingressConfigRef, config };
		};
		ledger.beginChildArtifactPersistence(preparationId);
		const initial = buildArtifacts(parentRevision);
		ledger.persistPreparingChildIntent({ edgeId, parentTaskId, childTaskId, childGoal: childSpec.goal, ordinal: 1, handoffArtifactId: initial.handoffRef.id, checkpointArtifactId: initial.checkpointRef.id, artifacts: [
			{ role: "plan", artifactId: initial.planRef.id, mediaType: initial.planRef.mediaType, reference: initial.planRef },
			{ role: "child-spec", artifactId: initial.childSpecRef.id, mediaType: initial.childSpecRef.mediaType, reference: initial.childSpecRef },
			{ role: "ingress-config", artifactId: initial.ingressConfigRef.id, mediaType: initial.ingressConfigRef.mediaType, reference: initial.ingressConfigRef },
			{ role: "parent-receipt", artifactId: initial.parentReceiptRef.id, mediaType: initial.parentReceiptRef.mediaType, reference: initial.parentReceiptRef },
		], sequentialConfig: initial.config, preparationId, preparationDriver: options.workspaceDriver.name, preparationCapabilityIdentity: providerIdentity, preparationCapabilityVersion: providerVersion });
		if (options.deferProviderPreparation === true)
			return { parent: parent.receipt, parentTaskId, childTaskId, edgeId, status: "preparing" };

		try {
			let prepared: { context: WorkspaceContext; continuation: { opaqueToken: string; revision: string } };
			if (continuationCapability.prepareContinuation) prepared = await continuationCapability.prepareContinuation(childTaskId, preparationId);
			else {
				const context = await options.workspaceDriver.createWorkspace(childTaskId);
				prepared = { context, continuation: await continuationCapability.preserveContinuation(context) };
			}
			const final = prepared.continuation.revision === parentRevision ? initial : buildArtifacts(prepared.continuation.revision);
			const continuationId = `cont-${edgeId}`;
			ledger.completeChildPreparation(edgeId, { id: `${childTaskId}-workspace`, driver: options.workspaceDriver.name, ...prepared.context }, { id: continuationId, taskId: childTaskId, driver: options.workspaceDriver.name, providerVersion, capabilityIdentity: providerIdentity, capabilityVersion: providerVersion, opaqueToken: prepared.continuation.opaqueToken, revision: prepared.continuation.revision }, final.config);
			gateway.emit({ type: "child.queued", taskId: parentTaskId, detail: { parentTaskId, childTaskId, relationship: "continuation", ordinal: 1, handoffArtifactId: final.handoffRef.id, checkpointArtifactId: final.checkpointRef.id, status: "ready" } });
			return { parent: parent.receipt, parentTaskId, childTaskId, edgeId, status: "ready" };
		} catch (error) {
			ledger.blockChild(edgeId);
			const code = isWorkspaceContinuationError(error) ? error.code : "provider_error";
			return { parent: parentOutcome(parent.receipt, "blocked"), parentTaskId, childTaskId, edgeId, status: "blocked", failureCode: code as SequentialFailureCode };
		}
	} finally { ledger.close(); }
}

function blockedResult(edge: NonNullable<ReturnType<LedgerStore["getTaskEdge"]>>, code: SequentialFailureCode, parent?: TaskReceipt): SequentialRunResult {
	return { parent: parentOutcome(parent ?? fallbackReceipt(edge.parentTaskId), "blocked"), parentTaskId: edge.parentTaskId, childTaskId: edge.childTaskId ?? "unknown", edgeId: edge.edgeId, status: "blocked", failureCode: code };
}

/** Compatibility spelling for daemon callers that name the first phase a task. */
export const prepareSequentialTask = prepareSequentialChild;

/** Resume a ready (or boot-reclassified resumable) edge without replaying its parent. */
export async function resumeSequentialChild(edgeId: string, runtime: SequentialRuntimeDependencies): Promise<SequentialRunResult> {
	assertNoMaxCostUsd(runtime.maxCostUsd);
	const ledger = new LedgerStore(runtime.dbPath);
	const gateway = runtime.gateway ?? new InMemoryTaskGateway({ store: ledger });
	const deliveryPolicy = runtime.deliveryPolicy ?? "canonical";
	try {
		const edge = ledger.getTaskEdge(edgeId);
		if (!edge || edge.childTaskId === null) {
			const missing = fallbackReceipt("unknown-parent");
			return { parent: missing, childTaskId: "unknown-child", parentTaskId: "unknown-parent", edgeId, status: "blocked", failureCode: "missing" };
		}
		const childTaskId = edge.childTaskId;
		// A terminal outbox owns this edge once terminal evidence construction has
		// begun. Replay only immutable writes and linkage; never validate/resume a
		// provider or create another child session on this path.
		const pendingTerminal = ledger.getChildTerminalSettlement(edgeId);
		if (pendingTerminal !== null) {
			const recoverTerminal = (): SequentialRunResult => {
				try {
					const write = (value: unknown, reference: ImmutableArtifactReference): ImmutableArtifactReference => {
						const actual = runtime.artifactStore.putJson(value, { namespace: reference.namespace, kind: reference.kind, sensitivity: reference.sensitivity, sourceRevision: reference.sourceRevision, mediaType: reference.mediaType });
						if (!equalReference(actual, reference)) throw new Error("terminal evidence identity changed during replay");
						return actual;
					};
					write(pendingTerminal.verification, pendingTerminal.verificationReference);
					write(pendingTerminal.result, pendingTerminal.resultReference);
					write(pendingTerminal.receipt, pendingTerminal.receiptReference);
					write(pendingTerminal.trace, pendingTerminal.traceReference);
					write(pendingTerminal.parentReceipt, pendingTerminal.parentReceiptReference);
					write(pendingTerminal.parentTrace, pendingTerminal.parentTraceReference);
					if (pendingTerminal.state === "pending") ledger.settleChild(edgeId, pendingTerminal.childStatus, {
						verificationArtifactId: pendingTerminal.verificationReference.id, resultArtifactId: pendingTerminal.resultReference.id, receiptArtifactId: pendingTerminal.receiptReference.id, traceArtifactId: pendingTerminal.traceReference.id,
						verificationReference: pendingTerminal.verificationReference,
						parentReceiptArtifactId: pendingTerminal.parentReceiptReference.id, parentTraceArtifactId: pendingTerminal.parentTraceReference.id,
						resultReference: pendingTerminal.resultReference, receiptReference: pendingTerminal.receiptReference, traceReference: pendingTerminal.traceReference,
						parentReceiptReference: pendingTerminal.parentReceiptReference, parentTraceReference: pendingTerminal.parentTraceReference,
					}, { deliveryAcknowledged: false });
					const parent = TaskReceiptSchema.parse(pendingTerminal.parentReceipt);
					const child = TaskReceiptSchema.parse(pendingTerminal.receipt);
					if (deliveryPolicy === "canonical") {
						ledger.acknowledgeChildDeliveryStep(edgeId, "receipt");
						ledger.acknowledgeChildDeliveryStep(edgeId, "trace");
						ledger.acknowledgeChildDeliveryStep(edgeId, "final_receipt");
						return { parent, child, parentTaskId: edge.parentTaskId, childTaskId, edgeId, status: pendingTerminal.childStatus };
					}
					return { parent: parentOutcome(parent, "delivery_pending", child), child, parentTaskId: edge.parentTaskId, childTaskId, edgeId, status: "delivery_pending", failureCode: "delivery_failed" };
				} catch {
					const parent = (() => { try { return TaskReceiptSchema.parse(pendingTerminal.parentReceipt); } catch { return fallbackReceipt(edge.parentTaskId); } })();
					const child = (() => { try { return TaskReceiptSchema.parse(pendingTerminal.receipt); } catch { return undefined; } })();
					return { parent: parentOutcome(parent, "resumable"), ...(child === undefined ? {} : { child }), parentTaskId: edge.parentTaskId, childTaskId, edgeId, status: "resumable", failureCode: "provider_error" };
				}
			};
			return recoverTerminal();
		}
		const facts: SequentialExecutionFacts = { finalizations: [] };
		const stream = new SequentialEvidenceStream(edge.parentTaskId, childTaskId, gateway);
		const workspaceDriver = evidenceDriver(runtime.workspaceDriver, facts);
		let config: SequentialEdgeConfig | null;
		try { config = ledger.getSequentialEdgeConfig(edgeId); }
		catch { return blockedResult(edge, "corrupt"); }
		if (config === null) return blockedResult(edge, "missing");
		// Validate all runtime identities before reading executable child inputs or
		// allowing a provider resume. A mismatch is durably blocked, never spawned.
		let runtimeCapability: ReturnType<typeof workspaceContinuationOf> | undefined;
		try { runtimeCapability = workspaceContinuationOf(workspaceDriver); }
		catch { /* converted to the stable incompatible disposition below */ }
		const runtimeIdentity = capabilityIdentity(runtimeCapability ?? {});
		const runtimeVersion = capabilityVersion(runtimeCapability ?? {});
		const continuation = edge.workspaceContinuationId === null
			? null
			: ledger.getWorkspaceContinuation(edge.workspaceContinuationId);
		const preparation = edge.status === "preparing" ? ledger.getChildPreparation(edgeId) : null;
		const identityMismatch = config.modelIdentity !== runtime.model ||
			runtimeIdentity !== config.capabilityIdentity ||
			runtimeVersion !== config.capabilityVersion ||
			(continuation !== null && (continuation.driver !== workspaceDriver.name ||
				continuation.capabilityIdentity !== runtimeIdentity ||
				continuation.capabilityVersion !== runtimeVersion)) ||
			(preparation !== null && (preparation.driver !== workspaceDriver.name ||
				preparation.capabilityIdentity !== config.capabilityIdentity ||
				preparation.capabilityVersion !== config.capabilityVersion));
		if (identityMismatch) {
			ledger.blockChild(edgeId);
			return blockedResult(edge, "incompatible");
		}
		let parentReceipt: TaskReceipt | undefined;
		try {
			parentReceipt = parseJson(runtime.artifactStore, config.parentReceiptReference, "parent receipt", (value) => TaskReceiptSchema.parse(value));
		} catch (error) {
			const code = error instanceof DurableDependencyError ? error.code : "corrupt";
			if (["ready", "resumable", "claimed"].includes(edge.status)) ledger.blockChild(edgeId);
			return blockedResult(edge, code, parentReceipt);
		}
		if (edge.status === "preparing") {
			const preparation = ledger.getChildPreparation(edgeId);
			try {
				if (!preparation || preparation.driver !== workspaceDriver.name)
					throw new DurableDependencyError("incompatible", "child preparation owner is missing");
				const capability = workspaceContinuationOf(workspaceDriver);
				if (!capability.prepareContinuation)
					throw new DurableDependencyError("unsupported", "provider cannot reconcile a preparing child");
				const prepared = await capability.prepareContinuation(childTaskId, preparation.preparationId);
				if (prepared.continuation.revision !== config.sourceRevision) {
					const workspaceRevision = prepared.continuation.revision;
					const sourceRevision = sha(workspaceRevision);
					const oldHandoff = parseJson(runtime.artifactStore, config.handoffReference, "preparing handoff", (value) => buildChildHandoff(value));
					const oldCheckpoint = loadWorkingCheckpoint(runtime.artifactStore, config.checkpointReference);
					if (!oldCheckpoint) throw new DurableDependencyError("checkpoint_missing", "preparing checkpoint is missing");
					const specRecord = parseJson(runtime.artifactStore, config.childSpecReference, "preparing child spec", (value) => z.object({ version: z.literal(1), kind: z.literal("sequential-child-spec"), markdown: z.string().min(1) }).strict().parse(value));
					const parsedChild = parseTaskSpec(specRecord.markdown);
					const nextPlan = planContext({ goal: parsedChild.goal, requirements: parsedChild.requirements, candidates: [], sourceRevision: workspaceRevision, modelId: runtime.model, toolSchemaIdentity: "sequential-child", mode: "raw" });
					const planRef = runtime.artifactStore.putJson(nextPlan, { namespace: "plan", kind: "plan", sensitivity: "internal", sourceRevision: workspaceRevision });
					const checkpointRef = persistWorkingCheckpoint(runtime.artifactStore, createWorkingCheckpoint({ epochId: oldCheckpoint.epochId, workspaceRevision, plan: planRef, requirements: oldCheckpoint.requirements, verification: oldCheckpoint.verification, summary: oldCheckpoint.summary }));
					const handoffRef = artifactJson(runtime.artifactStore, buildChildHandoff({ version: 1, parentTaskId: edge.parentTaskId, childTaskId, relationship: "continuation", checkpointId: checkpointRef.id, planId: planRef.id, sourceRevision, requirementState: oldHandoff.requirementState, decisions: oldHandoff.decisions, openQuestions: oldHandoff.openQuestions, nextActions: oldHandoff.nextActions, changedPaths: oldHandoff.changedPaths, artifactReferences: oldHandoff.artifactReferences, verification: oldHandoff.verification }), workspaceRevision, "handoff");
					const childSpecRef = artifactJson(runtime.artifactStore, specRecord, workspaceRevision, "context", "context");
					const parentReceiptRef = artifactJson(runtime.artifactStore, parentReceipt, workspaceRevision, "receipt");
					const ingress: IngressConfig = { version: 1, parentTaskId: edge.parentTaskId, childTaskId, modelIdentity: runtime.model, sourceRevision: workspaceRevision, capabilityIdentity: preparation.capabilityIdentity, capabilityVersion: preparation.capabilityVersion, handoffReference: handoffRef, checkpointReference: checkpointRef, childSpecReference: childSpecRef, planReference: planRef };
					const ingressConfigRef = artifactJson(runtime.artifactStore, ingress, workspaceRevision, "context", "context");
					config = { edgeId, handoffReference: handoffRef, checkpointReference: checkpointRef, childSpecReference: childSpecRef, planReference: planRef, ingressConfigReference: ingressConfigRef, parentReceiptReference: parentReceiptRef, modelIdentity: runtime.model, sourceRevision: workspaceRevision, capabilityIdentity: preparation.capabilityIdentity, capabilityVersion: preparation.capabilityVersion };
				}
				ledger.completeChildPreparation(edgeId, { id: `${childTaskId}-workspace`, driver: workspaceDriver.name, ...prepared.context }, { id: `cont-${edgeId}`, taskId: childTaskId, driver: workspaceDriver.name, providerVersion: preparation.capabilityVersion, capabilityIdentity: preparation.capabilityIdentity, capabilityVersion: preparation.capabilityVersion, opaqueToken: prepared.continuation.opaqueToken, revision: prepared.continuation.revision }, config);
			} catch (error) {
				ledger.blockChild(edgeId);
				const code = isWorkspaceContinuationError(error) ? error.code : "provider_error";
				return blockedResult(edge, code as SequentialFailureCode, parentReceipt);
			}
			return resumeSequentialChild(edgeId, runtime);
		}
		if (edge.status === "blocked") return blockedResult(edge, "incompatible", parentReceipt);
		if (["completed", "failed", "escalated"].includes(edge.status)) {
			const childRefs = ledger.listTaskArtifacts(edge.childTaskId);
			const childRef = childRefs.find((ref) => ref.role === "receipt" && ref.reference)?.reference;
			const childTraceRef = childRefs.find((ref) => ref.role === "trace" && ref.reference)?.reference;
			const child = childRef ? parseJson(runtime.artifactStore, childRef, "child receipt", (value) => TaskReceiptSchema.parse(value)) : undefined;
			const childDependency = child !== undefined && childRef !== undefined && childTraceRef !== undefined
				? ChildDependencySummarySchema.parse({ childTaskId: edge.childTaskId, edgeId, verdict: child.verdict, receiptReference: childRef, traceReference: childTraceRef })
				: undefined;
			const aggregateRef = ledger.listTaskArtifacts(edge.parentTaskId)
				.find((ref) => ref.role === "receipt" && ref.reference)?.reference;
			const status = edge.status as "completed" | "failed" | "escalated";
			const aggregate = aggregateRef
				? parseJson(runtime.artifactStore, aggregateRef, "parent receipt", (value) => TaskReceiptSchema.parse(value))
				: parentOutcome(parentReceipt, status, child, childDependency);
			return { parent: aggregate, ...(child === undefined ? {} : { child }), parentTaskId: edge.parentTaskId, childTaskId: edge.childTaskId, edgeId, status };
		}
		if (edge.status === "claimed") return blockedResult(edge, "incompatible", parentReceipt);

		let handoff: ChildHandoff; let checkpoint: ReturnType<typeof loadWorkingCheckpoint>; let childSpecMarkdown: string; let plan: ContextPlan; let continuationRow: NonNullable<ReturnType<LedgerStore["getWorkspaceContinuation"]>>;
		try {
			if (config.edgeId !== edgeId || config.modelIdentity !== runtime.model)
				throw new DurableDependencyError("incompatible", "edge ingress configuration does not match runtime model");
			const ingress = parseJson(runtime.artifactStore, config.ingressConfigReference, "ingress config", (value) => IngressConfigSchema.parse(value));
			if (ingress.parentTaskId !== edge.parentTaskId || ingress.childTaskId !== edge.childTaskId || ingress.modelIdentity !== config.modelIdentity || ingress.sourceRevision !== config.sourceRevision || ingress.capabilityIdentity !== config.capabilityIdentity || ingress.capabilityVersion !== config.capabilityVersion ||
				!equalReference(ingress.handoffReference, config.handoffReference) || !equalReference(ingress.checkpointReference, config.checkpointReference) || !equalReference(ingress.childSpecReference, config.childSpecReference) || !equalReference(ingress.planReference, config.planReference))
				throw new DurableDependencyError("incompatible", "ingress config references do not match the durable manifest");
			const manifestReferences = [config.handoffReference, config.checkpointReference, config.childSpecReference, config.planReference, config.ingressConfigReference, config.parentReceiptReference];
			if (manifestReferences.some((reference) => reference.sourceRevision !== config.sourceRevision))
				throw new DurableDependencyError("revision_mismatch", "ingress artifact source revisions disagree");
			const handoffRef = config.handoffReference;
			if (handoffRef.namespace !== "handoff" || handoffRef.kind !== "handoff") throw new DurableDependencyError("incompatible", "handoff reference kind is incompatible");
			handoff = parseJson(runtime.artifactStore, handoffRef, "handoff", (value) => buildChildHandoff(value), "handoff_invalid");
			const checkpointRef = config.checkpointReference;
			checkpoint = (() => { try { return loadWorkingCheckpoint(runtime.artifactStore, checkpointRef); } catch { throw new DurableDependencyError("corrupt", "checkpoint schema is invalid"); } })();
			if (!checkpoint) throw new DurableDependencyError("checkpoint_missing", "checkpoint is missing");
			plan = parseJson(runtime.artifactStore, config.planReference, "plan", (value) => ContextPlanSchema.parse(value));
			const specRecord = parseJson(runtime.artifactStore, config.childSpecReference, "child spec", (value) => z.object({ version: z.literal(1), kind: z.literal("sequential-child-spec"), markdown: z.string().min(1) }).strict().parse(value));
			childSpecMarkdown = specRecord.markdown;
			const childSpec = parseTaskSpec(childSpecMarkdown);
			if (childSpec.goal !== ledger.getTask(edge.childTaskId)?.goal) throw new DurableDependencyError("incompatible", "child spec no longer matches child task");
			const parsedPlan = ContextPlanSchema.parse(plan);
			if (parsedPlan.sourceRevision !== checkpoint.workspaceRevision || parsedPlan.cache.modelId !== runtime.model || checkpoint.plan.id !== config.planReference.id || checkpoint.plan.sourceRevision !== parsedPlan.sourceRevision || config.sourceRevision !== checkpoint.workspaceRevision || handoff.parentTaskId !== edge.parentTaskId || handoff.childTaskId !== edge.childTaskId || handoff.checkpointId !== config.checkpointReference.id || handoff.planId !== config.planReference.id || handoff.sourceRevision !== sha(checkpoint.workspaceRevision))
				throw new DurableDependencyError("revision_mismatch", "checkpoint, plan, source, or handoff revisions disagree");
			continuationRow = ledger.getWorkspaceContinuation(edge.workspaceContinuationId ?? "") as typeof continuationRow;
			if (!continuationRow) throw new DurableDependencyError("missing", "workspace continuation is missing");
			const capability = workspaceContinuationOf(workspaceDriver);
			const identity = capabilityIdentity(capability); const version = capabilityVersion(capability);
			if (!identity || !version || identity !== config.capabilityIdentity || version !== config.capabilityVersion || continuationRow.driver !== workspaceDriver.name || continuationRow.capabilityIdentity !== identity || continuationRow.capabilityVersion !== version || continuationRow.providerVersion !== version || continuationRow.revision !== checkpoint.workspaceRevision) {
				throw new DurableDependencyError("incompatible", "workspace continuation capability is incompatible");
			}
		} catch (error) {
			const code = error instanceof DurableDependencyError ? error.code : "corrupt";
			if (["ready", "resumable", "claimed"].includes(edge.status)) ledger.blockChild(edgeId);
			return blockedResult(edge, code, parentReceipt);
		}

		const claimed = edge.status === "ready" ? ledger.claimReadyChild(edgeId) : ledger.claimResumableChild(edgeId);
		if (!claimed) return blockedResult(edge, "incompatible", parentReceipt);
		gateway.emit({ type: "child.claimed", taskId: edge.childTaskId, detail: { parentTaskId: edge.parentTaskId, childTaskId: edge.childTaskId, relationship: "continuation", ordinal: edge.ordinal, handoffArtifactId: edge.handoffArtifactId, checkpointArtifactId: config.checkpointReference.id, status: "claimed" } });
		let resumed: WorkspaceContext;
		try {
			const capability = workspaceContinuationOf(workspaceDriver);
			resumed = await capability.resumeContinuation(edge.childTaskId, { opaqueToken: continuationRow.opaqueToken, revision: continuationRow.revision });
		} catch (error) {
			ledger.blockChild(edgeId);
			const code = isWorkspaceContinuationError(error) ? error.code : "missing";
			return blockedResult(edge, code, parentReceipt);
		}
		gateway.emit({ type: "continuation.resumed", taskId: edge.childTaskId, detail: { parentTaskId: edge.parentTaskId, childTaskId: edge.childTaskId, relationship: "continuation", ordinal: edge.ordinal, handoffArtifactId: edge.handoffArtifactId, checkpointArtifactId: config.checkpointReference.id, status: "claimed" } });

		const preserveInterruptedChild = async (reason: string, childReceipt?: TaskReceipt): Promise<SequentialRunResult> => {
			try {
				const capability = workspaceContinuationOf(workspaceDriver);
				const nextContinuation = await capability.preserveContinuation(resumed);
				const workspaceRevision = nextContinuation.revision;
				const sourceRevision = sha(workspaceRevision);
				const parsedChild = parseTaskSpec(childSpecMarkdown);
				const nextPlan = planContext({ goal: parsedChild.goal, requirements: parsedChild.requirements, candidates: [], sourceRevision: workspaceRevision, modelId: runtime.model, toolSchemaIdentity: "sequential-child", mode: "raw" });
				const planRef = runtime.artifactStore.putJson(nextPlan, { namespace: "plan", kind: "plan", sensitivity: "internal", sourceRevision: workspaceRevision });
				const checkpointRef = persistWorkingCheckpoint(runtime.artifactStore, createWorkingCheckpoint({ epochId: `child-interruption-${edgeId}`, workspaceRevision, plan: planRef, requirements: checkpoint!.requirements, verification: { status: "unknown" }, summary: { nextActions: ["resume interrupted child from preserved workspace", `interruption: ${reason}`] } }));
				const nextHandoff = buildChildHandoff({ version: 1, parentTaskId: edge.parentTaskId, childTaskId, relationship: "continuation", checkpointId: checkpointRef.id, planId: planRef.id, sourceRevision, requirementState: handoff.requirementState, decisions: handoff.decisions, openQuestions: handoff.openQuestions, nextActions: ["resume interrupted child from preserved workspace"], changedPaths: handoff.changedPaths, artifactReferences: handoff.artifactReferences, verification: { status: "not-run", evidenceReferences: handoff.verification.evidenceReferences } });
				const handoffRef = artifactJson(runtime.artifactStore, nextHandoff, workspaceRevision, "handoff");
				const childSpecRef = artifactJson(runtime.artifactStore, { version: 1, kind: "sequential-child-spec", markdown: childSpecMarkdown }, workspaceRevision, "context", "context");
				const parentReceiptRef = artifactJson(runtime.artifactStore, parentReceipt, workspaceRevision, "receipt");
				const identity = capabilityIdentity(capability)!;
				const version = capabilityVersion(capability)!;
				const ingress: IngressConfig = { version: 1, parentTaskId: edge.parentTaskId, childTaskId, modelIdentity: runtime.model, sourceRevision: workspaceRevision, capabilityIdentity: identity, capabilityVersion: version, handoffReference: handoffRef, checkpointReference: checkpointRef, childSpecReference: childSpecRef, planReference: planRef };
				const ingressConfigRef = artifactJson(runtime.artifactStore, ingress, workspaceRevision, "context", "context");
				const nextConfig: SequentialEdgeConfig = { edgeId, handoffReference: handoffRef, checkpointReference: checkpointRef, childSpecReference: childSpecRef, planReference: planRef, ingressConfigReference: ingressConfigRef, parentReceiptReference: parentReceiptRef, modelIdentity: runtime.model, sourceRevision: workspaceRevision, capabilityIdentity: identity, capabilityVersion: version };
				ledger.updateResumableChild(edgeId, { id: continuationRow.id, taskId: childTaskId, driver: workspaceDriver.name, providerVersion: version, capabilityIdentity: identity, capabilityVersion: version, opaqueToken: nextContinuation.opaqueToken, revision: workspaceRevision }, nextConfig);
				const detail = { parentTaskId: edge.parentTaskId, childTaskId, relationship: "continuation" as const, ordinal: edge.ordinal, handoffArtifactId: handoffRef.id, checkpointArtifactId: checkpointRef.id, status: "resumable" as const };
				gateway.emit({ type: "continuation.checkpointed", taskId: childTaskId, detail });
				gateway.emit({ type: "child.resumable", taskId: childTaskId, detail });
				return { parent: parentOutcome(parentReceipt, "resumable"), ...(childReceipt === undefined ? {} : { child: childReceipt }), parentTaskId: edge.parentTaskId, childTaskId, edgeId, status: "resumable" };
			} catch (error) {
				// A failed refresh cannot leave a claimed edge for generic retry:
				// the provider may already own a changed workspace revision. Block
				// the edge durably and return a non-ship outcome instead of replaying
				// either the parent or the interrupted child.
				try { ledger.blockChild(edgeId); } catch { /* preserve the refresh failure */ }
				const code = isWorkspaceContinuationError(error)
					? error.code
					: error instanceof RangeError ? "corrupt" : "provider_error";
				return blockedResult(edge, code, parentReceipt);
			}
		};

		const sessionAttemptId = String(ledger.listSessions(childTaskId).length + 1);
		let child;
		try {
			child = await runIsolatedTask({
				specMarkdown: childSpecMarkdown, projectDir: runtime.projectDir, artifactsDir: runtime.artifactsDir, dbPath: runtime.dbPath, model: runtime.model, workspaceDriver,
				...(runtime.environmentDriver === undefined ? {} : { environmentDriver: runtime.environmentDriver }), ...(runtime.host === undefined ? {} : { host: runtime.host }), gateway,
				...(runtime.maxTurns === undefined ? {} : { maxTurns: runtime.maxTurns }),
				...(runtime.sessionTimeoutMs === undefined ? {} : { sessionTimeoutMs: runtime.sessionTimeoutMs }),
				...(runtime.contextCapabilitiesFactory === undefined ? {} : { contextCapabilitiesFactory: runtime.contextCapabilitiesFactory }),
				...(runtime.contextArtifactStore === undefined ? {} : { contextArtifactStore: runtime.contextArtifactStore }),
				...(runtime.onContextEvent === undefined ? {} : { onContextEvent: runtime.onContextEvent }),
				...(runtime.onEvent === undefined ? {} : { onEvent: runtime.onEvent }),
				taskId: childTaskId, reuseExistingTask: true, workspace: resumed,
				contextInput: { kind: "validated-resume", plan, checkpoint: checkpoint! },
				childHandoff: handoff, retainWorkspace: true, deferSuccessfulTerminal: true, sessionAttemptId,
			});
		} catch (error) {
			return await preserveInterruptedChild(error instanceof Error ? error.name : "session_error");
		}
		if (child.interruption !== undefined)
			return await preserveInterruptedChild(child.interruption.reason, child.receipt);
		const status = terminalStatus(child.receipt);
		facts.verification = stream.verification;
		const verificationFact = facts.verification;
		let terminalOutboxInstalled = false;
		try {
			if (verificationFact === undefined || verificationFact.evidence === undefined)
				throw new Error("verification provider did not return structural evidence");
			const verificationEvidence = VerificationEvidenceSchema.parse(verificationFact.evidence);
			const verification = { version: 1, passed: verificationFact.passed, evidence: verificationEvidence };
			const verificationRef = artifactJsonReference(runtime.artifactStore, verification, sha(config.sourceRevision), "verification");
			const result = terminalChildResult(facts, edge.parentTaskId, edge.childTaskId, child.receipt, verificationRef);
			const resultRef = artifactJsonReference(runtime.artifactStore, result, config.sourceRevision, "result");
			const receiptRef = artifactJsonReference(runtime.artifactStore, child.receipt, config.sourceRevision, "receipt");

			// Terminal facts are admitted before either trace is finalized. The
			// trace identity itself is intentionally absent from this event: putting
			// it in its own content hash would be circular.
			const terminalDetail = { parentTaskId: edge.parentTaskId, childTaskId: edge.childTaskId, relationship: "continuation" as const, ordinal: edge.ordinal, handoffArtifactId: edge.handoffArtifactId, checkpointArtifactId: config.checkpointReference.id, status, resultArtifactId: resultRef.id, receiptArtifactId: receiptRef.id };
			stream.recordUsage(parentReceipt, child.receipt);
			stream.recordCanonical({ type: status === "completed" ? "child.completed" : status === "escalated" ? "child.escalated" : "child.failed", taskId: edge.childTaskId, detail: terminalDetail });
			const childTrace = stream.finishChild(child.receipt.verdict);
			const traceRef = artifactJsonReference(runtime.artifactStore, childTrace, config.sourceRevision, "trace");
			const childDependency = ChildDependencySummarySchema.parse({ childTaskId: edge.childTaskId, edgeId, verdict: child.receipt.verdict, receiptReference: receiptRef, traceReference: traceRef });
			const linkedAggregateReceipt = parentOutcome(parentReceipt, status, child.receipt, childDependency);
			const parentReceiptRef = artifactJsonReference(runtime.artifactStore, linkedAggregateReceipt, config.sourceRevision, "receipt");
			const aggregateEvent: TaskLifecycleEvent = linkedAggregateReceipt.verdict === "ship"
				? { type: "task.completed", taskId: edge.parentTaskId, detail: { verdict: "ship" } }
				: linkedAggregateReceipt.verdict === "escalate"
					? { type: "task.escalated", taskId: edge.parentTaskId, detail: { verdict: "escalate" } }
					: { type: "task.failed", taskId: edge.parentTaskId, detail: { cause: "child terminal evidence did not ship", stage: "delivery", code: "delivery_failed" } };
			stream.recordCanonical(aggregateEvent);
			const parentTrace = stream.finishParent(linkedAggregateReceipt.verdict);
			const parentTraceRef = artifactJsonReference(runtime.artifactStore, parentTrace, config.sourceRevision, "trace");
			const terminal: Omit<ChildTerminalSettlement, "state" | "delivery"> = {
				edgeId, childStatus: status, verificationReference: verificationRef, resultReference: resultRef, receiptReference: receiptRef, traceReference: traceRef,
				parentReceiptReference: parentReceiptRef, parentTraceReference: parentTraceRef,
				verification, result, receipt: child.receipt, trace: childTrace, parentReceipt: linkedAggregateReceipt, parentTrace,
			};
			// This is the durable fence before the first evidence write. A crash at
			// any subsequent write boundary replays this outbox, not the child.
			ledger.beginChildTerminalSettlement(terminal);
			terminalOutboxInstalled = true;
			for (const [value, reference] of [
				[verification, verificationRef], [result, resultRef], [child.receipt, receiptRef], [childTrace, traceRef],
				[linkedAggregateReceipt, parentReceiptRef], [parentTrace, parentTraceRef],
			] as const) {
				const actual = artifactJson(runtime.artifactStore, value, reference.sourceRevision, reference.kind, reference.namespace);
				if (!equalReference(actual, reference)) throw new Error("terminal artifact identity changed during write");
			}
			ledger.settleChild(edgeId, status, {
				verificationArtifactId: verificationRef.id, resultArtifactId: resultRef.id, receiptArtifactId: receiptRef.id, traceArtifactId: traceRef.id,
				verificationReference: verificationRef,
				parentReceiptArtifactId: parentReceiptRef.id, parentTraceArtifactId: parentTraceRef.id,
				resultReference: resultRef, receiptReference: receiptRef, traceReference: traceRef,
				parentReceiptReference: parentReceiptRef, parentTraceReference: parentTraceRef,
			}, { deliveryAcknowledged: false });
			try {
				await workspaceDriver.cleanupWorkspace(resumed);
				ledger.setWorkspaceStatus(`${edge.childTaskId}-workspace`, "released");
			} catch { ledger.setWorkspaceStatus(`${edge.childTaskId}-workspace`, "orphaned"); }
			// Gateway delivery follows the canonical durable linkage. It must not
			// turn an already-settled ledger outcome back into a fake child failure.
			try { gateway.emit({ type: status === "completed" ? "child.completed" : status === "escalated" ? "child.escalated" : "child.failed", taskId: edge.childTaskId, detail: terminalDetail }); gateway.emit(aggregateEvent); } catch { /* durable evidence remains authoritative */ }
			if (deliveryPolicy === "canonical") {
				ledger.acknowledgeChildDeliveryStep(edgeId, "receipt");
				ledger.acknowledgeChildDeliveryStep(edgeId, "trace");
				ledger.acknowledgeChildDeliveryStep(edgeId, "final_receipt");
				return { parent: linkedAggregateReceipt, child: child.receipt, parentTaskId: edge.parentTaskId, childTaskId: edge.childTaskId, edgeId, status };
			}
			return { parent: parentOutcome(parentReceipt, "delivery_pending", child.receipt, childDependency), child: child.receipt, parentTaskId: edge.parentTaskId, childTaskId: edge.childTaskId, edgeId, status: "delivery_pending", failureCode: "delivery_failed" };
		} catch (error) {
			if (!terminalOutboxInstalled) {
				try { ledger.blockChild(edgeId); } catch { /* retain the original evidence/settlement failure */ }
				try { gateway.emit({ type: "child.blocked", taskId: edge.childTaskId, detail: { parentTaskId: edge.parentTaskId, childTaskId: edge.childTaskId, relationship: "continuation", ordinal: edge.ordinal, handoffArtifactId: edge.handoffArtifactId, checkpointArtifactId: config.checkpointReference.id, status: "blocked" } }); } catch { /* admission must not mask non-ship */ }
				return { parent: parentOutcome(parentReceipt, "failed", child.receipt), child: child.receipt, parentTaskId: edge.parentTaskId, childTaskId: edge.childTaskId, edgeId, status: "failed", failureCode: "provider_error" };
			}
			// Pending terminal evidence is recoverable. Keep the edge claimed and
			// report resumable so callers cannot mistake this attempt for a ship.
			return { parent: parentOutcome(parentReceipt, "resumable", child.receipt), child: child.receipt, parentTaskId: edge.parentTaskId, childTaskId: edge.childTaskId, edgeId, status: "resumable", failureCode: "provider_error" };
		}
	} finally { ledger.close(); }
}

/** Compatibility composition retained for existing callers. */
export async function runSequentialTask(options: RunSequentialTaskOptions): Promise<SequentialRunResult> {
	// This composition is itself a new execution ingress. Validate before
	// constructing its gateway ledger so unsupported cost caps cannot leave any
	// durable or provider-visible effect behind.
	assertNoMaxCostUsd(options.maxCostUsd);
	// A direct sequential run must have one gateway instance for both phases;
	// otherwise the parent lifecycle facts disappear at the process-local
	// prepare/resume seam and the terminal trace would be synthetic.
	const gatewayLedger = options.gateway === undefined ? new LedgerStore(options.dbPath) : undefined;
	const gateway = options.gateway ?? new InMemoryTaskGateway({ store: gatewayLedger });
	try {
		const prepared = await prepareSequentialChild({ ...options, gateway });
		if ((prepared.status === "delivery_pending") && prepared.edgeId !== undefined)
			return resumeSequentialChild(prepared.edgeId, { ...options, gateway });
		if (prepared.status !== "ready" || prepared.edgeId === undefined)
			return { ...prepared, status: prepared.status === "completed" ? "completed" : prepared.status === "escalated" ? "escalated" : prepared.status === "blocked" ? "blocked" : prepared.status === "preparing" ? "resumable" : prepared.status === "delivery_pending" ? "delivery_pending" : "failed" };
		return resumeSequentialChild(prepared.edgeId, { ...options, gateway });
	} finally {
		gatewayLedger?.close();
	}
}
