/** Context tool output-boundary validation and fallback tests. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ContextProvider } from "../src/contracts/context-provider.ts";
import { createRawContextProvider } from "../src/context/raw-provider.ts";
import { makeContextTool } from "../src/sessions/context-tool.ts";

function textOf(result: {
	content: Array<{ type: string; text?: string }>;
}): string {
	return result.content[0]?.text ?? "";
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (value: boolean, message: string): void => {
		if (!value) errors.push(message);
	};
	const root = mkdtempSync(join(tmpdir(), "core-v2-context-tool-"));
	try {
		const raw = createRawContextProvider({ root, sourceRevision: "rev" });
		const malicious: ContextProvider = {
			identity: { id: "malicious", version: "1" },
			compile: raw.compile.bind(raw),
			query: async () =>
				({
					...(await raw.query({ query: "" })),
					provider: { id: "malicious", version: "1" },
					sourceBody: "SOURCE_BODY_SENTINEL",
				}) as never,
			resolve: async () =>
				[
					{
						id: "h-0123456789abcdef",
						kind: "file",
						path: "src/file.ts",
						language: "typescript",
						status: "indexed",
						sourceIdentity: "sha256:test",
						contentIdentityScope: "full",
						sourceRevision: "rev",
						matchReasons: ["exact"],
						score: 1,
						provenance: {
							source: "fixture",
							sourceRevision: "rev",
							treeIdentity: "tree",
							selector: "test",
						},
						sourceBody: "SOURCE_BODY_SENTINEL",
					},
				] as never,
		};
		let fallbacks = 0;
		const tool = makeContextTool(malicious, {
			fallbackProvider: raw,
			onFallback: () => {
				fallbacks += 1;
			},
		});
		const query = await tool.execute(
			"query",
			{ action: "query", query: "file" },
			undefined,
			undefined,
			undefined as never,
		);
		check(
			(query.details as { status?: string }).status === "fallback" &&
				!textOf(query).includes("SOURCE_BODY_SENTINEL"),
			"undeclared provider query fields are rejected before tool output",
		);
		const resolve = await tool.execute(
			"resolve",
			{ action: "resolve", handles: ["h-0123456789abcdef"] },
			undefined,
			undefined,
			undefined as never,
		);
		check(
			(resolve.details as { status?: string }).status === "fallback" &&
				!textOf(resolve).includes("SOURCE_BODY_SENTINEL") &&
				fallbacks === 2,
			"undeclared materialization fields are rejected before tool output",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	if (errors.length > 0)
		throw new Error(`test-context-tool failed:\n  ✗ ${errors.join("\n  ✗ ")}`);
	console.log(
		"✓ context-tool: provider output is schema-valid, bounded, and body-free",
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
