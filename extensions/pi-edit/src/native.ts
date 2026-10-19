import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import {
  createEditToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { lang } from "@xynogen/pix-pretty/lang";

import {
  boundedDiffText,
  MAX_PREVIEW_CHARS,
  previewFromPatch,
} from "./preview.ts";
import type { FileDiff } from "./types.ts";

// Derived from the native tool so it tracks Pi's tool-context type across
// versions (ExtensionContext up to 0.87, ExtensionToolContext from 0.99).
type NativeEditContext = Parameters<
  ReturnType<typeof createEditToolDefinition>["execute"]
>[4];

/** Delegate matching/locking to Pi; persist hunks, never full-file snapshots. */
export async function executeNativeEdits(
  pi: ExtensionAPI,
  toolCallId: string,
  params: { path: string; edits: { oldText: string; newText: string }[] },
  signal: AbortSignal | undefined,
  ctx: NativeEditContext,
) {
  let changedPath: string | undefined;
  const tool = createEditToolDefinition(ctx.cwd, {
    operations: {
      access: (path) => access(path, constants.R_OK | constants.W_OK),
      readFile,
      async writeFile(path, content) {
        await writeFile(path, content, "utf-8");
        changedPath = path;
        pi.events.emit("context-guard:file-modified", { path });
      },
    },
  });
  const result = await tool.execute(toolCallId, params, signal, undefined, ctx);
  const patch = result.details?.patch ?? "";
  const fileChanges: FileDiff[] = changedPath
    ? [
        {
          format: "hunks-v1",
          path: changedPath,
          language: lang(changedPath),
          firstChangedLine: result.details?.firstChangedLine,
          preview: previewFromPatch(patch),
        },
      ]
    : [];
  return {
    ...result,
    details: {
      ...result.details,
      diff: boundedDiffText(result.details?.diff ?? ""),
      // An omitted patch is not a valid patch: expose an empty string and reason,
      // not a silently truncated patch that downstream consumers might apply.
      patch: patch.length <= MAX_PREVIEW_CHARS ? patch : "",
      ...(patch.length > MAX_PREVIEW_CHARS
        ? { patchOmitted: "Patch exceeds the stored diff size limit" }
        : {}),
      fileChanges,
    },
  };
}
