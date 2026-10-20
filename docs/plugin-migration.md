# Question, web, notification, and side-conversation plugin migration

The aggregator activates these upstream packages instead of the local factories:

| Retired bundle member | Replacement (pinned) |
| --- | --- |
| `@aldoborrero/pi-questionnaire` | `@juicesharp/rpiv-ask-user-question@2.12.0` |
| `@aldoborrero/pi-web-tools` | `pi-web-access@0.35.0` |
| `@aldoborrero/pi-notify` | `@bacnh85/pi-notify@0.1.8` |
| `@aldoborrero/pi-btw` | `pi-btw@^0.8.0` (dbachelder) |

The legacy directories were removed from the workspace once the pinned replacements took over.
They were never imported or dependencies of the bundle. Do not also install the new
packages as standalone Pi extensions: the aggregator already registers them.
After `bun install`, restart Pi to replace the loaded tools and event handlers.

## Tools and commands

- `questionnaire` → `ask_user_question`. Supports up to four questions,
  multi-select, markdown previews and notes. Its parameter schema is different;
  update any explicit tool allowlists and instructions. The tool hides itself
  during non-interactive runs.
- `web_search` keeps its name, but uses upstream parameters (`numResults`,
  `domainFilter`, `queries`, etc.), not the old local schema.
- `web_fetch` → `fetch_content`. Additional tools include `source_check`,
  `get_search_content`, and `web_enable`.
- The old `/web_search` and `/web_fetch` configuration commands are gone.
  Upstream supplies `/websearch` and `/curator`.
- `/notify` is gone. Use `--no-notify` or the `notify` settings object.

## Web configuration

`webTools` settings are not read by the replacement. Configure `web-search.json`
using the upstream schema. Its location is, in precedence order:

1. `$PI_CODING_AGENT_DIR/web-search.json` when that variable is set.
2. With `XDG_CONFIG_HOME`: `$XDG_CONFIG_HOME/pi/web-search.json` (or the legacy
   `~/.pi/web-search.json` if only that file exists).
3. Otherwise `~/.pi/agent/web-search.json`, with fallback to an existing
   `~/.pi/web-search.json`.

Standard `EXA_API_KEY`, `BRAVE_API_KEY`, `TAVILY_API_KEY`, `SERPER_API_KEY`,
`PERPLEXITY_API_KEY` and `FIRECRAWL_API_KEY` environment variables are supported.
The old `SEARCH_*` aliases should be renamed to their standard counterparts.
`SEARXNG_API_BASE` becomes `SEARXNG_BASE_URL`, or `searxngBaseUrl` in the JSON file.
The old `~/.config/searxng-search/config.json` is not automatically imported.
Do not copy API secrets into the repository.

Example:

```json
{
  "searxngBaseUrl": "https://search.example.com",
  "workflow": "none"
}
```

The default `none` workflow avoids an extra summary-model call and curator UI.
Hosted third-party fetch fallbacks require explicit upstream opt-in; this
migration does not enable them, browser-cookie access, or weaken SSRF checks.

## Notifications on Linux / Nix

Install `libnotify` so `notify-send` is on Pi's PATH. For a declarative NixOS or
Home Manager configuration, add `pkgs.libnotify` to your packages; alternatively
use `nix profile add nixpkgs#libnotify` in your user profile.

Version 0.1.8's OSC fallback skips TTY stdout, so do not rely on it for an
interactive terminal when `notify-send` is missing. Native notifications require
a running desktop notification service and its session D-Bus environment.

Sounds default on upstream. To retain silent notifications (and avoid the
hardcoded `/usr/share/sounds` path on NixOS), merge this into Pi settings:

```json
{
  "notify": { "sound": false }
}
```

## Verification

Run `bun test extensions/pi-agent-kit/src/extension.test.ts` for a real SDK-loader
smoke test without model calls. It checks the new tools, absence of retired tools,
notification hooks, and registration idempotency. Use a fresh interactive Pi
session to verify the question dialog and native desktop delivery end-to-end.

## Side conversations (/btw)

The retired local overlay asked an ephemeral question without tool access.
The upstream replacement opens a **real sub-session in parallel** with full
coding-tool access, even while the main agent is busy:

- `/btw <question>` and the `/side` alias; bare `/btw` opens the prompt UI
- `/btw:new` starts a fresh thread, `/btw:tangent` drops inherited context,
  `/btw:ask` is a read-only thread (`read`/`grep`/`find`/`ls` only)
- `/btw:clear`, `/btw:model`, `/btw:thinking`, `/btw:inject`, and
  `/btw:summarize` manage the thread lifecycle and handoff

Do not install `pi-btw` standalone: the aggregator already registers it.
