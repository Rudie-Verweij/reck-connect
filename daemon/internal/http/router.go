// Package http wires HTTP routes for the daemon.
package http

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	nethttp "net/http"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/daemon/internal/events"
	"github.com/rudie-verweij/reck-connect/daemon/internal/httpx"
	"github.com/rudie-verweij/reck-connect/daemon/internal/pty"
	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
	"github.com/rudie-verweij/reck-connect/daemon/internal/ws"
	"github.com/rudie-verweij/reck-connect/proto"
)

// Production HTTP server timeouts. Exposed as package-level vars so the
// daemon's main() and tests that need the same values can reference a
// single source of truth. Justification is in ApplyTimeouts below.
var (
	DefaultReadHeaderTimeout = 5 * time.Second
	DefaultReadTimeout       = 30 * time.Second
	DefaultWriteTimeout      = 45 * time.Second
	DefaultIdleTimeout       = 120 * time.Second
	DefaultMaxHeaderBytes    = 32 * 1024
)

// ApplyTimeouts wires the daemon's standard HTTP-server hardening onto s.
// Values picked to be generous enough for real client behaviour but
// close enough to block slow-loris and request-stall abuse:
//
//   - ReadHeaderTimeout (5s): browsers, curl, and the Satellite all
//     finish request headers within milliseconds. A client that
//     can't complete headers in 5s is almost certainly a slow-loris
//     probe, so we close early before the handler ever runs.
//   - ReadTimeout (30s): whole-request cap. Set well above the
//     largest normal JSON body we accept (handler-level
//     MaxBytesReader caps are 64 KiB) so trickle-fed POSTs can't
//     slip under it. Bounded so a malicious client can't tie up
//     read goroutines indefinitely.
//   - WriteTimeout (45s): bounded but long enough for paginated
//     replay tails and restore-candidates responses on a slow
//     network. Pane WS handlers are not bound by this — nhooyr's
//     Accept() hijacks the connection, which clears the
//     server-managed deadlines.
//   - IdleTimeout (120s): keep-alive cap. The Satellite reconnects
//     opportunistically; 120s amortises TCP setup over a burst of
//     REST calls without leaving stale sockets around.
//   - MaxHeaderBytes (32 KiB): generous for legitimate traffic
//     (Authorization + Sec-WebSocket-Protocol carrying a long
//     bearer + a few cookies) while cutting net/http's 1 MiB
//     default down to something that actually bounds memory per
//     handshake.
func ApplyTimeouts(srv *nethttp.Server) {
	srv.ReadHeaderTimeout = DefaultReadHeaderTimeout
	srv.ReadTimeout = DefaultReadTimeout
	srv.WriteTimeout = DefaultWriteTimeout
	srv.IdleTimeout = DefaultIdleTimeout
	srv.MaxHeaderBytes = DefaultMaxHeaderBytes
}

// Server is the composed HTTP + WS surface.
type Server struct {
	Manager   *pty.Manager
	WS        *ws.Handler
	MC        MissionControlHandler // optional; nil-safe — MC endpoints omitted when unset
	StartedAt time.Time
	Version   string
	// CodexAvailable mirrors whether the daemon resolved a codex binary at
	// startup; surfaced on /health so the Satellite can gate the "Codex"
	// new-pane button. Set from len(codexCmd) > 0 in main.
	CodexAvailable bool
	// SupervisorAuth, when non-nil, enables a second bearer token that
	// identifies the Mission Control supervisor pane. The supervisor
	// token lets a pane child authenticate to the daemon without the
	// main DAEMON_TOKEN being in its environment. Requests authenticated
	// with the supervisor token have their scope narrowed at the handler
	// level (only docked projects + the supervisor's own meta-project).
	SupervisorAuth SupervisorAuthenticator
	// ClipboardWriter, when non-nil, replaces the default
	// macclipboard.WriteImage call inside handleClipboardImage. Tests
	// stub this so they don't need a real Aqua session; production
	// leaves it nil and the handler falls through to macclipboard.
	ClipboardWriter func(mime string, body []byte) error

	// HookNonceStore tracks accepted (paneID, nonce) tuples for replay
	// defense on /panes/:id/agent-event. Audit fix F4 . Lazily
	// initialised on first use via hookNonceStore() so existing
	// fixtures that build a zero-valued Server still work — tests can
	// still inject a custom store (e.g. with a fake clock) by setting
	// this field directly before serving.
	HookNonceStore *NonceStore
	// hookNonceStoreInit guards lazy initialisation of HookNonceStore.
	hookNonceStoreInit sync.Once
}

// hookNonceStore returns the server's nonce store, lazily creating one
// the first time it's asked for. Keeps the zero-value Server usable —
// every existing test that constructs `&Server{...}` without thinking
// about hook auth keeps working without a constructor change.
func (s *Server) hookNonceStore() *NonceStore {
	s.hookNonceStoreInit.Do(func() {
		if s.HookNonceStore == nil {
			s.HookNonceStore = NewNonceStore()
		}
	})
	return s.HookNonceStore
}

// SupervisorAuthenticator validates the Mission Control supervisor's
// bearer token and answers scope questions for requests that carry it.
// Implemented by the supervisor package; nil when MC is disabled.
type SupervisorAuthenticator interface {
	// CheckToken reports whether the given bearer (raw, without the
	// "Bearer " prefix) is the current supervisor token. Implementations
	// must use constant-time comparison.
	CheckToken(bearer string) bool
	// IsProjectAccessible reports whether the supervisor is permitted to
	// act on the given project. True for docked projects and the
	// supervisor's own meta-project; false otherwise (including unknown
	// project ids).
	IsProjectAccessible(projectID string) bool
	// IsPaneAccessible reports whether the supervisor is permitted to
	// act on the given pane. True iff the pane's project is accessible
	// per IsProjectAccessible.
	IsPaneAccessible(paneID string) bool
}

// MissionControlHandler abstracts the supervisor-agent surface so the HTTP
// router doesn't import the supervisor package (which carries the Anthropic
// SDK). The daemon cmd wires it up; tests can omit it.
type MissionControlHandler interface {
	ServeState(w nethttp.ResponseWriter, r *nethttp.Request)
	ServeHistory(w nethttp.ResponseWriter, r *nethttp.Request)
	ServeChat(w nethttp.ResponseWriter, r *nethttp.Request)
	ServeReset(w nethttp.ResponseWriter, r *nethttp.Request)
	ServeWS(w nethttp.ResponseWriter, r *nethttp.Request)
	NotifyStateChanged()
}

// Router returns the chi mux.
func (s *Server) Router() *chi.Mux {
	r := chi.NewRouter()
	r.Use(corsMiddleware)
	r.Use(s.authMiddleware)

	r.Get("/health", s.handleHealth)
	r.Get("/projects", s.handleProjects)
	r.Post("/projects", s.handleCreateProject)
	// PUT /projects: hybrid mode rev 3.1, phase 8. Wholesale-replace the
	// in-memory project map. Mode-gated to local; station-mode daemons
	// reject with 409 (their projects.toml is authoritative). See
	// handlePutProjects for the trust-boundary contract.
	r.Put("/projects", s.handlePutProjects)
	r.Delete("/projects/{id}", s.handleDeleteProject)
	r.Get("/projects/{id}", s.handleProjectDetail)
	r.Post("/projects/{id}/dock", s.handleDockProject)
	r.Post("/projects/{id}/undock", s.handleUndockProject)
	r.Post("/projects/{id}/archive", s.handleArchiveProject)
	r.Post("/projects/{id}/unarchive", s.handleUnarchiveProject)
	r.Post("/projects/{id}/rename", s.handleRenameProject)
	r.Post("/projects/{id}/panes", s.handleCreatePane)
	r.Delete("/projects/{id}/panes/{pane_id}", s.handleDeletePane)
	r.Post("/projects/{id}/panes/{pane_id}/rename", s.handleRenamePane)
	r.Get("/projects/{id}/sessions", s.handleListSessions)
	r.Get("/projects/{id}/sessions/{session_id}/transcript", s.handleTranscript)
	r.Post("/projects/{id}/sessions/dismiss", s.handleDismissSessions)
	r.Get("/restore-candidates", s.handleRestoreCandidates)
	r.Post("/panes/{pane_id}/agent-event", s.handleAgentEvent)
	r.Get("/panes/{pane_id}/events", s.handlePaneEvents)
	r.Post("/panes/{pane_id}/input", s.handlePaneInput)
	r.Get("/panes/{pane_id}/output", s.handlePaneOutput)
	// Image-paste upload endpoint (phase 1). Writes a posted
	// image to a per-pane tmpdir and returns the absolute path for the
	// renderer to type into the PTY. Bearer-auth enforced above; no
	// loopback exemption.
	r.Post("/panes/{pane_id}/uploads", s.handlePaneUpload)
	// GET companion — lists images currently staged in the pane's
	// tmpdir. Shares auth + supervisor carve-outs with the POST above.
	// Primary consumer is test tooling (and a potential future UI
	// showing "recent paste history"); no live renderer logic depends
	// on it yet.
	r.Get("/panes/{pane_id}/uploads", s.handleListPaneUploads)
	// phase 2 → phase 2: clipboard image push.
	// Daemon writes the raw image to NSPasteboard.general directly via
	// cgo (internal/macclipboard), then writes 0x16 into the pane PTY
	// so Claude Code reads the pasteboard and creates the [Image #N]
	// chip. NSPasteboard rejection → 500 with the error text; renderer
	// falls back to the /uploads path above on any 5xx.
	r.Post("/panes/{pane_id}/clipboard-image", s.handleClipboardImage)
	r.HandleFunc("/ws/{id}/{pane_id}", s.handleWS)
	if s.MC != nil {
		r.Get("/mission-control/state", s.handleMCState)
		r.Get("/mission-control/history", s.handleMCHistory)
		r.Post("/mission-control/chat", s.handleMCChat)
		r.Post("/mission-control/reset", s.handleMCReset)
		r.HandleFunc("/ws/mission-control", s.handleMCWS)
	}
	return r
}

// corsMiddleware permits any origin. The daemon only binds to 127.0.0.1 in
// local mode; the auth middleware enforces DAEMON_TOKEN where set. Preflight
// OPTIONS short-circuits here so it never hits auth.
func corsMiddleware(next nethttp.Handler) nethttp.Handler {
	return nethttp.HandlerFunc(func(w nethttp.ResponseWriter, r *nethttp.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if r.Method == nethttp.MethodOptions {
			w.WriteHeader(nethttp.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ctxKey is a private type for request-scoped values to avoid collisions
// between packages in context.WithValue.
type ctxKey string

const (
	ctxActor         ctxKey = "actor"          // "main" (DAEMON_TOKEN) | "supervisor" | ""
	ctxWSSubprotocol ctxKey = "ws_subprotocol" // bearer subprotocol offered by the client (must be echoed on accept)
)

// ActorFromRequest returns "main", "supervisor", or "" for the
// authenticated actor behind a request. Handlers use this to apply
// scope restrictions to supervisor-authenticated requests.
func ActorFromRequest(r *nethttp.Request) string {
	if v, _ := r.Context().Value(ctxActor).(string); v != "" {
		return v
	}
	return ""
}

// WSBearerSubprotocol is the Sec-WebSocket-Protocol subprotocol name used to
// ferry the bearer token through a browser WebSocket upgrade. Browsers can
// set this header via the `new WebSocket(url, [subprotocol])` constructor's
// second argument but cannot set arbitrary headers like `Authorization` —
// so for WS upgrades the daemon accepts either the Authorization header
// (native clients) or a subprotocol of the shape
//
//	reck-bearer.<token>
//
// The server echoes the same subprotocol back in the 101 response so
// browsers don't reject the upgrade with a SUBPROTOCOL error. This
// replaces the previous `?token=<...>` query-string fallback, which
// leaked bearers into URLs (access logs, referrers, crash reports).
//
// The subprotocol is an opaque identifier from the browser's perspective;
// the only contract is that the server accepts it if offered. We use a
// '.' separator rather than ':' or '=' because the HTTP subprotocol
// grammar (RFC 6455 §11.5) restricts token characters.
const WSBearerSubprotocol = "reck-bearer"

// extractWSBearer returns the bearer token encoded in the
// Sec-WebSocket-Protocol header, if any. The header is a comma-separated
// list of offered subprotocols; we scan for the first entry whose prefix
// matches `reck-bearer.` and return the suffix.
//
// Returns ("", "") if the caller didn't offer a recognised bearer entry —
// the handler then falls through to the Authorization header path or 401.
// The second return value is the raw subprotocol string that the server
// must echo back via accept-options; empty when no match.
func extractWSBearer(h nethttp.Header) (token, offered string) {
	raw := h.Values("Sec-WebSocket-Protocol")
	for _, line := range raw {
		for _, part := range strings.Split(line, ",") {
			p := strings.TrimSpace(part)
			if strings.HasPrefix(p, WSBearerSubprotocol+".") {
				return strings.TrimPrefix(p, WSBearerSubprotocol+"."), p
			}
		}
	}
	return "", ""
}

func (s *Server) authMiddleware(next nethttp.Handler) nethttp.Handler {
	token := os.Getenv("DAEMON_TOKEN")
	expected := []byte("Bearer " + token)
	return nethttp.HandlerFunc(func(w nethttp.ResponseWriter, r *nethttp.Request) {
		// Audit fix F3 : fail closed when DAEMON_TOKEN is unset.
		// Previously, an empty token short-circuited every request as
		// "unauthenticated mode" — combined with router-wide
		// Access-Control-Allow-Origin: *, that meant a misconfigured
		// daemon could be driven from any webpage in the user's browser.
		// Production startup (cmd/reck-stationd/main.go) now fatal-exits
		// when no token is resolved, so reaching this branch in
		// production indicates a config regression. Return 503 with a
		// clear body so a misbehaving deployment surfaces a diagnosable
		// failure instead of a silent open door. CORS preflight (OPTIONS)
		// is handled in corsMiddleware before this runs, so browser
		// requests still get the headers and surface the 503 cleanly.
		if token == "" {
			nethttp.Error(w,
				"daemon token not configured: refusing request",
				nethttp.StatusServiceUnavailable)
			return
		}
		// Audit fix F4 : the agent-event endpoint has its own
		// per-pane HMAC + nonce-replay gate enforced inside
		// handleAgentEvent. The middleware no longer bearer-checks it
		// — the shim posting in a pane's child can't ever carry the
		// daemon's bearer token (we deliberately strip it from the
		// child env), so the only viable auth scheme there is the
		// per-pane secret the daemon injected as RECK_HOOK_SECRET.
		// We still gate at the middleware to reject pre-flight
		// header oddness and require the path matches; everything
		// else is the handler's job.
		//
		// The previous "loopback exemption" branch — which bypassed
		// auth for any local POST regardless of who sent it — is
		// gone. Local processes that didn't inherit the per-pane
		// secret now hit a 401 from the handler, which is the F4
		// invariant.
		if isAgentEventPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		h := r.Header.Get("Authorization")
		// WS upgrades: browsers can't set Authorization on `new
		// WebSocket(...)`. Instead the Satellite offers a
		// `reck-bearer.<token>` subprotocol; we extract + validate it
		// exactly like the Authorization header. The previous
		// `?token=<...>` query-param fallback was removed because the
		// URL string leaks into access logs, devtools, and error
		// surfaces. See WSBearerSubprotocol docstring above.
		//
		// The matched subprotocol string is stashed on the context so
		// the WS handler can echo it back via AcceptOptions (the 101
		// response MUST name one of the offered subprotocols or the
		// browser fails the upgrade).
		var offeredSubprotocol string
		if strings.HasPrefix(r.URL.Path, "/ws/") {
			if bearer, offered := extractWSBearer(r.Header); bearer != "" {
				if h == "" {
					h = "Bearer " + bearer
				}
				offeredSubprotocol = offered
			}
		}
		// Try the main bearer first.
		if subtle.ConstantTimeCompare([]byte(h), expected) == 1 {
			ctx := context.WithValue(r.Context(), ctxActor, "main")
			if offeredSubprotocol != "" {
				ctx = context.WithValue(ctx, ctxWSSubprotocol, offeredSubprotocol)
			}
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}
		// Fall back to the supervisor token, if registered. Scope is
		// enforced at handler level (docked projects + meta only).
		if s.SupervisorAuth != nil && strings.HasPrefix(h, "Bearer ") {
			raw := strings.TrimPrefix(h, "Bearer ")
			if s.SupervisorAuth.CheckToken(raw) {
				ctx := context.WithValue(r.Context(), ctxActor, "supervisor")
				if offeredSubprotocol != "" {
					ctx = context.WithValue(ctx, ctxWSSubprotocol, offeredSubprotocol)
				}
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
		}
		slog.Info("auth rejected", "path", r.URL.Path, "remote", r.RemoteAddr)
		nethttp.Error(w, "unauthorized", nethttp.StatusUnauthorized)
	})
}

// WSSubprotocolFromRequest returns the bearer subprotocol string offered by
// a WebSocket client after authMiddleware has extracted and validated it.
// WS handlers must pass this value into AcceptOptions.Subprotocols so the
// 101 response echoes it back — otherwise browsers reject the upgrade.
// Returns "" for native clients that authenticated via Authorization.
func WSSubprotocolFromRequest(r *nethttp.Request) string {
	if v, _ := r.Context().Value(ctxWSSubprotocol).(string); v != "" {
		return v
	}
	return ""
}

// requireSupervisorProjectScope returns nethttp.StatusForbidden if the
// request is authenticated as the supervisor and the target project is
// not in its accessible scope. Safe to call for non-supervisor requests
// (returns false, no status written). Returns true when the caller should
// stop handling the request.
func (s *Server) rejectSupervisorOutOfScope(w nethttp.ResponseWriter, r *nethttp.Request, projectID string) bool {
	if ActorFromRequest(r) != "supervisor" {
		return false
	}
	if s.SupervisorAuth == nil || !s.SupervisorAuth.IsProjectAccessible(projectID) {
		nethttp.Error(w, "forbidden: project not accessible to supervisor", nethttp.StatusForbidden)
		return true
	}
	return false
}

// rejectSupervisorPaneOutOfScope is the per-pane variant; used on
// /panes/:pane_id/... routes where the pane id is the only routing key.
func (s *Server) rejectSupervisorPaneOutOfScope(w nethttp.ResponseWriter, r *nethttp.Request, paneID string) bool {
	if ActorFromRequest(r) != "supervisor" {
		return false
	}
	if s.SupervisorAuth == nil || !s.SupervisorAuth.IsPaneAccessible(paneID) {
		nethttp.Error(w, "forbidden: pane not accessible to supervisor", nethttp.StatusForbidden)
		return true
	}
	return false
}

func isAgentEventPath(p string) bool {
	return strings.HasPrefix(p, "/panes/") && strings.HasSuffix(p, "/agent-event")
}

// isLoopbackAddr reports whether remoteAddr (an http.Request.RemoteAddr
// value, i.e. "host:port" for IPv4 or "[::1]:port" for IPv6) is a
// loopback presentation. We parse the host via netip so every form a
// kernel may present — plain 127.0.0.1, ::1, and IPv4-mapped IPv6
// ::ffff:127.0.0.1 — is treated as loopback.
//
// Before this check was a literal string compare against "127.0.0.1"
// and "::1", which missed the IPv4-mapped form that dual-stack TCP
// listeners sometimes produce. That mis-miss broke the loopback
// exemption for Claude Code lifecycle hooks on affected kernels: local
// hook shims would start getting 401s even though they were demonstrably
// local callers.
func isLoopbackAddr(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	if host == "" {
		return false
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	return addr.IsLoopback()
}

func (s *Server) handleHealth(w nethttp.ResponseWriter, r *nethttp.Request) {
	writeJSON(w, proto.HealthResponse{
		Status:         "ok",
		Version:        s.Version,
		UptimeSec:      int64(time.Since(s.StartedAt).Seconds()),
		CodexAvailable: s.CodexAvailable,
	})
}

func (s *Server) handleProjects(w nethttp.ResponseWriter, r *nethttp.Request) {
	writeJSON(w, proto.ProjectsListResponse{Projects: s.Manager.Projects()})
}

func (s *Server) handleProjectDetail(w nethttp.ResponseWriter, r *nethttp.Request) {
	id := chi.URLParam(r, "id")
	if s.rejectSupervisorOutOfScope(w, r, id) {
		return
	}
	// an earlier release: hybrid mode's selectProject fetches /projects/:id from
	// every enabled host so reconcile can rebind tabs across station +
	// local. The original auto-spawn-on-empty behaviour (kept for the
	// "new project gets a starter pane" UX on the primary host) then
	// fires on the secondary host too — local has zero panes for a
	// station-resident project, so a phantom Claude pane gets spawned
	// every time the user re-enters the project. The opt-out lets
	// secondary-host fetches read pane state without provoking the
	// spawn; default `true` keeps the new-project UX intact for clients
	// that don't pass the flag.
	//
	// Strict parsing (Codex HIGH): unparsable values (`?autospawn=fasle`
	// typo, `?autospawn=garbage`) used to fall through to the default
	// (`true`) and silently spawn — exactly the bug class the opt-out
	// was meant to fix, surfacing under a different shape. Reject with
	// 400 instead so the typo is loud. Accepts strconv.ParseBool's
	// canonical set: `true`/`false`/`1`/`0`/`t`/`f`/`TRUE`/etc.
	autoSpawn := true
	if v := r.URL.Query().Get("autospawn"); v != "" {
		parsed, err := strconv.ParseBool(v)
		if err != nil {
			nethttp.Error(w, "invalid autospawn value (expected true/false/1/0)", nethttp.StatusBadRequest)
			return
		}
		autoSpawn = parsed
	}
	if autoSpawn {
		// Atomic empty-check + spawn (Codex HIGH): see Manager.EnsureDefaultPane.
		// Concurrent GETs on the same empty project would otherwise both
		// observe zero panes and both spawn a starter pane.
		if _, _, err := s.Manager.EnsureDefaultPane(id, 120, 40); err != nil {
			_ = err
		}
	}
	d, ok := s.Manager.ProjectDetail(id)
	if !ok {
		nethttp.Error(w, "project not found", nethttp.StatusNotFound)
		return
	}
	writeJSON(w, d)
}

func (s *Server) handleCreatePane(w nethttp.ResponseWriter, r *nethttp.Request) {
	id := chi.URLParam(r, "id")
	if s.rejectSupervisorOutOfScope(w, r, id) {
		return
	}
	var req proto.CreatePaneRequest
	if err := decodeJSONBody(w, r, maxJSONBody, &req); err != nil {
		return
	}
	if req.Kind != proto.PaneKindClaude && req.Kind != proto.PaneKindShell && req.Kind != proto.PaneKindCodex {
		nethttp.Error(w, "invalid kind", nethttp.StatusBadRequest)
		return
	}
	// A codex create on a station without a resolved codex binary falls
	// through to CreatePaneWith, where the codex adapter returns
	// ErrCodexNotAvailable → 400 below. The Satellite hides the Codex
	// button unless /health reports codex_available, so this is the
	// raw-client / stale-UI safety net, not the normal path.
	pane, err := s.Manager.CreatePaneWith(id, req.Kind, 120, 40, pty.CreatePaneOptions{
		ResumeSessionID: req.ResumeSessionID,
		RestoreSlotID:   req.RestoreSlotID,
		ExtraArgs:       req.ExtraArgs,
		GlobalPreamble:  req.GlobalPreamble,
	})
	if err != nil {
		// ErrSlotAlreadyLive is the "concurrent restore / stale retry
		// tried to reclaim a slot that's already attached to a running
		// pane" case — semantically a conflict, not a bad request.
		// Clients that hit this can re-poll /restore-candidates and
		// see the slot is no longer offered.
		if errors.Is(err, pty.ErrSlotAlreadyLive) {
			nethttp.Error(w, err.Error(), nethttp.StatusConflict)
			return
		}
		nethttp.Error(w, err.Error(), nethttp.StatusBadRequest)
		return
	}
	writeJSON(w, proto.CreatePaneResponse{PaneID: pane.ID})
}

// handleListSessions returns the persisted session index for a project,
// newest-first. Entries whose JSONL no longer exists on disk (Claude Code
// TTLs its store at ~30 days) are filtered out so the Satellite never
// shows a row that `--resume` couldn't honor.
// handleListSessions serves the Claude-resume picker. Despite the
// generic "sessions" name, this endpoint is semantically Claude-only:
// old Satellite builds pre-Scope-B assumed every row carries a
// session_id and render via `s.session_id.slice(0,8)` — shipping a
// shell row (Kind="shell", SessionID="") would crash them. Shell
// restore lives on /restore-candidates (with an opt-in query param)
// where the same deployment-skew concern is addressed explicitly.
// (Codex HIGH #3.)
func (s *Server) handleListSessions(w nethttp.ResponseWriter, r *nethttp.Request) {
	id := chi.URLParam(r, "id")
	if s.rejectSupervisorOutOfScope(w, r, id) {
		return
	}
	if !s.Manager.ProjectExists(id) {
		nethttp.Error(w, "project not found", nethttp.StatusNotFound)
		return
	}
	store := s.Manager.Sessions()
	if store == nil {
		// Session persistence disabled — respond with an empty list
		// rather than 404, so the Satellite's "Resume…" UI degrades
		// gracefully to "no sessions yet".
		writeJSON(w, proto.SessionsListResponse{Sessions: []proto.SessionInfo{}})
		return
	}
	entries, err := store.List(id, sessions.ListOptions{})
	if err != nil {
		nethttp.Error(w, err.Error(), nethttp.StatusInternalServerError)
		return
	}
	out := make([]proto.SessionInfo, 0, len(entries))
	for _, e := range entries {
		// Filter to Claude entries. Pre-Scope-B on-disk rows have Kind
		// defaulted to claude by the sessions package on load, so this
		// is back-compatible without special-casing.
		if e.Kind != proto.PaneKindClaude {
			continue
		}
		out = append(out, entryToWire(e))
	}
	writeJSON(w, proto.SessionsListResponse{Sessions: out})
}

// entryToWire converts a store Entry to the JSON-wire SessionInfo.
// Includes Kind + SlotID for shell entries (Scope B); Claude
// entries carry SessionID as before. Receivers should treat missing
// kind as "claude" for back-compat.
func entryToWire(e sessions.Entry) proto.SessionInfo {
	return proto.SessionInfo{
		SessionID:    e.SessionID,
		Name:         e.Name,
		Cwd:          e.Cwd,
		CreatedAt:    e.CreatedAt.Format(time.RFC3339),
		LastActiveAt: e.LastActiveAt.Format(time.RFC3339),
		LastPaneID:   e.LastPaneID,
		WasLive:      e.WasLive,
		Kind:         e.Kind,
		SlotID:       e.SlotID,
	}
}

// handleRestoreCandidates returns the "panes the daemon believed were
// running but aren't" across every project — computed server-side so
// the Satellite can render a single restore prompt at reconnect.
//
// "Believed running" = WasLive (and for Claude entries, JSONL still on
// disk — shell entries skip that check since they have no external
// transcript).
// "Not running now" = LastPaneID not in the project's current live
// panes.
//
// Deployment-skew capability negotiation (Codex HIGH #3): a pre-Scope-B
// Satellite connecting to a post-Scope-B daemon would crash on a shell
// row's missing session_id. The endpoint therefore DEFAULTS to Claude-
// only (the legacy shape) and requires an explicit `?kinds=` opt-in
// for clients that handle both kinds. Unknown tokens in the list are
// silently ignored so a future `codex` sent to an older daemon
// degrades to "handled kinds that are understood here" rather than
// failing outright.
//
// Examples:
//
//	GET /restore-candidates                     → Claude-only (legacy)
//	GET /restore-candidates?kinds=claude        → Claude-only (explicit)
//	GET /restore-candidates?kinds=claude,shell  → both kinds
//	GET /restore-candidates?kinds=shell         → shell-only
//
// Drive-by: an entry with LastPaneID == "" (could arise from a partial
// Upsert that lost the pane id, or a pre-livePane bookkeeping bug)
// would slip through the livePaneIDs[e.LastPaneID] test as false and
// get offered for restore — but no pane ever claimed it, so restoring
// would spawn a duplicate. Skip those rows up front.
func (s *Server) handleRestoreCandidates(w nethttp.ResponseWriter, r *nethttp.Request) {
	acceptedKinds := parseAcceptedKinds(r.URL.Query().Get("kinds"))

	store := s.Manager.Sessions()
	if store == nil {
		writeJSON(w, proto.RestoreCandidatesResponse{Candidates: []proto.RestoreCandidateGroup{}})
		return
	}
	groups := make([]proto.RestoreCandidateGroup, 0)
	for _, proj := range s.Manager.Projects() {
		entries, err := store.List(proj.ID, sessions.ListOptions{})
		if err != nil {
			slog.Warn("restore-candidates: list failed", "err", err, "project", proj.ID)
			continue
		}
		if len(entries) == 0 {
			continue
		}
		livePanes := s.Manager.PanesInProject(proj.ID)
		livePaneIDs := make(map[string]bool, len(livePanes))
		for _, p := range livePanes {
			livePaneIDs[p.ID] = true
		}
		matching := make([]proto.SessionInfo, 0)
		for _, e := range entries {
			if !acceptedKinds[e.Kind] {
				continue
			}
			if !e.WasLive {
				continue
			}
			if e.LastPaneID == "" {
				// Drive-by Scope B: entry with no bound pane id
				// cannot be "still running somewhere else" — it was
				// never live under a pane from this daemon run.
				continue
			}
			if livePaneIDs[e.LastPaneID] {
				continue
			}
			matching = append(matching, entryToWire(e))
		}
		if len(matching) > 0 {
			groups = append(groups, proto.RestoreCandidateGroup{
				ProjectID:   proj.ID,
				ProjectName: proj.Name,
				Sessions:    matching,
			})
		}
	}
	writeJSON(w, proto.RestoreCandidatesResponse{Candidates: groups})
}

// parseAcceptedKinds returns a set of PaneKinds the client said it
// handles. Empty/missing param defaults to "claude" only (the
// pre-Scope-B legacy shape). Unknown tokens are silently dropped so a
// forward-compatible client can send `codex` to an older daemon.
// If an explicit list contains only unknown tokens, we fall back to
// the legacy Claude default rather than returning nothing for every
// project — the client clearly wants *some* restore surface.
func parseAcceptedKinds(param string) map[proto.PaneKind]bool {
	out := make(map[proto.PaneKind]bool)
	if param == "" {
		out[proto.PaneKindClaude] = true
		return out
	}
	for _, tok := range strings.Split(param, ",") {
		tok = strings.TrimSpace(tok)
		switch proto.PaneKind(tok) {
		case proto.PaneKindClaude:
			out[proto.PaneKindClaude] = true
		case proto.PaneKindShell:
			out[proto.PaneKindShell] = true
		case proto.PaneKindCodex:
			out[proto.PaneKindCodex] = true
		}
	}
	if len(out) == 0 {
		out[proto.PaneKindClaude] = true
	}
	return out
}

// handleDismissSessions clears was_live on a batch of session IDs in
// one project. Used by the Satellite's "Skip" action on the restore
// prompt so subsequent reconnects don't re-prompt for the same ones.
func (s *Server) handleDismissSessions(w nethttp.ResponseWriter, r *nethttp.Request) {
	id := chi.URLParam(r, "id")
	if s.rejectSupervisorOutOfScope(w, r, id) {
		return
	}
	if !s.Manager.ProjectExists(id) {
		nethttp.Error(w, "project not found", nethttp.StatusNotFound)
		return
	}
	store := s.Manager.Sessions()
	if store == nil {
		writeJSON(w, proto.DismissSessionsResponse{Dismissed: 0})
		return
	}
	var req proto.DismissSessionsRequest
	if err := decodeJSONBody(w, r, maxJSONBody, &req); err != nil {
		return
	}
	count := 0
	for _, sid := range req.SessionIDs {
		if err := store.SetLive(id, sid, false); err != nil {
			slog.Warn("dismiss: set_live failed", "err", err, "project", id, "session", sid)
			continue
		}
		count++
	}
	writeJSON(w, proto.DismissSessionsResponse{Dismissed: count})
}

func (s *Server) handleDeletePane(w nethttp.ResponseWriter, r *nethttp.Request) {
	id := chi.URLParam(r, "id")
	paneID := chi.URLParam(r, "pane_id")
	if s.rejectSupervisorOutOfScope(w, r, id) {
		return
	}
	if err := s.Manager.DeletePane(id, paneID); err != nil {
		nethttp.Error(w, err.Error(), nethttp.StatusNotFound)
		return
	}
	writeJSON(w, proto.DeletePaneResponse{Ok: true})
}

func (s *Server) handleCreateProject(w nethttp.ResponseWriter, r *nethttp.Request) {
	// Project creation is a main-actor-only operation — the supervisor
	// can observe and dispatch within docked projects but never register
	// new ones.
	if ActorFromRequest(r) == "supervisor" {
		nethttp.Error(w, "forbidden: supervisor cannot create projects", nethttp.StatusForbidden)
		return
	}
	var req proto.AddProjectRequest
	if err := decodeJSONBody(w, r, maxJSONBody, &req); err != nil {
		return
	}
	if req.Name == "" {
		nethttp.Error(w, "name is required", nethttp.StatusBadRequest)
		return
	}
	// Validate caller-supplied IDs against the same regex + length cap
	// that Load() applies on startup. Without this, a client could create
	// a project that persists to TOML successfully in the running
	// process but is silently dropped as invalid on the next daemon
	// restart. Derived IDs (req.ID == "") are already bounded by
	// DeriveID / SlugifyUnique downstream.
	if req.ID != "" {
		if err := config.ValidateProjectID(req.ID); err != nil {
			nethttp.Error(w, err.Error(), nethttp.StatusBadRequest)
			return
		}
	}
	proj, err := s.Manager.AddProject(req)
	if err != nil {
		nethttp.Error(w, err.Error(), nethttp.StatusBadRequest)
		return
	}
	writeJSON(w, proto.AddProjectResponse{Project: proto.Project{
		ID:             proj.ID,
		Name:           proj.Name,
		Cwd:            proj.Cwd,
		Stoplight:      proto.StoplightGray,
		PaneCount:      0,
		PaneStoplights: []proto.Stoplight{},
		PaneIDs:        []string{},
		// AddProject validates cwd before persisting, so the freshly
		// registered project is always available at this point.
		Available: true,
	}})
}

func (s *Server) handleDeleteProject(w nethttp.ResponseWriter, r *nethttp.Request) {
	// Mirror handleCreateProject: deletions belong to the human operator,
	// not the supervisor. Reject before resolving id so a supervisor
	// token can't enumerate project existence via 4xx codes.
	if ActorFromRequest(r) == "supervisor" {
		nethttp.Error(w, "forbidden: supervisor cannot delete projects", nethttp.StatusForbidden)
		return
	}
	id := chi.URLParam(r, "id")
	if err := s.Manager.RemoveProject(id); err != nil {
		nethttp.Error(w, err.Error(), nethttp.StatusNotFound)
		return
	}
	writeJSON(w, proto.DeletePaneResponse{Ok: true})
}

func (s *Server) handleDockProject(w nethttp.ResponseWriter, r *nethttp.Request) {
	// Docking grants the supervisor access to a project. Letting the
	// supervisor dock arbitrary projects would be a self-escalation: it
	// could widen its own reach without the human's consent. Keep this
	// capability on the main actor only.
	if ActorFromRequest(r) == "supervisor" {
		nethttp.Error(w, "forbidden: supervisor cannot dock projects", nethttp.StatusForbidden)
		return
	}
	id := chi.URLParam(r, "id")
	if err := s.Manager.SetDocked(id, true); err != nil {
		nethttp.Error(w, err.Error(), nethttp.StatusNotFound)
		return
	}
	if s.MC != nil {
		s.MC.NotifyStateChanged()
	}
	writeJSON(w, proto.DockProjectResponse{Docked: true})
}

// handleRenameProject sets (or clears, on empty string) the user-given
// display_name override for a project. The supervisor can't rename —
// label mutation is a human-operator concern and out of its scope, same
// rationale as dock/undock.
func (s *Server) handleRenameProject(w nethttp.ResponseWriter, r *nethttp.Request) {
	if ActorFromRequest(r) == "supervisor" {
		nethttp.Error(w, "forbidden: supervisor cannot rename projects", nethttp.StatusForbidden)
		return
	}
	id := chi.URLParam(r, "id")
	var req proto.RenameRequest
	if err := decodeJSONBody(w, r, maxJSONBody, &req); err != nil {
		return
	}
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if len(req.DisplayName) > 128 {
		nethttp.Error(w, "display_name too long", nethttp.StatusBadRequest)
		return
	}
	if err := s.Manager.SetProjectDisplayName(id, req.DisplayName); err != nil {
		nethttp.Error(w, err.Error(), nethttp.StatusNotFound)
		return
	}
	if s.MC != nil {
		s.MC.NotifyStateChanged()
	}
	writeJSON(w, proto.RenameRequest{DisplayName: req.DisplayName})
}

// handleRenamePane sets (or clears) the user-given display_name override
// for a single pane. Only claude panes (those with a session_id) are
// renameable — shell panes have no persistent identity to key against,
// so they reject with 400. Same supervisor restriction as the project
// variant.
func (s *Server) handleRenamePane(w nethttp.ResponseWriter, r *nethttp.Request) {
	if ActorFromRequest(r) == "supervisor" {
		nethttp.Error(w, "forbidden: supervisor cannot rename panes", nethttp.StatusForbidden)
		return
	}
	projectID := chi.URLParam(r, "id")
	paneID := chi.URLParam(r, "pane_id")
	var req proto.RenameRequest
	if err := decodeJSONBody(w, r, maxJSONBody, &req); err != nil {
		return
	}
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if len(req.DisplayName) > 128 {
		nethttp.Error(w, "display_name too long", nethttp.StatusBadRequest)
		return
	}
	if err := s.Manager.SetPaneDisplayName(projectID, paneID, req.DisplayName); err != nil {
		nethttp.Error(w, err.Error(), nethttp.StatusBadRequest)
		return
	}
	if s.MC != nil {
		s.MC.NotifyStateChanged()
	}
	writeJSON(w, proto.RenameRequest{DisplayName: req.DisplayName})
}

func (s *Server) handleUndockProject(w nethttp.ResponseWriter, r *nethttp.Request) {
	// Symmetric with dock: only the main actor can change the scope the
	// supervisor operates within.
	if ActorFromRequest(r) == "supervisor" {
		nethttp.Error(w, "forbidden: supervisor cannot undock projects", nethttp.StatusForbidden)
		return
	}
	id := chi.URLParam(r, "id")
	if err := s.Manager.SetDocked(id, false); err != nil {
		nethttp.Error(w, err.Error(), nethttp.StatusNotFound)
		return
	}
	if s.MC != nil {
		s.MC.NotifyStateChanged()
	}
	writeJSON(w, proto.DockProjectResponse{Docked: false})
}

// handleArchiveProject puts a project to sleep — kills its panes to free RAM
// while keeping its session rows was_live so it can be restored later. Same
// supervisor restriction as dock: putting a project to sleep is a
// human-operator concern, and self-archiving would let the supervisor drop
// its own workspace out from under itself.
func (s *Server) handleArchiveProject(w nethttp.ResponseWriter, r *nethttp.Request) {
	if ActorFromRequest(r) == "supervisor" {
		nethttp.Error(w, "forbidden: supervisor cannot archive projects", nethttp.StatusForbidden)
		return
	}
	id := chi.URLParam(r, "id")
	if err := s.Manager.ArchiveProject(id); err != nil {
		nethttp.Error(w, err.Error(), nethttp.StatusNotFound)
		return
	}
	if s.MC != nil {
		s.MC.NotifyStateChanged()
	}
	writeJSON(w, proto.ArchiveProjectResponse{Archived: true})
}

// handleUnarchiveProject wakes an archived project — clears the flag and
// respawns exactly the panes that were live. cols/rows are left at 0 (the
// sessions store default-sizes the PTYs; the client re-fits on attach, same
// as the boot restore path). Symmetric supervisor restriction with archive.
func (s *Server) handleUnarchiveProject(w nethttp.ResponseWriter, r *nethttp.Request) {
	if ActorFromRequest(r) == "supervisor" {
		nethttp.Error(w, "forbidden: supervisor cannot unarchive projects", nethttp.StatusForbidden)
		return
	}
	id := chi.URLParam(r, "id")
	if err := s.Manager.UnarchiveProject(id, 0, 0); err != nil {
		nethttp.Error(w, err.Error(), nethttp.StatusNotFound)
		return
	}
	if s.MC != nil {
		s.MC.NotifyStateChanged()
	}
	writeJSON(w, proto.ArchiveProjectResponse{Archived: false})
}

func (s *Server) handleWS(w nethttp.ResponseWriter, r *nethttp.Request) {
	id := chi.URLParam(r, "id")
	paneID := chi.URLParam(r, "pane_id")
	if s.rejectSupervisorOutOfScope(w, r, id) {
		return
	}
	// Origin allowlist: reject browser-initiated cross-site WS upgrades
	// (CSWSH). Non-browser clients (satellite, curl, go) omit the header
	// or send something we explicitly allow.
	if !originAllowed(r) {
		nethttp.Error(w, "forbidden origin", nethttp.StatusForbidden)
		return
	}
	ctx := r.Context()
	ctx = context.WithValue(ctx, ws.CtxProjectID, id)
	ctx = context.WithValue(ctx, ws.CtxPaneID, paneID)
	// Forward the bearer subprotocol (if any) so ws.Handler can echo it
	// in the 101 response. Without this, browsers offering the
	// reck-bearer.<token> subprotocol see a subprotocol-mismatch close.
	if sp := WSSubprotocolFromRequest(r); sp != "" {
		ctx = context.WithValue(ctx, ws.CtxWSSubprotocol, sp)
	}
	s.WS.Serve(w, r.WithContext(ctx))
}

// originAllowed reports whether a request's Origin header is acceptable
// for a WebSocket upgrade. Rules:
//
//   - Missing Origin: allowed (native clients — satellite, curl, go).
//   - Origin host matches the request's Host: allowed (same-origin).
//   - Origin host is 127.0.0.1 / localhost / ::1 on any port: allowed
//     (Electron satellite via its loopback loader, dev servers).
//   - Electron / file:// origins ("null", "file://..."): allowed — the
//     packaged satellite renders from the app bundle.
//   - Anything else: rejected. This blocks a malicious webpage from
//     opening a WS to the daemon with the user's token.
func originAllowed(r *nethttp.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	if origin == "null" {
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
	// Same-origin: Origin host matches the Host the request came in on.
	reqHost := r.Host
	if idx := strings.Index(reqHost, ":"); idx >= 0 {
		reqHost = reqHost[:idx]
	}
	if host == reqHost && host != "" {
		return true
	}
	return false
}

// Mission Control handlers — thin shims that delegate to the configured
// MissionControlHandler. All guarded by the MC != nil check at route
// registration time; these methods are only called when MC is set.
//
// Mission Control itself is an operator-facing surface. The supervisor
// agent is the *subject* of Mission Control, not a consumer — it must
// not be able to chat with itself, reset itself, or read its own UI
// stream via its own token.
func (s *Server) handleMCState(w nethttp.ResponseWriter, r *nethttp.Request) {
	// Read-only snapshot — intentionally allowed for the supervisor actor.
	// The supervisor's system prompt directs it to call this endpoint to
	// enumerate docked projects; the same data is reconstructible from
	// /projects + /projects/<id> calls it already has access to, so the
	// ban would only be cosmetic. The write-side endpoints (chat, reset,
	// history, ws) remain supervisor-forbidden below.
	s.MC.ServeState(w, r)
}
func (s *Server) handleMCHistory(w nethttp.ResponseWriter, r *nethttp.Request) {
	if ActorFromRequest(r) == "supervisor" {
		nethttp.Error(w, "forbidden", nethttp.StatusForbidden)
		return
	}
	s.MC.ServeHistory(w, r)
}
func (s *Server) handleMCChat(w nethttp.ResponseWriter, r *nethttp.Request) {
	if ActorFromRequest(r) == "supervisor" {
		nethttp.Error(w, "forbidden", nethttp.StatusForbidden)
		return
	}
	s.MC.ServeChat(w, r)
}
func (s *Server) handleMCReset(w nethttp.ResponseWriter, r *nethttp.Request) {
	if ActorFromRequest(r) == "supervisor" {
		nethttp.Error(w, "forbidden", nethttp.StatusForbidden)
		return
	}
	s.MC.ServeReset(w, r)
}
func (s *Server) handleMCWS(w nethttp.ResponseWriter, r *nethttp.Request) {
	if ActorFromRequest(r) == "supervisor" {
		nethttp.Error(w, "forbidden", nethttp.StatusForbidden)
		return
	}
	s.MC.ServeWS(w, r)
}

func writeJSON(w nethttp.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// Per-handler request-body size caps. Picked per-endpoint based on the
// shape of the JSON the daemon expects. Anything past these bounds is
// almost certainly an attacker — the largest legitimate body the daemon
// reads is the agent-event hook payload (Claude Code attaches a tool I/O
// dump there, capped on the producer side around 1 MiB).
//
//   - maxJSONBody: catch-all for the small, structured POST bodies on
//     create/rename/dismiss endpoints. 64 KiB is several thousand
//     characters of display-name or session-id list, more than any
//     realistic call needs.
//   - maxPaneInputBytes: stdin injection via the supervisor's
//     /panes/:id/input. Capped tight so a runaway agent can't fill a
//     pane's input queue with megabytes of paste.
//   - maxAgentEventBody: as documented above; matches the producer-side
//     cap in the Claude Code lifecycle hook.
const (
	maxJSONBody       = 64 * 1024
	maxPaneInputBytes = 64 * 1024
	maxAgentEventBody = 1 << 20
)

// decodeJSONBody is the router's thin re-export of httpx.DecodeJSONBody.
//
// Kept as a local name so the large number of existing call sites don't
// need to change. The helper delegates to the shared implementation in
// internal/httpx so the router and the supervisor's chat endpoint apply
// identical body-size, trailing-data, and 413-vs-400 policy — one
// source of truth for the decode contract.
func decodeJSONBody(w nethttp.ResponseWriter, r *nethttp.Request, max int64, v any) error {
	return httpx.DecodeJSONBody(w, r, max, v)
}

// handleAgentEvent accepts one lifecycle event from a hook shim running
// inside a pane's child process. Query params:
//
//	?kind=user_prompt|pre_tool|post_tool|stop|notification|session_start|session_end  (required)
//	?agent=claude-code|codex|gemini-cli|...  (required)
//
// Body is the JSON hook payload. Audit fix F4  makes project_id
// REQUIRED inside the body (the shim wires it in from RECK_PROJECT_ID),
// alongside any payload Claude Code attaches.
//
// Auth (F4): the request MUST carry HMAC headers signed with the
// pane's RECK_HOOK_SECRET — see hookauth.go for the full scheme. The
// auth middleware no longer bearer-checks this endpoint; the HMAC is
// the only gate, and it binds the request to the specific pane that
// the daemon spawned. Any local process that did NOT inherit
// RECK_HOOK_SECRET (i.e. anything outside the pane's child tree) is
// rejected here.
//
// Max body size (maxAgentEventBody) bounds memory per event.
func (s *Server) handleAgentEvent(w nethttp.ResponseWriter, r *nethttp.Request) {
	paneID := chi.URLParam(r, "pane_id")
	pane, ok := s.Manager.PaneByID(paneID)
	if !ok {
		nethttp.Error(w, "pane not found", nethttp.StatusNotFound)
		return
	}
	kind := events.Kind(r.URL.Query().Get("kind"))
	if !events.KindValid(kind) {
		nethttp.Error(w, "unknown or missing kind", nethttp.StatusBadRequest)
		return
	}
	agent := r.URL.Query().Get("agent")
	if agent == "" {
		nethttp.Error(w, "agent is required", nethttp.StatusBadRequest)
		return
	}
	// Read the raw body once: the HMAC verification needs the exact
	// bytes that came over the wire (the shim signed them verbatim),
	// and we re-parse the JSON afterwards for project_id + the
	// transparent payload field. Doing JSON-decode-then-re-marshal would
	// re-key the object and break the signature.
	var raw []byte
	if r.ContentLength != 0 && r.Body != nil {
		// MaxBytesReader surfaces oversize as http.MaxBytesError so we
		// can respond 413; io.LimitReader would silently truncate the
		// payload instead. +1 so the EOF at exactly maxAgentEventBody
		// bytes is the expected condition, not an overflow.
		r.Body = nethttp.MaxBytesReader(w, r.Body, maxAgentEventBody+1)
		var err error
		raw, err = io.ReadAll(r.Body)
		if err != nil {
			var maxErr *nethttp.MaxBytesError
			if errors.As(err, &maxErr) {
				nethttp.Error(w, "agent event body too large", nethttp.StatusRequestEntityTooLarge)
				return
			}
			nethttp.Error(w, "read body: "+err.Error(), nethttp.StatusBadRequest)
			return
		}
		if len(raw) > maxAgentEventBody {
			nethttp.Error(w, "agent event body too large", nethttp.StatusRequestEntityTooLarge)
			return
		}
	}

	// Audit fix F4 : per-pane HMAC + nonce check. Done BEFORE
	// any further body parsing so an unsigned/replayed/tampered call
	// can't burn JSON-decode CPU or touch the pane's event log.
	hookErr := VerifyHookSignature(
		s.hookNonceStore(),
		pane.HookSecret,
		r.Method,
		r.URL.Path,
		raw,
		r.Header.Get(HookAuthHeaderSig),
		r.Header.Get(HookAuthHeaderTs),
		r.Header.Get(HookAuthHeaderNonce),
	)
	if hookErr != nil {
		var hae *HookAuthError
		if errors.As(hookErr, &hae) {
			slog.Info("agent-event: hook auth rejected",
				"pane", pane.ID, "reason", hae.Reason, "code", hae.Code)
			nethttp.Error(w, hae.Reason, hae.Code)
			return
		}
		slog.Info("agent-event: hook auth error",
			"pane", pane.ID, "err", hookErr.Error())
		nethttp.Error(w, "hook auth failed", nethttp.StatusUnauthorized)
		return
	}

	// Parse the body for the structural fields we care about
	// (project_id is required; everything else is opaque payload
	// the daemon stores in the event log). Empty body is rejected —
	// project_id is mandatory after F4. Validation order: body
	// presence → JSON validity → project_id required → match pane.
	if len(raw) == 0 {
		nethttp.Error(w, "agent event body required (project_id missing)", nethttp.StatusBadRequest)
		return
	}
	if !json.Valid(raw) {
		nethttp.Error(w, "body must be valid JSON", nethttp.StatusBadRequest)
		return
	}
	var envelope struct {
		ProjectID string `json:"project_id"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		// json.Valid passed above so a structural decode failure
		// here means the top-level isn't an object. Treat as 400.
		nethttp.Error(w, "body must be a JSON object with project_id", nethttp.StatusBadRequest)
		return
	}
	if envelope.ProjectID == "" {
		nethttp.Error(w, "project_id is required in body", nethttp.StatusBadRequest)
		return
	}
	if envelope.ProjectID != pane.ProjectID {
		slog.Info("agent-event: project mismatch",
			"pane", pane.ID, "declared", envelope.ProjectID, "actual", pane.ProjectID)
		nethttp.Error(w, "project mismatch", nethttp.StatusForbidden)
		return
	}
	// Preserve the validated raw payload as the opaque event data.
	data := json.RawMessage(raw)
	ev := events.Event{
		ID:        events.NewID(),
		PaneID:    pane.ID,
		ProjectID: pane.ProjectID,
		Agent:     agent,
		Kind:      kind,
		At:        time.Now().UTC(),
		Data:      data,
	}
	pane.RecordEvent(ev)
	slog.Info("agent-event",
		"pane", pane.ID,
		"kind", kind,
		"agent", agent,
		"state", pane.AgentState(),
		"data_bytes", len(data),
	)
	writeJSON(w, map[string]any{"ok": true, "event_id": ev.ID})
}

// handlePaneEvents returns the recent events recorded for a pane. Useful
// for debugging hook wiring during dogfood.
func (s *Server) handlePaneEvents(w nethttp.ResponseWriter, r *nethttp.Request) {
	paneID := chi.URLParam(r, "pane_id")
	if s.rejectSupervisorPaneOutOfScope(w, r, paneID) {
		return
	}
	pane, ok := s.Manager.PaneByID(paneID)
	if !ok {
		nethttp.Error(w, "pane not found", nethttp.StatusNotFound)
		return
	}
	snap := pane.EventLog().Snapshot()
	writeJSON(w, map[string]any{
		"pane_id":     pane.ID,
		"agent_state": pane.AgentState(),
		"count":       len(snap),
		"events":      snap,
	})
}

// paneInputRequest is the body of POST /panes/:pane_id/input. Used by
// the Mission Control supervisor (via its Bash tool + curl) to inject
// text into another pane's stdin.
//
// Text is written verbatim. Submit=true appends CR so the receiving
// agent processes the line. Submit=false leaves it queued; the user has
// to press Enter themselves — this is the safer default when the
// supervisor doesn't want to clobber an in-progress turn.
type paneInputRequest struct {
	Text   string `json:"text"`
	Submit bool   `json:"submit,omitempty"`
}

func (s *Server) handlePaneInput(w nethttp.ResponseWriter, r *nethttp.Request) {
	paneID := chi.URLParam(r, "pane_id")
	if s.rejectSupervisorPaneOutOfScope(w, r, paneID) {
		return
	}
	pane, ok := s.Manager.PaneByID(paneID)
	if !ok {
		nethttp.Error(w, "pane not found", nethttp.StatusNotFound)
		return
	}
	actor := ActorFromRequest(r)
	// Audit supervisor-initiated stdin injection. Regular main-actor
	// writes (the human via the satellite) are not logged — this is the
	// accountability trail for the agent-driven writes.
	if actor == "supervisor" {
		slog.Info("supervisor pane-input",
			"pane", paneID, "project", pane.ProjectID)
	}
	var req paneInputRequest
	if err := decodeJSONBody(w, r, maxPaneInputBytes, &req); err != nil {
		return
	}
	if req.Text == "" && !req.Submit {
		nethttp.Error(w, "empty input", nethttp.StatusBadRequest)
		return
	}
	// an audit finding: filter ASCII control bytes on the
	// supervisor-actor path only. Indirect prompt-injection in pages
	// the supervisor agent reads can otherwise cause it to type
	// 0x03 (SIGINT) into a sibling docked pane, or smuggle ANSI
	// escape sequences (0x1b) that the receiving terminal interprets
	// as cursor / colour / OSC commands. The filter mirrors the one
	// /mission-control/chat already applies (see supervisor.firstControlByte):
	// reject any control byte < 0x20 except \t / \n / \r, plus DEL
	// (0x7f).
	//
	// Main-actor calls (renderer / user keystrokes) MUST stay
	// unfiltered — interactive use legitimately needs all control
	// bytes (Ctrl-C, arrow keys, escape sequences for vim, etc.).
	if actor == "supervisor" {
		if offender, bad := firstControlByte(req.Text); bad {
			slog.Info("supervisor pane-input rejected control byte",
				"pane", paneID, "project", pane.ProjectID, "byte", int(offender))
			nethttp.Error(w, "input contains control characters", nethttp.StatusBadRequest)
			return
		}
	}
	payload := req.Text
	if req.Submit {
		payload += "\r"
	}
	if err := pane.Write([]byte(payload)); err != nil {
		nethttp.Error(w, err.Error(), nethttp.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "bytes": len(payload)})
}

// firstControlByte scans for ASCII control bytes (< 0x20) that are NOT
// tab / LF / CR. Reports the offending byte and true if found, or 0 +
// false when clean. UTF-8 continuation bytes are >= 0x80 so the
// <0x20 check is safe on arbitrary-encoded input.
//
// Mirrors supervisor.firstControlByte (daemon/internal/supervisor/http.go);
// duplicated here so the http package doesn't need to import the
// supervisor package (which would create a cycle — supervisor imports
// pty/manager which the http package also reaches through Server).
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

// handlePaneOutput returns the tail of a pane's replay buffer so the
// supervisor can inspect recent activity without opening a WebSocket.
// `bytes` query param is the approximate byte count to return (default 8192).
func (s *Server) handlePaneOutput(w nethttp.ResponseWriter, r *nethttp.Request) {
	paneID := chi.URLParam(r, "pane_id")
	if s.rejectSupervisorPaneOutOfScope(w, r, paneID) {
		return
	}
	pane, ok := s.Manager.PaneByID(paneID)
	if !ok {
		nethttp.Error(w, "pane not found", nethttp.StatusNotFound)
		return
	}
	n := 8192
	if v := r.URL.Query().Get("bytes"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 && parsed <= 128*1024 {
			n = parsed
		}
	}
	tail := pane.ReplayTail(n)
	writeJSON(w, map[string]any{
		"pane_id":     pane.ID,
		"agent_state": pane.AgentState(),
		"bytes":       len(tail),
		"text":        string(tail),
	})
}
