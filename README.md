# Pi Agent Kit

A collection of `pi-*` extensions for [Pi Coding Agent](https://github.com/badlogic/pi-mono).

## Installation

```bash
# From npm (once published)
pi install npm:@aldoborrero/pi-agent-kit

# From local clone
pi install ./agent-kit
```

## Extensions

All extensions follow the same structure:
- `src/extension.ts` — entry point
- `package.json` with `@aldoborrero/pi-{name}` naming and peer dependencies
- `README.md` with usage docs

### Bundle

| Package | Description |
|---------|-------------|
| [`pi-agent-kit`](extensions/pi-agent-kit) | Meta-package — installs all pi-* extensions below |

### Code Intelligence

| Extension | Description |
|-----------|-------------|
| [`pi-ast-grep`](extensions/pi-ast-grep) | Structural code search using AST patterns |
| [`pi-edit`](extensions/pi-edit) | Enhanced `edit` tool — single, batch (`multi`), and Codex-style patch modes |
| [`pi-diff`](extensions/pi-diff) | Structured diff rendering |
| [`pi-tuicr`](extensions/pi-tuicr) | Interactive code review launcher |

### Safety

| Extension | Description |
|-----------|-------------|
| [`pi-bitwarden`](extensions/pi-bitwarden) | Secure vault access via rbw — `bw_get`/`bw_list` with password masking |
| [`pi-sandbox`](extensions/pi-sandbox) | OS-level sandboxing for bash commands |
| [`pi-rewind-hook`](https://github.com/nicobailon/pi-rewind-hook) | External — file-state rewind points, restorable from `/fork` and `/tree` |

### Session & Context

| Extension | Description |
|-----------|-------------|
| [`pi-context`](extensions/pi-context) | `/context` TUI — token usage, extensions, skills, session cost |
| [`pi-alias`](extensions/pi-alias) | `/exit` (alias for `/quit`) and `/clear` (alias for `/new`) commands |
| [`pi-suggest`](extensions/pi-suggest) | Next-prompt prediction — ghost text suggestions after each turn |
| [`pi-btw`](https://github.com/dbachelder/pi-btw) | External — parallel `/btw` side conversations in a real sub-session with tool access |
| [`@luxusai/pi-hindsight`](https://www.npmjs.com/package/@luxusai/pi-hindsight) | External — durable Hindsight-backed long-term memory (`hindsight_*` tools) |

### Workflow & Automation

| Extension | Description |
|-----------|-------------|
| [`@bacnh85/pi-subagent`](https://www.npmjs.com/package/@bacnh85/pi-subagent) | External — delegate tasks to specialized subagents (single, parallel, chain) |
| [`pi-loop`](extensions/pi-loop) | Schedule, list, or delete recurring prompts on a timer |
| [`pi-until`](extensions/pi-until) | Repeat until a condition is met |
| [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) | External — structured questions with multi-select, previews, and notes |

Deterministic workflow orchestration is provided by the external
[`@quintinshaw/pi-dynamic-workflows`](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows)
package, loaded from its own extension entry through the root `pi.extensions` manifest.

### Search & Web

| Extension | Description |
|-----------|-------------|
| [`pi-web-access`](https://github.com/nicobailon/pi-web-access) | External — web search, page/PDF extraction, repository and video access |

### Environment & Integration

| Extension | Description |
|-----------|-------------|
| [`pi-direnv`](extensions/pi-direnv) | Auto-load direnv environment variables |
| [`pi-codex`](extensions/pi-codex) | OpenAI Codex integration — review and rescue tasks |
| [`@bacnh85/pi-notify`](https://github.com/bacnh85/pi-extensions/tree/main/pi-notify) | External — desktop notifications for completion, errors, and questions |
| [`pi-phoenix`](https://github.com/philipbjorge/pi-phoenix) | External — OpenTelemetry tracing to Arize Phoenix |

> This kit disables pi-phoenix tracing and pi-hindsight memory by default. Opt in with `PI_PHOENIX_ENABLE=true` and `PI_HINDSIGHT_ENABLED=true`.

### Input & Voice

| Extension | Description |
|-----------|-------------|
| [`pi-voice`](extensions/pi-voice) | Speech-to-text — Groq, OpenAI, or local Whisper |

### UI

| Extension | Description |
|-----------|-------------|
| [`pi-footer`](extensions/pi-footer) | Custom footer with git branch, tokens, status |
| [`pi-themes`](extensions/pi-themes) | Ships the `lavender` theme |

### Utility

| Extension | Description |
|-----------|-------------|
| [`pi-common`](extensions/pi-common) | Shared `createUiColors` and color utilities |

## External plugin migration

Questionnaires, web access, and notifications are now provided by pinned external
packages, activated by the aggregator. Do not install a second copy alongside it.
The old `pi-questionnaire`, `pi-web-tools`, and `pi-notify` sources have been removed
from the repository; only the pinned external packages remain.

See [migration notes](docs/plugin-migration.md) for renamed tools, configuration,
and Linux/Nix notification requirements. Restart Pi after updating dependencies.

## Development

```bash
bun install                  # Install workspace dependencies
bun test                     # Run tests
```

## Publishing

Monorepo publishing is idempotent and package-version based:

```bash
bun run publish:dry          # Show packages whose name@version is not on npm
bun run publish:all          # Publish unpublished workspace package versions
```

The GitHub workflow keeps the Nix shell and runs on `release-YYYYMMDD-HHMM` tags.

## License

[MIT](LICENSE)