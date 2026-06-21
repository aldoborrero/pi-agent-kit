/**
 * Diff Extension — quick diff viewer via /diff command.
 *
 * Shells out to tuicr (preferred), delta, or plain git diff.
 * For agent-triggered code review with feedback capture, use the tuicr tool instead.
 *
 * Usage:
 *   /diff              — show all uncommitted changes
 *   /diff --staged     — show only staged changes
 *   /diff <revisions>  — show changes for a commit range (e.g. HEAD~3..HEAD)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync, spawnSync } from "node:child_process";

function which(cmd: string): boolean {
	try {
		execSync(`which ${cmd}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("diff", {
		description: "View uncommitted changes (tuicr/delta/git diff)",
		getArgumentCompletions: (prefix: string) => {
			const opts = ["--staged", "--cached", "HEAD~1", "HEAD~3..HEAD"];
			const filtered = opts.filter((o) => o.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((o) => ({ value: o, label: o })) : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Diff viewer requires interactive mode", "error");
				return;
			}

			const trimmed = args.trim();

			if (which("tuicr")) {
				// tuicr: full interactive TUI
				const tuicrArgs: string[] = [];
				if (trimmed) tuicrArgs.push("-r", trimmed);

				await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
					tui.stop();
					process.stdout.write("\x1b[2J\x1b[H");
					spawnSync("tuicr", tuicrArgs, {
						stdio: "inherit",
						cwd: ctx.cwd,
						env: process.env,
					});
					tui.start();
					tui.requestRender(true);
					done();
					return { render: () => [], invalidate: () => {} };
				});
			} else if (which("delta")) {
				// delta: syntax-highlighted pager
				const cmd = trimmed
					? `git diff ${trimmed} | delta --pager 'less -R'`
					: `git diff | delta --pager 'less -R'`;

				await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
					tui.stop();
					spawnSync("bash", ["-c", cmd], {
						stdio: "inherit",
						cwd: ctx.cwd,
					});
					tui.start();
					tui.requestRender(true);
					done();
					return { render: () => [], invalidate: () => {} };
				});
			} else {
				// Fallback: plain git diff
				await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
					tui.stop();
					spawnSync("git", ["diff", ...(trimmed ? [trimmed] : [])], {
						stdio: "inherit",
						cwd: ctx.cwd,
					});
					tui.start();
					tui.requestRender(true);
					done();
					return { render: () => [], invalidate: () => {} };
				});
			}
		},
	});
}
