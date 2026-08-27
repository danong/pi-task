/** Final explicit acquisition/materialization boundary conformance. */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ContextProvider } from "../src/contracts/context-provider.ts";
import {
	ContextAcquisitionRequestSchema,
	ContextItemListSchema,
} from "../src/contracts/context-lifecycle.ts";
import { capabilitiesFromLegacyProvider } from "../src/context/provider-adapter.ts";
import { rawContextAcquisitionFactory } from "../src/context/raw-provider.ts";
import { symbolTreeAcquisitionFactory } from "../src/context/providers.ts";

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (value: boolean, message: string): void => {
		if (!value) errors.push(message);
	};
	const root = mkdtempSync(join(tmpdir(), "core-v2-acquisition-"));
	try {
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(
			join(root, "src", "widget.ts"),
			"export function createWidget() { return 'secret body'; }\n",
			"utf8",
		);
		const request = ContextAcquisitionRequestSchema.parse({
			root,
			sourceRevision: "attempt-1",
			needs: [
				{
					id: "need-1",
					requirementId: "R1",
					query: "createWidget",
					priority: 1,
				},
			],
		});
		const symbol = symbolTreeAcquisitionFactory.create({
			root,
			sourceRevision: "attempt-1",
		});
		const items = ContextItemListSchema.parse(
			await symbol.candidates.acquire(request),
		);
		check(
			items.some((item) => item.sourcePath === "src/widget.ts") &&
				!JSON.stringify(items).includes("secret body"),
			"symbol acquisition returns bounded lifecycle items without source bodies",
		);
		const resolved = ContextItemListSchema.parse(
			await symbol.materializer.materialize({
				handles: [items[0]!.id],
				requirementIds: ["R1"],
			}),
		);
		check(
			resolved[0]?.requirementIds.includes("R1") === true,
			"materialization preserves requirement linkage",
		);
		const raw = rawContextAcquisitionFactory.create({
			root,
			sourceRevision: "attempt-1",
		});
		check(
			(await raw.candidates.acquire(request)).length === 0 &&
				(await raw.materializer.materialize({ handles: ["missing"] }))
					.length === 0,
			"raw is a correct empty capability without an index",
		);
		const rawSource = readFileSync(
			new URL("../src/context/raw-provider.ts", import.meta.url),
			"utf8",
		);
		const kernelSource = readFileSync(
			new URL("../src/daemon/parallel.ts", import.meta.url),
			"utf8",
		);
		check(
			!rawSource.includes("./providers") &&
				!rawSource.includes("symbol-tree") &&
				!kernelSource.includes("context/providers") &&
				!kernelSource.includes("context-provider.ts"),
			"raw and kernel module graphs exclude optional symbol and legacy provider implementations",
		);
		const malformed: ContextProvider = {
			identity: { id: "malformed", version: "1" },
			compile: async () => {
				throw new Error("unused");
			},
			query: async () =>
				({
					provider: { id: "malformed", version: "1" },
					source: {
						source: "fixture",
						sourceRevision: "rev",
						treeIdentity: "tree",
						selector: "test",
					},
					query: "",
					handles: [],
					omissions: { count: 0, reasons: [] },
					estimatedSize: { characters: 0, tokens: 0 },
					budget: { maxHandles: 1, maxCharacters: 1, maxTokens: 1 },
					sourceBody: "forbidden",
				}) as never,
			resolve: () => [],
		};
		let malformedRejected = false;
		try {
			await capabilitiesFromLegacyProvider(malformed).candidates.acquire(
				request,
			);
		} catch {
			malformedRejected = true;
		}
		check(
			malformedRejected,
			"compatibility adapters fail closed on malformed provider output",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	if (errors.length > 0)
		throw new Error(
			`test-context-acquisition failed:\n  ✗ ${errors.join("\n  ✗ ")}`,
		);
	console.log(
		"✓ context-acquisition: explicit removable candidate and materialization capabilities",
	);
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
