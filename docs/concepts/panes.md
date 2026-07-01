# Panes

A pane is one PTY-backed child process, hosted by `reck-stationd` inside a project. Every pane has a kind, a lifecycle state, and an optional persistent identity that survives daemon restarts.

Source: `daemon/internal/pty/pane.go`, `daemon/internal/pty/manager.go`, `daemon/internal/agent/`, `proto/proto.go`.

## Pane Kinds

Defined in `proto/proto.go`:

```go
type PaneKind string

const (
    PaneKindClaude PaneKind = "claude"
    PaneKindShell  PaneKind = "shell"
    PaneKindCodex  PaneKind = "codex"
)
```

| Kind | What it spawns | Session persistence | Preamble injection |
|------|----------------|--------------------|--------------------|
| `claude` | `claude` binary (resolved at daemon startup) | Yes — `SessionID` (RFC 4122 UUID), stored in sessions index | Yes — baseline + project preamble via `--append-system-prompt` |
| `shell` | Project's configured shell (default: `$SHELL -l`) | Yes — `SlotID` (RFC 4122 UUID), stored argv+cwd | No |
| `codex` | `codex` binary (resolved at daemon startup; optional) | Yes — `SlotID` (reuses the shell slot mechanism), stored argv+cwd | No |

Codex is a first-class pane kind: creatable from the New-pane dialog (the button is shown only when `/health` reports `codex_available`, i.e. a `codex` binary was resolved on that station), labelled **"Codex"** in the tab bar, and — like shell — restart-durable via a persisted `SlotID`. Still deferred (no evidence the `codex` CLI supports them): preamble injection, `--resume`, and lifecycle-hook–driven agent state. If `codex` is not on `PATH` at daemon startup, codex panes return `ErrCodexNotAvailable` at spawn time (HTTP 400) rather than executing a bare name.

## Pane State

```go
type PaneState string

const (
    PaneStateRunning PaneState = "running"
    PaneStateExited  PaneState = "exited"
)
```

Panes move from `running` to `exited` when the child process exits. There is no intermediate state. The daemon does not automatically respawn a pane after exit; the satellite offers a restore UI for sessions/slots that were live at crash time.

## PTY Implementation

Each pane owns one PTY master (`*os.File`). The daemon spawns the child via `pty.StartWithSize` (github.com/creack/pty) with a configurable initial `cols × rows`.

Two goroutines per pane:
- `readLoop` — reads from PTY master, writes to a 64 KB ring buffer (`replayBuffer`), fans out to WebSocket subscribers.
- `waitLoop` — calls `Cmd.Wait`, sets `PaneStateExited`, fires exit callbacks, closes the `exited` channel.

PTY I/O over WebSocket is base64-encoded raw bytes (not UTF-8 strings). The WS `hello` message replays the ring buffer on connect so a fresh satellite connection picks up recent output without the user missing context.

The ring buffer keeps the last 64 KB of raw terminal bytes. This is the `replay` field on `daemon/internal/pty/pane.go:Pane`.

## Pane ID

Generated at spawn time, before `exec`: `p_<12 lowercase hex chars>` (e.g. `p_a1b2c3d4e5f6`). Injected into the child as `RECK_PANE_ID`. Regenerated on every spawn — not stable across restarts.

## Persistent Identity

Panes with persistent identity survive daemon restarts and can be resumed. The two identity fields are mutually exclusive:

| Field | Kind | Type | Purpose |
|-------|------|------|---------|
| `SessionID` | claude | RFC 4122 UUID | Passed as `--session-id` (fresh) or `--resume` (restore). Stable across restarts. Used by `claude --resume <uuid>`. |
| `SlotID` | shell | RFC 4122 UUID | Stable across restarts. Keyed into the sessions store to retrieve the frozen `ShellArgv` and `Cwd` for restore. |

Codex panes have neither field.

## Claude Pane Lifecycle

1. `CreatePaneWith` is called with `kind=claude`.
2. The claude adapter generates a new UUID, calls the `claude` binary as:
   ```
   claude --session-id <uuid> --name <project>/<short-uuid> [--append-system-prompt <preamble>] [extra_args...]
   ```
3. On spawn, the daemon upserts the session entry into the sessions store with `WasLive=true`.
4. On exit, the sessions store `Touch` fires to update `LastActiveAt`.
5. On graceful `DeletePane`, `WasLive` is cleared — no restore prompt next time.

## Shell Pane Lifecycle

1. Fresh create: daemon generates a new `SlotID`, stores `ShellArgv` (the resolved argv) and `Cwd` (the project's cwd at spawn time) in the sessions store with `WasLive=true`.
2. On exit: `LastActiveAt` is touched. `WasLive` stays `true` unless `DeletePane` was called.
3. Restore: `CreatePaneWith` with `RestoreSlotID` looks up the entry, replays `ShellArgv` and stored `Cwd`.

### Shell restore replays frozen argv and cwd

**Critical**: shell restore uses the `ShellArgv` and `Cwd` stored at original create time, NOT the project's current `shell` or `cwd` fields from `projects.toml`. Project configuration can drift between create time and restore time. The stored argv is the invariant.

This is enforced in `daemon/internal/agent/shell.go` `BuildSpawn`:

```go
if req.RestoreEntry != nil {
    return SpawnPlan{
        Argv: append([]string(nil), req.RestoreEntry.ShellArgv...),
        Cwd:  req.RestoreEntry.Cwd,
        // ...
    }, nil
}
```

See also: [`concepts/sessions.md`](./sessions.md) for the sessions store, [`concepts/behaviors.md`](./behaviors.md) for the restore flow.

## Claude `extra_args` Validation

`CreatePaneRequest.extra_args` allows callers to append flags to a Claude pane's argv. The daemon validates them through `ValidateClaudeExtraArgs` in `daemon/internal/pty/claude_args.go` before spawning.

Rejected flags:
- `--cwd` / `--cwd=<v>` — would escape the project sandbox.
- `--resume`, `--session-id`, `--name` — reserved for the daemon's session bookkeeping.
- `--append-system-prompt` — reserved; the daemon injects baseline + project preamble. Use the `preamble` field in `projects.toml` to add prompt content.
- `--add-dir <path>` — allowed only when `path` resolves under the project's cwd.
- `--debug-file <path>` — allowed only when `path` resolves under `os.TempDir()`.

Everything else, including `--dangerously-skip-permissions`, is allowed.

`extra_args` is silently ignored for shell panes; for codex panes it is appended verbatim to the `codex` argv (the New-pane dialog sends none).

## Codex Pane Specifics

The codex adapter (`daemon/internal/agent/codex.go`) prepends the resolved `codexCmd` path and appends any `ExtraArgs`. On a **restore** it instead replays the argv+cwd captured at the original spawn (mirroring the shell adapter), so a codex pane comes back running the same command in the same directory after a daemon restart — slot-identity continuity is what lets the Satellite rebind the saved tab. If `codex` was unavailable at daemon startup, `BuildSpawn` returns `ErrCodexNotAvailable` and the HTTP handler returns 400.

**Availability signal.** `GET /health` reports `codex_available` (`len(codexCmd) > 0`); the Satellite records it per-host and shows the "Codex" new-pane button only where a codex binary exists. Absent on older daemons ⇒ treated as false (button hidden).

**Still deferred** (no repo evidence the `codex` CLI supports these): `--resume` (`BuildSpawn` returns `ErrResumeUnsupported`), preamble injection (Claude's `--append-system-prompt` has no known codex equivalent; codex's convention is a filesystem `AGENTS.md`), and lifecycle-hook–driven agent state (the daemon hook channel is already wired for every pane, but a codex-side `reck-codex-hook.sh` shim awaits confirmation that the codex CLI exposes hooks). See issue #33.

## Agent State (hook-driven)

Claude panes (and, in principle, future hooked agents) maintain an `AgentState` updated by lifecycle hook events:

```go
type AgentState string

const (
    AgentStateUnknown   AgentState = ""
    AgentStateWorking   AgentState = "working"
    AgentStateIdle      AgentState = "idle"
    AgentStateAttention AgentState = "attention"
)
```

Transitions driven by `RecordEvent` in `daemon/internal/pty/pane.go`:

| Event | → State |
|-------|---------|
| `user_prompt`, `pre_tool`, `post_tool` | `working` |
| `post_tool_failure` (is_interrupt=true) | `""` (unknown) |
| `post_tool_failure` (other) | `working` |
| `user_interrupt` | `""` (unknown) |
| `permission_request`, `permission_denied`, `elicitation` | `attention` |
| `stop`, `stop_failure` | `idle` |
| `notification`, `session_start`, `session_end` | no change (log only) |

The `AgentState` feeds the stoplight. See [`concepts/stoplight.md`](./stoplight.md) and [`concepts/hook-shims.md`](./hook-shims.md).
