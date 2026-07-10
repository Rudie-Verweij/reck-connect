package http

import (
	"bytes"
	"encoding/json"
	"fmt"
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

	"github.com/rudie-verweij/reck-connect/daemon/internal/agent"
	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/daemon/internal/pty"
	"github.com/rudie-verweij/reck-connect/daemon/internal/ws"
	"github.com/rudie-verweij/reck-connect/proto"
)

// newLocalServer wires a Server with mode=local + a tmp permitted prefix
// so PUT /projects exercises the local-mode acceptance path. Returns the
// server and the prefix the test should anchor cwds under.
func newLocalServer(t *testing.T) (*Server, string) {
	t.Helper()
	ensureTestDaemonToken(t)
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	prefix := filepath.Join(dir, "permitted")
	if err := os.MkdirAll(prefix, 0o755); err != nil {
		t.Fatal(err)
	}
	mgr := pty.NewManagerFromConfig(pty.ManagerConfig{
		ClaudeCmd:              []string{"/bin/echo", "claude-placeholder"},
		DefaultShell:           []string{"/bin/sh"},
		ConfigPath:             configPath,
		Mode:                   agent.ModeLocal,
		PermittedProjectPrefix: prefix,
	})
	return &Server{
		Manager:   mgr,
		WS:        &ws.Handler{Manager: mgr, Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))},
		StartedAt: time.Now(),
		Version:   "test",
	}, prefix
}

// newStationServer wires a Server with mode=station so PUT /projects
// exercises the 409 rejection path.
func newStationServer(t *testing.T) *Server {
	t.Helper()
	ensureTestDaemonToken(t)
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := pty.NewManagerFromConfig(pty.ManagerConfig{
		Projects:     []config.Project{{ID: "from-toml", Name: "From TOML", Cwd: dir, DefaultPane: "shell", Shell: []string{"/bin/sh"}, Available: true}},
		ClaudeCmd:    []string{"/bin/echo", "claude-placeholder"},
		DefaultShell: []string{"/bin/sh"},
		ConfigPath:   configPath,
		Mode:         agent.ModeStation,
	})
	return &Server{
		Manager:   mgr,
		WS:        &ws.Handler{Manager: mgr, Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))},
		StartedAt: time.Now(),
		Version:   "test",
	}
}

func putBody(t *testing.T, payload any) []byte {
	t.Helper()
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// putReq builds a PUT request with optional bearer.
func putReq(t *testing.T, url string, body []byte, bearer string) *nethttp.Request {
	t.Helper()
	req, err := nethttp.NewRequest(nethttp.MethodPut, url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	return req
}

// TestPutProjects_modeGate_localAccepts confirms the local-mode daemon
// accepts the wholesale push, replaces the project map, and the new
// state shows up via GET /projects.
func TestPutProjects_modeGate_localAccepts(t *testing.T) {
	s, prefix := newLocalServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	cwd := filepath.Join(prefix, "alpha")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	body := putBody(t, []proto.PutProjectsEntry{{ID: "alpha", Cwd: cwd}})

	resp, err := nethttp.DefaultClient.Do(putReq(t, srv.URL+"/projects", body, ""))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("PUT /projects: status=%d body=%q", resp.StatusCode, string(raw))
	}
	var pr proto.PutProjectsResponse
	if err := json.NewDecoder(resp.Body).Decode(&pr); err != nil {
		t.Fatal(err)
	}
	if !pr.Ok || pr.Count != 1 {
		t.Fatalf("response: %+v", pr)
	}

	// GET /projects must now show alpha.
	g, err := nethttp.Get(srv.URL + "/projects")
	if err != nil {
		t.Fatal(err)
	}
	defer g.Body.Close()
	var lst proto.ProjectsListResponse
	json.NewDecoder(g.Body).Decode(&lst)
	if len(lst.Projects) != 1 || lst.Projects[0].ID != "alpha" {
		t.Fatalf("after PUT: GET /projects = %+v", lst.Projects)
	}
}

// TestPutProjects_modeGate_stationRejects pins the 409 error string the
// renderer keys off — this is a contract.
func TestPutProjects_modeGate_stationRejects(t *testing.T) {
	s := newStationServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	body := putBody(t, []proto.PutProjectsEntry{})
	resp, err := nethttp.DefaultClient.Do(putReq(t, srv.URL+"/projects", body, ""))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != nethttp.StatusConflict {
		t.Fatalf("station mode: status=%d, want 409", resp.StatusCode)
	}
	raw, _ := io.ReadAll(resp.Body)
	got := strings.TrimSpace(string(raw))
	want := "PUT /projects not allowed in station mode (projects.toml is authoritative)"
	if got != want {
		t.Fatalf("error body:\n  got:  %q\n  want: %q", got, want)
	}

	// Sanity: station's projects.toml-sourced project remains untouched.
	g, _ := nethttp.Get(srv.URL + "/projects")
	defer g.Body.Close()
	var lst proto.ProjectsListResponse
	json.NewDecoder(g.Body).Decode(&lst)
	if len(lst.Projects) != 1 || lst.Projects[0].ID != "from-toml" {
		t.Fatalf("station-mode rejection must not mutate state; got %+v", lst.Projects)
	}
}

// TestPutProjects_authRequired covers the three auth states: no token,
// wrong token, correct token.
func TestPutProjects_authRequired(t *testing.T) {
	t.Setenv("DAEMON_TOKEN", "expected-token-long-enough-to-matter")
	s, prefix := newLocalServer(t)
	// Bypass newTestHandler: the "no token" subcase needs to reach
	// authMiddleware with no Authorization header set.
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	cwd := filepath.Join(prefix, "alpha")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	body := putBody(t, []proto.PutProjectsEntry{{ID: "alpha", Cwd: cwd}})

	cases := []struct {
		name   string
		bearer string
		want   int
	}{
		{"no token", "", nethttp.StatusUnauthorized},
		{"wrong token", "obviously-not-it", nethttp.StatusUnauthorized},
		{"correct token", "expected-token-long-enough-to-matter", 200},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resp, err := nethttp.DefaultClient.Do(putReq(t, srv.URL+"/projects", body, c.bearer))
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != c.want {
				t.Errorf("status=%d, want %d", resp.StatusCode, c.want)
			}
		})
	}
}

// TestPutProjects_emptyListDropsState confirms the wholesale-replace
// semantics: an empty array drops every entry, and the daemon reports
// it via GET /projects.
func TestPutProjects_emptyListDropsState(t *testing.T) {
	s, prefix := newLocalServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	// Seed two projects.
	a := filepath.Join(prefix, "alpha")
	b := filepath.Join(prefix, "beta")
	for _, d := range []string{a, b} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	body := putBody(t, []proto.PutProjectsEntry{{ID: "alpha", Cwd: a}, {ID: "beta", Cwd: b}})
	r1, err := nethttp.DefaultClient.Do(putReq(t, srv.URL+"/projects", body, ""))
	if err != nil {
		t.Fatal(err)
	}
	r1.Body.Close()
	if r1.StatusCode != 200 {
		t.Fatalf("seed: status=%d", r1.StatusCode)
	}

	// Now drop everything.
	resp, err := nethttp.DefaultClient.Do(putReq(t, srv.URL+"/projects", []byte("[]"), ""))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("drop: status=%d body=%q", resp.StatusCode, string(raw))
	}
	var pr proto.PutProjectsResponse
	json.NewDecoder(resp.Body).Decode(&pr)
	if !pr.Ok || pr.Count != 0 {
		t.Fatalf("drop response: %+v", pr)
	}
	g, _ := nethttp.Get(srv.URL + "/projects")
	defer g.Body.Close()
	var lst proto.ProjectsListResponse
	json.NewDecoder(g.Body).Decode(&lst)
	if len(lst.Projects) != 0 {
		t.Fatalf("after drop: GET /projects = %+v", lst.Projects)
	}
}

// TestPutProjects_acceptsObjectFormToo confirms both wire shapes round-
// trip — the bare-array form (what the renderer sends) and the wrapped
// form (future-proof).
func TestPutProjects_acceptsObjectFormToo(t *testing.T) {
	s, prefix := newLocalServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()
	cwd := filepath.Join(prefix, "alpha")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	body := putBody(t, proto.PutProjectsRequest{
		Projects: []proto.PutProjectsEntry{{ID: "alpha", Cwd: cwd}},
	})
	resp, err := nethttp.DefaultClient.Do(putReq(t, srv.URL+"/projects", body, ""))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("object form: status=%d", resp.StatusCode)
	}
}

// TestPutProjects_validationRejects exercises every malformed-payload
// branch through the HTTP layer end-to-end, asserting a 400 + the
// generic "payload rejected" preamble.
func TestPutProjects_validationRejects(t *testing.T) {
	s, prefix := newLocalServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()
	valid := filepath.Join(prefix, "valid")
	if err := os.MkdirAll(valid, 0o755); err != nil {
		t.Fatal(err)
	}

	// Build the escaping-symlink case once; the rest are pure path strings.
	outsideRoot := t.TempDir()
	outsideTarget := filepath.Join(outsideRoot, "leak")
	if err := os.MkdirAll(outsideTarget, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(prefix, "linked")
	if err := os.Symlink(outsideTarget, link); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name   string
		body   []byte
		want   int
		substr string
	}{
		{
			name:   "relative path",
			body:   putBody(t, []proto.PutProjectsEntry{{ID: "ok", Cwd: "relative/x"}}),
			want:   400,
			substr: "absolute path",
		},
		{
			name:   "outside prefix",
			body:   putBody(t, []proto.PutProjectsEntry{{ID: "ok", Cwd: "/etc"}}),
			want:   400,
			substr: "permitted prefix",
		},
		{
			name:   "traversal segment",
			body:   putBody(t, []proto.PutProjectsEntry{{ID: "ok", Cwd: filepath.Join(prefix, "x", "..", "..", "etc")}}),
			want:   400,
			substr: "permitted prefix",
		},
		{
			name:   "escaping symlink",
			body:   putBody(t, []proto.PutProjectsEntry{{ID: "ok", Cwd: link}}),
			want:   400,
			substr: "symlink",
		},
		{
			name:   "missing id",
			body:   putBody(t, []proto.PutProjectsEntry{{ID: "", Cwd: valid}}),
			want:   400,
			substr: "id is required",
		},
		{
			name:   "missing cwd",
			body:   putBody(t, []proto.PutProjectsEntry{{ID: "ok", Cwd: ""}}),
			want:   400,
			substr: "cwd is required",
		},
		{
			name:   "duplicate id",
			body:   putBody(t, []proto.PutProjectsEntry{{ID: "dup", Cwd: valid}, {ID: "dup", Cwd: valid}}),
			want:   400,
			substr: "duplicate id",
		},
		{
			name:   "garbage body",
			body:   []byte("not json at all"),
			want:   400,
			substr: "invalid request body",
		},
		{
			name:   "empty body",
			body:   []byte(""),
			want:   400,
			substr: "request body is empty",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resp, err := nethttp.DefaultClient.Do(putReq(t, srv.URL+"/projects", c.body, ""))
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != c.want {
				raw, _ := io.ReadAll(resp.Body)
				t.Fatalf("status=%d, want %d (body=%q)", resp.StatusCode, c.want, string(raw))
			}
			raw, _ := io.ReadAll(resp.Body)
			if !strings.Contains(string(raw), c.substr) {
				t.Errorf("response body must contain %q; got %q", c.substr, string(raw))
			}
			// Validation rejection must not leave half-applied state.
			g, _ := nethttp.Get(srv.URL + "/projects")
			var lst proto.ProjectsListResponse
			json.NewDecoder(g.Body).Decode(&lst)
			g.Body.Close()
			if len(lst.Projects) != 0 {
				t.Errorf("rejection should not mutate state; got %+v", lst.Projects)
			}
		})
	}
}

// TestPutProjects_missingCwdRegistersUnavailable: the Phase 7 semantics
// flow through here — a missing cwd is registered with Available=false
// instead of rejecting the whole payload.
func TestPutProjects_missingCwdRegistersUnavailable(t *testing.T) {
	s, prefix := newLocalServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()
	missing := filepath.Join(prefix, "never-existed")
	body := putBody(t, []proto.PutProjectsEntry{{ID: "ghost", Cwd: missing}})
	resp, err := nethttp.DefaultClient.Do(putReq(t, srv.URL+"/projects", body, ""))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d, want 200 (missing cwd → registered+unavailable, not reject); body=%q", resp.StatusCode, string(raw))
	}
	g, _ := nethttp.Get(srv.URL + "/projects")
	defer g.Body.Close()
	var lst proto.ProjectsListResponse
	json.NewDecoder(g.Body).Decode(&lst)
	if len(lst.Projects) != 1 {
		t.Fatalf("want 1 registered project, got %+v", lst.Projects)
	}
	if lst.Projects[0].Available {
		t.Fatalf("missing cwd: want Available=false, got true")
	}
}

// TestPutProjects_concurrentSerialize spawns N goroutines hammering
// PUT /projects with different payloads. The final state must be one of
// the input payloads verbatim, not interleaved garbage.
func TestPutProjects_concurrentSerialize(t *testing.T) {
	s, prefix := newLocalServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	const n = 6
	bodies := make([][]byte, n)
	for i := 0; i < n; i++ {
		idA := fmt.Sprintf("p%d-a", i)
		idB := fmt.Sprintf("p%d-b", i)
		for _, id := range []string{idA, idB} {
			if err := os.MkdirAll(filepath.Join(prefix, id), 0o755); err != nil {
				t.Fatal(err)
			}
		}
		bodies[i] = putBody(t, []proto.PutProjectsEntry{
			{ID: idA, Cwd: filepath.Join(prefix, idA)},
			{ID: idB, Cwd: filepath.Join(prefix, idB)},
		})
	}

	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		i := i
		go func() {
			defer wg.Done()
			resp, err := nethttp.DefaultClient.Do(putReq(t, srv.URL+"/projects", bodies[i], ""))
			if err != nil {
				t.Errorf("payload %d: %v", i, err)
				return
			}
			resp.Body.Close()
			if resp.StatusCode != 200 {
				t.Errorf("payload %d: status=%d", i, resp.StatusCode)
			}
		}()
	}
	wg.Wait()

	g, _ := nethttp.Get(srv.URL + "/projects")
	defer g.Body.Close()
	var lst proto.ProjectsListResponse
	json.NewDecoder(g.Body).Decode(&lst)
	if len(lst.Projects) != 2 {
		t.Fatalf("want 2 projects (one payload's worth), got %d: %+v", len(lst.Projects), lst.Projects)
	}
	gotIDs := []string{lst.Projects[0].ID, lst.Projects[1].ID}
	matched := false
	for i := 0; i < n; i++ {
		idA := fmt.Sprintf("p%d-a", i)
		idB := fmt.Sprintf("p%d-b", i)
		if (gotIDs[0] == idA && gotIDs[1] == idB) || (gotIDs[0] == idB && gotIDs[1] == idA) {
			matched = true
			break
		}
	}
	if !matched {
		t.Fatalf("final state %v matches no input payload — interleaved replace?", gotIDs)
	}
}
