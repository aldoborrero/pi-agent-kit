/**
 * ast-grep CLI runner — fallback backend for rule/inspect modes and for
 * pattern queries the native engine can't express (multi-path, multi-glob).
 *
 * Ported from the retired extensions/pi-ast-grep extension so the tool
 * contract survives unchanged.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

export interface AstGrepMatch {
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
  ruleId?: string;
  severity?: string;
  message?: string;
  labels?: Array<{ text: string; style: string }>;
}

export interface AstGrepParams {
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

/** Indent every line of text by N spaces. */
function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

/** Write a YAML rule file to a temp directory. Returns { dir, filePath }. */
export function writeRuleToTempFile(
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
export function cleanupTempFile(dir: string, filePath: string): void {
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

function spawnAstGrep(
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string; enoent: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ast-grep", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr, enoent: false }));
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ code: null, stdout: "", stderr: "", enoent: true });
      } else {
        reject(err);
      }
    });
  });
}

const ENOENT_MESSAGE =
  "ast-grep CLI not found (needed for rule/inspect modes). Install from https://ast-grep.github.io";

/** Run ast-grep and parse JSON output into matches. */
export function runAstGrep(args: string[], cwd: string): Promise<AstGrepMatch[]> {
  return spawnAstGrep(args, cwd).then(({ code, stdout, stderr, enoent }) => {
    if (enoent) throw new Error(ENOENT_MESSAGE);
    if (code !== 0 && code !== 1) {
      throw new Error(stderr || `ast-grep exited with code ${code}`);
    }
    if (!stdout.trim()) return [];
    try {
      return JSON.parse(stdout) as AstGrepMatch[];
    } catch {
      throw new Error(`Failed to parse ast-grep output: ${stdout}`);
    }
  });
}

/** Run ast-grep and return raw string output (no JSON parsing). For inspect mode. */
export function runAstGrepRaw(args: string[], cwd: string): Promise<string> {
  return spawnAstGrep(args, cwd).then(({ code, stdout, stderr, enoent }) => {
    if (enoent) throw new Error(ENOENT_MESSAGE);
    if (code !== 0 && code !== 1) {
      throw new Error(stderr || `ast-grep exited with code ${code}`);
    }
    const combined = (stdout + "\n" + stderr).trim();
    return combined || "No output.";
  });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatResults(matches: AstGrepMatch[], showContext: boolean): string {
  if (matches.length === 0) return "No matches found.";

  const byFile = new Map<string, AstGrepMatch[]>();
  for (const match of matches) {
    const existing = byFile.get(match.file) || [];
    existing.push(match);
    byFile.set(match.file, existing);
  }

  let output = `Found ${matches.length} match(es) in ${byFile.size} file(s):\n\n`;

  for (const [file, fileMatches] of byFile) {
    output += `### ${file}\n\n`;

    for (const match of fileMatches) {
      const loc = `${match.range.start.line}:${match.range.start.column}`;

      if (match.ruleId && match.ruleId !== "ast-grep-search") {
        output += `**Line ${loc}** (rule: ${match.ruleId}`;
        if (match.severity) output += `, ${match.severity}`;
        output += ")\n";
      } else {
        output += `**Line ${loc}**\n`;
      }

      if (match.message) output += `> ${match.message}\n`;

      if (showContext) {
        output += "```\n" + match.lines.trimEnd() + "\n```\n";
      } else {
        output += "```\n" + match.text + "\n```\n";
      }

      const captures: string[] = [];
      if (match.metaVariables?.single) {
        for (const [k, v] of Object.entries(match.metaVariables.single)) {
          captures.push(`${k}=\`${v.text}\``);
        }
      }
      if (match.metaVariables?.multi) {
        for (const [k, v] of Object.entries(match.metaVariables.multi)) {
          captures.push(`${k}=[${v.map((x) => `\`${x.text}\``).join(", ")}]`);
        }
      }
      if (captures.length > 0) {
        output += `Captures: ${captures.join(", ")}\n`;
      }
      output += "\n";
    }
  }

  return output.trimEnd();
}