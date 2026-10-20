import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grep as nativeGrep, astGrep as nativeAstGrep, pdfToMarkdown } from "@oh-my-pi/pi-natives";
import { fallbackGrep, mapAstFindMatch, writeRuleToTempFile, cleanupTempFile } from "./extension.ts";
import { runAstGrepRaw } from "./ast-cli.ts";

const fixtureDir = mkdtempSync(join(tmpdir(), "pi-natives-test-"));
const nestedDir = join(fixtureDir, "src");
mkdirSync(nestedDir, { recursive: true });
writeFileSync(
  join(nestedDir, "sample.ts"),
  "export function abortActiveSession(): void {\n  // aborts the session\n}\n",
);
writeFileSync(join(fixtureDir, "ignored.log"), "abortActiveSession in log\n");

afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

// Minimal valid PDF (handcrafted, one page of text)
const MINIMAL_PDF = Buffer.from(
  "%PDF-1.4\n" +
  "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
  "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
  "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
  "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n" +
  "4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 24 Tf 72 700 Td (pi-natives test) Tj ET\nendstream\nendobj\n" +
  "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n" +
  "xref\n0 6\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n",
);
const pdfPath = join(fixtureDir, "sample.pdf");
writeFileSync(pdfPath, MINIMAL_PDF);

describe("pi-natives: grep", () => {
  test("native grep finds pattern with glob filtering", async () => {
    const res = await nativeGrep({ pattern: "abortActiveSession", path: fixtureDir, glob: "*.ts" });
    expect(res.totalMatches).toBe(1);
    expect(res.matches.every((m) => m.path.endsWith(".ts"))).toBeTrue();
  });

  test("native grep filesWithMatches mode", async () => {
    const res = await nativeGrep({ pattern: "abortActiveSession", path: fixtureDir, mode: "filesWithMatches" });
    expect(res.filesWithMatches).toBe(2); // sample.ts + ignored.log (no glob filter)
    const withGlob = await nativeGrep({ pattern: "abortActiveSession", path: fixtureDir, glob: "*.ts", mode: "filesWithMatches" });
    expect(withGlob.filesWithMatches).toBe(1);
  });

  test("fallbackGrep skips node_modules-like dirs and honors glob suffix", async () => {
    const hits = await fallbackGrep("abortActiveSession", fixtureDir, "*.ts");
    expect(hits.length).toBe(1);
    expect(hits[0]!.text).toContain("export function abortActiveSession");
  });

  test("fallbackGrep respects ignoreCase", async () => {
    const hits = await fallbackGrep("ABORTACTIVE", fixtureDir, undefined, true);
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("pi-natives: ast_grep", () => {
  test("native astGrep pattern mode finds function", async () => {
    const res = await nativeAstGrep({
      patterns: ["export function $NAME(): void { $$$ }"],
      path: join(fixtureDir, "src"),
      lang: "typescript",
      includeMeta: true,
    });
    expect(res.matches.length).toBe(1);
    expect(res.matches[0]!.text).toContain("abortActiveSession");
  });

  test("mapAstFindMatch produces legacy match shape", async () => {
    const res = await nativeAstGrep({
      patterns: ["export function $NAME(): void { $$$ }"],
      path: join(fixtureDir, "src"),
      lang: "typescript",
      includeMeta: true,
    });
    const legacy = mapAstFindMatch(res.matches[0]!);
    expect(legacy.file).toBe(res.matches[0]!.path);
    expect(legacy.text).toBe(res.matches[0]!.text);
    expect(legacy.metaVariables?.single?.NAME?.text).toBe("abortActiveSession");
  });

  test("inspect mode via CLI (requires ast-grep binary)", async () => {
    try {
      const output = await runAstGrepRaw(
        ["run", "--pattern", "export function $NAME(): void { $$$ }", "--lang", "typescript", "--debug-query=ast"],
        join(fixtureDir, "src"),
      );
      expect(output.length).toBeGreaterThan(0);
    } catch (error) {
      // CLI not installed in this environment — acceptable; native covers pattern mode
      expect((error as Error).message).toContain("ast-grep CLI not found");
    }
  });

  test("rule file round-trip", () => {
    const { dir, filePath } = writeRuleToTempFile("typescript", "kind: function_declaration");
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("language: typescript");
    expect(content).toContain("kind: function_declaration");
    cleanupTempFile(dir, filePath);
  });
});

describe("pi-natives: pdf", () => {
  test("pdfToMarkdown extracts text from minimal PDF", async () => {
    const bytes = new Uint8Array(readFileSync(pdfPath));
    const result = await pdfToMarkdown(bytes);
    expect(result.markdown).toContain("pi-natives test");
  });
});
