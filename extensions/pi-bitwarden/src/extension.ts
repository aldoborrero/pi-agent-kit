
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
import { once } from "./once.ts";

const MASKED = "********";

// ── Helpers ──────────────────────────────────────────────────────────────────

const RBW_TIMEOUT_MS = 10_000;
const RBW_UNLOCK_TIMEOUT_MS = 120_000;

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

function runRbwUnlock(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    // rbw unlock uses pinentry. If rbw is spawned with piped stdio, pinentry can
    // fail because it cannot talk to the real terminal. Attach to /dev/tty and,
    // when util-linux `script` is available, run rbw in a fresh pseudo-terminal
    // so pinentry behaves like it was launched from a normal interactive shell.
    const unlockCommand = [
      "TTY=$(tty)",
      "export GPG_TTY=\"$TTY\"",
      "gpg-connect-agent updatestartuptty /bye >/dev/null 2>&1 || true",
      "rbw unlock",
    ].join("; ");
    const child = spawn(
      "sh",
      [
        "-lc",
        [
          "exec < /dev/tty > /dev/tty 2> /dev/tty",
          "if command -v script >/dev/null 2>&1; then exec script -qfec '" + unlockCommand + "' /dev/null; fi",
          unlockCommand.replace("rbw unlock", "exec rbw unlock"),
        ].join("; "),
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, GPG_TTY: process.env.GPG_TTY || "/dev/tty" },
      },
    );

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`rbw unlock timed out after ${RBW_UNLOCK_TIMEOUT_MS / 1000}s`));
    }, RBW_UNLOCK_TIMEOUT_MS);

    const onAbort = () => {
      child.kill();
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `rbw unlock exited with code ${code}. If pinentry did not appear, run rbw unlock in a shell first.`));
        return;
      }
      resolve();
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
  once(pi, "pi-bitwarden", () => {
  let lastStatus: "ready" | "locked" | "missing" = isAvailable()
    ? (isUnlocked() ? "ready" : "locked")
    : "missing";

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

    if (!ctx.hasUI) return;
    const colors = createUiColors(ctx.ui.theme);

    if (!available) {
      ctx.ui.setStatus("bitwarden", colors.danger("󰌾 rbw:missing"));
      return;
    }

    if (lastStatus === "ready") {
      ctx.ui.setStatus("bitwarden", colors.success("󰍁 rbw:unlocked"));
    } else {
      ctx.ui.setStatus("bitwarden", colors.danger("󰌾 rbw:locked"));
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  const bitwardenCommand: Parameters<typeof pi.registerCommand>[1] = {
    description: "Bitwarden vault: /bw or /rbw [unlock|lock|sync|status]",
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
          ctx.ui.notify("Opening rbw pinentry in the terminal…", "info");
          await runRbwUnlock();
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
        "  /bw unlock   - Unlock vault (via rbw-agent pinentry)",
        "  /bw lock     - Lock vault",
        "  /bw sync     - Sync with server",
        "  /rbw ...     - Alias for /bw",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  };

  pi.registerCommand("bw", bitwardenCommand);
  pi.registerCommand("rbw", bitwardenCommand);

  // ── Tools ─────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "bw_get",
    label: "Bitwarden get",
    description: `Retrieve a Bitwarden vault item by name or folder/name.

By default returns only the username. Set field to retrieve a specific field.
Only 'username' and 'uris' are returned freely; password, totp, notes, and any
custom/hidden field are treated as sensitive and require user confirmation.
Sensitive fields are unavailable in headless (non-interactive) sessions.

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

      // Fields that are safe to return without confirmation. Everything else —
      // including custom/hidden fields — is treated as sensitive by default so a
      // custom field named e.g. "recovery_code" or "secret_access_key" cannot be
      // exfiltrated without the same gate as password/totp/notes.
      //
      // Only names rbw resolves to a built-in login field belong here. Any
      // other name reaches `rbw get --field`, which for logins returns the
      // first custom field whose name *contains* it, so "name", "uri" or
      // "folder" would expose hidden custom fields without confirmation.
      const nonSensitiveFields = ["username", "uris"];
      const isSensitive = !nonSensitiveFields.includes(field.toLowerCase());

      // Require user confirmation for sensitive fields, and fail closed when
      // there is no interactive session to confirm through. Without a UI we
      // cannot prompt, so headless modes (print/json) must never return the
      // raw secret.
      if (isSensitive) {
        if (!ctx.hasUI) {
          return errorResult(
            "Sensitive fields require an interactive session; not available in headless mode.",
          );
        }

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

  // ── Safety: block direct rbw/bw usage in bash ─────────────────────────────
  //
  // BEST-EFFORT ONLY — this is NOT a security boundary. It is a guardrail to
  // stop the agent from casually shelling out to rbw/bw and dumping secrets
  // into a tool result. It can be bypassed (e.g. variable indirection, aliases,
  // wrapper scripts, or entirely different execution paths such as inline-bash
  // `!{...}` that never route through this tool_call hook). Do not rely on it
  // to contain a determined or adversarial caller.

  // Returns true if any whitespace-separated token resolves to the rbw or bw
  // binary. This tokenized check catches simple obfuscation that a fixed
  // `\brbw\s+get\b`-style regex misses (backslash line-continuation, extra
  // separators, unlisted subcommands), while staying deliberately simple.
  function mentionsRbwOrBw(command: string): boolean {
    // Normalize line continuations and shell separators to whitespace so
    // tokens split cleanly regardless of how the command is laid out.
    const normalized = command.replace(/\\\r?\n/g, " ").replace(/[;&|()<>]/g, " ");
    for (const rawToken of normalized.split(/\s+/)) {
      // Strip a leading path (e.g. /usr/bin/rbw) and any quoting so we compare
      // the resolved program name, case-insensitively.
      const token = rawToken.replace(/^["']|["']$/g, "");
      const base = token.split("/").pop()?.toLowerCase() ?? "";
      if (base === "rbw" || base === "bw") return true;
    }
    return false;
  }

  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;

    // Block any command that appears to invoke the rbw or bw binary. This is
    // intentionally broad (blocks all subcommands, not just get/list) because
    // even `rbw export` or `bw list` can leak vault contents. See best-effort
    // note above.
    if (mentionsRbwOrBw(command)) {
      return {
        block: true,
        reason:
          "Direct rbw/bw CLI access in bash is blocked. Use the bw_get and bw_list tools instead, which mask sensitive fields and require user confirmation.",
      };
    }

    return undefined;
  });

  });
}
