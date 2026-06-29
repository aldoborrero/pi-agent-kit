# Agent Guidelines for pi-agent-kit

## Project Overview

pi-agent-kit is a toolkit for AI coding agents providing skills, extensions, themes, and specialized agents for pi-coding-agent and related agent runtimes.

## Directory Structure

```
pi-agent-kit/
├── agents/           # Agent definitions (scout, planner, worker, reviewer, debugger, brainstormer)
├── extensions/       # TypeScript extensions (35 local + 4 external npm packages)
│   ├── _shared/      # Shared helpers (ui-colors, fancy-footer bridge)
│   └── ...
├── prompts/          # Workflow templates (brainstorm, debug, full-cycle, review)
├── skills/           # Markdown-based agent instructions
│   ├── ast-grep/     # AST-based structural code search
│   ├── kagi-search/  # Privacy-focused web search
│   ├── pexpect-cli/  # Interactive CLI automation
│   ├── searxng-search/ # Self-hosted SearXNG search skill
│   └── superpowers/  # 13 workflow skills (brainstorming, TDD, debugging, etc.)
├── themes/           # Color themes (lavender)
└── packages/         # Nix packages (pexpect-cli, searxng-search)
```

## Environment Variables

Copy `.envrc.local-template` to `.envrc.local` and fill in your values:

```bash
cp .envrc.local-template .envrc.local
direnv allow
```

| Variable | Extension | Description |
|----------|-----------|-------------|
| `GROQ_API_KEY` | groq-provider, voice | Groq API key (LPU inference + STT) |
| `OPENAI_API_KEY` | voice | OpenAI Whisper for voice transcription |
| `OPENROUTER_API_KEY` | openrouter-provider | OpenRouter API key |
| `TOGETHER_API_KEY` | together-provider | Together AI API key |
| `BRAVE_API_KEY` | brave-search, web-tools | Brave Search API key |
| `EXA_API_KEY` | exa-search, web-tools | Exa Search API key |
| `SEARXNG_API_BASE` | web-tools, searxng-search | Base URL for a SearXNG instance with JSON enabled |
| `PI_ORACLE_MODEL` | oracle | Override oracle suggestion model (e.g. `groq/openai/gpt-oss-20b`) |
| `VOICE_LANG` | voice | Transcription language (default: `en`) |
| `VOICE_MODE` | voice | Output mode: `paste` or `send` |
| `VOICE_DAEMON_URL` | voice | Local Whisper daemon URL |

## Extensions Quick Reference

### Commands

| Command | Extension | Description |
|---------|-----------|-------------|
| `/plan` | plan-mode | Read-only exploration → plan → tracked execution |
| `/until tests` | until | Repeat until condition met (TDD, iterative fixes) |
| `/loop 5m <prompt>` | loop | Periodic polling on a schedule (persistent across sessions) |
| `/oracle [on\|off\|model\|status]` | oracle | Toggle/configure next-prompt suggestions |
| `/diff` | diff | Interactive diff viewer (tuicr/delta/git) |
| `/voice [config\|provider\|lang\|mode]` | voice | Toggle-to-record speech-to-text (`Ctrl+Alt+V`) |
| `/telegram setup` | telegram | Telegram bridge for mobile use |
| `/bw [unlock\|lock\|sync\|status]` | bitwarden | Vault management via rbw |
| `/sandbox [on\|off]` | sandbox | Toggle OS-level bash sandboxing |
| `/commit` | git-commit-context | Commit with git status/log context |
| `/context` | context | Token usage dashboard |
| `/handoff <goal>` | handoff | Transfer context to new session |
| `/btw <question>` | btw | Ephemeral side question (no tools, no context pollution) |
| `/codex [setup\|review\|rescue\|status]` | codex | OpenAI Codex integration |
| `/exit` | exit | Alias for /quit |
| `/direnv` | direnv | Force reload direnv environment |
| `/notify` | notify | Toggle desktop notifications |
| `/fancy-footer` | pi-fancy-footer | Interactive footer config editor |
| `/superpowers:*` | skill-namespaces | Namespaced skill commands |

### Tools (LLM-callable)

| Tool | Extension | Description |
|------|-----------|-------------|
| `web_search` | web-tools | **Preferred** high-level web search (uses Exa, Brave, and SearXNG backends) |
| `web_fetch` | web-tools | **Preferred** high-level page fetcher with markdown output |
| `ast_grep` | ast-grep | Structural code search via AST patterns |
| `github_search_code` | web-tools | Search code on GitHub via gh CLI |
| `github_search_issues` | web-tools | Search GitHub issues via gh CLI |
| `github_search_prs` | web-tools | Search GitHub PRs via gh CLI |
| `subagent` | subagent | Delegate tasks to specialized agents (single, parallel, chain) |
| `questionnaire` | questionnaire | Ask structured multi-question UI with options |
| `tuicr` | tuicr | Interactive code review with feedback capture |
| `bw_get` / `bw_list` | bitwarden | Secure vault access via rbw (passwords masked, require confirmation) |
| `signal_loop_success` | until | Break out of an /until loop |
| `exa_search` | exa-search | Backend-specific Exa search (prefer `web_search`) |
| `brave_search` | brave-search | Backend-specific Brave search (prefer `web_search`) |
| `jina` | jina | Backend-specific Jina page fetch (prefer `web_fetch`) |

### Providers

| Provider | Extension | Models |
|----------|-----------|--------|
| Groq | groq-provider | GPT-OSS 120B/20B, Kimi K2, Qwen3 32B, Llama 4 Scout |
| OpenRouter | openrouter-provider | Kimi K2.5, Gemini 2.5 Pro, Grok 4, Devstral, ByteDance Seed |
| Together AI | together-provider | Llama, DeepSeek, Qwen, Kimi, GLM, Mistral |

### Background / Automatic

| Extension | Description |
|-----------|-------------|
| direnv | Auto-load `.envrc` + `.direnv/` on change via fs.watch (not per-bash) |
| git-checkpoint | Git stash per turn for `/fork` restore |
| notify | Desktop notification when agent finishes (OSC 777/99/Windows toast) |
| oracle | Ghost-text next-prompt suggestions after each agent turn |
| inline-bash | Expand `!{command}` patterns in prompts |
| recorder | Session analytics to SQLite (turns, tool calls, costs) |
| permission-gate | Confirm before dangerous bash commands (rm -rf, force-push, sudo) |
| footer | Git branch, context usage, cost in footer (falls back if pi-fancy-footer absent) |
| pi-fancy-footer | Rich two-row footer with widgets, git diff, PR, context bar |
| lsp-guidelines | Steer agent toward LSP tools |
| skill-namespaces | Register `/superpowers:*` commands |

### External (npm)

| Package | Description |
|---------|-------------|
| pi-fancy-footer | Rich footer with git info, context bar, extension widgets |
| pi-lsp-extension | LSP integration (diagnostics, hover, definition, references) |
| pi-mcp-adapter | MCP server bridge |
| pi-interactive-shell | Full PTY emulation |

## Key Conventions

### Shared Helpers (`extensions/_shared/`)

| File | Description |
|------|-------------|
| `ui-colors.ts` | `createUiColors(theme)` — semantic color wrappers (primary, meta, warning, danger…). Always use this instead of raw `theme.fg()`. |
| `fancy-footer.ts` | Optional pi-fancy-footer bridge. `registerFancyFooterWidget(pi, widgetFn)` returns `true` if pi-fancy-footer is active. Extensions fall back to `ctx.ui.setStatus()` when it returns `false`. |
| `pi-fancy-footer-shim.d.ts` | Type declarations for `pi-fancy-footer/api` (dynamic import, no hard dependency). |

### pi-fancy-footer Integration

Extensions that show status support an optional pi-fancy-footer widget. The pattern:

```typescript
const fancyFooterReady = registerFancyFooterWidget(pi, () => ({
  id: "pi-agent-kit.myext",
  label: "My Extension",
  description: "...",
  defaults: { row: 1, position: 10, align: "right", fill: "none" },
  visible: () => someCondition(),
  renderText: () => "myext:state",
})).then((active) => { fancyFooterActive = active; return active; });

// In session_start:
await fancyFooterReady;

// In updateStatus:
if (fancyFooterActive) {
  ctx.ui.setStatus("myext", undefined);  // clear local status
  void refreshFancyFooter(pi);           // trigger footer re-render
  return;
}
ctx.ui.setStatus("myext", colors.warning("myext:on"));  // fallback
```

**Widget visibility policy**: only show widget when state is noteworthy. Don't show `myext:on` if "on" is the expected default.

### Skills (`skills/`)

- Each skill has a `SKILL.md` with frontmatter `name` that MUST match the parent directory name
- Skills under `superpowers/` get `/superpowers:*` namespace commands via skill-namespaces extension
- Compatible with pi-coding-agent and related agent runtimes

### Pi Extensions (`extensions/`)

- TypeScript files that register tools with pi-coding-agent
- Use event hooks (`session_start`, `tool_result`, etc.) for side effects
- Prefer high-level web tools (`web_search`, `web_fetch`) over backend-specific tools (`exa_search`, `brave_search`, `jina`)
- Each extension has its own directory with a `README.md`
- Extensions with npm dependencies have their own `package.json`
- **If an extension directory has multiple `.ts` files** (including `.d.ts` shims), add a `package.json` with `pi.extensions` pointing to the entry file. Without this, pi scans the directory and tries to load every `.ts` file as an extension.
- npm package extensions are referenced as `node_modules/<pkg>` in `package.json`

### Agents (`agents/`)

- Lean markdown system prompts that load skills at runtime
- Scout (haiku) for fast exploration, Planner (opus) for design

### Prompts (`prompts/`)

- Workflow templates that orchestrate agent chains via subagent extension

## Development

### Nix Environment

```bash
nix develop   # Enter dev shell
nix fmt       # Format code
```

### Testing Extensions

```bash
pi -e ./extensions/example/example.ts
```

### Installing

```bash
pi install git:github.com/aldoborrero/pi-agent-kit
```

---

## Pi Extension Development

### Tool Execute Signature

**CRITICAL**: The correct parameter order for tool execute functions is:

```typescript
async execute(toolCallId, params, signal, onUpdate, ctx) {
  // toolCallId: string — unique ID for this tool call
  // params: object — parsed parameters from the LLM
  // signal: AbortSignal — for cancellation
  // onUpdate: function — for streaming progress updates
  // ctx: ExtensionContext — session context (cwd, ui, etc.)
}
```

### Using ctx.cwd

Always use `ctx.cwd` from the event context, never `process.cwd()`:

```typescript
pi.on("session_start", async (_event, ctx) => {
  const projectDir = ctx.cwd;  // correct
});
```

If you need `cwd` outside of an event handler, capture it from `session_start` into a module-level variable.

### Extension pi.extensions Resolution

Entries in `pi.extensions` are resolved as **relative paths from the package root**:

```json
{
  "pi": {
    "extensions": [
      "extensions/my-ext",
      "node_modules/pi-lsp-extension"
    ]
  }
}
```

### Event Lifecycle

```
session_start
    │
user sends prompt
    ├─► input (can intercept/transform)
    ├─► before_agent_start (can inject message, modify systemPrompt)
    ├─► agent_start
    │   ┌─── turn loop ───┐
    │   ├─► turn_start    │
    │   ├─► context       │ (can modify messages)
    │   │   LLM responds  │
    │   │   ├─► tool_call │ (can block)
    │   │   └─► tool_result (can modify)
    │   └─► turn_end      │
    │   └──────────────────┘
    └─► agent_end

/new or /resume  → session_before_switch → session_switch
/fork            → session_before_fork → session_fork
/compact         → session_before_compact → session_compact
/tree            → session_before_tree → session_tree
/model or Ctrl+P → model_select
exit             → session_shutdown
```

---

## Key Learnings

### 1. The Bash Tool Is NOT a Persistent Shell

Each bash tool call spawns a **new shell process** (`spawn(shell, [...args, command])`). `cd` inside a bash command has no effect on subsequent bash calls — the next call always starts from `ctx.cwd`.

Implication: don't hook `tool_result` to react to cwd changes. Use `fs.watch` instead.

```typescript
// Wrong — cwd never actually changes between calls
pi.on("tool_result", async (event, ctx) => {
  if (event.toolName !== "bash") return;
  reloadSomething(ctx.cwd, ctx);  // runs N times per session for nothing
});

// Right — react to actual file/directory changes
fs.watch(join(cwd, ".envrc"), () => scheduleReload());
```

### 2. Prefer Simple Solutions Over Tool Replacement

Hook into events instead of replacing tools. Replacing built-in tools (edit, bash, grep) bypasses pi's safeguards: file mutation queue, fuzzy matching, BOM handling, line ending normalization, multiple occurrence detection.

### 3. Multi-file Extensions Need a package.json

When an extension directory contains more than the entry `.ts` file (e.g. `node-shim.d.ts`, helper files), add a `package.json` with `pi.extensions`:

```json
{ "pi": { "extensions": ["./myext.ts"] } }
```

Without this, pi will try to load every `.ts` file (including `.d.ts`) as an extension and fail.

### 4. Status Indicators

Use `name:state` format. Clear status for expected/normal state — only show for noteworthy states:

```typescript
ctx.ui.setStatus("myext", colors.warning("myext:warn"));  // noteworthy
ctx.ui.setStatus("myext", undefined);                      // normal = clear
```

### 5. Guiding Tool Selection

Use `promptSnippet` and `promptGuidelines` to steer the LLM:

```typescript
pi.registerTool({
  name: "my_tool",
  promptSnippet: "Short summary for tool listing",
  promptGuidelines: ["Use my_tool when X", "Use grep instead when Y"],
});
```

### 6. Message Injection in before_agent_start

Prefer injecting a message over replacing the system prompt:

```typescript
pi.on("before_agent_start", async (_event, _ctx) => {
  return { message: { content: "Extra context...", display: false } };
  // Not: return { systemPrompt: "..." }  ← replaces, doesn't append
});
```

### 7. Async Over Sync for Subprocess Calls

Never use `execSync` in hot paths (event handlers called frequently). Use `exec` (async) to avoid blocking the Node.js event loop:

```typescript
// Wrong — blocks event loop on every call
const output = execSync("direnv export json", { cwd });

// Right — non-blocking
exec("direnv export json", { cwd }, (error, stdout) => { ... });
```

### 8. Clean Up on Shutdown

Kill child processes, clear intervals, close file watchers:

```typescript
pi.on("session_shutdown", async () => {
  for (const w of watchers) w.close();
  if (timer) clearInterval(timer);
});
```

### 9. Oracle Model Configuration

Oracle uses a separate agent session for suggestion generation. To use a cheaper/faster model:

```bash
PI_ORACLE_MODEL=groq/openai/gpt-oss-20b  # fast + cheap
PI_ORACLE_MODEL=groq/qwen/qwen3-32b       # better quality
```

Or via `/oracle model` (interactive TUI selector) or `<cwd>/.pi/oracle.json`.

### 10. Telegram Extension Architecture

pi-telegram bridges pi to Telegram. Pi owns session state — the bridge just shuttles messages. Don't duplicate pi's session management in the bridge. Use `MessageQueue` for messages arriving while agent is busy.

---

## Design Principles

1. **Think about the actual goal** — don't fixate on wrapping/intercepting
2. **Use `ctx.cwd` for paths** — never `process.cwd()`
3. **Use events for side effects** — `session_start` for init, `fs.watch` for file reactions
4. **Only replace tools when necessary** — safeguards are lost
5. **Inject messages, don't replace systemPrompt** — append via `before_agent_start` message
6. **Use `context` for message manipulation** — filter, prune, augment before LLM calls
7. **Clean up on shutdown** — kill child processes, clear intervals, close connections
8. **Correct execute signature** — `(toolCallId, params, signal, onUpdate, ctx)`
9. **Pi owns state, extensions bridge** — don't duplicate session management
10. **Async over sync** — never block the event loop in hot paths
11. **Prefer shared ui-colors** — use `createUiColors(theme)` instead of raw `theme.fg()`
12. **Optional dependencies** — use dynamic import + fallback for optional integrations (see fancy-footer bridge)
