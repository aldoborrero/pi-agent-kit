/**
 * applyClassicEdits — contract tests.
 *
 * Pins the classic-edit behavior before Phase C polish. Each test uses its own
 * tmpdir so they can run in parallel.
 */

import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  applyClassicEdits,
  countOccurrences,
  findActualString,
} from "../src/classic.ts";
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

describe("applyClassicEdits — unicode dash/space fallback (findActualString)", () => {
  test("en/em-dash oldText matches ASCII-hyphen file content", () => {
    const content = "range 1-10 done"; // ASCII hyphen in the file
    const enDash = findActualString(content, "range 1–10 done", 0); // U+2013
    assert.ok(enDash, "en-dash should match ASCII hyphen");
    assert.equal(enDash!.pos, 0);
    const emDash = findActualString(content, "range 1—10 done", 0); // U+2014
    assert.ok(emDash, "em-dash should match ASCII hyphen");
    assert.equal(emDash!.pos, 0);
  });

  test("ASCII-hyphen oldText matches en-dash file content", () => {
    const content = "range 1–10 done"; // en-dash (U+2013) in the file
    const match = findActualString(content, "range 1-10 done", 0);
    assert.ok(match, "ASCII hyphen should match en-dash");
    assert.equal(match!.pos, 0);
  });

  test("non-breaking-space oldText matches regular-space file content", () => {
    const content = "foo bar baz"; // regular spaces in the file
    const match = findActualString(content, "foo bar baz", 0); // NBSP
    assert.ok(match, "NBSP should match regular space");
    assert.equal(match!.pos, 0);
  });

  test("applies edit when oldText uses an em-dash and file uses a hyphen", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "dash.txt");
      await writeFile(file, "cost is 5-10 dollars\n"); // ASCII hyphen

      const edits: EditItem[] = [
        { path: "dash.txt", oldText: "5—10", newText: "5 to 10" }, // U+2014
      ];
      const results = await applyClassicEdits(edits, makeWorkspace(), dir);
      assert.equal(results[0]!.success, true);
      assert.equal(await readFile(file, "utf-8"), "cost is 5 to 10 dollars\n");
    });
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

describe("applyClassicEdits — uniqueness guard (built-in contract)", () => {
  test("ambiguous single oldText (2+ occurrences) errors instead of editing the first", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "dup.txt");
      await writeFile(file, "foo\nfoo\n");

      const edits: EditItem[] = [
        { path: "dup.txt", oldText: "foo", newText: "BAR" },
      ];
      await assert.rejects(
        () => applyClassicEdits(edits, makeWorkspace(), dir),
        /Found 2 occurrences of the text.*must be unique/s,
      );
      // File must be untouched.
      assert.equal(await readFile(file, "utf-8"), "foo\nfoo\n");
    });
  });

  test("unique oldText still applies normally", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "uniq.txt");
      await writeFile(file, "alpha\nbeta\ngamma\n");

      const edits: EditItem[] = [
        { path: "uniq.txt", oldText: "beta", newText: "BETA" },
      ];
      const results = await applyClassicEdits(edits, makeWorkspace(), dir);
      assert.equal(results[0]!.success, true);
      assert.equal(await readFile(file, "utf-8"), "alpha\nBETA\ngamma\n");
    });
  });

  test("positional multi-edit consumes duplicate occurrences (no false ambiguity)", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "pos.txt");
      await writeFile(file, "foo\nfoo\n");

      // Two edits for the same oldText: each consumes one occurrence in order.
      const edits: EditItem[] = [
        { path: "pos.txt", oldText: "foo", newText: "ONE" },
        { path: "pos.txt", oldText: "foo", newText: "TWO" },
      ];
      const results = await applyClassicEdits(edits, makeWorkspace(), dir);
      assert.equal(
        results.every((r) => r.success),
        true,
      );
      assert.equal(await readFile(file, "utf-8"), "ONE\nTWO\n");
    });
  });

  test("more occurrences than edits is still ambiguous", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "over.txt");
      await writeFile(file, "foo\nfoo\nfoo\n");

      // Only two edits target three occurrences — the extra one is un-targeted.
      const edits: EditItem[] = [
        { path: "over.txt", oldText: "foo", newText: "ONE" },
        { path: "over.txt", oldText: "foo", newText: "TWO" },
      ];
      await assert.rejects(
        () =>
          applyClassicEdits(edits, makeWorkspace(), dir, undefined, {
            rollbackOnError: true,
          }),
        /Found 3 occurrences of the text.*must be unique/s,
      );
      assert.equal(await readFile(file, "utf-8"), "foo\nfoo\nfoo\n");
    });
  });

  test("an occurrence inside an earlier edit's region still makes the text ambiguous", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "overlap.ts");
      const original = "if (a) { return x; }\nmiddle();\nreturn x;\n";
      await writeFile(file, original);

      // "return x;" occurs twice in the file. The first edit replaces the
      // region holding the first occurrence; the second must not quietly land
      // on the other one.
      const edits: EditItem[] = [
        {
          path: "overlap.ts",
          oldText: "if (a) { return x; }",
          newText: "if (a) { return y; }",
        },
        { path: "overlap.ts", oldText: "return x;", newText: "return z;" },
      ];
      await assert.rejects(
        () =>
          applyClassicEdits(edits, makeWorkspace(), dir, undefined, {
            rollbackOnError: true,
          }),
        /Found 2 occurrences of the text.*must be unique/s,
      );
      assert.equal(await readFile(file, "utf-8"), original);
    });
  });

  test("countOccurrences counts non-overlapping matches", () => {
    assert.equal(countOccurrences("foo foo foo", "foo"), 3);
    assert.equal(countOccurrences("foo bar", "foo"), 1);
    assert.equal(countOccurrences("nothing", "foo"), 0);
    assert.equal(countOccurrences("foo foo", ""), 0);
  });
});

describe("applyClassicEdits — edits are planned against the original content", () => {
  /** Write `content`, apply `edits` to it in one batch, return the result. */
  async function applyTo(
    dir: string,
    content: string,
    ...edits: [oldText: string, newText: string][]
  ): Promise<string> {
    const file = join(dir, "f.txt");
    await writeFile(file, content);
    await applyClassicEdits(
      edits.map(([oldText, newText]) => ({ path: "f.txt", oldText, newText })),
      makeWorkspace(),
      dir,
      undefined,
      { rollbackOnError: true },
    );
    return readFile(file, "utf-8");
  }

  test("duplicates take their occurrences in file order around other edits", async () => {
    await withTmp(async (dir) => {
      assert.equal(
        await applyTo(dir, "A\nB\nA\n", ["A", "x"], ["A", "y"], ["B", "z"]),
        "x\nz\ny\n",
      );
    });
  });

  test("overlapping edits are rejected", async () => {
    await withTmp(async (dir) => {
      await assert.rejects(
        () =>
          applyTo(
            dir,
            "one two three\n",
            ["one two", "1 2"],
            ["two three", "2 3"],
          ),
        /overlaps another edit.*Merge them/s,
      );
      assert.equal(
        await readFile(join(dir, "f.txt"), "utf-8"),
        "one two three\n",
      );
    });
  });

  test("an edit that changes nothing is an error, not 'Edited'", async () => {
    await withTmp(async (dir) => {
      await assert.rejects(
        () => applyTo(dir, "same();\n", ["same();", "same();"]),
        /No changes made to f\.txt: oldText and newText are identical/,
      );
      // Fuzzy match whose replacement is what the file already says.
      await assert.rejects(
        () => applyTo(dir, "say “hi”\n", ['say "hi"', "say “hi”"]),
        /No changes made to f\.txt\. The replacement produced identical content/,
      );
    });
  });

  test("an abort while matching reaches the caller even when failures are tolerated", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "f.txt");
      await writeFile(file, "a\nb\n");
      // Not aborted when the file is picked up, aborted by the first edit.
      let checks = 0;
      const signal = {
        get aborted() {
          return checks++ > 0;
        },
      } as AbortSignal;
      await assert.rejects(
        () =>
          applyClassicEdits(
            [
              { path: "f.txt", oldText: "a", newText: "A" },
              { path: "f.txt", oldText: "b", newText: "B" },
            ],
            makeWorkspace(),
            dir,
            signal,
            { continueOnError: true, rollbackOnError: true },
          ),
        /aborted/,
      );
      assert.equal(await readFile(file, "utf-8"), "a\nb\n");
    });
  });
});

describe("applyClassicEdits — fuzzy matching maps back to the file's own text", () => {
  async function edit(
    dir: string,
    content: string,
    oldText: string,
    newText: string,
  ): Promise<string> {
    const file = join(dir, "f.txt");
    await writeFile(file, content);
    await applyClassicEdits(
      [{ path: "f.txt", oldText, newText }],
      makeWorkspace(),
      dir,
    );
    return readFile(file, "utf-8");
  }

  test("oldText ending in a newline matches lines with trailing whitespace", async () => {
    await withTmp(async (dir) => {
      assert.equal(
        await edit(dir, "foo();   \nbar();\nbaz();\n", "foo();\nbar();\n", "X\n"),
        "X\nbaz();\n",
      );
    });
  });

  test("a partial line matches through a length-changing normalization", async () => {
    await withTmp(async (dir) => {
      assert.equal(
        await edit(dir, 'const s = "wait…";\nnext\n', 's = "wait..."', 's = "go"'),
        'const s = "go";\nnext\n',
      );
    });
  });

  test("several tolerances combine in one match", async () => {
    await withTmp(async (dir) => {
      assert.equal(
        await edit(dir, "say ‘hi’   \nnext\n", "say 'hi'\nnext", "done"),
        "done\n",
      );
    });
  });

  test("the rest of a touched line keeps its own text", async () => {
    await withTmp(async (dir) => {
      assert.equal(
        await edit(dir, "x = foo —  bar   \nnext\n", "foo -", "FOO -"),
        "x = FOO -  bar   \nnext\n",
      );
    });
  });

  test("whitespace at the end of a mid-line oldText is part of the match", async () => {
    await withTmp(async (dir) => {
      assert.equal(await edit(dir, "\ta—b c \n", "\ta-b ", "NEW"), "NEWc \n");
    });
  });
});

describe("applyClassicEdits — paths as Pi's built-in tools read them", () => {
  test("drops the @ of a mentioned file, keeps it in a real name", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "a.txt"), "a\n");
      await mkdir(join(dir, "@types"));
      await writeFile(join(dir, "@types", "x.d.ts"), "x\n");
      await writeFile(join(dir, "types"), "decoy\n");

      await applyClassicEdits(
        [
          { path: "@a.txt", oldText: "a", newText: "A" },
          { path: "@types/x.d.ts", oldText: "x", newText: "X" },
        ],
        makeWorkspace(),
        dir,
      );

      assert.equal(await readFile(join(dir, "a.txt"), "utf-8"), "A\n");
      assert.equal(await readFile(join(dir, "@types", "x.d.ts"), "utf-8"), "X\n");
    });
  });
});

describe("applyClassicEdits — a symlink and its target are one file", () => {
  async function linked(dir: string, content: string) {
    await writeFile(join(dir, "real.txt"), content);
    await symlink(join(dir, "real.txt"), join(dir, "link.txt"));
  }

  test("edits through both names are matched together and written once", async () => {
    await withTmp(async (dir) => {
      await linked(dir, "one\ntwo\n");
      const writes: string[] = [];
      const workspace = makeWorkspace();
      const originalWrite = workspace.writeText;
      workspace.writeText = async (path, content) => {
        writes.push(path);
        await originalWrite(path, content);
      };

      await applyClassicEdits(
        [
          { path: "real.txt", oldText: "one", newText: "1" },
          { path: "link.txt", oldText: "two", newText: "2" },
        ],
        workspace,
        dir,
      );

      assert.equal(await readFile(join(dir, "real.txt"), "utf-8"), "1\n2\n");
      assert.equal(writes.length, 1);
      assert.ok((await lstat(join(dir, "link.txt"))).isSymbolicLink());
    });
  });

  test("the uniqueness check sees the edits made through the other name", async () => {
    await withTmp(async (dir) => {
      await linked(dir, "dup\ndup\n");
      // Two edits for two occurrences: unambiguous only as one file.
      await applyClassicEdits(
        [
          { path: "real.txt", oldText: "dup", newText: "first" },
          { path: "link.txt", oldText: "dup", newText: "second" },
        ],
        makeWorkspace(),
        dir,
      );
      assert.equal(
        await readFile(join(dir, "real.txt"), "utf-8"),
        "first\nsecond\n",
      );
    });
  });
});

describe("applyClassicEdits — empty oldText guard (built-in contract)", () => {
  test("empty oldText errors instead of inserting at file start", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "empty.txt");
      await writeFile(file, "keep me\n");

      const edits: EditItem[] = [
        { path: "empty.txt", oldText: "", newText: "INSERTED" },
      ];
      await assert.rejects(
        () => applyClassicEdits(edits, makeWorkspace(), dir),
        /oldText must not be empty/,
      );
      // File must be untouched — no insertion at offset 0.
      assert.equal(await readFile(file, "utf-8"), "keep me\n");
    });
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

  test("CRLF in oldText and newText does not double the carriage returns", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "crlf.txt");
      await writeFile(file, "a\r\nb\r\nc\r\n");

      const edits: EditItem[] = [
        { path: "crlf.txt", oldText: "a\r\nb", newText: "A\r\nB1\r\nB2" },
      ];
      await applyClassicEdits(edits, makeWorkspace(), dir);

      assert.equal(await readFile(file, "utf-8"), "A\r\nB1\r\nB2\r\nc\r\n");
    });
  });

  test("CRLF in newText is written as LF into an LF file", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "lf.txt");
      await writeFile(file, "a\nb\n");

      const edits: EditItem[] = [
        { path: "lf.txt", oldText: "a", newText: "A1\r\nA2" },
      ];
      await applyClassicEdits(edits, makeWorkspace(), dir);

      assert.equal(await readFile(file, "utf-8"), "A1\nA2\nb\n");
    });
  });
});

describe("matching — progress and offset regressions", () => {
  test("whitespace-only fuzzy searches terminate in a bounded child process", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const module = new URL("../src/classic.ts", import.meta.url).href;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--eval",
        `
      const { countOccurrences } = await import(${JSON.stringify(module)});
      console.log(JSON.stringify([" ", "\\t", "\\u00a0", "   "].map(s => countOccurrences("abc", s))));
    `,
      ],
      { timeout: 3000 },
    );
    assert.deepEqual(JSON.parse(stdout), [0, 0, 0, 0]);
  });

  test("exact whitespace replacements remain valid", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "spaces");
      await writeFile(file, "a  b\n");
      await applyClassicEdits(
        [{ path: file, oldText: "  ", newText: " " }],
        makeWorkspace(),
        dir,
      );
      assert.equal(await readFile(file, "utf8"), "a b\n");
    });
  });

  test("fuzzy matches never point before the requested offset or past EOF", () => {
    assert.equal(findActualString("hello  \nworld\n", "hello\n", 1), undefined);
    assert.equal(findActualString("hello  \n", "hello\n", 100), undefined);
    assert.equal(findActualString("abc", "", 0), undefined);
  });

  test("length-changing line fallback does not consume an extra newline", () => {
    const content = "prefix  \nhello  \n\ntail\n";
    const match = findActualString(content, "hello\n", 0);
    assert.ok(match);
    assert.equal(match.actualOldText, "hello  \n");
    assert.equal(
      content.slice(match.pos + match.actualOldText.length),
      "\ntail\n",
    );
  });
});

describe("matching — bounded uniqueness and prepared plans", () => {
  test("stops as soon as ambiguity is established", () => {
    assert.equal(countOccurrences("foo ".repeat(10000), "foo", 0, 2), 2);
    assert.equal(countOccurrences("foo foo foo", "foo", 4, 2), 2);
  });

  test("fuzzy variants before an exact occurrence still count as ambiguous", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "quotes");
      const original = "say ‘hi’\nsay 'hi'\n";
      await writeFile(file, original);
      await assert.rejects(
        () =>
          applyClassicEdits(
            [{ path: file, oldText: "say 'hi'", newText: "done" }],
            makeWorkspace(),
            dir,
          ),
        /occurrences/,
      );
      assert.equal(await readFile(file, "utf8"), original);
    });
  });

  test("prepared plans revalidate contents and inputs before reuse", async () => {
    const { createVirtualWorkspace } = await import("../src/workspace.ts");
    await withTmp(async (dir) => {
      const file = join(dir, "a");
      const edits = [{ path: file, oldText: "old", newText: "new" }];
      const prepared = new Map();
      await writeFile(file, "prefix\nold\n");
      await applyClassicEdits(
        edits,
        createVirtualWorkspace(dir),
        dir,
        undefined,
        { onPrepared: (path, plan) => prepared.set(path, plan) },
      );
      assert.equal(prepared.size, 1);
      await applyClassicEdits(edits, makeWorkspace(), dir, undefined, {
        prepared,
      });
      assert.equal(await readFile(file, "utf8"), "prefix\nnew\n");
      // An external modification must not be overwritten by the cached snapshot.
      await writeFile(file, "external\nold\n");
      await applyClassicEdits(edits, makeWorkspace(), dir, undefined, {
        prepared,
      });
      assert.equal(await readFile(file, "utf8"), "external\nnew\n");
      await writeFile(file, "prefix\nold\n");
      await applyClassicEdits(
        [{ ...edits[0]!, newText: "different" }],
        makeWorkspace(),
        dir,
        undefined,
        { prepared },
      );
      assert.equal(await readFile(file, "utf8"), "prefix\ndifferent\n");
    });
  });

  test("prepared plans still roll back on later write failure", async () => {
    const { createVirtualWorkspace } = await import("../src/workspace.ts");
    await withTmp(async (dir) => {
      const a = join(dir, "a"),
        b = join(dir, "b");
      await writeFile(a, "old");
      await writeFile(b, "old");
      const edits = [
        { path: a, oldText: "old", newText: "new" },
        { path: b, oldText: "old", newText: "new" },
      ];
      const prepared = new Map();
      await applyClassicEdits(
        edits,
        createVirtualWorkspace(dir),
        dir,
        undefined,
        { onPrepared: (path, plan) => prepared.set(path, plan) },
      );
      const workspace = makeWorkspace();
      const originalWrite = workspace.writeText;
      workspace.writeText = async (path, content) => {
        if (path === b && content === "new")
          throw new Error("simulated I/O failure");
        await originalWrite(path, content);
      };
      await assert.rejects(
        () =>
          applyClassicEdits(edits, workspace, dir, undefined, {
            prepared,
            rollbackOnError: true,
          }),
        /I\/O failure/,
      );
      assert.equal(await readFile(a, "utf8"), "old");
      assert.equal(await readFile(b, "utf8"), "old");
    });
  });
});

test("abort during a prepared write still restores the snapshot", async () => {
  const { createVirtualWorkspace } = await import("../src/workspace.ts");
  await withTmp(async (dir) => {
    const file = join(dir, "a");
    const edits = [{ path: file, oldText: "old", newText: "new" }];
    const prepared = new Map();
    await writeFile(file, "old");
    await applyClassicEdits(
      edits,
      createVirtualWorkspace(dir),
      dir,
      undefined,
      { onPrepared: (path, plan) => prepared.set(path, plan) },
    );
    const controller = new AbortController();
    const workspace = makeWorkspace(),
      originalWrite = workspace.writeText;
    workspace.writeText = async (path, content) => {
      await originalWrite(path, content);
      if (content === "new") controller.abort();
    };
    await assert.rejects(
      () =>
        applyClassicEdits(edits, workspace, dir, controller.signal, {
          prepared,
          rollbackOnError: true,
        }),
      /aborted/,
    );
    assert.equal(await readFile(file, "utf8"), "old");
  });
});
