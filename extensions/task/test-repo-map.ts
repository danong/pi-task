/**
 * repo-map hermetic tests — no LLM anywhere:
 *
 * 1. skeleton: langs/symbols/LOC correct, binaries skipped
 * 2. tree hash: stable; changes when content changes
 * 3. cache: save/load roundtrip; agent-dir cache path (stable per dir,
 *    distinct across dirs, outside the repo); zero working-copy mutation
 * 4. slicing + injection: relevant file ranks top; prompt format
 * 5. parseAnnotation: fence-stripping, braces-slicing, malformed JSON
 *    throws, missing-field defaults
 * 6. config loader: defaults + temp-file parse; invalid TOML warns once,
 *    missing file stays silent
 * 7. skeleton mode: fresh build has no summaries; saveMap(fake full map)
 *    → edit one file → skeleton rebuild reuses cached summaries for
 *    unchanged files and never annotates (edited file has none)
 * 8. failure semantics: skeleton cache round-trips through save/load;
 *    cachedUsable rejects skeleton caches for full-mode requests (the
 *    annotation-retry contract); a REAL buildMap full build whose annotate
 *    throws (stub, no LLM) returns + persists a skeleton map, and the next
 *    full build retries annotation (succeeding stub) and returns + persists
 *    a full map — retry contract proven end to end
 *
 * The full LLM-annotated build, cache hit and incremental rebuild move to
 * test-e2e.ts section 6; the reads A/B benchmark is dropped (declared
 * benchmark-harness territory in the old suite's own comment).
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";
import {
	buildMap,
	buildSkeleton,
	formatMapOverview,
	formatMapPrompt,
	getTreeHash,
	isCacheUsableFor,
	loadCachedMap,
	loadRepoMapConfig,
	mapCachePath,
	parseAnnotation,
	saveMap,
	sliceRelevant,
	type CodebaseMap,
} from "./repo-map.ts";

function makeRepo(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-task-map-"));
	execSync("jj git init --colocate", { cwd: dir, stdio: "pipe" });
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(dir, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content);
	}
	execSync('jj commit -m "init"', { cwd: dir, stdio: "pipe" });
	return dir;
}

/** 1-3. Deterministic skeleton / hash / cache. */
function testSkeletonAndCache(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const dir = makeRepo({
		"calculator.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
		"utils.py": "def helper(x):\n    return x * 2\nclass Helper:\n    pass\n",
		"main.gd": "extends Node\nfunc _ready():\n    pass\n",
		"notes.md": "# Notes\njust prose\n",
		"binary.bin": Buffer.from([0, 1, 2, 255]).toString("binary"),
	});

	try {
		const skel = buildSkeleton(dir);
		const byPath = new Map(skel.map((f) => [f.path, f]));

		// Binaries skipped
		check(!byPath.has("binary.bin"), "binary.bin should be skipped");
		check(byPath.size === 4, `expected 4 files, got ${byPath.size}`);

		const calc = byPath.get("calculator.ts");
		check(!!calc && calc.lang === "typescript" && calc.symbols.includes("add"),
			`calculator.ts skeleton wrong: ${JSON.stringify(calc)}`);
		const util = byPath.get("utils.py");
		check(!!util && util.lang === "python" && util.symbols.includes("helper") && util.symbols.includes("Helper"),
			`utils.py skeleton wrong: ${JSON.stringify(util)}`);
		const gd = byPath.get("main.gd");
		check(!!gd && gd.lang === "gdscript" && gd.symbols.includes("_ready"),
			`main.gd skeleton wrong: ${JSON.stringify(gd)}`);

		// Tree hash: stable, then changes on edit
		const h1 = getTreeHash(dir);
		const h2 = getTreeHash(dir);
		check(h1 === h2, "tree hash should be stable");
		writeFileSync(join(dir, "calculator.ts"), "export function add(a: number, b: number): number {\n  return a + b + 1;\n}\n");
		const h3 = getTreeHash(dir);
		check(h1 !== h3, "tree hash should change when a file changes");

		// Cache roundtrip — stored under <agentDir>/cache/codebase-map/, never
		// inside the project working copy (zero WC mutation).
		const fakeMap: CodebaseMap = {
			treeHash: h3, generated: "t", generatorModel: "m", mode: "full",
			entryPoints: ["main.gd"], patterns: [], testLayout: "", files: buildSkeleton(dir),
		};
		saveMap(dir, fakeMap);
		const loaded = loadCachedMap(dir);
		check(!!loaded && loaded.treeHash === h3 && loaded.mode === "full", "cache roundtrip failed");
		const cacheFile = mapCachePath(dir);
		check(existsSync(cacheFile), `cache file should exist at ${cacheFile}`);
		check(!existsSync(join(dir, ".pi")), "map cache must not create anything inside the project repo");
		const tracked = execSync("jj file list", { cwd: dir, encoding: "utf8" });
		check(!tracked.includes("codebase-map"), "no cache files should be tracked in the repo");
	} finally {
		rmSync(mapCachePath(dir), { force: true });
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("✓ skeleton langs/symbols/binaries, hash stable+changes, cache outside the repo");
}

/** 3a. Cache path derivation: agent-dir scoped, stable, distinct. */
function testCachePathDerivation(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// Same source as repo-map.ts: the agent dir (pi's getAgentDir) — the
	// cache lives in the pi agent dir, not the package, so it survives
	// package relocations and never touches any task repo.
	const agentDir = getAgentDir();
	const root = join(agentDir, "cache", "codebase-map");
	const a = mkdtempSync(join(tmpdir(), "pi-task-map-a-"));
	const b = mkdtempSync(join(tmpdir(), "pi-task-map-b-"));
	try {
		const pa = mapCachePath(a);
		const pb = mapCachePath(b);
		check(pa.startsWith(root + "/"), `cache path ${pa} should be under ${root}`);
		check(pb.startsWith(root + "/"), `cache path ${pb} should be under ${root}`);
		check(pa === mapCachePath(a), "same project dir must map to the same cache path");
		check(pa !== pb, "different project dirs must map to different cache paths");
	} finally {
		rmSync(a, { recursive: true, force: true });
		rmSync(b, { recursive: true, force: true });
	}
	console.log("✓ cache path: under agent-dir cache root, stable per dir, distinct across dirs");
}

/** 4. Slicing + injection format. */
function testSlicingAndInjection(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const files = [
		{ path: "src/calculator.ts", lang: "typescript", symbols: ["add"], loc: 3, contentHash: "a", summary: "basic arithmetic operations (add)" },
		{ path: "src/renderer.ts", lang: "typescript", symbols: ["render"], loc: 3, contentHash: "b", summary: "renders output to console" },
		{ path: "src/storage.ts", lang: "typescript", symbols: ["save"], loc: 4, contentHash: "c", summary: "persists values" },
	] as CodebaseMap["files"];
	const map: CodebaseMap = {
		treeHash: "t", generated: "g", generatorModel: "m", mode: "full",
		entryPoints: ["src/main.ts"], patterns: ["ts modules"], testLayout: "tests/ via tests/run_all.sh",
		files,
	};

	const rel = sliceRelevant(map, "Add a multiply operation to the arithmetic module");
	check(rel.some((f) => f.path === "src/calculator.ts"),
		`calculator.ts should rank relevant, got ${rel.map((f) => f.path).join(",")}`);

	const prompt = formatMapPrompt(map, rel);
	check(prompt.includes("## Codebase map"), "prompt missing header");
	check(prompt.includes("Read the files above first"), "prompt missing guidance line");
	check(prompt.includes("src/calculator.ts"), "prompt missing relevant file");
	console.log("✓ slicing ranks relevant file, prompt format");
}

/** formatMapOverview: always-on main-session overview (Phase 9). */
function testFormatMapOverview(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const map: CodebaseMap = {
		treeHash: "h", generated: "g", generatorModel: "m", mode: "full",
		entryPoints: ["src/main.ts"],
		patterns: ["ts modules", "mvc"],
		testLayout: "tests/ via npm test",
		files: [],
	};
	const overview = formatMapOverview(map);
	check(overview.startsWith("## Codebase overview"), "overview missing header");
	check(overview.includes("Entry points: src/main.ts"), "overview missing entry points");
	check(overview.includes("Patterns: ts modules; mvc"), "overview missing patterns");
	check(overview.includes("Test layout: tests/ via npm test"), "overview missing test layout");
	check(!overview.includes("- "), "overview should NOT include the file list (that is the codebase_map tool's job)");

	// Empty map → empty string (callers skip the injection entirely).
	const empty = formatMapOverview({ ...map, entryPoints: [], patterns: [], testLayout: "" });
	check(empty === "", `empty map should produce "", got ${JSON.stringify(empty)}`);

	console.log("✓ formatMapOverview: entry points + patterns + test layout, no file list");
}

/** 5. parseAnnotation: fences, braces, malformed, defaults. */
function testParseAnnotation(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// Fence-stripping (```json ... ``` with prose around)
	const fenced = parseAnnotation(
		'Here is the result:\n```json\n{"entryPoints": ["src/main.ts"], "patterns": ["ts modules"], "testLayout": "", "files": [{"path": "a.ts", "role": "core", "summary": "does a"}]}\n```\nDone.',
	);
	check(fenced.entryPoints.length === 1 && fenced.entryPoints[0] === "src/main.ts",
		`fenced entryPoints wrong: ${JSON.stringify(fenced.entryPoints)}`);
	check(fenced.patterns.length === 1 && fenced.patterns[0] === "ts modules", `fenced patterns wrong: ${JSON.stringify(fenced.patterns)}`);
	check(fenced.files.length === 1 && fenced.files[0].path === "a.ts" && fenced.files[0].role === "core" && fenced.files[0].summary === "does a",
		`fenced files wrong: ${JSON.stringify(fenced.files)}`);

	// Braces-slicing: prose before/after the JSON object
	const sliced = parseAnnotation('Sure, the map is {"entryPoints": ["x.ts"], "files": []} — hope that helps.');
	check(sliced.entryPoints.length === 1 && sliced.entryPoints[0] === "x.ts",
		`braces-sliced entryPoints wrong: ${JSON.stringify(sliced.entryPoints)}`);

	// Malformed JSON throws (no braces, no fences)
	let threw = false;
	try {
		parseAnnotation("not json at all, just prose");
	} catch {
		threw = true;
	}
	check(threw, "malformed annotation should throw");

	// Missing-field defaults
	const empty = parseAnnotation("{}");
	check(empty.entryPoints.length === 0 && empty.patterns.length === 0 && empty.testLayout === "" && empty.files.length === 0,
		`empty annotation defaults wrong: ${JSON.stringify(empty)}`);
	const partial = parseAnnotation('{"files": [{"path": "a.ts"}]}');
	check(partial.files.length === 1 && partial.files[0].role === "" && partial.files[0].summary === "",
		`partial file entry defaults wrong: ${JSON.stringify(partial.files)}`);
	const nonArray = parseAnnotation('{"entryPoints": "not-an-array", "files": "nope"}');
	check(nonArray.entryPoints.length === 0 && nonArray.files.length === 0, "non-array fields should default to []");
	console.log("✓ parseAnnotation: fences, braces, throws, defaults");
}

/** 6. Config loader. */
function testConfigLoader(errors: string[]): void {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const defaults = loadRepoMapConfig("/nonexistent/repo-map.toml");
	check(defaults.mode === "full", "default mode should be full");
	check(defaults.injectWorkers === true, "default injectWorkers should be true");
	check(defaults.sliceLimit === 15, "default sliceLimit should be 15");

	const tmp = mkdtempSync(join(tmpdir(), "pi-task-cfg-"));
	const cfgPath = join(tmp, "repo-map.toml");
	writeFileSync(
		cfgPath,
		'[mode]\ndefault = "skeleton"\nannotation_model = "test/model"\n\n[injection]\nworkers = false\nslice_limit = 7\n',
	);
	const cfg = loadRepoMapConfig(cfgPath);
	check(cfg.mode === "skeleton", `mode should be skeleton, got ${cfg.mode}`);
	check(cfg.annotationModel === "test/model", `annotationModel should parse, got ${cfg.annotationModel}`);
	check(cfg.injectWorkers === false, "injectWorkers should be false");
	check(cfg.sliceLimit === 7, `sliceLimit should be 7, got ${cfg.sliceLimit}`);

	// Existing-but-invalid TOML → defaults + exactly one warn (mirrors
	// loadTaskConfig); a MISSING file → defaults + no warn.
	const warns: string[] = [];
	const origWarn = console.warn;
	console.warn = (msg: unknown) => { warns.push(String(msg)); };
	try {
		const invalidPath = join(tmp, "repo-map-invalid.toml");
		writeFileSync(invalidPath, "[mode\ndefault = "); // truncated table — invalid TOML
		const invalid = loadRepoMapConfig(invalidPath);
		check(invalid.mode === "full" && invalid.sliceLimit === 15,
			"invalid TOML should fall back to defaults");
		check(warns.length === 1, `invalid TOML should warn exactly once, got ${warns.length}: ${warns.join("; ")}`);

		const missingPath = join(tmp, "repo-map-missing.toml");
		const missing = loadRepoMapConfig(missingPath);
		check(missing.mode === "full", "missing config file should fall back to defaults");
		check(warns.length === 1, `missing file must NOT warn, got ${warns.length}`);
	} finally {
		console.warn = origWarn;
	}
	rmSync(tmp, { recursive: true, force: true });
	console.log("✓ config loader: defaults + temp-file parse, invalid warns once / missing silent");
}

/** 7. Skeleton mode — zero LLM calls, hermetic via saveMap. */
async function testSkeletonMode(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const dir = makeRepo({
		"src/calculator.ts": 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
		"src/renderer.ts": 'export function render(): void {\n  console.log("render");\n}\n',
		"README.md": "# Demo\n",
	});

	try {
		// Fresh repo in skeleton mode: no annotation call, no summaries.
		const fresh = await buildMap(dir, { mode: "skeleton" });
		check(fresh.mode === "skeleton", "fresh build should produce a skeleton map");
		check(!fresh.files.some((f) => f.summary), "skeleton mode should have no summaries on fresh build");
		check(fresh.entryPoints.length === 0, "skeleton mode should have no entryPoints on fresh build");

		// Slicing still works on path+symbols alone.
		const rel = sliceRelevant(fresh, "the calculator add function");
		check(rel.some((f) => f.path === "src/calculator.ts"),
			`skeleton slicing should rank calculator.ts, got ${rel.map((f) => f.path).join(",")}`);

		// Seed a fake FULL map via saveMap (exported, hermetic — stands in
		// for a previous annotated build). renderer.ts (the file we will
		// edit) deliberately has no cached summary.
		const treeHash = getTreeHash(dir);
		const skeleton = buildSkeleton(dir);
		const fakeFullMap: CodebaseMap = {
			treeHash,
			generated: "t0",
			generatorModel: "test-model",
			mode: "full",
			entryPoints: ["src/calculator.ts"],
			patterns: ["ts modules"],
			testLayout: "tests/ via run_all.sh",
			files: skeleton.map((f) =>
				f.path === "src/renderer.ts"
					? f
					: { ...f, role: "support", summary: `cached summary of ${f.path}` },
			),
		};
		saveMap(dir, fakeFullMap);

		// Unchanged tree: a skeleton request accepts the cached full map as-is.
		const hit = await buildMap(dir, { mode: "skeleton" });
		check(hit.generated === "t0" && hit.mode === "full", "skeleton request should hit the cached full map");

		// Edit one file → skeleton rebuild: unchanged files keep cached
		// summaries, the edited file gets none (skeleton mode never
		// annotates — the "has no summary" fact comes from the cache).
		writeFileSync(
			join(dir, "src/renderer.ts"),
			'export function render(): void {\n  console.log("render v2");\n}\n',
		);
		const skel = await buildMap(dir, { mode: "skeleton" });
		check(skel.treeHash !== treeHash, "treeHash should change after edit");
		check(skel.mode === "skeleton", "rebuild should produce a skeleton map");
		const calc = skel.files.find((f) => f.path === "src/calculator.ts");
		check(calc?.summary === "cached summary of src/calculator.ts",
			`unchanged file should keep its cached summary, got ${JSON.stringify(calc?.summary)}`);
		const renderer = skel.files.find((f) => f.path === "src/renderer.ts");
		check(renderer !== undefined && !renderer.summary,
			`edited file should have no summary in skeleton mode, got ${JSON.stringify(renderer?.summary)}`);
		check(skel.entryPoints.length === 1 && skel.entryPoints[0] === "src/calculator.ts",
			"entryPoints should be carried over from the cached annotation");
	} finally {
		rmSync(mapCachePath(dir), { force: true });
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("✓ skeleton mode: no summaries fresh, cache reuse, never annotates");
}

/** 8. Annotation-failure retry semantics (hermetic, zero LLM). */
async function testFailureSemantics(errors: string[]): Promise<void> {
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const dir = makeRepo({ "a.ts": "export const a = 1;\n" });
	try {
		const treeHash = getTreeHash(dir);
		// A skeleton map — exactly what buildMap persists after a failed
		// annotation (R3). save/load must round-trip the mode.
		const skeletonMap: CodebaseMap = {
			treeHash, generated: "t-fail", generatorModel: "m", mode: "skeleton",
			entryPoints: [], patterns: [], testLayout: "", files: buildSkeleton(dir),
		};
		saveMap(dir, skeletonMap);
		const loaded = loadCachedMap(dir);
		check(loaded !== null && loaded.mode === "skeleton",
			`skeleton mode should round-trip through the cache, got ${loaded?.mode}`);

		// cachedUsable semantics: a full-mode request rejects a skeleton cache
		// (so the next full build re-annotates the summary-less files — the
		// retry contract); skeleton requests accept any cache with a matching
		// tree hash.
		check(isCacheUsableFor(loaded, "full", treeHash) === false,
			"full request must reject a skeleton cache (annotation retry)");
		check(isCacheUsableFor(loaded, "skeleton", treeHash) === true,
			"skeleton request must accept a skeleton cache");
		check(isCacheUsableFor(loaded, "full", "other-hash") === false,
			"tree-hash mismatch must invalidate the cache");
		check(isCacheUsableFor({ ...skeletonMap, mode: "full" }, "full", treeHash) === true,
			"full request must accept a full cache");
		check(isCacheUsableFor(null, "full", treeHash) === false,
			"missing cache must not be usable");

		// REAL buildMap failure path via the annotate seam (stub, no pi
		// spawn): a full build whose annotation throws must return AND persist
		// a skeleton map — the seam drives the exact code path the old test
		// only approximated with saveMap. todo #73: the degradation is SILENT
		// — an annotation failure is an expected condition on normal runs
		// (transient LLM errors, unavailable model) and must not write to the
		// process console (it would leak into the prompt box).
		const warns: string[] = [];
		const origWarn = console.warn;
		console.warn = (msg: unknown) => { warns.push(String(msg)); };
		try {
			const failed = await buildMap(dir, { mode: "full", model: "m" }, {
				annotate: async () => { throw new Error("boom"); },
			});
			check(failed.mode === "skeleton",
				`failed annotation must yield a skeleton map, got "${failed.mode}"`);
			const persisted = loadCachedMap(dir);
			check(persisted !== null && persisted.mode === "skeleton",
				`failed annotation must persist a skeleton map, got ${persisted?.mode}`);
			check(warns.length === 0, `annotation failure must be silent, got warns: ${warns.join("; ")}`);
		} finally {
			console.warn = origWarn;
		}

		// Retry contract end to end: the next full build rejects the persisted
		// skeleton cache, re-annotates via the (now succeeding) stub, and must
		// return AND persist a full map.
		const retried = await buildMap(dir, { mode: "full", model: "m" }, {
			annotate: async () => ({ entryPoints: [], patterns: [], testLayout: "", files: [] }),
		});
		check(retried.mode === "full",
			`retried build must yield a full map, got "${retried.mode}"`);
		const retriedPersisted = loadCachedMap(dir);
		check(retriedPersisted !== null && retriedPersisted.mode === "full",
			`retried build must persist a full map, got ${retriedPersisted?.mode}`);
	} finally {
		rmSync(mapCachePath(dir), { force: true });
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("✓ failure semantics: skeleton round-trips; failed annotation persists skeleton, retry yields full");
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	console.log("── test-repo-map: skeleton/hash/cache, slicing, annotation parse, config, skeleton mode, failure semantics ──");
	testSkeletonAndCache(errors);
	testCachePathDerivation(errors);
	testSlicingAndInjection(errors);
	testFormatMapOverview(errors);
	testParseAnnotation(errors);
	testConfigLoader(errors);
	await testSkeletonMode(errors);
	await testFailureSemantics(errors);

	if (errors.length > 0) {
		throw new Error("test-repo-map failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log("✓ repo-map hermetic assertions passed");
}

// Direct execution support: `npx tsx extensions/task/test-repo-map.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
