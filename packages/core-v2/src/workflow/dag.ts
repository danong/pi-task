/**
 * /plan R2 — DAG synthesis over validated spec nodes (pure).
 *
 * `synthesizeDag` is a pure function over a list of already-validated
 * spec nodes: it produces a deterministic topological order (stable
 * Kahn's algorithm — ties broken by input order, never by time or hash
 * iteration), detects cycles as a typed error carrying the cycle path,
 * and enforces a configurable max-fan-out guard (default
 * DEFAULT_MAX_FAN_OUT) so no node depends on more than the limit.
 *
 * No fs, no ledger, no sessions — the caller decides what to persist.
 */

import type { ValidatedSpec } from "./plan.ts";

/**
 * Default max fan-out guard (R2): a sane ceiling on how many direct
 * dependencies one spec node may declare. Configurable via options.
 */
export const DEFAULT_MAX_FAN_OUT = 8;

/** One node in the plan DAG: a validated spec plus its caller-assigned id. */
export interface DagNode {
	id: string;
	spec: ValidatedSpec;
}

/** The synthesized plan: nodes in dependency order. */
export interface SynthesizedDag {
	/** Node ids in topological order — every dependency precedes its dependent. */
	order: string[];
	/** All nodes keyed by id (includes every node in `order`). */
	nodes: ReadonlyMap<string, DagNode>;
}

/** Typed synthesis failure with a stable machine-readable code. */
export type DagSynthesisCode =
	"cycle" | "unknown_dependency" | "fan_out_exceeded" | "duplicate_id";

export class DagSynthesisError extends Error {
	constructor(
		public readonly code: DagSynthesisCode,
		message: string,
	) {
		super(message);
		this.name = "DagSynthesisError";
	}
}

/** Typed cycle failure naming the offending path (id → id → … → id). */
export class DagCycleError extends DagSynthesisError {
	constructor(public readonly cyclePath: readonly string[]) {
		super("cycle", `spec DAG contains a cycle: ${cyclePath.join(" → ")}`);
		this.name = "DagCycleError";
	}
}

/**
 * Pure topological synthesis (R2). Deterministic: Kahn's queue drains in
 * insertion order so equal-priority roots keep their input order across
 * runs — the same node list always yields the same order.
 */
export function synthesizeDag(
	nodes: readonly DagNode[],
	options?: { maxFanOut?: number },
): SynthesizedDag {
	const maxFanOut = options?.maxFanOut ?? DEFAULT_MAX_FAN_OUT;

	const byId = new Map<string, DagNode>();
	for (const node of nodes) {
		if (byId.has(node.id)) {
			throw new DagSynthesisError(
				"duplicate_id",
				`duplicate spec node id: ${node.id}`,
			);
		}
		byId.set(node.id, node);
	}

	const dependenciesOf = new Map<string, string[]>();
	for (const node of nodes) {
		for (const dep of node.spec.dependsOn) {
			if (!byId.has(dep)) {
				throw new DagSynthesisError(
					"unknown_dependency",
					`node "${node.id}" depends on unknown spec "${dep}"`,
				);
			}
		}
		if (node.spec.dependsOn.length > maxFanOut) {
			throw new DagSynthesisError(
				"fan_out_exceeded",
				`node "${node.id}" declares ${node.spec.dependsOn.length} dependencies, exceeding the max fan-out of ${maxFanOut}`,
			);
		}
		dependenciesOf.set(node.id, [...node.spec.dependsOn]);
	}

	const dependentsOf = new Map<string, string[]>();
	const pendingCount = new Map<string, number>();
	for (const [id, deps] of dependenciesOf) {
		pendingCount.set(id, deps.length);
		for (const dep of deps) {
			const list = dependentsOf.get(dep) ?? [];
			list.push(id);
			dependentsOf.set(dep, list);
		}
	}

	const queue: string[] = [];
	for (const node of nodes) {
		if ((pendingCount.get(node.id) ?? 0) === 0) queue.push(node.id);
	}

	const order: string[] = [];
	while (queue.length > 0) {
		const id = queue.shift()!;
		order.push(id);
		for (const dependent of dependentsOf.get(id) ?? []) {
			const remaining = (pendingCount.get(dependent) ?? 1) - 1;
			pendingCount.set(dependent, remaining);
			if (remaining === 0) queue.push(dependent);
		}
	}

	if (order.length !== nodes.length) {
		throw new DagCycleError(findCyclePath(nodes, byId));
	}
	return { order, nodes: byId };
}

/**
 * Walk remaining unresolved edges to recover ONE concrete cycle path for
 * the typed error (deterministic: first edge in insertion order). Pure.
 */
function findCyclePath(
	nodes: readonly DagNode[],
	byId: ReadonlyMap<string, DagNode>,
): string[] {
	const start =
		nodes.find((n) => (byId.get(n.id)?.spec.dependsOn.length ?? -1) > 0) ??
		nodes[0];
	if (!start) return [];
	const path: string[] = [start.id];
	let current: string | undefined = start.spec.dependsOn[0];
	while (current !== undefined && !path.includes(current)) {
		path.push(current);
		current = byId.get(current)?.spec.dependsOn[0];
	}
	if (current !== undefined && path.includes(current)) {
		path.push(current); // close the loop for readability
	}
	return path;
}
