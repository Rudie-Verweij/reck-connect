# Installing Reck Connect

> **Running the station on Linux / Raspberry Pi instead of macOS?** Follow
> [`INSTALL-LINUX.md`](INSTALL-LINUX.md) — a step-by-step Pi walkthrough. The
> runbook below targets a macOS station.

This document is a runbook for **Claude Code** to drive end-to-end on
your behalf. Open Claude Code in any directory and tell it:

> install Reck Connect from github

(The "from github" suffix disambiguates against Claude Code's built-in
`/install` plugin command — it tells Claude to clone this repo and
follow this runbook.) Claude reads this file, asks for what it can't
infer, and executes the choreography below across both your
**station** (the always-on Mac that hosts your work) and your
**satellite** (the laptop you control it from). Each stage detects
what's already done and skips ahead, so it's safe to re-run after a
failed step.

If you'd rather drive the install by hand, every command is included
verbatim. Skip to "Manual install" at the bottom.

---

## Before you start (one-time, physical)

These two steps need you in front of each machine. Claude can't do them
for you because they require typing your Apple ID into App Store and
clicking through Tailscale's browser sign-in.

### On the station (the always-on Mac)

1. **Install Tailscale** from the App Store. Sign in.
2. Open the Tailscale menu bar icon → **Settings** → toggle
   **Run SSH server** ON.
3. Walk away. The rest happens from your laptop.

### On the satellite (your laptop)

1. **Install Tailscale** from the App Store. Sign in to the same
   tailnet you used on the station.
2. **Install Claude Code** if you haven't already
   (https://claude.com/claude-code).
3. Open Claude Code in any directory. Tell it: `install Reck Connect`.

That's it — no other prerequisites. Claude probe-installs Homebrew,
git, and everything else on both hosts as part of the choreography.

---

## What "install Reck Connect" does

Six stages. Claude runs them in order, checks pre-conditions before
each one, and stops to ask if it hits a decision point.

### Stage 0 — satellite tool probe and clone

Goal: get this repository onto your laptop and confirm Homebrew + git
are usable.

Pre-conditions:
- macOS 14 (Sonoma) or later.
- Tailscale installed (you did this above).

Commands Claude runs on the satellite:

```bash
# 1. Probe Homebrew. Install non-interactively if missing.
command -v brew >/dev/null 2>&1 || \
  NONINTERACTIVE=1 /bin/bash -c \
    "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. Probe Tailscale CLI (the App Store install also drops the CLI).
command -v tailscale >/dev/null 2>&1 || brew install --cask tailscale

# 3. Probe Node + pnpm (needed to build the Satellite .app in Stage 5).
command -v node >/dev/null 2>&1 || brew install node
command -v pnpm >/dev/null 2>&1 || brew install pnpm

# 4. Clone this repo (public). Skip if already present.
mkdir -p ~/claude-code
cd ~/claude-code
[ -d reck-connect ] || git clone https://github.com/Rudie-Verweij/reck-connect reck-connect
```

Rollback: nothing to undo. Brew install is reversible with
`brew uninstall`; the clone is just a directory.

### Stage 1 — discover the station

Goal: pick which machine on your tailnet is the station.

> **Heads-up — Tailscale install variant matters.** This guide uses
> `tailscale ssh <user>@<host>` as the install transport. That command
> requires the userspace SSH extension, which historically ships only
> with **sysext / standalone Tailscale builds** and not with the
> **App Store / "macsys" Tailscale build**. App Store builds typically
> exit with `tailnet SSH is not enabled` even when `Run SSH server`
> looks toggled on. (Tailscale has been migrating capabilities over
> time, so this may have shifted by the time you read this — if your
> App Store build does support `tailscale ssh`, great; if not, plain
> SSH is the documented fallback.)
>
> **If you installed Tailscale from the Mac App Store, use plain SSH
> instead.** Substitute `ssh <admin-user>@<station-name>` for
> every `tailscale ssh -t <admin-user>@<station-name>` call below.
> Plain SSH works the same way as long as Remote Login is enabled
> (System Settings → General → Sharing → Remote Login). Tailnet IPs and
> MagicDNS names work as the SSH host either way.

Commands:

```bash
tailscale status                                # list peers
tailscale ping <station-name>                   # verify reachability
# Pick ONE of these — depending on your Tailscale install variant.
tailscale ssh <admin-user>@<station-name> -- echo ok    # sysext / standalone
ssh <admin-user>@<station-name> echo ok                 # App Store Tailscale or plain SSH
```

Decision point: Claude shows you the peer list and asks which one is
the station, then asks which user account is your admin user on that
machine (typically your own short name, the one you log in as).

If neither SSH path works:
- Re-check that **Run SSH server** is ON in the Tailscale menu on the
  station (sysext build only — App Store build will not have this).
- For plain SSH, confirm Remote Login is enabled on the station
  (System Settings → General → Sharing → Remote Login).
- If your tailnet has ACLs that block ssh-as-any-user (common on
  org tailnets), open the Tailscale admin console and grant
  `ssh-as-admin` for your satellite → station pair.

### Stage 2 — bootstrap the `reck-connect` user on the station

Goal: create a dedicated standard user account on the station so the
daemon runs in clean isolation from your admin user. Done over
`tailscale ssh` from the satellite.

Pre-conditions:
- Stage 1 confirmed `tailscale ssh` works.
- You know the station's admin password (you'll type it once into the
  ssh session — it's never stored).

Commands:

```bash
# 1. Make sure the satellite has an SSH keypair to inject. We use a
#    dedicated key so it can be revoked without touching your other
#    keys. Skips if it already exists.
[ -f ~/.ssh/reck_mount ] || \
  ssh-keygen -t ed25519 -f ~/.ssh/reck_mount -N "" -C "reck-mount@$(hostname -s)"

# 2. Pipe bootstrap-reck-user.sh into a tailscale ssh session that
#    has just warmed sudo. The pubkey is passed as base64 — OpenSSH
#    public keys may carry arbitrary comment text including quote
#    characters, and embedding the raw key into a remote shell
#    command would let a hostile comment break out of argv quoting.
#    The base64 wrapper round-trips through a single character class
#    that cannot escape any shell or argv encoding.
PUBKEY_B64=$(base64 < ~/.ssh/reck_mount.pub | tr -d '\n')
tailscale ssh -t <admin-user>@<station-name> "
  sudo -v && \
  bash -s -- --pubkey-b64 \"$PUBKEY_B64\" --confirm-create-user
" < ~/claude-code/reck-connect/ops/bootstrap-reck-user.sh
```

`--confirm-create-user` is consent for the script to create a new local
macOS user (`reck-connect`) and add it to the `admin` group. Without the
flag the script refuses to create the account and exits with the full
list of changes it would make. Re-runs against an existing account
ignore the flag (no creation needed).

App Store Tailscale variant: replace `tailscale ssh -t` with `ssh -t`
in the command above.

The script prints a single line of the form `RECK_CONNECT_PW=<hex>`
exactly once when it creates the account. Claude captures that line so
it can be written into the install result file in Stage 3 (so you
don't have to re-derive it later if you want to log in graphically).
Note that the password also lands in the satellite's terminal
scrollback — wipe it (`Edit → Clear Buffer`) once you've stashed the
value somewhere durable.

Idempotent: if the account already exists, the script skips creation
and only refreshes `authorized_keys`.

Rollback: `sudo sysadminctl -deleteUser reck-connect` (also takes
`-secure` to scrub the home directory).

### Stage 3 — clone and build on the station

Goal: get the daemon running as `reck-connect`. This is the existing
`install-station.sh` flow — unchanged from the manual install.

The repo is public, so the station's `reck-connect` user clones it
without any GitHub auth.

Commands:

```bash
# Run as reck-connect (sudo because we need to switch users from the
# admin shell). On a fresh account, brew install + go build take a
# few minutes; subsequent runs are seconds.
#
# `sudo -u` strips the env by default, so RECK_CONNECT_PW would be
# lost between the admin shell and the reck-connect shell unless we
# pass it through `env`. The `env VAR=val command...` form puts it
# in the new process's environment, where install-station.sh reads
# it via ${RECK_CONNECT_PW:-}.
tailscale ssh -t <admin-user>@<station-name> "
  sudo -u reck-connect env RECK_CONNECT_PW=\"$RECK_CONNECT_PW\" \
    RECK_STATION_USER=reck-connect \
    RECK_STATION_ROOT=/Users/reck-connect/projects \
    bash -lc '
    set -e
    mkdir -p ~/claude-code
    cd ~/claude-code
    [ -d reck-connect ] || git clone https://github.com/Rudie-Verweij/reck-connect reck-connect
    cd reck-connect/ops
    ./install-station.sh
  '
"
```

`install-station.sh` requires `RECK_STATION_USER` (must match
`whoami` — safety check) and `RECK_STATION_ROOT` (the absolute
projects-root path). Both are baked into the rendered LaunchAgent
plist's `EnvironmentVariables`, so the daemon picks up
`RECK_STATION_ROOT` at every launch (it fail-fasts at startup if
missing — see `daemon/cmd/reck-stationd/main.go`).

`install-station.sh` writes `~reck-connect/.reck-install-result.json`
(mode 0600) at the end:

```json
{
  "token": "<32 hex>",
  "station_url": "http://<tailnet-host>:7315",
  "tailnet_name": "<station>",
  "reck_connect_pw": "<from Stage 2, if known>"
}
```

Claude scp-pulls that file to a temp path on the satellite so it can
be fed into Stage 4.

```bash
scp -i ~/.ssh/reck_mount \
  reck-connect@<station-name>:.reck-install-result.json \
  /tmp/reck-install-result.json
```

Rollback: re-running `install-station.sh` upgrades in place via the
existing atomic-swap. To uninstall entirely:

```bash
tailscale ssh -t <admin-user>@<station-name> "
  sudo -u reck-connect bash -lc 'cd ~/claude-code/reck-connect/ops && ./uninstall-station.sh'
"
```

### Stage 4 — satellite install

Goal: install the FUSE-T mount stack, the LaunchAgent that mounts
your station's projects directory, and the Satellite app's first-launch
config.

Pre-conditions: Stage 3 wrote `/tmp/reck-install-result.json` on the
satellite.

Commands:

```bash
TOKEN=$(jq -r .token /tmp/reck-install-result.json)
URL=$(jq -r .station_url /tmp/reck-install-result.json)

cd ~/claude-code/reck-connect/ops
RECK_SATELLITE_TOKEN="$TOKEN" \
RECK_STATION_USER=reck-connect \
RECK_STATION_ROOT=/Users/reck-connect/projects \
STATION_HOST=<station-name> ./install-satellite.sh \
  --key-already-installed \
  --write-settings "$URL"
```

`RECK_STATION_USER` and `RECK_STATION_ROOT` are required — they
parameterize the unix user and absolute projects-root path on the
station so this installer is portable to non-default deployments
(different user, different home, Linux station, etc.). Setting them to
the values above reproduces the historical defaults.

The same `RECK_STATION_ROOT` value must be set on the **station** when
running `install-station.sh` (the rendered daemon plist bakes it into
`EnvironmentVariables`, and `reck-stationd` fail-fasts at startup if
missing). Mismatched values between satellite and station produce
silently-vanishing projects — the contract is verified at startup on
both halves now, so a mismatch surfaces in the daemon log instead.

> **Upgrading an existing station:** the new `reck-stationd` binary
> requires `RECK_STATION_ROOT` in `--mode=station`. A binary-only swap
> (e.g. `git pull && go build && cp …` without re-running
> `install-station.sh`) leaves the existing LaunchAgent plist without
> the env var; the daemon will exit 2 in a launchd respawn loop. The
> stderr error prints two recovery paths — re-run `install-station.sh`
> with the env vars set, or one-shot patch the plist in place via
> `plutil -insert EnvironmentVariables.RECK_STATION_ROOT -string …`
> followed by `launchctl kickstart -k gui/<uid>/eu.verwey.reck-stationd`.

The two flags collapse what used to be two manual steps:

- `--key-already-installed` skips the trailing `ssh-copy-id` reminder
  (Stage 2 already injected the key).
- `--write-settings <url>` drops a one-shot `bootstrap.json` into the
  Satellite app's userData directory. The app reads it on first launch,
  encrypts the token via Electron's `safeStorage`, populates the real
  `settings.json`, and unlinks the bootstrap file.

The token is passed via the `RECK_SATELLITE_TOKEN` environment
variable rather than argv so it doesn't appear in `ps auxww` output
visible to other local users.

#### macOS 26 (Tahoe) one-time prompt

If you're on **macOS 26** or later, the FUSE-T mount uses Apple's
new FSKit framework. The first time the watchdog tries to mount, the
OS asks you to approve the file-system extension. **This step
requires a physical click — it cannot be automated.**

When Claude reaches Stage 4 on macOS 26, it tells you:

> Open **System Settings → Privacy & Security → Login Items &
> Extensions → File System Extensions**. Find **FUSE-T** and toggle
> it ON. Click **Allow** if prompted.

Symptom if you skip this: `~/Library/Logs/reck-stationd/mount.log`
prints `sshfs failed (exit 1)` every 60 s. The watchdog retries
forever — no data is lost — but `~/reck/projects` will stay empty
until you approve.

On macOS 14 or 15, FUSE-T uses an older NFSv4 loopback path that
doesn't need this prompt; Claude skips this sub-step.

Rollback: `~/claude-code/reck-connect/ops/uninstall-satellite.sh`
(if present) or manually:

```bash
launchctl bootout gui/$(id -u)/eu.verwey.reck-mount
rm ~/Library/LaunchAgents/eu.verwey.reck-mount.plist
sudo rm /usr/local/bin/reck-mount-watchdog
```

### Stage 5 — build the satellite app, verify, and launch

Commands:

```bash
# 1. Build the Satellite .app bundle from source. (No pre-built .app
#    is shipped — every install compiles locally so Gatekeeper never
#    sees an unsigned binary.)
#    `VITE_RECK_STATION_ROOT` is required at build time — Vite inlines
#    the value into the renderer bundle.
cd ~/claude-code/reck-connect/satellite
VITE_RECK_STATION_ROOT=/Users/reck-connect/projects pnpm install
VITE_RECK_STATION_ROOT=/Users/reck-connect/projects pnpm dist
cp -R "release/mac-arm64/Reck Connect Satellite.app" /Applications/

# 2. Daemon answers /health with the bearer token.
curl -fsS -H "Authorization: Bearer $TOKEN" "$URL/health"

# 3. The mount is up.
mount | grep "$HOME/reck/projects"

# 4. The station is reachable.
tailscale ping <station-name>

# 5. Open the app.
open -a "Reck Connect Satellite"
```

The first launch consumes `bootstrap.json` and writes the encrypted
`settings.json`. You should land on the project list, not the
mode-chooser. If you land on the mode-chooser, Stage 4's `bootstrap.json`
either wasn't written (re-run Stage 4) or was malformed (check
`~/Library/Logs/Reck Connect Satellite/main.log` for
`bootstrap import: rejected`).

---

## Manual install

If Claude isn't available, the same flow runs by hand. The summary:

```bash
# Satellite
cd ~/claude-code/reck-connect
git pull
ssh-keygen -t ed25519 -f ~/.ssh/reck_mount -N ""
ssh-copy-id -i ~/.ssh/reck_mount.pub <admin-user>@<station-name>

# Station — over `tailscale ssh -t <admin-user>@<station-name>`
# (or plain `ssh -t <admin-user>@<station-name>` for App Store Tailscale)
sudo -v
bash -s -- --pubkey-b64 "$(base64 < ~/.ssh/reck_mount.pub | tr -d '\n')" --confirm-create-user < ops/bootstrap-reck-user.sh
sudo -u reck-connect env \
  RECK_STATION_USER=reck-connect \
  RECK_STATION_ROOT=/Users/reck-connect/projects \
  bash -lc '
  cd ~/claude-code && [ -d reck-connect ] || git clone https://github.com/Rudie-Verweij/reck-connect reck-connect
  cd reck-connect/ops && ./install-station.sh
'
# Note the printed Daemon Token + Station URL.

# Satellite
cd ops
RECK_STATION_USER=reck-connect \
RECK_STATION_ROOT=/Users/reck-connect/projects \
STATION_HOST=<station-name> ./install-satellite.sh
ssh-copy-id -i ~/.ssh/reck_mount.pub reck-connect@<station-name>  # if not already
open -a "Reck Connect Satellite"
# Paste Daemon Token + Station URL into the first-launch dialog.
```

The Claude-driven path replaces the manual `ssh-copy-id` to
`reck-connect` (Stage 2 injects the key directly) and the manual
first-launch dialog (`--write-settings` does it for you).

---

## Updating

To pick up a new release:

```bash
# Satellite — quit the running app first so the orphan-sweep doesn't
# fire one last time against the old daemon binary on shutdown.
osascript -e 'tell application "Reck Connect Satellite" to quit'

cd ~/claude-code/reck-connect && git pull

# Refresh the laptop-side reck-stationd binary used by Satellite's
# Local mode AND migrate any legacy userData (layouts_v2, projectOrder,
# theme, claudeLaunchArgs, gaze.*) from older productName dirs into
# the current ~/Library/Application Support/reck-connect-satellite/.
# install-satellite.sh handles both as part of its normal flow.
cd ops && \
  RECK_STATION_USER=reck-connect \
  RECK_STATION_ROOT=/Users/reck-connect/projects \
  ./install-satellite.sh
cd ..

# Rebuild + install the .app bundle. Vite needs the station root at
# build time so it can inline the value into the renderer bundle.
cd satellite && \
  VITE_RECK_STATION_ROOT=/Users/reck-connect/projects pnpm install && \
  VITE_RECK_STATION_ROOT=/Users/reck-connect/projects pnpm dist
osascript -e 'tell application "Reck Connect Satellite" to quit' >/dev/null 2>&1 || true
rm -rf "/Applications/Reck Connect Satellite.app"
cp -R "release/mac-arm64/Reck Connect Satellite.app" /Applications/

# Station
tailscale ssh -t <admin-user>@<station-name> "
  sudo -u reck-connect env \
    RECK_STATION_USER=reck-connect \
    RECK_STATION_ROOT=/Users/reck-connect/projects \
    bash -lc '
    cd ~/claude-code/reck-connect && git pull
    cd ops && ./install-station.sh
  '
"
```

`install-station.sh` does an atomic-swap with rollback (`.prev`
binary preserved on success) so a failed upgrade can be reverted with
a single `sudo install` of the previous binary.

### Why the satellite-side update has three steps now

Two real incidents informed the order above:

1. **Stale local-mode daemon binary.** The .app rebuild only refreshes
   the Electron renderer + main process. The reck-stationd that
   Satellite spawns for Local mode lives at `~/.local/bin/reck-stationd`
   and is independent of the app bundle. Skipping `install-satellite.sh`
   on update leaves the local daemon at whatever version was current
   when the laptop was first set up — daemon-side features (e.g.
   orphan auto-restore) silently don't apply on the local host.
   `install-satellite.sh` now invokes `install-local.sh` to keep that
   binary in lockstep with the checkout.

2. **Legacy userData orphaned on productName rename.** Electron
   derives `app.getPath('userData')` from `app.getName()`, which falls
   back to `satellite/package.json`'s `name` field. When the package
   was renamed `reck-satellite` → `reck-connect-satellite`, every key
   the user had configured (`layouts_v2`, `projectOrder`,
   `claudeLaunchArgs`, `theme`, `railWidth`, `gaze.*`) stayed at the
   old path while the rebuilt .app started reading from the new one,
   silently wiping the user's pane layouts on first launch.
   `install-satellite.sh` walks the known legacy candidate dirs and
   forwards any key the new dir is missing — never clobbering an
   existing key, so the active install's encrypted auth blobs stay
   in place.

---

## Uninstalling

```bash
# Station
tailscale ssh -t <admin-user>@<station-name> "
  sudo -u reck-connect bash -lc 'cd ~/claude-code/reck-connect/ops && ./uninstall-station.sh'
"
# If you also want the reck-connect user gone:
tailscale ssh -t <admin-user>@<station-name> "sudo sysadminctl -deleteUser reck-connect -secure"

# Satellite
launchctl bootout gui/$(id -u)/eu.verwey.reck-mount
rm ~/Library/LaunchAgents/eu.verwey.reck-mount.plist
sudo rm /usr/local/bin/reck-mount-watchdog
rm -rf "$HOME/Library/Application Support/Reck Connect Satellite"
```

The satellite's `~/reck/projects` mount point is left in place (empty
after unmount) so `rm -rf` of it is a separate, deliberate step.

---

## Status

This is an **early-stage** project. It has been hardened on the
maintainer's own daily-driver setup but has not been tested across
the variety of macOS versions, hardware models, and tailnet
configurations a wider audience would bring. Treat the install as a
"works for the maintainer, may surprise you" experience.

License: PolyForm Noncommercial 1.0.0 — see [LICENSE](./LICENSE).
