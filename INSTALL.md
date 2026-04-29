# Installing Reck Connect

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

# 4. Clone this repo. Private during early access; you'll need GitHub
#    access (run `gh auth login` first time). Skip if already present.
mkdir -p ~/claude-code
cd ~/claude-code
[ -d reck-connect ] || git clone https://github.com/Rudie-Verweij/reck-connect reck-connect
```

Rollback: nothing to undo. Brew install is reversible with
`brew uninstall`; the clone is just a directory.

### Stage 1 — discover the station

Goal: pick which machine on your tailnet is the station.

Commands:

```bash
tailscale status                                # list peers
tailscale ping <station-name>                   # verify reachability
tailscale ssh <admin-user>@<station-name> -- echo ok
```

Decision point: Claude shows you the peer list and asks which one is
the station, then asks which user account is your admin user on that
machine (typically your own short name, the one you log in as).

If the `tailscale ssh` test fails:
- Re-check that **Run SSH server** is ON in the Tailscale menu on the
  station.
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
  bash -s -- --pubkey-b64 \"$PUBKEY_B64\"
" < ~/claude-code/reck-connect/ops/bootstrap-reck-user.sh
```

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

**Heads-up for early access (private repo).** The station's
`reck-connect` user needs its own GitHub auth before the clone in this
stage can succeed. One-shot, on the station, before running Stage 3:

```bash
tailscale ssh -t <admin-user>@<station-name>
sudo -u reck-connect -i
gh auth login   # follow the device-code flow once
exit; exit
```

After that, the clone command below works non-interactively. Once the
public mirror flips to public visibility, this step goes away.

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
  sudo -u reck-connect env RECK_CONNECT_PW=\"$RECK_CONNECT_PW\" bash -lc '
    set -e
    mkdir -p ~/claude-code
    cd ~/claude-code
    [ -d reck-connect ] || git clone https://github.com/Rudie-Verweij/reck-connect reck-connect
    cd reck-connect/ops
    ./install-station.sh
  '
"
```

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
STATION_HOST=<station-name> ./install-satellite.sh \
  --key-already-installed \
  --write-settings "$URL"
```

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
cd ~/claude-code/reck-connect/satellite
pnpm install
pnpm dist
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
sudo -v
bash -s -- --pubkey-b64 "$(base64 < ~/.ssh/reck_mount.pub | tr -d '\n')" < ops/bootstrap-reck-user.sh
sudo -u reck-connect bash -lc '
  cd ~/claude-code && [ -d reck-connect ] || git clone https://github.com/Rudie-Verweij/reck-connect reck-connect
  cd reck-connect/ops && ./install-station.sh
'
# Note the printed Daemon Token + Station URL.

# Satellite
cd ops
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
# Satellite
cd ~/claude-code/reck-connect && git pull
cd satellite && pnpm install && pnpm dist
# Copy release/mac-arm64/Reck Connect Satellite.app to /Applications.

# Station
tailscale ssh -t <admin-user>@<station-name> "
  sudo -u reck-connect bash -lc '
    cd ~/claude-code/reck-connect && git pull
    cd ops && ./install-station.sh
  '
"
```

`install-station.sh` does an atomic-swap with rollback (`.prev`
binary preserved on success) so a failed upgrade can be reverted with
a single `sudo install` of the previous binary.

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
