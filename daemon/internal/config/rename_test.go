package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSetProjectDisplayName_writesThroughAndClears verifies the rename
// round-trips to disk and that an empty string cleanly clears the override
// (no dangling `display_name = ""` line in the file).
func TestSetProjectDisplayName_writesThroughAndClears(t *testing.T) {
	dir := t.TempDir()
	cwd := filepath.Join(dir, "p1")
	if err := os.Mkdir(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	path := writeTemp(t, "")
	if err := AppendProject(path, Project{ID: "p1", Name: "P1", Cwd: cwd}); err != nil {
		t.Fatal(err)
	}

	if err := SetProjectDisplayName(path, "p1", "My Rename"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	reg, _, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reg.Projects[0].DisplayName; got != "My Rename" {
		t.Fatalf("DisplayName = %q, want %q", got, "My Rename")
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), `display_name = "My Rename"`) {
		t.Fatalf("expected display_name in TOML, got: %s", raw)
	}

	// Idempotent re-rename with the same value — no error.
	if err := SetProjectDisplayName(path, "p1", "My Rename"); err != nil {
		t.Fatalf("idempotent rename: %v", err)
	}

	// Clearing with empty string strips the line.
	if err := SetProjectDisplayName(path, "p1", ""); err != nil {
		t.Fatalf("clear: %v", err)
	}
	reg, _, err = Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if reg.Projects[0].DisplayName != "" {
		t.Fatalf("expected empty DisplayName after clear, got %q", reg.Projects[0].DisplayName)
	}
	raw2, _ := os.ReadFile(path)
	if strings.Contains(string(raw2), "display_name") {
		t.Fatalf("expected display_name line to be stripped, got: %s", raw2)
	}
}

// TestSetProjectDisplayName_unknownProjectIsNoOp: callers racing with a
// project deletion shouldn't see an error.
func TestSetProjectDisplayName_unknownProjectIsNoOp(t *testing.T) {
	path := writeTemp(t, "")
	if err := SetProjectDisplayName(path, "nope", "Whatever"); err != nil {
		t.Fatalf("expected nil for unknown project, got %v", err)
	}
}

// TestSetProjectDisplayName_preservesOtherFields guards against the rewrite
// accidentally dropping archived/shell/preamble when it round-trips the file.
func TestSetProjectDisplayName_preservesOtherFields(t *testing.T) {
	dir := t.TempDir()
	cwd := filepath.Join(dir, "p1")
	if err := os.Mkdir(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	path := writeTemp(t, "")
	if err := AppendProject(path, Project{
		ID:       "p1",
		Name:     "P1",
		Cwd:      cwd,
		Shell:    []string{"/bin/bash", "-l"},
		Preamble: "Hello",
		Archived: true,
	}); err != nil {
		t.Fatal(err)
	}

	if err := SetProjectDisplayName(path, "p1", "P1 Renamed"); err != nil {
		t.Fatalf("rename: %v", err)
	}

	reg, _, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	p := reg.Projects[0]
	if !p.Archived {
		t.Error("expected Archived preserved")
	}
	if p.Preamble != "Hello" {
		t.Errorf("Preamble = %q, want Hello", p.Preamble)
	}
	if len(p.Shell) != 2 || p.Shell[0] != "/bin/bash" {
		t.Errorf("Shell = %v, want [/bin/bash -l]", p.Shell)
	}
}
