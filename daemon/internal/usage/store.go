// Package usage records local token/quota telemetry for Claude Code panes
// on the station: how much of the context window each session is using and
// how much of the account-level 5-hour / weekly quota is consumed.
//
// The single source of live data is the Claude Code statusline stdin
// payload (context_window + rate_limits), forwarded to the daemon by a
// per-pane shim (see internal/hooks/reck-statusline.sh). Per-turn token
// counts are backfilled from the JSONL transcripts. Everything is stored
// locally in a single SQLite database — usage numbers and identifiers
// only, never prompt text or file paths.
//
// Storage is SQLite via modernc.org/sqlite (pure Go, no cgo) so the
// daemon keeps cross-compiling for macOS and Linux without a C toolchain.
package usage

import (
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// schemaVersion is bumped whenever the DDL below changes in a way that
// needs a migration. Today migrations are additive (CREATE TABLE/INDEX IF
// NOT EXISTS) so a fresh open of an old DB just adds the missing objects.
const schemaVersion = 1

// DBFilename is the SQLite file name inside the store directory.
const DBFilename = "usage.db"

// DefaultDir returns the default directory for the usage database. Lives
// next to the session index under ~/.config/reck/usage/ — same convention
// as sessions.DefaultDir(). Empty string when $HOME can't be resolved.
func DefaultDir() string {
	home, _ := os.UserHomeDir()
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".config", "reck", "usage")
}

// Bucket is one quota window as reported by the statusline rate_limits
// payload. Both fields are optional: a window Anthropic didn't report is
// left nil rather than persisted as a misleading zero.
type Bucket struct {
	Pct      *float64
	ResetsAt *int64 // unix seconds
}

// ContextSample is one per-session context-window observation.
type ContextSample struct {
	TS                 time.Time
	SessionID          string
	PaneID             string
	ProjectID          string
	Agent              string
	Model              string
	ContextInputTokens int64
	ContextWindowSize  int64
	UsedPct            float64
	CurInput           int64
	CurOutput          int64
	CacheCreation      int64
	CacheRead          int64
	Source             string
}

// QuotaSample is one account-level quota observation. Quota is shared
// across every concurrent agent on the account, so these rows are
// coalesced into a single series rather than written per pane.
type QuotaSample struct {
	TS                time.Time
	FiveHour          Bucket
	SevenDay          Bucket
	SevenDayOpus      Bucket
	SevenDaySonnet    Bucket
	ReportedBySession string
	ModelFamily       string
	Source            string
}

// TurnUsage is one authoritative per-turn token count from a JSONL
// transcript. message_id is the primary key so re-reads and concurrent
// agents can't double-count.
type TurnUsage struct {
	MessageID     string
	TS            time.Time
	SessionID     string
	ProjectID     string
	Agent         string
	Model         string
	InputTokens   int64
	OutputTokens  int64
	CacheCreation int64
	CacheRead     int64
}

// Store owns the SQLite database. Writes are serialized both by the
// single-connection pool and by mu; the workload is low-rate (a handful
// of rows per active turn) so contention is a non-issue.
type Store struct {
	db        *sql.DB
	mu        sync.Mutex
	installID string
}

// Open opens (or creates) the usage database under dir. It sets WAL mode,
// a busy timeout, runs the additive migrations, and ensures an install_id
// exists (a stable random id reserved for a future opt-in anonymous
// uplink — never sent anywhere unless the user turns sharing on).
func Open(dir string) (*Store, error) {
	if dir == "" {
		return nil, errors.New("usage: dir required")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", dir, err)
	}
	path := filepath.Join(dir, DBFilename)
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(on)")
	if err != nil {
		return nil, fmt.Errorf("open sqlite %s: %w", path, err)
	}
	// SQLite tolerates one writer at a time; a single connection avoids
	// "database is locked" churn entirely for this low-rate workload.
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := s.ensureMeta(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the underlying database.
func (s *Store) Close() error { return s.db.Close() }

// InstallID returns the stable per-install id.
func (s *Store) InstallID() string { return s.installID }

const schemaDDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  install_id     TEXT    NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS context_samples (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                   INTEGER NOT NULL,
  session_id           TEXT    NOT NULL,
  pane_id              TEXT    NOT NULL,
  project_id           TEXT    NOT NULL,
  agent                TEXT    NOT NULL,
  model                TEXT    NOT NULL DEFAULT '',
  context_input_tokens INTEGER NOT NULL DEFAULT 0,
  context_window_size  INTEGER NOT NULL DEFAULT 0,
  used_pct             REAL    NOT NULL DEFAULT 0,
  cur_input            INTEGER NOT NULL DEFAULT 0,
  cur_output           INTEGER NOT NULL DEFAULT 0,
  cache_creation       INTEGER NOT NULL DEFAULT 0,
  cache_read           INTEGER NOT NULL DEFAULT 0,
  source               TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ctx_session_ts ON context_samples(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_ctx_project_ts ON context_samples(project_id, ts);
CREATE INDEX IF NOT EXISTS idx_ctx_agent_ts   ON context_samples(agent, ts);
CREATE INDEX IF NOT EXISTS idx_ctx_ts         ON context_samples(ts);

CREATE TABLE IF NOT EXISTS quota_samples (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                       INTEGER NOT NULL,
  five_hour_pct            REAL,
  five_hour_resets_at      INTEGER,
  seven_day_pct            REAL,
  seven_day_resets_at      INTEGER,
  seven_day_opus_pct       REAL,
  seven_day_opus_resets_at INTEGER,
  seven_day_sonnet_pct     REAL,
  seven_day_sonnet_resets_at INTEGER,
  reported_by_session      TEXT NOT NULL DEFAULT '',
  model_family             TEXT NOT NULL DEFAULT '',
  source                   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_quota_ts ON quota_samples(ts);

CREATE TABLE IF NOT EXISTS turn_usage (
  message_id     TEXT PRIMARY KEY,
  ts             INTEGER NOT NULL,
  session_id     TEXT NOT NULL DEFAULT '',
  project_id     TEXT NOT NULL DEFAULT '',
  agent          TEXT NOT NULL DEFAULT '',
  model          TEXT NOT NULL DEFAULT '',
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_creation INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_turn_session_ts ON turn_usage(session_id, ts);

CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id   TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL DEFAULT '',
  agent        TEXT NOT NULL DEFAULT '',
  model        TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
);
`

func (s *Store) migrate() error {
	if _, err := s.db.Exec(schemaDDL); err != nil {
		return fmt.Errorf("usage: migrate: %w", err)
	}
	return nil
}

// ensureMeta reads (or seeds) the singleton schema_meta row, caching the
// install id on the Store.
func (s *Store) ensureMeta() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var installID string
	err := s.db.QueryRow(`SELECT install_id FROM schema_meta WHERE id = 1`).Scan(&installID)
	switch {
	case err == nil:
		s.installID = installID
		// Keep schema_version current for future migration logic.
		_, _ = s.db.Exec(`UPDATE schema_meta SET schema_version = ? WHERE id = 1`, schemaVersion)
		return nil
	case errors.Is(err, sql.ErrNoRows):
		id, gerr := newUUID()
		if gerr != nil {
			return fmt.Errorf("usage: generate install_id: %w", gerr)
		}
		if _, ierr := s.db.Exec(
			`INSERT INTO schema_meta (id, schema_version, install_id, created_at) VALUES (1, ?, ?, ?)`,
			schemaVersion, id, time.Now().UTC().Unix(),
		); ierr != nil {
			return fmt.Errorf("usage: seed schema_meta: %w", ierr)
		}
		s.installID = id
		return nil
	default:
		return fmt.Errorf("usage: read schema_meta: %w", err)
	}
}

// InsertContextSample appends one per-session context observation.
func (s *Store) InsertContextSample(cs ContextSample) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`
		INSERT INTO context_samples
		  (ts, session_id, pane_id, project_id, agent, model,
		   context_input_tokens, context_window_size, used_pct,
		   cur_input, cur_output, cache_creation, cache_read, source)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		cs.TS.UTC().Unix(), cs.SessionID, cs.PaneID, cs.ProjectID, cs.Agent, cs.Model,
		cs.ContextInputTokens, cs.ContextWindowSize, cs.UsedPct,
		cs.CurInput, cs.CurOutput, cs.CacheCreation, cs.CacheRead, cs.Source,
	)
	if err != nil {
		return fmt.Errorf("usage: insert context sample: %w", err)
	}
	return nil
}

// InsertQuotaSample appends one account-level quota observation.
func (s *Store) InsertQuotaSample(qs QuotaSample) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`
		INSERT INTO quota_samples
		  (ts, five_hour_pct, five_hour_resets_at,
		   seven_day_pct, seven_day_resets_at,
		   seven_day_opus_pct, seven_day_opus_resets_at,
		   seven_day_sonnet_pct, seven_day_sonnet_resets_at,
		   reported_by_session, model_family, source)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		qs.TS.UTC().Unix(),
		nullF(qs.FiveHour.Pct), nullI(qs.FiveHour.ResetsAt),
		nullF(qs.SevenDay.Pct), nullI(qs.SevenDay.ResetsAt),
		nullF(qs.SevenDayOpus.Pct), nullI(qs.SevenDayOpus.ResetsAt),
		nullF(qs.SevenDaySonnet.Pct), nullI(qs.SevenDaySonnet.ResetsAt),
		qs.ReportedBySession, qs.ModelFamily, qs.Source,
	)
	if err != nil {
		return fmt.Errorf("usage: insert quota sample: %w", err)
	}
	return nil
}

// InsertTurnUsage records one authoritative per-turn token count. Returns
// inserted=false when the message_id was already present (dedup across
// re-reads and concurrent agents).
func (s *Store) InsertTurnUsage(tu TurnUsage) (bool, error) {
	if tu.MessageID == "" {
		return false, errors.New("usage: turn message_id required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`
		INSERT OR IGNORE INTO turn_usage
		  (message_id, ts, session_id, project_id, agent, model,
		   input_tokens, output_tokens, cache_creation, cache_read)
		VALUES (?,?,?,?,?,?,?,?,?,?)`,
		tu.MessageID, tu.TS.UTC().Unix(), tu.SessionID, tu.ProjectID, tu.Agent, tu.Model,
		tu.InputTokens, tu.OutputTokens, tu.CacheCreation, tu.CacheRead,
	)
	if err != nil {
		return false, fmt.Errorf("usage: insert turn usage: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// UpsertSession records that a session was seen at `seen`, creating the
// dimension row on first sight and advancing last_seen thereafter. This is
// how liveness is tracked without writing a time-series row per minute.
// Non-empty project/agent/model/display fields overwrite; empty ones are
// left as-is so a sparse later call can't erase earlier detail.
func (s *Store) UpsertSession(sessionID, projectID, agent, model, displayName string, seen time.Time) error {
	if sessionID == "" {
		return errors.New("usage: session_id required")
	}
	ts := seen.UTC().Unix()
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`
		INSERT INTO agent_sessions
		  (session_id, project_id, agent, model, display_name, first_seen, last_seen)
		VALUES (?,?,?,?,?,?,?)
		ON CONFLICT(session_id) DO UPDATE SET
		  project_id   = CASE WHEN excluded.project_id   <> '' THEN excluded.project_id   ELSE project_id   END,
		  agent        = CASE WHEN excluded.agent        <> '' THEN excluded.agent        ELSE agent        END,
		  model        = CASE WHEN excluded.model        <> '' THEN excluded.model        ELSE model        END,
		  display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE display_name END,
		  last_seen    = excluded.last_seen`,
		sessionID, projectID, agent, model, displayName, ts, ts,
	)
	if err != nil {
		return fmt.Errorf("usage: upsert session: %w", err)
	}
	return nil
}

// --- small helpers ---

func nullF(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullI(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

// newUUID returns a random RFC-4122 v4 UUID string. Mirrors the approach
// in the sessions package rather than pulling google/uuid in directly.
func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
