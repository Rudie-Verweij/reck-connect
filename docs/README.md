# Reck Connect — Wiki

Reck Connect is a station/satellite dev environment: a powerful Mac runs `reck-stationd` (the daemon), a laptop runs the Electron satellite app, and every Claude Code pane on the station surfaces agent state back to the satellite in real time. This wiki covers the V2 architecture for humans new to the codebase and for AI agents answering "how does X work?".

---

## Contents

### Onboarding & navigation

| Page | Description |
|---|---|
| [overview.md](./overview.md) | Mental model, ASCII architecture diagram, component list |
| [getting-started.md](./getting-started.md) | Step-by-step setup from zero to first pane |
| [concepts/modes.md](./concepts/modes.md) | Local vs Station mode — what they mean and how they differ |
| [history.md](./history.md) | Why V2 replaced V1; brief V1 summary |
| [reference/glossary.md](./reference/glossary.md) | Alphabetical definitions for every key term |
| [reference/file-map.md](./reference/file-map.md) | "Where does X live?" index by concern |

### Core domain

| Page | Description |
|---|---|
| [architecture.md](./architecture.md) | Deep-dive: daemon, satellite, and how they connect |
| [concepts/panes.md](./concepts/panes.md) | PTY-backed pane lifecycle and kinds |
| [concepts/projects.md](./concepts/projects.md) | projects.toml, project IDs, managed root |
| [concepts/sessions.md](./concepts/sessions.md) | Session persistence, resume, restore candidates |
| [concepts/preamble.md](./concepts/preamble.md) | System-prompt injection into Claude panes |
| [local-daemon-spawn.md](./local-daemon-spawn.md) | Local-mode spawn resilience: typed failure codes, cold-start pre-warm, PATH + token precedence |

### Interfaces & state

| Page | Description |
|---|---|
| [concepts/protocol.md](./concepts/protocol.md) | HTTP + WebSocket wire protocol reference |
| [concepts/auth.md](./concepts/auth.md) | DAEMON_TOKEN, loopback exemption |
| [concepts/stoplight.md](./concepts/stoplight.md) | Per-pane stoplight state machine |
| [concepts/hook-shims.md](./concepts/hook-shims.md) | Claude Code lifecycle hook installation and event flow |
| [concepts/behaviors.md](./concepts/behaviors.md) | Intentional design behaviors and known quirks |

### DevOps & support

| Page | Description |
|---|---|
| [operations.md](./operations.md) | Installing, running, and maintaining the station |
| [concepts/mount.md](./concepts/mount.md) | sshfs mount from satellite to station via Tailscale |
| [development.md](./development.md) | Build commands, test setup, dev workflow |
| [troubleshooting.md](./troubleshooting.md) | Common failure modes and how to diagnose them |

---

## External references

These durable documents are the source of truth for their topics — this wiki links to them rather than duplicating content.

| Document | What lives there |
|---|---|
| [`../docs/internals.md`](../docs/internals.md) | V2 layout, quickstart for station and laptop |
| [`../ops/README.md`](../ops/README.md) | Full station install/uninstall, launchd management, log paths |
| [`../proto/proto.md`](../proto/proto.md) | Complete HTTP + WebSocket wire protocol |
| [`../INSTALL.md`](../INSTALL.md) | End-to-end Claude-driven install runbook |
