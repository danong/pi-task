/**
 * JSONL framing unit tests — attachJsonlReader over in-process streams.
 *
 * Covers the framing contract worker sessions rely on: split on \n only
 * (NOT readline, which splits on U+2028/U+2029 and corrupts JSON strings),
 * strip trailing \r, flush the partial line on end, skip non-JSON and
 * empty lines. Zero subprocesses, zero LLM.
 */

import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { attachJsonlReader } from "./worker.ts";

/** Feed chunks through attachJsonlReader and resolve the parsed lines. */
function collect(chunks: Array<string | Buffer>): Promise<unknown[]> {
	const lines: unknown[] = [];
	const stream = Readable.from(chunks);
	attachJsonlReader(stream, (parsed) => lines.push(parsed));
	return new Promise((resolve) => {
		stream.on("end", () => resolve(lines));
	});
}

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	console.log("── test-jsonl: JSONL framing ──");

	// 1. \n-only splitting, chunk boundaries split mid-line
	{
		const lines = await collect(['{"a":1}\n{"b":', "2}\n", '{"c":3}\n']);
		check(lines.length === 3, `expected 3 lines, got ${lines.length}`);
		check(
			JSON.stringify(lines[0]) === '{"a":1}',
			`line 0 wrong: ${JSON.stringify(lines[0])}`,
		);
		check(
			JSON.stringify(lines[1]) === '{"b":2}',
			`line 1 wrong: ${JSON.stringify(lines[1])}`,
		);
		check(
			JSON.stringify(lines[2]) === '{"c":3}',
			`line 2 wrong: ${JSON.stringify(lines[2])}`,
		);
	}

	// 2. Trailing \r stripped (CRLF framing)
	{
		const lines = await collect(['{"a":1}\r\n{"b":2}\r\n']);
		check(
			lines.length === 2,
			`expected 2 lines with \\r\\n, got ${lines.length}`,
		);
		check(
			JSON.stringify(lines[0]) === '{"a":1}',
			`CRLF line 0 wrong: ${JSON.stringify(lines[0])}`,
		);
	}

	// 3. U+2028/U+2029 inside a JSON string must NOT split (readline bug)
	{
		const lines = await collect(['{"a":"x\u2028y\u2029z"}\n']);
		check(
			lines.length === 1,
			`U+2028/U+2029 split the line (readline bug): got ${lines.length} lines`,
		);
		check(
			(lines[0] as { a?: string }).a === "x\u2028y\u2029z",
			`string content corrupted: ${JSON.stringify(lines[0])}`,
		);
	}

	// 4. Partial line flushed on end (with and without trailing \r)
	{
		const bare = await collect(['{"a":1}']);
		check(
			bare.length === 1 && JSON.stringify(bare[0]) === '{"a":1}',
			`partial line not flushed: ${JSON.stringify(bare)}`,
		);
		const cr = await collect(['{"a":1}\r']);
		check(
			cr.length === 1 && JSON.stringify(cr[0]) === '{"a":1}',
			`partial CR line not flushed/stripped: ${JSON.stringify(cr)}`,
		);
	}

	// 5. Non-JSON lines skipped
	{
		const lines = await collect(['debug: not json\n{"a":1}\n']);
		check(
			lines.length === 1 && JSON.stringify(lines[0]) === '{"a":1}',
			`non-JSON line not skipped: ${JSON.stringify(lines)}`,
		);
	}

	// 6. Empty lines skipped
	{
		const lines = await collect(['\n\n{"a":1}\n\n']);
		check(
			lines.length === 1 && JSON.stringify(lines[0]) === '{"a":1}',
			`empty lines not skipped: ${JSON.stringify(lines)}`,
		);
	}

	if (errors.length > 0) {
		throw new Error("test-jsonl failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log("✓ splitting, CRLF, U+2028/29, flush-on-end, skip rules");
}

// Direct execution support: `npx tsx extensions/task/test-jsonl.ts`
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
