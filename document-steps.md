# Getting Reck Connect up and running — a real-world walkthrough

This is a **field guide** written while actually installing Reck Connect
on real hardware, so it captures the things the official `INSTALL.md`
doesn't spell out: the gotchas, the "this machine was set to sleep after
1 minute" surprises, and the exact commands that worked.

Use it as a companion to [`INSTALL.md`](INSTALL.md). Where they differ,
this file reflects what a fresh, two-Mac, Tailscale setup actually
needs.

---

## The setup we built

| Role | Machine | Identity |
|---|---|---|
| **Satellite** (the thin app you drive from) | a MacBook Pro | `macbook-pro-van-hugo` on the tailnet |
| **Station** (always-on, owns the agents) | an M4 Mac mini | `hugo-mac.tail517eef.ts.net` / `100.88.142.53` (tailnet), `10.0.0.164` (LAN) |
| **Link** | Tailscale | same tailnet on both |

**Key decision:** we run the station daemon as the Mini's **existing
admin user (`hugomac`)** rather than creating a dedicated `reck-connect`
account. It's the simplest path — the existing user already has an active
GUI session (which the installer requires) and a password you know. The
trade-off is less isolation (the agents can read that user's files). The
scripts are parameterised for this via `RECK_STATION_USER` /
`RECK_STATION_ROOT`, so it's fully supported.

> **Adapt to your own setup:** replace `hugomac`, the tailnet name
> `hugo-mac.tail517eef.ts.net`, and `/Users/hugomac/projects` with your
> station's admin user, its Tailscale name, and your chosen projects
> root throughout.

### What runs where

- **Station (Mini):** the Go daemon `reck-stationd` (a per-user
  LaunchAgent), every terminal/agent PTY, and the Claude Code CLI.
- **Satellite (laptop):** the Electron app, plus a FUSE-T sshfs mount
  that makes the station's projects appear locally at `~/reck/projects`.

---

## Everything you need to install — the flat checklist

The detailed steps below explain *why* each thing is needed; this is the
at-a-glance list so you can pre-stage a machine without reading ahead.
Items marked **(script)** are installed for you by `install-station.sh` /
`install-satellite.sh` — but only once the **(you)** items are in place,
so do those first.

### On the station (the always-on Mac — our M4 Mini)

- [ ] **Tailscale** (Mac App Store), signed into the tailnet — **(you)**
- [ ] **Remote Login / SSH** ON: System Settings → General → Sharing → Remote
  Login — **(you)**
- [ ] **One graphical login** as the daemon's user. The installer bootstraps a
  per-user LaunchAgent into `gui/<uid>` and **aborts if that Aqua session
  doesn't exist** — an account that has only ever been SSH'd into has none. — **(you)**
- [ ] **`/usr/local/bin` exists**: `sudo mkdir -p /usr/local/bin`. Fresh Apple
  Silicon Macs don't have it; the installer's `sudo install`/`ln` into it
  fails without it. See Problem #1. — **(you, until automated)**
- [ ] **Homebrew** + **Command Line Tools** (the Homebrew bootstrap pulls CLT in
  headlessly) — **(you)**
- [ ] **git** — required; installer errors out if missing — **(you / CLT)**
- [ ] **node** — needed for the `claude` CLI's `#!/usr/bin/env node` shebang — **(you)**
- [ ] **go** — installer auto-runs `brew install go` if missing — **(script)**
- [ ] **claude CLI** (`@anthropic-ai/claude-code`) — installer npm-installs
  globally + symlinks into `/usr/local/bin` if missing — **(script)**
- [ ] `reck-stationd` + `reck-pane-launcher` — built from source, installed to
  `/usr/local/bin` — **(script)**

### On the satellite (the laptop — our MacBook Pro)

- [ ] **Tailscale** (Mac App Store), **same tailnet** — **(you)**
- [ ] **Claude Code** (https://claude.com/claude-code) — **(you)**
- [ ] **`/usr/local/bin` exists**: `sudo mkdir -p /usr/local/bin` — same fresh-Mac
  gotcha; the mount watchdog installs there. See Problem #1. — **(you, until automated)**
- [ ] **Homebrew** — **(you)**
- [ ] **node** + **pnpm** — build the Satellite `.app` — **(you / script)**
- [ ] **go** — the satellite installer **also builds a local-mode `reck-stationd`
  from source**, which needs Go. `INSTALL.md` doesn't mention this — install it
  or Step 7 fails. — **(you)**
- [ ] **FUSE-T** + **fuse-t-sshfs** casks — needs `brew trust macos-fuse-t/cask`
  on Homebrew 6+ (see Problem #2) and your password for the `.pkg` — **(script)**
- [ ] **rsync** (real GNU rsync via brew — macOS ships openrsync, which the
  Satellite can't parse) — **(script)**
- [ ] **macOS 26 (Tahoe) only:** approve the FUSE-T **File System Extension** —
  a physical click, can't be scripted. See Problem #5. — **(you)**

---

## Before you start (one-time, manual)

These need a human; they can't be scripted.

1. **Tailscale on both machines**, signed into the **same tailnet**.
   (Mac App Store build is fine — we used plain SSH as the transport, not
   `tailscale ssh`.)
2. **Remote Login (SSH) enabled on the station:** System Settings →
   General → Sharing → **Remote Login** ON.
3. Confirm you can reach the station from the laptop:
   `ssh <admin-user>@<station-tailnet-name>` should connect.

---

## Step 0 — Make the station reachable by a friendly name (`ssh macmini`)

An SSH alias lives in `~/.ssh/config` and is **per-machine** — it does
not sync between your Macs, and it's unrelated to Tailscale. Add it on
the **laptop** so `ssh macmini` resolves over the tailnet from anywhere:

```sshconfig
# ~/.ssh/config  (on the laptop)
Host macmini
    HostName hugo-mac.tail517eef.ts.net   # the station's Tailscale MagicDNS name
    User hugomac
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

Test: `ssh macmini 'echo ok; hostname'`.

> **Gotchas we hit**
> - The host is named `macmini` (no hyphen). `ssh mac-mini` → "could not
>   resolve hostname".
> - Use the **Tailscale name**, not the LAN IP `10.0.0.164` — the LAN IP
>   only works at home and defeats the whole "close the laptop, reopen
>   anywhere" point.
> - If `ssh macmini` ever times out but `ssh <user>@<tailnet-ip>` works,
>   it's a transient Tailscale relay flap — the mount watchdog retries,
>   so it self-heals.

---

## Step 1 — Keep the station awake (so it's always reachable)

A station must **never sleep**. Ours shipped set to sleep after **1
minute** idle — that caused SSH/Tailscale to drop out. Fix it (needs the
admin password, run in a real terminal):

```bash
ssh -t macmini 'sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1'
```

| flag | effect |
|---|---|
| `sleep 0` | never sleep |
| `disksleep 0` | don't spin the disk down |
| `womp 1` | wake when a network packet arrives |
| `autorestart 1` | power back on automatically after a power cut |

Verify: `ssh macmini 'pmset -g | grep -E " sleep| autorestart"'` → `sleep
0`.

> **Reboot resilience (optional).** The station's disk uses FileVault and
> auto-login is off. That's secure, but after any **reboot** the Mini
> waits at the disk-unlock screen — no network until someone types the
> password. If the box is on a trusted network and you want it to recover
> reboots completely unattended, turn FileVault **off** and enable
> **auto-login** for the admin user (macOS won't do boot-time auto-login
> while FileVault is on). Otherwise, keep FileVault on and accept that the
> rare reboot needs a manual unlock.

---

## Step 2 — Satellite prerequisites (on the laptop)

```bash
brew install node pnpm go
```

> **Why `go`?** `INSTALL.md` only mentions node + pnpm, but the satellite
> installer also builds a local-mode `reck-stationd` from source, which
> needs Go. Install it now or that step fails.

---

## Step 3 — Station prerequisites (on the Mini)

The station needs Homebrew + the Command Line Tools + node + go. The
Homebrew bootstrap conveniently installs the Command Line Tools for you
(headless, no GUI dialog), so it's two commands:

**3a. Homebrew + CLT** — needs the admin password, run in a real terminal:
```bash
ssh -t macmini 'sudo -v && NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
```

**3b. node + go** — no password needed (Homebrew owns `/opt/homebrew`):
```bash
ssh macmini 'eval "$(/opt/homebrew/bin/brew shellenv)"; brew install node go'
```

> **Gotcha:** a fresh Mac often has **no Command Line Tools** (`clang`),
> which the station's `cgo` build needs. `git` existing at `/usr/bin/git`
> is a stub and doesn't mean CLT is installed. The Homebrew installer in
> 3a pulls them in automatically.

---

## Step 4 — Register the mount key on the station (from the laptop)

The satellite mounts the station's projects over sshfs using a dedicated
key, `~/.ssh/reck_mount`. Generate it and authorise its public half on
the station's admin account:

```bash
[ -f ~/.ssh/reck_mount ] || ssh-keygen -t ed25519 -f ~/.ssh/reck_mount -N "" -C "reck-mount@$(hostname -s)"
PUB="$(cat ~/.ssh/reck_mount.pub)"
ssh macmini "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; \
  grep -qxF '$PUB' ~/.ssh/authorized_keys || printf '%s\n' '$PUB' >> ~/.ssh/authorized_keys"
```

Verify the key authenticates as the station user (this is exactly what
the mount does):
```bash
ssh -i ~/.ssh/reck_mount -o IdentitiesOnly=yes hugomac@hugo-mac.tail517eef.ts.net 'echo MOUNT_KEY_OK'
```

---

## Step 5 — Install the station daemon (on the Mini)

Run as the station admin user. It builds + installs the daemon, mints a
bearer token, bootstraps the LaunchAgent, and writes a result file with
the token + station URL. It calls `sudo`, so run it in a real terminal
and type the admin password once when prompted:

```bash
ssh -t macmini '
  eval "$(/opt/homebrew/bin/brew shellenv)"
  mkdir -p ~/claude-code && cd ~/claude-code
  [ -d reck-connect ] || git clone https://github.com/Rudie-Verweij/reck-connect reck-connect
  cd reck-connect/ops
  RECK_STATION_USER=hugomac RECK_STATION_ROOT=/Users/hugomac/projects ./install-station.sh
'
```

It self-verifies (`/health` returns 401 without the token, 200 with it)
and writes `~/.reck-install-result.json` containing the daemon token and
`station_url` (e.g. `http://100.88.142.53:7315`).

> **Gotcha — fresh Apple Silicon Macs have no `/usr/local/bin`.** Homebrew
> lives in `/opt/homebrew`, so `/usr/local/bin` may not exist at all. The
> installer symlinks the Claude CLI into it and installs `reck-stationd`
> there, failing with `ln: /usr/local/bin/claude: No such file or
> directory`. Create it once first — `ssh -t macmini 'sudo mkdir -p
> /usr/local/bin'` — then run `install-station.sh` (safe to re-run). Note
> this is *not* a "claude isn't installed" problem; claude is found at
> `~/.local/bin/claude`, it just needs to be reachable from the daemon's
> restricted PATH.

> **Why run as the existing user?** `install-station.sh` bootstraps a
> per-user LaunchAgent into the user's GUI (`gui/<uid>`) session and
> **aborts if that session doesn't exist**. A brand-new account has never
> logged in graphically, so it has no GUI session — that's the main
> reason we reused `hugomac` instead of creating `reck-connect`.

Pull the result file to the laptop for the next step:
```bash
scp macmini:.reck-install-result.json /tmp/reck-install-result.json
```

---

## Step 6 — Install the satellite mount + first-launch config (on the laptop)

Run in a real terminal — it installs the FUSE-T casks and a watchdog via
`sudo`, so it prompts for your **laptop** password:

```bash
cd ~/Documents/GitHub/reck-connect/ops
RECK_SATELLITE_TOKEN="$(jq -r .token /tmp/reck-install-result.json)" \
RECK_STATION_USER=hugomac \
RECK_STATION_ROOT=/Users/hugomac/projects \
STATION_HOST=hugo-mac.tail517eef.ts.net \
./install-satellite.sh --key-already-installed \
  --write-settings "$(jq -r .station_url /tmp/reck-install-result.json)"
```

This installs FUSE-T + fuse-t-sshfs + rsync, writes the `reck-station`
SSH block, installs the mount watchdog LaunchAgent, and seeds a
`bootstrap.json` so the app auto-configures on first launch.

> **Same `/usr/local/bin` gotcha applies to the laptop.** The watchdog is
> installed via `sudo install … /usr/local/bin/reck-mount-watchdog`, and a
> fresh Apple Silicon laptop may not have that directory either. Prepend
> `sudo mkdir -p /usr/local/bin` to this step.

> **Homebrew 6 won't install third-party casks until you trust the tap.**
> The FUSE-T casks live in `macos-fuse-t/cask`, and modern Homebrew aborts
> with `Refusing to load cask … from untrusted tap`. Run once (no sudo):
> `brew trust macos-fuse-t/cask`, then re-run `install-satellite.sh`
> (it's idempotent — it skips whatever already installed).

> **`fuse-t-sshfs` needs your password** — it's a `.pkg` installed as root.
> Run `install-satellite.sh` in a real interactive terminal so `sudo` can
> prompt; it can't be driven non-interactively.

> **macOS 26 (Tahoe) only — one physical click.** The first mount needs
> the FUSE-T file-system extension approved:
> System Settings → Privacy & Security → Login Items & Extensions →
> **File System Extensions** → toggle **FUSE-T** on → Allow.
> Until you do, `~/reck/projects` stays empty and
> `~/Library/Logs/reck-stationd/mount.log` logs `sshfs failed (exit 1)`
> every 60 s.

> **Gotcha — FUSE-T rejects the watchdog's multi-cipher list.** The mount
> log shows `sshfs failed (exit 142): fuse: unknown option
> 'aes128-gcm@openssh.com'`. FUSE-T's `sshfs` splits `-o` values on commas,
> so the watchdog's `-o Ciphers=chacha20-poly1305@openssh.com,aes128-gcm@openssh.com`
> makes it treat the second cipher as a bogus mount option. Fix: edit
> `ops/reck-mount-watchdog.sh` to pin a **single** cipher
> (`-o Ciphers=chacha20-poly1305@openssh.com`), then reinstall the
> watchdog. Either reinstall canonically —
> `sudo install -m 0755 ops/reck-mount-watchdog.sh /usr/local/bin/reck-mount-watchdog` —
> or, to avoid sudo, drop the fixed copy in `~/.local/bin/reck-mount-watchdog`
> and point the (user-owned) LaunchAgent at it:
> `/usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $HOME/.local/bin/reck-mount-watchdog" ~/Library/LaunchAgents/eu.verwey.reck-mount.plist`
> then `launchctl bootout gui/$(id -u)/eu.verwey.reck-mount; launchctl
> bootstrap gui/$(id -u) ~/Library/LaunchAgents/eu.verwey.reck-mount.plist`.
> Verify with `tail ~/Library/Logs/reck-stationd/mount.log` → `remount succeeded`.

---

## Step 7 — Build, install, and launch the app (on the laptop)

```bash
cd ~/Documents/GitHub/reck-connect/satellite
VITE_RECK_STATION_ROOT=/Users/hugomac/projects pnpm install
VITE_RECK_STATION_ROOT=/Users/hugomac/projects pnpm dist
cp -R "release/mac-arm64/Reck Connect Satellite.app" /Applications/
open -a "Reck Connect Satellite"
```

> **Gotcha — pnpm 11 blocks native build scripts.** `pnpm install`/`pnpm
> dist` fails with `ERR_PNPM_IGNORED_BUILDS: Ignored build scripts:
> electron, esbuild, sharp`. The project allowlists these via
> `package.json`'s `pnpm.onlyBuiltDependencies`, but pnpm 11 no longer
> reads that field — it lives in `pnpm-workspace.yaml` now. pnpm even
> scaffolds a placeholder `pnpm-workspace.yaml` for you; fill it in:
> ```yaml
> allowBuilds:
>   electron: true
>   esbuild: true
>   sharp: true
> ```
> Then re-run `pnpm install` (you'll see the postinstall scripts run) and
> `pnpm dist`. Without this, electron's runtime + esbuild/sharp native
> binaries never build and the app can't be packaged.

The app reads `bootstrap.json` on first launch and should land on the
**project list** (not the mode-chooser). No `.app` is shipped pre-built —
every install compiles locally so Gatekeeper never sees an unsigned
binary.

---

## Verify the whole thing

```bash
# 1. Daemon healthy (use the token from the result file)
curl -fsS -H "Authorization: Bearer <token>" http://100.88.142.53:7315/health

# 2. Mount is live (within ~60s of the watchdog tick)
mount | grep "$HOME/reck/projects" && ls ~/reck/projects/.reck-mount-sentinel

# 3. Station reachable over the tailnet
ssh macmini 'echo ok'

# 4. Roaming test — get off the home LAN (hotspot) and confirm ssh macmini
#    + the app still connect via Tailscale.
```

If the mount is empty, tail `~/Library/Logs/reck-stationd/mount.log`
(usual cause: the macOS 26 FUSE-T approval in Step 6 is still pending).

---

## Problems we hit & how we fixed them (scan this first when something breaks)

Every one of these cost real time on this install. They're written up inline in
the steps above too, but here they are in one place — search the **Symptom**
column for the error you're staring at.

| # | Symptom | Cause | Fix | Preventable? |
|---|---|---|---|---|
| 1 | `ln: /usr/local/bin/claude: No such file or directory` (station) or `install: /usr/local/bin/reck-mount-watchdog … No such file or directory` (laptop) | Fresh Apple Silicon Macs have **no `/usr/local/bin`** — Homebrew lives in `/opt/homebrew`. The installers `sudo install`/`ln` into `/usr/local/bin`. | `sudo mkdir -p /usr/local/bin` once, then re-run the installer (idempotent). | **Yes** — the installers should `mkdir -p` it themselves. Still open. |
| 2 | `Refusing to load cask … from untrusted tap` when installing FUSE-T | Homebrew 6+ won't load third-party casks (`macos-fuse-t/cask`) until the tap is trusted. The installer taps but doesn't trust. | `brew trust macos-fuse-t/cask`, then re-run `install-satellite.sh`. | **Yes** — add a `brew trust` after the `brew tap`. Still open. |
| 3 | `sshfs failed (exit 142): fuse: unknown option 'aes128-gcm@openssh.com'`; mount never comes up | FUSE-T's `sshfs` splits `-o` values on commas, so the watchdog's **multi-cipher** `-o Ciphers=a,b` made it treat the 2nd cipher as a bogus mount option. | Pin a **single** cipher in `ops/reck-mount-watchdog.sh` (`chacha20-poly1305@openssh.com`), reinstall the watchdog. | **Fixed in repo** — `ops/reck-mount-watchdog.sh` now ships one cipher. |
| 4 | `ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: electron, esbuild, sharp`; `.app` won't package | pnpm 11 stopped reading `pnpm.onlyBuiltDependencies` from `package.json`; the allowlist moved to `pnpm-workspace.yaml`. | Add `allowBuilds: {electron, esbuild, sharp: true}` to `satellite/pnpm-workspace.yaml`, re-run `pnpm install` + `pnpm dist`. | **Fixed in repo** — `satellite/pnpm-workspace.yaml` is committed with the allowlist. |
| 5 | `sshfs failed (exit 1)` every 60 s; `~/reck/projects` stays empty (macOS 26 only) | macOS 26 (Tahoe) routes FUSE-T through FSKit, which needs a one-time **File System Extension** approval. | System Settings → Privacy & Security → Login Items & Extensions → File System Extensions → toggle **FUSE-T** on → Allow. | **No** — Apple requires a physical click. Make it a loud prerequisite instead. |
| 6 | SSH/Tailscale to the station randomly drops; box unreachable | The Mini shipped set to **sleep after 1 minute** idle. | `ssh -t macmini 'sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1'`. | **Yes** — `install-station.sh` already uses sudo; it could set this. Still open. |
| 7 | `install-station.sh` aborts: `gui/<uid> is unreachable … log in graphically at least once` | The daemon is a per-user LaunchAgent and needs a real Aqua/GUI session. A never-graphically-logged-in account (e.g. a brand-new `reck-connect` user) has none. | Log into that account once at the physical login screen (this is the main reason we reused the existing `hugomac` admin user). | **No** — but it belongs in the prerequisite checklist, not as a surprise mid-install. |
| 8 | `claude` panes on the station do nothing | `install-station.sh` only smoke-tests `claude --version`; it never logs `claude` in. | `ssh macmini` → run `claude` once and complete login. | Partly — the installer could detect the unauthenticated state and say so. |
| 9 | `ssh mac-mini` → "could not resolve hostname"; or `ssh macmini` works at home but not away | (a) the SSH alias host is `macmini`, no hyphen; (b) the alias pointed at the LAN IP `10.0.0.164` instead of the Tailscale MagicDNS name. | Use `macmini`; point `HostName` at the tailnet name `hugo-mac.tail517eef.ts.net`. | n/a — config typo; documented in Step 0. |

---

## What should be automated next time (so nobody re-lives the above)

This install was done on a **pristine machine that had never run anything** —
which is exactly why the fresh-Mac gotchas (Problems #1, #2) bit so hard. Most
real machines have prior state instead (existing runtimes, occupied ports, old
configs), so the *opposite* surprises are likely for the next person. Either
way, the following manual toil is deterministic and belongs in code:

1. **`sudo mkdir -p /usr/local/bin` at the top of both installers.** One line
   each, before the first `sudo install`/`ln`. Kills Problem #1 outright. The
   single highest-value change.
2. **`brew trust macos-fuse-t/cask` right after the `brew tap`** in
   `install-satellite.sh`. Kills Problem #2.
3. **Offer to set never-sleep in `install-station.sh`.** It already calls `sudo`;
   a prompted `pmset -a sleep 0 disksleep 0 womp 1 autorestart 1` would close
   Problem #6.
4. **Add `go` to the satellite prerequisites in `INSTALL.md` Stage 0.** Today it
   only installs `node` + `pnpm`, but the satellite installer builds a local
   `reck-stationd` from source. Pure doc fix; removes a mid-install dead end.
5. **A two-line `setup-station-preflight.sh` / `setup-satellite-preflight.sh`** that
   does the un-scriptable-but-mechanical one-time bits (the `mkdir`, the `brew
   trust`, the `pmset`) and then hands off to the real installer. A shipped
   preflight script is worth ten paragraphs of "don't forget to…".
6. **Detect an unauthenticated `claude` on the station** (Problem #8) and print a
   one-line "run `claude` once to log in" instead of letting panes silently
   no-op.

Already absorbed into the repo since this install (no longer manual): the
single-cipher watchdog (#3) and the pnpm `allowBuilds` workspace file (#4 above
in the table). Leave them fixed.

> **Want me to do #1–#4 now?** They're small, mechanical, and I've confirmed
> against the current scripts that they're genuinely still open. Say the word
> and I'll patch the installers + `INSTALL.md`.

---

## Key files & where things live (so you're not grepping blind)

### On the station
- `/usr/local/bin/reck-stationd` — the daemon binary (`.prev` alongside = rollback copy).
- `/usr/local/bin/reck-pane-launcher` — holds the TCC/Accessibility grant for panes.
- `~/.config/reck/token` — the bearer token (mode 0600). Rotate via `rm` + re-run installer.
- `~/.config/reck/projects.toml` — the list of projects the station serves.
- `~/Library/LaunchAgents/eu.verwey.reck-stationd.plist` — the daemon's LaunchAgent (bakes in `RECK_STATION_ROOT`).
- `~/Library/Logs/reck-stationd.log` — daemon log; first place to look on a `/health` failure.
- `~/.reck-install-result.json` — token + `station_url` (mode 0600); this is what gets pulled to the laptop.
- `$RECK_STATION_ROOT/.reck-mount-sentinel` — proves the projects root is the real one, not an empty mount.

### On the satellite
- `~/.ssh/reck_mount` / `.pub` — the dedicated mount key (revocable without touching your other keys).
- `~/.ssh/config` — holds both the `macmini` alias (Step 0) and the managed `reck-station` block.
- `/usr/local/bin/reck-mount-watchdog` — the remount loop. **This install's divergence:** the fixed copy was put at `~/.local/bin/reck-mount-watchdog` to dodge a 3rd sudo prompt; a future `install-satellite.sh` run restores the canonical `/usr/local/bin` one.
- `~/.local/bin/reck-stationd` — the Local-mode daemon the app spawns (independent of the `.app` bundle; updated by `install-satellite.sh`).
- `~/Library/LaunchAgents/eu.verwey.reck-mount.plist` — the mount watchdog's LaunchAgent.
- `~/Library/Logs/reck-stationd/mount.log` — mount log; first place to look when `~/reck/projects` is empty.
- `~/reck/projects` — the sshfs mount of the station's projects.
- `~/Library/Application Support/reck-connect-satellite/` (and the title-case `Reck Connect Satellite/`) — the app's `settings.json` (encrypted) and first-launch `bootstrap.json`.
- `/tmp/reck-install-result.json` — the transient copy pulled from the station to feed `install-satellite.sh`.

---

## Day-2 notes

- **Add projects:** put or symlink repos under `/Users/hugomac/projects`
  on the Mini, or register paths in `~/.config/reck/projects.toml`, then
  `launchctl kickstart -k gui/$(ssh macmini id -u)/eu.verwey.reck-stationd`.
- **Log in `claude` on the station** once (`ssh macmini` → `claude`) so
  Claude panes can run — the installer only smoke-tests `claude --version`.
- **Updating:** `git pull` in both checkouts, re-run
  `install-satellite.sh` and `install-station.sh`, rebuild the `.app`
  (see `INSTALL.md` §Updating).

---

## Progress log (this install)

- [x] **Step 0** — `macmini` SSH alias added on the laptop (fixed a typo'd
  `HostName 100.0.0.164` → the Tailscale name) and verified.
- [x] **Step 1** — never-sleep locked in: `sleep 0`, `disksleep 0`,
  `autorestart 1`, `womp 1`.
- [x] **Step 2** — laptop got `node` v26.3.1, `pnpm` 11.8.0, `go` 1.26.4.
- [x] **Step 3** — Mini has Homebrew 6.0.2 + CLT (clang 21), `node`
  v26.3.1, `npm` 11.16.0, `go`.
- [x] **Step 4** — `reck_mount` key generated + authorised on the Mini,
  authentication proven.
- [x] **Step 5** — station daemon running (`gui/501/eu.verwey.reck-stationd`);
  `/health` returns 200 over Tailscale from the laptop. Needed a one-off
  `sudo mkdir -p /usr/local/bin` first (see gotcha above).
- [x] **Step 6** — satellite mount installed and **LIVE** (`fuse-t:/Reck
  Projects on ~/reck/projects`). FUSE-T was already approved (no FSKit
  click needed). Hit the multi-cipher watchdog bug (see gotcha) — fixed
  the script and the watchdog now auto-remounts (`remount succeeded`).
- [x] **Step 7** — app built (`pnpm dist`, after the `allowBuilds`
  fix), installed to `/Applications`, launched. It consumed
  `bootstrap.json` and wrote encrypted `settings.json`
  (`settings` + `station.token`) — self-configured to the station.

### Outcome (verified)

| Check | Result |
|---|---|
| Station never sleeps | `sleep 0`, `autorestart 1` |
| Daemon `/health` over Tailscale | `200` with bearer, `401` without |
| `~/reck/projects` mount | LIVE, auto-remounts via watchdog |
| `ssh macmini` | reachable over Tailscale |
| Satellite app | running, self-configured to the station |

> **One divergence to know about:** to avoid a 3rd sudo prompt, the fixed
> watchdog was installed to `~/.local/bin/reck-mount-watchdog` and the
> (user-owned) LaunchAgent repointed there, instead of the canonical
> `/usr/local/bin`. The repo's `ops/reck-mount-watchdog.sh` is also fixed,
> so a future `install-satellite.sh` re-run restores the canonical
> `/usr/local/bin` copy automatically.
