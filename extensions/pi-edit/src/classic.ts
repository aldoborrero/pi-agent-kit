/**
 * Classic edit engine — (path, oldText, newText) triples applied against a
 * Workspace, with positional duplicate matching, fuzzy fallback, and atomic
 * multi-file rollback.
 *
 * The core loop groups edits by their absolute path so all hits against a
 * file happen in one read/mutate/write cycle. Every edit of a group is matched
 * against the file's original content; the replacements are then applied in
 * one pass, so the order in which the model lists them does not matter.
 */

import { generateDiffString } from "./diff.ts";
import { normalizeToLf } from "./encoding.ts";
import { canonicalPath, resolveEditPath } from "./paths.ts";
import type { EditItem, EditResult, OnFileChange, Workspace } from "./types.ts";

// ---------------------------------------------------------------------------
// Text matching
// ---------------------------------------------------------------------------

// Printable ASCII that does not end in whitespace is already normalized.
const PLAIN_LINE = /^(?:[\t\x20-\x7E]*[\x21-\x7E])?$/;

/**
 * One line as fuzzy matching sees it, with the same tolerance as Pi's built-in
 * edit: compatibility forms folded (NFKC), trailing whitespace dropped, and
 * typographic quotes, dashes and spaces turned into their ASCII equivalents.
 */
function normalizeLine(line: string): string {
  if (PLAIN_LINE.test(line)) return line;
  return line
    .normalize("NFKC")
    .trimEnd()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C-\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

const normalizeText = (text: string): string =>
  text.split("\n").map(normalizeLine).join("\n");

/**
 * Where an edit lands in the original content: `[pos, end)` is replaced by
 * `prefix + newText + suffix`.
 *
 * `prefix` and `suffix` are empty unless a fuzzy match starts or ends inside a
 * line whose text could not be mapped back column by column (NFKC changes
 * lengths). The whole line is then replaced and its unmatched part is put back
 * in normalized form.
 */
interface Match {
  pos: number;
  end: number;
  prefix: string;
  suffix: string;
}

/** The original and the normalized content of a file, line by line. */
interface FuzzyView {
  lines: string[];
  normalized: string[];
  /** Offset of each line in the original content. */
  starts: number[];
  /** The normalized lines joined, and the offset of each line in it. */
  text: string;
  normalizedStarts: number[];
  /** Whether normalization left the content as it was. */
  plain: boolean;
}

function lineStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1; // +1 for \n
  }
  return starts;
}

function createFuzzyView(content: string): FuzzyView {
  const lines = content.split("\n");
  // Normalizing line by line keeps both views aligned: line N of one is line
  // N of the other, which is what lets a match be mapped back.
  const normalized = lines.map(normalizeLine);
  const text = normalized.join("\n");
  return {
    lines,
    normalized,
    starts: lineStarts(lines),
    text,
    normalizedStarts: lineStarts(normalized),
    plain: text === content,
  };
}

/** Index of the line containing `offset`. */
function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Map `[start, end)` of the normalized text back onto the original content. */
function mapToOriginal(view: FuzzyView, start: number, end: number): Match {
  const first = lineAt(view.normalizedStarts, start);
  const last = lineAt(view.normalizedStarts, end);
  const startColumn = start - view.normalizedStarts[first]!;
  const endColumn = end - view.normalizedStarts[last]!;

  const firstStart = view.starts[first]!;
  const lastLine = view.lines[last]!;
  const lastEnd = view.starts[last]! + lastLine.length;

  // What the match leaves of its first and last line, in normalized form.
  const before = view.normalized[first]!.slice(0, startColumn);
  const after = view.normalized[last]!.slice(endColumn);

  // Keep the original text around the match whenever it is that same text.
  const keepsBefore = view.lines[first]!.startsWith(before);
  const pos = firstStart + (keepsBefore ? startColumn : 0);

  let matchEnd = lastEnd;
  let suffix = after;
  if (endColumn === 0) {
    // The match ends on a line boundary, which is the same in both views.
    matchEnd = view.starts[last]!;
    suffix = "";
  } else if (after === "") {
    // Up to the end of the line: any trailing whitespace goes with the match.
    suffix = "";
  } else {
    const trimmedLength = lastLine.trimEnd().length;
    if (lastLine.slice(0, trimmedLength).endsWith(after)) {
      matchEnd = view.starts[last]! + trimmedLength - after.length;
      suffix = "";
    }
  }

  // Both ends were found by text, independently; on one line they could cross.
  if (matchEnd < pos) {
    return { pos: firstStart, end: lastEnd, prefix: before, suffix: after };
  }
  return { pos, end: matchEnd, prefix: keepsBefore ? "" : before, suffix };
}

interface Matcher {
  /** Non-overlapping exact occurrences at or after `offset`, at most `limit`. */
  exact(oldText: string, limit: number, offset?: number): Match[];
  /** The same for the normalized form of `oldText` in the normalized content. */
  fuzzy(oldText: string, limit: number, offset?: number): Match[];
  /**
   * Where edits for `oldText` may land, and how often it occurs for the
   * uniqueness check: the larger of the exact and the fuzzy count, so a fuzzy
   * variant elsewhere in the file makes an exact match ambiguous too.
   */
  find(
    oldText: string,
    limit: number,
    offset?: number,
  ): { matches: Match[]; occurrences: number };
}

/**
 * Occurrence finder for one file. The normalized view is built on first use
 * and shared by every edit of the file, instead of once per edit.
 */
function createMatcher(content: string): Matcher {
  let view: FuzzyView | undefined;

  function exact(oldText: string, limit: number, offset = 0): Match[] {
    const matches: Match[] = [];
    if (!oldText) return matches;
    for (
      let pos = content.indexOf(oldText, offset);
      pos !== -1 && matches.length < limit;
      pos = content.indexOf(oldText, pos + oldText.length)
    ) {
      matches.push({ pos, end: pos + oldText.length, prefix: "", suffix: "" });
    }
    return matches;
  }

  // `exactMatches` spares a second scan when the caller already has them and
  // fuzzy matching turns out to be the same search.
  function fuzzy(
    oldText: string,
    limit: number,
    offset = 0,
    exactMatches?: Match[],
  ): Match[] {
    const needle = normalizeText(oldText);
    // A needle that normalizes to nothing but whitespace would match at every
    // line end; exact matching is the only meaningful search for it.
    if (needle.trim() === "") return [];
    view ??= createFuzzyView(content);
    // Nothing to gain when neither side changes under normalization.
    if (needle === oldText && view.plain) {
      return exactMatches ?? exact(oldText, limit, offset);
    }
    const { text } = view;
    const occurrences = (wanted: string): Match[] => {
      const matches: Match[] = [];
      for (
        let pos = text.indexOf(wanted);
        pos !== -1 && matches.length < limit;
        pos = text.indexOf(wanted, pos + wanted.length)
      ) {
        const match = mapToOriginal(view!, pos, pos + wanted.length);
        if (match.pos >= offset) matches.push(match);
      }
      return matches;
    };
    const matches = occurrences(needle);
    // Normalizing oldText drops whitespace at the end of each of its lines,
    // which is real text when oldText stops in the middle of a line. Where the
    // text as written fits the normalized content just as often, it says more
    // precisely what to replace.
    if (needle !== oldText) {
      const asWritten = occurrences(oldText);
      if (asWritten.length === matches.length) return asWritten;
    }
    return matches;
  }

  function find(oldText: string, limit: number, offset = 0) {
    const exactMatches = exact(oldText, limit, offset);
    const fuzzyMatches = fuzzy(oldText, limit, offset, exactMatches);
    return {
      matches:
        exactMatches.length >= fuzzyMatches.length
          ? exactMatches
          : fuzzyMatches,
      occurrences: Math.max(exactMatches.length, fuzzyMatches.length),
    };
  }

  return { exact, fuzzy, find };
}

/**
 * Locate `oldText` inside `content` at or after `offset`: exactly, or failing
 * that through fuzzy matching — most commonly when the model wrote curly
 * quotes but the file has straight ASCII, or lost trailing whitespace.
 *
 * Returns `{ pos, actualOldText }` on match, `undefined` otherwise.
 * `actualOldText` is the text of the file that matched, which may differ from
 * the requested text after normalization.
 */
export function findActualString(
  content: string,
  oldText: string,
  offset: number,
): { pos: number; actualOldText: string } | undefined {
  // Empty patterns and offsets past EOF must never produce a zero-width match.
  if (!oldText || offset >= content.length) return undefined;
  const matcher = createMatcher(content);
  const from = Math.max(0, offset);
  const match =
    matcher.exact(oldText, 1, from)[0] ?? matcher.fuzzy(oldText, 1, from)[0];
  return (
    match && {
      pos: match.pos,
      actualOldText: content.slice(match.pos, match.end),
    }
  );
}

/**
 * Conservative uniqueness check, counting fuzzy variants too. Counts at most
 * `limit` hits (callers only need to establish ambiguity).
 */
export function countOccurrences(
  content: string,
  oldText: string,
  offset = 0,
  limit = Number.POSITIVE_INFINITY,
): number {
  if (!oldText || offset >= content.length) return 0;
  return createMatcher(content).find(oldText, limit, offset).occurrences;
}

// ---------------------------------------------------------------------------
// Grouping helpers
// ---------------------------------------------------------------------------

interface IndexedEdit {
  index: number;
  edit: EditItem;
}

/**
 * Bucket a flat edit list by the file each edit targets. The returned Map
 * preserves insertion order, which is the order files are processed in the
 * apply loop — making the first-seen file also the first to be mutated on
 * disk.
 *
 * Files are keyed by where they really live: edits naming a symlink and edits
 * naming its target belong to one file, read, matched and written once.
 */
async function groupEditsByPath(
  edits: EditItem[],
  cwd: string,
): Promise<Map<string, IndexedEdit[]>> {
  const groups = new Map<string, IndexedEdit[]>();
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    const abs = await canonicalPath(resolveEditPath(cwd, edit.path));
    const bucket = groups.get(abs);
    if (bucket) {
      bucket.push({ index: i, edit });
    } else {
      groups.set(abs, [{ index: i, edit }]);
    }
  }
  return groups;
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
 * Apply a list of classic edits through a Workspace.
 *
 * Within each file every edit is matched against the original content, and
 * duplicate oldText snippets are disambiguated positionally: the first edit
 * for a text takes its first occurrence, the second edit the second one.
 *
 * When `rollbackOnError` is set, any file already written in this batch is
 * restored to its pre-edit snapshot if a later file fails — producing an
 * atomic multi-file edit on the real filesystem.
 */
export async function applyClassicEdits(
  requestedEdits: EditItem[],
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

  // Files are matched and written as LF text; the Workspace restores CRLF on
  // write. CRLF in the model's own text has to go too, or newText would reach
  // a CRLF file as "\r\r\n".
  const edits = requestedEdits.map((edit) => ({
    ...edit,
    oldText: normalizeToLf(edit.oldText),
    newText: normalizeToLf(edit.newText),
  }));

  const fileGroups = await groupEditsByPath(edits, cwd);
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
      if (reusable) {
        // Revalidate the current file after acquiring the mutation locks. If
        // an external writer changed it, fall back to the full matching pass.
        updatedContent = cached!.updatedContent;
        for (const { index } of group)
          results[index] = { ...cached!.edits.get(index)!.result };
      } else {
        // With `continueOnError` a failed edit is recorded, not thrown: what
        // does throw here is an abort, which must reach the rollback below.
        updatedContent = applyGroupToContent(
          group,
          originalContent,
          results,
          edits.length,
          signal,
          continueOnError,
        );
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
 * mutated content for the file, or throws with a formatted error if an edit
 * can't be applied.
 */
function applyGroupToContent(
  group: IndexedEdit[],
  originalContent: string,
  results: EditResult[],
  totalEdits: number,
  signal: AbortSignal | undefined,
  continueOnError = false,
): string {
  const matcher = createMatcher(originalContent);

  // How many edits of this group target each oldText.
  const wanted = new Map<string, number>();
  for (const { edit } of group)
    wanted.set(edit.oldText, (wanted.get(edit.oldText) ?? 0) + 1);

  // Per oldText: its occurrences in the original content, how many of them
  // earlier edits already took, and whether there are too many to choose from.
  const targets = new Map<
    string,
    { matches: Match[]; taken: number; occurrences: number; ambiguous: boolean }
  >();

  // Track which oldText→newText pairs already landed in this file so we
  // can skip a redundant duplicate gracefully instead of failing the batch.
  const appliedPairs = new Set<string>();
  const pairKey = (edit: EditItem) => `${edit.oldText}\0${edit.newText}`;

  const planned: { entry: IndexedEdit; match: Match }[] = [];

  // Record a failed edit; unless failures are tolerated, give up on the group.
  const fail = (entry: IndexedEdit, message: string): void => {
    results[entry.index] = { path: entry.edit.path, success: false, message };
    if (continueOnError) return;
    markRemainingSkipped(group, entry.index, results);
    throw new Error(formatResults(results.filter(Boolean), totalEdits));
  };

  for (const entry of group) {
    const { index, edit } = entry;
    throwIfAborted(signal);

    // Reject empty oldText outright — the built-in edit tool refuses it, and
    // an empty match would splice newText at the file start (indexOf("") === 0).
    if (edit.oldText === "") {
      fail(entry, `oldText must not be empty in ${edit.path}.`);
      continue;
    }

    // As the built-in does: reporting "Edited" for a replacement that changes
    // nothing would hide that the model's view of the file is off.
    if (edit.oldText === edit.newText) {
      fail(
        entry,
        `No changes made to ${edit.path}: oldText and newText are identical.`,
      );
      continue;
    }

    let target = targets.get(edit.oldText);
    if (!target) {
      // Enforce the built-in's uniqueness contract. A single replacement whose
      // oldText matches more than once is ambiguous and must error instead of
      // silently editing the first hit. Positional multi-edits are still
      // allowed: when several edits in this group target the same oldText,
      // each takes one occurrence in file order, so an ambiguity only exists
      // when the text occurs more often than there are edits for it.
      //
      // Occurrences are those of the original content: one that lies inside a
      // region another edit replaces still makes the text ambiguous, and must
      // not let the edit land on a later one.
      const edits = wanted.get(edit.oldText)!;
      // One more than needed is enough to establish the ambiguity.
      const { matches, occurrences } = matcher.find(edit.oldText, edits + 1);
      target = {
        matches,
        taken: 0,
        occurrences,
        ambiguous: occurrences > 1 && occurrences > edits,
      };
      targets.set(edit.oldText, target);
    }

    if (target.ambiguous) {
      fail(
        entry,
        `Found ${target.occurrences} occurrences of the text in ${edit.path}. The text must be unique. Please provide more context to make it unique. (Counting stops once ambiguity is established.)`,
      );
      continue;
    }

    const match = target.matches[target.taken];
    if (match === undefined) {
      if (appliedPairs.has(pairKey(edit))) {
        results[index] = {
          path: edit.path,
          success: true,
          message: `Skipped redundant edit in ${edit.path} (already replaced all occurrences).`,
        };
        continue;
      }
      fail(
        entry,
        `Could not find the exact text in ${edit.path}. The old text must match exactly including all whitespace and newlines.`,
      );
      continue;
    }

    target.taken++;
    appliedPairs.add(pairKey(edit));
    planned.push({ entry, match });
    results[index] = {
      path: edit.path,
      success: true,
      message: `Edited ${edit.path}.`,
    };
  }

  // Edits must target disjoint regions: applying one would invalidate what
  // the other matched.
  planned.sort((a, b) => a.match.pos - b.match.pos);
  const applied: typeof planned = [];
  for (const candidate of planned) {
    const previous = applied[applied.length - 1];
    if (previous && candidate.match.pos < previous.match.end) {
      fail(
        candidate.entry,
        `Edit overlaps another edit in ${candidate.entry.edit.path}. Merge them into one edit or target disjoint regions.`,
      );
      continue;
    }
    applied.push(candidate);
  }

  let content = "";
  let cursor = 0;
  for (const { entry, match } of applied) {
    content +=
      originalContent.slice(cursor, match.pos) +
      match.prefix +
      entry.edit.newText +
      match.suffix;
    cursor = match.end;
  }
  content += originalContent.slice(cursor);

  // A fuzzy match can also end up writing back exactly what was there.
  if (applied.length > 0 && content === originalContent) {
    for (const { entry } of applied) {
      fail(
        entry,
        `No changes made to ${entry.edit.path}. The replacement produced identical content.`,
      );
    }
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
