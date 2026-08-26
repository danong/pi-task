/**
 * Tool-guard hermetic tests (Phase 2): the bash timeout cap + the
 * root-scoped search block policy. The extension glue is thin; the policy
 * is pure. Registered in test.ts.
 */

import { pathToFileURL } from "node:url";
import {
	capBashTimeout,
	isRootScopedSearch,
	rootScopedSearchReason,
	TOOL_GUARD_BASH_TIMEOUT_CAP_MS,
} from "./tools/tool-guard.ts";

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	// capBashTimeout
	check(
		capBashTimeout(undefined, 300_000) === 300_000,
		"absent timeout → the cap",
	);
	check(capBashTimeout(60_000, 300_000) === 60_000, "smaller timeout kept");
	check(capBashTimeout(999_999, 300_000) === 300_000, "larger timeout clamped");
	check(
		capBashTimeout(NaN, 300_000) === 300_000,
		"non-finite timeout → the cap",
	);
	check(TOOL_GUARD_BASH_TIMEOUT_CAP_MS === 300_000, "default cap is 5 minutes");

	// isRootScopedSearch — the incident class (session-dump sweeps)
	check(
		isRootScopedSearch('grep -rn "mergeWorkspace" .') === true,
		"bare-dot grep blocked",
	);
	check(
		isRootScopedSearch('grep -rn "mergeWorkspaces" . | head -5') === true,
		"bare-dot grep in a pipeline blocked",
	);
	check(
		isRootScopedSearch("find . -name '*.ts'") === true,
		"find over the root blocked",
	);
	check(
		isRootScopedSearch('rg "pattern" .') === true,
		"rg over the root blocked",
	);
	check(
		isRootScopedSearch('cd /workspace/pi-task; grep -rn "x" .') === true,
		"cd-prefixed root grep blocked",
	);
	check(
		isRootScopedSearch('timeout 30 grep -rn "x" .') === true,
		"timeout-prefixed root grep blocked",
	);

	// scoped searches pass
	check(
		isRootScopedSearch('grep -rn "mergeWorkspace" extensions/') === false,
		"dir-scoped grep passes",
	);
	check(
		isRootScopedSearch('grep -rn "x" extensions/task/ docs/') === false,
		"multi-dir grep passes",
	);
	check(
		isRootScopedSearch("find extensions -name '*.ts'") === false,
		"dir-scoped find passes",
	);
	check(
		isRootScopedSearch('grep -rn "x" . --exclude-dir=.pi') === false,
		"explicit exclusion passes",
	);
	check(
		isRootScopedSearch('grep "v1.2.3" versions.txt') === false,
		"dotted file arg is not a root scope",
	);
	check(
		isRootScopedSearch("npx tsx extensions/task/test.ts") === false,
		"non-search command passes",
	);
	check(
		isRootScopedSearch('echo "grep x ."') === false,
		"search inside an echo is not a search",
	);
	check(isRootScopedSearch("jj log -n 5") === false, "jj passes");

	// the block reason teaches the re-scope
	check(
		rootScopedSearchReason('grep -rn "x" .').includes("extensions/") &&
			rootScopedSearchReason('grep -rn "x" .').includes(".pi/sessions"),
		"block reason names the problem + the fix",
	);

	if (errors.length > 0) {
		throw new Error("test-tool-guard failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log(
		"✓ tool guard: bash timeout cap + root-scoped search block (Phase 2)",
	);
	return Promise.resolve();
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error((err as Error).message ?? err);
			process.exit(1);
		});
}
