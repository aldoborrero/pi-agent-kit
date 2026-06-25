/**
 * File-encoding boundary — BOM and line-ending detection/restoration.
 *
 * The edit engines operate purely on BOM-stripped, LF-normalized text. The
 * Workspace reads through `readEncoding` (capturing the original BOM + EOL)
 * and writes through `restore` so files keep their CRLF/BOM on disk. Lone-`\r`
 * (classic Mac) is intentionally out of scope — only LF and CRLF are handled.
 */
import type { FileEncoding } from "./types.ts";

const BOM = "﻿";

export function stripBom(raw: string): { bom: boolean; text: string } {
  return raw.charCodeAt(0) === 0xfeff
    ? { bom: true, text: raw.slice(1) }
    : { bom: false, text: raw };
}

export function detectEol(text: string): "\n" | "\r\n" {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
}

export function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function readEncoding(raw: string): {
  text: string;
  encoding: FileEncoding;
} {
  const { bom, text } = stripBom(raw);
  const eol = detectEol(text);
  return { text: normalizeToLf(text), encoding: { bom, eol } };
}

export function restore(text: string, encoding: FileEncoding): string {
  const withEol = encoding.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
  return encoding.bom ? BOM + withEol : withEol;
}
