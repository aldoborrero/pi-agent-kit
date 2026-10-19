# @aldoborrero/pi-codex

Use OpenAI Codex from pi to review code or delegate tasks.

## Usage

```
/codex <subcommand> [args]
```

### Subcommands

- `setup` — check Codex CLI readiness and auth
- `review` — run a native code review via Codex
- `adversarial-review` — adversarial review questioning design choices
- `rescue <task description>` — delegate a task to Codex
- `status` — show running and recent Codex jobs
- `result` — display output from a completed job
- `cancel` — cancel an active background job
