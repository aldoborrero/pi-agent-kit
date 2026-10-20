import * as Diff from "diff";
import { loadNatives } from "@aldoborrero/pi-natives/src/natives.ts";
import type { DiffPreview, FileChange, FileDiff } from "./types.ts";

// Native structuredPatchHunks (Rust) when available; jsdiff otherwise.
const natives = await loadNatives();

// Bounds apply before presentation/highlighting, not just to visible rows.
export const DIFF_TIMEOUT_MS = 15;
export const MAX_EDIT_DISTANCE = 512;
export const MAX_DIFF_INPUT_CHARS = 8 * 1024 * 1024;
export const MAX_PREVIEW_CHARS = 64 * 1024;
export const MAX_PREVIEW_LINES = 2000;
export const MAX_LINE_CHARS = 2000;

export function omittedPreview(reason: string, chars = 0): DiffPreview {
  return { lines: [], added: 0, removed: 0, chars, omitted: reason };
}

type PreviewLine = DiffPreview["lines"][number];

/** A preview under construction, with the lines that did not fit counted. */
interface PreviewBuilder {
  preview: DiffPreview;
  contentChars: number;
  full: boolean;
  hidden: number;
}

function createBuilder(chars: number): PreviewBuilder {
  return {
    preview: { lines: [], added: 0, removed: 0, chars },
    contentChars: 0,
    full: false,
    hidden: 0,
  };
}

/**
 * Append a line while the preview has room. An over-long line is cut rather
 * than dropped, and once the preview is full the rest is only counted: one
 * long line or a big change must not cost the reader the whole diff.
 */
function pushLine(builder: PreviewBuilder, line: PreviewLine): void {
  const length = Math.min(line.content.length, MAX_LINE_CHARS);
  if (
    builder.full ||
    builder.preview.lines.length >= MAX_PREVIEW_LINES ||
    builder.contentChars + length > MAX_PREVIEW_CHARS
  ) {
    builder.full = true;
    if (line.type !== "sep") builder.hidden++;
    return;
  }
  builder.contentChars += length;
  builder.preview.lines.push(
    line.content.length > MAX_LINE_CHARS
      ? { ...line, content: `${line.content.slice(0, MAX_LINE_CHARS)}…` }
      : line,
  );
}

function finishPreview(builder: PreviewBuilder): DiffPreview {
  if (builder.hidden > 0) {
    builder.preview.truncated = `${builder.hidden} more diff lines not shown`;
  }
  return builder.preview;
}

function fromHunks(
  hunks: Diff.StructuredPatch["hunks"],
  chars: number,
): DiffPreview {
  const builder = createBuilder(chars);
  const { preview } = builder;
  for (let hi = 0; hi < hunks.length; hi++) {
    const hunk = hunks[hi]!;
    if (hi) {
      const previous = hunks[hi - 1]!;
      const gap = hunk.oldStart - (previous.oldStart + previous.oldLines);
      pushLine(builder, {
        type: "sep",
        oldNum: null,
        newNum: gap > 0 ? gap : null,
        content: "",
      });
    }
    let oldNum = hunk.oldStart;
    let newNum = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue; // no-newline marker
      const content = line.slice(1);
      if (line[0] === "+") {
        preview.added++;
        pushLine(builder, {
          type: "add",
          oldNum: null,
          newNum: newNum++,
          content,
        });
      } else if (line[0] === "-") {
        preview.removed++;
        pushLine(builder, {
          type: "del",
          oldNum: oldNum++,
          newNum: null,
          content,
        });
      } else {
        pushLine(builder, {
          type: "ctx",
          oldNum: oldNum++,
          newNum: newNum++,
          content,
        });
      }
    }
  }
  return finishPreview(builder);
}

/** Lines of `text`, without the empty element after a final newline. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Diff of last resort: everything between the common leading and trailing
 * lines is one block, removed then added. That is exact for a pure insertion
 * or deletion, and valid though not minimal for a rewrite too large for the
 * line-diff search. Each side shows at most `MAX_EDIT_DISTANCE` lines — what
 * the search itself would have allowed — while the counts stay complete.
 */
function blockPreview(
  oldContent: string,
  newContent: string,
  context: number,
  chars: number,
): DiffPreview {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const shorter = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < shorter && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  )
    suffix++;

  const builder = createBuilder(chars);
  const { preview } = builder;
  preview.removed = oldLines.length - prefix - suffix;
  preview.added = newLines.length - prefix - suffix;

  for (let i = Math.max(0, prefix - context); i < prefix; i++) {
    pushLine(builder, {
      type: "ctx",
      oldNum: i + 1,
      newNum: i + 1,
      content: oldLines[i]!,
    });
  }
  for (let i = 0; i < Math.min(preview.removed, MAX_EDIT_DISTANCE); i++) {
    pushLine(builder, {
      type: "del",
      oldNum: prefix + i + 1,
      newNum: null,
      content: oldLines[prefix + i]!,
    });
  }
  for (let i = 0; i < Math.min(preview.added, MAX_EDIT_DISTANCE); i++) {
    pushLine(builder, {
      type: "add",
      oldNum: null,
      newNum: prefix + i + 1,
      content: newLines[prefix + i]!,
    });
  }
  builder.hidden +=
    Math.max(0, preview.removed - MAX_EDIT_DISTANCE) +
    Math.max(0, preview.added - MAX_EDIT_DISTANCE);
  for (let i = 0; i < Math.min(context, suffix); i++) {
    pushLine(builder, {
      type: "ctx",
      oldNum: oldLines.length - suffix + i + 1,
      newNum: newLines.length - suffix + i + 1,
      content: oldLines[oldLines.length - suffix + i]!,
    });
  }
  return finishPreview(builder);
}

/** Bounded fallback for legacy engines and historical snapshot-based results. */
export function computePreview(
  oldContent: string,
  newContent: string,
  context = 3,
): DiffPreview {
  const chars = oldContent.length + newContent.length;
  if (chars > MAX_DIFF_INPUT_CHARS)
    return omittedPreview("File exceeds the diff input limit", chars);
  if (oldContent === newContent)
    return { lines: [], added: 0, removed: 0, chars };
  // A new or deleted file needs no search at all.
  if (oldContent === "" || newContent === "")
    return blockPreview(oldContent, newContent, context, chars);
  // Native path first (Rust myers — fast, but the MAX_EDIT_DISTANCE product
  // budget still applies: pathological diffs get the capped block preview,
  // not a giant hunk dump). Edit-script length = +/- lines across hunks.
  if (natives) {
    try {
      const hunks = natives.structuredPatchHunks(oldContent, newContent, context);
      const editDistance = hunks.reduce(
        (sum, h) =>
          sum + h.lines.filter((l) => l.startsWith("+") || l.startsWith("-")).length,
        0,
      );
      if (hunks.length > 0 && editDistance <= MAX_EDIT_DISTANCE) {
        return fromHunks(hunks as unknown as Diff.StructuredPatch["hunks"], chars);
      }
      if (hunks.length > 0 && editDistance > MAX_EDIT_DISTANCE) {
        return blockPreview(oldContent, newContent, context, chars);
      }
      // Empty hunks on differing inputs (e.g. trailing-newline-only change):
      // fall through to jsdiff.
    } catch {
      // fall through to jsdiff
    }
  }
  const patch = Diff.structuredPatch(
    "",
    "",
    oldContent,
    newContent,
    undefined,
    undefined,
    {
      context,
      timeout: DIFF_TIMEOUT_MS,
      maxEditLength: MAX_EDIT_DISTANCE,
    },
  );
  return patch
    ? fromHunks(patch.hunks, chars)
    : blockPreview(oldContent, newContent, context, chars);
}

/** Reuse Pi's already computed patch instead of rediffing whole files. */
export function previewFromPatch(patch: string): DiffPreview {
  if (patch.length > MAX_PREVIEW_CHARS)
    return omittedPreview("Patch exceeds the preview size limit");
  try {
    const patches = Diff.parsePatch(patch);
    return fromHunks(
      patches.flatMap((p) => p.hunks),
      patch.length,
    );
  } catch {
    return omittedPreview("Diff preview unavailable");
  }
}

/**
 * Parse the native engine's line-numbered diff format:
 *
 * ```
 *  1|alpha   context (old and new number coincide in this rendering)
 * -2|beta    removed from the old file at line 2
 * +2|BETA    added to the new file at line 2
 * ```
 *
 * Non-matching lines become separators; added/removed count every changed
 * line even when the display is bounded by MAX_PREVIEW_CHARS upstream.
 */
export function previewFromNumberedDiff(diff: string): DiffPreview {
  const lines: DiffPreview["lines"] = [];
  let added = 0;
  let removed = 0;
  for (const raw of diff.split("\n")) {
    const marker = raw[0];
    const match = /^( |\+|-)\s*(\d+)\|(.*)$/.exec(raw);
    if (!match) {
      if (raw.trim().length > 0) {
        lines.push({ type: "sep", oldNum: null, newNum: null, content: raw });
      }
      continue;
    }
    const num = Number.parseInt(match[2]!, 10);
    const content = match[3]!;
    if (marker === "+") {
      added++;
      lines.push({ type: "add", oldNum: null, newNum: num, content });
    } else if (marker === "-") {
      removed++;
      lines.push({ type: "del", oldNum: num, newNum: null, content });
    } else {
      lines.push({ type: "ctx", oldNum: num, newNum: num, content });
    }
  }
  return {
    lines: lines.slice(0, MAX_PREVIEW_LINES),
    added,
    removed,
    chars: diff.length,
    ...(lines.length > MAX_PREVIEW_LINES ? { omitted: "Diff preview truncated" } : {}),
  };
}

export function firstChangedLine(preview: DiffPreview): number | undefined {
  let nextNew = 1;
  for (const line of preview.lines) {
    if (line.type === "sep") continue;
    if (line.type === "ctx") nextNew = (line.newNum ?? nextNew) + 1;
    else return line.newNum ?? line.oldNum ?? nextNew;
  }
  return undefined;
}

export function compactChange(change: FileChange): FileDiff {
  return {
    format: "hunks-v1",
    path: change.path,
    language: change.language,
    firstChangedLine: change.firstChangedLine,
    preview:
      change.preview ?? computePreview(change.oldContent, change.newContent),
  };
}

/** Clamp text details too, so large native diffs cannot bloat session files. */
export function boundedDiffText(text: string): string {
  return text.length <= MAX_PREVIEW_CHARS
    ? text
    : "Diff omitted: exceeds the stored diff size limit.";
}
