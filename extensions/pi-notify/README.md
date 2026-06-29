# notify

Sends a native terminal notification when the agent finishes or asks a question and is waiting for input.

## Supported terminals

- **OSC 777**: Ghostty, iTerm2, WezTerm, rxvt-unicode
- **OSC 99**: Kitty
- **Windows toast**: Windows Terminal (WSL)

The extension writes notifications to the controlling terminal where possible and includes tmux-aware delivery for inactive panes/windows.

## Notification content

Each notification contains:

| Part | Example | Description |
|------|---------|-------------|
| **Title** | `Pi · my-project` | "Pi" plus the current working directory name |
| **Body** | `Refactored auth module (42s · 3 turns · 2 files)` | First sentence of the last assistant message, with stats appended in parentheses |

When no assistant text is available the body falls back to the stats summary
(`42s · 3 turns · 2 files`) or `"Ready for input"` if the session produced no
measurable activity.

Question tool calls also send a short `Input required: ...` notification.

## Stats tracked

| Stat | Source |
|------|--------|
| Elapsed time | `agent_start` → `agent_end` |
| Turn count | `turn_start` events |
| Files changed | Successful `edit` / `write` tool calls |

## Configuration

### Disable at startup

Pass `--no-notify` when launching pi to start with notifications off:

```bash
pi --no-notify
```

### Toggle during a session

Use the `/notify` command to flip notifications on or off at any time.
The current state is shown in the footer (`notify:on` / `notify:off`).

## Events

| Event | Action |
|-------|--------|
| `session_start` | Read `--no-notify` flag and set initial state |
| `agent_start` | Reset stats counters |
| `turn_start` | Increment turn counter |
| `tool_result` | Count successful file edits/writes |
| `tool_call` | Notify immediately when the `question` tool requests input |
| `agent_end` | Send desktop notification (if enabled) |

## Attribution

Based on [pi-mono example extension](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/notify.ts).

Tmux delivery, cooldown, and sanitization improvements were inspired by [vanillagreencom/vstack pi-qol notifications](https://github.com/vanillagreencom/vstack/blob/main/pi-extensions/pi-qol/extensions/qol/notifications.ts), reimplemented for this standalone extension.
