/**
 * Typed local continuation store (ADR docs/adr/m5.5-linear-recovery.md).
 *
 * Holds compiled continuation-record bodies in local user state — outside the
 * checkout and outside canonical context artifacts (M5.5 ownership boundary).
 * The CAS pattern mirrors ContextArtifactStore (artifact-store.ts) where the
 * record contract allows: content-addressed sha256 ids, atomic temp+link
 * writes at 0600, hash-validated reads, and deterministic sorted-key JSON.
 *
 * This milestone wires cap-policy admission (R4/R5): `validate`/`read`/`write`
 * all re-validate the deferred task authority schema, declared expiry, store
 * byte bounds, AND the shared DEFAULT_CONTINUATION_CAP_POLICY (or a supplied
 * ContinuationCapPolicy override) using deterministic byte/token measurement
 * on canonical bytes — never a model call. `validate` maps hostile/malformed
 * JSON, hash/non-canonical failures, incompatible versions, expired timestamps
 * and over-budget records to typed blockers (corrupt|expired|incompatible|
 * over_budget|blocked) instead of generic throws; `read` may still throw on
 * corrupt/over-cap bodies (existing fail-closed behavior).
 */
import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	canonicalBytes,
	canonicalContinuationBytes,
	ContinuationRecordSchema,
	CONTINUATION_RECORD_VERSION,
	DEFAULT_CONTINUATION_CAP_POLICY,
	isExpired,
	type ContinuationBlocker,
	type ContinuationCapPolicy,
	type ContinuationRecord,
} from "../contracts/continuation-record.ts";
import { estimateContinuationTokens } from "./continuation-compiler.ts";

export const CONTINUATION_STORE_VERSION = 1 as const;
export const DEFAULT_CONTINUATION_STORE_MAX_BYTES = 2 * 1024 * 1024;
export const CONTINUATION_STORE_DIR_MODE = 0o700;
export const CONTINUATION_STORE_FILE_MODE = 0o600;

const RECORD_ID = /^sha256:[a-f0-9]{64}$/;

export interface ContinuationStoreOptions {
	/** Local-user-state root outside the checkout; created on first use. */
	root: string;
	/** Per-record byte ceiling enforced at write/read admission (store-wide). */
	maxBytes?: number;
	/** Cap-policy override applied by validate/write/read. Defaults to
	 *  DEFAULT_CONTINUATION_CAP_POLICY (shared with the compiler). */
	capPolicy?: ContinuationCapPolicy;
}

/** Typed admission result for `validate`. Failure to admit is a typed blocker
 *  (corrupt|expired|incompatible|over_budget|blocked), never a generic
 *  exception — the caller can render a stable, factual blocker reason. */
export type ContinuationValidationResult =
	| { status: "valid"; id: string }
	| { status: "blocked"; blocker: ContinuationBlocker; reason: string };

/** Typed local store surface. Record bodies never enter the checkout or
 *  canonical artifacts; ids are deterministic content hashes of the canonical
 *  sorted-key JSON. */
export interface ContinuationStore {
	/** Validate, bound, serialize deterministically and persist atomically at
	 *  0600. Returns the content-addressed record id (sha256). */
	write(record: ContinuationRecord): Promise<string>;
	/** Hash-validated read; `undefined` when absent, throws when corrupt or
	 *  over-cap. */
	read(id: string): Promise<ContinuationRecord | undefined>;
	/** Raw presence test for a well-formed record id. */
	exists(id: string): Promise<boolean>;
	/** Remove a record body; true when something was deleted. */
	delete(id: string): Promise<boolean>;
	/** Admission gate: schema, declared expiry, store byte bounds, and the cap
	 *  policy. Returns valid + deterministic id, or a typed blocker. */
	validate(record: unknown): Promise<ContinuationValidationResult>;
}

/** Typed admission failure surfaced by write/read. Carries the same stable
 *  blocker vocabulary as `validate` so callers can route it without string
 *  matching. */
export class ContinuationAdmissionError extends Error {
	readonly blocker: ContinuationBlocker;
	constructor(blocker: ContinuationBlocker, message: string) {
		super(`continuation record blocked (${blocker}): ${message}`);
		this.name = "ContinuationAdmissionError";
		this.blocker = blocker;
	}
}

function digest(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertRecordId(id: string): string {
	if (!RECORD_ID.test(id))
		throw new TypeError(`invalid continuation record id: ${id}`);
	return id;
}

/** Gate result: a parsed record that passed every cap, or a typed blocker. */
type GateResult =
	| { ok: true; parsed: ContinuationRecord; bytes: Buffer; id: string }
	| { ok: false; blocker: ContinuationBlocker; reason: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class LocalContinuationStore implements ContinuationStore {
	readonly #root: string;
	readonly #maxBytes: number;
	readonly #capPolicy: ContinuationCapPolicy;

	constructor(options: ContinuationStoreOptions) {
		this.#root = resolve(options.root);
		this.#maxBytes = options.maxBytes ?? DEFAULT_CONTINUATION_STORE_MAX_BYTES;
		this.#capPolicy = options.capPolicy ?? DEFAULT_CONTINUATION_CAP_POLICY;
		if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1)
			throw new RangeError(
				"continuation store maxBytes must be a positive safe integer",
			);
		continuationCapPolicyGuard(this.#capPolicy);
	}

	get root(): string {
		return this.#root;
	}
	get maxBytes(): number {
		return this.#maxBytes;
	}
	get capPolicy(): ContinuationCapPolicy {
		return this.#capPolicy;
	}

	#pathFor(id: string): string {
		return join(this.#root, id.slice("sha256:".length));
	}

	/** Full admission gate shared by write/validate (read enforces the cap
	 *  half against persisted bytes). Deterministic and pure of wall clock:
	 *  byte/token math on canonical bytes, never a model call. */
	#assess(record: unknown): GateResult {
		if (record === null || typeof record !== "object" || Array.isArray(record)) {
			return {
				ok: false,
				blocker: "corrupt",
				reason: "continuation record is not an object",
			};
		}
		const recordObject = record as Record<string, unknown>;
		if (
			typeof recordObject.version === "number" &&
			recordObject.version !== CONTINUATION_RECORD_VERSION
		) {
			return {
				ok: false,
				blocker: "incompatible",
				reason: `unsupported continuation record version ${String(recordObject.version)}`,
			};
		}
		let parsed: ContinuationRecord;
		try {
			parsed = ContinuationRecordSchema.parse(record);
		} catch (error: unknown) {
			return {
				ok: false,
				blocker: "corrupt",
				reason: `continuation record schema mismatch: ${errorMessage(error)}`,
			};
		}
		const bytes = canonicalContinuationBytes(parsed);
		const tokenEstimate = estimateContinuationTokens(bytes.byteLength);
		const reasons: string[] = [];
		if (bytes.byteLength > this.#maxBytes)
			reasons.push(
				`${bytes.byteLength} bytes exceeds store limit ${this.#maxBytes}`,
			);
		if (bytes.byteLength > this.#capPolicy.maxBytes)
			reasons.push(
				`${bytes.byteLength} bytes exceeds cap maxBytes ${this.#capPolicy.maxBytes}`,
			);
		if (tokenEstimate > this.#capPolicy.maxTokens)
			reasons.push(
				`${tokenEstimate} tokens exceeds cap maxTokens ${this.#capPolicy.maxTokens}`,
			);
		if (parsed.toolPairs.length > this.#capPolicy.maxPairs)
			reasons.push(
				`${parsed.toolPairs.length} tool pairs exceed cap maxPairs ${this.#capPolicy.maxPairs}`,
			);
		if (parsed.contextEntries.length > this.#capPolicy.maxContextEntries)
			reasons.push(
				`${parsed.contextEntries.length} context entries exceed cap maxContextEntries ${this.#capPolicy.maxContextEntries}`,
			);
		for (const element of [...parsed.toolPairs, ...parsed.contextEntries]) {
			if (canonicalBytes(element).byteLength > this.#capPolicy.maxBytesPerEntry)
				reasons.push(
					`an element exceeds the per-entry byte cap ${this.#capPolicy.maxBytesPerEntry}`,
				);
		}
		if (reasons.length > 0) {
			return { ok: false, blocker: "over_budget", reason: reasons.join("; ") };
		}
		return { ok: true, parsed, bytes, id: digest(bytes) };
	}

	async write(record: ContinuationRecord): Promise<string> {
		const gate = this.#assess(record);
		if (!gate.ok) throw new ContinuationAdmissionError(gate.blocker, gate.reason);
		if (isExpired(gate.parsed)) {
			throw new ContinuationAdmissionError(
				"expired",
				`continuation record expired at ${gate.parsed.expiresAt}`,
			);
		}
		const id = gate.id;
		mkdirSync(this.#root, {
			recursive: true,
			mode: CONTINUATION_STORE_DIR_MODE,
		});
		// Content-addressed: an already-persisted valid body is the same body.
		// A corrupt existing body fails closed rather than being overwritten.
		if ((await this.read(id)) !== undefined) return id;
		const target = this.#pathFor(id);
		const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			writeFileSync(temporary, gate.bytes, {
				flag: "wx",
				mode: CONTINUATION_STORE_FILE_MODE,
			});
			try {
				linkSync(temporary, target);
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				// A concurrent writer persisted the identical content first.
				if ((await this.read(id)) === undefined)
					throw new Error(
						`continuation record write race left no valid record: ${id}`,
					);
			}
			return id;
		} finally {
			try {
				unlinkSync(temporary);
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}

	async read(id: string): Promise<ContinuationRecord | undefined> {
		const checked = assertRecordId(id);
		const target = this.#pathFor(checked);
		if (!existsSync(target)) return undefined;
		let bytes: Buffer;
		try {
			bytes = readFileSync(target);
		} catch (error: unknown) {
			throw new Error(
				`continuation record read failed for ${id}: ${errorMessage(error)}`,
			);
		}
		if (digest(bytes) !== checked) {
			throw new ContinuationAdmissionError(
				"corrupt",
				`continuation record is corrupt (hash mismatch): ${id}`,
			);
		}
		if (bytes.byteLength > this.#maxBytes)
			throw new ContinuationAdmissionError(
				"over_budget",
				`continuation record exceeds ${this.#maxBytes} byte store limit: ${id}`,
			);
		let parsed: ContinuationRecord;
		try {
			parsed = ContinuationRecordSchema.parse(
				JSON.parse(bytes.toString("utf8")),
			);
		} catch (error: unknown) {
			throw new ContinuationAdmissionError(
				"corrupt",
				`continuation record is corrupt (invalid content): ${id}: ${errorMessage(error)}`,
			);
		}
		if (canonicalContinuationBytes(parsed).toString("hex") !== bytes.toString("hex")) {
			throw new ContinuationAdmissionError(
				"corrupt",
				`continuation record is corrupt (non-canonical content): ${id}`,
			);
		}
		// Re-validate the cap policy on the persisted body (R4): a record that
		// no longer fits the current caps fails closed on read.
		const gate = this.#assess(parsed);
		if (!gate.ok) throw new ContinuationAdmissionError(gate.blocker, gate.reason);
		return gate.parsed;
	}

	async exists(id: string): Promise<boolean> {
		const checked = assertRecordId(id);
		return existsSync(this.#pathFor(checked));
	}

	async delete(id: string): Promise<boolean> {
		const checked = assertRecordId(id);
		try {
			unlinkSync(this.#pathFor(checked));
			return true;
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	async validate(record: unknown): Promise<ContinuationValidationResult> {
		// Accept object or canonical byte/JSON-string form. A JSON string lets
		// hostile/malformed and non-canonical serialization map to a typed
		// `corrupt` blocker instead of an untyped throw.
		let target: unknown = record;
		let nonCanonical = false;
		if (typeof record === "string") {
			try {
				target = JSON.parse(record);
			} catch (error: unknown) {
				return {
					status: "blocked",
					blocker: "corrupt",
					reason: `malformed continuation JSON: ${errorMessage(error)}`,
				};
			}
			if (target === null || typeof target !== "object" || Array.isArray(target)) {
				return {
					status: "blocked",
					blocker: "corrupt",
					reason: "continuation record JSON is not an object",
				};
			}
			if (canonicalBytes(target).toString("utf8") !== record)
				nonCanonical = true;
		}
		const gate = this.#assess(target);
		if (!gate.ok) {
			return { status: "blocked", blocker: gate.blocker, reason: gate.reason };
		}
		if (isExpired(gate.parsed)) {
			return {
				status: "blocked",
				blocker: "expired",
				reason: `continuation record expired at ${gate.parsed.expiresAt}`,
			};
		}
		if (nonCanonical) {
			return {
				status: "blocked",
				blocker: "corrupt",
				reason: "continuation record is non-canonically serialized",
			};
		}
		return { status: "valid", id: gate.id };
	}
}

/** Value-level guard for a supplied cap policy (positive, finite limits). */
function continuationCapPolicyGuard(policy: ContinuationCapPolicy): void {
	for (const [key, value] of Object.entries(policy)) {
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new RangeError(
				`continuation cap policy ${key} must be a positive safe integer`,
			);
		}
	}
}

export function createContinuationStore(
	options: ContinuationStoreOptions,
): ContinuationStore {
	return new LocalContinuationStore(options);
}
