import { constants } from "node:fs";
import {
  access as fsAccess,
  chmod as fsChmod,
  lstat as fsLstat,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  readlink as fsReadlink,
  stat as fsStat,
  symlink as fsSymlink,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { readEncoding, restore } from "./encoding.ts";
import type { FileEncoding, Workspace } from "./types.ts";

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

/**
 * A new file may sit under directories that do not exist yet (they are created
 * on write), so the check applies to the nearest ancestor that does exist.
 */
async function checkCreatable(absolutePath: string): Promise<void> {
  let dir = dirname(absolutePath);
  for (;;) {
    try {
      const stats = await fsStat(dir);
      if (!stats.isDirectory()) {
        throw new Error(`Cannot create ${absolutePath}: ${dir} is not a directory`);
      }
      return fsAccess(dir, constants.W_OK);
    } catch (error) {
      const parent = dirname(dir);
      if (!hasCode(error, "ENOENT") || parent === dir) throw error;
      dir = parent;
    }
  }
}

export function createRealWorkspace(pi: ExtensionAPI): Workspace {
  const readCache = new Map<string, string>();
  const encodings = new Map<string, FileEncoding>();
  // Permission bits of files this workspace deleted. A file written back to
  // the same path (rollback, or Delete File + Add File) is that file again and
  // must not lose its executable bit.
  const deletedModes = new Map<string, number>();
  // Where the symlinks this workspace deleted pointed to.
  const deletedLinks = new Map<string, string>();

  const writeText = async (
    absolutePath: string,
    content: string,
    like: string = absolutePath,
  ): Promise<void> => {
    // No-op skip: compare LF content against cached LF text.
    // This prevents thrashing downstream consumers (watchers, context-guard)
    // after no-op dedups.
    const existing = readCache.get(absolutePath);
    if (existing === content) return;
    readCache.delete(absolutePath);
    const encoding = encodings.get(like) ?? {
      bom: false,
      eol: "\n" as const,
    };
    encodings.set(absolutePath, encoding);
    // A moved file keeps the permissions of the file it comes from.
    const mode =
      like === absolutePath
        ? deletedModes.get(absolutePath)
        : (await fsStat(like)).mode;
    const raw = restore(content, encoding);
    try {
      await fsWriteFile(absolutePath, raw, "utf-8");
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      await fsMkdir(dirname(absolutePath), { recursive: true });
      await fsWriteFile(absolutePath, raw, "utf-8");
    }
    if (mode !== undefined) {
      await fsChmod(absolutePath, mode & 0o7777);
      deletedModes.delete(absolutePath);
    }
    // Whatever was deleted here before, a regular file now takes its place.
    deletedLinks.delete(absolutePath);
    pi.events.emit("context-guard:file-modified", { path: absolutePath });
  };

  return {
    readText: async (absolutePath: string) => {
      if (readCache.has(absolutePath)) return readCache.get(absolutePath)!;
      const raw = await fsReadFile(absolutePath, "utf-8");
      const { text, encoding } = readEncoding(raw);
      readCache.set(absolutePath, text);
      encodings.set(absolutePath, encoding);
      return text;
    },
    writeText,
    deleteFile: async (absolutePath: string) => {
      readCache.delete(absolutePath);
      const stats = await fsLstat(absolutePath);
      if (stats.isSymbolicLink()) {
        // Deleting a symlink removes the link; its target stays as it is.
        deletedLinks.set(absolutePath, await fsReadlink(absolutePath));
      } else {
        deletedModes.set(absolutePath, stats.mode);
      }
      await fsUnlink(absolutePath);
      pi.events.emit("context-guard:file-modified", { path: absolutePath });
    },
    restoreFile: async (absolutePath: string, content: string) => {
      const target = deletedLinks.get(absolutePath);
      if (target === undefined) return writeText(absolutePath, content);
      await fsSymlink(target, absolutePath);
      deletedLinks.delete(absolutePath);
      pi.events.emit("context-guard:file-modified", { path: absolutePath });
    },
    exists: async (absolutePath: string) => {
      try {
        await fsAccess(absolutePath, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    checkWriteAccess: (absolutePath: string) =>
      fsAccess(absolutePath, constants.R_OK | constants.W_OK),
    checkCreatable,
  };
}

export function createVirtualWorkspace(cwd: string): Workspace {
  // null: no such path. An Error: something is there that cannot be read as a
  // file (a directory, no permission) — it exists, but reading it fails.
  const state = new Map<string, string | null | Error>();

  async function ensureLoaded(absolutePath: string): Promise<void> {
    if (state.has(absolutePath)) return;
    try {
      const raw = await fsReadFile(absolutePath, "utf-8");
      state.set(absolutePath, readEncoding(raw).text);
    } catch (error) {
      const missing = hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR");
      state.set(
        absolutePath,
        missing || !(error instanceof Error) ? null : error,
      );
    }
  }

  return {
    readText: async (absolutePath) => {
      await ensureLoaded(absolutePath);
      const content = state.get(absolutePath);
      if (content instanceof Error) throw content;
      if (content === null || content === undefined) {
        throw new Error(
          `File not found: ${absolutePath.replace(`${cwd}/`, "")}`,
        );
      }
      return content;
    },
    writeText: async (absolutePath, content) => {
      state.set(absolutePath, content);
    },
    restoreFile: async (absolutePath, content) => {
      state.set(absolutePath, content);
    },
    deleteFile: async (absolutePath) => {
      await ensureLoaded(absolutePath);
      const content = state.get(absolutePath);
      if (content instanceof Error) throw content;
      if (content === null) {
        throw new Error(
          `File not found: ${absolutePath.replace(`${cwd}/`, "")}`,
        );
      }
      state.set(absolutePath, null);
    },
    exists: async (absolutePath) => {
      await ensureLoaded(absolutePath);
      return state.get(absolutePath) !== null;
    },
    checkWriteAccess: async (absolutePath: string) => {
      // Check real-fs write permission during the virtual preflight so
      // that read-only files fail fast *before* any real file is touched.
      await fsAccess(absolutePath, constants.W_OK);
    },
    checkCreatable,
  };
}
