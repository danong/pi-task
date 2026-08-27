/** Pure execution-epoch transitions and resume decisions. */
import { createHash } from "node:crypto";
import {
	ExecutionEpochSchema,
	type ContextPlan,
	type ExecutionEpoch,
	type WorkingCheckpoint,
} from "../contracts/context-lifecycle.ts";
import { stableStringify } from "../contracts/serialize.ts";

export type EpochTransition =
	"retry" | "interruption" | "model-change" | "context-pressure";
export interface StartEpochInput {
	role: string;
	modelId: string;
	plan: ContextPlan;
	tailBudgetTokens?: number;
	checkpoint?: WorkingCheckpoint;
}
function idFor(value: unknown): string {
	return `epoch-${createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24)}`;
}
function epoch(input: Omit<ExecutionEpoch, "id">): ExecutionEpoch {
	return ExecutionEpochSchema.parse({ ...input, id: idFor(input) });
}
export function startExecutionEpoch(input: StartEpochInput): ExecutionEpoch {
	const plan = input.plan;
	return epoch({
		version: 1,
		role: input.role,
		modelId: input.modelId,
		planId: plan.id,
		...(input.checkpoint === undefined
			? {}
			: { checkpointId: input.checkpoint.id }),
		status: "active",
		transition: "initial",
		tailBudgetTokens:
			input.tailBudgetTokens ?? plan.budgets.window.reserveTokens,
	});
}
export interface EpochTransitionInput {
	reason: EpochTransition;
	modelId?: string;
	plan?: ContextPlan;
	checkpoint?: WorkingCheckpoint;
	tailBudgetTokens?: number;
}
export function transitionExecutionEpoch(
	current: ExecutionEpoch,
	input: EpochTransitionInput,
): ExecutionEpoch {
	const previous = ExecutionEpochSchema.parse(current);
	const nextModel = input.modelId ?? previous.modelId;
	const nextPlan = input.plan?.id ?? previous.planId;
	const next = epoch({
		version: 1,
		parentId: previous.id,
		role: previous.role,
		modelId: nextModel,
		planId: nextPlan,
		...(input.checkpoint === undefined
			? {}
			: { checkpointId: input.checkpoint.id }),
		status: "active",
		transition: input.reason,
		tailBudgetTokens: input.tailBudgetTokens ?? previous.tailBudgetTokens,
	});
	return next;
}
export function resumeExecutionEpoch(
	current: ExecutionEpoch,
	input: Omit<EpochTransitionInput, "reason"> = {},
): ExecutionEpoch {
	return epoch({
		version: 1,
		parentId: current.id,
		role: current.role,
		modelId: input.modelId ?? current.modelId,
		planId: input.plan?.id ?? current.planId,
		...(input.checkpoint === undefined
			? {}
			: { checkpointId: input.checkpoint.id }),
		status: "active",
		transition: current.transition ?? "retry",
		tailBudgetTokens: input.tailBudgetTokens ?? current.tailBudgetTokens,
	});
}
export function shouldStartNewEpoch(input: {
	tailTokens: number;
	tailBudgetTokens: number;
	modelChanged?: boolean;
	interrupted?: boolean;
}): boolean {
	return (
		input.modelChanged === true ||
		input.interrupted === true ||
		input.tailTokens > input.tailBudgetTokens
	);
}
