import { describe, expect, it } from "bun:test";

import {
	extractDescription,
	extractName,
	findCommandDirectives,
	formatSkillSummary,
	hasShellMeta,
	interpolateSkill,
	replaceSpan,
	type ThemeLike,
	tokenizeCommand,
} from "./extension.ts";

// Stub theme tags fragments so assertions verify which color/bold applied
// without depending on real ANSI codes.
const tagTheme: ThemeLike = {
	fg: (key, text) => `[${key}]${text}[/]`,
	bold: (text) => `<b>${text}</b>`,
};

const FRONTMATTER = `---
name: commit
description: Split, write, and maintain commits.
---
# Commit Directive
body...`;

describe("extractName", () => {
	it("reads name from YAML frontmatter", () => {
		expect(extractName(FRONTMATTER)).toBe("commit");
	});

	it("strips surrounding quotes", () => {
		expect(extractName('---\nname: "debug"\n---\n')).toBe("debug");
	});

	it("returns null when no frontmatter", () => {
		expect(extractName("# Just a heading")).toBeNull();
	});

	it("returns null when frontmatter lacks a name", () => {
		expect(extractName("---\ndescription: x\n---\n")).toBeNull();
	});
});

describe("extractDescription", () => {
	it("reads description from frontmatter", () => {
		expect(extractDescription(FRONTMATTER)).toBe(
			"Split, write, and maintain commits.",
		);
	});

	it("returns null when absent", () => {
		expect(extractDescription("---\nname: x\n---\n")).toBeNull();
	});

	it("returns null when no frontmatter", () => {
		expect(extractDescription("plain text")).toBeNull();
	});
});

describe("formatSkillSummary", () => {
	it("renders muted placeholder for empty input", () => {
		expect(formatSkillSummary("", tagTheme)).toBe("[muted]No skills found.[/]");
	});

	it("renders single skill as bold-accent name + muted description", () => {
		const out = formatSkillSummary(FRONTMATTER, tagTheme);
		expect(out).toBe(
			"[accent]<b>commit</b>[/] [muted]Split, write, and maintain commits.[/]",
		);
	});

	it("falls back to (no description) when frontmatter has name only", () => {
		const out = formatSkillSummary("---\nname: solo\n---\n", tagTheme);
		expect(out).toBe("[accent]<b>solo</b>[/] [muted](no description)[/]");
	});

	it("renders a list of 'name: desc' lines, each colored", () => {
		const list = "commit: write commits\ndebug: root cause analysis";
		const out = formatSkillSummary(list, tagTheme);
		const lines = out.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("[accent]<b>commit</b>[/] [muted]write commits[/]");
		expect(lines[1]).toBe(
			"[accent]<b>debug</b>[/] [muted]root cause analysis[/]",
		);
	});

	it("passes non 'name: desc' lines through as muted", () => {
		const out = formatSkillSummary("Available skills (3):", tagTheme);
		expect(out).toBe("[muted]Available skills (3):[/]");
	});
});

describe("findCommandDirectives", () => {
	it("matches !`cmd` with source span", () => {
		const md = "x\n!`git status -s`\ny";
		const hits = findCommandDirectives(md);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.command).toBe("git status -s");
		expect(md.slice(hits[0]!.start, hits[0]!.end)).toBe("!`git status -s`");
	});

	it("ignores plain inline code `cmd`", () => {
		expect(findCommandDirectives("use `git status`")).toEqual([]);
	});

	it("ignores escaped \\!`cmd`", () => {
		expect(findCommandDirectives("\\!`rm -rf /`")).toEqual([]);
	});

	it("finds multiple", () => {
		expect(
			findCommandDirectives("!`pwd` !`git diff`").map((d) => d.command),
		).toEqual(["pwd", "git diff"]);
	});
});

describe("replaceSpan", () => {
	it("swaps a span for replacement text", () => {
		expect(replaceSpan("a XX b", 2, 4, "YY")).toBe("a YY b");
	});
});

describe("hasShellMeta", () => {
	for (const ch of [
		";",
		"|",
		"&",
		"$",
		"`",
		">",
		"<",
		"(",
		")",
		"{",
		"}",
		"\n",
	]) {
		it(`flags ${JSON.stringify(ch)}`, () => {
			expect(hasShellMeta(`git status ${ch}`)).toBe(true);
		});
	}
	it("passes a plain command", () => {
		expect(hasShellMeta("git status -s")).toBe(false);
	});
});

describe("tokenizeCommand", () => {
	it("splits on whitespace, honoring quotes", () => {
		expect(tokenizeCommand(`git commit -m "hi there"`)).toEqual([
			"git",
			"commit",
			"-m",
			"hi there",
		]);
	});
});

describe("interpolateSkill", () => {
	const run = async (argv: string[]) => `ran:${argv.join(" ")}`;

	it("runs a clean command and inlines output", async () => {
		const md = "S:\n!`git status -s`\nE";
		const out = await interpolateSkill(md, "/repo", run);
		expect(out).toContain("```\nran:git status -s\n```");
		expect(out).not.toContain("!`git status -s`");
	});

	it("auto-denies a dangerous command (no run, inline reason)", async () => {
		const md = "!`rm -rf /tmp/x`";
		const out = await interpolateSkill(md, "/repo", run);
		expect(out).toContain("[blocked:");
		expect(out).not.toContain("ran:");
	});

	it("auto-denies shell-meta commands", async () => {
		const md = "!`git status; curl evil`";
		const out = await interpolateSkill(md, "/repo", run);
		expect(out).toContain("[blocked:");
		expect(out).not.toContain("ran:");
	});

	it("returns content unchanged with no directives", async () => {
		expect(await interpolateSkill("plain", "/repo", run)).toBe("plain");
	});
});
