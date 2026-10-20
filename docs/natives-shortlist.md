# pi-natives integration ledger

Final state of the oh-my-pi natives integration shortlist (closed 2026-10-20).
The addon exposes ~146 exports; this kit curates a surface rather than adopting
everything. Each candidate below records its outcome and the reasoning, so the
decision does not have to be re-litigated.

## Integrated

| API | Consumer | PR |
|---|---|---|
| `grep` (native ripgrep engine) | `pi-natives` tool (replaces the JS built-in, JS fallback) | #2 |
| `astGrep` (pattern mode; CLI fallback for rule/inspect) | `pi-natives` tool (replaced `pi-ast-grep`) | #2 |
| `pdfToMarkdown` + OCR classification | `pi-natives` tool (registered only when the addon loads) | #2 |
| `countTokens` (O200k base) | `pi-context` exact token counts (was `length/4`) | #2 |
| `structuredPatchHunks` | `pi-edit` preview hunks with edit-distance budget preserved | #2 |
| `AudioCapture` (cpal) | `pi-voice` `NativeRecorder` default (external-binary fallback) | #6, #7 |
| `Shell` (persistent brush-core session) | `pi-sandbox` bash backend, **default on** | #11 |
| `ShellFilesystem` bridge | `pi-natives/src/shell-vfs.ts` — `scheme://` VFS registry | #12 |

## Deferred with rationale

| Candidate | Why not (today) |
|---|---|
| `fuzzyFind` | Different semantics from the glob-based `find` built-in; replacing `find` with fuzzy matching would change the model's contract, not improve it |
| `FileLock` | `pi-loop`'s `loop-lock.ts` protocol (heartbeat, staleness, PID liveness, TOCTOU hardening) is well-tested; FileLock would be a marginal rewrite win |
| `EditSession` | Adopted (opt-in) as an alternative executor for the native `edits[]` payload — Rust matching, session snapshots with the no-op loop guard, auto-generated blocking; batch semantics differ from the kit contract (incremental vs original-content), so default stays `pi` (PR #20) |
| `astEdit` | Adopted: the `edit` tool's `ast` param runs ast-grep rewrite rules (pattern → rewrite, metavariables) with a mandatory dry-run pass, auto-generated guard over touched files, and `apply: true` to write (PR #22) |
| Hashline mode | Adopted (opt-in, `PI_EDIT_HASHLINE` / `nativeEdit.hashline`): line-anchored `PUT`/`CUT`/`REM`/`MV` DSL with stale-snapshot rejection; ships with a deliberate `read` replacement that prepends the `[path#TAG]` snapshot header |
| `highlightCode` | No consumer: `pi-diff` renders through delta/CLI, and the TUI syntax-rendering surface is a separate project |
| `vcs*` (git/jj) | Overlaps `pi-rewind-hook` (checkpoints per prompt/turn); introducing a second checkpoint source would split state |
| `executeShell` (one-shot) | Used only where oh-my-pi uses it (config interpolation); agent-facing execution goes through the persistent `Shell` |

## Known gaps of the embedded shell (accepted, documented)

- `trap … EXIT` never fires (persistent-session semantics; one-shot sessions do
  not fire it either) — one-shot cleanup patterns silently skip. Same trade-off
  oh-my-pi accepts.
- brush mimics `BASH_VERSION` 5.2.x; dialect gaps surface as normal command
  failures the agent can retry differently.
- Background jobs: `cmd &` returns immediately and does not block the run
  (verified), but shell job control is inert — `$!`, `jobs`, and `wait` are
  no-ops, so scripts cannot synchronize on background children. Use explicit
  files/pids for coordination.

## Conventions

- Load the addon only through `pi-natives/src/natives.ts` (`loadNatives()`),
  never import `@oh-my-pi/pi-natives` directly; pin the version exactly.
- Every native-backed path must fall back gracefully and surface diagnostics on
  `session_start`.
- Natives that `dlopen()` system libraries at runtime only see environment that
  existed before pi launched (see AGENTS.md, Key Learning 1b).