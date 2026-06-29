import { BACKEND_NAMES, type SearchResult, type WebSearchBackend } from "../search-registry.ts";
import { filterByDomains, resolveApiKey, truncate } from "./utils.ts";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

interface BraveResult {
  title?: string | null;
  url?: string | null;
  description?: string | null;
  age?: string | null;
  extra_snippets?: string[] | null;
}

interface BraveResponse {
  web?: {
    results?: BraveResult[];
  };
}

function buildBraveSnippet(result: BraveResult): string | undefined {
  const parts: string[] = [];
  if (result.description?.trim()) parts.push(result.description.trim());
  for (const snippet of result.extra_snippets ?? []) {
    const trimmed = snippet?.trim();
    if (trimmed && !parts.includes(trimmed)) parts.push(trimmed);
  }
  if (parts.length === 0) return undefined;
  return truncate(parts.join(" "), 320).text;
}

export const braveBackend: WebSearchBackend = {
  name: BACKEND_NAMES.brave,
  label: "Brave",
  description: "General web search using Brave Search API; good fallback for broad/current queries.",
  requiresKey: true,
  async search(params) {
    const apiKey = resolveApiKey(params.backendConfig, ["BRAVE_API_KEY", "SEARCH_BRAVE_API_KEY"]);
    if (!apiKey) {
      throw new Error("BRAVE_API_KEY not set");
    }

    const url = new URL(BRAVE_SEARCH_URL);
    url.searchParams.set("q", params.query);
    url.searchParams.set("count", String(params.numResults));
    url.searchParams.set("extra_snippets", "true");

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: params.signal,
    });

    if (!response.ok) {
      throw new Error(`Brave API error (${response.status}): ${await response.text()}`);
    }

    const data = (await response.json()) as BraveResponse;
    const results: SearchResult[] = (data.web?.results ?? [])
      .filter((result): result is BraveResult & { url: string } => typeof result.url === "string" && result.url.length > 0)
      .map((result) => ({
        title: result.title?.trim() || result.url,
        url: result.url,
        snippet: buildBraveSnippet(result),
        published: result.age ?? undefined,
      }));

    return {
      provider: BACKEND_NAMES.brave,
      results: filterByDomains(results, params.includeDomains, params.excludeDomains),
    };
  },
};
