/**
 * Exit Extension — adds /exit as an alias for /quit.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("exit", {
		description: "Exit pi cleanly (alias for /quit)",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
