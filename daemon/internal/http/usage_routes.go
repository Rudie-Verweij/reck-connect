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
	writeJSON(w, map[string]any{
		"enabled":    true,
		"install_id": s.UsageStore.InstallID(),
		"quota":      quotaToWire(quota),
		"sessions":   out,
	})
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
