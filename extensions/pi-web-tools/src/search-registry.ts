import { braveBackend } from "./providers/brave.ts";
import { exaBackend } from "./providers/exa.ts";
import { searxBackend } from "./providers/searx.ts";

export type WebSearchProvider = "auto" | "exa" | "brave" | "searx";
export type WebSearchBackendName = Exclude<WebSearchProvider, "auto">;

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
  signal?: AbortSignal;
};

export type WebSearchBackend = {
  name: WebSearchBackendName;
  label: string;
  description: string;
  search(params: WebSearchBackendParams): Promise<{ provider: string; results: SearchResult[] }>;
};

export function createWebSearchRegistry() {
  const backends = {
    exa: exaBackend,
    brave: braveBackend,
    searx: searxBackend,
  } satisfies Record<WebSearchBackendName, WebSearchBackend>;

  const order = Object.keys(backends) as WebSearchBackendName[];
  const providers = ["auto", ...order] as WebSearchProvider[];

  return {
    backends,
    order,
    providers,
    run(backend: WebSearchBackendName, params: WebSearchBackendParams) {
      return backends[backend].search(params);
    },
    summary() {
      return order.map((name) => {
        const backend = backends[name];
        return `- ${name}: ${backend.label} — ${backend.description}`;
      });
    },
  };
}
