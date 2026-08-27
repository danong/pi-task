/** Hermetic M4 context-provider contracts: bounded handles only, no model/network. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	CompiledContextArtifactSchema,
	type ContextProvider,
} from "../src/contracts/index.ts";
import {
	DEFAULT_CONTEXT_BUDGET,
	buildInitialContextQuery,
	renderInitialContextArtifact,
} from "../src/context/compiler.ts";
import {
	createRawContextProvider,
	createSymbolTreeContextProvider,
} from "../src/context/providers.ts";
import { makeContextTool } from "../src/sessions/context-tool.ts";

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (condition: boolean, message: string): void => {
		if (!condition) errors.push(message);
	};
	const root = mkdtempSync(join(tmpdir(), "core-v2-context-provider-"));
	try {
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(
			join(root, "src", "widget.ts"),
			"export function createWidget(): string { return 'SOURCE_BODY_SENTINEL'; }\n",
			"utf8",
		);
		writeFileSync(
			join(root, "src", "other.ts"),
			"export const unrelated = true;\n",
			"utf8",
		);

		const query = buildInitialContextQuery("Create the widget.", [
			"R1: use createWidget",
			"R2: cover widget behavior",
		]);
		check(
			query ===
				buildInitialContextQuery("Create the widget.", [
					"R1: use createWidget",
					"R2: cover widget behavior",
				]),
			"validated goal/requirements compile to a deterministic query",
		);

		const raw = createRawContextProvider({ root, sourceRevision: "fixture-1" });
		const rawArtifact = await raw.compile({ query });
		check(
			rawArtifact.provider.id === "raw",
			"raw provider identity is explicit",
		);
		check(rawArtifact.handles.length === 0, "raw baseline injects no handles");
		check(
			rawArtifact.estimatedSize.characters === 0,
			"raw baseline reports zero context size",
		);
		CompiledContextArtifactSchema.parse(rawArtifact);

		const symbol = createSymbolTreeContextProvider({
			root,
			sourceRevision: "fixture-1",
		});
		const first = await symbol.compile({ query });
		const second = await symbol.compile({ query });
		check(
			JSON.stringify(first) === JSON.stringify(second),
			"symbol compilation is byte-deterministic",
		);
		check(
			first.provider.id === "symbol-tree",
			"symbol provider identity is explicit",
		);
		check(
			first.source.treeIdentity.startsWith("sha256:"),
			"artifact carries source tree identity",
		);
		check(
			first.handles.some((handle) => handle.path === "src/widget.ts"),
			"ranked handles select relevant source",
		);
		check(
			first.handles.every(
				(handle) =>
					handle.id.length > 0 &&
					handle.provenance.sourceRevision === "fixture-1",
			),
			"handles preserve stable identity and provenance",
		);
		check(
			first.handles.length <= DEFAULT_CONTEXT_BUDGET.maxHandles,
			"handle count is bounded",
		);
		check(
			first.estimatedSize.characters <= DEFAULT_CONTEXT_BUDGET.maxCharacters,
			"compiled characters are bounded",
		);
		const encoded = JSON.stringify(first);
		check(
			!encoded.includes("SOURCE_BODY_SENTINEL"),
			"compiled artifacts never contain source bodies",
		);
		const prompt = renderInitialContextArtifact(first);
		check(
			prompt.includes("Progressive context handles") &&
				prompt.includes("src/widget.ts"),
			"prompt injects compact progressive-disclosure handles",
		);
		check(
			!prompt.includes("SOURCE_BODY_SENTINEL") &&
				Buffer.byteLength(prompt, "utf8") <=
					DEFAULT_CONTEXT_BUDGET.maxCharacters,
			"prompt injection is body-free and bounded",
		);

		let fallbackEvidence:
			{ fallbackProvider: string; artifact: string | undefined } | undefined;
		const failingProvider: ContextProvider = {
			identity: symbol.identity,
			compile: symbol.compile.bind(symbol),
			query: async () => {
				throw new Error("retrieval failed");
			},
			resolve: symbol.resolve.bind(symbol),
		};
		const fallbackTool = makeContextTool(failingProvider, {
			fallbackProvider: raw,
			onFallback: (event) => {
				fallbackEvidence = {
					fallbackProvider: event.fallbackProvider.id,
					artifact: event.artifact?.provider.id,
				};
			},
		});
		const fallbackResult = await fallbackTool.execute(
			"fallback-query",
			{ action: "query", query: "createWidget" },
			undefined,
			undefined,
			undefined as never,
		);
		check(
			(fallbackResult.details as { status?: string }).status === "fallback" &&
				fallbackEvidence?.fallbackProvider === "raw" &&
				fallbackEvidence.artifact === "raw",
			"async retrieval failure returns bounded raw fallback and evidence",
		);

		let resolveFallback:
			{ fallbackProvider: string; artifact: string | undefined } | undefined;
		const resolveFailingProvider: ContextProvider = {
			identity: { id: "broken-index", version: "1" },
			compile: symbol.compile.bind(symbol),
			query: symbol.query.bind(symbol),
			resolve: () => {
				throw new Error("index unavailable");
			},
		};
		const resolveFallbackTool = makeContextTool(resolveFailingProvider, {
			fallbackProvider: raw,
			onFallback: (event) => {
				resolveFallback = {
					fallbackProvider: event.fallbackProvider.id,
					artifact: event.artifact?.provider.id,
				};
			},
		});
		const resolvedAfterFailure = await resolveFallbackTool.execute(
			"resolve-fallback",
			{ action: "resolve", handles: ["h-0123456789abcdef"] },
			undefined,
			undefined,
			undefined as never,
		);
		const resolvedFallbackText =
			(resolvedAfterFailure.content[0] as { text?: string } | undefined)?.text ?? "";
		let resolvedFallbackArtifact: { provider?: { id?: string }; budget?: unknown };
		try {
			resolvedFallbackArtifact = JSON.parse(resolvedFallbackText) as typeof resolvedFallbackArtifact;
		} catch {
			resolvedFallbackArtifact = {};
		}
		check(
			(resolvedAfterFailure.details as { status?: string }).status === "fallback" &&
			resolvedFallbackArtifact.provider?.id === "raw" &&
			resolvedFallbackArtifact.budget !== undefined &&
			resolveFallback?.fallbackProvider === "raw" &&
			resolveFallback.artifact === "raw",
			"handle resolution failure returns a raw artifact and records actual fallback",
		);

		let invalidFallbackNotified = false;
		const invalidTool = makeContextTool(symbol, {
			fallbackProvider: raw,
			onFallback: () => {
				invalidFallbackNotified = true;
			},
		});
		await invalidTool.execute(
			"resolve-invalid",
			{ action: "resolve", handles: ["../secret"] },
			undefined,
			undefined,
			undefined as never,
		);
		check(!invalidFallbackNotified, "invalid handles do not claim a fallback");

		const largeRoot = join(root, "large");
		mkdirSync(join(largeRoot, "src"), { recursive: true });
		for (let index = 0; index < 32; index += 1) {
			writeFileSync(
				join(largeRoot, "src", `widget-${index}.ts`),
				`export function createWidget${index}(): string { return "fixture"; }\n`,
				"utf8",
			);
		}
		const largeSymbol = createSymbolTreeContextProvider({
			root: largeRoot,
			sourceRevision: "fixture-large",
		});
		const largeTool = makeContextTool(largeSymbol);
		const largeQuery = await largeTool.execute(
			"large-query",
			{ action: "query", query: "widget" },
			undefined,
			undefined,
			undefined as never,
		);
		const largeQueryText =
			(largeQuery.content[0] as { text?: string } | undefined)?.text ?? "";
		try {
			const largeArtifact = JSON.parse(largeQueryText) as {
				budget?: { maxCharacters?: number };
				handles?: Array<{ provenance?: { treeIdentity?: string } }>;
			};
			check(
				largeArtifact.budget?.maxCharacters === DEFAULT_CONTEXT_BUDGET.maxCharacters &&
				(largeArtifact.handles?.length ?? 0) > 0 &&
				largeArtifact.handles?.every(
					(handle) => handle.provenance?.treeIdentity !== undefined,
				) === true,
				"large context query remains valid JSON with budget and provenance",
			);
		} catch {
			errors.push("large context query must return valid JSON");
		}

		const tool = makeContextTool(symbol);
		const queried = await tool.execute(
			"query-1",
			{ action: "query", query: "createWidget", max_results: 2 },
			undefined,
			undefined,
			undefined as never,
		);
		const queryText =
			(queried.content[0] as { text?: string } | undefined)?.text ?? "";
		check(
			queryText.includes("createWidget") &&
				!queryText.includes("SOURCE_BODY_SENTINEL"),
			"context query returns bounded metadata, not source",
		);
		const handleId = first.handles[0]?.id;
		if (handleId === undefined)
			errors.push("expected an initial handle for resolve test");
		else {
			const resolved = await tool.execute(
				"resolve-1",
				{ action: "resolve", handles: [handleId] },
				undefined,
				undefined,
				undefined as never,
			);
			const text =
				(resolved.content[0] as { text?: string } | undefined)?.text ?? "";
			check(
				text.includes("src/widget.ts") &&
					text.length <= DEFAULT_CONTEXT_BUDGET.maxCharacters,
				"handle resolution returns bounded path/symbol metadata",
			);
		}
		for (const bad of ["../secret", "unknown-handle"]) {
			const rejected = await tool.execute(
				`bad-${bad}`,
				{ action: "resolve", handles: [bad] },
				undefined,
				undefined,
				undefined as never,
			);
			check(
				(rejected.details as { status?: string }).status === "rejected",
				`resolve rejects ${bad.includes("..") ? "traversal" : "unknown handles"}`,
			);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	if (errors.length > 0)
		throw new Error(
			`test-context-provider failed:\n  ✗ ${errors.join("\n  ✗ ")}`,
		);
	console.log(
		"✓ context-provider: typed bounded compilation, provenance, and safe progressive disclosure",
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
