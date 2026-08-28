/** Hermetic M5 sequential daemon proof: fake sessions, real jj/SQLite/verify. */
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { SessionHandle, SessionHost, SessionHostConfig, SessionHostEvent } from "../src/sessions/host.ts";
import { ContextArtifactStore } from "../src/context/artifact-store.ts";
import { buildChildHandoff } from "../src/contracts/payloads.ts";
import { stableStringify } from "../src/contracts/serialize.ts";
import { WorkingCheckpointSchema } from "../src/contracts/context-lifecycle.ts";
import { createWorkingCheckpoint, persistWorkingCheckpoint } from "../src/context/checkpoint.ts";
import { InMemoryTaskGateway } from "../src/gateway/in-memory.ts";
import { LedgerStore, type SequentialEdgeConfig } from "../src/ledger/store.ts";
import type { ImmutableArtifactReference } from "../src/contracts/context-lifecycle.ts";
import { prepareSequentialChild, resumeSequentialChild, runSequentialTask } from "../src/daemon/sequential.ts";
import { JujutsuWorkspaceDriver } from "../src/workspaces/jj-driver.ts";

const PARENT = `## Goal\nParent change.\n\n## Requirements\n- R1: write parent.txt\n\n## Verification\n- test -f parent.txt\n\n## Artifact Policy\n- Required: parent.txt\n- Change required\n`;
const CHILD = `## Goal\nChild change.\n\n## Requirements\n- R1: write child.txt\n\n## Verification\n- test -f child.txt\n\n## Artifact Policy\n- Required: child.txt\n- Change required\n`;
const FAILING_CHILD = CHILD.replace("- test -f child.txt", "- false");
const RESUMABLE_CHILD = `## Goal\nComplete preserved partial work.\n\n## Requirements\n- R1: retain partial.txt\n- R2: write child.txt\n\n## Verification\n- test -f partial.txt\n- test -f child.txt\n\n## Artifact Policy\n- Required: partial.txt\n- Required: child.txt\n- Change required\n`; 

class Handle implements SessionHandle {
	readonly role: string;
	readonly model = { provider: "fake", modelId: "fake/model" };
	result: { files_changed: string[]; summary: string; commit_ids: string[]; deviations: string[] } | undefined;
	constructor(private readonly config: SessionHostConfig, private readonly index: number) { this.role = config.role; }
	subscribe(listener: (event: SessionHostEvent) => void): () => void { listener({ type: "turnStart" }); listener({ type: "settled" }); return () => undefined; }
	async prompt(): Promise<void> {
		const file = this.index === 0 ? "parent.txt" : "child.txt";
		writeFileSync(join(this.config.cwd, file), `engine-${file}\n`);
		this.result = { files_changed: [file], summary: "fake output that must not cross handoff", commit_ids: [], deviations: [] };
	}
	async abort(): Promise<void> {}
	async stats() { return { sessionFile: undefined, sessionId: `fake-${this.index}`, userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }; }
	async setModel(): Promise<void> {}
	close(): void {}
}
function host(counter?: { value: number }, prompts?: string[], epochs?: SessionHostConfig["contextEpoch"][]): SessionHost {
	let calls = 0;
	return { spawn: async (config) => {
		prompts?.push(config.systemPrompt);
		epochs?.push(config.contextEpoch);
		const index = counter === undefined ? calls++ : counter.value++;
		return new Handle(config, index);
	} };
}
function interruptingHost(counter: { value: number }): SessionHost {
	return { spawn: async (config) => {
		counter.value += 1;
		return {
			role: config.role,
			model: { provider: "fake", modelId: "fake/model" },
			result: undefined,
			subscribe(listener: (event: SessionHostEvent) => void) {
				listener({ type: "turnStart" });
				listener({ type: "turnStart" });
				return () => undefined;
			},
			async prompt() { writeFileSync(join(config.cwd, "partial.txt"), "preserved partial work\n"); },
			async abort() {},
			async stats() { return { sessionFile: undefined, sessionId: "fake-interrupted", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }; },
			async setModel() {},
			close() {},
		} satisfies SessionHandle;
	} };
}
function unsupported(driver: JujutsuWorkspaceDriver) {
	return {
		name: driver.name, integrationMode: driver.integrationMode,
		isSupported: driver.isSupported.bind(driver), prepare: driver.prepare.bind(driver),
		createWorkspace: driver.createWorkspace.bind(driver), mergeWorkspace: driver.mergeWorkspace.bind(driver),
		cleanupWorkspace: driver.cleanupWorkspace.bind(driver), finalizeWorkspace: driver.finalizeWorkspace.bind(driver),
		prepareIntegrationBase: driver.prepareIntegrationBase.bind(driver), combine: driver.combine.bind(driver),
		materialize: driver.materialize.bind(driver),
	};
}

export async function runTests(): Promise<void> {
	try { execSync("jj --version", { stdio: "pipe" }); } catch { console.log("SKIPPED (no jj binary)"); return; }
	const root = mkdtempSync(join(tmpdir(), "core-v2-seq-"));
	const errors: string[] = [];
	const check = (ok: boolean, message: string) => { if (!ok) errors.push(message); };
	const repo = join(root, "repo"); mkdirSync(repo); execSync("jj git init --colocate", { cwd: repo, stdio: "pipe" });
	writeFileSync(join(repo, "README.md"), "fixture\n"); execSync('JJ_EDITOR=true jj commit -m init', { cwd: repo, stdio: "pipe" });
	try {
		const dbPath = join(root, "ledger.sqlite");
		const artifacts = new ContextArtifactStore({ root: join(root, "artifacts") });
		const ledger = new LedgerStore(dbPath); const gateway = new InMemoryTaskGateway({ store: ledger });
		const spawnCount = { value: 0 }; const prompts: string[] = []; let intentWasDurable = false;
		// The event is emitted after its transaction; exactly the parent session
		// has spawned while the sole direct edge is still ready.
		gateway.on("child.queued", (event) => { intentWasDurable = ledger.listChildEdges(event.taskId)[0]?.status === "ready" && spawnCount.value === 1; });
		const result = await runSequentialTask({ parentSpecMarkdown: PARENT, childSpecMarkdown: CHILD, projectDir: repo, artifactsDir: join(root, "failures"), dbPath, model: "fake/model", workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: repo }), host: host(spawnCount, prompts), gateway, artifactStore: artifacts });
		check(result.status === "completed" && result.child?.verdict === "ship", "parent then child ship");
		check(existsSync(join(repo, "parent.txt")) && existsSync(join(repo, "child.txt")), "real integrated verification sees both changes");
		const edge = result.edgeId ? ledger.getTaskEdge(result.edgeId) : null;
		check(edge?.status === "completed", "ready intent was claimed and settled once");
		check(ledger.getTask(result.parentTaskId)?.status === "completed" && ledger.getTask(result.childTaskId)?.status === "completed", "separate parent and child task identities settle together");
		check(ledger.listSessions(result.parentTaskId).length === 1 && ledger.listSessions(result.childTaskId).length === 1, "separate sessions persisted");
		check(ledger.listWorkspaces(result.parentTaskId).length === 1 && ledger.listWorkspaces(result.childTaskId).length === 1, "separate workspaces persisted");
		check((ledger.getWorkspaceContinuation(edge?.workspaceContinuationId ?? "")?.revision.length ?? 0) === 40, "provider-derived continuation revision persisted");
		const events = gateway.listEvents();
		const queued = events.findIndex((event) => event.type === "child.queued"); const claimed = events.findIndex((event) => event.type === "child.claimed");
		check(intentWasDurable && queued >= 0 && claimed > queued && events.some((event) => event.type === "continuation.resumed") && events.some((event) => event.type === "child.completed"), "canonical admitted child lifecycle order and durable intent before spawn");
		check(ledger.listTaskArtifacts(result.childTaskId).some((ref) => ref.role === "result") && ledger.listTaskArtifacts(result.childTaskId).some((ref) => ref.role === "receipt") && ledger.listTaskArtifacts(result.childTaskId).some((ref) => ref.role === "trace"), "settlement retains canonical result, receipt, and trace evidence");
		const childArtifacts = ledger.listTaskArtifacts(result.childTaskId);
		const parentArtifacts = ledger.listTaskArtifacts(result.parentTaskId);
		const edgeConfig = result.edgeId === undefined ? null : ledger.getSequentialEdgeConfig(result.edgeId);
		const childResultRef = childArtifacts.find((ref) => ref.role === "result")?.reference;
		const childReceiptRef = childArtifacts.find((ref) => ref.role === "receipt")?.reference;
		const childTraceRef = childArtifacts.find((ref) => ref.role === "trace")?.reference;
		const parentReceiptRef = parentArtifacts.find((ref) => ref.role === "receipt")?.reference;
		const parentTraceRef = parentArtifacts.find((ref) => ref.role === "trace")?.reference;
		const childDependency = result.parent.childDependency;
		check(
			childDependency !== undefined &&
			childDependency.childTaskId === result.childTaskId &&
			childDependency.edgeId === result.edgeId &&
			childDependency.verdict === result.child?.verdict &&
			childDependency.receiptReference.id === childReceiptRef?.id &&
			childDependency.receiptReference.kind === "receipt" &&
			stableStringify(childDependency.receiptReference) === stableStringify(childReceiptRef) &&
			childDependency.traceReference.id === childTraceRef?.id &&
			childDependency.traceReference.kind === "trace" &&
			stableStringify(childDependency.traceReference) === stableStringify(childTraceRef),
			"parent receipt records exact child identity, edge, verdict, receipt, and trace references",
		);
		check(childResultRef?.kind === "result" && childResultRef.namespace === "result" && childResultRef.sourceRevision === edgeConfig?.sourceRevision, "child result reference is typed and revision-bound");
		check(childReceiptRef?.kind === "receipt" && childReceiptRef.namespace === "receipt" && childReceiptRef.sourceRevision === edgeConfig?.sourceRevision && parentReceiptRef?.id !== childReceiptRef.id, "parent and child receipts are distinct immutable artifacts");
		check(childTraceRef?.kind === "trace" && childTraceRef.namespace === "trace" && childTraceRef.sourceRevision === edgeConfig?.sourceRevision && parentTraceRef?.kind === "trace" && parentTraceRef.namespace === "trace" && parentTraceRef.sourceRevision === edgeConfig?.sourceRevision && parentTraceRef.id !== childTraceRef.id, "parent and child traces are distinct typed artifacts");
		const childResult = childResultRef === undefined ? undefined : JSON.parse(readFileSync(join(artifacts.root, "result", childResultRef.id.slice("sha256:".length)), "utf8")) as { changedPaths?: Array<{ path: string }>; verification?: { evidenceReferences?: unknown[] } };
		check(childResult?.changedPaths?.some((entry) => entry.path === "child.txt") === true && (childResult.verification?.evidenceReferences?.length ?? 0) > 0, "child result contains provider changed-path and verification evidence");
		const childTrace = childTraceRef === undefined ? undefined : JSON.parse(readFileSync(join(artifacts.root, "trace", childTraceRef.id.slice("sha256:".length)), "utf8")) as { events: Array<{ type: string }> };
		check(childTrace?.events.some((event) => event.type === "verification.completed") === true, "child trace records admitted verification lifecycle facts");
		const terminalIndex = events.findIndex((event) => event.type === "child.completed");
		const parentTerminalIndex = events.findIndex((event) => event.type === "task.completed" && event.taskId === result.parentTaskId);
		check(terminalIndex >= 0 && parentTerminalIndex > terminalIndex, "child evidence settles before aggregate parent ship lifecycle");
		const handoffText = edge === null ? "" : readFileSync(
			join(artifacts.root, "handoff", edge.handoffArtifactId.slice("sha256:".length)), "utf8",
		);
		const checkpointText = edge === null || edge.checkpointArtifactId === null ? "" : readFileSync(
			join(artifacts.root, "checkpoint", edge.checkpointArtifactId.slice("sha256:".length)), "utf8",
		);
		check(Boolean(buildChildHandoff(JSON.parse(handoffText))) && Boolean(WorkingCheckpointSchema.parse(JSON.parse(checkpointText))), "handoff and checkpoint revalidate from durable bytes");
		const allArtifactText = [handoffText, checkpointText, ...gateway.listEvents().map((event) => JSON.stringify(event))].join("\n");
		check(prompts[1]?.includes("Continuation state (bounded, declarative)") === true && !prompts[1]!.includes(repo), "child receives only the bounded revalidated handoff");
		check(!allArtifactText.includes(repo) && !allArtifactText.includes("fake output") && !allArtifactText.includes("hostPath"), "handoff/events/evidence contain no output or host-path leakage");
		ledger.close();

		// Hermetic process boundary: preparation leaves a ready edge, then all
		// daemon state is closed and a new artifact store, driver, ledger, and
		// host resume the child by edge id. The parent is never spawned again.
		const restartRepo = join(root, "repo-restart"); mkdirSync(restartRepo); execSync("jj git init --colocate", { cwd: restartRepo, stdio: "pipe" }); writeFileSync(join(restartRepo, "README.md"), "fixture\\n"); execSync('JJ_EDITOR=true jj commit -m init', { cwd: restartRepo, stdio: "pipe" });
		const restartDb = join(root, "restart.sqlite"); const restartArtifactsDir = join(root, "restart-artifacts"); const restartCalls = { value: 0 }; const restartPrompts: string[] = []; const restartEpochs: SessionHostConfig["contextEpoch"][] = [];
		const restartArtifactStore = new ContextArtifactStore({ root: restartArtifactsDir });
		const prepared = await prepareSequentialChild({ parentSpecMarkdown: PARENT, childSpecMarkdown: CHILD, projectDir: restartRepo, artifactsDir: join(root, "restart-failures"), dbPath: restartDb, model: "fake/model", workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: restartRepo }), host: host(restartCalls, restartPrompts, restartEpochs), artifactStore: restartArtifactStore });
		check(prepared.status === "ready" && prepared.edgeId !== undefined, "preparation leaves one ready durable edge");
		const beforeRestart = new LedgerStore(restartDb); const restartConfig = prepared.edgeId ? beforeRestart.getSequentialEdgeConfig(prepared.edgeId) : null;
		check(restartConfig?.handoffReference.namespace === "handoff" && restartConfig?.checkpointReference.namespace === "checkpoint" && restartConfig?.planReference.namespace === "plan", "complete immutable ingress references round-trip");
		// Replace the durable plan with a distinctive, otherwise valid plan. This
		// makes a fresh child re-plan observable across the close/reopen boundary.
		let persistedPlanId: string | undefined;
		let persistedCheckpointId: string | undefined;
		let persistedEpochId: string | undefined;
		if (prepared.edgeId !== undefined && restartConfig !== null) {
			const planBytes = readFileSync(join(restartArtifactsDir, "plan", restartConfig.planReference.id.slice("sha256:".length)), "utf8");
			const persistedPlan = JSON.parse(planBytes) as Record<string, unknown>;
			const marker = {
				version: 1, id: "persisted-plan-marker", kind: "source", label: "PERSISTED_PLAN_MARKER",
				summary: "distinctive plan loaded after reopen", sourcePath: "PERSISTED_PLAN_MARKER.txt", score: 100,
				provenance: { providerId: "fixture", providerVersion: "1", source: "fixture", sourceRevision: restartConfig.sourceRevision, selector: "persisted-plan-marker" },
				freshness: { revision: restartConfig.sourceRevision, observedAtRevision: restartConfig.sourceRevision, state: "fresh" },
				sensitivity: "internal", size: { characters: 32, tokens: 8 }, requirementIds: ["goal"],
			};
			const distinctivePlan = { ...persistedPlan, mode: "managed", candidates: [marker], selected: [marker] };
			persistedPlanId = String(persistedPlan.id);
			const planReference = restartArtifactStore.putJson(distinctivePlan, { namespace: "plan", kind: "plan", sensitivity: "internal", sourceRevision: restartConfig.sourceRevision });
			const oldCheckpoint = JSON.parse(readFileSync(join(restartArtifactsDir, "checkpoint", restartConfig.checkpointReference.id.slice("sha256:".length)), "utf8")) as ReturnType<typeof createWorkingCheckpoint>;
			const checkpoint = createWorkingCheckpoint({ ...oldCheckpoint, plan: planReference });
			const checkpointReference = persistWorkingCheckpoint(restartArtifactStore, checkpoint);
			persistedCheckpointId = checkpoint.id;
			persistedEpochId = checkpoint.epochId;
			const oldHandoff = buildChildHandoff(JSON.parse(readFileSync(join(restartArtifactsDir, "handoff", restartConfig.handoffReference.id.slice("sha256:".length)), "utf8")));
			const handoff = buildChildHandoff({ ...oldHandoff, planId: planReference.id, checkpointId: checkpointReference.id });
			const handoffReference = restartArtifactStore.putJson(handoff, { namespace: "handoff", kind: "handoff", sensitivity: "internal", sourceRevision: restartConfig.sourceRevision });
			const ingress = { version: 1, parentTaskId: prepared.parentTaskId, childTaskId: prepared.childTaskId, modelIdentity: restartConfig.modelIdentity, sourceRevision: restartConfig.sourceRevision, capabilityIdentity: restartConfig.capabilityIdentity, capabilityVersion: restartConfig.capabilityVersion, handoffReference, checkpointReference, childSpecReference: restartConfig.childSpecReference, planReference };
			const ingressConfigReference = restartArtifactStore.putJson(ingress, { namespace: "context", kind: "context", sensitivity: "internal", sourceRevision: restartConfig.sourceRevision });
			beforeRestart.db.prepare("UPDATE sequential_edge_configs SET handoff_reference_json = ?, checkpoint_reference_json = ?, plan_reference_json = ?, ingress_config_reference_json = ? WHERE edge_id = ?").run(JSON.stringify(handoffReference), JSON.stringify(checkpointReference), JSON.stringify(planReference), JSON.stringify(ingressConfigReference), prepared.edgeId);
			beforeRestart.db.prepare("UPDATE task_edges SET handoff_artifact_id = ?, checkpoint_artifact_id = ? WHERE edge_id = ?").run(handoffReference.id, checkpointReference.id, prepared.edgeId);
		}
		beforeRestart.close();
		const resumed = await resumeSequentialChild(prepared.edgeId!, { projectDir: restartRepo, artifactsDir: join(root, "restart-failures"), dbPath: restartDb, model: "fake/model", workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: restartRepo }), host: host(restartCalls, restartPrompts, restartEpochs), artifactStore: new ContextArtifactStore({ root: restartArtifactsDir }) });
		const resumedEpoch = restartEpochs[1];
		check(resumed.status === "completed" && existsSync(join(restartRepo, "parent.txt")) && existsSync(join(restartRepo, "child.txt")) && restartCalls.value === 2, "close/reopen resume verifies parent once and child once");
		check(restartPrompts[1]?.includes("PERSISTED_PLAN_MARKER") === true && resumedEpoch?.planId === persistedPlanId && resumedEpoch?.checkpointId === persistedCheckpointId && resumedEpoch?.parentId === persistedEpochId && resumedEpoch?.transition === "retry", `resumed child receives the persisted plan and checkpoint epoch lineage (prompt=${restartPrompts[1]?.includes("PERSISTED_PLAN_MARKER")}, plan=${resumedEpoch?.planId}/${persistedPlanId}, checkpoint=${resumedEpoch?.checkpointId}/${persistedCheckpointId}, parent=${resumedEpoch?.parentId}/${persistedEpochId}, transition=${resumedEpoch?.transition})`);
		const duplicate = await resumeSequentialChild(prepared.edgeId!, { projectDir: restartRepo, artifactsDir: join(root, "restart-failures"), dbPath: restartDb, model: "fake/model", workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: restartRepo }), host: host(restartCalls), artifactStore: new ContextArtifactStore({ root: restartArtifactsDir }) });
		check(duplicate.status === "completed" && restartCalls.value === 2, "terminal duplicate resume does not spawn twice");

		const mismatchRepo = join(root, "repo-restart-mismatch"); mkdirSync(mismatchRepo); execSync("jj git init --colocate", { cwd: mismatchRepo, stdio: "pipe" }); writeFileSync(join(mismatchRepo, "README.md"), "fixture\n"); execSync('JJ_EDITOR=true jj commit -m init', { cwd: mismatchRepo, stdio: "pipe" });
		const mismatchDb = join(root, "restart-mismatch.sqlite"); const mismatchArtifactsDir = join(root, "restart-mismatch-artifacts"); const mismatchCalls = { value: 0 };
		const mismatchPrepared = await prepareSequentialChild({ parentSpecMarkdown: PARENT, childSpecMarkdown: CHILD, projectDir: mismatchRepo, artifactsDir: join(root, "restart-mismatch-failures"), dbPath: mismatchDb, model: "fake/model", workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: mismatchRepo }), host: host(mismatchCalls), artifactStore: new ContextArtifactStore({ root: mismatchArtifactsDir }) });
		const mismatchBefore = mismatchCalls.value;
		const mismatched = await resumeSequentialChild(mismatchPrepared.edgeId!, { projectDir: mismatchRepo, artifactsDir: join(root, "restart-mismatch-failures"), dbPath: mismatchDb, model: "other/model", workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: mismatchRepo }), host: host(mismatchCalls), artifactStore: new ContextArtifactStore({ root: mismatchArtifactsDir }) });
		const mismatchLedger = new LedgerStore(mismatchDb);
		check(mismatched.status === "blocked" && mismatchCalls.value === mismatchBefore && mismatchLedger.listSessions(mismatchPrepared.childTaskId).length === 0, "validated resume mismatch is rejected before child session spawn");
		mismatchLedger.close();

		// The provider mutation is owned by a preparing edge before it starts.
		// Calling provider preparation before a simulated crash and again from a
		// new daemon resolves the same workspace and never replays the parent.
		const prepRepo = join(root, "repo-preparing"); mkdirSync(prepRepo); execSync("jj git init --colocate", { cwd: prepRepo, stdio: "pipe" }); writeFileSync(join(prepRepo, "README.md"), "fixture\n"); execSync('JJ_EDITOR=true jj commit -m init', { cwd: prepRepo, stdio: "pipe" });
		const prepDb = join(root, "preparing.sqlite"); const prepArtifactsRoot = join(root, "preparing-artifacts"); const prepCalls = { value: 0 };
		const preparing = await prepareSequentialChild({ parentSpecMarkdown: PARENT, childSpecMarkdown: CHILD, projectDir: prepRepo, artifactsDir: join(root, "preparing-failures"), dbPath: prepDb, model: "fake/model", workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: prepRepo }), host: host(prepCalls), artifactStore: new ContextArtifactStore({ root: prepArtifactsRoot }), deferProviderPreparation: true });
		const prepLedger = new LedgerStore(prepDb); const preparation = preparing.edgeId ? prepLedger.getChildPreparation(preparing.edgeId) : null;
		check(preparing.status === "preparing" && preparation !== null && prepLedger.getTask(preparing.parentTaskId)?.status === "awaiting_child", "durable preparing edge owns provider work before mutation"); prepLedger.close();
		const providerBeforeCrash = new JujutsuWorkspaceDriver({ projectDir: prepRepo });
		await providerBeforeCrash.continuation!.prepareContinuation!(preparing.childTaskId, preparation!.preparationId);
		const preparedAfterCrash = await resumeSequentialChild(preparing.edgeId!, { projectDir: prepRepo, artifactsDir: join(root, "preparing-failures"), dbPath: prepDb, model: "fake/model", workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: prepRepo }), host: host(prepCalls), artifactStore: new ContextArtifactStore({ root: prepArtifactsRoot }) });
		check(preparedAfterCrash.status === "completed" && prepCalls.value === 2 && existsSync(join(prepRepo, "child.txt")), `provider prepare is idempotently reconciled after restart without parent replay (${preparedAfterCrash.status}, calls=${prepCalls.value})`);

		// Fault-boundary proof: every preparation phase is visible after a
		// close/reopen, including the interval before a child task exists. The
		// generic retry pass sees the owner and therefore cannot replay parent
		// acceptance while artifacts or provider work are incomplete.
		const faultDb = join(root, "fault-boundary.sqlite");
		const faultLedger = new LedgerStore(faultDb);
		faultLedger.insertTask({ id: "fault-parent", goal: "accepted parent" });
		const owner = faultLedger.persistChildPreparationOwner({ preparationId: "fault-prep", edgeId: "fault-edge", parentTaskId: "fault-parent", plannedChildTaskId: "fault-child", driver: "fake", capabilityIdentity: "fake.continuation", capabilityVersion: "1" });
		check(owner.status === "parent_pending" && faultLedger.getTask("fault-child") === null, "parent reservation precedes child creation");
		faultLedger.close();
		let faultReopen = new LedgerStore(faultDb);
		const beforeAcceptanceBoot = faultReopen.reconcileChildEdgesOnBoot();
		const beforeAcceptanceTasks = faultReopen.reconcileOnBoot();
		check(beforeAcceptanceBoot.preparing.includes("fault-prep") && beforeAcceptanceTasks.requeued.length === 0 && faultReopen.getTask("fault-parent")?.status === "preparing", "preliminary preparation is classified before generic retry");
		faultReopen.recordChildParentAcceptance("fault-prep", JSON.stringify({ taskId: "fault-parent", verdict: "ship" }), "parent-revision");
		faultReopen.close();
		faultReopen = new LedgerStore(faultDb);
		check(faultReopen.getChildPreparationOwnership("fault-prep")?.status === "parent_accepted" && faultReopen.getTask("fault-child") === null, "accepted parent survives before child creation without replay");
		faultReopen.beginChildArtifactPersistence("fault-prep");
		faultReopen.close();
		faultReopen = new LedgerStore(faultDb);
		check(faultReopen.getChildPreparationOwnership("fault-prep")?.status === "artifacts_pending" && faultReopen.getTask("fault-child") === null, "immutable artifact boundary is durable before child attach");
		const faultRef = (hex: string, kind: ImmutableArtifactReference["kind"], namespace = kind): ImmutableArtifactReference => ({ version: 1, id: `sha256:${hex.repeat(64 / hex.length)}`, namespace, kind, mediaType: "application/json", sizeBytes: 1, sensitivity: "internal", sourceRevision: "parent-revision" });
		const faultConfig: SequentialEdgeConfig = { edgeId: "fault-edge", handoffReference: faultRef("1", "handoff"), checkpointReference: faultRef("2", "checkpoint"), childSpecReference: faultRef("3", "context", "context"), planReference: faultRef("4", "plan"), ingressConfigReference: faultRef("5", "context", "context"), parentReceiptReference: faultRef("6", "receipt"), modelIdentity: "fake/model", sourceRevision: "parent-revision", capabilityIdentity: "fake.continuation", capabilityVersion: "1" };
		const faultEdge = faultReopen.persistPreparingChildIntent({ preparationId: "fault-prep", preparationDriver: "fake", preparationCapabilityIdentity: "fake.continuation", preparationCapabilityVersion: "1", parentTaskId: "fault-parent", childTaskId: "fault-child", childGoal: "accepted child", edgeId: "fault-edge", ordinal: 1, handoffArtifactId: faultConfig.handoffReference.id, checkpointArtifactId: faultConfig.checkpointReference.id, sequentialConfig: faultConfig });
		faultReopen.close();
		faultReopen = new LedgerStore(faultDb);
		check(faultEdge.status === "preparing" && faultReopen.getTask("fault-child") !== null && faultReopen.getParentEdge("fault-child")?.edgeId === "fault-edge" && faultReopen.getChildPreparationOwnership("fault-prep")?.status === "provider_preparing", "child creation and immutable references attach under preparation ownership");
		const completedFaultEdge = faultReopen.completeChildPreparation("fault-edge", { id: "fault-workspace", taskId: "fault-child", driver: "fake", hostPath: "/provider-owned", branchName: "fault-child" }, { id: "fault-cont", taskId: "fault-child", driver: "fake", providerVersion: "1", capabilityIdentity: "fake.continuation", capabilityVersion: "1", opaqueToken: "opaque", revision: "parent-revision" }, faultConfig);
		faultReopen.close();
		faultReopen = new LedgerStore(faultDb);
		check(completedFaultEdge.status === "ready" && faultReopen.getChildPreparationOwnership("fault-prep")?.status === "ready" && faultReopen.getTask("fault-parent")?.status === "awaiting_child", "provider preparation commits ready edge transactionally");
		faultReopen.close();

		// A capped child preserves its dirty workspace under a new checkpoint.
		// A second process resumes that checkpoint, retains the partial file, and
		// completes real integrated verification without transcript replay.
		const capRepo = join(root, "repo-capped"); mkdirSync(capRepo); execSync("jj git init --colocate", { cwd: capRepo, stdio: "pipe" }); writeFileSync(join(capRepo, "README.md"), "fixture\n"); execSync('JJ_EDITOR=true jj commit -m init', { cwd: capRepo, stdio: "pipe" });
		const capDb = join(root, "capped.sqlite"); const capArtifactsRoot = join(root, "capped-artifacts"); const capCalls = { value: 0 };
		const capPrepared = await prepareSequentialChild({ parentSpecMarkdown: PARENT, childSpecMarkdown: RESUMABLE_CHILD, projectDir: capRepo, artifactsDir: join(root, "capped-failures"), dbPath: capDb, model: "fake/model", workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: capRepo }), host: host(capCalls), artifactStore: new ContextArtifactStore({ root: capArtifactsRoot }) });
		const beforeCapLedger = new LedgerStore(capDb); const beforeCapCheckpoint = beforeCapLedger.getTaskEdge(capPrepared.edgeId!)?.checkpointArtifactId; beforeCapLedger.close();
		const capped = await resumeSequentialChild(capPrepared.edgeId!, { projectDir: capRepo, artifactsDir: join(root, "capped-failures"), dbPath: capDb, model: "fake/model", workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: capRepo }), host: interruptingHost(capCalls), artifactStore: new ContextArtifactStore({ root: capArtifactsRoot }), maxTurns: 1 });
		const cappedLedger = new LedgerStore(capDb); const cappedEdge = cappedLedger.getTaskEdge(capPrepared.edgeId!); const cappedSessions = cappedLedger.listSessions(capPrepared.childTaskId).length; cappedLedger.close();
		check(capped.status === "resumable" && cappedEdge?.status === "resumable" && cappedEdge.checkpointArtifactId !== beforeCapCheckpoint, "cap atomically refreshes checkpoint and marks child resumable");
		const capCompleted = await resumeSequentialChild(capPrepared.edgeId!, { projectDir: capRepo, artifactsDir: join(root, "capped-failures"), dbPath: capDb, model: "fake/model", workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: capRepo }), host: host({ value: 1 }), artifactStore: new ContextArtifactStore({ root: capArtifactsRoot }) });
		const capDoneLedger = new LedgerStore(capDb); const finalSessions = capDoneLedger.listSessions(capPrepared.childTaskId).length; capDoneLedger.close();
		check(capCompleted.status === "completed" && existsSync(join(capRepo, "partial.txt")) && existsSync(join(capRepo, "child.txt")) && cappedSessions === 1 && finalSessions === 2, `resumed child preserves partial work and completes verification in a new session (${capCompleted.status}, partial=${existsSync(join(capRepo, "partial.txt"))}, child=${existsSync(join(capRepo, "child.txt"))}, sessions=${cappedSessions}/${finalSessions})`);

		// A missing durable dependency is a typed, durable block. A separate
		// prepared edge supplies the corrupt-artifact case without reusing state.
		const missingRepo = join(root, "repo-missing"); mkdirSync(missingRepo); execSync("jj git init --colocate", { cwd: missingRepo, stdio: "pipe" }); writeFileSync(join(missingRepo, "README.md"), "fixture\\n"); execSync('JJ_EDITOR=true jj commit -m init', { cwd: missingRepo, stdio: "pipe" });
		const missingDb = join(root, "missing.sqlite"); const missingArtifactsRoot = join(root, "missing-artifacts"); const missingPrepared = await prepareSequentialChild({ parentSpecMarkdown: PARENT, childSpecMarkdown: CHILD, projectDir: missingRepo, artifactsDir: join(root, "missing-failures"), dbPath: missingDb, model: "fake/model", workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: missingRepo }), host: host(), artifactStore: new ContextArtifactStore({ root: missingArtifactsRoot }) });
		const missingLedger = new LedgerStore(missingDb); const missingConfig = missingPrepared.edgeId ? missingLedger.getSequentialEdgeConfig(missingPrepared.edgeId) : null; missingLedger.close();
		if (missingConfig) rmSync(join(missingArtifactsRoot, "checkpoint", missingConfig.checkpointReference.id.slice("sha256:".length)));
		const missing = await resumeSequentialChild(missingPrepared.edgeId!, { projectDir: missingRepo, artifactsDir: join(root, "missing-failures"), dbPath: missingDb, model: "fake/model", workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: missingRepo }), host: host(), artifactStore: new ContextArtifactStore({ root: missingArtifactsRoot }) });
		check(missing.status === "blocked" && missing.failureCode === "checkpoint_missing", "missing immutable dependency becomes typed durable block");

		const badRepo = join(root, "repo-bad"); mkdirSync(badRepo); execSync("jj git init --colocate", { cwd: badRepo, stdio: "pipe" }); writeFileSync(join(badRepo, "README.md"), "fixture\\n"); execSync('JJ_EDITOR=true jj commit -m init', { cwd: badRepo, stdio: "pipe" });
		const badDb = join(root, "bad.sqlite"); const badArtifactsRoot = join(root, "bad-artifacts"); const badPrepared = await prepareSequentialChild({ parentSpecMarkdown: PARENT, childSpecMarkdown: CHILD, projectDir: badRepo, artifactsDir: join(root, "bad-failures"), dbPath: badDb, model: "fake/model", workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: badRepo }), host: host(), artifactStore: new ContextArtifactStore({ root: badArtifactsRoot }) });
		const badLedger = new LedgerStore(badDb); const badConfig = badPrepared.edgeId ? badLedger.getSequentialEdgeConfig(badPrepared.edgeId) : null; badLedger.close();
		if (badConfig) writeFileSync(join(badArtifactsRoot, "handoff", badConfig.handoffReference.id.slice("sha256:".length)), "corrupt\\n");
		const corrupt = await resumeSequentialChild(badPrepared.edgeId!, { projectDir: badRepo, artifactsDir: join(root, "bad-failures"), dbPath: badDb, model: "fake/model", workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: badRepo }), host: host(), artifactStore: new ContextArtifactStore({ root: badArtifactsRoot }) });
		check(corrupt.status === "blocked" && corrupt.failureCode === "corrupt", "corrupt immutable dependency becomes typed durable block");

		// Child failure is a terminal parent failure, never a parent ship.
		const repoFail = join(root, "repo-fail"); mkdirSync(repoFail); execSync("jj git init --colocate", { cwd: repoFail, stdio: "pipe" }); writeFileSync(join(repoFail, "README.md"), "fixture\\n"); execSync('JJ_EDITOR=true jj commit -m init', { cwd: repoFail, stdio: "pipe" });
		const failDb = join(root, "failure.sqlite"); const failLedger = new LedgerStore(failDb);
		const failed = await runSequentialTask({ parentSpecMarkdown: PARENT, childSpecMarkdown: FAILING_CHILD, projectDir: repoFail, artifactsDir: join(root, "failures-2"), dbPath: failDb, model: "fake/model", workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: repoFail }), host: host(), artifactStore: new ContextArtifactStore({ root: join(root, "artifacts-2") }) });
		check(failed.status === "failed" && failed.parent.verdict === "failed" && failLedger.getTask(failed.parentTaskId)?.status === "failed", "parent cannot ship when child verification fails"); failLedger.close();

		// A terminal evidence persistence failure blocks settlement and therefore
		// cannot turn the admitted parent into a ship outcome.
		const evidenceFailureRepo = join(root, "repo-evidence-failure"); mkdirSync(evidenceFailureRepo); execSync("jj git init --colocate", { cwd: evidenceFailureRepo, stdio: "pipe" }); writeFileSync(join(evidenceFailureRepo, "README.md"), "fixture\n"); execSync('JJ_EDITOR=true jj commit -m init', { cwd: evidenceFailureRepo, stdio: "pipe" });
		const evidenceFailureDb = join(root, "evidence-failure.sqlite"); const evidenceFailureArtifacts = new ContextArtifactStore({ root: join(root, "evidence-failure-artifacts") });
		const evidencePrepared = await prepareSequentialChild({ parentSpecMarkdown: PARENT, childSpecMarkdown: CHILD, projectDir: evidenceFailureRepo, artifactsDir: join(root, "evidence-failure-recovery"), dbPath: evidenceFailureDb, model: "fake/model", workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: evidenceFailureRepo }), host: host(), artifactStore: evidenceFailureArtifacts });
		evidenceFailureArtifacts.putJson = (() => { throw new Error("simulated evidence persistence failure"); }) as typeof evidenceFailureArtifacts.putJson;
		const evidenceFailed = await resumeSequentialChild(evidencePrepared.edgeId!, { projectDir: evidenceFailureRepo, artifactsDir: join(root, "evidence-failure-recovery"), dbPath: evidenceFailureDb, model: "fake/model", workspaceDriver: new JujutsuWorkspaceDriver({ projectDir: evidenceFailureRepo }), host: host(), artifactStore: evidenceFailureArtifacts });
		const evidenceFailureLedger = new LedgerStore(evidenceFailureDb); const evidenceFailureEdge = evidenceFailureLedger.getTaskEdge(evidencePrepared.edgeId!);
		check(evidenceFailed.status === "failed" && evidenceFailed.parent.verdict !== "ship" && evidenceFailureEdge?.status === "blocked" && evidenceFailureLedger.getTask(evidenceFailed.parentTaskId)?.status === "failed", "failed terminal evidence persistence prevents parent ship"); evidenceFailureLedger.close();

		// A missing continuation capability blocks durably without child spawn.
		const repoBlock = join(root, "repo-block"); mkdirSync(repoBlock); execSync("jj git init --colocate", { cwd: repoBlock, stdio: "pipe" }); writeFileSync(join(repoBlock, "README.md"), "fixture\\n"); execSync('JJ_EDITOR=true jj commit -m init', { cwd: repoBlock, stdio: "pipe" });
		const blockDb = join(root, "blocked.sqlite"); const blocked = await runSequentialTask({ parentSpecMarkdown: PARENT, childSpecMarkdown: CHILD, projectDir: repoBlock, artifactsDir: join(root, "failures-3"), dbPath: blockDb, model: "fake/model", workspaceDriver: unsupported(new JujutsuWorkspaceDriver({ projectDir: repoBlock })), host: host(), artifactStore: new ContextArtifactStore({ root: join(root, "artifacts-3") }) });
		const blockedLedger = new LedgerStore(blockDb);
		check(blocked.status === "blocked" && blocked.failureCode === "unsupported" && blocked.edgeId !== undefined && blockedLedger.getTaskEdge(blocked.edgeId!)?.status === "blocked", "unsupported provider is typed, durable, and does not spawn twice"); blockedLedger.close();
	} finally { if (errors.length === 0) rmSync(root, { recursive: true, force: true }); }
	if (errors.length > 0) throw new Error(`sequential tests failed:\n  ${errors.join("\n  ")}`);
	console.log("✓ sequential: durable parent-child continuation");
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) runTests().catch((error: unknown) => { console.error(error); process.exit(1); });
