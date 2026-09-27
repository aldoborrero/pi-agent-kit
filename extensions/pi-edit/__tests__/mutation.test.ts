import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { withMutationQueues } from "../src/mutation.ts";

async function withTmp(fn: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-edit-locks-"));
  try {
    await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("batch locks deduplicate symlink aliases", { timeout: 3000 }, async () => {
  await withTmp(async (cwd) => {
    await writeFile(join(cwd, "a"), "a");
    await symlink(join(cwd, "a"), join(cwd, "alias"));
    assert.equal(
      await withMutationQueues(["a", "alias", "./a"], cwd, async () => "done"),
      "done",
    );
  });
});

test(
  "oppositely ordered batches do not deadlock and release locks on failure",
  { timeout: 3000 },
  async () => {
    await withTmp(async (cwd) => {
      await writeFile(join(cwd, "a"), "a");
      await writeFile(join(cwd, "b"), "b");
      const results = await Promise.allSettled([
        withMutationQueues(["a", "b"], cwd, async () => {
          throw new Error("failed");
        }),
        withMutationQueues(["b", "a"], cwd, async () => "done"),
      ]);
      assert.equal(results[0]!.status, "rejected");
      assert.deepEqual(results[1], { status: "fulfilled", value: "done" });
      assert.equal(
        await withFileMutationQueue(join(cwd, "a"), async () => "released"),
        "released",
      );
    });
  },
);
