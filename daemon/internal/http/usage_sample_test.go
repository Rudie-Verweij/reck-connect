package http

import (
	"bytes"
	"encoding/json"
	"io"
	nethttp "net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/usage"
)

func attachUsage(t *testing.T, s *Server) *usage.Store {
	t.Helper()
	store, err := usage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open usage store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	s.Usage = usage.NewIngester(store)
	return store
}

func statuslineBody(projectID string) []byte {
	return []byte(`{"project_id":"` + projectID + `",
	  "session_id":"sess-9","model":{"id":"claude-opus-4-8","display_name":"Opus"},
	  "context_window":{"total_input_tokens":40000,"context_window_size":200000,"used_percentage":20,
	    "current_usage":{"input_tokens":1200,"output_tokens":900,
	      "cache_creation_input_tokens":5000,"cache_read_input_tokens":33800}},
	  "rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1738425600},
	    "seven_day":{"used_percentage":41.2,"resets_at":1738857600}}}`)
}

func TestUsageSample_validSignatureIngests(t *testing.T) {
	s, pane := newServerWithPane(t)
	store := attachUsage(t, s)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	body := statuslineBody(pane.ProjectID)
	path := "/panes/" + pane.ID + "/usage-sample"
	url := srv.URL + path + "?agent=claude-code"
	sig, ts, nonce := signHookRequest(t, pane.HookSecret, "POST", path, body)
	req, _ := nethttp.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HookAuthHeaderSig, sig)
	req.Header.Set(HookAuthHeaderTs, ts)
	req.Header.Set(HookAuthHeaderNonce, nonce)
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}

	cs, _ := store.LatestContextForSession("sess-9")
	if cs == nil || cs.ContextInputTokens != 40000 {
		t.Fatalf("context sample not stored: %+v", cs)
	}
	// Attribution comes from the authenticated pane, not the payload.
	if cs.PaneID != pane.ID || cs.ProjectID != pane.ProjectID {
		t.Fatalf("attribution wrong: %+v", cs)
	}
	q, _ := store.LatestQuota()
	if q == nil || q.FiveHour.Pct == nil || *q.FiveHour.Pct != 23.5 {
		t.Fatalf("quota not stored: %+v", q)
	}
}

func TestUsageSample_unsignedRejected(t *testing.T) {
	s, pane := newServerWithPane(t)
	attachUsage(t, s)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	body := statuslineBody(pane.ProjectID)
	url := srv.URL + "/panes/" + pane.ID + "/usage-sample?agent=claude-code"
	req, _ := nethttp.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	// No HMAC headers: the per-pane gate must reject (not fall through to
	// bearer, and not silently accept over loopback).
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode == 200 {
		t.Fatalf("unsigned usage-sample was accepted (status 200); HMAC gate broken")
	}
}

func f64p(v float64) *float64 { return &v }

func TestUsageSummaryAndSeries(t *testing.T) {
	s := newServer(t)
	store, err := usage.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	s.UsageStore = store

	now := time.Unix(1_700_000_000, 0).UTC()
	_ = store.UpsertSession("sess-1", "proj-1", "claude-code", "claude-opus-4-8", "", now)
	_ = store.InsertContextSample(usage.ContextSample{
		TS: now, SessionID: "sess-1", PaneID: "pane-1", ProjectID: "proj-1",
		Agent: "claude-code", ContextInputTokens: 40000, ContextWindowSize: 200000, UsedPct: 20,
	})
	_ = store.InsertQuotaSample(usage.QuotaSample{
		TS: now, FiveHour: usage.Bucket{Pct: f64p(23.5)}, Source: "statusline",
	})

	h := newTestHandler(t, s)
	srv := httptest.NewServer(h)
	defer srv.Close()

	// summary
	resp, err := nethttp.Get(srv.URL + "/usage/summary")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("summary status=%d body=%s", resp.StatusCode, body)
	}
	var summary struct {
		Enabled  bool             `json:"enabled"`
		Quota    map[string]any   `json:"quota"`
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(body, &summary); err != nil {
		t.Fatalf("summary parse: %v\n%s", err, body)
	}
	if !summary.Enabled || len(summary.Sessions) != 1 || summary.Quota == nil {
		t.Fatalf("unexpected summary: %+v", summary)
	}

	// context series
	resp, err = nethttp.Get(srv.URL + "/usage/series?kind=context&session_id=sess-1")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	var series struct {
		Kind   string           `json:"kind"`
		Points []map[string]any `json:"points"`
	}
	if err := json.Unmarshal(body, &series); err != nil {
		t.Fatalf("series parse: %v\n%s", err, body)
	}
	if series.Kind != "context" || len(series.Points) != 1 {
		t.Fatalf("unexpected context series: %+v", series)
	}

	// context series without session_id → 400
	resp, err = nethttp.Get(srv.URL + "/usage/series?kind=context")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("expected 400 for missing session_id, got %d", resp.StatusCode)
	}
}
