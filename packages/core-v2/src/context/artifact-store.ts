/** Repository-scoped immutable content-addressed storage for M4 artifacts. */
import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	linkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	ImmutableArtifactReferenceSchema,
	type ContextSensitivity,
	type ImmutableArtifactReference,
} from "../contracts/context-lifecycle.ts";
import { stableStringify } from "../contracts/serialize.ts";

export const DEFAULT_CONTEXT_ARTIFACT_MAX_BYTES = 512 * 1024;
export const CONTEXT_ARTIFACT_STORE_VERSION = 1 as const;
export type ArtifactReadResult =
	| { status: "present"; reference: ImmutableArtifactReference; bytes: Buffer }
	| { status: "absent"; reference: ImmutableArtifactReference }
	| { status: "invalidated"; reference: ImmutableArtifactReference }
	| { status: "corrupt"; reference: ImmutableArtifactReference; error: string };

export interface ContextArtifactStoreOptions {
	root: string;
	maxBytes?: number;
	allowedNamespaces?: readonly string[];
	maxSensitivity?: ContextSensitivity;
}

const sensitivityRank: Record<ContextSensitivity, number> = {
	public: 0,
	internal: 1,
	confidential: 2,
	restricted: 3,
};
const CANONICAL_NAMESPACES = new Set([
	"context",
	"source-view",
	"checkpoint",
	"plan",
	"tool-result",
]);
function validNamespace(value: string): boolean {
	return (
		CANONICAL_NAMESPACES.has(value) &&
		/^[a-z][a-z0-9-]*$/.test(value) &&
		value.length <= 64
	);
}
function digest(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function pathFor(root: string, ref: ImmutableArtifactReference): string {
	return join(root, ref.namespace, ref.id.slice("sha256:".length));
}
function markerFor(root: string, ref: ImmutableArtifactReference): string {
	return `${pathFor(root, ref)}.invalid`;
}
function checkReference(
	ref: ImmutableArtifactReference,
	maxBytes: number,
	namespaces: ReadonlySet<string>,
	maxSensitivity: ContextSensitivity,
): void {
	ImmutableArtifactReferenceSchema.parse(ref);
	if (!namespaces.has(ref.namespace))
		throw new Error(`artifact namespace is not allowed: ${ref.namespace}`);
	if (ref.namespace !== ref.kind)
		throw new Error(
			`artifact namespace ${ref.namespace} does not match kind ${ref.kind}`,
		);
	if (ref.sizeBytes > maxBytes)
		throw new RangeError(`artifact exceeds ${maxBytes} byte limit`);
	if (sensitivityRank[ref.sensitivity] > sensitivityRank[maxSensitivity])
		throw new Error(
			`artifact sensitivity exceeds store policy: ${ref.sensitivity}`,
		);
}

/**
 * The store never follows references outside its root. A failed read is a
 * typed result, allowing callers to omit optional context without inventing a
 * successful cache hit.
 */
export class ContextArtifactStore {
	readonly #root: string;
	readonly #maxBytes: number;
	readonly #namespaces: ReadonlySet<string>;
	readonly #maxSensitivity: ContextSensitivity;
	constructor(options: ContextArtifactStoreOptions) {
		this.#root = resolve(options.root);
		this.#maxBytes = options.maxBytes ?? DEFAULT_CONTEXT_ARTIFACT_MAX_BYTES;
		if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1)
			throw new RangeError("artifact maxBytes must be a positive safe integer");
		const namespaces = options.allowedNamespaces ?? [
			"context",
			"source-view",
			"checkpoint",
			"plan",
			"tool-result",
		];
		if (
			namespaces.length === 0 ||
			namespaces.some((value) => !validNamespace(value))
		)
			throw new RangeError("artifact namespaces must be non-empty safe names");
		this.#namespaces = new Set(namespaces);
		this.#maxSensitivity = options.maxSensitivity ?? "confidential";
		mkdirSync(this.#root, { recursive: true, mode: 0o700 });
	}
	get root(): string {
		return this.#root;
	}
	get maxBytes(): number {
		return this.#maxBytes;
	}
	reference(
		bytes: Uint8Array,
		metadata: Omit<ImmutableArtifactReference, "version" | "id" | "sizeBytes">,
	): ImmutableArtifactReference {
		const data = Buffer.from(bytes);
		const reference = ImmutableArtifactReferenceSchema.parse({
			version: CONTEXT_ARTIFACT_STORE_VERSION,
			id: digest(data),
			sizeBytes: data.byteLength,
			...metadata,
		});
		checkReference(
			reference,
			this.#maxBytes,
			this.#namespaces,
			this.#maxSensitivity,
		);
		return reference;
	}
	put(
		bytes: Uint8Array,
		metadata: Omit<ImmutableArtifactReference, "version" | "id" | "sizeBytes">,
	): ImmutableArtifactReference {
		const data = Buffer.from(bytes);
		const reference = this.reference(data, metadata);
		const target = pathFor(this.#root, reference);
		mkdirSync(join(this.#root, reference.namespace), { recursive: true });
		const existing = this.read(reference);
		if (existing.status === "present") return existing.reference;
		if (existing.status === "corrupt")
			throw new Error(
				`cannot replace corrupt immutable artifact ${reference.id}: ${existing.error}`,
			);
		const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
			try {
				linkSync(temporary, target);
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const raced = this.read(reference);
				if (raced.status !== "present")
					throw new Error(
						`artifact write race left no valid immutable artifact: ${reference.id}`,
					);
				return raced.reference;
			}
			return reference;
		} finally {
			try {
				unlinkSync(temporary);
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}
	putJson(
		value: unknown,
		metadata: Omit<
			ImmutableArtifactReference,
			"version" | "id" | "sizeBytes" | "mediaType"
		> & { mediaType?: string },
	): ImmutableArtifactReference {
		const bytes = Buffer.from(`${stableStringify(value)}\n`, "utf8");
		return this.put(bytes, {
			...metadata,
			mediaType: metadata.mediaType ?? "application/json",
		});
	}
	read(reference: ImmutableArtifactReference): ArtifactReadResult {
		try {
			checkReference(
				reference,
				this.#maxBytes,
				this.#namespaces,
				this.#maxSensitivity,
			);
		} catch (error: unknown) {
			return {
				status: "corrupt",
				reference,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		const target = pathFor(this.#root, reference);
		if (existsSync(markerFor(this.#root, reference)))
			return { status: "invalidated", reference };
		if (!existsSync(target)) return { status: "absent", reference };
		try {
			const bytes = readFileSync(target);
			if (
				bytes.byteLength !== reference.sizeBytes ||
				digest(bytes) !== reference.id
			)
				return {
					status: "corrupt",
					reference,
					error: "content hash or size mismatch",
				};
			return { status: "present", reference, bytes };
		} catch (error: unknown) {
			return {
				status: "corrupt",
				reference,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
	get(reference: ImmutableArtifactReference): Buffer | undefined {
		const result = this.read(reference);
		if (result.status === "present") return result.bytes;
		if (result.status === "absent" || result.status === "invalidated")
			return undefined;
		throw new Error(
			`corrupt context artifact ${reference.id}: ${result.error}`,
		);
	}
	has(reference: ImmutableArtifactReference): boolean {
		return this.read(reference).status === "present";
	}
	invalidate(reference: ImmutableArtifactReference): void {
		checkReference(
			reference,
			this.#maxBytes,
			this.#namespaces,
			this.#maxSensitivity,
		);
		mkdirSync(join(this.#root, reference.namespace), { recursive: true });
		const marker = markerFor(this.#root, reference);
		if (existsSync(marker)) return;
		const temporary = `${marker}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			writeFileSync(temporary, "invalidated\n", { flag: "wx", mode: 0o600 });
			renameSync(temporary, marker);
		} catch (error: unknown) {
			if (!existsSync(marker)) throw error;
		} finally {
			try {
				unlinkSync(temporary);
			} catch (cleanupError: unknown) {
				if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT")
					throw cleanupError;
			}
		}
	}
}

export function createContextArtifactStore(
	options: ContextArtifactStoreOptions,
): ContextArtifactStore {
	return new ContextArtifactStore(options);
}
export function deterministicArtifactId(bytes: Uint8Array): string {
	return digest(bytes);
}
