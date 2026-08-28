/** Hermetic working-checkpoint creation and persistence tests. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ContextArtifactStore } from "../src/context/artifact-store.ts";
import { WorkingCheckpointSchema } from "../src/contracts/context-lifecycle.ts";
import {
	createWorkingCheckpoint,
	loadWorkingCheckpoint,
	persistWorkingCheckpoint,
} from "../src/context/checkpoint.ts";

const plan = {
	version: 1 as const,
	id: `sha256:${"c".repeat(64)}`,
	namespace: "plan",
	kind: "plan" as const,
	mediaType: "application/json",
	sizeBytes: 1,
	sensitivity: "internal" as const,
	sourceRevision: "rev-1",
};

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (value: boolean, message: string): void => {
		if (!value) errors.push(message);
	};
	const root = mkdtempSync(join(tmpdir(), "core-v2-checkpoint-"));
	try {
		const input = {
			epochId: "epoch-1",
			workspaceRevision: "rev-1",
			plan,
			requirements: [{ id: "R1", status: "open" as const }],
			summary: {
				decisions: ["use the typed parser"],
				openQuestions: ["which fixture covers failure?"],
				nextActions: ["run the parser suite"],
			},
			verification: { status: "not-run" as const },
		};
		const first = createWorkingCheckpoint(input);
		const second = createWorkingCheckpoint(input);
		check(first.id === second.id, "checkpoint identity is deterministic");
		const store = new ContextArtifactStore({ root });
		const reference = persistWorkingCheckpoint(store, first);
		check(
			loadWorkingCheckpoint(store, reference)?.id === first.id,
			"checkpoint persists and loads through immutable storage",
		);
		check(
			!WorkingCheckpointSchema.safeParse({ ...first, transcript: "hidden" })
				.success && !JSON.stringify(first).includes("transcript"),
			"checkpoint shape cannot carry a transcript or undeclared reasoning field",
		);
		const secondStore = new ContextArtifactStore({ root });
		const reopened = loadWorkingCheckpoint(secondStore, reference);
		check(
			reopened !== undefined &&
			JSON.stringify(reopened) === JSON.stringify(first) &&
			Object.isFrozen(reference),
			"checkpoint round-trips through a newly constructed artifact store",
		);
		check(
			!JSON.stringify(first).includes("/tmp/") &&
			!JSON.stringify(first).includes("refs/heads") &&
			!JSON.stringify(first).includes("stdout"),
			"checkpoint contract contains no host path, branch, or output",
		);
		let rejected = false;
		try {
			createWorkingCheckpoint({
				...input,
				summary: {
					...input.summary,
					nextActions: ["private reasoning: /tmp/secret stdout"],
				},
			});
		} catch {
			rejected = true;
		}
		check(rejected, "prohibited session and host data is rejected");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	if (errors.length > 0)
		throw new Error(
			`test-context-checkpoint failed:\n  ✗ ${errors.join("\n  ✗ ")}`,
		);
	console.log(
		"✓ context-checkpoint: deterministic bounded declarative persistence",
	);
	return Promise.resolve();
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
