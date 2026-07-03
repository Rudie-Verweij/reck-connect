package pty

import (
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/proto"
)

// TestArchiveProject_killsPanesButKeepsWasLive is the core archive contract:
// panes are torn down (freeing RAM) but the session rows keep was_live=true
// — the single thing that separates archive from a graceful DeletePane — so
// the project can be woken later.
func TestArchiveProject_killsPanesButKeepsWasLive(t *testing.T) {
	mgr, store, _ := newManagerWithStore(t)

	pane, err := mgr.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	slot := pane.SlotID
	if e, ok, gerr := store.Get("p1", slot); gerr != nil || !ok || !e.WasLive {
		t.Fatalf("precondition: expected live entry with WasLive=true; ok=%v err=%v", ok, gerr)
	}

	if err := mgr.ArchiveProject("p1"); err != nil {
		t.Fatalf("ArchiveProject: %v", err)
	}

	// Panes gone (RAM freed).
	if got := len(mgr.PanesInProject("p1")); got != 0 {
		t.Fatalf("PanesInProject after archive = %d, want 0", got)
	}
	// was_live preserved (NOT cleared the way DeletePane would).
	e, ok, gerr := store.Get("p1", slot)
	if gerr != nil || !ok {
		t.Fatalf("entry missing after archive: ok=%v err=%v", ok, gerr)
	}
	if !e.WasLive {
		t.Errorf("WasLive = false after archive; want true (archive must not clear it)")
	}
	time.Sleep(50 * time.Millisecond)
}

// TestArchiveProject_thenRestoreOrphansSkips verifies an archived project
// stays asleep across the boot-restore walk — otherwise a daemon restart
// would resurrect exactly the panes the user put to sleep.
func TestArchiveProject_thenRestoreOrphansSkips(t *testing.T) {
	mgr, _, _ := newManagerWithStore(t)

	if _, err := mgr.CreatePane("p1", proto.PaneKindShell, 80, 24); err != nil {
		t.Fatal(err)
	}
	if err := mgr.ArchiveProject("p1"); err != nil {
		t.Fatalf("ArchiveProject: %v", err)
	}

	r := mgr.RestoreOrphans(80, 24)
	if r.Restored != 0 {
		t.Errorf("RestoreOrphans restored %d panes for an archived project; want 0", r.Restored)
	}
	if got := len(mgr.PanesInProject("p1")); got != 0 {
		t.Errorf("archived project has %d live panes after RestoreOrphans; want 0", got)
	}
	time.Sleep(50 * time.Millisecond)
}

// TestUnarchiveProject_respawnsPanes verifies unarchive brings back exactly
// the panes that were live, keyed by their stable slot identity.
func TestUnarchiveProject_respawnsPanes(t *testing.T) {
	mgr, _, _ := newManagerWithStore(t)

	pane, err := mgr.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	slot := pane.SlotID

	if err := mgr.ArchiveProject("p1"); err != nil {
		t.Fatalf("ArchiveProject: %v", err)
	}
	if got := len(mgr.PanesInProject("p1")); got != 0 {
		t.Fatalf("panes not torn down by archive: %d", got)
	}

	if err := mgr.UnarchiveProject("p1", 80, 24); err != nil {
		t.Fatalf("UnarchiveProject: %v", err)
	}
	live := mgr.PanesInProject("p1")
	if len(live) != 1 {
		t.Fatalf("panes after unarchive = %d, want 1", len(live))
	}
	if live[0].SlotID != slot {
		t.Errorf("respawned SlotID = %q, want %q (identity must be preserved)", live[0].SlotID, slot)
	}

	for _, p := range live {
		_ = mgr.DeletePane("p1", p.ID)
	}
	time.Sleep(50 * time.Millisecond)
}

// TestArchiveProject_unknownProjectErrors — archiving/unarchiving a project
// that isn't registered is an error (mirrors SetDocked).
func TestArchiveProject_unknownProjectErrors(t *testing.T) {
	mgr, _, _ := newManagerWithStore(t)
	if err := mgr.ArchiveProject("nope"); err == nil {
		t.Error("expected error archiving unknown project, got nil")
	}
	if err := mgr.UnarchiveProject("nope", 80, 24); err == nil {
		t.Error("expected error unarchiving unknown project, got nil")
	}
}
