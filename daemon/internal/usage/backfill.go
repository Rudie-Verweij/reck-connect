package usage

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
)

// SessionRef identifies a live Claude session whose JSONL transcript
// should be scanned for authoritative per-turn token counts.
type SessionRef struct {
	SessionID string
	Cwd       string
	ProjectID string
	Agent     string
}

// fileSig is the (mtime, size) fingerprint used to skip re-scanning an
// unchanged transcript.
type fileSig struct {
	mtime int64
	size  int64
}

// Backfiller scans Claude Code JSONL transcripts for per-turn `usage`
// records and records them in turn_usage, deduped by message_id. It
// complements the statusline path: authoritative per-turn tokens, plus
// history from before the statusline forwarder was installed.
//
// Re-scanning an unchanged file is skipped via an (mtime,size) cache; a
// changed file is re-read in full, which is safe because InsertTurnUsage
// is INSERT OR IGNORE on message_id (idempotent).
type Backfiller struct {
	store             *Store
	claudeProjectsDir string // "" ⇒ resolve ~/.claude/projects at scan time

	mu   sync.Mutex
	seen map[string]fileSig // keyed by sessionID
}

// NewBackfiller constructs a Backfiller. claudeProjectsDir may be empty to
// use the default ~/.claude/projects.
func NewBackfiller(store *Store, claudeProjectsDir string) *Backfiller {
	return &Backfiller{
		store:             store,
		claudeProjectsDir: claudeProjectsDir,
		seen:              make(map[string]fileSig),
	}
}

// Run scans each referenced session's transcript once, inserting any new
// per-turn usage rows. Errors on individual sessions are skipped silently
// (a missing/locked transcript is normal and self-heals next tick).
func (b *Backfiller) Run(refs []SessionRef) {
	dir := b.claudeProjectsDir
	if dir == "" {
		if d, err := sessions.DefaultClaudeProjectsDir(); err == nil {
			dir = d
		} else {
			return
		}
	}
	for _, ref := range refs {
		b.processOne(dir, ref)
	}
}

func (b *Backfiller) processOne(dir string, ref SessionRef) {
	if ref.SessionID == "" || ref.Cwd == "" {
		return
	}
	// Defense-in-depth: SessionID becomes the transcript file component in a
	// glob (FindTranscript's doc-comment requires a validated UUID). Inputs
	// come from daemon-minted UUIDs today, but reject anything with path /
	// glob metacharacters so a future relaxed resume path can't traverse.
	if !safeSessionID(ref.SessionID) {
		return
	}
	path, ok := sessions.FindTranscriptUnderProject(dir, ref.Cwd, ref.SessionID)
	if !ok {
		path = sessions.TranscriptPath(dir, ref.Cwd, ref.SessionID)
	}
	st, err := os.Stat(path)
	if err != nil || st.IsDir() {
		return
	}
	sig := fileSig{mtime: st.ModTime().UnixNano(), size: st.Size()}

	b.mu.Lock()
	prev, had := b.seen[ref.SessionID]
	b.mu.Unlock()
	if had && prev == sig {
		return // unchanged since last scan
	}

	if err := b.scan(path, ref); err != nil {
		return // leave seen unset so we retry next tick
	}

	b.mu.Lock()
	b.seen[ref.SessionID] = sig
	b.mu.Unlock()
}

// turnRecord captures only the assistant-message fields we need from one
// JSONL line. Everything else (content, tool results, prompts) is ignored.
type turnRecord struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Message   struct {
		ID    string `json:"id"`
		Model string `json:"model"`
		Usage *struct {
			InputTokens              int64 `json:"input_tokens"`
			OutputTokens             int64 `json:"output_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

func (b *Backfiller) scan(path string, ref SessionRef) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	// Transcripts carry large tool-result payloads; match the autoname
	// reader's generous per-line buffer so long lines don't abort the scan.
	sc.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var rec turnRecord
		if err := json.Unmarshal(line, &rec); err != nil {
			continue // tolerate schema drift / partial writes
		}
		if rec.Type != "assistant" || rec.Message.Usage == nil || rec.Message.ID == "" {
			continue
		}
		ts := parseTS(rec.Timestamp)
		_, _ = b.store.InsertTurnUsage(TurnUsage{
			MessageID:     rec.Message.ID,
			TS:            ts,
			SessionID:     ref.SessionID,
			ProjectID:     ref.ProjectID,
			Agent:         ref.Agent,
			Model:         rec.Message.Model,
			InputTokens:   rec.Message.Usage.InputTokens,
			OutputTokens:  rec.Message.Usage.OutputTokens,
			CacheCreation: rec.Message.Usage.CacheCreationInputTokens,
			CacheRead:     rec.Message.Usage.CacheReadInputTokens,
		})
	}
	if err := sc.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			// A single JSONL line exceeded the buffer cap (a giant tool
			// result). Returning an error here would leave `seen` unset and
			// re-scan this file every tick forever, never advancing. Treat
			// the file as processed instead: turns after the oversized line
			// are skipped, but the loop terminates. Rare; logged so it's
			// diagnosable.
			slog.Warn("usage: backfill hit an oversized transcript line; skipping remainder",
				"path", path, "session", ref.SessionID)
			return nil
		}
		return err
	}
	return nil
}

// safeSessionID rejects ids that could escape the per-session transcript
// file component (path separators, parent refs, or shell-glob
// metacharacters). Daemon-minted UUIDs always pass.
func safeSessionID(id string) bool {
	if id == "" || id == "." || id == ".." {
		return false
	}
	if strings.ContainsAny(id, `/\`) || strings.Contains(id, "..") {
		return false
	}
	if strings.ContainsAny(id, "*?[]") {
		return false
	}
	return true
}

func parseTS(s string) time.Time {
	if s == "" {
		return time.Unix(0, 0).UTC()
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC()
	}
	return time.Unix(0, 0).UTC()
}

// RunBackfiller periodically scans the transcripts of the sessions
// returned by refs() and records new per-turn usage. Blocks until ctx is
// cancelled. Safe with a nil backfiller or nil refs (no-op).
func RunBackfiller(ctx context.Context, b *Backfiller, refs func() []SessionRef, interval time.Duration) {
	if b == nil || refs == nil {
		<-ctx.Done()
		return
	}
	if interval <= 0 {
		interval = time.Minute
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			b.Run(refs())
		}
	}
}
