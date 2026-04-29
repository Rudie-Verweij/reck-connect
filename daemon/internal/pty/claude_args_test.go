package pty

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/proto"
)

func TestValidateClaudeExtraArgs_allowsCommonFlags(t *testing.T) {
	cases := [][]string{
		nil,
		{},
		{"--dangerously-skip-permissions"},
		{"--permission-mode", "plan"},
		{"--permission-mode=acceptEdits"},
		{"--betas", "interleaved-thinking"},
		{"--model", "claude-opus-4-7"},
		{"--effort", "high"},
		{"--dangerously-skip-permissions", "--model=claude-opus-4-7"},
	}
	for _, args := range cases {
		if err := ValidateClaudeExtraArgs(args, t.TempDir()); err != nil {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=%v, want nil", args, err)
		}
	}
}

func TestValidateClaudeExtraArgs_rejectsCwd(t *testing.T) {
	cwd := t.TempDir()
	cases := [][]string{
		{"--cwd", "/etc"},
		{"--cwd=/etc"},
		{"--model=x", "--cwd", cwd},
	}
	for _, args := range cases {
		err := ValidateClaudeExtraArgs(args, cwd)
		if err == nil {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=nil, want rejection", args)
			continue
		}
		if !strings.Contains(err.Error(), "--cwd") {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=%v, want --cwd mention", args, err)
		}
	}
}

func TestValidateClaudeExtraArgs_addDir(t *testing.T) {
	cwd := t.TempDir()
	sub := filepath.Join(cwd, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}

	// Allowed: absolute under cwd, relative path, multi-value variadic.
	ok := [][]string{
		{"--add-dir", sub},
		{"--add-dir", "sub"},
		{"--add-dir=" + sub},
		{"--add-dir", sub, "./sub"},
		{"--add-dir", sub, "--model", "x"},
	}
	for _, args := range ok {
		if err := ValidateClaudeExtraArgs(args, cwd); err != nil {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=%v, want nil", args, err)
		}
	}

	// Rejected: path outside cwd (via /etc, parent traversal, absolute elsewhere).
	bad := [][]string{
		{"--add-dir", "/etc"},
		{"--add-dir", "../outside"},
		{"--add-dir=/etc"},
		{"--add-dir", sub, "/etc"}, // variadic second arg outside
		{"--add-dir"},              // missing value
		{"--add-dir="},             // empty value
	}
	for _, args := range bad {
		if err := ValidateClaudeExtraArgs(args, cwd); err == nil {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=nil, want rejection", args)
		}
	}
}

func TestValidateClaudeExtraArgs_rejectsReservedSessionFlags(t *testing.T) {
	cwd := t.TempDir()
	// The daemon injects these flags itself (claude/*.go) — letting a
	// user supply them too would result in duplicate argv entries and
	// an ambiguous session ID on the claude side.
	cases := [][]string{
		{"--resume", "aaaa"},
		{"--resume=aaaa"},
		{"--session-id", "aaaa"},
		{"--session-id=aaaa"},
		{"--name", "hello"},
		{"--name=hello"},
		{"--model", "x", "--resume", "aaaa"}, // reserved mixed in with allowed flags
	}
	for _, args := range cases {
		err := ValidateClaudeExtraArgs(args, cwd)
		if err == nil {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=nil, want rejection", args)
			continue
		}
		if !strings.Contains(err.Error(), "reserved") {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=%v, want 'reserved' mention", args, err)
		}
	}
}

func TestValidateClaudeExtraArgs_rejectsAppendSystemPrompt(t *testing.T) {
	cwd := t.TempDir()
	// The daemon injects --append-system-prompt itself (baseline + project
	// preamble). A user-supplied duplicate would produce two flags in
	// argv (last-wins on CLI, but redact only masks the first — confusing
	// to debug). Steer the user at projects.toml `preamble` instead.
	cases := [][]string{
		{"--append-system-prompt", "foo"},
		{"--append-system-prompt=foo"},
		{"--model", "x", "--append-system-prompt", "foo"}, // mixed with an allowed flag
		{"--append-system-prompt=foo", "--dangerously-skip-permissions"},
	}
	for _, args := range cases {
		err := ValidateClaudeExtraArgs(args, cwd)
		if err == nil {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=nil, want rejection", args)
			continue
		}
		msg := err.Error()
		if !strings.Contains(msg, "--append-system-prompt") {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=%v, want '--append-system-prompt' mention", args, err)
		}
		if !strings.Contains(msg, "reserved") {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=%v, want 'reserved' mention", args, err)
		}
		if !strings.Contains(msg, "preamble") {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=%v, want 'preamble' pointer to projects.toml field", args, err)
		}
	}
}

func TestValidateClaudeExtraArgs_debugFile(t *testing.T) {
	cwd := t.TempDir()
	tmp := os.TempDir()
	inside := filepath.Join(tmp, "reck-test-debug.log")
	// cwd is a t.TempDir() which may itself live under os.TempDir(). Pick a
	// location that is definitely outside TMPDIR.
	outside := "/etc/debug.log"

	ok := [][]string{
		{"--debug-file", inside},
		{"--debug-file=" + inside},
	}
	for _, args := range ok {
		if err := ValidateClaudeExtraArgs(args, cwd); err != nil {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=%v, want nil", args, err)
		}
	}

	bad := [][]string{
		{"--debug-file", outside},
		{"--debug-file=" + outside},
		{"--debug-file", "/etc/passwd"},
		{"--debug-file"},  // missing value
		{"--debug-file="}, // empty value
	}
	for _, args := range bad {
		if err := ValidateClaudeExtraArgs(args, cwd); err == nil {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=nil, want rejection", args)
		}
	}
}

func TestValidateClaudeExtraArgs_addDirRejectsSymlinkEscape(t *testing.T) {
	cwd := t.TempDir()
	// Symlink inside the project that points outside the project. A purely
	// lexical containment check would accept this — the resolved target
	// (e.g. /etc) widens claude's filesystem reach beyond the sandbox.
	link := filepath.Join(cwd, "escape")
	if err := os.Symlink("/etc", link); err != nil {
		t.Fatal(err)
	}
	bad := [][]string{
		{"--add-dir", link},
		{"--add-dir=" + link},
		{"--add-dir", "escape"}, // relative variant
	}
	for _, args := range bad {
		err := ValidateClaudeExtraArgs(args, cwd)
		if err == nil {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=nil, want rejection (symlink escapes cwd)", args)
			continue
		}
		if !strings.Contains(err.Error(), "outside project cwd") {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=%v, want 'outside project cwd' mention", args, err)
		}
	}
}

func TestValidateClaudeExtraArgs_addDirAcceptsSymlinkWithin(t *testing.T) {
	cwd := t.TempDir()
	// A real subdirectory plus a symlink that points to it (still inside
	// the project) — the resolved path is inside cwd, so accept.
	target := filepath.Join(cwd, "real")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(cwd, "alias")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	ok := [][]string{
		{"--add-dir", target},
		{"--add-dir", link},
		{"--add-dir=" + link},
	}
	for _, args := range ok {
		if err := ValidateClaudeExtraArgs(args, cwd); err != nil {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=%v, want nil (resolved path is inside cwd)", args, err)
		}
	}
}

func TestValidateClaudeExtraArgs_debugFileRejectsSymlinkEscape(t *testing.T) {
	tmp := os.TempDir()
	// Place a symlink in TMPDIR that points outside TMPDIR — claude would
	// dereference it on first write and clobber/expose the target.
	link := filepath.Join(tmp, "reck-test-debug-escape.log")
	t.Cleanup(func() { _ = os.Remove(link) })
	if err := os.Symlink("/etc/reck-debug.log", link); err != nil {
		t.Fatal(err)
	}
	cwd := t.TempDir()
	bad := [][]string{
		{"--debug-file", link},
		{"--debug-file=" + link},
	}
	for _, args := range bad {
		err := ValidateClaudeExtraArgs(args, cwd)
		if err == nil {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=nil, want rejection (symlink escapes TMPDIR)", args)
			continue
		}
		if !strings.Contains(err.Error(), "outside TMPDIR") {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=%v, want 'outside TMPDIR' mention", args, err)
		}
	}
}

func TestValidateClaudeExtraArgs_debugFileAcceptsNotYetExistingPath(t *testing.T) {
	tmp := os.TempDir()
	// Common case: --debug-file names a file that claude will create on
	// first write. The path doesn't exist yet but its parent (TMPDIR) does
	// and is inside the allowed root, so accept.
	notYet := filepath.Join(tmp, "reck-test-debug-notexist.log")
	// Sanity: ensure the path really doesn't exist.
	if _, err := os.Lstat(notYet); !os.IsNotExist(err) {
		t.Fatalf("test setup: expected %q to not exist, got %v", notYet, err)
	}

	cwd := t.TempDir()
	ok := [][]string{
		{"--debug-file", notYet},
		{"--debug-file=" + notYet},
	}
	for _, args := range ok {
		if err := ValidateClaudeExtraArgs(args, cwd); err != nil {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=%v, want nil (parent exists and is inside TMPDIR)", args, err)
		}
	}
}

func TestValidateClaudeExtraArgs_addDirRejectsSymlinkedAncestorEscape(t *testing.T) {
	cwd := t.TempDir()
	// Symlinked intermediate directory: project/aliasdir → /etc.
	// A child path under that symlink (project/aliasdir/passwd) would
	// resolve to /etc/passwd — must be rejected even though the literal
	// path string starts inside cwd.
	link := filepath.Join(cwd, "aliasdir")
	if err := os.Symlink("/etc", link); err != nil {
		t.Fatal(err)
	}
	leaf := filepath.Join(link, "passwd")
	bad := [][]string{
		{"--add-dir", leaf},
		{"--add-dir=" + leaf},
	}
	for _, args := range bad {
		err := ValidateClaudeExtraArgs(args, cwd)
		if err == nil {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=nil, want rejection (ancestor symlink escapes cwd)", args)
			continue
		}
		if !strings.Contains(err.Error(), "outside project cwd") {
			t.Errorf("ValidateClaudeExtraArgs(%v) err=%v, want 'outside project cwd' mention", args, err)
		}
	}
}

func TestCreatePane_claudeWithExtraArgs(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		nil,
	)
	extra := []string{"--dangerously-skip-permissions", "--model", "claude-opus-4-7"}
	pane, err := mgr.CreatePaneWith("p1", proto.PaneKindClaude, 80, 24, CreatePaneOptions{ExtraArgs: extra})
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.DeletePane("p1", pane.ID)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		tail := string(pane.ReplayTail(512))
		if strings.Contains(tail, "--dangerously-skip-permissions") && strings.Contains(tail, "claude-opus-4-7") {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("extra args missing from spawn argv; tail=%q", string(pane.ReplayTail(512)))
}

func TestCreatePane_shellIgnoresExtraArgs(t *testing.T) {
	m := newManager(t)
	// Shell pane with "extra args" should succeed — args are ignored, not validated.
	pane, err := m.CreatePaneWith("p1", proto.PaneKindShell, 80, 24, CreatePaneOptions{ExtraArgs: []string{"--cwd", "/etc"}})
	if err != nil {
		t.Fatalf("shell pane should ignore extra args, got err=%v", err)
	}
	defer m.DeletePane("p1", pane.ID)
}

func TestCreatePane_claudeRejectsExtraArgs(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		nil,
	)
	_, err := mgr.CreatePaneWith("p1", proto.PaneKindClaude, 80, 24, CreatePaneOptions{ExtraArgs: []string{"--cwd", "/etc"}})
	if err == nil {
		t.Fatal("expected error rejecting --cwd")
	}
}
