# Agent Guidelines for pi-agent-kit

## Project Overview

pi-agent-kit is a toolkit for AI coding agents providing extensions, themes, and specialized agents for pi-coding-agent and related agent runtimes. It ships as a Bun workspace of 18 local `@aldoborrero/pi-*` packages. External packages provide workflows (`@quintinshaw/pi-dynamic-workflows`), subagents (`@bacnh85/pi-subagent`), rewind (`pi-rewind-hook`), structured questions (`@juicesharp/rpiv-ask-user-question`), web access (`pi-web-access`), notifications (`@bacnh85/pi-notify`), side conversations (`pi-btw`), tracing (`pi-phoenix`), and long-term memory (`@luxusai/pi-hindsight`).

## Directory Structure

```
agent-kit/
├── agents/           # Agent definitions (explore, plan, build, review, debug, brainstorm)
├── extensions/       # 18 TypeScript packages, each an @aldoborrero/pi-* workspace package
│   ├── pi-agent-kit/ # Aggregator — imports every member extension + pi-rewind-hook
│   ├── pi-common/    # Shared helpers (createUiColors, etc.) — no _shared/ dir exists
│   └── ...           # see "Extensions Quick Reference" below
├── prompts/          # Prompt templates (brainstorm, debug, explore, full-cycle, review)
├── themes/           # Provided by extensions/pi-themes/themes (lavender) + @xynogen/pix-themes
└── packages/         # Python packages with Nix build wrappers (pexpect-cli, searxng-search)
```

Root `package.json` lists three entries in `pi.extensions`: `extensions/pi-agent-kit` and the
extension entries shipped by `@bacnh85/pi-subagent`
(`node_modules/@bacnh85/pi-subagent/extensions/index.ts`) and `@quintinshaw/pi-dynamic-workflows`
(`node_modules/@quintinshaw/pi-dynamic-workflows/extensions/workflow.ts`). The aggregator
(`extensions/pi-agent-kit/src/extension.ts`) imports each active member extension's factory (including the external question, web, and notification factories) and
calls it against the same Pi host. The two external packages load from their own entries and
register their tools and commands themselves; the workflow engine's package exports do not
expose its entry for import at all, and root `pi.skills` exposes its two skills.

## Environment Variables

Copy `.envrc.local-template` to `.envrc.local` and fill in your values:

```bash
cp .envrc.local-template .envrc.local
direnv allow
```

| Variable | Extension | Description |
|----------|-----------|-------------|
| `GROQ_API_KEY` | pi-voice | Groq API key (STT via Whisper) |
| `OPENAI_API_KEY` | pi-voice | OpenAI Whisper for voice transcription |
| `VOICE_LANG` | pi-voice | Transcription language (default: `en`) |
| `VOICE_MODE` | pi-voice | Output mode: `paste` or `send` |
| `VOICE_DAEMON_URL` | pi-voice | Local Whisper daemon URL |
| `EXA_API_KEY` | pi-web-access | Exa search API key |
| `BRAVE_API_KEY` | pi-web-access | Brave search API key |
| `TAVILY_API_KEY` | pi-web-access | Tavily search API key |
| `SERPER_API_KEY` | pi-web-access | Serper search API key |
| `PERPLEXITY_API_KEY` | pi-web-access | Perplexity search API key |
| `FIRECRAWL_API_KEY` | pi-web-access | Firecrawl API key (search + fetch) |
| `SEARXNG_BASE_URL` | pi-web-access | Base URL for a SearXNG instance with JSON enabled |
| `PI_SUGGEST_MODEL` | pi-suggest | Override the next-prompt suggestion model |
| `PI_UNTIL_MAX_ITERATIONS` | pi-until | Cap iterations for the `/until` loop |
| `RBW_TIMEOUT_MS` / `RBW_UNLOCK_TIMEOUT_MS` | pi-bitwarden | rbw command / unlock timeouts |
| `PI_PHOENIX_ENABLE` | pi-phoenix | Opt-in tracing — off by default in this kit; `true` to enable |
| `PHOENIX_COLLECTOR_ENDPOINT` | pi-phoenix | Phoenix server URL (default `http://localhost:6006`) |
| `PHOENIX_API_KEY` | pi-phoenix | API key for Phoenix Cloud |
| `PI_PHOENIX_PROJECT` | pi-phoenix | Project name (defaults to repo/cwd basename) |
| `PI_HINDSIGHT_ENABLED` | pi-hindsight | Opt-in memory — off by default in this kit; `true` to enable |
| `HINDSIGHT_BASE_URL` | pi-hindsight | Hindsight server base URL |
| `HINDSIGHT_API_TOKEN` / `HINDSIGHT_API_KEY` | pi-hindsight | Hindsight API credentials |

## Extensions Quick Reference

### Commands

| Command | Extension | Description |
|---------|-----------|-------------|
| `/until <cond>` | pi-until | Repeat until a condition is met (e.g. `/until tests`, `/until custom <cond>`) |
| `/loop 5m <prompt>` | pi-loop | Schedule, list, or delete recurring prompts on a timer |
| `/suggest` | pi-suggest | Toggle/manage next-prompt suggestions |
| `/diff` | pi-diff | View uncommitted changes (tuicr/delta/git diff) |
| `/voice [config\|provider\|lang\|mode\|cancel\|status]` | pi-voice | Toggle recording or configure speech-to-text |
| `/bw`, `/rbw` | pi-bitwarden | Bitwarden vault management via rbw |
| `/sandbox [on\|off]` | pi-sandbox | Toggle OS-level bash sandboxing or show status |
| `/context` | pi-context | Show loaded context overview (tokens, extensions, cost) |
| `/btw <question>` | pi-btw | Parallel side conversation in a real sub-session with tool access (`/side` alias; `/btw:new`, `/btw:tangent`, `/btw:ask`, `/btw:clear`, `/btw:model`, `/btw:inject`, `/btw:summarize`) |
| `/codex [setup\|review\|adversarial-review\|rescue\|status\|result\|cancel]` | pi-codex | OpenAI Codex integration |
| `/exit` | pi-alias | Exit pi cleanly (alias for `/quit`) |
| `/clear` | pi-alias | Clear conversation and start fresh (alias for `/new`) |
| `/direnv` | pi-direnv | Reload direnv environment variables |
| `--no-notify` (CLI flag) | @bacnh85/pi-notify | Disable notifications; configure events/sound via the `notify` settings object (no `/notify` toggle) |
| `/subagent`, `/agent` | @bacnh85/pi-subagent | Configure model roles, list agents and inspect delegated runs |
| `/websearch <query>` | pi-web-access | Open the search curator |
| `/curator` | pi-web-access | Configure the search workflow |
| `/workflows`, `/workflows-models`, `/workflows-progress`, `/workflows-trigger` | pi-dynamic-workflows | Manage and inspect dynamic workflows |
| `/effort` | pi-dynamic-workflows | Set the effort level for workflows |
| `/ultracode`, `/deep-research`, `/adversarial-review`, `/code-review`, `/codebase-audit`, `/multi-perspective` | pi-dynamic-workflows | Built-in workflow commands |

### Tools (LLM-callable)

| Tool | Extension | Description |
|------|-----------|-------------|
| `web_search` | pi-web-access | Web search across configured providers; schema differs from the retired local tool |
| `fetch_content` | pi-web-access | Extract pages, PDFs, repositories, and videos |
| `ast_grep` | pi-natives | Structural code search via AST patterns — native pattern mode (Rust), CLI fallback for rule/inspect |
| `grep` | pi-natives | Content search via native ripgrep engine — replaces the JS built-in |
| `pdf` | pi-natives | Extract local PDFs as Markdown (native Rust, OCR page classification) |
| `subagent` | @bacnh85/pi-subagent | Delegate tasks to specialized agents (single, parallel, chain) |
| `ask_user_question` | @juicesharp/rpiv-ask-user-question | Structured questions with multi-select, previews, and notes |
| `tuicr` | pi-tuicr | Interactive code review with feedback capture |
| `edit` | pi-edit | Replaces the built-in edit tool (single, `multi` batch, and Codex-style patch modes) |
| `bw_get` / `bw_list` | pi-bitwarden | Secure vault access via rbw (passwords masked, require confirmation) |
| `hindsight_*` | pi-hindsight | Long-term memory tools (`hindsight_recall`, `hindsight_retain`, `hindsight_reflect`, `hindsight_status`, …) |
| `signal_loop_success` | pi-until | Signal that an `/until` loop's condition has been met |
| `bash` (sandboxed) | pi-sandbox | Re-registers the built-in bash tool wrapped in OS-level sandboxing when enabled |
| `workflow`, `workflow_control` | pi-dynamic-workflows | Run and control dynamic workflows (registered by `@quintinshaw/pi-dynamic-workflows`) |

### Background / Automatic

| Extension | Description |
|-----------|-------------|
| pi-direnv | Auto-load `.envrc` + `.direnv/` on change via fs.watch (not per-bash) |
| @bacnh85/pi-notify | Desktop notifications on completion, errors, and blocking questions |
| pi-suggest | Ghost-text next-prompt suggestions after each agent turn |
| pi-footer | Rich adaptive status bar (git branch, context usage, cost); registers a `footer-two-line` flag |
| pi-themes | Ships the `lavender` theme (`extensions/pi-themes/themes`) |
| pi-phoenix | OpenTelemetry tracing to Arize Phoenix — off by default (`PI_PHOENIX_ENABLE=true` to enable) |
| pi-hindsight | Hindsight-backed long-term memory — off by default (`PI_HINDSIGHT_ENABLED=true` to enable) |
| pi-common | Shared UI helpers (`createUiColors`, color utilities) consumed by other extensions |

### External (npm)

Question/web/notify migration and configuration: [plugin-migration.md](docs/plugin-migration.md).
The local `pi-questionnaire`, `pi-web-tools`, `pi-notify`, and `pi-btw` sources were removed from the
workspace when the upstream replacements were adopted; do not re-add them alongside those.

| Package | Description |
|---------|-------------|
| `@quintinshaw/pi-dynamic-workflows` | Deterministic workflow engine; registers the workflow tools and `/workflows`, `/effort`, and built-in workflow commands. Loaded from its own extension entry through root `pi.extensions`; its `workflow-authoring` and `workflow-patterns` skills through root `pi.skills` |
| `@bacnh85/pi-subagent` | In-process `subagent` tool (single, parallel, chain with `{previous}`) plus `/subagent` and `/agent`. Loaded from its own extension entry through root `pi.extensions`. The aggregator defaults `PI_SUBAGENT_HERDR` to `off` so delegation stays in-process inside herdr |
| `@juicesharp/rpiv-ask-user-question` | Structured questions; loaded through the aggregator |
| `pi-web-access` | Search and extraction; loaded through the aggregator |
| `pi-btw` | Parallel side conversations via `/btw` in a real sub-session; loaded through the aggregator |
| `pi-phoenix` | Phoenix tracing; loaded through the aggregator |
| `@luxusai/pi-hindsight` | Durable long-term memory; loaded through the aggregator |
| `@bacnh85/pi-notify` | Native notifications; loaded through the aggregator |
| `pi-rewind-hook` | File-state rewind points per prompt and assistant turn, restorable from `/fork` and `/tree`; loaded via the pi-agent-kit aggregator. Pinned to the upstream commit that binds each snapshot to its own prompt (nicobailon/pi-rewind-hook#19) until a release includes it |

## Key Conventions

### Shared Helpers (`@aldoborrero/pi-common`)

Shared UI helpers live in the `extensions/pi-common` workspace package — there is no
`extensions/_shared/` directory. Import them from `@aldoborrero/pi-common`:

| Export | Description |
|--------|-------------|
| `createUiColors(theme)` | Semantic color wrappers (primary, meta, warning, danger…). Prefer this over raw `theme.fg()`. |

### Pi Extensions (`extensions/`)

- Each extension is an `@aldoborrero/pi-*` workspace package that registers tools/commands with pi-coding-agent
- Use event hooks (`session_start`, `tool_result`, etc.) for side effects
- Each extension has its own directory with a `README.md` and `package.json`
- **If an extension directory has multiple `.ts` files** (including `.d.ts` shims), the `package.json` must point `pi.extensions` at the entry file. Without this, pi scans the directory and tries to load every `.ts` file as an extension.
- The `pi-agent-kit` aggregator imports every member extension's factory and invokes it against the same Pi host; the root `pi.extensions` lists `extensions/pi-agent-kit` plus the `@bacnh85/pi-subagent` and `@quintinshaw/pi-dynamic-workflows` entries.

### Agents (`agents/`)

- Lean markdown system prompts with YAML frontmatter (`name`, `description`, `tools`)
- Real agents: `explore`, `plan`, `build`, `review`, `debug`, `brainstorm`
- No agent pins a `model`: each one inherits the model of the session that delegates to it, so the definitions do not go stale. Override per agent in `~/.pi/agent/settings.json` under `subagent.agentModels` when one needs a different model
- Pi has no manifest key for agents. `@bacnh85/pi-subagent` and `@quintinshaw/pi-dynamic-workflows` read them from `~/.pi/agent/agents/` (user) or `.pi/agents/` (project), so link this directory there: `ln -s "$PWD/agents" ~/.pi/agent/agents`
- An explicit `tools:` list may only name tools that exist; an unknown name makes the delegation fail

### Prompts (`prompts/`)

- Prompt templates (`brainstorm`, `debug`, `explore`, `full-cycle`, `review`), loaded by Pi as slash commands through root `pi.prompts`; each one drives the `subagent` tool

## Development

### Nix Environment

```bash
nix develop   # Enter dev shell
nix fmt       # Format code
```

### Testing

```bash
bun test      # Run the workspace test suite (Bun's built-in runner discovers *.test.ts)
```

### Installing

```bash
pi install git:github.com/aldoborrero/agent-kit
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

### 9. Suggestion Model Configuration

pi-suggest generates next-prompt suggestions with a separate model. Override it with a cheaper/faster model:

```bash
PI_SUGGEST_MODEL=groq/openai/gpt-oss-20b  # fast + cheap
```

Or manage it interactively via `/suggest`.

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
11. **Prefer shared ui-colors** — import `createUiColors(theme)` from `@aldoborrero/pi-common` instead of raw `theme.fg()`
12. **Optional dependencies** — use dynamic import + fallback for optional integrations
