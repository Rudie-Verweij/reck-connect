package http

import (
	"encoding/json"
	"fmt"
	"io"
	nethttp "net/http"
	"net/http/httptest"
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
		Day          int64  `json:"day"`
		Subscription string `json:"subscription"`
	} `json:"plan_days"`
	PlanSummary map[string]int `json:"plan_summary"`
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
