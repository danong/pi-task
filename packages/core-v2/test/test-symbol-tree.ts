/**
 * Hermetic contract tests for the deterministic symbol-tree context source.
 * Temporary filesystem fixtures only: zero model, network, or VCS calls.
 *
 * Standalone: npx tsx packages/core-v2/test/test-symbol-tree.ts
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { scanSymbolTree } from "../src/context/symbol-tree.ts";

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (condition: boolean, message: string): void => {
		if (!condition) errors.push(message);
	};
	const parent = mkdtempSync(join(tmpdir(), "core-v2-symbol-tree-"));
	const root = join(parent, "repo");
	const outside = join(parent, "outside");

	try {
		mkdirSync(join(root, "src"), { recursive: true });
		mkdirSync(join(root, "config"), { recursive: true });
		mkdirSync(join(root, "nested", ".git"), { recursive: true });
		mkdirSync(outside, { recursive: true });

		// Deliberately create paths out of order; output ordering must not depend
		// on directory insertion order.
		writeFileSync(
			join(root, "src", "z.ts"),
			"export class Zebra {}\nexport function zoom(): void {}\n",
			"utf8",
		);
		writeFileSync(
			join(root, "src", "a.py"),
			"class Alpha:\n    pass\n\ndef build_widget():\n    return Alpha()\n",
			"utf8",
		);
		writeFileSync(
			join(root, "config", "app.toml"),
			"[service]\nname = 'fixture'\nport = 8080\n",
			"utf8",
		);
		writeFileSync(
			join(root, "src", "many.ts"),
			Array.from(
				{ length: 8 },
				(_, index) => `export function symbol${index}(): void {}`,
			).join("\n"),
			"utf8",
		);
		writeFileSync(join(root, "image.dat"), Buffer.from([0, 1, 2, 3, 4]));
		writeFileSync(
			join(root, "notes.weird"),
			"unsupported but visible\n",
			"utf8",
		);
		const hugeContent = `export function hiddenBySize(): void {}\n${"x".repeat(700)}`;
		writeFileSync(join(root, "huge.ts"), hugeContent, "utf8");

		for (const ignored of [
			".jj",
			"node_modules",
			"vendor",
			"dist",
			"artifacts",
		]) {
			mkdirSync(join(root, ignored), { recursive: true });
			writeFileSync(
				join(root, ignored, "ignored.ts"),
				"export const leaked = true;\n",
				"utf8",
			);
		}
		writeFileSync(join(root, ".git"), "gitdir: ../worktrees/repo\n", "utf8");
		writeFileSync(
			join(root, "nested", ".git", "ignored.ts"),
			"export const leakedFromGitDirectory = true;\n",
			"utf8",
		);

		writeFileSync(
			join(outside, "secret.ts"),
			"export const escaped = true;\n",
			"utf8",
		);
		symlinkSync(join(outside, "secret.ts"), join(root, "escape-file.ts"));
		symlinkSync(outside, join(root, "escape-dir"), "dir");

		const options = {
			root,
			sourceRevision: "fixture-change-1",
			maxFileBytes: 512,
			maxSymbolsPerFile: 3,
		} as const;
		const first = scanSymbolTree(options);
		const second = scanSymbolTree(options);

		check(
			JSON.stringify(first) === JSON.stringify(second),
			"unchanged scans are byte-identical",
		);
		const paths = first.entries.map((entry) => entry.path);
		check(
			JSON.stringify(paths) === JSON.stringify([...paths].sort()),
			`entries have stable repository-relative ordering (${JSON.stringify(paths)})`,
		);
		check(
			paths.every((path) => !path.startsWith("/") && !path.includes("..")),
			"all indexed paths are safe and repository-relative",
		);

		const python = first.entries.find((entry) => entry.path === "src/a.py");
		const typescript = first.entries.find((entry) => entry.path === "src/z.ts");
		const toml = first.entries.find(
			(entry) => entry.path === "config/app.toml",
		);
		check(
			python?.language === "python" &&
				python.symbols.includes("Alpha") &&
				python.symbols.includes("build_widget"),
			"python class and function symbols are extracted",
		);
		check(
			typescript?.language === "typescript" &&
				typescript.symbols.includes("Zebra") &&
				typescript.symbols.includes("zoom"),
			"TypeScript class and function symbols are extracted",
		);
		check(
			toml?.language === "toml" && toml.symbols.includes("service"),
			"config files receive lightweight symbols",
		);
		check(
			python !== undefined &&
				python.sizeBytes !== null &&
				python.sizeBytes > 0 &&
				python.lineCount === 6 &&
				python.contentIdentity.startsWith("sha256:"),
			"indexed text carries size, line, and full-content identity metadata",
		);

		const many = first.entries.find((entry) => entry.path === "src/many.ts");
		check(many?.symbols.length === 3, "per-file symbol count is bounded");
		check(
			first.entries.every((entry) =>
				entry.symbols.every(
					(symbol) =>
						Buffer.byteLength(symbol, "utf8") <= first.limits.maxSymbolBytes,
				),
			),
			"every symbol name respects the byte bound",
		);
		check(
			first.entries.find((entry) => entry.path === "image.dat")?.status ===
				"binary",
			"binary files are represented explicitly",
		);
		check(
			first.entries.find((entry) => entry.path === "notes.weird")?.status ===
				"unsupported",
			"unsupported text files are represented explicitly",
		);
		const huge = first.entries.find((entry) => entry.path === "huge.ts");
		check(
			huge?.status === "oversized" &&
				huge.symbols.length === 0 &&
				huge.lineCount === null,
			"oversized source is represented without symbol extraction",
		);
		check(
			first.entries
				.filter((entry) => entry.status === "oversized")
				.every((entry) => entry.contentIdentityScope === "full"),
			"oversized files disclose their full-content identity scope",
		);

		// Mutate beyond the retained descriptor prefix while preserving the
		// file length. Identity must still cover the complete byte stream.
		const changedBeyondPrefix = `${hugeContent.slice(0, -1)}y`;
		check(
			changedBeyondPrefix.length === hugeContent.length,
			"oversized tail mutation preserves file length",
		);
		check(
			changedBeyondPrefix.slice(0, first.limits.maxFileBytes + 1) ===
				hugeContent.slice(0, first.limits.maxFileBytes + 1),
			"oversized mutation is beyond the retained descriptor prefix",
		);
		writeFileSync(join(root, "huge.ts"), changedBeyondPrefix, "utf8");
		const oversizedMutation = scanSymbolTree(options);
		const mutatedHuge = oversizedMutation.entries.find(
			(entry) => entry.path === "huge.ts",
		);
		const originalHuge = first.entries.find(
			(entry) => entry.path === "huge.ts",
		);
		check(
			mutatedHuge?.sizeBytes === originalHuge?.sizeBytes &&
				mutatedHuge?.contentIdentity !== originalHuge?.contentIdentity,
			"a same-size mutation beyond the retained prefix changes oversized content identity",
		);
		check(
			oversizedMutation.treeIdentity !== first.treeIdentity,
			"an oversized content mutation changes tree identity",
		);

		check(!paths.includes(".git"), "root Git worktree metadata file is absent");
		check(
			!paths.some((path) => path.split("/").includes(".git")),
			"Git metadata directories are absent at every depth",
		);
		for (const forbidden of [
			".jj/",
			"node_modules/",
			"vendor/",
			"dist/",
			"artifacts/",
			"escape-file.ts",
			"escape-dir/",
		]) {
			check(
				!paths.some((path) => path === forbidden || path.startsWith(forbidden)),
				`ignored or escaping path is absent: ${forbidden}`,
			);
		}

		check(
			first.provenance.sourceRevision === "fixture-change-1",
			"source revision provenance is retained",
		);
		check(
			first.provenance.source === "filesystem",
			"filesystem source provenance is explicit",
		);
		check(
			first.provenance.freshness.treeIdentity === first.treeIdentity &&
				first.provenance.freshness.kind === "content-addressed",
			"freshness provenance points at the content-addressed tree identity",
		);

		// Timestamp-only changes are irrelevant, while a same-path content
		// mutation changes both the file and aggregate identities.
		utimesSync(join(root, "src", "a.py"), new Date(1), new Date(1));
		const timestampOnly = scanSymbolTree(options);
		check(
			timestampOnly.treeIdentity === oversizedMutation.treeIdentity,
			"mtime does not affect identity",
		);
		writeFileSync(
			join(root, "src", "a.py"),
			"class Alpha:\n    pass\n\ndef build_widget():\n    return 'changed'\n",
			"utf8",
		);
		const mutated = scanSymbolTree(options);
		const mutatedPython = mutated.entries.find(
			(entry) => entry.path === "src/a.py",
		);
		check(
			mutatedPython?.contentIdentity !== python?.contentIdentity,
			"content mutation changes the relevant file identity",
		);
		check(
			mutated.treeIdentity !== oversizedMutation.treeIdentity,
			"content mutation changes tree identity",
		);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		throw new Error(`symbol-tree tests failed:\n  ✗ ${errors.join("\n  ✗ ")}`);
	}
	console.log(
		"✓ symbol-tree: deterministic bounded symbols, identities, provenance, and escape safety",
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
