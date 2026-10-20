/**
 * Tracks in-flight delegation (subagent / herdr tool calls) so pi-suggest
 * can stand down while agents are running: suggestion generation driven by
 * a subagent's own turn end is noise for the main editor and routinely
 * crashes on stale extension contexts.
 */

/** Tools whose execution means "an agent is working" in this kit. */
export const DELEGATION_TOOLS = new Set(["subagent", "herdr"]);

export class DelegationTracker {
	private active = new Set<string>();

	onToolCall(toolName: string, toolCallId: string): void {
		if (DELEGATION_TOOLS.has(toolName)) this.active.add(toolCallId);
	}

	onToolResult(toolName: string, toolCallId: string): void {
		if (DELEGATION_TOOLS.has(toolName)) this.active.delete(toolCallId);
	}

	/** Whether any delegation is currently in flight. */
	isDelegating(): boolean {
		return this.active.size > 0;
	}

	/** Test/diagnostic helper. */
	activeCount(): number {
		return this.active.size;
	}

	clear(): void {
		this.active.clear();
	}
}