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

/**
 * A single edit window inside an Update File operation.
 *
 * `oldBlock` is the exact literal substring to find in the target file;
 * `newBlock` is what it should be replaced with. Both are raw strings (not
 * arrays of lines) so the applier can work directly via `indexOf` without
 * reconstructing line arrays.
 *
 * `contextPrefix` is an optional anchor from a "@@ foo" hunk header. When set,
 * the applier must find `contextPrefix` before searching for `oldBlock`, so
 * the same oldBlock can appear multiple times in the file and be disambiguated
 * by the anchor.
 */
export interface Hunk {
  contextPrefix?: string;
  oldBlock: string;
  newBlock: string;
}

export type PatchOperation =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; hunks: Hunk[] };

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
  writeText: (absolutePath: string, content: string) => Promise<void>; // restores encoding of last read
  deleteFile: (absolutePath: string) => Promise<void>;
  exists: (absolutePath: string) => Promise<boolean>;
  checkWriteAccess: (absolutePath: string) => Promise<void>; // existing file readable+writable
  checkCreatable: (absolutePath: string) => Promise<void>; // parent dir writable (for new files)
}

/** A single file's actual before→after, surfaced by the engines for rendering. */
export interface FileChange {
  path: string; // absolute path
  oldContent: string; // LF-normalized; "" for a newly added file
  newContent: string; // LF-normalized; "" for a deleted file
  firstChangedLine?: number;
  language?: string; // set by index.ts via pix-pretty lang(); absent at engine layer
}

/** Additive collector the engines call once per changed file (real apply only). */
export type OnFileChange = (change: Omit<FileChange, "language">) => void;
