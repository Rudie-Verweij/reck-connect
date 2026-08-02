package usage

import (
	"math"
	"testing"
	"time"
)

// reading builds one bucket reading at `minutesAgo` before `now`.
func reading(now int64, minutesAgo int, pct float64, resetsAt int64) quotaReading {
	return quotaReading{ts: now - int64(minutesAgo)*60, pct: pct, resetsAt: resetsAt}
}

// steady builds a run of readings climbing at a constant %/hour inside one
// window, oldest first, ending `endMinutesAgo` before now.
func steady(now int64, resetsAt int64, startPct, ratePerHour float64, n, stepMin, endMinutesAgo int) []quotaReading {
	out := make([]quotaReading, 0, n)
	for i := 0; i < n; i++ {
		minutesAgo := endMinutesAgo + (n-1-i)*stepMin
		out = append(out, quotaReading{
			ts:       now - int64(minutesAgo)*60,
			pct:      startPct + ratePerHour*float64(i*stepMin)/60,
			resetsAt: resetsAt,
		})
	}
	return out
}

func TestBuildForecastAnchorsOnTheLatestActualReading(t *testing.T) {
	now := time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC).Unix()
	resets := now + int64(2*time.Hour.Seconds())

	// 20 %/h for two hours, sampled every 10 minutes.
	got := buildForecast(steady(now, resets, 20, 20, 13, 10, 0), fiveHourWindow, now)
	if got == nil {
		t.Fatal("buildForecast = nil, want a forecast")
	}
	if got.Pct != 60 {
		t.Errorf("Pct = %v, want 60 (the last actual reading)", got.Pct)
	}
	if got.ResetsAt != resets {
		t.Errorf("ResetsAt = %d, want %d", got.ResetsAt, resets)
	}
	// Window start is derived, never detected: resets_at minus the width.
	if want := resets - int64(fiveHourWindow.Seconds()); got.WindowStart != want {
		t.Errorf("WindowStart = %d, want %d", got.WindowStart, want)
	}
	for _, c := range []struct {
		name string
		rate float64
	}{{"low", got.RateLow}, {"centre", got.RateCentre}, {"high", got.RateHigh}} {
		if math.Abs(c.rate-20) > 0.01 {
			t.Errorf("Rate%s = %v, want ~20 %%/h", c.name, c.rate)
		}
	}
}

func TestBuildForecastOrdersItsBounds(t *testing.T) {
	now := time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC).Unix()
	resets := now + 3600

	// Alternating fast and slow intervals inside one window.
	rs := []quotaReading{
		reading(now, 100, 0, resets),
		reading(now, 90, 2, resets),  // 12 %/h
		reading(now, 80, 10, resets), // 48 %/h
		reading(now, 70, 12, resets), // 12 %/h
		reading(now, 60, 20, resets), // 48 %/h
		reading(now, 50, 22, resets), // 12 %/h
		reading(now, 40, 31, resets), // 54 %/h
	}
	got := buildForecast(rs, fiveHourWindow, now)
	if got == nil {
		t.Fatal("buildForecast = nil, want a forecast")
	}
	if !(got.RateLow <= got.RateCentre && got.RateCentre <= got.RateHigh) {
		t.Errorf("bounds out of order: low=%v centre=%v high=%v",
			got.RateLow, got.RateCentre, got.RateHigh)
	}
	if got.RateLow == got.RateHigh {
		t.Errorf("bounds collapsed to %v despite a spread of observed rates", got.RateLow)
	}
}

// The headline test: quantiles must shrug off the artifact that min/max
// would adopt as a bound outright.
func TestQuantilesResistASingleWildTick(t *testing.T) {
	now := time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC).Unix()
	resets := now + 3600

	clean := steady(now, resets, 0, 20, 13, 10, 0)
	base := buildForecast(clean, fiveHourWindow, now)
	if base == nil {
		t.Fatal("clean series produced no forecast")
	}

	// Splice in one absurd jump: +40 points in a single 10-minute step,
	// i.e. 240 %/h — the shape a stale cached rate_limits block produces.
	spiked := make([]quotaReading, len(clean))
	copy(spiked, clean)
	for i := 6; i < len(spiked); i++ {
		spiked[i].pct += 40
	}
	got := buildForecast(spiked, fiveHourWindow, now)
	if got == nil {
		t.Fatal("spiked series produced no forecast")
	}

	// The literal maximum slope IS the artifact. The 90th percentile is not.
	if got.RateHigh > 60 {
		t.Errorf("RateHigh = %v %%/h — the outlier became the bound", got.RateHigh)
	}
	if math.Abs(got.RateCentre-base.RateCentre) > 0.01 {
		t.Errorf("RateCentre moved from %v to %v on one bad tick",
			base.RateCentre, got.RateCentre)
	}
}

func TestFiveHourSlopesRejectsReadingsBelowTheWindowRunningMax(t *testing.T) {
	now := time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC).Unix()
	resets := now + 3600

	// A clean climb with one impossible dip: quota is cumulative inside a
	// window, so 8% after 30% cannot have happened.
	rs := []quotaReading{
		reading(now, 60, 10, resets),
		reading(now, 50, 20, resets),
		reading(now, 40, 30, resets),
		reading(now, 30, 8, resets), // stale cached block
		reading(now, 20, 40, resets),
		reading(now, 10, 50, resets),
	}
	slopes := observedSlopes(rs, now, fiveHourRule)

	// Without the filter the dip yields a huge fake recovery slope
	// (8% -> 40% in 10 min = 192 %/h). Every real interval here is 60 %/h.
	for _, s := range slopes {
		if s.rate > 100 {
			t.Errorf("slope %v %%/h survived — the dip was not rejected", s.rate)
		}
	}
	if len(slopes) < forecastMinSlopes {
		t.Fatalf("got %d slopes, want at least %d", len(slopes), forecastMinSlopes)
	}
}

func TestFiveHourSlopesNeverMeasuresAcrossAReset(t *testing.T) {
	now := time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC).Unix()
	oldWindow := now - 1800
	newWindow := now + 16200

	// A window ending at 90%, then a fresh one starting at 2%. Grouping by
	// resets_at means the 90 -> 2 drop is never seen as an interval at all,
	// so a real reset can't be mistaken for an anomaly.
	rs := []quotaReading{
		reading(now, 70, 70, oldWindow),
		reading(now, 60, 80, oldWindow),
		reading(now, 50, 90, oldWindow),
		reading(now, 40, 2, newWindow),
		reading(now, 30, 12, newWindow),
		reading(now, 20, 22, newWindow),
	}
	for _, s := range observedSlopes(rs, now, fiveHourRule) {
		if s.rate < 0 {
			t.Errorf("negative slope %v — a reset was measured as an interval", s.rate)
		}
		if s.rate > 100 {
			t.Errorf("slope %v %%/h — a cross-window interval leaked in", s.rate)
		}
	}
}

func TestFiveHourSlopesExcludesIdleIntervals(t *testing.T) {
	now := time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC).Unix()
	resets := now + 3600

	// Two hours of genuine idling around one burst of work. Counting the
	// flat intervals would drag the low quantile to 0 %/h — technically
	// true, but it answers "what if I stop", not "what if I keep going".
	rs := []quotaReading{
		reading(now, 180, 10, resets),
		reading(now, 150, 10, resets),
		reading(now, 120, 10, resets),
		reading(now, 90, 10, resets),
		reading(now, 60, 30, resets),
		reading(now, 50, 40, resets),
		reading(now, 40, 50, resets),
	}
	for _, s := range observedSlopes(rs, now, fiveHourRule) {
		if s.rate <= 0 {
			t.Errorf("idle interval kept as slope %v", s.rate)
		}
	}
	// Two, not three. The old walk re-based the anchor through the flat
	// stretch, so the idle->work transition was emitted as a slope of its
	// own (10% -> 30% measured across the boundary, reading 40 %/h against
	// a real working rate of 60). Holding the anchor through idle drops
	// that artifact: what survives is the actual work.
	if got := len(observedSlopes(rs, now, fiveHourRule)); got != 2 {
		t.Errorf("got %d active slopes, want 2 (the working intervals only)", got)
	}
}

func TestRecencyWeightHalvesEveryHalfLife(t *testing.T) {
	now := time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC).Unix()

	if w := recencyWeight(now, now); math.Abs(w-1) > 1e-9 {
		t.Errorf("weight now = %v, want 1", w)
	}
	if w := recencyWeight(now-int64(forecastHalfLifeDays*86400), now); math.Abs(w-0.5) > 1e-9 {
		t.Errorf("weight at one half-life = %v, want 0.5", w)
	}
	// The current window outweighs the same behaviour a week ago, which is
	// what makes "weight the current session higher" fall out of one
	// parameter instead of a special case.
	if recencyWeight(now-600, now) <= recencyWeight(now-6*86400, now) {
		t.Error("a 10-minute-old observation must outweigh a 6-day-old one")
	}
}

func TestRecencyWeightingPullsTheCentreTowardCurrentBehaviour(t *testing.T) {
	now := time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC).Unix()
	resets := now + 3600
	oldWindow := now - 5*86400

	var rs []quotaReading
	// Five days ago: a long, slow 6 %/h stretch (many samples).
	for i := 0; i < 12; i++ {
		rs = append(rs, quotaReading{
			ts:       now - 5*86400 + int64(i)*600,
			pct:      float64(i) * 1,
			resetsAt: oldWindow,
		})
	}
	// Right now: a short, fast 60 %/h burst (few samples).
	for i := 0; i < 5; i++ {
		rs = append(rs, quotaReading{
			ts:       now - int64(40-i*10)*60,
			pct:      float64(i) * 10,
			resetsAt: resets,
		})
	}

	got := buildForecast(rs, fiveHourWindow, now)
	if got == nil {
		t.Fatal("buildForecast = nil")
	}
	// Unweighted, the 11 stale slow slopes would outvote the 4 fresh fast
	// ones and drag the median to 6 %/h.
	if got.RateCentre < 30 {
		t.Errorf("RateCentre = %v %%/h — stale behaviour outvoted the live window", got.RateCentre)
	}
}

func TestBuildForecastWithholdsWhenItCannotBeHonest(t *testing.T) {
	now := time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC).Unix()
	resets := now + 3600

	tests := []struct {
		name     string
		readings []quotaReading
	}{
		{"no readings at all", nil},
		{
			// A daemon offline across a reset leaves the newest STORED row
			// describing a window that is already over.
			name:     "the newest window has already reset",
			readings: steady(now, now-60, 0, 20, 13, 10, 0),
		},
		{
			name: "too few active intervals to fit",
			readings: []quotaReading{
				reading(now, 30, 10, resets),
				reading(now, 20, 20, resets),
			},
		},
		{
			name: "readings exist but nothing was ever burned",
			readings: []quotaReading{
				reading(now, 40, 10, resets),
				reading(now, 30, 10, resets),
				reading(now, 20, 10, resets),
				reading(now, 10, 10, resets),
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := buildForecast(tc.readings, fiveHourWindow, now); got != nil {
				t.Errorf("buildForecast = %+v, want nil", got)
			}
		})
	}
}

func TestWeightedQuantileEdges(t *testing.T) {
	s := []weightedSlope{
		{rate: 10, weight: 1},
		{rate: 20, weight: 1},
		{rate: 30, weight: 1},
	}
	if got := weightedQuantile(s, 0.5); got != 20 {
		t.Errorf("median = %v, want 20", got)
	}
	if got := weightedQuantile(s, 0); got != 10 {
		t.Errorf("q0 = %v, want 10", got)
	}
	if got := weightedQuantile(s, 1); got != 30 {
		t.Errorf("q1 = %v, want 30", got)
	}
	if got := weightedQuantile(nil, 0.5); got != 0 {
		t.Errorf("empty = %v, want 0", got)
	}
}

func TestQuotaForecastsEndToEnd(t *testing.T) {
	s := newPlanStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	fhReset := now.Add(2 * time.Hour).Unix()
	sdReset := now.Add(72 * time.Hour).Unix()

	// Five days of hourly rows, as the poller writes them. The 7d bucket
	// runs the whole span at 0.2 %/h; the 5h bucket only exists inside its
	// own window, which opened three hours ago — the realistic shape, and
	// the one that exercises both rules over the same rows.
	//
	// Rows are an all-bucket snapshot (store.go), so the same INSERT carries
	// whichever buckets are live. That is exactly why the 7d column ends up
	// sampled on the 5h bucket's clock in production.
	const step = 15 * time.Minute // poller cadence, coarsened to keep the test quick
	for t0 := -120 * time.Hour; t0 <= 0; t0 += step {
		ts := now.Add(t0)
		hours := (t0 + 120*time.Hour).Hours()
		sd := 8 + hours*0.2 // 0.2 %/h across five days
		sample := QuotaSample{
			TS:       ts,
			SevenDay: Bucket{Pct: &sd, ResetsAt: &sdReset},
			Source:   "poll",
		}
		if t0 >= -3*time.Hour {
			fh := (t0 + 3*time.Hour).Hours() * 20 // 20 %/h inside the live window
			sample.FiveHour = Bucket{Pct: &fh, ResetsAt: &fhReset}
		}
		if err := s.InsertQuotaSample(sample); err != nil {
			t.Fatalf("insert: %v", err)
		}
	}

	gotFH, gotSD, err := s.QuotaForecasts(now)
	if err != nil {
		t.Fatalf("QuotaForecasts: %v", err)
	}
	if gotFH == nil || gotSD == nil {
		t.Fatalf("got (%v, %v), want both buckets", gotFH, gotSD)
	}
	if math.Abs(gotFH.RateCentre-20) > 0.5 {
		t.Errorf("5h RateCentre = %v, want ~20 %%/h", gotFH.RateCentre)
	}
	// The whole point: the same rows, read against the weekly window, give a
	// weekly rate — not the 5h bucket's clock misread as one.
	if math.Abs(gotSD.RateCentre-0.2) > 0.05 {
		t.Errorf("7d RateCentre = %v, want ~0.2 %%/h", gotSD.RateCentre)
	}
	// The two buckets carry their own window widths.
	if want := fhReset - int64(fiveHourWindow.Seconds()); gotFH.WindowStart != want {
		t.Errorf("5h WindowStart = %d, want %d", gotFH.WindowStart, want)
	}
	if want := sdReset - int64(sevenDayWindow.Seconds()); gotSD.WindowStart != want {
		t.Errorf("7d WindowStart = %d, want %d", gotSD.WindowStart, want)
	}
}

func TestQuotaForecastsEmptyStore(t *testing.T) {
	s := newPlanStore(t)
	fh, sd, err := s.QuotaForecasts(time.Now().UTC())
	if err != nil {
		t.Fatalf("QuotaForecasts on empty store: %v", err)
	}
	if fh != nil || sd != nil {
		t.Errorf("got (%v, %v), want (nil, nil)", fh, sd)
	}
}

// Regression for the shape real data actually has.
//
// The ingest gate writes IMMEDIATELY on a 2-point jump, bypassing its
// one-minute rate cap (ingest.go), so a burst emits pairs of rows seconds
// apart with a 2-point delta. Those are rising and inside their window, so
// the monotonic and active filters both pass them straight through — and
// 2 points over 5 seconds is 1440 %/h. Shipped, this made every forecast
// read "100% in twenty minutes".
func TestSlopesIgnoreTheGateJumpArtifact(t *testing.T) {
	now := time.Date(2026, 7, 30, 19, 40, 0, 0, time.UTC).Unix()
	resets := now + 4*3600

	// Six hours climbing 0 -> 96%, i.e. 16 %/h, sampled once a minute…
	var rs []quotaReading
	for i := 0; i <= 360; i++ {
		rs = append(rs, quotaReading{
			ts:       now - int64(360-i)*60,
			pct:      float64(i) * 96.0 / 360.0,
			resetsAt: resets,
		})
	}
	// …with the gate's jump path firing inside it: an extra row five
	// seconds after a regular one, two points higher.
	var spiked []quotaReading
	for i, r := range rs {
		spiked = append(spiked, r)
		if i%20 == 0 && i > 0 {
			spiked = append(spiked, quotaReading{ts: r.ts + 5, pct: r.pct + 2, resetsAt: resets})
		}
	}

	for _, s := range observedSlopes(spiked, now, fiveHourRule) {
		if s.rate > 100 {
			t.Errorf("slope %.0f %%/h — a sub-minute gate write was divided by", s.rate)
		}
	}

	got := buildForecast(spiked, fiveHourWindow, now)
	if got == nil {
		t.Fatal("buildForecast = nil")
	}
	// The series averages 16 %/h. An upper bound above ~60 means artifacts
	// still dominate the quantile.
	if got.RateHigh > 60 {
		t.Errorf("RateHigh = %.0f %%/h, want a rate the series can support", got.RateHigh)
	}
	// And from 96% the projection must not claim to reach 100% instantly:
	// at a sane rate that is minutes of headroom, not seconds.
	if got.RateCentre > 40 {
		t.Errorf("RateCentre = %.0f %%/h, want ~16", got.RateCentre)
	}
}

func TestSlopesSkipLongIdleGaps(t *testing.T) {
	now := time.Date(2026, 7, 30, 19, 0, 0, 0, time.UTC).Unix()
	resets := now + 3600

	// Two bursts of real work either side of a two-hour lull. The interval
	// straddling the lull averages working and not-working, which is not the
	// rate "if I keep going" asks about.
	rs := []quotaReading{
		{ts: now - 10800, pct: 10, resetsAt: resets},
		{ts: now - 10200, pct: 15, resetsAt: resets}, // 30 %/h
		{ts: now - 9600, pct: 20, resetsAt: resets},  // 30 %/h
		{ts: now - 2400, pct: 22, resetsAt: resets},  // straddles the lull
		{ts: now - 1800, pct: 27, resetsAt: resets},  // 30 %/h
		{ts: now - 1200, pct: 32, resetsAt: resets},  // 30 %/h
	}
	for _, s := range observedSlopes(rs, now, fiveHourRule) {
		if s.rate < 20 {
			t.Errorf("slope %.1f %%/h — an idle stretch was measured as work", s.rate)
		}
	}
}

// --- 7-day window ---------------------------------------------------
//
// The 7d series is a 1-point staircase (upstream reports whole percentages
// — see realUsageResponse in quota_poll_test.go) sampled on the 5h bucket's
// clock, because a quota_samples row is an all-bucket snapshot and the
// ingest gate's jump test ORs across buckets.
//
// weekTrace builds that shape: `days` daily rises, each delivered as
// 1-point steps spread through a 10-hour working stretch, with the rest of
// the day flat. Rows land every 5 minutes throughout — including overnight,
// as the poller does — so the row spacing carries no information about the
// 7d rate. That is precisely the trap.
func weekTrace(now int64, resets int64, dayRises []float64) []quotaReading {
	var out []quotaReading
	pct := 8.0
	days := len(dayRises)
	startTS := now - int64(days)*86400

	for d := 0; d < days; d++ {
		dayStart := startTS + int64(d)*86400
		steps := int(dayRises[d]) // one row per whole point
		// 10 working hours out of 24; the rest of the day is flat.
		for tick := 0; tick < 288; tick++ { // 5-minute rows, 24h
			ts := dayStart + int64(tick)*300
			if ts > now {
				break
			}
			// Deliver the day's steps evenly across the first 10 hours.
			if steps > 0 && tick < 120 && tick%(120/maxInt(steps, 1)) == 0 {
				pct += 1
				steps--
			}
			out = append(out, quotaReading{ts: ts, pct: pct, resetsAt: resets})
		}
	}
	return out
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// The bug from the field: a 7d series climbing ~0.21 %/h projected ~22 %/h
// and hit 100% within hours of the data ending, with the band collapsed to
// a hairline. Every surviving interval was a single 1-point step over ~5
// minutes — a quantisation artifact, not a rate.
func TestSevenDayRateMatchesTheSeriesItIsDrawnOver(t *testing.T) {
	now := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC).Unix()
	resets := now + 60*3600 // ~2.5 days out, as in the report

	// Mon..Fri: +4, +2, +3, +5, +11 points — read off the reported chart.
	// 25 points over 5 days = 0.208 %/h.
	rs := weekTrace(now, resets, []float64{4, 2, 3, 5, 11})
	const trueRate = 25.0 / (5 * 24)

	got := buildForecast(rs, sevenDayWindow, now)
	if got == nil {
		t.Fatal("buildForecast = nil, want a 7d forecast")
	}

	// Within ~2x of the real rate. The failure being pinned was ~100x.
	if got.RateCentre < trueRate/2 || got.RateCentre > trueRate*2 {
		t.Errorf("RateCentre = %.3f %%/h, want ~%.3f", got.RateCentre, trueRate)
	}
	// A weekly burn is fractions of a point per hour. Anything near the 12
	// %/h a single 1-point step over 5 minutes yields means the quantisation
	// artifacts are back in the pool.
	if got.RateHigh > 1.0 {
		t.Errorf("RateHigh = %.3f %%/h — quantisation artifacts in the pool", got.RateHigh)
	}

	// What the user actually sees: the projection at the reset marker.
	atReset := got.Pct + got.RateCentre*float64(got.ResetsAt-got.TS)/3600
	if atReset > 70 {
		t.Errorf("projects %.0f%% at reset, want the 40s", atReset)
	}
}

// The band must have width. It collapsed to a hairline in the field because
// every interval was the same artifact, which made low == high and hid that
// anything was wrong.
func TestSevenDayBandHasWidth(t *testing.T) {
	now := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC).Unix()
	resets := now + 60*3600

	// Genuinely varying days — the source of an honest spread.
	rs := weekTrace(now, resets, []float64{2, 9, 3, 12, 4})
	got := buildForecast(rs, sevenDayWindow, now)
	if got == nil {
		t.Fatal("buildForecast = nil")
	}
	if !(got.RateLow < got.RateHigh) {
		t.Errorf("band collapsed: low=%.4f high=%.4f", got.RateLow, got.RateHigh)
	}
	if !(got.RateLow <= got.RateCentre && got.RateCentre <= got.RateHigh) {
		t.Errorf("bounds out of order: %.4f / %.4f / %.4f",
			got.RateLow, got.RateCentre, got.RateHigh)
	}
}

// The anchor must not re-base on an interval it discarded. Chopping a flat
// stretch into short hops means the step that eventually lands is divided
// by the last hop rather than by the whole stretch — inflating the rate by
// exactly the ratio between them.
func TestIdleStretchIsMeasuredWhole(t *testing.T) {
	now := time.Date(2026, 7, 30, 19, 0, 0, 0, time.UTC).Unix()
	resets := now + 3600

	// 25 flat minutes (rows every 5 minutes — inside maxSpan, so the gap
	// branch is not what is under test), then one 2-point step. Measured
	// whole that is 2 points over 30 min = 4 %/h. Re-basing on each
	// discarded flat interval would instead divide by the last 5-minute hop
	// and report 24 %/h.
	var rs []quotaReading
	for i := 0; i <= 5; i++ {
		rs = append(rs, quotaReading{ts: now - 1800 + int64(i)*300, pct: 40, resetsAt: resets})
	}
	rs = append(rs, quotaReading{ts: now, pct: 42, resetsAt: resets})

	slopes := observedSlopes(rs, now, fiveHourRule)
	if len(slopes) == 0 {
		t.Fatal("no slope emitted — the step was lost entirely")
	}
	for _, s := range slopes {
		if s.rate > 6 {
			t.Errorf("slope %.2f %%/h — the flat stretch was re-based away", s.rate)
		}
	}
}
