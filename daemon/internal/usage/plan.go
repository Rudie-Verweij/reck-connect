package usage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// Subscription-plan tracking.
//
// A quota percentage is meaningless without the tier it is a percentage
// of — 80% of Max 20x is a different amount of work from 80% of Pro. The
// tier comes from the same local credential blob the poller already reads
// for its bearer token (see oauth_creds.go), so this costs no extra
// process, no network call, and no token.
//
// Rows are written only when the tier CHANGES. A plan is state, not an
// event: the tier in force at any instant is the latest row at or before
// it. The usage view already reads quota this way ("quota is state,
// forward-fill idle bins"), and applying the same rule here keeps a table
// that would otherwise be pure repetition down to a few rows a year.

// Plan values that are not subscription tiers reported by Claude.
const (
	// PlanNone is an authenticated session with no claude.ai subscription
	// (API key or a third-party provider).
	PlanNone = "none"
	// PlanUnknown is "we had not observed the plan yet at this point in
	// time" — used for days that precede the first sample. It is never
	// stored, only reported by PlanDays.
	PlanUnknown = "unknown"
)

// PlanSample is one observation of the account's subscription tier.
type PlanSample struct {
	TS            time.Time
	Subscription  string // 'pro' | 'max' | 'team' | 'enterprise' | 'none'
	RateLimitTier string // e.g. 'default_claude_max_20x'; '' when unreported
}

// PlanDay is the tier in force at the end of one local day.
type PlanDay struct {
	Day          int64  // local-midnight bin start, unix seconds
	Subscription string // may be PlanUnknown for days before the first sample
}

// InsertPlanSample appends one plan observation.
func (s *Store) InsertPlanSample(p PlanSample) error {
	if p.Subscription == "" {
		return errors.New("usage: plan subscription required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO plan_samples (ts, subscription, rate_limit_tier) VALUES (?,?,?)`,
		p.TS.UTC().Unix(), p.Subscription, p.RateLimitTier,
	)
	if err != nil {
		return fmt.Errorf("usage: insert plan sample: %w", err)
	}
	return nil
}

// LatestPlan returns the most recent plan observation, or nil when none
// has been recorded yet.
func (s *Store) LatestPlan() (*PlanSample, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var (
		ts   int64
		sub  string
		tier string
	)
	err := s.db.QueryRow(
		`SELECT ts, subscription, rate_limit_tier FROM plan_samples ORDER BY ts DESC, id DESC LIMIT 1`,
	).Scan(&ts, &sub, &tier)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return nil, nil
	case err != nil:
		return nil, fmt.Errorf("usage: latest plan: %w", err)
	}
	return &PlanSample{
		TS:            time.Unix(ts, 0).UTC(),
		Subscription:  sub,
		RateLimitTier: tier,
	}, nil
}

// PlanDays reports the subscription tier for every local day overlapping
// [since, until).
//
// Day granularity is deliberate and fixed: plan attribution is always
// per-day no matter what bin width the caller is plotting, so zooming
// from a month to an hour narrows the range but never subdivides the
// plan. Day boundaries use the same local-midnight convention as
// HistogramParams so the two line up exactly.
//
// A day's tier is the LAST one seen that day, which falls out of taking
// the latest sample before the day ends: a day containing a change takes
// the post-change tier, and a day with no sample at all carries the
// previous day's tier forward. Days before the first-ever sample are
// PlanUnknown.
func (s *Store) PlanDays(since, until int64, tzOffsetMin int) ([]PlanDay, error) {
	p := HistogramParams{
		Bucket:      BucketDay,
		Since:       since,
		Until:       until,
		TZOffsetMin: tzOffsetMin,
	}
	if err := p.Validate(); err != nil {
		return nil, err
	}
	starts, _, err := p.binStarts()
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// Change-only writes keep this table tiny, so reading every sample up
	// to the range end and walking it in Go beats a per-day subquery.
	rows, err := s.db.Query(
		`SELECT ts, subscription FROM plan_samples WHERE ts < ? ORDER BY ts ASC, id ASC`,
		until,
	)
	if err != nil {
		return nil, fmt.Errorf("usage: plan days: %w", err)
	}
	defer rows.Close()

	type change struct {
		ts  int64
		sub string
	}
	var changes []change
	for rows.Next() {
		var c change
		if err := rows.Scan(&c.ts, &c.sub); err != nil {
			return nil, fmt.Errorf("usage: plan days scan: %w", err)
		}
		changes = append(changes, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("usage: plan days: %w", err)
	}

	// Merge-walk: both slices are ascending, so one pass suffices.
	out := make([]PlanDay, 0, len(starts))
	cur := PlanUnknown
	next := 0
	for _, dayStart := range starts {
		dayEnd := dayStart + 86400
		for next < len(changes) && changes[next].ts < dayEnd {
			cur = changes[next].sub
			next++
		}
		out = append(out, PlanDay{Day: dayStart, Subscription: cur})
	}
	return out, nil
}

// PlanSummary counts days per tier, e.g. {"max": 40, "pro": 5}. This is
// what the usage view renders when a range spans more than one tier.
func PlanSummary(days []PlanDay) map[string]int {
	out := make(map[string]int, 4)
	for _, d := range days {
		out[d.Subscription]++
	}
	return out
}

// --- probe ---

// planStore is the slice of the store the probe needs, declared where it
// is used. *Store satisfies it.
type planStore interface {
	InsertPlanSample(PlanSample) error
	LatestPlan() (*PlanSample, error)
}

// DefaultPlanProbeInterval is how often to re-read the tier. Plans change
// a handful of times a year at most, so this only needs to be frequent
// enough to notice an upgrade within the day it happened.
const DefaultPlanProbeInterval = time.Hour

// PlanProbe reads the subscription tier from the local credential blob
// and records it when it differs from the last recorded value.
type PlanProbe struct {
	store  planStore
	creds  CredentialSource
	now    func() time.Time
	logger *slog.Logger
	state  changeLogger
}

// NewPlanProbe constructs a probe against the local credential store.
func NewPlanProbe(store *Store) *PlanProbe {
	if store == nil {
		return nil
	}
	return &PlanProbe{
		store:  store,
		creds:  NewCachedCredentialSource(LoadCredentials, nil),
		now:    func() time.Time { return time.Now().UTC() },
		logger: slog.Default(),
	}
}

// Probe reads the current tier and writes a row only if it changed.
// Reports whether a row was written.
func (p *PlanProbe) Probe() (bool, error) {
	creds, err := p.creds()
	// An expired token is fine here: the probe reads subscription metadata,
	// not the token, and that metadata stays accurate after expiry. Only a
	// genuinely absent/unreadable blob stops us.
	if err != nil && !errors.Is(err, ErrTokenExpired) {
		return false, err
	}
	if creds.Subscription == "" && errors.Is(err, ErrTokenExpired) {
		return false, err
	}
	sub := creds.Subscription
	if sub == "" {
		// Authenticated, but not on a claude.ai subscription.
		sub = PlanNone
	}

	last, err := p.store.LatestPlan()
	if err != nil {
		return false, err
	}
	if last != nil && last.Subscription == sub && last.RateLimitTier == creds.RateLimitTier {
		return false, nil
	}
	if err := p.store.InsertPlanSample(PlanSample{
		TS:            p.now(),
		Subscription:  sub,
		RateLimitTier: creds.RateLimitTier,
	}); err != nil {
		return false, err
	}
	p.logger.Info("usage: subscription plan recorded", "subscription", sub, "tier", creds.RateLimitTier)
	return true, nil
}

// RunPlanProbe re-reads the tier every interval until ctx is cancelled.
// Mirrors RunSampler/RunBackfiller/RunQuotaPoller: nil-safe and inert on a
// non-positive interval so the daemon can start it unconditionally.
func RunPlanProbe(ctx context.Context, p *PlanProbe, interval time.Duration) {
	if p == nil || interval <= 0 {
		<-ctx.Done()
		return
	}
	p.probeOnce()

	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.probeOnce()
		}
	}
}

// probeOnce runs one probe, logging on transitions rather than every
// tick. See poll_log.go.
func (p *PlanProbe) probeOnce() {
	switch _, err := p.Probe(); {
	case errors.Is(err, ErrNoCredentials), errors.Is(err, ErrTokenExpired):
		if p.state.changed("skip:" + err.Error()) {
			p.logger.Warn("usage: plan tracking inactive — no readable Claude credentials", "reason", err)
		}
	case err != nil:
		if p.state.changed("err:" + err.Error()) {
			p.logger.Warn("usage: plan probe failed", "err", err)
		}
	default:
		// Probe() already logs at Info the first time a tier is recorded
		// and on every change; steady state is silent by design.
		p.state.changed("ok")
	}
}
