package usage

import (
	"fmt"
	"time"
)

// Histogram: server-side binning for the Satellite's usage view (issue
// #88). One GROUP BY over turn_usage (token sums + turn count) plus one
// over quota_samples (per-bin peak 5h/7d %), merged and zero-filled in
// Go so the wire result is a dense, small series (a year of days is
// ~366 bins) that never hits the raw-series row clamp.
//
// Buckets are "hour" and "day" (fixed-width, aligned to the caller's
// local midnight via tzOffset) and "month" (calendar months in the
// caller's zone). The Satellite maps its four granularities onto these:
// Day view = hour bins, Week/Month views = day bins, Year view = month
// bins.

// HistogramBucket is the validated bin width for HistogramParams.
type HistogramBucket string

const (
	BucketHour  HistogramBucket = "hour"
	BucketDay   HistogramBucket = "day"
	BucketMonth HistogramBucket = "month"
)

// maxHistogramBins bounds the zero-filled result so a caller can't ask
// for a decade of hours and stall the daemon. 1000 comfortably covers
// every real view (worst legitimate case: ~370 day-bins for a year).
const maxHistogramBins = 1000

// HistogramParams selects the range, bin width, and optional project
// filter. Since/Until are unix seconds, half-open [Since, Until).
// TZOffsetMin shifts bin boundaries so "day" and "month" bins start at
// the *caller's* local midnight, not the station's (the Satellite sends
// -new Date().getTimezoneOffset()).
type HistogramParams struct {
	Bucket      HistogramBucket
	Since       int64
	Until       int64
	ProjectID   string // empty = all projects
	TZOffsetMin int
}

// HistogramBin is one dense bin of the result. Token sums come from
// turn_usage (authoritative per-turn counts); the quota peaks are the
// MAX 5h/7d used-% sampled inside the bin, nil when no quota sample
// landed there. Quota is account-level, so it is deliberately NOT
// filtered by ProjectID.
type HistogramBin struct {
	T             int64 // bin start, unix seconds
	Input         int64
	Output        int64
	CacheCreation int64
	CacheRead     int64
	Total         int64
	Turns         int64
	FiveHourPeak  *float64
	SevenDayPeak  *float64
}

// Validate checks bucket, range, tz offset, and the bin-count cap. The
// HTTP handler calls it up front to map caller mistakes to 400s; a
// Histogram error after a passing Validate is a store failure (500).
func (p HistogramParams) Validate() error {
	switch p.Bucket {
	case BucketHour, BucketDay, BucketMonth:
	default:
		return fmt.Errorf("usage: histogram: invalid bucket %q", p.Bucket)
	}
	if p.Since <= 0 || p.Until <= 0 || p.Since >= p.Until {
		return fmt.Errorf("usage: histogram: invalid range [%d, %d)", p.Since, p.Until)
	}
	// UTC-14 .. UTC+14 covers every real zone.
	if p.TZOffsetMin < -14*60 || p.TZOffsetMin > 14*60 {
		return fmt.Errorf("usage: histogram: invalid tz offset %d", p.TZOffsetMin)
	}
	// Enumerating bin starts enforces maxHistogramBins; recomputing in
	// Histogram is cheap (≤1000 small appends).
	if _, _, err := p.binStarts(); err != nil {
		return err
	}
	return nil
}

// binKeyExpr returns the SQL expression that maps a row's ts to its bin
// key, always as TEXT so both fixed-width (integer) and month (string)
// keys scan uniformly. off is the tz offset in seconds and is injected
// as a bound parameter by the caller (the expression contains one ?).
func (p HistogramParams) binKeyExpr() string {
	switch p.Bucket {
	case BucketHour:
		return "CAST((ts + ?) / 3600 AS TEXT)"
	case BucketDay:
		return "CAST((ts + ?) / 86400 AS TEXT)"
	default: // BucketMonth
		return "strftime('%Y-%m', ts + ?, 'unixepoch')"
	}
}

// binStarts enumerates every bin start in [Since, Until), zero-fill
// order, and the key each bin groups under. Errors when the range would
// exceed maxHistogramBins.
func (p HistogramParams) binStarts() ([]int64, []string, error) {
	off := int64(p.TZOffsetMin) * 60
	var starts []int64
	var keys []string
	switch p.Bucket {
	case BucketHour, BucketDay:
		w := int64(3600)
		if p.Bucket == BucketDay {
			w = 86400
		}
		for k := (p.Since + off) / w; k*w-off < p.Until; k++ {
			if len(starts) >= maxHistogramBins {
				return nil, nil, fmt.Errorf("usage: histogram: range exceeds %d bins", maxHistogramBins)
			}
			starts = append(starts, k*w-off)
			keys = append(keys, fmt.Sprintf("%d", k))
		}
	default: // BucketMonth
		loc := time.FixedZone("caller", int(off))
		t := time.Unix(p.Since, 0).In(loc)
		cur := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, loc)
		for cur.Unix() < p.Until {
			if len(starts) >= maxHistogramBins {
				return nil, nil, fmt.Errorf("usage: histogram: range exceeds %d bins", maxHistogramBins)
			}
			starts = append(starts, cur.Unix())
			keys = append(keys, cur.Format("2006-01"))
			cur = cur.AddDate(0, 1, 0)
		}
	}
	return starts, keys, nil
}

// Histogram bins turn_usage token sums and quota_samples peaks over
// [Since, Until). Bins with no rows are present with zero sums and nil
// peaks, so the caller can plot the series without gap logic.
func (s *Store) Histogram(p HistogramParams) ([]HistogramBin, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	starts, keys, err := p.binStarts()
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	off := int64(p.TZOffsetMin) * 60
	keyExpr := p.binKeyExpr()

	type sums struct {
		input, output, cacheCreation, cacheRead, turns int64
	}
	tokenByKey := make(map[string]sums)
	{
		q := `SELECT ` + keyExpr + ` AS bkey,
		             SUM(input_tokens), SUM(output_tokens),
		             SUM(cache_creation), SUM(cache_read), COUNT(*)
		      FROM turn_usage WHERE ts >= ? AND ts < ?`
		args := []any{off, p.Since, p.Until}
		if p.ProjectID != "" {
			q += ` AND project_id = ?`
			args = append(args, p.ProjectID)
		}
		q += ` GROUP BY bkey`
		rows, err := s.db.Query(q, args...)
		if err != nil {
			return nil, fmt.Errorf("usage: histogram: turn query: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var key string
			var v sums
			if err := rows.Scan(&key, &v.input, &v.output, &v.cacheCreation, &v.cacheRead, &v.turns); err != nil {
				return nil, fmt.Errorf("usage: histogram: turn scan: %w", err)
			}
			tokenByKey[key] = v
		}
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("usage: histogram: turn rows: %w", err)
		}
	}

	type peaks struct {
		fiveHour, sevenDay *float64
	}
	quotaByKey := make(map[string]peaks)
	{
		q := `SELECT ` + keyExpr + ` AS bkey,
		             MAX(five_hour_pct), MAX(seven_day_pct)
		      FROM quota_samples WHERE ts >= ? AND ts < ?
		      GROUP BY bkey`
		rows, err := s.db.Query(q, off, p.Since, p.Until)
		if err != nil {
			return nil, fmt.Errorf("usage: histogram: quota query: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var key string
			var fh, sd *float64
			if err := rows.Scan(&key, &fh, &sd); err != nil {
				return nil, fmt.Errorf("usage: histogram: quota scan: %w", err)
			}
			quotaByKey[key] = peaks{fiveHour: fh, sevenDay: sd}
		}
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("usage: histogram: quota rows: %w", err)
		}
	}

	out := make([]HistogramBin, 0, len(starts))
	for i, start := range starts {
		bin := HistogramBin{T: start}
		if v, ok := tokenByKey[keys[i]]; ok {
			bin.Input = v.input
			bin.Output = v.output
			bin.CacheCreation = v.cacheCreation
			bin.CacheRead = v.cacheRead
			bin.Total = v.input + v.output + v.cacheCreation + v.cacheRead
			bin.Turns = v.turns
		}
		if pk, ok := quotaByKey[keys[i]]; ok {
			bin.FiveHourPeak = pk.fiveHour
			bin.SevenDayPeak = pk.sevenDay
		}
		out = append(out, bin)
	}
	return out, nil
}
