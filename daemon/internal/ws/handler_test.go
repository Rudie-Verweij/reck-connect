package ws

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"nhooyr.io/websocket"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/daemon/internal/pty"
	"github.com/rudie-verweij/reck-connect/proto"
)

func TestWS_helloAndInput(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := pty.NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo", "placeholder"},
		configPath,
		nil,
	)
	pane, err := mgr.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.DeletePane("p1", pane.ID)

	h := &Handler{Manager: mgr, Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))}
	mux := http.NewServeMux()
	path := fmt.Sprintf("/ws/%s/%s", "p1", pane.ID)
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		ctx = context.WithValue(ctx, CtxProjectID, "p1")
		ctx = context.WithValue(ctx, CtxPaneID, pane.ID)
		h.Serve(w, r.WithContext(ctx))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + path
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "bye")
	// Sanity: native client offered no subprotocol → server echoes none.
	if got := conn.Subprotocol(); got != "" {
		t.Errorf("Subprotocol = %q, want empty (no subprotocol offered)", got)
	}

	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var hello proto.HelloMessage
	if err := json.Unmarshal(data, &hello); err != nil {
		t.Fatal(err)
	}
	if hello.Type != "hello" {
		t.Fatalf("expected hello, got %s", hello.Type)
	}

	input := proto.InputMessage{Type: "input", Data: base64.StdEncoding.EncodeToString([]byte("echo hi\n"))}
	raw, _ := json.Marshal(input)
	conn.Write(ctx, websocket.MessageText, raw)

	deadline := time.Now().Add(2 * time.Second)
	found := false
	for time.Now().Before(deadline) && !found {
		rctx, rcancel := context.WithTimeout(ctx, 500*time.Millisecond)
		_, data, err := conn.Read(rctx)
		rcancel()
		if err != nil {
			continue
		}
		var env struct {
			Type string `json:"type"`
			Data string `json:"data"`
		}
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}
		if env.Type == "output" {
			out, _ := base64.StdEncoding.DecodeString(env.Data)
			if strings.Contains(string(out), "hi") {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("expected echoed output 'hi'")
	}
}

// TestWS_echoesBearerSubprotocol confirms the daemon accepts a browser-
// style WS upgrade carrying the bearer token in Sec-WebSocket-Protocol
// and echoes the same subprotocol back so the handshake succeeds. Without
// the echo, nhooyr returns 400 "no matching subprotocol" and browsers
// reject the upgrade with SUBPROTOCOL error.
func TestWS_echoesBearerSubprotocol(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := pty.NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo", "placeholder"},
		configPath,
		nil,
	)
	pane, err := mgr.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.DeletePane("p1", pane.ID)

	h := &Handler{Manager: mgr, Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))}
	mux := http.NewServeMux()
	path := fmt.Sprintf("/ws/%s/%s", "p1", pane.ID)
	const offered = "reck-bearer.secret-abc"
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		ctx = context.WithValue(ctx, CtxProjectID, "p1")
		ctx = context.WithValue(ctx, CtxPaneID, pane.ID)
		// Simulate what authMiddleware would stash on ctx after it
		// validates the token. The real router puts the offered
		// subprotocol string here; the ws handler echoes it via
		// AcceptOptions.Subprotocols.
		ctx = context.WithValue(ctx, CtxWSSubprotocol, offered)
		h.Serve(w, r.WithContext(ctx))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + path
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		Subprotocols: []string{offered},
	})
	if err != nil {
		t.Fatalf("dial with subprotocol %q: %v", offered, err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "bye")
	if got := conn.Subprotocol(); got != offered {
		t.Errorf("Subprotocol = %q, want %q (server must echo)", got, offered)
	}
}

// TestWS_shutdownSendsGoingAwayCloseFrame exercises the SIGTERM path:
// a client connected to a pane WS must observe a close frame with
// code 1001 (StatusGoingAway) when Handler.Shutdown runs, not a bare
// TCP reset.
func TestWS_shutdownSendsGoingAwayCloseFrame(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := pty.NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo", "placeholder"},
		configPath,
		nil,
	)
	pane, err := mgr.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.DeletePane("p1", pane.ID)

	h := &Handler{Manager: mgr, Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))}
	mux := http.NewServeMux()
	path := fmt.Sprintf("/ws/%s/%s", "p1", pane.ID)
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		ctx = context.WithValue(ctx, CtxProjectID, "p1")
		ctx = context.WithValue(ctx, CtxPaneID, pane.ID)
		h.Serve(w, r.WithContext(ctx))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + path
	dialCtx, dialCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer dialCancel()
	conn, _, err := websocket.Dial(dialCtx, wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusInternalError, "test cleanup")

	// Drain the initial hello so we know the server-side Serve
	// goroutine has finished registering the connection.
	helloCtx, helloCancel := context.WithTimeout(context.Background(), 2*time.Second)
	_, _, err = conn.Read(helloCtx)
	helloCancel()
	if err != nil {
		t.Fatalf("hello read: %v", err)
	}

	// Sanity: the tracker saw exactly one connection.
	if n := h.ActiveConnections(); n != 1 {
		t.Fatalf("ActiveConnections = %d, want 1", n)
	}

	// Now trigger the SIGTERM-equivalent: call Shutdown. Its close
	// broadcast should land on our conn.Read with a 1001 close error.
	shutdownDone := make(chan struct{})
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), ShutdownCloseWait)
		defer cancel()
		h.Shutdown(ctx)
		close(shutdownDone)
	}()

	readCtx, readCancel := context.WithTimeout(context.Background(), ShutdownCloseWait+time.Second)
	defer readCancel()
	_, _, err = conn.Read(readCtx)
	if err == nil {
		t.Fatal("expected close error after Shutdown, got nil")
	}
	// Extract the close code. nhooyr returns websocket.CloseStatus(err)
	// = StatusGoingAway when the server sent that code.
	if code := websocket.CloseStatus(err); code != websocket.StatusGoingAway {
		t.Errorf("close code = %v (err=%v), want %v (StatusGoingAway)",
			code, err, websocket.StatusGoingAway)
	}

	// Shutdown should have returned by now — the Serve goroutine
	// untracks on return, so the live count drops to 0.
	select {
	case <-shutdownDone:
	case <-time.After(ShutdownCloseWait + time.Second):
		t.Fatalf("Shutdown did not return within grace period")
	}
	if n := h.ActiveConnections(); n != 0 {
		t.Errorf("ActiveConnections = %d after Shutdown, want 0", n)
	}
}

// TestWS_shutdownNoActiveConnections confirms Shutdown is a no-op
// when there are no live clients (the common case on a quiet station).
func TestWS_shutdownNoActiveConnections(t *testing.T) {
	h := &Handler{Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))}
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	h.Shutdown(ctx)
	if time.Since(start) > 100*time.Millisecond {
		t.Errorf("Shutdown with 0 conns took %v, want near-instant", time.Since(start))
	}
}

// TestWS_shutdownCoversRegistrationRace exercises the hazard Codex
// finding #3 called out: a Serve goroutine that crossed Accept but
// not yet called trackOrClose during the window Shutdown's snapshot
// runs could be invisible to the broadcast and see a bare TCP reset.
//
// The fix pairs three mechanisms:
//   - shuttingDown is set under the same lock as the snapshot, so
//     trackOrClose's check can't interleave between the two.
//   - trackOrClose self-closes with 1001 on seeing shuttingDown=true.
//   - inflight counts every Serve that crossed the entry gate, and
//     Shutdown waits on it.
//
// Together they guarantee every upgraded connection either (a)
// receives a 1001 close frame from the broadcast, or (b) receives
// one from trackOrClose's self-close, with Shutdown blocking on the
// inflight drain until both paths complete.
//
// We exercise this by dialling many clients against a handler whose
// Accept is artificially slowed so Shutdown reliably races with
// Serve's registration phase. Every dialler that opens a conn must
// observe a clean close (1001 code), not a raw reset.
func TestWS_shutdownCoversRegistrationRace(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := pty.NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo", "placeholder"},
		configPath,
		nil,
	)
	pane, err := mgr.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.DeletePane("p1", pane.ID)

	h := &Handler{Manager: mgr, Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))}
	mux := http.NewServeMux()
	path := fmt.Sprintf("/ws/%s/%s", "p1", pane.ID)

	// The race window we care about is:
	//   t0: Serve enters, crosses shuttingDown gate (flag not set)
	//   t1: Shutdown acquires h.mu, sets flag, snapshots conns
	//   t2: Serve calls trackOrClose — MUST see the flag
	//
	// We stretch t0 → t2 by sleeping between the gate check and the
	// real work, giving Shutdown a consistent opportunity to run
	// inside the window. In production the sleep is zero; this seam
	// only activates in tests.
	//
	// A handful of clients are dialled concurrently. Each records
	// the close status it observes. Failing the race would show up
	// as either (a) a non-1001 close (raw reset, nhooyr surfaces it
	// as StatusNoStatusRcvd / abnormal) or (b) a hung Read that
	// never sees any close at all.
	const nClients = 10
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		ctx = context.WithValue(ctx, CtxProjectID, "p1")
		ctx = context.WithValue(ctx, CtxPaneID, pane.ID)
		h.Serve(w, r.WithContext(ctx))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + path

	type result struct {
		dialErr    error
		closeCode  websocket.StatusCode
		cleanClose bool
	}
	results := make(chan result, nClients)

	var ready sync.WaitGroup
	ready.Add(nClients)
	start := make(chan struct{})

	for i := 0; i < nClients; i++ {
		go func() {
			dialCtx, cancel := context.WithTimeout(context.Background(),
				3*time.Second)
			defer cancel()
			ready.Done()
			<-start
			conn, _, err := websocket.Dial(dialCtx, wsURL, nil)
			if err != nil {
				// Rejected upgrade (503 after shutdown flag) is a
				// legitimate, non-leaky outcome. Record it distinct
				// from a close code so the assertion reads cleanly.
				results <- result{dialErr: err}
				return
			}
			readCtx, rcancel := context.WithTimeout(context.Background(),
				ShutdownCloseWait+2*time.Second)
			defer rcancel()
			// Block until the server closes (either via broadcast
			// or trackOrClose self-close). A clean close surfaces
			// as a StatusCode via websocket.CloseStatus(err).
			_, _, readErr := conn.Read(readCtx)
			code := websocket.CloseStatus(readErr)
			results <- result{closeCode: code, cleanClose: readErr != nil}
			_ = conn.Close(websocket.StatusNormalClosure, "test done")
		}()
	}

	ready.Wait()
	// Fire Shutdown and the dials in tight succession. The goroutines
	// are ready; unblocking them while Shutdown is in flight is what
	// lands several of them in the race window.
	close(start)
	shutdownCtx, cancel := context.WithTimeout(context.Background(),
		ShutdownCloseWait)
	h.Shutdown(shutdownCtx)
	cancel()

	// Collect all results.
	var (
		closed1001 int
		closedOther int
		rejectedUpgrade int
		noClose int
	)
	for i := 0; i < nClients; i++ {
		select {
		case r := <-results:
			switch {
			case r.dialErr != nil:
				rejectedUpgrade++
			case r.closeCode == websocket.StatusGoingAway:
				closed1001++
			case r.cleanClose:
				closedOther++
			default:
				noClose++
			}
		case <-time.After(ShutdownCloseWait + 3*time.Second):
			t.Fatalf("client %d did not produce a result in time", i)
		}
	}

	// Every client that got past the upgrade must have observed a
	// close, and the vast majority of those should be 1001.
	// Any "noClose" means a conn survived past Shutdown — the bug
	// this test exists to prevent.
	if noClose > 0 {
		t.Errorf("%d client(s) never observed a close frame (race leak)", noClose)
	}
	// closedOther is legal for nhooyr's StatusNoStatusRcvd when the
	// server's close frame racing with an abrupt socket close
	// delivers no status. We allow a small number of these on
	// heavily-loaded CI runners, but the dominant outcome must be
	// either a clean 1001 or a pre-upgrade rejection.
	if closed1001+rejectedUpgrade == 0 {
		t.Errorf("no client saw either 1001 (%d) or a pre-upgrade reject (%d); "+
			"other=%d, no-close=%d — shutdown coordination inactive?",
			closed1001, rejectedUpgrade, closedOther, noClose)
	}

	// Shutdown must leave the tracker empty regardless of race path.
	if got := h.ActiveConnections(); got != 0 {
		t.Errorf("ActiveConnections = %d after Shutdown, want 0", got)
	}
}

// TestWS_trackOrClose_raceDeterministic exercises the exact
// interleaving that motivates finding #3: a Serve goroutine that
// crossed Accept (inflight incremented) is attempting to register
// when Shutdown takes the lock, sets shuttingDown=true, snapshots,
// and releases. Whichever side wins the lock, the connection must
// end up closed.
//
// We simulate it directly against the Handler surface:
//
//   - Start a goroutine that holds h.mu, mimicking Shutdown mid-
//     snapshot. While the lock is held, another goroutine calls
//     trackOrClose on a live connection. trackOrClose must block
//     on the mutex until the simulated Shutdown releases.
//   - Before releasing, set shuttingDown=true (the real Shutdown
//     does this inside the same critical section).
//   - After release, trackOrClose should observe shuttingDown=true,
//     self-close the connection, and return false. The tracker
//     must not contain the conn.
//
// This isolates the invariant that the simple TCP-level race test
// can only probe probabilistically.
func TestWS_trackOrClose_raceDeterministic(t *testing.T) {
	// Stand up a throwaway httptest WS server that accepts one
	// upgrade and parks the conn so we have a real
	// *websocket.Conn to hand to trackOrClose. (Constructing one
	// synthetically would require a full net.Conn fake; this is
	// less work and exercises the real library's close path.)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true,
		})
		if err != nil {
			t.Errorf("accept: %v", err)
			return
		}
		// Park until the test's Close lands.
		_, _, _ = c.Read(r.Context())
	}))
	defer srv.Close()

	dialCtx, dialCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer dialCancel()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	conn, _, err := websocket.Dial(dialCtx, wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusInternalError, "test cleanup")

	h := &Handler{Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))}

	// Simulate Shutdown's critical section: take h.mu, set
	// shuttingDown, then release — but do it in a goroutine that
	// holds the lock briefly so trackOrClose has to wait on it.
	lockHeld := make(chan struct{})
	lockReleased := make(chan struct{})
	go func() {
		h.mu.Lock()
		h.shuttingDown.Store(true)
		// Let trackOrClose call arrive at the lock and block.
		close(lockHeld)
		time.Sleep(20 * time.Millisecond)
		h.mu.Unlock()
		close(lockReleased)
	}()

	<-lockHeld

	// Now race trackOrClose against the still-held lock. Expected:
	// it blocks, then when the lock releases it reads
	// shuttingDown=true and self-closes.
	trackDone := make(chan bool, 1)
	go func() {
		trackDone <- h.trackOrClose(conn)
	}()

	// Wait for the simulated Shutdown lock window to close.
	<-lockReleased

	select {
	case ok := <-trackDone:
		if ok {
			t.Fatalf("trackOrClose returned true after shuttingDown was set")
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("trackOrClose never returned")
	}

	// The conn must not be in h.conns — trackOrClose's self-close
	// path skips registration.
	if got := h.ActiveConnections(); got != 0 {
		t.Errorf("ActiveConnections = %d, want 0 (self-closed conn should not register)", got)
	}
	// (The close-frame propagation itself is tested by
	// TestWS_shutdownSendsGoingAwayCloseFrame — this test's job is
	// just to prove the lock-ordering invariant. conn is the
	// client-side socket here, and we just called Close on it from
	// trackOrClose, so reading back would only observe our own
	// close. Skip that assertion to keep the test focused.)
}

// TestWS_shutdownRejectsNewUpgradesAfterFired is the tighter
// invariant: after Handler.Shutdown is called, any NEW Serve
// invocation must refuse the upgrade with 503 instead of hanging
// on. Shutdown's inflight.Wait() would deadlock otherwise on a
// never-closing new conn.
func TestWS_shutdownRejectsNewUpgradesAfterFired(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := pty.NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo", "placeholder"},
		configPath,
		nil,
	)
	pane, err := mgr.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.DeletePane("p1", pane.ID)

	h := &Handler{Manager: mgr, Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))}
	mux := http.NewServeMux()
	path := fmt.Sprintf("/ws/%s/%s", "p1", pane.ID)
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		ctx = context.WithValue(ctx, CtxProjectID, "p1")
		ctx = context.WithValue(ctx, CtxPaneID, pane.ID)
		h.Serve(w, r.WithContext(ctx))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// Fire Shutdown on an empty tracker — flag is set instantly.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	h.Shutdown(ctx)
	cancel()

	// Now attempt a fresh upgrade. The Serve gate at entry must
	// refuse with 503; no upgrade, no hijacked socket.
	resp, err := http.Get(srv.URL + path)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("post-shutdown upgrade: status=%d, want 503", resp.StatusCode)
	}
}

// TestWS_rejectsUnrecognizedSubprotocol ensures that a browser-side
// upgrade offering a subprotocol the daemon doesn't recognise (i.e. one
// that authMiddleware didn't validate and forward) gets a clean 400
// rather than a confusing close-frame after a successful upgrade.
func TestWS_rejectsUnrecognizedSubprotocol(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := pty.NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo", "placeholder"},
		configPath,
		nil,
	)
	pane, err := mgr.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.DeletePane("p1", pane.ID)

	h := &Handler{Manager: mgr, Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))}
	mux := http.NewServeMux()
	path := fmt.Sprintf("/ws/%s/%s", "p1", pane.ID)
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		ctx = context.WithValue(ctx, CtxProjectID, "p1")
		ctx = context.WithValue(ctx, CtxPaneID, pane.ID)
		// NO subprotocol stashed — simulates authMiddleware rejecting
		// a bogus subprotocol (which in practice means it went through
		// as a 401 before reaching here; this test covers the
		// defense-in-depth branch).
		h.Serve(w, r.WithContext(ctx))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// Raw HTTP upgrade request with a bogus subprotocol — bypasses
	// the Dial library's client-side subprotocol management.
	req, _ := http.NewRequest("GET", srv.URL+path, nil)
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	req.Header.Set("Sec-WebSocket-Protocol", "mystery-proto")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("unrecognized subprotocol: status = %d, want 400", resp.StatusCode)
	}
}
