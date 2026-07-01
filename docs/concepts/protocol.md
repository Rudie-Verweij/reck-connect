# Protocol

**The canonical wire contract is [`../../proto/proto.md`](../../proto/proto.md). This page provides narrative orientation; when it disagrees with `proto.md`, `proto.md` wins.**

## Overview

The daemon exposes an HTTP + WebSocket API on port `7315`. All communication between Satellite and daemon uses this surface. TypeScript definitions live in `proto/proto.ts`; Go definitions in `proto/proto.go`. Both are hand-maintained in sync with `proto.md`.

## HTTP endpoints

Base URL: `http://<station-host>:7315`

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| GET | `/health` | Daemon liveness + version + uptime + `codex_available` | Optional |
| GET | `/projects` | List all projects with aggregate stoplight | Optional |
| POST | `/projects` | Register a new project | Required |
| DELETE | `/projects/:id` | Unregister a project | Required |
| GET | `/projects/:id` | Project detail + panes (auto-spawns default pane if empty — see [behaviors](./behaviors.md)) | Optional |
| POST | `/projects/:id/dock` | Opt project into Mission Control | Required |
| POST | `/projects/:id/undock` | Remove project from Mission Control | Required |
| POST | `/projects/:id/rename` | Set project display name | Required |
| POST | `/projects/:id/panes` | Create a new pane | Optional |
| DELETE | `/projects/:id/panes/:pane_id` | Kill and remove a pane | Optional |
| POST | `/projects/:id/panes/:pane_id/rename` | Set pane display name | Optional |
| GET | `/projects/:id/sessions` | List Claude sessions for resume picker (Claude-only; shell rows filtered) | Optional |
| POST | `/projects/:id/sessions/dismiss` | Clear `was_live` on a batch of sessions | Optional |
| GET | `/restore-candidates` | Cross-project live-but-gone panes for restore prompt | Optional |
| POST | `/panes/:pane_id/agent-event` | Lifecycle hook POST from shim (loopback-exempt — see [auth](./auth.md)) | Exempt on loopback |
| GET | `/panes/:pane_id/events` | Debug event log for a pane (not in proto.md — see below) | Optional |
| POST | `/panes/:pane_id/input` | Inject text into pane stdin | Optional |
| GET | `/panes/:pane_id/output` | Tail of replay buffer (`?bytes=N`, default 8192) | Optional |
| GET | `/mission-control/state` | Aggregated MC state across docked projects | Optional |
| GET | `/mission-control/history` | Persisted MC conversation (always empty — see [behaviors](./behaviors.md)) | Optional |
| POST | `/mission-control/chat` | Send message to supervisor pane | Required |
| POST | `/mission-control/reset` | Kill supervisor pane | Required |
| WS | `/ws/:project_id/:pane_id` | Per-pane PTY stream | Required |
| WS | `/ws/mission-control` | MC state change stream | Required |

"Auth required" rows require `Authorization: Bearer <DAEMON_TOKEN>` when the daemon is running with a token. See [auth](./auth.md) for the full model.

## WebSocket upgrade flow

```
Client                                   Daemon
  |                                        |
  |-- GET /ws/<proj>/<pane> ------------->|
  |   Sec-WebSocket-Protocol: reck-bearer.<token>
  |                                        |
  |<-- 101 Switching Protocols -----------|
  |    Sec-WebSocket-Protocol: reck-bearer.<token>  (echoed back)
  |                                        |
  |<-- {"type":"hello", ...} -------------|   replay buffer
  |                                        |
  |<-- {"type":"output", ...} ------------|   PTY bytes (continuous)
  |<-- {"type":"status", ...} ------------|   stoplight changes
  |<-- {"type":"exit", ...} --------------|   on pane exit
  |                                        |
  |-- {"type":"input", ...} ------------->|   user keystrokes
  |-- {"type":"resize", ...} ------------>|   terminal resize
```

### Bearer via Sec-WebSocket-Protocol — NOT query string

Browsers cannot set the `Authorization` header on `new WebSocket(...)` calls. The previous `?token=<...>` query-string approach was removed because query strings appear in access logs, browser history, `Referer` headers, and crash reports.

The bearer is now carried as a `Sec-WebSocket-Protocol` subprotocol of the form `reck-bearer.<token>`. The server validates the token in `authMiddleware` (`daemon/internal/http/router.go:extractWSBearer`) and echoes the subprotocol back in the 101 response — if the server doesn't echo an offered subprotocol, browsers abort the upgrade. Native clients (Go, curl) may still use `Authorization: Bearer <token>` directly.

See `daemon/internal/http/router.go:WSBearerSubprotocol` and `daemon/internal/ws/handler.go` for the implementation.

## WebSocket message types

All message bodies are JSON. The `type` field discriminates the shape.

### Server → client

| Type | Fields | Notes |
|------|--------|-------|
| `hello` | `replay: string`, `cols: number`, `rows: number`, `stoplight: Stoplight` | Sent once on upgrade |
| `output` | `data: string` | Base64-encoded PTY bytes |
| `status` | `stoplight: Stoplight` | Stoplight changed |
| `exit` | `code: number` | Pane exited |
| `error` | `msg: string` | Daemon-side error |

### Client → server

| Type | Fields | Notes |
|------|--------|-------|
| `input` | `data: string` | Base64-encoded bytes to write to PTY |
| `resize` | `cols: number`, `rows: number` | Terminal resize |

## Replay buffer on `hello`

On WebSocket upgrade the daemon sends a `hello` message whose `replay` field contains the last N bytes of the pane's PTY output, base64-encoded. The replay size is 64 KB (constant in `daemon/internal/pty/pane.go:newReplayBuffer(64 * 1024)`).

## Base64 encoding

PTY output is arbitrary bytes (escape sequences, binary control codes). All `data` fields in `output` and `input` messages are base64-encoded standard encoding (`encoding/base64.StdEncoding`) for binary-safe transport over the JSON text-mode WebSocket connection.

## Debug / unlisted endpoints

These endpoints exist in the router but are not documented in `proto.md`:

### GET `/panes/:pane_id/events`

Returns the in-memory event log for a pane. Useful for debugging hook wiring — you can confirm which lifecycle events the daemon has received and what `agent_state` they drove.

Response shape:
```json
{
  "pane_id": "p_...",
  "agent_state": "idle",
  "count": 3,
  "events": [...]
}
```

Source: `daemon/internal/http/router.go:handlePaneEvents`

## Known drift: `?bytes=` vs `?lines=`

`GET /panes/:pane_id/output` accepts a `?bytes=N` query parameter (default 8192, max 131072). The supervisor's system prompt template in `daemon/internal/supervisor/prompt.go` still documents the endpoint as:

```
/panes/<pane_id>/output?lines=200
```

The `?lines=` parameter does not exist in the handler; only `?bytes=` is parsed. The system prompt is incorrect. This means the supervisor agent, when following the documented curl example verbatim, silently falls back to the 8192-byte default. Recommend opening an issue to update the system prompt template.

Source: `daemon/internal/http/router.go:handlePaneOutput` (implements `?bytes=`), `daemon/internal/supervisor/prompt.go` (documents `?lines=`).
