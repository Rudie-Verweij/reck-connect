package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIsUnderManagedRoot(t *testing.T) {
	tmp := t.TempDir()
	root := filepath.Join(tmp, "projects")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	inside := filepath.Join(root, "demo")
	if err := os.Mkdir(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(tmp, "elsewhere")
	if err := os.Mkdir(outside, 0o755); err != nil {
		t.Fatal(err)
	}

	if !IsUnderManagedRoot(inside, root) {
		t.Error("expected inside dir to be under managed root")
	}
	if IsUnderManagedRoot(outside, root) {
		t.Error("expected outside dir to be rejected")
	}
	if IsUnderManagedRoot(root, root) {
		t.Error("expected root itself to be rejected (don't rm -rf the root)")
	}
}

func TestIsUnderManagedRootRejectsSymlinkEscape(t *testing.T) {
	tmp := t.TempDir()
	root := filepath.Join(tmp, "projects")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(tmp, "secrets")
	if err := os.Mkdir(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	// Plant a symlink *inside* the managed root that points outside.
	trap := filepath.Join(root, "escape")
	if err := os.Symlink(outside, trap); err != nil {
		t.Skipf("symlink unsupported on this FS: %v", err)
	}
	if IsUnderManagedRoot(trap, root) {
		t.Error("expected symlink-escaping path to be rejected")
	}
}

func TestIsUnderManagedRootRejectsNonexistentPaths(t *testing.T) {
	tmp := t.TempDir()
	root := filepath.Join(tmp, "projects")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if IsUnderManagedRoot(filepath.Join(root, "never-created"), root) {
		t.Error("expected nonexistent path to be rejected (EvalSymlinks fails)")
	}
}
