package sessions

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/proto"
)

// TestLoad_preMigration_defaultsKindToClaude covers the an earlier release Scope B
// on-disk migration: rows written by a pre-Scope-B daemon have no "kind"
// field. loadLocked() must default Kind to "claude" so existing indexes
// keep working. The test uses an inline JSON fixture rather than a
// golden file so it's self-contained and easy to review — the point is
// the load-time behavior, not the exact byte layout of old files.
func TestLoad_preMigration_defaultsKindToClaude(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	// Pre-Scope-B shape: no "kind", no "slot_id", no "shell_argv".
	// Matches what sessions.json looks like on a station still running
	// the Older daemon. Timestamps deliberately round-tripped as
	// RFC3339Nano so the read-back comparison is stable.
	now := time.Now().UTC().Truncate(time.Second)
	sid := NewUUID()
	preMigration := []byte(`{
	  "entries": [
	    {
	      "session_id": "` + sid + `",
	      "name": "proj/abc",
	      "cwd": "/tmp/proj",
	      "created_at": "` + now.Format(time.RFC3339Nano) + `",
	      "last_active_at": "` + now.Format(time.RFC3339Nano) + `",
	      "last_pane_id": "p_legacy",
	      "was_live": true
	    }
	  ]
	}`)
	path := filepath.Join(s.Dir(), "p1.json")
	if err := os.WriteFile(path, preMigration, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	// First read: Kind defaulted to claude; other fields untouched.
	got, ok, err := s.Get("p1", sid)
	if err != nil || !ok {
		t.Fatalf("Get: ok=%v err=%v", ok, err)
	}
	if got.Kind != proto.PaneKindClaude {
		t.Errorf("Kind = %q, want %q", got.Kind, proto.PaneKindClaude)
	}
	if got.SessionID != sid {
		t.Errorf("SessionID = %q, want %q", got.SessionID, sid)
	}
	if got.Name != "proj/abc" {
		t.Errorf("Name = %q, want proj/abc", got.Name)
	}
	if got.Cwd != "/tmp/proj" {
		t.Errorf("Cwd = %q, want /tmp/proj", got.Cwd)
	}
	if got.LastPaneID != "p_legacy" {
		t.Errorf("LastPaneID = %q, want p_legacy", got.LastPaneID)
	}
	if !got.WasLive {
		t.Errorf("WasLive = false, want true")
	}
	if got.SlotID != "" {
		t.Errorf("SlotID = %q, want empty on migrated Claude row", got.SlotID)
	}
	if len(got.ShellArgv) != 0 {
		t.Errorf("ShellArgv = %v, want empty", got.ShellArgv)
	}

	// Round-trip: Upsert writes the migrated Entry back. Read again and
	// assert the on-disk shape now has kind="claude" explicitly, and
	// every other field is preserved.
	if err := s.Upsert("p1", got); err != nil {
		t.Fatalf("Upsert migrated entry: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var onDisk fileFormat
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatalf("reparse: %v", err)
	}
	if len(onDisk.Entries) != 1 {
		t.Fatalf("want 1 entry, got %d", len(onDisk.Entries))
	}
	if onDisk.Entries[0].Kind != proto.PaneKindClaude {
		t.Errorf("persisted Kind = %q, want claude", onDisk.Entries[0].Kind)
	}
	// Through a second Get, the entry round-trips cleanly.
	got2, ok, err := s.Get("p1", sid)
	if err != nil || !ok {
		t.Fatalf("second Get: ok=%v err=%v", ok, err)
	}
	if got2.SessionID != got.SessionID || got2.Name != got.Name || got2.Cwd != got.Cwd {
		t.Errorf("round-trip drift: got=%+v want=%+v", got2, got)
	}
	if got2.LastPaneID != got.LastPaneID || got2.WasLive != got.WasLive {
		t.Errorf("round-trip drift on LastPaneID/WasLive: got=%+v want=%+v", got2, got)
	}
}

// TestUpsert_requiresSlotIDForShell locks in the write-side invariant:
// a shell entry with no SlotID is rejected. Mirror to the Claude rule
// that's asserted through the existing TestUpsert_* tests.
func TestUpsert_requiresSlotIDForShell(t *testing.T) {
	s, _ := newStore(t)
	err := s.Upsert("p1", Entry{Kind: proto.PaneKindShell, Cwd: "/tmp"})
	if err == nil {
		t.Fatal("expected error for shell entry with no SlotID")
	}
}

// TestClaudeWithBogusSlotID_usesSessionIDForIdentity locks in the
// invariant that Claude panes key by SessionID even if a stray SlotID
// made it onto the entry somehow. Guards against the "belt-and-braces
// bug" where we might accidentally route through SlotID for a Claude
// entry and split its identity across two rows.
func TestClaudeWithBogusSlotID_usesSessionIDForIdentity(t *testing.T) {
	s, _ := newStore(t)
	sid := NewUUID()
	stray := NewUUID()
	now := time.Now().UTC()
	if err := s.Upsert("p1", Entry{
		Kind:         proto.PaneKindClaude,
		SessionID:    sid,
		SlotID:       stray, // a bug stuffed a slot id onto a Claude entry
		Name:         "claude-with-bug",
		Cwd:          "/tmp",
		CreatedAt:    now,
		LastActiveAt: now,
		WasLive:      true,
	}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	// Get by SessionID finds it.
	if _, ok, _ := s.Get("p1", sid); !ok {
		t.Errorf("Get by SessionID failed on Claude entry with bogus SlotID")
	}
	// Get by the stray SlotID must MISS — Claude's identity is SessionID.
	if _, ok, _ := s.Get("p1", stray); ok {
		t.Errorf("Get by SlotID must not match Claude entry (identity = SessionID)")
	}
}
