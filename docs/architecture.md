# Architecture

Reck Connect V2 is a station/satellite system. A powerful Mac ("station") runs a Go daemon that owns all compute. A laptop ("satellite") runs an Electron app that renders terminal panes and drives the daemon over HTTP and WebSocket.

See also: [`docs/internals.md`](../docs/internals.md) for the quickstart, [`concepts/modes.md`](./concepts/modes.md) for local vs station deployment.

## Component Map

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  STATION (Mac Studio or any macOS host)                                      │
│                                                                               │
│  reck-stationd (Go daemon)                                                   │
│  ├── HTTP/WS server  :7315                                                   │
│  ├── pty.Manager  ──────────────────────────────────── PTY children         │
│  │   ├── [project: reck-connect]                                             │
│  │   │   ├── pane p_abc123  → PTY → /usr/local/bin/claude ...               │
│  │   │   └── pane p_def456  → PTY → /bin/zsh -l                             │
│  │   └── [project: my-app]                                                   │
│  │       └── pane p_ghi789  → PTY → codex ...                               │
│  ├── sessions.Store  ~/.config/reck/sessions/<project>.json                 │
│  ├── hooks (Claude Code lifecycle shims)                                     │
│  └── stoplight.Runner (pane-activity state machine)                         │
└───────────────────┬─────────────────────────────────────────────────────────┘
                    │
          HTTP control plane  (REST: project CRUD, pane create/delete,
                    │          sessions, stoplight snapshot)
          WS stream plane     (per-pane: PTY I/O + resize + stoplight events)
          hook POST-back       (loopback-exempt: /panes/:id/agent-event)
                    │
        tailnet (station mode) or loopback (local mode)
                    │
┌───────────────────┴─────────────────────────────────────────────────────────┐
│  SATELLITE (laptop)                                                           │
│                                                                               │
│  Reck Satellite (Electron app)                                               │
│  ├── main process  (Node/Electron)                                           │
│  │   └── spawns daemon child in local mode (127.0.0.1:7315)                 │
│  └── renderer process                                                        │
│      ├── shared-renderer  (typed HTTP client + PTY WS wrapper + xterm.js)  │
│      └── UI  (project rail, pane tabs, stoplight)                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Component Details

### `reck-stationd` (Go daemon)

Entry point: `daemon/cmd/reck-stationd/main.go`

Internal packages under `daemon/internal/`:

| Package | Responsibility |
|---------|----------------|
| `config` | Load/validate `projects.toml`, `ManagedProjectsRoot`, token resolution |
| `pty` | `Manager` (project/pane registry), `Pane` (PTY lifecycle, ring buffer), `ValidateClaudeExtraArgs` |
| `agent` | Per-kind adapters: claude, codex, shell. `BuildSpawn` argv construction, preamble |
| `sessions` | Persist session/slot UUIDs to `~/.config/reck/sessions/<project>.json` |
| `http` | Chi router: REST handlers + WS upgrade |
| `ws` | WebSocket per-pane stream (input, output, resize, stoplight, exit) |
| `hooks` | Install/uninstall Claude Code lifecycle hook shims into `~/.claude/settings.json` |
| `stoplight` | Background runner — classifies pane output activity into gray/orange/green/red |
| `events` | Append-only in-memory event log per pane (lifecycle hook events) |
| `httpx` | Shared HTTP helpers (body decode, size caps) |

### Reck Satellite (Electron app)

Source: `satellite/`

Two run modes — see [`concepts/modes.md`](./concepts/modes.md):

- **Local**: Electron main process spawns `reck-stationd` as a child on `127.0.0.1:7315`.
- **Station**: connects to a remote daemon over Tailscale at `<hostname>:7315`.

The renderer uses `client-core/` — a framework-free browser library with a typed HTTP client, a PTY WebSocket wrapper, and an xterm.js pane component. No Electron APIs inside, so the same library can power non-Electron clients in future.

Note: `pnpm dev` in `satellite` is broken. Use `pnpm dist` to build an app bundle and launch the resulting `.app`.

### `client-core/`

Platform-neutral browser plumbing consumed by the Satellite renderer. Provides:
- Typed fetch client matching the proto types in `proto/`.
- `PtyWS` — WebSocket wrapper that encodes input as `base64` and decodes output from `base64`.
- xterm.js pane wrapper.

### `proto/`

Hand-maintained TypeScript + Go protocol types. Go: `proto.go`. TypeScript: `proto.ts`. Contract: `proto.md`. **Do not drift these files** — all three must agree on every field name and type.

### `ops/`

Station install/uninstall scripts, launchd plist template, satellite mount scripts. See [`../ops/README.md`](../ops/README.md) for the full install guide.

## Process Model

One daemon process manages all projects on the station. Each pane is a PTY-backed child process (`os/exec` + `github.com/creack/pty`). The daemon generates a `p_<12hexchars>` pane ID before exec so the child's `RECK_PANE_ID` env var can be used by hook shims to POST lifecycle events back.

```
reck-stationd
├── goroutine: stoplight.Runner (scans all pane output timestamps every tick)
├── goroutine: mgr.RunLivenessTicker (refreshes was_live in sessions store every 15s)
├── goroutine: httpServer.Serve (chi mux, single listener on :7315)
├── per-pane goroutine: pane.readLoop (PTY master → ring buffer + subscribers)
└── per-pane goroutine: pane.waitLoop (Cmd.Wait → exit-code + callbacks)
```

## Data Flow

### Satellite opens a project

1. Satellite calls `GET /projects/:id` (HTTP, bearer auth if `DAEMON_TOKEN` set).
2. If the project has no live panes, the handler auto-spawns the project's `default_pane` — see [`concepts/behaviors.md`](./concepts/behaviors.md).
3. Response: `ProjectDetail` with the pane list.
4. Satellite opens `ws://.../ws/:project_id/:pane_id`.
5. Daemon sends a `hello` message with the ring-buffer replay (last 64 KB of PTY output) and current stoplight.
6. Subsequent `output` messages stream new PTY bytes (base64). Satellite sends `input` (base64) and `resize` back.

### Hook shim POST-back (stoplight / agent state)

Claude Code hook shims run inside each Claude pane's process. On lifecycle events (pre-tool, stop, attention, etc.) they POST to `http://127.0.0.1:<port>/panes/:pane_id/agent-event`. Loopback requests to this path are exempt from bearer auth. The daemon records the event on the pane and advances its `AgentState` machine. The stoplight runner picks up the state change via `SetStoplight`.

## Deployment Topology

See [`concepts/modes.md`](./concepts/modes.md) for a detailed comparison. Summary:

- **Local mode**: daemon and satellite run on the same machine. Daemon binds `127.0.0.1:7315` (from the `--addr` flag default). No Tailscale needed.
- **Station mode**: daemon runs on the station Mac, bound to `0.0.0.0:7315` (as in the launchd plist template at `ops/eu.verwey.reck-stationd.plist.tmpl`). The satellite connects over Tailscale. Projects are accessible via the sshfs mount managed by `ops/install-satellite.sh`.

## What Runs Where

| Component | Runs on |
|-----------|---------|
| `reck-stationd` daemon | station Mac |
| PTY children (claude, zsh, codex panes) | station Mac |
| Claude Code hook shims | station Mac (inside each claude pane) |
| Reck Satellite (Electron app) | laptop |
| xterm.js rendering | laptop (renderer process) |
| sshfs mount of station projects | laptop (via `install-satellite.sh`) |
