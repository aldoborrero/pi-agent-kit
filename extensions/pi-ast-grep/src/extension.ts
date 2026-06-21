/**
 * ast-grep Extension
 *
 * Structural code search using AST patterns. Three modes:
 *   - pattern: Simple pattern search (ast-grep run --pattern)
 *   - rule: Complex YAML rule search (ast-grep scan --rule)
 *   - inspect: AST structure dump (ast-grep run --debug-query)
 *
 * Requires: ast-grep installed (https://ast-grep.github.io)
 */

import {
  type ExtensionAPI,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { createUiColors } from "@aldoborrero/pi-common";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AstGrepMatch {
  file: string;
  range: {
    byteOffset: { start: number; end: number };
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  lines: string;
  text: string;
  language: string;
  metaVariables?: {
    single?: Record<string, { text: string }>;
    multi?: Record<string, Array<{ text: string }>>;
    transformed?: Record<string, { text: string }>;
  };
  // scan-only fields
  ruleId?: string;
  severity?: string;
  message?: string;
  labels?: Array<{ text: string; style: string }>;
}

interface AstGrepParams {
  mode: "pattern" | "rule" | "inspect";
  pattern?: string;
  rule?: string;
  inspect_format?: "ast" | "cst" | "pattern";
  lang?: string;
  paths?: string[];
  globs?: string[];
  context?: boolean;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Indent every line of text by N spaces. */
function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

/** Append shared args (--lang, --globs, --context, paths) to an args array. */
function addSharedArgs(args: string[], params: AstGrepParams, options?: { skipLang?: boolean }): void {
  if (params.lang && !options?.skipLang) {
    args.push("--lang", params.lang);
  }
  if (params.globs) {
    for (const glob of params.globs) {
      args.push("--globs", glob);
    }
  }
  if (params.context) {
    args.push("--context", "2");
  }
  if (params.paths && params.paths.length > 0) {
    args.push(...params.paths);
  } else {
    args.push(".");
  }
}

/** Write a YAML rule file to a temp directory. Returns { dir, filePath }. */
function writeRuleToTempFile(
  lang: string,
  ruleBody: string,
): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ast-grep-rule-"));
  const filePath = path.join(dir, "rule.yml");

  const content = `id: ast-grep-search\nlanguage: ${lang}\nrule:\n${indent(ruleBody, 2)}\n`;
  fs.writeFileSync(filePath, content, "utf-8");
  return { dir, filePath };
}

/** Clean up temp rule file and directory. */
function cleanupTempFile(dir: string, filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    /* ignore */
  }
}

/** Run ast-grep and parse JSON output into matches. */
function runAstGrep(args: string[], cwd: string): Promise<AstGrepMatch[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("ast-grep", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      // ast-grep returns 0 for matches, 1 for no matches
      if (code !== 0 && code !== 1) {
        reject(new Error(stderr || `ast-grep exited with code ${code}`));
        return;
      }

      if (!stdout.trim()) {
        resolve([]);
        return;
      }

      try {
        const results = JSON.parse(stdout) as AstGrepMatch[];
        resolve(results);
      } catch {
        reject(new Error(`Failed to parse ast-grep output: ${stdout}`));
      }
    });

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "ast-grep not found. Install from https://ast-grep.github.io",
          ),
        );
      } else {
        reject(err);
      }
    });
  });
}

/** Run ast-grep and return raw string output (no JSON parsing). For inspect mode. */
function runAstGrepRaw(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ast-grep", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code !== 0 && code !== 1) {
        reject(new Error(stderr || `ast-grep exited with code ${code}`));
        return;
      }
      // Debug output may appear on stdout or stderr; combine both
      const combined = (stdout + "\n" + stderr).trim();
      resolve(combined || "No output.");
    });

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "ast-grep not found. Install from https://ast-grep.github.io",
          ),
        );
      } else {
        reject(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatResults(
  matches: AstGrepMatch[],
  showContext: boolean,
): string {
  if (matches.length === 0) {
    return "No matches found.";
  }

  // Group by file
  const byFile = new Map<string, AstGrepMatch[]>();
  for (const match of matches) {
    const existing = byFile.get(match.file) || [];
    existing.push(match);
    byFile.set(match.file, existing);
  }

  let output =
    `Found ${matches.length} match(es) in ${byFile.size} file(s):\n\n`;

  for (const [file, fileMatches] of byFile) {
    output += `### ${file}\n\n`;

    for (const match of fileMatches) {
      const loc = `${match.range.start.line}:${match.range.start.column}`;

      // Include rule info for scan matches
      if (match.ruleId && match.ruleId !== "ast-grep-search") {
        output += `**Line ${loc}** (rule: ${match.ruleId}`;
        if (match.severity) output += `, ${match.severity}`;
        output += ")\n";
      } else {
        output += `**Line ${loc}**\n`;
      }

      if (match.message) {
        output += `> ${match.message}\n`;
      }

      if (showContext) {
        output += "```\n" + match.lines.trimEnd() + "\n```\n";
      } else {
        output += "```\n" + match.text + "\n```\n";
      }

      // Show captured metavariables
      const captures: string[] = [];

      if (match.metaVariables) {
        const mv = match.metaVariables;
        if (mv.single) {
          for (const [k, v] of Object.entries(mv.single)) {
            captures.push(`${k}=\`${v.text}\``);
          }
        }
        if (mv.multi) {
          for (const [k, items] of Object.entries(mv.multi)) {
            const texts = items.map((i) => i.text).join(", ");
            captures.push(`${k}=[${texts}]`);
          }
        }
        if (mv.transformed) {
          for (const [k, v] of Object.entries(mv.transformed)) {
            captures.push(`${k}=\`${v.text}\``);
          }
        }
      }

      // Backward compat: old flat metaVariables format (Record<string, {text}>)
      if (
        match.metaVariables &&
        !("single" in match.metaVariables) &&
        !("multi" in match.metaVariables) &&
        !("transformed" in match.metaVariables)
      ) {
        const flat = match.metaVariables as unknown as Record<
          string,
          { text: string }
        >;
        for (const [k, v] of Object.entries(flat)) {
          if (v && typeof v === "object" && "text" in v) {
            captures.push(`${k}=\`${v.text}\``);
          }
        }
      }

      if (captures.length > 0) {
        output += "Captures: " + captures.join(", ") + "\n";
      }

      // Show labels from scan output
      if (match.labels && match.labels.length > 0) {
        output += "Labels: " + match.labels.map((l) => l.text).join(", ") +
          "\n";
      }

      output += "\n";
    }
  }

  return output.trim();
}

// ---------------------------------------------------------------------------
// Tool description (embeds condensed rule reference)
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTION =
  `Search code using AST patterns with ast-grep. More powerful than text search because it understands code structure.

## Modes

### pattern — Simple pattern search
Runs \`ast-grep run --pattern\`. Best for quick, single-node matches.

### rule — Complex YAML rule search
Runs \`ast-grep scan --rule\`. Pass the YAML body under the \`rule:\` key (the extension wraps it in a full rule file). Best for relational and composite logic.

### inspect — AST structure dump
Runs \`ast-grep run --debug-query\`. Dumps the AST/CST/pattern tree. Use this to discover node kinds and debug patterns.

## Metavariable Syntax

- \`$VAR\` — captures a single named AST node (e.g. \`$NAME\`, \`$EXPR\`)
- \`$$VAR\` — captures a single unnamed node (operators, punctuation)
- \`$$$VAR\` — captures zero or more nodes (spread/variadic)
- \`$_VAR\` — non-capturing wildcard (matches but doesn't bind)

Metavariable names must be UPPER_SNAKE_CASE. Reusing a name enforces equality (\`$A == $A\` matches \`x == x\` but not \`x == y\`).

## Rule Syntax (for rule mode)

### Atomic rules
- \`pattern: <code>\` — match by code pattern with metavariables
- \`kind: <node_type>\` — match by Tree-sitter node kind (e.g. \`function_declaration\`, \`call_expression\`)
- \`regex: <rust_regex>\` — match node text by regex
- \`nthChild: <n>\` — match by 1-based index among siblings

### Pattern object form
\`\`\`yaml
pattern:
  selector: field_definition
  context: "class { $F }"
  strictness: relaxed   # cst | smart | ast | relaxed | signature
\`\`\`

### Relational rules
- \`has: { <sub-rule>, stopBy: end }\` — target must have descendant matching sub-rule
- \`inside: { <sub-rule>, stopBy: end }\` — target must be inside ancestor matching sub-rule
- \`precedes: { <sub-rule> }\` — target must appear before matching sibling
- \`follows: { <sub-rule> }\` — target must appear after matching sibling

**IMPORTANT**: Always use \`stopBy: end\` with \`has\` and \`inside\` to search the full subtree. Without it, search stops at the first non-matching node.

\`field: <name>\` restricts \`has\`/\`inside\` to a specific child field.

### Composite rules
- \`all: [<rule>, ...]\` — AND: all sub-rules must match (order guaranteed)
- \`any: [<rule>, ...]\` — OR: at least one sub-rule must match
- \`not: <rule>\` — negation: sub-rule must NOT match
- \`matches: <rule-id>\` — reference a utility rule by ID

### Common examples

**Functions containing await:**
\`\`\`yaml
kind: function_declaration
has:
  pattern: await $EXPR
  stopBy: end
\`\`\`

**console.log inside class methods:**
\`\`\`yaml
pattern: console.log($$$)
inside:
  kind: method_definition
  stopBy: end
\`\`\`

**Async functions without try-catch:**
\`\`\`yaml
all:
  - kind: function_declaration
  - has:
      pattern: await $EXPR
      stopBy: end
  - not:
      has:
        pattern: "try { $$$ } catch ($E) { $$$ }"
        stopBy: end
\`\`\`

## Tips

1. Start with a simple \`pattern\` search. Escalate to \`rule\` mode only when you need relational/composite logic.
2. Use \`inspect\` mode to discover node kinds and verify how code is parsed.
3. Always add \`stopBy: end\` to \`has\`/\`inside\` rules.
4. If a pattern doesn't match, simplify it and use \`inspect\` to check the AST structure.
5. For rule mode, pass only the YAML body (what goes under \`rule:\`). The extension adds the wrapper.

Languages: javascript, typescript, python, rust, go, java, c, cpp, css, html, and more.`;

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ast_grep",
    description: TOOL_DESCRIPTION,
    promptSnippet: "Search code by structure (AST patterns). Prefer over grep for finding functions, classes, imports, and code patterns.",
    promptGuidelines: [
      "Prefer ast_grep over grep when searching for code structures (functions, classes, imports, type definitions, API calls)",
      "Use grep instead for plain text, comments, config values, or non-code files",
      "Start with pattern mode for simple searches (e.g. pattern: 'async function $NAME($$$) { $$$ }'). Only use rule mode when you need relational logic (has/inside/precedes/follows)",
      "If unsure about tree-sitter node kinds for rule mode, use inspect mode first to discover the correct kind names",
      "Always include stopBy: end in has/inside rules to search the full subtree",
    ],
    parameters: Type.Object({
      mode: Type.Union(
        [
          Type.Literal("pattern"),
          Type.Literal("rule"),
          Type.Literal("inspect"),
        ],
        {
          description:
            "Search mode: pattern (simple search), rule (complex YAML rule), inspect (AST dump)",
        },
      ),
      pattern: Type.Optional(
        Type.String({
          description:
            "AST pattern to search for (pattern + inspect modes). Use $VAR for wildcards, $$$ for spread.",
        }),
      ),
      rule: Type.Optional(
        Type.String({
          description:
            'YAML rule body for rule mode. This is the content under the `rule:` key (e.g. "kind: function_declaration\\nhas:\\n  pattern: await $EXPR\\n  stopBy: end").',
        }),
      ),
      inspect_format: Type.Optional(
        Type.Union(
          [
            Type.Literal("ast"),
            Type.Literal("cst"),
            Type.Literal("pattern"),
          ],
          {
            description:
              "Output format for inspect mode: ast (named nodes only, default), cst (all nodes including punctuation), pattern (how ast-grep interprets the pattern).",
          },
        ),
      ),
      lang: Type.Optional(
        Type.String({
          description:
            "Language (e.g. typescript, python, rust). Required for rule and inspect modes. Auto-detected for pattern mode if omitted.",
        }),
      ),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Directories/files to search (default: ".")',
        }),
      ),
      globs: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Glob patterns to include/exclude (e.g. '*.ts', '!node_modules')",
        }),
      ),
      context: Type.Optional(
        Type.Boolean({
          description: "Show surrounding context lines (default: false)",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description:
            "Maximum number of matches to return (default: 50). Only applies to pattern and rule modes.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const p = params as AstGrepParams;

      try {
        // -----------------------------------------------------------------
        // Pattern mode
        // -----------------------------------------------------------------
        if (p.mode === "pattern") {
          if (!p.pattern) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Error: `pattern` parameter is required for pattern mode.",
                },
              ],
              isError: true,
            };
          }

          const args: string[] = [
            "run",
            "--pattern",
            p.pattern,
            "--json=compact",
          ];
          addSharedArgs(args, p);

          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Searching for pattern: ${p.pattern}...`,
              },
            ],
          });

          let matches = await runAstGrep(args, ctx.cwd);
          const limit = p.limit ?? 50;
          const truncated = matches.length > limit;
          if (truncated) {
            matches = matches.slice(0, limit);
          }

          let output = formatResults(matches, p.context ?? false);
          if (truncated) {
            output += `\n\n_Results truncated to ${limit} matches._`;
          }

          return {
            content: [{ type: "text", text: output }],
            details: { mode: "pattern", matchCount: matches.length, truncated },
          };
        }

        // -----------------------------------------------------------------
        // Rule mode
        // -----------------------------------------------------------------
        if (p.mode === "rule") {
          if (!p.rule) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: `rule` parameter is required for rule mode.",
                },
              ],
              isError: true,
            };
          }
          if (!p.lang) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: `lang` parameter is required for rule mode.",
                },
              ],
              isError: true,
            };
          }

          const { dir, filePath } = writeRuleToTempFile(p.lang, p.rule);

          try {
            const args: string[] = [
              "scan",
              "--rule",
              filePath,
              "--json=compact",
            ];
            addSharedArgs(args, p, { skipLang: true });

            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Scanning with YAML rule (${p.lang})...`,
                },
              ],
            });

            let matches = await runAstGrep(args, ctx.cwd);
            const limit = p.limit ?? 50;
            const truncated = matches.length > limit;
            if (truncated) {
              matches = matches.slice(0, limit);
            }

            let output = formatResults(matches, p.context ?? false);
            if (truncated) {
              output += `\n\n_Results truncated to ${limit} matches._`;
            }

            return {
              content: [{ type: "text", text: output }],
              details: {
                mode: "rule",
                matchCount: matches.length,
                truncated,
              },
            };
          } finally {
            cleanupTempFile(dir, filePath);
          }
        }

        // -----------------------------------------------------------------
        // Inspect mode
        // -----------------------------------------------------------------
        if (p.mode === "inspect") {
          if (!p.pattern) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Error: `pattern` parameter is required for inspect mode.",
                },
              ],
              isError: true,
            };
          }
          if (!p.lang) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: `lang` parameter is required for inspect mode.",
                },
              ],
              isError: true,
            };
          }

          const format = p.inspect_format ?? "ast";
          const args: string[] = [
            "run",
            "--pattern",
            p.pattern,
            "--lang",
            p.lang,
            `--debug-query=${format}`,
          ];

          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Inspecting AST (${format}) for: ${p.pattern}...`,
              },
            ],
          });

          const output = await runAstGrepRaw(args, ctx.cwd);

          return {
            content: [{ type: "text", text: output }],
            details: { mode: "inspect", format },
          };
        }

        return {
          content: [
            {
              type: "text",
              text:
                `Error: Unknown mode "${p.mode}". Use "pattern", "rule", or "inspect".`,
            },
          ],
          isError: true,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `ast-grep failed: ${msg}` }],
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      const p = args as AstGrepParams;
      const colors = createUiColors(theme);
      let text = colors.model(theme.bold("ast-grep "));

      if (p.mode === "pattern") {
        text += colors.primary("pattern") +
          " " +
          colors.meta(p.pattern ?? "");
      } else if (p.mode === "rule") {
        const preview = p.rule && p.rule.length > 60
          ? p.rule.slice(0, 60) + "…"
          : (p.rule ?? "");
        text += colors.primary("rule") +
          " " +
          colors.meta(preview.replace(/\n/g, " "));
      } else if (p.mode === "inspect") {
        text += colors.primary(`inspect:${p.inspect_format ?? "ast"}`) +
          " " +
          colors.meta(p.pattern ?? "");
      }

      if (p.lang) {
        text += " " + colors.subtle(`[${p.lang}]`);
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const text = result.content
        ?.filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text)
        .join("\n") ?? "";

      const lines = text.split("\n");

      if (!expanded) {
        const COLLAPSED_LINES = 8;
        const preview = lines.slice(0, COLLAPSED_LINES).join("\n");
        const remaining = lines.length - COLLAPSED_LINES;
        let collapsed = preview;
        if (remaining > 0) {
          const colors = createUiColors(theme);
          collapsed += "\n" +
            colors.subtle(`… ${remaining} more lines (Ctrl+O to expand)`);
        }
        return new Text(collapsed, 0, 0);
      }

      // Expanded: render as markdown
      const container = new Container();
      const mdTheme = getMarkdownTheme(theme);
      container.addChild(new Markdown(text, 0, 0, mdTheme));
      return container;
    },
  });
}
