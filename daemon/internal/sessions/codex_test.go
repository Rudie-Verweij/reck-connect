package sessions

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/proto"
)

func newCodexTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewStore(filepath.Join(t.TempDir(), "sessions"))
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return s
}

// codexRow writes the placeholder row the Manager creates before starting a
// fresh codex pane: keyed by SlotID, with no thread id yet.
func codexRow(t *testing.T, s *Store, projectID, slotID string) {
	t.Helper()
	now := time.Now().UTC()
	if err := s.Upsert(projectID, Entry{
		Kind:         proto.PaneKindCodex,
		SlotID:       slotID,
		Cwd:          "/tmp/project",
		CreatedAt:    now,
		LastActiveAt: now,
		WasLive:      true,
	}); err != nil {
		t.Fatalf("seed codex row: %v", err)
	}
}

func getBySlot(t *testing.T, s *Store, projectID, slotID string) Entry {
	t.Helper()
	e, ok, err := s.Get(projectID, slotID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !ok {
		t.Fatalf("row for slot %q not found", slotID)
	}
	return e
}

func TestSetThreadID_recordsAndReportsPrevious(t *testing.T) {
	s := newCodexTestStore(t)
	codexRow(t, s, "proj", "slot-1")

	prev, err := s.SetThreadID("proj", "slot-1", "thread-aaa")
	if err != nil {
		t.Fatalf("SetThreadID: %v", err)
	}
	if prev != "" {
		t.Errorf("first capture returned prev = %q, want empty", prev)
	}
	if got := getBySlot(t, s, "proj", "slot-1").ThreadID; got != "thread-aaa" {
		t.Errorf("ThreadID = %q, want thread-aaa", got)
	}

	// A changed thread id must be reported so the caller can flag the drift.
	prev, err = s.SetThreadID("proj", "slot-1", "thread-bbb")
	if err != nil {
		t.Fatalf("SetThreadID (second): %v", err)
	}
	if prev != "thread-aaa" {
		t.Errorf("prev = %q, want thread-aaa", prev)
	}
	if got := getBySlot(t, s, "proj", "slot-1").ThreadID; got != "thread-bbb" {
		t.Errorf("ThreadID = %q, want the new value to win", got)
	}
}

// Clearing a thread id is not a supported operation — a codex thread UUID is
// fixed for the life of the pane, so an empty value must not erase a captured
// one.
func TestSetThreadID_emptyIsNoOp(t *testing.T) {
	s := newCodexTestStore(t)
	codexRow(t, s, "proj", "slot-1")
	if _, err := s.SetThreadID("proj", "slot-1", "thread-aaa"); err != nil {
		t.Fatalf("SetThreadID: %v", err)
	}
	if _, err := s.SetThreadID("proj", "slot-1", ""); err != nil {
		t.Fatalf("SetThreadID(empty): %v", err)
	}
	if got := getBySlot(t, s, "proj", "slot-1").ThreadID; got != "thread-aaa" {
		t.Errorf("ThreadID = %q, want the captured value to survive", got)
	}
}

// A pane can exit and be collected from the index before its hook lands.
func TestSetThreadID_unknownSlotIsNoOp(t *testing.T) {
	s := newCodexTestStore(t)
	prev, err := s.SetThreadID("proj", "nonexistent", "thread-aaa")
	if err != nil {
		t.Fatalf("SetThreadID: %v", err)
	}
	if prev != "" {
		t.Errorf("prev = %q, want empty", prev)
	}
}

// The Manager upserts a codex row at spawn, before SessionStart fires, and
// re-upserts afterwards (and again from the liveness ticker) with a
// freshly-built Entry whose ThreadID is empty. Those later writes must not
// blank out the value captured in between, or the pane silently stops being
// resumable.
func TestUpsert_preservesCapturedThreadID(t *testing.T) {
	s := newCodexTestStore(t)
	codexRow(t, s, "proj", "slot-1")
	if _, err := s.SetThreadID("proj", "slot-1", "thread-aaa"); err != nil {
		t.Fatalf("SetThreadID: %v", err)
	}

	now := time.Now().UTC()
	if err := s.Upsert("proj", Entry{
		Kind:         proto.PaneKindCodex,
		SlotID:       "slot-1",
		Cwd:          "/tmp/project",
		ShellArgv:    []string{"/bin/codex"},
		CreatedAt:    now,
		LastActiveAt: now,
		WasLive:      true,
	}); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}

	e := getBySlot(t, s, "proj", "slot-1")
	if e.ThreadID != "thread-aaa" {
		t.Errorf("ThreadID = %q, want it preserved across re-upsert", e.ThreadID)
	}
	if len(e.ShellArgv) != 1 || e.ShellArgv[0] != "/bin/codex" {
		t.Errorf("ShellArgv = %v, want the re-upsert to still land its own fields", e.ShellArgv)
	}
}

// An explicitly-supplied ThreadID still wins, so a caller that does know the
// value can set it.
func TestUpsert_explicitThreadIDWins(t *testing.T) {
	s := newCodexTestStore(t)
	codexRow(t, s, "proj", "slot-1")
	if _, err := s.SetThreadID("proj", "slot-1", "thread-aaa"); err != nil {
		t.Fatalf("SetThreadID: %v", err)
	}
	now := time.Now().UTC()
	if err := s.Upsert("proj", Entry{
		Kind:         proto.PaneKindCodex,
		SlotID:       "slot-1",
		Cwd:          "/tmp/project",
		ThreadID:     "thread-explicit",
		CreatedAt:    now,
		LastActiveAt: now,
	}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if got := getBySlot(t, s, "proj", "slot-1").ThreadID; got != "thread-explicit" {
		t.Errorf("ThreadID = %q, want thread-explicit", got)
	}
}

// The thread id must survive a round-trip through the on-disk JSON, since the
// whole point is resuming after the daemon restarts.
func TestThreadID_survivesReload(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sessions")
	s1, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	codexRow(t, s1, "proj", "slot-1")
	if _, err := s1.SetThreadID("proj", "slot-1", "thread-aaa"); err != nil {
		t.Fatalf("SetThreadID: %v", err)
	}

	s2, err := NewStore(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	e := getBySlot(t, s2, "proj", "slot-1")
	if e.ThreadID != "thread-aaa" {
		t.Errorf("ThreadID after reload = %q, want thread-aaa", e.ThreadID)
	}
	if e.Kind != proto.PaneKindCodex {
		t.Errorf("Kind after reload = %q, want codex", e.Kind)
	}
}
