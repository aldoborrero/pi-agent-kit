# loop

Provides a `/loop` command that keeps re-sending prompts until a breakout condition is met. Essential for TDD and iterative workflows.

## Commands

| Command | Description |
|---------|-------------|
| `/loop` | Interactive preset selector |
| `/loop tests` | Loop until tests pass |
| `/loop custom <condition>` | Loop until custom condition |
| `/loop self` | Agent decides when done |

## Tools

| Tool | Description |
|------|-------------|
| `signal_loop_success` | Called by the agent to break the loop |

## Presets

- **Until tests pass**: Runs all tests, loops until green
- **Until custom condition**: User-defined breakout condition
- **Self-driven**: Agent calls `signal_loop_success` when finished

## Features

- Status widget showing loop turn count and condition summary
- Survives compaction (preserves loop state in compaction instructions)
- Survives session resume (persists state via custom entries)
- Uses Haiku for summarizing breakout conditions in the status widget

## Attribution

Based on [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/loop.ts).
