# searxng-search

CLI for querying SearXNG instances with normalized, LLM-friendly output.

## Features

- queries any SearXNG instance with JSON enabled
- configurable via `SEARXNG_API_BASE`, `--api-base`, or a config file
- human-readable terminal output by default
- `--json` mode for structured automation
- simple result deduplication by URL

## Usage

```bash
export SEARXNG_API_BASE="https://searx.orbiit.xyz"
searxng-search "brave search api key"
```

JSON mode:

```bash
searxng-search --json --limit 5 "rust async tutorial"
```

Read query from stdin:

```bash
echo "nix flake tutorial" | searxng-search --json
```

## Config file

Optional config at `~/.config/searxng-search/config.json`:

```json
{
  "api_base": "https://searx.orbiit.xyz",
  "timeout": 20,
  "headers": {
    "User-Agent": "searxng-search/0.1"
  }
}
```

Config `headers` are merged over the built-in request headers, so a `headers` entry
**overrides** the default of the same name (e.g. setting `User-Agent` here replaces the
default `searxng-search/0.1`). Other keys are added.

## Development

```bash
cd packages/searxng-search
python -m pytest
python -m searxng_search.cli --help
```
