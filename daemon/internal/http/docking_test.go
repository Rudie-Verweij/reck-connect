package http

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rudie-verweij/reck-connect/proto"
)

func TestDockAndUndockProject(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	// Create a project.
	body, _ := json.Marshal(proto.AddProjectRequest{Name: "Dockable", Cwd: t.TempDir()})
	r, err := http.Post(srv.URL+"/projects", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 {
		t.Fatalf("create status %d", r.StatusCode)
	}
	var added proto.AddProjectResponse
	if err := json.NewDecoder(r.Body).Decode(&added); err != nil {
		t.Fatal(err)
	}
	if added.Project.Docked {
		t.Fatalf("new project should default to undocked, got %+v", added.Project)
	}

	// Dock.
	r2, err := http.Post(srv.URL+"/projects/"+added.Project.ID+"/dock", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	if r2.StatusCode != 200 {
		t.Fatalf("dock status %d", r2.StatusCode)
	}
	var dockResp proto.DockProjectResponse
	if err := json.NewDecoder(r2.Body).Decode(&dockResp); err != nil {
		t.Fatal(err)
	}
	if !dockResp.Docked {
		t.Fatalf("expected Docked=true, got %+v", dockResp)
	}

	// Listing reflects it.
	r3, err := http.Get(srv.URL + "/projects")
	if err != nil {
		t.Fatal(err)
	}
	var list proto.ProjectsListResponse
	if err := json.NewDecoder(r3.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, p := range list.Projects {
		if p.ID == added.Project.ID {
			found = true
			if !p.Docked {
				t.Fatalf("listing says Docked=false after dock: %+v", p)
			}
		}
	}
	if !found {
		t.Fatalf("project missing from listing")
	}

	// Undock.
	r4, err := http.Post(srv.URL+"/projects/"+added.Project.ID+"/undock", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	var undockResp proto.DockProjectResponse
	if err := json.NewDecoder(r4.Body).Decode(&undockResp); err != nil {
		t.Fatal(err)
	}
	if undockResp.Docked {
		t.Fatalf("expected Docked=false, got %+v", undockResp)
	}
}

func TestDockUnknownProject404s(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	r, err := http.Post(srv.URL+"/projects/does-not-exist/dock", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 404 {
		t.Fatalf("expected 404, got %d", r.StatusCode)
	}
}

func TestPaneInput_writesToStdin(t *testing.T) {
	s := newServerWithShellPanes(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPane(t, srv)

	payload, _ := json.Marshal(map[string]any{"text": "hello", "submit": false})
	r, err := http.Post(srv.URL+"/panes/"+paneID+"/input", "application/json", bytes.NewReader(payload))
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

	r, err := http.Get(srv.URL + "/panes/" + paneID + "/output?bytes=512")
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
	r, err := http.Post(srv.URL+"/projects", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var added proto.AddProjectResponse
	if err := json.NewDecoder(r.Body).Decode(&added); err != nil {
		t.Fatal(err)
	}

	paneBody, _ := json.Marshal(proto.CreatePaneRequest{Kind: proto.PaneKindShell})
	r2, err := http.Post(
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
