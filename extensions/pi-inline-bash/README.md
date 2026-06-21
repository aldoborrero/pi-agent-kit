# inline-bash

Expands `!{command}` patterns in user prompts before sending to the LLM.

## Usage

```
What's in !{pwd}?
The branch is !{git branch --show-current} and status: !{git status --short}
My node version is !{node --version}
```

The `!{command}` patterns are executed and replaced with their output. Regular `!command` syntax (whole-line bash) is preserved.

## Events

| Event | Action |
|-------|--------|
| `input` | Detect and expand `!{...}` patterns |

## Features

- 30s timeout per command
- Error output shown inline as `[error: message]`
- UI notification summarizing expansions
- Preserves existing `!command` whole-line bash behavior

## Attribution

Based on [pi-mono example extension](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/inline-bash.ts).
