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
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/daemon/internal/pty"
	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
	"github.com/rudie-verweij/reck-connect/daemon/internal/ws"
	"github.com/rudie-verweij/reck-connect/proto"
)

// testDaemonToken is the DAEMON_TOKEN value newServer installs into the
// process environment when no test has set its own. Audit fix F3
// made the auth middleware fail closed on empty DAEMON_TOKEN; without a
// default, every test exercising the router would return 503.
//
// Tests that exercise the auth path directly (TestAuth_*, security_test.go,
// ws_auth_test.go) override this with t.Setenv before calling newServer
// and use the value they set. Tests that don't care about auth use this
// default plus the bearer-injecting handler returned by newTestHandler.
const testDaemonToken = "test-daemon-token-fixed"

// ensureTestDaemonToken sets DAEMON_TOKEN for the duration of the test
// if no value is currently published. Tests that explicitly set their
// own DAEMON_TOKEN before calling newServer keep that value; this is a
// fallback so the F3 fail-closed authMiddleware doesn't 503 every
// fixture-based test that never thought about auth.
func ensureTestDaemonToken(t *testing.T) {
	t.Helper()
	if os.Getenv("DAEMON_TOKEN") == "" {
		t.Setenv("DAEMON_TOKEN", testDaemonToken)
	}
}

// newTestHandler wraps s.Router() with a bearer-injecting layer so the
// vast majority of tests (which don't care about auth) can keep using
// the bare nethttp.Get/Post pattern. Callers that need to exercise the
// auth path itself (sending a wrong/missing bearer to assert 401 or 503)
// must use s.Router() directly so this helper doesn't mask the request.
//
// The wrapper only injects the Authorization header when the incoming
// request did not already provide one — so a test that explicitly sets
// "Bearer wrong" still sees its 401, and a test that sends no
// Authorization on a route the server is supposed to reject (e.g. CORS
// tests, supervisor-token tests) gets the right behaviour as long as it
// sets its own DAEMON_TOKEN before calling newServer.
func newTestHandler(t *testing.T, s *Server) nethttp.Handler {
	t.Helper()
	ensureTestDaemonToken(t)
	// Snapshot the token at the same moment authMiddleware does so
	// the wrapper can never inject a stale or rotated value that the
	// middleware no longer expects.
	token := os.Getenv("DAEMON_TOKEN")
	inner := s.Router()
	return nethttp.HandlerFunc(func(w nethttp.ResponseWriter, r *nethttp.Request) {
		if r.Header.Get("Authorization") == "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		inner.ServeHTTP(w, r)
	})
}

func newServer(t *testing.T) *Server {
	t.Helper()
	ensureTestDaemonToken(t)
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := pty.NewManager(
		// Available=true mirrors what config.Load stamps for an entry
		// whose cwd exists. Tests that bypass config.Load and inject
		// projects directly must keep this in sync so HTTP responses
		// don't pretend the fixture project is stale.
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, DefaultPane: "shell", Shell: []string{"/bin/sh"}, Available: true}},
		[]string{"/bin/echo", "placeholder"},
		configPath,
		nil,
	)
	return &Server{
		Manager:   mgr,
		WS:        &ws.Handler{Manager: mgr, Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))},
		StartedAt: time.Now(),
		Version:   "test",
	}
}

func TestHealth(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	r, err := nethttp.Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 {
		t.Fatalf("status: %d", r.StatusCode)
	}
	var h proto.HealthResponse
	json.NewDecoder(r.Body).Decode(&h)
	if h.Status != "ok" {
		t.Fatalf("status: %s", h.Status)
	}
	// newServer builds a manager with no codex binary, so /health must
	// report codex unavailable.
	if h.CodexAvailable {
		t.Fatalf("expected codex_available=false on a codex-less server")
	}
}

// /health must surface whether the daemon has a codex binary so the
// Satellite can gate the "Codex" new-pane button on it.
func TestHealth_reportsCodexAvailable(t *testing.T) {
	s := newServer(t)
	s.CodexAvailable = true
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	r, err := nethttp.Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	var h proto.HealthResponse
	json.NewDecoder(r.Body).Decode(&h)
	if !h.CodexAvailable {
		t.Fatalf("expected codex_available=true when Server.CodexAvailable is set")
	}
}

func TestProjectsList(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	r, err := nethttp.Get(srv.URL + "/projects")
	if err != nil {
		t.Fatal(err)
	}
	var p proto.ProjectsListResponse
	json.NewDecoder(r.Body).Decode(&p)
	if len(p.Projects) != 1 {
		t.Fatalf("want 1 project, got %d", len(p.Projects))
	}
	// Hybrid mode rev 3.1, phase 7: the wire response must always carry
	// `available` for projects whose cwd exists. The test fixture uses an
	// existing tmpdir as the cwd so the manager mirrors p.Available=true
	// (the value the AddProject path stamps).
	if !p.Projects[0].Available {
		t.Fatalf("want Available=true for fixture project (cwd exists), got false")
	}
}

// TestProjectsList_unavailableProjectKeptInResponse — phase 7 wire
// contract: an entry whose underlying config.Project.Available is false
// flows through the HTTP response intact. We construct the manager
// directly with Available=false so this test pins the encoder path
// without depending on config.Load (covered separately in config_test).
func TestProjectsList_unavailableProjectKeptInResponse(t *testing.T) {
	ensureTestDaemonToken(t)
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := pty.NewManager(
		[]config.Project{
			// "stale" simulates an entry whose cwd has gone missing on
			// disk — config.Load would mark it Available=false.
			{ID: "stale", Name: "Stale", Cwd: filepath.Join(dir, "gone"), DefaultPane: "shell", Shell: []string{"/bin/sh"}, Available: false},
		},
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
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	r, err := nethttp.Get(srv.URL + "/projects")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()

	// Decode into the typed struct first to confirm the shape round-trips.
	var p proto.ProjectsListResponse
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(bodyBytes, &p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(p.Projects) != 1 {
		t.Fatalf("want 1 project (kept despite Available=false), got %d", len(p.Projects))
	}
	if p.Projects[0].ID != "stale" {
		t.Fatalf("want id 'stale', got %q", p.Projects[0].ID)
	}
	if p.Projects[0].Available {
		t.Fatalf("want Available=false in response, got true")
	}
	// Phase 7 wire-key contract: the JSON literal must use the snake_case
	// `available` key so TS clients decode it via the optional
	// Project.available field. Pin the literal so a future field rename
	// can't slip through silently.
	if !strings.Contains(string(bodyBytes), `"available":false`) {
		t.Fatalf("response body must contain literal `\"available\":false`; got %s", string(bodyBytes))
	}
}

func TestProjectDetail_autoSpawnDefault(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	r, err := nethttp.Get(srv.URL + "/projects/p1")
	if err != nil {
		t.Fatal(err)
	}
	var d proto.ProjectDetail
	json.NewDecoder(r.Body).Decode(&d)
	if len(d.Panes) != 1 {
		t.Fatalf("default pane should be auto-spawned; got %d panes", len(d.Panes))
	}
	if d.Panes[0].Kind != proto.PaneKindShell {
		t.Fatalf("wanted default shell pane, got %s", d.Panes[0].Kind)
	}
	s.Manager.DeletePane("p1", d.Panes[0].ID)
}

// an earlier release: hybrid satellite calls /projects/:id on the secondary host
// purely to read pane state (so reconcile can rebind cross-host tabs).
// `?autospawn=false` opts out of the new-project starter-pane side-effect
// so a station-resident project doesn't grow a phantom pane on local
// every time the user re-enters it. Mirrors the bug repro: open project,
// click Mission Control, click project again — the secondary fetch
// shouldn't side-effect a spawn.
func TestProjectDetail_autoSpawnOptOut(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	r, err := nethttp.Get(srv.URL + "/projects/p1?autospawn=false")
	if err != nil {
		t.Fatal(err)
	}
	var d proto.ProjectDetail
	json.NewDecoder(r.Body).Decode(&d)
	if len(d.Panes) != 0 {
		t.Fatalf("autospawn=false should leave the project empty; got %d panes", len(d.Panes))
	}
	// Belt-and-braces: the project entry itself must still be returned.
	if d.ID != "p1" {
		t.Fatalf("wanted project p1 in response, got %q", d.ID)
	}
}

// an earlier release (Codex HIGH, strict parsing): an unparsable autospawn value
// used to fall through to the default `true` and silently spawn — which
// makes typos (`?autospawn=fasle`) undetectable. The handler now rejects
// malformed values with 400 so the typo is loud at the client. Empty
// (i.e. param omitted) still defaults to true; that's covered by
// TestProjectDetail_autoSpawnDefault above.
func TestProjectDetail_autoSpawnRejectsMalformedValue(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	for _, bad := range []string{"garbage", "fasle", "yes", "no", "TRUEISH"} {
		t.Run(bad, func(t *testing.T) {
			r, err := nethttp.Get(srv.URL + "/projects/p1?autospawn=" + bad)
			if err != nil {
				t.Fatal(err)
			}
			defer r.Body.Close()
			if r.StatusCode != nethttp.StatusBadRequest {
				body, _ := io.ReadAll(r.Body)
				t.Fatalf("expected 400 for autospawn=%q, got %d (body=%q)", bad, r.StatusCode, body)
			}
			// No spawn should have happened on the rejected request.
			if got := len(s.Manager.PanesInProject("p1")); got != 0 {
				t.Fatalf("rejected request must not spawn; got %d panes", got)
			}
		})
	}
}

// an earlier release (Codex HIGH, atomic spawn): two concurrent GETs at an empty
// project used to both observe zero panes (PanesInProject + ProjectExists
// under separate RLock acquisitions) and both spawn a starter pane. The
// EnsureDefaultPane critical section serialises the empty-check with the
// spawn intent so only the first caller wins; the rest see the in-flight
// flag (or, if the spawn already finished, the populated pane list) and
// short-circuit. End-to-end through the HTTP handler: fan out N parallel
// requests, assert exactly one pane was created.
func TestProjectDetail_autoSpawnIsAtomicUnderConcurrency(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	const concurrency = 8
	var wg sync.WaitGroup
	start := make(chan struct{})
	statuses := make([]int, concurrency)
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-start
			r, err := nethttp.Get(srv.URL + "/projects/p1")
			if err != nil {
				t.Errorf("worker %d: %v", idx, err)
				return
			}
			defer r.Body.Close()
			statuses[idx] = r.StatusCode
		}(i)
	}
	close(start)
	wg.Wait()

	for i, st := range statuses {
		if st != nethttp.StatusOK {
			t.Fatalf("worker %d returned status %d", i, st)
		}
	}
	if got := len(s.Manager.PanesInProject("p1")); got != 1 {
		t.Fatalf("concurrent GETs spawned %d panes; want exactly 1", got)
	}
	for _, p := range s.Manager.PanesInProject("p1") {
		s.Manager.DeletePane("p1", p.ID)
	}
}

func TestCreateAndDeletePane(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	body, _ := json.Marshal(proto.CreatePaneRequest{Kind: proto.PaneKindShell})
	r, err := nethttp.Post(srv.URL+"/projects/p1/panes", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var cr proto.CreatePaneResponse
	json.NewDecoder(r.Body).Decode(&cr)
	if cr.PaneID == "" {
		t.Fatal("no pane_id returned")
	}
	req, _ := nethttp.NewRequest("DELETE", srv.URL+"/projects/p1/panes/"+cr.PaneID, nil)
	r, err = nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 {
		t.Fatalf("delete status %d", r.StatusCode)
	}
}

// A codex pane must be creatable through the normal create-pane endpoint
// when the station has a codex binary configured — same path as claude/shell.
// The manager is built with a CodexCmd so the adapter resolves (an empty
// CodexCmd would 400 with ErrCodexNotAvailable, which is a different case).
func TestCreatePane_codex_accepted(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := pty.NewManagerFromConfig(pty.ManagerConfig{
		Projects:   []config.Project{{ID: "p1", Name: "P1", Cwd: dir, DefaultPane: "shell", Shell: []string{"/bin/sh"}, Available: true}},
		ClaudeCmd:  []string{"/bin/echo", "placeholder"},
		CodexCmd:   []string{"/bin/echo", "codex-placeholder"},
		ConfigPath: configPath,
	})
	s := &Server{
		Manager:   mgr,
		WS:        &ws.Handler{Manager: mgr, Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))},
		StartedAt: time.Now(),
		Version:   "test",
	}
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	body, _ := json.Marshal(proto.CreatePaneRequest{Kind: proto.PaneKindCodex})
	r, err := nethttp.Post(srv.URL+"/projects/p1/panes", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 {
		b, _ := io.ReadAll(r.Body)
		t.Fatalf("create codex pane: status %d, body %q", r.StatusCode, strings.TrimSpace(string(b)))
	}
	var cr proto.CreatePaneResponse
	json.NewDecoder(r.Body).Decode(&cr)
	if cr.PaneID == "" {
		t.Fatal("no pane_id returned for codex pane")
	}
	panes := s.Manager.PanesInProject("p1")
	if len(panes) != 1 || panes[0].Kind != proto.PaneKindCodex {
		t.Fatalf("expected exactly one codex pane, got %+v", panes)
	}
}

func TestCreateProject_deriveID(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()
	dir := t.TempDir()

	body, _ := json.Marshal(proto.AddProjectRequest{Name: "Foo Bar", Cwd: dir})
	r, err := nethttp.Post(srv.URL+"/projects", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 {
		t.Fatalf("status %d", r.StatusCode)
	}
	var resp proto.AddProjectResponse
	json.NewDecoder(r.Body).Decode(&resp)
	if resp.Project.ID != "foo-bar" {
		t.Fatalf("want foo-bar, got %s", resp.Project.ID)
	}
}

// newServerAt is like newServer but exposes the configPath so parity
// tests can re-Load the same TOML file the HTTP handlers wrote.
func newServerAt(t *testing.T) (*Server, string) {
	t.Helper()
	ensureTestDaemonToken(t)
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := pty.NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, DefaultPane: "shell", Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo", "placeholder"},
		configPath,
		nil,
	)
	return &Server{
		Manager:   mgr,
		WS:        &ws.Handler{Manager: mgr, Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))},
		StartedAt: time.Now(),
		Version:   "test",
	}, configPath
}

// TestCreateProject_idValidation_parityWithLoad is the regression guard
// for the previous persistence-invariant break: every id the HTTP
// creation path accepts must also round-trip through config.Load, and
// every one it rejects must agree on the rejection.
func TestCreateProject_idValidation_parityWithLoad(t *testing.T) {
	cases := []struct {
		id       string
		wantHTTP int
	}{
		{"", 200},              // empty id → server derives one from Name; still 200
		{"foo", 200},           // plain valid
		{"FOO_BAR-123", 200},   // full alphabet inside the regex
		{"-leading-dash", 400}, // regex rejects leading dash
		{"has space", 400},     // space
		{"has/slash", 400},
		{strings.Repeat("x", config.MaxProjectIDLen), 200},         // at cap
		{strings.Repeat("y", config.MaxProjectIDLen+1), 400},       // over cap
		{strings.Repeat("z", config.MaxProjectIDLen+1) + "!", 400}, // over + invalid chars
	}
	for _, c := range cases {
		s, configPath := newServerAt(t)
		srv := httptest.NewServer(newTestHandler(t, s))
		dir := t.TempDir()
		body, _ := json.Marshal(proto.AddProjectRequest{
			ID: c.id, Name: "some-name-" + c.id, Cwd: dir,
		})
		r, err := nethttp.Post(srv.URL+"/projects", "application/json", bytes.NewReader(body))
		if err != nil {
			srv.Close()
			t.Fatal(err)
		}
		r.Body.Close()
		srv.Close()
		if r.StatusCode != c.wantHTTP {
			t.Errorf("id=%q (len=%d): POST status=%d, want %d",
				c.id, len(c.id), r.StatusCode, c.wantHTTP)
			continue
		}
		if c.wantHTTP != 200 {
			continue
		}
		// The server stored something. Either it was c.id (when non-empty)
		// or a derived slug. Read it back via Load and confirm the ID
		// survives restart validation.
		reg, warns, err := config.Load(configPath)
		if err != nil {
			t.Errorf("id=%q: reload: %v", c.id, err)
			continue
		}
		if len(warns) > 0 {
			t.Errorf("id=%q: reload warnings on create-accepted id: %v", c.id, warns)
		}
		if len(reg.Projects) < 1 {
			t.Errorf("id=%q: project missing from reload", c.id)
		}
	}
}

// TestCreateProject_missingName is unchanged: empty names are
// intentionally rejected independently of id validation.
func TestCreateProject_missingName(t *testing.T) {
	// Empty name must still be rejected; empty cwd is now valid.
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	body, _ := json.Marshal(proto.AddProjectRequest{Cwd: t.TempDir()})
	r, err := nethttp.Post(srv.URL+"/projects", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 400 {
		t.Fatalf("want 400, got %d", r.StatusCode)
	}
}

func TestCreateProject_emptyCwdCreatesManagedDir(t *testing.T) {
	tmp := t.TempDir()
	origRoot := config.ManagedProjectsRoot
	config.ManagedProjectsRoot = filepath.Join(tmp, "projects")
	t.Cleanup(func() { config.ManagedProjectsRoot = origRoot })

	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	body, _ := json.Marshal(proto.AddProjectRequest{Name: "Demo"})
	r, err := nethttp.Post(srv.URL+"/projects", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 {
		buf := new(bytes.Buffer)
		_, _ = buf.ReadFrom(r.Body)
		t.Fatalf("status = %d, body = %q", r.StatusCode, buf.String())
	}
	var resp proto.AddProjectResponse
	if err := json.NewDecoder(r.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.Project.ID != "demo" {
		t.Errorf("ID = %q, want demo", resp.Project.ID)
	}
	wantCwd := filepath.Join(config.ManagedProjectsRoot, "demo")
	if resp.Project.Cwd != wantCwd {
		t.Errorf("Cwd = %q, want %q", resp.Project.Cwd, wantCwd)
	}
	if _, err := os.Stat(wantCwd); err != nil {
		t.Errorf("expected managed dir to exist: %v", err)
	}
}

// TestDeleteProject_rmRFManagedDir drives the DELETE handler through a project
// whose cwd is under a temp-overridden managed root, and verifies the dir
// is actually removed from disk.
func TestDeleteProject_rmRFManagedDir(t *testing.T) {
	tmp := t.TempDir()
	origRoot := config.ManagedProjectsRoot
	config.ManagedProjectsRoot = filepath.Join(tmp, "projects")
	t.Cleanup(func() { config.ManagedProjectsRoot = origRoot })

	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	body, _ := json.Marshal(proto.AddProjectRequest{Name: "Disposable"})
	r, err := nethttp.Post(srv.URL+"/projects", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var resp proto.AddProjectResponse
	if err := json.NewDecoder(r.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.Project.ID != "disposable" {
		t.Fatalf("unexpected ID %q", resp.Project.ID)
	}
	if _, err := os.Stat(resp.Project.Cwd); err != nil {
		t.Fatalf("expected managed dir %s: %v", resp.Project.Cwd, err)
	}

	req, _ := nethttp.NewRequest("DELETE", srv.URL+"/projects/"+resp.Project.ID, nil)
	r2, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if r2.StatusCode != 200 {
		t.Fatalf("delete status %d", r2.StatusCode)
	}
	if _, err := os.Stat(resp.Project.Cwd); !os.IsNotExist(err) {
		t.Errorf("expected %s to be removed after DELETE; err=%v", resp.Project.Cwd, err)
	}
}

// TestDeleteProject_leavesExternalDir verifies the destructive path guard:
// a project registered against an external cwd is unregistered but the dir
// (and its contents) survive.
func TestDeleteProject_leavesExternalDir(t *testing.T) {
	tmp := t.TempDir()
	origRoot := config.ManagedProjectsRoot
	config.ManagedProjectsRoot = filepath.Join(tmp, "projects")
	t.Cleanup(func() { config.ManagedProjectsRoot = origRoot })

	external := filepath.Join(tmp, "externally-owned")
	if err := os.Mkdir(external, 0o755); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(external, "keep.txt")
	if err := os.WriteFile(sentinel, []byte("preserve"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	body, _ := json.Marshal(proto.AddProjectRequest{Name: "Ext", Cwd: external})
	r, err := nethttp.Post(srv.URL+"/projects", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var resp proto.AddProjectResponse
	if err := json.NewDecoder(r.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}

	req, _ := nethttp.NewRequest("DELETE", srv.URL+"/projects/"+resp.Project.ID, nil)
	r2, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if r2.StatusCode != 200 {
		t.Fatalf("delete status %d", r2.StatusCode)
	}
	if _, err := os.Stat(sentinel); err != nil {
		t.Errorf("sentinel unexpectedly deleted: %v", err)
	}
}

func TestDeleteProject_roundtrip(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()
	dir := t.TempDir()

	body, _ := json.Marshal(proto.AddProjectRequest{Name: "Disposable", Cwd: dir})
	r, err := nethttp.Post(srv.URL+"/projects", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var resp proto.AddProjectResponse
	json.NewDecoder(r.Body).Decode(&resp)

	req, _ := nethttp.NewRequest("DELETE", srv.URL+"/projects/"+resp.Project.ID, nil)
	r2, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if r2.StatusCode != 200 {
		t.Fatalf("delete status %d", r2.StatusCode)
	}

	r3, _ := nethttp.Get(srv.URL + "/projects")
	var list proto.ProjectsListResponse
	json.NewDecoder(r3.Body).Decode(&list)
	for _, p := range list.Projects {
		if p.ID == resp.Project.ID {
			t.Fatalf("project still listed after delete")
		}
	}
}

func TestAuth_tokenRequired(t *testing.T) {
	os.Setenv("DAEMON_TOKEN", "secret")
	defer os.Unsetenv("DAEMON_TOKEN")
	s := newServer(t)
	// Bypass newTestHandler: this test asserts the no-Authorization → 401
	// behaviour, which the wrapper would mask by injecting one.
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	r, err := nethttp.Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 401 {
		t.Fatalf("expected 401, got %d", r.StatusCode)
	}

	req, _ := nethttp.NewRequest("GET", srv.URL+"/health", nil)
	req.Header.Set("Authorization", "Bearer secret")
	r, err = nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", r.StatusCode)
	}
}

func TestCORSPreflight(t *testing.T) {
	srv := httptest.NewServer(newTestHandler(t, newServer(t)))
	defer srv.Close()

	req, _ := nethttp.NewRequest("OPTIONS", srv.URL+"/projects", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "content-type")
	r, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 204 {
		t.Fatalf("expected 204, got %d", r.StatusCode)
	}
	if got := r.Header.Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want *", got)
	}
	if got := r.Header.Get("Access-Control-Allow-Methods"); got == "" {
		t.Fatal("Access-Control-Allow-Methods header missing")
	}
}

// TestAuth_agentEventNoBearerFromLoopback is the F4  behaviour
// for the endpoint that previously had a loopback bypass. After F4 the
// auth middleware no longer bearer-checks /panes/:id/agent-event — the
// per-pane HMAC enforced inside handleAgentEvent is the only gate. So
// a loopback POST without the HMAC headers reaches the handler and is
// rejected there with 401 (NOT a middleware 401, NOT a free-pass 200
// like pre-F4).
//
// Before F4: loopback agent-event without auth headers → 200 (the
// loopback exemption short-circuited the middleware).
// After F4:  loopback agent-event without HMAC headers → 401 (handler
// rejects "missing hook signature headers").
//
// The contrast with /health is preserved: bearer auth is still
// enforced everywhere except agent-event, and agent-event has its own
// stricter HMAC scheme.
func TestAuth_agentEventNoBearerFromLoopback(t *testing.T) {
	t.Setenv("DAEMON_TOKEN", "secret")
	s := newServer(t)
	paneID := createShellPaneForEvents(t, s)
	// Bypass newTestHandler: this test explicitly checks the
	// no-auth-headers behaviour, so we don't want the wrapper to
	// inject Authorization on our behalf.
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	// agent-event without HMAC headers is now 401, not 200. This is the
	// F4 invariant — the loopback exemption is gone.
	r, err := nethttp.Post(
		srv.URL+"/panes/"+paneID+"/agent-event?kind=user_prompt&agent=claude-code",
		"application/json",
		bytes.NewBufferString(`{}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 401 {
		t.Fatalf("agent-event over loopback without HMAC: status = %d, want 401 (was 200 pre-F4)", r.StatusCode)
	}

	// Non-agent-event endpoints still require the bearer token, even from
	// loopback. /health is the cheapest probe of the bearer path.
	r, err = nethttp.Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 401 {
		t.Fatalf("/health over loopback status = %d, want 401 (auth still enforced)", r.StatusCode)
	}
}

func TestCORSPreflightBypassesAuth(t *testing.T) {
	t.Setenv("DAEMON_TOKEN", "secret")
	srv := httptest.NewServer(newTestHandler(t, newServer(t)))
	defer srv.Close()

	// Preflight must succeed without an Authorization header.
	req, _ := nethttp.NewRequest("OPTIONS", srv.URL+"/projects", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	req.Header.Set("Access-Control-Request-Method", "POST")
	r, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 204 {
		t.Fatalf("preflight status = %d, want 204 (should bypass auth)", r.StatusCode)
	}
}

// --- POST /panes/:id/agent-event ---

// createShellPaneForEvents spawns a dummy shell pane so we have a real
// pane ID registered with the manager for the handler to look up.
func createShellPaneForEvents(t *testing.T, s *Server) string {
	t.Helper()
	pane, err := s.Manager.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	return pane.ID
}

func TestAgentEvent_happyPath(t *testing.T) {
	s := newServer(t)
	paneID := createShellPaneForEvents(t, s)
	pane, _ := s.Manager.PaneByID(paneID)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	// F4 : body now MUST include project_id, and the request MUST
	// carry HMAC headers signed with the pane's RECK_HOOK_SECRET. The
	// daemon stores the validated raw body verbatim in the event log.
	resp := postSignedHook(t, srv, paneID, pane.HookSecret, pane.ProjectID, "user_prompt")
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var got map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&got)
	resp.Body.Close()
	if got["ok"] != true {
		t.Fatalf("resp = %+v", got)
	}

	// Pane state should now be "working".
	if pane.AgentState() != proto.AgentStateWorking {
		t.Fatalf("agent state = %s, want working", pane.AgentState())
	}
	// The event is in the log; data is the validated raw body
	// (which postSignedHook constructed as `{"project_id":..., "prompt":"hi"}`).
	snap := pane.EventLog().Snapshot()
	if len(snap) != 1 {
		t.Fatalf("event log len = %d, want 1", len(snap))
	}
	wantBody := `{"project_id":"` + pane.ProjectID + `","prompt":"hi"}`
	if string(snap[0].Data) != wantBody {
		t.Fatalf("data lost: got %s want %s", snap[0].Data, wantBody)
	}
}

func TestAgentEvent_unknownPane(t *testing.T) {
	srv := httptest.NewServer(newTestHandler(t, newServer(t)))
	defer srv.Close()
	r, err := nethttp.Post(srv.URL+"/panes/p_missing/agent-event?kind=stop&agent=claude-code", "application/json", bytes.NewBufferString("{}"))
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 404 {
		t.Fatalf("status = %d, want 404", r.StatusCode)
	}
}

func TestAgentEvent_unknownKind(t *testing.T) {
	s := newServer(t)
	paneID := createShellPaneForEvents(t, s)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()
	r, err := nethttp.Post(srv.URL+"/panes/"+paneID+"/agent-event?kind=garbage&agent=claude-code", "application/json", bytes.NewBufferString("{}"))
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 400 {
		t.Fatalf("status = %d, want 400", r.StatusCode)
	}
}

func TestAgentEvent_missingAgent(t *testing.T) {
	s := newServer(t)
	paneID := createShellPaneForEvents(t, s)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()
	r, err := nethttp.Post(srv.URL+"/panes/"+paneID+"/agent-event?kind=stop", "application/json", bytes.NewBufferString("{}"))
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 400 {
		t.Fatalf("status = %d, want 400", r.StatusCode)
	}
}

func TestAgentEvent_invalidJSON(t *testing.T) {
	s := newServer(t)
	paneID := createShellPaneForEvents(t, s)
	pane, _ := s.Manager.PaneByID(paneID)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	// F4: body validity is checked AFTER HMAC verification, so the
	// signature has to be over the (invalid) bytes we're sending.
	body := []byte(`{"prompt":`)
	path := "/panes/" + paneID + "/agent-event"
	url := srv.URL + path + "?kind=user_prompt&agent=claude-code"
	sig, ts, nonce := signHookRequest(t, pane.HookSecret, "POST", path, body)

	req, _ := nethttp.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HookAuthHeaderSig, sig)
	req.Header.Set(HookAuthHeaderTs, ts)
	req.Header.Set(HookAuthHeaderNonce, nonce)
	r, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != 400 {
		t.Fatalf("status = %d, want 400", r.StatusCode)
	}
}

// --- Session persistence  ---

func newServerWithSessions(t *testing.T) (*Server, *sessions.Store, string) {
	t.Helper()
	ensureTestDaemonToken(t)
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sess"))
	if err != nil {
		t.Fatal(err)
	}
	mgr := pty.NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, DefaultPane: "shell", Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo", "placeholder"},
		configPath,
		store,
	)
	return &Server{
		Manager:   mgr,
		WS:        &ws.Handler{Manager: mgr, Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))},
		StartedAt: time.Now(),
		Version:   "test",
	}, store, dir
}

func TestListSessions_emptyWhenNoStore(t *testing.T) {
	s := newServer(t) // no sessions store
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()
	r, err := nethttp.Get(srv.URL + "/projects/p1/sessions")
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", r.StatusCode)
	}
	var resp proto.SessionsListResponse
	json.NewDecoder(r.Body).Decode(&resp)
	if len(resp.Sessions) != 0 {
		t.Fatalf("want empty sessions, got %+v", resp.Sessions)
	}
}

func TestListSessions_unknownProject404s(t *testing.T) {
	s, _, _ := newServerWithSessions(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()
	r, err := nethttp.Get(srv.URL + "/projects/does-not-exist/sessions")
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 404 {
		t.Fatalf("want 404, got %d", r.StatusCode)
	}
}

func TestListSessions_returnsLiveEntries(t *testing.T) {
	// Point HOME at a tempdir *before* newServerWithSessions so the
	// daemon's session-store dir and the fake ~/.claude/projects tree
	// both live under the same isolated root. store.List() resolves
	// $HOME on every call, so this is the seam the handler exercises.
	fakeHome := t.TempDir()
	t.Setenv("HOME", fakeHome)

	s, store, projectCwd := newServerWithSessions(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	transcriptDir := filepath.Join(fakeHome, ".claude", "projects", sessions.EncodeCwd(projectCwd))
	if err := os.MkdirAll(transcriptDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sid := sessions.NewUUID()
	if err := os.WriteFile(filepath.Join(transcriptDir, sid+".jsonl"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := store.Upsert("p1", sessions.Entry{
		SessionID:    sid,
		Name:         "p1/seed",
		Cwd:          projectCwd,
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "p_abc",
	}); err != nil {
		t.Fatal(err)
	}
	r, err := nethttp.Get(srv.URL + "/projects/p1/sessions")
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 {
		t.Fatalf("status = %d", r.StatusCode)
	}
	var resp proto.SessionsListResponse
	json.NewDecoder(r.Body).Decode(&resp)
	if len(resp.Sessions) != 1 || resp.Sessions[0].SessionID != sid {
		t.Fatalf("want one session %s, got %+v", sid, resp.Sessions)
	}
	if resp.Sessions[0].Name != "p1/seed" {
		t.Errorf("name = %q, want p1/seed", resp.Sessions[0].Name)
	}
}

func TestCreatePane_resumeSessionID_unknown_400s(t *testing.T) {
	s, _, _ := newServerWithSessions(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()
	body, _ := json.Marshal(proto.CreatePaneRequest{
		Kind:            proto.PaneKindClaude,
		ResumeSessionID: sessions.NewUUID(),
	})
	r, err := nethttp.Post(srv.URL+"/projects/p1/panes", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 400 {
		t.Fatalf("want 400 for unknown resume id, got %d", r.StatusCode)
	}
}

func TestRestoreCandidates_emptyWhenNoStore(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()
	r, err := nethttp.Get(srv.URL + "/restore-candidates")
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 {
		t.Fatalf("status = %d", r.StatusCode)
	}
	var resp proto.RestoreCandidatesResponse
	json.NewDecoder(r.Body).Decode(&resp)
	if len(resp.Candidates) != 0 {
		t.Fatalf("want empty candidates, got %+v", resp.Candidates)
	}
}

func TestRestoreCandidates_surfacesOrphanLiveSessions(t *testing.T) {
	fakeHome := t.TempDir()
	t.Setenv("HOME", fakeHome)
	s, store, projectCwd := newServerWithSessions(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	transcriptDir := filepath.Join(fakeHome, ".claude", "projects", sessions.EncodeCwd(projectCwd))
	if err := os.MkdirAll(transcriptDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Three entries: one orphan live (should surface), one live but
	// linked to a live pane (should NOT surface — it's still running),
	// one not-live (user gracefully closed; should NOT surface).
	orphan := sessions.NewUUID()
	stillRunning := sessions.NewUUID()
	closed := sessions.NewUUID()
	for _, sid := range []string{orphan, stillRunning, closed} {
		if err := os.WriteFile(filepath.Join(transcriptDir, sid+".jsonl"), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UTC()

	// Spawn a real pane so its ID exists in PanesInProject for the
	// "stillRunning" case. We'll inject the pane ID into the entry.
	pane, err := s.Manager.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Manager.DeletePane("p1", pane.ID)

	mustUpsert := func(sid string, was bool, paneID string) {
		if err := store.Upsert("p1", sessions.Entry{
			SessionID:    sid,
			Name:         sid[:8],
			Cwd:          projectCwd,
			CreatedAt:    now,
			LastActiveAt: now,
			LastPaneID:   paneID,
			WasLive:      was,
		}); err != nil {
			t.Fatal(err)
		}
	}
	mustUpsert(orphan, true, "p_ghost")
	mustUpsert(stillRunning, true, pane.ID)
	mustUpsert(closed, false, "p_gone")

	r, err := nethttp.Get(srv.URL + "/restore-candidates")
	if err != nil {
		t.Fatal(err)
	}
	var resp proto.RestoreCandidatesResponse
	json.NewDecoder(r.Body).Decode(&resp)
	if len(resp.Candidates) != 1 {
		t.Fatalf("want 1 group, got %d: %+v", len(resp.Candidates), resp.Candidates)
	}
	g := resp.Candidates[0]
	if g.ProjectID != "p1" {
		t.Errorf("ProjectID = %q, want p1", g.ProjectID)
	}
	if len(g.Sessions) != 1 {
		t.Fatalf("want 1 session, got %d: %+v", len(g.Sessions), g.Sessions)
	}
	if g.Sessions[0].SessionID != orphan {
		t.Errorf("SessionID = %q, want orphan %q", g.Sessions[0].SessionID, orphan)
	}
}

func TestDismissSessions_clearsWasLive(t *testing.T) {
	fakeHome := t.TempDir()
	t.Setenv("HOME", fakeHome)
	s, store, projectCwd := newServerWithSessions(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	transcriptDir := filepath.Join(fakeHome, ".claude", "projects", sessions.EncodeCwd(projectCwd))
	if err := os.MkdirAll(transcriptDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sid1 := sessions.NewUUID()
	sid2 := sessions.NewUUID()
	for _, sid := range []string{sid1, sid2} {
		_ = os.WriteFile(filepath.Join(transcriptDir, sid+".jsonl"), []byte("{}"), 0o600)
		if err := store.Upsert("p1", sessions.Entry{
			SessionID:    sid,
			Cwd:          projectCwd,
			CreatedAt:    time.Now().UTC(),
			LastActiveAt: time.Now().UTC(),
			WasLive:      true,
		}); err != nil {
			t.Fatal(err)
		}
	}
	body, _ := json.Marshal(proto.DismissSessionsRequest{SessionIDs: []string{sid1, sid2}})
	r, err := nethttp.Post(srv.URL+"/projects/p1/sessions/dismiss", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 {
		t.Fatalf("status = %d", r.StatusCode)
	}
	var resp proto.DismissSessionsResponse
	json.NewDecoder(r.Body).Decode(&resp)
	if resp.Dismissed != 2 {
		t.Errorf("Dismissed = %d, want 2", resp.Dismissed)
	}
	for _, sid := range []string{sid1, sid2} {
		e, _, _ := store.Get("p1", sid)
		if e.WasLive {
			t.Errorf("session %s still WasLive after dismiss", sid)
		}
	}
}

func TestDismissSessions_unknownProject404s(t *testing.T) {
	s, _, _ := newServerWithSessions(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()
	body, _ := json.Marshal(proto.DismissSessionsRequest{SessionIDs: []string{"x"}})
	r, err := nethttp.Post(srv.URL+"/projects/nope/sessions/dismiss", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 404 {
		t.Fatalf("want 404, got %d", r.StatusCode)
	}
}

func TestCreatePane_resumeSessionID_happyPath(t *testing.T) {
	s, store, projectCwd := newServerWithSessions(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()
	sid := sessions.NewUUID()
	now := time.Now().UTC()
	if err := store.Upsert("p1", sessions.Entry{
		SessionID:    sid,
		Name:         "p1/resumed",
		Cwd:          projectCwd,
		CreatedAt:    now,
		LastActiveAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(proto.CreatePaneRequest{
		Kind:            proto.PaneKindClaude,
		ResumeSessionID: sid,
	})
	r, err := nethttp.Post(srv.URL+"/projects/p1/panes", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 {
		t.Fatalf("status = %d", r.StatusCode)
	}
	var cr proto.CreatePaneResponse
	json.NewDecoder(r.Body).Decode(&cr)
	if cr.PaneID == "" {
		t.Fatal("no pane_id returned")
	}
	// ProjectDetail should surface the session id back on the pane row.
	r2, _ := nethttp.Get(srv.URL + "/projects/p1")
	var detail proto.ProjectDetail
	json.NewDecoder(r2.Body).Decode(&detail)
	found := false
	for _, p := range detail.Panes {
		if p.ID == cr.PaneID {
			found = true
			if p.SessionID != sid {
				t.Errorf("pane.SessionID = %q, want %q", p.SessionID, sid)
			}
		}
	}
	if !found {
		t.Fatalf("resumed pane %s not in project detail", cr.PaneID)
	}
	s.Manager.DeletePane("p1", cr.PaneID)
	// Let the waitLoop → OnExit → Touch goroutine settle before
	// t.TempDir cleanup runs; otherwise we log a harmless rename EEXIST.
	time.Sleep(50 * time.Millisecond)
}

// TestRestoreCandidates_includesShellEntries covers the Scope B
// widening of /restore-candidates: both Claude (SessionID) and shell
// (SlotID) entries appear in one group, with Kind propagated so the
// client can branch to createPane(shell, {restore_slot_id}) vs
// createPane(claude, {resume_session_id}).
func TestRestoreCandidates_includesShellEntries(t *testing.T) {
	fakeHome := t.TempDir()
	t.Setenv("HOME", fakeHome)
	s, store, projectCwd := newServerWithSessions(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	// A Claude transcript on disk — required for the Claude entry to
	// surface. Shell entries skip that check entirely.
	transcriptDir := filepath.Join(fakeHome, ".claude", "projects", sessions.EncodeCwd(projectCwd))
	if err := os.MkdirAll(transcriptDir, 0o755); err != nil {
		t.Fatal(err)
	}
	claudeSID := sessions.NewUUID()
	_ = os.WriteFile(filepath.Join(transcriptDir, claudeSID+".jsonl"), []byte("{}"), 0o600)
	shellSlot := sessions.NewUUID()
	now := time.Now().UTC()
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindClaude,
		SessionID:    claudeSID,
		Cwd:          projectCwd,
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "p_claude_gone",
		WasLive:      true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindShell,
		SlotID:       shellSlot,
		Cwd:          projectCwd,
		ShellArgv:    []string{"/bin/sh", "-l"},
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "p_shell_gone",
		WasLive:      true,
	}); err != nil {
		t.Fatal(err)
	}

	// Post-Scope-B Satellite sends `?kinds=claude,shell` to opt into
	// shell rows. Without the opt-in the endpoint returns Claude-only
	// (see TestRestoreCandidates_kindsOptInHidesShellByDefault).
	r, err := nethttp.Get(srv.URL + "/restore-candidates?kinds=claude,shell")
	if err != nil {
		t.Fatal(err)
	}
	var resp proto.RestoreCandidatesResponse
	json.NewDecoder(r.Body).Decode(&resp)
	if len(resp.Candidates) != 1 {
		t.Fatalf("want 1 group, got %d: %+v", len(resp.Candidates), resp.Candidates)
	}
	g := resp.Candidates[0]
	if len(g.Sessions) != 2 {
		t.Fatalf("want 2 sessions (claude+shell), got %d: %+v", len(g.Sessions), g.Sessions)
	}
	var sawClaude, sawShell bool
	for _, s := range g.Sessions {
		switch s.Kind {
		case proto.PaneKindClaude:
			sawClaude = true
			if s.SessionID != claudeSID {
				t.Errorf("claude SessionID drift: %q want %q", s.SessionID, claudeSID)
			}
			if s.SlotID != "" {
				t.Errorf("claude SlotID should be empty, got %q", s.SlotID)
			}
		case proto.PaneKindShell:
			sawShell = true
			if s.SlotID != shellSlot {
				t.Errorf("shell SlotID drift: %q want %q", s.SlotID, shellSlot)
			}
			if s.SessionID != "" {
				t.Errorf("shell SessionID should be empty, got %q", s.SessionID)
			}
		}
	}
	if !sawClaude || !sawShell {
		t.Fatalf("missing kind in response: claude=%v shell=%v", sawClaude, sawShell)
	}
}

// TestRestoreCandidates_kindsOptInHidesShellByDefault is the
// back-compat pair: an old Satellite (no ?kinds= param) hitting a
// post-Scope-B daemon must see only Claude rows, never shell. Without
// this the old renderer crashes on `s.session_id.slice(0,8)`.
// (Codex HIGH #3.)
func TestRestoreCandidates_kindsOptInHidesShellByDefault(t *testing.T) {
	fakeHome := t.TempDir()
	t.Setenv("HOME", fakeHome)
	s, store, projectCwd := newServerWithSessions(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	transcriptDir := filepath.Join(fakeHome, ".claude", "projects", sessions.EncodeCwd(projectCwd))
	_ = os.MkdirAll(transcriptDir, 0o755)
	claudeSID := sessions.NewUUID()
	_ = os.WriteFile(filepath.Join(transcriptDir, claudeSID+".jsonl"), []byte("{}"), 0o600)
	shellSlot := sessions.NewUUID()
	now := time.Now().UTC()
	_ = store.Upsert("p1", sessions.Entry{
		Kind: proto.PaneKindClaude, SessionID: claudeSID, Cwd: projectCwd,
		CreatedAt: now, LastActiveAt: now, LastPaneID: "p_c_gone", WasLive: true,
	})
	_ = store.Upsert("p1", sessions.Entry{
		Kind: proto.PaneKindShell, SlotID: shellSlot, Cwd: projectCwd,
		ShellArgv: []string{"/bin/sh"},
		CreatedAt: now, LastActiveAt: now, LastPaneID: "p_s_gone", WasLive: true,
	})

	// No ?kinds= param → legacy Claude-only response.
	r, _ := nethttp.Get(srv.URL + "/restore-candidates")
	var resp proto.RestoreCandidatesResponse
	json.NewDecoder(r.Body).Decode(&resp)
	if len(resp.Candidates) != 1 {
		t.Fatalf("want 1 group, got %d", len(resp.Candidates))
	}
	g := resp.Candidates[0]
	if len(g.Sessions) != 1 {
		t.Fatalf("want 1 Claude-only session, got %d: %+v", len(g.Sessions), g.Sessions)
	}
	if g.Sessions[0].Kind != proto.PaneKindClaude {
		t.Errorf("default response must be Claude-only, got kind=%q", g.Sessions[0].Kind)
	}
	if g.Sessions[0].SessionID != claudeSID {
		t.Errorf("SessionID drift: %q want %q", g.Sessions[0].SessionID, claudeSID)
	}

	// `?kinds=shell` returns shell-only.
	r2, _ := nethttp.Get(srv.URL + "/restore-candidates?kinds=shell")
	var resp2 proto.RestoreCandidatesResponse
	json.NewDecoder(r2.Body).Decode(&resp2)
	if len(resp2.Candidates) != 1 || len(resp2.Candidates[0].Sessions) != 1 {
		t.Fatalf("shell-only want 1 session, got %+v", resp2.Candidates)
	}
	if resp2.Candidates[0].Sessions[0].Kind != proto.PaneKindShell {
		t.Errorf("shell-only kind = %q", resp2.Candidates[0].Sessions[0].Kind)
	}

	// `?kinds=claude` is identical to the default.
	r3, _ := nethttp.Get(srv.URL + "/restore-candidates?kinds=claude")
	var resp3 proto.RestoreCandidatesResponse
	json.NewDecoder(r3.Body).Decode(&resp3)
	if len(resp3.Candidates) != 1 || len(resp3.Candidates[0].Sessions) != 1 {
		t.Fatalf("claude-explicit want 1 session, got %+v", resp3.Candidates)
	}

	// Unknown tokens fall back to Claude-only rather than returning
	// zero rows for every project.
	r4, _ := nethttp.Get(srv.URL + "/restore-candidates?kinds=unknown,alsofake")
	var resp4 proto.RestoreCandidatesResponse
	json.NewDecoder(r4.Body).Decode(&resp4)
	if len(resp4.Candidates) != 1 || len(resp4.Candidates[0].Sessions) != 1 {
		t.Fatalf("unknown-kinds fallback want 1 session, got %+v", resp4.Candidates)
	}
	if resp4.Candidates[0].Sessions[0].Kind != proto.PaneKindClaude {
		t.Errorf("unknown-kinds fallback should default to Claude, got %q", resp4.Candidates[0].Sessions[0].Kind)
	}
}

// TestListSessions_omitsShellEntries ensures /projects/:id/sessions
// stays Claude-only regardless of what's in the store. The endpoint
// drives the Claude-resume picker; shell rows there would crash the
// pre-Scope-B renderer (s.session_id.slice(0,8)). (Codex HIGH #3.)
func TestListSessions_omitsShellEntries(t *testing.T) {
	fakeHome := t.TempDir()
	t.Setenv("HOME", fakeHome)
	s, store, projectCwd := newServerWithSessions(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	transcriptDir := filepath.Join(fakeHome, ".claude", "projects", sessions.EncodeCwd(projectCwd))
	_ = os.MkdirAll(transcriptDir, 0o755)
	claudeSID := sessions.NewUUID()
	_ = os.WriteFile(filepath.Join(transcriptDir, claudeSID+".jsonl"), []byte("{}"), 0o600)
	shellSlot := sessions.NewUUID()
	now := time.Now().UTC()
	_ = store.Upsert("p1", sessions.Entry{
		Kind: proto.PaneKindClaude, SessionID: claudeSID, Name: "claude-row",
		Cwd: projectCwd, CreatedAt: now, LastActiveAt: now,
	})
	_ = store.Upsert("p1", sessions.Entry{
		Kind: proto.PaneKindShell, SlotID: shellSlot, Name: "shell-row",
		Cwd: projectCwd, ShellArgv: []string{"/bin/sh"}, CreatedAt: now, LastActiveAt: now,
	})

	r, _ := nethttp.Get(srv.URL + "/projects/p1/sessions")
	var resp proto.SessionsListResponse
	json.NewDecoder(r.Body).Decode(&resp)
	if len(resp.Sessions) != 1 {
		t.Fatalf("want 1 Claude-only session, got %d: %+v", len(resp.Sessions), resp.Sessions)
	}
	if resp.Sessions[0].SessionID != claudeSID {
		t.Errorf("/sessions returned wrong row: %+v", resp.Sessions[0])
	}
	for _, row := range resp.Sessions {
		if row.Kind == proto.PaneKindShell {
			t.Errorf("/sessions must not include shell rows; got %+v", row)
		}
	}
}

// TestRestoreCandidates_driveByLastPaneIDEmptyGuard locks in an earlier-release behavior (Scope B)
// Scope B drive-by fix: a WasLive entry with LastPaneID=="" must not
// be offered for restore, because no pane ever claimed it and
// "restoring" would spawn a duplicate. Before the guard, the
// livePaneIDs[""] lookup returned false and the entry slipped through.
func TestRestoreCandidates_driveByLastPaneIDEmptyGuard(t *testing.T) {
	fakeHome := t.TempDir()
	t.Setenv("HOME", fakeHome)
	s, store, projectCwd := newServerWithSessions(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	transcriptDir := filepath.Join(fakeHome, ".claude", "projects", sessions.EncodeCwd(projectCwd))
	_ = os.MkdirAll(transcriptDir, 0o755)
	sid := sessions.NewUUID()
	_ = os.WriteFile(filepath.Join(transcriptDir, sid+".jsonl"), []byte("{}"), 0o600)
	now := time.Now().UTC()
	// WasLive + empty LastPaneID — the pathological case the guard targets.
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindClaude,
		SessionID:    sid,
		Cwd:          projectCwd,
		CreatedAt:    now,
		LastActiveAt: now,
		WasLive:      true,
		// LastPaneID intentionally empty.
	}); err != nil {
		t.Fatal(err)
	}

	r, err := nethttp.Get(srv.URL + "/restore-candidates")
	if err != nil {
		t.Fatal(err)
	}
	var resp proto.RestoreCandidatesResponse
	json.NewDecoder(r.Body).Decode(&resp)
	// The entry must NOT appear. Either the group is empty or the whole
	// response has zero groups; both shapes count as passing the guard.
	for _, g := range resp.Candidates {
		for _, s := range g.Sessions {
			if s.SessionID == sid {
				t.Fatalf("entry with empty LastPaneID should be filtered out, got %+v", s)
			}
		}
	}
}

// TestCreatePane_restoreSlotID_happyPath is the HTTP-level Scope B
// contract: POST /projects/:id/panes with Kind=shell + RestoreSlotID
// spawns a shell pane that carries the same SlotID on the subsequent
// ProjectDetail poll.
func TestCreatePane_restoreSlotID_happyPath(t *testing.T) {
	s, store, projectCwd := newServerWithSessions(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	slot := sessions.NewUUID()
	now := time.Now().UTC()
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindShell,
		SlotID:       slot,
		Cwd:          projectCwd,
		ShellArgv:    []string{"/bin/sh"},
		CreatedAt:    now,
		LastActiveAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(proto.CreatePaneRequest{
		Kind:          proto.PaneKindShell,
		RestoreSlotID: slot,
	})
	r, err := nethttp.Post(srv.URL+"/projects/p1/panes", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 {
		t.Fatalf("status = %d", r.StatusCode)
	}
	var cr proto.CreatePaneResponse
	json.NewDecoder(r.Body).Decode(&cr)

	r2, _ := nethttp.Get(srv.URL + "/projects/p1")
	var detail proto.ProjectDetail
	json.NewDecoder(r2.Body).Decode(&detail)
	found := false
	for _, p := range detail.Panes {
		if p.ID == cr.PaneID {
			found = true
			if p.SlotID != slot {
				t.Errorf("pane.SlotID = %q, want %q", p.SlotID, slot)
			}
			if p.Kind != proto.PaneKindShell {
				t.Errorf("pane.Kind = %q, want shell", p.Kind)
			}
		}
	}
	if !found {
		t.Fatal("restored shell pane missing from ProjectDetail")
	}
	s.Manager.DeletePane("p1", cr.PaneID)
	time.Sleep(50 * time.Millisecond)
}

// TestCreatePane_restoreSlotID_unknown400s: an unknown slot rejects
// with 400 like the Claude resume guard.
func TestCreatePane_restoreSlotID_unknown400s(t *testing.T) {
	s, _, _ := newServerWithSessions(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()
	body, _ := json.Marshal(proto.CreatePaneRequest{
		Kind:          proto.PaneKindShell,
		RestoreSlotID: sessions.NewUUID(),
	})
	r, err := nethttp.Post(srv.URL+"/projects/p1/panes", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 400 {
		t.Fatalf("want 400 for unknown slot, got %d", r.StatusCode)
	}
}

// TestCreatePane_restoreSlotID_liveSlot409s is the HTTP-level map of
// Codex HIGH #2: a RestoreSlotID naming a slot already attached to a
// running pane returns 409 Conflict (not 400). Pairs with the pty-
// layer TestCreatePaneWith_restoreSlotID_liveSlotRejected.
func TestCreatePane_restoreSlotID_liveSlot409s(t *testing.T) {
	s, _, _ := newServerWithSessions(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	// Spawn a shell pane first; grab its SlotID.
	pane, err := s.Manager.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = s.Manager.DeletePane("p1", pane.ID)
		time.Sleep(50 * time.Millisecond)
	})
	if pane.SlotID == "" {
		t.Fatal("live shell pane must have a SlotID")
	}

	body, _ := json.Marshal(proto.CreatePaneRequest{
		Kind:          proto.PaneKindShell,
		RestoreSlotID: pane.SlotID,
	})
	r, err := nethttp.Post(srv.URL+"/projects/p1/panes", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 409 {
		t.Fatalf("want 409 Conflict for live-slot restore, got %d", r.StatusCode)
	}
}

// TestRenamePane_shellPane covers the rename-endpoint drive-by fix
// through its HTTP surface: before Scope B this returned 400 ("only
// claude panes can be renamed persistently"); now it round-trips
// through store keyed by SlotID.
func TestRenamePane_shellPane(t *testing.T) {
	s, _, _ := newServerWithSessions(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	// Spawn a fresh shell pane directly via the manager so we have its
	// SlotID + ID. HTTP path exercised below.
	pane, err := s.Manager.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = s.Manager.DeletePane("p1", pane.ID)
		time.Sleep(50 * time.Millisecond)
	})

	body, _ := json.Marshal(proto.RenameRequest{DisplayName: "renamed-shell"})
	r, err := nethttp.Post(
		srv.URL+"/projects/p1/panes/"+pane.ID+"/rename",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 {
		buf, _ := io.ReadAll(r.Body)
		t.Fatalf("status = %d, body=%q", r.StatusCode, string(buf))
	}

	// The persisted Entry carries the new label.
	e, ok, _ := s.Manager.Sessions().Get("p1", pane.SlotID)
	if !ok {
		t.Fatal("session entry missing after shell rename")
	}
	if e.DisplayName != "renamed-shell" {
		t.Fatalf("persisted DisplayName = %q, want renamed-shell", e.DisplayName)
	}

	// And /projects/p1 surfaces it back on the pane row so another
	// client can pick it up without knowing about SlotID.
	r2, _ := nethttp.Get(srv.URL + "/projects/p1")
	var detail proto.ProjectDetail
	json.NewDecoder(r2.Body).Decode(&detail)
	found := false
	for _, p := range detail.Panes {
		if p.ID == pane.ID {
			found = true
			if p.DisplayName != "renamed-shell" {
				t.Errorf("detail DisplayName = %q, want renamed-shell", p.DisplayName)
			}
			if p.SlotID != pane.SlotID {
				t.Errorf("detail SlotID = %q, want %q", p.SlotID, pane.SlotID)
			}
		}
	}
	if !found {
		t.Fatal("shell pane missing from ProjectDetail")
	}
}

// TestCreatePane_globalPreamble_flowsThroughHandler confirms a
// global_preamble in the createPane request body reaches the spawned
// Claude argv (baseline disabled so the marker is the only preamble).
func TestCreatePane_globalPreamble_flowsThroughHandler(t *testing.T) {
	t.Setenv("RECK_DISABLE_BASELINE_PREAMBLE", "1")
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	const marker = "RECK_GLOBAL_MARKER_http_handler_test"
	body, _ := json.Marshal(proto.CreatePaneRequest{
		Kind:           proto.PaneKindClaude,
		GlobalPreamble: marker,
	})
	r, err := nethttp.Post(srv.URL+"/projects/p1/panes", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 {
		buf, _ := io.ReadAll(r.Body)
		t.Fatalf("createPane status = %d, body=%q", r.StatusCode, string(buf))
	}
	var cr proto.CreatePaneResponse
	if err := json.NewDecoder(r.Body).Decode(&cr); err != nil {
		t.Fatal(err)
	}
	if cr.PaneID == "" {
		t.Fatal("no pane_id returned")
	}

	pane, ok := s.Manager.PaneByID(cr.PaneID)
	if !ok {
		t.Fatalf("PaneByID(%q) not found", cr.PaneID)
	}
	defer s.Manager.DeletePane("p1", cr.PaneID)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		tail := string(pane.ReplayTail(2048))
		if strings.Contains(tail, "--append-system-prompt") && strings.Contains(tail, marker) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("expected %s in --append-system-prompt argv; tail=%q", marker, string(pane.ReplayTail(2048)))
}
