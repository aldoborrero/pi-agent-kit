# context

TUI dashboard showing what's loaded and how context is being used.

## Commands

| Command | Description |
|---------|-------------|
| `/context` | Show context overview |

## What it shows

- **Context window**: token usage bar (system prompt, tools, conversation, free)
- **System prompt**: estimated tokens including AGENTS.md
- **Tools**: estimated token cost of active tool definitions
- **Extensions**: loaded extension files
- **Skills**: available skills with loaded/unloaded status (green = loaded)
- **Session totals**: cumulative tokens and cost

## Attribution

Based on [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/context.ts).
