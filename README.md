# Pi Agent Kit

A collection of `pi-*` extensions for [Pi Coding Agent](https://github.com/badlogic/pi-mono).

## Installation

```bash
# From npm (once published)
pi install npm:@aldoborrero/pi-agent-kit

# From local clone
pi install ./pi-agent-kit
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
| [`pi-diff`](extensions/pi-diff) | Structured diff rendering |
| [`pi-tuicr`](extensions/pi-tuicr) | Interactive code review launcher |
| [`pi-github-search`](extensions/pi-github-search) | Search code, issues, and PRs on GitHub |

### Safety

| Extension | Description |
|-----------|-------------|
| [`pi-bitwarden`](extensions/pi-bitwarden) | Secure vault access via rbw — `bw_get`/`bw_list` with password masking |
| [`pi-sandbox`](extensions/pi-sandbox) | OS-level sandboxing for bash commands |
| [`pi-git-checkpoint`](extensions/pi-git-checkpoint) | Auto git stash at each turn for safe rollback |

### Session & Context

| Extension | Description |
|-----------|-------------|
| [`pi-context`](extensions/pi-context) | `/context` TUI — token usage, extensions, skills, session cost |
| [`pi-exit`](extensions/pi-exit) | `/exit` command |
| [`pi-suggest`](extensions/pi-suggest) | Next-prompt prediction — ghost text suggestions after each turn |

### Workflow & Automation

| Extension | Description |
|-----------|-------------|
| [`pi-subagent`](extensions/pi-subagent) | Delegate tasks to specialized subagents (single, parallel, chain) |
| [`pi-workflows`](extensions/pi-workflows) | Deterministic JS workflow orchestration engine |
| [`pi-loop`](extensions/pi-loop) | Periodic polling and monitoring on a schedule |
| [`pi-until`](extensions/pi-until) | Repeat until condition met |
| [`pi-questionnaire`](extensions/pi-questionnaire) | Structured multi-question UI with options |

### Search & Web

| Extension | Description |
|-----------|-------------|
| [`pi-web-tools`](extensions/pi-web-tools) | Web search and fetch tools |

### Environment & Integration

| Extension | Description |
|-----------|-------------|
| [`pi-direnv`](extensions/pi-direnv) | Auto-load direnv environment variables |
| [`pi-walkie`](extensions/pi-walkie) | Telegram bridge for mobile messaging |
| [`pi-codex`](extensions/pi-codex) | OpenAI Codex integration — review and rescue tasks |
| [`pi-notify`](extensions/pi-notify) | Desktop notifications when agent finishes |

### Input & Voice

| Extension | Description |
|-----------|-------------|
| [`pi-voice`](extensions/pi-voice) | Speech-to-text — Groq, OpenAI, or local Whisper |
| [`pi-inline-bash`](extensions/pi-inline-bash) | Expand `!{command}` patterns in prompts |
| [`pi-btw`](extensions/pi-btw) | Ephemeral side questions without tool access |

### UI

| Extension | Description |
|-----------|-------------|
| [`pi-footer`](extensions/pi-footer) | Custom footer with git branch, tokens, status |

### Utility

| Extension | Description |
|-----------|-------------|
| [`pi-common`](extensions/pi-common) | Shared `createUiColors` and color utilities |

## Development

```bash
bun install                  # Install workspace dependencies
bun test                     # Run tests
```

## License

[MIT](LICENSE)