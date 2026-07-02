#!/usr/bin/env bash
# bootstrap-linux-user.sh — inject the satellite SSH key into the existing
# Linux station user's authorized_keys. Linux equivalent of bootstrap-reck-user.sh.
# Does NOT create a new OS user (Linux convention: use the existing system user).
#
# Usage:
#   bash -s -- --pubkey-b64 "$(base64 < ~/.ssh/reck_mount.pub)" \
#       [--username <user>] [--station-root <path>] < bootstrap-linux-user.sh
set -euo pipefail

USERNAME="$(whoami)"; PUBKEY_B64=""; STATION_ROOT=""
while (( $# > 0 )); do
  case "$1" in
    --pubkey-b64) PUBKEY_B64="$2"; shift 2 ;;
    --username)   USERNAME="$2"; shift 2 ;;
    --station-root) STATION_ROOT="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | head -20; exit 0 ;;
    *) echo "Unknown: $1" >&2; exit 1 ;;
  esac
done

[[ -n "$PUBKEY_B64" ]] || { echo "--pubkey-b64 required" >&2; exit 1; }
[[ "$PUBKEY_B64" =~ ^[A-Za-z0-9+/]+=*$ ]] || { echo "--pubkey-b64 not base64" >&2; exit 1; }
PUBKEY=$(printf '%s' "$PUBKEY_B64" | base64 -d 2>/dev/null || true)   # GNU: -d, not -D
[[ -n "$PUBKEY" ]] || { echo "--pubkey-b64 failed to decode" >&2; exit 1; }
if ! [[ "$PUBKEY" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521)\ [A-Za-z0-9+/=]+( [[:print:]]*)?$ ]]; then
  echo "decoded pubkey is not an OpenSSH public key" >&2; exit 1; fi
# Defense in depth: reject a key comment carrying shell metacharacters.
# PUBKEY is only ever used quoted below, but keep the value boring.
for _ch in '$' '`' '"' "'" '\'; do
  if [[ "$PUBKEY" == *"$_ch"* ]]; then
    echo "pubkey comment has shell metacharacters" >&2; exit 1
  fi
done
[[ "$(uname)" == "Linux" ]] || { echo "This script targets Linux." >&2; exit 1; }

HOME_DIR=$(eval echo "~$USERNAME"); SSH_DIR="$HOME_DIR/.ssh"; AUTH_KEYS="$SSH_DIR/authorized_keys"
mkdir -p "$SSH_DIR"; chown "$USERNAME:" "$SSH_DIR" 2>/dev/null || true; chmod 700 "$SSH_DIR"
if [[ -f "$AUTH_KEYS" ]] && grep -Fxq "$PUBKEY" "$AUTH_KEYS" 2>/dev/null; then
  echo "==> Satellite pubkey already in $AUTH_KEYS"
else
  echo "==> Appending satellite pubkey to $AUTH_KEYS"; printf '%s\n' "$PUBKEY" >> "$AUTH_KEYS"
fi
chmod 600 "$AUTH_KEYS"

PROJ_ROOT="${STATION_ROOT:-$HOME_DIR/projects}"; mkdir -p "$PROJ_ROOT"
touch "$PROJ_ROOT/.reck-mount-sentinel"

echo; echo "Done."
echo "  user:     $USERNAME"; echo "  ssh key:  $AUTH_KEYS"; echo "  projects: $PROJ_ROOT"
echo "RECK_STATION_USER=$USERNAME"; echo "RECK_STATION_ROOT=$PROJ_ROOT"
