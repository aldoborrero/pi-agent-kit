import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { canonicalPath, resolveEditPath } from "./paths.ts";

/** Hold Pi's locks across preflight, application and rollback of a legacy batch. */
export async function withMutationQueues<T>(
  paths: string[],
  cwd: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Resolved exactly as the engines resolve them, so the lock is taken on the
  // file that is actually written.
  const absolutePaths = [
    ...new Set(paths.map((path) => resolveEditPath(cwd, path))),
  ];
  const keys = await Promise.all(absolutePaths.map(canonicalPath));
  // Canonical deduplication avoids locking a file twice through a symlink.
  // Stable ordering avoids deadlocks between batches listing paths in reverse.
  const sorted = [...new Set(keys)].sort();
  const lock = (index: number): Promise<T> =>
    index === sorted.length
      ? fn()
      : withFileMutationQueue(sorted[index]!, () => lock(index + 1));
  return lock(0);
}
