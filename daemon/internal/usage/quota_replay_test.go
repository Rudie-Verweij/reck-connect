package usage

import (
	"encoding/csv"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"testing"
	"time"
)

// Replay a real quota export through the forecast estimator.
//
// Not a test of anything — a diagnostic. Synthetic traces encode what I
// BELIEVE the data looks like, which is exactly how the 7-day bucket
// shipped broken: the constants were reasoned from the 5-hour bucket's
// behaviour and never checked against a real weekly series. This reads the
// station's own rows instead.
//
// Skipped unless RECK_QUOTA_CSV points at a file, so it costs nothing in CI
// and has no external dependency by default:
//
//	RECK_QUOTA_CSV=~/Downloads/reck-usage-quota-….csv \
//	  go test ./daemon/internal/usage/ -run QuotaReplay -v
//
// Get the file from the usage overlay: download icon → "Raw quota
// readings" → set From seven days back → Download CSV. Those are the
// columns exportQuota writes (export.go).
func TestQuotaReplayFromCSV(t *testing.T) {
	path := os.Getenv("RECK_QUOTA_CSV")
	if path == "" {
		t.Skip("set RECK_QUOTA_CSV to a quota export to replay it")
	}

	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer f.Close()

	rows, err := csv.NewReader(f).ReadAll()
	if err != nil {
		t.Fatalf("parse csv: %v", err)
	}
	if len(rows) < 2 {
		t.Fatalf("only %d rows — nothing to replay", len(rows))
	}

	col := map[string]int{}
	for i, name := range rows[0] {
		col[name] = i
	}
	for _, want := range []string{"ts_unix", "five_hour_pct", "five_hour_resets_at",
		"seven_day_pct", "seven_day_resets_at"} {
		if _, ok := col[want]; !ok {
			t.Fatalf("column %q missing — is this the 'Raw quota readings' export? got %v", want, rows[0])
		}
	}

	num := func(rec []string, name string) (float64, bool) {
		i, ok := col[name]
		if !ok || i >= len(rec) || rec[i] == "" {
			return 0, false
		}
		v, err := strconv.ParseFloat(rec[i], 64)
		return v, err == nil
	}

	var fh, sd []quotaReading
	var newest int64
	for _, rec := range rows[1:] {
		ts, ok := num(rec, "ts_unix")
		if !ok {
			continue
		}
		if int64(ts) > newest {
			newest = int64(ts)
		}
		if pct, ok := num(rec, "five_hour_pct"); ok {
			if reset, ok := num(rec, "five_hour_resets_at"); ok {
				fh = append(fh, quotaReading{ts: int64(ts), pct: pct, resetsAt: int64(reset)})
			}
		}
		if pct, ok := num(rec, "seven_day_pct"); ok {
			if reset, ok := num(rec, "seven_day_resets_at"); ok {
				sd = append(sd, quotaReading{ts: int64(ts), pct: pct, resetsAt: int64(reset)})
			}
		}
	}

	// The export is historical, so "now" is its newest row — not the wall
	// clock, which would make every window look long expired.
	now := newest
	t.Logf("replaying %s: %d rows, %d 5h readings, %d 7d readings, newest %s",
		path, len(rows)-1, len(fh), len(sd), time.Unix(now, 0).Format(time.RFC3339))

	report(t, "5h", fh, fiveHourWindow, fiveHourRule, now)
	report(t, "7d", sd, sevenDayWindow, sevenDayRule, now)
}

func report(t *testing.T, label string, rs []quotaReading, window time.Duration, rule slopeRule, now int64) {
	t.Helper()
	t.Logf("── %s ──────────────────────────────────────────", label)
	if len(rs) == 0 {
		t.Logf("  no readings")
		return
	}

	// Ground truth to judge the estimate against, PER WINDOW. Not across the
	// whole export: that spans resets, and a rate measured through one is
	// meaningless — it was reading -0.04 %/h for a bucket that only ever
	// climbs.
	for i := 0; i < len(rs); {
		j := i
		for j < len(rs) && windowID(rs[j].resetsAt) == windowID(rs[i].resetsAt) {
			j++
		}
		w := rs[i:j]
		i = j
		span := float64(w[len(w)-1].ts-w[0].ts) / 3600
		if span < 1 {
			continue
		}
		t.Logf("  window resetting %s: %.0f%% → %.0f%% over %.1fh = %.4f %%/h (actual)",
			time.Unix(w[0].resetsAt, 0).Format("Mon 02 15:04"),
			w[0].pct, w[len(w)-1].pct, span, (w[len(w)-1].pct-w[0].pct)/span)
	}

	slopes := observedSlopes(rs, now, rule)
	t.Logf("  rule:   span %s–%s, dropIdle=%v → %d slopes",
		time.Duration(rule.minSpan)*time.Second, time.Duration(rule.maxSpan)*time.Second,
		rule.dropIdle, len(slopes))
	if len(slopes) > 0 {
		sorted := append([]weightedSlope(nil), slopes...)
		sort.Slice(sorted, func(i, j int) bool { return sorted[i].rate < sorted[j].rate })
		t.Logf("  slopes: min %.4f  p50 %.4f  max %.4f  (%%/h)",
			sorted[0].rate, sorted[len(sorted)/2].rate, sorted[len(sorted)-1].rate)
	}

	f := buildForecast(rs, window, now)
	if f == nil {
		t.Logf("  forecast: withheld (under %d slopes, or the window has reset)", forecastMinSlopes)
		return
	}
	hoursLeft := float64(f.ResetsAt-f.TS) / 3600
	at := func(rate float64) float64 { return math.Min(100, f.Pct+rate*hoursLeft) }
	t.Logf("  rates:  low %.4f  centre %.4f  high %.4f  (%%/h)", f.RateLow, f.RateCentre, f.RateHigh)
	t.Logf("  from %.1f%% with %.1fh to reset → %s at reset",
		f.Pct, hoursLeft,
		fmt.Sprintf("%.0f%% / %.0f%% / %.0f%%", at(f.RateLow), at(f.RateCentre), at(f.RateHigh)))
}
