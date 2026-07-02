#!/usr/bin/env bash
# install-station-linux.sh — install reck-stationd as a per-user systemd
# service on Linux (Pi 5 / Ubuntu / Debian). Run as the unprivileged user
# that will own the daemon; it will sudo only for `loginctl enable-linger`.
#
# What this does:
#   1. Builds reck-stationd + reck-pane-launcher into ~/.local/bin/.
#   2. Creates ~/.config/reck/ with a 0600 token if absent.
#   3. Writes a starter ~/.config/reck/projects.toml if absent.
#   4. Renders ~/.config/systemd/user/reck-stationd.service from the
#      template, substituting --addr / --claude / --pane-launcher.
#   5. systemctl --user daemon-reload + enable --now.
#   6. sudo loginctl enable-linger so the service runs at boot without
#      an interactive login.
#
# Idempotent — re-running upgrades the binary and reloads the unit.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
CFG_DIR="${HOME}/.config/reck"
STATE_DIR="${HOME}/.local/state/reck-stationd"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_NAME="reck-stationd.service"

ADDR="${RECK_ADDR:-0.0.0.0:7315}"
CLAUDE_BIN="${RECK_CLAUDE_BIN:-$(command -v claude || true)}"
LAUNCHER_PATH="${RECK_LAUNCHER_PATH:-${BIN_DIR}/reck-pane-launcher}"

echo "==> repo: ${REPO_ROOT}"
echo "==> addr: ${ADDR}"
echo "==> claude: ${CLAUDE_BIN:-<empty — set RECK_CLAUDE_BIN or install claude on PATH first>}"
echo "==> pane-launcher: ${LAUNCHER_PATH}"

if [[ -z "${CLAUDE_BIN}" ]]; then
  echo "WARN: claude binary not on PATH. Install Claude Code CLI first," >&2
  echo "      or set RECK_CLAUDE_BIN=/abs/path/claude before re-running." >&2
fi

command -v go >/dev/null || { echo "ERR: go toolchain missing. apt install golang-go (or grab tarball from go.dev/dl)." >&2; exit 1; }
command -v openssl >/dev/null || { echo "ERR: openssl missing." >&2; exit 1; }
command -v systemctl >/dev/null || { echo "ERR: systemctl missing — this script targets systemd hosts." >&2; exit 1; }

# xclip + Xvfb back the [Image #N] chip-paste path. The
# daemon writes pasted image bytes to the X clipboard via xclip; Claude
# Code reads them on Ctrl+V. On TTY-only Pi installs the install script
# also stands up Xvfb as a per-user systemd service so $DISPLAY:99 is
# always reachable. Skip with RECK_SKIP_CLIPBOARD=1 if you intend to
# run a real desktop session — the daemon will use that DISPLAY instead.
if [[ "${RECK_SKIP_CLIPBOARD:-0}" != "1" ]]; then
  for pkg_bin in "xvfb:Xvfb" "xclip:xclip"; do
    bin="${pkg_bin#*:}"
    pkg="${pkg_bin%:*}"
    if ! command -v "${bin}" >/dev/null; then
      echo "==> installing ${pkg} (provides ${bin})"
      sudo apt-get update -qq
      sudo apt-get install -y -qq "${pkg}"
    fi
  done
fi

mkdir -p "${BIN_DIR}" "${CFG_DIR}" "${STATE_DIR}" "${UNIT_DIR}"

echo "==> building reck-stationd"
( cd "${REPO_ROOT}" && go build -o "${BIN_DIR}/reck-stationd" ./daemon/cmd/reck-stationd )

echo "==> building reck-pane-launcher"
( cd "${REPO_ROOT}" && go build -o "${BIN_DIR}/reck-pane-launcher" ./daemon/cmd/reck-pane-launcher )

if [[ ! -f "${CFG_DIR}/token" ]]; then
  echo "==> generating token at ${CFG_DIR}/token"
  umask 077
  openssl rand -hex 32 > "${CFG_DIR}/token"
  chmod 0600 "${CFG_DIR}/token"
else
  echo "==> token already present at ${CFG_DIR}/token (kept)"
fi

if [[ ! -f "${CFG_DIR}/projects.toml" ]]; then
  echo "==> writing starter projects.toml"
  cat > "${CFG_DIR}/projects.toml" <<EOF
# Reck Connect — projects manifest. Each [[project]] block exposes a
# directory to the satellite. cwd must be an absolute path that exists.
# Add more blocks for each repo you want to pane-spawn into.

[[project]]
id    = "scratch"
name  = "Scratch"
cwd   = "${HOME}/scratch"
default_pane = "claude"
EOF
  mkdir -p "${HOME}/scratch"
fi

# The station daemon runs in --mode=station (the default), which REQUIRES
# RECK_STATION_ROOT or it exits 2 at startup. The systemd unit sources
# this .env via EnvironmentFile=-. Default to ~/projects (matches the
# daemon's linux managed-root default). Idempotent: an existing value is
# kept.
STATION_ROOT="${RECK_STATION_ROOT:-${HOME}/projects}"
if ! grep -q "^RECK_STATION_ROOT=" "${CFG_DIR}/.env" 2>/dev/null; then
  echo "==> writing RECK_STATION_ROOT=${STATION_ROOT} to ${CFG_DIR}/.env"
  mkdir -p "${STATION_ROOT}"
  echo "RECK_STATION_ROOT=${STATION_ROOT}" >> "${CFG_DIR}/.env"
  chmod 0600 "${CFG_DIR}/.env"
else
  STATION_ROOT="$(grep "^RECK_STATION_ROOT=" "${CFG_DIR}/.env" | cut -d= -f2-)"
  echo "==> RECK_STATION_ROOT already set: ${STATION_ROOT} (kept)"
fi

echo "==> rendering systemd units"
sed \
  -e "s|__ADDR__|${ADDR}|g" \
  -e "s|__CLAUDE_BIN__|${CLAUDE_BIN}|g" \
  -e "s|__LAUNCHER__|${LAUNCHER_PATH}|g" \
  "${REPO_ROOT}/ops/reck-stationd.service.tmpl" > "${UNIT_DIR}/${UNIT_NAME}"

# Xvfb companion unit. Started before reck-stationd via After= so the
# daemon's xclip probe finds a live $DISPLAY at boot. Skip when the
# operator opts out of the chip-paste backend.
if [[ "${RECK_SKIP_CLIPBOARD:-0}" != "1" ]]; then
  install -m 0644 "${REPO_ROOT}/ops/reck-xvfb.service" "${UNIT_DIR}/reck-xvfb.service"
fi

echo "==> systemctl --user daemon-reload + (re)start"
systemctl --user daemon-reload
if [[ "${RECK_SKIP_CLIPBOARD:-0}" != "1" ]]; then
  systemctl --user enable --now reck-xvfb.service
fi
systemctl --user enable "${UNIT_NAME}"
# Use restart, not `enable --now`: on a re-run/upgrade the service is
# already active, and `enable --now` would NOT load the freshly built
# binary or a changed unit (start is a no-op when already running, so the
# daemon keeps the old, now-deleted inode). restart loads the new build
# and also starts the service cleanly on a first install.
systemctl --user restart "${UNIT_NAME}"

echo "==> ensuring linger so service runs at boot without login"
if ! loginctl show-user "${USER}" 2>/dev/null | grep -q '^Linger=yes'; then
  sudo loginctl enable-linger "${USER}"
else
  echo "    linger already enabled"
fi

echo
echo "==> reck-stationd installed."
echo "    token:  ${CFG_DIR}/token"
echo "    config: ${CFG_DIR}/projects.toml"
echo "    log:    ${STATE_DIR}/reck-stationd.log"
echo "    status: systemctl --user status reck-stationd"
echo
echo "    Connect from satellite using:"
echo "      host: $(hostname)  (or your tailnet name, e.g. pi5.<tailnet>.ts.net)"
echo "      port: 7315"
echo "      token: $(cat "${CFG_DIR}/token")"
