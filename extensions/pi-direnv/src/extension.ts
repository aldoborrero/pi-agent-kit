/**
 * Direnv Extension
 *
 * Loads direnv environment variables on session start, then watches
 * .envrc and .direnv/ for changes and reloads only when needed.
 *
 * The bash tool spawns a new process per command (no persistent shell),
 * so the working directory never changes between bash calls. Running
 * direnv after every bash command is therefore unnecessary — file
 * watching is both cheaper and more correct.
 *
 * Requirements:
 *   - direnv installed and in PATH
 *   - .envrc must be allowed (run `direnv allow` in your shell first)
 */

import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { exec } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createUiColors } from "@aldoborrero/pi-common";

/** Debounce before reloading after a file-system event (ms). */
const RELOAD_DEBOUNCE_MS = 300;

export default function (pi: ExtensionAPI) {
  let direnvStatus: "on" | "blocked" | "error" | "off" = "off";
  let watchers: FSWatcher[] = [];
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let latestCtx: ExtensionContext | null = null;



  function updateStatus(ctx: ExtensionContext, status: "on" | "blocked" | "error" | "off"): void {
    direnvStatus = status;
      if (ctx.hasUI) ctx.ui.setStatus("direnv", undefined);
      return;
    }
    if (!ctx.hasUI) return;
    if (status === "off" || status === "on") {
      ctx.ui.setStatus("direnv", undefined);
      return;
    }
    const colors = createUiColors(ctx.ui.theme);
    ctx.ui.setStatus(
      "direnv",
      status === "blocked" ? colors.warning("direnv:blocked") : colors.danger("direnv:error"),
    );
  }

  function loadDirenv(cwd: string, ctx: ExtensionContext): void {
    exec("direnv export json", { cwd }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || error.message).toLowerCase();
        updateStatus(ctx, /allow|blocked|denied|not allowed/.test(message) ? "blocked" : "error");
        return;
      }

      if (!stdout.trim()) {
        updateStatus(ctx, "off");
        return;
      }

      try {
        const env = JSON.parse(stdout) as Record<string, string | null>;
        let loadedCount = 0;
        for (const [key, value] of Object.entries(env)) {
          if (value === null) {
            delete process.env[key];
          } else {
            process.env[key] = value;
            loadedCount++;
          }
        }
        updateStatus(ctx, loadedCount > 0 ? "on" : "off");
      } catch {
        updateStatus(ctx, "error");
      }
    });
  }

  function scheduleReload(): void {
    if (!latestCtx) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (latestCtx) loadDirenv(latestCtx.cwd, latestCtx);
    }, RELOAD_DEBOUNCE_MS);
  }

  function startWatchers(cwd: string): void {
    stopWatchers();

    // Watch .envrc — covers edits and direnv allow (which rewrites .envrc state)
    const envrcPath = join(cwd, ".envrc");
    try {
      const w = watch(envrcPath, () => scheduleReload());
      watchers.push(w);
    } catch {
      // .envrc may not exist — that's fine
    }

    // Watch .direnv/ — covers flake rebuilds, nix develop, direnv allow state
    const direnvDir = join(cwd, ".direnv");
    try {
      const w = watch(direnvDir, () => scheduleReload());
      watchers.push(w);
    } catch {
      // .direnv/ may not exist yet — that's fine
    }
  }

  function stopWatchers(): void {
    for (const w of watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    watchers = [];
    if (reloadTimer) {
      clearTimeout(reloadTimer);
      reloadTimer = null;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    loadDirenv(ctx.cwd, ctx);
    startWatchers(ctx.cwd);
  });

  pi.on("session_shutdown", async () => {
    stopWatchers();
    latestCtx = null;
  });

  pi.registerCommand("direnv", {
    description: "Reload direnv environment variables",
    handler: async (_args, ctx) => {
      latestCtx = ctx;
      loadDirenv(ctx.cwd, ctx);
      ctx.ui.notify("direnv reloaded", "info");
    },
  });
}
