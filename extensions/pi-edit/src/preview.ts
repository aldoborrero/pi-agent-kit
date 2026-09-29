import * as Diff from "diff";
import type { DiffPreview, FileChange, FileDiff } from "./types.ts";

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

function fromHunks(
  hunks: Diff.StructuredPatch["hunks"],
  chars: number,
): DiffPreview {
  const preview: DiffPreview = { lines: [], added: 0, removed: 0, chars };
  let contentChars = 0;
  for (let hi = 0; hi < hunks.length; hi++) {
    const hunk = hunks[hi]!;
    if (hi) {
      const previous = hunks[hi - 1]!;
      const gap = hunk.oldStart - (previous.oldStart + previous.oldLines);
      preview.lines.push({
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
      contentChars += content.length;
      if (
        content.length > MAX_LINE_CHARS ||
        contentChars > MAX_PREVIEW_CHARS ||
        preview.lines.length >= MAX_PREVIEW_LINES
      ) {
        return omittedPreview("Diff exceeds the preview size limit", chars);
      }
      if (line[0] === "+") {
        preview.added++;
        preview.lines.push({
          type: "add",
          oldNum: null,
          newNum: newNum++,
          content,
        });
      } else if (line[0] === "-") {
        preview.removed++;
        preview.lines.push({
          type: "del",
          oldNum: oldNum++,
          newNum: null,
          content,
        });
      } else {
        preview.lines.push({
          type: "ctx",
          oldNum: oldNum++,
          newNum: newNum++,
          content,
        });
      }
    }
  }
  return preview;
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
    : omittedPreview("Diff exceeded its computation budget", chars);
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
