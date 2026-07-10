# Troubleshooting

Each entry: symptom, root cause, and where to look or what to do.

---

## Satellite can't connect to daemon

**Symptom:** The satellite shows a connection error or spinner on launch; HTTP calls to the daemon time out or return 401.

**Causes and checks:**

- **Daemon not running.** On the station: `launchctl print gui/$(id -u)/eu.verwey.reck-stationd`. If it shows `state = not running`, check the log at `/var/log/reck-stationd.log` for the crash reason. Restart: `launchctl kickstart -k gui/$(id -u)/eu.verwey.reck-stationd`.
- **Token mismatch.** The satellite's configured token doesn't match `/etc/reck-stationd/token` on the station. Copy the token from the station: `sudo cat /etc/reck-stationd/token`. Re-enter it in the satellite's settings dialog. See [concepts/auth.md](./concepts/auth.md).
- **Wrong URL.** In station mode, verify the URL includes the correct Tailscale hostname and port `:7315`. In local mode, the daemon should be on `127.0.0.1:7315`.
- **Tailscale not up.** In station mode, verify Tailscale is connected on both the laptop and station: `tailscale status`.
- **FileVault cold-boot.** If the station was recently rebooted with FileVault enabled, the daemon won't run until someone logs in interactively. See [operations.md#filevault-cold-boot-window](./operations.md#filevault-cold-boot-window).

---

## Pane output is stale or frozen

**Symptom:** A pane's terminal shows old output and doesn't respond; the stoplight stays fixed.

**Cause:** The daemon likely crashed and restarted (or the WebSocket connection dropped). The PTY session is gone; what you see is the replay buffer from the last `hello` message.

**What to do:** Check the stoplight in the satellite UI for the pane — a red stoplight means the daemon saw activity requiring attention; gray means idle or disconnected. Reconnect the WebSocket (close and reopen the pane tab) to get a fresh `hello`. If the pane process exited, spawn a new one. See [concepts/stoplight.md](./concepts/stoplight.md) and [concepts/sessions.md](./concepts/sessions.md) for restore semantics.

---

## Stoplight stuck gray

**Symptom:** All panes show a gray stoplight indefinitely, even during active Claude Code sessions.

**Cause:** The Claude Code hook shims are not installed or not firing. The stoplight falls back to a byte-flow heuristic when no hook events arrive, but gray is the initial state and the heuristic may not have triggered yet. More likely, `reck-hook-v1` marker is absent from `~/.claude/settings.json` on the station.

**What to check:** On the station, run:

```bash
grep reck-hook-v1 ~/.claude/settings.json
```

If nothing is returned, the hooks are not installed. Re-run `install-station.sh` or run the daemon once to trigger auto-install (it's idempotent). Alternatively, run the daemon with `--install-hooks` flag to install hooks and exit.

See [concepts/hook-shims.md](./concepts/hook-shims.md) for the full hook-shim mechanism.

---

## Restored shell pane ignores `projects.toml` change

**Symptom:** You updated a project's `shell` field in `projects.toml` and restarted the daemon, but a restored shell pane still uses the old shell.

**Cause:** Shell pane restore replays the exact `argv` captured at the original `CreatePane` call — the project's current shell config is not consulted on restore. This is intentional to preserve the environment the user had when they originally opened the pane.

**Fix:** Delete the old pane and create a new shell pane; the new spawn picks up the current `projects.toml` shell configuration.

See [concepts/sessions.md](./concepts/sessions.md) and [concepts/behaviors.md](./concepts/behaviors.md).

---

## Project in `projects.toml` not visible in satellite

**Symptom:** You added a project to `projects.toml`, reloaded the daemon, but the project doesn't appear in the satellite's project list.

**Cause:** The daemon silently skips invalid `projects.toml` entries on load. Common reasons: `cwd` doesn't exist, duplicate `id`, or malformed TOML.

**What to check:** Inspect the daemon log for load warnings:

```bash
tail -100 /var/log/reck-stationd.log | grep -i "warn\|error\|config"
```

Verify the `cwd` path exists on the station. Each project needs a unique `id`, a `name`, and an existing `cwd`. See [concepts/projects.md](./concepts/projects.md) and [concepts/behaviors.md](./concepts/behaviors.md).

---

## Local daemon still running after satellite quit

**Symptom:** In local mode (satellite spawns a daemon child on `127.0.0.1:7315`), quitting the satellite leaves the daemon process running.

**Cause:** This is intentional. The local-mode daemon is a child process, but the satellite does not SIGTERM it on quit in order to preserve pane state across satellite restarts.

**Fix:** Kill manually when you want it gone:

```bash
pkill reck-stationd
```

Or relaunch the satellite — it will reattach to the running daemon or start a new one. See [concepts/modes.md](./concepts/modes.md) and [concepts/behaviors.md](./concepts/behaviors.md).

---

## `pnpm dev` infinite error loop

**Symptom:** Running `pnpm dev` in `satellite` produces a cascade of errors and never starts the app.

**Cause:** The concurrent vite + Electron dev-server flow is broken and has been since the initial V2 release. It is not a transient issue.

**Fix:** Build a real app bundle and launch that:

```bash
cd satellite && pnpm dist
open "release/mac-arm64/Reck Connect Satellite.app"
```

`pnpm typecheck`, `pnpm test`, and `pnpm build` all work fine for static verification. Only `pnpm dev` is broken. See [development.md](./development.md).

---

## `.DS_Store` files appearing in station project tree

**Symptom:** `.DS_Store` and `._.DS_Store` files accumulate under `/Users/reck-connect/projects/` on the station, despite the sshfs mount using `-o noappledouble`.

**Cause:** The `noappledouble` option suppresses `.AppleDouble` resource-fork directories, but Finder writes `.DS_Store` files via a separate code path that bypasses this flag. macOS continues creating these files on any mounted directory the user browses in Finder.

**Fix:** `install-satellite.sh` now sets the `DSDontWriteNetworkStores` Finder pref + restarts Finder. New installs are clean. For boxes that were installed before this landed, the manual one-liner is the same:

```bash
defaults write com.apple.desktopservices DSDontWriteNetworkStores -bool true
killall Finder
```

**Stragglers:** existing `.DS_Store` files already on the station persist after the pref flip (Finder won't re-create them but won't delete either). One-shot cleanup:

```bash
find /Users/reck-connect/projects -name '.DS_Store' -o -name '._*' -delete
```

See [operations.md#ds_store-leakage-through-sshfs](./operations.md#ds_store-leakage-through-sshfs).

---

## Reboot: mount doesn't reattach

**Symptom:** After rebooting the laptop and logging in, `~/reck/projects/` is empty or unmounted; the watchdog doesn't remount within 60 seconds.

**Cause:** The `RunAtLoad true` path in `eu.verwey.reck-mount` should trigger the watchdog on login, but this full reboot sequence has not been verified on hardware at time of writing. The watchdog itself works correctly on the 60-second tick; the gap is whether launchd fires it promptly after the user session starts.

**Fix:** If the mount doesn't come up, manually trigger the watchdog:

```bash
launchctl kickstart gui/"$UID"/eu.verwey.reck-mount
```

Or re-run the mount section of `install-satellite.sh`. Once the station sentinel file is reachable, the watchdog will mount within 60 seconds.

See [concepts/mount.md](./concepts/mount.md#reboot-remount-not-hardware-tested) and [operations.md#reboot-mount-not-hardware-tested](./operations.md#reboot-mount-not-hardware-tested).

---

## FileVault post-reboot: `/Users/reck-connect` locked

**Symptom:** After rebooting the station, the daemon doesn't start; SSH over Tailscale may not respond at all; `launchctl print` (if reachable) shows the daemon as not loaded.

**Cause:** FileVault encrypts the home directory. A cold boot leaves `/Users/reck-connect` inaccessible until someone supplies the decryption key at the login screen. The LaunchAgent is installed but cannot run until the user logs in graphically.

**Recovery:**
1. Log in to the station interactively (physical keyboard/display, Screen Sharing, or Apple Remote Desktop) to unlock the disk.
2. The daemon starts automatically after login (`RunAtLoad` + `KeepAlive`).

Longer-term options (disable FileVault, configure auto-login) are in `ops/README.md` §2 — "FileVault + headless cold-boot — read this before deploying". See also [operations.md#filevault-cold-boot-window](./operations.md#filevault-cold-boot-window).

---

## openrsync errors (`--info=progress2` not supported)

**Symptom:** An error like `unknown option --info=progress2` appears when adding a new project via the satellite's folder-picker flow.

**Cause:** macOS 14 (Sonoma) and later ship `openrsync` as `/usr/bin/rsync`. openrsync does not implement `--info=progress2`, which the satellite uses for progress reporting during the project copy.

**Fix:** Ensure Homebrew rsync is installed:

```bash
brew install rsync
```

`rsync-copy.ts` prefers `/opt/homebrew/bin/rsync`, then `/usr/local/bin/rsync`, and falls back to bare `rsync` on PATH only if neither Homebrew path exists. `install-satellite.sh` also installs Homebrew rsync as part of the normal setup flow. If the error persists, verify the Homebrew rsync is present: `ls -l /opt/homebrew/bin/rsync`.

See [concepts/mount.md#usrbinrsync-is-openrsync-on-macos-14](./concepts/mount.md#usrbinrsync-is-openrsync-on-macos-14).
