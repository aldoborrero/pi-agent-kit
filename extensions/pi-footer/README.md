# @aldoborrero/pi-footer

Custom footer renderer for the Pi TUI. Renders a rich, adaptive status bar at the bottom of the terminal.

## Usage

Automatically registered — no commands needed. The footer renders at the bottom of the terminal.

## What it shows

- **Workspace**: current working directory (home-relativized, shortened to fit) and, when inside a git repo, the branch name with a `*` dirty marker. The branch name is shown whole when there is room and shortened in the middle otherwise.
- **Git markers**: staged (`+`), unstaged (`✗`), untracked (`?`), ahead (`⇡`), and behind (`⇣`) counts. Read with `git --no-optional-locks` so the background refresh never holds `index.lock` against the agent's own git commands.
- **Context usage**: token count and/or percent of the model's context window, colored by pressure. Shown as `?` while Pi cannot know it, such as right after a compaction.
- **Session tokens**: input/output plus cache read/write, shown briefly after each turn and then fading out.
- **Cost**: accumulated session cost in USD. Tokens and cost are counted like Pi's own footer: the whole session, including aborted responses, tool-result usage, and the model calls made for compaction and branch summaries.
- **Auto-compaction**: `(auto)` after the context usage while Pi compacts on its own.
- **Cache hit rate**: `CH58%` next to the session tokens — the share of the latest prompt served from the provider's cache.
- **Subscription marker**: `(sub)` after the cost when the active provider bills a subscription, where the figure is only nominal.
- **Model**: normalized model id and the active thinking level, prefixed with `(provider)` when more than one provider is available. For a virtual model, `→` and the physical model that answered last.
- **Live tokens/sec**: streaming throughput while the assistant is generating.
- **Extension statuses**: status entries published by other extensions.

## Adaptive density

The footer measures the terminal width and steps through `wide`, `full`, `comfortable`, `compact`, and `minimal` layouts, dropping the least important segments (session name, cost, session tokens, git markers, branch) as space runs out.

The auto-compaction marker and the provider prefix only appear in the `wide` layout (140 columns or more), so on narrower terminals they do not push out the branch name or the git markers.

Extension statuses are never dropped: they sit on the first line when they fit next to the workspace, and move to a second line when they do not. A status is only cut (`+N`) when the statuses are wider than the whole terminal. The choice assumes the session tokens and live rate are showing, so the footer keeps its height while a turn streams and after it ends.

## Flags

- `--footer-two-line` — always put statuses on the second line, even when they would fit on the first. Off by default.

## Configuration

Custom footer items can be defined in `.pi/settings.json` (project) or `~/.pi/agent/settings.json` (global), under either a `footer` or `piFooter` key. Custom items pull their text from an extension status key and render on the left or right side.

```json
{
  "footer": {
    "customItems": [
      {
        "id": "deploy",
        "statusKey": "deploy-status",
        "position": "right",
        "prefix": "deploy",
        "color": "success",
        "hideWhenMissing": true,
        "excludeFromStatuses": true
      }
    ]
  }
}
```

`customItems` may be an array (as above) or an object keyed by `id`. Per-item fields:

- **`id`** — unique identifier (letters, digits, `_`, `-`).
- **`statusKey`** — extension status key to read text from (defaults to `id`).
- **`position`** — `"left"` or `"right"` (default `"left"`).
- **`prefix`** — optional label shown before the value.
- **`color`** — a named footer color (`primary`, `meta`, `success`, `warning`, `danger`, `subtle`, `text`, `model`) or a theme color.
- **`hideWhenMissing`** — hide the item when its status key has no value (default `true`).
- **`excludeFromStatuses`** — keep the item's status key out of the regular status list so it isn't shown twice (default `true`).
