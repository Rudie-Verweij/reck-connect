package usage

import (
	"database/sql"
	"fmt"
	"math"
	"sort"
	"time"
)

// Burn-rate forecasting for the rate-limit windows.
//
// The Satellite draws three projected lines from "now" to the window's
// reset: a centre and two bounds. All three rates are computed HERE, from
// raw quota_samples, rather than in the renderer from the binned histogram.
// That is the whole point of this file, for three reasons:
//
//   - Bin width stops mattering. A 90-minute trailing window gives the
//     renderer ~18 points at Day/5m but only 3 at Week/30m — too few to fit
//     anything trustworthy. The raw table has ~90 readings for the same span
//     whatever the caller is plotting.
//   - The projection origin is exact. The plotted series is a per-bin MAX()
//     that is then forward-filled, so anchoring a forecast on its last value
//     projects from a peak, and from one up to a bin-width stale.
//   - The wire stays tiny: six numbers per bucket instead of raw rows.
//
// The bounds are NOT a confidence interval and must not be presented as one.
// They are the 10th and 90th percentile of the burn rates this account has
// actually sustained — "if you keep working at your slowest / fastest
// observed pace". The centre is the median of the same sample.

const (
	// forecastPoolDays is how far back the rate sample reaches. A week
	// spans the working rhythm (weekday vs weekend, deep sessions vs
	// triage) without reaching into behaviour that is no longer typical.
	forecastPoolDays = 7

	// forecastHalfLifeDays decays each observation's weight by age, so the
	// current window dominates simply by being the youngest data in the
	// pool and the window before it still counts. One parameter instead of
	// a special case for "the current session".
	forecastHalfLifeDays = 2.0

	// forecastMinSlopes is the fewest active intervals worth fitting. Below
	// this the quantiles are noise wearing a number's clothes, so the
	// forecast is withheld entirely — no line beats a wrong line.
	forecastMinSlopes = 3

	fiveHourWindow = 5 * time.Hour
	sevenDayWindow = 7 * 24 * time.Hour
)

// slopeRule says how to measure a burn rate for one window.
//
// There is a rule per window rather than one shared set of constants
// because the two windows ask different questions on scales 33x apart, and
// a rule tuned for one is catastrophically wrong for the other:
//
//	5h — "will I get cut off in this session?" The answer is the rate while
//	     you are WORKING, so idle intervals are dropped.
//	7d — "will I run out this week?" A seven-day window spans nights and
//	     breaks nobody can work through, so the rate that answers it is the
//	     one INCLUDING them. Dropping idle here would answer a question you
//	     cannot act on.
type slopeRule struct {
	// minSpan / maxSpan bound the interval a rate may be divided by.
	minSpan, maxSpan int64
	// dropIdle excludes intervals with no rise.
	dropIdle bool
	// sliding samples OVERLAPPING intervals — one per reading, each
	// measured back to the reading ~minSpan earlier — instead of walking a
	// chain of disjoint ones.
	//
	// It exists because the band is a set of quantiles, and quantiles need
	// a distribution. Disjoint day-long intervals across a 91-hour export
	// yielded FOUR slopes, at which point p10 is just the minimum and p90
	// the maximum, and the centre lands wherever the sparse sample happens
	// to fall. Overlapping spans over the same rows give hundreds, and the
	// result is time-weighted: a rate the account actually held for a long
	// stretch counts for more than one it touched briefly.
	//
	// The samples are correlated, so this is not a sampling distribution
	// and the quantiles are not confidence bounds — but they were never
	// claimed to be. The question is "what 24-hour rates has this account
	// actually sustained", and overlapping windows answer exactly that.
	sliding bool
}

var (
	// fiveHourRule: 5-30 minutes, working time only.
	//
	// The lower bound is load-bearing. The ingest gate writes IMMEDIATELY
	// on a jump of DefaultJumpPct, bypassing its one-minute rate cap, so
	// during a burst two rows land seconds apart with a 2-point delta —
	// 1440 %/hour if you divide by it. Those readings are rising and inside
	// their window, so neither the monotonic filter nor the idle filter
	// touches them; only refusing to divide by a few seconds does.
	fiveHourRule = slopeRule{minSpan: 300, maxSpan: 1800, dropIdle: true}

	// sevenDayRule: 20-30 hours, downtime included — about one day per
	// interval, which is the granularity the weekly question lives at.
	//
	// A full day-night cycle per interval, not half of one. At 12 hours the
	// intervals alternate between catching the working stretch and catching
	// the night, so half the sample is zero and the median collapses toward
	// it; a ~24-hour span always contains one of each and lands on the
	// day's real average.
	//
	// Sized by the reporting resolution, not by taste. Upstream reports
	// whole percentages (see quota_poll_test.go's captured response), so
	// the 7d series is a 1-point staircase. A real weekly burn of ~0.2 %/h
	// moves less than a tenth of a point in half an hour — far under that
	// step — so at the 5h rule EVERY 7d interval is either exactly flat
	// (dropped) or one whole step over ~5 minutes, which reads as 12 %/h.
	// The pool ends up containing nothing but quantisation artifacts, which
	// is why the bounds collapsed onto each other and the projection hit
	// 100% within hours.
	//
	// A day, by contrast, carries ~5 points of rise, so a 1-point step is a
	// ~20% error rather than a 100x one — and the day-to-day spread is a
	// real signal, which is what finally gives the band honest width.
	sevenDayRule = slopeRule{
		minSpan: 20 * 3600, maxSpan: 30 * 3600, dropIdle: false, sliding: true,
	}
)

// ruleFor picks the measurement rule for a window width.
func ruleFor(window time.Duration) slopeRule {
	if window >= sevenDayWindow {
		return sevenDayRule
	}
	return fiveHourRule
}

// windowIDGranularity is the resolution at which two resets_at values are
// considered the same window.
//
// They must not be compared exactly. The two ingest paths derive the value
// differently — the poller parses an RFC3339 string with sub-second
// precision and truncates (quota_poll.go), while the statusline supplies
// its own integer — so ONE window is recorded as two timestamps a second
// apart, alternating as the paths interleave.
//
// Measured on a real 4.6-day export: the 7-day bucket had two genuine
// windows recorded across 386 alternating runs, and the 5-hour bucket five
// windows across 306. Since slopes are never measured across a window
// boundary, exact grouping shattered the series into fragments too short to
// measure anything over — the 7d forecast came out empty and the 5h one
// lost a slope at every flicker.
//
// A minute is far below the hours between real windows and far above the
// jitter. Rounding rather than a tolerance comparison keeps grouping
// transitive, so a run of near-equal values can't chain into one bucket.
const windowIDGranularity = 60

// windowID identifies the rate-limit window a reading belongs to.
func windowID(resetsAt int64) int64 {
	return (resetsAt + windowIDGranularity/2) / windowIDGranularity
}

// QuotaForecast is the live state of one rate-limit window plus the burn
// rates projected from it. Rates are percentage points per hour.
type QuotaForecast struct {
	// TS is when Pct was observed; Pct is the latest ACTUAL reading, not a
	// bin peak. The caller projects from this point, not from the plotted
	// series' last value.
	TS  int64
	Pct float64

	// ResetsAt is Anthropic-reported and therefore exact. WindowStart is
	// derived as ResetsAt minus the window width rather than by looking for
	// where the series dropped to zero: MAX() binning hides a reset
	// whenever one bin straddles it, so drop-detection is unreliable by
	// construction.
	ResetsAt    int64
	WindowStart int64

	// RateCentre is the median sustained burn rate; RateLow and RateHigh
	// the 10th and 90th percentile. RateLow <= RateCentre <= RateHigh by
	// construction.
	RateCentre float64
	RateLow    float64
	RateHigh   float64
}

// quotaReading is one bucket's slice of a quota_samples row.
type quotaReading struct {
	ts       int64
	pct      float64
	resetsAt int64
}

// QuotaForecasts reports the live 5h and 7d windows with their projected
// burn rates. Either may be nil — meaning "nothing worth drawing" — without
// that being an error: no reading carried an expiry, the newest window has
// already reset (a daemon down for six hours leaves exactly that), or too
// few active intervals survived to fit.
func (s *Store) QuotaForecasts(now time.Time) (fiveHour, sevenDay *QuotaForecast, err error) {
	nowUnix := now.UTC().Unix()
	since := now.UTC().Add(-forecastPoolDays * 24 * time.Hour).Unix()

	s.mu.Lock()
	defer s.mu.Unlock()

	// One query for both buckets. A 7-day pool at the default 1/min poll is
	// ~10k rows; splitting it in two would double the scan to save nothing.
	rows, err := s.db.Query(
		`SELECT ts, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at
		 FROM quota_samples WHERE ts >= ? AND ts <= ? ORDER BY ts ASC, id ASC`,
		since, nowUnix,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("usage: quota forecasts: %w", err)
	}
	defer rows.Close()

	var fh, sd []quotaReading
	for rows.Next() {
		var (
			ts               int64
			fhPct, sdPct     sql.NullFloat64
			fhReset, sdReset sql.NullInt64
		)
		if err := rows.Scan(&ts, &fhPct, &fhReset, &sdPct, &sdReset); err != nil {
			return nil, nil, fmt.Errorf("usage: quota forecasts scan: %w", err)
		}
		// A row needs both halves: a percentage with no expiry can't be
		// attributed to a window, and an expiry with no percentage has
		// nothing to contribute to a rate.
		if fhPct.Valid && fhReset.Valid {
			fh = append(fh, quotaReading{ts: ts, pct: fhPct.Float64, resetsAt: fhReset.Int64})
		}
		if sdPct.Valid && sdReset.Valid {
			sd = append(sd, quotaReading{ts: ts, pct: sdPct.Float64, resetsAt: sdReset.Int64})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("usage: quota forecasts: %w", err)
	}

	return buildForecast(fh, fiveHourWindow, nowUnix),
		buildForecast(sd, sevenDayWindow, nowUnix),
		nil
}

// buildForecast turns one bucket's ascending readings into a forecast, or
// nil when there isn't enough to say anything honest.
func buildForecast(readings []quotaReading, window time.Duration, now int64) *QuotaForecast {
	if len(readings) == 0 {
		return nil
	}
	latest := readings[len(readings)-1]
	// A window that has already reset describes the past. dropExpiredWindows
	// (quota_stale.go) NULLs these at ingest, but a daemon that was offline
	// across a reset leaves the newest STORED row describing a dead window.
	if latest.resetsAt <= now {
		return nil
	}

	slopes := observedSlopes(readings, now, ruleFor(window))
	if len(slopes) < forecastMinSlopes {
		return nil
	}
	sort.Slice(slopes, func(i, j int) bool { return slopes[i].rate < slopes[j].rate })

	return &QuotaForecast{
		TS:          latest.ts,
		Pct:         latest.pct,
		ResetsAt:    latest.resetsAt,
		WindowStart: latest.resetsAt - int64(window.Seconds()),
		RateLow:     weightedQuantile(slopes, 0.10),
		RateCentre:  weightedQuantile(slopes, 0.50),
		RateHigh:    weightedQuantile(slopes, 0.90),
	}
}

// weightedSlope is one observed burn rate and how much it counts.
type weightedSlope struct {
	rate   float64 // percentage points per hour
	weight float64
}

// observedSlopes derives the burn rates between readings, measured over
// intervals the given rule considers meaningful.
//
// Filters, each earning its place:
//
//   - Readings are grouped by resets_at, so a slope is never measured
//     ACROSS a reset. Because the grouping is by the window's own identity,
//     a genuine reset can never be mistaken for an anomaly.
//   - Within a window quota is cumulative, so any reading below its
//     window's running maximum is impossible and dropped. That is the
//     stale-cache artifact quota_stale.go documents: Claude Code re-serves
//     the rate_limits block it cached from the session's last API response,
//     which lands as a single tick at the wrong level.
//   - Intervals are bounded by the rule, never taken between whichever two
//     rows the write gate happened to emit. A quota_samples row is an
//     all-bucket snapshot and the gate's jump test ORs across buckets, so
//     the 7d column is sampled on the 5h bucket's clock — its row spacing
//     says nothing about its own rate of change.
//   - Idle intervals are dropped or kept per the rule; see slopeRule for
//     why that differs by window.
func observedSlopes(readings []quotaReading, now int64, rule slopeRule) []weightedSlope {
	var out []weightedSlope

	for start := 0; start < len(readings); {
		end := start
		for end < len(readings) && windowID(readings[end].resetsAt) == windowID(readings[start].resetsAt) {
			end++
		}
		window := readings[start:end]
		start = end

		// Drop the impossible readings once, up front, so both walks below
		// see the same cleaned series. Within a window quota is cumulative,
		// so anything under the running maximum is a stale cached block.
		clean := window[:0:0]
		runningMaxFilter := math.Inf(-1)
		for _, r := range window {
			if r.pct < runningMaxFilter {
				continue
			}
			runningMaxFilter = r.pct
			clean = append(clean, r)
		}

		if rule.sliding {
			out = append(out, slidingSlopes(clean, now, rule)...)
			continue
		}

		window = clean
		runningMax := math.Inf(-1)
		var anchor *quotaReading
		for i := range window {
			r := window[i]
			if r.pct < runningMax {
				continue // impossible within a live window: a stale reading
			}
			runningMax = r.pct

			cur := r
			if anchor == nil {
				anchor = &cur
				continue
			}

			dt := r.ts - anchor.ts
			switch {
			case dt < rule.minSpan:
				// Too close together to divide by. Hold the anchor and keep
				// accumulating.
			case dt > rule.maxSpan:
				// The gap swallowed the interval. Start again from here
				// rather than reporting the average across it.
				anchor = &cur
			default:
				rate := (r.pct - anchor.pct) / (float64(dt) / 3600)
				if rate <= 0 && rule.dropIdle {
					// Nothing burned, and this rule counts working time only.
					// Crucially the anchor does NOT advance: re-basing here
					// would chop a long flat stretch into short hops, so the
					// step that eventually lands gets divided by the last hop
					// instead of by the whole stretch — inflating the rate by
					// exactly the ratio of the two.
					continue
				}
				out = append(out, weightedSlope{
					rate:   math.Max(rate, 0),
					weight: recencyWeight(r.ts, now),
				})
				anchor = &cur
			}
		}
	}
	return out
}

// recencyWeight halves an observation's influence every
// forecastHalfLifeDays. Always positive, so nothing is silently dropped by
// being old — only outvoted.
func recencyWeight(ts, now int64) float64 {
	ageDays := float64(now-ts) / 86400
	if ageDays < 0 {
		ageDays = 0
	}
	return math.Pow(2, -ageDays/forecastHalfLifeDays)
}

// weightedQuantile returns the q-th weighted quantile of `slopes`, which
// MUST already be sorted ascending by rate.
//
// Quantiles rather than the literal min and max the bounds might suggest:
// min and max are the two most outlier-sensitive statistics available, so a
// single bad tick would not merely perturb a bound, it would BECOME one.
func weightedQuantile(slopes []weightedSlope, q float64) float64 {
	if len(slopes) == 0 {
		return 0
	}
	total := 0.0
	for _, s := range slopes {
		total += s.weight
	}
	if total <= 0 {
		return slopes[len(slopes)/2].rate
	}
	target := q * total
	cum := 0.0
	for _, s := range slopes {
		cum += s.weight
		if cum >= target {
			return s.rate
		}
	}
	return slopes[len(slopes)-1].rate
}

// slidingSlopes measures one rate per reading, each against the most
// recent earlier reading at least minSpan back, skipping any pair further
// apart than maxSpan (a gap in the data, not a slow burn).
//
// `clean` must already be filtered to non-decreasing readings and belong to
// a single window. Two pointers, so it stays linear.
func slidingSlopes(clean []quotaReading, now int64, rule slopeRule) []weightedSlope {
	var out []weightedSlope
	lo := 0
	for hi := range clean {
		r := clean[hi]
		// Advance to the LATEST reading still at least minSpan behind, so
		// the span stays as close to minSpan as the data allows rather than
		// stretching back to the start of the window.
		for lo+1 < hi && r.ts-clean[lo+1].ts >= rule.minSpan {
			lo++
		}
		span := r.ts - clean[lo].ts
		if span < rule.minSpan || span > rule.maxSpan {
			continue
		}
		rate := (r.pct - clean[lo].pct) / (float64(span) / 3600)
		if rate <= 0 && rule.dropIdle {
			continue
		}
		out = append(out, weightedSlope{
			rate:   math.Max(rate, 0),
			weight: recencyWeight(r.ts, now),
		})
	}
	return out
}
