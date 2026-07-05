package sessions

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"
)

func TestEncodeCwd(t *testing.T) {
	cases := map[string]string{
		"/Users/reck-connect/projects/reck-connect": "-Users-reck-connect-projects-reck-connect",
		"/tmp":              "-tmp",
		"/a/b.c/d_e":        "-a-b-c-d-e",
		"/Users/Foo/Bar123": "-Users-Foo-Bar123",
	}
	for in, want := range cases {
		if got := EncodeCwd(in); got != want {
			t.Errorf("EncodeCwd(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNewUUID_shape(t *testing.T) {
	re := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	seen := make(map[string]bool)
	for i := 0; i < 50; i++ {
		u := NewUUID()
		if !re.MatchString(u) {
			t.Fatalf("NewUUID() = %q, not a valid RFC 4122 v4 UUID", u)
		}
		if seen[u] {
			t.Fatalf("NewUUID() repeated: %q", u)
		}
		seen[u] = true
	}
}

func newStore(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return s, dir
}

func TestUpsertThenList_returnsEntryWhenTranscriptExists(t *testing.T) {
	s, dir := newStore(t)
	cwd := "/a/b/c"
	claudeDir := filepath.Join(dir, "claude-projects")
	encoded := filepath.Join(claudeDir, EncodeCwd(cwd))
	if err := os.MkdirAll(encoded, 0o755); err != nil {
		t.Fatal(err)
	}
	sid := NewUUID()
	if err := os.WriteFile(filepath.Join(encoded, sid+".jsonl"), []byte(`{"type":"user"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := s.Upsert("p1", Entry{
		SessionID:    sid,
		Name:         "p1/pane-a",
		Cwd:          cwd,
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "p_abc",
	}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	got, err := s.List("p1", ListOptions{ClaudeProjectsDir: claudeDir})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 || got[0].SessionID != sid {
		t.Fatalf("List = %+v, want one entry with session %s", got, sid)
	}
}

func TestList_filtersWhenTranscriptMissing(t *testing.T) {
	s, dir := newStore(t)
	claudeDir := filepath.Join(dir, "claude-projects")
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := s.Upsert("p1", Entry{
		SessionID:    NewUUID(),
		Name:         "dead",
		Cwd:          "/nope",
		CreatedAt:    now,
		LastActiveAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := s.List("p1", ListOptions{ClaudeProjectsDir: claudeDir})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected missing transcript to be filtered, got %+v", got)
	}
}

func TestList_keepsWorktreeSessionUnderSuffixedDir(t *testing.T) {
	// Failsafe for #56: a Claude session run in a git worktree stores its
	// transcript under <EncodeCwd(cwd)>--claude-worktrees-<name>/, not the
	// project-root folder. The entry's Cwd is the project root, so the
	// canonical lookup misses — List must still keep the entry (via the
	// worktree-suffix glob) instead of dropping the tab on restore.
	s, dir := newStore(t)
	cwd := "/a/b/c"
	claudeDir := filepath.Join(dir, "claude-projects")
	worktreeDir := filepath.Join(claudeDir, EncodeCwd(cwd)+"--claude-worktrees-fts5")
	if err := os.MkdirAll(worktreeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sid := NewUUID()
	if err := os.WriteFile(filepath.Join(worktreeDir, sid+".jsonl"), []byte(`{"type":"user"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := s.Upsert("p1", Entry{
		SessionID:    sid,
		Name:         "p1/pane-a",
		Cwd:          cwd, // recorded as the project root, NOT the worktree
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "p_abc",
	}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	got, err := s.List("p1", ListOptions{ClaudeProjectsDir: claudeDir})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 || got[0].SessionID != sid {
		t.Fatalf("List = %+v, want the worktree session kept", got)
	}
}

func TestResolveTranscriptCwd(t *testing.T) {
	// #56 Layer B: given a set of candidate cwds (project root + its git
	// worktrees), return the one whose EncodeCwd() folder actually holds the
	// transcript. This recovers the real runtime cwd WITHOUT lossy-decoding a
	// folder name, so a mis-recorded worktree session can be resumed in the
	// directory Claude actually wrote to.
	claudeDir := t.TempDir()
	root := "/home/u/proj"
	worktree := "/home/u/proj/.claude-worktrees/feat-x"
	sid := NewUUID()

	seed := func(cwd string) {
		dir := filepath.Join(claudeDir, EncodeCwd(cwd))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, sid+".jsonl"), []byte(`{"type":"user"}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("canonical candidate wins", func(t *testing.T) {
		dir := t.TempDir()
		encoded := filepath.Join(dir, EncodeCwd(root))
		if err := os.MkdirAll(encoded, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(encoded, sid+".jsonl"), []byte(`x`), 0o600); err != nil {
			t.Fatal(err)
		}
		got, ok := ResolveTranscriptCwd(dir, sid, []string{root, worktree})
		if !ok || got != root {
			t.Fatalf("ResolveTranscriptCwd = (%q, %v), want (%q, true)", got, ok, root)
		}
	})

	t.Run("worktree candidate recovered when canonical misses", func(t *testing.T) {
		seed(worktree)
		got, ok := ResolveTranscriptCwd(claudeDir, sid, []string{root, worktree})
		if !ok || got != worktree {
			t.Fatalf("ResolveTranscriptCwd = (%q, %v), want (%q, true)", got, ok, worktree)
		}
	})

	t.Run("no candidate holds the transcript", func(t *testing.T) {
		got, ok := ResolveTranscriptCwd(t.TempDir(), NewUUID(), []string{root, worktree})
		if ok || got != "" {
			t.Fatalf("ResolveTranscriptCwd = (%q, %v), want (\"\", false)", got, ok)
		}
	})

	t.Run("first matching candidate wins", func(t *testing.T) {
		dir := t.TempDir()
		for _, cwd := range []string{root, worktree} {
			enc := filepath.Join(dir, EncodeCwd(cwd))
			if err := os.MkdirAll(enc, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(enc, sid+".jsonl"), []byte(`x`), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		got, _ := ResolveTranscriptCwd(dir, sid, []string{worktree, root})
		if got != worktree {
			t.Fatalf("ResolveTranscriptCwd first-match = %q, want %q", got, worktree)
		}
	})
}

func TestList_sortsByLastActiveDesc(t *testing.T) {
	s, dir := newStore(t)
	cwd := "/x/y"
	claudeDir := filepath.Join(dir, "claude-projects")
	encoded := filepath.Join(claudeDir, EncodeCwd(cwd))
	if err := os.MkdirAll(encoded, 0o755); err != nil {
		t.Fatal(err)
	}
	t0 := time.Now().UTC().Add(-2 * time.Hour)
	t1 := time.Now().UTC().Add(-1 * time.Hour)
	t2 := time.Now().UTC()

	upsert := func(sid, name string, active time.Time) {
		if err := os.WriteFile(filepath.Join(encoded, sid+".jsonl"), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := s.Upsert("p1", Entry{
			SessionID:    sid,
			Name:         name,
			Cwd:          cwd,
			CreatedAt:    active,
			LastActiveAt: active,
		}); err != nil {
			t.Fatal(err)
		}
	}
	a, b, c := NewUUID(), NewUUID(), NewUUID()
	upsert(a, "oldest", t0)
	upsert(c, "newest", t2)
	upsert(b, "middle", t1)

	got, err := s.List("p1", ListOptions{ClaudeProjectsDir: claudeDir})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("want 3, got %d", len(got))
	}
	if got[0].SessionID != c || got[1].SessionID != b || got[2].SessionID != a {
		t.Fatalf("sort order wrong: %s, %s, %s", got[0].Name, got[1].Name, got[2].Name)
	}
}

func TestTouch_updatesLastActiveAndPaneID(t *testing.T) {
	s, dir := newStore(t)
	cwd := "/x"
	claudeDir := filepath.Join(dir, "claude-projects")
	encoded := filepath.Join(claudeDir, EncodeCwd(cwd))
	if err := os.MkdirAll(encoded, 0o755); err != nil {
		t.Fatal(err)
	}
	sid := NewUUID()
	if err := os.WriteFile(filepath.Join(encoded, sid+".jsonl"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	t0 := time.Now().UTC().Add(-1 * time.Hour)
	if err := s.Upsert("p1", Entry{SessionID: sid, Name: "n", Cwd: cwd, CreatedAt: t0, LastActiveAt: t0, LastPaneID: "old"}); err != nil {
		t.Fatal(err)
	}

	t1 := time.Now().UTC()
	if err := s.Touch("p1", sid, "new", t1); err != nil {
		t.Fatalf("Touch: %v", err)
	}
	e, ok, err := s.Get("p1", sid)
	if err != nil || !ok {
		t.Fatalf("Get: ok=%v err=%v", ok, err)
	}
	if !e.LastActiveAt.Equal(t1) {
		t.Errorf("LastActiveAt = %v, want %v", e.LastActiveAt, t1)
	}
	if e.LastPaneID != "new" {
		t.Errorf("LastPaneID = %q, want new", e.LastPaneID)
	}
	if !e.CreatedAt.Equal(t0) {
		t.Errorf("Touch clobbered CreatedAt: got %v, want %v", e.CreatedAt, t0)
	}
}

func TestTouch_unknownSessionIsNoOp(t *testing.T) {
	s, _ := newStore(t)
	// No upsert first — Touch on an unknown id should silently succeed.
	if err := s.Touch("p1", NewUUID(), "", time.Now()); err != nil {
		t.Fatalf("Touch: %v", err)
	}
}

func TestUpsert_preservesCreatedAtOnResume(t *testing.T) {
	s, dir := newStore(t)
	cwd := "/p"
	claudeDir := filepath.Join(dir, "claude-projects")
	encoded := filepath.Join(claudeDir, EncodeCwd(cwd))
	if err := os.MkdirAll(encoded, 0o755); err != nil {
		t.Fatal(err)
	}
	sid := NewUUID()
	_ = os.WriteFile(filepath.Join(encoded, sid+".jsonl"), []byte("{}"), 0o600)

	t0 := time.Now().UTC().Add(-24 * time.Hour)
	if err := s.Upsert("p1", Entry{SessionID: sid, Cwd: cwd, CreatedAt: t0, LastActiveAt: t0}); err != nil {
		t.Fatal(err)
	}
	// Resume upsert with zero CreatedAt should preserve original.
	t1 := time.Now().UTC()
	if err := s.Upsert("p1", Entry{SessionID: sid, Cwd: cwd, LastActiveAt: t1, LastPaneID: "p2"}); err != nil {
		t.Fatal(err)
	}
	e, _, _ := s.Get("p1", sid)
	if !e.CreatedAt.Equal(t0) {
		t.Errorf("CreatedAt = %v, want %v", e.CreatedAt, t0)
	}
	if e.LastPaneID != "p2" {
		t.Errorf("LastPaneID = %q, want p2", e.LastPaneID)
	}
}

func TestSetLive_togglesFlagWithoutTouchingTimestamps(t *testing.T) {
	s, dir := newStore(t)
	cwd := "/x"
	claudeDir := filepath.Join(dir, "claude-projects")
	encoded := filepath.Join(claudeDir, EncodeCwd(cwd))
	if err := os.MkdirAll(encoded, 0o755); err != nil {
		t.Fatal(err)
	}
	sid := NewUUID()
	_ = os.WriteFile(filepath.Join(encoded, sid+".jsonl"), []byte("{}"), 0o600)
	t0 := time.Now().UTC().Add(-1 * time.Hour)
	if err := s.Upsert("p1", Entry{
		SessionID:    sid,
		Cwd:          cwd,
		CreatedAt:    t0,
		LastActiveAt: t0,
		WasLive:      true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetLive("p1", sid, false); err != nil {
		t.Fatalf("SetLive: %v", err)
	}
	e, _, _ := s.Get("p1", sid)
	if e.WasLive {
		t.Errorf("WasLive should be false after SetLive(false)")
	}
	if !e.LastActiveAt.Equal(t0) {
		t.Errorf("SetLive clobbered LastActiveAt: got %v, want %v", e.LastActiveAt, t0)
	}

	if err := s.SetLive("p1", sid, true); err != nil {
		t.Fatal(err)
	}
	e, _, _ = s.Get("p1", sid)
	if !e.WasLive {
		t.Errorf("WasLive should be true after SetLive(true)")
	}
}

func TestTouch_preservesWasLive(t *testing.T) {
	s, dir := newStore(t)
	cwd := "/x"
	claudeDir := filepath.Join(dir, "claude-projects")
	encoded := filepath.Join(claudeDir, EncodeCwd(cwd))
	if err := os.MkdirAll(encoded, 0o755); err != nil {
		t.Fatal(err)
	}
	sid := NewUUID()
	_ = os.WriteFile(filepath.Join(encoded, sid+".jsonl"), []byte("{}"), 0o600)
	t0 := time.Now().UTC().Add(-1 * time.Hour)
	if err := s.Upsert("p1", Entry{SessionID: sid, Cwd: cwd, CreatedAt: t0, LastActiveAt: t0, WasLive: true}); err != nil {
		t.Fatal(err)
	}
	if err := s.Touch("p1", sid, "pX", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	e, _, _ := s.Get("p1", sid)
	if !e.WasLive {
		t.Error("Touch should not have cleared WasLive")
	}
}

func TestStore_surviveReopen(t *testing.T) {
	dir := t.TempDir()
	stateDir := filepath.Join(dir, "sessions")
	s1, err := NewStore(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	cwd := "/r"
	claudeDir := filepath.Join(dir, "claude-projects")
	encoded := filepath.Join(claudeDir, EncodeCwd(cwd))
	if err := os.MkdirAll(encoded, 0o755); err != nil {
		t.Fatal(err)
	}
	sid := NewUUID()
	_ = os.WriteFile(filepath.Join(encoded, sid+".jsonl"), []byte("{}"), 0o600)
	now := time.Now().UTC()
	if err := s1.Upsert("p1", Entry{SessionID: sid, Name: "persists", Cwd: cwd, CreatedAt: now, LastActiveAt: now}); err != nil {
		t.Fatal(err)
	}
	// Simulate daemon restart.
	s2, err := NewStore(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s2.List("p1", ListOptions{ClaudeProjectsDir: claudeDir})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Name != "persists" {
		t.Fatalf("expected entry to survive reopen, got %+v", got)
	}
}
