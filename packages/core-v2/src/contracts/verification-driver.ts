/**
 * Seam 4/6 — Verification (subsystems §1, contract FR-6).
 *
 * Completion is a fact, not a claim: a task completes only when its
 * spec's bash commands exit zero, executed on the merged tree
 * post-merge, each bounded by a per-command timeout. The gate never
 * trusts model assertions.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { WorkspaceContext } from "./workspace-driver.ts";

/** The canonical trace bound for per-command verification evidence. */
export const MAX_VERIFICATION_COMMAND_SUMMARIES = 24;

export interface VerificationCommandResult {
	/** Retained for bounded failure diagnostics; never copied into a trace. */
	command: string;
	exitCode: number;
	stdoutTail: string;
	stderrTail: string;
	durationMs: number;
	timedOut: boolean;
}

export interface VerificationCommandEvidence {
	/** Zero-based position in the declared verification command list. */
	index: number;
	/** Stable SHA-256 identity of the command text, not the text itself. */
	digest: string;
	exitCode: number;
	timedOut: boolean;
	durationMs: number;
}

export interface VerificationEvidence {
	executedCount: number;
	expectedCount: number;
	/** Executed command summaries omitted by the structural evidence bound. */
	omittedCount: number;
	/** True when the per-command summary bound dropped entries. */
	capped: boolean;
	commands: VerificationCommandEvidence[];
}

const VerificationCommandEvidenceSchema = z
	.object({
		index: z.number().int().nonnegative(),
		digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
		exitCode: z.number().int(),
		timedOut: z.boolean(),
		durationMs: z.number().finite().nonnegative(),
	})
	.strict();

export const VerificationEvidenceSchema = z
	.object({
		executedCount: z.number().int().nonnegative(),
		expectedCount: z.number().int().nonnegative(),
		omittedCount: z.number().int().nonnegative(),
		capped: z.boolean(),
		commands: z
			.array(VerificationCommandEvidenceSchema)
			.max(MAX_VERIFICATION_COMMAND_SUMMARIES),
	})
	.strict()
	.superRefine((evidence, ctx) => {
		if (
			evidence.omittedCount + evidence.commands.length !==
			evidence.executedCount
		) {
			ctx.addIssue({
				code: "custom",
				path: ["commands"],
				message: "summary counts do not account for every executed command",
			});
		}
		if (evidence.executedCount > evidence.expectedCount) {
			ctx.addIssue({
				code: "custom",
				path: ["executedCount"],
				message: "executed command count cannot exceed the expected count",
			});
		}
		if (evidence.capped !== evidence.omittedCount > 0) {
			ctx.addIssue({
				code: "custom",
				path: ["capped"],
				message: "capped must truthfully reflect omitted summaries",
			});
		}
	});

/** Keep an evidence payload within the canonical per-command bound. */
export function boundVerificationEvidence(
	input: VerificationEvidence,
): VerificationEvidence {
	const commands = input.commands.slice(0, MAX_VERIFICATION_COMMAND_SUMMARIES);
	return VerificationEvidenceSchema.parse({
		...input,
		commands,
		omittedCount: input.omittedCount + input.commands.length - commands.length,
		capped: input.capped || input.commands.length > commands.length,
	});
}

/** Hash a command without retaining its text in canonical evidence. */
export function verificationCommandDigest(command: string): string {
	return `sha256:${createHash("sha256").update(command).digest("hex")}`;
}

/** Build bounded, structural evidence from runner results. Pure. */
export function buildVerificationEvidence(
	commands: readonly VerificationCommandResult[],
	expectedCount = commands.length,
): VerificationEvidence {
	const summaries = commands
		.slice(0, MAX_VERIFICATION_COMMAND_SUMMARIES)
		.map((command, index) => ({
			index,
			digest: verificationCommandDigest(command.command),
			exitCode: command.exitCode,
			timedOut: command.timedOut,
			durationMs: Math.max(0, command.durationMs),
		}));
	return VerificationEvidenceSchema.parse({
		executedCount: commands.length,
		expectedCount: Math.max(0, expectedCount),
		omittedCount: commands.length - summaries.length,
		capped: commands.length > summaries.length,
		commands: summaries,
	});
}

export interface VerificationResult {
	passed: boolean;
	/** Full results stay available to bounded failure-artifact handling. */
	commands: VerificationCommandResult[];
	/** Safe structural projection for the canonical completion event. */
	evidence: VerificationEvidence;
}

export interface VerificationDriver {
	name: string;
	runVerification(
		context: WorkspaceContext,
		commands: string[],
	): Promise<VerificationResult>;
}
