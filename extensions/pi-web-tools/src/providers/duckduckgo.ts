import { BACKEND_NAMES, type SearchResult, type WebSearchBackend } from "../search-registry.ts";
import { filterByDomains, truncate } from "./utils.ts";

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapDuckDuckGoUrl(raw: string): string {
  const decoded = decodeHtml(raw);
  try {
    const url = new URL(decoded, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.toString();
  } catch {
    return decoded;
  }
}

function parseDuckDuckGoHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blockRegex = /<div[^>]+class="[^"]*result[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*result[^"]*"|<\/body>)/gi;
  for (const blockMatch of html.matchAll(blockRegex)) {
    const block = blockMatch[0];
    const linkMatch = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = unwrapDuckDuckGoUrl(linkMatch[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const snippetMatch = block.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      ?? block.match(/<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    results.push({
      title: decodeHtml(linkMatch[2]) || url,
      url,
      snippet: snippetMatch ? truncate(decodeHtml(snippetMatch[1]), 320).text : undefined,
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

export const duckduckgoBackend: WebSearchBackend = {
  name: BACKEND_NAMES.duckduckgo,
  label: "DuckDuckGo",
  description: "Zero-config general web search via DuckDuckGo's HTML results endpoint.",
  async search(params) {
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", params.query);

    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (compatible; pi-web-tools/1.0)",
      },
      signal: params.signal,
    });
    if (!response.ok) {
      throw new Error(`DuckDuckGo error (${response.status}): ${response.statusText}`);
    }

    let results = parseDuckDuckGoHtml(await response.text(), params.numResults);
    results = filterByDomains(results, params.includeDomains, params.excludeDomains);
    return { provider: BACKEND_NAMES.duckduckgo, results: results.slice(0, params.numResults) };
  },
};
