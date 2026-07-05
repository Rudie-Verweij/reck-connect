package pty

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
	"github.com/rudie-verweij/reck-connect/proto"
)

func newManager(t *testing.T) *Manager {
	t.Helper()
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	projects := []config.Project{{
		ID:    "p1",
		Name:  "P1",
		Cwd:   dir,
		Shell: []string{"/bin/sh"},
	}}
	return NewManager(projects, []string{"/bin/echo", "claude-placeholder"}, configPath, nil)
}

func TestCreatePane_shell(t *testing.T) {
	m := newManager(t)
	pane, err := m.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if pane.Kind != proto.PaneKindShell {
		t.Fatalf("kind: want shell, got %s", pane.Kind)
	}
	if pane.State() != proto.PaneStateRunning {
		t.Fatalf("state: want running, got %s", pane.State())
	}
}

func TestCreatePane_unknownProject(t *testing.T) {
	m := newManager(t)
	_, err := m.CreatePane("bogus", proto.PaneKindShell, 80, 24)
	if err == nil {
		t.Fatal("expected error for unknown project")
	}
}

func TestDeletePane(t *testing.T) {
	m := newManager(t)
	pane, err := m.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.DeletePane("p1", pane.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := m.GetPane("p1", pane.ID); ok {
		t.Fatal("pane should be gone after delete")
	}
}

func TestPaneOutput_and_replay(t *testing.T) {
	m := newManager(t)
	pane, err := m.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer m.DeletePane("p1", pane.ID)
	if err := pane.Write([]byte("echo hi\n")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	out := pane.ReplayTail(1024)
	if len(out) == 0 {
		t.Fatal("expected some output in replay buffer")
	}
}

func TestProjectAggregate_defaultsToGray(t *testing.T) {
	m := newManager(t)
	projects := m.Projects()
	if len(projects) != 1 {
		t.Fatalf("want 1 project, got %d", len(projects))
	}
	if projects[0].Stoplight != proto.StoplightGray {
		t.Fatalf("want gray, got %s", projects[0].Stoplight)
	}
}

func TestAddProject_derivesID(t *testing.T) {
	m := newManager(t)
	dir := t.TempDir()
	p, err := m.AddProject(proto.AddProjectRequest{Name: "My New Thing", Cwd: dir})
	if err != nil {
		t.Fatal(err)
	}
	if p.ID != "my-new-thing" {
		t.Fatalf("want my-new-thing, got %s", p.ID)
	}
	found := false
	for _, pr := range m.Projects() {
		if pr.ID == "my-new-thing" {
			found = true
		}
	}
	if !found {
		t.Fatalf("new project not listed")
	}
}

func TestAddProject_badCwd(t *testing.T) {
	m := newManager(t)
	_, err := m.AddProject(proto.AddProjectRequest{Name: "X", Cwd: "/nonexistent/xyzzy"})
	if err == nil {
		t.Fatal("expected error for missing cwd")
	}
}

func TestAddProject_idCollision(t *testing.T) {
	m := newManager(t)
	dir := t.TempDir()
	_, err := m.AddProject(proto.AddProjectRequest{ID: "p1", Name: "dup", Cwd: dir})
	if err == nil {
		t.Fatal("expected error for duplicate ID")
	}
}

// TestAddProject_rejectsBareShellName — an earlier release acceptance: a caller-
// supplied Shell[0] that's a bare name (no slashes, so exec would
// resolve it via $PATH at spawn time) must be rejected at registration
// time. Otherwise a poisoned PATH could swap in a malicious shell.
func TestAddProject_rejectsBareShellName(t *testing.T) {
	m := newManager(t)
	dir := t.TempDir()
	_, err := m.AddProject(proto.AddProjectRequest{
		Name:  "BareShell",
		Cwd:   dir,
		Shell: []string{"zsh", "-l"},
	})
	if err == nil {
		t.Fatal("AddProject with bare shell[0] should have errored")
	}
	if !strings.Contains(err.Error(), "shell[0]") {
		t.Errorf("error should mention shell[0]; got %v", err)
	}
}

// TestAddProject_absoluteShellAccepted — positive control: an absolute
// shell path passes through AddProject cleanly.
func TestAddProject_absoluteShellAccepted(t *testing.T) {
	m := newManager(t)
	dir := t.TempDir()
	p, err := m.AddProject(proto.AddProjectRequest{
		Name:  "AbsShell",
		Cwd:   dir,
		Shell: []string{"/bin/sh"},
	})
	if err != nil {
		t.Fatalf("AddProject: %v", err)
	}
	if p.Shell[0] != "/bin/sh" {
		t.Errorf("Shell[0] = %q, want /bin/sh", p.Shell[0])
	}
}

func TestRemoveProject(t *testing.T) {
	m := newManager(t)
	dir := t.TempDir()
	p, err := m.AddProject(proto.AddProjectRequest{Name: "Temp", Cwd: dir})
	if err != nil {
		t.Fatal(err)
	}
	pane, err := m.CreatePane(p.ID, proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.RemoveProject(p.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := m.ProjectDetail(p.ID); ok {
		t.Fatal("project should be gone")
	}
	if _, ok := m.GetPane(p.ID, pane.ID); ok {
		t.Fatal("pane record should be gone")
	}
}

func TestRemoveProject_missing(t *testing.T) {
	m := newManager(t)
	err := m.RemoveProject("does-not-exist")
	if err == nil {
		t.Fatal("expected error for missing project")
	}
}

func TestPane_OSC777_setsAwaitingApproval(t *testing.T) {
	m := newManager(t)
	pane, err := m.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer m.DeletePane("p1", pane.ID)

	// `cat` blocks on stdin so no shell prompt arrives after the OSC to clear
	// the flag. This mirrors Claude Code's real behavior (OSC is the last
	// output before human input).
	osc := "\x1b]777;notify;Claude Code;Claude needs your permission to use Edit\x07"
	cmd := "printf '%s' " + strconvQuote(osc) + "; cat\n"
	if err := pane.Write([]byte(cmd)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if pane.AwaitingApproval() {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !pane.AwaitingApproval() {
		t.Fatalf("awaitingApproval should be true after OSC 777, tail=%q", string(pane.ReplayTail(500)))
	}

	// cat echoes whatever we send — a non-OSC chunk clears the flag.
	if err := pane.Write([]byte("hello-after\n")); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !pane.AwaitingApproval() {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if pane.AwaitingApproval() {
		t.Fatalf("awaitingApproval should clear after plain output, tail=%q", string(pane.ReplayTail(500)))
	}
}

func TestCreatePane_claudePreamble(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{
			ID:       "p1",
			Name:     "P1",
			Cwd:      dir,
			Shell:    []string{"/bin/sh"},
			Preamble: "Hello from Reck.",
		}},
		[]string{"/bin/echo"},
		configPath,
		nil,
	)
	pane, err := mgr.CreatePane("p1", proto.PaneKindClaude, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.DeletePane("p1", pane.ID)

	// /bin/echo prints its argv then exits; the readLoop captures the
	// output. After an earlier release the baseline Reck preamble is prepended to
	// the project preamble, so the argv the kernel echoes back starts
	// with the baseline (several KiB) and ends with "Hello from Reck."
	// followed by any trailing flags. We need enough replay tail to
	// reach the project preamble; 8 KiB covers the current baseline with
	// headroom (MaxPreambleBytes is the same cap on the spawn side).
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		tail := string(pane.ReplayTail(8 * 1024))
		if strings.Contains(tail, "--append-system-prompt") && strings.Contains(tail, "Hello from Reck.") {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("spawn argv missing preamble; tail=%q", string(pane.ReplayTail(8*1024)))
}

// TestCreatePane_claudeNoProjectPreamble confirms the baseline preamble
// is still injected even when the project's own Preamble field is empty.
// Before an earlier release this test asserted --append-system-prompt was absent;
// now the daemon always emits a baseline (unless RECK_DISABLE_BASELINE_PREAMBLE
// is set), so we invert: --append-system-prompt must be present, and
// its value must contain the baseline's signature string.
func TestCreatePane_claudeNoProjectPreamble(t *testing.T) {
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
	pane, err := mgr.CreatePane("p1", proto.PaneKindClaude, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.DeletePane("p1", pane.ID)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		tail := string(pane.ReplayTail(8 * 1024))
		if strings.Contains(tail, "--append-system-prompt") && strings.Contains(tail, "Reck Connect Claude Code pane") {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("spawn argv missing baseline preamble; tail=%q", string(pane.ReplayTail(8*1024)))
}

// TestCreatePane_claudeBaselineDisabled ensures RECK_DISABLE_BASELINE_PREAMBLE
// in the daemon's environment suppresses the baseline; the Older
// behaviour of omitting --append-system-prompt entirely when no project
// preamble is configured is preserved under this escape hatch.
func TestCreatePane_claudeBaselineDisabled(t *testing.T) {
	t.Setenv("RECK_DISABLE_BASELINE_PREAMBLE", "1")
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
	pane, err := mgr.CreatePane("p1", proto.PaneKindClaude, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.DeletePane("p1", pane.ID)
	time.Sleep(500 * time.Millisecond)
	tail := string(pane.ReplayTail(2 * 1024))
	if strings.Contains(tail, "--append-system-prompt") {
		t.Fatalf("baseline should be suppressed and no project preamble set; got --append-system-prompt in tail=%q", tail)
	}
}

func TestAddProjectWithEmptyCwdCreatesDirUnderManagedRoot(t *testing.T) {
	tmp := t.TempDir()
	origRoot := config.ManagedProjectsRoot
	config.ManagedProjectsRoot = filepath.Join(tmp, "projects")
	t.Cleanup(func() { config.ManagedProjectsRoot = origRoot })

	configPath := filepath.Join(tmp, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(nil, []string{"/bin/echo"}, configPath, nil)

	proj, err := mgr.AddProject(proto.AddProjectRequest{Name: "Demo Project"})
	if err != nil {
		t.Fatalf("AddProject: %v", err)
	}
	if proj.ID != "demo-project" {
		t.Errorf("ID = %q, want demo-project", proj.ID)
	}
	wantCwd := filepath.Join(config.ManagedProjectsRoot, "demo-project")
	if proj.Cwd != wantCwd {
		t.Errorf("Cwd = %q, want %q", proj.Cwd, wantCwd)
	}
	if _, err := os.Stat(wantCwd); err != nil {
		t.Errorf("expected %s to exist: %v", wantCwd, err)
	}
}

func TestAddProjectWithEmptyCwdRejectsBadName(t *testing.T) {
	tmp := t.TempDir()
	origRoot := config.ManagedProjectsRoot
	config.ManagedProjectsRoot = filepath.Join(tmp, "projects")
	t.Cleanup(func() { config.ManagedProjectsRoot = origRoot })

	configPath := filepath.Join(tmp, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(nil, []string{"/bin/echo"}, configPath, nil)

	for _, bad := range []string{"", "   ", "!!! ???"} {
		if _, err := mgr.AddProject(proto.AddProjectRequest{Name: bad}); err == nil {
			t.Errorf("AddProject(%q) should have errored", bad)
		}
	}
}

func TestAddProjectWithEmptyCwdCollisionSuffixes(t *testing.T) {
	tmp := t.TempDir()
	origRoot := config.ManagedProjectsRoot
	config.ManagedProjectsRoot = filepath.Join(tmp, "projects")
	t.Cleanup(func() { config.ManagedProjectsRoot = origRoot })

	configPath := filepath.Join(tmp, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(nil, []string{"/bin/echo"}, configPath, nil)

	p1, err := mgr.AddProject(proto.AddProjectRequest{Name: "Demo"})
	if err != nil {
		t.Fatal(err)
	}
	p2, err := mgr.AddProject(proto.AddProjectRequest{Name: "Demo"})
	if err != nil {
		t.Fatal(err)
	}
	if p1.ID != "demo" || p2.ID != "demo-2" {
		t.Errorf("collision suffixes wrong: %q, %q", p1.ID, p2.ID)
	}
}

func TestRemoveProjectRemovesDirWhenUnderManagedRoot(t *testing.T) {
	tmp := t.TempDir()
	origRoot := config.ManagedProjectsRoot
	config.ManagedProjectsRoot = filepath.Join(tmp, "projects")
	t.Cleanup(func() { config.ManagedProjectsRoot = origRoot })

	configPath := filepath.Join(tmp, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(nil, []string{"/bin/echo"}, configPath, nil)

	proj, err := mgr.AddProject(proto.AddProjectRequest{Name: "Demo"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(proj.Cwd); err != nil {
		t.Fatalf("expected %s to exist after AddProject: %v", proj.Cwd, err)
	}

	if err := mgr.RemoveProject(proj.ID); err != nil {
		t.Fatalf("RemoveProject: %v", err)
	}
	if _, err := os.Stat(proj.Cwd); !os.IsNotExist(err) {
		t.Errorf("expected %s to be deleted after RemoveProject, got err=%v", proj.Cwd, err)
	}
}

func TestRemoveProjectLeavesDirWhenOutsideManagedRoot(t *testing.T) {
	tmp := t.TempDir()
	origRoot := config.ManagedProjectsRoot
	config.ManagedProjectsRoot = filepath.Join(tmp, "projects")
	t.Cleanup(func() { config.ManagedProjectsRoot = origRoot })

	// Simulate an existing-folder registration outside the managed root.
	external := filepath.Join(tmp, "existing-elsewhere")
	if err := os.Mkdir(external, 0o755); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(external, "do-not-delete.txt")
	if err := os.WriteFile(sentinel, []byte("preserve me"), 0o644); err != nil {
		t.Fatal(err)
	}

	configPath := filepath.Join(tmp, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(nil, []string{"/bin/echo"}, configPath, nil)

	proj, err := mgr.AddProject(proto.AddProjectRequest{Name: "External", Cwd: external})
	if err != nil {
		t.Fatal(err)
	}
	if err := mgr.RemoveProject(proj.ID); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(sentinel); err != nil {
		t.Errorf("sentinel file inside external dir was deleted: %v", err)
	}
}

func TestCreatePane_claudeRecordsSessionInIndex(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	pane, err := mgr.CreatePane("p1", proto.PaneKindClaude, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.DeletePane("p1", pane.ID)

	if pane.SessionID == "" {
		t.Fatal("expected SessionID to be populated on claude pane")
	}
	if pane.SessionName == "" {
		t.Fatal("expected SessionName to be populated on claude pane")
	}

	// spawn argv should include --session-id and --name.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		tail := string(pane.ReplayTail(1024))
		if strings.Contains(tail, "--session-id") && strings.Contains(tail, pane.SessionID) && strings.Contains(tail, "--name") {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	tail := string(pane.ReplayTail(1024))
	if !strings.Contains(tail, "--session-id") || !strings.Contains(tail, pane.SessionID) {
		t.Fatalf("expected --session-id %s in argv; tail=%q", pane.SessionID, tail)
	}
	if !strings.Contains(tail, "--name") {
		t.Fatalf("expected --name in argv; tail=%q", tail)
	}

	// The entry must exist in the index with matching metadata.
	e, ok, err := store.Get("p1", pane.SessionID)
	if err != nil || !ok {
		t.Fatalf("index missing session %s: ok=%v err=%v", pane.SessionID, ok, err)
	}
	if e.Cwd != dir {
		t.Errorf("Entry.Cwd = %q, want %q", e.Cwd, dir)
	}
	if e.LastPaneID != pane.ID {
		t.Errorf("Entry.LastPaneID = %q, want %q", e.LastPaneID, pane.ID)
	}
}

// TestCreatePane_shellHasSlotIDNotSessionID locks in an earlier release Scope B's
// identity rule: shell panes get a SlotID, never a SessionID. Prior to
// Scope B shell panes had no persistent identity at all — the daemon
// now records a shell entry keyed by SlotID so restore-on-reconnect
// can respawn with the original argv.
func TestCreatePane_shellHasSlotIDNotSessionID(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	pane, err := mgr.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if pane.SessionID != "" {
		t.Errorf("shell pane should not get SessionID, got %q", pane.SessionID)
	}
	if pane.SlotID == "" {
		t.Errorf("shell pane should have SlotID after Scope B; got empty")
	}
	// SlotID matches an entry in the session index.
	e, ok, err := store.Get("p1", pane.SlotID)
	if err != nil || !ok {
		t.Fatalf("session entry missing for slot %s: ok=%v err=%v", pane.SlotID, ok, err)
	}
	if e.Kind != proto.PaneKindShell {
		t.Errorf("entry.Kind = %q, want %q", e.Kind, proto.PaneKindShell)
	}
	if len(e.ShellArgv) == 0 || e.ShellArgv[0] != "/bin/sh" {
		t.Errorf("entry.ShellArgv = %v, want [/bin/sh ...]", e.ShellArgv)
	}
	if e.Cwd != dir {
		t.Errorf("entry.Cwd = %q, want %q", e.Cwd, dir)
	}
	if !e.WasLive {
		t.Errorf("expected WasLive=true on fresh shell spawn")
	}
	// Clean up: DeletePane first, then wait briefly for the Touch
	// goroutine so t.TempDir cleanup doesn't race the sessions.json
	// rewrite. Same "wait a tick" hack as other tests that exercise
	// OnExit paths.
	if err := mgr.DeletePane("p1", pane.ID); err != nil {
		t.Fatalf("DeletePane: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
}

func TestCreatePaneWith_resume_unknownSessionRejected(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	_, err = mgr.CreatePaneWith("p1", proto.PaneKindClaude, 80, 24, CreatePaneOptions{
		ResumeSessionID: sessions.NewUUID(),
	})
	if err == nil {
		t.Fatal("expected error resuming unknown session")
	}
}

func TestCreatePaneWith_resume_passesResumeFlag(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	// Seed an entry the way CreatePane would have, with a real JSONL on
	// disk so List would also surface it.
	sid := sessions.NewUUID()
	now := time.Now().UTC()
	if err := store.Upsert("p1", sessions.Entry{
		SessionID:    sid,
		Name:         "p1/seed",
		Cwd:          dir,
		CreatedAt:    now,
		LastActiveAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	pane, err := mgr.CreatePaneWith("p1", proto.PaneKindClaude, 80, 24, CreatePaneOptions{ResumeSessionID: sid})
	if err != nil {
		t.Fatalf("CreatePaneWith: %v", err)
	}
	defer mgr.DeletePane("p1", pane.ID)
	if pane.SessionID != sid {
		t.Errorf("pane.SessionID = %q, want %q", pane.SessionID, sid)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		tail := string(pane.ReplayTail(1024))
		if strings.Contains(tail, "--resume") && strings.Contains(tail, sid) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("expected --resume %s in argv; tail=%q", sid, string(pane.ReplayTail(1024)))
}

// TestCreatePaneWith_resume_recoversWorktreeCwdAndSelfHeals — #56: a Claude
// session that ran in a git worktree recorded the project root as its cwd, but
// its transcript lives under the worktree's encoded folder. On resume the
// manager must recover the worktree cwd (so `claude --resume` rehydrates the
// real transcript instead of forking a fresh one) AND self-heal the stored
// Entry.Cwd so subsequent restores hit the canonical path directly.
func TestCreatePaneWith_resume_recoversWorktreeCwdAndSelfHeals(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	root := filepath.Join(dir, "proj")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	gitRun(t, root, "init", "-q")
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	gitRun(t, root, "add", ".")
	gitRun(t, root, "commit", "-q", "-m", "init")
	gitRun(t, root, "worktree", "add", "-q", "-b", "feat-x", filepath.Join(root, ".claude-worktrees", "feat-x"))

	// Match the transcript against the path git actually reports (macOS
	// resolves /var symlinks) so EncodeCwd lines up with recovery.
	worktrees, _ := gitWorktreePaths(root)
	var wtPath string
	for _, p := range worktrees {
		if strings.Contains(p, "feat-x") {
			wtPath = p
		}
	}
	if wtPath == "" {
		t.Fatalf("worktree not enumerated: %v", worktrees)
	}

	claudeDir := filepath.Join(dir, "claude-projects")
	enc := filepath.Join(claudeDir, sessions.EncodeCwd(wtPath))
	if err := os.MkdirAll(enc, 0o755); err != nil {
		t.Fatal(err)
	}
	sid := sessions.NewUUID()
	if err := os.WriteFile(filepath.Join(enc, sid+".jsonl"), []byte(`{"type":"user"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindClaude,
		SessionID:    sid,
		Name:         "p1/seed",
		Cwd:          root, // mis-recorded as the project root
		CreatedAt:    now,
		LastActiveAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	mgr := NewManagerFromConfig(ManagerConfig{
		Projects:          []config.Project{{ID: "p1", Name: "P1", Cwd: root, Shell: []string{"/bin/sh"}}},
		ClaudeCmd:         []string{"/bin/echo"},
		ConfigPath:        filepath.Join(dir, "projects.toml"),
		Sessions:          store,
		ClaudeProjectsDir: claudeDir,
	})
	pane, err := mgr.CreatePaneWith("p1", proto.PaneKindClaude, 80, 24, CreatePaneOptions{ResumeSessionID: sid})
	if err != nil {
		t.Fatalf("CreatePaneWith resume: %v", err)
	}
	defer mgr.DeletePane("p1", pane.ID)

	e, ok, err := store.Get("p1", sid)
	if err != nil || !ok {
		t.Fatalf("store.Get(%s) ok=%v err=%v", sid, ok, err)
	}
	if e.Cwd != wtPath {
		t.Errorf("Entry.Cwd not self-healed: got %q, want the worktree %q", e.Cwd, wtPath)
	}
}

// TestCreatePaneWith_resume_gitUnavailableRefused — when a worktree session's
// transcript survives under a suffixed folder but git can't confirm the
// worktree set (here: the project isn't a git repo, so `git worktree list`
// fails), resume is refused with ErrResumeWorktreeGone rather than relocating
// the transcript. Refusing on an unconfirmed worktree set avoids stranding a
// still-live worktree session on a transient git failure. The session stays
// viewable read-only; the restore path clears was_live on this error.
func TestCreatePaneWith_resume_gitUnavailableRefused(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "proj") // deliberately NOT a git repo → git fails
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	claudeDir := filepath.Join(dir, "claude-projects")
	// Transcript exists under a worktree-suffixed folder with no live worktree.
	gone := filepath.Join(claudeDir, sessions.EncodeCwd(root)+"--claude-worktrees-removed")
	if err := os.MkdirAll(gone, 0o755); err != nil {
		t.Fatal(err)
	}
	sid := sessions.NewUUID()
	if err := os.WriteFile(filepath.Join(gone, sid+".jsonl"), []byte(`{"type":"user"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := store.Upsert("p1", sessions.Entry{
		Kind: proto.PaneKindClaude, SessionID: sid, Name: "p1/gone", Cwd: root,
		CreatedAt: now, LastActiveAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	mgr := NewManagerFromConfig(ManagerConfig{
		Projects:          []config.Project{{ID: "p1", Name: "P1", Cwd: root, Shell: []string{"/bin/sh"}}},
		ClaudeCmd:         []string{"/bin/echo"},
		ConfigPath:        filepath.Join(dir, "projects.toml"),
		Sessions:          store,
		ClaudeProjectsDir: claudeDir,
	})
	_, err = mgr.CreatePaneWith("p1", proto.PaneKindClaude, 80, 24, CreatePaneOptions{ResumeSessionID: sid})
	if !errors.Is(err, ErrResumeWorktreeGone) {
		t.Fatalf("CreatePaneWith resume err = %v, want ErrResumeWorktreeGone", err)
	}
}

// TestCreatePaneWith_resume_goneWorktreeMigratesToProjectRoot — #56, the "jerry"
// case: the session's git worktree was permanently removed (git runs fine and
// simply doesn't list it), but its transcript survives under the suffixed
// folder. Rather than fork a fresh chat, the daemon relocates the transcript
// into the project-root folder and resumes there — same session id, full
// history — and self-heals Entry.Cwd to the project root.
func TestCreatePaneWith_resume_goneWorktreeMigratesToProjectRoot(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	root := filepath.Join(dir, "proj")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	gitRun(t, root, "init", "-q") // a real repo, but with NO matching worktree

	claudeDir := filepath.Join(dir, "claude-projects")
	gone := filepath.Join(claudeDir, sessions.EncodeCwd(root)+"--claude-worktrees-removed")
	if err := os.MkdirAll(gone, 0o755); err != nil {
		t.Fatal(err)
	}
	sid := sessions.NewUUID()
	orphan := filepath.Join(gone, sid+".jsonl")
	if err := os.WriteFile(orphan, []byte(`{"type":"user","text":"the real history"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := store.Upsert("p1", sessions.Entry{
		Kind: proto.PaneKindClaude, SessionID: sid, Name: "p1/jerry", Cwd: root,
		CreatedAt: now, LastActiveAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	mgr := NewManagerFromConfig(ManagerConfig{
		Projects:          []config.Project{{ID: "p1", Name: "P1", Cwd: root, Shell: []string{"/bin/sh"}}},
		ClaudeCmd:         []string{"/bin/echo"},
		ConfigPath:        filepath.Join(dir, "projects.toml"),
		Sessions:          store,
		ClaudeProjectsDir: claudeDir,
	})
	pane, err := mgr.CreatePaneWith("p1", proto.PaneKindClaude, 80, 24, CreatePaneOptions{ResumeSessionID: sid})
	if err != nil {
		t.Fatalf("CreatePaneWith resume (gone worktree) = %v, want migrate+resume", err)
	}
	defer mgr.DeletePane("p1", pane.ID)

	// Same session id — not a fresh spawn.
	if pane.SessionID != sid {
		t.Errorf("pane.SessionID = %q, want the original %q", pane.SessionID, sid)
	}
	// Transcript relocated into the project-root folder (move, not copy).
	dest := sessions.TranscriptPath(claudeDir, root, sid)
	if _, err := os.Stat(dest); err != nil {
		t.Errorf("transcript not relocated to project root %q: %v", dest, err)
	}
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Errorf("orphaned transcript should have been moved, still at %q (err=%v)", orphan, err)
	}
	// Entry.Cwd self-healed to the project root.
	e, ok, err := store.Get("p1", sid)
	if err != nil || !ok {
		t.Fatalf("store.Get ok=%v err=%v", ok, err)
	}
	if e.Cwd != root {
		t.Errorf("Entry.Cwd = %q, want the project root %q", e.Cwd, root)
	}
}

func TestCreatePane_claudeMarksWasLive(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	pane, err := mgr.CreatePane("p1", proto.PaneKindClaude, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	e, ok, _ := store.Get("p1", pane.SessionID)
	if !ok || !e.WasLive {
		t.Fatalf("expected WasLive=true on fresh claude spawn, got entry=%+v ok=%v", e, ok)
	}
}

func TestDeletePane_clearsWasLive(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	pane, err := mgr.CreatePane("p1", proto.PaneKindClaude, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	sid := pane.SessionID
	if err := mgr.DeletePane("p1", pane.ID); err != nil {
		t.Fatal(err)
	}
	e, ok, _ := store.Get("p1", sid)
	if !ok {
		t.Fatal("entry unexpectedly gone after DeletePane")
	}
	if e.WasLive {
		t.Errorf("graceful DeletePane should have cleared WasLive, got %+v", e)
	}
}

func TestRunLivenessTicker_refreshesLastActive(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	pane, err := mgr.CreatePane("p1", proto.PaneKindClaude, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.DeletePane("p1", pane.ID)
	before, _, _ := store.Get("p1", pane.SessionID)

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	// 10ms interval so we see multiple ticks within the timeout.
	mgr.RunLivenessTicker(ctx, 10*time.Millisecond)

	after, _, _ := store.Get("p1", pane.SessionID)
	if !after.LastActiveAt.After(before.LastActiveAt) {
		t.Errorf("ticker should have advanced LastActiveAt: before=%v after=%v", before.LastActiveAt, after.LastActiveAt)
	}
	if !after.WasLive {
		t.Errorf("ticker should keep WasLive set; entry=%+v", after)
	}
}

func TestRunLivenessTicker_nilSessionsStore(t *testing.T) {
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
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	// Should block on ctx.Done() without panicking.
	mgr.RunLivenessTicker(ctx, 10*time.Millisecond)
}

// TestPane_Resize_NoOpsWhenUnchanged verifies that Resize returns nil
// without invoking pty.Setsize when the requested cols/rows match the
// pane's current size. The guard is the "cheap safe fix" from an earlier release: every
// pane switch + refit() used to ship a redundant SIGWINCH to the child,
// and while not confirmed as the wedge cause it's churn we don't need.
//
// We probe behaviour by closing the PTY master after spawn. With the
// guard: a same-size Resize is a plain mutex-only return and doesn't
// touch Tty, so it succeeds. Without the guard: Setsize on a closed fd
// returns an errno. Either branch would be a regression indicator.
func TestPane_Resize_NoOpsWhenUnchanged(t *testing.T) {
	m := newManager(t)
	pane, err := m.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer m.DeletePane("p1", pane.ID)

	// Close the PTY master. Any real Setsize call from here would fail.
	if err := pane.Tty.Close(); err != nil {
		t.Fatalf("close Tty: %v", err)
	}

	if err := pane.Resize(80, 24); err != nil {
		t.Fatalf("Resize(80,24) on unchanged dims should no-op and return nil, got %v", err)
	}
}

// TestPane_Resize_AppliesWhenChanged is the companion to the no-op guard:
// when cols/rows actually differ from the last applied values, Resize
// must still propagate the winsize change through pty.Setsize. We verify
// by observing the new dims via Subscribe (which returns p.cols/p.rows).
func TestPane_Resize_AppliesWhenChanged(t *testing.T) {
	m := newManager(t)
	pane, err := m.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer m.DeletePane("p1", pane.ID)

	if err := pane.Resize(100, 30); err != nil {
		t.Fatalf("Resize(100,30): %v", err)
	}
	_, _, cols, rows, _ := pane.Subscribe(
		make(chan []byte, 1),
		make(chan proto.Stoplight, 1),
		make(chan int, 1),
		make(chan string, 1),
	)
	if cols != 100 || rows != 30 {
		t.Fatalf("pane dims after Resize: want 100x30, got %dx%d", cols, rows)
	}

	// Same-dim call is a no-op but also must not report a regression —
	// Subscribe still shows 100x30.
	if err := pane.Resize(100, 30); err != nil {
		t.Fatalf("same-dim Resize should no-op, got %v", err)
	}
}

// TestCreatePane_shellSlotIDPersists is the Scope B happy path: a fresh
// shell spawn generates a SlotID, persists it under Kind=="shell" with
// the resolved argv, and survives a store reopen (simulating daemon
// restart). This mirrors TestStore_surviveReopen in the sessions package
// but from the manager's end — catches drift between what CreatePane
// writes and what the store expects to read back.
func TestCreatePane_shellSlotIDPersists(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	stateDir := filepath.Join(dir, "sessions")
	store, err := sessions.NewStore(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh", "-l"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	pane, err := mgr.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}
	if pane.SlotID == "" {
		t.Fatal("SlotID should be populated on fresh shell spawn")
	}
	slot := pane.SlotID
	if err := mgr.DeletePane("p1", pane.ID); err != nil {
		t.Fatalf("DeletePane: %v", err)
	}
	// Let OnExit's Touch flush. Without this the tempdir cleanup races
	// the goroutine; same pattern as the other shell-session tests.
	time.Sleep(50 * time.Millisecond)

	// Simulate daemon restart: re-open the store, entry must still be
	// there under the same SlotID with the captured argv.
	store2, err := sessions.NewStore(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	e, ok, err := store2.Get("p1", slot)
	if err != nil || !ok {
		t.Fatalf("post-reopen Get: ok=%v err=%v", ok, err)
	}
	if e.Kind != proto.PaneKindShell {
		t.Errorf("Kind = %q, want shell", e.Kind)
	}
	if e.SlotID != slot {
		t.Errorf("SlotID drift: on-disk %q, want %q", e.SlotID, slot)
	}
	if len(e.ShellArgv) != 2 || e.ShellArgv[0] != "/bin/sh" || e.ShellArgv[1] != "-l" {
		t.Errorf("ShellArgv = %v, want [/bin/sh -l]", e.ShellArgv)
	}
}

// TestCreatePaneWith_restoreSlotID_reusesSlotAndArgv is the Scope B
// restore path: given a seed shell entry with stored argv, a respawn
// under RestoreSlotID must (1) reuse the same SlotID, (2) spawn with
// the stored argv rather than re-resolving the project default, and
// (3) refresh LastPaneID/WasLive on the entry.
func TestCreatePaneWith_restoreSlotID_reusesSlotAndArgv(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	slot := sessions.NewUUID()
	now := time.Now().UTC()
	// Deliberately store an argv DIFFERENT from the project's current
	// shell default — we want to prove the restore path uses the
	// stored argv, not today's Project.Shell. /bin/echo stands in
	// because it prints its argv and exits so we can scrape ReplayTail.
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindShell,
		SlotID:       slot,
		Cwd:          dir,
		ShellArgv:    []string{"/bin/echo", "restored-argv-marker"},
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "p_gone",
		WasLive:      true,
	}); err != nil {
		t.Fatal(err)
	}
	// Project's current default is /bin/sh — drift from the stored argv,
	// on purpose. Restore must ignore it.
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	pane, err := mgr.CreatePaneWith("p1", proto.PaneKindShell, 80, 24, CreatePaneOptions{
		RestoreSlotID: slot,
	})
	if err != nil {
		t.Fatalf("CreatePaneWith restore: %v", err)
	}
	if pane.SlotID != slot {
		t.Errorf("SlotID drift on restore: got %q, want %q", pane.SlotID, slot)
	}
	// The spawned argv should be the stored one, not /bin/sh. We prove
	// this by observing /bin/echo's output — it prints "restored-argv-marker".
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(string(pane.ReplayTail(256)), "restored-argv-marker") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(string(pane.ReplayTail(256)), "restored-argv-marker") {
		t.Fatalf("restore didn't use stored argv; tail=%q", string(pane.ReplayTail(256)))
	}

	// The store entry was refreshed: LastPaneID now points at the new
	// pane, WasLive stays true.
	e, ok, _ := store.Get("p1", slot)
	if !ok {
		t.Fatal("entry missing after restore")
	}
	if e.LastPaneID != pane.ID {
		t.Errorf("LastPaneID = %q, want %q", e.LastPaneID, pane.ID)
	}
	if !e.WasLive {
		t.Errorf("WasLive should stay true after restore")
	}
	_ = mgr.DeletePane("p1", pane.ID)
	time.Sleep(50 * time.Millisecond)
}

// A fresh codex pane must get a persisted slot entry (Kind=codex + a new
// SlotID), mirroring shell — that entry is what makes the pane restorable
// after a daemon restart. Codex needs a resolved binary for the fresh
// spawn, so build the manager with a CodexCmd.
func TestCreatePaneWith_codexFreshSpawnPersistsSlotEntry(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	mgr := NewManagerFromConfig(ManagerConfig{
		Projects:   []config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		ClaudeCmd:  []string{"/bin/echo"},
		CodexCmd:   []string{"/bin/echo", "codex"},
		ConfigPath: configPath,
		Sessions:   store,
	})
	pane, err := mgr.CreatePaneWith("p1", proto.PaneKindCodex, 80, 24, CreatePaneOptions{})
	if err != nil {
		t.Fatalf("CreatePaneWith codex: %v", err)
	}
	if pane.SlotID == "" {
		t.Fatal("fresh codex pane got no SlotID — nothing to restore after a restart")
	}
	e, ok, err := store.Get("p1", pane.SlotID)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("no session entry persisted for a fresh codex pane")
	}
	if e.Kind != proto.PaneKindCodex {
		t.Errorf("entry kind = %q, want codex", e.Kind)
	}
	if e.SlotID != pane.SlotID {
		t.Errorf("entry SlotID = %q, want %q", e.SlotID, pane.SlotID)
	}
	if !e.WasLive {
		t.Errorf("fresh codex entry should be WasLive=true")
	}
	_ = mgr.DeletePane("p1", pane.ID)
	time.Sleep(50 * time.Millisecond)
}

// A codex pane must survive a daemon restart the same way a shell pane
// does: given a seeded codex entry with a stored argv, a respawn under
// RestoreSlotID reuses the SlotID and replays the stored argv. Slot
// continuity is what lets the Satellite rebind the saved codex tab.
func TestCreatePaneWith_restoreSlotID_codexReusesSlotAndArgv(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	slot := sessions.NewUUID()
	now := time.Now().UTC()
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindCodex,
		SlotID:       slot,
		Cwd:          dir,
		ShellArgv:    []string{"/bin/echo", "restored-codex-marker"},
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "p_gone",
		WasLive:      true,
	}); err != nil {
		t.Fatal(err)
	}
	// Restore replays the captured argv, so no CodexCmd is needed here
	// (same as the shell restore path).
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	pane, err := mgr.CreatePaneWith("p1", proto.PaneKindCodex, 80, 24, CreatePaneOptions{
		RestoreSlotID: slot,
	})
	if err != nil {
		t.Fatalf("CreatePaneWith codex restore: %v", err)
	}
	if pane.SlotID != slot {
		t.Errorf("SlotID drift on codex restore: got %q, want %q", pane.SlotID, slot)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(string(pane.ReplayTail(256)), "restored-codex-marker") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(string(pane.ReplayTail(256)), "restored-codex-marker") {
		t.Fatalf("codex restore didn't replay stored argv; tail=%q", string(pane.ReplayTail(256)))
	}
	e, ok, _ := store.Get("p1", slot)
	if !ok {
		t.Fatal("entry missing after codex restore")
	}
	if e.LastPaneID != pane.ID {
		t.Errorf("LastPaneID = %q, want %q", e.LastPaneID, pane.ID)
	}
	if !e.WasLive {
		t.Errorf("WasLive should stay true after codex restore")
	}
	_ = mgr.DeletePane("p1", pane.ID)
	time.Sleep(50 * time.Millisecond)
}

// TestCreatePaneWith_restoreSlotID_usesStoredCwdNotCurrentProjectCwd
// locks in the "restore uses Entry.Cwd, not Project.Cwd" invariant.
// Without this, a shell restore after a project-cwd change would land
// the user in the wrong working directory — silently, because the
// spawned shell looks valid but points at a different checkout.
// (Codex adversarial review HIGH #1.)
func TestCreatePaneWith_restoreSlotID_usesStoredCwdNotCurrentProjectCwd(t *testing.T) {
	dir := t.TempDir()
	originalCwd := filepath.Join(dir, "original")
	currentCwd := filepath.Join(dir, "current")
	for _, p := range []string{originalCwd, currentCwd} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	slot := sessions.NewUUID()
	now := time.Now().UTC()
	// Seed the stored entry with Cwd = originalCwd.
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindShell,
		SlotID:       slot,
		Cwd:          originalCwd,
		ShellArgv:    []string{"/bin/sh"},
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "p_gone",
		WasLive:      true,
	}); err != nil {
		t.Fatal(err)
	}
	// Project's registered cwd is the *current* one — drift from the
	// stored entry, on purpose. Without the fix, Spawn would be called
	// with currentCwd; with the fix, it uses originalCwd from the entry.
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: currentCwd, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	pane, err := mgr.CreatePaneWith("p1", proto.PaneKindShell, 80, 24, CreatePaneOptions{
		RestoreSlotID: slot,
	})
	if err != nil {
		t.Fatalf("CreatePaneWith restore: %v", err)
	}
	if pane.Cwd != originalCwd {
		t.Errorf("restored pane.Cwd = %q, want %q (stored entry cwd)", pane.Cwd, originalCwd)
	}
	if pane.Cmd != nil && pane.Cmd.Dir != originalCwd {
		t.Errorf("restored Cmd.Dir = %q, want %q", pane.Cmd.Dir, originalCwd)
	}
	_ = mgr.DeletePane("p1", pane.ID)
	time.Sleep(50 * time.Millisecond)
}

// TestCreatePaneWith_restoreSlotID_emptyStoredCwdRejected covers the
// defensive guard in shellAdapter.BuildSpawn: a corrupted store row
// with an empty Cwd must fail clean, not fall through to proj.Cwd
// silently.
func TestCreatePaneWith_restoreSlotID_emptyStoredCwdRejected(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	slot := sessions.NewUUID()
	now := time.Now().UTC()
	// Use Upsert with an Argv+Cwd first, then surgically clear Cwd
	// on disk — Upsert rejects shell entries with empty SlotID but
	// not empty Cwd. Keep the test aligned with realistic drift.
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindShell,
		SlotID:       slot,
		Cwd:          "", // simulate a corrupted row
		ShellArgv:    []string{"/bin/sh"},
		CreatedAt:    now,
		LastActiveAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	_, err = mgr.CreatePaneWith("p1", proto.PaneKindShell, 80, 24, CreatePaneOptions{
		RestoreSlotID: slot,
	})
	if err == nil {
		t.Fatal("expected error for empty stored Cwd on restore")
	}
	if !strings.Contains(err.Error(), "stored cwd") {
		t.Errorf("error should mention 'stored cwd'; got %v", err)
	}
}

// TestCreatePaneWith_restoreSlotID_liveSlotRejected locks in the
// duplicate-prevention guard (Codex HIGH #2): once a slot is attached
// to a running pane, a second RestoreSlotID request for the same slot
// must fail with ErrSlotAlreadyLive — not silently spawn a duplicate
// that would alias the same store row.
func TestCreatePaneWith_restoreSlotID_liveSlotRejected(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	// Fresh spawn first → pane is live under a fresh SlotID.
	pane1, err := mgr.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	slot := pane1.SlotID
	if slot == "" {
		t.Fatal("fresh shell pane must have a SlotID")
	}
	defer func() {
		_ = mgr.DeletePane("p1", pane1.ID)
		time.Sleep(50 * time.Millisecond)
	}()

	// Attempt to restore the same slot while pane1 is still live.
	_, err = mgr.CreatePaneWith("p1", proto.PaneKindShell, 80, 24, CreatePaneOptions{
		RestoreSlotID: slot,
	})
	if err == nil {
		t.Fatal("expected ErrSlotAlreadyLive for live-slot restore")
	}
	if !errors.Is(err, ErrSlotAlreadyLive) {
		t.Errorf("err = %v, want ErrSlotAlreadyLive wrap", err)
	}
}

// TestCreatePaneWith_restoreSlotID_concurrentRestoreOnlyOneWins is the
// atomicity guarantee: two goroutines racing to restore the same
// SlotID — exactly one must succeed, the other must get
// ErrSlotAlreadyLive. Guards against the check/register race that
// would otherwise let both pass the "is this slot live?" test before
// either had registered the new pane.
func TestCreatePaneWith_restoreSlotID_concurrentRestoreOnlyOneWins(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	slot := sessions.NewUUID()
	now := time.Now().UTC()
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindShell,
		SlotID:       slot,
		Cwd:          dir,
		ShellArgv:    []string{"/bin/sh"},
		CreatedAt:    now,
		LastActiveAt: now,
		WasLive:      true,
	}); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	// Fire N goroutines at the same slot and count winners. Even two
	// would be enough to catch the race in most schedulers; bumping to
	// 8 gives the race detector more surface to trip on.
	const N = 8
	var (
		wg          sync.WaitGroup
		successes   atomic.Int32
		conflicts   atomic.Int32
		otherErrors atomic.Int32
		winnerMu    sync.Mutex
		winner      *Pane
	)
	start := make(chan struct{})
	wg.Add(N)
	for i := 0; i < N; i++ {
		go func() {
			defer wg.Done()
			<-start
			p, err := mgr.CreatePaneWith("p1", proto.PaneKindShell, 80, 24, CreatePaneOptions{
				RestoreSlotID: slot,
			})
			if err == nil {
				successes.Add(1)
				winnerMu.Lock()
				if winner == nil {
					winner = p
				}
				winnerMu.Unlock()
			} else if errors.Is(err, ErrSlotAlreadyLive) {
				conflicts.Add(1)
			} else {
				otherErrors.Add(1)
				t.Logf("unexpected error kind: %v", err)
			}
		}()
	}
	close(start)
	wg.Wait()
	if successes.Load() != 1 {
		t.Errorf("successes = %d, want exactly 1", successes.Load())
	}
	if conflicts.Load() != N-1 {
		t.Errorf("conflicts = %d, want %d", conflicts.Load(), N-1)
	}
	if otherErrors.Load() != 0 {
		t.Errorf("otherErrors = %d, want 0", otherErrors.Load())
	}
	if winner != nil {
		_ = mgr.DeletePane("p1", winner.ID)
		time.Sleep(50 * time.Millisecond)
	}
}

// TestCreatePaneWith_restoreSlotID_releasedAfterDelete: once the
// winning pane is deleted, the slot is free for a subsequent restore.
// Locks in that the reservation map is not "sticky" past the pane's
// lifetime.
func TestCreatePaneWith_restoreSlotID_releasedAfterDelete(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	slot := sessions.NewUUID()
	now := time.Now().UTC()
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindShell,
		SlotID:       slot,
		Cwd:          dir,
		ShellArgv:    []string{"/bin/sh"},
		CreatedAt:    now,
		LastActiveAt: now,
		WasLive:      true,
	}); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	first, err := mgr.CreatePaneWith("p1", proto.PaneKindShell, 80, 24, CreatePaneOptions{
		RestoreSlotID: slot,
	})
	if err != nil {
		t.Fatalf("first restore: %v", err)
	}
	if err := mgr.DeletePane("p1", first.ID); err != nil {
		t.Fatalf("DeletePane: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	second, err := mgr.CreatePaneWith("p1", proto.PaneKindShell, 80, 24, CreatePaneOptions{
		RestoreSlotID: slot,
	})
	if err != nil {
		t.Fatalf("second restore after delete: %v", err)
	}
	if second.SlotID != slot {
		t.Errorf("second.SlotID = %q, want %q", second.SlotID, slot)
	}
	_ = mgr.DeletePane("p1", second.ID)
	time.Sleep(50 * time.Millisecond)
}

// TestCreatePaneWith_restoreSlotID_unknownRejected: restoring against a
// bogus SlotID must error cleanly rather than spawning a fresh shell.
// Mirrors the Claude unknown-resume guard.
func TestCreatePaneWith_restoreSlotID_unknownRejected(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	_, err = mgr.CreatePaneWith("p1", proto.PaneKindShell, 80, 24, CreatePaneOptions{
		RestoreSlotID: sessions.NewUUID(),
	})
	if err == nil {
		t.Fatal("expected error for unknown restore_slot_id")
	}
}

// TestCreatePaneWith_restoreSlotID_rejectsClaude: the daemon rejects
// RestoreSlotID for a Claude pane request — mixing the two identities
// would be a bug waiting to happen.
func TestCreatePaneWith_restoreSlotID_rejectsClaude(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	_, err = mgr.CreatePaneWith("p1", proto.PaneKindClaude, 80, 24, CreatePaneOptions{
		RestoreSlotID: sessions.NewUUID(),
	})
	if err == nil {
		t.Fatal("expected error when pairing RestoreSlotID with PaneKindClaude")
	}
}

// TestSetPaneDisplayName_shellPane is the rename-endpoint drive-by fix:
// before Scope B the handler keyed by SessionID only, so shell panes
// were always rejected (the error message even said "only claude panes
// can be renamed persistently"). With SlotID in place, shell panes now
// route through the same SetDisplayName path keyed by their identity.
func TestSetPaneDisplayName_shellPane(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	pane, err := mgr.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = mgr.DeletePane("p1", pane.ID)
		time.Sleep(50 * time.Millisecond)
	}()
	if err := mgr.SetPaneDisplayName("p1", pane.ID, "my-shell"); err != nil {
		t.Fatalf("SetPaneDisplayName on shell pane should succeed, got %v", err)
	}
	e, ok, _ := store.Get("p1", pane.SlotID)
	if !ok || e.DisplayName != "my-shell" {
		t.Fatalf("display_name not persisted on shell entry: ok=%v e=%+v", ok, e)
	}
	// ProjectDetail should surface the label back on the shell row.
	detail, _ := mgr.ProjectDetail("p1")
	var found bool
	for _, pn := range detail.Panes {
		if pn.ID == pane.ID {
			found = true
			if pn.DisplayName != "my-shell" {
				t.Errorf("pn.DisplayName = %q, want my-shell", pn.DisplayName)
			}
			if pn.SlotID != pane.SlotID {
				t.Errorf("pn.SlotID = %q, want %q", pn.SlotID, pane.SlotID)
			}
		}
	}
	if !found {
		t.Fatal("shell pane missing from ProjectDetail")
	}
}

// --- an earlier release: AutoName on ProjectDetail ---
//
// These tests exercise the Manager → AutoNameCache → Pane.AutoName
// plumbing. Each test writes a synthetic Claude Code JSONL transcript
// into a tmp ClaudeProjectsDir so the cache has a concrete file to
// stat/read, and asserts ProjectDetail produces the expected shape.

// autoNameTestManager builds a Manager wired with a sessions store + a
// per-test ClaudeProjectsDir so the autoname cache can be seeded with
// a deterministic transcript. The project cwd is the Claude session's
// "cwd" — both must agree for EncodeCwd to produce a matching slug.
func autoNameTestManager(t *testing.T) (*Manager, string, string, *sessions.Store) {
	t.Helper()
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	claudeDir := filepath.Join(dir, "claude-projects-root")
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	projCwd := filepath.Join(dir, "proj")
	if err := os.MkdirAll(projCwd, 0o755); err != nil {
		t.Fatal(err)
	}
	mgr := NewManagerFromConfig(ManagerConfig{
		Projects:          []config.Project{{ID: "p1", Name: "P1", Cwd: projCwd, Shell: []string{"/bin/sh"}}},
		ClaudeCmd:         []string{"/bin/echo"},
		DefaultShell:      []string{"/bin/sh"},
		ConfigPath:        configPath,
		Sessions:          store,
		ClaudeProjectsDir: claudeDir,
	})
	return mgr, claudeDir, projCwd, store
}

// writeClaudeTranscript drops a JSONL at claudeDir/<cwd-slug>/<sid>.jsonl
// with the given body — matching Claude Code's on-disk layout so the
// AutoNameCache resolves the same path it would in production.
func writeClaudeTranscript(t *testing.T, claudeDir, cwd, sid, body string) {
	t.Helper()
	slug := sessions.EncodeCwd(cwd)
	dir := filepath.Join(claudeDir, slug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	p := filepath.Join(dir, sid+".jsonl")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestProjectDetail_populatesAutoNameForClaudePane(t *testing.T) {
	mgr, claudeDir, projCwd, _ := autoNameTestManager(t)

	pane, err := mgr.CreatePane("p1", proto.PaneKindClaude, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = mgr.DeletePane("p1", pane.ID)
		time.Sleep(50 * time.Millisecond)
	}()
	if pane.SessionID == "" {
		t.Fatal("expected SessionID populated on claude pane")
	}

	writeClaudeTranscript(t, claudeDir, projCwd, pane.SessionID,
		`{"type":"custom-title","customTitle":"refactor broker","sessionId":"`+pane.SessionID+`"}
`)

	detail, ok := mgr.ProjectDetail("p1")
	if !ok {
		t.Fatal("project not found")
	}
	var found bool
	for _, pn := range detail.Panes {
		if pn.ID != pane.ID {
			continue
		}
		found = true
		if pn.AutoName != "refactor broker" {
			t.Errorf("AutoName = %q, want %q", pn.AutoName, "refactor broker")
		}
		if pn.DisplayName != "" {
			t.Errorf("DisplayName should stay empty when only AutoName is set, got %q", pn.DisplayName)
		}
	}
	if !found {
		t.Fatal("claude pane missing from ProjectDetail")
	}
}

func TestProjectDetail_skipsAutoNameWhenDisplayNameSet(t *testing.T) {
	mgr, claudeDir, projCwd, _ := autoNameTestManager(t)

	pane, err := mgr.CreatePane("p1", proto.PaneKindClaude, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = mgr.DeletePane("p1", pane.ID)
		time.Sleep(50 * time.Millisecond)
	}()
	writeClaudeTranscript(t, claudeDir, projCwd, pane.SessionID,
		`{"type":"custom-title","customTitle":"ignored auto","sessionId":"`+pane.SessionID+`"}
`)
	if err := mgr.SetPaneDisplayName("p1", pane.ID, "user-chosen"); err != nil {
		t.Fatalf("SetPaneDisplayName: %v", err)
	}

	// Reset the readCount so the next ProjectDetail call is the one
	// we're asserting on. We didn't call ProjectDetail yet, so this
	// is already 0 — but be explicit about the intent.
	if n := mgr.autoNames.ReadCountForTest(); n != 0 {
		t.Fatalf("precondition: expected readCount=0 before first ProjectDetail, got %d", n)
	}

	detail, _ := mgr.ProjectDetail("p1")
	for _, pn := range detail.Panes {
		if pn.ID != pane.ID {
			continue
		}
		if pn.DisplayName != "user-chosen" {
			t.Errorf("DisplayName = %q, want %q", pn.DisplayName, "user-chosen")
		}
		if pn.AutoName != "" {
			t.Errorf("AutoName should be empty when DisplayName is set, got %q", pn.AutoName)
		}
	}
	// The DisplayName-wins guard in ProjectDetail must short-circuit
	// BEFORE the AutoNameCache Lookup — i.e. no JSONL read should have
	// happened.
	if n := mgr.autoNames.ReadCountForTest(); n != 0 {
		t.Errorf("readCount = %d, want 0 (DisplayName set ⇒ no JSONL read)", n)
	}
}

func TestProjectDetail_shellPaneNoAutoName(t *testing.T) {
	mgr, claudeDir, projCwd, _ := autoNameTestManager(t)

	pane, err := mgr.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = mgr.DeletePane("p1", pane.ID)
		time.Sleep(50 * time.Millisecond)
	}()

	// Lay down a transcript keyed by the shell pane's SlotID — even
	// this should NOT produce an AutoName, because shell panes have
	// no Claude session and the ProjectDetail branch filters them out
	// before calling into the cache.
	writeClaudeTranscript(t, claudeDir, projCwd, pane.SlotID,
		`{"type":"custom-title","customTitle":"should never show","sessionId":"`+pane.SlotID+`"}
`)

	detail, _ := mgr.ProjectDetail("p1")
	for _, pn := range detail.Panes {
		if pn.ID != pane.ID {
			continue
		}
		if pn.AutoName != "" {
			t.Errorf("shell pane should not have AutoName, got %q", pn.AutoName)
		}
	}
	if n := mgr.autoNames.ReadCountForTest(); n != 0 {
		t.Errorf("shell pane triggered JSONL read: readCount=%d, want 0", n)
	}
}

func TestProjectDetail_autoNameCacheShortCircuitsOnRepeatedPoll(t *testing.T) {
	mgr, claudeDir, projCwd, _ := autoNameTestManager(t)

	pane, err := mgr.CreatePane("p1", proto.PaneKindClaude, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = mgr.DeletePane("p1", pane.ID)
		time.Sleep(50 * time.Millisecond)
	}()
	writeClaudeTranscript(t, claudeDir, projCwd, pane.SessionID,
		`{"type":"custom-title","customTitle":"cached","sessionId":"`+pane.SessionID+`"}
`)

	// First poll: one JSONL read.
	_, _ = mgr.ProjectDetail("p1")
	if n := mgr.autoNames.ReadCountForTest(); n != 1 {
		t.Fatalf("first poll: readCount=%d, want 1", n)
	}
	// Second poll with no file change: must short-circuit on mtime.
	_, _ = mgr.ProjectDetail("p1")
	if n := mgr.autoNames.ReadCountForTest(); n != 1 {
		t.Errorf("second poll should hit cache: readCount=%d, want 1", n)
	}

	// Third poll AFTER rewriting the transcript: must re-read.
	slug := sessions.EncodeCwd(projCwd)
	path := filepath.Join(claudeDir, slug, pane.SessionID+".jsonl")
	if err := os.WriteFile(path, []byte(
		`{"type":"custom-title","customTitle":"updated","sessionId":"`+pane.SessionID+`"}
{"type":"custom-title","customTitle":"latest","sessionId":"`+pane.SessionID+`"}
`), 0o600); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(path, future, future); err != nil {
		t.Fatal(err)
	}
	detail, _ := mgr.ProjectDetail("p1")
	var autoName string
	for _, pn := range detail.Panes {
		if pn.ID == pane.ID {
			autoName = pn.AutoName
		}
	}
	if autoName != "latest" {
		t.Errorf("post-rewrite AutoName = %q, want %q", autoName, "latest")
	}
	if n := mgr.autoNames.ReadCountForTest(); n != 2 {
		t.Errorf("post-rewrite: readCount=%d, want 2", n)
	}
}

// TestProjectDetail_autoNameForgetOnPaneExit locks in that the cache's
// per-pane row is dropped when the pane exits, so a long-lived daemon
// doesn't accumulate rows for dead panes.
func TestProjectDetail_autoNameForgetOnPaneExit(t *testing.T) {
	mgr, claudeDir, projCwd, _ := autoNameTestManager(t)

	pane, err := mgr.CreatePane("p1", proto.PaneKindClaude, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	writeClaudeTranscript(t, claudeDir, projCwd, pane.SessionID,
		`{"type":"custom-title","customTitle":"x","sessionId":"`+pane.SessionID+`"}
`)
	_, _ = mgr.ProjectDetail("p1")
	if n := mgr.autoNames.EntryCountForTest(); n != 1 {
		t.Fatalf("pre-exit entryCount=%d, want 1", n)
	}
	if err := mgr.DeletePane("p1", pane.ID); err != nil {
		t.Fatal(err)
	}
	// Wait for onExit callbacks to run (cmd.Wait is in a goroutine).
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if mgr.autoNames.EntryCountForTest() == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Errorf("post-exit entryCount=%d, want 0", mgr.autoNames.EntryCountForTest())
}

// strconvQuote produces a $'…' shell-safe string that preserves all bytes
// (including escape and BEL) when printed via `printf '%s'`.
func strconvQuote(s string) string {
	var b []byte
	b = append(b, '$', '\'')
	for _, c := range []byte(s) {
		if c == '\'' {
			b = append(b, '\'', '\\', '\'', '\'')
			continue
		}
		if c < 0x20 || c == 0x7f || c > 0x7e {
			b = append(b, '\\', 'x')
			hex := "0123456789abcdef"
			b = append(b, hex[c>>4], hex[c&0xf])
			continue
		}
		b = append(b, c)
	}
	b = append(b, '\'')
	return string(b)
}

// TestCreatePaneWith_globalPreamble_passesToArgv confirms a
// CreatePaneOptions.GlobalPreamble surfaces in the spawned Claude argv
// (baseline disabled so the marker is the only preamble content).
func TestCreatePaneWith_globalPreamble_passesToArgv(t *testing.T) {
	t.Setenv("RECK_DISABLE_BASELINE_PREAMBLE", "1")
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	const marker = "RECK_GLOBAL_MARKER_pty_thread_test"
	pane, err := mgr.CreatePaneWith("p1", proto.PaneKindClaude, 80, 24, CreatePaneOptions{
		GlobalPreamble: marker,
	})
	if err != nil {
		t.Fatalf("CreatePaneWith: %v", err)
	}
	defer mgr.DeletePane("p1", pane.ID)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		tail := string(pane.ReplayTail(2048))
		if strings.Contains(tail, "--append-system-prompt") && strings.Contains(tail, marker) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("expected %s in --append-system-prompt argv; tail=%q", marker, string(pane.ReplayTail(2048)))
}
