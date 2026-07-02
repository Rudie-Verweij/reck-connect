#!/usr/bin/env bash
# uninstall-station-linux.sh — disable + remove the systemd unit and the
# installed binaries. Leaves ~/.config/reck/ in place (token, projects.toml,
# log files) so config + history survive. Pass --purge to wipe those too.

set -euo pipefail

PURGE=0
if [[ "${1:-}" == "--purge" ]]; then
  PURGE=1
fi

UNIT_NAME="reck-stationd.service"
BIN_DIR="${HOME}/.local/bin"
UNIT_PATH="${HOME}/.config/systemd/user/${UNIT_NAME}"

if systemctl --user is-active --quiet "${UNIT_NAME}" 2>/dev/null; then
  echo "==> stopping ${UNIT_NAME}"
  systemctl --user stop "${UNIT_NAME}" || true
fi
if systemctl --user is-enabled --quiet "${UNIT_NAME}" 2>/dev/null; then
  echo "==> disabling ${UNIT_NAME}"
  systemctl --user disable "${UNIT_NAME}" || true
fi
if [[ -f "${UNIT_PATH}" ]]; then
  rm -f "${UNIT_PATH}"
fi

# Symmetric teardown of the Xvfb companion unit the installer adds.
XVFB_UNIT_NAME="reck-xvfb.service"
XVFB_UNIT_PATH="${HOME}/.config/systemd/user/${XVFB_UNIT_NAME}"
if systemctl --user is-active --quiet "${XVFB_UNIT_NAME}" 2>/dev/null; then
  echo "==> stopping ${XVFB_UNIT_NAME}"
  systemctl --user stop "${XVFB_UNIT_NAME}" || true
fi
if systemctl --user is-enabled --quiet "${XVFB_UNIT_NAME}" 2>/dev/null; then
  echo "==> disabling ${XVFB_UNIT_NAME}"
  systemctl --user disable "${XVFB_UNIT_NAME}" || true
fi
rm -f "${XVFB_UNIT_PATH}"
systemctl --user daemon-reload

rm -f "${BIN_DIR}/reck-stationd" "${BIN_DIR}/reck-pane-launcher"

if [[ "${PURGE}" -eq 1 ]]; then
  echo "==> --purge: removing ~/.config/reck and ~/.local/state/reck-stationd"
  rm -rf "${HOME}/.config/reck" "${HOME}/.local/state/reck-stationd"
fi

echo "==> done."
echo "    To also stop the service surviving reboots: sudo loginctl disable-linger \$USER"
