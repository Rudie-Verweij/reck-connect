package supervisor

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"

	"github.com/rudie-verweij/reck-connect/daemon/internal/httpx"
	"github.com/rudie-verweij/reck-connect/proto"
)

// maxChatMessage bounds an inbound Mission Control chat payload. 64 KiB
// is far larger than any realistic user message but guards against a
// compromised caller flooding the supervisor pane.
//
// Matches the catch-all maxJSONBody used by the router's create/rename
// /dismiss handlers — one cap for every small structured JSON endpoint,
// so a future tweak only lands in one place.
const maxChatMessage = 64 * 1024

// wsBearerSubprotocolPrefix identifies the Sec-WebSocket-Protocol entry
// that carries the bearer token. Must match internal/http.WSBearerSubprotocol
// (we avoid the dep to keep the supervisor → http edge one-way).
const wsBearerSubprotocolPrefix = "reck-bearer."

// extractOfferedBearerSubprotocol scans Sec-WebSocket-Protocol headers
// for the bearer entry and returns the raw offered subprotocol string
// (e.g. "reck-bearer.abc123"). Used so ServeWS can echo it via
// AcceptOptions.Subprotocols — the browser rejects the 101 otherwise.
// authMiddleware has already validated the token before ServeWS runs;
// this is purely about round-tripping the string the client offered.
func extractOfferedBearerSubprotocol(h http.Header) string {
	for _, line := range h.Values("Sec-WebSocket-Protocol") {
		for _, part := range strings.Split(line, ",") {
			p := strings.TrimSpace(part)
			if strings.HasPrefix(p, wsBearerSubprotocolPrefix) {
				return p
			}
		}
	}
	return ""
}

// ServeState implements http.MissionControlHandler — GET /mission-control/state.
func (c *Controller) ServeState(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, c.snapshot())
}

// ServeHistory returns the persisted conversation. For v1 this is always
// empty — the supervisor conversation lives inside the Claude Code pane's
// own session (via --session-id / --resume). Exposed for protocol
// completeness so the Satellite can bind the surface without a 404.
func (c *Controller) ServeHistory(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, proto.MissionControlHistoryResponse{
		Messages: []proto.MissionControlChatMessage{},
	})
}

// ServeChat handles POST /mission-control/chat. The body's "message"
// field is typed into the supervisor pane's stdin with a trailing CR so
// the agent processes it. Starts the supervisor pane on demand when
// it's not already running.
//
// Body is decoded via httpx.DecodeJSONBody so oversize or trailing-data
// payloads are rejected with the same 413/400 policy the router
// applies — single source of truth for the daemon's JSON-body
// contract. The previous local readJSON used io.LimitReader, which
// silently truncated oversize bodies into malformed JSON (400) rather
// than surfacing 413, breaking the uniformity of the cap.
func (c *Controller) ServeChat(w http.ResponseWriter, r *http.Request) {
	var req proto.MissionControlChatRequest
	if err := httpx.DecodeJSONBody(w, r, maxChatMessage, &req); err != nil {
		// DecodeJSONBody already wrote the response (413/400).
		return
	}
	if req.Message == "" {
		http.Error(w, "message required", http.StatusBadRequest)
		return
	}
	// Reject non-printable bytes so a malicious caller can't smuggle
	// terminal control sequences into the supervisor pane's PTY. \t
	// and newlines are intentionally allowed — normal chat.
	if offender, ok := firstControlByte(req.Message); ok {
		slog.Info("mc chat: rejected control byte", "byte", int(offender))
		http.Error(w, "message contains control characters", http.StatusBadRequest)
		return
	}
	paneID := c.SupervisorPaneID()
	if paneID == "" {
		id, err := c.StartSupervisor()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		paneID = id
	}
	pane, ok := c.mgr.PaneByID(paneID)
	if !ok {
		http.Error(w, "supervisor pane vanished", http.StatusInternalServerError)
		return
	}
	// Write message + CR. No leading wait for the prompt — the user
	// has just typed, so the pane is idle.
	if err := pane.Write([]byte(req.Message + "\r")); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "pane_id": paneID})
}

// firstControlByte scans for ASCII control bytes (< 0x20) that are NOT
// tab / LF / CR. Reports the offending byte and true if found, or 0 +
// false when clean. UTF-8 continuation bytes are >= 0x80 so the
// <0x20 check is safe on arbitrary-encoded input.
func firstControlByte(s string) (byte, bool) {
	for i := 0; i < len(s); i++ {
		b := s[i]
		if b < 0x20 && b != '\t' && b != '\n' && b != '\r' {
			return b, true
		}
		if b == 0x7f { // DEL
			return b, true
		}
	}
	return 0, false
}

// ServeReset kills the supervisor pane so the next chat spawns a fresh
// one. Analogous to "clear history" but implemented via pane lifecycle.
func (c *Controller) ServeReset(w http.ResponseWriter, r *http.Request) {
	if err := c.StopSupervisor(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// ServeWS upgrades to a WebSocket and streams state snapshots whenever
// the manager fires OnStateChange. Sends an initial snapshot on connect.
func (c *Controller) ServeWS(w http.ResponseWriter, r *http.Request) {
	// Defense in depth vs CSWSH: reject browser-initiated upgrades
	// from a cross-origin page. Native clients (the satellite, curl)
	// don't send Origin and pass through.
	if !originAllowed(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	accept := &websocket.AcceptOptions{
		// InsecureSkipVerify bypasses nhooyr's same-origin check —
		// we've already gated on Origin above.
		InsecureSkipVerify: true,
	}
	// Browser clients authenticate WS upgrades via a
	// reck-bearer.<token> subprotocol (see auth plumbing in
	// internal/http/router.go). The 101 response must echo one of the
	// offered subprotocols or the browser rejects the upgrade with
	// "subprotocol mismatch", so forward whatever the client offered.
	if offered := extractOfferedBearerSubprotocol(r.Header); offered != "" {
		accept.Subprotocols = []string{offered}
	} else if raw := r.Header.Values("Sec-WebSocket-Protocol"); len(raw) > 0 {
		if strings.TrimSpace(strings.Join(raw, ",")) != "" {
			http.Error(w, "unsupported subprotocol", http.StatusBadRequest)
			return
		}
	}
	conn, err := websocket.Accept(w, r, accept)
	if err != nil {
		slog.Debug("mc ws: accept failed", "err", err)
		return
	}
	defer conn.Close(websocket.StatusInternalError, "terminated")

	subID, ch := c.subscribe()
	defer c.unsubscribe(subID)

	ctx := r.Context()

	// Send initial snapshot so the client has something to render.
	if err := wsjson.Write(ctx, conn, proto.MCStateMessage{
		Type:  "state",
		State: c.snapshot(),
	}); err != nil {
		return
	}

	// Fan out subscriber-channel updates and watch for client disconnects.
	readCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		// Drain client reads (we don't expect any messages from the
		// browser side for v1, but read to detect close cleanly).
		for {
			_, _, err := conn.Read(readCtx)
			if err != nil {
				cancel()
				return
			}
		}
	}()

	for {
		select {
		case <-readCtx.Done():
			conn.Close(websocket.StatusNormalClosure, "bye")
			return
		case snap := <-ch:
			if err := wsjson.Write(readCtx, conn, proto.MCStateMessage{
				Type:  "state",
				State: snap,
			}); err != nil {
				conn.Close(websocket.StatusInternalError, "write failed")
				return
			}
		}
	}
}

// --- used by ServeChat decoding; wrappers keep encoding/json import local ---
var _ = json.Marshal

// originAllowed mirrors the rules in internal/http.originAllowed. Kept
// private here so the supervisor package stays import-independent of
// internal/http (which imports internal/supervisor via the handler
// interface — reverse would be a cycle).
func originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" || origin == "null" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if u.Scheme == "file" {
		return true
	}
	host := u.Hostname()
	if host == "127.0.0.1" || host == "::1" || host == "localhost" {
		return true
	}
	reqHost := r.Host
	if idx := strings.Index(reqHost, ":"); idx >= 0 {
		reqHost = reqHost[:idx]
	}
	if host == reqHost && host != "" {
		return true
	}
	return false
}
