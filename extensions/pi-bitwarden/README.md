# Bitwarden Extension (via rbw)

Secure access to Bitwarden vault items through [rbw](https://github.com/doy/rbw), the unofficial Bitwarden CLI.

## Why rbw over bw?

| | rbw | bw (official) |
|---|---|---|
| **Session management** | Background agent (like ssh-agent) | Manual `BW_SESSION` env var |
| **Speed** | Milliseconds (in-memory cache) | 1-5 seconds per call |
| **Token exposure** | None - keys stay in rbw-agent | Token in env, visible to child processes |
| **Programmatic use** | Simple: `rbw get name` | Complex: unlock + token + `--session` |

## Requirements

- [rbw](https://github.com/doy/rbw) installed and in PATH
- Configured: `rbw config set email <your-email>`
- Registered: `rbw register` (once per device)
- Optionally unlocked: `rbw unlock` (or use `/bw unlock` in session)

## Security Model

1. **No tokens in process.env**: rbw-agent holds decryption keys in its own daemon process, never exposed to the extension or LLM.

2. **Passwords masked by default**: The `bw_get` tool returns usernames and URIs freely, but passwords, TOTP codes, and notes require explicit user confirmation via a UI prompt.

3. **Bash command blocking**: Direct `rbw get`/`rbw code` and `bw get`/`bw export` commands are blocked in the bash tool, forcing usage through the safe tools.

4. **Read-only access**: Only retrieval operations are exposed. No create/edit/delete.

5. **Agent-managed lifecycle**: rbw-agent handles lock timeout, key caching, and cleanup independently. No session state to leak on crash.

## Commands

- `/bw` - Show vault status (locked/unlocked)
- `/bw unlock` - Unlock vault (triggers rbw-agent's pinentry prompt)
- `/bw lock` - Lock vault immediately
- `/bw sync` - Sync vault with Bitwarden server

## Tools

### `bw_get`

Retrieve a specific field from a vault item.

Parameters:
- `name` (string, required): Item name or URI
- `folder` (string, optional): Folder name to disambiguate duplicate names
- `field` (string, optional): Field to retrieve. Default: `username`
  - `username` - login username (no confirmation needed)
  - `password` - login password (requires confirmation)
  - `totp` - TOTP code (requires confirmation)
  - `notes` - secure notes (requires confirmation)
  - Any custom field name (no confirmation for text fields)

### `bw_list`

List vault items with optional filtering.

Parameters:
- `search` (string, optional): Case-insensitive substring filter
- `folder` (string, optional): Filter by folder name

Returns item names and usernames only - no sensitive data.

## Usage

```bash
pi -e ./extensions/bitwarden/bitwarden.ts
```
