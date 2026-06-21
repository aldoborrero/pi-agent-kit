/**
 * Walkie Extension
 *
 * Bridges pi coding agent sessions to Telegram for mobile use.
 *
 * Bidirectional:
 *   pi → Telegram  — agent responses pushed after each run with stats
 *   pi → Telegram  — live draft streaming via sendMessageDraft (512B/4s/12s throttle)
 *   pi → Telegram  — phase-aware heartbeat (🧠 Thinking… / 🔧 tool…)
 *   Telegram → pi  — text, photos, voice → injected as user prompts
 *   Telegram → pi  — inline keyboard choices tap → submit_text injected
 *
 * Pi commands:
 *   /walkie          — toggle on/off
 *   /walkie setup    — enter pairing mode
 *   /walkie start    — enable and start polling
 *   /walkie stop     — disable and stop polling
 *   /walkie stream   — toggle draft streaming
 *   /walkie status   — show config
 *   /walkie topic    — create a forum topic and bind this instance to it
 *
 * Telegram commands (from your phone):
 *   /abort    — stop agent run
 *   /status   — agent state, model, context usage
 *   /compact  — compress context
 *   /think    — cycle thinking level: none → low → high
 *   /stream   — toggle draft streaming
 *   /mute     — silence notifications (polling continues)
 *   /unmute   — resume notifications
 *   /new      — queue new session
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SettingsManager, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createUiColors } from "@aldoborrero/pi-common";
import * as tg from "./telegram.js";
import { MessageQueue } from "./queue.js";
import { createProvider, detectProvider } from "../../pi-voice/src/providers.js";
import {
  DRAFT_HEARTBEAT_INTERVAL_MS,
  type AgentStats,
  type DraftFlush,
  type DraftState,
  appendDraftChunk,
  buildFinalMessage,
  buildHeartbeatText,
  buildTransportText,
  chunkText,
  createDraftState,
  escapeHTML,
  formatForTelegram,
  heartbeatDraft,
  suppressDraftUntil,
} from "./format.js";

// ── Config ────────────────────────────────────────────────────────────────────

// ~/.pi/ (or custom via PI_CODING_AGENT_DIR env var — pi derives this from getAgentDir())
const PI_DIR = dirname(getAgentDir());
const PI_DIR_NAME = PI_DIR.replace(homedir() + "/", ""); // e.g. ".pi"

const CONFIG_PATH = join(PI_DIR, "walkie.json");
const WALKIE_SETTINGS_KEY = "walkie";

interface WalkieConfig {
  botToken: string;
  chatId: number;
  allowedUserId: number;
  enabled: boolean;
  /** Use sendMessageDraft for live streaming preview (default: true — available to all bots since Bot API 9.5) */
  streaming: boolean;
  /** Unix timestamp (ms) until which sendMessageDraft is suppressed — set when peer returns TEXTDRAFT_PEER_INVALID */
  draftSuppressedUntil?: number;
  /** Forum topic (message_thread_id) this instance is scoped to. Enables multi-project routing via Telegram Topics. */
  topicId?: number;
  /** Display name for the topic / project (shown in notifications and /status) */
  topicName?: string;
}

function normalizeWalkieConfig(raw: unknown): Partial<WalkieConfig> {
  if (!raw || typeof raw !== "object") return {};
  return raw as Partial<WalkieConfig>;
}

function loadLegacyConfigSync(): Partial<WalkieConfig> {
  try {
    return normalizeWalkieConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  } catch {
    return {};
  }
}

function loadConfigSync(cwd: string = process.cwd()): Partial<WalkieConfig> {
  try {
    const manager = SettingsManager.create(cwd);
    const globalSettings = manager.getGlobalSettings() as Record<string, unknown>;
    return { ...loadLegacyConfigSync(), ...normalizeWalkieConfig(globalSettings[WALKIE_SETTINGS_KEY]) };
  } catch {
    return loadLegacyConfigSync();
  }
}

/** Load project-local overrides from <cwd>/.pi/settings.json, with legacy fallback to <cwd>/.pi/walkie.json */
function loadProjectConfigSync(cwd: string): Partial<WalkieConfig> {
  try {
    const manager = SettingsManager.create(cwd);
    const projectSettings = manager.getProjectSettings() as Record<string, unknown>;
    const settingsConfig = normalizeWalkieConfig(projectSettings[WALKIE_SETTINGS_KEY]);
    if (Object.keys(settingsConfig).length > 0) return settingsConfig;
  } catch {
    // fall back to legacy sidecar
  }
  try {
    const path = join(cwd, PI_DIR_NAME, "walkie.json");
    return normalizeWalkieConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

/**
 * Persist global config to ~/.pi/agent/settings.json under the walkie key.
 * topicId and topicName are project-specific — use persistProjectConfig() for those.
 */
async function persistConfig(config: Partial<WalkieConfig>): Promise<void> {
  const { topicId, topicName, ...globalFields } = config;
  try {
    const manager = SettingsManager.create(process.cwd());
    await manager.reload();
    const globalSettings = manager.getGlobalSettings() as Record<string, unknown>;
    globalSettings[WALKIE_SETTINGS_KEY] = globalFields;
    const internal = manager as unknown as {
      globalSettings: Record<string, unknown>;
      modifiedFields: Set<string>;
      save: () => void;
      flush: () => Promise<void>;
    };
    internal.globalSettings = globalSettings;
    internal.modifiedFields.add(WALKIE_SETTINGS_KEY);
    internal.save();
    await internal.flush();
  } catch {
    // non-critical
  }
}

/** Persist project-local overrides (topicId, topicName) to <cwd>/.pi/settings.json under walkie */
async function persistProjectConfig(cwd: string, partial: Pick<Partial<WalkieConfig>, "topicId" | "topicName">): Promise<void> {
  try {
    const manager = SettingsManager.create(cwd);
    await manager.reload();
    const projectSettings = manager.getProjectSettings() as Record<string, unknown>;
    const existing = normalizeWalkieConfig(projectSettings[WALKIE_SETTINGS_KEY]);
    const merged = { ...existing, ...partial };
    projectSettings[WALKIE_SETTINGS_KEY] = merged;
    const internal = manager as unknown as {
      modifiedProjectFields: Set<string>;
      saveProjectSettings: (settings: Record<string, unknown>) => void;
      flush: () => Promise<void>;
    };
    internal.modifiedProjectFields.add(WALKIE_SETTINGS_KEY);
    internal.saveProjectSettings(projectSettings);
    await internal.flush();
  } catch {
    // non-critical
  }
}

// ── Voice / STT helpers ───────────────────────────────────────────────────────

const VOICE_CONFIG_PATH = join(PI_DIR, "voice.json");

interface VoiceConfig {
  provider?: string;
  lang?: string;
}

function loadVoiceConfigSync(cwd: string = process.cwd()): VoiceConfig {
  try {
    const manager = SettingsManager.create(cwd);
    const globalSettings = manager.getGlobalSettings() as Record<string, unknown>;
    const projectSettings = manager.getProjectSettings() as Record<string, unknown>;
    const merged = {
      ...(globalSettings.voice as VoiceConfig | undefined),
      ...(projectSettings.voice as VoiceConfig | undefined),
    };
    if (merged && (merged.provider || merged.lang)) return merged;
  } catch {
    // fall back to legacy sidecar
  }
  try {
    return JSON.parse(readFileSync(VOICE_CONFIG_PATH, "utf8")) as VoiceConfig;
  } catch {
    return {};
  }
}

function isConfigured(c: Partial<WalkieConfig>): c is WalkieConfig {
  return (
    typeof c.botToken === "string" &&
    c.botToken.length > 0 &&
    typeof c.chatId === "number" &&
    typeof c.allowedUserId === "number"
  );
}

/** True when walkie is fully configured AND enabled — the common guard. */
function isActive(c: Partial<WalkieConfig>): c is WalkieConfig {
  if (!isConfigured(c)) return false;
  return c.enabled;
}

// ── Interactive choices ───────────────────────────────────────────────────────

interface ChoiceOption {
  id: string;
  label: string;
  submit_text: string;
}

interface PendingInteraction {
  options: ChoiceOption[];
  messageId: number | null;
  expiresAt: number;
}

const INTERACTION_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SETUP_MODE_TTL_MS  =  5 * 60 * 1000; //  5 minutes

/**
 * System prompt appended when walkie is active so the agent knows how to
 * produce Telegram inline keyboard choices.
 */
const CHOICES_SYSTEM_PROMPT = `
## Telegram Interactive Buttons

When communicating via Telegram you may present the user with tappable choice buttons by appending a JSON block at the very end of your response (after all your text):

{"v":1,"options":[
  {"id":"a","label":"✅ Option A","submit_text":"I choose option A"},
  {"id":"b","label":"❌ Option B","submit_text":"I choose option B"}
]}

Rules:
- 2–4 options only
- label: shown on the Telegram button (keep it short, ≤ 30 chars)
- submit_text: injected as the user's next message when the button is tapped
- Use only for genuine discrete choices, not open-ended questions
- The JSON block must be the very last thing in your response`.trim();

/**
 * Extract a choices block from the end of an assistant response.
 * Returns the visible text (without the JSON) and the parsed options, or
 * null choices if no valid block is found.
 */
function parseChoicesBlock(text: string): { visibleText: string; choices: ChoiceOption[] | null } {
  // Use a regex so we match the block regardless of whitespace around JSON punctuation
  // (e.g. the model may produce `{"v": 1, "options": [` instead of the compact form).
  // We scan for the LAST occurrence in case the model produces multiple candidate blocks.
  const markerRe = /\{"v"\s*:\s*1\s*,\s*"options"\s*:\s*\[/g;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(text)) !== null) lastMatch = m;
  if (!lastMatch) return { visibleText: text, choices: null };
  const idx = lastMatch.index;
  try {
    const block = JSON.parse(text.slice(idx)) as { v: number; options: ChoiceOption[] };
    if (!Array.isArray(block.options)) return { visibleText: text, choices: null };
    if (block.options.length < 2 || block.options.length > 4) return { visibleText: text, choices: null };
    if (!block.options.every(o => o.id && o.label && o.submit_text)) return { visibleText: text, choices: null };
    return { visibleText: text.slice(0, idx).trim(), choices: block.options };
  } catch {
    return { visibleText: text, choices: null };
  }
}

/** Telegram's hard limit for the callback_data field on inline buttons. */
const CALLBACK_DATA_MAX_BYTES = 64;

function buildChoicesKeyboard(interactionId: number, options: ChoiceOption[]): tg.InlineKeyboardMarkup {
  return {
    inline_keyboard: options.map(opt => {
      const prefix = `wk:${interactionId}:`;
      // Truncate the id if the full callback_data would exceed 64 bytes (rare in practice
      // since the system prompt shows single-letter ids, but enforced defensively).
      let id = opt.id;
      while (Buffer.byteLength(prefix + id, "utf8") > CALLBACK_DATA_MAX_BYTES && id.length > 1) {
        id = id.slice(0, -1);
      }
      return [{ text: opt.label, callback_data: prefix + id }];
    }),
  };
}

// ── Bot command menu ──────────────────────────────────────────────────────────

/** Default (English) command descriptions — registered as the global fallback */
const BOT_COMMANDS: tg.BotCommand[] = [
  { command: "abort",   description: "Stop the current agent run immediately" },
  { command: "status",  description: "Show agent state, model, and context usage" },
  { command: "compact", description: "Compress context to free up space" },
  { command: "new",     description: "New session (queued if agent is active)" },
  { command: "think",   description: "Cycle thinking level: none → low → high" },
  { command: "stream",  description: "Toggle live draft preview on/off" },
  { command: "mute",    description: "Silence walkie notifications" },
  { command: "unmute",  description: "Resume walkie notifications" },
];

/** Spanish translations — shown when the user's Telegram language is set to Spanish */
const BOT_COMMANDS_ES: tg.BotCommand[] = [
  { command: "abort",   description: "Detener la ejecución del agente inmediatamente" },
  { command: "status",  description: "Ver estado del agente, modelo y contexto" },
  { command: "compact", description: "Comprimir el contexto para liberar espacio" },
  { command: "new",     description: "Nueva sesión (en cola si el agente está activo)" },
  { command: "think",   description: "Cambiar nivel de razonamiento: ninguno → bajo → alto" },
  { command: "stream",  description: "Activar/desactivar vista previa en tiempo real" },
  { command: "mute",    description: "Silenciar notificaciones de walkie" },
  { command: "unmute",  description: "Reanudar notificaciones de walkie" },
];

// ── Topic routing helpers ─────────────────────────────────────────────────────

/**
 * Returns SendMessageOptions with message_thread_id pre-filled when the config
 * has a topicId. Merge into every outbound sendMessage call so topic routing is
 * applied automatically without repeating the check at every call site.
 *
 * Usage:
 *   await tg.sendMessage(token, chatId, text, { ...topicOptions(config), parse_mode: "HTML" });
 */
function topicOptions(config: Partial<WalkieConfig>): Partial<tg.SendMessageOptions> {
  return config.topicId ? { message_thread_id: config.topicId } : {};
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the last text-only assistant message from the agent's message history.
 * Skips thinking blocks (content type !== "text"), tool calls, and non-assistant turns.
 *
 * AgentMessage's role/content fields are not re-exported from pi's public API
 * surface — the single cast is isolated here rather than scattered in agent_end.
 */
function extractLastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: Array<{ type?: string; text?: string }> };
    if (msg.role !== "assistant") continue;
    const text = (msg.content ?? [])
      .filter(c => c.type === "text")
      .map(c => c.text ?? "")
      .join("\n\n")
      .trim();
    if (text) return text;
  }
  return "";
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function walkieExtension(pi: ExtensionAPI) {
  // ─── pi API shims ─────────────────────────────────────────────────────────
  // getThinkingLevel / setThinkingLevel are available on ExtensionAPI but not
  // re-exported from the package root index in this version of pi.

  function getThinkingLevel(): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return String((pi as any).getThinkingLevel?.() ?? "none");
  }

  function setThinkingLevel(level: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pi as any).setThinkingLevel?.(level);
  }

  // ─── Module-level state ──────────────────────────────────────────────────

  let config: Partial<WalkieConfig> = loadConfigSync();
  let cachedVoiceConfig: VoiceConfig = {};
  let pollingAbort: AbortController | null = null;
  /** True while pi agent loop is running (between agent_start → agent_end) */
  let isStreaming = false;
  /** True after /walkie setup — next Telegram message claims chat_id + user_id */
  let setupMode = false;
  /** Timer that expires setupMode after SETUP_MODE_TTL_MS if no pairing message arrives */
  let setupModeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Stored ctx for abort() calls from polling loop */
  let lastCtx: ExtensionContext | null = null;

  // ─── Per-run counters (reset on agent_start) ─────────────────────────────

  let agentStartTime: number | null = null;
  let turnCount = 0;
  let filesChanged = 0;
  /** message_id of the inbound Telegram message that triggered the current run */
  let runTriggerMessageId: number | null = null;
  /** message_id of a followUp message queued during a run — promoted to runTriggerMessageId at the next agent_start */
  let nextRunTriggerMessageId: number | null = null;
  /** Current activity label shown in heartbeat messages (thinking / tool / generic) */
  let agentPhase = "Processing request...";

  // ─── Message queue ────────────────────────────────────────────────────────
  // Messages that arrive while the agent is running are queued instead of
  // being injected as followUp (which can collide). After each agent_end,
  // the queue drains the next message, triggering a new run.

  const messageQueue = new MessageQueue();

  /** Drain the next queued message into the agent. Called from agent_end. */
  function drainQueue(): void {
    if (!messageQueue.pending) return;
    const next = messageQueue.shift()!;
    runTriggerMessageId = next.messageId;

    if (next.images?.length) {
      const content = [
        { type: "text" as const, text: next.text },
        ...next.images,
      ];
      pi.sendUserMessage(content);
    } else {
      pi.sendUserMessage(next.text);
    }
  }

  // ─── Text debounce buffer ─────────────────────────────────────────────────
  // Consecutive messages from the same chat within TEXT_DEBOUNCE_MS are merged
  // with \n into one message before being injected — so the agent sees one
  // coherent prompt instead of N separate turns.

  const TEXT_DEBOUNCE_MS = 3_000;

  interface PendingTextEntry {
    items: Array<{ text: string; messageId: number }>;
    timer: ReturnType<typeof setTimeout>;
  }

  let pendingTextEntry: PendingTextEntry | null = null;

  function flushPendingText(): void {
    if (!pendingTextEntry) return;
    const pending = pendingTextEntry;
    pendingTextEntry = null;

    const merged = pending.items.map(i => i.text).join("\n");
    const lastId = pending.items[pending.items.length - 1]!.messageId;

    if (isStreaming) {
      // Agent is busy — queue instead of followUp
      messageQueue.push({ text: merged, messageId: lastId });
    } else {
      runTriggerMessageId = lastId;
      pi.sendUserMessage(merged);
    }
  }

  /** Discard any buffered text without injecting it. */
  function cancelPendingText(): void {
    if (!pendingTextEntry) return;
    clearTimeout(pendingTextEntry.timer);
    pendingTextEntry = null;
  }

  // ─── Pending inline keyboard interactions ────────────────────────────────

  const pendingInteractions = new Map<number, PendingInteraction>();
  let interactionSeq = 0;

  function cleanExpiredInteractions(): void {
    const now = Date.now();
    for (const [id, interaction] of pendingInteractions) {
      if (interaction.expiresAt <= now) pendingInteractions.delete(id);
    }
  }

  // ─── Draft state (only active when config.streaming = true) ─────────────

  let draftState: DraftState | null = null;
  let draftIdCounter = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Keep-alive typing indicator for tool-call phases with no text output */
  let typingTimer: ReturnType<typeof setInterval> | null = null;

  // ─── Helpers ─────────────────────────────────────────────────────────────

  async function reloadConfigForCwd(ctx: ExtensionContext): Promise<void> {
    config = { enabled: true, streaming: true, ...loadConfigSync(), ...loadProjectConfigSync(ctx.cwd) };
    cachedVoiceConfig = loadVoiceConfigSync(ctx.cwd);
    updateStatus(ctx);

    if (isConfigured(config)) {
      await registerBotCommands(config.botToken, config.chatId);
    }
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const { setStatus } = ctx.ui;
    const colors = createUiColors(ctx.ui.theme);

    if (!config.enabled) {
      setStatus("walkie", colors.warning("walkie:off"));
      return;
    }
    if (setupMode) {
      setStatus("walkie", colors.warning("walkie:setup"));
      return;
    }
    if (!isConfigured(config)) {
      setStatus("walkie", colors.danger("walkie:unconfigured"));
      return;
    }
    setStatus("walkie", colors.success("walkie:on"));
  }

  /**
   * Send text to Telegram as HTML (converted from markdown), falling back to plain.
   * Returns the message_id of the last chunk sent, or null on failure / inactive.
   */
  async function send(text: string, extraOptions?: Partial<tg.SendMessageOptions>): Promise<number | null> {
    if (!isActive(config)) return null;
    const { botToken, chatId } = config;

    // Detach reply_markup so it is only attached to the last chunk, not every chunk.
    const { reply_markup, ...restExtra } = extraOptions ?? {};
    const topic = topicOptions(config);

    const formatted = formatForTelegram(text);
    const chunks = chunkText(formatted);

    let lastMessageId: number | null = null;
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const markupOpt = isLast && reply_markup ? { reply_markup } : {};

      try {
        const msg = await tg.sendMessage(botToken, chatId, chunks[i]!, {
          ...topic,
          parse_mode: "HTML",
          ...restExtra,
          ...markupOpt,
        });
        lastMessageId = msg.message_id;
      } catch (err) {
        if (!(err instanceof tg.TelegramError && err.statusCode === 400)) continue;

        // HTML parse failure on chunk i — fall back to plain text for the
        // UNSENT remainder only. We must not reuse the same chunk index against
        // chunkText(text): HTML chunk boundaries differ from plain-text chunk
        // boundaries, which can skip or duplicate content. Instead, derive the
        // remaining payload from the unsent formatted chunks and strip the small
        // Telegram HTML subset we generate.
        const remainingHtml = chunks.slice(i).join("");
        const remainingPlain = remainingHtml
          .replace(/<a\s+href="([^"]*)">/gi, "")
          .replace(/<\/?(?:b|i|s|code|pre|a)>/gi, "")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&");

        const plainChunks = chunkText(remainingPlain);
        for (let j = 0; j < plainChunks.length; j++) {
          const plainIsLast = j === plainChunks.length - 1;
          const plainMarkup = plainIsLast && reply_markup ? { reply_markup } : {};
          const msg = await tg.sendMessage(botToken, chatId, plainChunks[j]!, {
            ...topic,
            ...restExtra,
            ...plainMarkup,
          }).catch(() => null);
          if (msg) lastMessageId = msg.message_id;
        }
        return lastMessageId;
      }
    }
    return lastMessageId;
  }

  /** Send plain text with no parse mode */
  async function sendPlain(text: string): Promise<void> {
    if (!isActive(config)) return;
    const { botToken, chatId } = config;
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      await tg.sendMessage(botToken, chatId, chunk, topicOptions(config)).catch(() => {});
    }
  }

  type FlushResult = "ok" | "rate_limited" | "peer_invalid" | "stale" | "skipped";

  /** Flush a DraftFlush to sendMessageDraft. Returns a result the caller acts on. */
  async function flushDraft(flush: DraftFlush): Promise<FlushResult> {
    if (!isActive(config) || !config.streaming) return "skipped";
    if (!draftState || flush.draftId !== draftState.draftId) return "stale";

    try {
      await tg.sendMessageDraft(config.botToken, config.chatId, flush.draftId, flush.text, { messageThreadId: config.topicId });
      return "ok";
    } catch (err) {
      if (err instanceof tg.TelegramError) {
        if (err.statusCode === 429) {
          const backoffMs = (err.retryAfter ?? 5) * 1000;
          if (draftState) suppressDraftUntil(draftState, backoffMs);
          return "rate_limited";
        }
        if (err.description.includes("TEXTDRAFT_PEER_INVALID")) {
          // Persist suppression for 24h so future sessions don't retry.
          config.draftSuppressedUntil = Date.now() + 24 * 60 * 60 * 1000;
          await persistConfig(config);
          return "peer_invalid";
        }
      }
      return "skipped";
    }
  }

  /**
   * Call flushDraft and null out draftState if the peer doesn't support drafts.
   * If a tool is currently running, appends the phase indicator to the draft text
   * so it remains visible alongside the streaming content.
   */
  async function flushDraftAndHandleResult(flush: DraftFlush): Promise<void> {
    const displayFlush = agentPhase.startsWith("🔧")
      ? { ...flush, text: `${flush.text}\n\n${agentPhase}` }
      : flush;
    const result = await flushDraft(displayFlush).catch(() => "skipped" as FlushResult);
    if (result === "peer_invalid") draftState = null;
  }

  function stopTimers(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = null;
    }
  }

  function stopPolling(): void {
    pollingAbort?.abort();
    pollingAbort = null;
  }

  // ─── Polling Loop ─────────────────────────────────────────────────────────

  async function startPolling(initialOffset = 0): Promise<void> {
    if (pollingAbort) return; // already running
    if (!isConfigured(config) && !setupMode) return;
    if (!config.botToken) return;

    pollingAbort = new AbortController();
    const { signal } = pollingAbort;
    const token = config.botToken;

    let offset = initialOffset;
    let errorCount = 0;

    while (!signal.aborted) {
      try {
        const updates = await tg.getUpdates(token, { offset, timeout: 30 }, signal);
        errorCount = 0;

        for (const update of updates) {
          offset = update.update_id + 1;
          handleUpdate(update).catch((err) => { console.error("[walkie] handleUpdate error:", err); });
        }
      } catch (err) {
        if (signal.aborted) break;
        errorCount++;
        // Exponential backoff: 1s, 2s, 4s … 60s max
        const backoffMs = Math.min(1_000 * 2 ** (errorCount - 1), 60_000);
        await sleep(backoffMs, signal).catch(() => {});
      }
    }
  }

  /**
   * Register the bot command menu. When chatId is known, uses a chat-scoped
   * registration so commands only appear for this specific group — important
   * when multiple walkie instances share the same bot token.
   */
  async function registerBotCommands(token: string, chatId?: number): Promise<void> {
    const scope: tg.BotCommandScope | undefined = chatId
      ? { type: "chat", chat_id: chatId }
      : undefined;
    await tg.setMyCommands(token, BOT_COMMANDS, undefined, scope).catch(() => {});
    await tg.setMyCommands(token, BOT_COMMANDS_ES, "es", scope).catch(() => {});
  }

  // ─── Update sub-handlers ─────────────────────────────────────────────────

  /**
   * Resolve the effective forum topic thread ID from an incoming message.
   * Mirrors nullclaw's messageThreadId logic in telegram_update_ingress.zig:
   * 1. Use message_thread_id when explicitly present and > 0
   * 2. Fall back to reply_to_message.message_id when is_topic_message is true
   *    (Telegram omits message_thread_id on the root message of a topic)
   */
  function resolveMessageThreadId(msg: tg.TelegramMessage | undefined): number | undefined {
    if (!msg) return undefined;
    if (msg.message_thread_id && msg.message_thread_id > 0) return msg.message_thread_id;
    // Telegram fallback: topic root messages carry is_topic_message but no thread_id
    // The thread ID equals the first message_id in the topic (reply_to_message)
    // We don't have reply_to_message in our minimal TelegramMessage type, so we
    // rely solely on the explicit field — good enough for bot-created topics.
    return undefined;
  }

  async function handleSetupPairing(msg: tg.TelegramMessage): Promise<void> {
    config.chatId = msg.chat.id;
    config.allowedUserId = msg.from!.id;
    config.enabled = true;
    setupMode = false;
    if (setupModeTimer) { clearTimeout(setupModeTimer); setupModeTimer = null; }
    await persistConfig(config);
    if (lastCtx) updateStatus(lastCtx);
    await registerBotCommands(config.botToken!, config.chatId);
    await tg.sendMessage(config.botToken!, config.chatId, "✅ Paired! Pi will send updates to this chat.", topicOptions(config)).catch(() => {});
  }

  async function handleCallbackQuery(cq: tg.TelegramCallbackQuery): Promise<void> {
    if (!isConfigured(config)) return;
    await tg.answerCallbackQuery(config.botToken, cq.id).catch(() => {});

    if (!cq.data) return;

    if (cq.data.startsWith("wk:")) {
      const parts = cq.data.split(":");
      const interactionId = Number(parts[1]);
      // Rejoin with ":" to handle any colons inside the id itself.
      const optionId = parts.slice(2).join(":");
      if (!Number.isFinite(interactionId) || !optionId) return;

      const interaction = pendingInteractions.get(interactionId);
      if (!interaction || interaction.expiresAt <= Date.now()) return;

      const opt = interaction.options.find(o => o.id === optionId);
      if (!opt) return;

      pendingInteractions.delete(interactionId);
      if (interaction.messageId !== null) {
        await tg.editMessageReplyMarkup(config.botToken, config.chatId, interaction.messageId).catch(() => {});
      }
      if (isStreaming) {
        messageQueue.push({ text: opt.submit_text, messageId: cq.message?.message_id ?? 0 });
      } else {
        runTriggerMessageId = cq.message?.message_id ?? null;
        pi.sendUserMessage(opt.submit_text);
      }
    } else {
      pi.events.emit("walkie:callback", { data: cq.data });
    }
  }

  async function handleCommand(text: string): Promise<void> {
    if (!isConfigured(config)) return;
    // Strip @BotName suffix used in group chats (e.g. /abort@MyBot → /abort)
    const rawCmd = text.split(/\s+/)[0]!;
    const cmd = rawCmd.includes("@") ? rawCmd.slice(0, rawCmd.indexOf("@")) : rawCmd;

    switch (cmd) {
      case "/abort":
        cancelPendingText();
        await tg.sendMessage(config.botToken, config.chatId, "⛔ Abort signal sent.", topicOptions(config)).catch(() => {});
        if (isStreaming) {
          pi.sendUserMessage("Stop what you're doing and summarize what happened.", { deliverAs: "steer" });
        }
        lastCtx?.abort();
        break;

      case "/status": {
        const projectName = lastCtx ? basename(lastCtx.cwd) : "unknown";
        const modelName = lastCtx?.model?.name ?? "unknown";
        const usage = lastCtx?.getContextUsage();
        const usageStr = usage?.percent != null
          ? `${Math.round(usage.percent)}% · ${(usage.tokens ?? 0).toLocaleString()} tokens`
          : "unknown";
        const thinkingLevel = getThinkingLevel();
        const topicLine = config.topicId
          ? `Topic: <code>${escapeHTML(config.topicName ?? String(config.topicId))}</code> (#${config.topicId})`
          : null;
        const html = [
          `📍 <b>Pi Status</b>`,
          `Project: <code>${escapeHTML(projectName)}</code>`,
          topicLine,
          `Agent: ${isStreaming ? "🔄 running" : "⏸ idle"}`,
          `Model: <code>${escapeHTML(String(modelName))}</code>`,
          `Context: ${usageStr}`,
          `Thinking: ${thinkingLevel}`,
          `Streaming: ${config.streaming ? "✅" : "❌"}`,
          `Walkie: ${config.enabled ? "✅" : "❌"}`,
        ].filter(Boolean).join("\n");
        await tg.sendMessage(config.botToken, config.chatId, html, { ...topicOptions(config), parse_mode: "HTML" }).catch(() => {});
        break;
      }

      case "/think": {
        const levels = ["none", "low", "high"] as const;
        const current = getThinkingLevel();
        const idx = levels.indexOf(current as typeof levels[number]);
        // Without the guard, an unrecognised level gives indexOf() === -1, so
        // (-1 + 1) % 3 === 0 → "none", silently resetting instead of advancing.
        // Math.max(0, idx) treats any unknown level as "none" and advances to "low".
        const next = levels[(Math.max(0, idx) + 1) % levels.length]!;
        setThinkingLevel(next);
        await sendPlain(`🧠 Thinking: ${current} → ${next}`).catch(() => {});
        break;
      }

      case "/compact":
        if (isStreaming) {
          await sendPlain("⚠️ Cannot compact while agent is running.").catch(() => {});
          break;
        }
        await sendPlain("🗜 Compacting context...").catch(() => {});
        lastCtx?.compact({
          onComplete: async () => { await sendPlain("✅ Context compacted.").catch(() => {}); },
          onError:    async (err) => { await sendPlain(`❌ Compaction failed: ${err.message}`).catch(() => {}); },
        });
        break;

      case "/new":
        if (isStreaming) {
          messageQueue.push({ text: "When you're done, please start a new session.", messageId: 0 });
          await sendPlain("📋 Queued: new session after current task.").catch(() => {});
        } else {
          await sendPlain("⚠️ Use /new in the terminal to start a new session.").catch(() => {});
        }
        break;

      case "/stream":
        config.streaming = !config.streaming;
        // Clear any peer-invalid suppression so the toggle acts as a manual reset.
        if (config.streaming) config.draftSuppressedUntil = undefined;
        await persistConfig(config);
        if (lastCtx) updateStatus(lastCtx);
        await sendPlain(`📡 Streaming ${config.streaming ? "enabled ✅" : "disabled ❌"}`).catch(() => {});
        break;

      case "/mute":
        // Send confirmation before disabling — sendPlain no-ops when enabled=false
        await sendPlain("🔕 Notifications muted. Send /unmute to resume.").catch(() => {});
        config.enabled = false;
        await persistConfig(config);
        if (lastCtx) updateStatus(lastCtx);
        break;

      case "/unmute":
        config.enabled = true;
        await persistConfig(config);
        if (lastCtx) updateStatus(lastCtx);
        await sendPlain("🔔 Notifications resumed.").catch(() => {});
        break;
    }
  }

  /**
   * Buffer incoming text with a 3s debounce. Rapid consecutive messages are
   * merged with \n into one before being injected, so the agent sees a single
   * coherent prompt. 👀 fires immediately for each message.
   */
  function injectText(text: string, messageId: number): void {
    tg.setMessageReaction(config.botToken, config.chatId, messageId, "👀").catch(() => {});

    if (pendingTextEntry) {
      clearTimeout(pendingTextEntry.timer);
      pendingTextEntry.items.push({ text, messageId });
      pendingTextEntry.timer = setTimeout(flushPendingText, TEXT_DEBOUNCE_MS);
    } else {
      pendingTextEntry = {
        items: [{ text, messageId }],
        timer: setTimeout(flushPendingText, TEXT_DEBOUNCE_MS),
      };
    }
  }

  async function handlePhoto(msg: tg.TelegramMessage): Promise<void> {
    await tg.setMessageReaction(config.botToken, config.chatId, msg.message_id, "👀").catch(() => {});
    const largest = msg.photo![msg.photo!.length - 1]!;
    try {
      const fileInfo = await tg.getFile(config.botToken, largest.file_id);
      if (!fileInfo.file_path) {
        await sendPlain("❌ Could not retrieve photo from Telegram (no file path returned).").catch(() => {});
        return;
      }
      const buf = await tg.downloadFile(config.botToken, fileInfo.file_path);
      const caption = (msg.caption ?? msg.text ?? "Image from Telegram").trim();
      const content = [
        { type: "text"  as const, text: caption },
        // Telegram transcodes all photos to JPEG before delivery, so JPEG is always correct here.
        { type: "image" as const, data: buf.toString("base64"), mimeType: "image/jpeg" },
      ];
      if (isStreaming) {
        messageQueue.push({
          text: caption,
          messageId: msg.message_id,
          images: [{ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" }],
        });
      } else {
        runTriggerMessageId = msg.message_id;
        pi.sendUserMessage(content);
      }
    } catch (err) {
      await sendPlain(`❌ Could not send photo: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    }
  }

  async function handleVoice(msg: tg.TelegramMessage): Promise<void> {
    await tg.setMessageReaction(config.botToken, config.chatId, msg.message_id, "👀").catch(() => {});
    const voiceConfig = cachedVoiceConfig;
    const stt = voiceConfig.provider
      ? createProvider(voiceConfig.provider as "groq" | "openai" | "daemon")
      : detectProvider()?.provider ?? null;
    if (!stt) {
      await sendPlain("⚠️ No STT provider for voice transcription.\nSet GROQ_API_KEY or OPENAI_API_KEY and run /voice config.").catch(() => {});
      return;
    }
    try {
      const fileInfo = await tg.getFile(config.botToken, msg.voice!.file_id);
      if (!fileInfo.file_path) {
        await sendPlain("❌ Could not retrieve voice message from Telegram (no file path returned).").catch(() => {});
        return;
      }
      const buf = await tg.downloadFile(config.botToken, fileInfo.file_path);
      const lang = voiceConfig.lang ?? "en";
      const transcription = await stt.transcribe(buf, lang, "", { mimeType: "audio/ogg", filename: "voice.ogg" });
      if (!transcription.trim()) {
        await sendPlain("⚠️ No speech detected.").catch(() => {});
        return;
      }
      await sendPlain(`🎤 ${transcription.trim()}`).catch(() => {});
      await tg.setMessageReaction(config.botToken, config.chatId, msg.message_id, "✅").catch(() => {});
      if (isStreaming) {
        messageQueue.push({ text: transcription.trim(), messageId: msg.message_id });
      } else {
        runTriggerMessageId = msg.message_id;
        pi.sendUserMessage(transcription.trim());
      }
    } catch (err) {
      await sendPlain(`❌ Transcription failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    }
  }

  async function handleUpdate(update: tg.TelegramUpdate): Promise<void> {
    // ── Setup mode: claim the first real user ────────────────────────────
    cleanExpiredInteractions();
    if (setupMode && update.message?.from && !update.message.from.is_bot) {
      await handleSetupPairing(update.message);
      return;
    }

    // ── Security: only accept from allowedUserId ─────────────────────────
    if (!isConfigured(config)) return;
    const senderId = update.message?.from?.id ?? update.callback_query?.from.id;
    if (senderId !== config.allowedUserId) return;

    // ── Topic filter: ignore messages not in our configured topic ─────────
    if (config.topicId !== undefined) {
      const msgThreadId = resolveMessageThreadId(update.message)
        ?? update.callback_query?.message?.message_thread_id;
      if (msgThreadId !== config.topicId) return;
    }

    // ── Inline button ─────────────────────────────────────────────────────
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return;
    }

    if (!update.message) return;
    const msg = update.message;
    const text = msg.text?.trim() ?? "";

    // ── Commands ──────────────────────────────────────────────────────────
    if (text.startsWith("/")) {
      await handleCommand(text);
      return;
    }

    // ── Content → inject into pi ──────────────────────────────────────────
    if (text)                   injectText(text, msg.message_id);
    else if (msg.photo?.length) await handlePhoto(msg);
    else if (msg.voice)         await handleVoice(msg);
    else {
      // Document, sticker, video, etc. — let the user know rather than silently drop.
      await sendPlain("⚠️ Unsupported message type — send text, a photo, or a voice message.").catch(() => {});
    }
  }

  // ─── Pi Events ────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    // Merge: global defaults ← global config ← project-local overrides
    // Project-local settings hold topicId/topicName so each
    // pi instance in a different project has its own topic without collision.
    await reloadConfigForCwd(ctx);

    if (!config.botToken) return;
    // Skip updates that accumulated while pi was offline, then start polling.
    // Outbound sends are gated on config.enabled — polling always runs when configured.
    const initialOffset = isConfigured(config)
      ? await tg.getNextUpdateOffset(config.botToken).catch(() => 0)
      : 0;
    startPolling(initialOffset).catch(() => {});

    // Ensure bot command menu is registered (idempotent, best-effort)
    if (isConfigured(config)) {
      await registerBotCommands(config.botToken, config.chatId);
    }

    // Only notify on a genuinely fresh session (no prior entries)
    const isFresh = ctx.sessionManager.getEntries().length === 0;
    if (isFresh && isConfigured(config)) {
      const projectName = config.topicName ?? basename(ctx.cwd);
      await sendPlain(`🟢 Pi started · ${projectName}`).catch(() => {});
    }
  });

  pi.on("session_switch", async (_event, ctx) => {
    lastCtx = ctx;
    await reloadConfigForCwd(ctx);
    if (!isActive(config)) return;
    const projectName = config.topicName ?? basename(ctx.cwd);
    await sendPlain(`📂 Session switched · ${projectName}`).catch(() => {});
  });

  pi.on("before_agent_start", async (_event, _ctx) => {
    if (!isActive(config)) return;
    return {
      message: {
        content: CHOICES_SYSTEM_PROMPT,
        display: false,
      },
    };
  });

  pi.on("agent_start", async (_event, ctx) => {
    lastCtx = ctx;
    isStreaming = true;
    agentStartTime = Date.now();
    turnCount = 0;
    filesChanged = 0;
    agentPhase = "Processing request...";
    // Promote a followUp trigger when no direct trigger was set for this run
    // (i.e. this run was queued via deliverAs:"followUp" during a previous run).
    if (runTriggerMessageId === null) {
      runTriggerMessageId = nextRunTriggerMessageId;
    }
    nextRunTriggerMessageId = null;

    if (!isActive(config)) return;

    // Keep-alive typing indicator every 4s until the first draft flush is visible
    typingTimer = setInterval(async () => {
      if (!isActive(config)) return;
      if (draftState?.lastFlushCharOffset) return; // draft is already visible, stop typing indicator
      await tg.sendChatAction(config.botToken!, config.chatId!, "typing", config.topicId).catch(() => {});
    }, 4_000);

    if (!config.streaming) return;

    // Skip draft creation if this peer previously returned TEXTDRAFT_PEER_INVALID
    if (config.draftSuppressedUntil && Date.now() < config.draftSuppressedUntil) return;

    // Create fresh draft state for this run
    draftIdCounter++;
    draftState = createDraftState(draftIdCounter, agentStartTime);

    // Heartbeat timer: fires every DRAFT_HEARTBEAT_INTERVAL_MS
    heartbeatTimer = setInterval(async () => {
      if (!draftState) return;
      const flush = heartbeatDraft(draftState, Date.now(), agentPhase);
      if (flush) await flushDraftAndHandleResult(flush);
    }, DRAFT_HEARTBEAT_INTERVAL_MS);
  });

  // message_update is typed in pi's internal types.d.ts but MessageUpdateEvent
  // is not re-exported from the package root index — cast to any for this handler.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pi as any).on("message_update", async (event: any) => {
    const ae = event?.assistantMessageEvent;
    if (!ae) return;

    if (ae.type === "thinking_delta") {
      // Track phase for heartbeat label — don't add raw thoughts to the draft buffer
      agentPhase = "🧠 Thinking...";
      return;
    }

    if (ae.type !== "text_delta" || typeof ae.delta !== "string") return;

    // Switched from thinking to text output — reset phase label
    agentPhase = "Processing request...";

    if (!isActive(config) || !config.streaming || !draftState) return;
    const flush = appendDraftChunk(draftState, ae.delta as string, Date.now());
    if (flush) await flushDraftAndHandleResult(flush);
  });

  pi.on("turn_start", async (event) => {
    turnCount = event.turnIndex + 1;
  });

  pi.on("tool_call", async (event) => {
    agentPhase = `🔧 ${event.toolName}...`;

    // Immediately push a draft update so the tool name is visible at once,
    // not just on the next 12s heartbeat tick. We send directly without
    // modifying the buffer so the tool label doesn't bleed into the final message.
    if (!draftState || !isActive(config) || !config.streaming) return;
    if (draftState.suppressUntil > Date.now()) return;

    const nowMs = Date.now();
    const base = draftState.buffer.trim();
    const displayText = base
      ? buildTransportText(`${base}\n\n${agentPhase}`, draftState.startedAt, nowMs)
      : buildHeartbeatText(draftState.startedAt, nowMs, agentPhase);

    await tg.sendMessageDraft(config.botToken, config.chatId, draftState.draftId, displayText, { messageThreadId: config.topicId })
      .catch(() => {});
  });

  pi.on("tool_result", async (event) => {
    if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
      filesChanged++;
    }
    agentPhase = "Processing request...";
  });

  pi.on("agent_end", async (event, ctx) => {
    lastCtx = ctx;
    isStreaming = false;
    stopTimers();
    draftState = null;

    if (!isActive(config)) return;

    const elapsed = agentStartTime !== null ? Date.now() - agentStartTime : 0;
    agentStartTime = null;

    const lastAssistantText = extractLastAssistantText(event.messages);
    if (!lastAssistantText) return;

    const stats: AgentStats = {
      turnCount,
      filesChanged,
      elapsedMs: elapsed,
    };

    cleanExpiredInteractions();

    const { visibleText, choices } = parseChoicesBlock(lastAssistantText);
    const body = buildFinalMessage(choices ? visibleText : lastAssistantText, stats);
    const replyOptions = runTriggerMessageId !== null
      ? { reply_parameters: { message_id: runTriggerMessageId } }
      : undefined;

    if (choices) {
      interactionSeq++;
      const id = interactionSeq;
      const sentMessageId = await send(body, {
        reply_markup: buildChoicesKeyboard(id, choices),
        ...replyOptions,
      }).catch(() => null);
      pendingInteractions.set(id, {
        options: choices,
        messageId: sentMessageId,
        expiresAt: Date.now() + INTERACTION_TTL_MS,
      });
    } else {
      await send(body, replyOptions).catch(() => {});
    }

    // React ✅ on the message that triggered this run
    if (isActive(config) && runTriggerMessageId !== null) {
      await tg.setMessageReaction(config.botToken, config.chatId, runTriggerMessageId, "✅").catch(() => {});
    }
    runTriggerMessageId = null;

    // Drain next queued message (if any) to start the next run
    drainQueue();
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    stopPolling();
    stopTimers();
    if (setupModeTimer) { clearTimeout(setupModeTimer); setupModeTimer = null; }
    if (pendingTextEntry) { clearTimeout(pendingTextEntry.timer); pendingTextEntry = null; }
    messageQueue.clear();
    if (isActive(config)) {
      await sendPlain("🔴 Pi session ended").catch(() => {});
    }
  });

  // ─── Commands ─────────────────────────────────────────────────────────────

  pi.registerCommand("walkie", {
    description: "Telegram bridge — toggle, setup, or configure",

    getArgumentCompletions: (prefix: string) => {
      const subs = ["setup", "topic", "start", "stop", "status", "stream"];
      const filtered = subs.filter((s) => s.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
    },

    handler: async (args, ctx) => {
      lastCtx = ctx;
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() ?? "";
      const subArgs = parts.slice(1).join(" ");

      // ── No arg: toggle ─────────────────────────────────────────────────
      if (!sub) {
        config.enabled = !config.enabled;
        await persistConfig(config);
        updateStatus(ctx);
        ctx.ui.notify(config.enabled ? "Walkie enabled" : "Walkie disabled", "info");

        if (config.enabled && isConfigured(config) && !pollingAbort) {
          startPolling().catch(() => {});
        } else if (!config.enabled) {
          stopPolling();
        }
        return;
      }

      switch (sub) {
        // ── Setup: enter pairing mode ─────────────────────────────────────
        case "setup": {
          const hint = config.botToken
            ? `Current: ${config.botToken.slice(0, 12)}… — leave blank to keep, or enter a new token`
            : "Enter your Telegram bot token from @BotFather";
          const token = await ctx.ui.input("Bot Token", hint);
          if (token === null) {
            ctx.ui.notify("Setup cancelled", "info");
            return;
          }
          const trimmed = token.trim();
          if (trimmed) {
            config.botToken = trimmed;
            await persistConfig(config);
          } else if (!config.botToken) {
            ctx.ui.notify("No bot token provided — setup cancelled.", "warning");
            return;
          }

          // Optional: topic ID for forum-group multi-project routing
          const currentTopic = config.topicId ? `Current: ${config.topicId}` : "none";
          const topicHint = `Forum topic ID (message_thread_id) — leave blank to clear / use no topic. Current: ${currentTopic}`;
          const topicInput = await ctx.ui.input("Topic ID (optional)", topicHint);
          if (topicInput !== null) {
            const trimmedTopic = topicInput.trim();
            const tid = parseInt(trimmedTopic, 10);
            if (!isNaN(tid) && tid > 0) {
              config.topicId = tid;
            } else if (trimmedTopic === "") {
              config.topicId = undefined;
              config.topicName = undefined;
            } else {
              config.topicId = undefined;
              config.topicName = undefined;
            }
          }

          // Topic name (shown in notifications)
          if (config.topicId) {
            const nameHint = config.topicName
              ? `Current: ${config.topicName} — leave blank to keep`
              : "Short project name shown in notifications (e.g. pi-agent-kit)";
            const nameInput = await ctx.ui.input("Project name (optional)", nameHint);
            if (nameInput !== null && nameInput.trim()) {
              config.topicName = nameInput.trim();
            }
          }

          setupMode = true;
          // Expire setup mode automatically if nobody pairs within 5 minutes.
          if (setupModeTimer) clearTimeout(setupModeTimer);
          setupModeTimer = setTimeout(() => {
            if (setupMode) {
              setupMode = false;
              setupModeTimer = null;
              if (lastCtx) updateStatus(lastCtx);
              lastCtx?.ui.notify("⏱ Setup mode expired — run /walkie setup again to pair.", "warning");
            }
          }, SETUP_MODE_TTL_MS);

          config.enabled = true;
          await persistConfig(config);
          await persistProjectConfig(ctx.cwd, { topicId: config.topicId, topicName: config.topicName });
          updateStatus(ctx);

          // Restart polling with the new token, skipping backlog accumulated while offline
          stopPolling();
          const initialOffset = config.botToken
            ? await tg.getNextUpdateOffset(config.botToken).catch(() => 0)
            : 0;
          startPolling(initialOffset).catch(() => {});

          ctx.ui.notify(
            "📱 Send any message to your Telegram bot to pair this chat (expires in 5 min).",
            "info",
          );
          break;
        }

        // ── Start ──────────────────────────────────────────────────────────
        case "start": {
          config.enabled = true;
          await persistConfig(config);
          updateStatus(ctx);

          if (isConfigured(config) && !pollingAbort) {
            const initialOffset = await tg.getNextUpdateOffset(config.botToken).catch(() => 0);
            startPolling(initialOffset).catch(() => {});
          }
          ctx.ui.notify("Walkie started", "info");
          break;
        }

        // ── Stop ───────────────────────────────────────────────────────────
        case "stop": {
          config.enabled = false;
          await persistConfig(config);
          stopPolling();
          updateStatus(ctx);
          ctx.ui.notify("Walkie stopped", "info");
          break;
        }

        // ── Stream: toggle live draft preview ─────────────────────────────
        case "stream": {
          config.streaming = !config.streaming;
          // Clear any peer-invalid suppression so re-enabling acts as a manual reset.
          if (config.streaming) config.draftSuppressedUntil = undefined;
          await persistConfig(config);
          ctx.ui.notify(
            `Live draft streaming ${config.streaming ? "enabled (default)" : "disabled"}`,
            "info",
          );
          break;
        }

        // ── Status ─────────────────────────────────────────────────────────
        case "status": {
          const lines = [
            `Token   : ${config.botToken ? config.botToken.slice(0, 12) + "…" : "not set"}`,
            `Chat ID : ${config.chatId ?? "not set"}`,
            `User ID : ${config.allowedUserId ?? "not set"}`,
            `Topic   : ${config.topicId ? `${config.topicName ?? "unnamed"} (#${config.topicId})` : "none"}`,
            `Enabled : ${config.enabled ? "yes" : "no"}`,
            `Stream  : ${config.streaming ? "yes" : "no"}`,
            `Polling : ${pollingAbort ? "active" : "stopped"}`,
            `Agent   : ${isStreaming ? "running" : "idle"}`,
            `Global  : ${join(getAgentDir(), "settings.json")}#${WALKIE_SETTINGS_KEY}`,
            `Project : ${join(ctx.cwd, ".pi", "settings.json")}#${WALKIE_SETTINGS_KEY}`,
          ];
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }

        // ── Topic: create a forum topic and save its ID ───────────────────
        case "topic": {
          if (!isConfigured(config)) {
            ctx.ui.notify("Walkie not configured — run /walkie setup first.", "warning");
            break;
          }
          const rawName = subArgs.trim();
          const topicName = rawName || basename(ctx.cwd);
          try {
            const { message_thread_id } = await tg.createForumTopic(config.botToken, config.chatId, topicName);
            config.topicId = message_thread_id;
            config.topicName = topicName;
            await persistConfig(config);
            await persistProjectConfig(ctx.cwd, { topicId: message_thread_id, topicName });
            ctx.ui.notify(
              `✅ Forum topic created: "${topicName}" (id: ${message_thread_id})\nAll messages now routed to this topic.`,
              "info",
            );
          } catch (err) {
            ctx.ui.notify(
              `❌ Could not create topic: ${err instanceof Error ? err.message : String(err)}\nMake sure the bot is admin in a supergroup with Topics enabled.`,
              "error",
            );
          }
          break;
        }

        default:
          ctx.ui.notify(
            "Usage: /walkie [setup | topic <name> | start | stop | status | stream]",
            "warning",
          );
      }
    },
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}


