/**
 * Alias Extension — convenient aliases for built-in commands.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { once } from "./once.ts";

export default function (pi: ExtensionAPI) {
  once(pi, "pi-alias", () => {
	pi.registerCommand("exit", {
		description: "Exit pi cleanly (alias for /quit)",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});

	pi.registerCommand("clear", {
		description: "Clear conversation and start fresh (alias for /new)",
		handler: async (_args, ctx) => {
			try {
				await ctx.waitForIdle();
				const result = await ctx.newSession();
				if (result.cancelled && ctx.hasUI) {
					ctx.ui.notify("Clear cancelled — session was not reset.", "warning");
				}
			} catch (err) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Clear failed: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
				}
			}
		},
	});

  });
}
