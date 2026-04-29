#!/usr/bin/env bash
# bootstrap-reck-user.sh — create the dedicated `reck-connect` macOS
# account on a station so the rest of ops/install-station.sh has a
# clean home to run as. Designed to be invoked over `tailscale ssh`
# from a satellite by the Claude-driven INSTALL.md choreography:
#
#   tailscale ssh -t <admin>@<station> -- \
#     bash -s -- --pubkey "$(cat ~/.ssh/reck_mount.pub)" \
#       < bootstrap-reck-user.sh
#
# This script needs sudo. The choreography arranges for the user to
# enter their admin password into the same ssh session before piping
# the script in (Pattern A in the install plan). We do not cache or
# echo that password anywhere.
#
# Idempotent: if the `reck-connect` account already exists, we skip
# account creation and only refresh the authorized_keys entry. The
# generated account password is printed exactly once on a single
# parser-friendly marker line so the satellite Claude can scrape it
# off stdout and tuck it into the structured result file written by
# install-station.sh.
#
# Out of scope (per install plan v2 — locked decisions):
#   - No FileVault changes (operator's policy choice).
#   - No auto-login enable.
#   - No Tailscale install (the admin user installs Tailscale during
#     the physical PREFLIGHT-STATION step).
#   - No Homebrew install (install-station.sh handles that as
#     reck-connect after this script finishes).

set -euo pipefail

USERNAME="reck-connect"
FULL_NAME="Reck Connect"
PUBKEY_B64=""

usage() {
  cat <<EOF
Usage: bootstrap-reck-user.sh --pubkey-b64 <base64-of-ssh-key>

Required:
  --pubkey-b64 <b64>  Base64-encoded satellite SSH public key (the
                      contents of ~/.ssh/reck_mount.pub piped through
                      'base64'). The base64 wrapper is intentional —
                      OpenSSH public keys may carry arbitrary comments
                      including quote characters; passing the raw
                      string into a remote shell command (as
                      INSTALL.md Stage 2 does) opens a shell-injection
                      window. Base64 round-trip means the only
                      characters traversing the remote shell are
                      [A-Za-z0-9+/=], which can never break out of
                      argv quoting.

Optional:
  --username <name>   Override the account short name (default: reck-connect).
  -h, --help          Show this help.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --pubkey-b64)
      [[ $# -ge 2 ]] || { echo "--pubkey-b64 requires a value" >&2; exit 1; }
      PUBKEY_B64="$2"
      shift 2
      ;;
    --username)
      [[ $# -ge 2 ]] || { echo "--username requires a value" >&2; exit 1; }
      USERNAME="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PUBKEY_B64" ]]; then
  echo "Missing --pubkey-b64" >&2
  usage >&2
  exit 1
fi

# Reject anything that isn't strict base64 BEFORE decoding — base64
# itself is small enough that we can fully validate the encoded form.
if ! [[ "$PUBKEY_B64" =~ ^[A-Za-z0-9+/]+=*$ ]]; then
  echo "--pubkey-b64 contains characters outside the base64 alphabet" >&2
  exit 1
fi

PUBKEY=$(printf '%s' "$PUBKEY_B64" | /usr/bin/base64 -D 2>/dev/null || true)
if [[ -z "$PUBKEY" ]]; then
  echo "--pubkey-b64 failed to decode (truncated or corrupt base64)" >&2
  exit 1
fi

# Decoded pubkey must still be a single line with a recognised key
# type. Comment text after the base64 blob is allowed but must be
# plain ASCII without shell or control characters — defence in depth
# in case a future caller switches back to passing the raw key.
if [[ "$PUBKEY" == *$'\n'* ]]; then
  echo "decoded pubkey must be a single line" >&2
  exit 1
fi
if ! [[ "$PUBKEY" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521)\ [A-Za-z0-9+/=]+( [[:print:]]*)?$ ]]; then
  echo "decoded pubkey does not look like an OpenSSH public key" >&2
  exit 1
fi
if [[ "$PUBKEY" =~ [\$\`\\\"\']  ]]; then
  echo "decoded pubkey comment contains shell metacharacters; refusing" >&2
  exit 1
fi

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script targets macOS (sysadminctl, dscl, createhomedir)." >&2
  exit 1
fi

# We need sudo. Validate the cached timestamp up front so we fail fast
# rather than mid-script; the choreography arranges for the user to
# have just typed `sudo -v` so this should be a no-op.
if ! sudo -n true 2>/dev/null; then
  echo "sudo timestamp is not warm. Run 'sudo -v' first, then re-run." >&2
  exit 1
fi

# ---------------------------------------------------------------------
# 1. Skip-or-create the account
# ---------------------------------------------------------------------
EXISTED=0
if /usr/bin/dscl . -read "/Users/$USERNAME" >/dev/null 2>&1; then
  EXISTED=1
  echo "==> $USERNAME already exists; skipping account creation"
else
  # Generate a 32-hex-char random password. Keeps the new account
  # locked behind a real password (rather than blank or trivial) while
  # still letting the operator log in graphically once for FileVault /
  # iCloud setup if they want to. We surface the password on a marker
  # line at the end of this script — never via env or temp file.
  GENPW=$(/usr/bin/openssl rand -hex 16)
  echo "==> Creating $USERNAME (Standard, not Administrator)"
  sudo /usr/sbin/sysadminctl \
    -addUser "$USERNAME" \
    -fullName "$FULL_NAME" \
    -password "$GENPW" \
    >/dev/null
  echo "==> Initializing home directory at /Users/$USERNAME"
  sudo /usr/sbin/createhomedir -c -u "$USERNAME" >/dev/null
fi

# ---------------------------------------------------------------------
# 2. Make sure ~/.ssh exists with the right ownership + mode
# ---------------------------------------------------------------------
SSH_DIR="/Users/$USERNAME/.ssh"
AUTH_KEYS="$SSH_DIR/authorized_keys"

sudo mkdir -p "$SSH_DIR"
sudo chown "$USERNAME:staff" "$SSH_DIR"
sudo chmod 700 "$SSH_DIR"

# Inject the satellite pubkey idempotently. We compare exact-line
# membership (with `grep -Fxq`) so re-runs don't append duplicates and
# so a key with embedded spaces/comments still matches itself.
if sudo test -f "$AUTH_KEYS" && sudo grep -Fxq "$PUBKEY" "$AUTH_KEYS"; then
  echo "==> Satellite pubkey already in $AUTH_KEYS"
else
  echo "==> Appending satellite pubkey to $AUTH_KEYS"
  # Write via tee -a (sudo-friendly append) without the shell ever
  # holding the key in a substitution we'd need to escape.
  printf '%s\n' "$PUBKEY" | sudo tee -a "$AUTH_KEYS" >/dev/null
fi
sudo chown "$USERNAME:staff" "$AUTH_KEYS"
sudo chmod 600 "$AUTH_KEYS"

# ---------------------------------------------------------------------
# 3. Surface the result
# ---------------------------------------------------------------------
echo ""
echo "Done. Account ready for install-station.sh."
echo "  user:        $USERNAME"
echo "  home:        /Users/$USERNAME"
echo "  authorized_keys: $AUTH_KEYS"
if (( EXISTED == 0 )); then
  # Marker line is parsed by the satellite Claude — keep the format
  # exact: "RECK_CONNECT_PW=<value>" on its own line, no surrounding
  # text. The password is the only thing on the line so a naive
  # `awk -F= '$1=="RECK_CONNECT_PW"{print $2}'` works.
  echo ""
  echo "RECK_CONNECT_PW=$GENPW"
  echo ""
  echo "(Above marker line: random password assigned to the new $USERNAME"
  echo " account. Capture it now — this script does not store it anywhere"
  echo " on disk. Pass it into install-station.sh via env if you want it"
  echo " written into ~/.reck-install-result.json.)"
else
  echo ""
  echo "(Account already existed; no new password generated. Use the"
  echo " existing one if you need to log in graphically.)"
fi
