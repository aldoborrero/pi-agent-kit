import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { createTwoFilesPatch } from "diff";
import {
  computePreview,
  previewFromPatch,
  MAX_DIFF_INPUT_CHARS,
  MAX_EDIT_DISTANCE,
  MAX_LINE_CHARS,
  MAX_PREVIEW_CHARS,
  boundedDiffText,
} from "../src/preview.ts";

test("pathological diffs fall back to a capped block diff in a bounded child process", async () => {
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
  // Too large for the line-diff search: each side is shown from its start.
  assert.equal(result.omitted, undefined);
  assert.equal(result.lines.length, 2 * MAX_EDIT_DISTANCE);
  assert.deepEqual([result.removed, result.added], [6000, 6000]);
  assert.match(result.truncated, /10976 more diff lines not shown/);
});

test("oversized inputs and persisted patches have explicit fallbacks", () => {
  assert.match(
    computePreview("x".repeat(MAX_DIFF_INPUT_CHARS + 1), "y").omitted!,
    /input limit/,
  );
  assert.match(
    previewFromPatch("x".repeat(MAX_PREVIEW_CHARS + 1)).omitted!,
    /size limit/,
  );
  assert.match(boundedDiffText("x".repeat(MAX_PREVIEW_CHARS + 1)), /omitted/);
});

test("an over-long line is cut instead of costing the whole diff", () => {
  const long = "x".repeat(MAX_LINE_CHARS + 100);
  const before = `${long}\nline b\nline c\n`;
  const preview = computePreview(before, before.replace("line c", "line C"));
  assert.equal(preview.omitted, undefined);
  assert.equal(preview.truncated, undefined);
  assert.equal(preview.lines[0]!.content, `${"x".repeat(MAX_LINE_CHARS)}…`);
  assert.deepEqual(
    preview.lines.slice(-2).map((l) => [l.type, l.oldNum, l.newNum, l.content]),
    [
      ["del", 3, null, "line c"],
      ["add", null, 3, "line C"],
    ],
  );
});

test("additions beyond the search budget keep their head, counts and line numbers", () => {
  const added =
    Array.from({ length: 600 }, (_, i) => `ins ${i}`).join("\n") + "\n";
  for (const [before, after, firstNew] of [
    ["", added, 1],
    ["a\nb\nc\nd\n", `a\nb\n${added}c\nd\n`, 3],
  ] as const) {
    const preview = computePreview(before, after);
    assert.equal(preview.omitted, undefined);
    assert.deepEqual([preview.removed, preview.added], [0, 600]);
    assert.match(preview.truncated!, /^88 more diff lines not shown$/);
    const adds = preview.lines.filter((l) => l.type === "add");
    assert.equal(adds.length, MAX_EDIT_DISTANCE);
    assert.deepEqual([adds[0]!.newNum, adds[0]!.content], [firstNew, "ins 0"]);
  }
});

test("a rewrite beyond the search budget is shown as one removed-then-added block", () => {
  const block = (word: string) =>
    Array.from({ length: 300 }, (_, i) => `${word} ${i}`).join("\n");
  const preview = computePreview(
    `head\n${block("old")}\ntail\n`,
    `head\n${block("new")}\ntail\n`,
  );
  assert.equal(preview.truncated, undefined);
  assert.deepEqual(
    preview.lines.map((l) => l.type).join("").replace(/(del)+/, "D").replace(/(add)+/, "A"),
    "ctxDActx",
  );
  assert.deepEqual([preview.removed, preview.added], [300, 300]);
});

test("the stored preview stops at its size budget and says how much is missing", () => {
  const after =
    Array.from({ length: 40 }, () => "y".repeat(MAX_LINE_CHARS)).join("\n") +
    "\n";
  const preview = computePreview("", after);
  assert.equal(preview.added, 40);
  assert.equal(preview.lines.length, Math.floor(MAX_PREVIEW_CHARS / MAX_LINE_CHARS));
  assert.match(preview.truncated!, /^8 more diff lines not shown$/);
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
