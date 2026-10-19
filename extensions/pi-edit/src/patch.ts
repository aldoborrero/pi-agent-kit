/**
 * Codex-style apply_patch engine.
 *
 * Accepts payloads bracketed by `*** Begin Patch` / `*** End Patch` and
 * supports Add File, Delete File and Update File (optionally with
 * `*** Move to:`).
 *
 * The parser and the hunk matcher follow Codex's own `apply-patch` crate
 * (parser state machine, `seek_sequence`, `compute_replacements`): hunks are
 * matched as whole lines, with decreasing strictness.
 *
 * Deliberate differences from Codex:
 * - A patch is all-or-nothing: Codex keeps the operations applied before a
 *   failure, this engine rolls them back.
 * - `Add File` and `Move to` refuse to overwrite an existing file.
 * - Context lines keep the file's own text, and line endings/BOM are restored
 *   by the Workspace, instead of being rewritten from the patch.
 * - A hunk with only added lines and a `@@ anchor` is inserted after the
 *   anchor line; Codex appends it at the end of the file.
 */

import { generateDiffString } from "./diff.ts";
import { canonicalPath, resolveEditPath } from "./paths.ts";
import type {
  Hunk,
  HunkLine,
  OnFileChange,
  PatchOpResult,
  PatchOperation,
  Workspace,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const DIRECTIVE_BEGIN = "*** Begin Patch";
const DIRECTIVE_END = "*** End Patch";
const DIRECTIVE_ADD = "*** Add File: ";
const DIRECTIVE_DELETE = "*** Delete File: ";
const DIRECTIVE_UPDATE = "*** Update File: ";
const DIRECTIVE_MOVE = "*** Move to: ";
const DIRECTIVE_EOF = "*** End of File";
const HUNK_HEADER = "@@";
const HUNK_HEADER_WITH_CONTEXT = "@@ ";

const VALID_HEADERS = `'${DIRECTIVE_ADD.trim()}', '${DIRECTIVE_DELETE.trim()}', '${DIRECTIVE_UPDATE.trim()}'`;
const HEREDOC_OPENERS = ["<<EOF", "<<'EOF'", '<<"EOF"'];

/**
 * Split the payload into lines and check its Begin/End markers. Models
 * sometimes send the patch wrapped in the heredoc they would pass to a shell
 * (`<<'EOF' … EOF`); that wrapper is stripped.
 */
function patchLines(patchText: string): string[] {
  const normalized = patchText.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    throw new Error("Patch is empty or invalid");
  }

  let lines = normalized.split("\n");
  if (
    lines.length >= 4 &&
    lines[0]!.trim() !== DIRECTIVE_BEGIN &&
    HEREDOC_OPENERS.includes(lines[0]!) &&
    lines[lines.length - 1]!.endsWith("EOF")
  ) {
    lines = lines.slice(1, -1);
  }

  if (lines[0]!.trim() !== DIRECTIVE_BEGIN) {
    throw new Error(`The first line of the patch must be '${DIRECTIVE_BEGIN}'`);
  }
  if (lines[lines.length - 1]!.trim() !== DIRECTIVE_END) {
    throw new Error(`The last line of the patch must be '${DIRECTIVE_END}'`);
  }
  return lines;
}

const hunkIsEmpty = (hunk: Hunk | undefined): boolean =>
  hunk !== undefined && hunk.lines.length === 0;

function invalidHunk(lineNumber: number, message: string): never {
  throw new Error(`Invalid patch hunk on line ${lineNumber}: ${message}`);
}

const invalidHeader = (text: string): string =>
  `'${text}' is not a valid hunk header. Valid headers: ${VALID_HEADERS}`;
const unexpectedUpdateLine = (line: string): string =>
  `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`;
const expectedHunkHeader = (line: string): string =>
  `Expected update hunk to start with a @@ context marker, got: '${line}'`;

function hunkLineKind(line: string): HunkLine["kind"] | undefined {
  // A bare empty line is an unchanged empty line of the file.
  if (line === "" || line[0] === " ") return "context";
  if (line[0] === "+") return "add";
  if (line[0] === "-") return "remove";
  return undefined;
}

/** The operation a header line opens, or "end" for `*** End Patch`. */
function parseHeader(text: string): PatchOperation | "end" | undefined {
  if (text === DIRECTIVE_END) return "end";
  if (text.startsWith(DIRECTIVE_ADD)) {
    return {
      kind: "add",
      path: text.slice(DIRECTIVE_ADD.length).trim(),
      contents: "",
    };
  }
  if (text.startsWith(DIRECTIVE_DELETE)) {
    return { kind: "delete", path: text.slice(DIRECTIVE_DELETE.length).trim() };
  }
  if (text.startsWith(DIRECTIVE_UPDATE)) {
    return {
      kind: "update",
      path: text.slice(DIRECTIVE_UPDATE.length).trim(),
      hunks: [],
    };
  }
  return undefined;
}

export function parsePatch(patchText: string): PatchOperation[] {
  const lines = patchLines(patchText);
  const operations: PatchOperation[] = [];
  let ended = false;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNumber = i + 1;
    // The operation the current line belongs to; none right after Begin Patch.
    const current = operations[operations.length - 1];

    if (ended) {
      if (line.trim() === "") continue;
      throw new Error(`The last line of the patch must be '${DIRECTIVE_END}'`);
    }

    // Inside Update File a header must start at column 0: an indented
    // "*** Update File:" there is a context line of the file being patched.
    // The final line is always the (possibly indented) End Patch marker.
    const text =
      current?.kind === "update" && i < lines.length - 1
        ? line.trimEnd()
        : line.trim();

    const header = parseHeader(text);
    if (header) {
      // An Update File block must be complete before the next operation.
      if (current?.kind === "update") {
        if (current.hunks.length === 0) {
          invalidHunk(
            lineNumber,
            `Update file hunk for path '${current.path}' is empty`,
          );
        }
        if (hunkIsEmpty(current.hunks[current.hunks.length - 1])) {
          invalidHunk(
            lineNumber,
            header === "end"
              ? "Update hunk does not contain any lines"
              : unexpectedUpdateLine(text),
          );
        }
      }
      if (header === "end") ended = true;
      else operations.push(header);
      continue;
    }

    if (!current || current.kind === "delete") {
      // Blank lines between operations carry no meaning.
      if (text === "") continue;
      invalidHunk(lineNumber, invalidHeader(text));
    }

    if (current.kind === "add") {
      if (!line.startsWith("+")) {
        invalidHunk(
          lineNumber,
          `Invalid add-file line '${line}'. Add-file lines must start with '+'`,
        );
      }
      current.contents += `${line.slice(1)}\n`;
      continue;
    }

    const lastHunk = current.hunks[current.hunks.length - 1];
    const startsHunk =
      text === HUNK_HEADER || text.startsWith(HUNK_HEADER_WITH_CONTEXT);

    // Nothing but a new hunk may follow "*** End of File".
    if (lastHunk?.endOfFile) {
      if (text === "") continue;
      if (!startsHunk) invalidHunk(lineNumber, expectedHunkHeader(line));
    }

    if (
      current.hunks.length === 0 &&
      current.moveTo === undefined &&
      text.startsWith(DIRECTIVE_MOVE)
    ) {
      current.moveTo = text.slice(DIRECTIVE_MOVE.length).trim();
      continue;
    }

    if (startsHunk) {
      if (hunkIsEmpty(lastHunk)) {
        invalidHunk(lineNumber, unexpectedUpdateLine(line));
      }
      current.hunks.push({
        contextPrefix:
          text === HUNK_HEADER
            ? undefined
            : text.slice(HUNK_HEADER_WITH_CONTEXT.length),
        lines: [],
        endOfFile: false,
      });
      continue;
    }

    if (text === DIRECTIVE_EOF) {
      if (!lastHunk || hunkIsEmpty(lastHunk)) {
        invalidHunk(lineNumber, "Update hunk does not contain any lines");
      }
      lastHunk.endOfFile = true;
      continue;
    }

    const kind = hunkLineKind(line);
    if (kind === undefined) {
      invalidHunk(
        lineNumber,
        lastHunk && !hunkIsEmpty(lastHunk)
          ? expectedHunkHeader(line)
          : unexpectedUpdateLine(line),
      );
    }

    if (lastHunk) {
      lastHunk.lines.push({ kind, text: line.slice(1) });
    } else {
      // The first hunk of a file may omit its "@@" header.
      current.hunks.push({
        lines: [{ kind, text: line.slice(1) }],
        endOfFile: false,
      });
    }
  }

  if (!ended) {
    throw new Error(`The last line of the patch must be '${DIRECTIVE_END}'`);
  }

  return operations;
}

// ---------------------------------------------------------------------------
// Applier
// ---------------------------------------------------------------------------

/** Typographic punctuation and odd spaces → their ASCII equivalents. */
const normalizePunctuation = (line: string): string =>
  line
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018-\u201B]/g, "'")
    .replace(/[\u201C-\u201F]/g, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");

/** Passes `seekSequence` tries, strictest first. */
const LINE_MATCHERS: readonly ((line: string) => string)[] = [
  (line) => line, // exact
  (line) => line.trimEnd(), // ignore trailing whitespace
  (line) => line.trim(), // ignore indentation too
  normalizePunctuation,
];

/**
 * Find `pattern` as consecutive whole lines of `lines`, at or after `start`.
 * With `eof` the pattern must sit at the end of the file. Returns the index of
 * the first matching line.
 */
function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
): number | undefined {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return undefined;

  const last = lines.length - pattern.length;
  const first = eof ? Math.max(last, start) : start;

  for (const normalize of LINE_MATCHERS) {
    const wanted = pattern.map(normalize);
    for (let i = first; i <= last; i++) {
      let matches = true;
      for (let j = 0; j < wanted.length; j++) {
        if (normalize(lines[i + j]!) !== wanted[j]) {
          matches = false;
          break;
        }
      }
      if (matches) return i;
    }
  }
  return undefined;
}

function lastIndexWhere(
  lines: readonly HunkLine[],
  pred: (line: HunkLine) => boolean,
): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (pred(lines[i]!)) return i;
  }
  return -1;
}

/**
 * A hunk often ends with an empty line that stands for the newline after the
 * replaced region rather than for a real empty line of the file. Drop it from
 * the old side — and from the new side when that also ends with one.
 */
function withoutTrailingEmptyLine(lines: HunkLine[]): HunkLine[] | undefined {
  const lastOld = lastIndexWhere(lines, (line) => line.kind !== "add");
  if (lastOld === -1 || lines[lastOld]!.text !== "") return undefined;
  const lastNew = lastIndexWhere(lines, (line) => line.kind !== "remove");
  const dropNew = lastNew !== -1 && lines[lastNew]!.text === "";
  return lines.flatMap((line, index): HunkLine[] => {
    const offOld = index === lastOld;
    const offNew = dropNew && index === lastNew;
    if (!offOld && !offNew) return [line];
    if (line.kind !== "context" || (offOld && offNew)) return [];
    // A context line stands on both sides; it stays on the one it keeps.
    return [{ kind: offOld ? "add" : "remove", text: line.text }];
  });
}

const oldSide = (lines: readonly HunkLine[]): string[] =>
  lines.filter((line) => line.kind !== "add").map((line) => line.text);

function applyHunks(filePath: string, content: string, hunks: Hunk[]): string {
  const lines = content.split("\n");
  // Drop the empty element after the final newline so line counts match the
  // file's real lines.
  if (lines[lines.length - 1] === "") lines.pop();

  // [first line, number of lines replaced, replacement lines], in file order.
  const replacements: [number, number, string[]][] = [];
  let lineIndex = 0;

  for (const hunk of hunks) {
    if (hunk.contextPrefix !== undefined) {
      const anchor = seekSequence(lines, [hunk.contextPrefix], lineIndex, false);
      if (anchor === undefined) {
        throw new Error(
          `Failed to find context '${hunk.contextPrefix}' in ${filePath}`,
        );
      }
      lineIndex = anchor + 1;
    }

    let hunkLines = hunk.lines;
    let pattern = oldSide(hunkLines);

    if (pattern.length === 0) {
      // Pure insertion: after the anchor line, or at the end of the file.
      const at = hunk.contextPrefix !== undefined ? lineIndex : lines.length;
      replacements.push([at, 0, hunkLines.map((line) => line.text)]);
      continue;
    }

    let found = seekSequence(lines, pattern, lineIndex, hunk.endOfFile);
    if (found === undefined) {
      const shorter = withoutTrailingEmptyLine(hunkLines);
      if (shorter) {
        hunkLines = shorter;
        pattern = oldSide(hunkLines);
        found = seekSequence(lines, pattern, lineIndex, hunk.endOfFile);
      }
    }
    if (found === undefined) {
      throw new Error(
        `Failed to find expected lines in ${filePath}:\n${oldSide(hunk.lines).join("\n")}`,
      );
    }

    // Context lines keep the file's own text: a loose match (whitespace,
    // typographic punctuation) must not rewrite lines the patch leaves alone.
    const replacement: string[] = [];
    let offset = found;
    for (const line of hunkLines) {
      if (line.kind === "add") replacement.push(line.text);
      else if (line.kind === "context") replacement.push(lines[offset++]!);
      else offset++;
    }
    replacements.push([found, pattern.length, replacement]);
    lineIndex = found + pattern.length;
  }

  // Stable sort: an insertion at the start of a later replacement stays first.
  replacements.sort((a, b) => a[0] - b[0]);

  const result: string[] = [];
  let next = 0;
  for (const [first, count, replacement] of replacements) {
    result.push(...lines.slice(next, first), ...replacement);
    next = first + count;
  }
  result.push(...lines.slice(next));

  // Updated files always end with a newline, as with Codex.
  return result.length > 0 ? `${result.join("\n")}\n` : "";
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function resolvePatchPath(cwd: string, filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    throw new Error("Patch path cannot be empty");
  }
  return resolveEditPath(cwd, trimmed);
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

/** Every path a patch reads or writes, for locking. */
export function patchPaths(ops: PatchOperation[]): string[] {
  return ops.flatMap((op) =>
    op.kind === "update" && op.moveTo !== undefined
      ? [op.path, op.moveTo]
      : [op.path],
  );
}

export async function applyPatchOperations(
  ops: PatchOperation[],
  workspace: Workspace,
  cwd: string,
  signal?: AbortSignal,
  options?: {
    collectDiff?: boolean;
    checkAccess?: boolean;
    onFileChange?: OnFileChange;
  },
): Promise<PatchOpResult[]> {
  const results: PatchOpResult[] = [];
  const collectDiff = options?.collectDiff ?? false;
  const checkAccess = options?.checkAccess ?? false;
  const { onFileChange } = options ?? {};

  // Write-access preflight: verify all targets are accessible before mutating
  // anything, so we never partially apply a patch that can't complete.
  if (checkAccess) {
    // Files an earlier operation of this patch creates do not exist yet.
    const created = new Set<string>();
    for (const op of ops) {
      const abs = resolvePatchPath(cwd, op.path);
      if (op.kind === "add") {
        await workspace.checkCreatable(abs);
        created.add(abs);
        continue;
      }
      // update / delete: the file must exist and be writable.
      if (!created.has(abs)) await workspace.checkWriteAccess(abs);
      if (op.kind === "update" && op.moveTo !== undefined) {
        const dest = resolvePatchPath(cwd, op.moveTo);
        await workspace.checkCreatable(dest);
        created.add(dest);
      }
    }
  }

  // Snapshot stack for atomic rollback. Each entry records the absolute path
  // and the content BEFORE the operation (null = file did not exist, i.e. an
  // Add or Move op created it), and whether the operation deleted the file.
  const snapshots: Array<{
    abs: string;
    prior: string | null;
    deleted?: true;
  }> = [];

  try {
    for (const op of ops) {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      switch (op.kind) {
        case "add": {
          const abs = resolvePatchPath(cwd, op.path);

          // Guard: refuse to overwrite an existing file through Add File.
          if (await workspace.exists(abs)) {
            throw new Error(`Cannot add ${op.path}: file already exists`);
          }

          snapshots.push({ abs, prior: null });

          const newText = ensureTrailingNewline(op.contents);
          await workspace.writeText(abs, newText);
          results.push(
            buildOpResult(
              op.path,
              abs,
              `Added file ${op.path}.`,
              "",
              newText,
              collectDiff,
              onFileChange,
            ),
          );
          break;
        }

        case "delete": {
          const abs = resolvePatchPath(cwd, op.path);
          if (!(await workspace.exists(abs))) {
            throw new Error(`Failed to delete ${op.path}: file does not exist`);
          }
          // Always read before deleting so we can restore on rollback.
          const prior = await workspace.readText(abs);
          const oldText = collectDiff ? prior : "";
          snapshots.push({ abs, prior, deleted: true });
          await workspace.deleteFile(abs);
          results.push(
            buildOpResult(
              op.path,
              abs,
              `Deleted file ${op.path}.`,
              oldText,
              "",
              collectDiff,
              onFileChange,
            ),
          );
          break;
        }

        case "update": {
          const source = resolvePatchPath(cwd, op.path);
          const dest =
            op.moveTo === undefined ? source : resolvePatchPath(cwd, op.moveTo);
          // In place, the file is the one the path leads to: operations that
          // name a symlink and operations that name its target then work on
          // the same content, in the dry run as on disk. A move is about the
          // path itself, which stays as written.
          const abs = dest === source ? await canonicalPath(source) : source;
          const sourceText = await workspace.readText(abs);
          // Compute and validate the updated content BEFORE pushing the
          // snapshot — if applyHunks throws, the file has not been touched yet.
          const updated = applyHunks(op.path, sourceText, op.hunks);

          if (dest === source) {
            snapshots.push({ abs, prior: sourceText });
            await workspace.writeText(abs, updated);
          } else {
            // Same guard as Add File: a move never overwrites another file.
            if (await workspace.exists(dest)) {
              throw new Error(
                `Cannot move ${op.path} to ${op.moveTo}: destination already exists`,
              );
            }
            snapshots.push({ abs: dest, prior: null });
            await workspace.writeText(dest, updated, abs);
            snapshots.push({ abs, prior: sourceText, deleted: true });
            await workspace.deleteFile(abs);
          }
          results.push(
            buildOpResult(
              op.path,
              dest === source ? abs : dest,
              dest === source
                ? `Updated ${op.path}.`
                : `Updated ${op.path} and moved it to ${op.moveTo}.`,
              sourceText,
              updated,
              collectDiff,
              onFileChange,
            ),
          );
          break;
        }
      }
    }
  } catch (err) {
    // Best-effort rollback in reverse operation order.
    for (let i = snapshots.length - 1; i >= 0; i--) {
      const { abs, prior, deleted } = snapshots[i]!;
      if (prior === null) {
        // File was created by an Add or Move op — remove it.
        await workspace.deleteFile(abs).catch(() => {});
      } else if (deleted) {
        // File was deleted or moved away — put back what was there.
        await workspace.restoreFile(abs, prior).catch(() => {});
      } else {
        // File was updated — restore its prior content.
        await workspace.writeText(abs, prior).catch(() => {});
      }
    }
    throw err;
  }

  return results;
}

function buildOpResult(
  path: string,
  abs: string,
  message: string,
  oldText: string,
  newText: string,
  collectDiff: boolean,
  onFileChange?: OnFileChange,
): PatchOpResult {
  const result: PatchOpResult = { path, message };
  if (collectDiff) {
    const { diff, firstChangedLine, preview } = generateDiffString(
      oldText,
      newText,
    );
    result.diff = diff;
    result.firstChangedLine = firstChangedLine;
    onFileChange?.({
      path: abs,
      oldContent: oldText,
      newContent: newText,
      firstChangedLine,
      preview,
    });
  }
  return result;
}
