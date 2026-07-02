# Linux / Raspberry Pi station

Reck Connect's station daemon (`reck-stationd`) runs on **Linux** as well as
macOS. The Satellite is always a Mac app — only the station side changes. This
page orients you; the full install + troubleshooting reference is
[`ops/README.md` → Linux station](../../ops/README.md#linux-station).

## What's different from a macOS station

Everything that differs lives on the station host. The Satellite, the protocol,
and the project model are identical across both topologies.

| Concern | macOS station | Linux / Pi station |
|---|---|---|
| Service manager | launchd LaunchAgent | `systemd --user` unit + linger |
| Clipboard (image paste) | NSPasteboard (cgo / AppKit) | `xclip` + an Xvfb virtual display (`:99`) |
| Process spawn | cgo `posix_spawn` + TCC disclaim | `os.StartProcess` + `Setsid` (no cgo) |
| Daemon binary | `/usr/local/bin/reck-stationd` | `~/.local/bin/reck-stationd` |
| Projects root | `/Users/reck-connect/projects` | `~/projects` |
| Station user | dedicated `reck-connect` user | the existing system user |
| Package manager | Homebrew | apt |
| Build | native `go build` | `make cross` (`GOOS=linux GOARCH=arm64`, no cgo) |

## Quick start

```bash
git clone https://github.com/mehdigreefhorst/reck-connect.git ~/src/reck-connect
cd ~/src/reck-connect
./ops/install-station-linux.sh        # builds, installs the systemd unit, enables linger
```

Then add the station from the Mac Satellite (tailnet hostname, port `7315`, the
token at `~/.config/reck/token`). Full prerequisites, tunables, and verification
are in [`ops/README.md` → Linux station](../../ops/README.md#linux-station).

## Service management (systemd ↔ launchd)

| Task | Linux (`systemd --user`) | macOS (launchd) |
|---|---|---|
| Status | `systemctl --user status reck-stationd` | `launchctl print gui/$(id -u)/eu.verwey.reck-stationd` |
| Restart | `systemctl --user restart reck-stationd` | `launchctl kickstart -k gui/$(id -u)/eu.verwey.reck-stationd` |
| Stop | `systemctl --user stop reck-stationd` | `launchctl bootout gui/$(id -u)/eu.verwey.reck-stationd` |
| Logs | `journalctl --user -u reck-stationd` | `~/Library/Logs/reck-stationd/` |
| Boot survival | `loginctl enable-linger $USER` | LaunchAgent (automatic) |

## Clipboard / image paste

Pasting an image into a Claude pane needs the OS clipboard. On Linux the daemon
shells out to `xclip`, which needs a reachable X display. On a headless Pi the
installer provisions `reck-xvfb.service` — a virtual framebuffer on `$DISPLAY=:99`
— so chip-paste works with no GUI session. The capability is probed once at daemon
startup: if `xclip` or `$DISPLAY` is missing, panes report `ClipboardImage:false`
and the Satellite falls back to the `/uploads` path-typing route. Fixing it needs
a daemon restart. Skip the whole backend with `RECK_SKIP_CLIPBOARD=1`.

## Won't work on the Linux station

- macOS Accessibility / AppleEvents grants (`mcp__computer-use__*`) — TCC is a
  macOS concept with no Linux equivalent.
- FUSE-T / FSKit specifics — those are **Satellite-side** (the Mac mounts the
  station), so they're unchanged regardless of station OS.

## See also

- [`ops/README.md` → Linux station](../../ops/README.md#linux-station) — install, tunables, troubleshooting
- [`modes.md`](modes.md) — station vs local daemon posture
- [`mount.md`](mount.md) — how the Mac Satellite mounts the station
