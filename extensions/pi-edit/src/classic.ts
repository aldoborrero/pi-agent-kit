/**
 * Classic edit engine — (path, oldText, newText) triples applied against a
 * Workspace, with positional same-file ordering, curly-quote fallback, and
 * atomic multi-file rollback.
 *
 * The core loop groups edits by their absolute path so all hits against a
 * file happen in one read/mutate/write cycle. Within a group, entries are
 * sorted by the position of their `oldText` in the original content, so a
 * model that lists edits bottom-up still applies them top-down.
 */

import { isAbsolute, resolve as resolvePath } from "node:path";

import { generateDiffString } from "./diff.ts";
import type { EditItem, EditResult, OnFileChange, Workspace } from "./types.ts";

// ---------------------------------------------------------------------------
// Text matching
// ---------------------------------------------------------------------------

const normalizeCurlyQuotes = (s: string): string =>
  s.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"');

const trimTrailingPerLine = (s: string): string =>
  s
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n");

// NFKC compatibility normalization — folds together compatibility variants
// (ligatures, full-width forms, etc.) that render identically but differ in
// code points, matching the built-in edit tool's first fuzzy pass.
const normalizeUnicode = (s: string): string => s.normalize("NFKC");

// Unicode dash/hyphen variants → ASCII hyphen.
// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus.
const normalizeDashes = (s: string): string => s.replace(/[‐‑‒–—―−]/g, "-");

// Special/non-breaking spaces → regular space.
// U+00A0 NBSP, U+2002–U+200A various widths, U+202F narrow NBSP,
// U+205F medium math space, U+3000 ideographic space.
const normalizeSpaces = (s: string): string => s.replace(/[  -   　]/g, " ");

/**
 * Ordered list of passes `findActualString` tries when matching `oldText`
 * inside file content. Each pass applies a normalizer to *both* `oldText`
 * and `content`; the first one that locates the transformed string wins.
 *
 * The array is the extension point: add a new pass here to gain tolerance
 * for a new class of model/file mismatch (e.g. dash variants, NBSP).
 */
const MATCH_PASSES: readonly ((s: string) => string)[] = [
  (s) => s, // exact
  normalizeCurlyQuotes, // curly → straight quotes
  trimTrailingPerLine, // trailing-whitespace tolerance per line
  normalizeUnicode, // NFKC compatibility folding
  normalizeDashes, // unicode dash/hyphen → ASCII hyphen
  normalizeSpaces, // special/non-breaking spaces → regular space
];

// Compute once per file/pass, not once per occurrence. The forward cursor
// only searches the untouched suffix, so inserted text before it cannot add
// normalization requirements to subsequent searches.
type MatchProfile = readonly boolean[];
function matchProfile(content: string): MatchProfile {
  return MATCH_PASSES.map(
    (transform, i) => i > 0 && transform(content) !== content,
  );
}

/**
 * Locate `oldText` inside `content` starting at `offset`. Falls back through
 * `MATCH_PASSES` when the exact search fails — most commonly when the model
 * wrote curly quotes but the file has straight ASCII.
 *
 * Returns `{ pos, actualOldText }` on match, `undefined` otherwise. Callers
 * must use `actualOldText.length` (not the original oldText length) when
 * splicing, since the matched region may differ from the requested text
 * after normalization.
 */
export function findActualString(
  content: string,
  oldText: string,
  offset: number,
  profile?: MatchProfile,
): { pos: number; actualOldText: string } | undefined {
  // Empty fuzzy patterns and offsets past EOF must never produce a zero-width
  // match: occurrence counting relies on strictly advancing through the file.
  if (!oldText || offset >= content.length) return undefined;
  offset = Math.max(0, offset);
  // Fast path: exact match with no normalization.
  const exact = content.indexOf(oldText, offset);
  if (exact !== -1) return { pos: exact, actualOldText: oldText };

  // Slower passes: normalize both sides and map the position back to the
  // original content. We search in the normalized content but return the
  // position and length in the *original* so the caller can splice correctly.
  profile ??= matchProfile(content);

  for (let i = 1; i < MATCH_PASSES.length; i++) {
    const transform = MATCH_PASSES[i]!;
    const normOld = transform(oldText);
    if (!normOld) continue;
    if (!profile[i] && normOld === oldText) continue;
    const normContent = profile[i] ? transform(content) : content;

    const normalizedOffset = profile[i]
      ? transform(content.slice(0, offset)).length
      : offset;
    const pos = normContent.indexOf(normOld, normalizedOffset);
    if (pos !== -1) {
      // Map back: the character at `pos` in normalised content corresponds
      // to the same index in the original (our normalizers preserve length
      // for all passes except trimTrailingPerLine). For trimEnd we need the
      // actual substring from original content that matches.
      const actualOld = content.slice(pos, pos + normOld.length);
      // Verify the mapped slice actually normalizes to the same thing.
      if (pos >= offset && transform(actualOld) === normOld) {
        return { pos, actualOldText: actualOld };
      }
      // If the lengths shifted (trimEnd can shrink lines), fall back to a
      // line-aligned search: find the lines in the original content.
      const match = findByNormalizedLines(content, oldText, offset, transform);
      if (match) return match;
    }
  }
  return undefined;
}

/**
 * Conservative uniqueness check in each matching domain. Count at most `limit`
 * hits (the caller only needs to establish ambiguity). Never use fuzzy needles
 * that normalize to empty, and do not rescan/normalize after every occurrence.
 */
export function countOccurrences(
  content: string,
  oldText: string,
  offset = 0,
  limit = Number.POSITIVE_INFINITY,
  profile: MatchProfile = matchProfile(content),
): number {
  if (!oldText || offset >= content.length) return 0;
  const countIn = (haystack: string, needle: string, start: number): number => {
    if (!needle) return 0;
    let count = 0;
    for (
      let pos = haystack.indexOf(needle, start);
      pos !== -1;
      pos = haystack.indexOf(needle, pos + needle.length)
    ) {
      if (++count >= limit) break;
    }
    return count;
  };
  let count = countIn(content, oldText, offset);
  if (count >= limit) return count;
  for (let i = 1; i < MATCH_PASSES.length; i++) {
    const transform = MATCH_PASSES[i]!;
    const needle = transform(oldText);
    if (!needle || (!profile[i] && needle === oldText)) continue;
    const haystack = profile[i] ? transform(content) : content;
    const start = profile[i]
      ? transform(content.slice(0, offset)).length
      : offset;
    count = Math.max(count, countIn(haystack, needle, start));
    if (count >= limit) break;
  }
  return count;
}

/**
 * Line-by-line normalized search. Used when a normalizer changes string
 * length (e.g. trimEnd) so character offsets between original and normalized
 * content no longer align 1:1.
 */
function findByNormalizedLines(
  content: string,
  oldText: string,
  offset: number,
  normalize: (s: string) => string,
): { pos: number; actualOldText: string } | undefined {
  if (offset >= content.length) return undefined;
  const contentLines = content.split("\n");
  const oldLines = oldText.split("\n");
  if (oldLines.length === 0) return undefined;

  const normOldLines = oldLines.map((l) => normalize(l));

  // Character offset → line index.
  let charCount = 0;
  let startLine = 0;
  for (let i = 0; i < contentLines.length; i++) {
    if (charCount + contentLines[i]!.length >= offset) {
      startLine = i;
      break;
    }
    charCount += contentLines[i]!.length + 1; // +1 for \n
  }

  for (let i = startLine; i <= contentLines.length - oldLines.length; i++) {
    let match = true;
    for (let j = 0; j < normOldLines.length; j++) {
      if (normalize(contentLines[i + j]!) !== normOldLines[j]!) {
        match = false;
        break;
      }
    }
    if (match) {
      // Compute character position and actual substring from original.
      let pos = 0;
      for (let k = 0; k < i; k++) pos += contentLines[k]!.length + 1;
      if (pos < offset) continue;
      const endLine = i + oldLines.length - 1;
      let endPos = 0;
      for (let k = 0; k <= endLine; k++) endPos += contentLines[k]!.length + 1;
      endPos--; // don't include the final \n after last matched line
      // A trailing empty oldLines entry already includes oldText's final LF.

      const actualOldText = content.slice(pos, endPos);
      return { pos, actualOldText };
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Grouping helpers
// ---------------------------------------------------------------------------

interface IndexedEdit {
  index: number;
  edit: EditItem;
}

function toAbsolute(path: string, cwd: string): string {
  return isAbsolute(path) ? resolvePath(path) : resolvePath(cwd, path);
}

/**
 * Bucket a flat edit list by its resolved absolute path. The returned Map
 * preserves insertion order, which is the order files are processed in the
 * apply loop — making the first-seen file also the first to be mutated on
 * disk.
 */
function groupEditsByPath(
  edits: EditItem[],
  cwd: string,
): Map<string, IndexedEdit[]> {
  const groups = new Map<string, IndexedEdit[]>();
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    const abs = toAbsolute(edit.path, cwd);
    const bucket = groups.get(abs);
    if (bucket) {
      bucket.push({ index: i, edit });
    } else {
      groups.set(abs, [{ index: i, edit }]);
    }
  }
  return groups;
}

/**
 * Sort same-file edits by the position of their `oldText` inside the
 * original content. Edits whose oldText can't be located slide to the end
 * and surface the error through the regular apply loop.
 */
function sortGroupByPosition(
  group: IndexedEdit[],
  originalContent: string,
  profile: MatchProfile,
): void {
  if (group.length < 2) return;
  const positions = new Map<IndexedEdit, number>();
  for (const entry of group) {
    const match = findActualString(
      originalContent,
      entry.edit.oldText,
      0,
      profile,
    );
    positions.set(
      entry,
      match === undefined ? Number.MAX_SAFE_INTEGER : match.pos,
    );
  }
  group.sort((a, b) => positions.get(a)! - positions.get(b)!);
}

// ---------------------------------------------------------------------------
// Core apply loop
// ---------------------------------------------------------------------------

/** Operation-local preflight cache. Never persisted or reused across tool calls. */
export interface PreparedClassicFile {
  originalContent: string;
  updatedContent: string;
  edits: Map<number, { edit: EditItem; result: EditResult }>;
}

interface ApplyOptions {
  prepared?: Map<string, PreparedClassicFile>;
  onPrepared?: (path: string, file: PreparedClassicFile) => void;
  collectDiff?: boolean;
  rollbackOnError?: boolean;
  /** When true, failed edits are recorded but the batch continues with the
   *  remaining edits instead of aborting the entire group. */
  continueOnError?: boolean;
  /** Called once per changed file after the diff is computed (requires collectDiff). */
  onFileChange?: OnFileChange;
}

/**
 * Apply a list of classic edits sequentially through a Workspace.
 *
 * Within each file the applier advances a `searchOffset` cursor after every
 * replacement so duplicate oldText snippets are disambiguated positionally.
 * Same-file edits are reordered by the position of their oldText in the
 * original content so the cursor always moves forward.
 *
 * When `rollbackOnError` is set, any file already written in this batch is
 * restored to its pre-edit snapshot if a later file fails — producing an
 * atomic multi-file edit on the real filesystem.
 */
export async function applyClassicEdits(
  edits: EditItem[],
  workspace: Workspace,
  cwd: string,
  signal?: AbortSignal,
  options: ApplyOptions = {},
): Promise<EditResult[]> {
  const {
    collectDiff = false,
    rollbackOnError = false,
    continueOnError = false,
    onFileChange,
  } = options;

  const fileGroups = groupEditsByPath(edits, cwd);
  const results: EditResult[] = new Array(edits.length);

  // Fail fast on any unwritable target so we don't partially mutate the FS.
  await Promise.all(
    Array.from(fileGroups.keys(), (absPath) =>
      workspace.checkWriteAccess(absPath),
    ),
  );

  // Pre-edit snapshots keyed by absolute path — populated as each file is
  // successfully written, consumed on failure for rollback.
  const snapshots = new Map<string, string>();

  try {
    for (const [absPath, group] of fileGroups) {
      throwIfAborted(signal);

      const originalContent = await workspace.readText(absPath);
      const cached = options.prepared?.get(absPath);
      const reusable =
        cached?.originalContent === originalContent &&
        group.every(({ index, edit }) => {
          const prior = cached.edits.get(index)?.edit;
          return (
            prior?.path === edit.path &&
            prior.oldText === edit.oldText &&
            prior.newText === edit.newText
          );
        }) &&
        cached.edits.size === group.length;

      let updatedContent: string;
      try {
        if (reusable) {
          // Revalidate the current file after acquiring the mutation locks. If
          // an external writer changed it, fall back to the full matching pass.
          updatedContent = cached!.updatedContent;
          for (const { index } of group)
            results[index] = { ...cached!.edits.get(index)!.result };
        } else {
          const profile = matchProfile(originalContent);
          sortGroupByPosition(group, originalContent, profile);
          updatedContent = applyGroupToContent(
            group,
            originalContent,
            results,
            edits.length,
            signal,
            continueOnError,
            profile,
          );
        }
      } catch (err) {
        if (continueOnError) continue;
        throw err;
      }

      options.onPrepared?.(absPath, {
        originalContent,
        updatedContent,
        edits: new Map(
          group.map(({ index, edit }) => [
            index,
            { edit: { ...edit }, result: { ...results[index]! } },
          ]),
        ),
      });
      throwIfAborted(signal);
      if (updatedContent === originalContent) continue;

      snapshots.set(absPath, originalContent);
      await workspace.writeText(absPath, updatedContent);
      throwIfAborted(signal);

      if (collectDiff) {
        const { diff, firstChangedLine, preview } = generateDiffString(
          originalContent,
          updatedContent,
        );
        const orderedIndices = reusable
          ? [...cached!.edits.keys()]
          : group.map((entry) => entry.index);
        const firstSuccessIdx = orderedIndices.find(
          (index) => results[index]?.success,
        );
        if (firstSuccessIdx !== undefined) {
          results[firstSuccessIdx]!.diff = diff;
          results[firstSuccessIdx]!.firstChangedLine = firstChangedLine;
        }
        onFileChange?.({
          path: absPath,
          oldContent: originalContent,
          newContent: updatedContent,
          firstChangedLine,
          preview,
        });
      }
    }
  } catch (err) {
    if (rollbackOnError) {
      await rollbackSnapshots(snapshots, workspace);
    }
    throw err;
  }

  return results;
}

/**
 * Apply every edit in a same-file group against `originalContent`, writing
 * per-edit outcomes into the shared `results` slot array. Returns the final
 * mutated content for the file, or throws with a formatted error if a hunk
 * can't be located.
 */
function applyGroupToContent(
  group: IndexedEdit[],
  originalContent: string,
  results: EditResult[],
  totalEdits: number,
  signal: AbortSignal | undefined,
  continueOnError = false,
  profile: MatchProfile = matchProfile(originalContent),
): string {
  let content = originalContent;
  let searchOffset = 0;

  // Track which oldText→newText pairs already landed in this file so we
  // can skip a redundant duplicate gracefully instead of failing the batch.
  const remaining = new Map<string, number>();
  for (const { edit } of group)
    remaining.set(edit.oldText, (remaining.get(edit.oldText) ?? 0) + 1);
  const appliedPairs = new Set<string>();
  const pairKey = (edit: EditItem) => `${edit.oldText}\0${edit.newText}`;

  for (let gi = 0; gi < group.length; gi++) {
    const { index, edit } = group[gi]!;
    const demand = remaining.get(edit.oldText)!;
    remaining.set(edit.oldText, demand - 1);
    throwIfAborted(signal);

    // Reject empty oldText outright — the built-in edit tool refuses it, and
    // an empty match would splice newText at the file start (indexOf("") === 0).
    if (edit.oldText === "") {
      results[index] = {
        path: edit.path,
        success: false,
        message: `oldText must not be empty in ${edit.path}.`,
      };
      if (continueOnError) continue;
      markRemainingSkipped(group, index, results);
      throw new Error(formatResults(results.filter(Boolean), totalEdits));
    }

    // Enforce the built-in's uniqueness contract. A single replacement whose
    // oldText matches more than once is ambiguous and must error instead of
    // silently editing the first hit. Positional multi-edits are still allowed:
    // when several edits in this group target the same oldText, each consumes
    // one occurrence in file order, so an ambiguity only exists when the number
    // of remaining matches exceeds the number of remaining edits for that text.
    const occurrences = countOccurrences(
      content,
      edit.oldText,
      searchOffset,
      demand + 1,
      profile,
    );
    if (occurrences > 1) {
      if (occurrences > demand) {
        results[index] = {
          path: edit.path,
          success: false,
          message: `Found ${occurrences} occurrences of the text in ${edit.path}. The text must be unique. Please provide more context to make it unique. (Counting stops once ambiguity is established.)`,
        };
        if (continueOnError) continue;
        markRemainingSkipped(group, index, results);
        throw new Error(formatResults(results.filter(Boolean), totalEdits));
      }
    }

    const match = findActualString(
      content,
      edit.oldText,
      searchOffset,
      profile,
    );

    if (match === undefined) {
      if (appliedPairs.has(pairKey(edit))) {
        results[index] = {
          path: edit.path,
          success: true,
          message: `Skipped redundant edit in ${edit.path} (already replaced all occurrences).`,
        };
        continue;
      }

      results[index] = {
        path: edit.path,
        success: false,
        message: `Could not find the exact text in ${edit.path}. The old text must match exactly including all whitespace and newlines.`,
      };

      if (continueOnError) continue;

      markRemainingSkipped(group, index, results);
      throw new Error(formatResults(results.filter(Boolean), totalEdits));
    }

    const { pos, actualOldText } = match;
    content =
      content.slice(0, pos) +
      edit.newText +
      content.slice(pos + actualOldText.length);
    searchOffset = pos + edit.newText.length;
    appliedPairs.add(pairKey(edit));

    results[index] = {
      path: edit.path,
      success: true,
      message: `Edited ${edit.path}.`,
    };
  }

  return content;
}

function markRemainingSkipped(
  group: IndexedEdit[],
  failedIndex: number,
  results: EditResult[],
): void {
  const failedPos = group.findIndex((e) => e.index === failedIndex);
  for (let i = failedPos + 1; i < group.length; i++) {
    const pending = group[i]!;
    results[pending.index] = {
      path: pending.edit.path,
      success: false,
      message: `Skipped (earlier edit in ${pending.edit.path} failed).`,
    };
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

async function rollbackSnapshots(
  snapshots: Map<string, string>,
  workspace: Workspace,
): Promise<void> {
  // Best-effort restore — surface the original failure regardless of per-file
  // rollback failures.
  await Promise.all(
    Array.from(snapshots, ([absPath, original]) =>
      workspace.writeText(absPath, original).catch(() => {}),
    ),
  );
}

function formatResults(results: EditResult[], totalEdits: number): string {
  const lines: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const status = r.success ? "✓" : "✗";
    lines.push(
      `${status} Edit ${i + 1}/${totalEdits} (${r.path}): ${r.message}`,
    );
  }

  const remaining = totalEdits - results.length;
  if (remaining > 0) {
    lines.push(`⊘ ${remaining} remaining edit(s) skipped due to error.`);
  }

  return lines.join("\n");
}
