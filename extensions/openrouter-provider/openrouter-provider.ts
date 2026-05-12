/**
 * OpenRouter Provider Extension
 *
 * Access to frontier models from multiple providers through a single API key.
 * Curated selection of models not easily available elsewhere — Chinese-origin
 * models (Kimi, ByteDance, MiniMax), Google Gemini (no GCP setup), and xAI Grok.
 *
 * Requires: OPENROUTER_API_KEY environment variable.
 * Get one at: https://openrouter.ai/keys
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createUiColors } from "../_shared/ui-colors.js";

const API_KEY_ENV = "OPENROUTER_API_KEY";
const OPENROUTER_CONFIG_PATH = ".pi/openrouter-provider.json";

type OpenRouterModelDef = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

type OpenRouterRouting = {
  only?: string[];
  order?: string[];
  default?: string[];
};

type OpenRouterConfig = {
  routing?: Record<string, OpenRouterRouting>;
};

const MODEL_DEFS: OpenRouterModelDef[] = [
  {
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.42, output: 2.20, cacheRead: 0.21, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65535,
  },
  {
    id: "moonshotai/kimi-k2.6",
    name: "Kimi K2.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.30, output: 1.20, cacheRead: 0.15, cacheWrite: 0.30 },
    contextWindow: 262144,
    maxTokens: 65536,
  },
  {
    id: "minimax/minimax-m2.7",
    name: "MiniMax M2.7",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.60, cacheRead: 0.075, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 131072,
  },
  {
    id: "zhipuai/glm-5.1",
    name: "GLM 5.1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.25, output: 1.00, cacheRead: 0.125, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "qwen/qwen3.6-plus",
    name: "Qwen3.6 Plus",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.325, output: 1.95, cacheRead: 0.0325, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 65500,
  },
  {
    id: "qwen/qwen3.5-397b-a17b",
    name: "Qwen3.5 397B",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.39, output: 2.34, cacheRead: 0.195, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65500,
  },
  {
    id: "deepseek/deepseek-v3.2",
    name: "DeepSeek V3.2",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.26, output: 0.38, cacheRead: 0.13, cacheWrite: 0 },
    contextWindow: 163840,
    maxTokens: 65500,
  },
  {
    id: "google/gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2.0, output: 12.0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.25, output: 10.0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "google/gemini-3-flash-preview",
    name: "Gemini 3 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.5, output: 3.0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "x-ai/grok-4.20-beta",
    name: "Grok 4.20 Beta",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2.0, output: 6.0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 2000000,
    maxTokens: 65536,
  },
  {
    id: "x-ai/grok-4-fast",
    name: "Grok 4 Fast",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.2, output: 0.5, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 2000000,
    maxTokens: 30000,
  },
  {
    id: "x-ai/grok-code-fast-1",
    name: "Grok Code Fast",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.2, output: 1.5, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256000,
    maxTokens: 10000,
  },
  {
    id: "mistralai/devstral-medium",
    name: "Devstral Medium",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.4, output: 2.0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  {
    id: "bytedance-seed/seed-2.0-mini",
    name: "ByteDance Seed 2.0 Mini",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 131072,
  },
  {
    id: "inception/mercury-2",
    name: "Inception Mercury 2",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.25, output: 0.75, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 50000,
  },
];

function getConfigPath(cwd: string): string {
  return join(cwd, OPENROUTER_CONFIG_PATH);
}

function normalizeProviderList(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeRoutingEntry(entry: OpenRouterRouting | undefined): OpenRouterRouting | undefined {
  if (!entry) return undefined;
  const only = entry.only?.map((value) => value.trim()).filter(Boolean);
  const order = entry.order?.map((value) => value.trim()).filter(Boolean);
  const def = entry.default?.map((value) => value.trim()).filter(Boolean);
  if (only && only.length > 0) return { only };
  if (order && order.length > 0) return { order };
  if (def && def.length > 0) return { default: def };
  return undefined;
}

async function loadConfig(cwd: string): Promise<OpenRouterConfig> {
  try {
    const raw = await fs.readFile(getConfigPath(cwd), "utf8");
    const parsed = JSON.parse(raw) as OpenRouterConfig;
    const routing = Object.fromEntries(
      Object.entries(parsed.routing ?? {})
        .map(([modelId, entry]) => [modelId, normalizeRoutingEntry(entry)])
        .filter((entry): entry is [string, OpenRouterRouting] => !!entry[1]),
    );
    return Object.keys(routing).length > 0 ? { routing } : {};
  } catch {
    return {};
  }
}

async function saveConfig(cwd: string, config: OpenRouterConfig): Promise<void> {
  const path = getConfigPath(cwd);
  await fs.mkdir(join(cwd, ".pi"), { recursive: true });
  await fs.writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

async function clearConfig(cwd: string): Promise<void> {
  await fs.rm(getConfigPath(cwd), { force: true });
}

function buildModels(config: OpenRouterConfig) {
  return MODEL_DEFS.map((model) => {
    const routing = normalizeRoutingEntry(config.routing?.[model.id]);
    return {
      ...model,
      compat: routing ? { openRouterRouting: routing } : undefined,
    };
  });
}

function registerOpenRouterProvider(pi: ExtensionAPI, config: OpenRouterConfig): void {
  pi.unregisterProvider("openrouter");
  pi.registerProvider("openrouter", {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: API_KEY_ENV,
    api: "openai-completions",
    models: buildModels(config),
  });
}

function formatRouting(entry: OpenRouterRouting | undefined): string {
  if (!entry) return "default";
  if (entry.only?.length) return `only=${entry.only.join(",")}`;
  if (entry.order?.length) return `order=${entry.order.join(",")}`;
  if (entry.default?.length) return `default=${entry.default.join(",")}`;
  return "default";
}

async function applyConfigForCwd(pi: ExtensionAPI, cwd: string): Promise<OpenRouterConfig> {
  const config = await loadConfig(cwd);
  registerOpenRouterProvider(pi, config);
  return config;
}

function commandCompletions(prefix: string) {
  const trimmed = prefix.trimStart();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const endsWithSpace = /\s$/.test(trimmed);
  const root = ["status", "only", "order", "default", "clear"];

  if (!trimmed) return root.map((value) => ({ value, label: value }));

  if (parts.length <= 1 && !endsWithSpace) {
    const sub = (parts[0] ?? "").toLowerCase();
    const filtered = root.filter((value) => value.startsWith(sub));
    return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
  }

  const first = (parts[0] ?? "").toLowerCase();
  if (first === "only" || first === "order" || first === "default" || first === "clear") {
    const wantsModel = parts.length === 1 || (parts.length === 2 && !endsWithSpace);
    if (wantsModel) {
      const modelPrefix = parts.length <= 1 || endsWithSpace ? "" : (parts[1] ?? "").toLowerCase();
      const matches = MODEL_DEFS
        .map((model) => model.id)
        .filter((id) => id.startsWith(modelPrefix));
      return matches.map((id) => ({ value: `${first} ${id}`, label: id }));
    }
  }

  return null;
}

export default function (pi: ExtensionAPI) {
  registerOpenRouterProvider(pi, {});

  pi.on("session_start", async (_event, ctx) => {
    const config = await applyConfigForCwd(pi, ctx.cwd);
    if (process.env[API_KEY_ENV]) {
      if (ctx.hasUI) ctx.ui.setStatus("openrouter", undefined);
      return;
    }
    if (ctx.hasUI) {
      const colors = createUiColors(ctx.ui.theme);
      ctx.ui.setStatus("openrouter", colors.warning("or:no-key"));
      ctx.ui.notify(`OpenRouter provider loaded, but ${API_KEY_ENV} is not set`, "warning");
      if (config.routing && Object.keys(config.routing).length > 0) {
        ctx.ui.notify(`OpenRouter routing config loaded from ${getConfigPath(ctx.cwd)}`, "info");
      }
    }
  });

  pi.registerCommand("openrouter", {
    description: "Manage OpenRouter per-model provider routing",
    getArgumentCompletions: commandCompletions,
    handler: async (args, ctx: ExtensionContext) => {
      const raw = args.trim();
      const configPath = getConfigPath(ctx.cwd);
      const config = await loadConfig(ctx.cwd);

      if (!raw || raw === "status") {
        const lines = [
          "OpenRouter routing status",
          `Config path: ${configPath}`,
          `API key: ${process.env[API_KEY_ENV] ? "set" : "missing"}`,
        ];
        const routing = config.routing ?? {};
        if (Object.keys(routing).length === 0) {
          lines.push("Routing: default");
        } else {
          lines.push("Routing:");
          for (const model of MODEL_DEFS) {
            const entry = routing[model.id];
            if (entry) {
              lines.push(`- ${model.id}: ${formatRouting(entry)}`);
            }
          }
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const [subcommand, modelId, ...rest] = raw.split(/\s+/);
      const value = rest.join(" ").trim();
      const knownModel = MODEL_DEFS.some((model) => model.id === modelId);

      if (subcommand === "only" || subcommand === "order" || subcommand === "default") {
        if (!knownModel || !value) {
          throw new Error("Usage: /openrouter <only|order|default> <model-id> <provider-slug[,provider-slug,...]>");
        }
        const providers = normalizeProviderList(value);
        if (providers.length === 0) {
          throw new Error("Provider list cannot be empty");
        }
        const next: OpenRouterConfig = { routing: { ...(config.routing ?? {}) } };
        if (subcommand === "only") next.routing![modelId] = { only: providers };
        else if (subcommand === "order") next.routing![modelId] = { order: providers };
        else next.routing![modelId] = { default: providers };
        await saveConfig(ctx.cwd, next);
        registerOpenRouterProvider(pi, next);
        ctx.ui.notify(
          `OpenRouter routing for ${modelId} set to ${formatRouting(next.routing?.[modelId])}`,
          "info",
        );
        return;
      }

      if (subcommand === "clear") {
        if (!modelId) {
          await clearConfig(ctx.cwd);
          registerOpenRouterProvider(pi, {});
          ctx.ui.notify("OpenRouter routing config cleared", "info");
          return;
        }
        if (!knownModel) {
          throw new Error(`Unknown model id: ${modelId}`);
        }
        const nextRouting = { ...(config.routing ?? {}) };
        delete nextRouting[modelId];
        if (Object.keys(nextRouting).length === 0) {
          await clearConfig(ctx.cwd);
          registerOpenRouterProvider(pi, {});
        } else {
          const next = { routing: nextRouting } satisfies OpenRouterConfig;
          await saveConfig(ctx.cwd, next);
          registerOpenRouterProvider(pi, next);
        }
        ctx.ui.notify(`OpenRouter routing cleared for ${modelId}`, "info");
        return;
      }

      throw new Error(
        "Usage: /openrouter [status|only <model-id> <providers>|order <model-id> <providers>|default <model-id> <providers>|clear [model-id]]",
      );
    },
  });
}
