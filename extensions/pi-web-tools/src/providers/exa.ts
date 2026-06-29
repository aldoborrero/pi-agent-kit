import type { SearchResult, WebSearchBackend } from "../search-registry.ts";
import { truncate } from "./utils.ts";

const EXA_API_URL = "https://api.exa.ai/search";

interface ExaResult {
  title?: string | null;
  url?: string | null;
  text?: string | null;
  highlights?: string[] | null;
  publishedDate?: string | null;
}

interface ExaResponse {
  resolvedSearchType?: string;
  results?: ExaResult[];
}

export const exaBackend: WebSearchBackend = {
  name: "exa",
  label: "Exa",
  description: "AI-native semantic search; best for documentation, research, and finding high-signal sources.",
  async search(params) {
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey) {
      throw new Error("EXA_API_KEY not set");
    }

    const response = await fetch(EXA_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        query: params.query,
        numResults: params.numResults,
        type: params.searchType,
        includeDomains: params.includeDomains,
        excludeDomains: params.excludeDomains,
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      throw new Error(`Exa API error (${response.status}): ${await response.text()}`);
    }

    const data = (await response.json()) as ExaResponse;
    const results: SearchResult[] = (data.results ?? [])
      .filter((result): result is ExaResult & { url: string } => typeof result.url === "string" && result.url.length > 0)
      .map((result) => ({
        title: result.title?.trim() || result.url,
        url: result.url,
        snippet: result.text?.trim()
          ? truncate(result.text.trim().replace(/\s+/g, " "), 320).text
          : (result.highlights?.length ? truncate(result.highlights.join(" ... "), 320).text : undefined),
        published: result.publishedDate ?? undefined,
      }));

    return {
      provider: data.resolvedSearchType ? `exa:${data.resolvedSearchType}` : "exa",
      results,
    };
  },
};
