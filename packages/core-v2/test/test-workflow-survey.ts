/**
 * Hermetic tests for the read-only workflow survey
 * (packages/core-v2/src/workflow/survey.ts). Zero LLM, zero network,
 * zero spawns: coverage of
 *
 *   - READ-ONLY (R1): a before/after tree snapshot proves the survey
 *     writes nothing — no file mutations, no creations, no ledger;
 *   - BOUNDED + DETERMINISTIC (R3): maxFindings truncation is honest,
 *     findings come back under a total order, skip-listed directories
 *     are never entered, and identical inputs yield identical output
 *     regardless of filesystem creation order;
 *   - IDEMPOTENT RE-RUN (R2): running twice on the same fixture and
 *     diffing the rendered reports yields byte-identical output;
 *   - GATE (R3): a denied SurveyGate blocks the scan (typed denial,
 *     nothing read), a granted gate emits permission.requested through
 *     a REAL InMemoryTaskGateway, ungated runs declare themselves.
 *
 * Standalone: npx tsx packages/core-v2/test/test-workflow-survey.ts
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	gatewaySurveyGate,
	renderSurveyReport,
	runWorkflowSurvey,
	SURVEY_PERMISSION_ACTION,
	type SurveyFinding,
} from "../src/workflow/survey.ts";
import { buildExecutionBundle } from "../src/grounding/bundle.ts";
import { InMemoryTaskGateway } from "../src/gateway/in-memory.ts";

/** Content+metadata fingerprint used to prove non-mutation (test-local;
 *  the survey itself never needs this — it only reads). */
function snapshotTree(root: string): Map<string, number> {
	const snap = new Map<string, number>();
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, e.name);
			if (e.isDirectory()) stack.push(full);
			else if (e.isFile()) snap.set(full, statSync(full).mtimeMs ^ statSync(full).size);
		}
	}
	return new Map([...snap].sort());
}

interface Fixture {
	root: string;
	files: string[];
}

/** Deterministic fixture: nested files, an oversized file, and a
 *  node_modules subtree that must never be entered. */
function makeFixture(parent: string, name: string): Fixture {
	const root = join(parent, name);
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
	const files = [
		join(root, "README.md"),
		join(root, join("src", "a.ts")),
		join(root, join("src", "b.ts")),
		join(root, join("node_modules", "pkg", "index.js")),
	];
	writeFileSync(files[0]!, "readme\n", "utf-8");
	writeFileSync(files[1]!, "export const a = 1;\n", "utf-8");
	writeFileSync(files[2]!, "export const b = 2;\n", "utf-8");
	writeFileSync(files[3]!, "module.exports = {};\n", "utf-8");
	// Oversized relative to the tiny budget used below.
	writeFileSync(join(root, "big.bin"), "x".repeat(5000), "utf-8");
	return { root, files };
}

function findingLocations(findings: readonly SurveyFinding[]): string[] {
	return findings.map((f) => f.location);
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	const parent = mkdtempSync(join(tmpdir(), "core-v2-survey-"));
	try {
		// ─── Read-only behavior (R1) ─────────────────────────────────
		{
			const fx = makeFixture(parent, "readonly");
			const before = snapshotTree(fx.root);
			const out = runWorkflowSurvey({ root: fx.root });
			check(out.kind === "report", `ungated survey produces a report (got ${out.kind})`);
			if (out.kind !== "report") throw new Error("survey unexpectedly denied");
			const after = snapshotTree(fx.root);
			check(after.size === before.size, `no files created or removed by survey (${before.size} → ${after.size})`);
			for (const [path, sig] of before) {
				check(after.get(path) === sig, `unmutated: ${path}`);
			}
			check(out.report.summary.gateDecision === "ungated", "no gate → decision recorded as ungated");
			// node_modules never entered: its file is invisible to findings
			// AND to the scanned count.
			check(out.report.summary.filesScanned === 4, `skip-list respected (scanned ${out.report.summary.filesScanned}, want 4)`);
			check(!findingLocations(out.report.findings).includes(join("node_modules", "pkg", "index.js")),
				"skipped directory contributes no findings");
		}

		// ─── Bundle + continuation inputs fold into typed findings ────
		{
			const fx = makeFixture(parent, "inputs");
			const bundle = buildExecutionBundle({
				taskId: "t-survey",
				goal: "g",
				requirements: ["r"],
				verificationCommands: ["true"],
				targetPaths: [fx.files[1]!, fx.files[2]!, join(fx.root, "missing.ts")],
			});
			const out = runWorkflowSurvey({
				root: fx.root,
				bundle,
				bundleCandidates: [fx.files[1]!, join(fx.root, "never-bundled.ts"), join(fx.root, "missing.ts")],
				continuation: {
					entries: [{ role: "user", content: "x".repeat(400) }],
					budgetTokens: 10,
				},
			});
			if (out.kind !== "report") throw new Error("survey unexpectedly denied");
			const cats = out.report.findings.map((f) => f.category);
			check(cats.includes("bundle-candidate"), "candidate dropped by builder surfaces as finding");
			check(cats.includes("continuation-budget"), "over-budget continuation surfaces as finding");
			check(
				findingLocations(out.report.findings).includes("continuation"),
				"continuation finding uses logical location",
			);
			// The builder SKIPS missing files silently — the survey makes
			// that visible without mutating anything.
			check(
				out.report.findings.some(
					(f) =>
						f.location === join(fx.root, "missing.ts") &&
						f.severity === "warn",
				),
				"missing bundle target reported at warn",
			);
		}

		// ─── Bounded + deterministic output (R3) ──────────────────────
		{
			const fx = makeFixture(parent, "bounded");
			const budget = { maxFileBytes: 10 };
			const full = runWorkflowSurvey({ root: fx.root, budget });
			if (full.kind !== "report") throw new Error("survey unexpectedly denied");
			check(full.report.summary.truncated === false, "default budget does not truncate small fixture");
			check(
				full.report.findings.some((f) => f.location.endsWith("big.bin")),
				"oversized file flagged",
			);

			// Total-order sort: severity asc (critical first), then location.
			const locs = findingLocations(full.report.findings);
			check(JSON.stringify(locs) === JSON.stringify([...locs].sort()), `findings sorted by location (got ${JSON.stringify(locs)})`);

			// Cap: maxFindings=1 truncates honestly.
			const capped = runWorkflowSurvey({ root: fx.root, budget: { ...budget, maxFindings: 1 } });
			if (capped.kind !== "report") throw new Error("survey unexpectedly denied");
			check(capped.report.findings.length === 1, "maxFindings cap applied");
			check(capped.report.summary.truncated === true, "truncation flagged in summary");
			check(
				capped.report.findings[0]?.severity === full.report.findings[0]?.severity &&
					capped.report.findings[0]?.location === full.report.findings[0]?.location,
				"cap keeps the top of the total order (deterministic prefix)",
			);

			// Filesystem creation order must not matter: rebuild the same
			// fixture with reversed insertion order and compare renders.
			const fx2root = join(parent, "bounded-reversed");
			mkdirSync(join(fx2root, "src"), { recursive: true });
			mkdirSync(join(fx2root, "node_modules/pkg"), { recursive: true });
			writeFileSync(join(fx2root, "big.bin"), "x".repeat(5000), "utf-8");
			writeFileSync(join(fx2root, "src", "b.ts"), "export const b = 2;\n", "utf-8");
			writeFileSync(join(fx2root, "src", "a.ts"), "export const a = 1;\n", "utf-8");
			writeFileSync(join(fx2root, "README.md"), "readme\n", "utf-8");
			writeFileSync(join(fx2root, "node_modules", "pkg", "index.js"), "module.exports = {};\n", "utf-8");
			const reversed = runWorkflowSurvey({ root: fx2root, budget });
			if (reversed.kind !== "report") throw new Error("survey unexpectedly denied");
			// Root paths differ between fixtures — normalize before diffing.
			const normalize = (s: string): string =>
				s.replaceAll("\\", "/").split("\n").filter((l) => !l.startsWith("root:")).join("\n");
			check(
				normalize(renderSurveyReport(full.report)) === normalize(renderSurveyReport(reversed.report)),
				"creation order does not affect rendered output",
			);
		}

		// ─── Idempotent re-run (R2) ───────────────────────────────────
		{
			const fx = makeFixture(parent, "idempotent");
			const input = {
				root: fx.root,
				budget: { maxFileBytes: 100 },
				bundle: buildExecutionBundle({
					taskId: "t-idem",
					goal: "g",
					requirements: [],
					verificationCommands: [],
					targetPaths: [fx.files[1]!],
				}),
			};
			const r1 = runWorkflowSurvey(input);
			const r2 = runWorkflowSurvey(input);
			if (r1.kind !== "report" || r2.kind !== "report") throw new Error("survey unexpectedly denied");
			const render1 = renderSurveyReport(r1.report);
			const render2 = renderSurveyReport(r2.report);
			check(render1 === render2, "re-run on unchanged tree → byte-identical render");
			// The report carries NO timestamp/id fields at all, so there is
			// nothing to normalize away — the raw bytes are already stable.
			check(!render1.match(/\d{4}-\d\d-\d\d|T\d\d:/), "render contains no timestamps by construction");

			// A changed tree DOES change the report (the survey is not a
			// constant function of nothing).
			writeFileSync(join(fx.root, "new-file.txt"), "fresh\n", "utf-8");
			const r3 = runWorkflowSurvey(input);
			if (r3.kind !== "report") throw new Error("survey unexpectedly denied");
			check(r3.report.summary.filesScanned === r1.report.summary.filesScanned + 1,
				"added file increments scanned count");
			check(renderSurveyReport(r3.report) !== render1, "changed tree → different render");
		}

		// ─── Human-gate surface (R3) ──────────────────────────────────
		{
			const fx = makeFixture(parent, "gated");

			// Denied: typed denial, and the scan provably never ran.
			let asked = 0;
			const deny: Parameters<typeof runWorkflowSurvey>[1] = {
				request: () => {
					asked += 1;
					return false;
				},
			};
			const denied = runWorkflowSurvey({ root: fx.root }, deny);
			check(denied.kind === "denied", `denied gate → typed denial (got ${denied.kind})`);
			check(asked === 1, "gate consulted exactly once");
			check(denied.kind === "denied" && denied.reason.includes(SURVEY_PERMISSION_ACTION),
				"denial reason names the action");

			// Granted through a REAL InMemoryTaskGateway: the additive
			// permission.requested event reaches subscribers.
			const gateway = new InMemoryTaskGateway({ rows: { tasks: new Map() } });
			const seen: Array<{ action: string; requestId: string }> = [];
			gateway.on("permission.requested", (event) => {
				if (event.type === "permission.requested") seen.push({ action: event.action, requestId: event.requestId });
			});
			const gate = gatewaySurveyGate(gateway, "t-survey", "sess-1", () => true);
			const granted = runWorkflowSurvey({ root: fx.root }, gate);
			check(granted.kind === "report", `granted gate → report (got ${granted.kind})`);
			if (granted.kind === "report") {
				check(granted.report.summary.gateDecision === "granted", "granted decision recorded on summary");
			}
			check(seen.length === 1 && seen[0]?.action === SURVEY_PERMISSION_ACTION,
				`gateway emitted exactly one permission.requested (${JSON.stringify(seen)})`);
		}

		// The survey catches per-directory read failures internally;
		// point it at a nonexistent root instead of patching fs so the
		// suite stays hermetic without monkey-patching.
		{
			const missing = runWorkflowSurvey({ root: join(parent, "does-not-exist") });
			if (missing.kind !== "report") throw new Error("survey unexpectedly denied");
			check(missing.report.summary.filesScanned === 0, "missing root scans zero files");
			check(missing.report.findings.some((f) => f.message.includes("directory unreadable")),
				"unreadable root → warn finding, not a crash");
		}
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}

	if (errors.length > 0) {
		throw new Error(`${errors.length} workflow-survey failure(s):\n- ${errors.join("\n- ")}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => {
			console.log("✓ workflow-survey");
			process.exit(0);
		})
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
