# direnv

Loads [direnv](https://direnv.net) environment variables into the agent process automatically. Runs on session start, then watches `.envrc` and `.direnv/` for changes and reloads only when needed.

The bash tool spawns a new process per command (no persistent shell), so the working directory never changes between bash calls. Watching the filesystem is therefore both cheaper and more correct than re-running direnv after every command.

## Behavior

- **`session_start`**: Runs `direnv export json` and applies the resulting environment variables to `process.env`, then starts the file watchers.
- **File watching**: Uses `fs.watch` on `.envrc` and `.direnv/`. Any change schedules a reload after a short debounce (300 ms), so bursts of events (flake rebuilds, `direnv allow`, `nix develop`) trigger a single reload. Missing `.envrc` or `.direnv/` is fine — those watchers are simply skipped.
- **`session_shutdown`**: Closes the watchers and cancels any pending reload.

## `/direnv` Command

Manually re-runs `direnv export json` and reapplies the environment.

## Status Indicator

The status is hidden while everything is healthy (loaded, empty, or off). It only appears for problem states:

| Indicator     | Meaning                                                       |
|---------------|--------------------------------------------------------------|
| `󰒓 blocked`   | `.envrc` is not allowed — run `direnv allow` in your shell   |
| `󰒓 error`     | direnv failed to export (not installed, bad `.envrc`, etc.)  |

## Requirements

- [direnv](https://direnv.net) installed and in PATH
- `.envrc` must be allowed (`direnv allow`)
