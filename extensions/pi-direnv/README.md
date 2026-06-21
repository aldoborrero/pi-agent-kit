# direnv

Loads [direnv](https://direnv.net) environment variables into the agent process automatically. Runs on session start and after every `bash` tool call, mirroring how the direnv shell hook works -- picking up `.envrc` changes from `cd`, `git checkout`, `direnv allow`, etc.

## Behavior

- **`session_start`**: Runs `direnv export json` and applies the resulting environment variables to `process.env`.
- **`tool_result` (bash)**: Re-runs `direnv export json` after every bash command to detect directory or `.envrc` changes.

## Status Indicator

| Indicator | Meaning |
|-----------|---------|
| `direnv ✓` | Environment loaded successfully |
| `direnv ✗` | direnv not available or `.envrc` blocked/failed |

## Requirements

- [direnv](https://direnv.net) installed and in PATH
- `.envrc` must be allowed (`direnv allow`)
