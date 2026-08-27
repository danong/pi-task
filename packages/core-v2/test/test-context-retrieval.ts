/**
 * Hermetic contracts for deterministic retrieval over the symbol tree.
 * Temporary symbol-tree fixtures only: zero model calls and zero network.
 *
 * Standalone: npx tsx packages/core-v2/test/test-context-retrieval.ts
 */

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

import {
	retrieveSymbolTree,
	type ContextRetrievalResult,
} from "../src/context/retrieval.ts";
import { scanSymbolTree, type SymbolTree } from "../src/context/symbol-tree.ts";

function handleKeys(result: ContextRetrievalResult): string[] {
	return result.handles.map(
		(handle) => `${handle.kind}:${handle.path}:${handle.symbol ?? ""}`,
	);
}

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (condition: boolean, message: string): void => {
		if (!condition) errors.push(message);
	};
	const parent = mkdtempSync(join(tmpdir(), "core-v2-context-retrieval-"));
	const root = join(parent, "repo");

	try {
		mkdirSync(join(root, "src", "tools"), { recursive: true });
		mkdirSync(join(root, "tests"), { recursive: true });
		mkdirSync(join(root, "assets"), { recursive: true });
		writeFileSync(
			join(root, "src", "widget.ts"),
			[
				"export class WidgetService {}",
				"export function createWidget(): WidgetService {",
				'\treturn "SOURCE_BODY_SENTINEL" as unknown as WidgetService;',
				"}",
			].join("\n"),
			"utf8",
		);
		writeFileSync(
			join(root, "tests", "widget.test.ts"),
			"export function testCreateWidget(): void {}\n",
			"utf8",
		);
		writeFileSync(
			join(root, "src", "tools", "router.ts"),
			"export function routeTask(): void {}\n",
			"utf8",
		);
		writeFileSync(join(root, "assets", "image.png"), Buffer.from([0, 1, 2]));
		writeFileSync(
			join(root, "notes.weird"),
			"unsupported text remains discoverable by path\n",
			"utf8",
		);

		const tree = scanSymbolTree({
			root,
			sourceRevision: "retrieval-fixture-1",
		});

		// Exact symbol and path matches outrank token-only matches.
		const exactSymbol = retrieveSymbolTree(tree, "createWidget");
		check(
			exactSymbol.handles[0]?.kind === "symbol" &&
				exactSymbol.handles[0]?.symbol === "createWidget" &&
				exactSymbol.handles[0]?.matchReasons.includes("exact-symbol"),
			"exact symbol ranks first with an explicit reason",
		);
		const tokenSymbol = exactSymbol.handles.find(
			(handle) => handle.symbol === "testCreateWidget",
		);
		check(
			tokenSymbol?.matchReasons.includes("symbol-token") === true &&
				exactSymbol.handles[0]!.score > tokenSymbol.score,
			"exact symbol score is above a symbol-token match",
		);

		const exactPath = retrieveSymbolTree(tree, "tests/widget.test.ts");
		check(
			exactPath.handles[0]?.kind === "file" &&
				exactPath.handles[0]?.path === "tests/widget.test.ts" &&
				exactPath.handles[0]?.matchReasons.includes("exact-path"),
			"exact path ranks first with an explicit reason",
		);

		// Filename, path-segment, language, and symbol token signals are visible.
		const lexical = retrieveSymbolTree(tree, "widget typescript");
		check(
			lexical.handles.some(
				(handle) =>
					handle.kind === "file" &&
					handle.matchReasons.includes("filename-token") &&
					handle.matchReasons.includes("language-token"),
			),
			"filename and language token signals contribute to file handles",
		);
		const pathSegment = retrieveSymbolTree(tree, "tools");
		check(
			pathSegment.handles[0]?.path === "src/tools/router.ts" &&
				pathSegment.handles[0]?.matchReasons.includes("path-segment-token"),
			"directory path-segment token is retrievable",
		);

		// Structural adjacency exposes the compact counterpart handle without
		// copying either file body into the result.
		const adjacent = retrieveSymbolTree(tree, "WidgetService");
		const adjacentTest = adjacent.handles.find(
			(handle) =>
				handle.kind === "file" && handle.path === "tests/widget.test.ts",
		);
		check(
			adjacentTest?.matchReasons.includes("test-source-adjacent") === true,
			"a matching source symbol brings in its mechanically adjacent test file",
		);
		const serializedHandles = JSON.stringify(adjacent.handles);
		check(
			!serializedHandles.includes("SOURCE_BODY_SENTINEL") &&
				!["body", "content", "outline"].some((key) =>
					adjacent.handles.some((handle) => key in handle),
				),
			"handles preserve progressive disclosure and contain no source bodies",
		);
		check(
			adjacent.handles.every((handle) =>
				handle.sourceIdentity.startsWith("sha256:"),
			) && adjacent.metadata.treeIdentity === tree.treeIdentity,
			"every handle and result carry source identity",
		);

		// Unsupported and binary entries remain retrievable as file handles,
		// but can never manufacture symbol handles.
		for (const [query, path, status] of [
			["assets/image.png", "assets/image.png", "binary"],
			["notes.weird", "notes.weird", "unsupported"],
		] as const) {
			const result = retrieveSymbolTree(tree, query);
			check(
				result.handles[0]?.kind === "file" &&
					result.handles[0]?.path === path &&
					result.handles[0]?.status === status &&
					!result.handles.some((handle) => handle.kind === "symbol"),
				`${status} entry is represented only by a compact file handle`,
			);
		}

		// Output is independent of calls and input entry ordering.
		const first = retrieveSymbolTree(tree, "widget typescript");
		const reordered: SymbolTree = {
			...tree,
			entries: [...tree.entries].reverse(),
		};
		const second = retrieveSymbolTree(reordered, "widget typescript");
		check(
			JSON.stringify(first) === JSON.stringify(second),
			"stable ranking is byte-identical across calls and entry order",
		);

		// Duplicate tree entries/symbols collapse to one path+symbol handle.
		const widget = tree.entries.find(
			(entry) => entry.path === "src/widget.ts",
		)!;
		const duplicated: SymbolTree = {
			...tree,
			entries: [
				...tree.entries,
				{ ...widget, symbols: [...widget.symbols, ...widget.symbols] },
			],
		};
		const deduped = retrieveSymbolTree(duplicated, "widget");
		check(
			new Set(handleKeys(deduped)).size === deduped.handles.length &&
				deduped.metadata.deduplicatedCount > 0,
			"duplicate path+symbol handles are removed and reported",
		);

		// Every cap is configurable, enforced, and surfaced in omission metadata.
		const resultCapped = retrieveSymbolTree(tree, "typescript", {
			maxResults: 1,
		});
		check(
			resultCapped.handles.length === 1 &&
				resultCapped.metadata.omittedCount > 0 &&
				resultCapped.metadata.capped &&
				resultCapped.metadata.cappingReasons.includes("result-limit"),
			"result cap records omitted matches",
		);
		const characterCapped = retrieveSymbolTree(tree, "createWidget", {
			maxCharacters: 8,
		});
		check(
			characterCapped.handles.length === 0 &&
				characterCapped.metadata.charactersUsed <= 8 &&
				characterCapped.metadata.cappingReasons.includes("character-budget"),
			"character budget can omit an oversized compact handle",
		);
		const tokenCapped = retrieveSymbolTree(tree, "createWidget", {
			maxTokens: 1,
		});
		check(
			tokenCapped.handles.length === 0 &&
				tokenCapped.metadata.estimatedTokensUsed <= 1 &&
				tokenCapped.metadata.cappingReasons.includes("token-budget"),
			"estimated token budget can omit an oversized compact handle",
		);

		// Empty and unknown queries are safe, deterministic empty results rather
		// than implicit requests for the whole tree.
		for (const [query, status] of [
			["   ", "empty"],
			["no-such-file-or-symbol", "unknown"],
		] as const) {
			const result = retrieveSymbolTree(tree, query);
			check(
				result.handles.length === 0 &&
					result.metadata.queryStatus === status &&
					result.metadata.omittedCount === 0 &&
					!result.metadata.capped,
				`${status} query returns a safe deterministic empty result`,
			);
		}

		// Behavioral network tripwire plus import locality pin the zero-service
		// implementation: retrieval is a synchronous pure operation over the tree.
		const globals = globalThis as {
			fetch?: (...args: never[]) => unknown;
		};
		const originalFetch = globals.fetch;
		let networkCalls = 0;
		globals.fetch = () => {
			networkCalls += 1;
			throw new Error("network access is forbidden in retrieval");
		};
		try {
			retrieveSymbolTree(tree, "routeTask");
		} finally {
			if (originalFetch === undefined) delete globals.fetch;
			else globals.fetch = originalFetch;
		}
		const retrievalSource = readFileSync(
			new URL("../src/context/retrieval.ts", import.meta.url),
			"utf8",
		);
		const imports = retrievalSource
			.split("\n")
			.filter((line) => line.startsWith("import "));
		check(
			networkCalls === 0 &&
				imports.every(
					(line) =>
						line.startsWith("import type ") &&
						line.includes('"./symbol-tree.ts"'),
				),
			"retrieval uses no model, embedding, network, or nonlocal service import",
		);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		throw new Error(
			`context-retrieval tests failed:\n  ✗ ${errors.join("\n  ✗ ")}`,
		);
	}
	console.log(
		"✓ context-retrieval: stable lexical/structural handles, adjacency, deduplication, and honest budgets",
	);
	return Promise.resolve();
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests()
		.then(() => process.exit(0))
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		});
}
