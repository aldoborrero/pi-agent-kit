import {
  computePreview,
  firstChangedLine as previewFirstLine,
} from "./preview.ts";
import type { DiffPreview } from "./types.ts";

function lineCount(text: string): number {
  let count = 1;
  for (
    let pos = text.indexOf("\n");
    pos !== -1;
    pos = text.indexOf("\n", pos + 1)
  )
    count++;
  return count;
}

/** Compute the bounded structured preview and gutter diff in a single pass. */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): {
  diff: string;
  firstChangedLine: number | undefined;
  preview: DiffPreview;
} {
  const preview = computePreview(oldContent, newContent, contextLines);
  if (preview.omitted) {
    return {
      diff: `Diff omitted: ${preview.omitted}.`,
      firstChangedLine: undefined,
      preview,
    };
  }
  const width = String(
    Math.max(lineCount(oldContent), lineCount(newContent)),
  ).length;
  const diff = preview.lines
    .map((line) => {
      if (line.type === "sep") return ` ${"".padStart(width)} ...`;
      const marker =
        line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
      const num = line.type === "add" ? line.newNum : line.oldNum;
      return `${marker}${String(num).padStart(width)} ${line.content}`;
    })
    .join("\n");
  return { diff, firstChangedLine: previewFirstLine(preview), preview };
}
