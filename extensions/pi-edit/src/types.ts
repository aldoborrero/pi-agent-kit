// Shared types for pi-edit: edit items, patch operations, results, and workspace abstraction.

export interface EditItem {
  path: string;
  oldText: string;
  newText: string;
}

export interface EditResult {
  path: string;
  success: boolean;
  message: string;
  diff?: string;
  firstChangedLine?: number;
}

/** One line of an Update File hunk: " " context, "-" removed, "+" added. */
export interface HunkLine {
  kind: "context" | "remove" | "add";
  text: string;
}

/**
 * A single edit window inside an Update File operation.
 *
 * The context and removed lines, in order, must be found as whole consecutive
 * lines of the target file. Lines are kept individually (not as one block of
 * text) because matching is per line: a hunk line never matches part of a
 * longer file line.
 *
 * `contextPrefix` is an optional anchor from a "@@ foo" hunk header. When set,
 * the applier must find that line before searching for the hunk, so the same
 * lines can appear multiple times in the file and be disambiguated by the
 * anchor. `endOfFile` comes from a "*** End of File" marker and makes the
 * search start at the end of the file.
 */
export interface Hunk {
  contextPrefix?: string;
  lines: HunkLine[];
  endOfFile: boolean;
}

export type PatchOperation =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: Hunk[] };

export interface PatchOpResult {
  path: string;
  message: string;
  diff?: string;
  firstChangedLine?: number;
}

export interface FileEncoding {
  bom: boolean;
  eol: "\n" | "\r\n";
}

export interface Workspace {
  readText: (absolutePath: string) => Promise<string>; // returns LF-normalized, BOM-stripped
  // Restores the encoding of the last read of `absolutePath`. When the content
  // moves to a new path, `like` names the file whose encoding and permissions
  // it keeps. Creates missing parents.
  writeText: (
    absolutePath: string,
    content: string,
    like?: string,
  ) => Promise<void>;
  deleteFile: (absolutePath: string) => Promise<void>;
  // Undo a deleteFile: put back what was there. A deleted symlink comes back
  // as that symlink, not as a regular file holding the target's content.
  restoreFile: (absolutePath: string, content: string) => Promise<void>;
  exists: (absolutePath: string) => Promise<boolean>;
  checkWriteAccess: (absolutePath: string) => Promise<void>; // existing file readable+writable
  checkCreatable: (absolutePath: string) => Promise<void>; // nearest existing ancestor is a writable dir
}

/** Compact, bounded presentation data. Safe to persist in session JSONL. */
export interface DiffPreview {
  lines: Array<{
    type: "add" | "del" | "ctx" | "sep";
    oldNum: number | null;
    newNum: number | null;
    content: string;
  }>;
  added: number;
  removed: number;
  chars: number;
  omitted?: string;
  // Set when `lines` stops short of the whole diff; `added`/`removed` still
  // count every changed line.
  truncated?: string;
}

export interface FileDiff {
  format: "hunks-v1";
  path: string;
  firstChangedLine?: number;
  language?: string;
  preview: DiffPreview;
}

/** Internal before/after callback; raw contents never enter new tool results. */
export interface FileChange {
  path: string; // absolute path
  oldContent: string; // LF-normalized; "" for a newly added file
  newContent: string; // LF-normalized; "" for a deleted file
  firstChangedLine?: number;
  language?: string;
  preview?: DiffPreview; // computed with the gutter diff; avoids a second diff pass
}

/** Additive collector the engines call once per changed file (real apply only). */
export type OnFileChange = (change: Omit<FileChange, "language">) => void;
