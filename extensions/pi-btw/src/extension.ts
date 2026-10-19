/**
 * BTW Extension — ephemeral side questions that don't pollute context.
 *
 * Like Claude Code's /btw command: ask a quick question without tool access,
 * get an answer in a bottom overlay, and keep the main conversation clean.
 *
 * Usage:
 *   /btw what's the difference between rebase and merge?
 *   /btw how do I write a regex for emails?
 *   /btw   # opens the BTW prompt UI
 */

import {
	AssistantMessageComponent,
	convertToLlm,
	UserMessageComponent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	completeSimple,
	type AssistantMessage,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { createUiColors } from "@aldoborrero/pi-common";
import {
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type OverlayOptions,
	type TUI,
} from "@earendil-works/pi-tui";
import { once } from "./once.ts";

const BTW_COMMAND_NAME = "btw";
const BTW_STATE_SYMBOL = Symbol.for("aldoborrero.pi-btw.state");
const OVERLAY_MAX_HEIGHT_RATIO = 0.6;
const SIDE_PAD = "  ";
const BODY_PAD = "    ";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const BTW_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "center",
	width: "90%",
	maxHeight: `${OVERLAY_MAX_HEIGHT_RATIO * 100}%`,
	margin: { left: 2, right: 2, top: 1, bottom: 1 },
};

const BTW_SYSTEM_PROMPT = [
	"You are answering a quick side question while the user's main Pi session continues working.",
	"You are given the user's primary conversation as background context. Do not continue the prior assistant work or pick up pending tool calls.",
	"Answer directly and concisely. Prefer compact bullets or short paragraphs.",
	"Cite files, functions, and line numbers when grounding a claim in the provided context.",
	"If the context is insufficient, say so briefly instead of guessing.",
	"You have no tools. Reply in plain text only.",
].join("\n");

interface BtwTurn {
	userMessage: UserMessage;
	assistantMessage: AssistantMessage;
}

interface BtwState {
	histories: Map<string, BtwTurn[]>;
	snapshots: Map<string, { messages: Message[] }>;
}

type BtwResult =
	| { ok: true; answer: string; userMessage: UserMessage; assistantMessage: AssistantMessage }
	| { ok: false; error: string }
	| { ok: false; aborted: true };

function getState(): BtwState {
	const host = globalThis as unknown as Record<PropertyKey, BtwState | undefined>;
	let state = host[BTW_STATE_SYMBOL];
	if (!state) {
		state = { histories: new Map(), snapshots: new Map() };
		host[BTW_STATE_SYMBOL] = state;
	}
	return state;
}

function getSessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionFile() ?? `memory:${ctx.sessionManager.getSessionId()}`;
}

function getSessionHistory(ctx: ExtensionContext): BtwTurn[] {
	const state = getState();
	const key = getSessionKey(ctx);
	let history = state.histories.get(key);
	if (!history) {
		history = [];
		state.histories.set(key, history);
	}
	return history;
}

function clearSessionHistory(ctx: ExtensionContext): void {
	getState().histories.set(getSessionKey(ctx), []);
}

function setSnapshot(ctx: ExtensionContext, messages: Message[]): void {
	getState().snapshots.set(getSessionKey(ctx), { messages });
}

function getSnapshot(ctx: ExtensionContext): Message[] | undefined {
	return getState().snapshots.get(getSessionKey(ctx))?.messages;
}

function invalidateSnapshot(ctx: ExtensionContext): void {
	getState().snapshots.delete(getSessionKey(ctx));
}

function clearSessionState(ctx: ExtensionContext): void {
	const state = getState();
	const key = getSessionKey(ctx);
	state.histories.delete(key);
	state.snapshots.delete(key);
}

function branchToMessages(branch: SessionEntry[]): Message[] {
	const agentMessages = branch
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);
	return convertToLlm(agentMessages);
}

function readConversationSnapshot(ctx: ExtensionContext): Message[] {
	return getSnapshot(ctx) ?? branchToMessages(ctx.sessionManager.getBranch() as SessionEntry[]);
}

function assistantMessageText(message: AssistantMessage): string {
	return message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

function buildBtwMessages(ctx: ExtensionContext, userMessage: UserMessage): Message[] {
	const mainConversation = readConversationSnapshot(ctx);
	const btwHistory = getSessionHistory(ctx).flatMap((turn): Message[] => [turn.userMessage, turn.assistantMessage]);
	return [...mainConversation, ...btwHistory, userMessage];
}

async function executeBtw(ctx: ExtensionCommandContext, question: string, controller: AbortController): Promise<BtwResult> {
	const model = ctx.model as Model<any> | undefined;
	if (!model) return { ok: false, error: "/btw requires an active model" };

	const modelLabel = `${model.provider}/${model.id}`;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { ok: false, error: `/btw model (${modelLabel}) is misconfigured: ${auth.error}` };
	if (!auth.apiKey) return { ok: false, error: `/btw model (${modelLabel}) has no API key available.` };

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: question }],
		timestamp: Date.now(),
	};

	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt: BTW_SYSTEM_PROMPT,
				messages: buildBtwMessages(ctx, userMessage),
				tools: [],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal: controller.signal,
				maxTokens: 1024,
				reasoning: "minimal",
			},
		);

		if (response.stopReason === "aborted") return { ok: false, aborted: true };
		if (response.stopReason === "error") {
			return { ok: false, error: `/btw call failed: ${response.errorMessage ?? "unknown error"}` };
		}

		const answer = assistantMessageText(response);
		if (!answer) return { ok: false, error: "/btw returned no text content." };
		return { ok: true, answer, userMessage, assistantMessage: response };
	} catch (error) {
		if (controller.signal.aborted) return { ok: false, aborted: true };
		return { ok: false, error: `/btw call threw: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function styleBanner(theme: any, width: number, text: string): string {
	const colors = createUiColors(theme);
	const content = truncateToWidth(`${SIDE_PAD}${text}`, width, "…", false);
	const padding = " ".repeat(Math.max(0, width - visibleWidth(content)));
	return colors.primary(content + padding);
}

function boxBorder(theme: any, width: number, left: string, right: string): string {
	const colors = createUiColors(theme);
	return colors.primary(left + "─".repeat(Math.max(1, width - 2)) + right);
}

function boxLine(theme: any, width: number, content = ""): string {
	const colors = createUiColors(theme);
	const innerWidth = Math.max(1, width - 4);
	const text = truncateToWidth(content, innerWidth, "…", false);
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(text)));
	return colors.primary("│ ") + text + padding + colors.primary(" │");
}

function boxTitleLine(theme: any, width: number, title: string, status = ""): string {
	const colors = createUiColors(theme);
	const innerWidth = Math.max(1, width - 4);
	const right = status ? colors.subtle(status) : "";
	const availableTitleWidth = Math.max(1, innerWidth - visibleWidth(right) - (right ? 2 : 0));
	const left = truncateToWidth(title, availableTitleWidth, "…", false);
	const gap = " ".repeat(Math.max(right ? 2 : 0, innerWidth - visibleWidth(left) - visibleWidth(right)));
	return boxLine(theme, width, left + gap + right);
}

function wrapBoxLines(theme: any, width: number, text: string, color: (value: string) => string): string[] {
	const innerWidth = Math.max(1, width - 4);
	const lines: string[] = [];
	for (const raw of text.split("\n")) {
		if (!raw) {
			lines.push(boxLine(theme, width));
			continue;
		}
		for (const line of wrapTextWithAnsi(color(raw), innerWidth)) lines.push(boxLine(theme, width, line));
	}
	return lines;
}

function componentBoxLines(theme: any, width: number, component: Component): string[] {
	const innerWidth = Math.max(1, width - 4);
	const rendered = component.render(innerWidth);
	return rendered.length > 0 ? rendered.map((line) => boxLine(theme, width, line)) : [boxLine(theme, width)];
}

function wrapIndented(text: string, width: number, pad: string, color: (value: string) => string): string[] {
	const bodyWidth = Math.max(1, width - pad.length);
	const lines: string[] = [];
	for (const raw of text.split("\n")) {
		if (!raw) {
			lines.push("");
			continue;
		}
		for (const line of wrapTextWithAnsi(color(raw), bodyWidth)) lines.push(pad + line);
	}
	return lines;
}

class BtwPromptOverlay implements Component {
	private readonly input = new Input();
	private error: string | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: any,
		private readonly done: (question?: string) => void,
	) {
		this.input.focused = true;
		this.input.onSubmit = (value) => this.submit(value);
		this.input.onEscape = () => this.done(undefined);
	}

	private submit(value: string): void {
		const question = value.trim();
		if (!question) {
			this.error = "Enter a question before submitting.";
			this.tui.requestRender();
			return;
		}
		this.done(question);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(undefined);
			return;
		}
		this.error = undefined;
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const colors = createUiColors(this.theme);
		const w = Math.max(36, width);
		const inputLine = this.input.render(Math.max(1, w - 8))[0] ?? "> ";
		const lines = [
			boxBorder(this.theme, w, "╭", "╮"),
			boxTitleLine(this.theme, w, colors.primary(this.theme.bold("BTW")), "private · no tools"),
			boxLine(this.theme, w, colors.meta("Question") + "  " + inputLine),
		];
		if (this.error) lines.push(boxLine(this.theme, w, colors.warning(this.error)));
		lines.push(boxLine(this.theme, w, colors.subtle("Enter submit · Esc cancel")));
		lines.push(boxBorder(this.theme, w, "╰", "╯"));
		return lines;
	}
}

type BtwOverlayMode = "pending" | "answer" | "error";

class BtwOverlayController implements Component {
	private mode: BtwOverlayMode = "pending";
	private answer = "";
	private assistantMessage: AssistantMessage | undefined;
	private error = "";
	private scrollOffset = 0;
	private frame = 0;
	private readonly timer: ReturnType<typeof setInterval>;
	private history: BtwTurn[];

	constructor(
		private readonly question: string,
		history: BtwTurn[],
		private readonly theme: any,
		private readonly tui: TUI,
		private readonly done: () => void,
		private readonly controller: AbortController,
		private readonly onClearHistory: () => void,
	) {
		this.history = [...history];
		this.timer = setInterval(() => {
			if (this.mode !== "pending") return;
			this.frame += 1;
			this.tui.requestRender();
		}, 250);
		this.timer.unref?.();
	}

	setAnswer(answer: string, assistantMessage?: AssistantMessage): void {
		this.mode = "answer";
		this.answer = answer;
		this.assistantMessage = assistantMessage;
		clearInterval(this.timer);
		this.tui.requestRender();
	}

	setError(error: string): void {
		this.mode = "error";
		this.error = error;
		clearInterval(this.timer);
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.controller.abort();
			clearInterval(this.timer);
			this.done();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scrollOffset += 1;
			this.tui.requestRender();
			return;
		}
		if (data === "x" && this.history.length > 0) {
			this.history = [];
			this.onClearHistory();
			this.scrollOffset = 0;
			this.tui.requestRender();
			return;
		}
		if (
			(matchesKey(data, Key.enter) ||
				matchesKey(data, Key.return) ||
				data === "\r" ||
				data === "\n" ||
				data.toLowerCase() === "q") &&
			this.mode !== "pending"
		) {
			clearInterval(this.timer);
			this.done();
		}
	}

	dispose(): void {
		clearInterval(this.timer);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const colors = createUiColors(this.theme);
		const w = Math.max(36, width);
		const status =
			this.mode === "pending"
				? `${SPINNER[this.frame % SPINNER.length] ?? "…"} asking…`
				: this.mode === "answer"
					? "done"
					: "error";

		const historySuffix = this.history.length > 0 ? `${this.history.length} prior · x clear` : "";
		const header = [
			boxBorder(this.theme, w, "╭", "╮"),
			boxTitleLine(this.theme, w, colors.primary(this.theme.bold("BTW")), historySuffix ? `${status} · ${historySuffix}` : status),
			boxLine(this.theme, w),
		];

		const content = this.renderConversation(w, colors);

		const footerParts: string[] = [];
		if (this.mode !== "pending") footerParts.push("Enter/q close", "↑/↓ scroll");
		footerParts.push("Esc dismiss");
		const footer = [
			boxLine(this.theme, w, colors.subtle(footerParts.join(" · "))),
			boxBorder(this.theme, w, "╰", "╯"),
		];

		const termRows = (this.tui.terminal as { rows?: number }).rows ?? 24;
		const maxRows = Math.max(6, Math.floor(termRows * OVERLAY_MAX_HEIGHT_RATIO));
		const availableContentRows = Math.max(1, maxRows - header.length - footer.length);
		let visibleContent = content;
		if (content.length > availableContentRows) {
			const excess = content.length - availableContentRows;
			if (this.scrollOffset > excess) this.scrollOffset = excess;
			const start = excess - this.scrollOffset;
			visibleContent = content.slice(start, start + availableContentRows);
		}

		return [...header, ...visibleContent, ...footer];
	}

	private renderConversation(width: number, colors: ReturnType<typeof createUiColors>): string[] {
		const lines: string[] = [];
		lines.push(...componentBoxLines(this.theme, width, new UserMessageComponent(this.question)));
		lines.push(boxLine(this.theme, width));

		if (this.mode === "pending") {
			lines.push(boxLine(this.theme, width, colors.warning("Thinking…")));
			return lines;
		}

		if (this.mode === "error") {
			lines.push(...wrapBoxLines(this.theme, width, this.error, colors.danger));
			return lines;
		}

		if (this.assistantMessage) {
			lines.push(...componentBoxLines(this.theme, width, new AssistantMessageComponent(this.assistantMessage, true)));
			return lines;
		}

		lines.push(...wrapBoxLines(this.theme, width, this.answer, colors.text));
		return lines;
	}
}

async function readQuestionFromOverlay(ctx: ExtensionCommandContext): Promise<string | undefined> {
	return await ctx.ui.custom<string | undefined>(
		(tui, theme, _kb, done) => new BtwPromptOverlay(tui, theme, done),
		{ overlay: true, overlayOptions: BTW_OVERLAY_OPTIONS },
	);
}

function showBtwOverlay(params: {
	ctx: ExtensionCommandContext;
	question: string;
	history: BtwTurn[];
	controller: AbortController;
	onClearHistory: () => void;
}): { overlayPromise: Promise<void>; controllerReady: Promise<BtwOverlayController> } {
	let ready!: (controller: BtwOverlayController) => void;
	const controllerReady = new Promise<BtwOverlayController>((resolve) => {
		ready = resolve;
	});

	const overlayPromise = params.ctx.ui.custom<void>(
		(tui, theme, _kb, done) => {
			const overlay = new BtwOverlayController(
				params.question,
				params.history,
				theme,
				tui,
				() => done(undefined),
				params.controller,
				params.onClearHistory,
			);
			ready(overlay);
			return overlay;
		},
		{ overlay: true, overlayOptions: BTW_OVERLAY_OPTIONS },
	);

	return { overlayPromise, controllerReady };
}

function safeInvalidateSnapshot(ctx: ExtensionContext): void {
	try {
		invalidateSnapshot(ctx);
	} catch (error) {
		if (!/stale after session replacement/.test(String(error))) throw error;
	}
}

function isLegacyBtwMessage(message: unknown): boolean {
	return Boolean(
		message &&
			typeof message === "object" &&
			(message as { role?: unknown }).role === "custom" &&
			(message as { customType?: unknown }).customType === BTW_COMMAND_NAME,
	);
}

function isAssistantMessage(message: unknown): boolean {
	return Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "assistant");
}

function filterLegacyBtwExchange(messages: unknown[]): unknown[] {
	let dropNextAssistant = false;
	return messages.filter((message) => {
		if (isLegacyBtwMessage(message)) {
			dropNextAssistant = true;
			return false;
		}
		if (dropNextAssistant && isAssistantMessage(message)) {
			dropNextAssistant = false;
			return false;
		}
		return true;
	});
}

export default function (pi: ExtensionAPI) {
	once(pi, "pi-btw", () => {
		pi.registerCommand(BTW_COMMAND_NAME, {
			description: "Ask a side question in a bottom overlay without polluting the main conversation",
			handler: async (args, ctx) => {
				if (!ctx.hasUI || ctx.mode !== "tui") {
					ctx.ui.notify("/btw requires interactive mode", "error");
					return;
				}
				if (!ctx.model) {
					ctx.ui.notify("/btw requires an active model", "error");
					return;
				}

				const question = args.trim() || (await readQuestionFromOverlay(ctx))?.trim() || "";
				if (!question) {
					ctx.ui.notify("BTW cancelled", "info");
					return;
				}

				const controller = new AbortController();
				const history = [...getSessionHistory(ctx)];
				const { overlayPromise, controllerReady } = showBtwOverlay({
					ctx,
					question,
					history,
					controller,
					onClearHistory: () => clearSessionHistory(ctx),
				});

				const overlay = await controllerReady;
				try {
					const requestPromise = executeBtw(ctx, question, controller);
					const first = await Promise.race([
						requestPromise.then((result) => ({ type: "result" as const, result })),
						overlayPromise.then(() => ({ type: "closed" as const })),
					]);

					// If the user dismissed the overlay while the provider request was still
					// pending, abort and return immediately. Some providers are slow to honor
					// AbortSignal; awaiting them here can make Pi feel stuck.
					if (first.type === "closed") {
						controller.abort();
						void requestPromise.catch(() => undefined);
						return;
					}

					const { result } = first;
					if (result.ok) {
						overlay.setAnswer(result.answer, result.assistantMessage);
						getSessionHistory(ctx).push({ userMessage: result.userMessage, assistantMessage: result.assistantMessage });
					} else if (!("aborted" in result)) {
						overlay.setError(result.error);
					} else {
						return;
					}

					await overlayPromise;
				} finally {
					overlay.dispose();
				}
			},
		});

		pi.on("message_end", async (event, ctx) => {
			if (event.message.role !== "assistant") return;
			const assistant = event.message as AssistantMessage;
			if (assistant.stopReason === "toolUse") return;
			setSnapshot(ctx, branchToMessages(ctx.sessionManager.getBranch() as SessionEntry[]));
		});

		pi.on("session_compact", async (_event, ctx) => safeInvalidateSnapshot(ctx));
		pi.on("session_tree", async (_event, ctx) => safeInvalidateSnapshot(ctx));

		// Drop this session's in-memory BTW history and conversation snapshot so
		// closed sessions don't accumulate in the process-global state.
		pi.on("session_shutdown", async (_event, ctx) => clearSessionState(ctx));

		// Clean up messages produced by older pi-btw versions that used custom
		// conversation messages instead of the separate answer overlay.
		pi.on("context", async (event) => {
			return {
				messages: filterLegacyBtwExchange(event.messages) as typeof event.messages,
			};
		});
	});
}
