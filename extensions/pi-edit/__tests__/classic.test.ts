/**
 * applyClassicEdits — contract tests.
 *
 * Pins the classic-edit behavior before Phase C polish. Each test uses its own
 * tmpdir so they can run in parallel.
 */

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyClassicEdits, findActualString } from "../src/classic.ts";
import type { EditItem, Workspace } from "../src/types.ts";
import { createRealWorkspace } from "../src/workspace.ts";

// Stub ExtensionAPI — only `events.emit` is touched by the real workspace.
const stubPi: ExtensionAPI = {
  events: { emit: () => {} },
} as unknown as ExtensionAPI;

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "multi-edit-classic-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeWorkspace(): Workspace {
  return createRealWorkspace(stubPi);
}

describe("applyClassicEdits — single edit", () => {
  test("replaces oldText with newText", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "a.txt");
      await writeFile(file, "hello world\n");

      const edits: EditItem[] = [
        { path: "a.txt", oldText: "hello", newText: "HI" },
      ];
      const results = await applyClassicEdits(edits, makeWorkspace(), dir);

      assert.equal(results.length, 1);
      assert.equal(results[0]!.success, true);
      assert.equal(await readFile(file, "utf-8"), "HI world\n");
    });
  });

  test("accepts absolute paths", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "abs.txt");
      await writeFile(file, "foo\n");
      const edits: EditItem[] = [
        { path: file, oldText: "foo", newText: "bar" },
      ];
      const results = await applyClassicEdits(edits, makeWorkspace(), dir);
      assert.equal(results[0]!.success, true);
      assert.equal(await readFile(file, "utf-8"), "bar\n");
    });
  });

  test("returns failure when oldText is not found", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "a.txt");
      await writeFile(file, "hello world\n");
      const edits: EditItem[] = [
        { path: "a.txt", oldText: "absent", newText: "x" },
      ];
      await assert.rejects(
        () => applyClassicEdits(edits, makeWorkspace(), dir),
        /Could not find the exact text/,
      );
    });
  });
});

describe("applyClassicEdits — multi edit, same file", () => {
  test("applies two edits listed in bottom-up order (positional reordering)", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "a.txt");
      await writeFile(file, "aaa\nbbb\nccc\n");

      const edits: EditItem[] = [
        { path: "a.txt", oldText: "ccc", newText: "CCC" },
        { path: "a.txt", oldText: "aaa", newText: "AAA" },
      ];
      const results = await applyClassicEdits(edits, makeWorkspace(), dir);

      assert.equal(
        results.every((r) => r.success),
        true,
      );
      assert.equal(await readFile(file, "utf-8"), "AAA\nbbb\nCCC\n");
    });
  });

  test("skips redundant duplicate edit when only one occurrence exists", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "a.txt");
      await writeFile(file, "foo bar\n");

      const edits: EditItem[] = [
        { path: "a.txt", oldText: "foo", newText: "FOO" },
        { path: "a.txt", oldText: "foo", newText: "FOO" },
      ];
      const results = await applyClassicEdits(edits, makeWorkspace(), dir);

      assert.equal(results[0]!.success, true);
      assert.equal(results[1]!.success, true);
      assert.match(results[1]!.message, /Skipped redundant edit/);
      assert.equal(await readFile(file, "utf-8"), "FOO bar\n");
    });
  });
});

describe("applyClassicEdits — multi edit, multiple files", () => {
  test("applies edits across two files successfully", async () => {
    await withTmp(async (dir) => {
      const a = join(dir, "a.txt");
      const b = join(dir, "b.txt");
      await writeFile(a, "alpha\n");
      await writeFile(b, "beta\n");

      const edits: EditItem[] = [
        { path: "a.txt", oldText: "alpha", newText: "ALPHA" },
        { path: "b.txt", oldText: "beta", newText: "BETA" },
      ];
      const results = await applyClassicEdits(edits, makeWorkspace(), dir);

      assert.equal(
        results.every((r) => r.success),
        true,
      );
      assert.equal(await readFile(a, "utf-8"), "ALPHA\n");
      assert.equal(await readFile(b, "utf-8"), "BETA\n");
    });
  });

  test("rolls back first file when second file's edit fails", async () => {
    await withTmp(async (dir) => {
      const a = join(dir, "a.txt");
      const b = join(dir, "b.txt");
      await writeFile(a, "alpha\n");
      await writeFile(b, "beta\n");

      const edits: EditItem[] = [
        { path: "a.txt", oldText: "alpha", newText: "ALPHA" },
        { path: "b.txt", oldText: "NOT_PRESENT", newText: "x" },
      ];

      await assert.rejects(
        () =>
          applyClassicEdits(edits, makeWorkspace(), dir, undefined, {
            rollbackOnError: true,
          }),
        /Could not find the exact text/,
      );

      // a.txt should be restored; b.txt unchanged
      assert.equal(await readFile(a, "utf-8"), "alpha\n");
      assert.equal(await readFile(b, "utf-8"), "beta\n");
    });
  });
});

describe("applyClassicEdits — quote fallback (findActualString)", () => {
  test("matches curly-quote oldText against straight-quote file content", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "q.txt");
      // File has straight quotes; model's oldText has curly quotes (common when
      // model was trained on formatted prose).
      await writeFile(file, 'say "hello" to the world\n');

      const edits: EditItem[] = [
        { path: "q.txt", oldText: "say “hello”", newText: 'SAY "HELLO"' },
      ];
      const results = await applyClassicEdits(edits, makeWorkspace(), dir);
      assert.equal(results[0]!.success, true);
      assert.equal(await readFile(file, "utf-8"), 'SAY "HELLO" to the world\n');
    });
  });

  test("findActualString returns exact match when no normalization is needed", () => {
    const content = "hello world";
    const match = findActualString(content, "hello", 0);
    assert.ok(match);
    assert.equal(match!.pos, 0);
    assert.equal(match!.actualOldText, "hello");
  });

  test("findActualString falls back to curly→straight normalization of oldText", () => {
    const content = "a 'b' c"; // straight quotes in the file
    const match = findActualString(content, "a ‘b’ c", 0);
    assert.ok(match);
    assert.equal(match!.pos, 0);
    // actualOldText is the normalized (straight) form that was actually matched
    assert.equal(match!.actualOldText, "a 'b' c");
  });

  test("findActualString returns undefined when no match after normalization", () => {
    const match = findActualString("nothing here", "missing", 0);
    assert.equal(match, undefined);
  });
});

describe("applyClassicEdits — read-only file", () => {
  test("rejects before any mutation when target is read-only", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "ro.txt");
      await writeFile(file, "readonly\n");
      await chmod(file, 0o444);

      const edits: EditItem[] = [
        { path: "ro.txt", oldText: "readonly", newText: "X" },
      ];
      try {
        await assert.rejects(() =>
          applyClassicEdits(edits, makeWorkspace(), dir),
        );
        assert.equal(await readFile(file, "utf-8"), "readonly\n");
      } finally {
        await chmod(file, 0o644);
      }
    });
  });
});

describe("applyClassicEdits — trailing whitespace tolerance", () => {
  test("matches oldText with trailing spaces when file has none", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "ws.ts");
      await writeFile(file, "const x = 1;\nconst y = 2;\n");

      const edits: EditItem[] = [
        {
          path: "ws.ts",
          oldText: "const x = 1;  \nconst y = 2;  \n",
          newText: "const x = 10;\nconst y = 20;\n",
        },
      ];
      const results = await applyClassicEdits(edits, makeWorkspace(), dir);
      assert.equal(results[0]!.success, true);
      assert.equal(
        await readFile(file, "utf-8"),
        "const x = 10;\nconst y = 20;\n",
      );
    });
  });

  test("findActualString falls back to trimEnd when exact and quote passes miss", () => {
    const content = "line one\nline two\n";
    const match = findActualString(content, "line one  \nline two  \n", 0);
    assert.ok(match, "should find a match via trimEnd normalization");
    assert.equal(match!.pos, 0);
  });
});

describe("applyClassicEdits — continueOnError (partial success)", () => {
  test("applies successful edits and records failures without aborting", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "partial.ts");
      await writeFile(file, "aaa\nbbb\nccc\n");

      const edits: EditItem[] = [
        { path: "partial.ts", oldText: "aaa", newText: "AAA" },
        { path: "partial.ts", oldText: "DOES_NOT_EXIST", newText: "X" },
        { path: "partial.ts", oldText: "ccc", newText: "CCC" },
      ];
      const results = await applyClassicEdits(
        edits,
        makeWorkspace(),
        dir,
        undefined,
        {
          continueOnError: true,
        },
      );

      assert.equal(results[0]!.success, true, "first edit should succeed");
      assert.equal(results[1]!.success, false, "second edit should fail");
      assert.equal(
        results[2]!.success,
        true,
        "third edit should still succeed",
      );
      assert.equal(await readFile(file, "utf-8"), "AAA\nbbb\nCCC\n");
    });
  });

  test("all-or-nothing when continueOnError is false", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "strict.ts");
      await writeFile(file, "aaa\nbbb\nccc\n");

      const edits: EditItem[] = [
        { path: "strict.ts", oldText: "aaa", newText: "AAA" },
        { path: "strict.ts", oldText: "DOES_NOT_EXIST", newText: "X" },
        { path: "strict.ts", oldText: "ccc", newText: "CCC" },
      ];
      await assert.rejects(() =>
        applyClassicEdits(edits, makeWorkspace(), dir, undefined, {
          continueOnError: false,
          rollbackOnError: true,
        }),
      );
      // File should be untouched due to rollback.
      assert.equal(await readFile(file, "utf-8"), "aaa\nbbb\nccc\n");
    });
  });
});

describe("applyClassicEdits — onFileChange callback", () => {
  test("applyClassicEdits emits one FileChange per changed file (net of edits)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-edit-fc-"));
    const fp = join(dir, "f.ts");
    await writeFile(fp, "const a = 1;\nconst b = 2;\n", "utf-8");
    const ws = createRealWorkspace({ events: { emit() {} } } as any);
    const changes: any[] = [];
    await applyClassicEdits(
      [
        { path: fp, oldText: "const a = 1;", newText: "const a = 10;" },
        { path: fp, oldText: "const b = 2;", newText: "const b = 20;" },
      ],
      ws,
      dir,
      undefined,
      { collectDiff: true, onFileChange: (c) => changes.push(c) },
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, fp);
    assert.equal(changes[0].oldContent, "const a = 1;\nconst b = 2;\n");
    assert.equal(changes[0].newContent, "const a = 10;\nconst b = 20;\n");
    assert.equal(typeof changes[0].firstChangedLine, "number");
  });

  test("applyClassicEdits emits no FileChange for an unmatched (no-op) edit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-edit-fc-"));
    const fp = join(dir, "f.ts");
    await writeFile(fp, "x\n", "utf-8");
    const ws = createRealWorkspace({ events: { emit() {} } } as any);
    const changes: any[] = [];
    await applyClassicEdits(
      [{ path: fp, oldText: "NOPE", newText: "y" }],
      ws,
      dir,
      undefined,
      {
        collectDiff: true,
        continueOnError: true,
        onFileChange: (c) => changes.push(c),
      },
    );
    assert.equal(changes.length, 0);
  });
});

describe("applyClassicEdits — CRLF encoding round-trip", () => {
  test("edit succeeds against LF-normalized view and file retains CRLF on disk", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "crlf.txt");
      // Write a CRLF file to disk directly.
      await writeFile(file, "hello world\r\nfoo bar\r\n");

      // The Workspace strips CRLF on read; oldText is plain LF (as a model would supply).
      const edits: EditItem[] = [
        {
          path: "crlf.txt",
          oldText: "hello world\nfoo bar\n",
          newText: "HI WORLD\nFOO BAR\n",
        },
      ];
      const results = await applyClassicEdits(edits, makeWorkspace(), dir);

      // (a) edit succeeded — the LF oldText matched the LF-normalized content.
      assert.equal(results.length, 1);
      assert.equal(results[0]!.success, true);

      // (b) the file on disk still uses CRLF — the Workspace restored the original EOL.
      const raw = await readFile(file, "utf-8");
      assert.ok(raw.includes("\r\n"), "file on disk must still contain CRLF");
      assert.equal(raw, "HI WORLD\r\nFOO BAR\r\n");
    });
  });
});
