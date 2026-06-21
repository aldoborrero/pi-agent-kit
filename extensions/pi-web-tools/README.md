# web-tools

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
/web_search provider exa
/web_search provider brave
/web_search provider searx
/web_search provider auto
/web_search clear
```

### `/web_fetch`

Configure the default fetch provider for the `web_fetch` tool on a per-project basis.

Examples:

```text
/web_fetch status
/web_fetch provider jina     # uses r.jina.ai (markdown conversion)
/web_fetch provider native   # direct fetch with HTML-to-text stripping
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
    "defaultProvider": "searx"
  }
}
```

If the tool call explicitly passes `provider`, that explicit value still wins.

## Tools

### `web_search`
Search the web with a unified interface.

#### Parameters
- `query` — search query
- `provider` — `auto` (default), `exa`, `brave`, or `searx`
- `include_domains` — optional allowlist of domains
- `exclude_domains` — optional denylist of domains
- `num_results` — optional result count
- `type` — optional Exa mode: `auto`, `neural`, `fast`, `deep`

#### Behavior
- Uses the explicitly passed `provider` when present
- Otherwise uses the project default from `.pi/settings.json` under `webTools.defaultProvider` if configured via `/web_search provider ...`
- Otherwise defaults to `auto`
- In `auto` mode: prefers Exa, falls back to Brave, then falls back to SearXNG
- Falls back to SearXNG if `SEARXNG_API_BASE` or `~/.config/searxng-search/config.json` is configured
- Normalizes output into a single structured result format
- Always includes a `Sources:` section

### `web_fetch`
Fetch a specific webpage and return content.

#### Parameters
- `url` — the URL to fetch
- `provider` — `jina` (default, converts to markdown via r.jina.ai), `native` (direct fetch with HTML-to-text stripping)
- `extract` — optional question or extraction request answered from the fetched page content
- `max_chars` — optional maximum size of returned raw markdown

#### Behavior
- Validates that the URL is public and uses `http` or `https`
- Rejects local/private/loopback hosts and embedded credentials
- **Jina provider**: fetches markdown via `r.jina.ai` (default)
- **Native provider**: fetches HTML directly and strips tags to plain text
- Uses project default from `.pi/settings.json` under `webTools.defaultFetchProvider` if configured via `/web_fetch provider ...`
- If `extract` is provided and a model is available, answers the extraction request from the fetched content
- Otherwise returns raw content, truncated if necessary

## Usage guidance

Prefer:
- `web_search` when you need to discover sources, documentation, articles, or recent information
- `web_fetch` when you already have an exact URL and want to read that page

Use backend-specific tools only when you explicitly need their provider-specific behavior.
