# Hook Shims

## What Claude Code hooks are

Claude Code supports lifecycle hooks: shell commands registered in `~/.claude/settings.json` under a `hooks` key. Claude Code invokes these commands at specific lifecycle events (session start, before/after tool calls, on stop, etc.) with the event payload on stdin.

Reck uses this mechanism to forward lifecycle events from each Claude pane's child process back to the daemon, driving the stoplight state machine.

## Installation at daemon startup

On every daemon startup, `hooks.EnsureInstalled(home string)` runs. Source: `daemon/internal/hooks/install.go:EnsureInstalled`.

It does two things:

1. Writes the embedded shim script to `~/.claude/hooks/reck-claude-hook.sh` (only if the content has changed — avoids spurious mtime bumps).
2. Reads `~/.claude/settings.json`, strips any previously Reck-owned hook entries, and writes fresh entries for all 12 lifecycle bindings.

This is **idempotent** — running it N times produces the same result as running it once.

## Shim script

**Location:** `~/.claude/hooks/reck-claude-hook.sh`

**Template source:** `daemon/internal/hooks/reck-claude-hook.sh` (embedded via `//go:embed`)

The shim is invoked by Claude Code with:
- `$1` — the canonical event kind (`session_start`, `user_prompt`, `pre_tool`, `post_tool`, `stop`, etc.)
- `stdin` — the raw hook payload (JSON)

The shim reads `RECK_PANE_ID` and `RECK_DAEMON_URL` from its environment. If either is missing (Claude running outside Reck), it silently exits 0 — existing Claude workflows are unaffected.

When both are set, the shim POSTs to:
```
${RECK_DAEMON_URL}/panes/${RECK_PANE_ID}/agent-event?kind=<KIND>&agent=claude-code&project_id=<RECK_PROJECT_ID>
```

This POST reaches the loopback exemption in `authMiddleware` — no bearer token required. See [auth.md](./auth.md) for why.

The shim uses `curl --max-time 2` and discards all output (`>/dev/null 2>&1 || true`). A slow or down daemon never blocks the Claude session.

## Lifecycle bindings

The daemon registers hooks for these Claude Code events:

| Claude Code event | Reck kind |
|------------------|-----------|
| `SessionStart` | `session_start` |
| `UserPromptSubmit` | `user_prompt` |
| `PreToolUse` | `pre_tool` |
| `PostToolUse` | `post_tool` |
| `PostToolUseFailure` | `post_tool_failure` |
| `PermissionRequest` | `permission_request` |
| `PermissionDenied` | `permission_denied` |
| `Elicitation` | `elicitation` |
| `Stop` | `stop` |
| `StopFailure` | `stop_failure` |
| `Notification` | `notification` |
| `SessionEnd` | `session_end` |

## Idempotency and ownership

Each hook entry's command string is tagged with `# reck-hook-v1`. Ownership recognition uses **structured exact-match**, not loose substring scanning:

1. **Exact match** of the current canonical command form (covers the normal case).
2. **Sidecar lookup** from `~/.claude/.reck-hooks.json` — records the exact command strings written by prior installs, so an entry with a stale shim path (e.g. if `$HOME` moved) is still recognized and stripped.
3. **Legacy regex** — a one-shot migration heuristic for installs from before the sidecar system existed. Matches `bash <path>/.claude/hooks/reck-claude-hook.sh <kind> # reck-hook-v1` with tight path constraints.

User hooks whose command string merely contains "reck-hook-v1" in a comment are **not** claimed or stripped.

## Concurrency safety

The installer holds an **advisory OS-level flock** on `~/.claude/.reck-hook.lock` for the duration of the entire read-modify-write sequence (settings.json + shim write + sidecar write). This serialises concurrent daemon instances at boot.

Both `settings.json` and the sidecar file are written via per-PID temp files + atomic rename.

Source: `daemon/internal/hooks/install.go:withInstallLock`.

## Known caveats

**Shim script written non-atomically before the lock era:** the shim write itself uses a per-PID temp + rename (since `writeShimIfChanged` uses the same pattern), but an older version wrote directly. This is fixed in current code.

**Paths with spaces:** hook command strings are single-quoted (`bash '<shim_path>' <kind> # reck-hook-v1`) with `'` characters escaped as `'\''`. Paths with single quotes in the name are handled; paths with other shell-special characters are not.

**User hooks with the same name shape:** a user hook that happens to match the legacy regex pattern (path ends in `.claude/hooks/reck-claude-hook.sh`, kind is a known binding kind, comment is `reck-hook-v1`) would be claimed and stripped. This is narrow enough to be unlikely in practice.

## Ops sidebar

Hook installation happens automatically at daemon startup and requires no manual step. To see the current state of Reck's entries in `settings.json`, inspect `~/.claude/settings.json` directly. The sidecar at `~/.claude/.reck-hooks.json` records which command strings Reck owns.

Uninstalling the daemon removes all Reck-owned hook entries and deletes the shim script. See [../operations.md](../operations.md) for the full install/uninstall impact.

For how hook events drive the stoplight, see [behaviors.md](./behaviors.md) and [stoplight.md](./stoplight.md).
