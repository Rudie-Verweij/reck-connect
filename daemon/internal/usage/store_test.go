package usage

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func f64(v float64) *float64 { return &v }
func i64(v int64) *int64     { return &v }

func TestOpenCreatesDBAndInstallID(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()
	if s.InstallID() == "" {
		t.Fatal("expected non-empty install id")
	}
	if _, err := os.Stat(filepath.Join(dir, DBFilename)); err != nil {
		t.Fatalf("expected db file: %v", err)
	}

	// Reopen must preserve the install id (stable across restarts).
	got := s.InstallID()
	s.Close()
	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	if s2.InstallID() != got {
		t.Fatalf("install id changed on reopen: %q -> %q", got, s2.InstallID())
	}
}

func TestInsertContextSample(t *testing.T) {
	s := openTestStore(t)
	now := time.Unix(1_700_000_000, 0).UTC()
	cs := ContextSample{
		TS: now, SessionID: "sess-1", PaneID: "pane-1", ProjectID: "proj-1",
		Agent: "claude-code", Model: "claude-opus-4-8",
		ContextInputTokens: 41234, ContextWindowSize: 200000, UsedPct: 20.6,
		CurInput: 1200, CurOutput: 900, CacheCreation: 5000, CacheRead: 38000,
		Source: "statusline",
	}
	if err := s.InsertContextSample(cs); err != nil {
		t.Fatalf("insert: %v", err)
	}
	got, err := s.LatestContextForSession("sess-1")
	if err != nil {
		t.Fatalf("latest: %v", err)
	}
	if got == nil {
		t.Fatal("expected a row")
	}
	if got.ContextInputTokens != 41234 || got.UsedPct != 20.6 || got.CacheRead != 38000 {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
	if got.Agent != "claude-code" || got.PaneID != "pane-1" {
		t.Fatalf("attribution mismatch: %+v", got)
	}
}

func TestInsertQuotaSample_PartialBuckets(t *testing.T) {
	s := openTestStore(t)
	// Only five_hour and seven_day present; opus/sonnet absent.
	qs := QuotaSample{
		TS:                time.Unix(1_700_000_100, 0).UTC(),
		FiveHour:          Bucket{Pct: f64(23.5), ResetsAt: i64(1738425600)},
		SevenDay:          Bucket{Pct: f64(41.2), ResetsAt: i64(1738857600)},
		ReportedBySession: "sess-1", Source: "statusline",
	}
	if err := s.InsertQuotaSample(qs); err != nil {
		t.Fatalf("insert quota: %v", err)
	}
	got, err := s.LatestQuota()
	if err != nil {
		t.Fatalf("latest quota: %v", err)
	}
	if got == nil {
		t.Fatal("expected quota row")
	}
	if got.FiveHour.Pct == nil || *got.FiveHour.Pct != 23.5 {
		t.Fatalf("five_hour pct: %+v", got.FiveHour)
	}
	if got.SevenDay.ResetsAt == nil || *got.SevenDay.ResetsAt != 1738857600 {
		t.Fatalf("seven_day resets_at: %+v", got.SevenDay)
	}
	if got.SevenDayOpus.Pct != nil || got.SevenDaySonnet.Pct != nil {
		t.Fatalf("absent buckets should be nil: %+v %+v", got.SevenDayOpus, got.SevenDaySonnet)
	}
}

func TestInsertTurnUsage_DedupByMessageID(t *testing.T) {
	s := openTestStore(t)
	tu := TurnUsage{
		MessageID: "msg-abc", TS: time.Unix(1_700_000_200, 0).UTC(),
		SessionID: "sess-1", ProjectID: "proj-1", Agent: "claude-code",
		Model: "claude-opus-4-8", InputTokens: 1000, OutputTokens: 500,
		CacheCreation: 200, CacheRead: 3000,
	}
	inserted, err := s.InsertTurnUsage(tu)
	if err != nil {
		t.Fatalf("insert turn: %v", err)
	}
	if !inserted {
		t.Fatal("first insert should report inserted=true")
	}
	// Second insert of the same message_id (e.g. a re-read, or a second
	// concurrent agent seeing the same transcript) must be ignored.
	inserted, err = s.InsertTurnUsage(tu)
	if err != nil {
		t.Fatalf("second insert: %v", err)
	}
	if inserted {
		t.Fatal("duplicate message_id should report inserted=false")
	}
	if _, err := s.InsertTurnUsage(TurnUsage{MessageID: ""}); err == nil {
		t.Fatal("empty message_id should error")
	}
}

func TestUpsertSession_AdvancesLastSeenPreservesFirst(t *testing.T) {
	s := openTestStore(t)
	t1 := time.Unix(1_700_000_000, 0).UTC()
	t2 := t1.Add(10 * time.Minute)
	if err := s.UpsertSession("sess-1", "proj-1", "claude-code", "claude-opus-4-8", "", t1); err != nil {
		t.Fatalf("upsert 1: %v", err)
	}
	if err := s.UpsertSession("sess-1", "", "", "", "My Pane", t2); err != nil {
		t.Fatalf("upsert 2: %v", err)
	}
	row, err := s.GetSession("sess-1")
	if err != nil || row == nil {
		t.Fatalf("get session: %v row=%v", err, row)
	}
	if !row.FirstSeen.Equal(t1) {
		t.Fatalf("first_seen moved: %v want %v", row.FirstSeen, t1)
	}
	if !row.LastSeen.Equal(t2) {
		t.Fatalf("last_seen not advanced: %v want %v", row.LastSeen, t2)
	}
	// Empty fields on the second call must not erase earlier detail.
	if row.ProjectID != "proj-1" || row.Agent != "claude-code" {
		t.Fatalf("sparse upsert erased detail: %+v", row)
	}
	// Non-empty field on the second call updates.
	if row.DisplayName != "My Pane" {
		t.Fatalf("display_name not updated: %+v", row)
	}
}
