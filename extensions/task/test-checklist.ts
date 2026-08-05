/**
 * Checklist state machine unit tests — pure functions from tools/checklist.ts.
 * The extension plumbing (readState/appendEntry, setStatus, context
 * injection wiring) is pi-extension behavior → e2e section 3.
 */

import { pathToFileURL } from "node:url";
import {
	checklistRemaining,
	checklistReminder,
	checklistStatusText,
	createChecklistState,
	markChecklistDone,
	shouldInjectChecklistReminder,
} from "./tools/checklist.ts";

export async function runTests(): Promise<void> {
	const errors: string[] = [];
	const check = (cond: boolean, msg: string): void => {
		if (!cond) errors.push(msg);
	};

	console.log("── test-checklist: pure state machine ──");

	// 1. createChecklistState: default 12 cap, all undone
	{
		const capped = createChecklistState(Array.from({ length: 15 }, (_, i) => `item ${i}`));
		check(capped.items.length === 12, `should truncate to 12 items, got ${capped.items.length}`);
		check(capped.items.every((i) => !i.done), "fresh items should all be undone");
		check(capped.items[0].text === "item 0" && capped.items[11].text === "item 11", "truncation should keep the first items");

		const small = createChecklistState(["a", "b"]);
		check(small.items.length === 2, `should keep 2 items, got ${small.items.length}`);

		const custom = createChecklistState(["a", "b", "c"], 2);
		check(custom.items.length === 2, `maxItems override should cap at 2, got ${custom.items.length}`);
	}

	// 2. markChecklistDone happy path
	{
		const state = createChecklistState(["a", "b", "c"]);
		const result = markChecklistDone(state, 0);
		check(result.ok === true, "first mark should succeed");
		if (result.ok) {
			check(result.state === state, "should return the same state object");
			check(result.remaining === 2, `remaining should be 2, got ${result.remaining}`);
		}
		check(state.items[0].done === true, "item 0 should be done");
		check(state.items[1].done === false, "item 1 should stay undone");
	}

	// 3. Duplicate mark → ok:false, state unchanged
	{
		const state = createChecklistState(["a", "b"]);
		markChecklistDone(state, 0);
		const dup = markChecklistDone(state, 0);
		check(dup.ok === false, "duplicate mark should fail");
		if (!dup.ok) {
			check(dup.error.includes("already done"), `dup error should mention "already done", got: ${dup.error}`);
		}
		check(state.items[0].done === true && checklistRemaining(state) === 1, "dup mark must not change state");
	}

	// 4. Out-of-range marks → ok:false with index guidance
	{
		const state = createChecklistState(["a", "b", "c"]);
		for (const bad of [-1, 3, 99]) {
			const result = markChecklistDone(state, bad);
			check(result.ok === false, `index ${bad} should be rejected`);
			if (!result.ok) {
				check(result.error.includes(`Index ${bad} invalid (expected 0..2)`),
					`error should guide the caller, got: ${result.error}`);
				check(result.alreadyDone === false, `index ${bad} must not be flagged alreadyDone`);
			}
		}
		check(checklistRemaining(state) === 3, "no out-of-range mark may change state");
	}

	// 5. checklistRemaining
	{
		const state = createChecklistState(["a", "b", "c"]);
		check(checklistRemaining(state) === 3, `fresh remaining should be 3, got ${checklistRemaining(state)}`);
		markChecklistDone(state, 0);
		markChecklistDone(state, 1);
		check(checklistRemaining(state) === 1, `remaining should be 1, got ${checklistRemaining(state)}`);
	}

	// 6. checklistStatusText format
	{
		const state = createChecklistState(["a", "b"]);
		markChecklistDone(state, 1);
		check(checklistStatusText(state) === "remaining:1", `status text should be "remaining:1", got ${checklistStatusText(state)}`);
		check(checklistStatusText(createChecklistState([])) === "remaining:0", "empty checklist should report remaining:0");
	}

	// 7. checklistReminder format (1-based numbering of unchecked items)
	{
		const state = createChecklistState(["R1: create file", "R2: commit", "R3: verify"]);
		markChecklistDone(state, 1);
		const reminder = checklistReminder(state);
		const expected =
			"Remaining checklist items (complete before calling yield):\n" +
			"1. R1: create file\n" +
			"3. R3: verify";
		check(reminder === expected, `reminder format wrong:\n--- got ---\n${reminder}\n--- want ---\n${expected}`);
	}

	// 8. shouldInjectChecklistReminder matrix
	{
		const remaining = createChecklistState(["a", "b"]);
		const done = createChecklistState(["a"]);
		markChecklistDone(done, 0);

		check(shouldInjectChecklistReminder(false, remaining) === false, "no first edit → no injection");
		check(shouldInjectChecklistReminder(true, null) === false, "null state → no injection");
		check(shouldInjectChecklistReminder(true, done) === false, "zero remaining → no injection");
		check(shouldInjectChecklistReminder(false, null) === false, "no first edit + null state → no injection");
		check(shouldInjectChecklistReminder(true, remaining) === true, "first edit + remaining items → inject");
	}

	if (errors.length > 0) {
		throw new Error("test-checklist failed:\n  ✗ " + errors.join("\n  ✗ "));
	}
	console.log("✓ truncation, mark/dup/out-of-range, remaining, status, reminder, inject gate");
}

// Direct execution support: `npx tsx extensions/task/test-checklist.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runTests()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err.message ?? err);
			process.exit(1);
		});
}
