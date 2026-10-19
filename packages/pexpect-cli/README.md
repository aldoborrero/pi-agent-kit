# pexpect-cli

Python CLI tool for managing persistent [pexpect](https://pexpect.readthedocs.io/) sessions via [pueue](https://github.com/Nukesor/pueue). Provides a server/client architecture where sessions run as pueue tasks and can be interacted with through the CLI client.

## Components

| Script | Entry point | Description |
|--------|-------------|-------------|
| `pexpect-server` | `pexpect_cli.server:main` | Backend server managing pexpect sessions as pueue tasks |
| `pexpect-cli` | `pexpect_cli.client:main` | CLI client for creating, interacting with, and stopping sessions |

## Usage

```bash
# Start a new session
pexpect-cli --start [--name <label>]

# Execute code in a session (reads Python/pexpect code from stdin)
echo 'child = pexpect.spawn("ssh user@host")' | pexpect-cli <session_id>

# List active sessions
pexpect-cli --list

# Stop a session
pexpect-cli --stop <session_id>
```

## Installation

### Via Nix Flake

```bash
nix build .#pexpect-cli
nix profile install .#pexpect-cli
```

The Nix package automatically wraps the binaries with `pueue` in PATH.

## Security

`pexpect-server` executes arbitrary Python/pexpect code received over its
`AF_UNIX` socket, so anyone able to connect to that socket has full code
execution as the user running the server. This is intentional: the tool is
designed for a **single-user, single-trust-domain** environment.

Access control relies on filesystem permissions:

- The socket directory is created with mode `0700` (owner-only), under
  `$XDG_RUNTIME_DIR/pexpect-cli` (preferred) or
  `$XDG_CACHE_HOME/pexpect-cli/sockets`.
- Each socket file is set to mode `0600` (owner read/write only) after bind.

Do not point `XDG_RUNTIME_DIR`/`XDG_CACHE_HOME` at a shared or
world-accessible location, and do not run the server on a multi-user host
where other users could reach the socket.

## Requirements

- Python >= 3.13
- [pexpect](https://pexpect.readthedocs.io/) >= 4.9.0
- [pueue](https://github.com/Nukesor/pueue) daemon running (`pueued -d`)
