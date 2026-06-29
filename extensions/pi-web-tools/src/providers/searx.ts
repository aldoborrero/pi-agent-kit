import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SearchResult, WebSearchBackend } from "../search-registry.ts";
import { dedupeByUrl, filterByDomains, truncate } from "./utils.ts";

const SEARXNG_CONFIG_PATH = join(homedir(), ".config", "searxng-search", "config.json");

interface SearxResult {
  title?: string | null;
  url?: string | null;
  link?: string | null;
  content?: string | null;
  snippet?: string | null;
  publishedDate?: string | null;
  published_date?: string | null;
}

interface SearxResponse {
  query?: string;
  results?: SearxResult[];
}

function normalizeSearxResult(result: SearxResult): SearchResult | null {
  const url = result.url?.trim() || result.link?.trim();
  if (!url) return null;

  const rawSnippet = result.content?.trim() || result.snippet?.trim() || undefined;
  return {
    title: result.title?.trim() || url,
    url,
    snippet: rawSnippet ? truncate(rawSnippet.replace(/\s+/g, " "), 320).text : undefined,
    published: result.publishedDate ?? result.published_date ?? undefined,
  };
}

async function resolveSearxApiBase(): Promise<string> {
  const envBase = process.env.SEARXNG_API_BASE?.trim();
  if (envBase) return envBase.replace(/\/+$/, "");

  try {
    const raw = await fs.readFile(SEARXNG_CONFIG_PATH, "utf8");
    const config = JSON.parse(raw) as { api_base?: string };
    const configBase = config.api_base?.trim();
    if (configBase) return configBase.replace(/\/+$/, "");
  } catch {
    // ignore missing/unreadable config and fall through to explicit error
  }

  throw new Error("SEARXNG_API_BASE not set and ~/.config/searxng-search/config.json is missing or invalid");
}

export const searxBackend: WebSearchBackend = {
  name: "searx",
  label: "SearXNG",
  description: "Self-hosted/privacy-oriented metasearch via a configured SearXNG instance.",
  async search(params) {
    const apiBase = await resolveSearxApiBase();
    const url = new URL(`${apiBase}/search`);
    url.searchParams.set("q", params.query);
    url.searchParams.set("format", "json");

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "web-tools/1.0 searx",
      },
      signal: params.signal,
    });

    if (!response.ok) {
      throw new Error(`SearXNG error (${response.status}): ${await response.text()}`);
    }

    const data = (await response.json()) as SearxResponse;
    let results = (data.results ?? [])
      .map(normalizeSearxResult)
      .filter((result): result is SearchResult => result !== null);

    results = dedupeByUrl(results);
    results = filterByDomains(results, params.includeDomains, params.excludeDomains);

    return { provider: "searx", results: results.slice(0, params.numResults) };
  },
};
