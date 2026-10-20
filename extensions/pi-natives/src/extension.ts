/**
 * pi-natives Extension
 *
 * Rust-accelerated tools for Pi via @oh-my-pi/pi-natives (MIT, N-API):
 *   - grep:     ripgrep-engine content search (replaces the JS built-in)
 *   - ast_grep: structural code search — native pattern mode, CLI fallback
 *               for rule/inspect modes (preserves the pi-ast-grep contract)
 *   - pdf:      PDF → Markdown extraction with OCR page classification
 *
 * All tools degrade gracefully when the native addon is unavailable: grep
 * falls back to a JS implementation, ast_grep falls back to the ast-grep
 * CLI, and pdf is skipped entirely.
 */

import { Type } from "@sinclair/typebox";
import { once } from "./once.ts";
import { loadNatives, nativesLoadError as getLoadError } from "./natives.ts";
import {
  type AstGrepMatch,
  type AstGrepParams,
  formatResults,
  runAstGrep,
  runAstGrepRaw,
} from "./ast-cli.ts";

// ---------------------------------------------------------------------------
// Native module loading (graceful degradation)
// ---------------------------------------------------------------------------

const natives = await loadNatives();
const nativesLoadError = natives ? null : getLoadError();

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

type GrepOutputMode = "content" | "filesWithMatches" | "count";

interface GrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  ignore_case?: boolean;
  multiline?: boolean;
  mode?: GrepOutputMode;
  context?: number;
  limit?: number;
}

/** JS fallback grep: recursive walk, skips node_modules/.git, respects .gitignore minimally. */
export async function fallbackGrep(
  pattern: string,
  root: string,
  globSuffix?: string,
  ignoreCase = false,
): Promise<Array<{ path: string; line: number; text: string }>> {
  const { readdir, stat, readFile } = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const regex = new RegExp(pattern, ignoreCase ? "i" : "");
  const results: Array<{ path: string; line: number; text: string }> = [];
  const SKIP = new Set(["node_modules", ".git", ".direnv", "dist", "target"]);
  const suffix = globSuffix?.replace(/^\*\*/, "").replace(/^\*\./, ".").replace(/^\*./, ".");

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const full = pathMod.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (suffix && !entry.name.endsWith(suffix)) continue;
      let content: string;
      try {
        const s = await stat(full);
        if (s.size > 2_000_000) continue;
        content = await readFile(full, "utf-8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          results.push({ path: pathMod.relative(root, full), line: i + 1, text: lines[i]! });
          if (results.length >= 500) return;
        }
      }
    }
  }

  await walk(root);
  return results;
}

function formatGrepOutput(
  matches: Array<{ path: string; lineNumber: number; line: string; contextBefore?: Array<{ text: string }>; contextAfter?: Array<{ text: string }> }>,
  totalMatches: number,
  filesSearched: number,
): string {
  if (matches.length === 0) return "No matches found.";
  const byFile = new Map<string, typeof matches>();
  for (const m of matches) {
    const list = byFile.get(m.path) ?? [];
    list.push(m);
    byFile.set(m.path, list);
  }
  let out = `Found ${totalMatches} match(es) in ${byFile.size} file(s) (${filesSearched} searched):\n`;
  for (const [file, fileMatches] of byFile) {
    out += `\n### ${file}\n`;
    for (const m of fileMatches) {
      for (const c of m.contextBefore ?? []) out += ` ${c.text}\n`;
      out += `${m.lineNumber}: ${m.line}\n`;
      for (const c of m.contextAfter ?? []) out += ` ${c.text}\n`;
    }
  }
  return out;
}

const GREP_DESCRIPTION = natives
  ? "Search file contents using the native ripgrep engine (Rust). Respects .gitignore. Regex pattern, optional glob/type filters, output modes content/filesWithMatches/count, and context lines."
  : "Search file contents (JavaScript fallback — native addon unavailable). Regex pattern with recursive walk; skips node_modules/.git.";

// ---------------------------------------------------------------------------
// pdf
// ---------------------------------------------------------------------------

interface PdfParams {
  path: string;
  /** Max characters of extracted markdown to return (default 20000). */
  max_chars?: number;
}

// ---------------------------------------------------------------------------
// ast_grep — shared contract with the retired pi-ast-grep extension
// ---------------------------------------------------------------------------

/** Map a native AstFindMatch onto the legacy CLI match shape. */
export function mapAstFindMatch(m: import("@oh-my-pi/pi-natives").AstFindMatch): AstGrepMatch {
  return {
    file: m.path,
    range: {
      byteOffset: { start: m.byteStart, end: m.byteEnd },
      start: { line: m.startLine, column: m.startColumn },
      end: { line: m.endLine, column: m.endColumn },
    },
    lines: m.text,
    text: m.text,
    language: "",
    metaVariables: m.metaVariables
      ? {
          single: Object.fromEntries(
            Object.entries(m.metaVariables).map(([k, v]) => [k, { text: v }]),
          ),
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function nativesExtension(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI): void {
  once(pi, "pi-natives", () => {
    // -----------------------------------------------------------------
    // grep
    // -----------------------------------------------------------------
    pi.registerTool({
      name: "grep",
      description: GREP_DESCRIPTION,
      promptSnippet: "Search file contents with the native ripgrep engine (Rust).",
      promptGuidelines: [
        "Use grep for plain text, comments, config values, or non-code files",
        "Prefer ast_grep for code structures (functions, classes, imports)",
        "Respects .gitignore by default; use ignore_case for case-insensitive matches",
      ],
      parameters: Type.Object({
        pattern: Type.String({ description: "Regex pattern to search for" }),
        path: Type.Optional(
          Type.String({ description: "Directory or file to search (default: cwd)" }),
        ),
        glob: Type.Optional(
          Type.String({ description: 'Glob filter for file paths (e.g. "*.ts")' }),
        ),
        type: Type.Optional(
          Type.String({ description: 'Filter by file type (e.g. "js", "py", "rust")' }),
        ),
        ignore_case: Type.Optional(
          Type.Boolean({ description: "Case-insensitive search (default: false)" }),
        ),
        multiline: Type.Optional(
          Type.Boolean({ description: "Enable multiline matching (default: false)" }),
        ),
        mode: Type.Optional(
          Type.Union(
            [
              Type.Literal("content"),
              Type.Literal("filesWithMatches"),
              Type.Literal("count"),
            ],
            { description: "Output mode (default: content)" },
          ),
        ),
        context: Type.Optional(
          Type.Number({ description: "Lines of context before/after each match" }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Maximum number of matches to return (default: 200)" }),
        ),
      }),
      async execute(_toolCallId, params, _signal, onUpdate, ctx) {
        const p = params as GrepParams;
        const root = p.path ?? ctx.cwd;
        if (!root) {
          return {
            content: [{ type: "text", text: "Error: no path and no cwd available." }],
            isError: true,
          };
        }

        onUpdate?.({ content: [{ type: "text", text: `Searching for: ${p.pattern}` }] });

        if (natives) {
          try {
            const res = await natives.grep({
              pattern: p.pattern,
              path: root,
              glob: p.glob,
              type: p.type,
              ignoreCase: p.ignore_case,
              multiline: p.multiline,
              mode: p.mode as never,
              context: p.context,
              maxCount: p.limit ?? 200,
            });
            if (p.mode === "filesWithMatches" || p.mode === "count") {
              const lines = res.matches
                .map((m) => `${m.path}${m.matchCount != null ? `: ${m.matchCount}` : ""}`)
                .join("\n");
              return {
                content: [{ type: "text", text: lines || "No matches found." }],
                details: {
                  mode: p.mode,
                  totalMatches: res.totalMatches,
                  filesWithMatches: res.filesWithMatches,
                  filesSearched: res.filesSearched,
                },
              };
            }
            return {
              content: [{ type: "text", text: formatGrepOutput(res.matches as never, res.totalMatches, res.filesSearched) }],
              details: {
                mode: "content",
                totalMatches: res.totalMatches,
                filesSearched: res.filesSearched,
                truncated: (p.limit ?? 200) < res.totalMatches,
              },
            };
          } catch {
            // Native backend failed unexpectedly — fall through to JS fallback.
            // (Transient native errors surface as fallback results, not crashes;
            // the module-level load error is unaffected.)
          }
        }

        // JS fallback (content mode only)
        try {
          const hits = await fallbackGrep(p.pattern, root, p.glob, p.ignore_case);
          return {
            content: [{
              type: "text",
              text: hits.length === 0
                ? "No matches found."
                : hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n"),
            }],
            details: { mode: "content", totalMatches: hits.length, fallback: true },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `grep failed: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true,
          };
        }
      },
    });

    // -----------------------------------------------------------------
    // ast_grep
    // -----------------------------------------------------------------
    pi.registerTool({
      name: "ast_grep",
      description:
        "Search code using AST patterns. Three modes: pattern (native Rust), rule (YAML composite rules via ast-grep CLI), inspect (AST structure dump via CLI).",
      promptSnippet:
        "Search code by structure (AST patterns). Prefer over grep for finding functions, classes, imports, and code patterns.",
      promptGuidelines: [
        "Prefer ast_grep over grep when searching for code structures (functions, classes, imports, type definitions, API calls)",
        "Use grep instead for plain text, comments, config values, or non-code files",
        "Start with pattern mode for simple searches (e.g. pattern: 'async function $NAME($$$) { $$$ }'). Only use rule mode when you need relational logic (has/inside/precedes/follows)",
        "If unsure about tree-sitter node kinds for rule mode, use inspect mode first to discover the correct kind names",
        "Always include stopBy: end in has/inside rules to search the full subtree",
      ],
      parameters: Type.Object({
        mode: Type.Union(
          [Type.Literal("pattern"), Type.Literal("rule"), Type.Literal("inspect")],
          { description: "Search mode: pattern (native), rule (complex YAML rule, CLI), inspect (AST dump, CLI)" },
        ),
        pattern: Type.Optional(
          Type.String({
            description: "AST pattern to search for (pattern + inspect modes). Use $VAR for wildcards, $$$ for spread.",
          }),
        ),
        rule: Type.Optional(
          Type.String({
            description:
              'YAML rule body for rule mode (e.g. "kind: function_declaration\\nhas:\\n  pattern: await $EXPR\\n  stopBy: end").',
          }),
        ),
        inspect_format: Type.Optional(
          Type.Union([Type.Literal("ast"), Type.Literal("cst"), Type.Literal("pattern")], {
            description: "Output format for inspect mode: ast (named nodes only, default), cst (all nodes), pattern (how ast-grep interprets the pattern).",
          }),
        ),
        lang: Type.Optional(
          Type.String({
            description: "Language (e.g. typescript, python, rust). Required for rule and inspect modes. Auto-detected for pattern mode if omitted.",
          }),
        ),
        paths: Type.Optional(
          Type.Array(Type.String(), { description: 'Directories/files to search (default: ".")' }),
        ),
        globs: Type.Optional(
          Type.Array(Type.String(), { description: "Glob patterns to include/exclude (e.g. '*.ts', '!node_modules')" }),
        ),
        context: Type.Optional(
          Type.Boolean({ description: "Show surrounding context lines (default: false)" }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Maximum number of matches to return (default: 50). Only applies to pattern and rule modes." }),
        ),
      }),
      async execute(_toolCallId, params, _signal, onUpdate, ctx) {
        const p = params as AstGrepParams;
        try {
          if (p.mode === "pattern") {
            if (!p.pattern) {
              return {
                content: [{ type: "text", text: "Error: `pattern` parameter is required for pattern mode." }],
                isError: true,
              };
            }

            const useNative =
              natives &&
              (!p.globs || p.globs.length <= 1) &&
              (!p.paths || p.paths.length <= 1);

            if (useNative && natives) {
              onUpdate?.({ content: [{ type: "text", text: `Searching for pattern: ${p.pattern}...` }] });
              const res = await natives.astGrep({
                patterns: [p.pattern],
                lang: p.lang,
                path: p.paths?.[0] ?? ctx.cwd ?? ".",
                glob: p.globs?.[0],
                limit: p.limit ?? 50,
                includeMeta: true,
              });
              const matches = res.matches.map(mapAstFindMatch);
              let output = formatResults(matches, p.context ?? false);
              if (res.limitReached) {
                output += `\n\n_Results truncated to ${p.limit ?? 50} matches._`;
              }
              output += `\n\n_(native ast-grep engine)_`;
              return {
                content: [{ type: "text", text: output }],
                details: { mode: "pattern", matchCount: matches.length, truncated: res.limitReached, backend: "native" },
              };
            }

            // CLI fallback (multi-path/multi-glob queries, or natives unavailable)
            const args: string[] = ["run", "--pattern", p.pattern, "--json=compact"];
            if (p.lang) args.push("--lang", p.lang);
            if (p.globs) for (const g of p.globs) args.push("--globs", g);
            args.push(...(p.paths && p.paths.length > 0 ? p.paths : ["."]));

            onUpdate?.({ content: [{ type: "text", text: `Searching for pattern: ${p.pattern}...` }] });
            let matches = await runAstGrep(args, ctx.cwd ?? ".");
            const limit = p.limit ?? 50;
            const truncated = matches.length > limit;
            if (truncated) matches = matches.slice(0, limit);
            let output = formatResults(matches, p.context ?? false);
            if (truncated) output += `\n\n_Results truncated to ${limit} matches._`;
            return {
              content: [{ type: "text", text: output }],
              details: { mode: "pattern", matchCount: matches.length, truncated, backend: "cli" },
            };
          }

          if (p.mode === "rule") {
            if (!p.rule) {
              return {
                content: [{ type: "text", text: "Error: `rule` parameter is required for rule mode." }],
                isError: true,
              };
            }
            if (!p.lang) {
              return {
                content: [{ type: "text", text: "Error: `lang` parameter is required for rule mode." }],
                isError: true,
              };
            }
            const { dir, filePath } = writeRuleToTempFile(p.lang, p.rule);
            try {
              const args: string[] = ["scan", "--rule", filePath, "--json=compact"];
              if (p.globs) for (const g of p.globs) args.push("--globs", g);
              args.push(...(p.paths && p.paths.length > 0 ? p.paths : ["."]));
              onUpdate?.({ content: [{ type: "text", text: `Scanning with YAML rule (${p.lang})...` }] });
              let matches = await runAstGrep(args, ctx.cwd ?? ".");
              const limit = p.limit ?? 50;
              const truncated = matches.length > limit;
              if (truncated) matches = matches.slice(0, limit);
              let output = formatResults(matches, p.context ?? false);
              if (truncated) output += `\n\n_Results truncated to ${limit} matches._`;
              return {
                content: [{ type: "text", text: output }],
                details: { mode: "rule", matchCount: matches.length, truncated },
              };
            } finally {
              cleanupTempFile(dir, filePath);
            }
          }

          if (p.mode === "inspect") {
            if (!p.pattern || !p.lang) {
              return {
                content: [{ type: "text", text: "Error: `pattern` and `lang` parameters are required for inspect mode." }],
                isError: true,
              };
            }
            const format = p.inspect_format ?? "ast";
            const args: string[] = ["run", "--pattern", p.pattern, "--lang", p.lang, `--debug-query=${format}`];
            onUpdate?.({ content: [{ type: "text", text: `Inspecting AST (${format}) for: ${p.pattern}...` }] });
            const output = await runAstGrepRaw(args, ctx.cwd ?? ".");
            return {
              content: [{ type: "text", text: output }],
              details: { mode: "inspect", format },
            };
          }

          return {
            content: [{ type: "text", text: `Error: Unknown mode "${p.mode}". Use "pattern", "rule", or "inspect".` }],
            isError: true,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { content: [{ type: "text", text: `ast-grep failed: ${msg}` }], isError: true };
        }
      },
    });

    // -----------------------------------------------------------------
    // pdf (native only — skipped entirely when the addon is unavailable)
    // -----------------------------------------------------------------
    if (natives) {
      pi.registerTool({
        name: "pdf",
        description:
          "Extract text from a PDF file as Markdown (native Rust). Reports which pages likely need OCR (scanned content).",
        promptSnippet: "Extract PDF content as Markdown, with OCR-page classification.",
        promptGuidelines: [
          "Use pdf for local PDF files; use web tools for remote URLs",
          "Check pages_needing_ocr in details — those pages are scans and may need OCR tooling",
        ],
        parameters: Type.Object({
          path: Type.String({ description: "Path to the PDF file" }),
          max_chars: Type.Optional(
            Type.Number({ description: "Max characters of extracted Markdown to return (default: 20000)" }),
          ),
        }),
        async execute(_toolCallId, params, _signal, onUpdate) {
          const p = params as PdfParams;
          try {
            onUpdate?.({ content: [{ type: "text", text: `Extracting ${p.path}...` }] });
            const { readFile } = await import("node:fs/promises");
            const bytes = new Uint8Array(await readFile(p.path));
            const result = await natives!.pdfToMarkdown(bytes);
            const max = p.max_chars ?? 20000;
            const markdown =
              result.markdown.length > max
                ? `${result.markdown.slice(0, max)}\n\n_…truncated (${result.markdown.length} chars total)._`
                : result.markdown;
            const ocr = result.pagesNeedingOcr.length > 0
              ? `\n\n_Pages likely needing OCR: ${result.pagesNeedingOcr.join(", ")}_`
              : "";
            return {
              content: [{ type: "text", text: markdown + ocr }],
              details: {
                pagesNeedingOcr: result.pagesNeedingOcr,
                markdownChars: result.markdown.length,
              },
            };
          } catch (e) {
            return {
              content: [{ type: "text", text: `pdf failed: ${e instanceof Error ? e.message : String(e)}` }],
              isError: true,
            };
          }
        },
      });
    }

    // -----------------------------------------------------------------
    // Status on session start
    // -----------------------------------------------------------------
    pi.on("session_start", async (_event, ctx) => {
      if (natives) {
        ctx.ui.setStatus("pi-natives", undefined);
      } else {
        const reason = nativesLoadError ? ` (${nativesLoadError.slice(0, 120)})` : "";
        ctx.ui.setStatus(
          "pi-natives",
          ctx.ui.theme.warning(`pi-natives: native addon unavailable${reason}`),
        );
        // Surface the real cause — optional deps pruned, unsupported platform,
        // or incompatible runtime are the usual suspects.
        ctx.ui.notify(
          `pi-natives: native addon not loaded${reason}. Tools use fallbacks (grep JS, ast_grep CLI, no pdf). ` +
            `Fix: reinstall with optional dependencies enabled (bun install).`,
          "warning",
        );
      }
    });
  });
}

// Re-export CLI helpers so the rule/inspect fallback lives in one place.
import { cleanupTempFile, writeRuleToTempFile } from "./ast-cli.ts";
export { cleanupTempFile, writeRuleToTempFile };