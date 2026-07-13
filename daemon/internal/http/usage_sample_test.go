package http

import (
	"bytes"
	nethttp "net/http"
	"net/http/httptest"
	"testing"

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
