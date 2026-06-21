/**
 * Loop Extension
 *
 * Provides a /loop command that starts a follow-up loop with a breakout condition.
 * The loop keeps sending a prompt on turn end until the agent calls the
 * signal_loop_success tool.
 */

import { Type } from "@sinclair/typebox";
import { complete, type Api, type Model, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionSwitchEvent } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import { createUiColors } from "@aldoborrero/pi-common";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";

type LoopMode = "tests" | "custom" | "self";

type LoopStateData = {
	active: boolean;
	mode?: LoopMode;
	condition?: string;
	prompt?: string;
	summary?: string;
	loopCount?: number;
};

const LOOP_PRESETS = [
	{ value: "tests", label: "Until tests pass", description: "" },
	{ value: "custom", label: "Until custom condition", description: "" },
	{ value: "self", label: "Self driven (agent decides)", description: "" },
] as const;

const LOOP_STATE_ENTRY = "loop-state";

const HAIKU_MODEL_ID = "claude-haiku-4-5";

const SUMMARY_SYSTEM_PROMPT = `You summarize loop breakout conditions for a status widget.
Return a concise phrase (max 6 words) that says when the loop should stop.
Use plain text only, no quotes, no punctuation, no prefix.

Form should be "breaks when ...", "loops until ...", "stops on ...", "runs until ...", or similar.
Use the best form that makes sense for the loop condition.
`;

function buildPrompt(mode: LoopMode, condition?: string): string {
	switch (mode) {
		case "tests":
			return (
				"Run all tests. If they are passing, call the signal_loop_success tool. " +
				"Otherwise continue until the tests pass."
			);
		case "custom": {
			const customCondition = condition?.trim() || "the custom condition is satisfied";
			return (
				`Continue until the following condition is satisfied: ${customCondition}. ` +
				"When it is satisfied, call the signal_loop_success tool."
			);
		}
		case "self":
			return "Continue until you are done. When finished, call the signal_loop_success tool.";
	}
}

function summarizeCondition(mode: LoopMode, condition?: string): string {
	switch (mode) {
		case "tests":
			return "tests pass";
		case "custom": {
			const summary = condition?.trim() || "custom condition";
			return summary.length > 48 ? `${summary.slice(0, 45)}...` : summary;
		}
		case "self":
			return "done";
	}
}

function getConditionText(mode: LoopMode, condition?: string): string {
	switch (mode) {
		case "tests":
			return "tests pass";
		case "custom":
			return condition?.trim() || "custom condition";
		case "self":
			return "you are done";
	}
}

async function selectSummaryModel(
	ctx: ExtensionContext,
): Promise<{ model: Model<Api>; apiKey: string } | null> {
	if (!ctx.model) return null;

	if (ctx.model.provider === "anthropic") {
		const haikuModel = ctx.modelRegistry.find("anthropic", HAIKU_MODEL_ID);
		if (haikuModel) {
			const apiKey = await ctx.modelRegistry.getApiKey(haikuModel);
			if (apiKey) {
				return { model: haikuModel, apiKey };
			}
		}
	}

	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	if (!apiKey) return null;
	return { model: ctx.model, apiKey };
}

async function summarizeBreakoutCondition(
	ctx: ExtensionContext,
	mode: LoopMode,
	condition?: string,
): Promise<string> {
	const fallback = summarizeCondition(mode, condition);
	const selection = await selectSummaryModel(ctx);
	if (!selection) return fallback;

	const conditionText = getConditionText(mode, condition);
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: conditionText }],
		timestamp: Date.now(),
	};

	const response = await complete(
		selection.model,
		{ systemPrompt: SUMMARY_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: selection.apiKey },
	);

	if (response.stopReason === "aborted" || response.stopReason === "error") {
		return fallback;
	}

	const summary = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();

	if (!summary) return fallback;
	return summary.length > 60 ? `${summary.slice(0, 57)}...` : summary;
}

function getCompactionInstructions(mode: LoopMode, condition?: string): string {
	const conditionText = getConditionText(mode, condition);
	return `Loop active. Breakout condition: ${conditionText}. Preserve this loop state and breakout condition in the summary.`;
}

function updateStatus(ctx: ExtensionContext, state: LoopStateData): void {
	if (!ctx.hasUI) return;
	if (!state.active || !state.mode) {
		ctx.ui.setWidget("loop", undefined);
		return;
	}
	const loopCount = state.loopCount ?? 0;
	const turnText = `(turn ${loopCount})`;
	const summary = state.summary?.trim();
	const text = summary
		? `Loop active: ${summary} ${turnText}`
		: `Loop active ${turnText}`;
	const colors = createUiColors(ctx.ui.theme);
	ctx.ui.setWidget("loop", [colors.primary(text)]);
}

async function loadState(ctx: ExtensionContext): Promise<LoopStateData> {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type: string; customType?: string; data?: LoopStateData };
		if (entry.type === "custom" && entry.customType === LOOP_STATE_ENTRY && entry.data) {
			return entry.data;
		}
	}
	return { active: false };
}

export default function loopExtension(pi: ExtensionAPI): void {
	let loopState: LoopStateData = { active: false };

	function persistState(state: LoopStateData): void {
		pi.appendEntry(LOOP_STATE_ENTRY, state);
	}

	function setLoopState(state: LoopStateData, ctx: ExtensionContext): void {
		loopState = state;
		persistState(state);
		updateStatus(ctx, state);
	}

	function clearLoopState(ctx: ExtensionContext): void {
		const cleared: LoopStateData = { active: false };
		loopState = cleared;
		persistState(cleared);
		updateStatus(ctx, cleared);
	}

	function breakLoop(ctx: ExtensionContext): void {
		clearLoopState(ctx);
		ctx.ui.notify("Loop ended", "info");
	}

	function wasLastAssistantAborted(messages: Array<{ role?: string; stopReason?: string }>): boolean {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role === "assistant") {
				return message.stopReason === "aborted";
			}
		}
		return false;
	}

	function triggerLoopPrompt(ctx: ExtensionContext): void {
		if (!loopState.active || !loopState.mode || !loopState.prompt) return;
		if (ctx.hasPendingMessages()) return;

		const prompt = loopState.prompt;
		const loopCount = (loopState.loopCount ?? 0) + 1;
		loopState = { ...loopState, loopCount };
		persistState(loopState);
		updateStatus(ctx, loopState);

		pi.sendMessage({
			customType: "loop",
			content: prompt,
			display: true
		}, {
			deliverAs: "followUp",
			triggerTurn: true
		});
	}

	async function showLoopSelector(ctx: ExtensionContext): Promise<LoopStateData | null> {
		const items: SelectItem[] = LOOP_PRESETS.map((preset) => ({
			value: preset.value,
			label: preset.label,
			description: preset.description,
		}));

		const selection = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const colors = createUiColors(theme);
			const container = new Container();
			container.addChild(new DynamicBorder((str) => colors.primary(str)));
			container.addChild(new Text(colors.primary(theme.bold("Select a loop preset"))));

			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => colors.primary(text),
				selectedText: (text) => colors.primary(text),
				description: (text) => colors.meta(text),
				scrollInfo: (text) => colors.subtle(text),
				noMatch: (text) => colors.warning(text),
			});

			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(new Text(colors.subtle("Press enter to confirm or esc to cancel")));
			container.addChild(new DynamicBorder((str) => colors.primary(str)));

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!selection) return null;

		switch (selection) {
			case "tests":
				return { active: true, mode: "tests", prompt: buildPrompt("tests") };
			case "self":
				return { active: true, mode: "self", prompt: buildPrompt("self") };
			case "custom": {
				const condition = await ctx.ui.editor("Enter loop breakout condition:", "");
				if (!condition?.trim()) return null;
				return {
					active: true,
					mode: "custom",
					condition: condition.trim(),
					prompt: buildPrompt("custom", condition.trim()),
				};
			}
			default:
				return null;
		}
	}

	function parseArgs(args: string | undefined): LoopStateData | null {
		if (!args?.trim()) return null;
		const parts = args.trim().split(/\s+/);
		const mode = parts[0]?.toLowerCase();

		switch (mode) {
			case "tests":
				return { active: true, mode: "tests", prompt: buildPrompt("tests") };
			case "self":
				return { active: true, mode: "self", prompt: buildPrompt("self") };
			case "custom": {
				const condition = parts.slice(1).join(" ").trim();
				if (!condition) return null;
				return {
					active: true,
					mode: "custom",
					condition,
					prompt: buildPrompt("custom", condition),
				};
			}
			default:
				return null;
		}
	}

	pi.registerTool({
		name: "signal_loop_success",
		label: "Signal Loop Success",
		description: "Stop the active loop when the breakout condition is satisfied. Only call this tool when explicitly instructed to do so by the user, tool or system prompt.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!loopState.active) {
				return {
					content: [{ type: "text", text: "No active loop is running." }],
					details: { active: false },
				};
			}

			clearLoopState(ctx);

			return {
				content: [{ type: "text", text: "Loop ended." }],
				details: { active: false },
			};
		},
	});

	pi.registerCommand("until", {
		description: "Repeat until a condition is met (e.g., /until tests, /until custom <condition>)",
		getArgumentCompletions: (prefix: string) => {
			const trimmed = prefix.trimStart();
			const modes = ["tests", "custom", "self"];
			if (!trimmed) {
				return modes.map((value) => ({ value, label: value }));
			}
			const parts = trimmed.split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase() ?? "";
			if (parts.length <= 1 && !/\s$/.test(trimmed)) {
				const filtered = modes.filter((value) => value.startsWith(sub));
				return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			let nextState = parseArgs(args);
			if (!nextState) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /loop tests | /loop custom <condition> | /loop self", "warning");
					return;
				}
				nextState = await showLoopSelector(ctx);
			}

			if (!nextState) {
				ctx.ui.notify("Loop cancelled", "info");
				return;
			}

			if (loopState.active) {
				const confirm = ctx.hasUI
					? await ctx.ui.confirm("Replace active loop?", "A loop is already active. Replace it?")
					: true;
				if (!confirm) {
					ctx.ui.notify("Loop unchanged", "info");
					return;
				}
			}

			const summarizedState: LoopStateData = { ...nextState, summary: undefined, loopCount: 0 };
			setLoopState(summarizedState, ctx);
			ctx.ui.notify("Loop active", "info");
			triggerLoopPrompt(ctx);

			const mode = nextState.mode!;
			const condition = nextState.condition;
			void (async () => {
				const summary = await summarizeBreakoutCondition(ctx, mode, condition);
				if (!loopState.active || loopState.mode !== mode || loopState.condition !== condition) return;
				loopState = { ...loopState, summary };
				persistState(loopState);
				updateStatus(ctx, loopState);
			})();
		},
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!loopState.active) return;

		if (ctx.hasUI && wasLastAssistantAborted(event.messages)) {
			const confirm = await ctx.ui.confirm(
				"Break active loop?",
				"Operation aborted. Break out of the loop?",
			);
			if (confirm) {
				breakLoop(ctx);
				return;
			}
		}

		triggerLoopPrompt(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!loopState.active || !loopState.mode || !ctx.model) return;
		const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
		if (!apiKey) return;

		const instructionParts = [event.customInstructions, getCompactionInstructions(loopState.mode, loopState.condition)]
			.filter(Boolean)
			.join("\n\n");

		try {
			const compaction = await compact(event.preparation, ctx.model, apiKey, instructionParts, event.signal);
			return { compaction };
		} catch (error) {
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Loop compaction failed: ${message}`, "warning");
			}
			return;
		}
	});

	async function restoreLoopState(ctx: ExtensionContext): Promise<void> {
		loopState = await loadState(ctx);
		updateStatus(ctx, loopState);

		if (loopState.active && loopState.mode && !loopState.summary) {
			const mode = loopState.mode;
			const condition = loopState.condition;
			void (async () => {
				const summary = await summarizeBreakoutCondition(ctx, mode, condition);
				if (!loopState.active || loopState.mode !== mode || loopState.condition !== condition) return;
				loopState = { ...loopState, summary };
				persistState(loopState);
				updateStatus(ctx, loopState);
			})();
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await restoreLoopState(ctx);
	});

	pi.on("session_switch", async (_event: SessionSwitchEvent, ctx) => {
		await restoreLoopState(ctx);
	});
}
