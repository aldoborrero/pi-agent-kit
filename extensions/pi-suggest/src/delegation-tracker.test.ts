import { describe, expect, test } from "bun:test";
import { DelegationTracker, DELEGATION_TOOLS } from "./delegation-tracker.ts";

describe("DelegationTracker", () => {
	test("subagent and herdr tool calls activate suppression until their result", () => {
		const tracker = new DelegationTracker();
		expect(tracker.isDelegating()).toBe(false);

		tracker.onToolCall("subagent", "call-1");
		expect(tracker.isDelegating()).toBe(true);

		tracker.onToolCall("subagent", "call-2"); // parallel second delegation
		expect(tracker.activeCount()).toBe(2);

		tracker.onToolResult("subagent", "call-1");
		expect(tracker.isDelegating()).toBe(true); // call-2 still in flight

		tracker.onToolResult("subagent", "call-2");
		expect(tracker.isDelegating()).toBe(false);
	});

	test("herdr control calls also track", () => {
		const tracker = new DelegationTracker();
		tracker.onToolCall("herdr", "h-1");
		expect(tracker.isDelegating()).toBe(true);
		tracker.onToolResult("herdr", "h-1");
		expect(tracker.isDelegating()).toBe(false);
	});

	test("unrelated tools do not activate suppression", () => {
		const tracker = new DelegationTracker();
		tracker.onToolCall("bash", "b-1");
		tracker.onToolCall("edit", "e-1");
		expect(tracker.isDelegating()).toBe(false);
		// Their results must not clear real delegation state either.
		tracker.onToolCall("subagent", "s-1");
		tracker.onToolResult("bash", "b-1");
		expect(tracker.isDelegating()).toBe(true);
	});

	test("nested-call ids (parent/n) resolve via the delegation tool name", () => {
		const tracker = new DelegationTracker();
		tracker.onToolCall("subagent", "parent/1");
		tracker.onToolResult("subagent", "parent/1");
		expect(tracker.isDelegating()).toBe(false);
	});

	test("clear resets everything (session boundary)", () => {
		const tracker = new DelegationTracker();
		tracker.onToolCall("subagent", "s-1");
		tracker.clear();
		expect(tracker.isDelegating()).toBe(false);
	});

	test("delegation tool set is exactly the kit's delegation surface", () => {
		expect([...DELEGATION_TOOLS].sort()).toEqual(["herdr", "subagent"]);
	});
});
