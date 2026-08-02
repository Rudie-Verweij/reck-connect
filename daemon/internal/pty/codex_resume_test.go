package pty

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
	"github.com/rudie-verweij/reck-connect/proto"
)

// newCodexManager builds a Manager with a live session index and a usable
// codex binary. /bin/cat holds its PTY open without exiting, which is all a
// spawned pane needs to stay alive for the assertions.
//
// The session store deliberately lives outside t.TempDir: a pane's OnExit
// callback touches its index row, and finalizeExit closes the exit channel
// *before* running those callbacks, so there's no way to wait for the last
// write. Under t.TempDir that late write races the strict cleanup and fails
// the test with "directory not empty". Here a straggler just leaves a temp
// dir for the OS to reap.
func newCodexManager(t *testing.T) (*Manager, *sessions.Store, string) {
	t.Helper()
	root := t.TempDir()
	configPath := filepath.Join(root, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	sessDir, err := os.MkdirTemp("", "reck-codex-sessions-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(sessDir) })
	store, err := sessions.NewStore(sessDir)
	if err != nil {
		t.Fatalf("sessions.NewStore: %v", err)
	}
	mgr := NewManagerFromConfig(ManagerConfig{
		Projects:   []config.Project{{ID: "p1", Name: "P1", Cwd: root, Shell: []string{"/bin/sh"}, Available: true}},
		ClaudeCmd:  []string{"/bin/echo"},
		ConfigPath: configPath,
		Sessions:   store,
		CodexCmd:   []string{"/bin/cat"},
	})
	return mgr, store, root
}

// A fresh codex pane must have its index row in place by the time it is
// reachable, because its SessionStart hook can fire before CreatePane
// returns and SetThreadID silently no-ops against a missing row.
func TestCreatePane_codexRowExistsForThreadCapture(t *testing.T) {
	mgr, store, _ := newCodexManager(t)
	pane, err := mgr.CreatePane("p1", proto.PaneKindCodex, 80, 24)
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}
	defer func() { _ = mgr.DeletePane("p1", pane.ID) }()

	if pane.SlotID == "" {
		t.Fatal("codex pane has no SlotID")
	}
	e, ok, err := store.Get("p1", pane.SlotID)
	if err != nil || !ok {
		t.Fatalf("no index row for codex slot: ok=%v err=%v", ok, err)
	}
	if e.Kind != proto.PaneKindCodex {
		t.Errorf("row Kind = %q, want codex", e.Kind)
	}

	// The capture path must land on that row.
	mgr.RecordCodexThread(pane.ID, "thread-1")
	e, _, err = store.Get("p1", pane.SlotID)
	if err != nil {
		t.Fatal(err)
	}
	if e.ThreadID != "thread-1" {
		t.Errorf("ThreadID = %q, want thread-1", e.ThreadID)
	}
}

// A codex pane's identity stays its SlotID. Putting the thread UUID on
// pane.SessionID would divert the liveness/rename/touch paths, which prefer
// SessionID, to a key that no row is filed under.
func TestRecordCodexThread_leavesPaneSessionIDEmpty(t *testing.T) {
	mgr, _, _ := newCodexManager(t)
	pane, err := mgr.CreatePane("p1", proto.PaneKindCodex, 80, 24)
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}
	defer func() { _ = mgr.DeletePane("p1", pane.ID) }()

	mgr.RecordCodexThread(pane.ID, "thread-1")
	if pane.SessionID != "" {
		t.Errorf("pane.SessionID = %q, want empty so SlotID stays the row identity", pane.SessionID)
	}
}

// Non-codex panes and unknown ids must be ignored rather than writing to
// somebody else's row.
func TestRecordCodexThread_ignoresNonCodexAndUnknownPanes(t *testing.T) {
	mgr, store, _ := newCodexManager(t)
	shell, err := mgr.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatalf("CreatePane(shell): %v", err)
	}
	defer func() { _ = mgr.DeletePane("p1", shell.ID) }()

	mgr.RecordCodexThread(shell.ID, "thread-1")
	if e, ok, _ := store.Get("p1", shell.SlotID); ok && e.ThreadID != "" {
		t.Errorf("shell row picked up ThreadID %q", e.ThreadID)
	}
	// Must not panic or write anything.
	mgr.RecordCodexThread("p_nonexistent", "thread-1")
}

// Restoring a codex pane by slot id has to rebuild `codex resume <UUID>`.
// The client only knows the slot id, so the daemon hydrates the thread from
// the row — without that the pane would come back as a fresh conversation.
func TestCreatePane_codexRestoreHydratesThreadFromRow(t *testing.T) {
	mgr, store, _ := newCodexManager(t)
	first, err := mgr.CreatePane("p1", proto.PaneKindCodex, 80, 24)
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}
	slot := first.SlotID
	mgr.RecordCodexThread(first.ID, "thread-abc")
	if err := mgr.DeletePane("p1", first.ID); err != nil {
		t.Fatalf("DeletePane: %v", err)
	}

	restored, err := mgr.CreatePaneWith("p1", proto.PaneKindCodex, 80, 24, CreatePaneOptions{
		RestoreSlotID: slot,
	})
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	defer func() { _ = mgr.DeletePane("p1", restored.ID) }()

	if restored.SlotID != slot {
		t.Errorf("restored SlotID = %q, want the original %q", restored.SlotID, slot)
	}
	argv := restored.Cmd.Args
	if len(argv) < 3 || argv[1] != "resume" {
		t.Fatalf("argv = %v, want a `resume` subcommand", argv)
	}
	if last := argv[len(argv)-1]; last != "thread-abc" {
		t.Errorf("argv ends with %q, want the hydrated thread UUID", last)
	}
	// The row must still be keyed the same way and keep its thread.
	e, ok, err := store.Get("p1", slot)
	if err != nil || !ok {
		t.Fatalf("row missing after restore: ok=%v err=%v", ok, err)
	}
	if e.ThreadID != "thread-abc" {
		t.Errorf("ThreadID after restore = %q, want thread-abc", e.ThreadID)
	}
}

// A codex row whose pane died before reporting a thread has nothing to
// resume. It must still come back — replaying the captured argv — rather than
// erroring or being dropped.
func TestCreatePane_codexRestoreWithoutThreadStillSpawns(t *testing.T) {
	mgr, _, _ := newCodexManager(t)
	first, err := mgr.CreatePane("p1", proto.PaneKindCodex, 80, 24)
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}
	slot := first.SlotID
	if err := mgr.DeletePane("p1", first.ID); err != nil {
		t.Fatalf("DeletePane: %v", err)
	}

	restored, err := mgr.CreatePaneWith("p1", proto.PaneKindCodex, 80, 24, CreatePaneOptions{
		RestoreSlotID: slot,
	})
	if err != nil {
		t.Fatalf("restore without a thread should still spawn: %v", err)
	}
	defer func() { _ = mgr.DeletePane("p1", restored.ID) }()

	for _, a := range restored.Cmd.Args {
		if a == "resume" {
			t.Fatalf("argv = %v, want no resume subcommand when there is no thread", restored.Cmd.Args)
		}
	}
}
