/**
 * Config-driven plugin loader — subsystems §3 / R2.
 *
 * A plugin is ONE FILE with ONE DEFAULT EXPORT implementing TaskPlugin,
 * listed by path under `[plugins]` in task.toml (no discovery magic).
 * Every bad path fails TYPED (PluginLoadError with code + recoverable
 * guidance) instead of being silently skipped.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { TaskPlugin } from "../contracts/task-plugin.ts";
import { PluginLoadError } from "./errors.ts";

/**
 * Extract the raw `[plugins]` path entries from a task.toml file.
 *
 * Shape (documented here because this is the canonical grammar):
 *
 *   [plugins]
 *   paths = ["./plugins/my-plugin.mjs", '/abs/other-plugin.ts']
 *
 * This is the ONLY supported grammar: a `[plugins]` table header, then a
 * `paths` key whose value is an array of quoted strings. The parser is a
 * small hand-written scanner (no python3/tomllib shell-out): it skips
 * whitespace and `#` comments (full-line and trailing), accepts single- or
 * double-quoted entries with backslash escapes inside quotes, tolerates
 * trailing commas, and rejects everything else typed.
 *
 * Paths are resolved against `cwd` (absolute entries pass through).
 * Missing file → []; malformed TOML or wrong-shaped [plugins] → typed
 * PluginLoadError (never silently ignored). Files larger than 1 MiB are
 * rejected outright (the former exec maxBuffer cap, retained).
 */
const MAX_TOML_BYTES = 1 << 20;

function parsePluginPaths(source: string, tomlPath: string): string[] {
	let i = 0;
	const n = source.length;

	const fail = (why: string): never => {
		throw new PluginLoadError(
			"invalid_config",
			`unreadable/invalid TOML at ${tomlPath}: ${why}`,
			tomlPath,
			'fix the task.toml syntax — supported grammar is exactly: [plugins] paths = ["<file>", ...]',
		);
	};

	const skipWsAndComments = (): void => {
		while (i < n) {
			const c = source[i]!;
			if (c === "#") {
				while (i < n && source[i] !== "\n") i += 1;
			} else if (/\s/.test(c)) {
				i += 1;
			} else {
				return;
			}
		}
	};

	/** Scan one quoted string starting at the opening quote. */
	const scanString = (): string => {
		const quote = source[i++]!;
		let out = "";
		while (i < n) {
			const c = source[i]!;
			if (c === quote) {
				i += 1;
				return out;
			}
			if (c === "\\") {
				i += 1;
				if (i >= n) fail("unterminated escape in string");
				const e = source[i++]!;
				out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e;
				continue;
			}
			out += c;
			i += 1;
		}
		// Explicit return keeps the checker happy about the exhausted loop.
		return fail("unterminated string literal");
	};

	skipWsAndComments();
	// Locate the [plugins] table header.
	for (;;) {
		skipWsAndComments();
		if (i >= n) return []; // no [plugins] section at all → no plugins
		if (source[i] !== "[")
			fail(`expected a table header at offset ${i}, got "${source[i]}"`);
		// A table header cannot span lines or swallow a '=' — scan only to
		// the closing bracket ON THIS LINE.
		let close = i + 1;
		while (
			close < n &&
			source[close] !== "]" &&
			source[close] !== "\n" &&
			source[close] !== "="
		)
			close += 1;
		if (close >= n || source[close] !== "]") fail("unterminated table header");
		const header = source.slice(i + 1, close).trim();
		i = close + 1;
		if (header === "plugins") break;
		skipToNextHeaderOrEof();
	}

	/** Advance past everything until the next `[header]` or EOF. */
	function skipToNextHeaderOrEof(): void {
		while (i < n) {
			if (source[i] === "[") return;
			i += 1;
		}
	}

	skipWsAndComments();
	// Inside [plugins]: expect `paths = [ ... ]` (other keys are skipped).
	while (i < n && source[i] !== "[") {
		skipWsAndComments();
		if (i >= n || source[i] === "[") break;
		const eq = source.indexOf("=", i);
		if (eq === -1) fail("expected key = value inside [plugins]");
		const key = source.slice(i, eq).trim().replace(/^"|"$/g, "");
		i = eq + 1;
		skipWsAndComments();
		if (key !== "paths") {
			// Unsupported sibling key: skip its value (string/array/other).
			if (source[i] === '"' || source[i] === "'") {
				scanString();
			} else if (source[i] === "[") {
				let depth = 0;
				while (i < n) {
					const c = source[i]!;
					if (c === '"' || c === "'") scanString();
					else if (c === "[") {
						depth += 1;
						i += 1;
					} else if (c === "]") {
						depth -= 1;
						i += 1;
						if (depth === 0) break;
					} else i += 1;
				}
			} else {
				while (i < n && !/[\n[]/.test(source[i]!)) i += 1;
			}
			continue;
		}
		if (source[i] !== "[") fail("paths must be an array of quoted strings");
		i += 1; // consume '['
		const paths: string[] = [];
		for (;;) {
			skipWsAndComments();
			if (i >= n) fail("unterminated paths array");
			if (source[i] === "]") {
				i += 1;
				return paths;
			}
			if (source[i] === ",") {
				i += 1; // tolerate trailing commas between entries
				continue;
			}
			if (source[i] !== '"' && source[i] !== "'")
				fail(`expected a quoted path entry at offset ${i}`);
			paths.push(scanString());
		}
	}
	// Reached another header (or EOF) without a paths key inside [plugins].
	throw new PluginLoadError(
		"invalid_config",
		`[plugins] must be a table with paths = [array of file path strings] (${tomlPath})`,
		tomlPath,
		'set [plugins] paths = ["<file>", ...] in task.toml',
	);
}

export function readPluginPathsFromToml(
	tomlPath: string,
	cwd: string,
): string[] {
	if (!existsSync(tomlPath)) return [];
	let source: string;
	try {
		const bytes = readFileSync(tomlPath);
		if (bytes.byteLength > MAX_TOML_BYTES) {
			throw new PluginLoadError(
				"invalid_config",
				`task.toml exceeds the ${MAX_TOML_BYTES}-byte cap at ${tomlPath}`,
				tomlPath,
				"keep task.toml under 1 MiB (move large config out of [plugins])",
			);
		}
		source = bytes.toString("utf-8");
	} catch (err) {
		if (err instanceof PluginLoadError) throw err;
		throw new PluginLoadError(
			"invalid_config",
			`unreadable TOML file at ${tomlPath}`,
			tomlPath,
			"ensure task.toml exists and is readable UTF-8",
			err,
		);
	}
	const paths = parsePluginPaths(source, tomlPath);
	return paths.map((entry) =>
		isAbsolute(entry) ? entry : resolve(cwd, entry),
	);
}

/**
 * Import ONE plugin file by ABSOLUTE path and validate its default
 * export against the TaskPlugin shape (name: string required; hooks
 * optional). Fails typed with recoverable guidance on every outcome.
 */
export async function importPluginAt(
	absolutePath: string,
): Promise<TaskPlugin> {
	if (!existsSync(absolutePath)) {
		throw new PluginLoadError(
			"not_found",
			`plugin file not found: ${absolutePath}`,
			absolutePath,
			"correct the path in task.toml [plugins] paths (relative entries resolve against cwd)",
		);
	}
	let mod: Record<string, unknown>;
	try {
		mod = (await import(pathToFileURL(absolutePath).href)) as Record<
			string,
			unknown
		>;
	} catch (err) {
		throw new PluginLoadError(
			"import_failed",
			`plugin module failed to load: ${absolutePath}`,
			absolutePath,
			"fix the module's syntax/import errors (see cause)",
			err,
		);
	}
	const candidate = mod?.["default"];
	if (
		candidate === null ||
		typeof candidate !== "object" ||
		typeof (candidate as TaskPlugin).name !== "string" ||
		(candidate as TaskPlugin).name.length === 0
	) {
		throw new PluginLoadError(
			"invalid_export",
			`plugin at ${absolutePath} must default-export an object with a non-empty string "name"`,
			absolutePath,
			'export default { name: "my-plugin", ...hooks } implementing TaskPlugin',
		);
	}
	return candidate as TaskPlugin;
}

/**
 * Load every plugin declared in a task.toml, resolving relative paths
 * against `cwd`, in declaration order. First bad path fails typed
 * (PluginLoadError) — a misconfigured plugin never silently vanishes.
 */
export async function loadPluginsFromToml(
	tomlPath: string,
	cwd: string,
): Promise<TaskPlugin[]> {
	const paths = readPluginPathsFromToml(tomlPath, cwd);
	const plugins: TaskPlugin[] = [];
	for (const p of paths) {
		plugins.push(await importPluginAt(p));
	}
	return plugins;
}
