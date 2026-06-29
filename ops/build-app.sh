#!/usr/bin/env bash
# build-app.sh — one-shot Satellite app builder.
#
# Sources ~/.config/reck/satellite.env, exports RECK_STATION_ROOT and
# the matching VITE_* mirror, runs `pnpm install && pnpm dist`, and
# (optionally) copies the built bundle into /Applications.
#
# Why a wrapper exists: the build needs the same value injected in
# three different places — Vite's renderer-side `import.meta.env.VITE_*`
# (compiled into the bundle), the main process's runtime `process.env`,
# and electron-builder's `extendInfo.LSEnvironment` block (baked into
# Info.plist via `${env.RECK_STATION_ROOT}` substitution). Running
# `pnpm dist` by hand without setting all of these correctly is the
# easy way to ship a broken .app, so this script does it for you.
#
# Usage:
#   ./ops/build-app.sh                  # build only, leave .app in release/
#   ./ops/build-app.sh --install        # also copy to /Applications/

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SATELLITE_DIR="$REPO_ROOT/satellite"
ENV_FILE="$HOME/.config/reck/satellite.env"
APP_NAME="Reck Connect Satellite"
INSTALL_TO_APPLICATIONS=0

while (( $# > 0 )); do
  case "$1" in
    --install)
      INSTALL_TO_APPLICATIONS=1
      shift
      ;;
    --help|-h)
      sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# //;s/^#//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  cat >&2 <<EOM
ERROR: $ENV_FILE not found.

Run ./ops/install-satellite.sh first — it generates the .env from
the template (ops/satellite.env.example) and prompts you to fill it
in. Once that file exists, re-run this script.
EOM
  exit 1
fi

# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a

: "${RECK_STATION_ROOT:?RECK_STATION_ROOT not set in $ENV_FILE}"

# Vite picks up env vars prefixed with VITE_ at build time and emits
# them as static literals in the renderer bundle. Mirror the canonical
# value from RECK_STATION_ROOT so the .env stays single-source.
export VITE_RECK_STATION_ROOT="$RECK_STATION_ROOT"

# pnpm 11 requires interactive `pnpm approve-builds` even when
# package.json's `pnpm.onlyBuiltDependencies` lists the relevant
# packages. pnpm 10 respects the package.json field directly. Prefer
# pnpm 10 from `brew install pnpm@10` if available; otherwise use
# whatever `pnpm` resolves to. Override by exporting PNPM_BIN.
if [[ -z "${PNPM_BIN:-}" ]]; then
  if [[ -x /opt/homebrew/opt/pnpm@10/bin/pnpm ]]; then
    PNPM_BIN=/opt/homebrew/opt/pnpm@10/bin/pnpm
  elif command -v pnpm >/dev/null 2>&1; then
    PNPM_BIN=$(command -v pnpm)
  else
    echo "ERROR: no pnpm on PATH. Install via 'brew install pnpm@10'." >&2
    exit 1
  fi
fi

echo "==> using pnpm: $PNPM_BIN ($($PNPM_BIN --version))"
echo "==> RECK_STATION_ROOT=$RECK_STATION_ROOT"
echo "==> VITE_RECK_STATION_ROOT=$VITE_RECK_STATION_ROOT"

cd "$SATELLITE_DIR"
"$PNPM_BIN" install
"$PNPM_BIN" dist

BUILT_APP="$SATELLITE_DIR/release/mac-arm64/$APP_NAME.app"
if [[ ! -d "$BUILT_APP" ]]; then
  echo "ERROR: build did not produce $BUILT_APP" >&2
  exit 1
fi

if (( INSTALL_TO_APPLICATIONS )); then
  echo "==> installing to /Applications"
  # rm-then-cp rather than `cp -Rf` so we don't merge content from a
  # stale older bundle. macOS Gatekeeper may quarantine the new bundle
  # on first launch — right-click → Open once if you see the
  # unsigned-binary warning.
  rm -rf "/Applications/$APP_NAME.app"
  cp -R "$BUILT_APP" /Applications/
  echo "==> installed: /Applications/$APP_NAME.app"
fi

echo "==> done."
echo "    Launch with: open -a \"$APP_NAME\""
