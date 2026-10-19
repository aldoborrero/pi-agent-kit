# until

Provides an `/until` command that keeps re-sending prompts until a breakout condition is met. Essential for TDD and iterative workflows.

## Commands

| Command | Description |
|---------|-------------|
| `/until` | Interactive preset selector |
| `/until tests` | Loop until tests pass |
| `/until custom <condition>` | Loop until custom condition |
| `/until self` | Agent decides when done |

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
- Maximum iteration cap (default 25) to guard against runaway loops; the loop stops and notifies the user if it reaches the cap without success
- Stops when a run ends with an error instead of retrying it up to the cap
- Interrupting a run (Esc) asks whether to break out of the loop or resume it; without a UI the loop ends
- Messages queued while the loop runs are handled before the next iteration
- Survives compaction (state lives in session entries and every iteration restates the condition)
- Survives session resume (persists state via custom entries)

## Configuration

| Environment variable | Default | Description |
|----------------------|---------|-------------|
| `PI_UNTIL_MAX_ITERATIONS` | `25` | Maximum number of loop iterations before the loop stops itself. |

## Attribution

Based on [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/loop.ts).
