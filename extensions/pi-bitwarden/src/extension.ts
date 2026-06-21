
/**
 * Bitwarden Extension (via rbw)
 *
 * Secure access to Bitwarden vault items via rbw (unofficial Bitwarden CLI).
 * rbw uses a background agent (rbw-agent) to hold decryption keys in memory,
 * eliminating the need for session token management.
 *
 * Security design:
 *   - No session tokens or secrets in process.env
 *   - Passwords masked by default, require explicit user confirmation to expose
 *   - Read-only vault access (get/list only)
 *   - rbw-agent handles key lifecycle independently
 *
 * Requirements:
 *   - rbw installed and in PATH (https://github.com/doy/rbw)
 *   - rbw configured: `rbw config set email <email>`
 *   - rbw registered: `rbw register` (once per device)
 */

import { execSync, spawn } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createUiColors } from "@aldoborrero/pi-common";
import { Type } from "@sinclair/typebox";

const MASKED = "********";

// ── Helpers ──────────────────────────────────────────────────────────────────

const RBW_TIMEOUT_MS = 10_000;

function runRbw(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const child = spawn("rbw", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Hard timeout so a hung rbw-agent can never freeze the agent indefinitely.
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`rbw timed out after ${RBW_TIMEOUT_MS / 1000}s`));
    }, RBW_TIMEOUT_MS);

    const onAbort = () => {
      child.kill();
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `rbw exited with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

// Cached after first check — rbw installation doesn't change during a session.
let rbwAvailableCache: boolean | null = null;

function isAvailable(): boolean {
  if (rbwAvailableCache !== null) return rbwAvailableCache;
  try {
    execSync("rbw --version", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5_000,
    });
    rbwAvailableCache = true;
  } catch {
    rbwAvailableCache = false;
  }
  return rbwAvailableCache;
}

function isUnlocked(): boolean {
  try {
    execSync("rbw unlocked", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let lastStatus: "ready" | "locked" | "missing" = isAvailable()
    ? (isUnlocked() ? "ready" : "locked")
    : "missing";
    id: "pi-agent-kit.bitwarden",
    label: "Bitwarden",
    description: "Shows whether the Bitwarden rbw vault is ready, locked, or missing.",
    defaults: {
      row: 1,
      position: 11,
      align: "right",
      fill: "none",
    },
    textColor: lastStatus === "missing" ? "error" : "warning",
    visible: () => lastStatus === "locked" || lastStatus === "missing",
    renderText: () => `bw:${lastStatus}`,
  })).then((active) => {
    return active;
  });

  function okResult(text: string) {
    return {
      content: [{ type: "text" as const, text }],
      details: {},
    };
  }

  function errorResult(text: string) {
    return {
      content: [{ type: "text" as const, text }],
      isError: true,
      details: {},
    };
  }

  // Accept a pre-computed unlock state to avoid a redundant execSync call
  // when the caller already knows the lock status.
  function updateStatus(ctx: ExtensionContext, currentlyUnlocked?: boolean) {
    const available = isAvailable();
    lastStatus = !available ? "missing" : ((currentlyUnlocked ?? isUnlocked()) ? "ready" : "locked");

      if (ctx.hasUI) {
        ctx.ui.setStatus("bitwarden", undefined);
      }
      return;
    }

    if (!ctx.hasUI) return;
    const colors = createUiColors(ctx.ui.theme);

    if (!available) {
      ctx.ui.setStatus("bitwarden", colors.danger("rbw:missing"));
      return;
    }

    if (lastStatus === "ready") {
      ctx.ui.setStatus("bitwarden", colors.success("rbw:unlocked"));
    } else {
      ctx.ui.setStatus("bitwarden", colors.warning("rbw:locked"));
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  pi.registerCommand("bw", {
    description: "Bitwarden vault: /bw [unlock|lock|sync|status]",
    getArgumentCompletions: (prefix: string) => {
      const values = ["unlock", "lock", "sync", "status"];
      const trimmed = prefix.trimStart().toLowerCase();
      if (!trimmed) return values.map((value) => ({ value, label: value }));
      const filtered = values.filter((value) => value.startsWith(trimmed));
      return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;

      if (!isAvailable()) {
        ctx.ui.notify(
          "rbw is not installed. Install from https://github.com/doy/rbw",
          "error",
        );
        return;
      }

      const arg = args.trim().toLowerCase();

      if (arg === "unlock") {
        if (isUnlocked()) {
          ctx.ui.notify("Vault is already unlocked.", "info");
          return;
        }

        try {
          // rbw unlock prompts for master password via pinentry/agent
          await runRbw(["unlock"]);
          updateStatus(ctx);
          ctx.ui.notify("Vault unlocked.", "info");
        } catch (err) {
          ctx.ui.notify(
            `Unlock failed: ${err instanceof Error ? err.message : err}`,
            "error",
          );
        }
        return;
      }

      if (arg === "lock") {
        try {
          await runRbw(["lock"]);
          updateStatus(ctx);
          ctx.ui.notify("Vault locked.", "info");
        } catch (err) {
          ctx.ui.notify(
            `Lock failed: ${err instanceof Error ? err.message : err}`,
            "error",
          );
        }
        return;
      }

      if (arg === "sync") {
        try {
          await runRbw(["sync"]);
          ctx.ui.notify("Vault synced.", "info");
        } catch (err) {
          ctx.ui.notify(
            `Sync failed: ${err instanceof Error ? err.message : err}`,
            "error",
          );
        }
        return;
      }

      // Default: show status — call isUnlocked() once and share the result.
      const unlocked = isUnlocked();
      updateStatus(ctx, unlocked);
      const status = unlocked ? "unlocked" : "locked";
      const lines = [
        `Bitwarden vault: ${status}`,
        "",
        "Commands:",
        "  /bw unlock  - Unlock vault (via rbw-agent pinentry)",
        "  /bw lock    - Lock vault",
        "  /bw sync    - Sync with server",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── Tools ─────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "bw_get",
    label: "Bitwarden get",
    description: `Retrieve a Bitwarden vault item by name or folder/name.

By default returns only the username. Set field to retrieve a specific field.
Sensitive fields (password, totp, notes) require user confirmation.

The vault must be unlocked first (use /bw unlock command).

Examples:
  bw_get(name: "github.com") -> returns username
  bw_get(name: "github.com", field: "password") -> returns password (with confirmation)
  bw_get(name: "GitHub", folder: "Work") -> returns username from Work folder
  bw_get(name: "AWS", field: "totp") -> returns TOTP code (with confirmation)`,
    parameters: Type.Object({
      name: Type.String({
        description: "Item name or URI to search for",
      }),
      folder: Type.Optional(
        Type.String({
          description: "Folder name to narrow the search (for duplicate item names)",
        }),
      ),
      field: Type.Optional(
        Type.String({
          description:
            "Specific field to retrieve: 'username', 'password', 'totp', 'notes', or a custom field name. Default: 'username'.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!isAvailable()) {
        return errorResult("rbw is not installed. Install from https://github.com/doy/rbw");
      }

      if (!isUnlocked()) {
        return errorResult("Vault is locked. Use /bw unlock to unlock it first.");
      }

      const field = params.field ?? "username";
      const sensitiveFields = ["password", "totp", "notes"];
      const isSensitive = sensitiveFields.includes(field.toLowerCase());

      // Require user confirmation for sensitive fields
      if (isSensitive && ctx.hasUI) {
        const confirmed = await ctx.ui.confirm(
          `Expose ${field} for "${params.name}"?`,
          `The agent is requesting the ${field}. This value will be visible in the conversation.`,
        );

        if (!confirmed) {
          return okResult(`User denied access to the "${field}" field.`);
        }
      }

      try {
        // TOTP uses a different subcommand — handle before building get args.
        if (field === "totp") {
          const codeArgs = ["code", params.name];
          if (params.folder) {
            codeArgs.push("--folder", params.folder);
          }
          const code = await runRbw(codeArgs, signal ?? undefined);
          return okResult(`TOTP code: ${code}`);
        }

        const args = ["get"];

        // Push --folder before the positional name so all rbw/clap versions accept it.
        if (params.folder) {
          args.push("--folder", params.folder);
        }

        if (field === "password") {
          args.push(params.name);
        } else if (field === "username" || field === "notes") {
          args.push("--full", params.name);
        } else {
          // Custom field
          args.push("--field", field, params.name);
        }

        const output = await runRbw(args, signal ?? undefined);

        if (field === "username" || field === "notes") {
          // --full output format: "password\nusername: value\nURI: value\nNotes:\nline1\nline2"
          const lines = output.split("\n");

          if (field === "username") {
            const userLine = lines.find((l) => l.startsWith("Username: "));
            const username = userLine
              ? userLine.slice("Username: ".length)
              : "(no username)";

            // Also extract URIs for context
            const uris = lines
              .filter((l) => l.startsWith("URI: "))
              .map((l) => l.slice("URI: ".length));

            const parts = [`Username: ${username}`];
            if (uris.length > 0) {
              parts.push(`URIs: ${uris.join(", ")}`);
            }
            parts.push(`Password: ${MASKED}`);

            return okResult(parts.join("\n"));
          }

          if (field === "notes") {
            const notesIdx = lines.findIndex((l) => l.trim() === "Notes:");
            if (notesIdx === -1) {
              return okResult("(no notes)");
            }
            const notes = lines.slice(notesIdx + 1).join("\n");
            return okResult(notes || "(empty notes)");
          }
        }

        // For password and custom fields, output is the raw value
        return okResult(output);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`rbw error: ${msg}`);
      }
    },
  });

  pi.registerTool({
    name: "bw_list",
    label: "Bitwarden list",
    description: `List Bitwarden vault items, optionally filtered by a search term.

Returns item names only (no sensitive data). Use bw_get to retrieve specific fields.

The vault must be unlocked first (use /bw unlock command).`,
    parameters: Type.Object({
      search: Type.Optional(
        Type.String({ description: "Search term to filter items (case-insensitive substring match)" }),
      ),
      folder: Type.Optional(
        Type.String({ description: "Filter by folder name" }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      if (!isAvailable()) {
        return errorResult("rbw is not installed. Install from https://github.com/doy/rbw");
      }

      if (!isUnlocked()) {
        return errorResult("Vault is locked. Use /bw unlock to unlock it first.");
      }

      try {
        // --fields is a newer rbw feature; fall back to name-only listing if unsupported.
        let output: string;
        let hasFieldSupport = true;
        try {
          output = await runRbw(["list", "--fields", "name,user,folder"], signal ?? undefined);
        } catch {
          output = await runRbw(["list"], signal ?? undefined);
          hasFieldSupport = false;
        }

        // Folder filtering requires tab-separated field output.
        if (params.folder && !hasFieldSupport) {
          return okResult("Folder filtering requires rbw with --fields support. Please upgrade rbw (https://github.com/doy/rbw).");
        }
        let lines = output.split("\n").filter((l) => l.trim());

        // Apply folder filter
        if (params.folder) {
          const folderLower = params.folder.toLowerCase();
          lines = lines.filter((line) => {
            const parts = line.split("\t");
            const folder = parts[2]?.trim().toLowerCase() ?? "";
            return folder === folderLower;
          });
        }

        // Apply search filter
        if (params.search) {
          const searchLower = params.search.toLowerCase();
          lines = lines.filter((line) => line.toLowerCase().includes(searchLower));
        }

        if (lines.length === 0) {
          return okResult("No items found matching your criteria.");
        }

        // Format output
        const formatted = lines.slice(0, 50).map((line, i) => {
          const parts = line.split("\t");
          const name = parts[0] ?? "";
          const user = parts[1] ?? "";
          const folder = parts[2] ?? "";
          const display = user ? `${name} (${user})` : name;
          return folder
            ? `${i + 1}. ${display} [${folder}]`
            : `${i + 1}. ${display}`;
        });

        const header = `Found ${lines.length} item(s):`;
        const result = [header, "", ...formatted];

        if (lines.length > 50) {
          result.push(`\n... and ${lines.length - 50} more. Refine your search.`);
        }

        return okResult(result.join("\n"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`rbw error: ${msg}`);
      }
    },
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("before_agent_start", async (_event, _ctx) => {
    if (!isAvailable() || !isUnlocked()) {
      return {
        systemPrompt:
          "The Bitwarden vault is currently LOCKED. If the user asks for credentials, " +
          "remind them to run /bw unlock before using the bw_get or bw_list tools.",
      };
    }
  });

  // ── Safety: block direct rbw/bw usage in bash ─────────────────────────────

  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;

    // Block direct rbw/bw CLI access to prevent secrets appearing in tool results
    if (/\brbw\s+(get|code|list)\b/.test(command)) {
      return {
        block: true,
        reason:
          "Direct rbw credential access in bash is blocked. Use the bw_get tool instead, which masks sensitive fields and requires user confirmation.",
      };
    }

    if (/\bbw\s+(get|list|unlock|login|export)\b/.test(command)) {
      return {
        block: true,
        reason:
          "Direct bw CLI access is blocked. Use the bw_get and bw_list tools instead.",
      };
    }

    return undefined;
  });
}
