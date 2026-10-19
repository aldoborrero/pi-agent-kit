/**
 * parsePatch + applyPatchOperations — contract tests.
 *
 * Covers the Codex-style patch parsing and application surface in pi-edit:
 * structural validation, Add/Delete/Update/Move round-trips, multi-op batches,
 * whole-line hunk matching, rollback on failure, and write-access preflight.
 */

import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getuid } from "node:process";
import { describe, test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyPatchOperations, parsePatch } from "../src/patch.ts";
import {
  createRealWorkspace,
  createVirtualWorkspace,
} from "../src/workspace.ts";

const stubPi: ExtensionAPI = {
  events: { emit: () => {} },
} as unknown as ExtensionAPI;

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-edit-patch-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const patchOf = (...body: string[]): string =>
  ["*** Begin Patch", ...body, "*** End Patch"].join("\n");

/** Write `content` to `name`, apply `body` as a patch, return the new content. */
async function applyTo(
  dir: string,
  name: string,
  content: string,
  ...body: string[]
): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, content);
  await applyPatchOperations(
    parsePatch(patchOf(`*** Update File: ${name}`, ...body)),
    createRealWorkspace(stubPi),
    dir,
  );
  return readFile(file, "utf-8");
}

describe("parsePatch — structural errors", () => {
  test("rejects patch missing '*** Begin Patch'", () => {
    assert.throws(
      () => parsePatch("not a patch\n*** End Patch"),
      /first line of the patch must be/,
    );
  });

  test("rejects patch missing '*** End Patch'", () => {
    assert.throws(
      () => parsePatch("*** Begin Patch\nno end"),
      /last line of the patch must be/,
    );
  });

  test("rejects empty patch", () => {
    assert.throws(() => parsePatch(""), /empty or invalid/);
  });

  test("rejects invalid hunk header", () => {
    const patch = "*** Begin Patch\n*** Frobnicate: a.txt\n*** End Patch";
    assert.throws(() => parsePatch(patch), /not a valid hunk header/);
  });
});

describe("parsePatch — Add File", () => {
  test("parses a single add-file op", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: new.txt",
      "+line one",
      "+line two",
      "*** End Patch",
    ].join("\n");
    const ops = parsePatch(patch);
    assert.equal(ops.length, 1);
    const op0 = ops[0]!;
    assert.equal(op0.kind, "add");
    if (op0.kind === "add") {
      assert.equal(op0.path, "new.txt");
      assert.equal(op0.contents, "line one\nline two\n");
    }
  });
});

describe("parsePatch — Delete File", () => {
  test("parses a single delete-file op", () => {
    const patch = "*** Begin Patch\n*** Delete File: old.txt\n*** End Patch";
    const ops = parsePatch(patch);
    assert.equal(ops.length, 1);
    const op0 = ops[0]!;
    assert.equal(op0.kind, "delete");
    if (op0.kind === "delete") {
      assert.equal(op0.path, "old.txt");
    }
  });
});

describe("parsePatch — Update File", () => {
  test("parses an update with a single context-anchored hunk", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src.txt",
      "@@",
      " unchanged",
      "-old line",
      "+new line",
      "*** End Patch",
    ].join("\n");
    const ops = parsePatch(patch);
    assert.equal(ops.length, 1);
    const op0 = ops[0]!;
    assert.equal(op0.kind, "update");
    if (op0.kind === "update") {
      assert.deepEqual(op0.hunks, [
        {
          contextPrefix: undefined,
          lines: [
            { kind: "context", text: "unchanged" },
            { kind: "remove", text: "old line" },
            { kind: "add", text: "new line" },
          ],
          endOfFile: false,
        },
      ]);
    }
  });

  test("parses a move, an anchored hunk and an end-of-file marker", () => {
    const ops = parsePatch(
      patchOf(
        "*** Update File: src.txt",
        "*** Move to: dst.txt",
        "@@ function tail() {",
        "-old",
        "+new",
        "*** End of File",
      ),
    );
    assert.deepEqual(ops, [
      {
        kind: "update",
        path: "src.txt",
        moveTo: "dst.txt",
        hunks: [
          {
            contextPrefix: "function tail() {",
            lines: [
              { kind: "remove", text: "old" },
              { kind: "add", text: "new" },
            ],
            endOfFile: true,
          },
        ],
      },
    ]);
  });

  test("accepts a first hunk without its @@ header", () => {
    const ops = parsePatch(patchOf("*** Update File: src.txt", "-old", "+new"));
    const op0 = ops[0]!;
    assert.equal(op0.kind === "update" && op0.hunks.length, 1);
  });

  test("accepts a patch wrapped in a shell heredoc", () => {
    const wrapped = `<<'EOF'\n${patchOf("*** Delete File: old.txt")}\nEOF`;
    assert.deepEqual(parsePatch(wrapped), [{ kind: "delete", path: "old.txt" }]);
  });

  test("rejects an update without hunks, naming the patch line", () => {
    assert.throws(
      () => parsePatch(patchOf("*** Update File: src.txt")),
      /line 3: Update file hunk for path 'src.txt' is empty/,
    );
  });

  test("rejects a second hunk without a @@ header after an invalid line", () => {
    assert.throws(
      () => parsePatch(patchOf("*** Update File: src.txt", "@@", "-a", "oops")),
      /Expected update hunk to start with a @@ context marker/,
    );
  });
});

describe("applyPatchOperations — Add File round-trip", () => {
  test("creates the file with the given contents", async () => {
    await withTmp(async (dir) => {
      const patch = [
        "*** Begin Patch",
        "*** Add File: greet.txt",
        "+hello",
        "+world",
        "*** End Patch",
      ].join("\n");
      const ops = parsePatch(patch);
      await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);
      assert.equal(
        await readFile(join(dir, "greet.txt"), "utf-8"),
        "hello\nworld\n",
      );
    });
  });
});

describe("applyPatchOperations — Delete File round-trip", () => {
  test("removes the target file", async () => {
    await withTmp(async (dir) => {
      const victim = join(dir, "gone.txt");
      await writeFile(victim, "bye\n");

      const patch = "*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch";
      const ops = parsePatch(patch);
      await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);
      assert.equal(await exists(victim), false);
    });
  });

  test("rejects deletion of a non-existent file", async () => {
    await withTmp(async (dir) => {
      const patch =
        "*** Begin Patch\n*** Delete File: ghost.txt\n*** End Patch";
      const ops = parsePatch(patch);
      await assert.rejects(
        () => applyPatchOperations(ops, createRealWorkspace(stubPi), dir),
        /does not exist/,
      );
    });
  });
});

describe("applyPatchOperations — Update File round-trip", () => {
  test("applies a single-hunk replacement", async () => {
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
      const ops = parsePatch(patch);
      await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);
      assert.equal(await readFile(file, "utf-8"), "keep\nnew\ntail\n");
    });
  });

  test("applies two non-overlapping hunks", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "src.txt");
      await writeFile(file, "a\nb\nc\nd\ne\nf\ng\n");

      const patch = [
        "*** Begin Patch",
        "*** Update File: src.txt",
        "@@",
        " a",
        "-b",
        "+B",
        "@@",
        " e",
        "-f",
        "+F",
        "*** End Patch",
      ].join("\n");
      const ops = parsePatch(patch);
      await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);
      assert.equal(await readFile(file, "utf-8"), "a\nB\nc\nd\ne\nF\ng\n");
    });
  });
});

describe("applyPatchOperations — multi-op", () => {
  test("applies add + update + delete in one batch", async () => {
    await withTmp(async (dir) => {
      const keep = join(dir, "keep.txt");
      const gone = join(dir, "gone.txt");
      await writeFile(keep, "foo\nbar\n");
      await writeFile(gone, "delete me\n");

      const patch = [
        "*** Begin Patch",
        "*** Add File: new.txt",
        "+created",
        "*** Update File: keep.txt",
        "@@",
        " foo",
        "-bar",
        "+BAR",
        "*** Delete File: gone.txt",
        "*** End Patch",
      ].join("\n");
      const ops = parsePatch(patch);
      await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);

      assert.equal(await readFile(join(dir, "new.txt"), "utf-8"), "created\n");
      assert.equal(await readFile(keep, "utf-8"), "foo\nBAR\n");
      assert.equal(await exists(gone), false);
    });
  });
});

describe("applyPatchOperations — trimEnd hunk matching", () => {
  test("matches hunk when file has trailing spaces on context/old lines", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "ws.ts");
      // File has trailing spaces on some lines.
      await writeFile(file, "keep  \nold  \ntail\n");

      // Patch references the lines without trailing spaces (model generated clean).
      const patch = [
        "*** Begin Patch",
        "*** Update File: ws.ts",
        "@@",
        " keep",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n");
      const ops = parsePatch(patch);
      await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);
      // The context line is matched loosely but left as the file has it.
      assert.equal(await readFile(file, "utf-8"), "keep  \nnew\ntail\n");
    });
  });

  test("matches context prefix with trailing whitespace difference", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "ctx.ts");
      await writeFile(file, "function foo() {  \n  return 1;\n}\n");

      // Context line doesn't have the trailing spaces the file has.
      const patch = [
        "*** Begin Patch",
        "*** Update File: ctx.ts",
        "@@ function foo() {",
        "-  return 1;",
        "+  return 2;",
        "*** End Patch",
      ].join("\n");
      const ops = parsePatch(patch);
      await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);
      assert.equal(
        await readFile(file, "utf-8"),
        "function foo() {  \n  return 2;\n}\n",
      );
    });
  });
});

describe("applyPatchOperations — whole-line hunk matching", () => {
  test("a hunk line never matches part of a longer line", async () => {
    await withTmp(async (dir) => {
      assert.equal(
        await applyTo(dir, "f.txt", "x = 10\nx = 1\n", "@@", "-x = 1", "+x = 2"),
        "x = 10\nx = 2\n",
      );
      await assert.rejects(
        () =>
          applyTo(
            dir,
            "g.ts",
            "const maxRetries = 3;\n",
            "@@",
            "-const max",
            "+const min",
          ),
        /Failed to find expected lines/,
      );
      assert.equal(
        await readFile(join(dir, "g.ts"), "utf-8"),
        "const maxRetries = 3;\n",
      );
    });
  });

  test("an anchor must be a whole line", async () => {
    await withTmp(async (dir) => {
      await assert.rejects(
        () =>
          applyTo(
            dir,
            "f.ts",
            "function foo() {\n  body();\n}\n",
            "@@ function foo()",
            "+  // comment",
          ),
        /Failed to find context 'function foo\(\)'/,
      );
    });
  });

  test("inserts added-only lines after the anchor line", async () => {
    await withTmp(async (dir) => {
      assert.equal(
        await applyTo(
          dir,
          "f.ts",
          "function foo() {\n  body();\n}\n",
          "@@ function foo() {",
          "+  // comment",
        ),
        "function foo() {\n  // comment\n  body();\n}\n",
      );
    });
  });

  test("appends added-only lines without an anchor at the end", async () => {
    await withTmp(async (dir) => {
      assert.equal(
        await applyTo(dir, "f.txt", "a\nb\n", "@@", "+c"),
        "a\nb\nc\n",
      );
    });
  });

  test("falls back to ignoring indentation, then typographic punctuation", async () => {
    await withTmp(async (dir) => {
      assert.equal(
        await applyTo(
          dir,
          "f.py",
          "def f():\n    return 1\n",
          "@@",
          "-return 1",
          "+    return 2",
        ),
        "def f():\n    return 2\n",
      );
      assert.equal(
        await applyTo(
          dir,
          "g.txt",
          "say “hi” — now\nnext\n",
          "@@",
          '-say "hi" - now',
          '+say "bye"',
        ),
        'say "bye"\nnext\n',
      );
    });
  });

  test("prefers an exact match over an earlier loose one", async () => {
    await withTmp(async (dir) => {
      assert.equal(
        await applyTo(
          dir,
          "f.txt",
          "  return value;\nreturn value;\n",
          "@@",
          "-return value;",
          "+return other;",
        ),
        "  return value;\nreturn other;\n",
      );
    });
  });

  test("a later hunk still matches after lines with trailing whitespace", async () => {
    await withTmp(async (dir) => {
      assert.equal(
        await applyTo(
          dir,
          "f.txt",
          "pad                \nmiddle\nfirst\nt1 \nt2\n",
          "@@",
          "-first",
          "+FIRST",
          "@@",
          "-t1",
          "-t2",
          "+T",
        ),
        "pad                \nmiddle\nFIRST\nT\n",
      );
    });
  });

  test("an end-of-file hunk matches the last occurrence", async () => {
    await withTmp(async (dir) => {
      assert.equal(
        await applyTo(
          dir,
          "f.txt",
          "end\nmiddle\nend\n",
          "@@",
          "-end",
          "+END",
          "*** End of File",
        ),
        "end\nmiddle\nEND\n",
      );
    });
  });

  test("a trailing empty line is given up on its own, keeping the lines before it", async () => {
    await withTmp(async (dir) => {
      // The hunk asks for two empty lines after "say"; the file has one. Only
      // the last is given up, so the one that exists is still removed.
      assert.equal(
        await applyTo(
          dir,
          "f.txt",
          "a\nsay\n\n",
          "@@ a",
          "-say",
          "+NEW",
          "",
          "-",
          "*** End of File",
        ),
        "a\nNEW\n",
      );
    });
  });

  test("a blank line before the next operation is not required in the file", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "f.txt"), "a\nz\n");
      await writeFile(join(dir, "g.txt"), "b\n");
      await applyPatchOperations(
        parsePatch(
          patchOf(
            "*** Update File: f.txt",
            "@@",
            "-a",
            "+A",
            "",
            "*** Update File: g.txt",
            "@@",
            "-b",
            "+B",
          ),
        ),
        createRealWorkspace(stubPi),
        dir,
      );
      assert.equal(await readFile(join(dir, "f.txt"), "utf-8"), "A\nz\n");
      assert.equal(await readFile(join(dir, "g.txt"), "utf-8"), "B\n");
    });
  });
});

describe("applyPatchOperations — Move to", () => {
  test("writes the updated content to the new path, keeping CRLF", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "old.txt"), "a\r\nb\r\n");
      const results = await applyPatchOperations(
        parsePatch(
          patchOf(
            "*** Update File: old.txt",
            "*** Move to: nested/new.txt",
            "@@",
            "-b",
            "+B",
          ),
        ),
        createRealWorkspace(stubPi),
        dir,
        undefined,
        { checkAccess: true },
      );
      assert.equal(await exists(join(dir, "old.txt")), false);
      assert.equal(
        await readFile(join(dir, "nested/new.txt"), "utf-8"),
        "a\r\nB\r\n",
      );
      assert.match(results[0]!.message, /moved it to nested\/new\.txt/);
    });
  });

  test("refuses to overwrite an existing destination", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "old.txt"), "a\n");
      await writeFile(join(dir, "taken.txt"), "keep me\n");
      await assert.rejects(
        () =>
          applyPatchOperations(
            parsePatch(
              patchOf(
                "*** Update File: old.txt",
                "*** Move to: taken.txt",
                "@@",
                "-a",
                "+A",
              ),
            ),
            createRealWorkspace(stubPi),
            dir,
          ),
        /destination already exists/,
      );
      assert.equal(await readFile(join(dir, "old.txt"), "utf-8"), "a\n");
      assert.equal(await readFile(join(dir, "taken.txt"), "utf-8"), "keep me\n");
    });
  });

  test("a later failure puts the file back where it was", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "old.txt"), "a\n");
      await assert.rejects(() =>
        applyPatchOperations(
          parsePatch(
            patchOf(
              "*** Update File: old.txt",
              "*** Move to: new.txt",
              "@@",
              "-a",
              "+A",
              "*** Delete File: ghost.txt",
            ),
          ),
          createRealWorkspace(stubPi),
          dir,
        ),
      );
      assert.equal(await readFile(join(dir, "old.txt"), "utf-8"), "a\n");
      assert.equal(await exists(join(dir, "new.txt")), false);
    });
  });
});

describe("applyPatchOperations — new files", () => {
  test("creates missing parent directories", async () => {
    await withTmp(async (dir) => {
      await applyPatchOperations(
        parsePatch(patchOf("*** Add File: nested/dir/new.txt", "+hello")),
        createRealWorkspace(stubPi),
        dir,
        undefined,
        { checkAccess: true },
      );
      assert.equal(
        await readFile(join(dir, "nested/dir/new.txt"), "utf-8"),
        "hello\n",
      );
    });
  });

  test("rejects a new file under a path that is a regular file", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "blocker"), "x\n");
      await assert.rejects(
        () =>
          applyPatchOperations(
            parsePatch(patchOf("*** Add File: blocker/new.txt", "+hello")),
            createRealWorkspace(stubPi),
            dir,
            undefined,
            { checkAccess: true },
          ),
        /is not a directory/,
      );
    });
  });

  test("a file added by the patch can be updated by a later operation", async () => {
    await withTmp(async (dir) => {
      await mkdir(join(dir, "sub"));
      await applyPatchOperations(
        parsePatch(
          patchOf(
            "*** Add File: sub/n.txt",
            "+hello",
            "*** Update File: sub/n.txt",
            "@@",
            "-hello",
            "+HELLO",
          ),
        ),
        createRealWorkspace(stubPi),
        dir,
        undefined,
        { checkAccess: true },
      );
      assert.equal(await readFile(join(dir, "sub/n.txt"), "utf-8"), "HELLO\n");
    });
  });
});

describe("applyPatchOperations — permissions and directories", () => {
  test("a rolled-back Delete File keeps the file executable", async () => {
    await withTmp(async (dir) => {
      const script = join(dir, "run.sh");
      await writeFile(script, "#!/bin/sh\n");
      await chmod(script, 0o755);
      await assert.rejects(() =>
        applyPatchOperations(
          parsePatch(
            patchOf("*** Delete File: run.sh", "*** Delete File: ghost.txt"),
          ),
          createRealWorkspace(stubPi),
          dir,
        ),
      );
      assert.equal(await readFile(script, "utf-8"), "#!/bin/sh\n");
      assert.equal((await stat(script)).mode & 0o777, 0o755);
    });
  });

  test("Move to keeps the file executable", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "run.sh"), "echo a\n");
      await chmod(join(dir, "run.sh"), 0o755);
      await applyPatchOperations(
        parsePatch(
          patchOf(
            "*** Update File: run.sh",
            "*** Move to: bin/run.sh",
            "@@",
            "-echo a",
            "+echo b",
          ),
        ),
        createRealWorkspace(stubPi),
        dir,
      );
      assert.equal((await stat(join(dir, "bin/run.sh"))).mode & 0o777, 0o755);
    });
  });

  test("the dry run rejects Add File onto a directory", async () => {
    await withTmp(async (dir) => {
      await mkdir(join(dir, "somedir"));
      await assert.rejects(
        () =>
          applyPatchOperations(
            parsePatch(patchOf("*** Add File: somedir", "+x")),
            createVirtualWorkspace(dir),
            dir,
          ),
        /Cannot add somedir: file already exists/,
      );
    });
  });
});

describe("applyPatchOperations — symlinks", () => {
  test("operations naming a symlink and its target see each other's changes", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "real.txt"), "one\ntwo\n");
      await symlink("real.txt", join(dir, "link.txt"));
      // The second operation relies on what the first one wrote, in the dry
      // run as on disk.
      const ops = parsePatch(
        patchOf(
          "*** Update File: link.txt",
          "@@",
          "-one",
          "+1",
          "*** Update File: real.txt",
          "@@",
          " 1",
          "-two",
          "+2",
        ),
      );
      await applyPatchOperations(ops, createVirtualWorkspace(dir), dir);
      await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);

      assert.equal(await readFile(join(dir, "real.txt"), "utf-8"), "1\n2\n");
      assert.ok((await lstat(join(dir, "link.txt"))).isSymbolicLink());
    });
  });

  test("Delete File removes the link, and a rollback brings the link back", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "real.txt"), "content\n");
      await symlink("real.txt", join(dir, "link.txt"));

      await assert.rejects(() =>
        applyPatchOperations(
          parsePatch(
            patchOf("*** Delete File: link.txt", "*** Delete File: ghost.txt"),
          ),
          createRealWorkspace(stubPi),
          dir,
        ),
      );
      assert.equal(await readlink(join(dir, "link.txt")), "real.txt");
      assert.equal(await readFile(join(dir, "real.txt"), "utf-8"), "content\n");

      await applyPatchOperations(
        parsePatch(patchOf("*** Delete File: link.txt")),
        createRealWorkspace(stubPi),
        dir,
      );
      assert.equal(await exists(join(dir, "link.txt")), false);
      assert.equal(await readFile(join(dir, "real.txt"), "utf-8"), "content\n");
    });
  });

  test("Delete File + Add File on a symlink leaves a regular file", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "real.txt"), "content\n");
      await symlink("real.txt", join(dir, "link.txt"));
      await applyPatchOperations(
        parsePatch(
          patchOf("*** Delete File: link.txt", "*** Add File: link.txt", "+new"),
        ),
        createRealWorkspace(stubPi),
        dir,
      );
      assert.equal((await lstat(join(dir, "link.txt"))).isSymbolicLink(), false);
      assert.equal(await readFile(join(dir, "link.txt"), "utf-8"), "new\n");
      assert.equal(await readFile(join(dir, "real.txt"), "utf-8"), "content\n");
    });
  });
});

describe("applyPatchOperations — Add File on existing file", () => {
  test("rejects with checkAccess when target file already exists", async () => {
    await withTmp(async (dir) => {
      const target = join(dir, "existing.txt");
      await writeFile(target, "original content\n");

      const patch = [
        "*** Begin Patch",
        "*** Add File: existing.txt",
        "+replacement content",
        "*** End Patch",
      ].join("\n");
      const ops = parsePatch(patch);

      await assert.rejects(
        () =>
          applyPatchOperations(
            ops,
            createRealWorkspace(stubPi),
            dir,
            undefined,
            { checkAccess: true },
          ),
        /already exists/,
      );

      // Original content must be untouched.
      assert.equal(await readFile(target, "utf-8"), "original content\n");
    });
  });
});

describe("applyPatchOperations — atomic rollback", () => {
  test("restores all mutated files when a later op fails", async () => {
    await withTmp(async (dir) => {
      // op1: Update file1.txt (will succeed)
      const file1 = join(dir, "file1.txt");
      await writeFile(file1, "alpha\nbeta\n");

      // op2: Delete file2.txt (will succeed)
      const file2 = join(dir, "file2.txt");
      await writeFile(file2, "to be deleted\n");

      // op3: Add new.txt (will succeed on first part but fail because we
      // deliberately make it an Update with an unanchorable hunk)
      // Actually let's make op3 an Update on file3.txt where the old block
      // cannot be found — ensuring a deterministic failure.
      const file3 = join(dir, "file3.txt");
      await writeFile(file3, "gamma\ndelta\n");

      const patch = [
        "*** Begin Patch",
        // op1: update file1 — changes "beta" to "BETA"
        "*** Update File: file1.txt",
        "@@",
        " alpha",
        "-beta",
        "+BETA",
        // op2: delete file2
        "*** Delete File: file2.txt",
        // op3: update file3 with an old block that does NOT exist → triggers failure
        "*** Update File: file3.txt",
        "@@",
        "-THIS LINE DOES NOT EXIST IN FILE3",
        "+replacement",
        "*** End Patch",
      ].join("\n");

      const ops = parsePatch(patch);

      await assert.rejects(
        () => applyPatchOperations(ops, createRealWorkspace(stubPi), dir),
        /Failed to find expected lines/,
      );

      // op1 rollback: file1 restored to original content.
      assert.equal(await readFile(file1, "utf-8"), "alpha\nbeta\n");

      // op2 rollback: deleted file2 recreated with original content.
      assert.equal(await exists(file2), true);
      assert.equal(await readFile(file2, "utf-8"), "to be deleted\n");

      // file3 was not mutated (failure happened before write).
      assert.equal(await readFile(file3, "utf-8"), "gamma\ndelta\n");
    });
  });

  test("rollback also removes any added files", async () => {
    await withTmp(async (dir) => {
      // op1: Add new-file.txt (succeeds)
      // op2: Update nonexistent anchor in existing.txt (fails)
      const existing = join(dir, "existing.txt");
      await writeFile(existing, "hello\nworld\n");

      const patch = [
        "*** Begin Patch",
        "*** Add File: new-file.txt",
        "+created content",
        "*** Update File: existing.txt",
        "@@",
        "-THIS ANCHOR CANNOT BE FOUND",
        "+replacement",
        "*** End Patch",
      ].join("\n");

      const ops = parsePatch(patch);

      await assert.rejects(
        () => applyPatchOperations(ops, createRealWorkspace(stubPi), dir),
        /Failed to find expected lines/,
      );

      // Added file must be removed by rollback.
      assert.equal(await exists(join(dir, "new-file.txt")), false);

      // Existing file must be unchanged.
      assert.equal(await readFile(existing, "utf-8"), "hello\nworld\n");
    });
  });

  test("rollback restores deleted CRLF+BOM file with original byte encoding", async () => {
    await withTmp(async (dir) => {
      // victim.txt has a UTF-8 BOM and CRLF line endings.
      const victim = join(dir, "victim.txt");
      const originalBytes = "﻿alpha\r\nbeta\r\n";
      await writeFile(victim, originalBytes, "utf-8");

      // A sibling file that the patch will touch (succeeds), so the patch
      // makes real progress before the later failure.
      const sibling = join(dir, "sibling.txt");
      await writeFile(sibling, "one\ntwo\n");

      const patch = [
        "*** Begin Patch",
        // op1: delete victim.txt (succeeds — encoding entry is populated by the
        // pre-delete read in applyPatchOperations)
        "*** Delete File: victim.txt",
        // op2: update sibling.txt (succeeds)
        "*** Update File: sibling.txt",
        "@@",
        " one",
        "-two",
        "+TWO",
        // op3: update sibling.txt again with an unanchorable hunk → triggers failure
        "*** Update File: sibling.txt",
        "@@",
        "-THIS LINE DOES NOT EXIST",
        "+replacement",
        "*** End Patch",
      ].join("\n");

      const ops = parsePatch(patch);

      await assert.rejects(
        () =>
          applyPatchOperations(
            ops,
            createRealWorkspace(stubPi),
            dir,
            undefined,
            { checkAccess: true },
          ),
        /Failed to find expected lines/,
      );

      // Rollback must have recreated victim.txt with the ORIGINAL bytes —
      // BOM present, CRLF line endings, byte-for-byte identical.
      assert.ok(await exists(victim), "victim.txt must exist after rollback");
      const restoredBytes = await readFile(victim, "utf-8");
      assert.equal(
        restoredBytes,
        originalBytes,
        "rollback must restore victim.txt with its original BOM and CRLF endings",
      );
    });
  });
});

describe("applyPatchOperations — onFileChange callback", () => {
  test("applyPatchOperations emits a FileChange per op (add/delete/update)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-edit-patch-fc-"));
    const upd = join(dir, "u.ts");
    await writeFile(upd, "old line\n", "utf-8");
    const del = join(dir, "d.ts");
    await writeFile(del, "bye\n", "utf-8");
    const add = join(dir, "a.ts");
    const patch = [
      "*** Begin Patch",
      `*** Add File: ${add}`,
      "+hello",
      `*** Update File: ${upd}`,
      "@@",
      "-old line",
      "+new line",
      `*** Delete File: ${del}`,
      "*** End Patch",
    ].join("\n");
    const ws = createRealWorkspace({ events: { emit() {} } } as any);
    const changes: any[] = [];
    await applyPatchOperations(parsePatch(patch), ws, dir, undefined, {
      collectDiff: true,
      onFileChange: (c) => changes.push(c),
    });
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
    assert.equal(byPath[add].oldContent, "");
    assert.equal(byPath[add].newContent, "hello\n");
    assert.equal(byPath[upd].oldContent, "old line\n");
    assert.equal(byPath[upd].newContent, "new line\n");
    assert.equal(byPath[del].oldContent, "bye\n");
    assert.equal(byPath[del].newContent, "");
  });
});

describe("applyPatchOperations — write-access preflight", () => {
  test("fails fast on read-only target without touching sibling file", async () => {
    // Root bypasses mode checks; skip the test in that environment.
    const isRoot = typeof getuid === "function" && getuid() === 0;
    if (isRoot) {
      // Emit a soft skip message and return without failing.
      console.log("Skipping read-only preflight test: running as root");
      return;
    }

    await withTmp(async (dir) => {
      // The read-only target.
      const locked = join(dir, "locked.txt");
      await writeFile(locked, "protected content\n");
      await chmod(locked, 0o444);

      // A sibling that the patch would modify AFTER the locked file.
      const sibling = join(dir, "sibling.txt");
      await writeFile(sibling, "original sibling\n");

      const patch = [
        "*** Begin Patch",
        "*** Update File: locked.txt",
        "@@",
        "-protected content",
        "+new content",
        "*** Update File: sibling.txt",
        "@@",
        "-original sibling",
        "+modified sibling",
        "*** End Patch",
      ].join("\n");

      const ops = parsePatch(patch);

      try {
        await assert.rejects(
          () =>
            applyPatchOperations(
              ops,
              createRealWorkspace(stubPi),
              dir,
              undefined,
              { checkAccess: true },
            ),
          // Should reject due to write-access check on locked.txt
          (err: Error) => {
            assert.ok(err instanceof Error);
            return true;
          },
        );

        // Sibling must NOT have been modified — preflight rejected before any write.
        assert.equal(await readFile(sibling, "utf-8"), "original sibling\n");
        // Locked file content must also be unchanged.
        assert.equal(await readFile(locked, "utf-8"), "protected content\n");
      } finally {
        // Restore mode so tmp-dir cleanup can delete the file.
        await chmod(locked, 0o644).catch(() => {});
      }
    });
  });
});
