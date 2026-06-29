import { complete, type Message } from "@earendil-works/pi-ai";
import { SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { once } from "./once.ts";
import {
  createWebSearchRegistry,
  type SearchResult,
  type WebSearchBackendParams,
  type WebSearchProvider,
} from "./search-registry.ts";

const WEB_TOOLS_SETTINGS_KEY = "webTools";
const DEFAULT_FETCH_MAX_CHARS = 20_000;
const MAX_FETCH_MAX_CHARS = 100_000;
const DEFAULT_SEARCH_RESULTS = 8;
const MAX_SEARCH_RESULTS = 20;
const EXTRACT_PROMPT_MAX_CHARS = 40_000;

type WebFetchProvider = "jina" | "native";

type WebToolsConfig = {
  defaultProvider?: WebSearchProvider;
  defaultFetchProvider?: WebFetchProvider;
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

function runGh(subcommand: string[], jsonFields: string, signal?: AbortSignal): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const child = spawn("gh", [...subcommand, "--json", jsonFields], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onAbort = () => {
      child.kill();
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `gh exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as unknown[]);
      } catch {
        reject(new Error(`Failed to parse gh output: ${stdout}`));
      }
    });

    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

function githubSearchFailure(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("ENOENT") || msg.includes("gh: command not found")) {
    return fail("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/.");
  }
  if (msg.includes("not logged in") || msg.includes("auth login")) {
    return fail("GitHub CLI is not authenticated. Run `gh auth login`.");
  }
  if ((error as Error).name === "AbortError") {
    return fail("GitHub search aborted");
  }
  return fail(`GitHub search failed: ${msg}`);
}

function formatGithubCodeResults(results: GhCodeResult[]): string {
  if (results.length === 0) return "No results found.";

  const lines: string[] = [`Found ${results.length} result(s):`, ""];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    lines.push(`### ${i + 1}. ${result.repository.fullName}/${result.path}`);
    lines.push(`- URL: ${result.url}`);
    for (const match of result.textMatches ?? []) {
      const fragment = match.fragment?.split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
      if (fragment) lines.push("```\n" + fragment + "\n```");
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function formatGithubIssueResults(results: GhIssueResult[], kind: string): string {
  if (results.length === 0) return `No ${kind} found.`;

  const lines: string[] = [`Found ${results.length} ${kind}:`, ""];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const state = result.state === "open" ? "OPEN" : "CLOSED";
    const labels = result.labels?.length ? result.labels.map((label) => label.name).join(", ") : "";
    const age = result.createdAt?.slice(0, 10) ?? "";

    lines.push(`### ${i + 1}. #${result.number} ${result.title}`);
    lines.push(`- State: ${state}`);
    lines.push(`- Author: ${result.author?.login ?? "?"}`);
    if (age) lines.push(`- Date: ${age}`);
    lines.push(`- Comments: ${result.comments ?? 0}`);
    if (labels) lines.push(`- Labels: ${labels}`);
    lines.push(`- URL: ${result.url}`);

    if (result.body) {
      lines.push("");
      lines.push(truncate(result.body.replace(/\s+/g, " "), 300).text);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
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

function normalizeWebToolsConfig(raw: unknown): WebToolsConfig {
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  const config: WebToolsConfig = {};
  const candidate = obj.defaultProvider;
  if (candidate === "auto" || candidate === "exa" || candidate === "brave" || candidate === "searx") {
    config.defaultProvider = candidate;
  }
  const fetchCandidate = obj.defaultFetchProvider;
  if (fetchCandidate === "jina" || fetchCandidate === "native") {
    config.defaultFetchProvider = fetchCandidate;
  }
  return config;
}

async function withSettingsManager<T>(cwd: string, fn: (manager: SettingsManager) => Promise<T> | T): Promise<T> {
  const manager = SettingsManager.create(cwd);
  await manager.reload();
  return await fn(manager);
}

async function loadWebToolsConfig(cwd: string): Promise<WebToolsConfig> {
  return await withSettingsManager(cwd, (manager) => {
    const projectSettings = manager.getProjectSettings() as Record<string, unknown>;
    return normalizeWebToolsConfig(projectSettings[WEB_TOOLS_SETTINGS_KEY]);
  });
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

async function resolveDefaultProvider(cwd: string): Promise<WebSearchProvider> {
  const config = await loadWebToolsConfig(cwd);
  return config.defaultProvider ?? "auto";
}

async function resolveDefaultFetchProvider(cwd: string): Promise<WebFetchProvider> {
  const config = await loadWebToolsConfig(cwd);
  return config.defaultFetchProvider ?? "jina";
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<!--.*?-->/gs, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<\/?(p|div|br|hr|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|nav|main|aside)[\s>][^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/gi, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]*\n/g, "\n\n")
    .replace(/^[ \t]+/gm, "")
    .trim();
}

async function nativeFetchHtml(url: URL, signal?: AbortSignal): Promise<{ text: string; contentType: string }> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "pi-agent-kit/1.0 web-tools native-fetch",
    },
    redirect: "follow",
    signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${url.toString()}`);
  }

  const contentType = response.headers.get("content-type") || "";
  return { text: await response.text(), contentType };
}

async function fetchWithProvider(
  url: URL,
  provider: WebFetchProvider,
  signal?: AbortSignal,
): Promise<{ text: string; source: string }> {
  if (provider === "native") {
    const { text, contentType } = await nativeFetchHtml(url, signal);
    const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml");
    return { text: isHtml ? stripHtmlToText(text) : text, source: "native" };
  }

  // Jina provider (default)
  const jinaUrl = `https://r.jina.ai/${url.toString()}`;
  const response = await fetch(jinaUrl, {
    headers: { Accept: "text/markdown" },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Jina fetch failed: ${response.status} ${response.statusText}`);
  }

  return { text: await response.text(), source: "jina" };
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
        Type.Union([
          Type.Literal("jina"),
          Type.Literal("native"),
        ], {
          description: "Fetch backend to use: jina (default, converts to markdown), native (direct fetch with HTML-to-text stripping)",
        }),
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
      const provider: WebFetchProvider = (params.provider ?? await resolveDefaultFetchProvider(ctx.cwd)) as WebFetchProvider;

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
      "Prefer provider='exa' for documentation and semantic research; use provider='brave' for general web search; use provider='searx' for self-hosted/privacy-oriented search.",
      "Always cite the returned URLs when answering the user.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      provider: Type.Optional(
        Type.Union([
          Type.Literal("auto"),
          Type.Literal("exa"),
          Type.Literal("brave"),
          Type.Literal("searx"),
        ], {
          description: "Search backend to use: auto (default), exa, brave, or searx",
        }),
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

      const provider = (params.provider ?? await resolveDefaultProvider(ctx.cwd)) as WebSearchProvider;
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
          searchResponse = await WEB_SEARCH_REGISTRY.run(provider, searchParams);
        } else {
          const errors: string[] = [];
          for (const backend of WEB_SEARCH_BACKEND_ORDER) {
            try {
              searchResponse = await WEB_SEARCH_REGISTRY.run(backend, searchParams);
              break;
            } catch (backendError) {
              errors.push(`${backend}: ${(backendError as Error).message}`);
            }
          }

          if (!searchResponse) {
            throw new Error(`All web search providers failed (${errors.join("; ")})`);
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
          configuredDefaultProvider: await resolveDefaultProvider(ctx.cwd),
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

  pi.registerTool({
    name: "github_search_code",
    description: "Search code across GitHub repositories via gh CLI. Find usage examples, implementations, and configuration patterns.",
    promptGuidelines: [
      "Use github_search_code to find how others implement specific patterns or use specific APIs.",
      "Use repo to search within a specific repository.",
      "Prefer focused qualifiers such as language, extension, filename, owner, or repo.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query (e.g., 'useState lang:typescript', 'filename:flake.nix nixpkgs')" }),
      language: Type.Optional(Type.String({ description: "Filter by language (e.g., 'python', 'typescript')" })),
      owner: Type.Optional(Type.String({ description: "Filter by repo owner (e.g., 'nixos')" })),
      repo: Type.Optional(Type.String({ description: "Filter by repo (e.g., 'nixos/nixpkgs')" })),
      extension: Type.Optional(Type.String({ description: "Filter by file extension (e.g., 'ts', 'nix')" })),
      filename: Type.Optional(Type.String({ description: "Filter by filename (e.g., 'flake.nix')" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 10, max: 100)", minimum: 1, maximum: 100 })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const query = params.query.trim();
      if (!query) return fail("GitHub code search query cannot be empty");

      try {
        const args = ["search", "code", query];
        if (params.language) args.push("--language", params.language);
        if (params.owner) args.push("--owner", params.owner);
        if (params.repo) args.push("--repo", params.repo);
        if (params.extension) args.push("--extension", params.extension);
        if (params.filename) args.push("--filename", params.filename);
        args.push("--limit", String(clamp(params.limit ?? 10, 1, 100)));

        onUpdate?.({ content: [{ type: "text", text: `Searching GitHub code: ${query}...` }] });

        const results = await runGh(args, "path,repository,url,textMatches", signal) as GhCodeResult[];
        return ok(formatGithubCodeResults(results), { query, resultCount: results.length });
      } catch (error) {
        return githubSearchFailure(error);
      }
    },
  });

  pi.registerTool({
    name: "github_search_issues",
    description: "Search GitHub issues. Find bugs, feature requests, discussions, and known problems in repositories.",
    promptGuidelines: [
      "Use github_search_issues to find known bugs, error reports, or feature requests.",
      "Use repo to search within a specific repository.",
      "Use state to filter open or closed issues.",
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
      limit: Type.Optional(Type.Number({ description: "Max results (default: 10, max: 100)", minimum: 1, maximum: 100 })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const query = params.query.trim();
      if (!query) return fail("GitHub issue search query cannot be empty");

      try {
        const args = ["search", "issues", query, "--type=issue"];
        if (params.repo) args.push("--repo", params.repo);
        if (params.owner) args.push("--owner", params.owner);
        if (params.state) args.push("--state", params.state);
        if (params.label) args.push("--label", params.label);
        if (params.sort) args.push("--sort", params.sort);
        args.push("--limit", String(clamp(params.limit ?? 10, 1, 100)));

        onUpdate?.({ content: [{ type: "text", text: `Searching GitHub issues: ${query}...` }] });

        const results = await runGh(args, "number,title,state,url,author,labels,createdAt,updatedAt,comments,body", signal) as GhIssueResult[];
        return ok(formatGithubIssueResults(results, "issues"), { query, resultCount: results.length });
      } catch (error) {
        return githubSearchFailure(error);
      }
    },
  });

  pi.registerTool({
    name: "github_search_prs",
    description: "Search GitHub pull requests. Find related PRs, implementations, and code changes across repositories.",
    promptGuidelines: [
      "Use github_search_prs to find related implementations or how others solved similar problems.",
      "Use state='merged' to find accepted solutions.",
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
      limit: Type.Optional(Type.Number({ description: "Max results (default: 10, max: 100)", minimum: 1, maximum: 100 })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const query = params.query.trim();
      if (!query) return fail("GitHub pull request search query cannot be empty");

      try {
        const args = ["search", "prs", query];
        if (params.repo) args.push("--repo", params.repo);
        if (params.owner) args.push("--owner", params.owner);
        if (params.state) args.push("--state", params.state);
        if (params.label) args.push("--label", params.label);
        if (params.sort) args.push("--sort", params.sort);
        args.push("--limit", String(clamp(params.limit ?? 10, 1, 100)));

        onUpdate?.({ content: [{ type: "text", text: `Searching GitHub PRs: ${query}...` }] });

        const results = await runGh(args, "number,title,state,url,author,labels,createdAt,updatedAt,comments,body", signal) as GhIssueResult[];
        return ok(formatGithubIssueResults(results, "pull requests"), { query, resultCount: results.length });
      } catch (error) {
        return githubSearchFailure(error);
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
      const fetchProviders: WebFetchProvider[] = ["jina", "native"];

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
        const fetchProvider = config.defaultFetchProvider ?? "jina";
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
        if (remainder !== "jina" && remainder !== "native") {
          throw new Error("Usage: /web_fetch provider <jina|native>");
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

      throw new Error("Usage: /web_fetch [status|provider <jina|native>|clear]");
    },
  });

  });
}
