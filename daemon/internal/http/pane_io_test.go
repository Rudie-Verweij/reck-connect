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

	"github.com/rudie-verweij/reck-connect/daemon/internal/agent"
	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/daemon/internal/pty"
	"github.com/rudie-verweij/reck-connect/daemon/internal/ws"
	"github.com/rudie-verweij/reck-connect/proto"
)

func newPersistedStationServer(t *testing.T) (*Server, string) {
	t.Helper()
	ensureTestDaemonToken(t)
	dir := t.TempDir()
	cwd := filepath.Join(dir, "p-station")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := config.AppendProject(configPath, config.Project{
		ID:          "p-station",
		Name:        "Station Project",
		Cwd:         cwd,
		DefaultPane: "shell",
		Shell:       []string{"/bin/sh"},
	}); err != nil {
		t.Fatal(err)
	}
	registry, warnings, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 {
		t.Fatalf("config.Load warnings: %+v", warnings)
	}
	mgr := pty.NewManagerFromConfig(pty.ManagerConfig{
		Projects:     registry.Projects,
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
	}, configPath
}

func postProjectAction(t *testing.T, url string) {
	t.Helper()
	resp, err := nethttp.Post(url, "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != nethttp.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST %s: status=%d body=%q", url, resp.StatusCode, string(raw))
	}
}

func getProject(t *testing.T, baseURL string, id string) proto.Project {
	t.Helper()
	resp, err := nethttp.Get(baseURL + "/projects")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != nethttp.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("GET /projects: status=%d body=%q", resp.StatusCode, string(raw))
	}
	var list proto.ProjectsListResponse
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	for _, project := range list.Projects {
		if project.ID == id {
			return project
		}
	}
	t.Fatalf("project %q missing from GET /projects: %+v", id, list.Projects)
	return proto.Project{}
}

func TestPaneInput_writesToStdin(t *testing.T) {
	s := newServerWithShellPanes(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPane(t, srv)

	payload, _ := json.Marshal(map[string]any{"text": "hello", "submit": false})
	r, err := nethttp.Post(srv.URL+"/panes/"+paneID+"/input", "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 {
		t.Fatalf("input status %d", r.StatusCode)
	}
}

func TestPaneOutput_returnsReplayTail(t *testing.T) {
	s := newServerWithShellPanes(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPane(t, srv)

	r, err := nethttp.Get(srv.URL + "/panes/" + paneID + "/output?bytes=512")
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 {
		t.Fatalf("output status %d", r.StatusCode)
	}
	var resp map[string]any
	if err := json.NewDecoder(r.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp["pane_id"] != paneID {
		t.Fatalf("pane_id mismatch: %+v", resp)
	}
	if _, ok := resp["text"]; !ok {
		t.Fatalf("expected 'text' in response: %+v", resp)
	}
}

// newServerWithShellPanes returns a server whose manager can spawn shell
// panes — reuses the existing newServer helper which already wires a
// manager with `sh` + `echo` for claude.
func newServerWithShellPanes(t *testing.T) *Server { return newServer(t) }

// createShellPane creates a project via /projects then spawns a shell
// pane, returning the pane ID.
func createShellPane(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	body, _ := json.Marshal(proto.AddProjectRequest{Name: "ShellHost", Cwd: t.TempDir(), DefaultPane: "shell"})
	r, err := nethttp.Post(srv.URL+"/projects", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var added proto.AddProjectResponse
	if err := json.NewDecoder(r.Body).Decode(&added); err != nil {
		t.Fatal(err)
	}

	paneBody, _ := json.Marshal(proto.CreatePaneRequest{Kind: proto.PaneKindShell})
	r2, err := nethttp.Post(
		srv.URL+"/projects/"+added.Project.ID+"/panes",
		"application/json",
		bytes.NewReader(paneBody),
	)
	if err != nil {
		t.Fatal(err)
	}
	if r2.StatusCode != 200 {
		t.Fatalf("createPane status %d", r2.StatusCode)
	}
	var pane proto.CreatePaneResponse
	if err := json.NewDecoder(r2.Body).Decode(&pane); err != nil {
		t.Fatal(err)
	}
	return pane.PaneID
}
