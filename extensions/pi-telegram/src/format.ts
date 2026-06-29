/**
 * Message formatting and draft state management.
 *
 * Draft throttling constants and the DraftState/flush pattern are ported
 * from nullclaw/src/channels/telegram_draft_presenter.zig — these values
 * are derived from hitting Telegram's rate limits in production.
 *
 * Key invariants:
 * - Only flush when ≥512 bytes of new content OR ≥4s have elapsed
 * - Heartbeat fires every 12s when a draft is active
 * - Transport cap is 3000 bytes (not 4096) to leave room for formatting
 * - When over cap: show progress preview with elapsed time + tail excerpt
 * - Stale draft IDs are silently dropped by callers
 * - 429 responses trigger suppressUntil backoff in the draft state
 */

// ── Draft Constants (from nullclaw) ──────────────────────────────────────────

/** Minimum new bytes before flushing a draft update */
export const DRAFT_FLUSH_MIN_DELTA_BYTES = 512;
/** Minimum milliseconds between draft flushes */
export const DRAFT_FLUSH_MIN_INTERVAL_MS = 4_000;
/** Heartbeat interval for draft keep-alive */
export const DRAFT_HEARTBEAT_INTERVAL_MS = 12_000;
/** Max bytes sent to sendMessageDraft (< 4096, leaves room for entities) */
export const DRAFT_TRANSPORT_MAX_BYTES = 3_000;

/** Hard limit per sendMessage call */
const TELEGRAM_MAX_BYTES = 4_096;

/** Appended to every non-final chunk so the reader knows more is coming */
export const CONTINUATION_MARKER = "\n\n⬇";

// ── Draft State ───────────────────────────────────────────────────────────────

export interface DraftState {
  /** Monotonically incrementing ID — new ID per agent run for stale detection */
  draftId: number;
  /** Accumulated text chunks from message_update events */
  buffer: string;
  /** buffer character offset at last flush — slice by this to get unflushed content */
  lastFlushCharOffset: number;
  /** Date.now() at last flush — for interval calculation */
  lastFlushTime: number;
  /** Date.now() when this draft / agent run started */
  startedAt: number;
  /** Suppress flushes until this timestamp (set on 429 backoff) */
  suppressUntil: number;
}

export interface DraftFlush {
  draftId: number;
  text: string;
  startedAt: number;
}

export function createDraftState(draftId: number, startedAt: number): DraftState {
  return {
    draftId,
    buffer: "",
    lastFlushCharOffset: 0,
    lastFlushTime: startedAt,
    startedAt,
    suppressUntil: 0,
  };
}

// ── Draft Flush Logic ─────────────────────────────────────────────────────────

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function hasVisibleText(text: string): boolean {
  return text.trim().length > 0;
}

function pendingBytesSinceFlush(state: DraftState): number {
  // lastFlushCharOffset is a character index, not a byte offset. Slicing by it
  // is correct; the byte lengths are then measured on the resulting substrings.
  const flushed = byteLength(state.buffer.slice(0, state.lastFlushCharOffset));
  const total = byteLength(state.buffer);
  return total - flushed;
}

function shouldFlush(state: DraftState, nowMs: number): boolean {
  if (state.suppressUntil > nowMs) return false;
  const deltaBytes = pendingBytesSinceFlush(state);
  const elapsedMs = nowMs - state.lastFlushTime;
  return deltaBytes >= DRAFT_FLUSH_MIN_DELTA_BYTES || elapsedMs >= DRAFT_FLUSH_MIN_INTERVAL_MS;
}

function hasPendingVisible(state: DraftState): boolean {
  const pending = state.buffer.slice(state.lastFlushCharOffset);
  return hasVisibleText(pending);
}

/**
 * Append a streaming text chunk to the draft buffer.
 * Returns a DraftFlush when thresholds are met, null otherwise.
 * Callers must check flush.draftId === state.draftId before sending.
 */
export function appendDraftChunk(
  state: DraftState,
  chunk: string,
  nowMs: number,
): DraftFlush | null {
  if (!chunk) return null;
  state.buffer += chunk;

  if (!shouldFlush(state, nowMs)) return null;
  if (!hasVisibleText(state.buffer)) return null;

  const text = buildTransportText(state.buffer, state.startedAt, nowMs);
  state.lastFlushCharOffset = state.buffer.length;
  state.lastFlushTime = nowMs;

  return { draftId: state.draftId, text, startedAt: state.startedAt };
}

/**
 * Called by heartbeat timer to keep the draft alive.
 * - If there is pending visible text: flush it.
 * - If no text yet: send synthetic "still processing" heartbeat.
 * - If nothing pending: return null.
 */
export function heartbeatDraft(state: DraftState, nowMs: number, label?: string): DraftFlush | null {
  const elapsed = nowMs - state.lastFlushTime;
  if (elapsed < DRAFT_HEARTBEAT_INTERVAL_MS) return null;

  // Pending visible text → flush it
  if (hasPendingVisible(state)) {
    const text = buildTransportText(state.buffer, state.startedAt, nowMs);
    state.lastFlushCharOffset = state.buffer.length;
    state.lastFlushTime = nowMs;
    return { draftId: state.draftId, text, startedAt: state.startedAt };
  }

  // Already flushed all visible content → nothing to do
  if (state.buffer.length > 0 && state.lastFlushCharOffset >= state.buffer.length) {
    return null;
  }

  // No visible text yet (agent is thinking or in a tool-call phase) → send synthetic heartbeat
  state.lastFlushTime = nowMs;
  return {
    draftId: state.draftId,
    text: buildHeartbeatText(state.startedAt, nowMs, label),
    startedAt: state.startedAt,
  };
}

/**
 * Set suppressUntil after a 429 response.
 * retryAfterMs comes from Telegram's retry_after field (in seconds) × 1000.
 */
export function suppressDraftUntil(state: DraftState, retryAfterMs: number): void {
  state.suppressUntil = Date.now() + retryAfterMs;
}

// ── Transport Text Building (from nullclaw) ────────────────────────────────────

/**
 * Build text to send to sendMessageDraft.
 * If the buffer is within 3000 bytes: return it as-is.
 * If over: return a progress preview with elapsed time + tail excerpt.
 */
export function buildTransportText(text: string, startedAt: number, nowMs: number): string {
  if (byteLength(text) <= DRAFT_TRANSPORT_MAX_BYTES) return text;

  const elapsedSec = Math.floor((nowMs - startedAt) / 1000);
  const sizeBytes = byteLength(text);
  const prefix = `Processing request...\nElapsed: ${elapsedSec}s\nCurrent size: ${sizeBytes} bytes\n\n Latest excerpt:\n`;

  const prefixBytes = byteLength(prefix);
  if (prefixBytes >= DRAFT_TRANSPORT_MAX_BYTES) {
    return alignedSlice(prefix, DRAFT_TRANSPORT_MAX_BYTES);
  }

  const tailBudget = DRAFT_TRANSPORT_MAX_BYTES - prefixBytes;
  const tail = alignedTail(text, tailBudget);
  return prefix + tail;
}

/**
 * Synthetic heartbeat message when no visible draft text is available yet
 * (agent is in a tool-call / thinking phase with no text output).
 */
export function buildHeartbeatText(startedAt: number, nowMs: number, label?: string): string {
  const elapsedSec = Math.floor((nowMs - startedAt) / 1000);
  const header = label ?? "Processing request...";
  return `${header}\nElapsed: ${elapsedSec}s`;
}

/** Get last maxBytes bytes of text, aligned to a UTF-8 character boundary */
function alignedTail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  // Walk forward to next valid UTF-8 start byte (skip continuation bytes 0x80–0xBF)
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.slice(start).toString("utf8");
}

/** Get first maxBytes of string, UTF-8 aligned */
function alignedSlice(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // Walk backward to avoid cutting a multi-byte sequence
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.slice(0, end).toString("utf8");
}

// ── HTML Formatting ───────────────────────────────────────────────────────────

/** Escape the three characters that are special in Telegram HTML text/attributes */
export function escapeHTML(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Format assistant response text as Telegram HTML.
 *
 * Converts the markdown subset Claude typically produces:
 *   - **bold**, *italic*, _italic_, ~~strikethrough~~
 *   - `inline code` and ``` code blocks ```
 *   - [links](url)
 *   - # headers → <b>heading</b>
 *   - Unrecognised markdown passes through HTML-escaped.
 */
export function formatForTelegram(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceLines: string[] = [];

  for (const line of lines) {
    if (!inFence) {
      if (/^```/.test(line)) {
        inFence = true;
        fenceLines = [];
        continue;
      }
      out.push(markdownLineToHTML(line));
    } else {
      if (line === "```") {
        inFence = false;
        out.push(`<pre><code>${escapeHTML(fenceLines.join("\n"))}</code></pre>`);
        fenceLines = [];
      } else {
        fenceLines.push(line);
      }
    }
  }

  if (inFence) {
    out.push(`<pre><code>${escapeHTML(fenceLines.join("\n"))}</code></pre>`);
  }

  return out.join("\n");
}

function markdownLineToHTML(line: string): string {
  // ATX headers: # … → <b>…</b>
  const headerMatch = line.match(/^#{1,6}\s+(.+)$/);
  if (headerMatch) return "<b>" + markdownInlineToHTML(headerMatch[1]) + "</b>";
  return markdownInlineToHTML(line);
}

function markdownInlineToHTML(text: string): string {
  // Stash inline code spans and links so HTML-escaping doesn't corrupt them
  const stash: string[] = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, content) => {
    return `\x00${stash.push(`<code>${escapeHTML(content)}</code>`) - 1}\x00`;
  });
  // Stash links before escaping — URLs must keep raw & characters
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    return `\x00${stash.push(`<a href="${url}">${escapeHTML(linkText)}</a>`) - 1}\x00`;
  });

  // HTML-escape the remaining plain text
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Apply inline formatting (longest/most-specific patterns first)
  s = s.replace(/\*\*\*(.+?)\*\*\*/gs, "<b><i>$1</i></b>");       // ***bold italic***
  s = s.replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>");                   // **bold**
  s = s.replace(/~~(.+?)~~/gs, "<s>$1</s>");                       // ~~strike~~
  s = s.replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, "<i>$1</i>"); // *italic*
  s = s.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "<i>$1</i>");   // _italic_

  // Restore stashed code spans and links
  s = s.replace(/\x00(\d+)\x00/g, (_, i) => stash[Number(i)] ?? "");
  return s;
}

// ── Message Chunking ───────────────────────────────────────────────────────────

/**
 * Split text into chunks that fit within Telegram's 4096-byte limit.
 *
 * Strategy:
 * 1. Try to split at double-newline paragraph boundaries
 * 2. Never split inside an open code fence
 * 3. If a single paragraph is still too large, split at line boundaries
 * 4. Last resort: hard byte-align split
 */
export function chunkText(text: string, maxBytes = TELEGRAM_MAX_BYTES): string[] {
  if (byteLength(text) <= maxBytes) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";
  // Track nesting depth instead of toggling a boolean — a toggle miscounts
  // paragraphs with multiple open/close tags (e.g. 2 opens + 1 close would
  // toggle once even though the net depth is +1). Math.max guards malformed HTML.
  let inPreDepth = 0;

  for (const para of paragraphs) {
    const opens = (para.match(/<pre\b/gi) ?? []).length;
    const closes = (para.match(/<\/pre>/gi) ?? []).length;
    inPreDepth = Math.max(0, inPreDepth + opens - closes);
    const inPre = inPreDepth > 0;

    const separator = current ? "\n\n" : "";
    const candidate = current + separator + para;

    if (byteLength(candidate) > maxBytes && current && !inPre) {
      // Would exceed limit and we're not inside a fence: flush current
      chunks.push(current);
      current = para;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);

  // Post-process: split any chunks that are still too large
  const final = chunks.flatMap((chunk) =>
    byteLength(chunk) <= maxBytes ? [chunk] : splitAtLineBoundary(chunk, maxBytes),
  );

  // Append continuation marker to every non-last chunk so the reader knows more is coming
  return final.map((chunk, i) =>
    i < final.length - 1 ? chunk + CONTINUATION_MARKER : chunk,
  );
}

function splitAtLineBoundary(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    const candidate = current ? current + "\n" + line : line;
    if (byteLength(candidate) > maxBytes && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  // Last resort: hard byte split for lines that are still too large
  return chunks.flatMap((chunk) =>
    byteLength(chunk) <= maxBytes ? [chunk] : [alignedSlice(chunk, maxBytes)],
  );
}

// ── Agent Response Formatting ──────────────────────────────────────────────────

export interface AgentStats {
  turnCount: number;
  filesChanged: number;
  elapsedMs: number;
}

/**
 * Format the final agent response for Telegram.
 * Appends a stats line (turns, files changed, elapsed time).
 */
export function buildFinalMessage(assistantText: string, stats: AgentStats): string {
  const parts: string[] = [];

  if (stats.elapsedMs > 0) {
    parts.push(`${Math.round(stats.elapsedMs / 1000)}s`);
  }
  if (stats.turnCount > 0) {
    parts.push(`${stats.turnCount} turn${stats.turnCount !== 1 ? "s" : ""}`);
  }
  if (stats.filesChanged > 0) {
    parts.push(`${stats.filesChanged} file${stats.filesChanged !== 1 ? "s" : ""} changed`);
  }

  const statsLine = parts.length > 0 ? `\n\n📊 ${parts.join(" · ")}` : "";
  return assistantText + statsLine;
}
