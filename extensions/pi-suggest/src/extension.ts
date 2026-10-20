
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, TextContent } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  DynamicBorder,
  SessionManager,
  SettingsManager,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { createUiColors, getRegisteredEditorDecorators, isEditorRegistryInstalled, registerEditorDecorator } from "@aldoborrero/pi-common";
import { SuggestEditor } from "./editor";
import { filterSuggestion, parseSuggestionArray } from "./text.ts";
import { buildWorkspaceSummary, gatherGitContext, type SuggestGitContext } from "./context.ts";
import { DelegationTracker } from "./delegation-tracker.ts";
import { once } from "./once.ts";

const DEFAULT_SUGGESTION_MODEL = "current";
const MODEL_ENV = "PI_SUGGEST_MODEL";
const WIDGET_ID = "suggest";
const STATUS_ID = "suggest";
const MAX_CONTEXT_MESSAGES = 6;
const MAX_ASSISTANT_CHARS = 3000;
const MAX_USER_CHARS = 1200;
// Coalesce rapid successive agent_end events into a single generation, and
// enforce a floor between generations so bursts don't each spawn a model call.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 120;

const SUGGEST_DEBOUNCE_MS = 400;
const SUGGEST_MIN_INTERVAL_MS = 1500;

const SUGGEST_SYSTEM_PROMPT = `You predict what the user will most likely type next in a coding assistant.

Rules:
- Output only valid JSON.
- Return a JSON array containing up to 3 likely next user messages.
- Each array item must be a plain string.
- Rank the array by probability in descending order.
- The most likely next user message must always be at index 0.
- Return only 1 suggestion when there is a single clear next step.
- Only include 2 or 3 suggestions when they are meaningfully different options.
- Do not pad the array with near-duplicates, paraphrases, or tiny variations.
- If you include additional candidates, they must be less likely than the previous item.
- Prefer 2-12 words per string.
- Match the user's style and language.
- No explanation, no markdown, no extra wrapper object.
- No assistant voice (avoid: let me, I'll, here's, you should).
- No evaluative filler (avoid: thanks, looks good, perfect).
- If no obvious next step exists, return an empty JSON array [].`;

function buildSystemPrompt(git?: SuggestGitContext | null): string {
  if (!git || git.totalChanged === 0) return SUGGEST_SYSTEM_PROMPT;
  return `${SUGGEST_SYSTEM_PROMPT}
- The repository has ${git.totalChanged} uncommitted file(s) on branch ${git.branch ?? "unknown"}. If the recent conversation is consistent with those changes, the FIRST suggestion must be a commit message for them: conventional commits style, imperative mood, no body, at most 72 characters.`;
}

interface SuggestModelItem {
  provider: string;
  id: string;
  fullId: string;
  model: Model<any>;
}

interface SuggestState {
  enabled: boolean;
  debug: boolean;
  suggestions: string[];
  selectedSuggestionIndex: number;
  sourceTurnKey: string | null;
  generating: boolean;
  lastError: string | null;
  lastRawSuggestion: string | null;
  lastFilterReason: string | null;
  lastResolvedModel: string | null;
  lastGenerationStatus: string | null;
  lastModelResolutionReason: string | null;
  lastSuggestInputPreview: string | null;
  lastSuggestPayloadPreview: string | null;
  lastSuggestMessageCount: number | null;
  lastSuggestMessageRoles: string | null;
  lastAssistantContentKind: string | null;
  lastAssistantContentPreview: string | null;
  generationId: number;
  miniMode: boolean;
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, Math.max(0, maxChars - 1))}…`;
}

function isAssistantMessage(message: AgentMessage): boolean {
  return (message as { role?: unknown }).role === "assistant";
}

function isUserMessage(message: AgentMessage): boolean {
  return (message as { role?: unknown }).role === "user";
}

function getMessageContent(message: AgentMessage): unknown {
  return (message as { content?: unknown }).content;
}

function extractText(message: AgentMessage): string {
  const content = getMessageContent(message);
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const candidate = block as { type?: unknown; text?: unknown; content?: unknown };
      if (candidate.type === "text" && typeof candidate.text === "string") return candidate.text;
      if (typeof candidate.text === "string") return candidate.text;
      if (typeof candidate.content === "string") return candidate.content;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function safeGetAvailableModels(modelRegistry: ExtensionContext["modelRegistry"]): Model<any>[] {
  try {
    const available = modelRegistry.getAvailable();
    if (available.length > 0) return available as Model<any>[];
  } catch {
    // Fall back to all models below.
  }
  try {
    return modelRegistry.getAll() as Model<any>[];
  } catch {
    return [];
  }
}

function normalizeMessageText(message: AgentMessage, maxChars: number): string {
  return truncate(extractText(message).replace(/\s+/g, " ").trim(), maxChars);
}

function buildTurnKey(messages: AgentMessage[]): string {
  return messages
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((message) => `${(message as { role?: unknown }).role ?? "unknown"}:${normalizeMessageText(message, 80)}`)
    .join("|");
}

export function buildSuggestionInput(
  messages: AgentMessage[],
  cwd: string,
  git?: SuggestGitContext | null,
  workspace?: string | null,
): string | null {
  const relevant = messages
    .filter((message) => isUserMessage(message) || isAssistantMessage(message))
    .slice(-MAX_CONTEXT_MESSAGES);
  if (relevant.length === 0) return null;

  const lines = [
    `Project: ${cwd}`,
  ];

  if (git) {
    if (git.totalChanged > 0) {
      lines.push(
        `Git: branch=${git.branch ?? "unknown"} uncommitted=${git.totalChanged} files (staged=${git.staged}, unstaged=${git.unstaged}, untracked=${git.untracked})`,
      );
      if (git.changedSample.length > 0) {
        lines.push(`Changed: ${git.changedSample.join(" | ")}`);
      }
    } else {
      lines.push(`Git: branch=${git.branch ?? "unknown"} working tree clean`);
    }
  }
  if (workspace) {
    lines.push(`Workspace: ${workspace}`);
  }

  lines.push("Recent conversation:");

  for (const message of relevant) {
    const role = (message as { role?: unknown }).role === "assistant" ? "assistant" : "user";
    const limit = role === "assistant" ? MAX_ASSISTANT_CHARS : MAX_USER_CHARS;
    const text = normalizeMessageText(message, limit);
    if (!text) continue;
    lines.push(`${role}: ${text}`);
  }

  if (lines.length <= 2) return null;
  lines.push("Predict the user's next message as a JSON array.");
  return lines.join("\n");
}

type SuggestJsonConfig = {
  model?: string;
  defaultModel?: string;
};

type SuggestModelConfigInfo = {
  value: string;
  source: "env" | "project-settings" | "global-settings" | "default";
  path?: string;
  field?: "model" | "defaultModel";
};

const SUGGEST_SETTINGS_KEY = "suggest";

function getGlobalSuggestConfigPath(): string {
  return join(getAgentDir(), "settings.json");
}


function getProjectSuggestConfigPath(cwd: string): string {
  return cwd ? join(cwd, ".pi", "settings.json") : ".pi/settings.json";
}



function normalizeSuggestConfig(raw: unknown): SuggestJsonConfig {
  if (!raw || typeof raw !== "object") return {};
  const config = raw as SuggestJsonConfig;
  return {
    model: typeof config.model === "string" ? config.model : undefined,
    defaultModel: typeof config.defaultModel === "string" ? config.defaultModel : undefined,
  };
}

function readSuggestSettings(cwd: string): { project: SuggestJsonConfig; global: SuggestJsonConfig } {
  if (!cwd) return { project: {}, global: {} };
  const manager = SettingsManager.create(cwd);
  const projectSettings = manager.getProjectSettings() as Record<string, unknown>;
  const globalSettings = manager.getGlobalSettings() as Record<string, unknown>;
  return {
    project: normalizeSuggestConfig(projectSettings[SUGGEST_SETTINGS_KEY]),
    global: normalizeSuggestConfig(globalSettings[SUGGEST_SETTINGS_KEY]),
  };
}

function getConfiguredModelInfo(cwd: string): SuggestModelConfigInfo {
  const envModel = process.env[MODEL_ENV]?.trim();
  if (envModel) return { value: envModel, source: "env" };


  const settingsConfig = readSuggestSettings(cwd);
  if (settingsConfig.project.model?.trim()) {
    return { value: settingsConfig.project.model.trim(), source: "project-settings", path: getProjectSuggestConfigPath(cwd), field: "model" };
  }
  if (settingsConfig.project.defaultModel?.trim()) {
    return { value: settingsConfig.project.defaultModel.trim(), source: "project-settings", path: getProjectSuggestConfigPath(cwd), field: "defaultModel" };
  }
  if (settingsConfig.global.model?.trim()) {
    return { value: settingsConfig.global.model.trim(), source: "global-settings", path: getGlobalSuggestConfigPath(), field: "model" };
  }
  if (settingsConfig.global.defaultModel?.trim()) {
    return { value: settingsConfig.global.defaultModel.trim(), source: "global-settings", path: getGlobalSuggestConfigPath(), field: "defaultModel" };
  }

  return { value: DEFAULT_SUGGESTION_MODEL, source: "default" };
}

function getConfiguredModelName(cwd: string): string {
  return getConfiguredModelInfo(cwd).value;
}

async function writeProjectSuggestModelConfig(cwd: string, model: string | null): Promise<void> {
  if (!cwd) return;
  const manager = SettingsManager.create(cwd);
  await manager.reload();
  const projectSettings = manager.getProjectSettings() as Record<string, unknown>;
  const existing = normalizeSuggestConfig(projectSettings[SUGGEST_SETTINGS_KEY]);

  if (model && model !== DEFAULT_SUGGESTION_MODEL) {
    existing.model = model;
    delete existing.defaultModel;
    projectSettings[SUGGEST_SETTINGS_KEY] = existing;
  } else {
    delete projectSettings[SUGGEST_SETTINGS_KEY];
  }

  const internal = manager as unknown as {
    modifiedProjectFields: Set<string>;
    saveProjectSettings: (settings: Record<string, unknown>) => void;
    flush: () => Promise<void>;
  };
  internal.modifiedProjectFields.add(SUGGEST_SETTINGS_KEY);
  internal.saveProjectSettings(projectSettings);
  await internal.flush();
}

async function showSuggestModelSelector(ctx: ExtensionContext): Promise<string | null> {
  if (!ctx.hasUI) return null;

  const availableModels = safeGetAvailableModels(ctx.modelRegistry);
  if (availableModels.length === 0) {
    ctx.ui.notify("No authenticated models available for Suggest.", "warning");
    return null;
  }

  const items: SuggestModelItem[] = availableModels.map((model) => ({
    provider: model.provider,
    id: model.id,
    fullId: `${model.provider}/${model.id}`,
    model,
  }));
  const configured = getConfiguredModelName(ctx.cwd);

  return ctx.ui.custom<string | null>((tui, theme, kb, done) => {
    const colors = createUiColors(theme);
    const selectTheme = {
      selectedPrefix: (text: string) => colors.primary(text),
      selectedText: (text: string) => colors.primary(text),
      description: (text: string) => colors.meta(text),
      scrollInfo: (text: string) => colors.meta(text),
      noMatch: (text: string) => colors.warning(text),
    };

    let selectedValue = configured;
    let list = makeList(items);

    function makeList(filtered: SuggestModelItem[]): SelectList {
      const component = new SelectList(
        filtered.map((item) => ({ value: item.fullId, label: item.fullId, description: item.provider })),
        10,
        selectTheme,
      );
      const index = filtered.findIndex((item) => item.fullId === selectedValue);
      component.setSelectedIndex(index >= 0 ? index : 0);
      component.onSelect = (item) => done(item.value);
      component.onCancel = () => done(null);
      component.onSelectionChange = (item) => {
        selectedValue = item.value;
      };
      return component;
    }

    function refilter(query: string): void {
      const filtered = query
        ? fuzzyFilter(items, query, (item) => `${item.fullId} ${item.provider} ${item.id}`)
        : items;
      list = makeList(filtered);
      listContainer.clear();
      listContainer.addChild(list);
    }

    const searchInput = new Input();
    searchInput.onChange = (text: string) => {
      refilter(text);
      tui.requestRender();
    };

    const container = new Container();
    container.addChild(new DynamicBorder((s) => colors.primary(s)));
    container.addChild(new Text(colors.primary(theme.bold(" Select Suggest Model")), 0, 0));
    container.addChild(new Text(colors.meta(`Current: ${configured}`), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(searchInput);
    container.addChild(new Spacer(1));
    const listContainer = new Container();
    listContainer.addChild(list);
    container.addChild(listContainer);
    container.addChild(new Spacer(1));
    container.addChild(new Text(colors.meta("Type to filter · ↑↓ navigate · enter select · esc cancel"), 0, 0));
    container.addChild(new DynamicBorder((s) => colors.primary(s)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => {
        container.invalidate();
        list.invalidate();
      },
      handleInput(data: string) {
        const keybindings = kb as { matches(data: string, action: string): boolean };
        if (
          keybindings.matches(data, "tui.select.up") ||
          keybindings.matches(data, "tui.select.down") ||
          keybindings.matches(data, "tui.select.confirm") ||
          keybindings.matches(data, "tui.select.cancel")
        ) {
          list.handleInput(data);
        } else {
          searchInput.handleInput(data);
          refilter(searchInput.getValue());
        }
        tui.requestRender();
      },
    };
  });
}

function buildPayloadPreview(
  input: string,
  resolvedModel: string,
  modelResolutionReason: string,
  systemPrompt: string,
): string {
  return truncate([
    `model=${resolvedModel}`,
    `resolution=${modelResolutionReason}`,
    "thinkingLevel=off",
    "tools=0",
    "extensions=disabled",
    "skills=disabled",
    "promptTemplates=disabled",
    `systemPrompt=${systemPrompt.replace(/\s+/g, " ").trim()}`,
    `userInput=${input.replace(/\s+/g, " ").trim()}`,
  ].join("\n"), 1200);
}

async function resolveSuggestionModel(
  ctx: ExtensionContext,
  currentModel: Model<any> | undefined,
): Promise<{ model: Model<any> | undefined; reason: string }> {
  const configured = getConfiguredModelName(ctx.cwd);

  const [provider, ...idParts] = configured.split("/");
  const modelId = idParts.join("/");

  const modelRegistry = ctx.modelRegistry;

  if (provider && modelId) {
    const explicit = modelRegistry.find(provider, modelId);
    if (explicit && explicit.provider && explicit.id) {
      const apiKey = await modelRegistry.getApiKeyForProvider(explicit.provider);
      if (apiKey) return { model: explicit, reason: `using configured model ${configured}` };
      return { model: undefined, reason: `configured model ${configured} found, but no API key available for provider ${explicit.provider}` };
    }
    if (configured !== DEFAULT_SUGGESTION_MODEL) {
      // Model configured explicitly but not found — warn via context if possible
      const currentLabel = currentModel ? `${currentModel.provider}/${currentModel.id}` : "none";
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Suggest: configured model "${configured}" not found in registry (provider extension loaded? correct model id?). Falling back to ${currentLabel}.`,
          "warning",
        );
      }
      return {
        model: currentModel,
        reason: `configured model ${configured} was not found in Suggest's internal model registry; falling back to current model ${currentLabel}`,
      };
    }
  }

  if (currentModel && currentModel.provider && currentModel.id) {
    try {
      const apiKey = await modelRegistry.getApiKeyForProvider(currentModel.provider);
      if (apiKey) return { model: currentModel, reason: `using current session model ${currentModel.provider}/${currentModel.id}` };
    } catch {
      // Fall through to built-in available models.
    }
  }

  const available = safeGetAvailableModels(modelRegistry);
  const fallback = available.find((m) => m.provider && m.id);
  if (fallback) return { model: fallback, reason: `falling back to first available model ${fallback.provider}/${fallback.id}` };
  return { model: undefined, reason: "no available model for suggest" };
}

function createAbortError(): Error {
  const error = new Error("Suggest generation aborted");
  error.name = "AbortError";
  return error;
}

async function generateSuggestion(
  ctx: ExtensionContext,
  currentModel: Model<any> | undefined,
  input: string,
  gitContext?: SuggestGitContext | null,
  onSession?: (session: { abort(): Promise<void>; dispose(): void }) => void,
  isCancelled?: () => boolean,
): Promise<{
  suggestions: string[];
  rawSuggestion: string | null;
  filterReason: string | null;
  resolvedModel: string | null;
  modelResolutionReason: string | null;
  suggestInputPreview: string;
  suggestPayloadPreview: string;
  suggestMessageCount: number;
  suggestMessageRoles: string;
  assistantContentKind: string | null;
  assistantContentPreview: string | null;
}> {
  const resolution = await resolveSuggestionModel(ctx, currentModel);
  const model = resolution.model;
  if (!model) {
    return {
      suggestions: [],
      rawSuggestion: null,
      filterReason: "no available model for suggest",
      resolvedModel: null,
      modelResolutionReason: resolution.reason,
      suggestInputPreview: truncate(input, 300),
      suggestPayloadPreview: truncate(`model=none\nresolution=${resolution.reason}\nuserInput=${input.replace(/\s+/g, " ").trim()}`, 1200),
      suggestMessageCount: 0,
      suggestMessageRoles: "none",
      assistantContentKind: null,
      assistantContentPreview: null,
    };
  }

  const resolvedModel = `${model.provider}/${model.id}`;
  if (!model.provider || !model.id) {
    return {
      suggestions: [],
      rawSuggestion: null,
      filterReason: "resolved suggest model missing provider or id",
      resolvedModel: resolvedModel.includes("undefined") ? null : resolvedModel,
      modelResolutionReason: resolution.reason,
      suggestInputPreview: truncate(input, 300),
      suggestPayloadPreview: truncate(`model=${resolvedModel}\nresolution=${resolution.reason}\nerror=resolved model missing provider or id`, 1200),
      suggestMessageCount: 0,
      suggestMessageRoles: "none",
      assistantContentKind: null,
      assistantContentPreview: null,
    };
  }
  const suggestPayloadPreview = buildPayloadPreview(input, resolvedModel, resolution.reason, buildSystemPrompt(gitContext));

  const suggestCwd = (ctx.cwd && typeof ctx.cwd === "string" && ctx.cwd.length > 0) ? ctx.cwd : process.cwd();
  if (!suggestCwd) {
    return {
      suggestions: [],
      rawSuggestion: null,
      filterReason: "no valid working directory for suggest session",
      resolvedModel: `${model.provider}/${model.id}`,
      modelResolutionReason: resolution.reason,
      suggestInputPreview: truncate(input, 300),
      suggestPayloadPreview: truncate(`model=${model.provider}/${model.id}\nresolution=${resolution.reason}\nerror=no cwd`, 1200),
      suggestMessageCount: 0,
      suggestMessageRoles: "none",
      assistantContentKind: null,
      assistantContentPreview: null,
    };
  }
  const settingsManager = SettingsManager.create(suggestCwd);
  const resourceLoader = new DefaultResourceLoader({
    cwd: suggestCwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt: buildSystemPrompt(gitContext),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: suggestCwd,
    modelRegistry: ctx.modelRegistry,
    model,
    thinkingLevel: "off",
    tools: [],
    resourceLoader,
    sessionManager: SessionManager.inMemory(suggestCwd),
    settingsManager,
  });

  onSession?.(session);

  try {
    // Cancellation checkpoint: a newer generation or a clearSuggestion() may
    // have raced past us during the async setup above. Bail out before
    // spending the model call; runGeneration's catch silences AbortError.
    if (isCancelled?.()) {
      throw createAbortError();
    }
    await session.prompt(input, { expandPromptTemplates: false, source: "interactive" });
    const lastAssistant = [...session.messages].reverse().find(isAssistantMessage);
    const rawSuggestion = lastAssistant ? extractText(lastAssistant) : null;
    const lastAssistantContent = lastAssistant ? getMessageContent(lastAssistant) : null;
    const assistantContentKind = lastAssistant
      ? typeof lastAssistantContent === "string"
        ? "string"
        : Array.isArray(lastAssistantContent)
          ? lastAssistantContent.map((block: any) => block?.type).join(", ") || "array(empty)"
          : typeof lastAssistantContent
      : null;
    const assistantContentPreview = lastAssistant
      ? truncate(typeof lastAssistantContent === "string" ? lastAssistantContent : JSON.stringify(lastAssistantContent), 300)
      : null;
    const parsed = parseSuggestionArray(rawSuggestion);
    return {
      suggestions: parsed.suggestions,
      rawSuggestion,
      filterReason: parsed.reason,
      resolvedModel,
      modelResolutionReason: resolution.reason,
      suggestInputPreview: truncate(input, 300),
      suggestPayloadPreview,
      suggestMessageCount: session.messages.length,
      suggestMessageRoles: session.messages.map((message) => message.role).join(", "),
      assistantContentKind,
      assistantContentPreview,
    };
  } finally {
    session.dispose();
  }
}

export default function suggestExtension(pi: ExtensionAPI): void {
  once(pi, "pi-suggest", () => {
  let editorRef: SuggestEditor | null = null;

  const state: SuggestState = {
    enabled: true,
    debug: false,
    suggestions: [],
    selectedSuggestionIndex: 0,
    sourceTurnKey: null,
    generating: false,
    lastError: null,
    lastRawSuggestion: null,
    lastFilterReason: null,
    lastResolvedModel: null,
    lastGenerationStatus: null,
    lastModelResolutionReason: null,
    lastSuggestInputPreview: null,
    lastSuggestPayloadPreview: null,
    lastSuggestMessageCount: null,
    lastSuggestMessageRoles: null,
    lastAssistantContentKind: null,
    lastAssistantContentPreview: null,
    generationId: 0,
    miniMode: false,
  };

  // Active generation session — aborted when a new generation starts or suggest is cleared.
  let activeSession: { abort(): Promise<void>; dispose(): void } | null = null;
  let unregisterEditorDecorator: (() => void) | undefined;

  // Debounce/throttle state for suggestion generation.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastGenerationStartedAt = 0;

  // Stand down while subagents/workers run: their turn ends must not drive
  // suggestions for the main editor (noise + stale-ctx crashes).
  const delegation = new DelegationTracker();

  // Spinner for the "generating" widget state; cleared whenever generation ends.
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;

  function cancelPendingGeneration(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  async function abortActiveSession(): Promise<void> {
    if (!activeSession) return;
    const session = activeSession;
    activeSession = null;
    try {
      await session.abort();
      // Per pi SDK docs: dispose() aborts remaining work, invalidates contexts
      // and disconnects the session — required once it's no longer needed.
      session.dispose();
    } catch {
      // ignore
    }
  }



  function getSelectedSuggestion(): string | null {
    if (state.suggestions.length === 0) return null;
    return state.suggestions[state.selectedSuggestionIndex] ?? null;
  }

  function getNextSuggestion(): { text: string; index: number } | null {
    if (state.suggestions.length <= 1) return null;
    const index = (state.selectedSuggestionIndex + 1) % state.suggestions.length;
    const text = state.suggestions[index];
    if (!text) return null;
    return { text, index };
  }

  function syncEditor(): void {
    editorRef?.setEnabled(state.enabled);
    editorRef?.setSuggestions(state.enabled ? state.suggestions : [], state.selectedSuggestionIndex);
    editorRef?.setGenerating(state.generating);
  }

  function installEditor(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    unregisterEditorDecorator?.();
    unregisterEditorDecorator = registerEditorDecorator(ctx, "pi-suggest", (inner, tui, theme) => {
      const editor = new SuggestEditor(inner, tui, theme);
      editor.setEnabled(state.enabled);
      editor.setSuggestions(state.enabled ? state.suggestions : [], state.selectedSuggestionIndex);
      editor.setOnAcceptSuggestion(() => {
        // Keep suggestions after accept so the ghost reappears
        // if the user deletes the inserted text
        syncEditor();
      });
      editor.setOnSelectSuggestion((index) => {
        state.selectedSuggestionIndex = index;
        renderSuggestion(ctx);
      });
      editor.setOnDismissSuggestion(() => {
        clearSuggestion(ctx);
      });
      editor.setOnCancelGeneration(() => {
        clearSuggestion(ctx);
        if (ctx.hasUI) ctx.ui.notify("Suggestion generation cancelled", "info");
      });
      // Cancel-on-type: the first keystroke during an in-flight generation
      // aborts it — a suggestion arriving after the user started typing is
      // waste. Silent (no notify): the user already moved on.
      editor.setOnUserInput(() => {
        if (state.generating) clearSuggestion(ctx);
        renderSuggestion(ctx);
      });
      editorRef = editor;
      return editor;
    }, { order: 10 });
  }

  function clearSuggestion(ctx?: ExtensionContext, options?: { preserveDiagnostics?: boolean }): void {
    cancelPendingGeneration();
    stopSpinner();
    void abortActiveSession();
    if (!ctx?.hasUI) return;
    state.suggestions = [];
    state.selectedSuggestionIndex = 0;
    state.sourceTurnKey = null;
    state.generating = false;
    state.lastError = null;
    if (!options?.preserveDiagnostics) {
      state.lastRawSuggestion = null;
      state.lastFilterReason = null;
      state.lastResolvedModel = null;
      state.lastGenerationStatus = null;
      state.lastModelResolutionReason = null;
      state.lastSuggestInputPreview = null;
      state.lastSuggestPayloadPreview = null;
      state.lastSuggestMessageCount = null;
      state.lastSuggestMessageRoles = null;
      state.lastAssistantContentKind = null;
      state.lastAssistantContentPreview = null;
    }
    state.generationId += 1;
    syncEditor();
    if (ctx?.hasUI) {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      ctx.ui.setStatus(STATUS_ID, undefined);
    }
  }

  function stopSpinner(): void {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  }

  function startSpinner(ctx: ExtensionContext, colors: ReturnType<typeof createUiColors>): void {
    if (spinnerTimer) return;
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      const frame = colors.primary(SPINNER_FRAMES[spinnerFrame]!);
      ctx.ui.setWidget(WIDGET_ID, [`${frame} ${colors.meta("generating suggestion — Esc cancels")}`]);
    }, SPINNER_INTERVAL_MS);
  }

  function renderSuggestion(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const selectedSuggestion = getSelectedSuggestion();
    if (!state.enabled || (!selectedSuggestion && !state.generating)) {
      stopSpinner();
      ctx.ui.setWidget(WIDGET_ID, undefined);
      ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }

    const colors = createUiColors(ctx.ui.theme);

    // Suggestions can only be inserted while the editor is empty; with text
    // present the widget is stale noise. Hide it, keep the status badge.
    if (selectedSuggestion && (editorRef?.getText() ?? "").length > 0) {
      stopSpinner();
      ctx.ui.setWidget(WIDGET_ID, undefined);
      ctx.ui.setStatus(STATUS_ID, colors.primary(state.miniMode ? "󰌶 mini" : "󰌶"));
      return;
    }

    if (!selectedSuggestion && state.generating) {
      // Generating with nothing to show yet: spinner + cancel hint.
      startSpinner(ctx, colors);
      ctx.ui.setWidget(WIDGET_ID, [`${colors.primary(SPINNER_FRAMES[spinnerFrame]!)} ${colors.meta("generating suggestion — Esc cancels")}`]);
      ctx.ui.setStatus(STATUS_ID, colors.primary("󰌶 …"));
      return;
    }
    stopSpinner();

    syncEditor();

    if (state.miniMode) {
      // Mini mode — one-liner with keybindings
      const count = state.suggestions.length;
      const index = state.selectedSuggestionIndex + 1;
      const help = count > 1 ? "Alt+↑↓: Cycle" : "";
      const insert = "Tab/→: Insert";
      const prefix = count > 1 ? `[${index}/${count}]` : "";
      const parts = [prefix, help, insert].filter(Boolean);
      const widgetLines = [
        `${colors.primary(`Suggest ${parts.join(" · ")}`)}`,
      ];
      ctx.ui.setWidget(WIDGET_ID, widgetLines);
    } else {
      // Full mode — show all suggestions as a list
      const suggestionLines: string[] = [];
      for (let i = 0; i < state.suggestions.length; i++) {
        const text = state.suggestions[i];
        if (!text) continue;
        const isSelected = i === state.selectedSuggestionIndex;
        const prefix = isSelected ? colors.primary("→ ") : "  ";
        const label = isSelected ? colors.primary(text) : colors.meta(text);
        suggestionLines.push(`${prefix}${label}`);
      }

      const helpText = state.suggestions.length > 1
        ? "Alt+↑↓ cycle · Tab/→ insert"
        : "Tab/→ insert";

      const widgetLines = [
        colors.primary("Suggest:"),
        ...suggestionLines,
        colors.meta(helpText),
      ];
      ctx.ui.setWidget(WIDGET_ID, widgetLines);
    }

    ctx.ui.setStatus(STATUS_ID, colors.primary(state.miniMode ? "󰌶 mini" : "󰌶"));
  }

  pi.on("session_start", async (_event, ctx) => {
    installEditor(ctx);
    clearSuggestion(ctx);
    renderSuggestion(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    delegation.onToolCall(event.toolName, event.toolCallId);
    if (delegation.isDelegating()) {
      // Delegation started: any in-flight suggestion is already stale.
      clearSuggestion(ctx);
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    delegation.onToolResult(event.toolName, event.toolCallId);
  });

  pi.on("session_switch", async (_event, ctx) => {
    installEditor(ctx);
    clearSuggestion(ctx);
    renderSuggestion(ctx);
  });

  pi.on("session_shutdown", async () => {
    cancelPendingGeneration();
    stopSpinner();
    await abortActiveSession();
    unregisterEditorDecorator?.();
    unregisterEditorDecorator = undefined;
    editorRef = null;
  });

  pi.on("agent_start", async (_event, ctx) => {
    clearSuggestion(ctx);
  });

  function shouldSuppressGeneration(ctx: ExtensionContext): string | null {
    if (!state.enabled) return "disabled";
    // Don't generate in plan mode (read-only exploration, no real next step to predict)
    if ((ctx as any).planMode === true) return "plan_mode";
    // Require at least one completed assistant turn in the conversation
    return null;
  }

  async function runGeneration(
    ctx: ExtensionContext,
    input: string,
    turnKey: string,
    gitContext?: SuggestGitContext | null,
  ): Promise<void> {
    // Abort any in-flight generation before starting a new one
    await abortActiveSession();

    lastGenerationStartedAt = Date.now();
    state.generating = true;
    state.lastError = null;
    state.lastRawSuggestion = null;
    state.lastFilterReason = null;
    state.lastResolvedModel = null;
    state.lastGenerationStatus = "generating";
    state.lastModelResolutionReason = null;
    state.lastSuggestInputPreview = truncate(input, 300);
    state.lastSuggestPayloadPreview = null;
    state.lastSuggestMessageCount = null;
    state.lastSuggestMessageRoles = null;
    state.lastAssistantContentKind = null;
    state.lastAssistantContentPreview = null;
    const generationId = state.generationId + 1;
    state.generationId = generationId;
    const isCancelled = (): boolean => state.generationId !== generationId || !state.enabled;
    // Session owned by THIS generation. The guards below ensure a superseded
    // generation can never null out a newer generation's activeSession slot.
    let mySession: { abort(): Promise<void>; dispose(): void } | null = null;

    try {
      if (state.debug && ctx.hasUI) {
        ctx.ui.notify(`Suggest debug: generating with ${getConfiguredModelName(ctx.cwd)}` + (ctx.model ? ` (current ${ctx.model.provider}/${ctx.model.id})` : ""), "info");
        ctx.ui.notify(`Suggest payload:\n${truncate(input, 500)}`, "info");
      }
      const result = await generateSuggestion(
        ctx,
        ctx.model,
        input,
        gitContext,
        (session) => {
          mySession = session;
          // Claim the active slot only while this generation is still current;
          // never clobber a newer generation's session with null.
          if (!isCancelled()) activeSession = session;
        },
        isCancelled,
      );
      if (activeSession === mySession) activeSession = null;
      if (state.generationId !== generationId || !state.enabled) return;

      state.lastRawSuggestion = result.rawSuggestion;
      state.lastFilterReason = result.filterReason;
      state.lastResolvedModel = result.resolvedModel;
      state.lastModelResolutionReason = result.modelResolutionReason;
      state.lastSuggestInputPreview = result.suggestInputPreview;
      state.lastSuggestPayloadPreview = result.suggestPayloadPreview;
      state.lastSuggestMessageCount = result.suggestMessageCount;
      state.lastSuggestMessageRoles = result.suggestMessageRoles;
      state.lastAssistantContentKind = result.assistantContentKind;
      state.lastAssistantContentPreview = result.assistantContentPreview;

      if (result.suggestions.length === 0) {
        state.lastGenerationStatus = result.filterReason ? "filtered" : "no-suggestion";
        if (state.debug && ctx.hasUI) {
          ctx.ui.notify(
            `Suggest debug: no suggestion. Resolved=${result.resolvedModel ?? "none"}; reason=${result.filterReason ?? "none"}; content=${result.assistantContentKind ?? "none"}`,
            "warning",
          );
        }
        clearSuggestion(ctx, { preserveDiagnostics: true });
        return;
      }
      state.suggestions = result.suggestions;
      state.selectedSuggestionIndex = 0;
      state.sourceTurnKey = turnKey;
      state.generating = false;
      state.lastGenerationStatus = "ready";
      if (state.debug && ctx.hasUI) {
        ctx.ui.notify(`Suggest debug: suggestions ready -> ${result.suggestions.join(" | ")}`, "info");
      }
      syncEditor();
      renderSuggestion(ctx);
    } catch (error) {
      if (activeSession === mySession) activeSession = null;
      if (state.generationId !== generationId) return;
      // Ignore abort errors — expected when a newer generation starts.
      if (error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))) {
        return;
      }
      // Ignore stale-ctx errors — expected when a session is replaced or
      // reloaded mid-generation (subagents, workers, /reload). The user has
      // moved on; surfacing them is noise.
      if (error instanceof Error && /ctx is stale|invalidated|session replacement/i.test(error.message)) {
        return;
      }
      clearSuggestion(ctx, { preserveDiagnostics: true });
      state.lastError = error instanceof Error ? error.message : String(error);
      state.lastGenerationStatus = "error";
      if (ctx.hasUI) {
        if (state.debug) {
          // eslint-disable-next-line no-console
          console.error("Suggest failed:", error);
        }
        ctx.ui.notify(`Suggest failed: ${state.lastError}`, "warning");
      }
    }
  }

  pi.on("agent_end", async (event, ctx) => {
    if (delegation.isDelegating()) {
      // This turn end belongs to (or overlaps) a running subagent — not a
      // moment to predict the user's next message in the main editor.
      clearSuggestion(ctx);
      return;
    }
    if (!ctx.cwd) {
      clearSuggestion(ctx);
      return;
    }
    const suppressReason = shouldSuppressGeneration(ctx);
    if (suppressReason) {
      clearSuggestion(ctx);
      return;
    }

    const messages = event.messages as AgentMessage[];
    const assistantTurnCount = messages.filter(isAssistantMessage).length;
    if (assistantTurnCount < 1) {
      clearSuggestion(ctx);
      return;
    }

    const turnKey = buildTurnKey(messages);

    // Short-circuit: the conversation hasn't changed since the suggestion we
    // already have (or are about to produce), so skip a redundant model call.
    if (turnKey === state.sourceTurnKey) {
      if (state.debug && ctx.hasUI) {
        ctx.ui.notify("Suggest debug: skipping generation (turn unchanged)", "info");
      }
      return;
    }

    const gitContext = await gatherGitContext(ctx.cwd ?? process.cwd()).catch(() => null);
    const workspaceSummary = await buildWorkspaceSummary(ctx.cwd ?? process.cwd()).catch(() => null);
    const input = buildSuggestionInput(messages, ctx.cwd ?? process.cwd(), gitContext, workspaceSummary);
    if (!input) {
      clearSuggestion(ctx);
      return;
    }

    // Debounce/throttle: coalesce rapid successive agent_end events and enforce
    // a minimum interval between generations. A superseded pending generation is
    // cancelled here; a superseded in-flight one is aborted inside runGeneration.
    cancelPendingGeneration();
    // Record the target turn now so repeated agent_end events for the same turn
    // short-circuit above instead of stacking timers.
    state.sourceTurnKey = turnKey;
    const sinceLast = Date.now() - lastGenerationStartedAt;
    const delay = Math.max(SUGGEST_DEBOUNCE_MS, SUGGEST_MIN_INTERVAL_MS - sinceLast);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!state.enabled || state.sourceTurnKey !== turnKey) return;
      void runGeneration(ctx, input, turnKey, gitContext);
    }, delay);
  });

  pi.registerCommand("suggest", {
    description: "Toggle suggest suggestions or manage suggest settings",
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trimStart();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const endsWithSpace = /\s$/.test(trimmed);
      const root = ["on", "off", "status", "debug", "model", "mini", "test"];

      if (!trimmed) {
        return root.map((value) => ({ value, label: value }));
      }

      if (parts.length <= 1 && !endsWithSpace) {
        const sub = parts[0]?.toLowerCase() ?? "";
        const filtered = root.filter((value) => value.startsWith(sub));
        return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
      }

      const first = parts[0]?.toLowerCase() ?? "";
      if (first === "debug") {
        const values = ["on", "off"];
        const subPrefix = parts.length <= 1 || endsWithSpace ? "" : (parts[parts.length - 1] ?? "").toLowerCase();
        const filtered = values.filter((value) => value.startsWith(subPrefix));
        return filtered.length > 0
          ? filtered.map((value) => ({ value: `debug ${value}`, label: value }))
          : null;
      }

      if (first === "model") {
        const values = ["select", "status", "clear", "current"];
        const subPrefix = parts.length <= 1 || endsWithSpace ? "" : (parts[parts.length - 1] ?? "").toLowerCase();
        const filtered = values.filter((value) => value.startsWith(subPrefix));
        return filtered.length > 0
          ? filtered.map((value) => ({ value: `model ${value}`, label: value }))
          : null;
      }

      if (first === "mini") {
        const values = ["on", "off"];
        const subPrefix = parts.length <= 1 || endsWithSpace ? "" : (parts[parts.length - 1] ?? "").toLowerCase();
        const filtered = values.filter((value) => value.startsWith(subPrefix));
        return filtered.length > 0
          ? filtered.map((value) => ({ value: `mini ${value}`, label: value }))
          : null;
      }

      return null;
    },
    handler: async (args, ctx) => {
      const raw = args.trim();
      const sub = raw.toLowerCase();

      if (sub === "status") {
        const configured = getConfiguredModelInfo(ctx.cwd);
        ctx.ui.notify(
          [
            `Enabled: ${state.enabled ? "yes" : "no"}`,
            `Configured model: ${configured.value}`,
            `Configured source: ${configured.source}${configured.path ? ` (${configured.path}${configured.field ? `:${configured.field}` : ""})` : ""}`,
            `Resolved model: ${state.lastResolvedModel ?? "none"}`,
            `Model resolution: ${state.lastModelResolutionReason ?? "none"}`,
            `Debug: ${state.debug ? "on" : "off"}`,
            `Mini mode: ${state.miniMode ? "on" : "off"}`, 
            `Suggestions: ${state.suggestions.length > 0 ? state.suggestions.join(" | ") : "none"}`,
            `Selected suggestion: ${getSelectedSuggestion() ?? "none"}`,
            `Editor wrapper: ${editorRef ? "created" : "not-created-yet"}`,
            `Editor registry: ${ctx.hasUI && isEditorRegistryInstalled(ctx) ? "installed" : "not-installed"}`,
            `Editor decorators: ${getRegisteredEditorDecorators(ctx).join(" -> ") || "none"}`,
            `Generating: ${state.generating ? "yes" : "no"}`,
            `Last generation status: ${state.lastGenerationStatus ?? "none"}`,
            `Last raw suggestion: ${state.lastRawSuggestion ?? "none"}`,
            `Last filter reason: ${state.lastFilterReason ?? "none"}`,
            `Last error: ${state.lastError ?? "none"}`,
            `Last turn key: ${state.sourceTurnKey ?? "none"}`,
            `Suggest input preview: ${state.lastSuggestInputPreview ?? "none"}`,
            `Suggest payload preview: ${state.lastSuggestPayloadPreview ?? "none"}`,
            `Suggest session message count: ${state.lastSuggestMessageCount ?? "none"}`,
            `Suggest session roles: ${state.lastSuggestMessageRoles ?? "none"}`,
            `Assistant content kind: ${state.lastAssistantContentKind ?? "none"}`,
            `Assistant content preview: ${state.lastAssistantContentPreview ?? "none"}`,
          ].join("\n"),
          "info",
        );
        return;
      }

      if (sub === "test") {
        state.suggestions = ["continue", "run tests", "show status"];
        state.selectedSuggestionIndex = 0;
        state.sourceTurnKey = "manual-test";
        state.generating = false;
        state.lastGenerationStatus = "ready";
        state.lastRawSuggestion = JSON.stringify(state.suggestions);
        state.lastFilterReason = null;
        syncEditor();
        renderSuggestion(ctx);
        ctx.ui.notify("Suggest test suggestions injected. Empty the editor, then use Tab/→ or Alt+↑↓.", "info");
        return;
      }

      if (sub === "model" || sub === "model select") {
        if (!ctx.hasUI) {
          const configured = getConfiguredModelInfo(ctx.cwd);
          ctx.ui.notify(
            [
              `Suggest model: ${configured.value}`,
              `Source: ${configured.source}`,
              `Path: ${configured.path ?? "none"}`,
              `Field: ${configured.field ?? "none"}`,
            ].join("\n"),
            "info",
          );
          return;
        }
        const selected = await showSuggestModelSelector(ctx);
        if (!selected) {
          ctx.ui.notify("Suggest model selection cancelled", "info");
          return;
        }
        await writeProjectSuggestModelConfig(ctx.cwd, selected);
        ctx.ui.notify(`Suggest model set to ${selected} (${getProjectSuggestConfigPath(ctx.cwd)}#${SUGGEST_SETTINGS_KEY})`, "info");
        return;
      }

      if (sub === "model status") {
        const configured = getConfiguredModelInfo(ctx.cwd);
        ctx.ui.notify(
          [
            `Suggest model: ${configured.value}`,
            `Source: ${configured.source}`,
            `Path: ${configured.path ?? "none"}`,
            `Field: ${configured.field ?? "none"}`,
            configured.source === "env"
              ? `Note: environment variables override settings`
              : `Use /suggest model, /suggest model <provider/model-id>, /suggest model current, or /suggest model clear`,
          ].join("\n"),
          "info",
        );
        return;
      }

      if (sub === "model clear") {
        await writeProjectSuggestModelConfig(ctx.cwd, null);
        ctx.ui.notify(`Cleared project suggest model override (${getProjectSuggestConfigPath(ctx.cwd)}#${SUGGEST_SETTINGS_KEY})`, "info");
        return;
      }

      if (sub === "model current") {
        await writeProjectSuggestModelConfig(ctx.cwd, DEFAULT_SUGGESTION_MODEL);
        const configured = getConfiguredModelInfo(ctx.cwd);
        const detail = configured.source === "default"
          ? "Suggest will use the current session model by default"
          : `Project override cleared; effective source is now ${configured.source} (${configured.value})`;
        ctx.ui.notify(`${detail}\nConfig: ${getProjectSuggestConfigPath(ctx.cwd)}#${SUGGEST_SETTINGS_KEY}`, "info");
        return;
      }

      if (sub.startsWith("model ")) {
        const modelRef = raw.slice("model ".length).trim();
        if (!modelRef || modelRef === "status" || modelRef === "clear" || modelRef === "current") {
          ctx.ui.notify("Usage: /suggest model <provider/model-id> | current | clear | status", "warning");
          return;
        }
        const [provider, ...idParts] = modelRef.split("/");
        const modelId = idParts.join("/");
        if (!provider || !modelId) {
          ctx.ui.notify("Model must be in the form provider/model-id", "error");
          return;
        }
        const model = ctx.modelRegistry.find(provider, modelId);
        if (!model) {
          ctx.ui.notify(`Model not found: ${modelRef}`, "error");
          return;
        }
        await writeProjectSuggestModelConfig(ctx.cwd, `${model.provider}/${model.id}`);
        ctx.ui.notify(`Suggest model set to ${model.provider}/${model.id} (${getProjectSuggestConfigPath(ctx.cwd)}#${SUGGEST_SETTINGS_KEY})`, "info");
        return;
      }

      if (sub === "debug on") {
        state.debug = true;
        ctx.ui.notify("Suggest debug enabled", "info");
        return;
      }

      if (sub === "debug off") {
        state.debug = false;
        ctx.ui.notify("Suggest debug disabled", "info");
        return;
      }

      if (sub === "mini") {
        state.miniMode = !state.miniMode;
        syncEditor();
        renderSuggestion(ctx);
        ctx.ui.notify(`Suggest mini mode ${state.miniMode ? "on" : "off"}`, "info");
        return;
      }

      if (sub === "mini on") {
        state.miniMode = true;
        syncEditor();
        renderSuggestion(ctx);
        ctx.ui.notify("Suggest mini mode on", "info");
        return;
      }

      if (sub === "mini off") {
        state.miniMode = false;
        syncEditor();
        renderSuggestion(ctx);
        ctx.ui.notify("Suggest mini mode off", "info");
        return;
      }

      if (sub === "on") {
        state.enabled = true;
        syncEditor();
        renderSuggestion(ctx);
        ctx.ui.notify("Suggest enabled", "info");
        return;
      }

      if (sub === "off") {
        state.enabled = false;
        clearSuggestion(ctx);
        ctx.ui.notify("Suggest disabled", "info");
        return;
      }

      state.enabled = !state.enabled;
      syncEditor();
      if (!state.enabled) clearSuggestion(ctx);
      else renderSuggestion(ctx);
      ctx.ui.notify(`Suggest ${state.enabled ? "enabled" : "disabled"}`, "info");
    },
  });
  });
}
