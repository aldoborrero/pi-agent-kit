import { BACKEND_NAMES, type SearchResult, type WebSearchBackend } from "../search-registry.ts";
import { filterByDomains, resolveApiKey, truncate } from "./utils.ts";

const PERPLEXITY_CHAT_URL = "https://api.perplexity.ai/chat/completions";

type PerplexityResponse = {
  citations?: string[];
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

export const perplexityBackend: WebSearchBackend = {
  name: BACKEND_NAMES.perplexity,
  label: "Perplexity",
  description: "Perplexity Sonar answer-oriented web research with citations.",
  requiresKey: true,
  async search(params) {
    const apiKey = resolveApiKey(params.backendConfig, ["PERPLEXITY_API_KEY", "SEARCH_PERPLEXITY_API_KEY"]);
    if (!apiKey) throw new Error("PERPLEXITY_API_KEY not set");

    const model = params.backendConfig?.model || (params.searchType === "deep" ? "sonar-pro" : "sonar");
    const response = await fetch(PERPLEXITY_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a web research assistant. Answer concisely and rely on current web sources." },
          { role: "user", content: params.query },
        ],
      }),
      signal: params.signal,
    });
    if (!response.ok) {
      throw new Error(`Perplexity error (${response.status}): ${await response.text()}`);
    }

    const data = (await response.json()) as PerplexityResponse;
    const answer = data.choices?.[0]?.message?.content?.trim() || "";
    const citations = data.citations ?? [];
    let results: SearchResult[] = citations.length > 0
      ? citations.map((url, index) => ({
        title: `Perplexity citation ${index + 1}`,
        url,
        snippet: answer ? truncate(answer.replace(/\s+/g, " "), 320).text : undefined,
      }))
      : [{
        title: "Perplexity answer",
        url: `https://www.perplexity.ai/search?q=${encodeURIComponent(params.query)}`,
        snippet: answer ? truncate(answer.replace(/\s+/g, " "), 320).text : undefined,
      }];
    results = filterByDomains(results, params.includeDomains, params.excludeDomains);
    return { provider: `${BACKEND_NAMES.perplexity}:${model}`, results: results.slice(0, params.numResults) };
  },
};
