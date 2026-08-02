# Port: Codex hooks, stoplight, and resume from `reck-connect-private`

Tracking issue: #122. Unblocks the first bullet of #39 and corrects its
"Explicitly NOT planned" note on resume.

This is the audit trail for a copy-based port between two repos with **no shared
git history**. `reck-connect-private` (`Rudie-Verweij/reck-connect-private`) is
the original; this repo begins at `75116ef` "Reck Connect — initial public
release" (2026-06-08), a scrubbed snapshot, and re-implemented Codex support
from scratch on 2026-07-01 (PRs #35/#36) as a thinner version. The private tree
had built a deeper integration on 2026-05-10→05-13 that the snapshot was cut
before.

`git merge` and `cherry-pick` are unavailable, so each unit was compared and
decided individually. The "what changed and why" narrative lives here rather
than in code comments, because the private tree's comments referenced issues
(`#28`, `#252`, `#254`) that don't exist in this repo's history.

## What the private tree established

Both blockers recorded in #39 turned out to be resolved, and its claim that
"the `codex` CLI has no session/resume concept" was wrong. Verified against
codex 0.128:

- **Hooks exist.** `features.hooks = true` (named `features.codex_hooks` before
  codex 0.130 deprecated it) plus `[[hooks.<Event>]]` tables in
  `~/.codex/config.toml`, with 8 usable events.
- **Resume exists.** `codex resume [OPTIONS] [SESSION_ID] [PROMPT]`. The thread
  UUID arrives in the `SessionStart` hook payload as `session_id`; codex owns
  the thread metadata in its own store, so only the UUID needs round-tripping.

## Identity and sanitization

- **No import rewrite needed.** Both repos use module path
  `github.com/rudie-verweij/reck-connect`, so Go imports ported verbatim.
- **No personal data found** in any ported unit. `testdata/fixture-real.toml.txt`
  was already `${HOME}`-placeholdered upstream; its header comment was reworded
  to drop a capture date and issue reference.
- **Secret scan**: a `gitleaks` pre-commit hook ran on every commit, clean each
  time.
- **Cruft stripped**: ~45 references to `#28` / `#252` / `#254` / `Phase N §M` /
  `Codex HIGH` / `pre-fix`. Where they described real behaviour (the ownership
  sidecar's v1→v2 migration) the prose was rewritten around the schema version,
  which is a durable anchor; where they were pure history they were deleted.

## Per-unit decisions

| Unit | State | Decision | Notes |
|---|---|---|---|
| `internal/codexhooks/` (installer, shim, testdata) | source only | **take-source** | ~1.9k lines, dropped in whole. Kept the codex 0.130 `codex_hooks`→`hooks` flag migration, the newest thing in the package. |
| `events.Kind` pre/post compact | source only | **take-source** | Added to `ValidKinds` too, or `KindValid` rejects them at the HTTP boundary. |
| `pty.New` / `Start` / `IsStarted` split | source only | **take-source** | Prerequisite, not optional — see below. |
| `Pane.Write` / `Resize` nil-Tty guards | diverged | **merge** | Adopted, but private read `p.Tty` unlocked; the split makes `Start` publish it under `p.mu`, so the read is taken under the lock here. |
| `Pane.Info` `ClipboardImage` | diverged | **keep-target** | This repo gates on `macclipboard.Available()` (darwin, plus linux with xclip+`$DISPLAY`); private used `runtime.GOOS == "darwin"`. Taking source would have dropped Linux support. |
| `stoplight.Evaluate` codex branch | diverged | **merge** | See "Deliberate deviations". |
| `ws/handler.go` ESC interrupt gate | source only | **take-source** | Widened to codex. |
| `sessions.Entry.ThreadID` + `SetThreadID` | source only | **merge** | Signature changed to return the previous value — see below. |
| `Manager.RecordCodexThread` | source only | **merge** | Does not write `pane.SessionID` — see below. |
| `CreatePaneWith` resume/hydration | diverged | **take-source** | Mutual-exclusion relaxed for codex; thread hydrated from the row so clients only need the slot id. |
| Codex placeholder row before `Start` | source only | **take-source** | Scoped to fresh codex panes. |
| `agent/codex.go` resume argv | diverged | **merge** | Resume argv taken from source; this repo's preamble mechanism and `GlobalPreamble` layer kept. |
| `agent/codex.go` preamble mechanism | diverged | **keep-target** | See "Deferred". |
| `restore-orphans` codex branch | diverged | **keep-target** | See "Deliberate deviations". |
| `new-pane-dialog.ts` resume split | diverged | **merge** | Split adopted; this repo's `x` shortcut and availability gating kept. |
| `boot.ts` resume flow | diverged | **merge** | Kind-branched resume adopted; this repo's `codexUnavailableMessage` toast kept and extended to cover resume. |
| `internal/childenv/` | source only | **discard** | Not needed by anything ported, and the private copy is scrub-damaged (`package ln`). |
| `pty.ValidateCodexExtraArgs`, launch-args menu | source only | **defer** | Out of agreed scope; see "Deferred". |

## Prerequisite: publish a pane before starting it

`pty.Spawn` built and started the child in one call, and `CreatePaneWith` only
registered the pane in `byID` afterwards. Codex fires `SessionStart` almost
immediately, so a hook arriving in that window got a 404 and the thread UUID —
which appears nowhere else — was lost.

Split into `New` + `Start` + `IsStarted`, with `CreatePaneWith` assigning the
slot, writing the row, registering, then starting. Because the pane is now
reachable while the exec is still in flight, `Start` publishes
`Cwd`/`cols`/`rows`/`Cmd`/`Tty` under `p.mu`, and the three scans over
`AllPanes` (stoplight ticker, mountprobe watcher, liveness ticker) skip panes
that aren't started. Each guard also supplies the happens-before that keeps
their subsequent unlocked field reads safe.

## Deliberate deviations from the private implementation

**1. Codex thread id is never written to `pane.SessionID`.** Private set it for
drift detection. In this repo `entryMatches` routes codex rows by `SlotID`,
while the liveness ticker, rename and touch paths all prefer `SessionID` when
set — so populating it would send those paths looking for a row keyed by a UUID
nothing is filed under, silently breaking liveness tracking for codex panes.
Instead `Store.SetThreadID` returns the previous value, which gives the same
drift warning without touching pane identity.

**2. An unhooked codex pane keeps the byte-flow stoplight.** Private ORs codex
into the agent-state branch unconditionally, which means a station running
`--no-install-codex-hooks` (or where the install failed) shows every codex pane
gray forever — a regression against this repo's current behaviour, and against
the degradation guarantee in the plan. Here the agent-state branch applies once
any hook event has landed; before that the pane falls back to the heuristic.
Distinguishing the two required a new signal, since "agent between turns" and
"hooks never installed" both leave `AgentState` at unknown. Claude deliberately
does not get this fallback: its unknown is also what an ESC interrupt produces,
where gray is intended.

**3. Restore-orphans still restores codex rows with no thread.** Private skips
them and clears `was_live`, because its adapter always resumes. This repo
already restores such panes by replaying the captured argv, so skipping would
stop them coming back at all. The adapter falls back to argv replay instead:
the pane returns to the right place, just without history.

**4. Kept `x` as the Codex shortcut.** Private remapped Codex to `o` and Resume
Claude to `r`. This repo already shipped `x` for Codex, so remapping would break
muscle memory for no gain; `Shift+R` was added for Resume Codex instead.

## Deferred

- **Tempfile preamble.** Private renders baseline+project into a 0600 tempfile
  and passes `-c model_instructions_file=…`, with a TOML basic-string escaper,
  `SpawnPlan.CleanupPaths` → `Pane.AddCleanup`, and a boot-time sweep for crash
  orphans. This repo passes prose inline via `-c developer_instructions=` and
  has no `CleanupPaths`. Kept as-is so this port stayed about
  hooks/stoplight/resume; the tempfile mechanism is a separate change. Note the
  two trees differ in which layers reach codex: this repo sends
  global+project and skips the Claude-shaped baseline, private sends
  baseline+project and has no global layer.
- **`ValidateCodexExtraArgs` + Codex launch-args menu** (private:
  `pty/codex_args.go`, 305 lines + 442 of tests, and a `claude-launch-dialog.ts`
  parameterized per agent). Codex panes still accept no extra args here, so
  there is nothing to validate yet. Worth a follow-up issue.
- **#39's clipboard-image bullet.** Untouched.

## Claude-only features with no Codex counterpart in either tree

Not ported because they don't exist to port: transcript view (reads Claude's
JSONL; codex uses its own store, a different format), history pane, dictation
mic, auto-naming, and usage/quota telemetry (fed by Claude Code's `statusLine`
hook, which codex has no equivalent of).

## Verification

- `go build ./...`, `go vet ./...` clean.
- Full Go suite green except `internal/launcher`, which is environmental: its
  integration tests build and exec the pane-launcher helper, and from a
  Desktop-rooted worktree macOS TCC delays that past the bind deadline.
  Confirmed by running the same commit from `/private/tmp/...` (passes, ~5s) and
  from `Desktop/.../worktrees/...` (fails). Not a regression.
- `pnpm exec vitest run`: 2320 passed. The two failing files —
  `main/rsync-copy.test.ts` and `renderer/src/project-push.test.ts` — fail on
  clean `main` in this environment (station-root env: they expect
  `/Users/reck-connect/projects`, the local env supplies `/home/strijders`).
  Neither file was touched.
- `tsc --noEmit` clean for the renderer.
- Each new test was checked to fail against the unmodified implementation before
  being kept. Two rounds of that found real problems: the ported
  `pre_compact`/`post_compact` table cases passed even with the mapping
  reverted, because the preceding case already left the pane in `working`
  (private's table had the same flaw); and a test asserting the pre-Start
  placeholder row passed without it, because the post-start upsert had already
  run by the time the test posted its event.

### Not covered by tests

The pre-Start placeholder row defends a race — a hook arriving before
`CreatePane` returns — that a unit test can't deterministically hit. Tests
assert the row exists and is writable as soon as the pane is reachable; the
ordering itself rests on the argument above.

Still to do by hand, on a real station:

1. Installer against a copy of a real `~/.codex/config.toml` in a temp `$HOME`:
   diff to confirm only Reck-owned slots changed, run twice for idempotence,
   uninstall to confirm restoration, and seed a legacy
   `features.codex_hooks = true` to confirm the migration.
2. Codex pane goes orange while working, red on a permission request, green on
   Stop; its session row gains a `thread_id` shortly after spawn.
3. Restart the daemon and confirm the pane returns with its conversation
   intact; then close it and use "Resume Codex…" (`Shift+R`).
4. With `--no-install-codex-hooks`, confirm codex panes behave as they do today.
