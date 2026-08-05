import { runTests as runWs } from "/home/danong/projects/pi-task/extensions/task/test-workspace.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
async function main() {
	console.log("agentDir:", getAgentDir());
	await runWs();
	console.log("ALL PASS");
}
main().catch((e) => { console.error("FAIL workspace: " + e.message); process.exit(1); });
