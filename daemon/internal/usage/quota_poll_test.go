package usage

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// realUsageResponse is the verbatim body returned by
// GET https://api.anthropic.com/api/oauth/usage against a Max account on
// 2026-07-23 (Claude Code 2.1.218), with the account's own numbers kept
// and nothing removed. It is the regression anchor for this whole file: if
// the endpoint's shape drifts, the parser should keep working against this
// and we should notice at the probe, not in production.
const realUsageResponse = `{
  "five_hour": {"utilization": 86.0, "resets_at": "2026-07-23T10:30:00.472932+00:00",
                "limit_dollars": null, "used_dollars": null, "remaining_dollars": null},
  "seven_day": {"utilization": 24.0, "resets_at": "2026-07-27T18:00:00.472951+00:00",
                "limit_dollars": null, "used_dollars": null, "remaining_dollars": null},
  "seven_day_oauth_apps": null, "seven_day_opus": null, "seven_day_sonnet": null,
  "seven_day_cowork": null, "seven_day_omelette": null, "tangelo": null,
  "iguana_necktie": null, "omelette_promotional": null, "nimbus_quill": null,
  "cinder_cove": null, "amber_ladder": null,
  "extra_usage": {"is_enabled": true, "monthly_limit": 8800, "used_credits": 0.0,
                  "utilization": null, "currency": "EUR", "decimal_places": 2},
  "limits": [
    {"kind": "session", "group": "session", "percent": 86, "severity": "warning",
     "resets_at": "2026-07-23T10:30:00.472932+00:00", "scope": null, "is_active": true},
    {"kind": "weekly_all", "group": "weekly", "percent": 24, "severity": "normal",
     "resets_at": "2026-07-27T18:00:00.472951+00:00", "scope": null, "is_active": false}
  ],
  "spend": {"percent": 0, "severity": "normal", "enabled": true},
  "member_dashboard_available": false
}`

// fakeQuotaStore records every InsertQuotaSample call and can fail on
// demand. Guarded by a mutex because RunQuotaPoller writes from its own
// goroutine while the test reads.
type fakeQuotaStore struct {
	mu   sync.Mutex
	rows []QuotaSample
	err  error
}

func (f *fakeQuotaStore) InsertQuotaSample(q QuotaSample) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.rows = append(f.rows, q)
	return nil
}

func (f *fakeQuotaStore) snapshot() []QuotaSample {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]QuotaSample(nil), f.rows...)
}

func (f *fakeQuotaStore) count() int { return len(f.snapshot()) }

// newTestPoller wires a poller at srvURL with a fixed clock and a store spy.
func newTestPoller(t *testing.T, srvURL string, store quotaWriter) *QuotaPoller {
	t.Helper()
	return &QuotaPoller{
		store:    store,
		creds:    func() (Credentials, error) { return Credentials{Token: "tok"}, nil },
		endpoint: srvURL,
		client:   &http.Client{Timeout: 2 * time.Second},
		now:      func() time.Time { return time.Unix(1_700_000_000, 0).UTC() },
		logger:   slog.New(slog.DiscardHandler),
	}
}

// serve stands up a test server returning the given status and body, and
// captures the Authorization header it saw.
func serve(t *testing.T, status int, body string) (url string, auth *string) {
	t.Helper()
	seen := new(string)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*seen = r.Header.Get("Authorization")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv.URL, seen
}

func TestPollMapsRealResponse(t *testing.T) {
	url, auth := serve(t, http.StatusOK, realUsageResponse)
	store := &fakeQuotaStore{}
	p := newTestPoller(t, url, store)

	written, err := p.Poll(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !written {
		t.Fatal("written = false, want true")
	}
	if *auth != "Bearer tok" {
		t.Errorf("Authorization = %q, want %q", *auth, "Bearer tok")
	}
	if store.count() != 1 {
		t.Fatalf("rows = %d, want 1", store.count())
	}

	got := store.snapshot()[0]
	if got.Source != "poll" {
		t.Errorf("Source = %q, want poll", got.Source)
	}
	if !got.TS.Equal(time.Unix(1_700_000_000, 0).UTC()) {
		t.Errorf("TS = %v, want the injected clock", got.TS)
	}
	// The endpoint calls it `utilization`; the store calls it Pct. Same
	// 0-100 scale as the statusline path, so rows are comparable.
	if got.FiveHour.Pct == nil || *got.FiveHour.Pct != 86.0 {
		t.Errorf("FiveHour.Pct = %v, want 86", got.FiveHour.Pct)
	}
	if got.SevenDay.Pct == nil || *got.SevenDay.Pct != 24.0 {
		t.Errorf("SevenDay.Pct = %v, want 24", got.SevenDay.Pct)
	}
	// RFC3339 with fractional seconds -> unix seconds.
	wantReset := time.Date(2026, 7, 23, 10, 30, 0, 0, time.UTC).Unix()
	if got.FiveHour.ResetsAt == nil || *got.FiveHour.ResetsAt != wantReset {
		t.Errorf("FiveHour.ResetsAt = %v, want %d", got.FiveHour.ResetsAt, wantReset)
	}
	// Null windows must stay nil, never a misleading zero.
	if got.SevenDayOpus.Pct != nil || got.SevenDayOpus.ResetsAt != nil {
		t.Errorf("SevenDayOpus = %+v, want zero Bucket for a null window", got.SevenDayOpus)
	}
	// Account-level reading: no session attribution.
	if got.ReportedBySession != "" || got.ModelFamily != "" {
		t.Errorf("expected no session/model attribution, got %q/%q",
			got.ReportedBySession, got.ModelFamily)
	}
}

func TestPollWritesUnconditionally(t *testing.T) {
	// The whole point of the poller: two identical readings must produce
	// two rows, so a gap in the series means "poller was down", never
	// "the numbers sat still". This is the behaviour that differs from
	// the statusline path's change gate.
	url, _ := serve(t, http.StatusOK, realUsageResponse)
	store := &fakeQuotaStore{}
	p := newTestPoller(t, url, store)

	for i := range 3 {
		written, err := p.Poll(context.Background())
		if err != nil || !written {
			t.Fatalf("poll %d: written=%v err=%v", i, written, err)
		}
	}
	if store.count() != 3 {
		t.Fatalf("rows = %d, want 3 (no change gate on the poll path)", store.count())
	}
}

func TestPollNonWritingOutcomes(t *testing.T) {
	tests := []struct {
		name    string
		status  int
		body    string
		wantErr bool
	}{
		{
			name:   "every window null is not an error",
			status: http.StatusOK,
			body:   `{"five_hour":null,"seven_day":null,"seven_day_opus":null,"seven_day_sonnet":null}`,
		},
		{
			name:   "unknown keys only",
			status: http.StatusOK,
			body:   `{"brand_new_window":{"utilization":50.0},"spend":{"percent":0}}`,
		},
		{
			name:   "window present but utilization null",
			status: http.StatusOK,
			body:   `{"five_hour":{"utilization":null,"resets_at":"2026-07-23T10:30:00+00:00"}}`,
		},
		{name: "malformed json", status: http.StatusOK, body: `{not json`, wantErr: true},
		{name: "empty body", status: http.StatusOK, body: ``, wantErr: true},
		{name: "unauthorized", status: http.StatusUnauthorized, body: `{"error":"x"}`, wantErr: true},
		{name: "bad request", status: http.StatusBadRequest, body: `{"error":"x"}`, wantErr: true},
		{name: "server error", status: http.StatusInternalServerError, body: `oops`, wantErr: true},
		{name: "html error page", status: http.StatusForbidden, body: `<!DOCTYPE html><html>`, wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			url, _ := serve(t, tc.status, tc.body)
			store := &fakeQuotaStore{}
			p := newTestPoller(t, url, store)

			written, err := p.Poll(context.Background())
			if tc.wantErr && err == nil {
				t.Error("expected an error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Errorf("unexpected error: %v", err)
			}
			if written {
				t.Error("written = true, want false")
			}
			if store.count() != 0 {
				t.Errorf("rows = %d, want 0", store.count())
			}
		})
	}
}

func TestPollUnparseableResetsAtKeepsUtilization(t *testing.T) {
	// Losing resets_at must not cost us the whole reading — the
	// utilization number is the part the series is built on.
	url, _ := serve(t, http.StatusOK, `{"five_hour":{"utilization":42.5,"resets_at":"not-a-time"}}`)
	store := &fakeQuotaStore{}
	p := newTestPoller(t, url, store)

	if _, err := p.Poll(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if store.count() != 1 {
		t.Fatalf("rows = %d, want 1", store.count())
	}
	if got := store.snapshot()[0].FiveHour; got.Pct == nil || *got.Pct != 42.5 || got.ResetsAt != nil {
		t.Errorf("FiveHour = %+v, want Pct=42.5 with nil ResetsAt", got)
	}
}

func TestPollCredentialFailuresPropagate(t *testing.T) {
	tests := []struct {
		name string
		err  error
	}{
		{"no credentials", ErrNoCredentials},
		{"expired token", ErrTokenExpired},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			url, _ := serve(t, http.StatusOK, realUsageResponse)
			store := &fakeQuotaStore{}
			p := newTestPoller(t, url, store)
			p.creds = func() (Credentials, error) { return Credentials{}, tc.err }

			written, err := p.Poll(context.Background())
			if !errors.Is(err, tc.err) {
				t.Errorf("err = %v, want %v", err, tc.err)
			}
			if written || store.count() != 0 {
				t.Error("a credential failure must not write a row")
			}
		})
	}
}

func TestPollStoreFailureSurfaces(t *testing.T) {
	url, _ := serve(t, http.StatusOK, realUsageResponse)
	store := &fakeQuotaStore{err: errors.New("disk on fire")}
	p := newTestPoller(t, url, store)

	written, err := p.Poll(context.Background())
	if err == nil {
		t.Error("expected the store error to surface")
	}
	if written {
		t.Error("written = true, want false")
	}
}

func TestPollRespectsContextCancellation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done() // hang until the client gives up
	}))
	t.Cleanup(srv.Close)

	store := &fakeQuotaStore{}
	p := newTestPoller(t, srv.URL, store)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	written, err := p.Poll(ctx)
	if err == nil {
		t.Error("expected a timeout error")
	}
	if written || store.count() != 0 {
		t.Error("a timed-out poll must not write a row")
	}
}

func TestRunQuotaPollerIsSafeWhenDisabled(t *testing.T) {
	// nil poller and interval <= 0 must both park on ctx rather than spin
	// or panic, so main.go can start it unconditionally.
	tests := []struct {
		name     string
		poller   *QuotaPoller
		interval time.Duration
	}{
		{"nil poller", nil, time.Minute},
		{"zero interval", &QuotaPoller{}, 0},
		{"negative interval", &QuotaPoller{}, -time.Second},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() { RunQuotaPoller(ctx, tc.poller, tc.interval); close(done) }()
			cancel()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("RunQuotaPoller did not return on context cancellation")
			}
		})
	}
}

func TestRunQuotaPollerPollsImmediately(t *testing.T) {
	// A restart must not leave a hole one full interval wide.
	url, _ := serve(t, http.StatusOK, realUsageResponse)
	store := &fakeQuotaStore{}
	p := newTestPoller(t, url, store)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { RunQuotaPoller(ctx, p, time.Hour); close(done) }()

	deadline := time.After(2 * time.Second)
	for store.count() == 0 {
		select {
		case <-deadline:
			t.Fatal("no startup poll within 2s")
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	<-done
}
