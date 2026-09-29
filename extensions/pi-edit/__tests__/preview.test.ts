import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { createTwoFilesPatch } from "diff";
import {
  computePreview,
  previewFromPatch,
  MAX_DIFF_INPUT_CHARS,
  MAX_LINE_CHARS,
  MAX_PREVIEW_CHARS,
  boundedDiffText,
} from "../src/preview.ts";

test("pathological diffs hit the work budget in a bounded child process", async () => {
  const module = new URL("../src/preview.ts", import.meta.url).href;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--eval",
      `
    const {computePreview}=await import(${JSON.stringify(module)});
    const old=Array.from({length:6000},(_,i)=>'old_'+i).join('\\n');
    const next=Array.from({length:6000},(_,i)=>'new_'+i).join('\\n');
    console.log(JSON.stringify(computePreview(old,next)));
  `,
    ],
    { timeout: 3000 },
  );
  const result = JSON.parse(stdout);
  assert.match(result.omitted, /budget/);
  assert.deepEqual(result.lines, []);
});

test("oversized inputs, lines and persisted patches have explicit fallbacks", () => {
  assert.match(
    computePreview("x".repeat(MAX_DIFF_INPUT_CHARS + 1), "y").omitted!,
    /input limit/,
  );
  assert.match(
    computePreview("x".repeat(MAX_LINE_CHARS + 1), "y").omitted!,
    /size limit/,
  );
  assert.match(
    previewFromPatch("x".repeat(MAX_PREVIEW_CHARS + 1)).omitted!,
    /size limit/,
  );
  assert.match(boundedDiffText("x".repeat(MAX_PREVIEW_CHARS + 1)), /omitted/);
});

test("compact hunks preserve non-contiguous line numbers and survive JSON", () => {
  const before =
    Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const after = before
    .replace("line 10\n", "TEN\n")
    .replace("line 90\n", "NINETY\n");
  const preview = previewFromPatch(
    createTwoFilesPatch("f", "f", before, after),
  );
  assert.equal(preview.omitted, undefined);
  assert.ok(preview.lines.some((l) => l.type === "sep"));
  assert.deepEqual(
    preview.lines
      .filter((l) => l.type === "add")
      .map((l) => [l.newNum, l.content]),
    [
      [10, "TEN"],
      [90, "NINETY"],
    ],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(preview)), preview);
  assert.ok(
    preview.lines.length < 30,
    "unchanged file bodies are not retained",
  );
});
