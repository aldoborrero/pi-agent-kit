import { BACKEND_NAMES, type SearchResult, type WebSearchBackend } from "../search-registry.ts";
import { filterByDomains, resolveApiKey, truncate } from "./utils.ts";

const SERPER_SEARCH_URL = "https://google.serper.dev/search";

type SerperOrganicResult = {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
};

type SerperResponse = {
  organic?: SerperOrganicResult[];
};

export const serperBackend: WebSearchBackend = {
  name: BACKEND_NAMES.serper,
  label: "Serper",
  description: "Google-style SERP results via Serper.dev.",
  requiresKey: true,
  async search(params) {
    const apiKey = resolveApiKey(params.backendConfig, ["SERPER_API_KEY", "SEARCH_SERPER_API_KEY"]);
    if (!apiKey) throw new Error("SERPER_API_KEY not set");

    const response = await fetch(SERPER_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({ q: params.query, num: params.numResults }),
      signal: params.signal,
    });
    if (!response.ok) {
      throw new Error(`Serper error (${response.status}): ${await response.text()}`);
    }

    const data = (await response.json()) as SerperResponse;
    let results: SearchResult[] = (data.organic ?? [])
      .filter((item): item is SerperOrganicResult & { link: string } => typeof item.link === "string" && item.link.length > 0)
      .map((item) => ({
        title: item.title?.trim() || item.link,
        url: item.link,
        snippet: item.snippet?.trim() ? truncate(item.snippet.trim().replace(/\s+/g, " "), 320).text : undefined,
        published: item.date,
      }));
    results = filterByDomains(results, params.includeDomains, params.excludeDomains);
    return { provider: "serper", results: results.slice(0, params.numResults) };
  },
};
