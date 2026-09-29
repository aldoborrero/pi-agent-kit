/**
 * execute — end-to-end integration tests.
 *
 * Drives the actual tool handler registered by the default export in extension.ts,
 * covering the virtual-preflight-then-real-apply orchestration. Each test uses
 * a real tmp directory and asserts on actual on-disk file contents as well as
 * the returned result shape.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lang } from "@xynogen/pix-pretty/lang";

import registerExtension from "../src/extension.ts";
import type { FileDiff } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Stub ExtensionAPI — registerTool captures the tool definition; events.emit
// is a no-op.
// ---------------------------------------------------------------------------

// The tool definition captured from pi.registerTool(…). The execute signature
// is: (toolCallId, params, signal, onUpdate, ctx) → Promise<result>.
interface CapturedTool {
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: { cwd: string },
  ) => Promise<unknown>;
}

function makeStub(): { pi: ExtensionAPI; getTool: () => CapturedTool } {
  let captured: CapturedTool | undefined;

  const pi = {
    registerTool(t: CapturedTool) {
      captured = t;
    },
    events: { emit() {} },
  } as unknown as ExtensionAPI;

  return {
    pi,
    getTool() {
      if (!captured) throw new Error("registerTool was never called");
      return captured;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-edit-execute-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Capture the tool once; all describe blocks share the same registration.
// ---------------------------------------------------------------------------

const { pi, getTool } = makeStub();
registerExtension(pi);
const { execute } = getTool();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("execute — classic single edit", () => {
  test("applies the edit on disk and returns diff + firstChangedLine", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "hello.ts");
      await writeFile(file, "const x = 1;\nconst y = 2;\n");

      const result = (await execute(
        "tid-1",
        { path: "hello.ts", oldText: "const x = 1;", newText: "const x = 42;" },
        undefined,
        undefined,
        { cwd: dir },
      )) as {
        content: { type: string; text: string }[];
        details: { diff: string; firstChangedLine?: number };
      };

      // File must be updated on disk.
      assert.equal(
        await readFile(file, "utf-8"),
        "const x = 42;\nconst y = 2;\n",
      );

      // Result shape: content array + details with diff and firstChangedLine.
      assert.ok(Array.isArray(result.content));
      assert.equal(result.content[0]!.type, "text");
      assert.ok(typeof result.details.diff === "string");
      assert.ok(result.details.diff.length > 0, "diff must be non-empty");
      assert.ok(
        typeof result.details.firstChangedLine === "number",
        "firstChangedLine must be a number",
      );
    });
  });
});

describe("execute — multi batch (same file, 2 edits)", () => {
  test("applies both edits on disk and reports applied count", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "multi.ts");
      await writeFile(file, "alpha\nbeta\ngamma\n");

      const result = (await execute(
        "tid-2",
        {
          multi: [
            { path: "multi.ts", oldText: "alpha", newText: "ALPHA" },
            { path: "multi.ts", oldText: "gamma", newText: "GAMMA" },
          ],
        },
        undefined,
        undefined,
        { cwd: dir },
      )) as {
        content: { type: string; text: string }[];
        details: { diff: string; firstChangedLine?: number };
      };

      // Both edits must land on disk.
      assert.equal(await readFile(file, "utf-8"), "ALPHA\nbeta\nGAMMA\n");

      // The result text must indicate success for all edits.
      assert.ok(Array.isArray(result.content));
      const text = result.content[0]!.text;
      assert.match(text, /2.*edit/i);
    });
  });
});

describe("execute — patch update", () => {
  test("applies a Codex-style patch and updates the file on disk", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "src.txt");
      await writeFile(file, "keep\nold\ntail\n");

      const patch = [
        "*** Begin Patch",
        "*** Update File: src.txt",
        "@@",
        " keep",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n");

      const result = (await execute("tid-3", { patch }, undefined, undefined, {
        cwd: dir,
      })) as {
        content: { type: string; text: string }[];
        details: { diff: string; firstChangedLine?: number };
      };

      // File must be updated on disk.
      assert.equal(await readFile(file, "utf-8"), "keep\nnew\ntail\n");

      // Result must contain content and details.
      assert.ok(Array.isArray(result.content));
      assert.equal(result.content[0]!.type, "text");
      assert.ok(typeof result.details.diff === "string");
    });
  });
});

describe("execute — failure leaves no partial write (preflight blocks batch)", () => {
  test("when 2nd edit's oldText is absent, preflight rejects and no file is mutated", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "target.ts");
      await writeFile(file, "line one\nline two\n");

      // Batch: first edit is valid, second edit's oldText does not exist.
      // Because classic-mode batches run through the virtual-workspace preflight
      // with continueOnError=false, the preflight throws before any real write.
      await assert.rejects(
        () =>
          execute(
            "tid-4",
            {
              multi: [
                { path: "target.ts", oldText: "line one", newText: "LINE ONE" },
                {
                  path: "target.ts",
                  oldText: "THIS DOES NOT EXIST",
                  newText: "x",
                },
              ],
            },
            undefined,
            undefined,
            { cwd: dir },
          ),
        /Preflight failed/,
      );

      // The file must be completely unchanged — no partial write.
      assert.equal(await readFile(file, "utf-8"), "line one\nline two\n");
    });
  });
});

// ---------------------------------------------------------------------------
// Task 4 — details.fileChanges
// ---------------------------------------------------------------------------

type ResultWithFileChanges = {
  content: { type: string; text: string }[];
  details: {
    diff: string;
    firstChangedLine?: number;
    fileChanges: FileDiff[];
  };
};

// These fixtures fit entirely in the context window. Check the stored hunks
// still describe exactly what reached disk, with no retained file snapshots.
function assertSmallPreview(change: FileDiff, before: string, after: string) {
  assert.equal(change.format, "hunks-v1");
  assert.equal("oldContent" in change, false);
  assert.equal("newContent" in change, false);
  assert.equal(change.preview.omitted, undefined);
  const lines = change.preview.lines;
  const original = lines
    .filter((l) => l.type === "ctx" || l.type === "del")
    .map((l) => l.content);
  const updated = lines
    .filter((l) => l.type === "ctx" || l.type === "add")
    .map((l) => l.content);
  assert.equal(original.length ? original.join("\n") + "\n" : "", before);
  assert.equal(updated.length ? updated.join("\n") + "\n" : "", after);
}

describe("execute — fileChanges: classic single edit", () => {
  test("result.details.fileChanges has one entry with correct path, compact hunks, and language", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "example.ts");
      const originalContent = "const a = 1;\nconst b = 2;\n";
      await writeFile(file, originalContent);

      const result = (await execute(
        "tid-fc-1",
        {
          path: "example.ts",
          oldText: "const a = 1;",
          newText: "const a = 99;",
        },
        undefined,
        undefined,
        { cwd: dir },
      )) as ResultWithFileChanges;

      const fileChanges = result.details.fileChanges;
      assert.ok(Array.isArray(fileChanges), "fileChanges must be an array");
      assert.equal(fileChanges.length, 1, "exactly one FileChange entry");

      const fc = fileChanges[0]!;
      assert.equal(fc.path, file, "path must be the absolute file path");
      assertSmallPreview(fc, originalContent, "const a = 99;\nconst b = 2;\n");
      assert.equal(
        fc.language,
        lang(fc.path),
        "language must match lang(path)",
      );
    });
  });
});

describe("execute — fileChanges: multi batch 2 edits on one file", () => {
  test("result.details.fileChanges has one entry with net before→after content", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "batch.ts");
      const originalContent = "alpha\nbeta\ngamma\n";
      await writeFile(file, originalContent);

      const result = (await execute(
        "tid-fc-2",
        {
          multi: [
            { path: "batch.ts", oldText: "alpha", newText: "ALPHA" },
            { path: "batch.ts", oldText: "gamma", newText: "GAMMA" },
          ],
        },
        undefined,
        undefined,
        { cwd: dir },
      )) as ResultWithFileChanges;

      const fileChanges = result.details.fileChanges;
      assert.ok(Array.isArray(fileChanges), "fileChanges must be an array");
      assert.equal(
        fileChanges.length,
        1,
        "same-file batch must produce one FileChange entry",
      );

      const fc = fileChanges[0]!;
      assert.equal(fc.path, file, "path must be the absolute file path");
      assertSmallPreview(fc, originalContent, "ALPHA\nbeta\nGAMMA\n");
    });
  });
});

describe("execute — fileChanges: patch with add/update/delete", () => {
  test("result.details.fileChanges has 3 entries covering each changed path", async () => {
    await withTmp(async (dir) => {
      // Create the file to be updated and the file to be deleted.
      const updateFile = join(dir, "update.txt");
      const deleteFile = join(dir, "delete.txt");
      await writeFile(updateFile, "keep\nold\ntail\n");
      await writeFile(deleteFile, "gone\n");

      const patch = [
        "*** Begin Patch",
        "*** Add File: new.txt",
        "+hello",
        "*** Update File: update.txt",
        "@@",
        " keep",
        "-old",
        "+new",
        "*** Delete File: delete.txt",
        "*** End Patch",
      ].join("\n");

      const result = (await execute(
        "tid-fc-3",
        { patch },
        undefined,
        undefined,
        { cwd: dir },
      )) as ResultWithFileChanges;

      const fileChanges = result.details.fileChanges;
      assert.ok(Array.isArray(fileChanges), "fileChanges must be an array");
      assert.equal(
        fileChanges.length,
        3,
        "three operations → three FileChange entries",
      );

      const added = fileChanges.find((fc) => fc.path.endsWith("new.txt"));
      const updated = fileChanges.find((fc) => fc.path.endsWith("update.txt"));
      const deleted = fileChanges.find((fc) => fc.path.endsWith("delete.txt"));
      assert.ok(added && updated && deleted);
      assertSmallPreview(added, "", "hello\n");
      assertSmallPreview(updated, "keep\nold\ntail\n", "keep\nnew\ntail\n");
      assertSmallPreview(deleted, "gone\n", "");
    });
  });
});

describe("execute — native Pi edits[]", () => {
  test("matches every edit against the original, regardless of order or inserted text", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "a.ts"), "alpha\nbeta\n");
      const result = (await execute(
        "native",
        {
          path: "a.ts",
          edits: [
            { oldText: "beta", newText: "BETA" },
            { oldText: "alpha", newText: "beta" },
          ],
        },
        undefined,
        undefined,
        { cwd: dir },
      )) as ResultWithFileChanges & { details: { patch: string } };
      assert.equal(await readFile(join(dir, "a.ts"), "utf8"), "beta\nBETA\n");
      assert.match(result.details.patch, /--- a.ts/);
      assert.match(result.details.diff, /BETA/);
      assert.equal(result.details.fileChanges.length, 1);
      const change = result.details.fileChanges[0]!;
      assert.equal(change.path, join(dir, "a.ts"));
      assert.equal(change.language, lang("a.ts"));
      assert.equal(change.firstChangedLine, 1);
      assertSmallPreview(change, "alpha\nbeta\n", "beta\nBETA\n");
    });
  });

  for (const [name, content, edits, error] of [
    [
      "overlapping",
      "abcdef\n",
      [
        { oldText: "abc", newText: "X" },
        { oldText: "bc", newText: "Y" },
      ],
      /overlap/,
    ],
    [
      "ambiguous",
      "foo\nfoo\n",
      [{ oldText: "foo", newText: "X" }],
      /occurrences/,
    ],
    ["empty", "foo\n", [{ oldText: "", newText: "X" }], /must not be empty/],
    ["no-op", "foo\n", [{ oldText: "foo", newText: "foo" }], /No changes/],
    [
      "incremental",
      "foo\n",
      [
        { oldText: "foo", newText: "bar" },
        { oldText: "bar", newText: "baz" },
      ],
      /Could not find/,
    ],
  ] as const) {
    test(`${name} edits fail without writing`, async () => {
      await withTmp(async (dir) => {
        const file = join(dir, "a.txt");
        await writeFile(file, content);
        await assert.rejects(
          () =>
            execute("invalid", { path: "a.txt", edits }, undefined, undefined, {
              cwd: dir,
            }),
          error,
        );
        assert.equal(await readFile(file, "utf8"), content);
      });
    });
  }

  test("preserves BOM/CRLF and accepts CRLF in arguments", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "a.txt");
      await writeFile(file, "\uFEFFalpha\r\nbeta\r\n");
      await execute(
        "encoding",
        {
          path: "a.txt",
          edits: [{ oldText: "alpha\r\n", newText: "ALPHA\r\n" }],
        },
        undefined,
        undefined,
        { cwd: dir },
      );
      assert.equal(await readFile(file, "utf8"), "\uFEFFALPHA\r\nbeta\r\n");
    });
  });

  test("combined fuzzy matching preserves untouched Unicode and trailing whitespace", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "a.txt");
      const untouched = "unchanged ‘quotes’ — \uFB01  \n";
      await writeFile(
        file,
        untouched + "target ‘value’ — \uFB01  \n" + untouched,
      );
      const result = (await execute(
        "fuzzy",
        {
          path: "a.txt",
          edits: [{ oldText: "target 'value' - fi", newText: "changed" }],
        },
        undefined,
        undefined,
        { cwd: dir },
      )) as ResultWithFileChanges;
      assert.equal(
        await readFile(file, "utf8"),
        untouched + "changed\n" + untouched,
      );
      const change = result.details.fileChanges[0]!;
      assert.equal(change.format, "hunks-v1");
      assert.ok(
        change.preview.lines.some(
          (line) => line.type === "add" && line.content === "changed",
        ),
      );
      assert.ok(
        change.preview.lines.some(
          (line) =>
            line.type === "ctx" && line.content === untouched.slice(0, -1),
        ),
      );
    });
  });

  test("pre-aborted calls do not mutate", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "a.txt");
      await writeFile(file, "alpha");
      await assert.rejects(
        () =>
          execute(
            "abort",
            { path: "a.txt", edits: [{ oldText: "alpha", newText: "beta" }] },
            AbortSignal.abort(),
            undefined,
            { cwd: dir },
          ),
        /aborted/,
      );
      assert.equal(await readFile(file, "utf8"), "alpha");
    });
  });

  test("native and legacy edits share Pi's mutation queue", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "a.txt");
      await writeFile(file, "alpha\nbeta\ngamma\n");
      await Promise.all([
        execute(
          "one",
          { path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
          undefined,
          undefined,
          { cwd: dir },
        ),
        execute(
          "two",
          { path: "a.txt", oldText: "beta", newText: "BETA" },
          undefined,
          undefined,
          { cwd: dir },
        ),
        execute(
          "three",
          {
            patch:
              "*** Begin Patch\n*** Update File: a.txt\n@@\n-gamma\n+GAMMA\n*** End Patch",
          },
          undefined,
          undefined,
          { cwd: dir },
        ),
      ]);
      assert.equal(await readFile(file, "utf8"), "ALPHA\nBETA\nGAMMA\n");
    });
  });
});

describe("execute — bounded result persistence", () => {
  test("small edits on large files persist hunks, in all modes including headless", async () => {
    await withTmp(async (dir) => {
      const rows = Array.from(
        { length: 65536 },
        (_, i) => `row_${String(i).padStart(7, "0")} = "${"a".repeat(42)}";`,
      );
      const original = rows.join("\n") + "\n";
      const oldText = rows[32768]!,
        newText = oldText.replace("row_", "ROW_");
      for (const params of [
        { path: "large", edits: [{ oldText, newText }] },
        { path: "large", multi: [{ oldText, newText }] },
        {
          patch: `*** Begin Patch\n*** Update File: large\n@@\n-${oldText}\n+${newText}\n*** End Patch`,
        },
      ]) {
        await writeFile(join(dir, "large"), original);
        const result = (await execute("large", params, undefined, undefined, {
          cwd: dir,
        })) as ResultWithFileChanges;
        const json = JSON.stringify(result);
        assert.ok(
          Buffer.byteLength(json) < 16 * 1024,
          `oversized result: ${json.length}`,
        );
        const change = result.details.fileChanges[0]!;
        assert.equal(change.format, "hunks-v1");
        assert.equal("oldContent" in change, false);
        assert.equal("newContent" in change, false);
        assert.ok(
          change.preview.lines.some(
            (l) => l.type === "add" && l.newNum === 32769,
          ),
        );
        assert.equal(
          await readFile(join(dir, "large"), "utf8"),
          original.replace(oldText, newText),
        );
      }
    });
  });

  test("a budget-limited legacy preview does not undo a successful edit", async () => {
    await withTmp(async (dir) => {
      const before =
        Array.from({ length: 6000 }, (_, i) => `old_${i}`).join("\n") + "\n";
      const after =
        Array.from({ length: 6000 }, (_, i) => `new_${i}`).join("\n") + "\n";
      await writeFile(join(dir, "f"), before);
      const result = (await execute(
        "rewrite",
        { path: "f", oldText: before, newText: after },
        undefined,
        undefined,
        { cwd: dir },
      )) as ResultWithFileChanges;
      assert.equal(await readFile(join(dir, "f"), "utf8"), after);
      assert.match(result.details.fileChanges[0]!.preview.omitted!, /budget/);
      assert.ok(JSON.stringify(result).length < 2048);
    });
  });
});
