# sandbox

OS-level sandboxing for bash commands using a sandbox runtime library. Enforces filesystem and network restrictions at the OS level (sandbox-exec on macOS, bubblewrap on Linux).

**Disabled by default.** Enable with `/sandbox on` or set `"sandbox.enabled": true` in settings.

## Commands

| Command | Description |
|---------|-------------|
| `/sandbox` | Show current status and configuration |
| `/sandbox on` | Enable sandboxing for this session |
| `/sandbox off` | Disable sandboxing for this session |

## Configuration

Configs are merged (project overrides global):
- `~/.pi/agent/settings.json` under `sandbox` (global)
- `<cwd>/.pi/settings.json` under `sandbox` (project-local)

```json
{
  "sandbox": {
    "enabled": true,
    "network": {
      "allowedDomains": ["github.com", "*.github.com", "registry.npmjs.org"],
      "deniedDomains": []
    },
    "filesystem": {
      "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
      "allowWrite": [".", "/tmp"],
      "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
    }
  }
}
```

Legacy compatibility is still kept for:
- `~/.pi/agent/sandbox.json`
- `<cwd>/.pi/sandbox.json`

Set `"sandbox.enabled": true` in settings to auto-enable on session start.

## Native shell backend (opt-in)

pi-sandbox owns the kit's bash tool and can run it on the embedded brush-core
shell (Rust, via `@aldoborrero/pi-natives`) instead of spawning a real bash per
call. One persistent session keeps shell state across tool calls; timeout,
abort, and errors quarantine it so the next call starts clean.

**Off by default** — brush is POSIX sh with partial bash dialect support, so
common bashisms may fail. Enable when you accept that:

```jsonc
// .pi/settings.json (project) or ~/.pi/agent/settings.json (global)
{ "nativeShell": { "enabled": true } }
```

or set `PI_SHELL_NATIVE=1` (env wins over settings). When sandboxing is active
it always wins — the native backend only serves unsandboxed runs. If the native
addon is unavailable the extension falls back to the standard local bash backend
with a session-start warning.

## Fail-closed behavior

Sandboxing is a security control, so it fails **closed**. Once sandboxing has been requested (config `enabled: true`, or `/sandbox on`) but the OS sandbox cannot be activated — for example initialization fails, or the platform is unsupported — bash is **blocked** rather than silently run unsandboxed:

- The `bash` tool returns an error result instead of executing.
- Interactive `!` bash returns the same error instead of executing.
- The footer status shows `error`, and a notification explains what happened.

This blocked state is **sticky** for the rest of the session. To explicitly opt into running unsandboxed bash, run `/sandbox off` (or restart with `--no-sandbox`). When sandboxing was never requested (disabled), bash runs normally with no blocking.

## Flags

| Flag | Description |
|------|-------------|
| `--no-sandbox` | Force disable sandboxing (overrides config) |

## Dependencies

- sandbox runtime dependency (included in package.json)
- Linux: `bubblewrap`, `socat`, `ripgrep`
- macOS: uses built-in sandbox-exec

## Attribution

Based on [pi-mono example extension](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/).
