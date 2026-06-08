# Mission Control

## What it is

Mission Control is an aggregated view across multiple projects. It consists of:

1. **A supervisor pane** — a hidden Claude Code instance running in a reserved meta-project (`__reck_supervisor__`). The supervisor has a system prompt that tells it to monitor docked projects and help orchestrate work.
2. **An HTTP/WS surface** — endpoints that expose aggregated state across docked projects and relay chat to the supervisor pane.
3. **Alert injection** — the daemon injects `[reck]` lines into the supervisor's stdin when docked project states change (pane goes attention, idle, red).

## Docking

A project must be "docked" to appear in Mission Control. Docking is a per-project flag persisted in `projects.toml`. The supervisor token's scope is enforced live: revoking docked status (`POST /projects/:id/undock`) immediately removes the supervisor's access to that project.

Only the main actor (`DAEMON_TOKEN`) can dock or undock projects — the supervisor cannot widen its own scope.

## Meta-project

The supervisor pane lives in a hidden meta-project with ID `__reck_supervisor__`. This project:

- Is registered in-memory only (not in `projects.toml`).
- Is excluded from `GET /projects` and the project rail.
- Has its cwd in a scratch directory under `$XDG_STATE_HOME/reck/supervisor` (or `~/.local/state/reck/supervisor`).
- Has its preamble set fresh on every supervisor spawn (so system-prompt changes take effect without a daemon restart).

Source: `daemon/internal/supervisor/controller.go:SupervisorProjectID`.

## Separate supervisor bearer

The supervisor pane authenticates its own HTTP calls back to the daemon with a **separate bearer token**, not the main `DAEMON_TOKEN`. This token is:

- Generated in-memory at `Controller` construction (`crypto/rand`, 32 bytes).
- Never persisted — rotates on daemon restart.
- Injected into the supervisor pane's environment as `RECK_SUPERVISOR_TOKEN`.
- Referenced in the supervisor's system prompt as `$RECK_SUPERVISOR_TOKEN` in curl examples.

The supervisor token narrows scope to docked projects and the meta-project. If the supervisor pane were compromised, it could not access or modify non-docked projects.

See [auth.md](./auth.md) for the full auth model.

## HTTP endpoints

All Mission Control endpoints are only registered when Mission Control is enabled (i.e. when a `Controller` is wired into the router).

| Method | Path | Purpose | Supervisor actor |
|--------|------|---------|-----------------|
| GET | `/mission-control/state` | Aggregated cards for docked projects | Allowed (read-only) |
| GET | `/mission-control/history` | Conversation history (always empty — see below) | Forbidden |
| POST | `/mission-control/chat` | Send message to supervisor pane | Forbidden |
| POST | `/mission-control/reset` | Kill supervisor pane | Forbidden |
| WS | `/ws/mission-control` | Streaming state snapshots | Forbidden |

The supervisor agent can call `GET /mission-control/state` with its own token (read-only access to the same data it would reconstruct from `/projects` calls). Write-side endpoints (chat, reset, history, WS) are forbidden to the supervisor — the agent must not chat with itself or reset itself via the API.

Source: `daemon/internal/http/router.go:handleMCState` (allows supervisor), `handleMCHistory`, `handleMCChat`, `handleMCReset`, `handleMCWS` (all forbid supervisor).

## WebSocket `/ws/mission-control`

Streams `MCStateMessage` snapshots (`{"type": "state", "state": MissionControlStateResponse}`) whenever the daemon's state changes (dock/undock, pane state transitions). Sends an initial snapshot on connect.

## Mission Control state

A `MissionControlStateResponse` contains:

```ts
interface MissionControlStateResponse {
  cards: MissionControlCard[];     // one per docked project
  supervisor_online: boolean;
}

interface MissionControlCard {
  project_id: string;
  project_name: string;
  cwd: string;
  stoplight: Stoplight;
  pane_count: number;
  panes: MissionControlPane[];
}

interface MissionControlPane {
  pane_id: string;
  kind: PaneKind;
  agent_state: AgentState;
  stoplight: Stoplight;
  session_name?: string;
}
```

## Intentional behavior: history is always empty

`GET /mission-control/history` always returns `{"messages": []}`. The supervisor's conversation lives inside its Claude Code pane's own session (stored as JSONL transcripts by Claude Code, accessible via `--resume`). The daemon does not maintain a separate message store.

This is deliberate — the conversation history is owned by Claude Code's session persistence, not by the daemon. The endpoint exists for protocol completeness so the Satellite can bind the surface without a 404.

Source: `daemon/internal/supervisor/http.go:ServeHistory`.

See [behaviors.md](./behaviors.md) for this and other non-obvious runtime behaviors.

## Alert injection

When docked project states change (`Manager.OnStateChange` fires), the supervisor's alert dispatcher computes a diff and injects `[reck]` lines into the supervisor pane's stdin:

```
[reck] <project name> — <pane kind> pane <short id>: <what happened>
```

Examples:
```
[reck] orchard — claude pane 3af4c1: needs attention
[reck] birch — claude pane 91bcd2: task done
[reck] pine — claude pane fe02d7: red / error
```

The supervisor's system prompt tells it how to respond to these signals (summarize, fetch output, surface to user).

## Supervisor lifecycle

- The supervisor pane is NOT auto-started at daemon boot. The user starts it from the Satellite MC view (which calls `POST /mission-control/chat`, which calls `StartSupervisor` on demand).
- `POST /mission-control/reset` kills the supervisor pane. The next chat call spawns a fresh one.
- A race condition in concurrent `StartSupervisor` calls is addressed by a singleflight gate (`startGate` + `startInFlight` channel). Previously, two concurrent callers could both observe "no pane" and each spawn a supervisor, leaving one untracked with supervisor credentials.

Source: `daemon/internal/supervisor/controller.go:StartSupervisor`, `doStartSupervisor`.
