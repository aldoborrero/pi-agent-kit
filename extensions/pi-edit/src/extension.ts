/**
 * Pi-Edit Extension — replaces the built-in `edit` tool.
 *
 * Supports all original parameters (path, oldText, newText) plus:
 * - `multi`: array of {path, oldText, newText} edits applied in sequence
 * - `patch`: Codex-style apply_patch payload
 *
 * When both top-level params and `multi` are provided, the top-level edit
 * is treated as an implicit first item prepended to the multi list.
 *
 * A preflight pass is performed before mutating files:
 * - multi/top-level mode: preflight via virtualised workspace
 * - patch mode: preflight by applying patch operations on a virtual filesystem
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { lang } from "@xynogen/pix-pretty/lang";

import { applyClassicEdits } from "./classic.ts";
import { once } from "./once.ts";
import { applyPatchOperations, parsePatch } from "./patch.ts";
import { renderCall, renderResult } from "./render.ts";
import type { EditItem, FileChange, PatchOperation } from "./types.ts";
import { createRealWorkspace, createVirtualWorkspace } from "./workspace.ts";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const editItemSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        "Path to the file to edit (relative or absolute). Inherits from top-level path if omitted.",
    }),
  ),
  oldText: Type.String({
    description: "Exact text to find and replace (must match exactly)",
  }),
  newText: Type.String({
    description: "New text to replace the old text with",
  }),
});

const schema = Type.Object({
  path: Type.Optional(
    Type.String({
      description: "Path to the file to edit (relative or absolute)",
    }),
  ),
  oldText: Type.Optional(
    Type.String({
      description: "Exact text to find and replace (must match exactly)",
    }),
  ),
  newText: Type.Optional(
    Type.String({ description: "New text to replace the old text with" }),
  ),
  multi: Type.Optional(
    Type.Array(editItemSchema, {
      description:
        "Multiple edits to apply in sequence. Each item has path, oldText, and newText.",
    }),
  ),
  patch: Type.Optional(
    Type.String({
      description:
        "Codex-style apply_patch payload (*** Begin Patch ... *** End Patch). Mutually exclusive with path/oldText/newText/multi.",
    }),
  ),
});

type Params = Static<typeof schema>;

// ---------------------------------------------------------------------------
// Pure planner
// ---------------------------------------------------------------------------

export type Plan =
  | { mode: "classic"; edits: EditItem[] }
  | { mode: "patch"; ops: PatchOperation[] };

/**
 * Pure validation + edit-list construction. No filesystem access, no side
 * effects. Throws with a descriptive message on any invalid combination.
 */
export function planEdits(params: Params): Plan {
  const { path, oldText, newText, multi, patch } = params;

  // patch is mutually exclusive with all classic params.
  const hasAnyClassicParam =
    path !== undefined ||
    oldText !== undefined ||
    newText !== undefined ||
    multi !== undefined;

  if (patch !== undefined && hasAnyClassicParam) {
    throw new Error(
      "The `patch` parameter is mutually exclusive with path/oldText/newText/multi.",
    );
  }

  if (patch !== undefined) {
    const ops = parsePatch(patch);
    return { mode: "patch", ops };
  }

  // Build classic edit list.
  const edits: EditItem[] = [];
  const hasTopLevel =
    path !== undefined && oldText !== undefined && newText !== undefined;

  if (hasTopLevel) {
    edits.push({ path: path!, oldText: oldText!, newText: newText! });
  } else if (
    path !== undefined ||
    oldText !== undefined ||
    newText !== undefined
  ) {
    // When multi is present, only a bare top-level `path` (for inheritance) is
    // allowed. Any other partial combination is an error.
    const hasOnlyPath =
      path !== undefined && oldText === undefined && newText === undefined;
    if (!hasOnlyPath || multi === undefined) {
      const missing: string[] = [];
      if (path === undefined) missing.push("path");
      if (oldText === undefined) missing.push("oldText");
      if (newText === undefined) missing.push("newText");
      throw new Error(
        `Incomplete top-level edit: missing ${missing.join(", ")}. Provide all three (path, oldText, newText) or use only the multi parameter.`,
      );
    }
    // path-only top-level with multi is fine — path is inherited below.
  }

  if (multi) {
    for (const item of multi) {
      edits.push({
        path: item.path ?? path ?? "",
        oldText: item.oldText,
        newText: item.newText,
      });
    }
  }

  if (edits.length === 0) {
    throw new Error(
      "No edits provided. Supply path/oldText/newText, a multi array, or a patch.",
    );
  }

  // Validate that every edit has a path.
  for (let i = 0; i < edits.length; i++) {
    if (!edits[i]!.path) {
      throw new Error(
        `Edit ${i + 1} is missing a path. Provide a path on each multi item or set a top-level path to inherit.`,
      );
    }
  }

  return { mode: "classic", edits };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  once(pi, "pi-edit", () => {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      "Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits. Supports a `multi` parameter for batch edits across one or more files, and a `patch` parameter for Codex-style patches.",
    promptSnippet:
      "Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
    promptGuidelines: [
      "Use edit for precise changes (old text must match exactly)",
      "Use the `multi` parameter to apply multiple edits in a single tool call",
      "Use the `patch` parameter for Codex-style multi-file / hunk-based edits",
    ],
    parameters: schema,
    // biome-ignore lint/suspicious/noExplicitAny: bridge render.ts's local hook interfaces to the ToolDefinition render-hook types
    renderCall: renderCall as any,
    // biome-ignore lint/suspicious/noExplicitAny: bridge render.ts's local hook interfaces to the ToolDefinition render-hook types
    renderResult: renderResult as any,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const plan = planEdits(params);

      if (plan.mode === "patch") {
        // Preflight on virtual filesystem before mutating real files.
        await applyPatchOperations(
          plan.ops,
          createVirtualWorkspace(ctx.cwd),
          ctx.cwd,
          signal,
          { collectDiff: false },
        );

        // Collector for the real apply only.
        const fileChanges: FileChange[] = [];
        const onFileChange = (c: Omit<FileChange, "language">) =>
          fileChanges.push({ ...c, language: lang(c.path) });

        // Apply for real.
        const applied = await applyPatchOperations(
          plan.ops,
          createRealWorkspace(pi),
          ctx.cwd,
          signal,
          { collectDiff: true, checkAccess: true, onFileChange },
        );

        const summary = applied
          .map((r, i) => `${i + 1}. ${r.message}`)
          .join("\n");
        const combinedDiff = applied
          .filter((r) => r.diff)
          .map((r) => `File: ${r.path}\n${r.diff}`)
          .join("\n\n");
        const firstChangedLine = applied.find(
          (r) => r.firstChangedLine !== undefined,
        )?.firstChangedLine;

        return {
          content: [
            {
              type: "text" as const,
              text: `Applied patch with ${applied.length} operation(s).\n${summary}`,
            },
          ],
          details: {
            diff: combinedDiff,
            firstChangedLine,
            fileChanges,
          },
        };
      }

      // Classic mode.

      // Preflight pass on virtual workspace before mutating real files.
      // Uses sequential occurrence matching so same-file edits are resolved
      // in file order (positional ordering).
      try {
        await applyClassicEdits(
          plan.edits,
          createVirtualWorkspace(ctx.cwd),
          ctx.cwd,
          signal,
          { collectDiff: false },
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Preflight failed before mutating files.\n${msg}`);
      }

      // Collector for the real apply only.
      const fileChanges: FileChange[] = [];
      const onFileChange = (c: Omit<FileChange, "language">) =>
        fileChanges.push({ ...c, language: lang(c.path) });

      // Apply for real. `continueOnError` lets successful edits land even
      // when a sibling fails; `rollbackOnError` restores files if an
      // unexpected error (I/O, abort) breaks the batch mid-write.
      const isBatch = plan.edits.length > 1;
      const results = await applyClassicEdits(
        plan.edits,
        createRealWorkspace(pi),
        ctx.cwd,
        signal,
        {
          collectDiff: true,
          rollbackOnError: true,
          continueOnError: isBatch,
          onFileChange,
        },
      );

      const succeeded = results.filter((r) => r?.success);
      const failed = results.filter((r) => r && !r.success);

      if (results.length === 1) {
        const r = results[0]!;
        return {
          content: [{ type: "text" as const, text: r.message }],
          details: {
            diff: r.diff ?? "",
            firstChangedLine: r.firstChangedLine,
            fileChanges,
          },
        };
      }

      const combinedDiff = results
        .filter((r) => r?.diff)
        .map((r) => r!.diff)
        .join("\n");

      const firstChanged = results.find(
        (r) => r?.firstChangedLine !== undefined,
      )?.firstChangedLine;

      const summary = results
        .map((r, i) => `${i + 1}. ${r!.message}`)
        .join("\n");

      const statusLine =
        failed.length > 0
          ? `Applied ${succeeded.length}/${results.length} edit(s). ${failed.length} failed:\n${summary}`
          : `Applied ${results.length} edit(s) successfully.\n${summary}`;

      return {
        content: [{ type: "text" as const, text: statusLine }],
        details: {
          diff: combinedDiff,
          firstChangedLine: firstChanged,
          fileChanges,
        },
      };
    },
  });
  });
}
