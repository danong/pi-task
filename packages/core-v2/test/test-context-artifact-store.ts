/** Hermetic local content-addressed context artifact store tests. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	ContextArtifactStore,
	deterministicArtifactId,
} from "../src/context/artifact-store.ts";

export function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (value: boolean, message: string): void => {
		if (!value) errors.push(message);
	};
	const root = mkdtempSync(join(tmpdir(), "core-v2-context-store-"));
	try {
		const store = new ContextArtifactStore({ root, maxBytes: 256 });
		const bytes = Buffer.from("bounded context", "utf8");
		const metadata = {
			namespace: "context",
			kind: "context" as const,
			mediaType: "text/plain",
			sensitivity: "internal" as const,
			sourceRevision: "rev-1",
		};
		const first = store.put(bytes, metadata);
		const second = store.put(bytes, metadata);
		check(
			first.id === second.id && first.id === deterministicArtifactId(bytes),
			"identical bytes deduplicate to one deterministic identity",
		);
		check(
			store.get(first)?.toString("utf8") === "bounded context",
			"stored bytes round-trip",
		);
		const target = join(
			root,
			first.namespace,
			first.id.slice("sha256:".length),
		);
		check(
			readFileSync(target, "utf8") === "bounded context",
			"artifact is repository-independent local state",
		);
		store.invalidate(first);
		store.invalidate(first);
		check(
			store.read(first).status === "invalidated",
			"invalidation is explicit and idempotent",
		);
		let oversizedRejected = false;
		try {
			store.put(Buffer.alloc(257), metadata);
		} catch {
			oversizedRejected = true;
		}
		check(oversizedRejected, "oversized artifacts fail closed");
		let sensitivityRejected = false;
		try {
			store.put(Buffer.from("restricted"), {
				...metadata,
				sensitivity: "restricted",
			});
		} catch {
			sensitivityRejected = true;
		}
		check(sensitivityRejected, "store sensitivity policy fails closed");
		const corruptStore = new ContextArtifactStore({
			root: join(root, "corrupt"),
		});
		const corruptRef = corruptStore.put(Buffer.from("original"), metadata);
		const corruptPath = join(
			corruptStore.root,
			corruptRef.namespace,
			corruptRef.id.slice("sha256:".length),
		);
		writeFileSync(corruptPath, "tampered", "utf8");
		check(
			corruptStore.read(corruptRef).status === "corrupt",
			"hash corruption is typed",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	if (errors.length > 0)
		throw new Error(
			`test-context-artifact-store failed:\n  ✗ ${errors.join("\n  ✗ ")}`,
		);
	console.log(
		"✓ context-artifact-store: immutable bounded local CAS semantics",
	);
	return Promise.resolve();
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runTests().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
