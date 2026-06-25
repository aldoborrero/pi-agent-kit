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

// ---------------------------------------------------------------------------
// Type stubs — kept minimal so the module loads cleanly in tests without
// a real pi-tui native build.
// ---------------------------------------------------------------------------

// We rely on ctx.lastComponent being provided at runtime (the real TUI always
// provides it). In tests, the smoke harness supplies a StubText. The lazy
// factory below is only called when lastComponent is absent.
function makeFallbackText(): { setText(v: string): void } {
  // Try to load pi-tui's Text lazily. If the native module fails (e.g. in a
  // test environment without the native addon), fall back to a plain object.
  try {
    const { Text } = require("@earendil-works/pi-tui") as {
      Text: new (
        t: string,
        px: number,
        py: number,
      ) => { setText(v: string): void };
    };
    return new Text("", 0, 0);
  } catch {
    return { setText(_v: string) {} };
  }
}

// ---------------------------------------------------------------------------
// Lightweight theme / context interfaces (mirrors pix-pretty's ThemeLike /
// RenderContextLike without importing the private pix-pretty types package).
// ---------------------------------------------------------------------------

interface ThemeLike {
  fg(key: string, s: string): string;
  bold(s: string): string;
  getFgAnsi?: (key: string) => string;
}

interface RenderCtx {
  toolCallId?: string;
  isError?: boolean;
  lastComponent?: { setText(v: string): void };
  state: Record<string, unknown>;
  invalidate(): void;
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
  theme: ThemeLike,
  ctx: RenderCtx,
): { setText(v: string): void } {
  const text = ctx.lastComponent ?? makeFallbackText();
  const fp = String(args.path ?? args.file_path ?? "");
  const hdr = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", fp)}`;

  let suffix: string;
  if (args.patch) {
    suffix = "patch";
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
  _opt: unknown,
  theme: ThemeLike,
  ctx: RenderCtx,
): { setText(v: string): void } {
  const text = ctx.lastComponent ?? makeFallbackText();

  // Error branch — show the error message and return immediately.
  if (ctx.isError) {
    text.setText(
      renderToolError(
        getTextContent(result as Parameters<typeof getTextContent>[0]) ||
          "Error",
        theme,
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
  const sig = fcs
    .map((fc) => `${fc.path}:${fc.oldContent.length}:${fc.newContent.length}`)
    .join("|");
  const key = `pied:${diffThemeCacheKey(theme)}:${termW()}:${fcs.length}:${sig}`;

  if (ctx.state._piek !== key) {
    ctx.state._piek = key;
    const placeholder = `  ${theme.fg("muted", "rendering diff…")}`;
    ctx.state._piet = placeholder;

    // Register for terminal-resize invalidation so diffs reflow when the
    // terminal is resized.
    if (ctx.toolCallId) {
      trackInvalidator(ctx.toolCallId, ctx.invalidate);
    }

    const dc = resolveDiffColors(theme);
    // Capture the key at the time of dispatch; stale-guard checks it on resolve.
    const capturedKey = key;

    Promise.all(
      fcs.map((fc) =>
        renderSplit(
          parseDiff(fc.oldContent, fc.newContent, 3, fc.firstChangedLine ?? 0),
          fc.language as string | undefined,
          MAX_RENDER_LINES,
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
