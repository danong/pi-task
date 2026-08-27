/**
 * Hermetic worker-protocol tests: requirement-count policy, prompt assembly,
 * selected tools, and the session host's custom-tool registration.
 */

import type {
	AgentSession,
	CreateAgentSessionOptions,
	ModelRuntime,
	ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { YieldSchema } from "../src/contracts/index.ts";
import { DefaultSessionHost, selectWorkerTools } from "../src/sessions/host.ts";
import {
	getRequirementTrackingPolicy,
	makeYieldTool,
} from "../src/sessions/tools.ts";
import type { SessionHostDependencies } from "../src/sessions/host.ts";
import {
	buildWorkerPromptText,
	buildWorkerSystemPrompt,
	parseTaskSpec,
} from "../src/daemon/task-runner.ts";

const SINGLE_SPEC = `## Goal
Create one file.

## Requirements
- R1: one.txt exists

## Verification
- test -f one.txt
`;

const MULTI_SPEC = `## Goal
Create two files.

## Requirements
- R1: one.txt exists
- R2: two.txt exists

## Verification
- test -f one.txt
- test -f two.txt
`;

function fakeSession(): AgentSession {
	return {
		subscribe: () => () => undefined,
		getSessionStats: () => ({}) as ReturnType<AgentSession["getSessionStats"]>,
		abort: () => Promise.resolve(),
		setModel: () => Promise.resolve(),
		dispose: () => undefined,
	} as unknown as AgentSession;
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (condition: boolean, message: string): void => {
		if (!condition) errors.push(message);
	};

	const singleCount = parseTaskSpec(SINGLE_SPEC).requirements.length;
	const multiCount = parseTaskSpec(MULTI_SPEC).requirements.length;
	const singlePolicy = getRequirementTrackingPolicy(singleCount);
	const multiPolicy = getRequirementTrackingPolicy(multiCount);

	check(singleCount === 1, "single spec has one parsed requirement");
	check(multiCount === 2, "multi spec has multiple parsed requirements");
	check(
		!singlePolicy.checklistEnabled,
		"single requirement disables checklist",
	);
	check(multiPolicy.checklistEnabled, "multiple requirements enable checklist");

	const singlePrompt = buildWorkerSystemPrompt(SINGLE_SPEC);
	const multiPrompt = buildWorkerSystemPrompt(MULTI_SPEC);
	check(
		!singlePrompt.includes("checklist"),
		"single-requirement worker prompt does not mandate checklist",
	);
	check(
		multiPrompt.includes("must use the checklist tool") &&
			multiPrompt.includes("structured requirement tracking"),
		"multi-requirement worker prompt requires structured checklist tracking",
	);
	check(
		singlePrompt.includes("files_changed") &&
			singlePrompt.includes("summary") &&
			singlePrompt.includes("deviations") &&
			singlePrompt.includes("exactly one final call"),
		"worker prompt describes one typed yield with model work claims",
	);
	check(
		singlePrompt.includes(
			"deterministic engine code owns VCS finalization and verification",
		) &&
			!singlePrompt.includes("jj status") &&
			!singlePrompt.includes("git status") &&
			!singlePrompt.includes("commit_ids"),
		"worker prompt makes VCS finalization and verification engine-owned",
	);
	const userPrompt = buildWorkerPromptText(parseTaskSpec(SINGLE_SPEC));
	check(
		userPrompt.includes("files_changed") &&
			userPrompt.includes("summary") &&
			userPrompt.includes("deviations") &&
			!userPrompt.includes("test -f one.txt"),
		"worker turn asks for claims without making verification a model completion step",
	);

	check(
		!selectWorkerTools(singleCount).includes("checklist"),
		"single-requirement allowlist omits checklist",
	);
	check(
		selectWorkerTools(multiCount).includes("checklist"),
		"multi-requirement allowlist includes checklist",
	);

	const yielded: unknown[] = [];
	const yieldTool = makeYieldTool("/repo", {
		onYield: (payload) => yielded.push(payload),
	});
	const accepted = await yieldTool.execute(
		"call-1",
		{
			files_changed: ["/repo/one.txt"],
			summary: "Created the requested file.",
			deviations: [],
		},
		undefined,
		undefined,
		undefined as never,
	);
	check(
		yielded.length === 1 &&
			(accepted as { terminate?: boolean }).terminate === true &&
			JSON.stringify(yielded[0]).includes('"commit_ids":[]'),
		"yield accepts model claims without requiring commit ids",
	);
	const legacyPayload = YieldSchema.safeParse({
		files_changed: ["one.txt"],
		summary: "legacy fake result",
		deviations: [],
	});
	check(
		legacyPayload.success && legacyPayload.data.commit_ids.length === 0,
		"legacy yield parsing supplies an empty VCS claim list",
	);
	const duplicate = await yieldTool.execute(
		"call-2",
		{
			files_changed: ["one.txt"],
			summary: "duplicate",
			deviations: [],
		},
		undefined,
		undefined,
		undefined as never,
	);
	check(
		yielded.length === 1 &&
			(duplicate as { terminate?: boolean }).terminate !== true,
		"yield is a one-shot completion gate",
	);
	const invalidYieldTool = makeYieldTool("/repo", {
		onYield: (payload) => yielded.push(payload),
	});
	const invalid = await invalidYieldTool.execute(
		"call-invalid",
		{
			files_changed: [],
			summary: 42 as unknown as string,
			deviations: [],
		},
		undefined,
		undefined,
		undefined as never,
	);
	check(
		yielded.length === 1 &&
			(invalid as { terminate?: boolean }).terminate !== true,
		"yield remains schema-validated",
	);

	let captured: CreateAgentSessionOptions | undefined;
	const fakeRuntime = {
		hasConfiguredAuth: () => true,
	} as unknown as ModelRuntime;
	const fakeLoader = (): ResourceLoader =>
		({ reload: () => Promise.resolve() }) as unknown as ResourceLoader;
	const dependencies: SessionHostDependencies = {
		resolveCliModel: (() => ({
			model: { provider: "fake", id: "fake/model" },
			error: undefined,
		})) as unknown as NonNullable<SessionHostDependencies["resolveCliModel"]>,
		hasConfiguredAuth: () => true,
		buildSessionLoader: fakeLoader,
		createAgentSession: (options?: CreateAgentSessionOptions) => {
			captured = options;
			return Promise.resolve({
				session: fakeSession(),
				extensionsResult: {} as never,
			});
		},
	};
	const host = new DefaultSessionHost(fakeRuntime, dependencies);

	const singleHandle = await host.spawn({
		role: "single",
		modelId: "fake/model",
		cwd: ".",
		systemPrompt: singlePrompt,
		requirementCount: singleCount,
	});
	check(
		!captured?.tools?.includes("checklist"),
		"single-requirement SDK allowlist omits checklist",
	);
	check(
		!(captured?.customTools ?? []).some((tool) => tool.name === "checklist"),
		"single-requirement SDK custom tools omit checklist",
	);
	singleHandle.close();

	const multiHandle = await host.spawn({
		role: "multi",
		modelId: "fake/model",
		cwd: ".",
		systemPrompt: multiPrompt,
		requirementCount: multiCount,
	});
	check(
		captured?.tools?.includes("checklist") === true,
		"multi-requirement SDK allowlist includes checklist",
	);
	check(
		(captured?.customTools ?? []).some((tool) => tool.name === "checklist"),
		"multi-requirement SDK custom tools include checklist",
	);
	multiHandle.close();

	if (errors.length > 0) {
		throw new Error(`worker protocol tests failed:\n  ${errors.join("\n  ")}`);
	}
	console.log("✓ worker protocol: requirement-sensitive prompts and tools");
}

if (
	process.argv[1] &&
	import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")
) {
	runTests()
		.then(() => process.exit(0))
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		});
}
