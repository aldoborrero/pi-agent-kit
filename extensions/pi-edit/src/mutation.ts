import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/** Hold Pi's locks across preflight, application and rollback of a legacy batch. */
export async function withMutationQueues<T>(
  paths: string[],
  cwd: string,
  fn: () => Promise<T>,
): Promise<T> {
  const absolutePaths = [...new Set(paths.map((path) => resolve(cwd, path)))];
  const keys = await Promise.all(
    absolutePaths.map(async (absolute) => {
      try {
        return await realpath(absolute);
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")
        )
          return absolute;
        throw error;
      }
    }),
  );
  // Canonical deduplication avoids locking a file twice through a symlink.
  // Stable ordering avoids deadlocks between batches listing paths in reverse.
  const sorted = [...new Set(keys)].sort();
  const lock = (index: number): Promise<T> =>
    index === sorted.length
      ? fn()
      : withFileMutationQueue(sorted[index]!, () => lock(index + 1));
  return lock(0);
}
