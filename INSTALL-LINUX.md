# Installing the Reck Connect station on Linux / Raspberry Pi

A step-by-step walkthrough. Follow it top to bottom and you'll end with a
**station daemon running on your Pi** that your **Mac Satellite** connects to over
Tailscale.

> The **station** (the always-on daemon, `reck-stationd`) runs on the Pi.
> The **Satellite** (the desktop app) stays on your Mac — nothing about it changes.
> For the conceptual map (systemd vs launchd, clipboard, paths) see
> [`docs/concepts/linux-station.md`](docs/concepts/linux-station.md). This file is
> the hands-on install path; [`ops/README.md`](ops/README.md#linux-station) is the
> reference.

---

## 0. What you need before starting

- A Raspberry Pi 5 (8 GB+) on Pi OS Bookworm 64-bit, or any Debian/Ubuntu **ARM64**
  host, that you can `ssh` into.
- [Tailscale](https://tailscale.com) on both the Pi and your Mac (same tailnet).
- A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) subscription/login.
- About 15 minutes.

Everything below runs **on the Pi** unless it says "on your Mac". Run as the normal
user that will own the daemon (not root) — the script uses `sudo` only where needed.

---

## 1. Install the prerequisites (on the Pi)

```bash
sudo apt update
sudo apt install -y git curl rsync openssh-server bash python3 openssl
```

`python3` + `openssl` sign Claude Code's lifecycle-hook events; `bash` is required
(the hook shim uses bashisms — do **not** switch the default shell to dash).

### Go toolchain

The daemon needs a recent Go (see `go.mod` for the exact minimum). Debian's
`golang-go` is usually too old, so install the official ARM64 toolchain:

```bash
curl -fsSL https://go.dev/dl/ | grep -o 'go[0-9.]*\.linux-arm64\.tar\.gz' | head -1   # find the latest
# then (substitute the filename printed above):
curl -fsSLO https://go.dev/dl/go1.26.3.linux-arm64.tar.gz
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf go1.26.3.linux-arm64.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.profile && source ~/.profile
go version    # confirm it prints the version you installed
```

### Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4         # note the Pi's tailnet IP; `tailscale status` shows its MagicDNS name
```

### Claude Code

Install Claude Code for **Linux ARM64** per the
[official instructions](https://docs.anthropic.com/en/docs/claude-code), then:

```bash
claude login            # complete the browser login
which claude            # note this path — you may need it in step 3
```

> The daemon spawns `claude` for every Claude pane, so it **must** be installed and
> logged in as the same user that runs the station.

### Codex CLI (optional)

Want **Codex panes** alongside Claude? Install OpenAI's `codex` CLI for Linux
ARM64 (per its official instructions) as the **same user** that runs the station,
and log in:

```bash
codex --version         # confirm it's installed
which codex             # note the path — must be on the daemon's PATH
```

> The daemon resolves `codex` via `PATH` **once at startup** (there's no `--codex`
> flag — unlike `--claude`). So install it **before** running the installer, or
> `systemctl --user restart reck-stationd` afterward. If `codex` isn't found, Codex
> panes stay unavailable and the Satellite's **Codex** button shows a "not installed"
> toast — Claude and shell panes are unaffected. A typical user install lands in
> `~/.local/bin`, which the systemd-user service already has on its `PATH`.

---

## 2. Get the code (on the Pi)

```bash
git clone https://github.com/mehdigreefhorst/reck-connect.git ~/src/reck-connect
cd ~/src/reck-connect
```

> **While the Codex work is still in PRs (not yet merged to `main`):**
> `git checkout feat/codex-preamble` — this stacks first-class Codex panes
> (#35) and the Codex preamble (#36) on top of the current `main` (which
> already has the Linux-station support). Once those merge, plain `main` is
> enough.

---

## 3. Run the installer (on the Pi)

```bash
cd ~/src/reck-connect
./ops/install-station-linux.sh
```

That one command:

1. Builds `reck-stationd` + `reck-pane-launcher` into `~/.local/bin/`.
2. Generates a 0600 bearer token at `~/.config/reck/token`.
3. Writes a starter `~/.config/reck/projects.toml`.
4. Writes `RECK_STATION_ROOT` (default `~/projects`) to `~/.config/reck/.env`.
5. apt-installs `xvfb` + `xclip` (the image-paste backend) and the
   `reck-xvfb.service` virtual display.
6. Renders + enables the `reck-stationd` systemd-user service.
7. `sudo loginctl enable-linger` so it runs at boot without you logging in.

It prints the **host, port (7315), and token** at the end — copy those; you need
them in step 5.

### Useful options (optional)

```bash
# Listen only on the tailnet instead of all interfaces:
RECK_ADDR="$(tailscale ip -4):7315" ./ops/install-station-linux.sh

# Point at a specific claude binary (if `which claude` wasn't on PATH at install):
RECK_CLAUDE_BIN="$(which claude)" ./ops/install-station-linux.sh

# Use a different projects root:
RECK_STATION_ROOT="$HOME/code" ./ops/install-station-linux.sh

# Headless box where you'll never paste images — skip xvfb/xclip:
RECK_SKIP_CLIPBOARD=1 ./ops/install-station-linux.sh
```

Re-running the installer is safe — it upgrades the binaries and reloads the unit;
your token and config are preserved.

---

## 4. Verify the station is running (on the Pi)

```bash
systemctl --user status reck-stationd        # should be "active (running)"
TOKEN=$(cat ~/.config/reck/token)
curl -H "Authorization: Bearer $TOKEN" http://localhost:7315/health
```

Expect JSON containing `"ok": true`. If it doesn't come up, jump to
[Troubleshooting](#troubleshooting).

---

## 5. Connect your Mac Satellite (on your Mac)

1. Open the **Reck Connect Satellite** app.
2. **Add station** and enter:
   - **Host** — the Pi's MagicDNS name (e.g. `my-pi.tailnet-name.ts.net`) or its
     tailnet IP from `tailscale ip -4`.
   - **Port** — `7315`.
   - **Token** — the contents of `~/.config/reck/token` (printed at the end of
     step 3).
3. Save. The station should show as connected and list the project(s) from
   `projects.toml`.

---

## 6. Smoke-test it

- Open a **Claude pane** in a project. It should spawn and the stoplight should go
  green (the daemon is reaching Claude Code on the Pi).
- **Paste an image** into the pane (⌘V). An `[Image #N]` chip should appear. If it
  doesn't, the clipboard backend isn't up — see the image-paste row in
  [Troubleshooting](#troubleshooting). Paste still works via the `/uploads` fallback
  in the meantime.
- If you installed the `codex` CLI, open a **Codex pane** too (New Pane → Codex). It
  should spawn just like Claude; if instead you get a "not installed" toast, `codex`
  wasn't on the daemon's PATH at startup — see the Codex row in
  [Troubleshooting](#troubleshooting).

That's it — the station is live on the Pi.

---

## Updating

```bash
cd ~/src/reck-connect
git pull                       # (or: git checkout main && git pull, once merged)
./ops/install-station-linux.sh # rebuilds + restarts the daemon; token/config preserved
```

> Re-running **restarts** `reck-stationd` to load the new binary, which drops any
> live panes on the station. Run it when you're at a safe point.

## Uninstalling

```bash
cd ~/src/reck-connect
./ops/uninstall-station-linux.sh          # stops + removes the service and binaries
./ops/uninstall-station-linux.sh --purge  # ...and wipes ~/.config/reck + logs
sudo loginctl disable-linger "$USER"      # stop it surviving reboots
```

---

## Troubleshooting

First, always check the logs:

```bash
journalctl --user -u reck-stationd -n 200 --no-pager
systemctl --user status reck-stationd
```

| Symptom | Cause & fix |
|---|---|
| Daemon exits immediately / `RECK_STATION_ROOT must be set` | The var isn't in `~/.config/reck/.env`. Re-run `./ops/install-station-linux.sh` (it writes it), or add `RECK_STATION_ROOT=$HOME/projects` to that file and `systemctl --user restart reck-stationd`. |
| `resolve claude binary failed` | Wrong `--claude=` path in the unit. Re-run with `RECK_CLAUDE_BIN="$(which claude)" ./ops/install-station-linux.sh`. |
| Pane spawns then dies | `claude` not on the daemon's PATH or not logged in. SSH in, run `claude` once, then `systemctl --user restart reck-stationd`. |
| **Codex** button shows a "not installed" toast | `codex` wasn't on the daemon's PATH when it started (it's resolved once per start, like claude — and there's no `--codex` flag). Confirm `which codex` is on the daemon's `PATH` (a `~/.local/bin` install already is), then `systemctl --user restart reck-stationd`. Also make sure the daemon is running a build with Codex support (`feat/codex-preamble` or `main` once merged) — an older `reck-stationd` doesn't advertise codex at all. |
| `resolve default shell failed` | `SHELL` unset under systemd. Add `SHELL=/bin/bash` to `~/.config/reck/.env` and restart. |
| `401` from the Satellite | Token mismatch — re-copy from `~/.config/reck/token` into the app. |
| Can't reach the station from the Mac | Both ends on Tailscale? `tailscale status` on each. Try the tailnet IP instead of the name. Confirm `RECK_ADDR` isn't bound to loopback only. |
| Service dies after you log out | Linger not enabled: `sudo loginctl enable-linger "$USER"`. |
| Image paste / chip never appears | The `xclip` probe failed at startup. Check `systemctl --user status reck-xvfb` is active, `xclip` is installed, then `systemctl --user restart reck-stationd` (capability is probed once per daemon start). |

---

## What got installed where

| Path | What |
|---|---|
| `~/.local/bin/reck-stationd`, `~/.local/bin/reck-pane-launcher` | the binaries |
| `~/.config/reck/token` | 0600 bearer token |
| `~/.config/reck/projects.toml` | the projects manifest |
| `~/.config/reck/.env` | `RECK_STATION_ROOT` (+ any extra env you pin) |
| `~/.config/systemd/user/reck-stationd.service`, `reck-xvfb.service` | the units |
| `~/.local/state/reck-stationd/reck-stationd.log` | the log |
| `~/projects` (default) | where managed projects live |
