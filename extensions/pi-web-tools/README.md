# web-tools

> Legacy implementation: retained for reference, but no longer activated by
> `pi-agent-kit`. See [migration notes](../../docs/plugin-migration.md).

High-level web tools for pi-coding-agent.

This extension provides the preferred agent-facing interface for web access:

- `web_search` — search the web and return structured results with titles, URLs, and snippets
- `web_fetch` — fetch a specific webpage as markdown, with optional extraction from the fetched content

These tools are intended to replace direct agent use of backend-specific tools such as `exa_search`, `brave_search`, and `jina` in most cases.

## Commands

### `/web_search`

Configure the default provider for the `web_search` tool on a per-project basis.

Examples:

```text
/web_search status
/web_search provider auto
/web_search provider duckduckgo
/web_search provider exa
/web_search provider brave
/web_search provider searx
/web_search provider firecrawl
/web_search provider tavily
/web_search provider serper
/web_search provider perplexity
/web_search clear
```

### `/web_fetch`

Configure the default fetch provider for the `web_fetch` tool on a per-project basis.

Examples:

```text
/web_fetch status
/web_fetch provider jina       # uses r.jina.ai (markdown conversion, default)
/web_fetch provider native     # direct fetch with HTML-to-text stripping
/web_fetch provider firecrawl  # Firecrawl scrape API (API key optional)
/web_fetch provider exa        # Exa Contents API (requires EXA_API_KEY)
/web_fetch clear
```

Both commands write project-local config to:

```text
.pi/settings.json
```

under the key:

```json
{
  "webTools": {
    "defaultProvider": "auto"
  }
}
```

If the tool call explicitly passes `provider`, that explicit value still wins.

## Tools

### `web_search`
Search the web with a unified interface.

#### Parameters
- `query` — search query
- `provider` — `auto` (default) or one of the backends below
- `include_domains` — optional allowlist of domains
- `exclude_domains` — optional denylist of domains
- `num_results` — optional result count
- `type` — optional search mode: `auto`, `neural`, `fast`, `deep` (interpreted per backend; primarily used by Exa)

#### Backends

Registered in this order (also the `auto` fallback order):

| Backend | Keyless? | API key (config `apiKey` or env var) |
| --- | --- | --- |
| `duckduckgo` | yes (default) | — |
| `exa` | no | `EXA_API_KEY` / `SEARCH_EXA_API_KEY` |
| `brave` | no | `BRAVE_API_KEY` / `SEARCH_BRAVE_API_KEY` |
| `searx` | yes | `SEARXNG_API_BASE` or `~/.config/searxng-search/config.json` |
| `firecrawl` | optional | `FIRECRAWL_API_KEY` / `SEARCH_FIRECRAWL_API_KEY` (key optional) |
| `tavily` | no | `TAVILY_API_KEY` / `SEARCH_TAVILY_API_KEY` |
| `serper` | no | `SERPER_API_KEY` / `SEARCH_SERPER_API_KEY` |
| `perplexity` | no | `PERPLEXITY_API_KEY` / `SEARCH_PERPLEXITY_API_KEY` |

Keyed backends require their key (from the backend's config `apiKey` or one of the
env vars above) to run. Backends without a resolvable key are skipped in `auto` mode.

#### Behavior
- Uses the explicitly passed `provider` when present
- Otherwise uses the project default from `.pi/settings.json` under `webTools.defaultProvider` if configured via `/web_search provider ...`
- Otherwise defaults to `auto`
- In `auto` mode: tries backends in the registered order (DuckDuckGo → Exa → Brave → SearXNG → Firecrawl → Tavily → Serper → Perplexity), skipping any keyed backend without a resolvable key, and returns the first that succeeds. DuckDuckGo is the keyless default, so `auto` works with no configuration.
- If `webTools.backends` marks specific backends as `enabled`, only those are considered in `auto` (still subject to the credential check)
- Normalizes output into a single structured result format
- Always includes a `Sources:` section

### `web_fetch`
Fetch a specific webpage and return content.

#### Parameters
- `url` — the URL to fetch
- `provider` — one of `jina` (default), `native`, `firecrawl`, `exa`
- `extract` — optional question or extraction request answered from the fetched page content
- `max_chars` — optional maximum size of returned raw markdown

#### Behavior
- Validates that the URL is public and uses `http` or `https`
- Rejects local/private/loopback hosts and embedded credentials
- **Jina provider** (default): fetches markdown via `r.jina.ai`
- **Native provider**: fetches HTML directly and strips tags to plain text
- **Firecrawl provider**: scrapes via the Firecrawl API (`FIRECRAWL_API_KEY` optional)
- **Exa provider**: fetches page text via the Exa Contents API (requires `EXA_API_KEY`)
- Uses project default from `.pi/settings.json` under `webTools.defaultFetchProvider` if configured via `/web_fetch provider ...`
- If `extract` is provided and a model is available, answers the extraction request from the fetched content
- Otherwise returns raw content, truncated if necessary

## Usage guidance

Prefer:
- `web_search` when you need to discover sources, documentation, articles, or recent information
- `web_fetch` when you already have an exact URL and want to read that page

Use backend-specific tools only when you explicitly need their provider-specific behavior.
