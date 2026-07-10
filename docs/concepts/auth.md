# Auth

## Overview

The daemon supports two modes:

1. **No token** — daemon started without `DAEMON_TOKEN` set. All requests pass without authentication. Used in local development only.
2. **Bearer token** — `DAEMON_TOKEN` is set. Every request must carry `Authorization: Bearer <token>` except for the loopback exemption described below.

## DAEMON_TOKEN

`DAEMON_TOKEN` is a random 64-char hex string generated at install time by `ops/install-station.sh` using `openssl rand -hex 32`.

**Current storage location:** `/etc/reck-stationd/token`, mode `0600`, owned `reck-connect:staff`. The daemon reads this file at startup and exports the value as the `DAEMON_TOKEN` environment variable for its own process.

**Historical note:** older installs stored `DAEMON_TOKEN` directly inside the launchd plist's `EnvironmentVariables` key. That made the token world-readable via `launchctl print` and the plist file itself. A later release migrated the token to `/etc/reck-stationd/token`. The install script detects the old location and promotes the value automatically.

## Bearer header (HTTP)

```http
Authorization: Bearer <DAEMON_TOKEN>
```

Required on all requests when the daemon is running with a token, except where the loopback exemption applies.

## WebSocket auth via Sec-WebSocket-Protocol

Browsers cannot set `Authorization` headers on WebSocket upgrades. The bearer is instead carried as a `Sec-WebSocket-Protocol` subprotocol:

```
Sec-WebSocket-Protocol: reck-bearer.<token>
```

The server echoes this subprotocol back in the 101 response. Omitting the echo causes browsers to abort the upgrade with a subprotocol-mismatch error.

For full detail on the WebSocket upgrade flow see [protocol.md](./protocol.md).

Native clients (Go, curl) may use the standard `Authorization: Bearer <token>` header on WebSocket upgrades instead.

## Loopback exemption

`POST /panes/:pane_id/agent-event` is bearer-exempt when the request originates from a loopback address (`127.0.0.1`, `::1`, or IPv4-mapped `::ffff:127.0.0.1`).

**Why:** Claude Code lifecycle hook shims run inside pane child processes and need to POST events back to the daemon. Injecting `DAEMON_TOKEN` into every pane's environment would expose it to any user code running in that pane (npm scripts, shell, Claude's own tool calls). The loopback exemption lets the shim operate without the token.

**Defense-in-depth:** the shim also sends `?project_id=<id>` and the daemon validates that the declared project matches the pane's registered project. This prevents local processes from forging events for panes in other projects via brute-force pane ID enumeration.

Remote callers reaching the daemon over Tailscale still require the bearer even for `/panes/:pane_id/agent-event`.

Source: `daemon/internal/http/router.go:isAgentEventPath`, `isLoopbackAddr`, `authMiddleware`.

## Token rotation

To rotate `DAEMON_TOKEN`:

1. Generate a new token: `openssl rand -hex 32`
2. Write it to `/etc/reck-stationd/token` as `reck-connect:staff` mode `0600`.
3. Restart the daemon: `launchctl kickstart -k gui/$(id -u)/eu.verwey.reck-stationd`
4. Update the Satellite's saved token configuration to match.

See [../operations.md](../operations.md) for the full install/uninstall impact on the system.

## Actor model

The auth middleware tags each authenticated request with an actor label on the request context:

| Actor | How authenticated | Scope |
|-------|------------------|-------|
| `"main"` | `DAEMON_TOKEN` | Full access to all endpoints |
| `""` (empty) | No token set | Full access — only used when `DAEMON_TOKEN` is unset (e.g. local mode on loopback) |

Handlers read the actor via `ActorFromRequest(r)` and enforce scope restrictions at the handler level (not in the auth middleware).
