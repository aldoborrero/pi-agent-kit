# Pi Agent Kit

A collection of skills and extensions for AI coding agents, compatible with [pi-coding-agent](https://github.com/badlogic/pi-mono) and related agent runtimes.

## Installation

```bash
# Install from git
pi install git:github.com/aldoborrero/pi-agent-kit

# Or from local clone
pi install ./pi-agent-kit

# Test a single extension
pi -e ./extensions/notify/notify.ts
```

## Repository Structure

```
pi-agent-kit/
├── agents/           # Agent definitions (6 agents)
├── extensions/       # TypeScript extensions (33 local + 3 npm)
├── prompts/          # Workflow templates (4 prompts)
├── skills/           # Markdown skills (portable across agent runtimes)
│   ├── ast-grep/     # AST-based structural code search
│   ├── kagi-search/  # Privacy-focused search
│   ├── pexpect-cli/  # Interactive CLI automation
│   ├── searxng-search/ # Self-hosted SearXNG search skill
│   └── superpowers/  # 13 advanced workflow skills
├── themes/           # Color themes (lavender)
└── packages/         # Nix packages (pexpect-cli, searxng-search)
```

## Pi Extensions

TypeScript extensions for [pi-coding-agent](https://github.com/badlogic/pi-mono). 33 local extensions + 3 external npm packages.

### Code Intelligence & Review

| Extension | Description |
|-----------|-------------|
| [`ast-grep`](extensions/ast-grep/README.md) | Structural code search using AST patterns with pattern, rule, and inspect modes |
| [`tuicr`](extensions/tuicr/tuicr.ts) | Interactive code review tool — agent launches tuicr, captures your review feedback |
| [`diff`](extensions/diff/diff.ts) | `/diff` command — interactive diff viewer (tuicr/delta/git) |
| [`codex`](extensions/codex/index.ts) | OpenAI Codex integration — `/codex review`, `/codex rescue`, adversarial reviews |
| [`pi-lsp-extension`](https://github.com/samfoy/pi-lsp-extension) | LSP integration — diagnostics, hover, go-to-definition, references, symbols, rename |

### Safety & Guardrails

| Extension | Description |
|-----------|-------------|
| [`sandbox`](extensions/sandbox/README.md) | OS-level sandboxing for bash — `/sandbox on/off` |
| [`permission-gate`](extensions/permission-gate/README.md) | Confirms before dangerous bash commands (rm -rf, git push --force, sudo, etc.) |
| [`git-checkpoint`](extensions/git-checkpoint/README.md) | Git stash checkpoints at each turn so `/fork` can restore code state |
| [`bitwarden`](extensions/bitwarden/README.md) | Secure vault access via rbw — `bw_get`/`bw_list` tools with password masking |

### Session & Context Management

| Extension | Description |
|-----------|-------------|
| [`context`](extensions/context/README.md) | `/context` TUI dashboard — token usage bar, loaded extensions/skills, session cost |
| [`handoff`](extensions/handoff/README.md) | `/handoff <goal>` — transfer context to a new focused session |
| [`btw`](extensions/btw/btw.ts) | `/btw <question>` — ephemeral side question (no tools, no context pollution) |
| [`recorder`](extensions/recorder/README.md) | Record all session activity to SQLite for performance tracking and analytics |

### Workflow & Automation

| Extension | Description |
|-----------|-------------|
| [`plan-mode`](extensions/plan-mode/README.md) | `/plan` — read-only exploration with subagent orchestration and plan file output |
| [`loop`](extensions/loop/README.md) | `/loop 5m <prompt>` — periodic polling and monitoring on a schedule |
| [`until`](extensions/until/README.md) | `/until tests` — repeat until condition met (TDD, iterative fixes) |
| [`subagent`](extensions/subagent/README.md) | Delegate tasks to specialized subagents with isolated context (single, parallel, chain) |
| [`pi-interactive-shell`](https://github.com/nicobailon/pi-interactive-shell) | Full PTY emulation for interactive CLIs — user can observe and take over anytime |

### Search & Web

| Extension | Description |
|-----------|-------------|
| `web-tools` | High-level `web_search` and `web_fetch` tools — preferred interface for web search, webpage fetching, and source gathering (Exa, Brave, SearXNG) |
| [`github-search`](extensions/github-search/README.md) | Search code, issues, and PRs on GitHub via `gh` CLI |
| [`exa-search`](extensions/exa-search/README.md) | Backend-specific Exa search integration used by higher-level web tooling |
| [`brave-search`](extensions/brave-search/README.md) | Backend-specific Brave search integration used by higher-level web tooling |
| [`jina`](extensions/jina/README.md) | Backend-specific webpage-to-markdown fetcher used by higher-level web tooling |

### Environment & Integration

| Extension | Description |
|-----------|-------------|
| [`direnv`](extensions/direnv/README.md) | Auto-load direnv environment variables — `/direnv` to reload on demand |
| [`walkie`](extensions/walkie/README.md) | Telegram bridge for mobile — bidirectional messaging, voice, photos, draft streaming |
| [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) | Token-efficient MCP (Model Context Protocol) adapter |

### Input & Voice

| Extension | Description |
|-----------|-------------|
| [`voice`](extensions/voice/README.md) | Toggle-to-record speech-to-text — Groq, OpenAI, or local Whisper daemon. `Ctrl+Alt+V` |
| [`inline-bash`](extensions/inline-bash/README.md) | Expand `!{command}` patterns in prompts |
| [`questionnaire`](extensions/questionnaire/README.md) | Structured multi-question UI with options and free-text input |

### UI & Commands

| Extension | Description |
|-----------|-------------|
| [`notify`](extensions/notify/README.md) | Desktop notifications when the agent finishes |
| [`footer`](extensions/footer/README.md) | Custom footer with git branch, context usage, and extension statuses |
| [`skill-namespaces`](extensions/skill-namespaces/skill-namespaces.ts) | `/superpowers:*` namespaced skill commands in autocomplete |
| [`exit`](extensions/exit/exit.ts) | `/exit` command — alias for `/quit` |
| [`git-commit-context`](extensions/git-commit-context/README.md) | `/commit` command with git status/log context injection |

## Skills

Markdown-based instructions that teach AI agents how to use external tools. Compatible with pi-coding-agent and other runtimes via the [Agent Skills](https://agentskills.io) standard.

### Tool Skills

| Skill | Description |
|-------|-------------|
| [`/ast-grep`](skills/ast-grep/SKILL.md) | Structural code search using AST patterns — find code by structure, not text |
| [`/pexpect-cli`](skills/pexpect-cli/SKILL.md) | Automate interactive CLI programs (SSH, databases, editors) with pexpect and pueue |
| [`/kagi-search`](skills/kagi-search/SKILL.md) | Privacy-focused web search via Kagi with Quick Answer support |
| [`/searxng-search`](skills/searxng-search/SKILL.md) | Query a self-hosted or public SearXNG instance with normalized, LLM-friendly output |

### Superpowers Skills

| Skill | Description |
|-------|-------------|
| [`/superpowers-brainstorming`](skills/superpowers/brainstorming/SKILL.md) | Explore intent, requirements, and design before implementation |
| [`/superpowers-writing-plans`](skills/superpowers/writing-plans/SKILL.md) | Create detailed implementation plans with bite-sized tasks |
| [`/superpowers-executing-plans`](skills/superpowers/executing-plans/SKILL.md) | Execute plans task-by-task with review checkpoints |
| [`/superpowers-subagent-driven-development`](skills/superpowers/subagent-driven-development/SKILL.md) | Execute plans by delegating independent tasks to subagents |
| [`/superpowers-dispatching-parallel-agents`](skills/superpowers/dispatching-parallel-agents/SKILL.md) | Run 2+ independent tasks in parallel without shared state |
| [`/superpowers-test-driven-development`](skills/superpowers/test-driven-development/SKILL.md) | Write tests before implementation code |
| [`/superpowers-systematic-debugging`](skills/superpowers/systematic-debugging/SKILL.md) | Structured debugging with root cause analysis |
| [`/superpowers-verification-before-completion`](skills/superpowers/verification-before-completion/SKILL.md) | Run verification commands before claiming work is complete |
| [`/superpowers-requesting-code-review`](skills/superpowers/requesting-code-review/SKILL.md) | Request formal code review before merging |
| [`/superpowers-receiving-code-review`](skills/superpowers/receiving-code-review/SKILL.md) | Process code review feedback with technical rigor |
| [`/superpowers-using-git-worktrees`](skills/superpowers/using-git-worktrees/SKILL.md) | Create isolated git worktrees for feature work |
| [`/superpowers-finishing-a-development-branch`](skills/superpowers/finishing-a-development-branch/SKILL.md) | Guide completion of development work (merge, PR, or cleanup) |
| [`/superpowers-writing-skills`](skills/superpowers/writing-skills/SKILL.md) | Create, edit, or verify skills before deployment |

## Agents

Agent definitions for pi-coding-agent. Each agent is a lean system prompt that loads skills at runtime.

| Agent | Description |
|-------|-------------|
| [`brainstormer`](agents/brainstormer.md) | Collaborative design dialogue — explores ideas before implementation |
| [`debugger`](agents/debugger.md) | Systematic debugging specialist with root cause analysis |
| [`planner`](agents/planner.md) | Creates bite-sized implementation plans from context and requirements |
| [`reviewer`](agents/reviewer.md) | Code review for quality, security, and maintainability |
| [`scout`](agents/scout.md) | Fast codebase reconnaissance that returns compressed context for handoff |
| [`worker`](agents/worker.md) | General-purpose implementation with TDD, verification, and debugging |

## Prompts

Workflow templates that orchestrate agents into chains via the subagent extension.

| Prompt | Description |
|--------|-------------|
| [`/brainstorm`](prompts/brainstorm.md) | Collaborative design dialogue |
| [`/debug`](prompts/debug.md) | Systematic debugging — scout gathers context, debugger investigates |
| [`/full-cycle`](prompts/full-cycle.md) | Full lifecycle — scout → planner → worker → reviewer → worker |
| [`/review`](prompts/review.md) | Standalone code review of recent changes or specified files |

## Packages

| Package | Description |
|---------|-------------|
| [`pexpect-cli`](packages/pexpect-cli/README.md) | Persistent pexpect sessions via pueue — server/client CLI for interactive automation |
| [`searxng-search`](packages/searxng-search/README.md) | CLI for querying SearXNG instances with normalized, LLM-friendly output |

## Development

```bash
nix develop               # Enter dev shell
nix fmt                   # Format code
nix build .#pexpect-cli   # Build pexpect-cli
nix build .#searxng-search # Build searxng-search
```

## License

[MIT](LICENSE)
