package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSetProjectDocked_flipsFlagAndPersists walks a project through
// dock → undock → dock and verifies both in-memory and on-disk state
// round-trip cleanly.
func TestSetProjectDocked_flipsFlagAndPersists(t *testing.T) {
	dir := t.TempDir()
	cwd := filepath.Join(dir, "p1")
	if err := os.Mkdir(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	path := writeTemp(t, "")
	if err := AppendProject(path, Project{ID: "p1", Name: "P1", Cwd: cwd}); err != nil {
		t.Fatal(err)
	}

	// Dock.
	if err := SetProjectDocked(path, "p1", true); err != nil {
		t.Fatalf("dock: %v", err)
	}
	reg, _, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reg.Projects[0].Docked {
		t.Fatalf("expected Docked=true, got %+v", reg.Projects[0])
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), "docked = true") {
		t.Fatalf("expected TOML to contain 'docked = true', got %s", raw)
	}

	// Idempotent re-dock: no change, no error.
	if err := SetProjectDocked(path, "p1", true); err != nil {
		t.Fatalf("idempotent dock: %v", err)
	}

	// Undock clears the flag AND strips the line from the file.
	if err := SetProjectDocked(path, "p1", false); err != nil {
		t.Fatalf("undock: %v", err)
	}
	reg, _, err = Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if reg.Projects[0].Docked {
		t.Fatalf("expected Docked=false after undock")
	}
	raw2, _ := os.ReadFile(path)
	if strings.Contains(string(raw2), "docked") {
		t.Fatalf("expected docked line to be stripped, got %s", raw2)
	}
}

// TestSetProjectDocked_unknownProjectIsNoOp protects us against callers
// racing with RemoveProject — a concurrent delete shouldn't manifest as
// an error when the caller merely wanted to undock.
func TestSetProjectDocked_unknownProjectIsNoOp(t *testing.T) {
	path := writeTemp(t, "")
	if err := SetProjectDocked(path, "nope", true); err != nil {
		t.Fatalf("expected nil for unknown project, got %v", err)
	}
}
