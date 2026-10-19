import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// The typographic spaces Pi's own tools fold when they read a path.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Resolve a path as the model wrote it, the way Pi's built-in tools do, so one
 * spelling reaches the same file in every edit mode: typographic spaces become
 * plain ones, "~" expands to the home directory, and the "@" that prompts put
 * in front of a mentioned file is dropped.
 *
 * Unlike the built-in tools, the "@" is kept when it is part of a real name
 * (`@types/index.d.ts`): it only goes when that makes an existing file out of
 * a missing one.
 */
export function resolveEditPath(cwd: string, path: string): string {
  const spaced = path.replace(UNICODE_SPACES, " ");
  const literal = resolveFrom(cwd, spaced);
  if (!spaced.startsWith("@") || existsSync(literal)) return literal;
  const mentioned = resolveFrom(cwd, spaced.slice(1));
  return existsSync(mentioned) ? mentioned : literal;
}

/**
 * Where a file really lives, symlinks followed. A symlink and its target are
 * one file: whatever keys work by path has to key it by this one. A path that
 * does not exist yet is returned as it is.
 */
export async function canonicalPath(absolutePath: string): Promise<string> {
  try {
    return await realpath(absolutePath);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return absolutePath;
    throw error;
  }
}

function resolveFrom(cwd: string, path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}
