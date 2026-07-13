package usage

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// SessionRow is a row of the agent_sessions dimension table.
type SessionRow struct {
	SessionID   string
	ProjectID   string
	Agent       string
	Model       string
	DisplayName string
	FirstSeen   time.Time
	LastSeen    time.Time
}

// CountContextSamples returns the number of rows in context_samples,
// optionally filtered to one session. Empty sessionID counts all rows.
func (s *Store) CountContextSamples(sessionID string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int
	var err error
	if sessionID == "" {
		err = s.db.QueryRow(`SELECT COUNT(*) FROM context_samples`).Scan(&n)
	} else {
		err = s.db.QueryRow(`SELECT COUNT(*) FROM context_samples WHERE session_id = ?`, sessionID).Scan(&n)
	}
	if err != nil {
		return 0, fmt.Errorf("usage: count context samples: %w", err)
	}
	return n, nil
}

// CountQuotaSamples returns the number of rows in quota_samples.
func (s *Store) CountQuotaSamples() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM quota_samples`).Scan(&n); err != nil {
		return 0, fmt.Errorf("usage: count quota samples: %w", err)
	}
	return n, nil
}

// LatestContextForSession returns the most recent context sample for a
// session, or nil when the session has no rows yet.
func (s *Store) LatestContextForSession(sessionID string) (*ContextSample, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row := s.db.QueryRow(`
		SELECT ts, session_id, pane_id, project_id, agent, model,
		       context_input_tokens, context_window_size, used_pct,
		       cur_input, cur_output, cache_creation, cache_read, source
		FROM context_samples WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT 1`, sessionID)
	var cs ContextSample
	var ts int64
	err := row.Scan(&ts, &cs.SessionID, &cs.PaneID, &cs.ProjectID, &cs.Agent, &cs.Model,
		&cs.ContextInputTokens, &cs.ContextWindowSize, &cs.UsedPct,
		&cs.CurInput, &cs.CurOutput, &cs.CacheCreation, &cs.CacheRead, &cs.Source)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("usage: latest context: %w", err)
	}
	cs.TS = time.Unix(ts, 0).UTC()
	return &cs, nil
}

// LatestQuota returns the most recent account-level quota sample, or nil
// when none has been recorded.
func (s *Store) LatestQuota() (*QuotaSample, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row := s.db.QueryRow(`
		SELECT ts, five_hour_pct, five_hour_resets_at,
		       seven_day_pct, seven_day_resets_at,
		       seven_day_opus_pct, seven_day_opus_resets_at,
		       seven_day_sonnet_pct, seven_day_sonnet_resets_at,
		       reported_by_session, model_family, source
		FROM quota_samples ORDER BY ts DESC, id DESC LIMIT 1`)
	var qs QuotaSample
	var ts int64
	var fhP, sdP, sdoP, sdsP sql.NullFloat64
	var fhR, sdR, sdoR, sdsR sql.NullInt64
	err := row.Scan(&ts, &fhP, &fhR, &sdP, &sdR, &sdoP, &sdoR, &sdsP, &sdsR,
		&qs.ReportedBySession, &qs.ModelFamily, &qs.Source)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("usage: latest quota: %w", err)
	}
	qs.TS = time.Unix(ts, 0).UTC()
	qs.FiveHour = Bucket{Pct: fPtr(fhP), ResetsAt: iPtr(fhR)}
	qs.SevenDay = Bucket{Pct: fPtr(sdP), ResetsAt: iPtr(sdR)}
	qs.SevenDayOpus = Bucket{Pct: fPtr(sdoP), ResetsAt: iPtr(sdoR)}
	qs.SevenDaySonnet = Bucket{Pct: fPtr(sdsP), ResetsAt: iPtr(sdsR)}
	return &qs, nil
}

// GetSession returns the dimension row for a session, or nil when absent.
func (s *Store) GetSession(sessionID string) (*SessionRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row := s.db.QueryRow(`
		SELECT session_id, project_id, agent, model, display_name, first_seen, last_seen
		FROM agent_sessions WHERE session_id = ?`, sessionID)
	var r SessionRow
	var first, last int64
	err := row.Scan(&r.SessionID, &r.ProjectID, &r.Agent, &r.Model, &r.DisplayName, &first, &last)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("usage: get session: %w", err)
	}
	r.FirstSeen = time.Unix(first, 0).UTC()
	r.LastSeen = time.Unix(last, 0).UTC()
	return &r, nil
}

func fPtr(n sql.NullFloat64) *float64 {
	if !n.Valid {
		return nil
	}
	v := n.Float64
	return &v
}

func iPtr(n sql.NullInt64) *int64 {
	if !n.Valid {
		return nil
	}
	v := n.Int64
	return &v
}
