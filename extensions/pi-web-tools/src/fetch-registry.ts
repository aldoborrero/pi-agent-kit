import { fetchExaContents } from "./providers/exa.ts";
import { fetchJina, fetchNative } from "./providers/fetch.ts";
import { fetchFirecrawl } from "./providers/firecrawl.ts";

export const FETCH_PROVIDER_NAMES = ["jina", "native", "firecrawl", "exa"] as const;
export type WebFetchProvider = (typeof FETCH_PROVIDER_NAMES)[number];
export const FETCH_PROVIDERS = [...FETCH_PROVIDER_NAMES] as string[];

type FetchFn = (url: URL, signal?: AbortSignal) => Promise<{ text: string; source: string }>;

const FETCH_FUNCTIONS: Record<WebFetchProvider, FetchFn> = {
  jina: fetchJina,
  native: fetchNative,
  firecrawl: fetchFirecrawl,
  exa: fetchExaContents,
};

export function fetchWithProvider(
  url: URL,
  provider: WebFetchProvider,
  signal?: AbortSignal,
): Promise<{ text: string; source: string }> {
  return FETCH_FUNCTIONS[provider](url, signal);
}
