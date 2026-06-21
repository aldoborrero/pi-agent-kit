# subagent

Delegate tasks to specialized subagents with isolated context windows. Each subagent runs as a separate `pi` process, preventing context pollution between tasks.

## Tool

**`subagent`** -- Delegate tasks to specialized agents.

## Modes

### Single

Run one agent on one task:
```json
{ "agent": "explore", "task": "Find all files related to authentication" }
```

### Parallel

Run multiple agents concurrently (max 8 tasks, 4 concurrent):
```json
{
  "tasks": [
    { "agent": "explore", "task": "Find API endpoint files" },
    { "agent": "explore", "task": "Find test files for auth" }
  ]
}
```

### Chain

Run agents sequentially, passing output from one to the next via `{previous}`:
```json
{
  "chain": [
    { "agent": "explore", "task": "Find the auth module structure" },
    { "agent": "plan", "task": "Create a plan to add OAuth based on: {previous}" },
    { "agent": "build", "task": "Implement the plan: {previous}" }
  ]
}
```

## Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent` | `string` | Agent name for single mode |
| `task` | `string` | Task description for single mode |
| `tasks` | `array` | Array of `{agent, task, cwd?}` for parallel mode |
| `chain` | `array` | Array of `{agent, task, cwd?}` for chain mode |
| `agentScope` | `"user" \| "project" \| "both"` | Which agent directories to search (default: `user`) |
| `confirmProjectAgents` | `boolean` | Prompt before running project-local agents (default: true) |
| `cwd` | `string` | Working directory for the agent process (single mode) |

## Agent Discovery

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

**Locations:**
- `~/.pi/agent/agents/*.md` -- User-level (always loaded)
- `.pi/agents/*.md` -- Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Structure

```
subagent/
├── README.md        # This file
├── index.ts         # Tool registration and execution logic
├── agents.ts        # Agent discovery and configuration
└── prompts.ts       # Prompt discovery and slash command registration
```

## Security Model

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## UI

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 10 items (tool calls and text output)
- Usage stats: turns, tokens, cost, context, model

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as markdown
- Per-task usage (for chain/parallel)

**Parallel streaming**:
- Live status per task (⏳ running, ✓ done, ✗ failed)
- "2/3 done, 1 running" summary

## Error Handling

- **Exit code != 0**: Returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: Ctrl+C kills subprocess
- **Chain mode**: Stops at first failing step

## Prompts as Slash Commands

Pi automatically registers markdown files from `prompts/` directories as slash commands.
The subagent extension adds a `/prompts` command to list what's available.

### Prompt File Format

```markdown
---
description: Fast codebase reconnaissance
---
Use the subagent tool to run the "explore" agent with the following task: $@
```

The `$@` placeholder is replaced with whatever the user types after the command.

### Example Commands

If you have `prompts/scout.md`:
```
/scout find authentication code
```

This executes the template with `$@` replaced by `"find authentication code"`.

### Pre-defined Prompts

| Command | Description |
|---------|-------------|
| `/scout <task>` | Fast codebase reconnaissance |
| `/brainstorm <topic>` | Collaborative design dialogue |
| `/debug <issue>` | Systematic debugging with scout → debugger chain |
| `/review <files>` | Standalone code review |
| `/full-cycle <feature>` | Complete workflow: scout → plan → implement → review |

## Limits

- Max parallel tasks: 8
- Max concurrency: 4
- Collapsed view: last 10 items (Ctrl+O to expand)
