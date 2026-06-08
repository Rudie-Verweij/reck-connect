// Package ws implements the per-pane WebSocket handler.
package ws

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"nhooyr.io/websocket"

	"github.com/rudie-verweij/reck-connect/daemon/internal/events"
	"github.com/rudie-verweij/reck-connect/daemon/internal/pty"
	"github.com/rudie-verweij/reck-connect/proto"
)

const pingInterval = 30 * time.Second
const writeTimeout = 5 * time.Second

// ShutdownCloseWait is the bound on how long Shutdown waits for active
// WS clients to observe the going-away close frame and drain before
// the daemon proceeds to kill pane processes. Picked short enough that
// SIGTERM→exit stays well under launchd's default 20s kill timeout but
// long enough that a typical round-trip observes the close.
const ShutdownCloseWait = 2 * time.Second

// Handler handles upgrades for /ws/:project_id/:pane_id.
//
// The zero value is ready-to-use once Manager + Logger are assigned.
// Active connections are tracked so the daemon's shutdown path can
// send a StatusGoingAway close frame to every client before pane
// teardown begins (instead of letting them see a bare socket reset).
//
// Shutdown coordination spans two mechanisms:
//
//   - conns is the map of fully-registered connections. Shutdown
//     snapshots it, broadcasts the 1001 close frame, and waits for
//     the Serve goroutines to deregister.
//   - shuttingDown + inflight close the registration race: a Serve
//     goroutine that crossed websocket.Accept just before Shutdown
//     snapshotted would otherwise be invisible to the broadcast.
//     Every Serve increments inflight on entry and decrements on
//     exit; Shutdown sets shuttingDown atomically before the
//     snapshot, then waits on inflight to drain. New Serves that
//     arrive after the flag is set refuse the upgrade immediately
//     with 503 instead of hanging on to a half-open socket.
type Handler struct {
	Manager *pty.Manager
	Logger  *slog.Logger

	mu    sync.Mutex
	conns map[*websocket.Conn]struct{}

	shuttingDown atomic.Bool
	inflight     sync.WaitGroup
}

// ServeHTTP requires the caller (router) to stash projectID + paneID on ctx.
type ctxKey string

const (
	CtxProjectID     ctxKey = "project_id"
	CtxPaneID        ctxKey = "pane_id"
	CtxWSSubprotocol ctxKey = "ws_subprotocol" // bearer subprotocol from authMiddleware; echo via AcceptOptions
)

func (h *Handler) Serve(w http.ResponseWriter, r *http.Request) {
	// Register as in-flight BEFORE doing anything connection-bearing.
	// Shutdown waits on this WaitGroup so a Serve goroutine that's
	// past Accept but hasn't reached h.track() yet still participates
	// in the drain. Also gate new upgrades once Shutdown has fired so
	// we don't spawn a fresh connection while the close broadcast is
	// in flight.
	if h.shuttingDown.Load() {
		http.Error(w, "daemon shutting down", http.StatusServiceUnavailable)
		return
	}
	h.inflight.Add(1)
	defer h.inflight.Done()

	projectID, _ := r.Context().Value(CtxProjectID).(string)
	paneID, _ := r.Context().Value(CtxPaneID).(string)
	pane, ok := h.Manager.GetPane(projectID, paneID)
	if !ok {
		http.Error(w, "pane not found", http.StatusNotFound)
		return
	}
	// The browser-side WebSocket upgrade offers a Sec-WebSocket-Protocol
	// header carrying the bearer (see auth plumbing in
	// internal/http/router.go). The 101 response MUST echo one of the
	// offered subprotocols or the browser aborts the handshake, so we
	// thread the validated subprotocol back through AcceptOptions.
	subprotocol, _ := r.Context().Value(CtxWSSubprotocol).(string)
	accept := &websocket.AcceptOptions{
		// InsecureSkipVerify bypasses nhooyr's same-origin check. The
		// router's handleWS wrapper applies an explicit Origin
		// allowlist before reaching this point (see internal/http
		// router.go originAllowed), so by the time we're here the
		// upgrade is either header-less (native client) or from a
		// vetted origin.
		InsecureSkipVerify: true,
	}
	if subprotocol != "" {
		accept.Subprotocols = []string{subprotocol}
	} else if raw := r.Header.Values("Sec-WebSocket-Protocol"); len(raw) > 0 {
		// Defense in depth: if the client offered a subprotocol but
		// authMiddleware didn't recognise it (e.g. a mistyped header),
		// nhooyr would fail the upgrade with "no matching subprotocol".
		// Surface that as an explicit 400 instead of letting the
		// client see a malformed close frame.
		if anyOffered := strings.Join(raw, ","); strings.TrimSpace(anyOffered) != "" {
			http.Error(w, "unsupported subprotocol", http.StatusBadRequest)
			return
		}
	}
	conn, err := websocket.Accept(w, r, accept)
	if err != nil {
		h.Logger.Error("ws accept failed", "err", err)
		return
	}
	// Track the connection so Shutdown can broadcast a going-away
	// close frame to every live client on SIGTERM. The map is
	// insert/delete-only under h.mu; iteration happens exclusively
	// from Shutdown, which takes its own snapshot under the same
	// lock. Registering here (post-Accept) means clients that fail
	// the upgrade never enter the tracker.
	//
	// Registration is atomic with a shutdown-gate check so a Serve
	// goroutine that crossed Accept while Shutdown was mid-snapshot
	// either (a) lands in h.conns before the snapshot captures it —
	// and thus receives the 1001 close via Shutdown's broadcast — or
	// (b) sees shuttingDown=true after Accept and closes itself
	// immediately. Shutdown's wait-on-inflight ensures both paths
	// complete before the pane-kill loop runs.
	if !h.trackOrClose(conn) {
		return
	}
	defer h.untrack(conn)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer conn.Close(websocket.StatusNormalClosure, "bye")

	output := make(chan []byte, 64)
	status := make(chan proto.Stoplight, 4)
	exit := make(chan int, 1)
	errCh := make(chan string, 1)

	subID, replay, cols, rows, stoplight := pane.Subscribe(output, status, exit, errCh)
	defer pane.Unsubscribe(subID)

	hello := proto.HelloMessage{
		Type:      "hello",
		Replay:    base64.StdEncoding.EncodeToString(replay),
		Cols:      cols,
		Rows:      rows,
		Stoplight: stoplight,
	}
	if err := writeJSON(ctx, conn, hello); err != nil {
		h.Logger.Warn("hello write failed", "err", err)
		return
	}

	// Reader pump
	go h.readPump(ctx, conn, pane, cancel)

	// Writer pump: forward output/status/exit/error
	ping := time.NewTicker(pingInterval)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case data := <-output:
			m := proto.OutputMessage{Type: "output", Data: base64.StdEncoding.EncodeToString(data)}
			if err := writeJSON(ctx, conn, m); err != nil {
				return
			}
		case s := <-status:
			m := proto.StatusMessage{Type: "status", Stoplight: s}
			if err := writeJSON(ctx, conn, m); err != nil {
				return
			}
		case code := <-exit:
			m := proto.ExitMessage{Type: "exit", Code: code}
			_ = writeJSON(ctx, conn, m)
			return
		case msg := <-errCh:
			m := proto.ErrorMessage{Type: "error", Msg: msg}
			_ = writeJSON(ctx, conn, m)
		case <-ping.C:
			pctx, pcancel := context.WithTimeout(ctx, writeTimeout)
			err := conn.Ping(pctx)
			pcancel()
			if err != nil {
				return
			}
		}
	}
}

func (h *Handler) readPump(ctx context.Context, conn *websocket.Conn, pane *pty.Pane, cancel context.CancelFunc) {
	defer cancel()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var env struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}
		switch env.Type {
		case "input":
			var m proto.InputMessage
			if err := json.Unmarshal(data, &m); err != nil {
				continue
			}
			bytes, err := base64.StdEncoding.DecodeString(m.Data)
			if err != nil {
				continue
			}
			_ = pane.Write(bytes)
			// A lone ESC byte sent to a "working" pane is almost always
			// a user interrupt (Escape in Claude Code cancels the current
			// turn). xterm.js sends arrow keys as multi-byte sequences
			// (ESC [ A, etc.) so a single-byte ESC is unambiguous. Claude's
			// own hooks don't fire on interrupts outside a tool call, so
			// this keystroke is often the only signal we get.
			if len(bytes) == 1 && bytes[0] == 0x1b && pane.Kind == proto.PaneKindClaude && pane.AgentState() == proto.AgentStateWorking {
				pane.RecordEvent(events.Event{
					ID:        events.NewID(),
					PaneID:    pane.ID,
					ProjectID: pane.ProjectID,
					Agent:     "user",
					Kind:      events.KindUserInterrupt,
					At:        time.Now().UTC(),
				})
			}
		case "resize":
			var m proto.ResizeMessage
			if err := json.Unmarshal(data, &m); err != nil {
				continue
			}
			_ = pane.Resize(m.Cols, m.Rows)
		}
	}
}

func writeJSON(ctx context.Context, conn *websocket.Conn, v any) error {
	wctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return conn.Write(wctx, websocket.MessageText, data)
}

// trackOrClose registers a live connection or, if Shutdown has already
// fired, closes it with StatusGoingAway and returns false so the
// caller bails out without entering the read/write loop.
//
// The shutdown-gate check is atomic with the map insert under h.mu so
// Shutdown's snapshot-and-flag sequence can't interleave in a way
// that leaves the conn invisible to both sides. Concretely:
//
//   - If Shutdown took the lock first and set shuttingDown=true
//     before we did, we see the flag here and close the conn
//     ourselves — no orphaned socket, no bare reset.
//   - If we took the lock first and inserted into h.conns, the
//     subsequent Shutdown snapshot includes our conn and its
//     broadcast delivers the 1001 frame.
//
// Returns true when the caller should proceed with the normal
// read/write loop; false after a self-close.
func (h *Handler) trackOrClose(c *websocket.Conn) bool {
	h.mu.Lock()
	if h.shuttingDown.Load() {
		h.mu.Unlock()
		_ = c.Close(websocket.StatusGoingAway, "daemon shutting down")
		return false
	}
	if h.conns == nil {
		h.conns = make(map[*websocket.Conn]struct{})
	}
	h.conns[c] = struct{}{}
	h.mu.Unlock()
	return true
}

// untrack removes a connection from the live set. Called from the
// deferred tail of Serve so every path — graceful close, read error,
// context cancel — deregisters exactly once.
func (h *Handler) untrack(c *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.conns, c)
}

// ActiveConnections reports the live-connection count. Exposed for
// tests and operator-facing diagnostics; the daemon doesn't use it at
// runtime.
func (h *Handler) ActiveConnections() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.conns)
}

// Shutdown closes every live WebSocket connection with
// websocket.StatusGoingAway (1001) and waits for clients to drain.
//
// The daemon calls this between httpServer.Shutdown (which blocks new
// upgrades and waits for HTTP handlers to return) and the pane-kill
// loop that terminates PTY children. Without this step, a client
// holding a WS sees a bare TCP reset as the process exits; with it,
// the client sees a proper 1001 close frame and can show a clean
// "daemon is restarting" message to the user instead of a generic
// connection error.
//
// Two hazards close the lifecycle gap between Accept and tracker
// registration:
//
//   - shuttingDown is set under h.mu alongside the snapshot, so
//     a Serve goroutine calling trackOrClose() either inserts into
//     h.conns before the snapshot (and gets the broadcast close) or
//     sees shuttingDown=true and closes itself. No conn slips
//     between the two.
//   - inflight counts every Serve goroutine that crossed the
//     shuttingDown gate at Serve entry. After broadcasting, Shutdown
//     waits for inflight to drain so any goroutine still finishing
//     its own trackOrClose + self-close completes before we return
//     and the pane-kill loop starts.
//
// Shutdown returns when either ctx is cancelled or every tracked
// connection has been deregistered and the inflight WaitGroup has
// drained. Callers should bound ctx with ShutdownCloseWait or similar
// so a stuck client doesn't stall the whole shutdown.
func (h *Handler) Shutdown(ctx context.Context) {
	// Set the flag + take the snapshot under one lock hold so
	// trackOrClose can't interleave between the two. After this
	// critical section, every not-yet-registered Serve goroutine
	// will see shuttingDown=true and self-close instead of joining
	// h.conns; every already-registered conn is in the snapshot.
	h.mu.Lock()
	h.shuttingDown.Store(true)
	snapshot := make([]*websocket.Conn, 0, len(h.conns))
	for c := range h.conns {
		snapshot = append(snapshot, c)
	}
	h.mu.Unlock()
	if h.Logger != nil {
		h.Logger.Info("ws shutdown: broadcasting close",
			"active", len(snapshot))
	}
	// Send close frames in parallel. Each Close is bounded by the WS
	// library's internal timeout (hit-the-wire latency plus a small
	// grace period); we don't need a per-call context.
	var wg sync.WaitGroup
	for _, c := range snapshot {
		wg.Add(1)
		go func(c *websocket.Conn) {
			defer wg.Done()
			_ = c.Close(websocket.StatusGoingAway, "daemon shutting down")
		}(c)
	}
	closed := make(chan struct{})
	go func() {
		wg.Wait()
		close(closed)
	}()
	// Wait for either the close-broadcast goroutines to finish or
	// ctx to fire.
	select {
	case <-closed:
	case <-ctx.Done():
		return
	}
	// Then wait for every Serve goroutine to complete. That includes
	// both the conns in our snapshot (Serve exits when conn.Read
	// errors after the close frame) and any goroutine that was
	// mid-Accept during the snapshot (which trackOrClose will
	// self-close on seeing shuttingDown=true).
	inflightDone := make(chan struct{})
	go func() {
		h.inflight.Wait()
		close(inflightDone)
	}()
	select {
	case <-inflightDone:
		return
	case <-ctx.Done():
		if h.Logger != nil {
			h.mu.Lock()
			remaining := len(h.conns)
			h.mu.Unlock()
			h.Logger.Warn("ws shutdown: grace period expired",
				"still_active", remaining)
		}
		return
	}
}
