import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import {
  createEditToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { lang } from "@xynogen/pix-pretty/lang";

import { readEncoding } from "./encoding.ts";
import type { FileChange } from "./types.ts";

/** Delegate edits[] to Pi so matching, overlap checks and mutation locking stay upstream. */
export async function executeNativeEdits(
  pi: ExtensionAPI,
  toolCallId: string,
  params: { path: string; edits: { oldText: string; newText: string }[] },
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) {
  const fileChanges: FileChange[] = [];
  let oldContent = "";
  const normalized = (raw: string) =>
    readEncoding(raw).text.replace(/\r/g, "\n");
  const tool = createEditToolDefinition(ctx.cwd, {
    operations: {
      access: (path) => access(path, constants.R_OK | constants.W_OK),
      // Capture the before/after inside the native mutation queue, not in
      // separate reads that could race with another edit or write tool.
      async readFile(path) {
        const buffer = await readFile(path);
        oldContent = normalized(buffer.toString("utf-8"));
        return buffer;
      },
      async writeFile(path, content) {
        await writeFile(path, content, "utf-8");
        fileChanges.push({
          path,
          oldContent,
          newContent: normalized(content),
          language: lang(path),
        });
        pi.events.emit("context-guard:file-modified", { path });
      },
    },
  });
  const result = await tool.execute(toolCallId, params, signal, undefined, ctx);
  for (const change of fileChanges) {
    change.firstChangedLine = result.details?.firstChangedLine;
  }
  return { ...result, details: { ...result.details, fileChanges } };
}
