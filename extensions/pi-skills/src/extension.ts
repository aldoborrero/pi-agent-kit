/**
 * pi-skills — skill loader extension
 *
 * Registers a `read_skills` tool that lets the agent load any bundled skill's
 * full SKILL.md (or flat .md) by name. This is the safe "agent prompts itself"
 * pattern: the agent calls the tool explicitly; no autonomous injection.
 *
 * Also bundles the skills folder so pi auto-loads skill descriptions into the
 * system prompt at startup (names + descriptions only — full content on demand).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	directiveBlockReason,
	findCommandDirectives,
	replaceSpan,
	tokenizeCommand,
} from "./directive.ts";
import { once } from "./once.ts";
import { runArgv } from "./run.ts";

// Re-export the pure directive API so consumers can import from the package root.
export {
	type ClassificationHit,
	classify,
	type CommandDirective,
	directiveBlockReason,
	findCommandDirectives,
	hasShellMeta,
	replaceSpan,
	scanUnsafeDirectives,
	tokenizeCommand,
	type UnsafeDirective,
} from "./directive.ts";

export { runArgv, type RunOptions } from "./run.ts";

// ─── Skill resolution ─────────────────────────────────────────────────────────

/** Absolute path to this package's bundled skills/ directory. */
function skillsRoot(): string {
	const here = fileURLToPath(new URL(".", import.meta.url));
	return resolve(here, "..", "skills");
}

/** Absolute path to the user-level skills directory (~/.pi/agent/skills). */
function userSkillsRoot(): string {
	return join(homedir(), ".pi", "agent", "skills");
}

interface SkillEntry {
	name: string;
	/** Absolute path to the SKILL.md or flat .md file. */
	path: string;
}

/**
 * Scan a single skills root directory.
 * Supports two layouts:
 *   - flat:     skills/commit.md
 *   - subdir:   skills/commit/SKILL.md
 */
function scanSkillsDir(root: string): SkillEntry[] {
	if (!existsSync(root)) return [];

	const entries: SkillEntry[] = [];

	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			// Subdirectory layout: skills/<name>/SKILL.md
			const skillMd = join(root, entry.name, "SKILL.md");
			if (existsSync(skillMd)) {
				entries.push({ name: entry.name, path: skillMd });
			}
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			// Flat layout: skills/<name>.md
			const name = entry.name.replace(/\.md$/, "");
			entries.push({ name, path: join(root, entry.name) });
		}
	}

	return entries;
}

/**
 * Discover all skills from bundled skills/ AND ~/.pi/agent/skills/.
 * Bundled skills take precedence on name collision.
 * Results sorted alphabetically by name.
 */
function discoverSkills(): SkillEntry[] {
	const bundled = scanSkillsDir(skillsRoot());
	const user = scanSkillsDir(userSkillsRoot());

	// Merge: bundled wins on collision
	const seen = new Set(bundled.map((s) => s.name));
	const merged = [...bundled, ...user.filter((s) => !seen.has(s.name))];

	return merged.sort((a, b) => a.name.localeCompare(b.name));
}

/** Extract the `description` from YAML frontmatter, or null. */
export function extractDescription(content: string): string | null {
	const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!m) return null;
	const dm = m[1]!.match(/^description\s*:\s*["']?(.+?)["']?\s*$/m);
	return dm ? dm[1]!.trim() : null;
}

export function extractName(content: string): string | null {
	const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!m) return null;
	const nm = m[1]!.match(/^name\s*:\s*["']?(.+?)["']?\s*$/m);
	return nm ? nm[1]!.trim() : null;
}

// ─── Command directive interpolation ───────────────────────────────────────────

export type ArgvRunner = (argv: string[], cwd: string) => Promise<string>;
const defaultRunner: ArgvRunner = (argv, cwd) => runArgv(argv, { cwd });

function fence(output: string): string {
	return `\n\`\`\`\n${output}\n\`\`\`\n`;
}

/**
 * Expand !`cmd` directives in skill content. Policy (no prompt):
 *   - shell metachars → blocked
 *   - matches any dangerous command pattern → blocked
 *   - otherwise → run shell-free, inline output as a fenced block
 * Blocked directives are replaced with an inline [blocked: reason] marker so
 * the skill author can see and fix them. Splices right-to-left so earlier spans
 * stay valid as the string mutates.
 */
export async function interpolateSkill(
	content: string,
	cwd: string,
	run: ArgvRunner = defaultRunner,
): Promise<string> {
	const directives = findCommandDirectives(content);
	if (!directives.length) return content;

	const resolved = await Promise.all(
		directives.map(async (d) => {
			const reason = directiveBlockReason(d.command);
			if (reason) return { d, text: `[blocked: ${reason}]`, blocked: true };
			return {
				d,
				text: await run(tokenizeCommand(d.command), cwd),
				blocked: false,
			};
		}),
	);

	let out = content;
	for (let i = resolved.length - 1; i >= 0; i--) {
		const { d, text, blocked } = resolved[i]!;
		out = replaceSpan(out, d.start, d.end, blocked ? text : fence(text));
	}
	return out;
}

export type ThemeLike = {
	bold: (text: string) => string;
	fg: (key: "accent" | "muted" | "toolTitle", text: string) => string;
};

export function formatSkillSummary(text: string, theme: ThemeLike): string {
	const trimmed = text.trim();
	if (!trimmed) return theme.fg("muted", "No skills found.");

	const name = extractName(trimmed);
	const desc = extractDescription(trimmed);
	if (name) {
		return `${theme.fg("accent", theme.bold(name))} ${theme.fg("muted", desc ?? "(no description)")}`;
	}

	// List form: each skill is a single-token name followed by ": <desc>".
	// Lines without that exact shape (headers, blanks) pass through muted so
	// we don't mis-tint "Available skills (3):" as a skill entry.
	const lines = trimmed.split("\n");
	return lines
		.map((line) => {
			const match = line.match(/^(\S+):\s+(.+)$/);
			if (!match) return theme.fg("muted", line);
			return `${theme.fg("accent", theme.bold(match[1]!))} ${theme.fg("muted", match[2]!)}`;
		})
		.join("\n");
}

// ─── Tool registration ────────────────────────────────────────────────────────

const ParamsSchema = Type.Object({
	name: Type.Optional(
		Type.String({
			description:
				'Skill name, e.g. "commit", "debug". Omit to list all skills.',
		}),
	),
	full: Type.Optional(
		Type.Boolean({
			default: false,
			description:
				"When true, return the full SKILL.md content. When false (default), return the description only.",
		}),
	),
});

function registerSkillLoader(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read_skills",
		label: "Read Skills",
		description:
			"Browse and load bundled skills. No args → list all skills with descriptions. name only → description for that skill. name + full=true → full instructions.",
		promptSnippet: "Browse and load bundled skill instructions",
		promptGuidelines: [
			"Call read_skills() with no arguments to list all available skills and their descriptions.",
			"Call read_skills(name=<skill>) to read the description of a specific skill before deciding to load it.",
			"Call read_skills(name=<skill>, full=true) to load the full procedure for a skill before executing it.",
			"Prefer read_skills() over the read tool for skills — it resolves the correct path regardless of install location.",
		],
		executionMode: "sequential",
		parameters: ParamsSchema,

		async execute(_toolCallId, params, _signal, _upd, toolCtx) {
			const ok = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: undefined,
			});
			const fail = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: undefined,
				isError: true,
			});

			const { name, full } = params as { name?: string; full?: boolean };

			// No name → list all skills
			if (!name) {
				const skills = discoverSkills();
				if (!skills.length) return ok("No skills found.");

				const lines = skills.map((s) => {
					try {
						const content = readFileSync(s.path, "utf-8");
						const desc = extractDescription(content);
						return desc ? `${s.name}: ${desc}` : s.name;
					} catch {
						return s.name;
					}
				});

				return ok(
					`Available skills (${skills.length}):\n\n${lines.join("\n")}`,
				);
			}

			// Resolve skill
			const skills = discoverSkills();
			const entry = skills.find(
				(s) => s.name === name || s.name === name.replace(/\.md$/, ""),
			);

			if (!entry) {
				const names = skills.map((s) => s.name).join(", ");
				return fail(
					`Skill "${name}" not found. Available: ${names || "(none)"}`,
				);
			}

			try {
				const content = readFileSync(entry.path, "utf-8");

				// full=false (default) → description only
				if (!full) {
					const desc = extractDescription(content);
					return ok(
						desc ? `${entry.name}: ${desc}` : `${entry.name}: (no description)`,
					);
				}

				// full=true → interpolate !`cmd` directives (safety-gated, no
				// prompt; auto-deny on any rule match), then return.
				const cwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
				const expanded = await interpolateSkill(content, cwd);
				return ok(expanded);
			} catch (err) {
				return fail(
					`Failed to read skill "${name}": ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		},

		renderCall(args, theme) {
			const { name, full } = args as { name?: string; full?: boolean };
			const label = name ? `${name}${full ? " (full)" : ""}` : "list";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("read_skills"))} ${theme.fg("muted", label)}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const text = result.content
				?.filter((content) => content.type === "text")
				.map((content) => content.text || "")
				.join("\n");
			return new Text(formatSkillSummary(text ?? "", theme), 0, 0);
		},
	});
}

function registerResourcesDiscover(pi: ExtensionAPI): void {
	const root = skillsRoot();
	pi.on("resources_discover", () => ({
		skillPaths: existsSync(root) ? [root] : [],
	}));
}

export default function (pi: ExtensionAPI): void {
	once(pi, "pi-skills", () => {
		registerSkillLoader(pi);
		registerResourcesDiscover(pi);
	});
}
