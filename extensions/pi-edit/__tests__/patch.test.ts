/**
 * parsePatch + applyPatchOperations — contract tests.
 *
 * Covers the Codex-style patch parsing and application surface in pi-edit:
 * structural validation, Add/Delete/Update round-trips, multi-op batches,
 * trimEnd hunk matching, rollback on failure, and write-access preflight.
 */

import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getuid } from "node:process";
import { describe, test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyPatchOperations, parsePatch } from "../src/patch.ts";
import { createRealWorkspace } from "../src/workspace.ts";

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
      assert.equal(op0.hunks.length, 1);
      const hunk0 = op0.hunks[0]!;
      assert.equal(hunk0.oldBlock, "unchanged\nold line");
      assert.equal(hunk0.newBlock, "unchanged\nnew line");
    }
  });

  test("rejects move operations", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src.txt",
      "*** Move to: dst.txt",
      "*** End Patch",
    ].join("\n");
    assert.throws(() => parsePatch(patch), /Move to.*not supported/);
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
      // The matched block (including context line "keep  ") is replaced by
      // newBlock ("keep\nnew") — trailing spaces on the context line are
      // cleaned as a side effect of the replacement.
      assert.equal(await readFile(file, "utf-8"), "keep\nnew\ntail\n");
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
