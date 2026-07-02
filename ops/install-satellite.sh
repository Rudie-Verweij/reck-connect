#!/usr/bin/env bash
# install-satellite.sh — laptop-side setup for Reck Connect V2 Step 2.
# Installs FUSE-T + fuse-t-sshfs, generates an SSH key, configures the
# reck-station alias, installs the LaunchAgent + watchdog, and prints
# the next (interactive) step for the user.

set -euo pipefail

# Required env vars — fail-fast at the top before any work. See README
# §"Migration from hardcoded defaults" for rationale; silent fallback
# to upstream's `/Users/reck-connect/projects` literal would let a
# misconfigured deploy mount against a non-existent dir on the station
# (empty mount, vanishing projects, silent rsync data loss).
: "${RECK_STATION_USER:?must be set (station unix user, e.g. reck-connect)}"
: "${RECK_STATION_ROOT:?must be set (absolute station projects root, e.g. /Users/reck-connect/projects)}"

# RECK_STATION_ROOT lands in three places that constrain its character
# set: a sed replacement (no '|', '&', '\' without escaping), a plist
# <string> element (no '<', '>', '&' without XML entity escaping), and
# an ssh remote command (no shell metacharacters). Restrict to a
# portable-enough whitelist — POSIX absolute path with letters, digits,
# `/`, `_`, `-`, `.`. Reject up front rather than producing malformed
# plists / cryptic plutil errors mid-install.
if ! [[ "$RECK_STATION_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "RECK_STATION_ROOT must be an absolute path containing only [A-Za-z0-9._/-]" >&2
  echo "  got: $RECK_STATION_ROOT" >&2
  exit 1
fi
if ! [[ "$RECK_STATION_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]; then
  echo "RECK_STATION_USER must be a valid unix username ([A-Za-z_][A-Za-z0-9_-]*)" >&2
  echo "  got: $RECK_STATION_USER" >&2
  exit 1
fi

V2_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOUNT_POINT="$HOME/reck/projects"
KEY="$HOME/.ssh/reck_mount"
SSH_CONFIG="$HOME/.ssh/config"
WATCHDOG_SRC="$V2_ROOT/ops/reck-mount-watchdog.sh"
WATCHDOG_DST="/usr/local/bin/reck-mount-watchdog"
PLIST_SRC="$V2_ROOT/ops/eu.verwey.reck-mount.plist.tmpl"
PLIST_DST="$HOME/Library/LaunchAgents/eu.verwey.reck-mount.plist"

# Optional flags consumed by the Claude-driven INSTALL.md choreography.
# Both are additive — running install-satellite.sh with no flags
# reproduces the original interactive flow.
#
#   --key-already-installed
#       Skip the trailing `ssh-copy-id` reminder. Used when the
#       bootstrap-reck-user.sh stage on the station already injected
#       the satellite's pubkey into reck-connect's authorized_keys.
#
#   --write-settings <station-url>
#       Write a one-shot bootstrap.json into the Satellite's userData
#       directory. The Electron app's main process reads this on first
#       launch, populates the encrypted settings.json via safeStorage,
#       and unlinks the bootstrap file. Replaces the manual
#       first-launch UI paste flow.
#
#       The bearer token is read from the RECK_SATELLITE_TOKEN
#       environment variable, NOT from argv — argv is visible to any
#       local user via `ps auxww`, env is restricted to root + the
#       same UID. The Claude-driven install passes it inline:
#         RECK_SATELLITE_TOKEN="$T" ./install-satellite.sh \
#             --write-settings "$URL" --key-already-installed
#
# We validate the values BEFORE doing any work — if the Claude driver
# passes a bad URL or token, fail at the front rather than after the
# brew + ssh-config + plist steps.
KEY_ALREADY_INSTALLED=0
WRITE_SETTINGS_URL=""

while (( $# > 0 )); do
  case "$1" in
    --key-already-installed)
      KEY_ALREADY_INSTALLED=1
      shift
      ;;
    --write-settings)
      if [[ $# -lt 2 ]]; then
        echo "--write-settings requires <station-url>" >&2
        exit 1
      fi
      WRITE_SETTINGS_URL="$2"
      shift 2
      ;;
    --help|-h)
      cat <<EOF
Usage: install-satellite.sh [--key-already-installed] [--write-settings <url>]

Environment:
  STATION_HOST            Skip the interactive hostname prompt.
  RECK_SATELLITE_TOKEN    Required by --write-settings; bearer token
                          for the station daemon. Kept out of argv so
                          it doesn't appear in 'ps' output.
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# Validate --write-settings inputs up front. URL must be
# http(s)://host[:port][/path] and tolerates IPv6-in-brackets
# (http://[fd7a::1]:7315). Token must be a positively-bounded
# character class — the Claude-driven install passes the
# openssl rand -hex output (lowercase hex) so URL-safe ASCII is
# more than sufficient and dodges shell/JSON escape concerns.
WRITE_SETTINGS_TOKEN="${RECK_SATELLITE_TOKEN:-}"
if [[ -n "$WRITE_SETTINGS_URL" ]]; then
  if [[ -z "$WRITE_SETTINGS_TOKEN" ]]; then
    echo "--write-settings requires the RECK_SATELLITE_TOKEN env var to be set" >&2
    exit 1
  fi
  if ! [[ "$WRITE_SETTINGS_URL" =~ ^https?://(\[[0-9a-fA-F:]+\]|[A-Za-z0-9._%-]+)(:[0-9]+)?(/.*)?$ ]]; then
    echo "--write-settings: invalid station URL: $WRITE_SETTINGS_URL" >&2
    echo "Expected http(s)://<host-or-[ipv6]>[:port][/path]" >&2
    exit 1
  fi
  if ! [[ "$WRITE_SETTINGS_TOKEN" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "RECK_SATELLITE_TOKEN must match [A-Za-z0-9._-]+ (no whitespace, quotes, or shell metas)" >&2
    exit 1
  fi
fi

if ! command -v brew >/dev/null 2>&1; then
  if   [[ -x /opt/homebrew/bin/brew ]]; then eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew    ]]; then eval "$(/usr/local/bin/brew shellenv)"
  else
    echo "Homebrew not found. Install from https://brew.sh first."
    exit 1
  fi
fi

echo "==> Building local reck-stationd (~/.local/bin/reck-stationd)"
# Satellite's Local mode spawns a reck-stationd from ~/.local/bin/. A
# reinstall that only refreshes the .app bundle would leave a stale
# binary in place and any new daemon code (e.g. issue #228 auto-restore
# of orphan panes) wouldn't take effect on the local host. Always
# rebuild it from this checkout. Delegates to install-local.sh so the
# build path stays in one place.
"$V2_ROOT/ops/install-local.sh"

# Legacy userData migration. Electron derives app.getPath('userData')
# from app.getName(), which falls back to satellite/package.json `name`
# in unpackaged / dev runs. The package was renamed
# `reck-satellite` → `reck-connect-satellite`; bundles built before
# the rename wrote settings (layouts_v2, projectOrder, theme,
# claudeLaunchArgs, gaze.*, railWidth, hoverToFocus) to the old path
# and a fresh build reads from the new path, stranding the user's
# layouts on every reinstall. Walk both legacy candidates and copy any
# missing keys forward; never clobber a key that already exists in the
# new dir (the active install's auth / station config wins).
LEGACY_USERDATA_DIRS=(
  "$HOME/Library/Application Support/reck-satellite"
)
NEW_USERDATA_DIR="$HOME/Library/Application Support/reck-connect-satellite"
for LEGACY in "${LEGACY_USERDATA_DIRS[@]}"; do
  legacy_settings="$LEGACY/config/settings.json"
  new_settings="$NEW_USERDATA_DIR/config/settings.json"
  [[ -f "$legacy_settings" ]] || continue
  echo "==> Migrating legacy Satellite config: $LEGACY → $NEW_USERDATA_DIR"
  mkdir -p "$NEW_USERDATA_DIR/config"
  # Wrapped with `|| true` because a corrupt or truncated legacy
  # settings.json must NOT abort the rest of install-satellite.sh
  # (FUSE-T, mount LaunchAgent, the user's actual install). The python
  # helper prints its own status; if it bails, the only thing lost is
  # this one-shot key carry-over.
  LEGACY_FILE="$legacy_settings" NEW_FILE="$new_settings" \
    /usr/bin/python3 - <<'PY' || true
import json, os, pathlib, sys, tempfile
legacy = pathlib.Path(os.environ["LEGACY_FILE"])
new = pathlib.Path(os.environ["NEW_FILE"])
try:
    old_data = json.loads(legacy.read_text())
except (OSError, ValueError) as e:
    print(f"  -> migration skipped: legacy file unreadable ({e})")
    sys.exit(0)
try:
    new_data = json.loads(new.read_text()) if new.exists() else {}
except ValueError as e:
    print(f"  -> migration skipped: new file unreadable ({e})")
    sys.exit(0)
# Pull every legacy key that the new dir is missing. Existing new keys
# win — never overwrite an in-place install's encrypted auth blobs
# with a stale legacy copy.
added = []
for k, v in old_data.items():
    if k not in new_data:
        new_data[k] = v
        added.append(k)
if not added:
    print("  -> no missing keys to migrate (already in new dir)")
    sys.exit(0)
fd, tmp = tempfile.mkstemp(prefix="settings.", dir=str(new.parent))
try:
    with os.fdopen(fd, "w") as f:
        json.dump(new_data, f, indent=2)
        f.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, new)
except Exception:
    try: os.unlink(tmp)
    except FileNotFoundError: pass
    raise
print(f"  -> migrated keys: {added}")
PY
done

echo "==> Installing FUSE-T + fuse-t-sshfs"
brew tap macos-fuse-t/cask >/dev/null 2>&1 || true
if ! brew list --cask fuse-t >/dev/null 2>&1; then
  brew install --cask fuse-t
fi
if ! brew list --cask fuse-t-sshfs >/dev/null 2>&1; then
  brew install --cask fuse-t-sshfs
fi

echo "==> Installing rsync (real GNU rsync — macOS ships openrsync which the Satellite can't parse)"
if ! brew list rsync >/dev/null 2>&1; then
  brew install rsync
fi

echo "==> Generating SSH key (if missing)"
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
if [[ ! -f "$KEY" ]]; then
  ssh-keygen -t ed25519 -f "$KEY" -N "" -C "reck-mount@$(hostname -s)"
else
  echo "  -> $KEY exists, keeping"
fi

# Honour a pre-set STATION_HOST env var so unattended / scripted installs
# (CI, dotfiles bootstrap, re-runs from a make target) can skip the
# interactive prompt without wrapping this in `expect` or `yes`. The
# validator below runs regardless of how the value arrived, so a bad
# env value fails just as loudly as a bad typed one.
if [[ -z "${STATION_HOST:-}" ]]; then
  read -rp "Station hostname (Tailscale MagicDNS name or tailnet IP) [your-station]: " STATION_HOST
  STATION_HOST=${STATION_HOST:-your-station}
else
  echo "==> Using STATION_HOST from environment: $STATION_HOST"
fi

# Validate STATION_HOST before interpolating it into ~/.ssh/config.
# An unvalidated value can carry newlines or extra whitespace and append
# arbitrary SSH directives to the config (or hijack later Host blocks).
# Accept three shapes:
#   - DNS hostname / MagicDNS name (letters, digits, dots, hyphens; must
#     start with a letter or digit)
#   - IPv4 address (a.b.c.d, each octet 0-255 — covers Tailscale CGNAT
#     range 100.64.0.0/10 too)
#   - IPv6 address (hex digits and colons, optional %zone-id suffix)
# Anything containing whitespace, control chars, semicolons, quotes,
# slashes, or newlines is rejected.
is_valid_hostname() {
  [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]]
}
is_valid_ipv4() {
  local ip=$1 IFS=.
  # shellcheck disable=SC2206
  local parts=($ip)
  [[ ${#parts[@]} -eq 4 ]] || return 1
  local p
  for p in "${parts[@]}"; do
    [[ "$p" =~ ^[0-9]+$ ]] || return 1
    (( p >= 0 && p <= 255 )) || return 1
  done
}
is_valid_ipv6() {
  # Must contain ':' (so we don't double-match plain hostnames) and only
  # hex/colons, optionally a '%zone' suffix using letters/digits/hyphens.
  [[ "$1" == *:* ]] && [[ "$1" =~ ^[0-9a-fA-F:]+(%[a-zA-Z0-9-]+)?$ ]]
}
is_valid_station_host() {
  is_valid_hostname "$1" || is_valid_ipv4 "$1" || is_valid_ipv6 "$1"
}

if ! is_valid_station_host "$STATION_HOST"; then
  printf 'Invalid station hostname: %q\n' "$STATION_HOST" >&2
  echo "Expected a DNS hostname (e.g. your-station), IPv4 (e.g. 100.64.5.7), or IPv6 address." >&2
  exit 1
fi

echo "==> Writing ~/.ssh/config stanza"
touch "$SSH_CONFIG" && chmod 600 "$SSH_CONFIG"
# Idempotency uses managed-block markers so re-runs can reliably detect
# this script's own block. The previous literal `^Host reck-station$`
# check missed leading whitespace, grouped Host stanzas
# (`Host foo reck-station bar`), and hand-edited variants — repeated
# installs would then append duplicate blocks.
#
# BEGIN alone is NOT proof of a valid managed block — a previous install
# may have crashed after writing BEGIN but before writing END, in which
# case every subsequent run would silently skip regeneration and leave
# the operator with no usable reck-station alias. So we validate BEGIN
# and END as a pair, and check the content between them has the three
# lines that matter (HostName / User / IdentityFile). On partial or
# corrupt blocks we fail loudly and tell the operator exactly which
# lines to remove — auto-rewriting ~/.ssh/config is too spooky.
SSH_BEGIN_MARKER="# BEGIN reck-station (managed by install-satellite.sh)"
SSH_END_MARKER="# END reck-station (managed by install-satellite.sh)"

# Tolerate pre-existing hand-rolled blocks (no managed markers) —
# leave them alone, tell the operator how to switch.
if ! grep -qF "$SSH_BEGIN_MARKER" "$SSH_CONFIG" \
   && grep -qE "^[[:space:]]*Host([[:space:]]|=).*\\breck-station\\b" "$SSH_CONFIG"; then
  echo "  -> unmanaged reck-station Host stanza present, leaving as-is"
  echo "     (rename/remove it to let this script manage one with markers)"
elif grep -qF "$SSH_BEGIN_MARKER" "$SSH_CONFIG"; then
  # Managed marker found — validate it's a complete, sane block before
  # deciding this install can skip.
  begin_line=$(grep -nF "$SSH_BEGIN_MARKER" "$SSH_CONFIG" | head -n1 | cut -d: -f1)
  end_line=$(grep -nF "$SSH_END_MARKER" "$SSH_CONFIG" | head -n1 | cut -d: -f1)
  partial=0
  reason=""
  if [[ -z "$end_line" ]]; then
    partial=1
    reason="BEGIN marker present but END marker missing (line $begin_line onward)"
  elif (( end_line <= begin_line )); then
    partial=1
    reason="END marker (line $end_line) appears before BEGIN (line $begin_line)"
  else
    # Inclusive slice, then check the body for the three required directives.
    block=$(sed -n "${begin_line},${end_line}p" "$SSH_CONFIG")
    missing=()
    grep -qE "^[[:space:]]*HostName[[:space:]]"     <<<"$block" || missing+=("HostName")
    grep -qE "^[[:space:]]*User[[:space:]]"         <<<"$block" || missing+=("User")
    grep -qE "^[[:space:]]*IdentityFile[[:space:]]" <<<"$block" || missing+=("IdentityFile")
    if (( ${#missing[@]} > 0 )); then
      partial=1
      reason="managed block on lines $begin_line-$end_line missing: ${missing[*]}"
    fi
  fi

  if (( partial )); then
    cat >&2 <<EOF
Error: $SSH_CONFIG has a partial reck-station managed block.
  $reason
Remove the damaged block manually and re-run install-satellite.sh:
  - Open $SSH_CONFIG in an editor.
  - Delete everything from the BEGIN marker (line $begin_line) through
    the END marker (or to end-of-file if END is absent).
  - Save, then re-run this script.
Refusing to auto-rewrite ~/.ssh/config.
EOF
    exit 1
  fi
  echo "  -> existing managed reck-station block validated, leaving as-is"
  echo "     (delete the BEGIN/END markers and re-run to regenerate)"
else
  cat >> "$SSH_CONFIG" <<EOF

$SSH_BEGIN_MARKER
Host reck-station
  HostName $STATION_HOST
  User $RECK_STATION_USER
  IdentityFile $KEY
  IdentitiesOnly yes
  ServerAliveInterval 15
  ServerAliveCountMax 3
  # Pin fast ciphers (chacha20 first for Apple Silicon; gcm fallback).
  # Lives here rather than in the watchdog's sshfs -o because fuse-t-sshfs
  # splits comma-separated -o values into multiple options and breaks
  # '-o Ciphers=A,B'. sshfs reads this via its own ssh client.
  Ciphers chacha20-poly1305@openssh.com,aes128-gcm@openssh.com
$SSH_END_MARKER
EOF
fi

echo "==> Installing watchdog → $WATCHDOG_DST"
sudo install -m 0755 "$WATCHDOG_SRC" "$WATCHDOG_DST"

echo "==> Creating mount-watchdog log directory $HOME/Library/Logs/reck-stationd"
mkdir -p "$HOME/Library/Logs/reck-stationd"

echo "==> Installing LaunchAgent plist → $PLIST_DST"
mkdir -p "$HOME/Library/LaunchAgents"
# launchd does NOT expand env vars (no $HOME, no ~) in StandardOutPath /
# StandardErrorPath. Substitute __HOME__ → "$HOME" at install time so
# the agent writes to the per-user log dir we just created.
#
# Two subtleties:
#   1. $HOME goes into sed's *replacement*, so any '|' (our delimiter),
#      '&' (match-reference), or '\' in the path would be interpreted
#      instead of taken literally. Escape those three before
#      substituting — a pathological $HOME like /Users/foo&bar or a
#      directory with '|' in the name would otherwise yield a plist
#      with the wrong path baked in.
#   2. Render to a .tmp file, plutil-lint the rendered output, and
#      only mv into place if lint succeeds. This avoids leaving a
#      half-written / invalid plist at $PLIST_DST if sed fails midway
#      or if lint catches a structural problem.
home_esc=$(printf '%s\n' "$HOME" | sed -e 's/[\\&|]/\\&/g')
# Same escape rules apply to RECK_STATION_ROOT — a station path with '|',
# '&', or '\' (unusual but possible) would otherwise corrupt the sed
# replacement. The validator at the top of this script doesn't constrain
# the path's character set, so escape defensively here.
station_root_esc=$(printf '%s\n' "$RECK_STATION_ROOT" | sed -e 's/[\\&|]/\\&/g')
plist_tmp="${PLIST_DST}.tmp.$$"
trap 'rm -f "$plist_tmp"' EXIT
sed -e "s|__HOME__|${home_esc}|g" \
    -e "s|__RECK_STATION_ROOT__|${station_root_esc}|g" \
    "$PLIST_SRC" > "$plist_tmp"
plutil -lint "$plist_tmp" >/dev/null
mv "$plist_tmp" "$PLIST_DST"
trap - EXIT

echo "==> Creating mount point $MOUNT_POINT"
mkdir -p "$MOUNT_POINT"

# Known gap: Finder writes .DS_Store + ._.DS_Store into
# every dir it browses, including sshfs-mounted station projects.
# `noappledouble` mount flag suppresses AppleDouble metadata files
# but not .DS_Store — Finder writes those via a separate code path.
# Per-user pref `DSDontWriteNetworkStores` tells Finder skip
# .DS_Store on network volumes entirely. Idempotent: re-running the
# installer with the pref already true is a no-op.
echo "==> Disabling Finder .DS_Store writes on network volumes"
defaults write com.apple.desktopservices DSDontWriteNetworkStores -bool true
# Restart Finder so the pref takes effect immediately. macOS will
# auto-respawn it. Suppress "no matching processes" if Finder isn't
# running (Recovery, headless) so the installer doesn't tail-fail.
killall Finder 2>/dev/null || true

echo "==> (Re)loading LaunchAgent"
launchctl bootout gui/"$UID"/eu.verwey.reck-mount >/dev/null 2>&1 || true
launchctl bootstrap gui/"$UID" "$PLIST_DST"

# Electron's main process reads `process.env.RECK_STATION_ROOT` at
# runtime (satellite/main/rsync-copy.ts). When the user launches the
# app via Finder / Spotlight / `open -a`, it inherits the GUI session
# environment, NOT the user's shell.
#
# `launchctl setenv` writes to the *current* launchctl context. When
# this installer runs over `tailscale ssh` (the documented Stage-4
# install transport), the current context has no GUI session attached
# and the value lands in the system domain — Finder/Dock-launched
# Electron will NOT see it. Use `launchctl asuser <uid> ...` so the
# write targets the GUI Aqua session regardless of where the installer
# was invoked from. Falls back to plain setenv when asuser is
# unavailable (e.g. very old macOS).
#
# Caveat: this value evaporates on logout. Persistence across sessions
# is left to the user's `~/.zprofile` (or LaunchAgent EnvironmentVariables
# if they want a more structured fix) — automating that touches user
# shell config and is out of scope for this installer.
echo "==> Exporting RECK_STATION_ROOT to GUI session (launchctl asuser setenv)"
if ! launchctl asuser "$UID" launchctl setenv RECK_STATION_ROOT "$RECK_STATION_ROOT" 2>/dev/null; then
  launchctl setenv RECK_STATION_ROOT "$RECK_STATION_ROOT"
fi

# Optional: seed the Satellite's first-launch settings via bootstrap.json
# so the Claude-driven install can hand the user a working app without
# the legacy UI paste flow.
#
# We deliberately do NOT shell-side decide whether settings.json is
# already populated — that file is safeStorage-encrypted base64 per key
# (see satellite/main/storage.ts) so a grep would never match. The
# real idempotency check lives in satellite/main/bootstrap-import.ts:
# if the decrypted "settings" key is already present, the import is a
# no-op and bootstrap.json is removed without overwriting.
#
# Token is read from RECK_SATELLITE_TOKEN env (kept out of argv).
# Write is atomic (tempfile + os.replace) so two concurrent installs
# can't interleave bytes — the loser's file simply replaces the
# winner's intact.
if [[ -n "$WRITE_SETTINGS_URL" ]]; then
  # Electron's app.getName() / app.getPath('userData') depends on which
  # name string Electron resolves at runtime:
  #   • Packaged .app: CFBundleName from Info.plist (electron-builder.yml's
  #     productName → "Reck Connect Satellite").
  #   • Unpackaged / electron-builder --dir / dev runs: package.json
  #     `name` field → "reck-connect-satellite" (lowercase).
  #
  # Issue #227: user reported the lowercase dir as the actual location
  # used by their installed app (most likely a `pnpm dist --dir` build
  # on macOS 26+). Codex flagged that for true packaged builds title-case
  # is what Electron uses. We have no reliable way at install time to
  # know which build variant the user will launch — and an upgrade path
  # may have multiple .app bundles around with different Info.plists.
  #
  # Always seed BOTH candidate dirs. Whichever one the launched app
  # reads, the import lands; the other file is owner-only (0600 inside
  # a 0700 dir) and is swept by uninstall-satellite.sh. The orphan is
  # not a leak — same daemon token already lives in the imported
  # encrypted settings.
  echo "==> Seeding Satellite first-launch config (both userData candidates)"
  APP_DATA_DIRS=(
    "$HOME/Library/Application Support/reck-connect-satellite"
    "$HOME/Library/Application Support/Reck Connect Satellite"
  )
  for APP_DATA_DIR in "${APP_DATA_DIRS[@]}"; do
    BOOTSTRAP_FILE="$APP_DATA_DIR/bootstrap.json"
    mkdir -p "$APP_DATA_DIR"
    WRITE_SETTINGS_URL="$WRITE_SETTINGS_URL" \
    WRITE_SETTINGS_TOKEN="$WRITE_SETTINGS_TOKEN" \
    /usr/bin/python3 - "$BOOTSTRAP_FILE" <<'PY'
import json, os, sys, tempfile
path = sys.argv[1]
data = {
    "stationUrl": os.environ["WRITE_SETTINGS_URL"],
    "daemonToken": os.environ["WRITE_SETTINGS_TOKEN"],
}
fd, tmp = tempfile.mkstemp(prefix="bootstrap.", dir=os.path.dirname(path))
try:
    with os.fdopen(fd, "w") as f:
        json.dump(data, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
except Exception:
    try: os.unlink(tmp)
    except FileNotFoundError: pass
    raise
PY
    echo "  -> wrote $BOOTSTRAP_FILE (mode 0600)"
  done
  echo "     Wrote both — unused copy stays in place until first launch +"
  echo "     uninstall-satellite.sh sweeps it. Both dirs are owner-only."
fi

echo
if (( KEY_ALREADY_INSTALLED )); then
  echo "Done installing local pieces. SSH key already registered on station."
else
  echo "Done installing local pieces. One interactive step remains:"
  echo
  echo "  ssh-copy-id -i $KEY.pub $RECK_STATION_USER@$STATION_HOST"
  echo
  echo "Run that to register the mount key on the station."
fi
echo "Once the station also has \$(install-station.sh) applied (sentinel"
echo "file created under $RECK_STATION_ROOT/), the watchdog will"
echo "mount $MOUNT_POINT within 60 s."
echo
echo "Tail the watchdog log:"
echo "  tail -f ~/Library/Logs/reck-stationd/mount.log"
echo
echo "(Note: mount log moved out of /tmp on 2026-04-23 — old path no longer used.)"

# macOS 26 (Tahoe) introduced FSKit; FUSE-T's mount path now requires a
# one-time approval in System Settings that cannot be automated. Detect
# the OS version and surface the click path to the user — both the
# manual install path and the Claude-driven path land here.
MACOS_MAJOR=$(/usr/bin/sw_vers -productVersion 2>/dev/null | /usr/bin/awk -F. '{print $1}')
if [[ "$MACOS_MAJOR" =~ ^[0-9]+$ ]] && (( MACOS_MAJOR >= 26 )); then
  echo
  echo "MACOS 26+ DETECTED — one-time FSKit approval needed:"
  echo "  System Settings → Privacy & Security → Login Items & Extensions"
  echo "    → File System Extensions → toggle FUSE-T ON, click Allow."
  echo
  echo "Symptom if skipped: mount.log shows 'sshfs failed (exit 1)' every"
  echo "60 s and ~/reck/projects stays empty. Approve, then the watchdog"
  echo "picks up on its next 60 s tick."
fi
