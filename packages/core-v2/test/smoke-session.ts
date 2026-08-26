/**
 * REAL session-host smoke test (M1.2 / R5) — not part of run-all.ts
 * (network + LLM cost). Run manually:
 *
 *   timeout 600 npx tsx packages/core-v2/test/smoke-session.ts
 *
 * Guard: when no OpenRouter credential is present (no OPENROUTER_API_KEY
 * env var and no stored credential in the active agent directory), the
 * test prints SKIPPED and exits 0 — it never hard-depends on network or
 * billing.
 *
 * What it proves: the in-process SessionHost (host.ts) spawns a real pi
 * SDK AgentSession bound to the hardcoded cheap model stealth/ox-alpha
 * in a temp jj repository, drives a trivial spec prompt to settlement,
 * and a typed `Yield` (yield tool, validated against the zod YieldSchema
 * from src/contracts/payloads.ts) arrives with files_changed=['hello.txt']
 * and that file on disk.
 *
 * The system prompt is self-contained (no skills/extensions/context files
 * are loaded), so the model needs only its tools to create the file,
 * commit with jj, and yield.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { readStoredCredential } from "@earendil-works/pi-coding-agent";

import { YieldSchema } from "../src/contracts/index.ts";
import { createSessionHost } from "../src/sessions/host.ts";

/** The ONLY model this smoke test ever uses: the cheap stealth dev tier. */
const MODEL = "stealth/ox-alpha";

/** Self-contained system prompt — the model must create and jj-commit hello.txt. */
const SYSTEM_PROMPT = [
	"You are a v2 worker session executing a single trivial spec.",
	"Working directory is the current working directory.",
	"Create a file hello.txt whose contents are exactly the two characters: v2",
	"Commit it with jj using the message 'add hello.txt'.",
	"When done, call the yield tool with files_changed=['hello.txt'], commit_ids=[the jj commit id], summary, deviations=[].",
	"Do NOT yield before the file exists and the commit is made.",
].join("\n");

const PROMPT = "Execute the spec now.";

/** Deterministic jj child env: no interactive editor, no host config. */
function jjEnv(): Record<string, string> {
	const env: Record<string, string> = { ...process.env, JJ_EDITOR: "true" };
	delete env.JJ_CONFIG;
	return env;
}

function jj(args: string[], cwd: string): string {
	return execFileSync("jj", args, {
		cwd,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
		env: jjEnv(),
	});
}

/** Fresh jj repo in `dir` with a deterministic worker-less identity. */
function initRepo(dir: string): void {
	jj(
		[
			"--config",
			'user.name="V2 Test"',
			"--config",
			'user.email="v2@test.dev"',
			"git",
			"init",
			"--colocate",
		],
		dir,
	);
	writeFileSync(join(dir, "README.md"), "# v2 smoke\n", "utf-8");
	jj(["commit", "-m", "init"], dir);
}

function fail(message: string): never {
	console.error(`✗ smoke-session: ${message}`);
	process.exit(1);
}

function hasOpenRouterAuth(): boolean {
	if (process.env.OPENROUTER_API_KEY) return true;
	try {
		return readStoredCredential("openrouter") !== undefined;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	if (!hasOpenRouterAuth()) {
		console.log(
			"SKIPPED: no OPENROUTER credential present — real session spawn is guarded (network + cost).",
		);
		return;
	}

	const dir = mkdtempSync(join(tmpdir(), "pi-task-v2-smoke-"));
	try {
		initRepo(dir);

		const host = createSessionHost();
		const events: string[] = [];
		const handle = await host.spawn({
			role: "smoke",
			modelId: MODEL,
			cwd: dir,
			systemPrompt: SYSTEM_PROMPT,
			timeoutMs: 9 * 60_000,
		});

		// Capture every turn/tool/settle event as clear evidence of streaming.
		const unsubscribe = handle.subscribe((event) => {
			events.push(event.type);
		});
		console.log(
			`spawned session: ${handle.model.provider}/${handle.model.modelId} role=${handle.role} cwd=${dir}`,
		);

		await handle.prompt(PROMPT);
		unsubscribe();

		const result = handle.result;
		if (!result) {
			fail("no typed yield captured — the model did not yield before settling");
		}

		// The yield payload must round-trip the canonical zod contract.
		const parsed = YieldSchema.safeParse(result);
		if (!parsed.success) {
			fail(
				`yield payload failed the canonical YieldSchema: ${JSON.stringify(parsed.error)}`,
			);
		}

		if (
			result.files_changed.length !== 1 ||
			result.files_changed[0] !== "hello.txt"
		) {
			fail(
				`expected files_changed=['hello.txt'], got ${JSON.stringify(result.files_changed)}`,
			);
		}

		const helloPath = join(dir, "hello.txt");
		if (!existsSync(helloPath)) {
			fail(`expected ${helloPath} to exist on disk`);
		}
		const content = readFileSync(helloPath, "utf-8").trim();
		if (content !== "v2") {
			fail(
				`expected hello.txt to contain exactly 'v2', got ${JSON.stringify(content)}`,
			);
		}

		const observed = new Set(events);
		for (const expected of ["turnStart", "toolEnd", "settled", "yielded"]) {
			if (!observed.has(expected)) {
				fail(
					`event stream missing '${expected}' (observed: ${[...observed].join(",")})`,
				);
			}
		}

		console.log(
			`✓ session smoke: ${result.commit_ids.length} commit(s), ` +
				`files_changed=${JSON.stringify(result.files_changed)}, events=${[...observed].join(",")}`,
		);
		handle.close();
	} catch (err) {
		if (err && typeof err === "object" && "code" in err) {
			fail(
				`SessionHostError(${JSON.stringify(err.code)}): ${err instanceof Error ? err.message : JSON.stringify(err)}`,
			);
		}
		fail(err instanceof Error ? err.message : String(err));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	});
}
