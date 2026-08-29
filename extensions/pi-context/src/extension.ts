/**
 * /context
 *
 * Small dashboard showing what Pi has loaded and how the active context is used.
 * This version reads Pi's current command context instead of rediscovering
 * AGENTS/CLAUDE files itself, so it follows current resource loading behavior
 * such as AGENTS.override.md, packaged resources, trust decisions, and explicit
 * system-prompt options.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { createUiColors } from "@aldoborrero/pi-common";
import { Container, Key, Text, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import os from "node:os";
import path from "node:path";
import { once } from "./once.ts";

function formatUsd(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost >= 0.1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(4)}`;
}

function estimateTokens(text: string): number {
	// Deliberately fuzzy (good enough for “how big-ish is this”).
	return Math.max(0, Math.ceil(text.length / 4));
}

function normalizeReadPath(inputPath: string, cwd: string): string {
	let p = inputPath;
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = os.homedir();
	else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
	if (!path.isAbsolute(p)) p = path.resolve(cwd, p);
	return path.resolve(p);
}

function normalizeSkillName(name: string): string {
	return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

type MaybeSourceInfo = {
	path?: unknown;
	source?: unknown;
	sourceInfo?: {
		path?: unknown;
		source?: unknown;
	};
};

function sourcePathOf(value: unknown): string | undefined {
	const item = value as MaybeSourceInfo;
	if (typeof item.sourceInfo?.path === "string") return item.sourceInfo.path;
	if (typeof item.path === "string") return item.path;
	return undefined;
}

function sourceKindOf(value: unknown): string | undefined {
	const item = value as MaybeSourceInfo;
	if (typeof item.sourceInfo?.source === "string") return item.sourceInfo.source;
	if (typeof item.source === "string") return item.source;
	return undefined;
}

type PromptContextFile = {
	path: string;
	content: string;
};

type PromptSkill = {
	name: string;
	filePath: string;
};

type PromptOptions = {
	contextFiles?: PromptContextFile[];
	skills?: PromptSkill[];
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	appendSystemPrompt?: string;
	customPrompt?: string;
};

function getPromptOptions(ctx: ExtensionCommandContext): PromptOptions {
	try {
		return ctx.getSystemPromptOptions() as PromptOptions;
	} catch {
		return {};
	}
}

type SkillIndexEntry = {
	name: string;
	skillFilePath: string;
	skillDir: string;
};

function buildSkillIndex(pi: ExtensionAPI, ctx: ExtensionCommandContext): SkillIndexEntry[] {
	const options = getPromptOptions(ctx);
	if (options.skills?.length) {
		return options.skills
			.map((skill) => {
				const p = normalizeReadPath(skill.filePath, ctx.cwd);
				return {
					name: normalizeSkillName(skill.name),
					skillFilePath: p,
					skillDir: path.dirname(p),
				};
			})
			.filter((entry) => entry.name && entry.skillDir);
	}

	return pi
		.getCommands()
		.filter((command) => command.source === "skill")
		.map((command) => {
			const sourcePath = sourcePathOf(command);
			const p = sourcePath ? normalizeReadPath(sourcePath, ctx.cwd) : "";
			return {
				name: normalizeSkillName(command.name),
				skillFilePath: p,
				skillDir: p ? path.dirname(p) : "",
			};
		})
		.filter((entry) => entry.name && entry.skillDir);
}

const SKILL_LOADED_ENTRY = "context:skill_loaded";

type SkillLoadedEntryData = {
	name: string;
	path: string;
};

function getLoadedSkillsFromSession(ctx: ExtensionContext): Set<string> {
	const out = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== SKILL_LOADED_ENTRY) continue;
		const data = entry.data as SkillLoadedEntryData | undefined;
		if (data?.name) out.add(data.name);
	}
	return out;
}

type UsageLike = {
	input?: unknown;
	output?: unknown;
	inputTokens?: unknown;
	outputTokens?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	totalTokens?: unknown;
	cost?: unknown;
};

function asFiniteNumber(value: unknown): number {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
	return Number.isFinite(n) ? n : 0;
}

function extractCostTotal(usage: UsageLike | undefined): number {
	if (!usage) return 0;
	const cost = usage.cost;
	if (typeof cost === "number" || typeof cost === "string") return asFiniteNumber(cost);
	if (cost && typeof cost === "object") return asFiniteNumber((cost as { total?: unknown }).total);
	return 0;
}

function readUsageNumbers(usage: UsageLike | undefined): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	totalCost: number;
} {
	if (!usage) {
		return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0 };
	}

	// Pi current uses input/output/cacheRead/cacheWrite. Keep legacy fallbacks so
	// old session files still render sensible totals.
	const input = asFiniteNumber(usage.input ?? usage.inputTokens);
	const output = asFiniteNumber(usage.output ?? usage.outputTokens);
	const cacheRead = asFiniteNumber(usage.cacheRead);
	const cacheWrite = asFiniteNumber(usage.cacheWrite);
	const totalTokens = asFiniteNumber(usage.totalTokens) || input + output + cacheRead + cacheWrite;
	return { input, output, cacheRead, cacheWrite, totalTokens, totalCost: extractCostTotal(usage) };
}

function usageOf(value: unknown): UsageLike | undefined {
	return (value as { usage?: UsageLike } | undefined)?.usage;
}

function sumSessionUsage(ctx: ExtensionCommandContext): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	totalCost: number;
} {
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0 };

	const add = (usage: UsageLike | undefined) => {
		const next = readUsageNumbers(usage);
		totals.input += next.input;
		totals.output += next.output;
		totals.cacheRead += next.cacheRead;
		totals.cacheWrite += next.cacheWrite;
		totals.totalTokens += next.totalTokens;
		totals.totalCost += next.totalCost;
	};

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant" || message.role === "toolResult") add(usageOf(message));
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			add(usageOf(entry));
		}
	}

	return totals;
}

function shortenPath(p: string, cwd: string): string {
	const rp = path.resolve(p);
	const rc = path.resolve(cwd);
	if (rp === rc) return ".";
	if (rp.startsWith(rc + path.sep)) return "./" + rp.slice(rc.length + 1);
	return rp;
}

function uniqueSorted(items: string[]): string[] {
	return [...new Set(items.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function extensionLabel(extensionPath: string): string {
	if (extensionPath.startsWith("<") && extensionPath.endsWith(">")) return extensionPath;
	const base = path.basename(extensionPath);
	const parent = path.basename(path.dirname(extensionPath));
	return parent && base === "extension.ts" ? parent : base;
}

function collectExtensionFiles(pi: ExtensionAPI): string[] {
	const paths: string[] = [];

	for (const command of pi.getCommands().filter((command) => command.source === "extension")) {
		const p = sourcePathOf(command);
		if (p) paths.push(p);
	}

	for (const tool of pi.getAllTools()) {
		if (sourceKindOf(tool) === "builtin") continue;
		const p = sourcePathOf(tool);
		if (p) paths.push(p);
	}

	return uniqueSorted(paths).map(extensionLabel);
}

function renderUsageBar(
	theme: any,
	parts: { system: number; tools: number; convo: number; remaining: number },
	total: number,
	width: number,
): string {
	const w = Math.max(10, width);
	if (total <= 0) return "";

	const toCols = (n: number) => Math.round((n / total) * w);
	let sys = toCols(parts.system);
	let tools = toCols(parts.tools);
	let con = toCols(parts.convo);
	let rem = w - sys - tools - con;
	if (rem < 0) rem = 0;
	while (sys + tools + con + rem < w) rem++;
	while (sys + tools + con + rem > w && rem > 0) rem--;

	const colors = createUiColors(theme);
	const block = "█";
	const sysStr = colors.primary(block.repeat(sys));
	const toolsStr = colors.warning(block.repeat(tools));
	const conStr = colors.success(block.repeat(con));
	const remStr = colors.subtle(block.repeat(rem));
	return `${sysStr}${toolsStr}${conStr}${remStr}`;
}

function joinComma(items: string[]): string {
	return items.join(", ");
}

function joinCommaStyled(items: string[], renderItem: (item: string) => string, sep: string): string {
	return items.map(renderItem).join(sep);
}

type ContextViewData = {
	usage:
		| {
				messageTokens: number | null;
				contextWindow: number;
				effectiveTokens: number | null;
				percent: number | null;
				remainingTokens: number | null;
				systemPromptTokens: number;
				contextFileTokens: number;
				appendSystemPromptTokens: number;
				toolsTokens: number;
				activeTools: number;
			}
		| null;
	contextFiles: string[];
	extensions: string[];
	skills: string[];
	loadedSkills: string[];
	session: { totalTokens: number; totalCost: number };
};

class ContextView implements Component {
	private tui: TUI;
	private theme: any;
	private onDone: () => void;
	private data: ContextViewData;
	private container: Container;
	private body: Text;
	private cachedWidth?: number;

	constructor(tui: TUI, theme: any, data: ContextViewData, onDone: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.data = data;
		this.onDone = onDone;

		const colors = createUiColors(theme);
		this.container = new Container();
		this.container.addChild(new DynamicBorder((s) => colors.primary(s)));
		this.container.addChild(
			new Text(colors.primary(theme.bold("Context")) + colors.subtle("  (Esc/q/Enter to close)"), 1, 0),
		);
		this.container.addChild(new Text("", 1, 0));

		this.body = new Text("", 1, 0);
		this.container.addChild(this.body);

		this.container.addChild(new Text("", 1, 0));
		this.container.addChild(new DynamicBorder((s) => colors.primary(s)));
	}

	private rebuild(width: number): void {
		const colors = createUiColors(this.theme);
		const muted = (s: string) => colors.meta(s);
		const dim = (s: string) => colors.subtle(s);
		const text = (s: string) => colors.text(s);

		const lines: string[] = [];

		if (!this.data.usage) {
			lines.push(muted("Window: ") + dim("(unknown)"));
		} else {
			const u = this.data.usage;
			const tokenText =
				u.effectiveTokens === null
					? `? / ${u.contextWindow.toLocaleString()}`
					: `~${u.effectiveTokens.toLocaleString()} / ${u.contextWindow.toLocaleString()}`;
			const percentText =
				u.percent === null || u.remainingTokens === null
					? "unknown after compaction"
					: `${u.percent.toFixed(1)}% used, ~${u.remainingTokens.toLocaleString()} left`;
			lines.push(muted("Window: ") + text(tokenText) + muted(`  (${percentText})`));

			if (u.effectiveTokens !== null && u.remainingTokens !== null) {
				const barWidth = Math.max(10, Math.min(36, width - 10));
				const sysInMessages = Math.min(u.systemPromptTokens, u.messageTokens ?? 0);
				const convoInMessages = Math.max(0, (u.messageTokens ?? 0) - sysInMessages);
				const bar =
					renderUsageBar(
						this.theme,
						{
							system: sysInMessages,
							tools: u.toolsTokens,
							convo: convoInMessages,
							remaining: u.remainingTokens,
						},
						u.contextWindow,
						barWidth,
					) +
					" " +
					dim("sys") +
					colors.primary("█") +
					" " +
					dim("tools") +
					colors.warning("█") +
					" " +
					dim("convo") +
					colors.success("█") +
					" " +
					dim("free") +
					colors.subtle("█");
				lines.push(bar);
			}
		}

		lines.push("");

		if (this.data.usage) {
			const u = this.data.usage;
			const appendText =
				u.appendSystemPromptTokens > 0 ? `, append ~${u.appendSystemPromptTokens.toLocaleString()}` : "";
			lines.push(
				muted("System: ") +
					text(`~${u.systemPromptTokens.toLocaleString()} tok`) +
					muted(` (context files ~${u.contextFileTokens.toLocaleString()}${appendText})`),
			);
			lines.push(
				muted("Tools: ") + text(`~${u.toolsTokens.toLocaleString()} tok`) + muted(` (${u.activeTools} active)`),
			);
		}

		lines.push(
			muted(`Context files (${this.data.contextFiles.length}): `) +
				text(this.data.contextFiles.length ? joinComma(this.data.contextFiles) : "(none)"),
		);
		lines.push("");
		lines.push(
			muted(`Extensions (${this.data.extensions.length}): `) +
				text(this.data.extensions.length ? joinComma(this.data.extensions) : "(none)"),
		);

		const loaded = new Set(this.data.loadedSkills);
		const skillsRendered = this.data.skills.length
			? joinCommaStyled(
					this.data.skills,
					(name) => (loaded.has(name) ? colors.success(name) : colors.meta(name)),
					colors.meta(", "),
				)
			: "(none)";
		lines.push(muted(`Skills (${this.data.skills.length}): `) + skillsRendered);
		lines.push("");
		lines.push(
			muted("Session: ") +
				text(`${this.data.session.totalTokens.toLocaleString()} tokens`) +
				muted(" · ") +
				text(formatUsd(this.data.session.totalCost)),
		);

		this.body.setText(lines.join("\n"));
		this.cachedWidth = width;
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c")) ||
			data.toLowerCase() === "q" ||
			data === "\r"
		) {
			this.onDone();
			return;
		}
	}

	invalidate(): void {
		this.container.invalidate();
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedWidth !== width) this.rebuild(width);
		return this.container.render(width);
	}
}

export default function contextExtension(pi: ExtensionAPI) {
	once(pi, "pi-context", () => {
		let lastSessionId: string | null = null;
		let cachedLoadedSkills = new Set<string>();
		let cachedSkillIndex: SkillIndexEntry[] = [];

		const ensureCaches = (ctx: ExtensionCommandContext) => {
			const sid = ctx.sessionManager.getSessionId();
			if (sid !== lastSessionId) {
				lastSessionId = sid;
				cachedLoadedSkills = getLoadedSkillsFromSession(ctx);
				cachedSkillIndex = buildSkillIndex(pi, ctx);
			}
			if (cachedSkillIndex.length === 0) cachedSkillIndex = buildSkillIndex(pi, ctx);
		};

		const matchSkillForPath = (absPath: string): string | null => {
			let best: SkillIndexEntry | null = null;
			for (const s of cachedSkillIndex) {
				if (!s.skillDir) continue;
				if (absPath === s.skillFilePath || absPath.startsWith(s.skillDir + path.sep)) {
					if (!best || s.skillDir.length > best.skillDir.length) best = s;
				}
			}
			return best?.name ?? null;
		};

		pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
			if (event.toolName !== "read") return;
			if (event.isError) return;

			const input = event.input as { path?: unknown } | undefined;
			const p = typeof input?.path === "string" ? input.path : "";
			if (!p) return;

			ensureCaches(ctx as ExtensionCommandContext);
			const abs = normalizeReadPath(p, ctx.cwd);
			const skillName = matchSkillForPath(abs);
			if (!skillName) return;

			if (!cachedLoadedSkills.has(skillName)) {
				cachedLoadedSkills.add(skillName);
				pi.appendEntry<SkillLoadedEntryData>(SKILL_LOADED_ENTRY, { name: skillName, path: abs });
			}
		});

		pi.registerCommand("context", {
			description: "Show loaded context overview",
			handler: async (_args, ctx: ExtensionCommandContext) => {
				const promptOptions = getPromptOptions(ctx);
				const contextFiles = promptOptions.contextFiles ?? [];
				const contextFilePaths = contextFiles.map((file) => shortenPath(file.path, ctx.cwd));
				const contextFileTokens = contextFiles.reduce((sum, file) => sum + estimateTokens(file.content), 0);
				const appendSystemPromptTokens = estimateTokens(promptOptions.appendSystemPrompt ?? "");

				const skills = (promptOptions.skills?.length
					? promptOptions.skills.map((skill) => normalizeSkillName(skill.name))
					: pi
							.getCommands()
							.filter((command) => command.source === "skill")
							.map((command) => normalizeSkillName(command.name))
				).sort((a, b) => a.localeCompare(b));

				const systemPrompt = ctx.getSystemPrompt();
				const systemPromptTokens = systemPrompt ? estimateTokens(systemPrompt) : 0;

				const contextUsage = ctx.getContextUsage();
				const messageTokens = typeof contextUsage?.tokens === "number" ? contextUsage.tokens : null;
				const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;

				const activeToolNames = pi.getActiveTools();
				const toolInfoByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool] as const));
				let toolsTokens = 0;
				for (const name of activeToolNames) {
					const info = toolInfoByName.get(name);
					const promptSnippet = promptOptions.toolSnippets?.[name] ?? "";
					const guidelines = info?.promptGuidelines?.join("\n") ?? "";
					const schema = info?.parameters ? JSON.stringify(info.parameters) : "";
					const blob = `${name}\n${info?.description ?? ""}\n${promptSnippet}\n${guidelines}\n${schema}`;
					toolsTokens += estimateTokens(blob);
				}

				const effectiveTokens = messageTokens === null ? null : messageTokens + toolsTokens;
				const percent = effectiveTokens !== null && contextWindow > 0 ? (effectiveTokens / contextWindow) * 100 : null;
				const remainingTokens = effectiveTokens !== null && contextWindow > 0 ? Math.max(0, contextWindow - effectiveTokens) : null;

				const sessionUsage = sumSessionUsage(ctx);
				const extensionFiles = collectExtensionFiles(pi);

				const makePlainText = () => {
					const lines: string[] = [];
					lines.push("Context");
					if (contextWindow > 0) {
						const tokenText = effectiveTokens === null ? "?" : `~${effectiveTokens.toLocaleString()}`;
						const usageText =
							percent === null || remainingTokens === null
								? "unknown after compaction"
								: `${percent.toFixed(1)}% used, ~${remainingTokens.toLocaleString()} left`;
						lines.push(`Window: ${tokenText} / ${contextWindow.toLocaleString()} (${usageText})`);
					} else {
						lines.push("Window: (unknown)");
					}
					lines.push(
						`System: ~${systemPromptTokens.toLocaleString()} tok (context files ~${contextFileTokens.toLocaleString()})`,
					);
					lines.push(`Tools: ~${toolsTokens.toLocaleString()} tok (${activeToolNames.length} active)`);
					lines.push(`Context files: ${contextFilePaths.length ? joinComma(contextFilePaths) : "(none)"}`);
					lines.push(`Extensions (${extensionFiles.length}): ${extensionFiles.length ? joinComma(extensionFiles) : "(none)"}`);
					lines.push(`Skills (${skills.length}): ${skills.length ? joinComma(skills) : "(none)"}`);
					lines.push(`Session: ${sessionUsage.totalTokens.toLocaleString()} tokens · ${formatUsd(sessionUsage.totalCost)}`);
					return lines.join("\n");
				};

				if (ctx.mode !== "tui") {
					pi.sendMessage({ customType: "context", content: makePlainText(), display: true }, { triggerTurn: false });
					return;
				}

				const loadedSkills = Array.from(getLoadedSkillsFromSession(ctx)).sort((a, b) => a.localeCompare(b));

				const viewData: ContextViewData = {
					usage:
						contextWindow > 0
							? {
									messageTokens,
									contextWindow,
									effectiveTokens,
									percent,
									remainingTokens,
									systemPromptTokens,
									contextFileTokens,
									appendSystemPromptTokens,
									toolsTokens,
									activeTools: activeToolNames.length,
								}
							: null,
					contextFiles: contextFilePaths,
					extensions: extensionFiles,
					skills,
					loadedSkills,
					session: { totalTokens: sessionUsage.totalTokens, totalCost: sessionUsage.totalCost },
				};

				await ctx.ui.custom<void>((tui, theme, _kb, done) => {
					return new ContextView(tui, theme, viewData, done);
				});
			},
		});
	});
}
