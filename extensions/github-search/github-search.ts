import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";

// ── Shared helpers ───────────────────────────────────────────────────────────

function runGh(subcommand: string[], jsonFields: string): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		const child = spawn("gh", [...subcommand, "--json", jsonFields], {
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(stderr || `gh exited with code ${code}`));
				return;
			}
			try {
				resolve(JSON.parse(stdout) as unknown[]);
			} catch {
				reject(new Error(`Failed to parse gh output: ${stdout}`));
			}
		});

		child.on("error", (err) => { reject(err); });
	});
}

function handleGhError(msg: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
	if (msg.includes("gh: command not found") || msg.includes("ENOENT")) {
		return {
			content: [{ type: "text", text: "GitHub CLI (gh) not installed. Get it at https://cli.github.com/" }],
			isError: true,
		};
	}
	if (msg.includes("not logged in") || msg.includes("auth login")) {
		return {
			content: [{ type: "text", text: "Not authenticated. Run `gh auth login`." }],
			isError: true,
		};
	}
	return {
		content: [{ type: "text", text: `GitHub search failed: ${msg}` }],
		isError: true,
	};
}

// ── Code search ──────────────────────────────────────────────────────────────

interface CodeResult {
	path: string;
	repository: { fullName: string };
	url: string;
	textMatches: Array<{ fragment: string }>;
}

function formatCodeResults(results: CodeResult[]): string {
	if (results.length === 0) return "No results found.";

	const lines: string[] = [`Found ${results.length} result(s):\n`];
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		lines.push(`### ${i + 1}. ${r.repository.fullName}/${r.path}`);
		lines.push(`**URL:** ${r.url}`);
		if (r.textMatches?.length) {
			for (const match of r.textMatches) {
				const fragment = match.fragment?.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
				if (fragment) lines.push("```\n" + fragment + "\n```");
			}
		}
		lines.push("");
	}
	return lines.join("\n").trim();
}

// ── Issue/PR search ──────────────────────────────────────────────────────────

interface IssueResult {
	number: number;
	title: string;
	state: string;
	url: string;
	author: { login: string };
	labels: Array<{ name: string }>;
	createdAt: string;
	updatedAt: string;
	comments: number;
	body?: string;
}

function formatIssueResults(results: IssueResult[], kind: string): string {
	if (results.length === 0) return `No ${kind} found.`;

	const lines: string[] = [`Found ${results.length} ${kind}:\n`];
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const state = r.state === "open" ? "OPEN" : "CLOSED";
		const labels = r.labels?.length ? r.labels.map((l) => l.name).join(", ") : "";
		const age = r.createdAt?.slice(0, 10) ?? "";

		lines.push(`### ${i + 1}. #${r.number} ${r.title}`);
		lines.push(`**State:** ${state} | **Author:** ${r.author?.login ?? "?"} | **Date:** ${age} | **Comments:** ${r.comments}`);
		if (labels) lines.push(`**Labels:** ${labels}`);
		lines.push(`**URL:** ${r.url}`);

		if (r.body) {
			const snippet = r.body.length > 300 ? r.body.slice(0, 300) + "..." : r.body;
			lines.push(`\n${snippet}`);
		}
		lines.push("");
	}
	return lines.join("\n").trim();
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Code search
	pi.registerTool({
		name: "github_search_code",
		description: "Search code across GitHub repositories via gh CLI. Find usage examples, implementations, and configuration patterns.",
		promptGuidelines: [
			"Use github_search_code to find how others implement specific patterns or use specific APIs",
			"Use the repo parameter to search within a specific repository",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query (e.g., 'useState lang:typescript', 'filename:flake.nix nixpkgs')" }),
			language: Type.Optional(Type.String({ description: "Filter by language (e.g., 'python', 'typescript')" })),
			owner: Type.Optional(Type.String({ description: "Filter by repo owner (e.g., 'nixos')" })),
			repo: Type.Optional(Type.String({ description: "Filter by repo (e.g., 'nixos/nixpkgs')" })),
			extension: Type.Optional(Type.String({ description: "Filter by file extension (e.g., 'ts', 'nix')" })),
			filename: Type.Optional(Type.String({ description: "Filter by filename (e.g., 'flake.nix')" })),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 10, max: 100)" })),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
			try {
				const args = ["search", "code", params.query];
				if (params.language) args.push("--language", params.language);
				if (params.owner) args.push("--owner", params.owner);
				if (params.repo) args.push("--repo", params.repo);
				if (params.extension) args.push("--extension", params.extension);
				if (params.filename) args.push("--filename", params.filename);
				args.push("--limit", String(Math.min(params.limit ?? 10, 100)));

				onUpdate?.({ content: [{ type: "text", text: `Searching GitHub code: ${params.query}...` }] });

				const results = await runGh(args, "path,repository,url,textMatches") as CodeResult[];
				return { content: [{ type: "text", text: formatCodeResults(results) }] };
			} catch (e) {
				return handleGhError(e instanceof Error ? e.message : String(e));
			}
		},
	});

	// Issue search
	pi.registerTool({
		name: "github_search_issues",
		description: "Search GitHub issues. Find bugs, feature requests, discussions, and known problems in repositories.",
		promptGuidelines: [
			"Use github_search_issues to find known bugs, error reports, or feature requests",
			"Use the repo parameter to search within a specific repository",
			"Use state to filter open or closed issues",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query (e.g., 'memory leak', 'segfault in parser')" }),
			repo: Type.Optional(Type.String({ description: "Filter by repo (e.g., 'badlogic/pi-mono')" })),
			owner: Type.Optional(Type.String({ description: "Filter by repo owner" })),
			state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")], { description: "Filter by state" })),
			label: Type.Optional(Type.String({ description: "Filter by label (e.g., 'bug', 'enhancement')" })),
			sort: Type.Optional(Type.Union(
				[Type.Literal("created"), Type.Literal("updated"), Type.Literal("comments"), Type.Literal("reactions")],
				{ description: "Sort order (default: created)" },
			)),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 10, max: 100)" })),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
			try {
				const args = ["search", "issues", params.query, "--type=issue"];
				if (params.repo) args.push("--repo", params.repo);
				if (params.owner) args.push("--owner", params.owner);
				if (params.state) args.push("--state", params.state);
				if (params.label) args.push("--label", params.label);
				if (params.sort) args.push("--sort", params.sort);
				args.push("--limit", String(Math.min(params.limit ?? 10, 100)));

				onUpdate?.({ content: [{ type: "text", text: `Searching GitHub issues: ${params.query}...` }] });

				const results = await runGh(args, "number,title,state,url,author,labels,createdAt,updatedAt,comments,body") as IssueResult[];
				return { content: [{ type: "text", text: formatIssueResults(results, "issues") }] };
			} catch (e) {
				return handleGhError(e instanceof Error ? e.message : String(e));
			}
		},
	});

	// PR search
	pi.registerTool({
		name: "github_search_prs",
		description: "Search GitHub pull requests. Find related PRs, implementations, and code changes across repositories.",
		promptGuidelines: [
			"Use github_search_prs to find related implementations or how others solved similar problems",
			"Use state:merged to find accepted solutions",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query (e.g., 'fix auth token refresh')" }),
			repo: Type.Optional(Type.String({ description: "Filter by repo (e.g., 'badlogic/pi-mono')" })),
			owner: Type.Optional(Type.String({ description: "Filter by repo owner" })),
			state: Type.Optional(Type.Union(
				[Type.Literal("open"), Type.Literal("closed"), Type.Literal("merged")],
				{ description: "Filter by state" },
			)),
			label: Type.Optional(Type.String({ description: "Filter by label" })),
			sort: Type.Optional(Type.Union(
				[Type.Literal("created"), Type.Literal("updated"), Type.Literal("comments"), Type.Literal("reactions")],
				{ description: "Sort order (default: created)" },
			)),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 10, max: 100)" })),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
			try {
				const args = ["search", "prs", params.query];
				if (params.repo) args.push("--repo", params.repo);
				if (params.owner) args.push("--owner", params.owner);
				if (params.state) args.push("--state", params.state);
				if (params.label) args.push("--label", params.label);
				if (params.sort) args.push("--sort", params.sort);
				args.push("--limit", String(Math.min(params.limit ?? 10, 100)));

				onUpdate?.({ content: [{ type: "text", text: `Searching GitHub PRs: ${params.query}...` }] });

				const results = await runGh(args, "number,title,state,url,author,labels,createdAt,updatedAt,comments,body") as IssueResult[];
				return { content: [{ type: "text", text: formatIssueResults(results, "pull requests") }] };
			} catch (e) {
				return handleGhError(e instanceof Error ? e.message : String(e));
			}
		},
	});
}
