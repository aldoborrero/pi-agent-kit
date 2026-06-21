# walkie

Bridges pi coding agent sessions to Telegram. Push agent responses to your phone; steer pi from anywhere.

## Features

| Direction | What happens |
|-----------|-------------|
| **pi → Telegram** | Agent response pushed after each run, with stats (turns, files changed, elapsed time) |
| **pi → Telegram** | Response is threaded as a reply to the message that triggered the run |
| **pi → Telegram** | Live draft preview via `sendMessageDraft` while agent is streaming |
| **pi → Telegram** | Typing indicator during tool-call phases (before first draft flush) |
| **Telegram → pi** | Text messages injected as user prompts (`followUp` when agent is busy) |
| **Telegram → pi** | Photos forwarded as image attachments |
| **Telegram → pi** | 👀 reaction on receipt, ✅ reaction on run completion |
| **Telegram → pi** | `/abort` sends a steer + calls `ctx.abort()` |

## Setup

### 1. Create a bot

Talk to [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, follow the prompts, and copy the token.

### 2. Pair your chat

```
/walkie setup
```

You will be prompted for your bot token. If a token is already saved, leave the input blank to keep it. Then **send any message to your bot on Telegram** — that chat is now paired, your user ID is recorded as the only allowed sender, and the bot command menu is registered automatically.

### 3. Test it

Ask pi to do something. The response will appear on your phone when the agent finishes.

## Commands (in pi)

| Command | Description |
|---------|-------------|
| `/walkie` | Toggle on/off |
| `/walkie setup` | Enter pairing mode (prompts for bot token) |
| `/walkie start` | Enable and start polling |
| `/walkie stop` | Disable and stop polling |
| `/walkie stream` | Toggle live draft streaming |
| `/walkie status` | Show current config and state |

## Commands (in Telegram, from your phone)

| Command | Description |
|---------|-------------|
| `/abort` | Stop the current agent run |
| `/status` | Show agent state, project, streaming mode |
| `/new` | Queue a new session start after the current run |
| *(any text)* | Injected as a user message into pi |
| *(any photo)* | Forwarded as an image attachment |

These commands are registered as a bot menu automatically on setup and on every pi session start, so they appear when you type `/` in the chat.

## Live Draft Streaming

Streaming is **enabled by default** — since Bot API 9.5, `sendMessageDraft` is available to all bots. Disable with `/walkie stream` if needed.

While the agent is generating a response, pi will send intermediate previews to Telegram as they arrive. The draft is ephemeral — a final permanent message replaces it when the agent finishes.

Streaming uses battle-tested throttling constants from [nullclaw](https://github.com/nullclaw/nullclaw)'s `telegram_draft_presenter.zig`:

| Constant | Value | Why |
|----------|-------|-----|
| Min delta before flush | 512 bytes | Avoid spamming tiny updates |
| Min flush interval | 4 seconds | Telegram rate limit safety |
| Heartbeat interval | 12 seconds | Keep draft alive during tool-call phases |
| Transport cap | 3000 bytes | Leave room for Telegram entity overhead |

When the draft buffer exceeds 3000 bytes, a **progress preview** is shown instead of truncating: elapsed time, total size, and the last N bytes of the buffer. On `429` rate-limit responses, flushes are suppressed for the `retry_after` duration. On `TEXTDRAFT_PEER_INVALID` responses (e.g. group chats), drafts are disabled for the rest of the run.

## Config (`settings.json`)

Global config is stored in `~/.pi/agent/settings.json` under `walkie`.
Project-local overrides are stored in `<cwd>/.pi/settings.json` under `walkie`.

Example global config:

```json
{
  "walkie": {
    "botToken": "123456:ABC-DEF...",
    "chatId": 987654321,
    "allowedUserId": 987654321,
    "enabled": true,
    "streaming": true
  }
}
```

Example project-local override:

```json
{
  "walkie": {
    "topicId": 123,
    "topicName": "pi-agent-kit"
  }
}
```

Config is written automatically by `/walkie setup`. You can also edit it manually.
Legacy compatibility is still kept for `~/.pi/walkie.json` and `<cwd>/.pi/walkie.json`.

## Security

- Only messages from `allowedUserId` are processed. All others are silently dropped.
- The bot token is stored in `~/.pi/agent/settings.json` under `walkie` (mode 600 recommended for the file).
- The polling loop only accepts `message` and `callback_query` update types.
- `/abort` sends a steering message and calls `ctx.abort()` — it cannot be triggered by any other Telegram user.

## Architecture

```
pi session
  │
  ├─ session_start  → register bot command menu, start polling, notify if fresh session
  │
  ├─ agent_start    → reset run counters, start typing keep-alive,
  │                   create DraftState + heartbeat timer (if streaming)
  │
  ├─ message_update → appendDraftChunk → sendMessageDraft (throttled)
  ├─ turn_start     → increment turn counter
  ├─ tool_result    → count file mutations (edit/write)
  │
  ├─ agent_end      → stop timers, send final message (threaded reply),
  │                   react ✅ on triggering message
  │
  └─ polling loop (background, AbortController-managed)
       └─ getUpdates(timeout=30) → handleUpdate
            ├─ text message → react 👀, inject via sendUserMessage
            │                 (immediate if idle, followUp if busy)
            └─ photo        → download via getFile, inject as image content
```

Inbound delivery:
- If agent is idle: `pi.sendUserMessage(text)` — immediate turn, message ID recorded for reply threading and ✅ reaction
- If agent is running: `pi.sendUserMessage(text, { deliverAs: "followUp" })` — queued after run, 👀 reaction only

## Attribution

Draft throttling logic ported from [nullclaw/telegram_draft_presenter.zig](https://github.com/nullclaw/nullclaw/blob/main/src/channels/telegram_draft_presenter.zig).
