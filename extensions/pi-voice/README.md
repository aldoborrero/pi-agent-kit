# voice

Walkie-talkie style speech-to-text input for pi-coding-agent. Hold Space to record, release to transcribe when the terminal supports key-release events; otherwise use `/voice` to toggle. Multiple STT backends, configurable language, and project context hints for coding vocabulary recognition.

## Hold-Space-to-Record

The custom voice editor uses a **walkie-talkie** interaction model:

1. **Tap Space** — inserts a normal space character (no delay, normal typing).
2. **Hold Space** (past ~1.2s) — recording starts, and a `● REC` indicator appears in the editor border.
3. **Recording stays active while Space is held down.**
4. **Release Space** — stops recording and transcribes.
5. The transcribed text is inserted at the cursor position for review.
6. **Escape** during recording — cancels without transcribing.

The space character is **not** inserted on press — it's only inserted on release if the hold threshold was not reached. This avoids the insert-then-delete pattern that can lose a space if recording fails to start. A quick tap feels like normal typing.

**Typing cooldown:** if the user typed any non-space key within the last 400ms, Space is treated as normal input, not a hold candidate. This prevents accidental recording during fast typing.

**Kitty keyboard protocol required for Hold Space.** Without it, all input passes through untouched so normal typing never breaks — hold-to-talk is unavailable, but `/voice` still toggles recording.

## Commands

| Command | Description |
|---------|-------------|
| `/voice` | Toggle recording (start/stop) |
| `/voice config` | Open interactive settings panel (provider, language, mode) |
| `/voice cancel` | Cancel recording without transcribing |
| `/voice provider <auto\|groq\|openai\|daemon>` | Switch STT provider |
| `/voice lang <code>` | Set transcription language (default: `en`) |
| `/voice mode <paste\|send>` | Set output mode (`paste` = editor, `send` = auto-submit) |
| `/voice status` | Show current configuration |

All subcommands support tab completion — type `/voice ` and press Tab.

## STT Providers

| Provider | Env var | Latency | Cost |
|----------|---------|---------|------|
| Groq Whisper | `GROQ_API_KEY` | ~0.5s | $0.02/hr |
| OpenAI Whisper | `OPENAI_API_KEY` | ~2-5s | $0.006/min |
| Local daemon | `VOICE_DAEMON_URL` | Near-instant | Free |

Auto-detects based on which env var is set. Priority: daemon > Groq > OpenAI.

### Local daemon setup

Any HTTP daemon compatible with:
- `POST /record/start` — begin recording
- `POST /record/stop` — stop and return `{ "text": "transcription" }`
- `GET /health` — health check

Example: [nvrxq/claude-code-voice](https://github.com/nvrxq/claude-code-voice) (faster-whisper daemon).

## Configuration

Settings are persisted to `~/.pi/agent/settings.json` under the `voice` key and restored on every session start. Changes made via `/voice config` or the inline subcommands are saved automatically.

Example:

```json
{
  "voice": {
    "provider": "groq",
    "lang": "en",
    "mode": "paste"
  }
}
```

Persisted config takes priority over env vars.

| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_API_KEY` | — | Groq Whisper API key |
| `OPENAI_API_KEY` | — | OpenAI Whisper API key |
| `VOICE_DAEMON_URL` | `http://localhost:8765` | Local whisper daemon URL |
| `VOICE_LANG` | `en` | Transcription language (env var fallback) |
| `VOICE_MODE` | `paste` | Output mode (env var fallback) |

## System Dependencies

**Linux:** `arecord` (from `alsa-utils`), `sox`/`rec`, or `ffmpeg`
**macOS:** `sox`/`rec` or `ffmpeg`

Not needed when using the daemon provider (daemon handles audio capture).

## Footer

| State | Display |
|-------|---------|
| Idle | `voice:groq` (provider shown quietly in status bar) |
| Recording (with level) | `● REC ▁▃▅▇` |
| Recording (daemon) | `● REC` |
| Transcribing | `● transcribing…` |
| Error | `● <message>` (clears after 3s) |

## Features

- **Walkie-talkie recording** — hold Space to record, release to transcribe when key-release events are available
- **Toggle recording** — `/voice` works even when Hold Space is unavailable
- **Deferred space insertion** — space is not inserted on press; only on release if it was a tap, never if it was a hold
- **Typing cooldown** — Space after recent typing is normal input, not a hold candidate
- **Kitty-only safety gate for Hold Space** — without Kitty keyboard protocol, all Space input passes through untouched
- **Persistent config** — provider, language, and mode saved to `~/.pi/agent/settings.json` under `voice`
- **Interactive settings** — `/voice config` opens a navigable settings panel
- **Tab completion** — `/voice [tab]` shows available subcommands
- Auto-stop on 2 seconds of silence
- Max recording duration: 60 seconds
- Project context hints (package name + git branch) improve coding term recognition
- Zero npm dependencies
