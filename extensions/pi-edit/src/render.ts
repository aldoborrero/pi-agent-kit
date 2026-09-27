/**
 * render.ts — TUI rendering for the pi-edit extension.
 *
 * Provides `renderCall` and `renderResult` hooks for the registered `edit`
 * tool, driving split-diff display from `details.fileChanges` (the actual
 * before→after per changed file) via `@xynogen/pix-pretty`.
 *
 * Architecture note: `renderResult` reads `details.fileChanges` — NOT the
 * call args — so accuracy reflects what the engine actually changed.
 * `renderCall` only has the request args and shows a header summary.
 */

import { createHash } from "node:crypto";
import type {
  Theme,
  ThemeColor,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { MAX_RENDER_LINES } from "@xynogen/pix-pretty/config";
import { parseDiff } from "@xynogen/pix-pretty/diff";
import {
  diffThemeCacheKey,
  renderSplit,
  resolveDiffColors,
} from "@xynogen/pix-pretty/diff-render";
import { trackInvalidator } from "@xynogen/pix-pretty/resize";
import {
  fillToolBackground,
  getTextContent,
  isTextContent,
  renderToolError,
  termW,
} from "@xynogen/pix-pretty/utils";

import type { FileChange } from "./types.ts";

type ToolRenderContext = Parameters<
  NonNullable<ToolDefinition["renderCall"]>
>[2];

// pix-pretty accepts string color keys; its renderer keys are Pi ThemeColors.
function prettyTheme(theme: Theme) {
  return {
    fg: (key: string, text: string) => theme.fg(key as ThemeColor, text),
    getFgAnsi: (key: string) => theme.getFgAnsi(key as ThemeColor),
  };
}

// Reuse only Text components; Pi's lastComponent can be any Component.
function textComponent(ctx: ToolRenderContext): Text {
  return ctx.lastComponent instanceof Text
    ? ctx.lastComponent
    : new Text("", 0, 0);
}

// ---------------------------------------------------------------------------
// renderCall
// ---------------------------------------------------------------------------

/**
 * Renders a one-line header summarising the incoming edit request.
 * Content is derived from `args` (the tool-call parameters) only.
 */
export function renderCall(
  args: Record<string, unknown>,
  theme: Theme,
  ctx: ToolRenderContext,
): Text {
  const text = textComponent(ctx);
  const fp = String(args.path ?? args.file_path ?? "");
  const hdr = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", fp)}`;

  let suffix: string;
  if (args.patch) {
    suffix = "patch";
  } else if (Array.isArray(args.edits)) {
    suffix = `${args.edits.length} edit${args.edits.length === 1 ? "" : "s"}`;
  } else if (args.multi) {
    const multiLen = Array.isArray(args.multi) ? args.multi.length : 0;
    const extra = args.oldText ? 1 : 0;
    const total = multiLen + extra;
    suffix = `${total} edit${total === 1 ? "" : "s"}`;
  } else {
    suffix = "edit";
  }

  text.setText(fillToolBackground(`${hdr}  ${theme.fg("muted", suffix)}`));
  return text;
}

// ---------------------------------------------------------------------------
// renderResult
// ---------------------------------------------------------------------------

/**
 * Renders the outcome of an edit operation, showing split diffs for each
 * changed file from `result.details.fileChanges`.
 *
 * Async rendering is kicked off when the cache key changes; `ctx.invalidate`
 * is called once the diff blocks are ready so the TUI redraws.
 */
export function renderResult(
  result: {
    content?: Array<{ type: string; text?: string }>;
    details?: unknown;
  },
  options: ToolRenderResultOptions,
  theme: Theme,
  ctx: ToolRenderContext,
): Text {
  const text = textComponent(ctx);

  // Error branch — show the error message and return immediately.
  if (ctx.isError) {
    ctx.state._piek = undefined;
    text.setText(
      renderToolError(
        getTextContent(result as Parameters<typeof getTextContent>[0]) ||
          "Error",
        prettyTheme(theme),
      ),
    );
    return text;
  }

  const details = result.details as Record<string, unknown> | undefined;
  const fcs: FileChange[] = Array.isArray(details?.fileChanges)
    ? (details.fileChanges as FileChange[])
    : [];

  // Empty fileChanges — show a one-line fallback from the text content.
  if (fcs.length === 0) {
    ctx.state._piek = undefined;
    const fallback = result.content?.[0];
    const fallbackText =
      fallback && isTextContent(fallback as Parameters<typeof isTextContent>[0])
        ? ((fallback as { text?: string }).text ?? "edited")
        : "edited";
    text.setText(
      fillToolBackground(
        `  ${theme.fg("dim", String(fallbackText).slice(0, 120))}`,
      ),
    );
    return text;
  }

  // Build a cache key from theme colours + terminal width + file change
  // content signatures. A change in any of these triggers a fresh render.
  const sig = createHash("sha256").update(JSON.stringify(fcs)).digest("hex");
  const key = `pied:${diffThemeCacheKey(prettyTheme(theme))}:${termW()}:${options.expanded}:${sig}`;

  if (ctx.state._piek !== key) {
    ctx.state._piek = key;
    const placeholder = `  ${theme.fg("muted", "rendering diff…")}`;
    ctx.state._piet = placeholder;

    // Register for terminal-resize invalidation so diffs reflow when the
    // terminal is resized.
    if (ctx.toolCallId) {
      trackInvalidator(ctx.toolCallId, ctx.invalidate);
    }

    const dc = resolveDiffColors(prettyTheme(theme));
    // Capture the key at the time of dispatch; stale-guard checks it on resolve.
    const capturedKey = key;

    Promise.all(
      fcs.map((fc) =>
        renderSplit(
          // fileChanges contains whole files, not snippets: no line offset.
          parseDiff(fc.oldContent, fc.newContent, 3),
          fc.language as string | undefined,
          options.expanded ? Number.POSITIVE_INFINITY : MAX_RENDER_LINES,
          dc,
        ),
      ),
    )
      .then((blocks) => {
        if (ctx.state._piek !== capturedKey) return; // stale render, discard
        ctx.state._piet = blocks.join("\n  ···\n");
        ctx.invalidate();
      })
      .catch(() => {
        if (ctx.state._piek !== capturedKey) return;
        ctx.state._piet = `  ${theme.fg("muted", "diff unavailable")}`;
        ctx.invalidate();
      });
  }

  text.setText(
    String(ctx.state._piet ?? `  ${theme.fg("muted", "rendering diff…")}`),
  );
  return text;
}
