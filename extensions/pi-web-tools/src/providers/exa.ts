import { BACKEND_NAMES } from "../backend-names.ts";
import type { SearchResult, WebSearchBackend } from "../search-registry.ts";
import { describeHttpError, FETCH_TIMEOUT_MS, resolveApiKey, SEARCH_TIMEOUT_MS, truncate, withTimeout } from "./utils.ts";

const EXA_API_URL = "https://api.exa.ai/search";
const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
const EXA_ENV_KEYS = ["EXA_API_KEY", "SEARCH_EXA_API_KEY"];

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

export async function fetchExaContents(url: URL, signal?: AbortSignal): Promise<{ text: string; source: string }> {
  const apiKey = resolveApiKey(undefined, EXA_ENV_KEYS);
  if (!apiKey) throw new Error("EXA_API_KEY not set");

  const response = await fetch(EXA_CONTENTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ urls: [url.toString()], text: true }),
    signal: withTimeout(signal, FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(await describeHttpError("Exa contents error", response));
  }

  const data = (await response.json()) as { results?: Array<{ text?: string; title?: string; url?: string }> };
  const text = data.results?.[0]?.text ?? "";
  if (!text.trim()) throw new Error(`Exa contents returned no content for ${url.toString()}`);
  return { text, source: BACKEND_NAMES.exa };
}

export const exaBackend: WebSearchBackend = {
  name: BACKEND_NAMES.exa,
  label: "Exa",
  description: "AI-native semantic search; best for documentation, research, and finding high-signal sources.",
  requiresKey: true,
  envKeys: EXA_ENV_KEYS,
  async search(params) {
    const apiKey = resolveApiKey(params.backendConfig, EXA_ENV_KEYS);
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
      signal: withTimeout(params.signal, SEARCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(await describeHttpError("Exa API error", response));
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
      provider: data.resolvedSearchType ? `${BACKEND_NAMES.exa}:${data.resolvedSearchType}` : BACKEND_NAMES.exa,
      results,
    };
  },
};
