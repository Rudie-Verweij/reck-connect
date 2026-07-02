# V2 — Station & Satellite Ops

This directory holds everything needed to install Reck Connect V2 on the station and to mount its projects directory from a laptop Satellite over Tailscale + sshfs. The station can run on **macOS** (sections 1–9 below) or **Linux / Raspberry Pi** (see [Linux station](#linux-station)). The Satellite is always a Mac app.

## 1. Create the `reck-connect` macOS user

This is a one-time manual step. V2 runs under a dedicated user for clean isolation from the admin user (`<your-admin-user>`) and the V1 Whisper service user (`<v1-service-user>`).

1. Open **System Settings → Users & Groups → "+"**.
2. Choose **Standard** (not Administrator).
3. Full Name: `Reck Connect`
4. Short Name: `reck-connect`
5. Set a secure password (store in 1Password or keychain).
6. Click **Create User**.
7. Log in once as `reck-connect` to initialize the home directory at `/Users/reck-connect/`.
8. While logged in as `reck-connect`:
   - Install Tailscale (App Store or `brew install tailscale`) — join your tailnet.
   - Install Homebrew if not system-wide: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
   - `gh auth login` (for GitHub PAT-based git access).
9. Create the Claude Code root: `mkdir -p /Users/reck-connect/claude-code/`
10. Clone any projects you want to register under `/Users/reck-connect/claude-code/<project>/`.

## 2. Install the daemon (one command)

As the `reck-connect` user:

```bash
cd /Users/reck-connect/claude-code/Reck-Connect/v2/ops
./install-station.sh
```

This is end-to-end. It will:
- Build `reck-stationd` from source.
- Install the binary to `/usr/local/bin/reck-stationd` (requires sudo for that one step).
- Drop the launchd plist at `~/Library/LaunchAgents/eu.verwey.reck-stationd.plist` — a per-user **LaunchAgent** in Aqua scope, with `ThrottleInterval=30` so a startup-time crash can't trigger a relaunch storm. The agent runs as the `reck-connect` user inside their graphical login session.
- Create `~/.config/reck/{projects.toml,.env}` (copying an example `projects.toml` on first install).
- **Generate a random `DAEMON_TOKEN`** and write it to `~/.config/reck/token` (mode 0600) if one isn't already there. Auth is **mandatory** for the station daemon — bearer token required on every request. The token does *not* live in the launchd plist; `reck-stationd` reads the file at startup.
- `bootout` + `bootstrap` the launchd service so the new plist actually takes effect.
- Verify that `/health` returns `401` without a bearer and `200` with one.
- Print the Satellite config (`Station URL` + `Daemon Token`).

The script is idempotent: re-running it keeps the existing token, just rebuilds and reloads. If an older install has `DAEMON_TOKEN` inside the plist's `EnvironmentVariables` or a token file at the legacy `/etc/reck-stationd/token` path, the installer migrates it forward and strips the legacy locations in the same run.

To rotate the token, either:
- `rm ~/.config/reck/token && ./install-station.sh` (new token generated), or
- Edit `~/.config/reck/token` directly, then `launchctl kickstart -k gui/$(id -u)/eu.verwey.reck-stationd`.

### FileVault + headless cold-boot — read this before deploying

If the station has FileVault enabled (the macOS default since 10.14), a **cold boot leaves the disk locked until somebody logs in interactively**. Because `reck-stationd` runs as a per-user LaunchAgent in Aqua scope, it doesn't even attempt to start until `reck-connect` has logged in graphically — there's no Aqua session to host it. From the network, the station looks dead. From `launchctl print gui/$(id -u)/eu.verwey.reck-stationd` over SSH (if you can even reach it via Tailscale before unlock — usually you can't), the agent shows as not loaded.

This is **the** failure mode for a headless deployment.

Recovery options:

1. **Disable FileVault** for the headless deployment (simplest). System Settings → Privacy & Security → FileVault → Turn Off. Lower-friction, and you get unattended reboot recovery for free. The disk is no longer encrypted at rest, so only do this if the station lives in a physically secure spot and never moves.
2. **Auto-login after restart**. System Settings → Users & Groups → "Automatically log in as: Reck Connect". macOS will usually refuse this while FileVault is on — enabling both together requires the "unlock at boot" mechanism Apple reserves for specific recovery paths, and is brittle across OS upgrades. Workable on a dedicated station but expect to re-verify after each major macOS release.
3. **Accept the cold-boot window**. If reboots are rare and you're in front of the machine when they happen, just walk it through the login screen. The LaunchAgent picks up automatically after login. Least effort, worst for true unattended operation.

After login the LaunchAgent catches up automatically (`RunAtLoad` + `KeepAlive`). The 30 s `ThrottleInterval` paces any retries; you should not see a relaunch storm even if the daemon comes up before some dependency finishes initialising.

A reboot recovery command worth remembering for the SSH-once-it's-up phase: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/eu.verwey.reck-stationd.plist` will re-bootstrap an unloaded daemon without a full re-install.

### macOS Accessibility / AppleEvents permissions for `mcp__computer-use__*`

If a station pane uses `mcp__computer-use__*` (or any other tool that calls AX / AppleEvents APIs through Claude or an MCP server), macOS will gate the call on a TCC permission grant. **Grant Accessibility to `/usr/local/bin/reck-pane-launcher` — NOT to `/usr/local/bin/reck-stationd`.**

`reck-pane-launcher` is a small helper binary the daemon spawns at startup. It exists solely to be the TCC responsible-process for every pane child the daemon would otherwise spawn directly. macOS attributes AX / AppleEvents grants by walking the spawned-process chain back to the nearest non-disclaimed ancestor; `reck-stationd` spawns the helper with `responsibility_spawnattrs_setdisclaim`, which makes the helper its own responsible process. Every subsequent pane (and every MCP child of every pane) is then attributed to the helper.

Why this matters: macOS caches the AX trust set in each process at launch and never re-reads it. If you grant AX to a long-running daemon mid-session, the daemon won't see the grant until it restarts — and restarting `reck-stationd` kills every live pane (and every Claude conversation in them). The helper sidesteps that: granting it AX after the fact still requires a *helper* restart to pick up, but the helper has no live state to lose, so the daemon transparently respawns it without touching panes. The grant survives subsequent daemon redeploys (TCC keys on the binary path) so this is a one-time setup.

To grant:
1. System Settings → Privacy & Security → Accessibility.
2. Click "+", navigate to `/usr/local/bin/reck-pane-launcher`, add it.
3. Toggle it on.
4. `launchctl kickstart -k gui/$(id -u)/eu.verwey.reck-stationd` so the daemon respawns the helper and the helper picks up the grant.

To revoke: remove the entry from System Settings → Privacy & Security → Accessibility. The helper continues running but its AX-gated children will fail until you re-grant.

### Image paste in Aqua-only sessions

A later release retired the per-user `reck-clipboard` LaunchAgent. The daemon now writes images to `NSPasteboard.general` directly via cgo (`internal/macclipboard`) since it runs as a LaunchAgent in the user's Aqua session itself. The pasteboard write only works while the user is actually logged in graphically — a fresh-boot box that hasn't seen a graphical login yet has no Aqua session, no daemon, and therefore no image-paste path. The same FileVault / cold-boot recovery options above (auto-login or manual login) bring everything online together.

## 3. Edit projects.toml

```bash
$EDITOR ~/.config/reck/projects.toml
```

Use the example at `examples/projects.toml` as a starting point. Each project needs a unique `id`, a `name`, and a `cwd` that exists.

For projects.toml changes only (no plist touched), a `kickstart` is enough:

```bash
launchctl kickstart -k gui/$(id -u)/eu.verwey.reck-stationd
```

Plist changes (env vars, args) require re-running `./install-station.sh` so launchd picks them up — `kickstart -k` alone reuses the cached plist and silently ignores edits.

## 4. Laptop setup (Step 2+)

Run `v2/ops/install-satellite.sh` on your laptop. It:

- Builds + installs `~/.local/bin/reck-stationd` (the daemon Satellite
  spawns for Local mode) by delegating to `install-local.sh`. Always
  runs on every install so a stale local binary can't outlive a
  daemon-side feature change (e.g. orphan auto-restore).
- Migrates legacy Electron userData (`layouts_v2`, `projectOrder`,
  `theme`, `claudeLaunchArgs`, `gaze.*`, `railWidth`) from older
  productName dirs (`~/Library/Application Support/reck-satellite/`)
  into the current dir
  (`~/Library/Application Support/reck-connect-satellite/`) without
  clobbering keys already present. Existed for the
  `reck-satellite → reck-connect-satellite` rename — keep extending
  `LEGACY_USERDATA_DIRS` if the package name ever shifts again.
- Installs FUSE-T + sshfs, generates an SSH key, wires a `reck-station`
  alias into `~/.ssh/config`, and registers a LaunchAgent
  (`eu.verwey.reck-mount`) that keeps `~/reck/projects/` mounted from
  the station's `/Users/reck-connect/projects/` via Tailscale.

Interactive step (prints after install): `ssh-copy-id` the key onto the
station so the mount can authenticate without prompting.

Pre-set `STATION_HOST` in the environment to skip the interactive
prompt (useful for scripted installs):

```bash
STATION_HOST=your-station v2/ops/install-satellite.sh
```

The hostname still runs through the same allow-list validator as the
interactive path; a bad value fails loudly either way.

Uninstall: `v2/ops/uninstall-satellite.sh`.

### FUSE-T on macOS 26 (Tahoe) — read this before upgrading

FUSE-T v1.2+ uses **FSKit**, Apple's native filesystem-extension API,
on macOS 26. On macOS 15 and older it uses an NFSv4 loopback server
(`go-nfsv4` helper). The Homebrew cask ships both paths; which one
runs is picked at mount time based on the OS version.

Two situations to know about:

1. **Upgrading macOS 15 → 26 while FUSE-T is installed.** The existing
   fuse-t bits need a refresh to register the FSKit extension. After
   the macOS upgrade, on the laptop:

   ```bash
   brew upgrade --cask fuse-t fuse-t-sshfs
   launchctl bootout  gui/"$UID"/eu.verwey.reck-mount || true
   launchctl bootstrap gui/"$UID" \
     ~/Library/LaunchAgents/eu.verwey.reck-mount.plist
   ```

   macOS 26 will prompt once (System Settings → Privacy & Security →
   Login Items & Extensions) to allow the FSKit extension. Approve
   it; the watchdog will log `sshfs failed (exit 1)` on every 60 s
   tick until you do.

2. **Leftover `go-nfsv4` helpers from before the upgrade.** The
   watchdog (`reck-mount-watchdog.sh`) reaps *orphaned* `go-nfsv4`
   helpers (PPID=1 — their sshfs parent has died) before each
   remount, so a crashed pre-26 mount can't accumulate helpers
   across ticks. Helpers still parented to a live sshfs (e.g. a
   second FUSE-T mount you have running by hand) are left alone.
   On a clean macOS 26 install the block is a no-op — FSKit spawns
   no helper. If `pgrep -u "$UID" -x go-nfsv4` still returns
   something minutes after a remount on 26, the cask didn't pick up
   FSKit — re-run the upgrade steps above.

## 5. Logs

On the **station**:

```bash
tail -f /var/log/reck-stationd.log
```

**No automatic rotation today.** A naive `newsyslog.d` policy doesn't work here: launchd opens `StandardOutPath` once at job start and passes the fd to the child, so newsyslog's rename+recreate cycle would leave the daemon writing to the rotated (gzipped) file forever until restart. Real rotation needs daemon-side `SIGHUP` handling that reopens the log fd plus a pidfile — follow-up. In the meantime, truncate manually when the file gets uncomfortably large:

```bash
sudo truncate -s 0 /var/log/reck-stationd.log
```

On the **laptop** (mount watchdog):

```bash
tail -f ~/Library/Logs/reck-stationd/mount.log
```

## 6. Service management

Run these on the station as the `reck-connect` user — no sudo needed; the
LaunchAgent lives in Aqua scope.

```bash
# Status
launchctl print gui/$(id -u)/eu.verwey.reck-stationd

# Restart (reuses cached plist; fine for binary-only swaps)
launchctl kickstart -k gui/$(id -u)/eu.verwey.reck-stationd

# Stop and unload
launchctl bootout gui/$(id -u)/eu.verwey.reck-stationd

# Reload (e.g. after editing the plist)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/eu.verwey.reck-stationd.plist
```

## 7. Optional: tell Claude panes which satellite is connecting

The daemon splices a short Reck-awareness preamble into every Claude Code pane's system prompt so Claude knows it's running on the station, not on the user's laptop. Two knobs in the launchd plist fine-tune it:

- `RECK_SATELLITE_HINT` — free-form string identifying the laptop, e.g. `"my-laptop"`. When set, the preamble uses it literally (`"The user is operating you remotely from their satellite (my-laptop)."`). Leave empty for the generic "laptop running the Reck Satellite app" fallback.
- `RECK_DISABLE_BASELINE_PREAMBLE` — set to `1` to suppress the baseline entirely; per-project preambles from `projects.toml` still apply. Use this only for debugging / clean-room sessions. Without the baseline, Claude is prone to fabricating browser / calendar / hardware MCP calls it can't actually make from the station.

Edit `eu.verwey.reck-stationd.plist.tmpl` (or the deployed plist at `~/Library/LaunchAgents/eu.verwey.reck-stationd.plist`) and re-run `./install-station.sh` — `EnvironmentVariables` changes require `bootout`+`bootstrap`, which the installer handles; `kickstart -k` alone reuses the cached plist and silently ignores env edits.

## 8. Redeploy after a daemon change

For binary-only updates — no changes to the plist template or env vars — you don't need to re-run `install-station.sh`. Build on the station, swap the binary, kickstart launchd.

From your laptop:

```bash
# Build (non-interactive SSH, so source brew env explicitly for `go`).
ssh reck-connect@your-station '
  eval "$(/opt/homebrew/bin/brew shellenv)" &&
  cd ~/claude-code/Reck-Connect && git pull --ff-only origin main &&
  cd v2 && go build -o /tmp/reck-stationd.new ./daemon/cmd/reck-stationd'

# Install + reload + verify. The `sudo install` step is the only piece
# that needs root → must run interactively (-t) so you can type the
# password; the kickstart + token read happen as the reck-connect user.
ssh -t reck-connect@your-station '
  sudo install -m 0755 /tmp/reck-stationd.new /usr/local/bin/reck-stationd &&
  launchctl kickstart -k gui/$(id -u)/eu.verwey.reck-stationd &&
  sleep 2 &&
  curl -s -o /dev/null -w "no-auth: %{http_code}\n" http://127.0.0.1:7315/health &&
  TOKEN=$(cat ~/.config/reck/token | tr -d "[:space:]") &&
  curl -s -o /dev/null -w "auth:    %{http_code}\n" -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7315/health &&
  rm /tmp/reck-stationd.new'
```

The `tr -d '[:space:]'` matches what `install-station.sh` does internally (`cat "$TOKEN_FILE" | tr -d '[:space:]'`) — strips a trailing newline that would otherwise produce a malformed `Authorization` header.

Expect `no-auth: 401` and `auth: 200`.

Why `kickstart -k` is enough for a binary swap: it re-execs the program at `/usr/local/bin/reck-stationd` while keeping the cached plist — and the daemon reloads its bearer from `/etc/reck-stationd/token` on every startup, so rotations survive without re-running the installer. Re-run `install-station.sh` only when the plist template itself changes (env vars, program args, user/group).

## 9. Uninstall

**Canonical path: `./uninstall-station.sh`**, run as the `reck-connect` user. It removes everything `install-station.sh` placed on the system, in the order needed to avoid launchd respawning the agent mid-uninstall:

1. `bootout` the launchd agent.
2. Remove the plist (`~/Library/LaunchAgents/eu.verwey.reck-stationd.plist`).
3. Remove the binary (`/usr/local/bin/reck-stationd`, requires sudo).
4. Remove the live log (`~/Library/Logs/reck-stationd/reck-stationd.log`).
5. Remove the bearer token at `~/.config/reck/token` and any legacy copy at `/etc/reck-stationd/token` (if present).
6. Remove `~/.config/reck` (`projects.toml` + `.env`).

That leaves the system in the same state as before `install-station.sh` ran. Re-running `./install-station.sh` afterwards genuinely starts from clean state, including a freshly generated `DAEMON_TOKEN`.

If you need to pick commands à la carte (rare — prefer the script for forward compatibility):

```bash
launchctl bootout gui/$(id -u)/eu.verwey.reck-stationd
rm ~/Library/LaunchAgents/eu.verwey.reck-stationd.plist
sudo rm /usr/local/bin/reck-stationd
rm -rf ~/Library/Logs/reck-stationd
rm -f ~/.config/reck/token
rm -rf ~/.config/reck
```

The script is the canonical source of truth — if its behaviour changes (extra files to clean up, ordering tweaks, etc.) it's expected to drift ahead of this list. Diff the script if a manual run misses something.

## Linux station

The station daemon also runs on **Linux** — a Raspberry Pi 5 (8 GB+) on Pi OS Bookworm 64-bit, or any Debian/Ubuntu ARM64 host with `systemd --user` and a recent `go` toolchain. The Satellite is still a Mac app; only the station side changes. Orientation and the full macOS↔Linux command map live in [`docs/concepts/linux-station.md`](../docs/concepts/linux-station.md).

### Quick install

```bash
git clone https://github.com/mehdigreefhorst/reck-connect.git ~/src/reck-connect
cd ~/src/reck-connect
./ops/install-station-linux.sh
```

The script:

1. Builds `reck-stationd` and `reck-pane-launcher` into `~/.local/bin/`.
2. Generates a 0600 bearer token at `~/.config/reck/token` if absent.
3. Writes a starter `~/.config/reck/projects.toml` if absent.
4. Writes `RECK_STATION_ROOT` (default `~/projects`) to `~/.config/reck/.env` — the daemon runs in `--mode=station`, which requires it.
5. Renders `~/.config/systemd/user/reck-stationd.service` from the template and installs the `reck-xvfb.service` companion (skip with `RECK_SKIP_CLIPBOARD=1`).
6. `systemctl --user daemon-reload && enable --now`.
7. `sudo loginctl enable-linger $USER` so the service runs at boot without an interactive login.

Re-running upgrades the binaries and reloads the unit; token and config are preserved. To build for the Pi from a Mac, run `make cross`.

### Tunables (env vars)

| Var                   | Default                           |
|-----------------------|-----------------------------------|
| `RECK_ADDR`           | `0.0.0.0:7315`                    |
| `RECK_CLAUDE_BIN`     | `$(command -v claude)`            |
| `RECK_LAUNCHER_PATH`  | `~/.local/bin/reck-pane-launcher` |
| `RECK_STATION_ROOT`   | `~/projects`                      |
| `RECK_SKIP_CLIPBOARD` | unset (set `1` to skip xclip/Xvfb)|

For tailnet-only listening, pass e.g. `RECK_ADDR="$(tailscale ip -4):7315"`.

### Prereqs

```bash
sudo apt update
sudo apt install -y git curl rsync openssh-server bash python3 openssl golang-go
```

`python3` and `openssl` back the Claude Code lifecycle hook shim (it signs every event with HMAC-SHA256). `bash` is required — the shim uses bashisms, so do not switch to dash. If `golang-go` from apt is older than the version in `go.mod`, grab the latest `linux-arm64` tarball from <https://go.dev/dl/> and unpack to `/usr/local/go`.

Install Claude Code per the official Linux ARM64 instructions, then `claude login`; capture `which claude` for `RECK_CLAUDE_BIN`. Install Tailscale: `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`.

### Verify

```bash
TOKEN=$(cat ~/.config/reck/token)
curl -H "Authorization: Bearer $TOKEN" http://localhost:7315/health
```

Expect JSON with `"ok": true`. From the Mac Satellite, add the station with the Pi's tailnet hostname, port `7315`, and the token contents.

### Service management & troubleshooting

```bash
journalctl --user -u reck-stationd -n 200 --no-pager
systemctl --user status reck-stationd
```

Common causes:

- "resolve claude binary failed" → wrong `--claude=` path in the unit; re-run with `RECK_CLAUDE_BIN=/abs/path/claude`.
- "resolve default shell failed" → `SHELL` unset; pin it in `~/.config/reck/.env`: `SHELL=/bin/bash`.
- "config load failed" → `~/.config/reck/projects.toml` missing, or a `cwd` that doesn't exist.
- Daemon exits immediately → `RECK_STATION_ROOT` not in `~/.config/reck/.env` (`--mode=station` requires it).
- 401 from Satellite → token mismatch; re-copy from `~/.config/reck/token`.
- Pane spawns then dies → `claude` not on the daemon's PATH or not logged in. SSH in, run `claude`, then `systemctl --user restart reck-stationd`.
- Service stops after logout → linger not enabled (`sudo loginctl enable-linger $USER`).
- "image paste unsupported" / chip never appears → the daemon's `xclip` probe failed at startup. Ensure `xclip` is on `$PATH` and `reck-xvfb.service` is active before `reck-stationd` (`systemctl --user status reck-xvfb`). Capability is probed once per daemon lifetime, so a fix needs `systemctl --user restart reck-stationd`; the renderer's `/uploads` fallback keeps paste working meanwhile. See [`docs/concepts/linux-station.md`](../docs/concepts/linux-station.md).

### Linux uninstall

```bash
./ops/uninstall-station-linux.sh
# or also wipe ~/.config/reck and ~/.local/state/reck-stationd:
./ops/uninstall-station-linux.sh --purge
```

Disable boot-survival: `sudo loginctl disable-linger $USER`.
