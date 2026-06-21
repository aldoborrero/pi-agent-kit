
/**
 * Codex Extension — use OpenAI Codex from pi to review code or delegate tasks.
 *
 * Wraps the upstream codex-plugin-cc scripts (codex-companion.mjs) which
 * communicate with Codex via its app-server JSON-RPC protocol for native
 * reviews, structured output, thread management, and job tracking.
 *
 * Commands:
 *   /codex setup              — check Codex CLI readiness and auth
 *   /codex review             — run a native code review via Codex
 *   /codex adversarial-review — adversarial review questioning design choices
 *   /codex rescue             — delegate a task to Codex
 *   /codex status             — show running and recent Codex jobs
 *   /codex result             — display output from a completed job
 *   /codex cancel             — cancel an active background job
 *
 * Requires: `codex` CLI installed globally (`npm i -g @openai/codex`).
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Resolve the codex-plugin-cc package location robustly via require.resolve,
// which handles hoisting regardless of where node_modules actually lives.
const require = createRequire(import.meta.url);
const pluginPkgPath = require.resolve("codex-plugin-cc/package.json");
const COMPANION_SCRIPT = path.join(
  path.dirname(pluginPkgPath),
  "plugins",
  "codex",
  "scripts",
  "codex-companion.mjs",
);

const EXEC_TIMEOUT = 10 * 60 * 1000; // 10 minutes

async function runCompanion(
  pi: ExtensionAPI,
  subcommand: string,
  rawArgs: string,
  timeout = EXEC_TIMEOUT,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // codex-companion.mjs accepts: node <script> <subcommand> [args...]
  // When argv.length === 1, it internally calls splitRawArgumentString
  // to handle quoted strings. We pass the raw args as a single string
  // to preserve that behavior (e.g. quoted task prompts).
  const nodeArgs = rawArgs.trim()
    ? [COMPANION_SCRIPT, subcommand, rawArgs.trim()]
    : [COMPANION_SCRIPT, subcommand];

  const result = await pi.exec("node", nodeArgs, { timeout });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: (result as { exitCode?: number }).exitCode ?? 1,
  };
}

function formatOutput(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
}): string {
  if (result.exitCode === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  if (result.stderr.trim()) {
    return `Error:\n\`\`\`\n${result.stderr.trim()}\n\`\`\``;
  }
  if (result.stdout.trim()) {
    return result.stdout.trim();
  }
  return "Codex returned no output.";
}

export default function (pi: ExtensionAPI) {
  const subcommands = [
    "setup",
    "review",
    "adversarial-review",
    "rescue",
    "status",
    "result",
    "cancel",
  ] as const;

  async function runSubcommand(subcommand: string, rawArgs: string, ctx: { ui: { notify(message: string, level: "info" | "warning" | "error"): void } }): Promise<void> {
    switch (subcommand) {
      case "setup": {
        const result = await runCompanion(pi, "setup", rawArgs, 30000);
        pi.sendUserMessage(formatOutput(result), { deliverAs: "followUp" });
        return;
      }
      case "review": {
        ctx.ui.notify("Running Codex review…", "info");
        const result = await runCompanion(pi, "review", rawArgs);
        pi.sendUserMessage(formatOutput(result), { deliverAs: "followUp" });
        return;
      }
      case "adversarial-review": {
        ctx.ui.notify("Running Codex adversarial review…", "info");
        const result = await runCompanion(pi, "adversarial-review", rawArgs);
        pi.sendUserMessage(formatOutput(result), { deliverAs: "followUp" });
        return;
      }
      case "rescue": {
        if (!rawArgs.trim()) {
          pi.sendUserMessage(
            "Usage: `/codex rescue <task description>` — describe what you want Codex to do.",
            { deliverAs: "followUp" },
          );
          return;
        }
        ctx.ui.notify("Delegating task to Codex…", "info");
        const result = await runCompanion(pi, "task", rawArgs);
        pi.sendUserMessage(formatOutput(result), { deliverAs: "followUp" });
        return;
      }
      case "status": {
        const result = await runCompanion(pi, "status", rawArgs, 30000);
        pi.sendUserMessage(formatOutput(result), { deliverAs: "followUp" });
        return;
      }
      case "result": {
        const result = await runCompanion(pi, "result", rawArgs, 30000);
        pi.sendUserMessage(formatOutput(result), { deliverAs: "followUp" });
        return;
      }
      case "cancel": {
        const result = await runCompanion(pi, "cancel", rawArgs, 30000);
        pi.sendUserMessage(formatOutput(result), { deliverAs: "followUp" });
        return;
      }
      default:
        pi.sendUserMessage(
          "Usage: `/codex <setup|review|adversarial-review|rescue|status|result|cancel> [args]`",
          { deliverAs: "followUp" },
        );
    }
  }

  pi.registerCommand("codex", {
    description:
      "Use Codex via subcommands: setup | review | adversarial-review | rescue | status | result | cancel",
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trimStart().toLowerCase();
      if (!trimmed) return subcommands.map((value) => ({ value, label: value }));
      const parts = trimmed.split(/\s+/).filter(Boolean);
      if (parts.length <= 1 && !/\s$/.test(trimmed)) {
        const sub = parts[0] ?? "";
        const filtered = subcommands.filter((value) => value.startsWith(sub));
        return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
      }
      return null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        pi.sendUserMessage(
          "Usage: `/codex <setup|review|adversarial-review|rescue|status|result|cancel> [args]`",
          { deliverAs: "followUp" },
        );
        return;
      }
      const [subcommand, ...rest] = trimmed.split(/\s+/);
      await runSubcommand(subcommand.toLowerCase(), rest.join(" "), ctx);
    },
  });
}
