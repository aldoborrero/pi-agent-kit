# @aldoborrero/pi-btw

Ephemeral side questions that don't pollute context.

Like Claude Code's `/btw` command — ask a quick question without tool access, get an answer in a bottom overlay, and keep the main conversation clean.

## Usage

```text
/btw What's the capital of France?
```

Run `/btw` with no arguments to open the dedicated BTW prompt UI.

The answer appears in a bottom overlay instead of the main conversation. The extension calls the current model directly with no tools, using a read-only snapshot of the current conversation plus prior `/btw` turns from this session for follow-up context.

## Keys

| Key | Action |
|---|---|
| `↑` / `↓` | Scroll overlay content |
| `x` | Clear in-memory `/btw` history for this session |
| `Enter` / `q` | Close after an answer/error |
| `Esc` / `Ctrl-C` | Dismiss; cancels if still pending |

The exchange is not appended to the main conversation history or future context.

## Attribution

Overlay behavior inspired by [`@juicesharp/rpiv-btw`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-btw) (MIT).
