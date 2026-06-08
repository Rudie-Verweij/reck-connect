# Local, Station, and Hybrid

The satellite has two daemon connections it can manage independently — a
**local** daemon (spawned as a child process on the satellite itself)
and a **station** daemon (running on a remote always-on Mac, reached over
Tailscale). Both can be enabled at the same time. The default for fresh
installs is **hybrid**: local always available, station configured if the
user has a station to connect to.

The mode is persisted in
`~/Library/Application Support/Reck Connect Satellite/config/settings.json`
under the key `"settings"`:

```json
{
  "station": { "enabled": true, "url": "http://your-station:7315" },
  "local":   { "enabled": true, "port": 7315, "autoStart": true }
}
```

The bearer token for the station daemon lives separately under
`"station.token"`, encrypted via Electron's `safeStorage`.

## Local

The satellite spawns `reck-stationd` as a child process via `startDaemon()`
in `satellite/main/daemon-spawn.ts`. The daemon listens on
`127.0.0.1:7315` (or whatever `local.port` is set to). No bearer token is
configured; the local daemon runs unauthenticated (the router's
`authMiddleware` passes all requests when `DAEMON_TOKEN` is empty).

The satellite resolves the daemon binary from a fixed search path (see
[getting-started.md](../getting-started.md) §2). If the binary is not
found, a dialog is shown at startup and the daemon is not launched.

Local on its own is enough when you want to run everything on a single
Mac without Tailscale.

## Station

The satellite connects to an existing `reck-stationd` running on a remote
Mac over Tailscale. The user supplies a `stationUrl` (e.g.
`http://your-station:7315`) and a daemon token. The satellite sends
`Authorization: Bearer <token>` on every HTTP request, and
`reck-bearer.<token>` as a `Sec-WebSocket-Protocol` subprotocol on
WebSocket upgrades (browsers cannot set `Authorization` on
`new WebSocket(...)`).

Use Station to keep a powerful Mac doing the heavy lifting while
controlling it from a laptop.

## Hybrid (default)

Both daemons are enabled. Each project lives on exactly one host — the
rail tags every project card with which daemon owns its panes — but the
two co-exist in the same window. Switching focus between a local project
and a station project is a click; no daemon restart, no app reload.

This is what `install-satellite.sh --write-settings` configures on first
launch when a station URL is supplied; the local side gets `enabled: true,
autoStart: true` so the satellite is useful immediately even before the
station finishes coming online.

## Adjusting

**File → Preferences…** opens the settings panel. Toggle the local or
station blocks independently; the satellite reconciles open panes against
whichever daemons are still enabled.

To force the satellite back to the first-launch mode-chooser (clears
`settings` so the next start renders the welcome flow), delete the
`settings.json` file.

## Intentional: daemon survives satellite quit

The `will-quit` handler in `satellite/main/daemon-spawn.ts` is
explicitly empty:

```typescript
app.on("will-quit", () => {
  /* daemon is intentionally left running */
});
```

Quitting the satellite **does not kill the local daemon**. The daemon and
all its panes keep running. To stop the local daemon explicitly:
**File → Quit Local Daemon…** (calls `stopDaemon()`, which sends SIGTERM
and waits up to 3 s before SIGKILL). The station daemon is launchd-managed
on the station host and is unaffected by satellite lifecycle.

This is a deliberate design choice: panes (especially long-running Claude
sessions) should not be interrupted by an accidental app quit.

This behavior is also indexed in [concepts/behaviors.md](./behaviors.md).

## Trade-offs

| | Local | Station |
|---|---|---|
| Network required | No | Tailscale |
| Auth | None (loopback only) | Bearer token required |
| Daemon owner | Satellite process | LaunchAgent on station |
| Panes survive app quit | Yes | Yes (daemon independent) |
| Who restarts daemon on crash | Must relaunch satellite | launchd `KeepAlive` |
| Latency | Sub-millisecond | Tailscale RTT |
