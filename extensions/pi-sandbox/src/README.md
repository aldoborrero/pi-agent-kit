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
