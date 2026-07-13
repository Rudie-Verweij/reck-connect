#!/usr/bin/env bash
# reck-statusline.sh — bridges the Claude Code statusline payload into the
# reck-stationd usage-telemetry endpoint, then renders a statusline.
#
# Claude Code invokes the configured statusLine command once per render
# with the status JSON on stdin. Unlike lifecycle hooks (an additive
# array), settings.json.statusLine is a single value — so this shim is
# installed as THE statusLine and, to avoid hijacking a user's own
# statusline, it chains to whatever statusLine command was configured
# before Reck took over.
#
#   $1 = the user's prior statusLine command, captured at install time
#        (may be empty). Rendered by piping the same payload into it.
#
# Forwarding is best-effort and fully fail-closed: if the per-pane env the
# daemon injects at spawn is absent (i.e. this Claude session isn't a reck
# pane), we forward nothing and just render. Forwarding runs in the
# background so it never adds latency to the statusline render.
#
# Auth mirrors reck-claude-hook.sh: HMAC-SHA256 over METHOD + "\n" + PATH
# + "\n" + BODY with the pane's RECK_HOOK_SECRET, plus a timestamp and
# nonce for replay defense.

set -uo pipefail

PRIOR="${1:-}"

# Read the status payload once; JSON never contains NUL so a shell var is
# a faithful carrier for both the forward and the chained render.
PAYLOAD="$(cat)"

# --- forward to the daemon (background, best-effort) ---
if [ -n "${RECK_PANE_ID:-}" ] && [ -n "${RECK_DAEMON_URL:-}" ] \
   && [ -n "${RECK_HOOK_SECRET:-}" ] && [ -n "${RECK_PROJECT_ID:-}" ]; then
  (
    DAEMON_BASE="${RECK_DAEMON_URL%/}"
    PATH_PART="/panes/${RECK_PANE_ID}/usage-sample"
    URL="${DAEMON_BASE}${PATH_PART}?agent=claude-code"

    BODY_FILE="$(mktemp -t reck-sl-body.XXXXXXXX)" || exit 0
    CANON_FILE="$(mktemp -t reck-sl-canon.XXXXXXXX)" || { rm -f "$BODY_FILE"; exit 0; }
    trap 'rm -f "$BODY_FILE" "$CANON_FILE"' EXIT

    # Merge project_id into the payload root (required by the daemon) and
    # write the exact bytes we will sign + send. python3 ships with the
    # Xcode CLT the daemon already depends on; jq is not guaranteed.
    printf '%s' "$PAYLOAD" | python3 -c '
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
' "$RECK_PROJECT_ID" "$BODY_FILE" || exit 0

    TS="$(date +%s)"
    NONCE="$(openssl rand -hex 16)"
    {
      printf 'POST\n'
      printf '%s\n' "$PATH_PART"
      cat "$BODY_FILE"
    } > "$CANON_FILE"
    SIG="$(openssl dgst -sha256 -hmac "$RECK_HOOK_SECRET" -hex < "$CANON_FILE" | awk '{print $NF}')"

    curl -sS --max-time 2 \
      -X POST "$URL" \
      -H "Content-Type: application/json" \
      -H "X-Reck-Hook-Sig: $SIG" \
      -H "X-Reck-Hook-Ts: $TS" \
      -H "X-Reck-Hook-Nonce: $NONCE" \
      --data-binary "@$BODY_FILE" \
      >/dev/null 2>&1 || true
  ) &
fi

# --- render the statusline ---
# Chain to the user's prior statusLine if we captured one; otherwise emit
# a minimal, sensible default (model + context% + 5h quota%) so the line
# isn't blank. Any failure degrades to an empty line — a statusline must
# never error.
if [ -n "$PRIOR" ]; then
  printf '%s' "$PAYLOAD" | bash -c "$PRIOR"
else
  printf '%s' "$PAYLOAD" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
parts = []
m = (d.get("model") or {}).get("display_name")
if m:
    parts.append(str(m))
cw = d.get("context_window") or {}
up = cw.get("used_percentage")
if up is not None:
    parts.append("ctx %d%%" % round(up))
rl = (d.get("rate_limits") or {}).get("five_hour") or {}
fh = rl.get("used_percentage")
if fh is not None:
    parts.append("5h %d%%" % round(fh))
sys.stdout.write(" · ".join(parts))
' 2>/dev/null || true
fi
