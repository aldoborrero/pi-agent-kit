import { BACKEND_NAMES, type SearchResult, type WebSearchBackend } from "../search-registry.ts";
import { filterByDomains, resolveApiKey, truncate } from "./utils.ts";

const FIRECRAWL_API_BASE = "https://api.firecrawl.dev/v2";

type FirecrawlSearchItem = {
  title?: string;
  url?: string;
  description?: string;
  markdown?: string;
};

type FirecrawlSearchResponse = {
  success?: boolean;
  data?: FirecrawlSearchItem[];
};

type FirecrawlScrapeResponse = {
  success?: boolean;
  data?: {
    markdown?: string;
    html?: string;
    metadata?: {
      title?: string;
      sourceURL?: string;
      url?: string;
    };
  };
};

function firecrawlHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

export async function fetchFirecrawl(url: URL, signal?: AbortSignal): Promise<{ text: string; source: string }> {
  const response = await fetch(`${FIRECRAWL_API_BASE}/scrape`, {
    method: "POST",
    headers: firecrawlHeaders(resolveApiKey(undefined, ["FIRECRAWL_API_KEY", "SEARCH_FIRECRAWL_API_KEY"])),
    body: JSON.stringify({ url: url.toString(), formats: ["markdown"] }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Firecrawl scrape error (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as FirecrawlScrapeResponse;
  const text = data.data?.markdown || data.data?.html || "";
  if (!text.trim()) throw new Error(`Firecrawl returned no content for ${url.toString()}`);
  return { text, source: "firecrawl" };
}

export const firecrawlBackend: WebSearchBackend = {
  name: BACKEND_NAMES.firecrawl,
  label: "Firecrawl",
  description: "Search plus crawl-oriented results from Firecrawl; API key optional where keyless mode is available.",
  async search(params) {
    const response = await fetch(`${FIRECRAWL_API_BASE}/search`, {
      method: "POST",
      headers: firecrawlHeaders(resolveApiKey(params.backendConfig, ["FIRECRAWL_API_KEY", "SEARCH_FIRECRAWL_API_KEY"])),
      body: JSON.stringify({ query: params.query, limit: params.numResults }),
      signal: params.signal,
    });
    if (!response.ok) {
      throw new Error(`Firecrawl search error (${response.status}): ${await response.text()}`);
    }
    const data = (await response.json()) as FirecrawlSearchResponse;
    let results: SearchResult[] = (data.data ?? [])
      .filter((item): item is FirecrawlSearchItem & { url: string } => typeof item.url === "string" && item.url.length > 0)
      .map((item) => ({
        title: item.title?.trim() || item.url,
        url: item.url,
        snippet: item.description?.trim()
          ? truncate(item.description.trim().replace(/\s+/g, " "), 320).text
          : item.markdown?.trim()
            ? truncate(item.markdown.trim().replace(/\s+/g, " "), 320).text
            : undefined,
      }));
    results = filterByDomains(results, params.includeDomains, params.excludeDomains);
    return { provider: "firecrawl", results: results.slice(0, params.numResults) };
  },
};
