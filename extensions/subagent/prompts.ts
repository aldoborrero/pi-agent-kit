/**
 * Prompt discovery and command registration
 *
 * Prompts are markdown files with YAML frontmatter that define
 * workflow templates for the subagent tool. They get registered
 * as slash commands for easy access.
 *
 * Example prompt file (prompts/explore.md):
 * ---
 * description: Fast codebase reconnaissance
 * ---
 * Use the subagent tool to run the "explore" agent with the following task: $@
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface PromptConfig {
	name: string;
	description: string;
	template: string;
	filePath: string;
}

interface ParsedFrontmatter {
	description?: string;
}

function parseFrontmatter(content: string): { frontmatter: ParsedFrontmatter; body: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) {
		return { frontmatter: {}, body: content };
	}

	const yaml = match[1];
	const body = content.slice(match[0].length).trimStart();

	const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim();
	return { frontmatter: { description }, body };
}

function loadPromptsFromDir(dir: string): PromptConfig[] {
	const prompts: PromptConfig[] = [];

	if (!fs.existsSync(dir)) {
		return prompts;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return prompts;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);
		const name = path.basename(entry.name, ".md");

		prompts.push({
			name,
			description: frontmatter.description || `Prompt: ${name}`,
			template: body,
			filePath,
		});
	}

	return prompts;
}

function findPromptsDirs(cwd: string): string[] {
	const dirs: string[] = [];

	// Walk up the directory tree looking for prompts directories
	let currentDir = cwd;
	const seen = new Set<string>();

	while (true) {
		// Check standard locations
		const candidates = [
			path.join(currentDir, "prompts"),
			path.join(currentDir, ".pi", "prompts"),
		];

		for (const candidate of candidates) {
			if (!seen.has(candidate) && fs.existsSync(candidate)) {
				try {
					const stat = fs.statSync(candidate);
					if (stat.isDirectory()) {
						dirs.push(candidate);
						seen.add(candidate);
					}
				} catch {
					// Ignore errors
				}
			}
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	return dirs;
}

export function discoverPrompts(cwd: string): PromptConfig[] {
	const promptDirs = findPromptsDirs(cwd);
	const promptMap = new Map<string, PromptConfig>();

	// Process directories in order (deeper first, so parent can override)
	for (const dir of promptDirs) {
		const prompts = loadPromptsFromDir(dir);
		for (const prompt of prompts) {
			// Later directories override earlier ones (closer to cwd wins)
			promptMap.set(prompt.name, prompt);
		}
	}

	return Array.from(promptMap.values());
}

export function formatPromptList(prompts: PromptConfig[], maxItems: number): { text: string; remaining: number } {
	if (prompts.length === 0) return { text: "none", remaining: 0 };
	const listed = prompts.slice(0, maxItems);
	const remaining = prompts.length - listed.length;
	return {
		text: listed.map((p) => `/${p.name} - ${p.description}`).join("\n"),
		remaining,
	};
}
