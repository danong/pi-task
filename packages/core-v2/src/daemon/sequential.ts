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
} from "../ledger/store.ts";
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

	finish(parentOutcome: TaskReceipt["verdict"], childOutcome: TaskReceipt["verdict"]): { parent: ReturnType<TraceCollector["finish"]>; child: ReturnType<TraceCollector["finish"]> } {
		this.unsubscribe();
		return {
			parent: this.parentTrace.finish(parentOutcome),
			child: this.childTrace.finish(childOutcome),
		};
	}
}

export interface SequentialTaskSpec {
	parentSpecMarkdown: string;
	childSpecMarkdown: string;
}
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
	maxCostUsd?: number;
	sessionTimeoutMs?: number;
	contextCapabilitiesFactory?: ContextAcquisitionFactory;
	contextArtifactStore?: ContextArtifactStore;
	onContextEvent?: (event: ContextEvidenceEvent) => void;
	onEvent?: (event: SessionHostEvent) => void;
}

export interface SequentialPrepareResult {
	parent: TaskReceipt;
	parentTaskId: string;
	childTaskId: string;
	edgeId?: string;
	status: "preparing" | "ready" | "failed" | "escalated" | "blocked";
	failureCode?: SequentialFailureCode;
}

export type SequentialFailureCode =
	| "unsupported" | "missing" | "stale" | "revision_mismatch"
	| "malformed_token" | "checkpoint_missing" | "handoff_invalid"
	| "corrupt" | "incompatible" | "provider_error";

export interface SequentialRunResult {
	parent: TaskReceipt;
	child?: TaskReceipt;
	parentTaskId: string;
	childTaskId: string;
	edgeId?: string;
	status: "completed" | "failed" | "escalated" | "blocked" | "resumable";
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
function parentOutcome(receipt: TaskReceipt, status: SequentialRunResult["status"], child?: TaskReceipt): TaskReceipt {
	const verdict = status === "completed" ? "ship" : status === "escalated" ? "escalate" : "failed";
	if (child === undefined) return { ...receipt, verdict };
	return {
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
	};
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
	const parentSpec = parseTaskSpec(options.parentSpecMarkdown);
	const childSpec = parseTaskSpec(options.childSpecMarkdown);
	const parentTaskId = options.parentTaskId ?? id("seq");
	const childTaskId = options.childTaskId ?? id("child");
	const edgeId = options.edgeId ?? id("edge");
	const ledger = new LedgerStore(options.dbPath);
	const gateway = options.gateway ?? new InMemoryTaskGateway({ store: ledger });
	try {
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
		const existingOwner = ledger.getChildPreparationOwnershipByEdge(edgeId);
		const preparationId = existingOwner?.preparationId ?? id("prep");
		const owner = ledger.persistChildPreparationOwner({
			preparationId, edgeId, parentTaskId, plannedChildTaskId: childTaskId,
			driver: options.workspaceDriver.name, capabilityIdentity: reservedProviderIdentity,
			capabilityVersion: reservedProviderVersion,
		});
		let parentReceipt: TaskReceipt;
		let parentRevision: string;
		if (owner.status === "parent_pending") {
			const parent = await runIsolatedTask({
				specMarkdown: options.parentSpecMarkdown, projectDir: options.projectDir,
				artifactsDir: options.artifactsDir, dbPath: options.dbPath, model: options.model,
				workspaceDriver: options.workspaceDriver,
				...(options.environmentDriver === undefined ? {} : { environmentDriver: options.environmentDriver }),
				...(options.host === undefined ? {} : { host: options.host }), gateway,
				...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
				...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
				...(options.sessionTimeoutMs === undefined ? {} : { sessionTimeoutMs: options.sessionTimeoutMs }),
				...(options.contextCapabilitiesFactory === undefined ? {} : { contextCapabilitiesFactory: options.contextCapabilitiesFactory }),
				...(options.contextArtifactStore === undefined ? {} : { contextArtifactStore: options.contextArtifactStore }),
				...(options.onContextEvent === undefined ? {} : { onContextEvent: options.onContextEvent }),
				...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
				taskId: parentTaskId, reuseExistingTask: true, deferSuccessfulTerminal: true,
			});
			if (parent.receipt.verdict !== "ship") {
				ledger.blockChildPreparation(preparationId);
				return { parent: parent.receipt, parentTaskId, childTaskId, status: parent.receipt.verdict === "escalate" ? "escalated" : "failed" };
			}
			parentReceipt = parent.receipt;
			parentRevision = parent.mergedCommitId ?? sha(parentTaskId).slice("sha256:".length);
			ledger.recordChildParentAcceptance(preparationId, JSON.stringify(parentReceipt), parentRevision);
		} else {
			if (!owner.parentReceiptJson || !owner.parentRevision)
				throw new Error("accepted child preparation has no durable parent receipt");
			parentReceipt = TaskReceiptSchema.parse(JSON.parse(owner.parentReceiptJson));
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
			const checkpoint = createWorkingCheckpoint({ epochId: "parent-handoff", workspaceRevision, plan: planRef, requirements: parentSpec.requirements.map((_, index) => ({ id: `r${index + 1}`, status: "satisfied" as const })), verification: { status: "passed" }, summary: { nextActions: ["continue accepted parent work"] } });
			const checkpointRef = persistWorkingCheckpoint(options.artifactStore, checkpoint);
			const handoff: ChildHandoff = buildChildHandoff({ version: 1, parentTaskId, childTaskId, relationship: "continuation", checkpointId: checkpointRef.id, planId: planRef.id, sourceRevision, requirementState: parentSpec.requirements.map((_, index) => ({ id: `r${index + 1}`, status: "complete", summary: "parent requirement accepted" })), decisions: ["parent verification and acceptance passed"], openQuestions: [], nextActions: ["execute direct continuation"], changedPaths: [], artifactReferences: [], verification: { status: "passed", evidenceReferences: [] } });
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
			const continuationId = id("cont");
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
	const ledger = new LedgerStore(runtime.dbPath);
	const gateway = runtime.gateway ?? new InMemoryTaskGateway({ store: ledger });
	try {
		const edge = ledger.getTaskEdge(edgeId);
		if (!edge || edge.childTaskId === null) {
			const missing = fallbackReceipt("unknown-parent");
			return { parent: missing, childTaskId: "unknown-child", parentTaskId: "unknown-parent", edgeId, status: "blocked", failureCode: "missing" };
		}
		const childTaskId = edge.childTaskId;
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
			const child = childRef ? parseJson(runtime.artifactStore, childRef, "child receipt", (value) => TaskReceiptSchema.parse(value)) : undefined;
			const aggregateRef = ledger.listTaskArtifacts(edge.parentTaskId)
				.find((ref) => ref.role === "receipt" && ref.reference)?.reference;
			const aggregate = aggregateRef
				? parseJson(runtime.artifactStore, aggregateRef, "parent receipt", (value) => TaskReceiptSchema.parse(value))
				: parentOutcome(parentReceipt, edge.status as "completed" | "failed" | "escalated", child);
			const status = edge.status as "completed" | "failed" | "escalated";
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
				if (!isWorkspaceContinuationError(error)) throw error;
				ledger.blockChild(edgeId);
				return blockedResult(edge, error.code, parentReceipt);
			}
		};

		const sessionAttemptId = String(ledger.listSessions(childTaskId).length + 1);
		let child;
		try {
			child = await runIsolatedTask({
				specMarkdown: childSpecMarkdown, projectDir: runtime.projectDir, artifactsDir: runtime.artifactsDir, dbPath: runtime.dbPath, model: runtime.model, workspaceDriver,
				...(runtime.environmentDriver === undefined ? {} : { environmentDriver: runtime.environmentDriver }), ...(runtime.host === undefined ? {} : { host: runtime.host }), gateway,
				...(runtime.maxTurns === undefined ? {} : { maxTurns: runtime.maxTurns }),
				...(runtime.maxCostUsd === undefined ? {} : { maxCostUsd: runtime.maxCostUsd }),
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
		try {
			if (verificationFact === undefined || verificationFact.evidence === undefined)
				throw new Error("verification provider did not return structural evidence");
			const verificationEvidence = VerificationEvidenceSchema.parse(verificationFact.evidence);
			const verificationRef = artifactJson(runtime.artifactStore, {
				version: 1,
				passed: verificationFact.passed,
				evidence: verificationEvidence,
			}, sha(config.sourceRevision), "verification");
			const result = terminalChildResult(facts, edge.parentTaskId, edge.childTaskId, child.receipt, verificationRef);
			const aggregateReceipt = parentOutcome(parentReceipt, status, child.receipt);
			const traces = stream.finish(aggregateReceipt.verdict, child.receipt.verdict);
			const resultRef = artifactJson(runtime.artifactStore, result, config.sourceRevision, "result");
			const receiptRef = artifactJson(runtime.artifactStore, child.receipt, config.sourceRevision, "receipt");
			const traceRef = artifactJson(runtime.artifactStore, traces.child, config.sourceRevision, "trace");
			const parentReceiptRef = artifactJson(runtime.artifactStore, aggregateReceipt, config.sourceRevision, "receipt");
			const parentTraceRef = artifactJson(runtime.artifactStore, traces.parent, config.sourceRevision, "trace");
			// Store complete references before the edge transaction. If any
			// immutable write or ledger insertion fails, settlement is never
			// attempted and the parent cannot be reported as shipped.
			for (const [taskId, role, reference] of [
				[edge.childTaskId, "verification", verificationRef],
				[edge.childTaskId, "result", resultRef],
				[edge.childTaskId, "receipt", receiptRef],
				[edge.childTaskId, "trace", traceRef],
				[edge.parentTaskId, "receipt", parentReceiptRef],
				[edge.parentTaskId, "trace", parentTraceRef],
			] as const)
				ledger.insertTaskArtifact({ taskId, role, artifactId: reference.id, mediaType: reference.mediaType, sourceRevision: reference.sourceRevision, reference });
			ledger.settleChild(edgeId, status, {
				resultArtifactId: resultRef.id,
				receiptArtifactId: receiptRef.id,
				traceArtifactId: traceRef.id,
			});
			try {
				await workspaceDriver.cleanupWorkspace(resumed);
				ledger.setWorkspaceStatus(`${edge.childTaskId}-workspace`, "released");
			} catch {
				// Terminal evidence is already durable; preserve cleanup failure for boot hygiene.
				ledger.setWorkspaceStatus(`${edge.childTaskId}-workspace`, "orphaned");
			}
			const detail = { parentTaskId: edge.parentTaskId, childTaskId: edge.childTaskId, relationship: "continuation" as const, ordinal: edge.ordinal, handoffArtifactId: edge.handoffArtifactId, checkpointArtifactId: config.checkpointReference.id, status, resultArtifactId: resultRef.id, receiptArtifactId: receiptRef.id, traceArtifactId: traceRef.id };
			gateway.emit({ type: status === "completed" ? "child.completed" : status === "escalated" ? "child.escalated" : "child.failed", taskId: edge.childTaskId, detail });
			if (aggregateReceipt.verdict === "ship")
				gateway.emit({ type: "task.completed", taskId: edge.parentTaskId, detail: { verdict: "ship" } });
			else if (aggregateReceipt.verdict === "escalate")
				gateway.emit({ type: "task.escalated", taskId: edge.parentTaskId, detail: { verdict: "escalate" } });
			else
				gateway.emit({ type: "task.failed", taskId: edge.parentTaskId, detail: { cause: "child terminal evidence did not ship", stage: "delivery", code: "delivery_failed" } });
			return { parent: aggregateReceipt, child: child.receipt, parentTaskId: edge.parentTaskId, childTaskId: edge.childTaskId, edgeId, status };
		} catch (error) {
			try {
				ledger.blockChild(edgeId);
			} catch { /* retain the original evidence/settlement failure */ }
			try {
				gateway.emit({ type: "child.blocked", taskId: edge.childTaskId, detail: { parentTaskId: edge.parentTaskId, childTaskId: edge.childTaskId, relationship: "continuation", ordinal: edge.ordinal, handoffArtifactId: edge.handoffArtifactId, checkpointArtifactId: config.checkpointReference.id, status: "blocked" } });
			} catch { /* gateway admission must not mask the non-ship result */ }
			return { parent: parentOutcome(parentReceipt, "failed", child.receipt), child: child.receipt, parentTaskId: edge.parentTaskId, childTaskId: edge.childTaskId, edgeId, status: "failed", failureCode: "provider_error" };
		}
	} finally { ledger.close(); }
}

/** Compatibility composition retained for existing callers. */
export async function runSequentialTask(options: RunSequentialTaskOptions): Promise<SequentialRunResult> {
	// A direct sequential run must have one gateway instance for both phases;
	// otherwise the parent lifecycle facts disappear at the process-local
	// prepare/resume seam and the terminal trace would be synthetic.
	const gatewayLedger = options.gateway === undefined ? new LedgerStore(options.dbPath) : undefined;
	const gateway = options.gateway ?? new InMemoryTaskGateway({ store: gatewayLedger });
	try {
		const prepared = await prepareSequentialChild({ ...options, gateway });
		if (prepared.status !== "ready" || prepared.edgeId === undefined)
			return { ...prepared, status: prepared.status === "escalated" ? "escalated" : prepared.status === "blocked" ? "blocked" : prepared.status === "preparing" ? "resumable" : "failed" };
		return resumeSequentialChild(prepared.edgeId, { ...options, gateway });
	} finally {
		gatewayLedger?.close();
	}
}
