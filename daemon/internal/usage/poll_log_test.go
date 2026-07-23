package usage

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestChangeLoggerReportsOnlyTransitions(t *testing.T) {
	var c changeLogger

	if !c.changed("ok") {
		t.Error("first observation must report, so an initial state is announced")
	}
	for range 3 {
		if c.changed("ok") {
			t.Error("a persisting state must stay silent")
		}
	}
	if !c.changed("broken") {
		t.Error("a new state must report")
	}
	if !c.changed("ok") {
		t.Error("recovery must report")
	}
}

func TestChangeLoggerIsConcurrencySafe(t *testing.T) {
	var c changeLogger
	var wg sync.WaitGroup
	for i := range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.changed([]string{"a", "b"}[i%2])
		}()
	}
	wg.Wait()
}

// capture collects log records so a test can assert on what an operator
// would actually see.
type capture struct {
	mu      sync.Mutex
	records []slog.Record
}

func (c *capture) Enabled(context.Context, slog.Level) bool { return true }
func (c *capture) WithAttrs([]slog.Attr) slog.Handler       { return c }
func (c *capture) WithGroup(string) slog.Handler            { return c }
func (c *capture) Handle(_ context.Context, r slog.Record) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.records = append(c.records, r)
	return nil
}

func (c *capture) atLeast(level slog.Level) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []string
	for _, r := range c.records {
		if r.Level >= level {
			out = append(out, r.Message)
		}
	}
	return out
}

// A poller that can never read credentials must say so — once. Silence
// here is the failure mode that hides a poller which has never worked
// (it is what a macOS daemon denied the keychain looks like), and a line
// every tick is what makes operators stop reading the log.
func TestPollOnceReportsPersistentCredentialFailureExactlyOnce(t *testing.T) {
	cap := &capture{}
	p := &QuotaPoller{
		store:    &fakeQuotaStore{},
		creds:    func() (Credentials, error) { return Credentials{}, ErrNoCredentials },
		endpoint: "http://127.0.0.1:1", // never reached
		client:   &http.Client{Timeout: time.Second},
		now:      func() time.Time { return time.Unix(1_700_000_000, 0).UTC() },
		logger:   slog.New(cap),
	}

	for range 5 {
		p.pollOnce(context.Background())
	}

	warns := cap.atLeast(slog.LevelWarn)
	if len(warns) != 1 {
		t.Fatalf("got %d warn lines, want exactly 1: %v", len(warns), warns)
	}
	if !strings.Contains(warns[0], "inactive") {
		t.Errorf("warn message = %q, want it to say polling is inactive", warns[0])
	}
}

func TestPollOnceAnnouncesRecovery(t *testing.T) {
	cap := &capture{}
	url, _ := serve(t, http.StatusOK, realUsageResponse)
	broken := true
	p := &QuotaPoller{
		store: &fakeQuotaStore{},
		creds: func() (Credentials, error) {
			if broken {
				return Credentials{}, ErrNoCredentials
			}
			return Credentials{Token: "tok"}, nil
		},
		endpoint: url,
		client:   &http.Client{Timeout: 2 * time.Second},
		now:      func() time.Time { return time.Unix(1_700_000_000, 0).UTC() },
		logger:   slog.New(cap),
	}

	p.pollOnce(context.Background())
	broken = false
	p.pollOnce(context.Background())
	p.pollOnce(context.Background()) // steady state: silent

	msgs := cap.atLeast(slog.LevelInfo)
	if len(msgs) != 2 {
		t.Fatalf("got %d lines, want 2 (one failure, one recovery): %v", len(msgs), msgs)
	}
	if !strings.Contains(msgs[1], "active") {
		t.Errorf("recovery message = %q, want it to announce polling is active", msgs[1])
	}
}

func TestProbeOnceReportsPersistentFailureExactlyOnce(t *testing.T) {
	cap := &capture{}
	s := newPlanStore(t)
	p := &PlanProbe{
		store:  s,
		creds:  func() (Credentials, error) { return Credentials{}, ErrNoCredentials },
		now:    func() time.Time { return time.Unix(1_700_000_000, 0).UTC() },
		logger: slog.New(cap),
	}

	for range 5 {
		p.probeOnce()
	}

	warns := cap.atLeast(slog.LevelWarn)
	if len(warns) != 1 {
		t.Fatalf("got %d warn lines, want exactly 1: %v", len(warns), warns)
	}
	if !errors.Is(ErrNoCredentials, ErrNoCredentials) { // guard against a refactor dropping the sentinel
		t.Fatal("sentinel check")
	}
}
