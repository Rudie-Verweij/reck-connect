package usage

import (
	"errors"
	"log/slog"
	"testing"
	"time"
)

// day returns the unix start of a UTC day, the anchor most cases here use.
func day(y int, m time.Month, d int) int64 {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Unix()
}

func newPlanStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestInsertAndLatestPlan(t *testing.T) {
	s := newPlanStore(t)

	if got, err := s.LatestPlan(); err != nil || got != nil {
		t.Fatalf("LatestPlan on empty store = %v, %v; want nil, nil", got, err)
	}

	base := time.Unix(day(2026, 7, 1), 0).UTC()
	for _, p := range []PlanSample{
		{TS: base, Subscription: "pro"},
		{TS: base.Add(48 * time.Hour), Subscription: "max", RateLimitTier: "default_claude_max_20x"},
	} {
		if err := s.InsertPlanSample(p); err != nil {
			t.Fatalf("insert %+v: %v", p, err)
		}
	}

	got, err := s.LatestPlan()
	if err != nil {
		t.Fatalf("LatestPlan: %v", err)
	}
	if got.Subscription != "max" || got.RateLimitTier != "default_claude_max_20x" {
		t.Errorf("LatestPlan = %+v, want max/default_claude_max_20x", got)
	}

	if err := s.InsertPlanSample(PlanSample{TS: base}); err == nil {
		t.Error("expected an error inserting a sample with no subscription")
	}
}

func TestPlanDaysAttribution(t *testing.T) {
	// Range: 2026-07-01 .. 2026-07-06 (5 days), all UTC.
	since, until := day(2026, 7, 1), day(2026, 7, 6)

	at := func(d int, hour int) time.Time {
		return time.Date(2026, 7, d, hour, 0, 0, 0, time.UTC)
	}

	tests := []struct {
		name    string
		samples []PlanSample
		want    []string // one tier per day, 1st .. 5th
	}{
		{
			name:    "no samples at all",
			samples: nil,
			want:    []string{"unknown", "unknown", "unknown", "unknown", "unknown"},
		},
		{
			name:    "a single sample carries forward to later days",
			samples: []PlanSample{{TS: at(2, 9), Subscription: "max"}},
			want:    []string{"unknown", "max", "max", "max", "max"},
		},
		{
			name: "a sample before the range seeds day one",
			samples: []PlanSample{
				{TS: time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC), Subscription: "pro"},
			},
			want: []string{"pro", "pro", "pro", "pro", "pro"},
		},
		{
			name: "two tiers on one day: the LAST one wins",
			samples: []PlanSample{
				{TS: at(3, 1), Subscription: "pro"},
				{TS: at(3, 23), Subscription: "max"},
			},
			want: []string{"unknown", "unknown", "max", "max", "max"},
		},
		{
			name: "a mid-range upgrade then downgrade",
			samples: []PlanSample{
				{TS: at(1, 6), Subscription: "pro"},
				{TS: at(3, 6), Subscription: "max"},
				{TS: at(5, 6), Subscription: "none"},
			},
			want: []string{"pro", "pro", "max", "max", "none"},
		},
		{
			name: "a sample after the range is ignored",
			samples: []PlanSample{
				{TS: at(2, 6), Subscription: "max"},
				{TS: time.Date(2026, 8, 1, 6, 0, 0, 0, time.UTC), Subscription: "enterprise"},
			},
			want: []string{"unknown", "max", "max", "max", "max"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := newPlanStore(t)
			for _, p := range tc.samples {
				if err := s.InsertPlanSample(p); err != nil {
					t.Fatalf("insert: %v", err)
				}
			}
			days, err := s.PlanDays(since, until, 0)
			if err != nil {
				t.Fatalf("PlanDays: %v", err)
			}
			if len(days) != len(tc.want) {
				t.Fatalf("got %d days, want %d", len(days), len(tc.want))
			}
			for i, want := range tc.want {
				if days[i].Subscription != want {
					t.Errorf("day %d (%s): got %q, want %q",
						i+1, time.Unix(days[i].Day, 0).UTC().Format("2006-01-02"),
						days[i].Subscription, want)
				}
				if wantStart := day(2026, 7, i+1); days[i].Day != wantStart {
					t.Errorf("day %d start = %d, want %d", i+1, days[i].Day, wantStart)
				}
			}
		})
	}
}

func TestPlanDaysRespectsCallerTimezone(t *testing.T) {
	// A change at 23:30 UTC on the 2nd is 00:30 on the 3rd at UTC+1, so
	// the same sample must land on a different day depending on the
	// caller's zone. Day boundaries follow the same local-midnight rule
	// the histogram uses, so the two views stay aligned.
	s := newPlanStore(t)
	if err := s.InsertPlanSample(PlanSample{
		TS:           time.Date(2026, 7, 2, 23, 30, 0, 0, time.UTC),
		Subscription: "max",
	}); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name      string
		tzOffset  int
		wantOnDay int // index of the first day reporting "max"
	}{
		{"UTC", 0, 1},      // 2026-07-02
		{"UTC+1", 60, 2},   // rolls into 2026-07-03 local
		{"UTC-5", -300, 1}, // still 2026-07-02 local
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			off := int64(tc.tzOffset) * 60
			since := day(2026, 7, 1) - off
			until := day(2026, 7, 5) - off
			days, err := s.PlanDays(since, until, tc.tzOffset)
			if err != nil {
				t.Fatalf("PlanDays: %v", err)
			}
			first := -1
			for i, d := range days {
				if d.Subscription == "max" {
					first = i
					break
				}
			}
			if first != tc.wantOnDay {
				t.Errorf("first 'max' day index = %d, want %d (days=%+v)", first, tc.wantOnDay, days)
			}
		})
	}
}

func TestPlanDaysRejectsBadRange(t *testing.T) {
	s := newPlanStore(t)
	tests := []struct {
		name         string
		since, until int64
		tzOffsetMin  int
	}{
		{"since after until", day(2026, 7, 5), day(2026, 7, 1), 0},
		{"zero range", 0, 0, 0},
		{"absurd tz offset", day(2026, 7, 1), day(2026, 7, 2), 15 * 60},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := s.PlanDays(tc.since, tc.until, tc.tzOffsetMin); err == nil {
				t.Error("expected an error, got nil")
			}
		})
	}
}

func TestPlanSummary(t *testing.T) {
	days := []PlanDay{
		{Subscription: "max"}, {Subscription: "max"}, {Subscription: "max"},
		{Subscription: "pro"},
		{Subscription: PlanUnknown},
	}
	got := PlanSummary(days)
	want := map[string]int{"max": 3, "pro": 1, PlanUnknown: 1}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %d, want %d", k, got[k], v)
		}
	}
}

// --- probe ---

func newTestProbe(t *testing.T, s *Store, creds CredentialSource) *PlanProbe {
	t.Helper()
	return &PlanProbe{
		store:  s,
		creds:  creds,
		now:    func() time.Time { return time.Unix(1_700_000_000, 0).UTC() },
		logger: slog.New(slog.DiscardHandler),
	}
}

func TestProbeWritesOnlyOnChange(t *testing.T) {
	s := newPlanStore(t)
	cur := Credentials{Token: "t", Subscription: "max", RateLimitTier: "default_claude_max_20x"}
	p := newTestProbe(t, s, func() (Credentials, error) { return cur, nil })

	written, err := p.Probe()
	if err != nil || !written {
		t.Fatalf("first probe: written=%v err=%v", written, err)
	}
	// Repeat probes of an unchanged plan must not accumulate rows.
	for range 3 {
		if written, err := p.Probe(); err != nil || written {
			t.Fatalf("repeat probe: written=%v err=%v; want false, nil", written, err)
		}
	}

	// An upgrade is a change.
	cur = Credentials{Token: "t", Subscription: "max", RateLimitTier: "default_claude_max_5x"}
	if written, err := p.Probe(); err != nil || !written {
		t.Fatalf("tier change: written=%v err=%v; want true", written, err)
	}
	cur = Credentials{Token: "t", Subscription: "pro"}
	if written, err := p.Probe(); err != nil || !written {
		t.Fatalf("subscription change: written=%v err=%v; want true", written, err)
	}

	last, err := s.LatestPlan()
	if err != nil {
		t.Fatal(err)
	}
	if last.Subscription != "pro" || last.RateLimitTier != "" {
		t.Errorf("LatestPlan = %+v, want pro with empty tier", last)
	}
}

func TestProbeMapsMissingSubscriptionToNone(t *testing.T) {
	// An API-key or third-party-provider session is authenticated but has
	// no claude.ai subscription; that is a fact worth recording, not a gap.
	s := newPlanStore(t)
	p := newTestProbe(t, s, func() (Credentials, error) {
		return Credentials{Token: "t"}, nil
	})
	if written, err := p.Probe(); err != nil || !written {
		t.Fatalf("written=%v err=%v", written, err)
	}
	last, _ := s.LatestPlan()
	if last.Subscription != PlanNone {
		t.Errorf("Subscription = %q, want %q", last.Subscription, PlanNone)
	}
}

func TestProbeToleratesExpiredToken(t *testing.T) {
	// Expiry invalidates the token, not the subscription metadata — the
	// probe must still record the tier on a station where nobody has run
	// Claude lately.
	s := newPlanStore(t)
	p := newTestProbe(t, s, func() (Credentials, error) {
		return Credentials{Token: "stale", Subscription: "max"}, ErrTokenExpired
	})
	if written, err := p.Probe(); err != nil || !written {
		t.Fatalf("written=%v err=%v; want true, nil", written, err)
	}
	last, _ := s.LatestPlan()
	if last == nil || last.Subscription != "max" {
		t.Errorf("LatestPlan = %+v, want max", last)
	}
}

func TestProbeCredentialFailure(t *testing.T) {
	s := newPlanStore(t)
	p := newTestProbe(t, s, func() (Credentials, error) {
		return Credentials{}, ErrNoCredentials
	})
	written, err := p.Probe()
	if !errors.Is(err, ErrNoCredentials) {
		t.Errorf("err = %v, want ErrNoCredentials", err)
	}
	if written {
		t.Error("written = true, want false")
	}
}
