#!/usr/bin/env bash
# uninstall-satellite.sh — reverse install-satellite.sh.
# Leaves brew casks installed (manual brew uninstall if you want them gone).

set -euo pipefail

MOUNT_POINT="$HOME/reck/projects"
KEY="$HOME/.ssh/reck_mount"
SSH_CONFIG="$HOME/.ssh/config"
WATCHDOG_DST="/usr/local/bin/reck-mount-watchdog"
PLIST_DST="$HOME/Library/LaunchAgents/eu.verwey.reck-mount.plist"

# `|| true` is applied only to commands that are legitimately idempotent
# (target might already be absent / service already unloaded). Any other
# failure should halt the script so the operator isn't told "Done." on
# a partial uninstall.

echo "==> Unloading LaunchAgent"
# bootout fails loudly when the service isn't loaded — idempotent skip.
launchctl bootout gui/"$UID"/eu.verwey.reck-mount >/dev/null 2>&1 || true

echo "==> Force-unmounting $MOUNT_POINT"
# If nothing is mounted, diskutil errors — idempotent skip.
diskutil unmount force "$MOUNT_POINT" >/dev/null 2>&1 || true

echo "==> Removing plist, watchdog, empty mount dir"
# rm -f is already idempotent w.r.t. missing files; don't mask other
# failures (e.g. permission errors) with `|| true`.
rm -f "$PLIST_DST"
sudo rm -f "$WATCHDOG_DST"

# Sweep stale bootstrap.json copies. install-satellite.sh may have
# seeded both candidate userData dirs (lowercase + title-case) when no
# packaged .app was installed at the time. Whichever one the launched
# Satellite consumed got cleaned up by bootstrap-import.ts; the other
# is orphaned. It contains the daemon token, so don't leave it behind.
for dir in \
  "$HOME/Library/Application Support/reck-connect-satellite" \
  "$HOME/Library/Application Support/Reck Connect Satellite"
do
  if [[ -f "$dir/bootstrap.json" ]]; then
    echo "  -> removing orphaned $dir/bootstrap.json"
    rm -f "$dir/bootstrap.json"
  fi
done
# rmdir only succeeds on an empty dir — skip if populated (user still
# has files in $MOUNT_POINT) or already removed.
rmdir "$MOUNT_POINT" 2>/dev/null || true

read -rp "Remove SSH key $KEY? [y/N] " ans
if [[ "$ans" =~ ^[Yy] ]]; then
  rm -f "$KEY" "$KEY.pub"
  echo "  -> removed"
fi

# Match both the managed-marker form from install-satellite.sh and the
# older literal `^Host reck-station$` line for pre-marker installs.
if grep -qF "# BEGIN reck-station (managed by install-satellite.sh)" "$SSH_CONFIG" 2>/dev/null \
   || grep -qE "^[[:space:]]*Host([[:space:]]|=).*\breck-station\b" "$SSH_CONFIG" 2>/dev/null; then
  echo
  echo "Your ~/.ssh/config still has the reck-station stanza. Remove it"
  echo "manually if you want — we don't want to edit SSH config blindly."
  echo "(Managed blocks are bracketed by # BEGIN reck-station … # END reck-station.)"
fi

echo "Done."
