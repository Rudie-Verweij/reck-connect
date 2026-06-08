package config

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// TestResolveBinary_rejectsBareName confirms a PATH-dependent name
// (no path separator) is hard-error, not silently allowed.
func TestResolveBinary_rejectsBareName(t *testing.T) {
	for _, bare := range []string{"codex", "claude", "zsh", "node"} {
		_, err := ResolveBinary("--claude", bare)
		if err == nil {
			t.Errorf("ResolveBinary(%q): expected error, got nil", bare)
			continue
		}
		if !errors.Is(err, ErrBareBinaryName) {
			t.Errorf("ResolveBinary(%q): error = %v, want ErrBareBinaryName", bare, err)
		}
	}
}

// TestResolveBinary_rejectsEmpty — empty string is a config bug, not a
// valid "skip" signal. Surface it loudly.
func TestResolveBinary_rejectsEmpty(t *testing.T) {
	if _, err := ResolveBinary("--claude", ""); err == nil {
		t.Error("ResolveBinary(\"\"): expected error")
	}
}

// TestResolveBinary_acceptsAbsoluteAndReturnsSame verifies the happy
// path for an absolute binary that exists and is executable.
func TestResolveBinary_acceptsAbsoluteAndReturnsSame(t *testing.T) {
	// /bin/sh is available on any Unix host; good portable fixture.
	got, err := ResolveBinary("shell[0]", "/bin/sh")
	if err != nil {
		t.Fatalf("ResolveBinary(/bin/sh): %v", err)
	}
	if got != "/bin/sh" {
		t.Errorf("resolved = %q, want /bin/sh", got)
	}
}

// TestResolveBinary_unresolvableAbsoluteFails — absolute but bogus path
// should error at load, not at spawn. Uses t.TempDir() for a path that
// can't possibly exist.
func TestResolveBinary_unresolvableAbsoluteFails(t *testing.T) {
	bogus := filepath.Join(t.TempDir(), "definitely-not-a-real-binary")
	if _, err := ResolveBinary("--claude", bogus); err == nil {
		t.Error("expected error for nonexistent absolute path")
	}
}

// TestResolveBinary_relativePathResolves — a ./relative path with
// executable bits should resolve to its absolute form via LookPath.
func TestResolveBinary_relativePathResolves(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "myprog")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho hi\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Switch CWD so ./myprog is resolvable.
	orig, _ := os.Getwd()
	defer os.Chdir(orig)
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	got, err := ResolveBinary("--claude", "./myprog")
	if err != nil {
		t.Fatalf("./myprog: %v", err)
	}
	// Expect absolute form (macOS may prefix /private for tmp paths).
	if !filepath.IsAbs(got) {
		t.Errorf("resolved = %q, want absolute path", got)
	}
}
