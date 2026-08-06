import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspace, mergeWorkspacesAtomic, detectChangeConflicts, taskBaseChangeId, resolveCommitId } from './workspace.ts';

const UNION_SCRIPT = 'git merge-file --union -p "$1" "$2" "$3" > "$4" && test -s "$4"';

async function main(): Promise<void> {
	const jj = (a: string[], cwd: string): string => execFileSync("jj", a, { cwd, encoding: "utf8", env: { ...process.env, JJ_EDITOR: "true" } });
	const testDir = mkdtempSync(join(tmpdir(), "dbg-"));
	try {
		jj(["git", "init", "--colocate"], testDir);
		writeFileSync(join(testDir, "README.md"), "# t\n"); jj(["commit", "-m", "init"], testDir);
		writeFileSync(join(testDir, "comments.txt"), "// base note\ncode\n", "utf-8");
		jj(["commit", "-m", "base files"], testDir);
		const baseChange = await taskBaseChangeId(testDir);
		const w1 = await createWorkspace(testDir, "uni-1"); const w2 = await createWorkspace(testDir, "uni-2");
		writeFileSync(join(w1, "comments.txt"), "// worker one\ncode\n", "utf-8");
		jj(["commit", "-m", "w1"], w1);
		writeFileSync(join(w2, "comments.txt"), "// worker two\ncode\n", "utf-8");
		jj(["commit", "-m", "w2"], w2);
		await mergeWorkspacesAtomic(testDir, ["uni-1", "uni-2"], baseChange);
		console.log("conflicts:", JSON.stringify(await detectChangeConflicts(testDir, baseChange)));
		const commitId = await resolveCommitId(testDir, baseChange);
		const escaped = UNION_SCRIPT.replace(/"/g, '\\"');
		const cfg = [
			`merge-tools.union.program=sh`,
			`merge-tools.union.merge-args=["-c","${escaped}","pi-union","$left","$base","$right","$output"]`,
		];
		const flat: string[] = [];
		for (const c of cfg) flat.push("--config", c);
		console.log("config:", JSON.stringify(cfg[1]));
		await new Promise<void>((resolve) => {
			execFile("jj", [...flat, "resolve", "--tool", "union", "-r", commitId, "comments.txt"], { cwd: testDir, env: { ...process.env, JJ_EDITOR: "true" } }, (error, stdout, stderr) => {
				console.log("exit:", error ? (error as NodeJS.ErrnoException).code : 0);
				console.log("stderr:", stderr);
				console.log("stdout:", stdout);
				resolve();
			});
		});
		console.log("after:", JSON.stringify(await detectChangeConflicts(testDir, baseChange)));
	} finally { console.log("done"); }
}
main().catch((e) => { console.error(e); process.exit(1); });
