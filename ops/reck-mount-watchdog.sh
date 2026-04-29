#!/usr/bin/env bash
# reck-mount-watchdog — periodic liveness check for the reck projects mount.
# Invoked every 60 s by eu.verwey.reck-mount LaunchAgent.
# Exits 0 either way (success = mount live, or remount attempted).

set -u

MOUNT_POINT="$HOME/reck/projects"
SENTINEL="$MOUNT_POINT/.reck-mount-sentinel"
SSH_HOST="reck-station"              # Host alias in ~/.ssh/config
REMOTE_PATH="/Users/reck-connect/projects"

log() {
  printf '%s reck-mount-watchdog: %s\n' "$(date '+%F %T')" "$*"
}

if /usr/bin/stat "$SENTINEL" >/dev/null 2>&1; then
  exit 0
fi

log "sentinel stat failed — remounting"
/usr/sbin/diskutil unmount force "$MOUNT_POINT" >/dev/null 2>&1 || true
mkdir -p "$MOUNT_POINT"

# FUSE-T (≤macOS 15) runs an NFSv4 loopback helper alongside sshfs. The
# helper basename used to be `go-nfsv4`; FUSE-T 1.2.x renamed it to
# `go-nfsv4-<version>` (e.g. `go-nfsv4-1.2.1`), and a future 1.3.x will
# carry its own suffix. Match by prefix, not exact equality, so the
# reaper keeps working across helper versions.
#
# If the sshfs parent dies unexpectedly (Tailscale flap, perl-alarm kill
# from this script, OOM) the helper can outlive it as an orphan, hold an
# idle NFS endpoint, and accumulate across watchdog ticks — one leaked
# helper per dead sshfs, never reaped by hand.
#
# diskutil unmount force handles the kernel-side teardown, but does NOT
# reap the userland helper. Do it explicitly here, but *narrowly*: only
# kill helper processes whose parent has died (PPID=1, reparented to
# launchd). A helper serving another live FUSE-T mount still has its
# sshfs as parent and is left alone. SIGTERM first, settle, SIGKILL any
# stragglers.
#
# macOS 26 (Tahoe) FUSE-T uses FSKit instead and spawns no helper, so
# the ps query returns nothing and the block is a no-op. See
# ops/README.md §"FUSE-T on macOS 26" for the upgrade recipe.
# `ucomm` is BSD ps's basename-only command column; `comm` on macOS
# reports the full exec path, which would miss a prefix match.
orphan_pids=$(/bin/ps -u "$UID" -o pid=,ppid=,ucomm= 2>/dev/null \
  | awk '$2 == 1 && $3 ~ /^go-nfsv4/ { print $1 }')
if [[ -n "$orphan_pids" ]]; then
  # Flatten newlines to spaces for the log line.
  log "reaping orphaned go-nfsv4 helpers (PPID=1): $(echo $orphan_pids)"
  # shellcheck disable=SC2086 # intentional word-splitting of pid list
  kill $orphan_pids 2>/dev/null || true
  sleep 1
  for pid in $orphan_pids; do
    if kill -0 "$pid" 2>/dev/null; then
      log "go-nfsv4 pid $pid still alive after SIGTERM — SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
fi

if ! command -v sshfs >/dev/null 2>&1; then
  log "sshfs binary not found on PATH — is fuse-t-sshfs installed?"
  exit 0
fi

# sshfs stderr capture moved out of /tmp into the same per-user log dir
# the LaunchAgent's StandardErrorPath now uses. install-satellite.sh
# creates this directory before bootstrapping the agent; we mkdir -p
# here too so an out-of-band run still finds a writable location.
LOG_DIR="$HOME/Library/Logs/reck-stationd"
mkdir -p "$LOG_DIR"
SSHFS_ERR="$LOG_DIR/mount-sshfs.err"
: >"$SSHFS_ERR"

# Hard 15s timeout — sshfs with -o reconnect can otherwise background-retry
# indefinitely and block this script from ever exiting, which freezes
# launchd's StartInterval and leaves the mount dead until manual kick.
# macOS has no timeout(1); perl's alarm is always available. The outer
# 2>/dev/null suppresses bash's "Alarm clock: 14" diagnostic that would
# otherwise land in the log when perl is killed by its own alarm.
( /usr/bin/perl -e 'alarm shift @ARGV; exec @ARGV' 15 sshfs \
    "$SSH_HOST:$REMOTE_PATH" "$MOUNT_POINT" \
    -o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3 \
    -o volname="Reck Projects" \
    -o noappledouble \
    -o auto_cache \
    -o defer_permissions 2>"$SSHFS_ERR" ) 2>/dev/null
ec=$?
if [[ $ec -ne 0 ]]; then
  if [[ -s "$SSHFS_ERR" ]]; then
    log "sshfs failed (exit $ec): $(tr '\n' ' ' <"$SSHFS_ERR")"
  else
    log "sshfs failed (exit $ec)"
  fi
fi

sleep 1
if /usr/bin/stat "$SENTINEL" >/dev/null 2>&1; then
  log "remount succeeded"
else
  log "remount did not produce a live sentinel — will retry next tick"
fi
exit 0
