import { braveBackend } from "./providers/brave.ts";
import { duckduckgoBackend } from "./providers/duckduckgo.ts";
import { exaBackend } from "./providers/exa.ts";
import { firecrawlBackend } from "./providers/firecrawl.ts";
import { perplexityBackend } from "./providers/perplexity.ts";
import { searxBackend } from "./providers/searx.ts";
import { serperBackend } from "./providers/serper.ts";
import { tavilyBackend } from "./providers/tavily.ts";

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

export type WebSearchProvider = "auto" | (typeof BACKEND_NAMES)[keyof typeof BACKEND_NAMES];
export type WebSearchBackendName = Exclude<WebSearchProvider, "auto">;

export type WebBackendConfig = {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  searchDepth?: string;
};

export type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
  published?: string;
};

export type WebSearchBackendParams = {
  query: string;
  numResults: number;
  searchType: "auto" | "neural" | "fast" | "deep";
  includeDomains?: string[];
  excludeDomains?: string[];
  backendConfig?: WebBackendConfig;
  signal?: AbortSignal;
};

export type WebSearchBackend = {
  name: WebSearchBackendName;
  label: string;
  description: string;
  requiresKey?: boolean;
  search(params: WebSearchBackendParams): Promise<{ provider: string; results: SearchResult[] }>;
};

export function createWebSearchRegistry() {
  const backends = {
    duckduckgo: duckduckgoBackend,
    exa: exaBackend,
    brave: braveBackend,
    searx: searxBackend,
    firecrawl: firecrawlBackend,
    tavily: tavilyBackend,
    serper: serperBackend,
    perplexity: perplexityBackend,
  } satisfies Record<WebSearchBackendName, WebSearchBackend>;

  const order = Object.keys(backends) as WebSearchBackendName[];
  const providers = ["auto", ...order] as WebSearchProvider[];

  return {
    backends,
    order,
    providers,
    enabledOrder(configuredBackends?: Record<string, WebBackendConfig | undefined>) {
      const enabled = order.filter((name) => configuredBackends?.[name]?.enabled === true);
      return enabled.length > 0 ? enabled : order;
    },
    run(backend: WebSearchBackendName, params: WebSearchBackendParams) {
      return backends[backend].search(params);
    },
    summary(configuredBackends?: Record<string, WebBackendConfig | undefined>) {
      return order.map((name) => {
        const backend = backends[name];
        const state = configuredBackends?.[name]?.enabled === true ? "enabled" : "available";
        return `- ${name}: ${backend.label} (${state}) — ${backend.description}`;
      });
    },
  };
}
