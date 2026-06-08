# Mount

The satellite-side FUSE-T/sshfs mount makes the station's project tree visible to local tools on the laptop. When a project is registered and a mount is active, the station path `/Users/reck-connect/projects/<id>` appears at `~/reck/projects/<id>` on the laptop, letting editors and local CLI tools read and write project files over the Tailscale tunnel.

## How it works

1. `install-satellite.sh` installs FUSE-T, fuse-t-sshfs, and Homebrew rsync; generates an SSH key at `~/.ssh/reck_mount`; and writes a `reck-station` host alias into `~/.ssh/config` pointing to the station over Tailscale.
2. A LaunchAgent (`eu.verwey.reck-mount`) is registered at `~/Library/LaunchAgents/eu.verwey.reck-mount.plist`. It runs `reck-mount-watchdog.sh` (installed to `/usr/local/bin/reck-mount-watchdog`) every 60 seconds and on login.
3. The watchdog checks whether `~/reck/projects/.reck-mount-sentinel` is stat-able. If yes, the mount is live and the script exits 0 immediately. If no, it force-unmounts the stale mount point, reaps any orphaned `go-nfsv4` helpers (see below), and calls sshfs to remount.

Source: `ops/reck-mount-watchdog.sh`, `ops/install-satellite.sh`, `ops/eu.verwey.reck-mount.plist.tmpl`.

## macOS version split: FUSE-T vs FSKit

FUSE-T's behavior differs by macOS version:

| macOS | FUSE-T path | NFS helper |
|---|---|---|
| 15 (Sequoia) and older | NFSv4 loopback via `go-nfsv4` helper | Yes — helper spawned alongside sshfs |
| 26 (Tahoe) and newer | FSKit native filesystem extension | No — FSKit spawns no helper |

The Homebrew cask ships both paths; which one runs is selected at mount time based on the OS version.

**Upgrading macOS 15 to 26:** after the OS upgrade, refresh the cask and reload the agent:

```bash
brew upgrade --cask fuse-t fuse-t-sshfs
launchctl bootout gui/"$UID"/eu.verwey.reck-mount || true
launchctl bootstrap gui/"$UID" ~/Library/LaunchAgents/eu.verwey.reck-mount.plist
```

macOS 26 will prompt once in System Settings → Privacy & Security → Login Items & Extensions to allow the FSKit extension. The watchdog logs `sshfs failed (exit 1)` on every 60-second tick until you approve it.

Full details: `ops/README.md` §"FUSE-T on macOS 26".

## go-nfsv4 orphan reaping (macOS ≤15 only)

On macOS 15 and older, FUSE-T spawns a `go-nfsv4` helper process alongside each sshfs instance. If sshfs dies unexpectedly (Tailscale flap, watchdog SIGALRM, OOM), the helper becomes an orphan — its PPID changes to 1 (reparented to launchd). Orphans accumulate across watchdog ticks and hold idle NFS endpoints.

The watchdog reaps orphans narrowly:

```bash
orphan_pids=$(/bin/ps -u "$UID" -o pid=,ppid=,ucomm= | awk '$2 == 1 && $3 == "go-nfsv4" { print $1 }')
```

Only helpers with PPID=1 are killed (SIGTERM, then SIGKILL after 1 second). Helpers still parented to a live sshfs are left alone.

On macOS 26, `pgrep -u "$UID" -x go-nfsv4` returns nothing and the block is a no-op.

## Homebrew dependencies

| Package | Why |
|---|---|
| `fuse-t` (cask) | FUSE-T kernel extension / FSKit extension |
| `fuse-t-sshfs` (cask) | sshfs binary backed by FUSE-T |
| `rsync` (formula) | Real GNU rsync for the project copy flow; macOS 14+ ships `openrsync` at `/usr/bin/rsync` which does not support `--info=progress2` |

`install-satellite.sh` installs all three via Homebrew.

## SSH configuration

`install-satellite.sh` generates an ed25519 key at `~/.ssh/reck_mount` and appends a managed block to `~/.ssh/config`:

```
Host reck-station
  HostName <station-tailscale-hostname>
  User reck-connect
  IdentityFile ~/.ssh/reck_mount
  IdentitiesOnly yes
  ServerAliveInterval 15
  ServerAliveCountMax 3
```

The watchdog connects as `reck-station` (this alias). The one remaining manual step after install is:

```bash
ssh-copy-id -i ~/.ssh/reck_mount.pub reck-connect@<station-host>
```

Pre-set `STATION_HOST` in the environment to skip the interactive hostname prompt during install:

```bash
STATION_HOST=your-station ops/install-satellite.sh
```

The value is validated against an allowlist (DNS hostname, IPv4, or IPv6) before being written to `~/.ssh/config`. Newlines or whitespace in `STATION_HOST` are rejected — this prevents newline-injection into the SSH config file.

## LaunchAgent

| Field | Value |
|---|---|
| Label | `eu.verwey.reck-mount` |
| Program | `/usr/local/bin/reck-mount-watchdog` |
| `RunAtLoad` | `true` — fires on login (handles reboot remount) |
| `StartInterval` | `60` seconds |
| Log | `~/Library/Logs/reck-stationd/mount.log` |

`launchd` does not expand environment variables in `StandardOutPath` / `StandardErrorPath`. `install-satellite.sh` substitutes the literal `__HOME__` token in the plist template with `$HOME` at install time.

## rsync copy flow (project registration)

When registering a new project from the satellite UI by picking a local folder, the satellite's main process copies it to the station using rsync before registering it with the daemon. See `satellite/main/rsync-copy.ts`.

The copy excludes local-ephemeral build state that has no benefit over the mount:

```
.DS_Store  ._*  node_modules  dist  build  .venv  __pycache__  target  .next  .cache
```

rsync is invoked via `/opt/homebrew/bin/rsync` (preferred) or `/usr/local/bin/rsync`, falling back to bare `rsync` on PATH. The `/usr/bin/rsync` path is intentionally avoided because macOS 14+ ships `openrsync` there, which rejects `--info=progress2`.

## Gotchas

### sshfs `-o reconnect` can hang the watchdog

sshfs with `-o reconnect` daemonizes and keeps its stderr pipe open when the initial mount fails. The script never exits, which freezes launchd's `StartInterval` and leaves the mount dead until a manual kick.

The watchdog wraps every sshfs call in a 15-second hard timeout using the `perl alarm` pattern (macOS has no `timeout(1)`):

```bash
( /usr/bin/perl -e 'alarm shift @ARGV; exec @ARGV' 15 sshfs \
    "$SSH_HOST:$REMOTE_PATH" "$MOUNT_POINT" \
    -o reconnect,... ) 2>/dev/null
```

The outer `2>/dev/null` suppresses bash's `"Alarm clock: 14"` diagnostic that would otherwise appear in the log when perl kills itself with SIGALRM.

Source: `ops/reck-mount-watchdog.sh:79`, `CLAUDE.md` gotchas.

### macOS has no `timeout(1)`

Use `perl -e 'alarm shift @ARGV; exec @ARGV' <secs> <cmd>` for hard timeouts in shell scripts. This is the pattern used in `reck-mount-watchdog.sh` and documented in `CLAUDE.md`.

### `/usr/bin/rsync` is openrsync on macOS 14+

macOS 14 (Sonoma) replaced `/usr/bin/rsync` with `openrsync`, which does not support `--info=progress2`. Always invoke `/opt/homebrew/bin/rsync` for real rsync behavior. `rsync-copy.ts` and `install-satellite.sh` both account for this.

### Reboot remount not hardware-tested

The `RunAtLoad` path (laptop reboots, user logs in, LaunchAgent fires, watchdog mounts) has not been explicitly verified end-to-end on hardware at time of writing. The underlying primitives (watchdog, sshfs invocation) are tested on the 60-second tick path. See [../operations.md](../operations.md) for the full note.
