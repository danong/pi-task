/**
 * Config-driven plugin loader — subsystems §3 / R2.
 *
 * A plugin is ONE FILE with ONE DEFAULT EXPORT implementing TaskPlugin,
 * listed by path under `[plugins]` in task.toml (no discovery magic).
 * Every bad path fails TYPED (PluginLoadError with code + recoverable
 * guidance) instead of being silently skipped.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
 *   paths = ["./plugins/my-plugin.mjs", "/abs/other-plugin.ts"]
 *
 * Paths are resolved against `cwd` (absolute entries pass through).
 * Missing file → []; malformed TOML or wrong-shaped [plugins] → typed
 * PluginLoadError (never silently ignored).
 */
export function readPluginPathsFromToml(tomlPath: string, cwd: string): string[] {
	if (!existsSync(tomlPath)) return [];
	const script = "import tomllib, json, sys; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb'))))";
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			execFileSync("python3", ["-c", script, tomlPath], {
				encoding: "utf8",
				maxBuffer: 1 << 20,
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
	} catch (err) {
		throw new PluginLoadError(
			"invalid_config",
			`unreadable/invalid TOML at ${tomlPath}`,
			tomlPath,
			"fix the task.toml syntax (validate with python3 -c \"import tomllib; tomllib.load(open(PATH,'rb'))\")",
			err,
		);
	}
	const plugins = (parsed as Record<string, unknown> | null)?.["plugins"];
	if (plugins === undefined) return [];
	const table = plugins as Record<string, unknown>;
	const paths = table?.["paths"];
	if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) {
		throw new PluginLoadError(
			"invalid_config",
			"[plugins] must be a table with paths = [array of file path strings]",
			tomlPath,
			'set [plugins] paths = ["<file>", ...] in task.toml',
			undefined,
		);
	}
	return (paths as string[]).map((entry) => (isAbsolute(entry) ? entry : resolve(cwd, entry)));
}

/**
 * Import ONE plugin file by ABSOLUTE path and validate its default
 * export against the TaskPlugin shape (name: string required; hooks
 * optional). Fails typed with recoverable guidance on every outcome.
 */
export async function importPluginAt(absolutePath: string): Promise<TaskPlugin> {
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
		mod = (await import(pathToFileURL(absolutePath).href)) as Record<string, unknown>;
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
export async function loadPluginsFromToml(tomlPath: string, cwd: string): Promise<TaskPlugin[]> {
	const paths = readPluginPathsFromToml(tomlPath, cwd);
	const plugins: TaskPlugin[] = [];
	for (const p of paths) {
		plugins.push(await importPluginAt(p));
	}
	return plugins;
}
