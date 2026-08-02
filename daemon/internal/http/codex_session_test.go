package http

import (
	"bytes"
	"encoding/json"
	"log/slog"
	nethttp "net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/daemon/internal/pty"
	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
	"github.com/rudie-verweij/reck-connect/daemon/internal/ws"
	"github.com/rudie-verweij/reck-connect/proto"
)

// newServerWithCodexPane builds a daemon fixture with a live session index
// and a spawned codex pane. The "codex binary" is /bin/cat: it sits there
// holding the PTY open without exiting, which is all the spawn path needs.
func newServerWithCodexPane(t *testing.T) (*Server, *pty.Pane, *sessions.Store) {
	t.Helper()
	ensureTestDaemonToken(t)
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatalf("sessions.NewStore: %v", err)
	}
	mgr := pty.NewManagerFromConfig(pty.ManagerConfig{
		Projects:     []config.Project{{ID: "p1", Name: "P1", Cwd: dir, DefaultPane: "shell", Shell: []string{"/bin/sh"}, Available: true}},
		ClaudeCmd:    []string{"/bin/echo", "placeholder"},
		DefaultShell: []string{"/bin/sh"},
		ConfigPath:   configPath,
		Sessions:     store,
		CodexCmd:     []string{"/bin/cat"},
	})
	s := &Server{
		Manager:   mgr,
		WS:        &ws.Handler{Manager: mgr, Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))},
		StartedAt: time.Now(),
		Version:   "test",
	}
	pane, err := s.Manager.CreatePane("p1", proto.PaneKindCodex, 80, 24)
	if err != nil {
		t.Fatalf("spawn codex pane: %v", err)
	}
	t.Cleanup(func() { _ = s.Manager.DeletePane("p1", pane.ID) })
	return s, pane, store
}

// postAgentEvent signs and sends one hook event exactly as the shim does.
func postAgentEvent(t *testing.T, srvURL string, pane *pty.Pane, query string, body []byte) int {
	t.Helper()
	path := "/panes/" + pane.ID + "/agent-event"
	sig, ts, nonce := signHookRequest(t, pane.HookSecret, "POST", path, body)
	req, err := nethttp.NewRequest("POST", srvURL+path+query, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HookAuthHeaderSig, sig)
	req.Header.Set(HookAuthHeaderTs, ts)
	req.Header.Set(HookAuthHeaderNonce, nonce)
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

// threadIDForPane reads the thread id the daemon persisted for a pane's slot.
func threadIDForPane(t *testing.T, store *sessions.Store, pane *pty.Pane) string {
	t.Helper()
	if pane.SlotID == "" {
		t.Fatal("codex pane has no SlotID; the spawn path must assign one before the child starts")
	}
	e, ok, err := store.Get("p1", pane.SlotID)
	if err != nil {
		t.Fatalf("sessions.Get: %v", err)
	}
	if !ok {
		t.Fatalf("no session row for slot %q — the placeholder upsert must happen before Start", pane.SlotID)
	}
	return e.ThreadID
}

// The thread UUID appears only in codex's SessionStart payload, and it's what
// a later `codex resume` needs. Losing it makes the conversation
// unrecoverable, so the handler must persist it against the pane's row.
func TestAgentEvent_codexSessionStartPersistsThreadID(t *testing.T) {
	s, pane, store := newServerWithCodexPane(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	body := []byte(`{"project_id":"p1","hook_event_name":"SessionStart","session_id":"1f0e-thread-uuid"}`)
	if code := postAgentEvent(t, srv.URL, pane, "?kind=session_start&agent=codex", body); code != 200 {
		t.Fatalf("agent-event status = %d, want 200", code)
	}
	if got := threadIDForPane(t, store, pane); got != "1f0e-thread-uuid" {
		t.Errorf("persisted thread_id = %q, want 1f0e-thread-uuid", got)
	}
}

// A payload without session_id must be accepted as a normal event — the pane
// simply stays unresumable rather than the hook failing.
func TestAgentEvent_codexSessionStartWithoutSessionID(t *testing.T) {
	s, pane, store := newServerWithCodexPane(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	body := []byte(`{"project_id":"p1","hook_event_name":"SessionStart"}`)
	if code := postAgentEvent(t, srv.URL, pane, "?kind=session_start&agent=codex", body); code != 200 {
		t.Fatalf("agent-event status = %d, want 200", code)
	}
	if got := threadIDForPane(t, store, pane); got != "" {
		t.Errorf("thread_id = %q, want empty", got)
	}
}

// Only codex's SessionStart carries a thread; a session_id on some other
// agent's payload must not be written to a codex row.
func TestAgentEvent_nonCodexSessionStartLeavesThreadIDAlone(t *testing.T) {
	s, pane, store := newServerWithCodexPane(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	body := []byte(`{"project_id":"p1","hook_event_name":"SessionStart","session_id":"claude-uuid"}`)
	if code := postAgentEvent(t, srv.URL, pane, "?kind=session_start&agent=claude-code", body); code != 200 {
		t.Fatalf("agent-event status = %d, want 200", code)
	}
	if got := threadIDForPane(t, store, pane); got != "" {
		t.Errorf("thread_id = %q, want empty — only codex hooks report a codex thread", got)
	}
}

// Compaction events are Codex-only additions to the canonical taxonomy; the
// endpoint has to accept them or the shim's POSTs 400 out.
func TestAgentEvent_acceptsCompactionKinds(t *testing.T) {
	s, pane, _ := newServerWithCodexPane(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	for _, kind := range []string{"pre_compact", "post_compact"} {
		body := []byte(`{"project_id":"p1","hook_event_name":"Compact"}`)
		if code := postAgentEvent(t, srv.URL, pane, "?kind="+kind+"&agent=codex", body); code != 200 {
			// Don't also assert the resulting state: a rejected POST records
			// no event, so that would pile a second, misleading failure on
			// top of the real one.
			t.Fatalf("kind=%s: status = %d, want 200", kind, code)
		}
		if got := pane.AgentState(); got != proto.AgentStateWorking {
			t.Errorf("agent state after %s = %s, want working", kind, got)
		}
	}
}

// Codex rows have to reach the sessions list or the resume picker can't offer
// them, and the thread id has to ride along so a client can tell which rows
// are resumable.
func TestSessionsList_includesCodexRowsWithThreadID(t *testing.T) {
	s, pane, _ := newServerWithCodexPane(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	body := []byte(`{"project_id":"p1","hook_event_name":"SessionStart","session_id":"thread-xyz"}`)
	if code := postAgentEvent(t, srv.URL, pane, "?kind=session_start&agent=codex", body); code != 200 {
		t.Fatal("seeding the thread id failed")
	}

	req, _ := nethttp.NewRequest("GET", srv.URL+"/projects/p1/sessions", nil)
	req.Header.Set("Authorization", "Bearer "+testDaemonToken)
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("sessions list status = %d, want 200", resp.StatusCode)
	}
	var out proto.SessionsListResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	for _, si := range out.Sessions {
		if si.Kind == proto.PaneKindCodex && si.SlotID == pane.SlotID {
			if si.ThreadID != "thread-xyz" {
				t.Errorf("codex row thread_id = %q, want thread-xyz", si.ThreadID)
			}
			return
		}
	}
	t.Fatalf("codex row for slot %q missing from the sessions list (%d rows)", pane.SlotID, len(out.Sessions))
}
