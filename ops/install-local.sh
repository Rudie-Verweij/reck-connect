#!/usr/bin/env bash
set -euo pipefail

# install-local.sh — installs reck-stationd on the user's laptop for
# Satellite's Local mode. No sudo. No launchd. Satellite spawns the daemon
# on app start (see satellite/main/daemon-spawn.ts).

V2_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
TARGET="$BIN_DIR/reck-stationd"
CONFIG_DIR="$HOME/.config/reck"

command -v go >/dev/null 2>&1 || { echo "go not found — install via 'brew install go'"; exit 1; }

echo "==> Building reck-stationd"
# mkdir -p BEFORE `go build -o "$TARGET.new"` — otherwise a clean machine
# (no ~/.local/bin yet) aborts on the build, since -o writes directly to
# that path. Previously the mkdir ran only after the build, which made
# the script useless for first-time installs.
mkdir -p "$BIN_DIR"
pushd "$V2_ROOT" >/dev/null
go build -o "$TARGET.new" ./daemon/cmd/reck-stationd
popd >/dev/null

mv "$TARGET.new" "$TARGET"
chmod 0755 "$TARGET"

echo "==> Creating config directory"
mkdir -p "$CONFIG_DIR"
touch "$CONFIG_DIR/projects.toml"

echo ""
echo "Installed reck-stationd at $TARGET"
echo ""
echo "Next:"
echo "  1. Make sure $BIN_DIR is on your PATH (add to ~/.zprofile if needed):"
echo "       export PATH=\"\$HOME/.local/bin:\$PATH\""
echo "  2. Open Reck Satellite, pick 'Local' on first launch — it spawns the daemon automatically."
