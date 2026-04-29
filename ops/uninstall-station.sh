#!/usr/bin/env bash
set -euo pipefail

# uninstall-station.sh — remove the V2 station daemon completely.
# Wipes the launchd service, binary, plist, config, and log so a fresh
# `install-station.sh` starts from clean state. Must be run as the
# reck-connect user.
#
# Idempotent: each block tolerates the resource already being absent,
# so re-running is safe. Covers BOTH the legacy LaunchDaemon layout
# (system/eu.verwey.reck-stationd) and the current LaunchAgent
# layout (gui/<uid>/eu.verwey.reck-stationd) plus the now-retired
# reck-clipboard sidecar (issue #215 phase 2) so a partial-state
# box ends up clean either way.

if [[ "$(whoami)" != "reck-connect" ]]; then
    echo "This script must be run as the reck-connect user."
    exit 1
fi

UID_NUM=$(id -u)
GUI_DOMAIN="gui/$UID_NUM"
LABEL="eu.verwey.reck-stationd"

echo "==> Bootout reck-stationd"
# Both scopes — current LaunchAgent (gui) and legacy LaunchDaemon (system).
launchctl bootout "$GUI_DOMAIN/$LABEL" 2>/dev/null || true
sudo launchctl bootout system/$LABEL 2>/dev/null || true

echo "==> Bootout legacy reck-clipboard sidecar (phase 2: retired)"
launchctl bootout "$GUI_DOMAIN/eu.verwey.reck-clipboard" 2>/dev/null || true

echo "==> Removing plists"
rm -f "$HOME/Library/LaunchAgents/eu.verwey.reck-stationd.plist"
rm -f "$HOME/Library/LaunchAgents/eu.verwey.reck-clipboard.plist"
sudo rm -f /Library/LaunchDaemons/eu.verwey.reck-stationd.plist
sudo rm -f /Library/LaunchDaemons/eu.verwey.reck-stationd.plist.disabled

echo "==> Removing binaries"
sudo rm -f /usr/local/bin/reck-stationd
sudo rm -f /usr/local/bin/reck-stationd.prev
sudo rm -f /usr/local/bin/reck-clipboard

echo "==> Removing sidecar state ($HOME/.reck/)"
rm -f "$HOME/.reck/clipboard.sock" "$HOME/.reck/daemon.pid"
rmdir "$HOME/.reck" 2>/dev/null || true

echo "==> Removing log files"
rm -f "$HOME/Library/Logs/reck-stationd.log"
rm -f "$HOME/Library/Logs/reck-clipboard.out.log" "$HOME/Library/Logs/reck-clipboard.err.log"
sudo rm -f /var/log/reck-stationd.log

echo "==> Removing bearer token"
rm -f "$HOME/.config/reck/token"
# Legacy /etc/reck-stationd/token (LaunchDaemon era).
sudo rm -f /etc/reck-stationd/token
sudo rmdir /etc/reck-stationd 2>/dev/null || true

echo "==> Removing config ($HOME/.config/reck)"
rm -rf "$HOME/.config/reck"

echo ""
echo "Done. Station uninstalled."
echo "Re-run ./install-station.sh for a fresh install."
