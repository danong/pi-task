/** Durable user-facing receipt delivery for the v2 shell (R1/R2).
 *
 * Receipts are compact contract payloads, written atomically beside failure
 * artifacts. Delivery is deliberately separate from the SQLite ledger: the
 * ledger records lifecycle state, while this file is the portable handoff a
 * caller can retain or inspect without opening the database.
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TaskReceiptSchema, type TaskReceipt } from "../contracts/index.ts";

/** Write `<artifactsDir>/<taskId>.receipt.json`; return undefined on I/O or
 * schema failure so the shell can map missing delivery to a nonzero exit. */
export function writeReceiptArtifact(
	receipt: TaskReceipt,
	artifactsDir: string,
): string | undefined {
	try {
		const checked = TaskReceiptSchema.parse(receipt);
		mkdirSync(artifactsDir, { recursive: true });
		const target = join(artifactsDir, `${checked.taskId}.receipt.json`);
		const temporary = `${target}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(checked, null, 2)}\n`, "utf8");
		renameSync(temporary, target);
		return target;
	} catch (error) {
		console.error(
			`[pi-task-v2] failed to deliver receipt: ${error instanceof Error ? error.message : String(error)}`,
		);
		try {
			unlinkSync(join(artifactsDir, `${receipt.taskId}.receipt.json.tmp`));
		} catch (cleanupError) {
			if (cleanupError instanceof Error && cleanupError.name !== "ENOENT") {
				console.error(
					`[pi-task-v2] receipt temporary-file cleanup failed: ${cleanupError.message}`,
				);
			}
		}
		return undefined;
	}
}
