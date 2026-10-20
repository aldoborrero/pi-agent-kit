# context

TUI dashboard showing what's loaded and how context is being used.

## Commands

| Command | Description |
|---------|-------------|
| `/context` | Show context overview |

## What it shows

- **Context window**: token usage bar (system prompt, tools, conversation, free)
- **System prompt**: token count of Pi's current effective system prompt
- **Context files**: files actually present in Pi's current system-prompt options
- **Tools**: token cost of active tool definitions
- **Extensions**: extension command/tool source labels visible through Pi's extension API
- **Skills**: skills from Pi's current system-prompt options, with read skill files highlighted
- **Session totals**: cumulative current Pi usage fields (`input`, `output`, `cacheRead`, `cacheWrite`, cost)

## Token counting

Counts use the native tokenizer from `@oh-my-pi/pi-natives` (Rust, O200k base)
when the addon is available — exact, not estimated. Without it, `pi-context`
falls back to the classic `length / 4` heuristic.

## Notes

`/context` uses Pi's runtime context instead of rediscovering files itself, so it follows current Pi behavior for `AGENTS.override.md`, packaged resources, trust decisions, and explicit system-prompt options.

## Attribution

Based on [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/context.ts).
