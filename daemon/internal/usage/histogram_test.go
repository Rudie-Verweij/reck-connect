package usage

import (
	"testing"
	"time"
)

// histTestStore opens a fresh store and seeds it with a small, fixed
// turn_usage + quota_samples data set spanning two local days.
//
// All timestamps are built relative to base = 2026-07-01 00:00:00 UTC.
func histTestStore(t *testing.T) (*Store, int64) {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { s.Close() })

	base := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC).Unix()

	turns := []TurnUsage{
		// Day 1, hour 0 and hour 1, project alpha.
		{MessageID: "m1", TS: time.Unix(base+600, 0), SessionID: "s1", ProjectID: "alpha", Agent: "claude-code", InputTokens: 100, OutputTokens: 10, CacheCreation: 1000, CacheRead: 5000},
		{MessageID: "m2", TS: time.Unix(base+3700, 0), SessionID: "s1", ProjectID: "alpha", Agent: "claude-code", InputTokens: 200, OutputTokens: 20},
		// Day 1, hour 2, project beta.
		{MessageID: "m3", TS: time.Unix(base+7300, 0), SessionID: "s2", ProjectID: "beta", Agent: "claude-code", InputTokens: 400, OutputTokens: 40},
		// Day 2, project alpha.
		{MessageID: "m4", TS: time.Unix(base+86400+60, 0), SessionID: "s1", ProjectID: "alpha", Agent: "claude-code", InputTokens: 800, OutputTokens: 80},
	}
	for _, tu := range turns {
		if _, err := s.InsertTurnUsage(tu); err != nil {
			t.Fatalf("insert turn %s: %v", tu.MessageID, err)
		}
	}

	f := func(v float64) *float64 { return &v }
	quotas := []QuotaSample{
		{TS: time.Unix(base+700, 0), FiveHour: Bucket{Pct: f(10)}, SevenDay: Bucket{Pct: f(30)}},
		{TS: time.Unix(base+3800, 0), FiveHour: Bucket{Pct: f(25)}, SevenDay: Bucket{Pct: f(31)}},
		{TS: time.Unix(base+86400+120, 0), FiveHour: Bucket{Pct: f(5)}}, // day 2: no seven_day report
	}
	for i, q := range quotas {
		if err := s.InsertQuotaSample(q); err != nil {
			t.Fatalf("insert quota %d: %v", i, err)
		}
	}
	return s, base
}

func TestHistogramDayBins(t *testing.T) {
	s, base := histTestStore(t)
	bins, err := s.Histogram(HistogramParams{
		Bucket: BucketDay,
		Since:  base,
		Until:  base + 3*86400,
	})
	if err != nil {
		t.Fatalf("histogram: %v", err)
	}
	if len(bins) != 3 {
		t.Fatalf("want 3 day bins, got %d", len(bins))
	}
	// Day 1: m1+m2+m3.
	d1 := bins[0]
	if d1.T != base {
		t.Errorf("day1 start: want %d, got %d", base, d1.T)
	}
	if d1.Input != 700 || d1.Output != 70 || d1.CacheCreation != 1000 || d1.CacheRead != 5000 {
		t.Errorf("day1 sums wrong: %+v", d1)
	}
	if d1.Total != 6770 || d1.Turns != 3 {
		t.Errorf("day1 total/turns wrong: total=%d turns=%d", d1.Total, d1.Turns)
	}
	if d1.FiveHourPeak == nil || *d1.FiveHourPeak != 25 {
		t.Errorf("day1 five-hour peak: want 25, got %v", d1.FiveHourPeak)
	}
	if d1.SevenDayPeak == nil || *d1.SevenDayPeak != 31 {
		t.Errorf("day1 seven-day peak: want 31, got %v", d1.SevenDayPeak)
	}
	// Day 2: m4 only; five-hour reported, seven-day absent.
	d2 := bins[1]
	if d2.Input != 800 || d2.Turns != 1 {
		t.Errorf("day2 sums wrong: %+v", d2)
	}
	if d2.FiveHourPeak == nil || *d2.FiveHourPeak != 5 {
		t.Errorf("day2 five-hour peak: want 5, got %v", d2.FiveHourPeak)
	}
	if d2.SevenDayPeak != nil {
		t.Errorf("day2 seven-day peak: want nil, got %v", *d2.SevenDayPeak)
	}
	// Day 3: zero-filled.
	d3 := bins[2]
	if d3.Total != 0 || d3.Turns != 0 || d3.FiveHourPeak != nil {
		t.Errorf("day3 should be zero-filled: %+v", d3)
	}
}

func TestHistogramHourBins(t *testing.T) {
	s, base := histTestStore(t)
	bins, err := s.Histogram(HistogramParams{
		Bucket: BucketHour,
		Since:  base,
		Until:  base + 3*3600,
	})
	if err != nil {
		t.Fatalf("histogram: %v", err)
	}
	if len(bins) != 3 {
		t.Fatalf("want 3 hour bins, got %d", len(bins))
	}
	wantTurns := []int64{1, 1, 1}
	wantInput := []int64{100, 200, 400}
	for i := range bins {
		if bins[i].T != base+int64(i)*3600 {
			t.Errorf("bin %d start: want %d, got %d", i, base+int64(i)*3600, bins[i].T)
		}
		if bins[i].Turns != wantTurns[i] || bins[i].Input != wantInput[i] {
			t.Errorf("bin %d: want turns=%d input=%d, got %+v", i, wantTurns[i], wantInput[i], bins[i])
		}
	}
}

func TestHistogramProjectFilter(t *testing.T) {
	s, base := histTestStore(t)
	bins, err := s.Histogram(HistogramParams{
		Bucket:    BucketDay,
		Since:     base,
		Until:     base + 2*86400,
		ProjectID: "beta",
	})
	if err != nil {
		t.Fatalf("histogram: %v", err)
	}
	if bins[0].Input != 400 || bins[0].Turns != 1 {
		t.Errorf("beta day1: want input=400 turns=1, got %+v", bins[0])
	}
	if bins[1].Turns != 0 {
		t.Errorf("beta day2 should be empty, got %+v", bins[1])
	}
	// Quota is account-level: still reported despite the project filter.
	if bins[0].FiveHourPeak == nil || *bins[0].FiveHourPeak != 25 {
		t.Errorf("quota must ignore project filter, got %v", bins[0].FiveHourPeak)
	}
}

func TestHistogramTZOffset(t *testing.T) {
	s, base := histTestStore(t)
	// UTC+2 (e.g. Amsterdam in summer): local midnight is 22:00 UTC the
	// previous day, so the query range shifts and m1 (00:10 UTC) lands
	// in the local day that started at base-7200.
	bins, err := s.Histogram(HistogramParams{
		Bucket:      BucketDay,
		Since:       base - 7200,
		Until:       base - 7200 + 86400,
		TZOffsetMin: 120,
	})
	if err != nil {
		t.Fatalf("histogram: %v", err)
	}
	if len(bins) != 1 {
		t.Fatalf("want 1 bin, got %d", len(bins))
	}
	if bins[0].T != base-7200 {
		t.Errorf("bin start: want %d (local midnight), got %d", base-7200, bins[0].T)
	}
	// m1, m2, m3 are all before 22:00 UTC on day 1 → inside this local day.
	if bins[0].Turns != 3 {
		t.Errorf("want 3 turns in the shifted local day, got %d", bins[0].Turns)
	}
}

func TestHistogramMonthBins(t *testing.T) {
	s, base := histTestStore(t)
	// Add one turn in August to prove month bucketing.
	aug := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC).Unix()
	if _, err := s.InsertTurnUsage(TurnUsage{
		MessageID: "m-aug", TS: time.Unix(aug, 0), SessionID: "s1",
		ProjectID: "alpha", Agent: "claude-code", InputTokens: 50,
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	since := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).Unix()
	until := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC).Unix()
	bins, err := s.Histogram(HistogramParams{Bucket: BucketMonth, Since: since, Until: until})
	if err != nil {
		t.Fatalf("histogram: %v", err)
	}
	if len(bins) != 12 {
		t.Fatalf("want 12 month bins, got %d", len(bins))
	}
	if bins[6].T != base { // July
		t.Errorf("july bin start: want %d, got %d", base, bins[6].T)
	}
	if bins[6].Turns != 4 {
		t.Errorf("july turns: want 4, got %d", bins[6].Turns)
	}
	if bins[7].Input != 50 || bins[7].Turns != 1 {
		t.Errorf("august bin wrong: %+v", bins[7])
	}
	if bins[0].Turns != 0 || bins[11].Turns != 0 {
		t.Errorf("jan/dec should be zero-filled: %+v %+v", bins[0], bins[11])
	}
}

func TestHistogramEmptyDB(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	base := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC).Unix()
	bins, err := s.Histogram(HistogramParams{Bucket: BucketDay, Since: base, Until: base + 7*86400})
	if err != nil {
		t.Fatalf("histogram: %v", err)
	}
	if len(bins) != 7 {
		t.Fatalf("want 7 zero bins, got %d", len(bins))
	}
	for i, b := range bins {
		if b.Total != 0 || b.FiveHourPeak != nil {
			t.Errorf("bin %d not zero: %+v", i, b)
		}
	}
}

func TestHistogramValidation(t *testing.T) {
	s, base := histTestStore(t)
	cases := []struct {
		name string
		p    HistogramParams
	}{
		{"bad bucket", HistogramParams{Bucket: "week", Since: base, Until: base + 86400}},
		{"inverted range", HistogramParams{Bucket: BucketDay, Since: base + 86400, Until: base}},
		{"zero since", HistogramParams{Bucket: BucketDay, Since: 0, Until: base}},
		{"tz out of range", HistogramParams{Bucket: BucketDay, Since: base, Until: base + 86400, TZOffsetMin: 15 * 60}},
		{"too many bins", HistogramParams{Bucket: BucketHour, Since: base, Until: base + 2000*3600}},
	}
	for _, tc := range cases {
		if _, err := s.Histogram(tc.p); err == nil {
			t.Errorf("%s: expected error, got nil", tc.name)
		}
	}
}
