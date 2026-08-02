package http

import (
	"encoding/json"
	"fmt"
	"io"
	nethttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/usage"
)

// planTestServer stands up a daemon HTTP server backed by a fresh usage
// store, returning both so tests can seed rows directly.
func planTestServer(t *testing.T) (*httptest.Server, *usage.Store) {
	t.Helper()
	s := newServer(t)
	store, err := usage.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	s.UsageStore = store

	srv := httptest.NewServer(newTestHandler(t, s))
	t.Cleanup(srv.Close)
	return srv, store
}

func getJSON(t *testing.T, url string, into any) {
	t.Helper()
	resp, err := nethttp.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("GET %s: status=%d body=%s", url, resp.StatusCode, body)
	}
	if err := json.Unmarshal(body, into); err != nil {
		t.Fatalf("GET %s: parse: %v\n%s", url, err, body)
	}
}

type planWire struct {
	Subscription  string `json:"subscription"`
	RateLimitTier string `json:"rate_limit_tier"`
	TS            int64  `json:"ts"`
}

func TestUsageSummaryReportsPlan(t *testing.T) {
	srv, store := planTestServer(t)

	// Before any plan is recorded the key is simply absent — a station
	// where nobody has run Claude yet is not an error.
	var before struct {
		Enabled bool      `json:"enabled"`
		Plan    *planWire `json:"plan"`
	}
	getJSON(t, srv.URL+"/usage/summary", &before)
	if !before.Enabled {
		t.Fatal("enabled = false")
	}
	if before.Plan != nil {
		t.Errorf("plan = %+v, want absent before the first probe", before.Plan)
	}

	now := time.Unix(1_700_000_000, 0).UTC()
	if err := store.InsertPlanSample(usage.PlanSample{
		TS: now, Subscription: "max", RateLimitTier: "default_claude_max_20x",
	}); err != nil {
		t.Fatal(err)
	}

	var after struct {
		Plan *planWire `json:"plan"`
	}
	getJSON(t, srv.URL+"/usage/summary", &after)
	if after.Plan == nil {
		t.Fatal("plan absent after a sample was recorded")
	}
	if after.Plan.Subscription != "max" {
		t.Errorf("subscription = %q, want max", after.Plan.Subscription)
	}
	if after.Plan.RateLimitTier != "default_claude_max_20x" {
		t.Errorf("rate_limit_tier = %q", after.Plan.RateLimitTier)
	}
	if after.Plan.TS != now.Unix() {
		t.Errorf("ts = %d, want %d", after.Plan.TS, now.Unix())
	}
}

type histogramWire struct {
	Enabled  bool `json:"enabled"`
	PlanDays []struct {
		Day           int64  `json:"day"`
		Subscription  string `json:"subscription"`
		RateLimitTier string `json:"rate_limit_tier"`
	} `json:"plan_days"`
	PlanSummary   map[string]int `json:"plan_summary"`
	QuotaForecast map[string]struct {
		TS          int64   `json:"ts"`
		Pct         float64 `json:"used_percentage"`
		ResetsAt    int64   `json:"resets_at"`
		WindowStart int64   `json:"window_start"`
		RateCentre  float64 `json:"rate_centre"`
		RateLow     float64 `json:"rate_low"`
		RateHigh    float64 `json:"rate_high"`
	} `json:"quota_forecast"`
}

func TestUsageHistogramReportsPlanDays(t *testing.T) {
	srv, store := planTestServer(t)

	utcDay := func(d int) int64 {
		return time.Date(2026, 7, d, 0, 0, 0, 0, time.UTC).Unix()
	}
	// pro for the 1st-2nd, max from the 3rd on.
	for _, p := range []usage.PlanSample{
		{TS: time.Date(2026, 7, 1, 8, 0, 0, 0, time.UTC), Subscription: "pro"},
		{TS: time.Date(2026, 7, 3, 8, 0, 0, 0, time.UTC), Subscription: "max"},
	} {
		if err := store.InsertPlanSample(p); err != nil {
			t.Fatal(err)
		}
	}

	url := fmt.Sprintf("%s/usage/histogram?bucket=day&since=%d&until=%d&tz_offset_min=0",
		srv.URL, utcDay(1), utcDay(6))
	var got histogramWire
	getJSON(t, url, &got)

	if len(got.PlanDays) != 5 {
		t.Fatalf("plan_days = %d, want 5", len(got.PlanDays))
	}
	want := []string{"pro", "pro", "max", "max", "max"}
	for i, w := range want {
		if got.PlanDays[i].Subscription != w {
			t.Errorf("day %d: got %q, want %q", i+1, got.PlanDays[i].Subscription, w)
		}
		if got.PlanDays[i].Day != utcDay(i+1) {
			t.Errorf("day %d start = %d, want %d", i+1, got.PlanDays[i].Day, utcDay(i+1))
		}
	}
	if got.PlanSummary["pro"] != 2 || got.PlanSummary["max"] != 3 {
		t.Errorf("plan_summary = %v, want pro:2 max:3", got.PlanSummary)
	}
}

func TestUsageHistogramPlanDaysStayDailyAtEveryZoom(t *testing.T) {
	// Zooming in narrows the range; it must never subdivide the plan.
	// An hour-bucket request over one day still returns exactly one
	// plan day, not 24.
	srv, store := planTestServer(t)
	if err := store.InsertPlanSample(usage.PlanSample{
		TS: time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC), Subscription: "max",
	}); err != nil {
		t.Fatal(err)
	}

	since := time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC).Unix()
	until := time.Date(2026, 7, 3, 0, 0, 0, 0, time.UTC).Unix()

	for _, bucket := range []string{"hour", "1m", "day"} {
		t.Run(bucket, func(t *testing.T) {
			url := fmt.Sprintf("%s/usage/histogram?bucket=%s&since=%d&until=%d&tz_offset_min=0",
				srv.URL, bucket, since, until)
			var got histogramWire
			getJSON(t, url, &got)
			if len(got.PlanDays) != 1 {
				t.Errorf("bucket=%s: plan_days = %d, want 1", bucket, len(got.PlanDays))
			}
			if got.PlanSummary["max"] != 1 {
				t.Errorf("bucket=%s: plan_summary = %v, want max:1", bucket, got.PlanSummary)
			}
		})
	}
}

func TestUsageHistogramPlanDaysWithNoSamples(t *testing.T) {
	// An empty plan table must still produce a well-formed response: one
	// entry per day, all unknown, so the renderer needs no gap logic.
	srv, _ := planTestServer(t)
	since := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC).Unix()
	until := time.Date(2026, 7, 4, 0, 0, 0, 0, time.UTC).Unix()

	url := fmt.Sprintf("%s/usage/histogram?bucket=day&since=%d&until=%d&tz_offset_min=0",
		srv.URL, since, until)
	var got histogramWire
	getJSON(t, url, &got)

	if len(got.PlanDays) != 3 {
		t.Fatalf("plan_days = %d, want 3", len(got.PlanDays))
	}
	for i, d := range got.PlanDays {
		if d.Subscription != usage.PlanUnknown {
			t.Errorf("day %d = %q, want %q", i, d.Subscription, usage.PlanUnknown)
		}
	}
	if got.PlanSummary[usage.PlanUnknown] != 3 {
		t.Errorf("plan_summary = %v, want unknown:3", got.PlanSummary)
	}
}

func TestUsageExportCsv(t *testing.T) {
	srv, store := planTestServer(t)
	base := time.Date(2026, 7, 23, 10, 0, 0, 0, time.UTC)
	if err := store.InsertQuotaSample(usage.QuotaSample{
		TS: base, Source: "poll", FiveHour: usage.Bucket{Pct: f64p(86)},
	}); err != nil {
		t.Fatal(err)
	}

	since := base.Add(-time.Hour).Unix()
	until := base.Add(time.Hour).Unix()

	t.Run("serves csv with a download filename", func(t *testing.T) {
		url := fmt.Sprintf("%s/usage/export.csv?dataset=quota&since=%d&until=%d", srv.URL, since, until)
		resp, err := nethttp.Get(url)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			t.Fatalf("status=%d body=%s", resp.StatusCode, body)
		}
		if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
			t.Errorf("Content-Type = %q, want text/csv", ct)
		}
		if cd := resp.Header.Get("Content-Disposition"); !strings.Contains(cd, "reck-usage-quota-") {
			t.Errorf("Content-Disposition = %q", cd)
		}
		// The renderer reads this header to name the save dialog.
		if fn := resp.Header.Get("X-Reck-Export-Filename"); !strings.HasSuffix(fn, ".csv") {
			t.Errorf("X-Reck-Export-Filename = %q", fn)
		}
		if !strings.HasPrefix(string(body), "ts,ts_unix,five_hour_pct") {
			t.Errorf("body starts with %.60q", body)
		}
		if !strings.Contains(string(body), "poll") {
			t.Error("expected the poll row in the body")
		}
	})

	t.Run("defaults to the binned dataset", func(t *testing.T) {
		url := fmt.Sprintf("%s/usage/export.csv?since=%d&until=%d&bucket=hour", srv.URL, since, until)
		resp, err := nethttp.Get(url)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			t.Fatalf("status=%d body=%s", resp.StatusCode, body)
		}
		if !strings.HasPrefix(string(body), "bin_start,") {
			t.Errorf("body starts with %.40q, want the binned header", body)
		}
	})

	t.Run("rejects caller mistakes with 400", func(t *testing.T) {
		for _, q := range []string{
			fmt.Sprintf("dataset=nonsense&since=%d&until=%d", since, until),
			fmt.Sprintf("dataset=binned&since=%d&until=%d", since, until), // no bucket
			fmt.Sprintf("dataset=quota&since=%d&until=%d", until, since),  // reversed
			"dataset=quota&since=abc&until=def",
		} {
			resp, err := nethttp.Get(srv.URL + "/usage/export.csv?" + q)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != 400 {
				t.Errorf("%s: status=%d, want 400", q, resp.StatusCode)
			}
		}
	})
}

// The entitlement is the field the Satellite labels from: subscriptionType
// goes stale after an upgrade and cannot express the 5x/20x multiplier at
// all. See issue #130.
func TestUsageHistogramReportsRateLimitTier(t *testing.T) {
	srv, store := planTestServer(t)

	utcDay := func(d int) int64 {
		return time.Date(2026, 7, d, 0, 0, 0, 0, time.UTC).Unix()
	}
	if err := store.InsertPlanSample(usage.PlanSample{
		TS:            time.Date(2026, 7, 1, 8, 0, 0, 0, time.UTC),
		Subscription:  "pro", // stale
		RateLimitTier: "default_claude_max_5x",
	}); err != nil {
		t.Fatal(err)
	}

	url := fmt.Sprintf("%s/usage/histogram?bucket=day&since=%d&until=%d&tz_offset_min=0",
		srv.URL, utcDay(1), utcDay(3))
	var got histogramWire
	getJSON(t, url, &got)

	if len(got.PlanDays) != 2 {
		t.Fatalf("plan_days = %d, want 2", len(got.PlanDays))
	}
	for i, d := range got.PlanDays {
		if d.RateLimitTier != "default_claude_max_5x" {
			t.Errorf("day %d rate_limit_tier = %q, want default_claude_max_5x", i+1, d.RateLimitTier)
		}
	}
}

func TestUsageHistogramReportsQuotaForecast(t *testing.T) {
	srv, store := planTestServer(t)

	now := time.Now().UTC().Truncate(time.Second)
	reset := now.Add(2 * time.Hour).Unix()
	for i := 0; i < 13; i++ {
		pct := float64(i) * 5 // 30 %/h at 10-minute steps
		ts := now.Add(-time.Duration(120-i*10) * time.Minute)
		if err := store.InsertQuotaSample(usage.QuotaSample{
			TS:       ts,
			FiveHour: usage.Bucket{Pct: &pct, ResetsAt: &reset},
			Source:   "poll",
		}); err != nil {
			t.Fatal(err)
		}
	}

	// The forecast describes the LIVE window, so it must appear even though
	// the plotted range below is a historical one.
	day := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC).Unix()
	url := fmt.Sprintf("%s/usage/histogram?bucket=day&since=%d&until=%d&tz_offset_min=0",
		srv.URL, day, day+86400)
	var got histogramWire
	getJSON(t, url, &got)

	fh, ok := got.QuotaForecast["five_hour"]
	if !ok {
		t.Fatalf("quota_forecast has no five_hour: %+v", got.QuotaForecast)
	}
	if fh.ResetsAt != reset {
		t.Errorf("resets_at = %d, want %d", fh.ResetsAt, reset)
	}
	if want := reset - int64((5 * time.Hour).Seconds()); fh.WindowStart != want {
		t.Errorf("window_start = %d, want %d", fh.WindowStart, want)
	}
	if fh.Pct != 60 {
		t.Errorf("used_percentage = %v, want 60 (the latest actual reading)", fh.Pct)
	}
	if fh.RateCentre < 29 || fh.RateCentre > 31 {
		t.Errorf("rate_centre = %v, want ~30 %%/h", fh.RateCentre)
	}
	if !(fh.RateLow <= fh.RateCentre && fh.RateCentre <= fh.RateHigh) {
		t.Errorf("bounds out of order: %v / %v / %v", fh.RateLow, fh.RateCentre, fh.RateHigh)
	}
	// No 7d readings were ever written, so that bucket must be absent
	// rather than present with zeroes.
	if _, ok := got.QuotaForecast["seven_day"]; ok {
		t.Error("seven_day present despite no 7d readings")
	}
}
