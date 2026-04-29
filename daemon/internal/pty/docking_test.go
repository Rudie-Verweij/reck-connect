package pty

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/proto"
)

func newDockManager(t *testing.T) (*Manager, string) {
	t.Helper()
	dir := t.TempDir()
	cwd := filepath.Join(dir, "p1")
	if err := os.Mkdir(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(cfg, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := config.AppendProject(cfg, config.Project{ID: "p1", Name: "P1", Cwd: cwd}); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: cwd, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		cfg,
		nil,
	)
	return mgr, cfg
}

func TestSetDocked_persistsAndSurfaces(t *testing.T) {
	mgr, _ := newDockManager(t)
	if err := mgr.SetDocked("p1", true); err != nil {
		t.Fatal(err)
	}
	docked := mgr.DockedProjects()
	if len(docked) != 1 || docked[0].ID != "p1" || !docked[0].Docked {
		t.Fatalf("expected p1 in DockedProjects, got %+v", docked)
	}
	// Projects() returns Docked=true too.
	found := false
	for _, p := range mgr.Projects() {
		if p.ID == "p1" && p.Docked {
			found = true
		}
	}
	if !found {
		t.Fatalf("Projects() did not reflect docked state: %+v", mgr.Projects())
	}

	// Undock.
	if err := mgr.SetDocked("p1", false); err != nil {
		t.Fatal(err)
	}
	if len(mgr.DockedProjects()) != 0 {
		t.Fatalf("expected 0 docked after undock, got %+v", mgr.DockedProjects())
	}
}

func TestSetDocked_unknownProjectErrs(t *testing.T) {
	mgr, _ := newDockManager(t)
	if err := mgr.SetDocked("nope", true); err == nil {
		t.Fatal("expected error for unknown project")
	}
}

func TestAddMetaProject_isHiddenFromProjectsList(t *testing.T) {
	mgr, _ := newDockManager(t)
	scratch := t.TempDir()
	if err := mgr.AddMetaProject(proto.AddProjectRequest{
		ID:   "__reck_supervisor__",
		Name: "Mission Control Supervisor",
		Cwd:  scratch,
	}); err != nil {
		t.Fatalf("AddMetaProject: %v", err)
	}

	// Projects() must exclude the meta-project.
	for _, p := range mgr.Projects() {
		if p.ID == "__reck_supervisor__" {
			t.Fatalf("meta-project leaked into Projects(): %+v", p)
		}
	}
	// DockedProjects() does too (meta-project defaults to undocked).
	if err := mgr.SetDocked("p1", true); err != nil {
		t.Fatal(err)
	}
	for _, p := range mgr.DockedProjects() {
		if p.ID == "__reck_supervisor__" {
			t.Fatalf("meta-project leaked into DockedProjects(): %+v", p)
		}
	}

	// But ProjectExists still reports it.
	if !mgr.ProjectExists("__reck_supervisor__") {
		t.Fatalf("ProjectExists should report the meta-project")
	}
}

func TestAddMetaProject_rejectsRegularID(t *testing.T) {
	mgr, _ := newDockManager(t)
	err := mgr.AddMetaProject(proto.AddProjectRequest{
		ID:   "regular",
		Name: "Regular",
		Cwd:  t.TempDir(),
	})
	if err == nil {
		t.Fatal("expected error for non-hidden ID")
	}
}

func TestIsHiddenProjectID(t *testing.T) {
	cases := []struct {
		id   string
		want bool
	}{
		{"__reck_supervisor__", true},
		{"__foo", true},
		{"_reck", false},
		{"foo", false},
		{"", false},
	}
	for _, c := range cases {
		if got := IsHiddenProjectID(c.id); got != c.want {
			t.Errorf("IsHiddenProjectID(%q) = %v, want %v", c.id, got, c.want)
		}
	}
}

func TestOnStateChange_firesOnDockUndock(t *testing.T) {
	mgr, _ := newDockManager(t)
	fired := 0
	mgr.OnStateChange(func() { fired++ })

	if err := mgr.SetDocked("p1", true); err != nil {
		t.Fatal(err)
	}
	if fired == 0 {
		t.Fatalf("listener did not fire on dock")
	}
	prev := fired
	if err := mgr.SetDocked("p1", false); err != nil {
		t.Fatal(err)
	}
	if fired <= prev {
		t.Fatalf("listener did not fire on undock")
	}
}
