# git-checkpoint

Creates git stash checkpoints at each turn so `/fork` can restore code state.

## How it works

- On `turn_start`: creates a `git stash create` snapshot before the LLM makes changes
- On `session_before_fork`: offers to restore code to that checkpoint
- On `agent_end`: clears all checkpoints

## Events

| Event | Action |
|-------|--------|
| `tool_result` | Tracks current entry ID |
| `turn_start` | Creates git stash checkpoint |
| `session_before_fork` | Offers to restore code state |
| `agent_end` | Clears checkpoints |

## Dependencies

- `git` installed and repository initialized

## Attribution

Based on [pi-mono example extension](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/git-checkpoint.ts).
