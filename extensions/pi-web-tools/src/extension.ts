import { complete, type Message } from "@earendil-works/pi-ai";
import { SettingsManager, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "./once.ts";
import { resolveApiKey, stripHtmlToText } from "./providers/utils.ts";
import {
  FETCH_PROVIDER_NAMES,
  FETCH_PROVIDERS,
  fetchWithProvider,
  type WebFetchProvider,
} from "./fetch-registry.ts";
import {
  createWebSearchRegistry,
  type SearchResult,
  type WebBackendConfig,
  type WebSearchBackendParams,
  type WebSearchProvider,
} from "./search-registry.ts";
import { resolveApiKey, stripHtmlToText } from "./providers/utils.ts";

const WEB_TOOLS_SETTINGS_KEY = "webTools";
const DEFAULT_FETCH_MAX_CHARS = 20_000;
const MAX_FETCH_MAX_CHARS = 100_000;
const DEFAULT_SEARCH_RESULTS = 8;
const MAX_SEARCH_RESULTS = 20;
const EXTRACT_PROMPT_MAX_CHARS = 40_000;



type WebToolsConfig = {
  defaultProvider?: WebSearchProvider;
  defaultFetchProvider?: WebFetchProvider;
  backends?: Record<string, WebBackendConfig | undefined>;
};

type GhCodeResult = {
  path: string;
  repository: { fullName: string };
  url: string;
  textMatches?: Array<{ fragment?: string | null }>;
};

type GhIssueResult = {
  number: number;
  title: string;
  state: string;
  url: string;
  author?: { login?: string | null } | null;
  labels?: Array<{ name: string }> | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  comments?: number | null;
  body?: string | null;
};

function ok(text: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? {},
  };
}

function fail(text: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
    details: details ?? {},
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, Math.max(0, maxChars - 1))}…`,
    truncated: true,
  };
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\*\./, "");
}

function hostnameMatches(hostname: string, domain: string): boolean {
  const normalizedHost = hostname.toLowerCase();
  const normalizedDomain = normalizeDomain(domain);
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function isPrivateIp(hostname: string): boolean {
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return true;
  if (hostname === "::1") return true;
  if (hostname.startsWith("fc") || hostname.startsWith("fd")) return true;
  return false;
}

function validatePublicHttpUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported");
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    isPrivateIp(hostname)
  ) {
    throw new Error("Local, private, or loopback hosts are not allowed");
  }

  return url;
}

function filterByDomains(results: SearchResult[], includeDomains?: string[], excludeDomains?: string[]): SearchResult[] {
  return results.filter((result) => {
    try {
      const hostname = new URL(result.url).hostname;
      if (includeDomains?.length && !includeDomains.some((domain) => hostnameMatches(hostname, domain))) {
        return false;
      }
      if (excludeDomains?.length && excludeDomains.some((domain) => hostnameMatches(hostname, domain))) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  });
}

function formatSearchResults(query: string, provider: string, results: SearchResult[]): string {
  const lines: string[] = [];
  lines.push(`Found ${results.length} result(s) for "${query}" using ${provider}:`);
  lines.push("");

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    lines.push(`### ${i + 1}. ${result.title}`);
    lines.push(`- URL: ${result.url}`);
    if (result.published) lines.push(`- Published: ${result.published}`);
    if (result.snippet) lines.push(`- Snippet: ${result.snippet}`);
    lines.push("");
  }

  lines.push("Sources:");
  for (const result of results) {
    lines.push(`- ${result.title}: ${result.url}`);
  }

  return lines.join("\n");
}

async function extractFromMarkdown(
  ctx: ExtensionContext,
  url: string,
  markdown: string,
  extractPrompt: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!ctx.model) return null;

  const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
  if (!apiKey) return null;

  const content = truncate(markdown, EXTRACT_PROMPT_MAX_CHARS).text;
  const systemPrompt = [
    "You extract specific information from fetched web content.",
    "Answer using only the provided page content.",
    "Be concise but include the key facts the user asked for.",
    "If the content does not contain the answer, say so clearly.",
    "Include short direct quotes only when helpful.",
    "Do not invent facts not present in the page.",
  ].join(" ");

  const userMessage: Message = {
    role: "user",
    timestamp: Date.now(),
    content: [{
      type: "text",
      text: [
        `URL: ${url}`,
        "",
        "User request:",
        extractPrompt,
        "",
        "Page content:",
        content,
      ].join("\n"),
    }],
  };

  const response = await complete(
    ctx.model,
    { systemPrompt, messages: [userMessage] },
    { apiKey, signal },
  );

  if (response.stopReason === "aborted" || response.stopReason === "error") {
    return null;
  }

  const text = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  return text || null;
}


function resolveWebToolsConfigPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBackends(raw: unknown): Record<string, WebBackendConfig | undefined> | undefined {
  if (!isRecord(raw)) return undefined;
  const backends: Record<string, WebBackendConfig | undefined> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    backends[name] = {
      enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
      apiKey: typeof value.apiKey === "string" ? value.apiKey : undefined,
      baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : typeof value.instanceUrl === "string" ? value.instanceUrl : undefined,
      model: typeof value.model === "string" ? value.model : undefined,
      searchDepth: typeof value.searchDepth === "string" ? value.searchDepth : typeof value.depth === "string" ? value.depth : undefined,
    };
  }
  return backends;
}

function normalizeWebToolsConfig(raw: unknown): WebToolsConfig {
  if (!isRecord(raw)) return {};
  const config: WebToolsConfig = {};
  const candidate = raw.defaultProvider ?? raw.defaultBackend;
  if (typeof candidate === "string" && WEB_SEARCH_PROVIDERS.includes(candidate as WebSearchProvider)) {
    config.defaultProvider = candidate as WebSearchProvider;
  }
  const fetchCandidate = raw.defaultFetchProvider ?? raw.reader;
  if (typeof fetchCandidate === "string" && FETCH_PROVIDERS.includes(fetchCandidate)) {
    config.defaultFetchProvider = fetchCandidate as WebFetchProvider;
  }
  config.backends = normalizeBackends(raw.backends);
  return config;
}

function mergeWebToolsConfig(base: WebToolsConfig, override: WebToolsConfig): WebToolsConfig {
  return {
    ...base,
    ...override,
    backends: {
      ...(base.backends ?? {}),
      ...(override.backends ?? {}),
    },
  };
}

function readConfigFile(path: string): WebToolsConfig {
  try {
    if (!existsSync(path)) return {};
    return normalizeWebToolsConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

async function withSettingsManager<T>(cwd: string, fn: (manager: SettingsManager) => Promise<T> | T): Promise<T> {
  const manager = SettingsManager.create(cwd);
  await manager.reload();
  return await fn(manager);
}

async function loadWebToolsConfig(cwd: string): Promise<WebToolsConfig> {
  const fileConfig = mergeWebToolsConfig(
    readConfigFile(join(getAgentDir(), "extensions", "search.json")),
    readConfigFile(join(cwd, ".pi", "search.json")),
  );

  const settingsConfig = await withSettingsManager(cwd, (manager) => {
    const globalSettings = manager.getGlobalSettings() as Record<string, unknown>;
    const projectSettings = manager.getProjectSettings() as Record<string, unknown>;
    return mergeWebToolsConfig(
      normalizeWebToolsConfig(globalSettings[WEB_TOOLS_SETTINGS_KEY]),
      normalizeWebToolsConfig(projectSettings[WEB_TOOLS_SETTINGS_KEY]),
    );
  });

  return mergeWebToolsConfig(fileConfig, settingsConfig);
}

async function saveWebToolsConfig(cwd: string, config: WebToolsConfig): Promise<void> {
  await withSettingsManager(cwd, async (manager) => {
    const projectSettings = manager.getProjectSettings() as Record<string, unknown>;
    projectSettings[WEB_TOOLS_SETTINGS_KEY] = config;

    const internal = manager as unknown as {
      modifiedProjectFields: Set<string>;
      saveProjectSettings: (settings: Record<string, unknown>) => void;
      flush: () => Promise<void>;
    };
    internal.modifiedProjectFields.add(WEB_TOOLS_SETTINGS_KEY);
    internal.saveProjectSettings(projectSettings);
    await internal.flush();
  });
}

async function clearWebToolsConfig(cwd: string): Promise<void> {
  await withSettingsManager(cwd, async (manager) => {
    const projectSettings = manager.getProjectSettings() as Record<string, unknown>;
    delete projectSettings[WEB_TOOLS_SETTINGS_KEY];

    const internal = manager as unknown as {
      modifiedProjectFields: Set<string>;
      saveProjectSettings: (settings: Record<string, unknown>) => void;
      flush: () => Promise<void>;
    };
    internal.modifiedProjectFields.add(WEB_TOOLS_SETTINGS_KEY);
    internal.saveProjectSettings(projectSettings);
    await internal.flush();
  });
}





const WEB_SEARCH_REGISTRY = createWebSearchRegistry();

const WEB_SEARCH_BACKEND_ORDER = WEB_SEARCH_REGISTRY.order;
const WEB_SEARCH_PROVIDERS = WEB_SEARCH_REGISTRY.providers;

function providerCompletions(prefix: string, providers: WebSearchProvider[]) {
  const trimmed = prefix.trimStart().toLowerCase();
  if (!trimmed) return providers.map((value) => ({ value, label: value }));
  const filtered = providers.filter((value) => value.startsWith(trimmed));
  return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
}

export default function webToolsExtension(pi: ExtensionAPI) {
  once(pi, "pi-web-tools", () => {
  pi.registerTool({
    name: "web_fetch",
    description:
      "Fetch a specific webpage and return its content as markdown. Use this when you already have an exact URL for docs, articles, release notes, or reference pages.",
    promptSnippet: "Fetch and read a specific webpage as markdown.",
    promptGuidelines: [
      "Use web_fetch when the user already gave you an exact URL or when you need to read a single known page.",
      "Prefer web_search first if you still need to discover the right page or source.",
      "Use max_chars to keep very large pages manageable.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch (http/https only)" }),
      provider: Type.Optional(
        Type.Union(
          (FETCH_PROVIDER_NAMES as readonly string[]).map((p) => Type.Literal(p)),
          {
            description: "Fetch backend to use: jina (default, converts to markdown), native (direct fetch with HTML-to-text stripping), firecrawl (API key optional), exa (needs key, uses Contents API)",
          },
        ),
      ),
      extract: Type.Optional(
        Type.String({
          description: "Optional question or extraction request to answer from the fetched page content",
        }),
      ),
      max_chars: Type.Optional(
        Type.Number({
          description: `Maximum number of characters to return (default: ${DEFAULT_FETCH_MAX_CHARS}, max: ${MAX_FETCH_MAX_CHARS})`,
          minimum: 1000,
          maximum: MAX_FETCH_MAX_CHARS,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let url: URL;
      try {
        url = validatePublicHttpUrl(params.url);
      } catch (error) {
        return fail(`Invalid URL: ${error instanceof Error ? error.message : String(error)}`);
      }

      const maxChars = clamp(params.max_chars ?? DEFAULT_FETCH_MAX_CHARS, 1000, MAX_FETCH_MAX_CHARS);
      const fetchConfig = await loadWebToolsConfig(ctx.cwd);
      const provider: WebFetchProvider = (params.provider ?? fetchConfig.defaultFetchProvider ?? FETCH_PROVIDER_NAMES[0]) as WebFetchProvider;

      try {
        const { text, source } = await fetchWithProvider(url, provider, signal);

        if (params.extract?.trim()) {
          const answer = await extractFromMarkdown(ctx, url.toString(), text, params.extract.trim(), signal);
          if (answer) {
            return ok([
              `Fetched: ${url.toString()} (${source})`,
              `Question: ${params.extract.trim()}`,
              "",
              answer,
            ].join("\n"), {
              url: url.toString(),
              source,
              extracted: true,
              originalLength: text.length,
            });
          }
        }

        const truncated = truncate(text, maxChars);
        const lines = [
          `Fetched: ${url.toString()} (${source})`,
          `Length: ${text.length} chars${truncated.truncated ? ` (truncated to ${maxChars})` : ""}`,
          params.extract?.trim()
            ? `Extract requested but no model was available, so returning raw content instead.`
            : undefined,
          "",
          truncated.text,
        ].filter((line): line is string => typeof line === "string");

        return ok(lines.join("\n"), {
          url: url.toString(),
          source,
          originalLength: text.length,
          returnedLength: truncated.text.length,
          truncated: truncated.truncated,
          extracted: false,
        });
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          return fail("Web fetch aborted", { url: url.toString() });
        }
        return fail(`Web fetch failed: ${(error as Error).message}`, { url: url.toString() });
      }
    },
  });

  pi.registerTool({
    name: "web_search",
    description:
      "Search the web and return structured results with titles, URLs, and snippets. Use this for recent info, documentation discovery, articles, and source gathering.",
    promptSnippet: "Search the web and return structured results with sources.",
    promptGuidelines: [
      "Use web_search when you need to discover sources or find recent/external information.",
      "Use provider='auto' for fallback across configured backends. Prefer exa/tavily for research, serper/brave/duckduckgo for general search, firecrawl for crawl-oriented results, and perplexity for answer-oriented research.",
      "Always cite the returned URLs when answering the user.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      provider: Type.Optional(
        Type.Union(
          WEB_SEARCH_PROVIDERS.map((p) => Type.Literal(p)),
          {
            description: `Search backend to use: ${WEB_SEARCH_PROVIDERS.join(", ")}`,
          },
        ),
      ),
      include_domains: Type.Optional(
        Type.Array(Type.String(), {
          description: "Only include results from these domains",
        }),
      ),
      exclude_domains: Type.Optional(
        Type.Array(Type.String(), {
          description: "Exclude results from these domains",
        }),
      ),
      num_results: Type.Optional(
        Type.Number({
          description: `Number of results to return (default: ${DEFAULT_SEARCH_RESULTS}, max: ${MAX_SEARCH_RESULTS})`,
          minimum: 1,
          maximum: MAX_SEARCH_RESULTS,
        }),
      ),
      type: Type.Optional(
        Type.Union([
          Type.Literal("auto"),
          Type.Literal("neural"),
          Type.Literal("fast"),
          Type.Literal("deep"),
        ], {
          description: "Exa search mode when provider is auto/exa",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const query = params.query.trim();
      if (!query) {
        return fail("Search query cannot be empty");
      }
      if (params.include_domains?.length && params.exclude_domains?.length) {
        return fail("Use either include_domains or exclude_domains, not both in the same request");
      }

      const config = await loadWebToolsConfig(ctx.cwd);
      const provider = (params.provider ?? config.defaultProvider ?? "auto") as WebSearchProvider;
      const numResults = clamp(params.num_results ?? DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS);
      const includeDomains = params.include_domains?.map(normalizeDomain).filter(Boolean);
      const excludeDomains = params.exclude_domains?.map(normalizeDomain).filter(Boolean);

      try {
        let searchResponse: { provider: string; results: SearchResult[] } | undefined;
        const searchParams: WebSearchBackendParams = {
          query,
          numResults,
          searchType: params.type ?? "auto",
          includeDomains,
          excludeDomains,
          signal,
        };

        if (provider !== "auto") {
          searchResponse = await WEB_SEARCH_REGISTRY.run(provider, {
            ...searchParams,
            backendConfig: config.backends?.[provider],
          });
        } else {
          const usableBackends = WEB_SEARCH_REGISTRY.enabledOrder(config.backends).filter(
            (name) => {
              const backend = WEB_SEARCH_REGISTRY.backends[name];
              if (backend.requiresKey !== true) return true;
              return !!resolveApiKey(config.backends?.[name], []);
            },
          );
          const errors: string[] = [];
          for (const backend of usableBackends) {
            try {
              searchResponse = await WEB_SEARCH_REGISTRY.run(backend, {
                ...searchParams,
                backendConfig: config.backends?.[backend],
              });
              break;
            } catch (backendError) {
              errors.push(`${backend}: ${(backendError as Error).message}`);
            }
          }

          if (!searchResponse) {
            throw new Error(`All configured web search providers failed (${errors.join("; ")})`);
          }
        }

        const results = searchResponse.results.slice(0, numResults);
        if (results.length === 0) {
          return ok(`No results found for: "${query}"`, {
            query,
            provider: searchResponse.provider,
            resultCount: 0,
          });
        }

        return ok(formatSearchResults(query, searchResponse.provider, results), {
          query,
          provider: searchResponse.provider,
          resultCount: results.length,
          includeDomains,
          excludeDomains,
          configuredDefaultProvider: config.defaultProvider ?? "auto",
        });
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          return fail("Web search aborted", { query });
        }
        return fail(`Web search failed: ${(error as Error).message}`, {
          query,
          provider,
        });
      }
    },
  });

        pi.registerCommand("web_search", {
    description: "Configure the default provider for the web_search tool",
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trimStart();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const endsWithSpace = /\s$/.test(trimmed);
      const root = ["status", "provider", "clear"];
      const providers = WEB_SEARCH_PROVIDERS;

      if (!trimmed) return root.map((value) => ({ value, label: value }));
      if (parts.length <= 1 && !endsWithSpace) {
        const sub = (parts[0] ?? "").toLowerCase();
        const filtered = root.filter((value) => value.startsWith(sub));
        return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
      }
      if ((parts[0] ?? "") === "provider") {
        const subPrefix = parts.length <= 1 || endsWithSpace ? "" : (parts[parts.length - 1] ?? "");
        return providerCompletions(subPrefix, providers)?.map((item) => ({ value: `provider ${item.value}`, label: item.label })) ?? null;
      }
      return null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const configPath = resolveWebToolsConfigPath(ctx.cwd);
      if (!trimmed || trimmed === "status") {
        const config = await loadWebToolsConfig(ctx.cwd);
        const provider = config.defaultProvider ?? "auto";
        ctx.ui.notify([
          "web_search config",
          `Default provider: ${provider}`,
          `Config path: ${configPath}`,
          `Settings key: ${WEB_TOOLS_SETTINGS_KEY}`,
          "",
          "Registered backends:",
          ...WEB_SEARCH_REGISTRY.summary(),
        ].join("\n"), "info");
        return;
      }

      const [subcommand, ...rest] = trimmed.split(/\s+/);
      const remainder = rest.join(" ").trim().toLowerCase();

      if (subcommand === "provider") {
        if (!WEB_SEARCH_PROVIDERS.includes(remainder as WebSearchProvider)) {
          throw new Error(`Usage: /web_search provider <${WEB_SEARCH_PROVIDERS.join("|")}>`);
        }
        await saveWebToolsConfig(ctx.cwd, { defaultProvider: remainder as WebSearchProvider });
        ctx.ui.notify(`web_search default provider set to ${remainder} in ${configPath}#${WEB_TOOLS_SETTINGS_KEY}`, "info");
        return;
      }

      if (subcommand === "clear") {
        await clearWebToolsConfig(ctx.cwd);
        ctx.ui.notify(`web_search config cleared from ${configPath} (default provider back to auto)`, "info");
        return;
      }

      throw new Error(`Usage: /web_search [status|provider <${WEB_SEARCH_PROVIDERS.join("|")}>|clear]`);
    },
  });

  pi.registerCommand("web_fetch", {
    description: "Configure the default fetch provider for the web_fetch tool",
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trimStart();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const endsWithSpace = /\s$/.test(trimmed);
      const root = ["status", "provider", "clear"];
      const fetchProviders = FETCH_PROVIDERS as WebFetchProvider[];

      if (!trimmed) return root.map((value) => ({ value, label: value }));
      if (parts.length <= 1 && !endsWithSpace) {
        const sub = (parts[0] ?? "").toLowerCase();
        const filtered = root.filter((value) => value.startsWith(sub));
        return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
      }
      if ((parts[0] ?? "") === "provider") {
        const subPrefix = parts.length <= 1 || endsWithSpace ? "" : (parts[parts.length - 1] ?? "");
        const matches = fetchProviders.filter((value) => value.startsWith(subPrefix.toLowerCase()));
        return matches.length > 0 ? matches.map((value) => ({ value: `provider ${value}`, label: value })) : null;
      }
      return null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const configPath = resolveWebToolsConfigPath(ctx.cwd);
      if (!trimmed || trimmed === "status") {
        const config = await loadWebToolsConfig(ctx.cwd);
        const fetchProvider = config.defaultFetchProvider ?? FETCH_PROVIDER_NAMES[0];
        const searchProvider = config.defaultProvider ?? "auto";
        ctx.ui.notify([
          "web_tools config",
          `Default web_search provider: ${searchProvider}`,
          `Default web_fetch provider: ${fetchProvider}`,
          `Config path: ${configPath}`,
          `Settings key: ${WEB_TOOLS_SETTINGS_KEY}`,
        ].join("\n"), "info");
        return;
      }

      const [subcommand, ...rest] = trimmed.split(/\s+/);
      const remainder = rest.join(" ").trim().toLowerCase();

      if (subcommand === "provider") {
        if (!FETCH_PROVIDERS.includes(remainder)) {
          throw new Error(`Usage: /web_fetch provider <${FETCH_PROVIDERS.join("|")}>`);
        }
        const current = await loadWebToolsConfig(ctx.cwd);
        await saveWebToolsConfig(ctx.cwd, { ...current, defaultFetchProvider: remainder as WebFetchProvider });
        ctx.ui.notify(`web_fetch default provider set to ${remainder} in ${configPath}#${WEB_TOOLS_SETTINGS_KEY}`, "info");
        return;
      }

      if (subcommand === "clear") {
        const current = await loadWebToolsConfig(ctx.cwd);
        delete current.defaultFetchProvider;
        if (Object.keys(current).length === 0) {
          await clearWebToolsConfig(ctx.cwd);
        } else {
          await saveWebToolsConfig(ctx.cwd, current);
        }
        ctx.ui.notify(`web_fetch provider reset to jina (default) in ${configPath}`, "info");
        return;
      }

      throw new Error(`Usage: /web_fetch [status|provider <${FETCH_PROVIDERS.join("|")}>|clear]`);
    },
  });

  });
}
