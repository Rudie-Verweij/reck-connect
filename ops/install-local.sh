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

# Ad-hoc re-sign + pre-warm. A freshly written binary triggers a
# one-time macOS Gatekeeper (syspolicyd) assessment on its FIRST exec —
# several seconds between posix_spawn and Go's main() — which used to
# lose the Satellite's wait-for-listen race and surface as "local
# daemon failed to listen within N ms". Running the binary once here
# moves that assessment off the app's critical path: the next Satellite
# launch sees a warm (~100 ms) bind.
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "==> Codesigning (ad-hoc) + pre-warming Gatekeeper assessment"
  codesign --force --sign - "$TARGET" 2>/dev/null || true
  PREWARM_PORT="${RECK_PREWARM_PORT:-7399}"
  PREWARM_LOG="$(mktemp -t reck-prewarm)"
  DAEMON_TOKEN="$(openssl rand -hex 32)" "$TARGET" \
    --mode=local --config "$CONFIG_DIR/projects.toml" \
    --addr "127.0.0.1:$PREWARM_PORT" >"$PREWARM_LOG" 2>&1 &
  PREWARM_PID=$!
  WARMED=""
  for _ in $(seq 1 100); do # up to 10 s
    if ! kill -0 "$PREWARM_PID" 2>/dev/null; then
      break # exited early (e.g. port in use) — assessment still done
    fi
    if grep -q '"msg":"listening"' "$PREWARM_LOG" 2>/dev/null; then
      WARMED=1
      break
    fi
    sleep 0.1
  done
  kill "$PREWARM_PID" 2>/dev/null || true
  wait "$PREWARM_PID" 2>/dev/null || true
  rm -f "$PREWARM_LOG"
  if [[ -n "$WARMED" ]]; then
    echo "    pre-warm OK — daemon bound 127.0.0.1:$PREWARM_PORT and was stopped"
  else
    echo "    pre-warm ran (no bind observed — assessment still cached)"
  fi
fi

echo ""
echo "Installed reck-stationd at $TARGET"
echo ""
echo "Next:"
echo "  1. Make sure $BIN_DIR is on your PATH (add to ~/.zprofile if needed):"
echo "       export PATH=\"\$HOME/.local/bin:\$PATH\""
echo "  2. Open Reck Satellite, pick 'Local' on first launch — it spawns the daemon automatically."
