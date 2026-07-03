package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSetProjectArchived_flipsFlagAndPersists walks a project through
// archive → unarchive → archive and verifies both in-memory and on-disk
// state round-trip cleanly (mirrors the docked flag).
func TestSetProjectArchived_flipsFlagAndPersists(t *testing.T) {
	dir := t.TempDir()
	cwd := filepath.Join(dir, "p1")
	if err := os.Mkdir(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	path := writeTemp(t, "")
	if err := AppendProject(path, Project{ID: "p1", Name: "P1", Cwd: cwd}); err != nil {
		t.Fatal(err)
	}

	// Archive.
	if err := SetProjectArchived(path, "p1", true); err != nil {
		t.Fatalf("archive: %v", err)
	}
	reg, _, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reg.Projects[0].Archived {
		t.Fatalf("expected Archived=true, got %+v", reg.Projects[0])
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), "archived = true") {
		t.Fatalf("expected TOML to contain 'archived = true', got %s", raw)
	}

	// Idempotent re-archive: no change, no error.
	if err := SetProjectArchived(path, "p1", true); err != nil {
		t.Fatalf("idempotent archive: %v", err)
	}

	// Unarchive clears the flag AND strips the line from the file.
	if err := SetProjectArchived(path, "p1", false); err != nil {
		t.Fatalf("unarchive: %v", err)
	}
	reg, _, err = Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if reg.Projects[0].Archived {
		t.Fatalf("expected Archived=false after unarchive")
	}
	raw2, _ := os.ReadFile(path)
	if strings.Contains(string(raw2), "archived") {
		t.Fatalf("expected archived line to be stripped, got %s", raw2)
	}
}

// TestSetProjectArchived_unknownProjectIsNoOp — unknown id is a nil no-op,
// same as dock; defends against callers racing with RemoveProject.
func TestSetProjectArchived_unknownProjectIsNoOp(t *testing.T) {
	path := writeTemp(t, "")
	if err := SetProjectArchived(path, "nope", true); err != nil {
		t.Fatalf("expected nil for unknown project, got %v", err)
	}
}

// TestSetProjectArchived_independentOfDocked — the archived flag and the
// docked flag are orthogonal; setting one must not disturb the other.
func TestSetProjectArchived_independentOfDocked(t *testing.T) {
	dir := t.TempDir()
	cwd := filepath.Join(dir, "p1")
	if err := os.Mkdir(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	path := writeTemp(t, "")
	if err := AppendProject(path, Project{ID: "p1", Name: "P1", Cwd: cwd, Docked: true}); err != nil {
		t.Fatal(err)
	}
	if err := SetProjectArchived(path, "p1", true); err != nil {
		t.Fatalf("archive: %v", err)
	}
	reg, _, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reg.Projects[0].Docked || !reg.Projects[0].Archived {
		t.Fatalf("expected both Docked and Archived true, got %+v", reg.Projects[0])
	}
}
