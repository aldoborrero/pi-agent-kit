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

## Development

```bash
bun install   # from the workspace root
bun test extensions/pi-natives
```

## License

MIT