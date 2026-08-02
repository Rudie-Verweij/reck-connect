package usage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"
)

// Account-level quota polling.
//
// WHY THIS EXISTS: the statusline path (ingest.go) only produces quota
// samples as a side effect of Claude Code rendering a statusline, and
// Claude Code only populates `rate_limits` "after first API response".
// That leaves the 5h/7d series blind exactly when it matters — an idle
// pane, no pane open at all, quota burned on claude.ai or another machine,
// and above all a window RESET, whose drop is never observed, only guessed
// at afterwards. This poller reads the account's quota on a timer so the
// series is continuous regardless of what any pane is doing.
//
// THE ENDPOINT IS UNDOCUMENTED. It is the same one Claude Code's own
// /usage dialog calls. Everything we know about it lives in this file, so
// a change upstream is one file to fix:
//
//	GET https://api.anthropic.com/api/oauth/usage
//	Authorization: Bearer <local Claude OAuth access token>
//
// Verified against Claude Code 2.1.218 (2026-07-23). Only the bearer token
// is required — no beta header, version header, or User-Agent (we send an
// honest reck User-Agent rather than impersonating the CLI). The response
// is a keyed object; `null` for a window the account does not have:
//
//	{"five_hour":  {"utilization": 86.0, "resets_at": "2026-07-23T10:30:00.47+00:00"},
//	 "seven_day":  {"utilization": 24.0, "resets_at": "2026-07-27T18:00:00.47+00:00"},
//	 "seven_day_opus": null, "seven_day_sonnet": null,
//	 ...other keys we deliberately ignore...}
//
// Note the field names differ from the statusline payload's: `utilization`
// (not `used_percentage`) and an RFC3339 `resets_at` string (not unix
// seconds). Both are normalised here so polled and statusline rows land in
// quota_samples on identical units and are directly comparable.

const (
	// DefaultUsageEndpoint is the account quota endpoint.
	DefaultUsageEndpoint = "https://api.anthropic.com/api/oauth/usage"

	// DefaultQuotaPollInterval is how often to read account quota on a
	// station that has never been told otherwise. A minute keeps a 5h
	// window's approach to its limit legible in close to real time, which
	// is when anyone actually looks at this data; five minutes rounded
	// that off enough to be frustrating. Users can move it anywhere
	// between MinQuotaPollInterval and MaxQuotaPollInterval, or switch
	// polling off — see poll_settings.go.
	DefaultQuotaPollInterval = time.Minute

	// quotaPollTimeout bounds a single request. Claude Code uses 5s for
	// the same call; a poller that hangs is worse than one that misses.
	quotaPollTimeout = 10 * time.Second
)

// quotaWriter is the slice of the store this poller needs. Declared here,
// where it is used, and kept to one method (*Store satisfies it).
type quotaWriter interface {
	InsertQuotaSample(QuotaSample) error
}

// QuotaPoller reads account quota from the OAuth usage endpoint and
// appends it to quota_samples. Unlike the statusline path it applies NO
// change gate: every successful poll writes a row, so a gap in the series
// unambiguously means "the poller was not running or could not read",
// never "the numbers happened to sit still".
type QuotaPoller struct {
	store    quotaWriter
	creds    CredentialSource
	endpoint string
	client   *http.Client
	now      func() time.Time
	logger   *slog.Logger
	state    changeLogger

	// interval is the live poll period in nanoseconds, 0 meaning "off". An
	// atomic rather than a mutex because the only contention is one HTTP
	// handler writing and one runner reading.
	interval atomic.Int64
	// wake nudges the runner to re-read interval. Buffered(1) and sent to
	// non-blockingly: a pending nudge already means "re-read", so a second
	// one carries no extra information and must never block the caller.
	wake chan struct{}
}

// NewQuotaPoller constructs a poller against the default endpoint and the
// local Claude credential store.
func NewQuotaPoller(store *Store) *QuotaPoller {
	if store == nil {
		return nil
	}
	return &QuotaPoller{
		store:    store,
		creds:    NewCachedCredentialSource(LoadCredentials, nil),
		endpoint: DefaultUsageEndpoint,
		client:   &http.Client{Timeout: quotaPollTimeout},
		now:      func() time.Time { return time.Now().UTC() },
		logger:   slog.Default(),
		wake:     make(chan struct{}, 1),
	}
}

// SetInterval changes the live poll period; d <= 0 stops polling until a
// later call turns it back on. Safe before or after RunQuotaPoller starts,
// and safe on a poller with no runner — the value is simply read when one
// arrives.
func (p *QuotaPoller) SetInterval(d time.Duration) {
	if p == nil {
		return
	}
	p.interval.Store(int64(d))
	// Non-blocking: a full buffer already means "re-read on the next turn
	// of the loop", and a nil channel (a poller built by a test literal)
	// falls through here rather than deadlocking.
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// Interval reports the period the poller is currently running at, 0
// meaning polling is off. This is what is actually live, which can differ
// from what is stored if a write half-succeeded — worth being able to ask.
func (p *QuotaPoller) Interval() time.Duration {
	if p == nil {
		return 0
	}
	return time.Duration(p.interval.Load())
}

// Poll performs one read and, when the response carried at least one
// usable window, writes exactly one quota_samples row. It reports whether
// a row was written.
//
// A missing or expired credential is NOT an error worth alarming about —
// it means Claude Code has not been run recently enough to hold a live
// token, so we return ErrNoCredentials/ErrTokenExpired for the caller to
// log quietly.
func (p *QuotaPoller) Poll(ctx context.Context) (written bool, err error) {
	creds, err := p.creds()
	if err != nil {
		return false, err
	}

	body, err := p.fetch(ctx, creds.Token)
	if err != nil {
		return false, err
	}

	sample, ok, err := p.sampleFrom(body, p.now())
	if err != nil {
		return false, err
	}
	if !ok {
		// A 200 with every window null: nothing to record. Not an error —
		// an account with no active limits legitimately looks like this.
		return false, nil
	}
	if err := p.store.InsertQuotaSample(sample); err != nil {
		return false, err
	}
	return true, nil
}

// fetch issues the authenticated GET and returns the raw body.
func (p *QuotaPoller) fetch(ctx context.Context, token string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("usage: build quota request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "reck-stationd")

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("usage: quota poll request failed: %w", err)
	}
	defer resp.Body.Close()

	// Cap the read: this is a small JSON document, and an unbounded
	// ReadAll on an unexpected response (an HTML error page, say) is how a
	// poller turns into a memory problem.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("usage: read quota response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		// Deliberately does not include the body: on an auth failure the
		// endpoint may echo request detail we would rather not log.
		return nil, fmt.Errorf("usage: quota poll: HTTP %d", resp.StatusCode)
	}
	return body, nil
}

// usageWire mirrors only the windows we store. Every other key in the
// response — extra_usage, spend, the normalised `limits` array, and a
// rotating cast of codenamed windows — is ignored on purpose: unknown
// keys must never turn a good response into an error.
type usageWire struct {
	FiveHour       *usageWindow `json:"five_hour"`
	SevenDay       *usageWindow `json:"seven_day"`
	SevenDayOpus   *usageWindow `json:"seven_day_opus"`
	SevenDaySonnet *usageWindow `json:"seven_day_sonnet"`
}

type usageWindow struct {
	Utilization *float64 `json:"utilization"`
	ResetsAt    *string  `json:"resets_at"`
}

// sampleFrom parses a response body into a QuotaSample. It distinguishes
// two non-writing outcomes on purpose: a malformed body is an error worth
// surfacing (the endpoint's shape may have changed under us), whereas
// ok=false simply means no usable window — the same "not worth a row" rule
// the statusline path applies in quotaCandidate.
func (p *QuotaPoller) sampleFrom(body []byte, now time.Time) (QuotaSample, bool, error) {
	var w usageWire
	if err := json.Unmarshal(body, &w); err != nil {
		return QuotaSample{}, false, fmt.Errorf("usage: malformed quota poll response: %w", err)
	}
	qs := QuotaSample{
		TS:             now,
		Source:         "poll",
		FiveHour:       windowToBucket(w.FiveHour),
		SevenDay:       windowToBucket(w.SevenDay),
		SevenDayOpus:   windowToBucket(w.SevenDayOpus),
		SevenDaySonnet: windowToBucket(w.SevenDaySonnet),
	}
	// Around a rollover the endpoint can still answer with the window
	// that just closed; that reading belongs to the old window, not to
	// now. See quota_stale.go.
	qs = dropExpiredWindows(qs, now)
	if qs.FiveHour.Pct == nil && qs.SevenDay.Pct == nil &&
		qs.SevenDayOpus.Pct == nil && qs.SevenDaySonnet.Pct == nil {
		return QuotaSample{}, false, nil
	}
	return qs, true, nil
}

// windowToBucket converts one endpoint window to the store's Bucket. An
// absent or null window yields the zero Bucket (both fields nil), which
// the store already persists as SQL NULL rather than a misleading zero.
func windowToBucket(w *usageWindow) Bucket {
	if w == nil {
		return Bucket{}
	}
	b := Bucket{Pct: copyF(w.Utilization)}
	if w.ResetsAt != nil {
		if t, err := time.Parse(time.RFC3339, *w.ResetsAt); err == nil {
			// Round, don't truncate: the string carries sub-second precision
			// and t.Unix() floors it, which is what turned a wobble around
			// the boundary into a one-second flip. See NormalizeResetsAt.
			unix := t.Round(time.Minute).Unix()
			b.ResetsAt = &unix
		}
		// An unparseable timestamp costs us resets_at, not the whole
		// sample — the utilization number is the part that matters.
	}
	return b
}

// RunQuotaPoller polls account quota until ctx is cancelled, at whatever
// period SetInterval most recently named (starting from interval). Safe
// with a nil poller so the daemon can start it unconditionally, and an
// interval <= 0 means "don't poll" rather than spinning.
//
// This no longer mirrors RunSampler/RunPlanProbe, which still take their
// period once and keep it. The difference is deliberate: the quota period
// is the only one a user can change from the UI (see poll_settings.go), so
// it has to be re-readable while running, and its "off" state has to be a
// state rather than the one-way <-ctx.Done() park the others use.
//
// Every failure is logged and swallowed. A poller that can take the daemon
// down is a worse bug than one that misses a sample.
func RunQuotaPoller(ctx context.Context, p *QuotaPoller, interval time.Duration) {
	if p == nil {
		<-ctx.Done()
		return
	}
	p.interval.Store(int64(interval))

	// A nil tick channel blocks forever in select, which is how "polling
	// off" parks without burning a goroutine on a spin — and unlike a
	// <-ctx.Done() park it can be armed again when polling comes back on.
	var ticker *time.Ticker
	var tick <-chan time.Time
	armed := time.Duration(-1)

	arm := func() {
		d := time.Duration(p.interval.Load())
		if d == armed {
			return
		}
		armed = d
		if ticker != nil {
			ticker.Stop()
			ticker, tick = nil, nil
		}
		if d <= 0 {
			return
		}
		ticker = time.NewTicker(d)
		tick = ticker.C
		// Poll on arming: at startup so a restart doesn't leave a hole the
		// width of one interval, and on a change so the effect of saving a
		// new interval is visible now rather than one interval from now.
		p.pollOnce(ctx)
	}

	arm()
	defer func() {
		if ticker != nil {
			ticker.Stop()
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case <-p.wake:
			arm()
		case <-tick:
			p.pollOnce(ctx)
		}
	}
}

// pollOnce runs a single poll, logging on transitions so a poller that
// never works is visible without a poller that works fine being noisy.
// See poll_log.go for why.
func (p *QuotaPoller) pollOnce(ctx context.Context) {
	written, err := p.Poll(ctx)
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		// Shutdown or a slow endpoint; nothing actionable and nothing
		// worth latching, so the next real outcome still reports.

	case errors.Is(err, ErrNoCredentials), errors.Is(err, ErrTokenExpired):
		// Expected on a machine where nobody has run Claude lately — but
		// it is also what a permanently unreadable credential store looks
		// like, so say it once rather than never. The subtle case is a
		// daemon whose HOME doesn't match the user that authenticated
		// Claude: on macOS `security` resolves the login keychain through
		// $HOME/Library/Keychains, so a wrong HOME silently finds nothing.
		// (The installed LaunchAgent sets HOME explicitly, so this is a
		// hand-rolled-invocation hazard, not an install-path one.)
		if p.state.changed("skip:" + err.Error()) {
			p.logger.Warn("usage: quota polling inactive — no usable Claude credentials", "reason", err)
		}

	case err != nil:
		if p.state.changed("err:" + err.Error()) {
			p.logger.Warn("usage: quota poll failed", "err", err)
		}

	case !written:
		if p.state.changed("empty") {
			p.logger.Info("usage: quota poll returned no usable window")
		}

	default:
		if p.state.changed("ok") {
			p.logger.Info("usage: quota polling active")
		}
	}
}
