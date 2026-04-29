#!/usr/bin/env bash
set -euo pipefail

# install-station.sh — end-to-end V2 station install.
#
# Issue #215 phase 1: reck-stationd now runs as a per-user LaunchAgent
# (gui/<uid>/eu.verwey.reck-stationd) instead of a system-scope
# LaunchDaemon. Same Aqua context as local mode, same direct-spawn
# code path, no sidecar audit-session dance. Closes the resize-scramble
# divergence by making station = local at the OS-launch level.
#
# Must be run AS the reck-connect user (the user that will own the
# Aqua session the daemon runs inside). One-shot:
#   1. Build reck-stationd binary, install to /usr/local/bin (sudo).
#   2. Resolve / migrate the DAEMON_TOKEN; write to ~/.config/reck/token (0600).
#   3. Render LaunchAgent plist with HOME substitutions, install to
#      ~/Library/LaunchAgents/.
#   4. Tear down the old LaunchDaemon if present and rename the plist to
#      .disabled (rollback path).
#   5. Bootstrap the LaunchAgent in gui/<uid>.
#   6. Build + install the reck-clipboard sidecar (kept for phase 1 —
#      retired in a follow-up after the LaunchAgent migration is verified).
#   7. Verify auth + reachability.
#
# Migration note (issue #49 / #215): the token survives whatever its
# previous home was — old LaunchDaemon plist EnvironmentVariables, old
# /etc/reck-stationd/token, ENV_FILE, or generated fresh. End state:
# single value at ~/.config/reck/token, mode 0600, owned by reck-connect.

if [[ "$(whoami)" != "reck-connect" ]]; then
    echo "This script must be run as the reck-connect user."
    echo "Create the user first via System Settings → Users & Groups (see ops/README.md §1)."
    exit 1
fi

# Non-interactive SSH shells don't source ~/.zprofile, so brew isn't on
# PATH. Pull it in ourselves (Apple Silicon + Intel fallback).
if ! command -v brew >/dev/null 2>&1; then
    if   [[ -x /opt/homebrew/bin/brew ]]; then eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [[ -x /usr/local/bin/brew    ]]; then eval "$(/usr/local/bin/brew shellenv)"
    fi
fi

V2_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_TMPL="$V2_ROOT/ops/eu.verwey.reck-stationd.plist.tmpl"

# New (LaunchAgent) target. Per-user; no sudo.
PLIST_TARGET="$HOME/Library/LaunchAgents/eu.verwey.reck-stationd.plist"

# Old (LaunchDaemon) target. Kept for tear-down + rollback.
LEGACY_DAEMON_PLIST="/Library/LaunchDaemons/eu.verwey.reck-stationd.plist"

BINARY_TARGET="/usr/local/bin/reck-stationd"
CONFIG_DIR="$HOME/.config/reck"
ENV_FILE="$CONFIG_DIR/.env"
PROJECTS_FILE="$CONFIG_DIR/projects.toml"
LOG_DIR="$HOME/Library/Logs"
LOG_FILE="$LOG_DIR/reck-stationd.log"

# Issue #215 phase 2: the reck-clipboard sidecar has been retired.
# These paths are kept solely for the teardown step further down —
# install-station.sh removes any artefacts a phase-1 station left
# behind so the box ends up clean.
CLIPBOARD_BINARY_TARGET="/usr/local/bin/reck-clipboard"

# Token storage.
# New (LaunchAgent): ~/.config/reck/token, owned by current user, mode 0600.
# Old (LaunchDaemon): /etc/reck-stationd/token, owned reck-connect:staff, mode 0600.
# The daemon's ResolveTokenChain prefers the new location and falls
# through to the old one for back-compat — same value either way during
# the migration window.
TOKEN_FILE="$CONFIG_DIR/token"
LEGACY_TOKEN_DIR="/etc/reck-stationd"
LEGACY_TOKEN_FILE="$LEGACY_TOKEN_DIR/token"

UID_NUM=$(id -u)
GUI_DOMAIN="gui/$UID_NUM"
LABEL="eu.verwey.reck-stationd"

echo "==> Checking prerequisites"
command -v go >/dev/null 2>&1 || { echo "Installing Go via brew..."; brew install go; }
command -v git >/dev/null 2>&1 || { echo "git required"; exit 1; }

echo "==> Building reck-stationd"
# Stage the unprivileged build in a private per-user dir (BSD mktemp -d
# defaults to mode 0700 under $TMPDIR, not world-writable /tmp) so a
# local attacker can't race-replace the binary between `go build` and
# the privileged `sudo install` below.
STAGE=$(mktemp -d -t reck-stage)
trap 'rm -rf "$STAGE"' EXIT
pushd "$V2_ROOT" >/dev/null
go build -o "$STAGE/reck-stationd" ./daemon/cmd/reck-stationd
popd >/dev/null

echo "==> Installing binary to $BINARY_TARGET (requires sudo)"
# Stash the previous binary at $BINARY_TARGET.prev so rollback can
# restore it. Codex 2026-04-28: the rollback trap re-bootstraps the
# legacy LaunchDaemon, which would otherwise execute the NEW binary
# (because we just overwrote $BINARY_TARGET) — defeating the point
# of rollback.
if [[ -f "$BINARY_TARGET" ]]; then
    sudo cp "$BINARY_TARGET" "$BINARY_TARGET.prev"
fi
sudo install -m 0755 "$STAGE/reck-stationd" "$BINARY_TARGET"
rm -rf "$STAGE"
trap - EXIT

echo "==> Creating config + log directories"
mkdir -p "$CONFIG_DIR"
mkdir -p "$LOG_DIR"
touch "$PROJECTS_FILE"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
touch "$LOG_FILE"
chmod 640 "$LOG_FILE"

if [[ ! -s "$PROJECTS_FILE" ]]; then
    echo "  -> copying example projects.toml (edit this later with your projects)"
    cp "$V2_ROOT/ops/examples/projects.toml" "$PROJECTS_FILE"
fi

echo "==> Resolving DAEMON_TOKEN"
# Precedence — and EXPLICIT conflict detection (Codex / Claude review
# 2026-04-27). The chain prefers $TOKEN_FILE, but a stale value at
# the new path from a partially-failed prior run could silently
# rotate the bearer onto something the legacy daemon would still
# accept while existing satellites get locked out:
#
#   1. If both $TOKEN_FILE and a legacy source exist AND differ →
#      ABORT. Operator must reconcile (either delete the wrong file
#      or pass --regenerate-token; the latter is intentionally not
#      yet implemented to make the conflict visible).
#   2. $TOKEN_FILE wins when it matches the legacy source (or no
#      legacy source exists).
#   3. Legacy LaunchDaemon token file → migrate.
#   4. Legacy plist EnvironmentVariables → migrate.
#   5. $ENV_FILE → migrate.
#   6. Generate fresh.
read_legacy_token() {
    if [[ -f "$LEGACY_TOKEN_FILE" ]] && sudo test -s "$LEGACY_TOKEN_FILE"; then
        sudo cat "$LEGACY_TOKEN_FILE" | tr -d '[:space:]'
        return 0
    fi
    if [[ -f "$LEGACY_DAEMON_PLIST" ]] && sudo /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:DAEMON_TOKEN" "$LEGACY_DAEMON_PLIST" >/dev/null 2>&1; then
        sudo /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:DAEMON_TOKEN" "$LEGACY_DAEMON_PLIST"
        return 0
    fi
    if grep -q "^DAEMON_TOKEN=" "$ENV_FILE" 2>/dev/null; then
        grep "^DAEMON_TOKEN=" "$ENV_FILE" | head -n1 | cut -d= -f2-
        return 0
    fi
    return 1
}

EXISTING_NEW=""
if [[ -s "$TOKEN_FILE" ]]; then
    EXISTING_NEW=$(tr -d '[:space:]' < "$TOKEN_FILE")
fi
EXISTING_LEGACY=$(read_legacy_token || true)

TOKEN=""
TOKEN_SOURCE=""
if [[ -n "$EXISTING_NEW" && -n "$EXISTING_LEGACY" && "$EXISTING_NEW" != "$EXISTING_LEGACY" ]]; then
    echo "  ✗ token conflict between $TOKEN_FILE and legacy source"
    echo "    A different DAEMON_TOKEN value lives in each. Migrating now"
    echo "    would silently rotate the bearer; existing satellites paired"
    echo "    against the legacy value would lose access."
    echo ""
    echo "    Reconcile manually before re-running:"
    echo "      • If the legacy token is canonical:"
    echo "          rm \"$TOKEN_FILE\"  &&  ./install-station.sh"
    echo "      • If the new token is canonical and you want to retire the legacy:"
    echo "          sudo rm \"$LEGACY_TOKEN_FILE\"  &&  ./install-station.sh"
    exit 1
fi

if [[ -n "$EXISTING_NEW" ]]; then
    TOKEN="$EXISTING_NEW"
    TOKEN_SOURCE="$TOKEN_FILE"
elif [[ -n "$EXISTING_LEGACY" ]]; then
    TOKEN="$EXISTING_LEGACY"
    TOKEN_SOURCE="legacy (migrating to $TOKEN_FILE)"
else
    TOKEN=$(openssl rand -hex 32)
    TOKEN_SOURCE="freshly generated"
fi
echo "  -> token source: $TOKEN_SOURCE"

echo "==> Writing token to $TOKEN_FILE (mode 0600)"
# install(1) on macOS can't read /dev/stdin, so stage in mktemp first.
# mktemp creates with 0600 by default; the staging file lives under
# $TMPDIR (per-user) so the secret is never world-readable transiently.
TOKEN_STAGE=$(mktemp)
trap 'rm -f "$TOKEN_STAGE"' EXIT
printf '%s\n' "$TOKEN" > "$TOKEN_STAGE"
install -m 0600 "$TOKEN_STAGE" "$TOKEN_FILE"
rm -f "$TOKEN_STAGE"
trap - EXIT

# Strip the legacy env-file copy (redundant once token lives in
# canonical file).
if grep -q "^DAEMON_TOKEN=" "$ENV_FILE" 2>/dev/null; then
    sed -i '' '/^DAEMON_TOKEN=/d' "$ENV_FILE"
    echo "  -> removed legacy DAEMON_TOKEN from $ENV_FILE"
fi

echo "==> Rendering LaunchAgent plist to $PLIST_TARGET"
mkdir -p "$(dirname "$PLIST_TARGET")"
sed "s|__HOME__|$HOME|g" "$PLIST_TMPL" > "$PLIST_TARGET"
chmod 644 "$PLIST_TARGET"

echo "==> Ensuring managed projects root + mount sentinel"
PROJ_ROOT="$HOME/projects"
mkdir -p "$PROJ_ROOT"
touch "$PROJ_ROOT/.reck-mount-sentinel"

# Sidecar teardown deferred until AFTER the daemon health check
# passes (rollback path needs the sidecar alive to support the
# old binary at $BINARY_TARGET.prev).

# ---------------------------------------------------------------------
# Switch reck-stationd from LaunchDaemon → LaunchAgent.
#
# Codex / Claude review 2026-04-27: a naive bootout(system) →
# bootstrap(gui) → mv .disabled → verify pipeline can strand the
# station offline if the bootstrap or any later step fails (set -e
# exits with the legacy daemon already gone). Hardening:
#
#   1. PRE-FLIGHT the gui/<uid> Aqua domain. SSH-only sessions on
#      macOS sometimes can't reach gui/<uid> until the user has
#      logged in graphically once; refuse to bootout the legacy
#      daemon if the target domain is unreachable.
#   2. INSTALL A ROLLBACK TRAP: if any step between bootout(system)
#      and successful health check fails, restore the legacy plist
#      and re-bootstrap it before exiting non-zero.
#   3. DEFER the legacy plist .disabled rename until AFTER the new
#      LaunchAgent has answered the health check. Until then the
#      legacy plist sits at /Library/LaunchDaemons/...plist (just
#      not loaded) — re-bootstrappable in one launchctl call.
# ---------------------------------------------------------------------

echo "==> Pre-flighting Aqua / GUI domain availability"
# `launchctl print gui/<uid>` exits non-zero if the per-user Aqua
# session doesn't exist (e.g. fresh box, SSH-only login on a Mac that
# has never had a graphical login). Refuse to tear down the legacy
# daemon on a machine that can't bootstrap the replacement.
if ! launchctl print "$GUI_DOMAIN" >/dev/null 2>&1; then
    echo "  ✗ $GUI_DOMAIN is unreachable. The Aqua session for uid=$UID_NUM"
    echo "    isn't loaded. The user must log in graphically at least once"
    echo "    on this Mac before the LaunchAgent can be bootstrapped."
    echo "    Aborting BEFORE touching the legacy LaunchDaemon."
    exit 1
fi

LEGACY_WAS_LOADED=0
if sudo launchctl print system/$LABEL >/dev/null 2>&1; then
    LEGACY_WAS_LOADED=1
fi

# Rollback function — wired to ERR trap and called from the verify
# branch. Best-effort: re-bootstrapping the legacy plist requires
# both the file to be in place and the system domain to accept it.
rollback_to_legacy() {
    local rc=$?
    echo ""
    echo "==> Migration failed (exit $rc) — attempting rollback"
    # Tear down a half-bootstrapped LaunchAgent if present.
    if launchctl print "$GUI_DOMAIN/$LABEL" >/dev/null 2>&1; then
        launchctl bootout "$GUI_DOMAIN/$LABEL" >/dev/null 2>&1 || true
    fi
    # Restore the previous binary so rollback runs the OLD code (not
    # the half-installed new code that just failed verification).
    if [[ -f "$BINARY_TARGET.prev" ]]; then
        sudo install -m 0755 "$BINARY_TARGET.prev" "$BINARY_TARGET" || true
    fi
    # Restore legacy plist if the .disabled rename happened (it
    # shouldn't yet at this point in the script, but defensive).
    if [[ -f "${LEGACY_DAEMON_PLIST}.disabled" && ! -f "$LEGACY_DAEMON_PLIST" ]]; then
        sudo mv "${LEGACY_DAEMON_PLIST}.disabled" "$LEGACY_DAEMON_PLIST" || true
    fi
    if [[ "$LEGACY_WAS_LOADED" == "1" && -f "$LEGACY_DAEMON_PLIST" ]]; then
        echo "  -> re-bootstrapping legacy LaunchDaemon"
        sudo launchctl bootstrap system "$LEGACY_DAEMON_PLIST" >/dev/null 2>&1 || true
    fi
    echo "  -> rollback complete (best-effort); inspect manually:"
    echo "       sudo launchctl print system/$LABEL"
    echo "       launchctl print $GUI_DOMAIN/$LABEL"
    exit $rc
}
trap rollback_to_legacy ERR

echo "==> Tearing down legacy LaunchDaemon (if present)"
if [[ "$LEGACY_WAS_LOADED" == "1" ]]; then
    echo "  -> bootout system/$LABEL"
    sudo launchctl bootout system/$LABEL || true
    sleep 1
fi
# NOTE: legacy plist file stays at $LEGACY_DAEMON_PLIST (NOT renamed
# yet) until after health check passes. Keeps rollback one launchctl
# call away.

echo "==> Bootstrapping LaunchAgent into $GUI_DOMAIN"
# Idempotent: bootout first if a previous run already bootstrapped.
if launchctl print "$GUI_DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "$GUI_DOMAIN/$LABEL" || true
    sleep 1
fi
launchctl bootstrap "$GUI_DOMAIN" "$PLIST_TARGET"

sleep 2
echo "==> Verifying"
HEALTH_URL=http://127.0.0.1:7315/health
code_no_auth=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" || true)
code_with_auth=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "$HEALTH_URL" || true)
if [[ "$code_no_auth" != "401" ]]; then
    echo "  ✗ /health without auth returned $code_no_auth (expected 401 — auth not enforced)"
    echo "    see $LOG_FILE"
    exit 1
fi
if [[ "$code_with_auth" != "200" ]]; then
    echo "  ✗ /health with bearer returned $code_with_auth (expected 200)"
    echo "    see $LOG_FILE"
    exit 1
fi
echo "  ✓ auth enforced (401 without bearer, 200 with)"

# Hard-fail (not warn) if the LaunchAgent isn't actually running —
# review caught that the prior `state isn't running` warning let a
# silent-bootstrap-failure case slip through.
if ! launchctl print "$GUI_DOMAIN/$LABEL" 2>/dev/null | grep -q "state = running"; then
    echo "  ✗ LaunchAgent state isn't 'running' (inspect: launchctl print $GUI_DOMAIN/$LABEL)"
    exit 1
fi
echo "  ✓ LaunchAgent state = running under $GUI_DOMAIN"

# Health check passed → safe to disarm the rollback trap and rename
# the legacy plist out of the way (so it doesn't get bootstrapped on
# a future reboot via launchd's auto-load mechanism).
trap - ERR
if [[ -f "$LEGACY_DAEMON_PLIST" ]]; then
    echo "==> Renaming legacy plist → .disabled (rollback path preserved)"
    sudo mv "$LEGACY_DAEMON_PLIST" "${LEGACY_DAEMON_PLIST}.disabled"
fi

# ---------------------------------------------------------------------
# Issue #215 phase 2: retire the reck-clipboard sidecar. Deferred to
# this point so the rollback trap above could re-bootstrap the OLD
# daemon binary (which DID need the sidecar) on health-check failure.
# Now that verification passed and the new binary is the canonical
# one, the sidecar is dead weight.
# ---------------------------------------------------------------------
echo "==> Tearing down legacy reck-clipboard sidecar"
if launchctl print "$GUI_DOMAIN/eu.verwey.reck-clipboard" >/dev/null 2>&1; then
    echo "  -> bootout $GUI_DOMAIN/eu.verwey.reck-clipboard"
    launchctl bootout "$GUI_DOMAIN/eu.verwey.reck-clipboard" || true
    sleep 1
fi
rm -f "$HOME/Library/LaunchAgents/eu.verwey.reck-clipboard.plist"
if [[ -e "$CLIPBOARD_BINARY_TARGET" ]]; then
    sudo rm -f "$CLIPBOARD_BINARY_TARGET"
fi
# Drop the UDS + pidfile that lived under ~/.reck/ for the sidecar
# era. The daemon no longer reads or writes either of them.
rm -f "$HOME/.reck/clipboard.sock" "$HOME/.reck/daemon.pid"

# Codex pre-commit review 2026-04-28: do NOT delete $BINARY_TARGET.prev
# here. /health is a shallow check — it doesn't exercise pane spawn,
# the cgo NSPasteboard write path, or LaunchAgent restart behaviour.
# Keeping the .prev stash on disk after a successful install means a
# subsequent burn-in failure (e.g. the user notices broken paste an
# hour later) has a one-`sudo install` rollback path. The next
# install-station.sh run rotates .prev to whatever the binary was at
# that moment.
if [[ -f "$BINARY_TARGET.prev" ]]; then
    echo "==> Previous binary preserved at $BINARY_TARGET.prev for rollback"
fi

TAILSCALE_BIN=""
if   [[ -x /opt/homebrew/bin/tailscale ]];                          then TAILSCALE_BIN=/opt/homebrew/bin/tailscale
elif [[ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then TAILSCALE_BIN=/Applications/Tailscale.app/Contents/MacOS/Tailscale
fi
STATION_IP=""
if [[ -n "$TAILSCALE_BIN" ]]; then
    STATION_IP=$("$TAILSCALE_BIN" ip -4 2>/dev/null | head -1 || true)
fi

# Write a structured result file at $HOME/.reck-install-result.json so the
# install choreography on a remote satellite (driven by Claude Code over
# tailscale ssh) can scp-pull it without screen-scraping the trailing
# "Satellite config:" block. Owner-readable only — it carries the daemon
# token and may carry the just-generated reck-connect account password
# (passed in via $RECK_CONNECT_PW from bootstrap-reck-user.sh).
#
# We use mkstemp + chmod-before-write + os.replace so the file is never
# briefly world-readable: a naive `open(...)` followed by `chmod` would
# leave a 0644 file (under the typical umask 022) on disk for the
# duration of the JSON write, racing with any process that polls the
# user's home directory.
RESULT_FILE="$HOME/.reck-install-result.json"
TAILNET_NAME=$(hostname -s 2>/dev/null || hostname)
STATION_URL="http://${STATION_IP:-${TAILNET_NAME}}:7315"
RECK_PW_VALUE="${RECK_CONNECT_PW:-}"
TOKEN="$TOKEN" \
STATION_URL="$STATION_URL" \
TAILNET_NAME="$TAILNET_NAME" \
RECK_PW_VALUE="$RECK_PW_VALUE" \
/usr/bin/python3 - "$RESULT_FILE" <<'PY'
import json, os, sys, tempfile
data = {
    "token": os.environ["TOKEN"],
    "station_url": os.environ["STATION_URL"],
    "tailnet_name": os.environ["TAILNET_NAME"],
}
pw = os.environ.get("RECK_PW_VALUE", "")
if pw:
    data["reck_connect_pw"] = pw
path = sys.argv[1]
target_dir = os.path.dirname(path) or "."
fd, tmp = tempfile.mkstemp(prefix=".reck-install-result.", dir=target_dir)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2, sort_keys=True)
    os.replace(tmp, path)
except Exception:
    try: os.unlink(tmp)
    except FileNotFoundError: pass
    raise
PY
echo "==> Wrote install result to $RESULT_FILE (mode 0600)"

echo ""
echo "Done. Satellite config:"
echo "  Station URL:  http://${STATION_IP:-<your-tailnet-ip>}:7315"
echo "  Daemon Token: $TOKEN"
echo "                (also on disk at $TOKEN_FILE, owner $(whoami) mode 0600)"
echo ""
echo "Daemon scope: LaunchAgent ($GUI_DOMAIN/$LABEL)"
echo "Logs:         $LOG_FILE"
echo ""
echo "Next:"
echo "  1. Edit $PROJECTS_FILE with real project paths."
echo "     For projects.toml changes only:"
echo "       launchctl kickstart -k $GUI_DOMAIN/$LABEL"
echo "  2. Plist changes (env vars, args) require re-running this script."
echo ""
echo "Rollback to LaunchDaemon if needed:"
echo "  launchctl bootout $GUI_DOMAIN/$LABEL"
echo "  sudo mv ${LEGACY_DAEMON_PLIST}.disabled $LEGACY_DAEMON_PLIST"
echo "  sudo launchctl bootstrap system $LEGACY_DAEMON_PLIST"
echo "  (token at $LEGACY_TOKEN_FILE if it was preserved by the old install)"
echo ""
echo "To rotate the token:"
echo "  rm $TOKEN_FILE && ./install-station.sh"
