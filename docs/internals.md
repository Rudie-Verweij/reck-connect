# Reck Connect V2

Station/satellite architecture. The daemon (`reck-stationd`) runs on the always-on station Mac, and an Electron app runs on the laptop satellite. Tailscale is the network.

## Layout

- `daemon/` — `reck-stationd`, Go
- `satellite/` — Electron app
- `shared/proto/` — wire protocol types (Go + TS, hand-maintained)
- `ops/` — install scripts, launchd plist, README

## Image paste

Two paths, picked per pane via `Pane.capabilities.clipboard_image`:

- **Chip path (preferred, Claude panes only).** Renderer POSTs the
  raw image to `/panes/:id/clipboard-image`. The daemon writes the
  bytes to `NSPasteboard.general` in-process via cgo (see
  `daemon/internal/macclipboard`), then writes `0x16` (Ctrl+V) into
  the pane PTY. Claude Code creates an `[Image #N]` chip exactly
  like a native paste. Works because the daemon runs as a per-user
  LaunchAgent in the same Aqua session that owns the pasteboard.
- **Fallback path (universal).** Renderer POSTs multipart to
  `/panes/:id/uploads`; daemon writes the file under
  `$TMPDIR/reck-pane-<id>/uploads/`, returns the absolute path; the
  renderer types it into the PTY for the model to `Read()`.

The renderer probes the daemon's per-pane capability flag and tries the
chip path first; on a 503 it silently falls back to the universal path.
Shell panes always take the universal path because writing `0x16` to an
interactive shell would do something unrelated.

## Quickstart (station)

```bash
cd ops
./install-station.sh
```

See `ops/README.md` for the full install steps, including dedicated `reck-connect` user creation.

## Quickstart (laptop)

On your laptop, run `ops/install-satellite.sh` to mount the station's `projects/` directory via FUSE-T + sshfs.

## Escape hatch — using local MCPs against a station project

In station mode, Claude Code panes run on the station and only see the
station's MCPs. Anything bound to the laptop — the user's Chrome, calendar,
Apple Events, screen, microphone, USB hardware — is unreachable from there.

As a deliberate **escape hatch** (not a product feature), you can open a
separate, *local* Claude Code on the satellite against the sshfs mount of the
same project:

```bash
cd ~/reck/projects/<name>
claude
```

This Claude runs with the satellite's `~/.claude/mcp.json`, so it has access
to local MCPs while still editing the same files the station-Claude is
working on.

### WARNING — guaranteed split-brain

Claude Code keys per-project state (session history, todos, compaction,
auto-memory, resumability) by the *encoded cwd* under
`~/.claude/projects/<encoded-cwd>/`. The station path
(`/Users/reck-connect/projects/<name>`) and the satellite mount path
(`~/reck/projects/<name>`) encode to **different** directory keys.

Station-Claude and local-mount-Claude will therefore silently maintain
**disjoint** mental models of the same project. Neither can see the other's
session, and there is no in-product signal that this split is happening.
This is a guarantee, not a risk.

### When this is justified

Ad-hoc, one-off tasks that *must* touch satellite-local resources (browser
MCP, calendar, Apple Events, hardware) and that are **not** part of an
in-progress station-Claude session.

### When it is not

- Anything iterative, or where you expect Claude to "remember" what just
  happened — the split-brain will bite.
- Anything heavy-I/O. The sshfs mount is convenience-grade: the watchdog
  (`ops/reck-mount-watchdog.sh`) polls every 60 s and force-unmounts on
  staleness. Large greps, big builds, file watchers, and `node_modules`
  installs do not belong here.

### Performance caveats

`node_modules`, `dist`, `build`, `.venv`, `target`, `.next`, `.cache` live
only on the station — they are excluded from the satellite mount. Builds,
test runs, and anything that reads/writes thousands of small files should
stay on station-Claude. Use the escape hatch for the *MCP call*, not for
the work around it.

The Satellite app runs in **hybrid mode** by default — both the local
daemon (always available) and the station daemon (when configured) are
live at the same time. This escape hatch is deliberately *outside* the
app: it spawns a separate `claude` process on the satellite's own
filesystem path, which is what you want for one-off MCP-using sessions.
Don't expect a button for it.
