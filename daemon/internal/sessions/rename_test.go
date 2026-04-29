package sessions

import (
	"testing"
	"time"
)

// TestSetDisplayName_roundTripsThroughGet walks a session through set →
// get → clear → get. Guards the common path a rename endpoint takes.
func TestSetDisplayName_roundTripsThroughGet(t *testing.T) {
	s, _ := newStore(t)
	sid := NewUUID()
	if err := s.Upsert("proj", Entry{
		SessionID:    sid,
		Name:         "proj/abc",
		Cwd:          "/tmp/proj",
		CreatedAt:    time.Now(),
		LastActiveAt: time.Now(),
	}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	if err := s.SetDisplayName("proj", sid, "My Label"); err != nil {
		t.Fatalf("SetDisplayName: %v", err)
	}
	got, ok, err := s.Get("proj", sid)
	if err != nil || !ok {
		t.Fatalf("Get: ok=%v err=%v", ok, err)
	}
	if got.DisplayName != "My Label" {
		t.Fatalf("DisplayName = %q, want %q", got.DisplayName, "My Label")
	}

	// Clearing round-trips too.
	if err := s.SetDisplayName("proj", sid, ""); err != nil {
		t.Fatalf("clear: %v", err)
	}
	got, _, _ = s.Get("proj", sid)
	if got.DisplayName != "" {
		t.Fatalf("expected DisplayName empty after clear, got %q", got.DisplayName)
	}
}

// TestSetDisplayName_unknownSessionIsNoOp mirrors Touch/SetLive semantics:
// racing with a session deletion shouldn't surface as an error.
func TestSetDisplayName_unknownSessionIsNoOp(t *testing.T) {
	s, _ := newStore(t)
	if err := s.SetDisplayName("proj", "does-not-exist", "Whatever"); err != nil {
		t.Fatalf("expected nil, got %v", err)
	}
}

// TestSetDisplayName_emptySessionIDIsNoOp matches the Touch convention —
// callers sometimes hand us a shell pane with no session_id.
func TestSetDisplayName_emptySessionIDIsNoOp(t *testing.T) {
	s, _ := newStore(t)
	if err := s.SetDisplayName("proj", "", "Whatever"); err != nil {
		t.Fatalf("expected nil for empty session_id, got %v", err)
	}
}

// TestUpsert_preservesDisplayNameOnResume is the whole point of persisting
// the label in the sessions store: a resume upserts a fresh Entry (built
// from the new pane's view) and must not clobber a rename the user
// performed before the kickstart.
func TestUpsert_preservesDisplayNameOnResume(t *testing.T) {
	s, _ := newStore(t)
	sid := NewUUID()
	now := time.Now()
	if err := s.Upsert("proj", Entry{
		SessionID: sid, Name: "proj/abc", Cwd: "/tmp", CreatedAt: now, LastActiveAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetDisplayName("proj", sid, "Deployment Agent"); err != nil {
		t.Fatal(err)
	}
	// Simulate a respawn: Manager builds a fresh Entry without DisplayName.
	if err := s.Upsert("proj", Entry{
		SessionID: sid, Name: "proj/abc", Cwd: "/tmp", LastActiveAt: now.Add(time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	got, _, _ := s.Get("proj", sid)
	if got.DisplayName != "Deployment Agent" {
		t.Fatalf("Upsert clobbered DisplayName; got %q want %q", got.DisplayName, "Deployment Agent")
	}
}
