# @aldoborrero/pi-diff

Quick diff viewer via the `/diff` command.

Shells out to `tuicr` (preferred), then `delta`, then plain `git diff`, showing the result in a fullscreen TUI. The first available tool in that chain is used.

## Usage

```
/diff              — show all uncommitted changes
/diff --staged     — show only staged changes
/diff --cached     — alias for --staged
/diff <revisions>  — show changes for a commit range (e.g. HEAD~3..HEAD)
```

Staged diffs (`--staged`/`--cached`) are rendered via `delta` or `git diff`, since `tuicr` only accepts a revision or range.

The command requires interactive mode.
