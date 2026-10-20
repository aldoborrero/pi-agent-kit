import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkspaceSummary, gatherGitContext } from "./context.ts";
import { filterSuggestion } from "./text.ts";
import { buildSuggestionInput } from "./extension.ts";

let gitDir: string;
let plainDir: string;

function git(cwd: string, args: string): void {
	const proc = Bun.spawnSync(["git", ...args.split(" ")], { cwd, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(new TextDecoder().decode(proc.stderr));
}

beforeAll(() => {
	gitDir = mkdtempSync(join(tmpdir(), "suggest-git-"));
	plainDir = mkdtempSync(join(tmpdir(), "suggest-plain-"));
	git(gitDir, "init -b main");
	git(gitDir, 'config user.email test@example.com');
	git(gitDir, 'config user.name Test');
	writeFileSync(join(gitDir, "tracked.ts"), "const a = 1;\n");
	git(gitDir, "add tracked.ts");
	git(gitDir, "commit -m init");
	writeFileSync(join(gitDir, "modified.ts"), "const b = 2;\n");
	writeFileSync(join(gitDir, "untracked.txt"), "new\n");
});

afterAll(() => {
	rmSync(gitDir, { recursive: true, force: true });
	rmSync(plainDir, { recursive: true, force: true });
});

describe("gatherGitContext", () => {
	test("reports branch, counts, and porcelain sample in a dirty repo", async () => {
		const context = await gatherGitContext(gitDir);
		expect(context).not.toBeNull();
		expect(context!.branch).toBe("main");
		expect(context!.totalChanged).toBe(2); // 1 unstaged + 1 untracked
		expect(context!.changedSample.length).toBe(2);
		expect(context!.changedSample.some((line) => line.includes("modified.ts"))).toBe(true);
	});

	test("clean repo reports zero changes", async () => {
		// gitDir before the dirty files were created would be clean; simulate
		// by using a fresh repo with one commit and no changes.
		const clean = mkdtempSync(join(tmpdir(), "suggest-clean-"));
		try {
			git(clean, "init -b main");
			git(clean, "config user.email test@example.com");
			git(clean, "config user.name Test");
			writeFileSync(join(clean, "f.ts"), "x;\n");
			git(clean, "add f.ts");
			git(clean, "commit -m init");
			const context = await gatherGitContext(clean);
			expect(context!.totalChanged).toBe(0);
			expect(context!.changedSample).toEqual([]);
		} finally {
			rmSync(clean, { recursive: true, force: true });
		}
	});

	test("non-repo directory returns null", async () => {
		expect(await gatherGitContext(plainDir)).toBeNull();
	});
});

describe("buildWorkspaceSummary", () => {
	test("lists top-level entries", async () => {
		const summary = await buildWorkspaceSummary(gitDir);
		expect(summary).toContain("tracked.ts");
	});
});

describe("buildSuggestionInput with context", () => {
	const messages = [
		{ role: "user", content: "fix the failing test" },
		{ role: "assistant", content: "Fixed the assertion in tests/x.ts." },
	] as never[];

	test("includes git block when a context is provided", () => {
		const context = {
			branch: "main",
			staged: 0,
			unstaged: 2,
			untracked: 0,
			changedSample: [" M a.ts", " M b.ts"],
			totalChanged: 2,
		};
		const input = buildSuggestionInput(messages, gitDir, context, "tracked.ts, modified.ts");
		expect(input).toContain("Git: branch=main uncommitted=2 files");
		expect(input).toContain("Changed:  M a.ts");
		expect(input).toContain("Workspace: tracked.ts");
		expect(input).toContain("Recent conversation:");
	});

	test("clean git context shows working tree clean", () => {
		const input = buildSuggestionInput(messages, gitDir, {
			branch: "main",
			staged: 0,
			unstaged: 0,
			untracked: 0,
			changedSample: [],
			totalChanged: 0,
		}, null);
		expect(input).toContain("working tree clean");
		expect(input).not.toContain("Changed:");
	});
});

describe("conventional commit filter exemption", () => {
	test("conventional commit messages pass the labeled-response check", () => {
		expect(filterSuggestion("fix: add cancel-on-type").suggestion).toBe("fix: add cancel-on-type");
		expect(filterSuggestion("feat(pi-suggest): commit message suggestions").suggestion).toBe(
			"feat(pi-suggest): commit message suggestions",
		);
	});

	test("non-conventional labeled responses stay rejected", () => {
		expect(filterSuggestion("status: all good").reason).toContain("labeled response");
	});
});