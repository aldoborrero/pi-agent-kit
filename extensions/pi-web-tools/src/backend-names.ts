// Leaf module: the backend name constants live here (with no imports) so that
// provider modules can reference BACKEND_NAMES at module-init time without a
// circular dependency on search-registry.ts (which imports the providers).
export const BACKEND_NAMES = {
  duckduckgo: "duckduckgo",
  exa: "exa",
  brave: "brave",
  searx: "searx",
  firecrawl: "firecrawl",
  tavily: "tavily",
  serper: "serper",
  perplexity: "perplexity",
} as const;
