package usage

import (
	"strconv"
	"testing"
	"time"
)

func itoa(v int64) string   { return strconv.FormatInt(v, 10) }
func ftoa(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// fakeClock lets tests advance time deterministically.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time { return c.t }
func (c *fakeClock) add(d time.Duration) {
	c.t = c.t.Add(d)
}

func newTestIngester(t *testing.T) (*Ingester, *Store, *fakeClock) {
	t.Helper()
	s := openTestStore(t)
	clk := &fakeClock{t: time.Unix(1_700_000_000, 0).UTC()}
	ing := NewIngester(s)
	ing.now = clk.now
	return ing, s, clk
}

const fullPayload = `{
  "session_id": "sess-1",
  "transcript_path": "/Users/x/.claude/projects/foo/sess-1.jsonl",
  "cwd": "/Users/x/secret-project",
  "model": { "id": "claude-opus-4-8", "display_name": "Opus" },
  "context_window": {
    "total_input_tokens": 40000, "context_window_size": 200000, "used_percentage": 20,
    "current_usage": { "input_tokens": 1200, "output_tokens": 900,
      "cache_creation_input_tokens": 5000, "cache_read_input_tokens": 33800 }
  },
  "rate_limits": {
    "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
    "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
  }
}`

func meta() IngestMeta {
	return IngestMeta{PaneID: "pane-1", ProjectID: "proj-1", Agent: "claude-code"}
}

func TestIngest_FullPayload_WritesContextAndQuota(t *testing.T) {
	ing, s, _ := newTestIngester(t)
	res, err := ing.Ingest(meta(), []byte(fullPayload))
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	if !res.ContextWritten || !res.QuotaWritten || !res.SessionSeen {
		t.Fatalf("expected all written, got %+v", res)
	}
	cs, _ := s.LatestContextForSession("sess-1")
	if cs == nil || cs.ContextInputTokens != 40000 || cs.CacheRead != 33800 {
		t.Fatalf("context not stored correctly: %+v", cs)
	}
	if cs.PaneID != "pane-1" || cs.ProjectID != "proj-1" || cs.Agent != "claude-code" {
		t.Fatalf("attribution wrong: %+v", cs)
	}
	q, _ := s.LatestQuota()
	if q == nil || q.FiveHour.Pct == nil || *q.FiveHour.Pct != 23.5 {
		t.Fatalf("quota not stored: %+v", q)
	}
	if q.ModelFamily != "opus" {
		t.Fatalf("model family: %q", q.ModelFamily)
	}
	// The session dimension row exists (liveness).
	if row, _ := s.GetSession("sess-1"); row == nil {
		t.Fatal("expected agent_sessions row")
	}
}

func TestIngest_MissingRateLimits_OnlyContext(t *testing.T) {
	ing, s, _ := newTestIngester(t)
	payload := `{"session_id":"s","model":{"id":"claude-sonnet-5"},
	  "context_window":{"total_input_tokens":10,"context_window_size":200000,"used_percentage":0}}`
	res, err := ing.Ingest(meta(), []byte(payload))
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	if !res.ContextWritten || res.QuotaWritten {
		t.Fatalf("expected context only, got %+v", res)
	}
	if n, _ := s.CountQuotaSamples(); n != 0 {
		t.Fatalf("expected 0 quota rows, got %d", n)
	}
}

func TestIngest_MissingContextWindow_OnlyQuota(t *testing.T) {
	ing, s, _ := newTestIngester(t)
	payload := `{"session_id":"s","model":{"id":"claude-opus-4-8"},
	  "rate_limits":{"five_hour":{"used_percentage":5,"resets_at":1}}}`
	res, err := ing.Ingest(meta(), []byte(payload))
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	if res.ContextWritten || !res.QuotaWritten {
		t.Fatalf("expected quota only, got %+v", res)
	}
	if n, _ := s.CountContextSamples(""); n != 0 {
		t.Fatalf("expected 0 context rows, got %d", n)
	}
}

func TestIngest_Malformed_ReturnsError(t *testing.T) {
	ing, _, _ := newTestIngester(t)
	if _, err := ing.Ingest(meta(), []byte("not json")); err == nil {
		t.Fatal("expected error on malformed payload")
	}
}

func TestIngest_IdleReRender_NoDuplicateRows(t *testing.T) {
	ing, s, clk := newTestIngester(t)
	if _, err := ing.Ingest(meta(), []byte(fullPayload)); err != nil {
		t.Fatal(err)
	}
	// Re-send identical payload several times within and beyond the cap:
	// unchanged numbers must never produce another row.
	for k := 0; k < 5; k++ {
		clk.add(30 * time.Second)
		if _, err := ing.Ingest(meta(), []byte(fullPayload)); err != nil {
			t.Fatal(err)
		}
	}
	if n, _ := s.CountContextSamples("sess-1"); n != 1 {
		t.Fatalf("idle re-renders wrote %d rows, want 1", n)
	}
	if n, _ := s.CountQuotaSamples(); n != 1 {
		t.Fatalf("idle quota re-renders wrote %d rows, want 1", n)
	}
}

// smallChangePayload nudges context by a sub-jump amount and quota unchanged.
func smallCtxPayload(tokens int64, pct float64) string {
	return `{"session_id":"sess-1","model":{"id":"claude-opus-4-8"},
	 "context_window":{"total_input_tokens":` + itoa(tokens) + `,"context_window_size":200000,"used_percentage":` + ftoa(pct) + `}}`
}

func TestIngest_RateCap_CoalescesSmallChanges(t *testing.T) {
	ing, s, clk := newTestIngester(t)
	// First sample.
	if _, err := ing.Ingest(meta(), []byte(smallCtxPayload(40000, 20))); err != nil {
		t.Fatal(err)
	}
	// A small change 10s later (below jump thresholds, within cap): withheld.
	clk.add(10 * time.Second)
	res, _ := ing.Ingest(meta(), []byte(smallCtxPayload(40100, 20.05)))
	if res.ContextWritten {
		t.Fatal("small in-cap change should be withheld, not written")
	}
	if n, _ := s.CountContextSamples("sess-1"); n != 1 {
		t.Fatalf("expected 1 row so far, got %d", n)
	}
	// Cross the cap: another small change should now write.
	clk.add(51 * time.Second) // total 61s since first write
	res, _ = ing.Ingest(meta(), []byte(smallCtxPayload(40200, 20.1)))
	if !res.ContextWritten {
		t.Fatal("change after cap elapsed should write")
	}
	if n, _ := s.CountContextSamples("sess-1"); n != 2 {
		t.Fatalf("expected 2 rows, got %d", n)
	}
}

func TestIngest_LargeJump_WritesImmediately(t *testing.T) {
	ing, s, clk := newTestIngester(t)
	if _, err := ing.Ingest(meta(), []byte(smallCtxPayload(40000, 20))); err != nil {
		t.Fatal(err)
	}
	// A big jump only 2s later must write despite the cap.
	clk.add(2 * time.Second)
	res, _ := ing.Ingest(meta(), []byte(smallCtxPayload(60000, 30)))
	if !res.ContextWritten {
		t.Fatal("large jump should bypass the rate cap")
	}
	if n, _ := s.CountContextSamples("sess-1"); n != 2 {
		t.Fatalf("expected 2 rows, got %d", n)
	}
}

func TestIngest_Flush_WritesPendingAfterCap(t *testing.T) {
	ing, s, clk := newTestIngester(t)
	if _, err := ing.Ingest(meta(), []byte(smallCtxPayload(40000, 20))); err != nil {
		t.Fatal(err)
	}
	clk.add(10 * time.Second)
	// Small change withheld.
	ing.Ingest(meta(), []byte(smallCtxPayload(40100, 20.05)))
	// Flush before cap: nothing.
	ing.Flush()
	if n, _ := s.CountContextSamples("sess-1"); n != 1 {
		t.Fatalf("flush before cap wrote early: %d rows", n)
	}
	// Advance past cap and flush: pending lands.
	clk.add(55 * time.Second)
	ing.Flush()
	if n, _ := s.CountContextSamples("sess-1"); n != 2 {
		t.Fatalf("flush after cap did not write pending: %d rows", n)
	}
}

func TestIngest_MultiAgentQuotaCoalesced(t *testing.T) {
	ing, s, clk := newTestIngester(t)
	// Two agents/panes reporting the SAME account quota in the same render
	// cycle must yield ONE quota row, but each its own context row.
	p1 := IngestMeta{PaneID: "pane-1", ProjectID: "proj-a", Agent: "claude-code"}
	p2 := IngestMeta{PaneID: "pane-2", ProjectID: "proj-b", Agent: "claude-code"}
	a := `{"session_id":"sA","model":{"id":"claude-opus-4-8"},
	  "context_window":{"total_input_tokens":10,"context_window_size":200000,"used_percentage":0},
	  "rate_limits":{"five_hour":{"used_percentage":50,"resets_at":1}}}`
	b := `{"session_id":"sB","model":{"id":"claude-opus-4-8"},
	  "context_window":{"total_input_tokens":20,"context_window_size":200000,"used_percentage":0},
	  "rate_limits":{"five_hour":{"used_percentage":50,"resets_at":1}}}`
	if _, err := ing.Ingest(p1, []byte(a)); err != nil {
		t.Fatal(err)
	}
	clk.add(1 * time.Second)
	if _, err := ing.Ingest(p2, []byte(b)); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.CountQuotaSamples(); n != 1 {
		t.Fatalf("identical account quota from 2 agents wrote %d quota rows, want 1", n)
	}
	if n, _ := s.CountContextSamples(""); n != 2 {
		t.Fatalf("expected 2 context rows (one per session), got %d", n)
	}
}
