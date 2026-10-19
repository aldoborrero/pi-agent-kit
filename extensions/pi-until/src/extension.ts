/**
 * Loop Extension
 *
 * Provides a /until command that starts a follow-up loop with a breakout condition.
 * Each time a run is about to settle the loop appends its prompt and asks Pi for
 * one more model request, until the agent calls the signal_loop_success tool, a
 * run fails, or a maximum iteration cap is reached.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createUiColors } from "@aldoborrero/pi-common";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { once } from "./once.ts";

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

const DEFAULT_MAX_ITERATIONS = 25;

/**
 * Maximum number of loop iterations before the loop stops itself.
 * Overridable via the PI_UNTIL_MAX_ITERATIONS environment variable.
 * Guards against runaway loops that never call signal_loop_success.
 */
function getMaxIterations(): number {
	const raw = process.env.PI_UNTIL_MAX_ITERATIONS;
	if (!raw) return DEFAULT_MAX_ITERATIONS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_ITERATIONS;
	return parsed;
}

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
  once(pi, "pi-until", () => {
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

	function stopLoop(ctx: ExtensionContext, reason: string): void {
		clearLoopState(ctx);
		ctx.ui.notify(`/until stopped: ${reason}`, "warning");
	}

	/** Count the next iteration, or stop the loop once the cap is reached. */
	function advanceLoop(ctx: ExtensionContext): boolean {
		const maxIterations = getMaxIterations();
		if ((loopState.loopCount ?? 0) >= maxIterations) {
			stopLoop(ctx, `reached ${maxIterations} iterations without success`);
			return false;
		}
		loopState = { ...loopState, loopCount: (loopState.loopCount ?? 0) + 1 };
		persistState(loopState);
		updateStatus(ctx, loopState);
		return true;
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

	/**
	 * Start a run with the loop prompt. Used to kick the loop off and to resume
	 * it after an interrupted run; while a run is settling the loop continues
	 * through the agent_before_settle handler instead.
	 */
	function triggerLoopPrompt(ctx: ExtensionContext): void {
		if (!loopState.active || !loopState.mode || !loopState.prompt) return;
		if (ctx.hasPendingMessages()) return;
		if (!advanceLoop(ctx)) return;

		pi.sendMessage({
			customType: "loop",
			content: loopState.prompt,
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
					ctx.ui.notify("Usage: /until tests | /until custom <condition> | /until self", "warning");
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

			const mode = nextState.mode!;
			setLoopState(
				{ ...nextState, summary: summarizeCondition(mode, nextState.condition), loopCount: 0 },
				ctx,
			);
			ctx.ui.notify("Loop active", "info");
			triggerLoopPrompt(ctx);
		},
	});

	// Pi runs this boundary after retries, compaction and queued messages, so a
	// continuation requested here cannot race with them.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (!loopState.active || !loopState.prompt) return;
		// An interrupted run is resolved with the user once the run has settled.
		if (event.outcome === "aborted") return;
		// A run that failed would fail again; do not spend the remaining iterations on it.
		if (event.outcome === "error") {
			stopLoop(ctx, "the last run ended with an error");
			return;
		}
		// Messages the user queued run first; this boundary fires again after them.
		if (event.context.pendingMessages.length > 0) return;
		if (!advanceLoop(ctx)) return;

		return {
			entries: [
				...event.entries,
				{ type: "custom_message", customType: "loop", content: loopState.prompt, display: true },
			],
			continue: true,
		};
	});

	let interrupted = false;

	pi.on("agent_end", async (event) => {
		interrupted = loopState.active && wasLastAssistantAborted(event.messages);
	});

	// Pi skips the settle boundary for an interrupted run, so the loop is
	// resumed or ended here, where starting a new run is allowed again.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!interrupted) return;
		interrupted = false;
		if (!loopState.active) return;

		// Without a UI nobody can answer, and an abort is the only stop signal.
		const breakOut = !ctx.hasUI || (await ctx.ui.confirm(
			"Break active loop?",
			"Operation aborted. Break out of the loop?",
		));
		if (breakOut) {
			breakLoop(ctx);
			return;
		}
		triggerLoopPrompt(ctx);
	});

	// Loop state lives in session entries and every iteration restates the
	// breakout condition, so the loop needs nothing from the compaction summary.
	pi.on("session_start", async (_event, ctx) => {
		loopState = await loadState(ctx);
		if (loopState.active && loopState.mode && !loopState.summary) {
			loopState = { ...loopState, summary: summarizeCondition(loopState.mode, loopState.condition) };
		}
		updateStatus(ctx, loopState);
	});

  });
}
