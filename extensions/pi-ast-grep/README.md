# ast-grep

Structural code search extension using [ast-grep](https://ast-grep.github.io). Unlike text-based search, ast-grep understands code structure through Abstract Syntax Trees, enabling precise pattern matching that ignores formatting and whitespace differences.

## Tool

**`ast_grep`** -- Search code using AST patterns.

## Modes

| Mode | Description | Required params |
|------|-------------|-----------------|
| `pattern` | Simple pattern search (`ast-grep run --pattern`) | `pattern` |
| `rule` | Complex YAML rule search (`ast-grep scan --rule`) | `rule`, `lang` |
| `inspect` | AST structure dump (`ast-grep run --debug-query`) | `pattern`, `lang` |

## Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `mode` | `"pattern" \| "rule" \| "inspect"` | Search mode (required) |
| `pattern` | `string` | AST pattern with metavariables (`$VAR`, `$$$VAR`) |
| `rule` | `string` | YAML rule body (content under the `rule:` key) |
| `inspect_format` | `"ast" \| "cst" \| "pattern"` | Output format for inspect mode (default: `ast`) |
| `lang` | `string` | Language (e.g. `typescript`, `python`, `rust`) |
| `paths` | `string[]` | Directories/files to search (default: `.`) |
| `globs` | `string[]` | Glob patterns to include/exclude |
| `context` | `boolean` | Show surrounding context lines |
| `limit` | `number` | Max matches to return (default: 50) |

## Examples

Pattern search for all `console.log` calls:
```json
{ "mode": "pattern", "pattern": "console.log($$$)" }
```

Rule search for async functions without try-catch:
```json
{
  "mode": "rule",
  "lang": "typescript",
  "rule": "all:\n  - kind: function_declaration\n  - has:\n      pattern: await $EXPR\n      stopBy: end\n  - not:\n      has:\n        pattern: \"try { $$$ } catch ($E) { $$$ }\"\n        stopBy: end"
}
```

Inspect the AST structure of a pattern:
```json
{ "mode": "inspect", "pattern": "function $NAME($$$ARGS) { $$$BODY }", "lang": "javascript" }
```

## Requirements

- [ast-grep](https://ast-grep.github.io) installed and in PATH

## Supported Languages

JavaScript, TypeScript, Python, Rust, Go, Java, C, C++, CSS, HTML, and more.
