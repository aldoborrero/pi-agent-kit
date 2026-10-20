# pi-natives

Rust-accelerated tools for [Pi](https://github.com/badlogic/pi-mono), powered by
[`@oh-my-pi/pi-natives`](https://github.com/can1357/oh-my-pi) (MIT) — the N-API
native core from the oh-my-pi fork.

## Tools

| Tool | Backend | Description |
|------|---------|-------------|
| `grep` | Native ripgrep engine (Rust) | Content search with `.gitignore` respect, glob/type filters, output modes (`content`, `filesWithMatches`, `count`), and context lines. Replaces the JS built-in |
| `ast_grep` | Native pattern mode + CLI fallback | Structural code search. Pattern mode runs in-process (Rust); `rule` (YAML composite rules) and `inspect` (AST dump) modes use the `ast-grep` CLI, preserving the full contract of the retired `pi-ast-grep` extension |
| `pdf` | Native (Rust) | Extract PDF text as Markdown, with per-page OCR-needs classification |

## Graceful degradation

- Native addon missing (unsupported platform)? `grep` falls back to a simple
  JS implementation, `ast_grep` falls back entirely to the CLI, and the `pdf`
  tool is not registered.
- The `rule`/`inspect` modes require the
  [ast-grep CLI](https://ast-grep.github.io) regardless of native availability.

## Install

Included in [`@aldoborrero/pi-agent-kit`](../pi-agent-kit) — one install gets
everything:

```bash
pi install git:github.com/aldoborrero/agent-kit
```

Or standalone:

```bash
pi install git:github.com/aldoborrero/pi-agent-kit --path extensions/pi-natives
```

## For other extensions

Extensions that want native capabilities import the shared cached loader — never
`@oh-my-pi/pi-natives` directly:

```ts
import { loadNatives } from "@aldoborrero/pi-natives/src/natives.ts";

const natives = await loadNatives(); // null when the addon is unavailable
if (natives) {
  // e.g. natives.countTokens(text), natives.structuredPatchHunks(old, new, ctx)
}
```

The result is cached per process, so every consumer shares one load attempt.
Consumers in this kit: `pi-natives` (tools), `pi-context` (exact token counts),
`pi-edit` (Rust diff hunks for previews), `pi-sandbox` (native bash backend).

### Native shell operations

`shell-ops.ts` adapts the addon's persistent brush-core `Shell` session to the
SDK's `BashOperations` contract, so the bash tool can run on the embedded shell
without replacing the tool (truncation, rendering, and status formatting stay
with the SDK tool):

```ts
import { loadNatives } from "@aldoborrero/pi-natives/src/natives.ts";
import { createNativeShellOperations, shutdownNativeShellSessions } from "@aldoborrero/pi-natives/src/shell-ops.ts";

const natives = await loadNatives();
const operations = natives?.Shell
  ? createNativeShellOperations(natives)
  : undefined; // fall back to the SDK's createLocalBashOperations()

// On session_shutdown:
shutdownNativeShellSessions();
```

Session model: one persistent session per process (shell state survives across
tool calls), one-shot sessions for parallel calls, quarantine on
timeout/abort/error. The bash dialect caveat applies — brush is POSIX sh with
partial bash support — which is why the known gaps are documented (see the pi-sandbox README).
This backend is the kit's **default** for the bash tool; opt out with
`nativeShell.enabled: false` in settings or `PI_SHELL_NATIVE=0`.

### VFS: mount `scheme://` filesystems inside the shell

`shell-vfs.ts` lets extensions expose virtual filesystems to the embedded
shell. Every ordinary host path stays native (`nativeLocalPaths: true`) —
providers can only see the `scheme://` namespaces they mount:

```ts
import { registerVfsScheme, clearVfsSchemes } from "@aldoborrero/pi-natives/src/shell-vfs.ts";

const unregister = registerVfsScheme("mem", async (request) => {
  // Wire contract: 35 ops (metadata, readDir, open/read/close, rename, …).
  // Errors travel as data: { error: { code: "ENOENT", message } }.
  // `open` returns { handle }; handle-addressed ops (read/write/close) carry
  // no path — the registry routes them back by remapped handle id.
  switch (String(request.op)) {
    case "metadata":
      return { metadata: { fileType: "file", size: 3, mode: 0o644 } };
    default:
      return { error: { code: "ENOTSUP", message: "read-only demo" } };
  }
});

// On session_shutdown:
clearVfsSchemes();
```

Once a scheme is mounted, every shell run gets the bridge filesystem: shell
cd, globs, redirections, and builtins work over `scheme://` paths; external
programs only see them when a host file backs them (`backingPath` redirect).

## Development

```bash
bun install   # from the workspace root
bun test extensions/pi-natives
```

## License

MIT