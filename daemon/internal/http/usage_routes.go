package http

import (
	nethttp "net/http"
	"strconv"

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
				"day":          d.Day,
				"subscription": d.Subscription,
			})
		}
		resp["plan_days"] = planDays
		resp["plan_summary"] = usage.PlanSummary(days)
	}
	writeJSON(w, resp)
}
