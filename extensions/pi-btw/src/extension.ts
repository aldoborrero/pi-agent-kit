/**
 * BTW Extension — ephemeral side questions that don't pollute context.
 *
 * Like Claude Code's /btw command: ask a quick question without tool access,
 * get an answer, and it doesn't become part of the conversation history.
 *
 * Usage:
 *   /btw what's the difference between rebase and merge?
 *   /btw how do I write a regex for emails?
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("btw", {
		description: "Ask a quick side question (ephemeral, no tools, doesn't pollute context)",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				ctx.ui.notify("Usage: /btw <question>", "error");
				return;
			}

			// Send as a follow-up message that triggers a turn but is marked
			// as ephemeral — the agent answers without tools
			pi.sendMessage(
				{
					customType: "btw",
					content: `[BTW — side question, answer briefly without using any tools]\n\n${question}`,
					display: true,
				},
				{
					triggerTurn: true,
				},
			);
		},
	});

	// Filter out BTW messages from context on subsequent turns
	// so they don't accumulate and waste tokens
	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((m) => {
				const msg = m as { customType?: string };
				return msg.customType !== "btw";
			}),
		};
	});
}
