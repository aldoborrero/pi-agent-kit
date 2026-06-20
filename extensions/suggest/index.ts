/// <reference path="./node-shim.d.ts" />

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
import { Container, fuzzyFilter, Input, Spacer, Text } from "@earendil-works/pi-tui";
import { registerFancyFooterWidget, refreshFancyFooter } from "../_shared/fancy-footer.js";
import { createUiColors } from "../_shared/ui-colors.js";
import { SuggestEditor } from "./editor";

const DEFAULT_SUGGESTION_MODEL = "current";
const MODEL_ENV = "PI_SUGGEST_MODEL";
const LEGACY_MODEL_ENV = "PI_PROMPT_SUGGESTION_MODEL";
const WIDGET_ID = "suggest";
const STATUS_ID = "suggest";
const MAX_CONTEXT_MESSAGES = 6;
const MAX_ASSISTANT_CHARS = 3000;
const MAX_USER_CHARS = 1200;

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
  suggestionHistory: Array<{
    suggestions: string[];
    selectedSuggestionIndex: number;
    sourceTurnKey: string | null;
  }>;
  miniMode: boolean;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function isAssistantMessage(message: AgentMessage): boolean {
  return message.role === "assistant";
}

function isUserMessage(message: AgentMessage): boolean {
  return message.role === "user";
}

function getMessageContent(message: AgentMessage): unknown {
  return (message as AgentMessage & { content?: unknown }).content;
}

function extractText(message: AgentMessage): string {
  const content = getMessageContent(message);
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is TextContent => typeof block === "object" && block !== null && "type" in block && block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

/** Work around older pi-coding-agent versions where hasConfiguredAuth() crashes on
 *  providers registered with headers but no apiKey. */
function safeGetAvailableModels(modelRegistry: ExtensionContext["modelRegistry"]): Model<any>[] {
  try {
    return modelRegistry.getAvailable();
  } catch {
    try {
      return modelRegistry
        .getAll()
        .filter((m) => m && m.provider && m.id)
        .filter((m) => {
          try {
            return modelRegistry.hasConfiguredAuth(m);
          } catch {
            return false;
          }
        });
    } catch {
      return [];
    }
  }
}

function buildTurnKey(messages: AgentMessage[]): string {
  const lastAssistantIndex = [...messages].reverse().findIndex(isAssistantMessage);
  const lastUserIndex = [...messages].reverse().findIndex(isUserMessage);
  return `${messages.length}:${lastAssistantIndex}:${lastUserIndex}`;
}

function buildSuggestionInput(messages: AgentMessage[], cwd: string): string | null {
  const recent = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-MAX_CONTEXT_MESSAGES);

  const rendered = recent
    .map((message) => {
      const text = extractText(message);
      if (!text) return null;
      const role = message.role ?? "unknown";
      const capped = role === "assistant"
        ? truncate(text, MAX_ASSISTANT_CHARS)
        : truncate(text, MAX_USER_CHARS);
      return `${role.toUpperCase()}:\n${capped}`;
    })
    .filter(Boolean)
    .join("\n\n");

  if (!rendered.trim()) return null;

  return [
    `Project directory: ${cwd}`,
    "Recent conversation:",
    rendered,
    "",
    "Reply with ONLY a JSON array of up to 3 likely next user messages. Use fewer when the options are too similar.",
  ].join("\n");
}

function filterSuggestion(raw: string | null): { suggestion: string | null; reason: string | null } {
  if (typeof raw !== "string" || !raw) return { suggestion: null, reason: "model returned empty output" };
  const suggestion = raw.trim();
  if (!suggestion) return { suggestion: null, reason: "model returned blank output" };

  const lower = suggestion.toLowerCase();
  const wordCount = suggestion.split(/\s+/).length;

  if (wordCount < 2 && !suggestion.startsWith("/")) {
    const allowed = new Set([
      // affirmatives
      "yes", "yeah", "yep", "yea", "yup", "sure",
      // negation
      "no",
      // neutral
      "ok", "okay",
      // common one-word actions
      "continue", "commit", "push", "deploy", "stop", "check", "exit", "quit",
    ]);
    if (!allowed.has(lower)) return { suggestion: null, reason: "single-word suggestion not allowlisted" };
  }

  if (wordCount > 12) return { suggestion: null, reason: "suggestion exceeded 12 words" };
  if (suggestion.length >= 100) return { suggestion: null, reason: "suggestion exceeded 100 characters" };
  if (/^\w+:\s/.test(suggestion)) return { suggestion: null, reason: "suggestion looked like a labeled response" };
  if (/^\(.*\)$|^\[.*\]$/.test(suggestion)) return { suggestion: null, reason: "suggestion was wrapped in brackets" };
  if (/[\n*]/.test(suggestion)) return { suggestion: null, reason: "suggestion contained newline or markdown bullets" };
  if (/[.!?]\s+[A-ZÁÉÍÓÚÑÜ]/.test(suggestion)) return { suggestion: null, reason: "suggestion looked like multiple sentences" };
  if (/^(let me|i'll|i can|here('| i)?s|you should|you could|sure,|of course|certainly)/i.test(suggestion)) {
    return { suggestion: null, reason: "suggestion used assistant voice" };
  }
  if (/(thanks|thank you|looks good|sounds good|perfect|awesome|great)$/i.test(lower)) {
    return { suggestion: null, reason: "suggestion ended with evaluative filler" };
  }
  if (/^(nothing found|no suggestion|stay silent|silence)$/i.test(lower)) {
    return { suggestion: null, reason: "model explicitly declined to suggest" };
  }

  return { suggestion, reason: null };
}

function parseSuggestionArray(raw: string | null): { suggestions: string[]; reason: string | null } {
  if (!raw) return { suggestions: [], reason: "model returned empty output" };

  const candidate = extractJsonArrayText(raw.trim());
  if (!candidate) return { suggestions: [], reason: "model did not return a JSON array" };

  try {
    const parsed = JSON.parse(candidate);
    if (!Array.isArray(parsed)) return { suggestions: [], reason: "model did not return a JSON array" };

    const seen = new Set<string>();
    const suggestions: string[] = [];
    let lastReason: string | null = null;

    for (const item of parsed) {
      if (typeof item !== "string") {
        lastReason = "JSON array contained non-string items";
        continue;
      }
      const filtered = filterSuggestion(item);
      if (!filtered.suggestion) {
        lastReason = filtered.reason;
        continue;
      }
      const key = filtered.suggestion.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push(filtered.suggestion);
      if (suggestions.length >= 3) break;
    }

    return {
      suggestions,
      reason: suggestions.length > 0 ? null : (lastReason ?? "all suggestions were filtered"),
    };
  } catch {
    return { suggestions: [], reason: "model returned invalid JSON" };
  }
}

function extractJsonArrayText(raw: string): string | null {
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const text = fenced ? fenced[1].trim() : raw;
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

type SuggestJsonConfig = {
  model?: string;
  defaultModel?: string;
};

type SuggestModelConfigInfo = {
  value: string;
  source: "env" | "legacy-env" | "project-settings" | "global-settings" | "project-json" | "global-json" | "default";
  path?: string;
  field?: "model" | "defaultModel";
};

const SUGGEST_SETTINGS_KEY = "suggest";

function getGlobalSuggestConfigPath(): string {
  return join(getAgentDir(), "settings.json");
}

function getLegacyGlobalSuggestConfigPath(): string {
  return join(dirname(getAgentDir()), "suggest.json");
}

function getProjectSuggestConfigPath(cwd: string): string {
  return cwd ? join(cwd, ".pi", "settings.json") : ".pi/settings.json";
}

function getLegacyProjectSuggestConfigPath(cwd: string): string {
  return cwd ? join(cwd, ".pi", "suggest.json") : ".pi/suggest.json";
}

function readSuggestConfigFile(path: string): SuggestJsonConfig {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SuggestJsonConfig;
  } catch {
    return {};
  }
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

  const legacyEnvModel = process.env[LEGACY_MODEL_ENV]?.trim();
  if (legacyEnvModel) return { value: legacyEnvModel, source: "legacy-env" };

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

  const projectPath = getLegacyProjectSuggestConfigPath(cwd);
  const projectConfig = readSuggestConfigFile(projectPath);
  if (projectConfig.model?.trim()) {
    return { value: projectConfig.model.trim(), source: "project-json", path: projectPath, field: "model" };
  }
  if (projectConfig.defaultModel?.trim()) {
    return { value: projectConfig.defaultModel.trim(), source: "project-json", path: projectPath, field: "defaultModel" };
  }

  const globalPath = getLegacyGlobalSuggestConfigPath();
  const globalConfig = readSuggestConfigFile(globalPath);
  if (globalConfig.model?.trim()) {
    return { value: globalConfig.model.trim(), source: "global-json", path: globalPath, field: "model" };
  }
  if (globalConfig.defaultModel?.trim()) {
    return { value: globalConfig.defaultModel.trim(), source: "global-json", path: globalPath, field: "defaultModel" };
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
    const container = new Container();
    const searchInput = new Input();
    const listContainer = new Container();
    let filteredItems = items;
    let selectedIndex = Math.max(0, items.findIndex((item) => item.fullId === configured));

    searchInput.onSubmit = () => {
      const selected = filteredItems[selectedIndex];
      done(selected ? selected.fullId : null);
    };

    function updateList(): void {
      listContainer.clear();
      const visibleCount = 10;
      const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(visibleCount / 2), filteredItems.length - visibleCount));
      const endIndex = Math.min(startIndex + visibleCount, filteredItems.length);

      for (let i = startIndex; i < endIndex; i++) {
        const item = filteredItems[i];
        if (!item) continue;
        const isSelected = i === selectedIndex;
        const isConfigured = item.fullId === configured;
        const prefix = isSelected ? colors.primary("→ ") : "  ";
        const modelText = isSelected ? colors.primary(item.fullId) : item.fullId;
        const currentMark = isConfigured ? colors.success(" ✓") : "";
        listContainer.addChild(new Text(`${prefix}${modelText}${currentMark}`, 0, 0));
      }

      if (filteredItems.length === 0) {
        listContainer.addChild(new Text(colors.meta("  No matching models"), 0, 0));
      } else {
        const selected = filteredItems[selectedIndex];
        if (selected) {
          listContainer.addChild(new Spacer(1));
          listContainer.addChild(new Text(colors.meta(`  ${selected.fullId}`), 0, 0));
        }
        if (startIndex > 0 || endIndex < filteredItems.length) {
          listContainer.addChild(new Text(colors.meta(`  (${selectedIndex + 1}/${filteredItems.length})`), 0, 0));
        }
      }
    }

    function filterItems(query: string): void {
      filteredItems = query
        ? fuzzyFilter(items, query, (item) => `${item.fullId} ${item.provider} ${item.id}`)
        : items;
      selectedIndex = Math.min(selectedIndex, Math.max(0, filteredItems.length - 1));
      updateList();
    }

    container.addChild(new DynamicBorder((s) => colors.primary(s)));
    container.addChild(new Text(colors.primary(theme.bold(" Select Suggest Model")), 0, 0));
    container.addChild(new Text(colors.meta(`Current: ${configured}`), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(searchInput);
    container.addChild(new Spacer(1));
    container.addChild(listContainer);
    container.addChild(new Spacer(1));
    container.addChild(new Text(colors.meta("Type to filter · ↑↓ navigate · enter select · esc cancel"), 0, 0));
    container.addChild(new DynamicBorder((s) => colors.primary(s)));

    filterItems("");

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        const keybindings = kb as { matches(data: string, action: string): boolean };
        if (keybindings.matches(data, "tui.select.up")) {
          if (filteredItems.length > 0) {
            selectedIndex = selectedIndex === 0 ? filteredItems.length - 1 : selectedIndex - 1;
            updateList();
          }
        } else if (keybindings.matches(data, "tui.select.down")) {
          if (filteredItems.length > 0) {
            selectedIndex = selectedIndex === filteredItems.length - 1 ? 0 : selectedIndex + 1;
            updateList();
          }
        } else if (keybindings.matches(data, "tui.select.confirm")) {
          const selected = filteredItems[selectedIndex];
          done(selected ? selected.fullId : null);
          return;
        } else if (keybindings.matches(data, "tui.select.cancel")) {
          done(null);
          return;
        } else {
          searchInput.handleInput(data);
          filterItems(searchInput.getValue());
        }
        tui.requestRender();
      },
    };
  });
}

function buildPayloadPreview(input: string, resolvedModel: string, modelResolutionReason: string): string {
  return truncate([
    `model=${resolvedModel}`,
    `resolution=${modelResolutionReason}`,
    "thinkingLevel=off",
    "tools=0",
    "extensions=disabled",
    "skills=disabled",
    "promptTemplates=disabled",
    `systemPrompt=${SUGGEST_SYSTEM_PROMPT.replace(/\s+/g, " ").trim()}`,
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

async function generateSuggestion(
  ctx: ExtensionContext,
  currentModel: Model<any> | undefined,
  input: string,
  onSession?: (session: { abort(): Promise<void>; dispose(): void }) => void,
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
  const suggestPayloadPreview = buildPayloadPreview(input, resolvedModel, resolution.reason);

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
    systemPrompt: SUGGEST_SYSTEM_PROMPT,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: suggestCwd,
    modelRegistry: ctx.modelRegistry,
    model,
    thinkingLevel: "off",
    tools: [],
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  onSession?.(session);

  try {
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
  let editorRef: SuggestEditor | null = null;
  let lastUIContext: ExtensionContext | undefined;

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
    suggestionHistory: [],
    miniMode: false,
  };
  let fancyFooterActive = false;

  // Active generation session — aborted when a new generation starts or suggest is cleared.
  let activeSession: { abort(): Promise<void>; dispose(): void } | null = null;

  async function abortActiveSession(): Promise<void> {
    if (!activeSession) return;
    const session = activeSession;
    activeSession = null;
    try {
      await session.abort();
    } catch {
      // ignore
    }
  }

  const fancyFooterReady = registerFancyFooterWidget(pi, () => ({
    id: "pi-agent-kit.suggest",
    label: "Suggest",
    description: "Shows whether suggest suggestions are enabled for the current session.",
    defaults: {
      row: 1,
      position: 12,
      align: "right",
      fill: "none",
    },
    textColor: "accent",
    visible: () => state.generating || state.suggestions.length > 0,
    renderText: () => state.generating ? "suggest:gen" : "suggest:ready",
  })).then((active) => {
    fancyFooterActive = active;
    return active;
  });

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
    editorRef?.setHistoryAvailable(state.suggestionHistory.length > 0);
  }

  function installEditor(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    lastUIContext = ctx;
    ctx.ui.setEditorComponent((tui, theme, kb) => {
      const editor = new SuggestEditor(tui, theme, kb);
      editor.setEnabled(state.enabled);
      editor.setSuggestions(state.enabled ? state.suggestions : [], state.selectedSuggestionIndex);
      editor.setOnAcceptSuggestion(() => {
        // Keep suggestions after accept so the ghost reappears
        // if the user deletes the inserted text
        syncEditor();
      });
      editor.setOnSelectSuggestion((index) => {
        state.selectedSuggestionIndex = index;
        if (lastUIContext) renderSuggestion(lastUIContext);
      });
      editor.setOnDismissSuggestion(() => {
        clearSuggestion(lastUIContext);
      });
      editor.setOnUndoSuggestion(() => {
        undoSuggestionDismissal(lastUIContext);
      });
      editor.setHistoryAvailable(state.suggestionHistory.length > 0);
      editorRef = editor;
      return editor;
    });
  }

  function clearSuggestion(ctx?: ExtensionContext, options?: { preserveDiagnostics?: boolean }): void {
    void abortActiveSession();
    if (ctx?.hasUI) lastUIContext = ctx;
    // Save to history before clearing
    if (state.suggestions.length > 0) {
      state.suggestionHistory.push({
        suggestions: [...state.suggestions],
        selectedSuggestionIndex: state.selectedSuggestionIndex,
        sourceTurnKey: state.sourceTurnKey,
      });
      if (state.suggestionHistory.length > 10) {
        state.suggestionHistory.shift();
      }
    }
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
    if (fancyFooterActive) {
      void refreshFancyFooter(pi);
    }
  }

  function undoSuggestionDismissal(ctx?: ExtensionContext): void {
    if (state.suggestionHistory.length === 0) return;
    if (ctx?.hasUI) lastUIContext = ctx;
    const entry = state.suggestionHistory.pop()!;
    state.suggestions = entry.suggestions;
    state.selectedSuggestionIndex = entry.selectedSuggestionIndex;
    state.sourceTurnKey = entry.sourceTurnKey;
    state.generating = false;
    syncEditor();
    renderSuggestion(ctx);
  }

  function renderSuggestion(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    lastUIContext = ctx;
    const selectedSuggestion = getSelectedSuggestion();
    if (!state.enabled || !selectedSuggestion) {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      ctx.ui.setStatus(STATUS_ID, undefined);
      if (fancyFooterActive) {
        void refreshFancyFooter(pi);
      }
      return;
    }

    syncEditor();
    const colors = createUiColors(ctx.ui.theme);

    if (state.miniMode) {
      // Mini mode — one-liner with keybindings
      const count = state.suggestions.length;
      const index = state.selectedSuggestionIndex + 1;
      const help = count > 1 ? "Alt+↑↓: Cycle" : "";
      const insert = "Tab/→: Insert";
      const undo = state.suggestionHistory.length > 0 ? "Alt+O: Undo" : "";
      const prefix = count > 1 ? `[${index}/${count}]` : "";
      const parts = [prefix, help, insert, undo].filter(Boolean);
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

      const historyText = state.suggestionHistory.length > 0
        ? ` · Alt+O undo (${state.suggestionHistory.length})`
        : "";

      const widgetLines = [
        colors.primary("Suggest:"),
        ...suggestionLines,
        colors.meta(helpText + historyText),
      ];
      ctx.ui.setWidget(WIDGET_ID, widgetLines);
    }

    if (fancyFooterActive) {
      ctx.ui.setStatus(STATUS_ID, undefined);
      void refreshFancyFooter(pi);
      return;
    }
    ctx.ui.setStatus(STATUS_ID, colors.primary("suggest:on"));
  }

  pi.on("session_start", async (_event, ctx) => {
    await fancyFooterReady;
    installEditor(ctx);
    clearSuggestion(ctx);
    renderSuggestion(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await fancyFooterReady;
    installEditor(ctx);
    clearSuggestion(ctx);
    renderSuggestion(ctx);
  });

  pi.on("session_shutdown", async () => {
    await abortActiveSession();
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

  pi.on("agent_end", async (event, ctx) => {
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
    const input = buildSuggestionInput(messages, ctx.cwd ?? process.cwd());
    if (!input) {
      clearSuggestion(ctx);
      return;
    }

    // Abort any in-flight generation before starting a new one
    await abortActiveSession();

    state.generating = true;
    if (fancyFooterActive) void refreshFancyFooter(pi);
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

    try {
      if (state.debug && ctx.hasUI) {
        ctx.ui.notify(`Suggest debug: generating with ${getConfiguredModelName(ctx.cwd)}` + (ctx.model ? ` (current ${ctx.model.provider}/${ctx.model.id})` : ""), "info");
        ctx.ui.notify(`Suggest payload:\n${truncate(input, 500)}`, "info");
      }
      const result = await generateSuggestion(ctx, ctx.model, input, (session) => {
        activeSession = session;
      });
      activeSession = null;
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
      // Save previous suggestions to history before overwriting
      if (state.suggestions.length > 0) {
        state.suggestionHistory.push({
          suggestions: [...state.suggestions],
          selectedSuggestionIndex: state.selectedSuggestionIndex,
          sourceTurnKey: state.sourceTurnKey,
        });
        if (state.suggestionHistory.length > 10) {
          state.suggestionHistory.shift();
        }
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
      activeSession = null;
      if (state.generationId !== generationId) return;
      // Ignore abort errors — these are expected when a newer generation starts
      if (error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))) {
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
  });

  pi.registerCommand("suggest", {
    description: "Toggle suggest suggestions or manage suggest settings",
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trimStart();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const endsWithSpace = /\s$/.test(trimmed);
      const root = ["on", "off", "status", "debug", "model"];

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
            configured.source === "env" || configured.source === "legacy-env"
              ? `Note: environment variables override settings and legacy JSON config`
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

      if (sub === "undo") {
        undoSuggestionDismissal(ctx);
        if (state.suggestions.length > 0) {
          ctx.ui.notify(`Suggest: restored suggestion "${getSelectedSuggestion()}" from history`, "info");
        } else {
          ctx.ui.notify("Suggest: no dismissed suggestions to restore", "info");
        }
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
}
