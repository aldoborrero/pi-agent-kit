# pi-edit — Enhanced Edit Tool

A Pi extension that extends the built-in `edit` tool with **cross-file batches**, **Codex-style patches**, and split-diff rendering. Requires Pi **0.87.1+**. Supports the current `path + edits[]` API as well as the legacy `path/oldText/newText` and `multi` formats.

## Overview

Pi already supports multiple disjoint replacements in one file via `edits[]`. This mode delegates to `createEditToolDefinition()` from the installed Pi runtime rather than reimplementing its matching and safety checks.

Legacy and patch modes retain a **virtual preflight pass**. All modes use Pi’s shared file-mutation queue; legacy batches hold locks across preflight, application, and rollback. Locks coordinate with Pi tools, not arbitrary external filesystem writers.

## Modes

### 1. Native (recommended)

```json
{
  "path": "src/index.ts",
  "edits": [
    { "oldText": "const foo = 1;", "newText": "const foo = 2;" },
    { "oldText": "const bar = 3;", "newText": "const bar = 4;" }
  ]
}
```

Every replacement targets the **original file**, not the result of previous replacements. Each `oldText` must be unique and edits must not overlap. Missing, ambiguous, overlapping, empty, and net no-op replacements fail before writing. Pi handles combined Unicode/whitespace fuzzy matching, preserves unchanged lines, and restores BOM/line endings. Native results include Pi's unified `details.patch` plus compact `details.fileChanges` for split-diff rendering. Oversized patches are replaced by an empty string with an explicit `patchOmitted` reason, never by an invalid truncated patch.

The argument preparation hook also accepts `edits` encoded as a JSON string or a single replacement object. `edits` cannot be mixed with legacy replacement fields, `multi`, or `patch`.

### 2. Classic (legacy single edit)

Provide `path`, `oldText`, and `newText`. This retains pi-edit's legacy engine semantics; use `edits[]` for current Pi behavior.

```jsonc
{
  "path": "src/index.ts",
  "oldText": "const foo = 1;",
  "newText": "const foo = 2;",
}
```

### 3. Multi (legacy batch array)

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

Multi mode first validates the entire batch: if any edit fails preflight, no files are changed. During the real apply pass, unexpected matching failures can be reported per edit; I/O and abort failures trigger best-effort rollback. Unlike native `edits[]`, legacy `multi` retains positional duplicate matching and redundant-edit skipping.

### 4. Patch (Codex-style)

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
| `edits`   | `{ oldText, newText }[]` (optional) | Native single-file replacements against the original content; requires `path`. |
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
| `patch` used together with `path`/`oldText`/`newText`/`edits`/`multi`        | Throws immediately — parameters are mutually exclusive            |
| Incomplete top-level edit (e.g. `path` + `oldText` but no `newText`) | Throws listing the missing fields                                 |
| `multi` item missing `path` and no top-level `path` set              | Throws identifying which item is affected                         |
| `oldText` not found in file (single mode)                            | Preflight throws; no files are modified                           |
| `oldText` not found in file (batch mode with `continueOnError`)      | Per-edit failure recorded; sibling edits still apply             |
| Patch hunk/context anchor not found                                  | Preflight throws; no files are modified                           |
| Target not writable / not creatable                                  | Throws before any mutation (all modes)                            |
| `Add File` on an existing file                                       | Throws — no silent overwrite                                      |
| `*** Move to:` operation in patch                                    | Throws — not supported                                            |

## Encoding

Native `edits[]` uses Pi’s encoding handling (including lone `\r` normalization). The following describes the legacy and patch engines.

`pi-edit` preserves the byte encoding of every file it touches:

- **BOM** (byte-order mark) — detected on read, re-prepended on write.
- **Line endings** — CRLF (`\r\n`) and LF (`\n`) are both detected and restored. The first line ending in the file wins.
- **Matching** — all `oldText` matching and hunk anchoring operates on LF-normalized, BOM-stripped text, so you can write `oldText` with plain `\n` even when the file uses CRLF.
- **New files** — files created by `Add File` default to LF with no BOM.
- **Out of scope** — lone `\r` (classic Mac line endings) is not handled.

## Key Features

### Preflight Validation

For legacy and patch modes, before writing to disk, every edit is applied to an in-memory virtual filesystem. If any replacement fails — wrong `oldText`, file not found, missing context — the operation is aborted and no real files are modified. The preflight also checks write permissions against the real filesystem so read-only targets fail fast. Classic mode keeps an operation-local prepared plan. The real pass rereads the file, rechecks permissions, and reuses matching only if the current contents and edit inputs still agree; otherwise it rematches. Preflight, revalidation and rollback stay inside the shared mutation locks.

### Atomic Multi-File Rollback

When an edit spans multiple files, each file's pre-edit content is snapshotted before writing. If a later file fails mid-write, every file already written is restored from its snapshot (best-effort). For patch mode, the rollback covers all three operation types: recreates deleted files, removes added files, and restores updated files.

### Positional Ordering for Same-File Edits

When multiple `multi` edits target the same file, they are automatically sorted by their position in the original file content (top-to-bottom). This ensures the forward-search cursor works correctly regardless of the order the model listed the edits.

### Tiered Fuzzy Matching for Classic Edits

Classic `oldText` lookups escalate through an ordered list of normalizer passes:

1. **Exact** — character-for-character match
2. **Curly → straight quotes** — `'` / `'` / `"` / `"` in `oldText` are rewritten to ASCII before the second search
3. **Trailing whitespace tolerance** — per-line `trimEnd` on both sides catches the most frequent class of mismatch
4. **Unicode NFKC**, dash and special-space normalization

Normalization requirements are classified once per file/pass. Uniqueness counting stops as soon as ambiguity is established, including fuzzy variants before exact hits. Empty fuzzy patterns are skipped, while exact whitespace edits remain valid; match offsets must advance.

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

## Rendering and performance bounds

`pi-edit` uses [`@xynogen/pix-pretty`](https://github.com/xynogen/pix-pretty) for split diffs, with `renderShell: "self"` and real Pi components.

- **Compact results:** new `details.fileChanges` entries contain versioned hunks/line numbers, not `oldContent`/`newContent` snapshots. Native mode reuses Pi's already computed patch; legacy engines compute gutter output and preview together. The data survives JSONL persistence, headless execution, and later TUI replay without reading today's file to reconstruct an old diff.
- **Historical compatibility:** old snapshot-based results still render using bounded diff computation and weakly held memoization.
- **Cache:** content references/revisions identify updates (including same-length changes). Theme, width and expansion affect presentation, not structural diff computation. Cache hits never JSON-stringify or hash full files. Published compact previews are immutable; producers must replace the preview object to signal an update.
- **Resize lifecycle:** invalidation belongs to the component and Pi's normal redraw lifecycle. There is no global callback registry or permanent stdout resize listener retaining closed sessions.
- **Long lines:** word-diff work in pix-pretty is estimated conservatively. Above the render-wide work budget, a linear, line-numbered plain diff replaces expensive word highlighting.

### Limits and fallbacks

| Work | Default bound |
|---|---|
| Local line-diff search | 15 ms soft timeout and 512 edit distance |
| Raw before + after input | 8 Mi UTF-16 code units |
| Stored preview content / native patch / text diff | 64 Ki code units each (metadata adds overhead) |
| Preview rows / individual line length | 2,000 rows / 2,000 code units |
| Collapsed rendering | pix-pretty's `MAX_RENDER_LINES`, shared across the visible files |
| Expanded rendering | 2,000 logical diff rows total |
| Files rendered | At most 20 collapsed / 100 expanded |

The timeout is a **soft search budget**, not a hard real-time guarantee: tokenization, parsing and bounded rendering still take time. Historical multi-file conversion also has a per-render budget. Limits produce explicit omission/plain-diff notices and never undo a successful file edit. Expanding increases the visible budget, but does not bypass safety bounds. Pi's native matching and initial diff generation still run upstream; this extension does not impose a timeout on that implementation.

Outside TUI, `content[0].text` remains the execution summary and `details.diff` the bounded gutter diff. Compact previews are retained in headless mode so the session remains viewable later.

**New result shape:**

```jsonc
{
  "content": [{ "type": "text", "text": "Edited src/file.ts." }],
  "details": {
    "diff": "-42 const value = 1;\n+42 const value = 2;",
    "firstChangedLine": 42,
    "fileChanges": [{
      "format": "hunks-v1",
      "path": "/abs/src/file.ts",
      "language": "typescript",
      "firstChangedLine": 42,
      "preview": {
        "lines": [
          { "type": "del", "oldNum": 42, "newNum": null, "content": "const value = 1;" },
          { "type": "add", "oldNum": null, "newNum": 42, "content": "const value = 2;" }
        ],
        "added": 1,
        "removed": 1,
        "chars": 1000
      }
    }]
  }
}
```

An omitted preview has `lines: []` and an explicit `omitted` reason; its zero counts mean unavailable statistics, not zero changes. Consumers of the previous raw-snapshot format should migrate to `format: "hunks-v1"`.

### Benchmarks

```sh
bun run --cwd extensions/pi-edit bench
```

The harness uses temporary files, a warm filesystem, one warm-up and five execution samples; cached rendering uses 15 samples. It compares the Pi builtin, native wrapper and legacy batch engine, reports serialized result size, and measures both historical and compact rendering. It does not include LLM/network time, actual terminal painting, session writes or external file-modification observers. Run on the deployment runtime before using the numbers as a latency target.

## Dependencies

| Package                           | Role                                                |
| --------------------------------- | --------------------------------------------------- |
| `@earendil-works/pi-coding-agent` | `ExtensionAPI` type and tool registration (peer)    |
| `@earendil-works/pi-tui`          | TUI `Text` component used by the render hooks (peer) |
| `typebox`               | Runtime JSON Schema / TypeBox parameter definitions (peer) |
| `@xynogen/pix-pretty`             | Syntax-highlighted split-diff rendering in the TUI  |
| `diff`                            | Line-level diff generation for result output        |


## Development reference

Updated against `.scratch/pi-mono` at `2b0a123de` (Pi 0.87.1), verified against `origin/main` and npm's `latest` tag. The extension uses public Pi exports at runtime; it does not import from `.scratch`.

```sh
bun test extensions/pi-edit
```
