import { BACKEND_NAMES, type SearchResult, type WebSearchBackend } from "../search-registry.ts";
import { filterByDomains, resolveApiKey, truncate } from "./utils.ts";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string;
  published_date?: string;
};

type TavilyResponse = {
  results?: TavilyResult[];
};

export const tavilyBackend: WebSearchBackend = {
  name: BACKEND_NAMES.tavily,
  label: "Tavily",
  description: "Agent-oriented structured web search with concise content snippets.",
  requiresKey: true,
  async search(params) {
    const apiKey = resolveApiKey(params.backendConfig, ["TAVILY_API_KEY", "SEARCH_TAVILY_API_KEY"]);
    if (!apiKey) throw new Error("TAVILY_API_KEY not set");

    const response = await fetch(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: params.query,
        max_results: params.numResults,
        search_depth: params.searchType === "deep" ? "advanced" : "basic",
        include_raw_content: false,
      }),
      signal: params.signal,
    });
    if (!response.ok) {
      throw new Error(`Tavily error (${response.status}): ${await response.text()}`);
    }

    const data = (await response.json()) as TavilyResponse;
    let results: SearchResult[] = (data.results ?? [])
      .filter((item): item is TavilyResult & { url: string } => typeof item.url === "string" && item.url.length > 0)
      .map((item) => ({
        title: item.title?.trim() || item.url,
        url: item.url,
        snippet: item.content?.trim()
          ? truncate(item.content.trim().replace(/\s+/g, " "), 320).text
          : item.raw_content?.trim()
            ? truncate(item.raw_content.trim().replace(/\s+/g, " "), 320).text
            : undefined,
        published: item.published_date,
      }));
    results = filterByDomains(results, params.includeDomains, params.excludeDomains);
    return { provider: "tavily", results: results.slice(0, params.numResults) };
  },
};
