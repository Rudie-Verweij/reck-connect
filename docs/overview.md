# Overview

## The problem

Developing on a powerful Mac ("station") from a laptop is awkward. Options are: SSH + tmux (blind to agent state, no GUI), remote desktop (laggy, ties up a screen), or syncing code (complicated, slow). Reck Connect takes a different approach: the station runs a daemon that owns the PTY processes; the laptop runs a thin Electron app that renders them over a local or Tailscale connection. No sync. No remote desktop. The code never leaves the station.

## Mental model

```
Laptop (satellite)                        Mac Studio (station)
┌──────────────────────────┐              ┌───────────────────────────────┐
│  Reck Connect Satellite  │              │  reck-stationd (Go daemon)    │
│  (Electron app)          │              │                               │
│                          │  Tailscale   │  ┌──────────────────────┐    │
│  xterm.js pane ◄─────────┼──WS──────────┼──│ PTY pane (claude)    │    │
│  xterm.js pane ◄─────────┼──WS──────────┼──│ PTY pane (shell)     │    │
│                          │  :7315       │  │ PTY pane (codex)     │    │
│  stoplight UI            │              │  └──────────────────────┘    │
│  project rail            │  REST        │                               │
│                          │◄─────────────┼──/projects, /health, …        │
└──────────────────────────┘              │                               │
                                          │  ~/.claude/settings.json      │
                                          │  (hook shims installed        │
                                          │   at daemon startup)          │
                                          └───────────────────────────────┘
```

The satellite is a display terminal with project management UI. The daemon owns all process state. If the satellite quits, the daemon — and every running pane — keeps going. The satellite runs in hybrid mode: a local daemon child on `127.0.0.1:7315` plus, optionally, a station daemon over Tailscale on `:7315`.

## Components at a glance

| Component | Path | Role |
|---|---|---|
| `reck-stationd` | `daemon/` | Go HTTP + WebSocket server; spawns and owns PTY panes; installs hook shims |
| Satellite | `satellite/` | Electron desktop app; renders panes via xterm.js; two modes (Local / Station) |
| shared-renderer | `client-core/` | Platform-neutral browser plumbing: typed HTTP client, PTY WebSocket wrapper, xterm.js pane |
| Proto | `proto/` | TypeScript + Go wire types, hand-maintained in parallel |
| Ops | `ops/` | Install/uninstall scripts, launchd plist templates, mount watchdog |

## Where next

- [architecture.md](./architecture.md) — how the daemon and satellite connect in detail
- [getting-started.md](./getting-started.md) — step-by-step setup
