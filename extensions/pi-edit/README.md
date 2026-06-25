# pi-edit — Enhanced Edit Tool

A pi extension that replaces the built-in `edit` tool with a more capable and safer engine. Supports the original single-file edit, **batch edits** across multiple files via a `multi` array, and **Codex-style patch payloads** — all three modes run through one consistent preflight-and-rollback safety pipeline.

## Overview

The standard `edit` tool handles one `oldText → newText` replacement per call. `pi-edit` extends it with three modes so an agent can make many targeted changes in a single tool call, dramatically reducing round-trips and the risk of partial edits leaving the codebase in an inconsistent state.

All modes share a **preflight pass** that applies the operation to an in-memory virtual filesystem first. If anything fails — wrong `oldText`, anchor not found, file not writable — no real files are touched.

## Modes

### 1. Classic (single edit)

Identical to the built-in `edit` tool. Provide `path`, `oldText`, and `newText`.

```jsonc
{
  "path": "src/index.ts",
  "oldText": "const foo = 1;",
  "newText": "const foo = 2;",
}
```

### 2. Multi (batch array)

Pass a `multi` array of edit objects. Each item has `path`, `oldText`, and `newText`. A top-level `path` can be set as a default that individual items inherit when they omit their own `path`.

```jsonc
{
  "path": "src/utils.ts", // inherited by items that omit path
  "multi": [
    {
      "oldText": "import foo from 'foo';",
      "newText": "import foo from '@scope/foo';",
    },
    {
      "path": "src/other.ts", // overrides the top-level path
      "oldText": "const bar = 0;",
      "newText": "const bar = 42;",
    },
  ],
}
```

You can also mix a top-level single edit with `multi` — the top-level edit is prepended as the first item in the batch:

```jsonc
{
  "path": "src/index.ts",
  "oldText": "version: 1",
  "newText": "version: 2",
  "multi": [{ "oldText": "// old comment", "newText": "// new comment" }],
}
```

Multi mode uses **partial success**: if one edit's `oldText` is not found, the remaining edits in the batch still apply. Failures are reported per-edit rather than aborting the whole batch. Atomic rollback fires only on catastrophic errors (I/O, abort signal) — not on an expected "text not found".

### 3. Patch (Codex-style)

Pass a `patch` string delimited by `*** Begin Patch` / `*** End Patch`. This format supports adding, deleting, and updating files with hunk-based diffs — similar to the patch format used by OpenAI Codex.

```
*** Begin Patch
*** Add File: src/new-file.ts
+export const greeting = "hello";
*** Delete File: src/deprecated.ts
*** Update File: src/existing.ts
@@ function oldName() {
-function oldName() {
+function newName() {
*** End Patch
```

**Supported operations inside a patch:**

| Header                    | Effect                                                              |
| ------------------------- | ------------------------------------------------------------------- |
| `*** Add File: <path>`    | Creates the file with `+`-prefixed lines as content (errors if the file already exists) |
| `*** Delete File: <path>` | Removes the file (errors if it does not exist)                      |
| `*** Update File: <path>` | Applies one or more `@@`-delimited hunks to the file                |

> **Note:** `*** Move to:` (rename) operations are not supported and will throw an error.

Patch mode is **all-or-nothing**: any operation failure triggers a full rollback of every operation already applied in the patch (recreates deleted files, removes added files, restores updated files).

#### Codex apply_patch compatibility

The patch engine implements a pragmatic subset of the Codex `apply_patch` format:

| Feature                           | Status    | Notes                                                                                     |
| --------------------------------- | --------- | ----------------------------------------------------------------------------------------- |
| `@@` hunk header                  | Required  | Every hunk inside an `*** Update File:` block must start with `@@`                        |
| Trailing-whitespace tolerance     | Supported | Hunks fall back to per-line `trimEnd` matching when exact `indexOf` misses                |
| Full trim / unicode-normalized    | Not supported | Only `trimEnd` — normalize curly quotes or dashes in the patch before sending          |
| `*** End of File` sentinel hunks  | Not supported | Use a normal hunk anchored on the last real line                                       |
| `*** Move to:` rename             | Rejected  | Emit an Add + Delete pair instead                                                         |

## Parameters

| Parameter | Type                    | Description                                                                                                  |
| --------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `path`    | `string` (optional)     | Target file path (absolute or relative to cwd). Serves as the default path for `multi` items.               |
| `oldText` | `string` (optional)     | Exact text to find and replace. Must match including all whitespace and newlines.                            |
| `newText` | `string` (optional)     | Replacement text.                                                                                            |
| `multi`   | `EditItem[]` (optional) | Array of `{ path?, oldText, newText }` objects for batch mode.                                               |
| `patch`   | `string` (optional)     | Codex-style patch payload (`*** Begin Patch … *** End Patch`). Mutually exclusive with all other parameters. |

**`EditItem` shape:**

```ts
{
  path?: string;   // inherits top-level path if omitted
  oldText: string;
  newText: string;
}
```

## Error Handling

| Situation                                                            | Behaviour                                                         |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `patch` used together with `path`/`oldText`/`newText`/`multi`        | Throws immediately — parameters are mutually exclusive            |
| Incomplete top-level edit (e.g. `path` + `oldText` but no `newText`) | Throws listing the missing fields                                 |
| `multi` item missing `path` and no top-level `path` set              | Throws identifying which item is affected                         |
| `oldText` not found in file (single mode)                            | Preflight throws; no files are modified                           |
| `oldText` not found in file (batch mode with `continueOnError`)      | Per-edit failure recorded; sibling edits still apply             |
| Patch hunk/context anchor not found                                  | Preflight throws; no files are modified                           |
| Target not writable / not creatable                                  | Throws before any mutation (all modes)                            |
| `Add File` on an existing file                                       | Throws — no silent overwrite                                      |
| `*** Move to:` operation in patch                                    | Throws — not supported                                            |

## Encoding

`pi-edit` preserves the byte encoding of every file it touches:

- **BOM** (byte-order mark) — detected on read, re-prepended on write.
- **Line endings** — CRLF (`\r\n`) and LF (`\n`) are both detected and restored. The first line ending in the file wins.
- **Matching** — all `oldText` matching and hunk anchoring operates on LF-normalized, BOM-stripped text, so you can write `oldText` with plain `\n` even when the file uses CRLF.
- **New files** — files created by `Add File` default to LF with no BOM.
- **Out of scope** — lone `\r` (classic Mac line endings) is not handled.

## Key Features

### Preflight Validation

Before writing a single byte to disk, every edit is applied to an in-memory virtual filesystem. If any replacement fails — wrong `oldText`, file not found, missing context — the operation is aborted and no real files are modified. The preflight also checks write permissions against the real filesystem so read-only targets fail fast.

### Atomic Multi-File Rollback

When an edit spans multiple files, each file's pre-edit content is snapshotted before writing. If a later file fails mid-write, every file already written is restored from its snapshot (best-effort). For patch mode, the rollback covers all three operation types: recreates deleted files, removes added files, and restores updated files.

### Positional Ordering for Same-File Edits

When multiple `multi` edits target the same file, they are automatically sorted by their position in the original file content (top-to-bottom). This ensures the forward-search cursor works correctly regardless of the order the model listed the edits.

### Tiered Fuzzy Matching for Classic Edits

Classic `oldText` lookups escalate through an ordered list of normalizer passes:

1. **Exact** — character-for-character match
2. **Curly → straight quotes** — `'` / `'` / `"` / `"` in `oldText` are rewritten to ASCII before the second search
3. **Trailing whitespace tolerance** — per-line `trimEnd` on both sides catches the most frequent class of mismatch

Patch `@@` hunks also support a `trimEnd` fallback when exact `indexOf` misses.

### Redundant Edit Detection

If the same `oldText → newText` pair appears more than once in a `multi` batch for the same file, subsequent duplicates are skipped gracefully with a success status rather than raising an error.

## Improvements over multi-edit

`pi-edit` fixes several gaps in the `multi-edit` extension it was derived from:

| Area | multi-edit | pi-edit |
| ---- | ---------- | ------- |
| Patch write-access check | Not present — partial writes possible | Eager preflight on all patch targets before any mutation |
| Patch atomic rollback | Not present — mid-patch failures leave FS in partial state | Full rollback: recreates deleted files, removes added files, restores updated files |
| `Add File` on existing file | Silently overwrites | Throws — Codex-compatible behavior |
| Encoding (BOM / CRLF) | Lost on read/write — CRLF files corrupted | Detected on read, restored on write across all modes |

## Rendering

When running inside pi's TUI, `pi-edit` renders syntax-highlighted, side-by-side split diffs for every changed file using [`@xynogen/pix-pretty`](https://github.com/xynogen/pix-pretty).

### How it works

- **`renderCall`** — shows a one-line header with the file path and edit mode (`edit`, `N edits`, or `patch`) as soon as the tool call is dispatched.
- **`renderResult`** — reads `details.fileChanges` from the tool result and renders one split-diff block per changed file, separated by `···` dividers. Rendering is async; the TUI displays a `rendering diff…` placeholder until the diff blocks are ready, then redraws via `ctx.invalidate()`.

### Accuracy guarantee

The split diffs are generated from `details.fileChanges`, which contains the **actual before→after content written to disk** — not the raw `oldText`/`newText` parameters. This means what you see in the TUI accurately reflects the real outcome, including encoding normalization and positional ordering.

### Resize handling

`renderResult` registers with `@xynogen/pix-pretty`'s resize tracker so diffs reflow to the current terminal width when the window is resized.

### Non-TUI fallback

Outside a TUI context (e.g. plain text output, CI), the tool returns a summary string in `content[0].text` and a gutter diff in `details.diff`. No split-diff rendering occurs in that path.

**Result shape:**

```jsonc
{
  "content": [{ "type": "text", "text": "Applied 2 edit(s) successfully.\n1. …\n2. …" }],
  "details": {
    "diff": "<gutter diff>",
    "firstChangedLine": 42,
    "fileChanges": [
      {
        "path": "/abs/path/to/file.ts",
        "oldContent": "…before…",
        "newContent": "…after…",
        "firstChangedLine": 42,
        "language": "typescript"
      }
    ]
  }
}
```

## Dependencies

| Package                           | Role                                                |
| --------------------------------- | --------------------------------------------------- |
| `@earendil-works/pi-coding-agent` | `ExtensionAPI` type and tool registration (peer)    |
| `@earendil-works/pi-tui`          | TUI `Text` component used by the render hooks (peer) |
| `@sinclair/typebox`               | Runtime JSON Schema / TypeBox parameter definitions (peer) |
| `@xynogen/pix-pretty`             | Syntax-highlighted split-diff rendering in the TUI  |
| `diff`                            | Line-level diff generation for result output        |
