import { describe, expect, test } from "bun:test";
import { extractJsonArrayText, filterSuggestion, parseSuggestionArray } from "./text.ts";

describe("filterSuggestion", () => {
	test("rejects empty and blank output", () => {
		expect(filterSuggestion(null).reason).toBe("model returned empty output");
		expect(filterSuggestion("").reason).toBe("model returned empty output");
		expect(filterSuggestion("   ").reason).toBe("model returned blank output");
	});

	test("accepts normal suggestions trimmed", () => {
		const result = filterSuggestion("  run the tests  ");
		expect(result.suggestion).toBe("run the tests");
		expect(result.reason).toBeNull();
	});

	test("single word: allowlist passes, unknown fails", () => {
		expect(filterSuggestion("commit").suggestion).toBe("commit");
		expect(filterSuggestion("/compact").suggestion).toBe("/compact"); // slash commands pass
		expect(filterSuggestion("banana").reason).toBe("single-word suggestion not allowlisted");
	});

	test("rejects over 12 words and over 100 chars", () => {
		expect(filterSuggestion("a b c d e f g h i j k l m").reason).toBe("suggestion exceeded 12 words");
		// 2 words (passes the single-word gate), 101 chars -> length limit fires.
		expect(filterSuggestion(`${"x".repeat(50)} ${"y".repeat(50)}`).reason).toBe("suggestion exceeded 100 characters");
		expect(filterSuggestion("run the full test suite for the auth module").suggestion).toBe("run the full test suite for the auth module");
	});

	test("rejects assistant voice and evaluative filler", () => {
		expect(filterSuggestion("Let me check the logs").reason).toContain("assistant voice");
		expect(filterSuggestion("I'll fix that next").reason).toContain("assistant voice");
		expect(filterSuggestion("Sure, right away").reason).toContain("assistant voice");
		expect(filterSuggestion("run tests, thanks").reason).toContain("evaluative filler");
		expect(filterSuggestion("deploy now!").reason).toBeNull(); // not filler, punctuation is fine
		expect(filterSuggestion("looks good").reason).toContain("evaluative filler");
	});

	test("rejects structured prose that is not a user prompt", () => {
		expect(filterSuggestion("status: done").reason).toContain("labeled response");
		expect(filterSuggestion("(option one)").reason).toContain("wrapped in brackets");
		expect(filterSuggestion("* bullet").reason).toContain("newline or markdown");
		expect(filterSuggestion("- dash list").suggestion).toBe("- dash list"); // dash bullets not covered (documented gap)
		expect(filterSuggestion("First sentence. Second one").reason).toContain("multiple sentences");
	});

	test("rejects explicit model decline", () => {
		expect(filterSuggestion("NO SUGGESTION").reason).toContain("declined to suggest");
	});
});

describe("parseSuggestionArray", () => {
	test("parses a plain JSON array with dedupe and cap at 3", () => {
		const result = parseSuggestionArray('["run tests","run tests","RUN TESTS","commit","push","deploy"]');
		expect(result.suggestions).toEqual(["run tests", "commit", "push"]);
		expect(result.reason).toBeNull();
	});

	test("extracts arrays fenced in markdown", () => {
		const result = parseSuggestionArray('```json\n["fix the build"]\n```');
		expect(result.suggestions).toEqual(["fix the build"]);
	});

	test("extracts arrays embedded in prose", () => {
		const result = parseSuggestionArray('Here are options: ["commit now", "review diff"] hope it helps');
		expect(result.suggestions).toEqual(["commit now", "review diff"]);
	});

	test("skips non-string items and applies filtering per item", () => {
		const result = parseSuggestionArray('[42,"banana","commit now"]');
		// 42 skipped (non-string), "banana" filtered (unknown single word)
		expect(result.suggestions).toEqual(["commit now"]);
		expect(result.reason).toBeNull(); // at least one survived
	});

	test("reports filter reason when everything is filtered", () => {
		const result = parseSuggestionArray('["Let me check"]');
		expect(result.suggestions).toEqual([]);
		expect(result.reason).toContain("assistant voice");
	});

	test("invalid JSON and missing arrays produce reasons", () => {
		expect(parseSuggestionArray("not json at all").reason).toBe("model did not return a JSON array");
		expect(parseSuggestionArray('{"a":1}').reason).toBe("model did not return a JSON array");
		expect(parseSuggestionArray('["unclosed').reason).toBe("model did not return a JSON array"); // no closing bracket -> not extracted
		expect(parseSuggestionArray(null).reason).toBe("model returned empty output");
	});
});

describe("extractJsonArrayText", () => {
	test("finds first [ and last ]", () => {
		expect(extractJsonArrayText('x ["a","b"] y')).toBe('["a","b"]');
		expect(extractJsonArrayText('[[1],[2]]')).toBe("[[1],[2]]");
	});

	test("returns null without a bracket pair", () => {
		expect(extractJsonArrayText("no brackets")).toBeNull();
		expect(extractJsonArrayText("] reversed [")).toBeNull();
	});
});
