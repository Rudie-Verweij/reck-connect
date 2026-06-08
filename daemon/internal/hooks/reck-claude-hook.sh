#!/usr/bin/env bash
# reck-claude-hook.sh — bridges a Claude Code lifecycle hook into the
# reck-stationd agent-event endpoint.
#
# Invoked by Claude Code with:
#   $1 = canonical kind (session_start|user_prompt|pre_tool|post_tool|stop|notification|session_end)
#   stdin = raw hook payload (JSON)
#
# Audit fix F4 (#139): the daemon no longer accepts unsigned POSTs to
# /panes/<id>/agent-event. Each request must carry an HMAC-SHA256
# signature over METHOD + "\n" + PATH + "\n" + BODY computed with the
# pane-specific RECK_HOOK_SECRET the daemon injects on spawn. The
# headers also carry a unix-second timestamp and a 16-byte random
# nonce for replay defense (the daemon enforces a ±60s window plus
# per-pane nonce dedup).
#
# Required env (all set by reck-stationd at pane spawn time):
#   RECK_PANE_ID       — the daemon's id for this pane
#   RECK_PROJECT_ID    — the project this pane belongs to (also embedded in body)
#   RECK_DAEMON_URL    — base URL of the local daemon (e.g. http://127.0.0.1:7315)
#   RECK_HOOK_SECRET   — the 64-char hex per-pane HMAC secret
#
# Fail-closed: if any required env var is missing, the script exits 0
# silently. NEVER fall back to unauthenticated POST — the whole point
# of F4 is that an unsigned event is forged event.

set -euo pipefail

KIND="${1:-}"
if [ -z "$KIND" ]; then
  exit 0
fi
# F4 fail-closed: missing secret/pane/url/project means the shim is
# running outside reck-stationd or the daemon's env-injection broke.
# Either way, posting unsigned is worse than dropping the event.
if [ -z "${RECK_PANE_ID:-}" ] || [ -z "${RECK_DAEMON_URL:-}" ] \
   || [ -z "${RECK_HOOK_SECRET:-}" ] || [ -z "${RECK_PROJECT_ID:-}" ]; then
  exit 0
fi

DAEMON_BASE="${RECK_DAEMON_URL%/}"
PATH_PART="/panes/${RECK_PANE_ID}/agent-event"
URL="${DAEMON_BASE}${PATH_PART}?kind=${KIND}&agent=claude-code"

# Stage tmpfiles for the body + canonical string so we can sign once
# and post the exact bytes. mktemp's `-t` template is portable across
# macOS bash 3.2 (the system shell) and Linux. trap cleans both files
# on every exit path so a crash doesn't leak under $TMPDIR.
BODY_FILE="$(mktemp -t reck-hook-body.XXXXXXXX)"
CANON_FILE="$(mktemp -t reck-hook-canon.XXXXXXXX)"
trap 'rm -f "$BODY_FILE" "$CANON_FILE"' EXIT

# Read Claude's hook payload from stdin and merge in project_id at the
# JSON-object root. project_id is required by the daemon (F4) so the
# shim guarantees it's present even if Claude posts an empty object.
# We use python because jq isn't in the system path on a stock macOS
# install, while python3 ships with the Xcode CLT that the daemon
# already requires for swiftc / git. Python writes the canonical body
# to BODY_FILE so curl can replay byte-for-byte what we signed.
#
# Pass the script via -c (not <<'PY' heredoc) so the script body
# itself doesn't get redirected onto python's stdin — Claude's hook
# payload is the legitimate stdin source and a heredoc would shadow
# it. The script is single-quoted to suppress all bash expansion,
# and the project_id + output path arrive as positional argv.
python3 -c '
import json, sys
project_id = sys.argv[1]
out_path = sys.argv[2]
raw = sys.stdin.read().strip()
try:
    obj = json.loads(raw) if raw else {}
    if not isinstance(obj, dict):
        # Wrap non-object payloads so we can still attach project_id.
        obj = {"payload": obj}
except Exception:
    # Non-JSON stdin gets carried as a string in payload; the daemon
    # treats this as a 400 (project_id is required at the object root,
    # and a string-payload object satisfies that).
    obj = {"payload": raw}
obj["project_id"] = project_id
with open(out_path, "w", encoding="utf-8") as f:
    f.write(json.dumps(obj, separators=(",", ":")))
' "$RECK_PROJECT_ID" "$BODY_FILE"

TS="$(date +%s)"
NONCE="$(openssl rand -hex 16)"

# Canonical-string format MUST match the server's VerifyHookSignature
# (see hookauth.go): METHOD + "\n" + PATH + "\n" + BODY. printf is more
# predictable than echo across shells, and concatenating into the file
# gives us a single read for openssl.
{
  printf 'POST\n'
  printf '%s\n' "$PATH_PART"
  cat "$BODY_FILE"
} > "$CANON_FILE"

SIG="$(openssl dgst -sha256 -hmac "$RECK_HOOK_SECRET" -hex < "$CANON_FILE" \
       | awk '{print $NF}')"

# Fire-and-forget with a short timeout so a slow/down daemon never
# blocks the Claude session. --data-binary with @file replays the
# exact bytes we signed (no shell variable round-trip that could
# mangle a literal newline or NUL inside the JSON).
curl -sS --max-time 2 \
  -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-Reck-Hook-Sig: $SIG" \
  -H "X-Reck-Hook-Ts: $TS" \
  -H "X-Reck-Hook-Nonce: $NONCE" \
  --data-binary "@$BODY_FILE" \
  >/dev/null 2>&1 || true
