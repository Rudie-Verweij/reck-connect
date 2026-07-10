# File Map

"Where does X live?" index, organized by concern. Key entry points and package boundaries only — not every file. For the complete wire protocol, see [`../../proto/proto.md`](../../proto/proto.md).

---

## Daemon internals (`daemon/`)

### Entry point

| Path | Description |
|---|---|
| `daemon/cmd/reck-stationd/main.go` | Daemon entry point: flag parsing, token resolution, hook install, sessions setup, HTTP server start |

### `internal/config`

| Path | Description |
|---|---|
| `internal/config/config.go` | `projects.toml` load/validate/write; `ManagedProjectsRoot` var; `ValidateProjectID`; `DeriveID` |
| `internal/config/token.go` | Bearer token resolution from `/etc/reck-stationd/token` or `DAEMON_TOKEN` env |
| `internal/config/slugify.go` | Slug generation helpers |
| `internal/config/binres.go` | Binary path resolution (`ResolveBinary`) |
| `internal/config/path_guard.go` | Path containment checks for project cwd safety |

### `internal/pty`

| Path | Description |
|---|---|
| `internal/pty/manager.go` | `Manager`: owns all live panes across projects; `AddProject`, `RemoveProject`, `CreatePane`, `CreatePaneWith`, `DeletePane` |
| `internal/pty/pane.go` | `Pane`: PTY lifecycle, `Write`, `ReplayTail`, `RecordEvent`, `AgentState`, `EventLog` |
| `internal/pty/claude_args.go` | Builds Claude pane argv (binary, `--resume`, `--append-system-prompt`, extra args) |
| `internal/pty/argv_redact.go` | Redacts bearer tokens from logged argv for safety |

### `internal/http`

| Path | Description |
|---|---|
| `internal/http/router.go` | Chi router, all HTTP/WS routes, `authMiddleware`, `corsMiddleware`, CSWSH origin check, loopback exemption, all handlers |

### `internal/ws`

| Path | Description |
|---|---|
| `internal/ws/handler.go` | WebSocket upgrade, PTY I/O relay, resize handling, `hello` replay on connect |

### `internal/hooks`

| Path | Description |
|---|---|
| `internal/hooks/install.go` | Installs `reck-claude-hook.sh` into `~/.claude/hooks/` and wires entries in `~/.claude/settings.json`; idempotent via `reck-hook-v1` marker |
| `internal/hooks/reck-claude-hook.sh` | Embedded shell script; POSTs lifecycle events to daemon |

### `internal/stoplight`

| Path | Description |
|---|---|
| `internal/stoplight/stoplight.go` | `Evaluate(Signals, time.Time)`: stoplight state machine; `IdleThreshold` = 3 s |

### `internal/agent`

| Path | Description |
|---|---|
| `internal/agent/claude.go` | Claude-specific agent-state logic and spawn config |
| `internal/agent/codex.go` | Codex-specific spawn config |
| `internal/agent/shell.go` | Shell pane spawn config |
| `internal/agent/preamble.go` | Baseline preamble injection logic |
| `internal/agent/autoname.go` | Derives a display name from Claude session JSONL transcript |
| `internal/agent/adapter.go` | Adapter between agent config types and PTY pane creation |

### `internal/sessions`

| Path | Description |
|---|---|
| `internal/sessions/sessions.go` | Session persistence store: `Upsert`, `List`, `SetLive`; JSON file per project under `~/.config/reck/sessions/` |

### `internal/events`

| Path | Description |
|---|---|
| `internal/events/events.go` | `Event` struct, `Kind` enum, `KindValid`, event log types |

### `internal/httpx`

| Path | Description |
|---|---|
| `internal/httpx/decode.go` | Shared `DecodeJSONBody` helper (size cap, trailing-data rejection) |

---

## Satellite internals (`satellite/`)

### Main process

| Path | Description |
|---|---|
| `satellite/main/main.ts` | Electron main: window creation, menu, IPC handlers (config, daemon, dialog, mount, rsync) |
| `satellite/main/daemon-spawn.ts` | `startDaemon`, `stopDaemon`, `isDaemonRunning`, `findDaemonBinary`; `will-quit` SIGTERM fallback (graceful quit path is `confirmQuitWithLocalDaemon` in `main.ts`) |
| `satellite/main/storage.ts` | `safeStorage`-backed config read/write; `CONFIG_KEYS` allowlist |
| `satellite/main/ipc-validation.ts` | `checkExternalUrl`, `resolveInsideMountPoint` — input validation for IPC handlers |
| `satellite/main/rsync-copy.ts` | rsync-based folder copy for "Add from existing folder" flow |

### Preload

| Path | Description |
|---|---|
| `satellite/preload/preload.ts` | `contextBridge` surface; exposes `reckAPI` to the renderer |

### Renderer

| Path | Description |
|---|---|
| `satellite/renderer/src/main.ts` | Renderer entry point; mounts the app shell |
| `satellite/renderer/src/boot.ts` | Boot sequence: reads config, picks mode, renders mode-chooser or main UI |
| `satellite/renderer/src/config.ts` | `reckAPI` type declaration (`Window.reckAPI`); typed wrappers around IPC |
| `satellite/renderer/src/daemon/connection.ts` | Typed HTTP client layer for the daemon REST surface |
| `satellite/renderer/src/daemon/mount-hint.ts` | Mount status polling and display |
| `satellite/renderer/src/layout/split-tree.ts` | Tmux-style pane split-tree model |
| `satellite/renderer/src/layout/reconcile.ts` | Reconciles daemon pane list against the local split-tree |
| `satellite/renderer/src/restore-candidates.ts` | Restore-candidates prompt logic |
| `satellite/renderer/src/select-project.ts` | Project selection from the rail |
| `satellite/renderer/src/ui/` | UI components: rail, pane-layout, dialogs, mode-chooser, etc. |

---

## Shared protocol (`proto/`)

| Path | Description |
|---|---|
| `proto/proto.ts` | TypeScript wire types (Project, Pane, SessionInfo, etc.) |
| `proto/proto.go` | Go wire types (same contract, hand-maintained in parallel) |
| `proto/proto.md` | Authoritative contract document — source of truth for the protocol |

---

## Shared renderer (`client-core/src/`)

| Path | Description |
|---|---|
| `api/client.ts` | Typed HTTP client for daemon REST endpoints |
| `api/ws.ts` | PTY WebSocket wrapper; emits typed events |
| `terminal/terminal-pane.ts` | xterm.js pane component |
| `terminal/osc-filter.ts` | Filters OSC escape sequences (e.g. OSC 777 approval prompts) |
| `launch-args/tokenize.ts` | Parses Claude launch-arg strings |

---

## Ops (`ops/`)

| Path | Description |
|---|---|
| `ops/install-station.sh` | Full station install: build, binary, launchd plist, token, bootstrap, verify |
| `ops/uninstall-station.sh` | Reverse of install-station.sh |
| `ops/install-satellite.sh` | Laptop setup: FUSE-T + sshfs, SSH key, LaunchAgent for mount |
| `ops/uninstall-satellite.sh` | Reverse of install-satellite.sh |
| `ops/install-local.sh` | Build daemon for Local mode only (no launchd) |
| `ops/reck-mount-watchdog.sh` | 60 s watchdog: reaps orphaned go-nfsv4 helpers, remounts sshfs |
| `ops/eu.verwey.reck-stationd.plist.tmpl` | launchd plist template for the daemon |
| `ops/eu.verwey.reck-mount.plist.tmpl` | launchd LaunchAgent template for the mount watchdog |
| `ops/examples/projects.toml` | Example project registry |
| `ops/README.md` | Full ops manual (install, FileVault, service management, log paths) |

---

## Tests

| Pattern | What they cover |
|---|---|
| `daemon/internal/**/*_test.go` | Go unit tests for every daemon package |
| `satellite/main/*.test.ts` | Vitest unit tests: storage, rsync-copy, ipc-validation |
| `satellite/renderer/src/**/*.test.ts` | Vitest unit tests: layout reconcile, restore-candidates, select-project |
| `client-core/src/**/*.test.ts` | Vitest unit tests: client, ws, terminal-pane, osc-filter, tokenize |
| `satellite/e2e/smoke.spec.ts` | Playwright e2e smoke test |

---

## Existing documentation

| Path | What lives there |
|---|---|
| `docs/internals.md` | V2 layout, quickstart, escape hatch for local MCPs |
| `ops/README.md` | Full ops manual |
| `proto/proto.md` | Wire protocol — authoritative source of truth |
| `docs/README.md` | This wiki's index |
| `INSTALL.md` | End-to-end Claude-driven install runbook |
