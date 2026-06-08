# Operations

**The canonical operations manual is [`../ops/README.md`](../ops/README.md). This page maps common ops tasks to that manual and adds cross-cutting concerns spanning multiple subsystems.**

## Task reference

| Task | Where to go |
|---|---|
| Install station daemon | `ops/README.md` §2 — runs `./install-station.sh` as `reck-connect` |
| Install satellite mount | `ops/README.md` §4 — runs `./install-satellite.sh` on the laptop |
| Manage `projects.toml` | `ops/README.md` §3 — edit `~/.config/reck/projects.toml`; `kickstart -k` to reload |
| Rotate `DAEMON_TOKEN` | `ops/README.md` §2 — edit `/etc/reck-stationd/token`, then `kickstart -k`; see also [concepts/auth.md](./concepts/auth.md) |
| Service status / restart | `ops/README.md` §6 — `launchctl print`, `kickstart -k`, `bootout`, `bootstrap` |
| Binary-only redeploy | `ops/README.md` §8 — build on station, swap binary, `kickstart -k` |
| Uninstall station | `ops/uninstall-station.sh` (canonical); `ops/README.md` §9 for manual steps |
| Uninstall satellite | `ops/uninstall-satellite.sh` |

## Log locations

### Station daemon log

**Path:** `/var/log/reck-stationd.log`

Daemon stdout and stderr both land here (set by `StandardOutPath` / `StandardErrorPath` in `eu.verwey.reck-stationd.plist.tmpl`). The log is JSON-structured (`slog.NewJSONHandler`).

```bash
tail -f /var/log/reck-stationd.log
```

**No automatic rotation is in place.** `newsyslog` cannot rotate this file cleanly because launchd opens the `StandardOutPath` fd at job start and passes it to the child — a rename+recreate cycle leaves the daemon writing to the rotated file until it restarts. Real rotation requires daemon-side `SIGHUP` handling to reopen the fd, plus a pidfile. Tracked in `notes/2026-04-23-leftovers-plan/`. In the meantime, truncate manually:

```bash
sudo truncate -s 0 /var/log/reck-stationd.log
```

### Mount watchdog log (laptop)

**Path:** `~/Library/Logs/reck-stationd/mount.log`

The `eu.verwey.reck-mount` LaunchAgent writes both stdout and stderr here (substituted from `__HOME__` in the plist template by `install-satellite.sh`). Per-user (directory is mode 0700) and survives reboots.

A secondary file `~/Library/Logs/reck-stationd/mount-sshfs.err` captures raw sshfs stderr on each failed mount attempt; overwritten each tick.

```bash
tail -f ~/Library/Logs/reck-stationd/mount.log
```

### Satellite app log

The Electron app writes to the standard macOS location:

```
~/Library/Logs/reck-satellite/
```

Access via Console.app or `tail -f ~/Library/Logs/reck-satellite/main.log`.

## Cross-cutting concerns

### Reboot-mount not hardware-tested

The `eu.verwey.reck-mount` LaunchAgent has `RunAtLoad true` and `StartInterval 60`, which should remount `~/reck/projects/` after login on reboot. This path uses the same watchdog primitives as the 60-second liveness loop (which has been tested), but the full reboot sequence — laptop shuts down, restarts, user logs in, LaunchAgent fires — has not been explicitly verified on hardware. Low risk; confirm on the next organic reboot.

### `.DS_Store` leakage through sshfs

The `sshfs` mount uses `-o noappledouble` to suppress `.AppleDouble` resource-fork directories, but Finder writes `.DS_Store` and `._.DS_Store` files via a separate code path that bypasses the flag. Fix:

`install-satellite.sh` now sets `DSDontWriteNetworkStores` and restarts Finder so the pref takes effect immediately. New satellite installs are clean from the first browse. Pre-existing `.DS_Store` files already on the station persist after the pref flip — clean them up once with:

```bash
find /Users/reck-connect/projects -name '.DS_Store' -o -name '._*' -delete
```

### Station Mac housekeeping (graphical login + sleep)

`reck-stationd` is a per-user LaunchAgent in Aqua scope. Two practical
consequences for the station Mac that hosts it:

**Keep `reck-connect` graphically logged in.** The daemon stops the
moment the Aqua session ends. Logging out of `reck-connect` (or letting
the Mac shut down without auto-login) takes the station offline until
someone graphically logs back in. Fast User Switching back to your
admin account is fine — that suspends the admin session but leaves
`reck-connect`'s session running. What you must avoid is fully logging
out of `reck-connect`.

**Disable display + system sleep on the station.** System Settings →
Energy Saver (or Battery on laptops): set **Prevent automatic sleeping
when the display is off** to ON, and set the display sleep timeout to
*Never* if the station is a dedicated host. The daemon survives display
sleep but goes unreachable if the system itself sleeps; on Apple
Silicon, Power Nap behaviour is inconsistent enough that "never sleep"
is the safer default for a station Mac.

If you do want the station Mac to be useful for other things, the
minimum is: **Wake for network access** ON and system-sleep timeout
generous enough that idle satellite connections won't push the Mac to
sleep mid-session.

### FileVault cold-boot window

If the station has FileVault enabled (macOS default since 10.14), a cold boot leaves `/Users/reck-connect` locked until someone logs in interactively. The LaunchAgent is installed but won't run until the user logs in graphically (the agent is in Aqua scope, so it needs an active GUI session). The station appears dead from the network — Tailscale may not even respond until after unlock.

Full recovery options (disable FileVault, configure auto-login, or accept manual intervention) are in `ops/README.md` §2 under "FileVault + headless cold-boot". After login the daemon picks up automatically via `RunAtLoad` + `KeepAlive`.

### Log rotation incomplete

As noted in the [daemon log section](#station-daemon-log) above, log rotation is not yet implemented. See `ops/README.md` §5 for the technical explanation.
