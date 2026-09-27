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
import type { FileChange } from "../src/types.ts";

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
    fileChanges: FileChange[];
  };
};

describe("execute — fileChanges: classic single edit", () => {
  test("result.details.fileChanges has one entry with correct path, old/new content, and language", async () => {
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
      assert.equal(
        fc.oldContent,
        originalContent,
        "oldContent must be the pre-edit content",
      );
      assert.equal(
        fc.newContent,
        "const a = 99;\nconst b = 2;\n",
        "newContent must be the post-edit content",
      );
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
      assert.equal(
        fc.oldContent,
        originalContent,
        "oldContent must be original pre-edit content",
      );
      assert.equal(
        fc.newContent,
        "ALPHA\nbeta\nGAMMA\n",
        "newContent must reflect both edits applied",
      );
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

      // Add: oldContent empty, newContent non-empty.
      const added = fileChanges.find((fc) => fc.path.endsWith("new.txt"));
      assert.ok(added, "must have a FileChange for the added file");
      assert.equal(added!.oldContent, "", "added file has empty oldContent");
      assert.ok(
        added!.newContent.length > 0,
        "added file has non-empty newContent",
      );

      // Update: old and new differ.
      const updated = fileChanges.find((fc) => fc.path.endsWith("update.txt"));
      assert.ok(updated, "must have a FileChange for the updated file");
      assert.equal(updated!.oldContent, "keep\nold\ntail\n");
      assert.equal(updated!.newContent, "keep\nnew\ntail\n");

      // Delete: newContent empty.
      const deleted = fileChanges.find((fc) => fc.path.endsWith("delete.txt"));
      assert.ok(deleted, "must have a FileChange for the deleted file");
      assert.ok(
        deleted!.oldContent.length > 0,
        "deleted file has non-empty oldContent",
      );
      assert.equal(
        deleted!.newContent,
        "",
        "deleted file has empty newContent",
      );
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
      assert.deepEqual(result.details.fileChanges, [
        {
          path: join(dir, "a.ts"),
          oldContent: "alpha\nbeta\n",
          newContent: "beta\nBETA\n",
          firstChangedLine: 1,
          language: lang("a.ts"),
        },
      ]);
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
      assert.equal(
        result.details.fileChanges[0]!.newContent,
        untouched + "changed\n" + untouched,
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
