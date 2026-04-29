package http

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	nethttp "net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/daemon/internal/pty"
	"github.com/rudie-verweij/reck-connect/daemon/internal/ws"
	"github.com/rudie-verweij/reck-connect/proto"
)

// newServerWithPane reuses newServer(t) (from router_test.go) and
// spawns one shell pane in project "p1" so tests have a pane id to
// exercise against.
func newServerWithPane(t *testing.T) (*Server, *pty.Pane) {
	t.Helper()
	s := newServer(t)
	pane, err := s.Manager.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatalf("spawn pane: %v", err)
	}
	return s, pane
}

// TestAuth_emptyTokenFailsClosed is the F3  regression. Before the
// fix, an unset DAEMON_TOKEN turned every protected route into an
// unauthenticated free-for-all — combined with the router-wide
// Access-Control-Allow-Origin: *, that meant any webpage in the user's
// browser could drive a misconfigured local daemon. The fix is two
// layers:
//
//  1. main.go fatal-exits before serving when no token is resolved
//     (covered manually; the binary smoke is out of scope here).
//  2. authMiddleware fail-closes belt-and-braces with 503 on the same
//     condition. This test pins layer 2 so a future refactor that
//     "forgets" the production guard can't silently re-open the door.
//
// Path mix: protected GET (/projects), protected POST
// (/projects/.../panes), and a loopback agent-event POST. All must
// return 503 — even agent-event, because the F3 fail-closed gate
// fires before any per-endpoint auth carve-out (including F4's
// HMAC-only path for agent-event). A misconfigured daemon refuses
// every request, full stop.
func TestAuth_emptyTokenFailsClosed(t *testing.T) {
	// Force DAEMON_TOKEN empty for this test specifically. newServer's
	// ensureTestDaemonToken would re-stamp it to testDaemonToken if it
	// saw the env var as empty, which would defeat the whole point —
	// so we build the Server fixture inline here, mirroring the body
	// of newServer but skipping the token install. t.Setenv("","") is
	// still required so any previously-stamped value (from a sibling
	// test in the same package) is reverted for this test only.
	t.Setenv("DAEMON_TOKEN", "")
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := pty.NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, DefaultPane: "shell", Shell: []string{"/bin/sh"}, Available: true}},
		[]string{"/bin/echo", "placeholder"},
		configPath,
		nil,
	)
	s := &Server{
		Manager:   mgr,
		WS:        &ws.Handler{Manager: mgr, Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))},
		StartedAt: time.Now(),
		Version:   "test",
	}
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	cases := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{"protected GET", "GET", "/projects", ""},
		{"protected POST", "POST", "/projects", `{"name":"x","cwd":"/tmp"}`},
		{"loopback agent-event without token still 503",
			"POST", "/panes/p_does_not_matter/agent-event?kind=user_prompt&agent=claude-code", `{}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var body io.Reader
			if c.body != "" {
				body = bytes.NewBufferString(c.body)
			}
			req, err := nethttp.NewRequest(c.method, srv.URL+c.path, body)
			if err != nil {
				t.Fatal(err)
			}
			if c.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			resp, err := nethttp.DefaultClient.Do(req)
			if err != nil {
				t.Fatalf("request: %v", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != nethttp.StatusServiceUnavailable {
				got, _ := io.ReadAll(resp.Body)
				t.Errorf("%s: status=%d body=%q want 503",
					c.name, resp.StatusCode, string(got))
			}
		})
	}

	// CORS preflight (OPTIONS) MUST still return its CORS headers
	// without auth. Otherwise browser preflight failures mask the 503
	// the real GET/POST would surface — operators would see a CORS
	// error and chase the wrong tail.
	t.Run("CORS preflight bypasses fail-closed", func(t *testing.T) {
		req, _ := nethttp.NewRequest("OPTIONS", srv.URL+"/projects", nil)
		req.Header.Set("Origin", "http://localhost:5173")
		req.Header.Set("Access-Control-Request-Method", "GET")
		resp, err := nethttp.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("preflight: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != nethttp.StatusNoContent {
			t.Errorf("preflight status=%d want 204", resp.StatusCode)
		}
		if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "*" {
			t.Errorf("preflight Access-Control-Allow-Origin=%q want *", got)
		}
	})
}

// TestAuth_rejectsMismatchedToken is a baseline — wrong bearer fails.
// The win is that we now use constant-time compare so the same byte-
// length mismatch no longer times differently than a byte-content
// mismatch. We can't meaningfully measure that in unit tests, but we
// can at least confirm the rejection still fires.
func TestAuth_rejectsMismatchedToken(t *testing.T) {
	t.Setenv("DAEMON_TOKEN", "expected-token-long-enough-to-matter")
	// Bypass newTestHandler so the "" and "Bearer wrong" cases reach the
	// real authMiddleware unchanged.
	srv := httptest.NewServer(newServer(t).Router())
	defer srv.Close()

	for _, bad := range []string{
		"",
		"Bearer",
		"Bearer wrong",
		"Bearer expected-token-long-enough-to-matte",  // len-1 prefix
		"bearer expected-token-long-enough-to-matter", // wrong case
	} {
		req, _ := nethttp.NewRequest("GET", srv.URL+"/projects", nil)
		if bad != "" {
			req.Header.Set("Authorization", bad)
		}
		resp, err := nethttp.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("req %q: %v", bad, err)
		}
		resp.Body.Close()
		if resp.StatusCode != nethttp.StatusUnauthorized {
			t.Errorf("bad auth %q: status=%d, want 401", bad, resp.StatusCode)
		}
	}
}

// TestOriginAllowlist covers the Origin check wired into handleWS. The
// real WS upgrade needs a client we don't ship in this package — so we
// exercise originAllowed directly, then spot-check the HTTP route
// rejects a cross-site Origin before reaching the upgrade.
func TestOriginAllowed_unitTable(t *testing.T) {
	cases := []struct {
		origin  string
		host    string
		allowed bool
	}{
		{"", "station.local:7315", true},                          // no Origin = native client
		{"null", "station.local:7315", true},                      // sandboxed iframe / file://
		{"file:///Users/x/app", "station.local:7315", true},       // electron packaged
		{"http://127.0.0.1:5173", "station.local:7315", true},     // dev satellite
		{"http://localhost:7315", "station.local:7315", true},     // localhost always OK
		{"http://[::1]:7315", "station.local:7315", true},         // ipv6 loopback
		{"http://station.local:7315", "station.local:7315", true}, // same host as request
		{"http://station.local:8080", "station.local:7315", true}, // same host, different port → still allowed
		{"http://evil.example:7315", "station.local:7315", false}, // cross-site CSWSH
		{"http://attacker", "station.local:7315", false},          // cross-site
		{"not a url", "station.local:7315", false},                // malformed
		{"https://evil.example", "station.local:7315", false},     // https attacker
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "http://"+c.host+"/ws/p/p", nil)
		r.Host = c.host
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		got := originAllowed(r)
		if got != c.allowed {
			t.Errorf("originAllowed(Origin=%q, Host=%q) = %v, want %v", c.origin, c.host, got, c.allowed)
		}
	}
}

// TestAgentEvent_projectIDBinding (pre-F4) was a defense-in-depth
// query-param check that prevented loopback callers from forging
// events for arbitrary panes. After F4  the query-param channel
// is gone — project_id is required in the JSON body and validated
// against pane.ProjectID inside handleAgentEvent. The HMAC itself is
// the primary binding (only the pane's own children have its
// per-pane RECK_HOOK_SECRET); the body project_id field is a
// configuration sanity check that catches a shim wired to the wrong
// pane id at the env-injection layer.
//
// The replacement coverage lives in hookauth_test.go:
//   - TestAgentEvent_projectIDRequiredInBody  → 400 when missing
//   - TestAgentEvent_projectIDMismatchRejected → 403 on mismatch
//   - TestHookAuth_validSignatureAccepted     → 200 on the happy path
//
// This stub remains as a docstring-only marker so future spelunkers
// who land here from `git log` for the original fix find the trail.
func TestAgentEvent_projectIDBinding_supersededByF4(t *testing.T) {
	t.Skip("superseded by hookauth_test.go: F4 moved project_id from query string to required body field, gated by HMAC")
}

// fakeSupervisorAuth is an in-test SupervisorAuthenticator for
// exercising the scoped-token path without spinning up the real
// supervisor package.
type fakeSupervisorAuth struct {
	token          string
	dockedProjects map[string]bool
	panes          map[string]string // paneID → projectID
}

func (f *fakeSupervisorAuth) CheckToken(b string) bool { return b != "" && b == f.token }
func (f *fakeSupervisorAuth) IsProjectAccessible(id string) bool {
	return f.dockedProjects[id]
}
func (f *fakeSupervisorAuth) IsPaneAccessible(paneID string) bool {
	proj, ok := f.panes[paneID]
	if !ok {
		return false
	}
	return f.dockedProjects[proj]
}

// TestSupervisorToken_scopeEnforcement covers NEW-C1: the supervisor's
// own bearer token cannot reach non-docked projects, can't create/delete
// projects, and can't dock/undock.
func TestSupervisorToken_scopeEnforcement(t *testing.T) {
	t.Setenv("DAEMON_TOKEN", "main-token")
	s, pane := newServerWithPane(t) // pane's project = "p1" (not docked)
	s.SupervisorAuth = &fakeSupervisorAuth{
		token:          "sup-token",
		dockedProjects: map[string]bool{}, // p1 is NOT docked
		panes:          map[string]string{pane.ID: "p1"},
	}
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	call := func(method, path string, bearer string) int {
		req, _ := nethttp.NewRequest(method, srv.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+bearer)
		resp, err := nethttp.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	// Supervisor → non-docked project detail → 403.
	if got := call("GET", "/projects/p1", "sup-token"); got != nethttp.StatusForbidden {
		t.Errorf("supervisor → GET /projects/p1 (undocked): status=%d want 403", got)
	}
	// Supervisor → pane in non-docked project → 403.
	if got := call("GET", "/panes/"+pane.ID+"/output", "sup-token"); got != nethttp.StatusForbidden {
		t.Errorf("supervisor → GET /panes/.../output (undocked): status=%d want 403", got)
	}
	// Supervisor → dock endpoint → 403 regardless of project.
	if got := call("POST", "/projects/p1/dock", "sup-token"); got != nethttp.StatusForbidden {
		t.Errorf("supervisor → POST /dock: status=%d want 403", got)
	}
	// Supervisor → undock → 403.
	if got := call("POST", "/projects/p1/undock", "sup-token"); got != nethttp.StatusForbidden {
		t.Errorf("supervisor → POST /undock: status=%d want 403", got)
	}
	// Supervisor → delete project → 403.
	if got := call("DELETE", "/projects/p1", "sup-token"); got != nethttp.StatusForbidden {
		t.Errorf("supervisor → DELETE /projects/p1: status=%d want 403", got)
	}

	// Main actor → all of the above resolve normally (200 or 404 with
	// existing manager state; the point is not 403).
	if got := call("GET", "/projects/p1", "main-token"); got == nethttp.StatusForbidden {
		t.Errorf("main actor → GET /projects/p1: got 403, should not be scope-blocked")
	}

	// Now dock p1 and confirm the supervisor gains access.
	s.SupervisorAuth.(*fakeSupervisorAuth).dockedProjects["p1"] = true
	if got := call("GET", "/projects/p1", "sup-token"); got == nethttp.StatusForbidden {
		t.Errorf("supervisor → GET /projects/p1 (now docked): got 403, should be allowed")
	}
	if got := call("GET", "/panes/"+pane.ID+"/output", "sup-token"); got == nethttp.StatusForbidden {
		t.Errorf("supervisor → GET pane output (now docked): got 403, should be allowed")
	}
}

// TestSupervisorToken_bogusBearerStillRejected confirms a random bearer
// that isn't main and isn't supervisor gets a clean 401.
func TestSupervisorToken_bogusBearerStillRejected(t *testing.T) {
	t.Setenv("DAEMON_TOKEN", "main-token")
	s := newServer(t)
	s.SupervisorAuth = &fakeSupervisorAuth{token: "sup-token"}
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	req, _ := nethttp.NewRequest("GET", srv.URL+"/projects", nil)
	req.Header.Set("Authorization", "Bearer who-even-am-i")
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != nethttp.StatusUnauthorized {
		t.Errorf("bogus bearer: status=%d want 401", resp.StatusCode)
	}
}

// TestIsLoopbackAddr_table covers the IPv4-mapped-IPv6 fix: the
// previous implementation compared RemoteAddr host against the literal
// strings "127.0.0.1" and "::1" and missed ::ffff:127.0.0.1, which
// broke the agent-event loopback exemption on stacks that present
// local callers that way. netip.ParseAddr(...).IsLoopback() covers
// every form we should accept.
func TestIsLoopbackAddr_table(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"127.0.0.1:7315", true},
		{"127.0.0.1", true},
		{"127.1.2.3:7315", true},          // any 127/8 is loopback
		{"[::1]:7315", true},              // bracketed IPv6 loopback
		{"::1", true},                     // bare IPv6 loopback
		{"[::ffff:127.0.0.1]:7315", true}, // IPv4-mapped IPv6 — the bug fix
		{"::ffff:127.0.0.1", true},
		{"192.168.0.1:7315", false},
		{"192.168.0.1", false},
		{"[2001:db8::1]:7315", false},
		{"10.0.0.5", false},
		{"", false},
		{"garbage", false},
		{"not-an-ip:7315", false}, // host resolves to a string, not an IP
	}
	for _, c := range cases {
		got := isLoopbackAddr(c.in)
		if got != c.want {
			t.Errorf("isLoopbackAddr(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

// TestAuth_agentEventNoLoopbackBypass_ipv4MappedIPv6 (renamed from
// the pre-F4 *Bypass test) confirms the F4 invariant: there is no
// loopback exemption for /panes/:id/agent-event regardless of how
// the RemoteAddr is presented. Pre-F4 this test asserted 200 (the
// loopback bypass was permissive); post-F4 the same request without
// HMAC headers must be 401.
//
// We still go through httptest.NewRecorder + direct dispatch so the
// IPv4-mapped IPv6 RemoteAddr is exercised explicitly — it's the
// shape that broke isLoopbackAddr historically and the test pinned
// the bypass on. Today it pins the absence of the bypass.
//
// isLoopbackAddr itself remains in the codebase + is still covered
// by TestIsLoopbackAddr_table — it's just no longer wired into
// authMiddleware.
func TestAuth_agentEventNoLoopbackBypass_ipv4MappedIPv6(t *testing.T) {
	t.Setenv("DAEMON_TOKEN", "secret")
	s, pane := newServerWithPane(t)

	req := httptest.NewRequest("POST",
		"/panes/"+pane.ID+"/agent-event?kind=user_prompt&agent=claude-code",
		bytes.NewBufferString(`{"project_id":"p1"}`))
	req.RemoteAddr = "[::ffff:127.0.0.1]:54321"

	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Errorf("IPv4-mapped IPv6 loopback agent-event without HMAC: status=%d want 401 (was 200 pre-F4)",
			rec.Code)
	}
}

// TestWSHandler_rejectsCrossSiteOrigin confirms the HTTP route returns
// 403 before reaching the WebSocket upgrade when Origin is cross-site.
func TestWSHandler_rejectsCrossSiteOrigin(t *testing.T) {
	t.Setenv("DAEMON_TOKEN", "main-token")
	s, pane := newServerWithPane(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	// Note the server URL isn't the origin; we override via Header.
	req, _ := nethttp.NewRequest("GET", srv.URL+"/ws/p1/"+pane.ID, nil)
	req.Header.Set("Authorization", "Bearer main-token")
	req.Header.Set("Origin", "http://attacker.example")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != nethttp.StatusForbidden {
		body, _ := io.ReadAll(resp.Body)
		t.Errorf("cross-site WS upgrade: status=%d body=%q want 403", resp.StatusCode, body)
	}
}

// TestPaneInput_supervisorControlByteFilter covers audit F11 :
// the supervisor-actor pane-input path must reject ASCII control bytes
// (notably 0x03 SIGINT and 0x1b ESC) so that indirect prompt-injection
// in pages the supervisor reads can't smuggle terminal control
// sequences into a sibling docked pane. Mirrors the filter that
// /mission-control/chat already applies.
//
// Main-actor calls (renderer / human keystrokes) MUST stay unfiltered —
// interactive use legitimately needs all control bytes (Ctrl-C, arrow
// keys, escape sequences for vim, etc.).
//
// We use a fresh pane per assertion so a stray write that kills the
// shell (notably the main-actor SIGINT case, which delivers 0x03 to
// the controlling pty and reaps /bin/sh) doesn't poison subsequent
// success-path assertions.
func TestPaneInput_supervisorControlByteFilter(t *testing.T) {
	t.Setenv("DAEMON_TOKEN", "main-token")

	freshServer := func() (*Server, *pty.Pane, *httptest.Server) {
		s, pane := newServerWithPane(t)
		s.SupervisorAuth = &fakeSupervisorAuth{
			token:          "sup-token",
			dockedProjects: map[string]bool{"p1": true},
			panes:          map[string]string{pane.ID: "p1"},
		}
		srv := httptest.NewServer(s.Router())
		t.Cleanup(srv.Close)
		return s, pane, srv
	}

	post := func(srv *httptest.Server, paneID, text, bearer string) int {
		raw, err := json.Marshal(map[string]any{"text": text})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		req, _ := nethttp.NewRequest("POST", srv.URL+"/panes/"+paneID+"/input",
			bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+bearer)
		resp, err := nethttp.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST input: %v", err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	// --- supervisor-rejected cases (filter blocks before pane.Write) ---
	// These don't kill the shell because the daemon never writes to it.
	{
		_, pane, srv := freshServer()
		rejectCases := []struct{ name, text string }{
			{"SIGINT_0x03", "\x03"},
			{"ESC_0x1b", "\x1b"},
			{"CSI_sequence", "\x1b[31mred\x1b[0m"},
			{"DEL_0x7f", "abc\x7fdef"},
			{"NUL_0x00", "abc\x00def"},
			{"hidden_BEL_0x07", "hi\x07there"},
			{"SIGINT_in_middle", "ls\x03ls"},
		}
		for _, tc := range rejectCases {
			t.Run("supervisor_rejected_"+tc.name, func(t *testing.T) {
				if got := post(srv, pane.ID, tc.text, "sup-token"); got != nethttp.StatusBadRequest {
					t.Errorf("supervisor → %s: status=%d want 400", tc.name, got)
				}
			})
		}
	}

	// --- main-actor-passes cases (filter must NOT apply) ---
	// Each gets its own pane because a control byte reaching the pty
	// can kill the shell (0x03 → SIGINT, 0x04 → EOF, etc.) and a
	// dead shell would 500 on the next test's pane.Write.
	mainPassCases := []struct{ name, text string }{
		{"SIGINT_0x03", "\x03"},
		{"ESC_0x1b", "\x1b"},
		{"CSI_sequence", "\x1b[31mred\x1b[0m"},
		{"DEL_0x7f", "abc\x7fdef"},
		{"NUL_0x00", "abc\x00def"},
		{"hidden_BEL_0x07", "hi\x07there"},
	}
	for _, tc := range mainPassCases {
		t.Run("main_actor_passes_"+tc.name, func(t *testing.T) {
			_, pane, srv := freshServer()
			// Main actor (renderer / user) must NOT be filtered. Only
			// assert "not 400" — pty write may fail for other reasons
			// (e.g. shell about to die), but it must NOT be the filter.
			if got := post(srv, pane.ID, tc.text, "main-token"); got == nethttp.StatusBadRequest {
				t.Errorf("main actor → %s: got 400 (filter wrongly applied)", tc.name)
			}
		})
	}

	// --- supervisor-allowed cases (clean text, tab/LF/CR whitespace) ---
	t.Run("supervisor_plain_text_passes", func(t *testing.T) {
		_, pane, srv := freshServer()
		if got := post(srv, pane.ID, "ls -la\n", "sup-token"); got != nethttp.StatusOK {
			t.Errorf("supervisor → plain text: status=%d want 200", got)
		}
	})
	t.Run("supervisor_newline_only_passes", func(t *testing.T) {
		_, pane, srv := freshServer()
		if got := post(srv, pane.ID, "\n", "sup-token"); got != nethttp.StatusOK {
			t.Errorf("supervisor → newline-only: status=%d want 200", got)
		}
	})
	t.Run("supervisor_tab_and_CR_pass", func(t *testing.T) {
		_, pane, srv := freshServer()
		if got := post(srv, pane.ID, "a\tb\r", "sup-token"); got != nethttp.StatusOK {
			t.Errorf("supervisor → tab+CR: status=%d want 200", got)
		}
	})
}

// TestFirstControlByte_table pins the predicate the supervisor input
// filter relies on. Mirrors supervisor.firstControlByte's contract.
func TestFirstControlByte_table(t *testing.T) {
	cases := []struct {
		name      string
		in        string
		wantOff   byte
		wantFound bool
	}{
		{"empty", "", 0, false},
		{"plain ASCII", "hello world", 0, false},
		{"newline allowed", "line1\nline2", 0, false},
		{"tab allowed", "a\tb", 0, false},
		{"CR allowed", "a\r", 0, false},
		{"NUL detected", "a\x00b", 0x00, true},
		{"SIGINT detected", "\x03exit", 0x03, true},
		{"ESC detected", "\x1b[m", 0x1b, true},
		{"BEL detected", "\x07", 0x07, true},
		{"DEL detected", "abc\x7f", 0x7f, true},
		{"first wins (NUL before ESC)", "x\x00y\x1b", 0x00, true},
		{"high bytes (UTF-8) are clean", "\xe2\x98\x83", 0, false}, // snowman ☃
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			off, found := firstControlByte(tc.in)
			if found != tc.wantFound {
				t.Fatalf("found=%v, want %v (offender=0x%02x)", found, tc.wantFound, off)
			}
			if found && off != tc.wantOff {
				t.Errorf("offender=0x%02x, want 0x%02x", off, tc.wantOff)
			}
		})
	}
}

