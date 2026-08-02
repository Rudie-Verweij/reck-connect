#!/usr/bin/env bash
# reck-codex-hook.sh — bridges a Codex CLI lifecycle hook into the
# reck-stationd agent-event endpoint. Mirror of reck-claude-hook.sh:
# same HMAC contract, same fail-closed posture, same env-var surface.
#
# Invoked by Codex with:
#   $1 = canonical Reck kind
#        (session_start|user_prompt|pre_tool|post_tool|permission_request|
#         pre_compact|post_compact|stop)
#   stdin = raw codex hook payload (JSON; contains hook_event_name, session_id, cwd, etc.)
#
# The daemon enforces an HMAC-SHA256 signature over METHOD + "\n" +
# PATH + "\n" + BODY computed with the pane-specific RECK_HOOK_SECRET
# the daemon injects on spawn. Headers also carry a unix-second
# timestamp and a 16-byte random nonce for replay defense.
#
# Required env (all set by reck-stationd at pane spawn time):
#   RECK_PANE_ID       — the daemon's id for this pane
#   RECK_PROJECT_ID    — the project this pane belongs to
#   RECK_DAEMON_URL    — base URL of the local daemon
#   RECK_HOOK_SECRET   — the per-pane HMAC secret
#
# Fail-closed: if any required env var is missing, exit 0 silently.
# NEVER fall back to unauthenticated POST.

set -euo pipefail

KIND="${1:-}"
if [ -z "$KIND" ]; then
  exit 0
fi
if [ -z "${RECK_PANE_ID:-}" ] || [ -z "${RECK_DAEMON_URL:-}" ] \
   || [ -z "${RECK_HOOK_SECRET:-}" ] || [ -z "${RECK_PROJECT_ID:-}" ]; then
  exit 0
fi

DAEMON_BASE="${RECK_DAEMON_URL%/}"
PATH_PART="/panes/${RECK_PANE_ID}/agent-event"
URL="${DAEMON_BASE}${PATH_PART}?kind=${KIND}&agent=codex"

BODY_FILE="$(mktemp -t reck-codex-hook-body.XXXXXXXX)"
CANON_FILE="$(mktemp -t reck-codex-hook-canon.XXXXXXXX)"
trap 'rm -f "$BODY_FILE" "$CANON_FILE"' EXIT

# Read codex's stdin payload, merge in project_id at the JSON-object
# root (daemon requires it for routing). Codex's payload is JSON with
# fields like hook_event_name, session_id, turn_id, cwd, model — we
# pass it through unchanged aside from the project_id injection.
python3 -c '
import json, sys
project_id = sys.argv[1]
out_path = sys.argv[2]
raw = sys.stdin.read().strip()
try:
    obj = json.loads(raw) if raw else {}
    if not isinstance(obj, dict):
        obj = {"payload": obj}
except Exception:
    obj = {"payload": raw}
obj["project_id"] = project_id
with open(out_path, "w", encoding="utf-8") as f:
    f.write(json.dumps(obj, separators=(",", ":")))
' "$RECK_PROJECT_ID" "$BODY_FILE"

TS="$(date +%s)"
NONCE="$(openssl rand -hex 16)"

{
  printf 'POST\n'
  printf '%s\n' "$PATH_PART"
  cat "$BODY_FILE"
} > "$CANON_FILE"

SIG="$(openssl dgst -sha256 -hmac "$RECK_HOOK_SECRET" -hex < "$CANON_FILE" \
       | awk '{print $NF}')"

curl -sS --max-time 2 \
  -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-Reck-Hook-Sig: $SIG" \
  -H "X-Reck-Hook-Ts: $TS" \
  -H "X-Reck-Hook-Nonce: $NONCE" \
  --data-binary "@$BODY_FILE" \
  >/dev/null 2>&1 || true
