package http

import (
	"bytes"
	"encoding/json"
	nethttp "net/http"
	"net/http/httptest"
	"testing"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/proto"
)

// TestArchiveUnarchiveProjectPersistsThroughHTTP drives the archive and
// unarchive endpoints end-to-end: the flag flips in the GET /projects view,
// the live panes are torn down, and the change is persisted to projects.toml.
// (Pane RE-spawn on unarchive needs a sessions store and is unit-tested at
// the manager layer; this test focuses on the endpoint plumbing.)
func TestArchiveUnarchiveProjectPersistsThroughHTTP(t *testing.T) {
	s, configPath := newPersistedStationServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	// Spawn a shell pane so archive has something to tear down.
	paneBody, _ := json.Marshal(proto.CreatePaneRequest{Kind: proto.PaneKindShell})
	pr, err := nethttp.Post(srv.URL+"/projects/p-station/panes", "application/json", bytes.NewReader(paneBody))
	if err != nil {
		t.Fatal(err)
	}
	if pr.StatusCode != nethttp.StatusOK {
		t.Fatalf("createPane status %d", pr.StatusCode)
	}
	if got := getProject(t, srv.URL, "p-station").PaneCount; got != 1 {
		t.Fatalf("precondition: PaneCount=%d, want 1", got)
	}

	// Archive → flag set, panes gone, persisted.
	postProjectAction(t, srv.URL+"/projects/p-station/archive")
	project := getProject(t, srv.URL, "p-station")
	if !project.Archived {
		t.Fatalf("GET /projects after archive: Archived=false, project=%+v", project)
	}
	if project.PaneCount != 0 {
		t.Fatalf("archive should leave 0 live panes, got PaneCount=%d", project.PaneCount)
	}
	if !persistedArchived(t, configPath, "p-station") {
		t.Fatalf("projects.toml after archive: Archived=false, want true")
	}

	// Unarchive → flag cleared, persisted.
	postProjectAction(t, srv.URL+"/projects/p-station/unarchive")
	project = getProject(t, srv.URL, "p-station")
	if project.Archived {
		t.Fatalf("GET /projects after unarchive: Archived=true, project=%+v", project)
	}
	if persistedArchived(t, configPath, "p-station") {
		t.Fatalf("projects.toml after unarchive: Archived=true, want false")
	}
}

// TestArchiveUnknownProject404s — archiving/unarchiving a project that
// doesn't exist is a 404.
func TestArchiveUnknownProject404s(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	for _, action := range []string{"archive", "unarchive"} {
		r, err := nethttp.Post(srv.URL+"/projects/does-not-exist/"+action, "application/json", nil)
		if err != nil {
			t.Fatal(err)
		}
		if r.StatusCode != nethttp.StatusNotFound {
			t.Fatalf("%s unknown project: expected 404, got %d", action, r.StatusCode)
		}
	}
}

func persistedArchived(t *testing.T, configPath string, id string) bool {
	t.Helper()
	registry, warnings, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 {
		t.Fatalf("config.Load warnings: %+v", warnings)
	}
	for _, project := range registry.Projects {
		if project.ID == id {
			return project.Archived
		}
	}
	t.Fatalf("project %q missing from %s", id, configPath)
	return false
}
