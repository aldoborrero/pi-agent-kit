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

import type {
  Theme,
  ThemeColor,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { MAX_RENDER_LINES } from "@xynogen/pix-pretty/config";
import {
  diffThemeCacheKey,
  renderSplit,
  resolveDiffColors,
} from "@xynogen/pix-pretty/diff-render";
import {
  fillToolBackground,
  getTextContent,
  isTextContent,
  renderToolError,
  termW,
} from "@xynogen/pix-pretty/utils";

import {
  compactChange,
  DIFF_TIMEOUT_MS,
  MAX_PREVIEW_LINES,
  omittedPreview,
} from "./preview.ts";
import type { DiffPreview, FileChange, FileDiff } from "./types.ts";

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

// Resize ownership stays with the component: no global registry can retain a
// closed session. Pi normally invalidates on resize; this also handles direct
// component renders with a new width.
class DiffText extends Text {
  private width?: number;
  onResize?: () => void;
  override render(width: number): string[] {
    const changed = this.width !== undefined && this.width !== width;
    this.width = width;
    if (changed) this.onResize?.();
    return super.render(width);
  }
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

// Previews are immutable tool-result data. Memoize historical snapshots by
// object identity + content references, never by serializing entire files.
const previews = new WeakMap<
  object,
  {
    oldContent?: string;
    newContent?: string;
    sourcePreview?: FileDiff["preview"];
    view: FileDiff;
  }
>();
const DEFERRED = "Historical diff exceeded the render computation budget";

function viewFor(change: FileChange | FileDiff, deadline: number): FileDiff {
  const raw = change as FileChange;
  const cached = previews.get(change);
  if (
    cached &&
    cached.oldContent === raw.oldContent &&
    cached.newContent === raw.newContent &&
    cached.sourcePreview === change.preview &&
    cached.view.path === change.path &&
    cached.view.language === change.language
  )
    return cached.view;
  const isCompact = "format" in change && change.format === "hunks-v1";
  // Out of time for this render: show a placeholder but do not remember it,
  // so a later render gets to compute the diff.
  if (!isCompact && !raw.preview && Date.now() >= deadline) {
    return compactChange({ ...raw, preview: omittedPreview(DEFERRED) });
  }
  const view = isCompact ? { ...change } : compactChange(raw);
  previews.set(change, {
    oldContent: raw.oldContent,
    newContent: raw.newContent,
    sourcePreview: change.preview,
    view,
  });
  return view;
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
  const text =
    ctx.lastComponent instanceof DiffText
      ? ctx.lastComponent
      : new DiffText("", 0, 0);
  text.onResize = ctx.invalidate;

  // Error branch — show the error message and return immediately.
  if (ctx.isError) {
    ctx.state._piek = undefined;
    ctx.state._pieViews = undefined;
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
  const fcs: Array<FileChange | FileDiff> = Array.isArray(details?.fileChanges)
    ? (details.fileChanges as Array<FileChange | FileDiff>)
    : [];

  // Empty fileChanges — show a one-line fallback from the text content.
  if (fcs.length === 0) {
    ctx.state._piek = undefined;
    ctx.state._pieViews = undefined;
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

  const deadline = Date.now() + DIFF_TIMEOUT_MS;
  const views = fcs
    .slice(0, options.expanded ? 100 : 20)
    .map((fc) => viewFor(fc, deadline));
  // Diffs left out for lack of time get their turn on the next render. Every
  // render computes at least one before its deadline can pass, so this ends.
  if (views.some((view) => view.preview.omitted === DEFERRED)) {
    setTimeout(ctx.invalidate, 0);
  }
  const previous = ctx.state._pieViews as FileDiff[] | undefined;
  if (
    !previous ||
    previous.length !== views.length ||
    views.some((view, i) => view !== previous[i])
  ) {
    ctx.state._pieViews = views;
    ctx.state._pieRevision = Number(ctx.state._pieRevision ?? 0) + 1;
  }
  const key = `pied:${ctx.state._pieRevision}:${fcs.length}:${diffThemeCacheKey(prettyTheme(theme))}:${termW()}:${options.expanded}`;

  if (ctx.state._piek !== key) {
    ctx.state._piek = key;
    const placeholder = `  ${theme.fg("muted", "rendering diff…")}`;
    ctx.state._piet = placeholder;

    const dc = resolveDiffColors(prettyTheme(theme));
    // Capture the key at the time of dispatch; stale-guard checks it on resolve.
    const capturedKey = key;

    let remainingLines = options.expanded
      ? MAX_PREVIEW_LINES
      : MAX_RENDER_LINES;
    let wordWork = 1_000_000;
    const pending: Promise<string>[] = [];
    for (const fc of views) {
      if (remainingLines <= 0) break;
      if (fc.preview.omitted) {
        pending.push(
          Promise.resolve(
            `  ${theme.fg("muted", `Diff omitted: ${fc.preview.omitted}.`)}`,
          ),
        );
        remainingLines--;
        continue;
      }
      const limit = Math.min(remainingLines, fc.preview.lines.length);
      remainingLines -= limit + 1;
      // pix-pretty's word diff is unbounded even when line diffing is cheap.
      // Estimate worst-case work conservatively and fall back to a linear,
      // line-numbered renderer for long lines / large expanded changes.
      const work = fc.preview.lines
        .slice(0, limit)
        .reduce(
          (total, line) =>
            total +
            (line.type === "add" || line.type === "del"
              ? line.content.length ** 2
              : 0),
          0,
        );
      // Say so when the stored preview itself stops short of the change; while
      // only part of it is visible, the renderer's own "more lines" note covers it.
      const note =
        fc.preview.truncated && limit >= fc.preview.lines.length
          ? `\n  ${theme.fg("muted", `… ${fc.preview.truncated}`)}`
          : "";
      if (work > wordWork) {
        pending.push(
          Promise.resolve(renderPlain(fc.preview, limit, theme) + note),
        );
      } else {
        wordWork -= work;
        pending.push(
          renderSplit(fc.preview, fc.language, limit, dc).then(
            (block) => block + note,
          ),
        );
      }
    }
    Promise.all(pending)
      .then((blocks) => {
        if (ctx.state._piek !== capturedKey) return; // stale render, discard
        const hidden = fcs.length - blocks.length;
        ctx.state._piet =
          blocks.join("\n  ···\n") +
          (hidden > 0
            ? `\n  ${hidden} more file diff(s) not shown (render limit).`
            : "");
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

function renderPlain(
  preview: DiffPreview,
  limit: number,
  theme: Theme,
): string {
  const lines = preview.lines.slice(0, limit).map((line) => {
    if (line.type === "sep") return "  …";
    const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
    const num = line.type === "add" ? line.newNum : line.oldNum;
    const color =
      line.type === "add"
        ? "toolDiffAdded"
        : line.type === "del"
          ? "toolDiffRemoved"
          : "toolDiffContext";
    return theme.fg(color, `${marker}${num} ${line.content}`);
  });
  const remaining = preview.lines.length - limit;
  return (
    `  ${theme.fg("muted", "Plain diff (word highlighting disabled by budget).")}\n${lines.join("\n")}` +
    (remaining > 0 ? `\n  … ${remaining} more diff lines` : "")
  );
}
