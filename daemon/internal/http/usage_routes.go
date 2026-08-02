package http

import (
	"log/slog"
	nethttp "net/http"
	"strconv"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/usage"
)

// quotaToWire renders a QuotaSample as a JSON-friendly map, omitting
// buckets Anthropic didn't report.
func quotaToWire(q *usage.QuotaSample) map[string]any {
	if q == nil {
		return nil
	}
	out := map[string]any{
		"ts":                  q.TS.Unix(),
		"reported_by_session": q.ReportedBySession,
		"model_family":        q.ModelFamily,
	}
	addBucket(out, "five_hour", q.FiveHour)
	addBucket(out, "seven_day", q.SevenDay)
	addBucket(out, "seven_day_opus", q.SevenDayOpus)
	addBucket(out, "seven_day_sonnet", q.SevenDaySonnet)
	return out
}

func addBucket(out map[string]any, key string, b usage.Bucket) {
	if b.Pct == nil && b.ResetsAt == nil {
		return
	}
	m := map[string]any{}
	if b.Pct != nil {
		m["used_percentage"] = *b.Pct
	}
	if b.ResetsAt != nil {
		m["resets_at"] = *b.ResetsAt
	}
	out[key] = m
}

func contextToWire(c usage.ContextSample) map[string]any {
	return map[string]any{
		"ts":                   c.TS.Unix(),
		"session_id":           c.SessionID,
		"pane_id":              c.PaneID,
		"project_id":           c.ProjectID,
		"agent":                c.Agent,
		"model":                c.Model,
		"context_input_tokens": c.ContextInputTokens,
		"context_window_size":  c.ContextWindowSize,
		"used_pct":             c.UsedPct,
		"cur_input":            c.CurInput,
		"cur_output":           c.CurOutput,
		"cache_creation":       c.CacheCreation,
		"cache_read":           c.CacheRead,
		"source":               c.Source,
	}
}

// handleUsageSummary returns the latest account quota plus a per-session
// glance (latest context + authoritative turn totals). The foundation for
// the minimal rail badge and future usage UIs.
func (s *Server) handleUsageSummary(w nethttp.ResponseWriter, r *nethttp.Request) {
	if s.UsageStore == nil {
		writeJSON(w, map[string]any{"enabled": false})
		return
	}
	quota, err := s.UsageStore.LatestQuota()
	if err != nil {
		nethttp.Error(w, "usage summary failed", nethttp.StatusInternalServerError)
		return
	}
	sessions, err := s.UsageStore.ListSessions()
	if err != nil {
		nethttp.Error(w, "usage summary failed", nethttp.StatusInternalServerError)
		return
	}
	out := make([]map[string]any, 0, len(sessions))
	for _, se := range sessions {
		row := map[string]any{
			"session_id": se.SessionID,
			"project_id": se.ProjectID,
			"agent":      se.Agent,
			"model":      se.Model,
			"last_seen":  se.LastSeen.Unix(),
		}
		if ctx, _ := s.UsageStore.LatestContextForSession(se.SessionID); ctx != nil {
			row["context"] = map[string]any{
				"used_pct":             ctx.UsedPct,
				"context_input_tokens": ctx.ContextInputTokens,
				"context_window_size":  ctx.ContextWindowSize,
			}
		}
		if t, err := s.UsageStore.SessionTotals(se.SessionID); err == nil && t.Turns > 0 {
			row["totals"] = map[string]any{
				"turns":          t.Turns,
				"input_tokens":   t.InputTokens,
				"output_tokens":  t.OutputTokens,
				"cache_creation": t.CacheCreation,
				"cache_read":     t.CacheRead,
			}
		}
		out = append(out, row)
	}
	resp := map[string]any{
		"enabled":    true,
		"install_id": s.UsageStore.InstallID(),
		"quota":      quotaToWire(quota),
		"sessions":   out,
	}
	// Current subscription tier, for the app-bar badge. Absent until the
	// plan probe has recorded one — a missing plan is not an error.
	if plan, err := s.UsageStore.LatestPlan(); err == nil && plan != nil {
		resp["plan"] = map[string]any{
			"subscription":    plan.Subscription,
			"rate_limit_tier": plan.RateLimitTier,
			"ts":              plan.TS.Unix(),
		}
	}
	writeJSON(w, resp)
}

// handleUsageSeries returns a time-series for plotting. Query params:
//
//	kind       = "context" (default) | "quota"
//	session_id = required when kind=context
//	since      = unix seconds lower bound (default 0 = all)
//	limit      = max points (default/capped in the store)
func (s *Server) handleUsageSeries(w nethttp.ResponseWriter, r *nethttp.Request) {
	if s.UsageStore == nil {
		writeJSON(w, map[string]any{"enabled": false})
		return
	}
	q := r.URL.Query()
	kind := q.Get("kind")
	if kind == "" {
		kind = "context"
	}
	since, _ := strconv.ParseInt(q.Get("since"), 10, 64)
	limit, _ := strconv.Atoi(q.Get("limit"))

	switch kind {
	case "context":
		sid := q.Get("session_id")
		if sid == "" {
			nethttp.Error(w, "session_id is required for kind=context", nethttp.StatusBadRequest)
			return
		}
		rows, err := s.UsageStore.ContextSeries(sid, since, limit)
		if err != nil {
			nethttp.Error(w, "usage series failed", nethttp.StatusInternalServerError)
			return
		}
		points := make([]map[string]any, 0, len(rows))
		for _, c := range rows {
			points = append(points, contextToWire(c))
		}
		writeJSON(w, map[string]any{"kind": "context", "session_id": sid, "points": points})
	case "quota":
		rows, err := s.UsageStore.QuotaSeries(since, limit)
		if err != nil {
			nethttp.Error(w, "usage series failed", nethttp.StatusInternalServerError)
			return
		}
		points := make([]map[string]any, 0, len(rows))
		for i := range rows {
			points = append(points, quotaToWire(&rows[i]))
		}
		writeJSON(w, map[string]any{"kind": "quota", "points": points})
	default:
		nethttp.Error(w, "unknown kind (want context or quota)", nethttp.StatusBadRequest)
	}
}

// handleUsageExport streams the usage store as CSV for the Satellite's
// download button. Query params:
//
//	dataset       = "binned" (default) | "turns" | "quota"
//	since, until  = unix seconds, half-open [since, until) (required)
//	bucket        = bin width, required for dataset=binned
//	project_id    = optional filter (binned + turns; quota is account-level)
//	tz_offset_min = caller's zone, for bin alignment and readable timestamps
//
// Validation lives on usage.ExportParams so it is unit-tested once; a
// caller mistake is a 400 and a store failure a 500.
func (s *Server) handleUsageExport(w nethttp.ResponseWriter, r *nethttp.Request) {
	if s.UsageStore == nil {
		nethttp.Error(w, "usage tracking is not enabled on this station", nethttp.StatusNotFound)
		return
	}
	q := r.URL.Query()
	since, errSince := strconv.ParseInt(q.Get("since"), 10, 64)
	until, errUntil := strconv.ParseInt(q.Get("until"), 10, 64)
	if errSince != nil || errUntil != nil {
		nethttp.Error(w, "since and until must be unix seconds", nethttp.StatusBadRequest)
		return
	}
	tzOffsetMin := 0
	if v := q.Get("tz_offset_min"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			nethttp.Error(w, "tz_offset_min must be an integer", nethttp.StatusBadRequest)
			return
		}
		tzOffsetMin = n
	}
	dataset := usage.ExportDataset(q.Get("dataset"))
	if dataset == "" {
		dataset = usage.DatasetBinned
	}
	params := usage.ExportParams{
		Dataset:     dataset,
		Since:       since,
		Until:       until,
		Bucket:      usage.HistogramBucket(q.Get("bucket")),
		ProjectID:   q.Get("project_id"),
		TZOffsetMin: tzOffsetMin,
	}
	if err := params.Validate(); err != nil {
		nethttp.Error(w, err.Error(), nethttp.StatusBadRequest)
		return
	}

	// Headers before the first byte: once ExportCSV starts streaming we
	// can no longer change the status code, so a mid-stream store failure
	// can only be logged and the response truncated.
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+params.Filename()+"\"")
	w.Header().Set("X-Reck-Export-Filename", params.Filename())

	if _, err := s.UsageStore.ExportCSV(w, params); err != nil {
		slog.Warn("usage: csv export failed mid-stream", "err", err, "dataset", dataset)
	}
}

// handleUsageHistogram returns dense, server-binned token sums + per-bin
// quota peaks for the Satellite's usage view (issue #88). Query params:
//
//	bucket        = "hour" | "day" | "month" (required)
//	since, until  = unix seconds, half-open [since, until) (required)
//	project_id    = optional filter on turn_usage (quota is account-level
//	                and ignores it)
//	tz_offset_min = caller's zone offset in minutes east of UTC, so day
//	                and month bins start at the caller's local midnight
//
// Parameter validation (bucket whitelist, range sanity, bin-count cap)
// lives in the store's HistogramParams so it is unit-tested once.
func (s *Server) handleUsageHistogram(w nethttp.ResponseWriter, r *nethttp.Request) {
	if s.UsageStore == nil {
		writeJSON(w, map[string]any{"enabled": false})
		return
	}
	q := r.URL.Query()
	since, errSince := strconv.ParseInt(q.Get("since"), 10, 64)
	until, errUntil := strconv.ParseInt(q.Get("until"), 10, 64)
	if errSince != nil || errUntil != nil {
		nethttp.Error(w, "since and until must be unix seconds", nethttp.StatusBadRequest)
		return
	}
	tzOffsetMin := 0
	if v := q.Get("tz_offset_min"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			nethttp.Error(w, "tz_offset_min must be an integer", nethttp.StatusBadRequest)
			return
		}
		tzOffsetMin = n
	}
	params := usage.HistogramParams{
		Bucket:      usage.HistogramBucket(q.Get("bucket")),
		Since:       since,
		Until:       until,
		ProjectID:   q.Get("project_id"),
		TZOffsetMin: tzOffsetMin,
	}
	if err := params.Validate(); err != nil {
		nethttp.Error(w, err.Error(), nethttp.StatusBadRequest)
		return
	}
	bins, err := s.UsageStore.Histogram(params)
	if err != nil {
		nethttp.Error(w, "usage histogram failed", nethttp.StatusInternalServerError)
		return
	}
	out := make([]map[string]any, 0, len(bins))
	for _, b := range bins {
		m := map[string]any{
			"t":              b.T,
			"input":          b.Input,
			"output":         b.Output,
			"cache_creation": b.CacheCreation,
			"cache_read":     b.CacheRead,
			"total":          b.Total,
			"turns":          b.Turns,
		}
		if b.FiveHourPeak != nil {
			m["five_hour_peak"] = *b.FiveHourPeak
		}
		if b.SevenDayPeak != nil {
			m["seven_day_peak"] = *b.SevenDayPeak
		}
		out = append(out, m)
	}
	resp := map[string]any{
		"enabled": true,
		"bucket":  string(params.Bucket),
		"since":   params.Since,
		"until":   params.Until,
		"bins":    out,
	}

	// Plan attribution rides along on the histogram call so the usage view
	// gets it without a second round trip. It is ALWAYS per-day, whatever
	// `bucket` the caller asked for: zooming changes the range, never the
	// granularity of the plan. A store failure here degrades to "no plan
	// info" rather than failing the whole histogram.
	if days, err := s.UsageStore.PlanDays(params.Since, params.Until, params.TZOffsetMin); err == nil {
		planDays := make([]map[string]any, 0, len(days))
		for _, d := range days {
			planDays = append(planDays, map[string]any{
				"day":             d.Day,
				"subscription":    d.Subscription,
				"rate_limit_tier": d.RateLimitTier,
			})
		}
		resp["plan_days"] = planDays
		resp["plan_summary"] = usage.PlanSummary(days)
	}

	// Burn-rate forecast for the LIVE windows, so it rides along on the same
	// call as the plan block. Deliberately not range-scoped: it describes
	// what is true now, and the caller decides whether the range it is
	// plotting contains now. Computed from raw quota_samples, so its quality
	// doesn't vary with the `bucket` the caller asked for. Degrades to "no
	// forecast" on error rather than failing the histogram.
	if fh, sd, err := s.UsageStore.QuotaForecasts(time.Now()); err == nil {
		windows := map[string]any{}
		if fh != nil {
			windows["five_hour"] = quotaForecastToWire(fh)
		}
		if sd != nil {
			windows["seven_day"] = quotaForecastToWire(sd)
		}
		if len(windows) > 0 {
			resp["quota_forecast"] = windows
		}
	}
	writeJSON(w, resp)
}

// quotaForecastToWire encodes one window's live state and projected rates.
// Field names match addBucket's vocabulary so the two quota surfaces read
// alike. Rates are percentage points per hour.
func quotaForecastToWire(f *usage.QuotaForecast) map[string]any {
	return map[string]any{
		"ts":              f.TS,
		"used_percentage": f.Pct,
		"resets_at":       f.ResetsAt,
		"window_start":    f.WindowStart,
		"rate_centre":     f.RateCentre,
		"rate_low":        f.RateLow,
		"rate_high":       f.RateHigh,
	}
}

// --- poll settings ---------------------------------------------------
//
// Both verbs 404 when telemetry is disabled, matching handleUsageExport
// rather than the {"enabled": false} body the other usage GETs return.
// That convention would be actively misleading here: this route has its
// own `enabled` field meaning "polling is on", and a client could not tell
// the two apart.

// usagePollSettingsRequest is the PUT body. interval_sec is honoured even
// when enabled is false, so switching polling off and back on restores the
// period the user picked rather than resetting it.
type usagePollSettingsRequest struct {
	Enabled     bool `json:"enabled"`
	IntervalSec int  `json:"interval_sec"`
}

// pollSettingsWire renders settings plus the bounds the daemon enforces,
// so the client can validate against the real clamp instead of keeping its
// own copy of the numbers in sync.
func pollSettingsWire(s usage.PollSettings) map[string]any {
	return map[string]any{
		"enabled":          s.Enabled,
		"interval_sec":     int(s.Interval / time.Second),
		"min_interval_sec": int(usage.MinQuotaPollInterval / time.Second),
		"max_interval_sec": int(usage.MaxQuotaPollInterval / time.Second),
	}
}

// handleUsagePollSettings reports the station's current quota-poll choice.
func (s *Server) handleUsagePollSettings(w nethttp.ResponseWriter, r *nethttp.Request) {
	if s.UsageStore == nil {
		nethttp.Error(w, "usage tracking is not enabled on this station", nethttp.StatusNotFound)
		return
	}
	writeJSON(w, pollSettingsWire(usage.LoadPollSettings(s.UsageStore, usage.DefaultQuotaPollInterval)))
}

// handleSetUsagePollSettings persists a new choice and applies it to the
// running poller. Out-of-range intervals are clamped rather than refused,
// and the accepted value is echoed back so the caller can show what
// actually took effect.
func (s *Server) handleSetUsagePollSettings(w nethttp.ResponseWriter, r *nethttp.Request) {
	if s.UsageStore == nil {
		nethttp.Error(w, "usage tracking is not enabled on this station", nethttp.StatusNotFound)
		return
	}
	var req usagePollSettingsRequest
	if err := decodeJSONBody(w, r, maxJSONBody, &req); err != nil {
		return
	}
	if req.IntervalSec <= 0 {
		nethttp.Error(w, "interval_sec must be a positive number of seconds", nethttp.StatusBadRequest)
		return
	}
	saved, err := usage.SavePollSettings(s.UsageStore, usage.PollSettings{
		Enabled:  req.Enabled,
		Interval: time.Duration(req.IntervalSec) * time.Second,
	})
	if err != nil {
		nethttp.Error(w, "could not save poll settings", nethttp.StatusInternalServerError)
		return
	}
	// Persist first, then reconfigure: a poller running at a period that
	// isn't on disk would silently revert on the next restart, which is
	// the harder failure to notice.
	s.UsageQuotaPoller.SetInterval(saved.Effective())
	writeJSON(w, pollSettingsWire(saved))
}
