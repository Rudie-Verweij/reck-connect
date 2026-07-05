// Package sessions persists the per-project index that maps a Claude Code
// session UUID to the pane that most recently hosted it, so that a
// daemon restart / pane close / reboot doesn't sever the user from their
// transcripts.
//
// Claude Code stores every conversation as JSONL under
// ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl and can respawn
// any of them with `claude --resume <uuid>`. Those transcripts already
// survive a restart — what we add here is the name ↔ uuid mapping so
// the Satellite can present a "Resume…" picker with human-readable
// labels instead of raw UUIDs.
//
// The index is intentionally append-mostly: we Upsert on spawn and
// Touch on exit / activity, but we don't delete entries when a pane
// exits. An exited pane is the *reason* you'd want to resume, not a
// reason to forget. List() filters entries whose JSONL no longer exists
// on disk at call time — cheap enough to do inline, and self-heals when
// Claude Code TTLs its own store (~30 days).
package sessions

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/rudie-verweij/reck-connect/proto"
)

// Entry is one row in a per-project session index.
//
// WasLive distinguishes a pane that was still running the last time we
// observed it from one the user explicitly closed. Set on spawn/resume,
// refreshed periodically by the manager, cleared only on graceful
// DeletePane. A daemon crash or SIGKILL leaves the flag set — that's
// how "restore what I was doing" knows what to offer at next startup.
//
// Identity:
//   - Kind=="claude" entries are identified by SessionID (the Claude
//     --resume UUID). SlotID is empty.
//   - Kind=="shell"  entries are identified by SlotID (a daemon-generated
//     UUID) and carry ShellArgv/Cwd so a respawn can reproduce the exact
//     invocation captured at create time. SessionID is empty.
//
// Migration (an earlier release Scope B additive): pre-migration rows on disk have
// no "kind" field and no SlotID — loadLocked() defaults Kind to
// PaneKindClaude so existing Claude-only indexes keep working. No version
// bump, no rewrite on load: the row is upgraded only when it next gets
// persisted through Upsert/Touch/SetLive/SetDisplayName.
type Entry struct {
	SessionID    string    `json:"session_id,omitempty"`
	Name         string    `json:"name"`
	Cwd          string    `json:"cwd"`
	CreatedAt    time.Time `json:"created_at"`
	LastActiveAt time.Time `json:"last_active_at"`
	LastPaneID   string    `json:"last_pane_id,omitempty"`
	WasLive      bool      `json:"was_live,omitempty"`
	// DisplayName is the user-given override for this session's label.
	// Empty = no override. Persisted here (not on the ephemeral Pane)
	// so the label survives pane respawn and daemon kickstart.
	DisplayName string `json:"display_name,omitempty"`
	// Kind of pane this entry represents. Introduced with Scope B of
	// an earlier release; missing on disk for older indexes, defaulted to
	// PaneKindClaude by loadLocked().
	Kind proto.PaneKind `json:"kind,omitempty"`
	// SlotID is the stable identifier for shell panes (Kind=="shell").
	// Regenerated on first save only if empty and kind is shell. Empty
	// on Claude entries — SessionID is their identity.
	SlotID string `json:"slot_id,omitempty"`
	// ShellArgv is the resolved absolute-path argv captured at shell
	// pane create time. Used verbatim on restore — we deliberately do
	// NOT re-resolve the project's default shell on restore because
	// project config can drift between create-time and restore-time,
	// and the stored argv is the invariant. Empty for Claude entries.
	ShellArgv []string `json:"shell_argv,omitempty"`
}

// Identity returns the stable identity key for this entry: SlotID for
// shell and codex panes, SessionID for Claude panes. Returns empty string
// when neither is set (a corrupted row).
func (e Entry) Identity() string {
	if e.Kind == proto.PaneKindShell || e.Kind == proto.PaneKindCodex {
		return e.SlotID
	}
	return e.SessionID
}

// Store owns the on-disk index directory. All mutating operations
// are serialized through mu — writes are rare (once per pane create /
// exit) so a single mutex is cheaper than per-file locking.
type Store struct {
	dir string

	mu sync.Mutex
}

// NewStore opens (or creates) a Store rooted at dir.
func NewStore(dir string) (*Store, error) {
	if dir == "" {
		return nil, errors.New("sessions: dir required")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", dir, err)
	}
	return &Store{dir: dir}, nil
}

// Dir returns the directory backing this store. Useful for tests.
func (s *Store) Dir() string { return s.dir }

func (s *Store) pathFor(projectID string) string {
	return filepath.Join(s.dir, projectID+".json")
}

type fileFormat struct {
	Entries []Entry `json:"entries"`
}

// loadLocked reads the project's index file. Missing file → empty slice.
// Caller must hold s.mu.
//
// Migration: rows missing the "kind" field (pre-Scope-B on-disk format)
// are promoted to Kind=="claude" in memory. The file is NOT rewritten
// here — migrated rows get persisted naturally the next time any write
// path (Upsert, Touch, SetLive, SetDisplayName) fires for that project.
// This keeps load cheap and loss-free: a read-only daemon observer
// doesn't mutate disk.
func (s *Store) loadLocked(projectID string) ([]Entry, error) {
	raw, err := os.ReadFile(s.pathFor(projectID))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	if len(raw) == 0 {
		return nil, nil
	}
	var f fileFormat
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("parse session index for %s: %w", projectID, err)
	}
	for i := range f.Entries {
		if f.Entries[i].Kind == "" {
			f.Entries[i].Kind = proto.PaneKindClaude
		}
	}
	return f.Entries, nil
}

// saveLocked atomically writes the project's index file. Caller must hold s.mu.
func (s *Store) saveLocked(projectID string, entries []Entry) error {
	path := s.pathFor(projectID)
	tmp := path + ".tmp"
	raw, err := json.MarshalIndent(fileFormat{Entries: entries}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Upsert inserts or replaces an entry by its identity (SessionID for
// Claude, SlotID for shell). LastActiveAt is set to entry.LastActiveAt;
// callers should typically set it to time.Now().
//
// Kind defaults to PaneKindClaude when the caller leaves it empty —
// matches the same load-time migration default and keeps pre-Scope-B
// call sites that only knew about Claude working as-is. Shell callers
// must set Kind explicitly so Identity() routes to SlotID.
func (s *Store) Upsert(projectID string, entry Entry) error {
	if entry.Kind == "" {
		entry.Kind = proto.PaneKindClaude
	}
	key := entry.Identity()
	if key == "" {
		switch entry.Kind {
		case proto.PaneKindShell, proto.PaneKindCodex:
			return errors.New("sessions: slot_id required for shell/codex entry")
		default:
			return errors.New("sessions: session_id required for claude entry")
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := s.loadLocked(projectID)
	if err != nil {
		return err
	}
	found := false
	for i, e := range entries {
		if e.Kind == entry.Kind && e.Identity() == key {
			// Preserve the original CreatedAt on re-upsert (a resume
			// shouldn't reset when the session was born).
			if !e.CreatedAt.IsZero() && entry.CreatedAt.IsZero() {
				entry.CreatedAt = e.CreatedAt
			}
			// Preserve the user-given DisplayName unless the caller
			// explicitly set one. Upsert is called on every spawn/resume
			// and should not clobber a rename just because the Manager
			// built the Entry without reading the previous value.
			if e.DisplayName != "" && entry.DisplayName == "" {
				entry.DisplayName = e.DisplayName
			}
			// Preserve ShellArgv for shell entries unless the caller
			// explicitly supplied one. Respawn/resume paths rebuild the
			// Entry from the *running* pane and may not re-capture the
			// original argv — we stored it at create time precisely so
			// that invariant survives restart.
			if len(entry.ShellArgv) == 0 && len(e.ShellArgv) > 0 {
				entry.ShellArgv = append([]string(nil), e.ShellArgv...)
			}
			entries[i] = entry
			found = true
			break
		}
	}
	if !found {
		entries = append(entries, entry)
	}
	return s.saveLocked(projectID, entries)
}

// Touch updates last_active_at (and optionally last_pane_id) for an
// existing entry, leaving WasLive unchanged. Missing identity is a
// no-op — we only care about refreshing entries we've already recorded
// at spawn time.
//
// The identity argument is matched against both SessionID and SlotID —
// callers can pass whichever one their pane carries without having to
// know the entry's Kind. A pathological entry with SessionID == SlotID
// across two rows (shouldn't happen) updates the first match only.
func (s *Store) Touch(projectID, identity, lastPaneID string, at time.Time) error {
	if identity == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := s.loadLocked(projectID)
	if err != nil {
		return err
	}
	for i, e := range entries {
		if entryMatches(e, identity) {
			entries[i].LastActiveAt = at
			if lastPaneID != "" {
				entries[i].LastPaneID = lastPaneID
			}
			return s.saveLocked(projectID, entries)
		}
	}
	return nil
}

// entryMatches reports whether e's identity (SessionID for Claude,
// SlotID for shell) equals the given id. Called from every identity-
// based mutator so the match rule lives in exactly one place.
func entryMatches(e Entry, id string) bool {
	if id == "" {
		return false
	}
	return e.Identity() == id
}

// SetDisplayName sets (or clears) the user-given label on a single entry.
// Empty string clears the override. Missing identity is a no-op — rename
// can only target sessions the daemon already knows about (i.e. spawned
// or resumed panes). Identity is matched against SessionID for Claude
// entries and SlotID for shell entries (Scope B).
func (s *Store) SetDisplayName(projectID, identity, displayName string) error {
	if identity == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := s.loadLocked(projectID)
	if err != nil {
		return err
	}
	for i, e := range entries {
		if entryMatches(e, identity) {
			if entries[i].DisplayName == displayName {
				return nil
			}
			entries[i].DisplayName = displayName
			return s.saveLocked(projectID, entries)
		}
	}
	return nil
}

// SetLive toggles the WasLive flag on a single entry. Used to mark a
// pane as gracefully closed (false) or actively running (true) without
// clobbering timestamps. Missing identity is a no-op. Identity is
// matched against SessionID for Claude entries and SlotID for shell.
func (s *Store) SetLive(projectID, identity string, live bool) error {
	if identity == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := s.loadLocked(projectID)
	if err != nil {
		return err
	}
	for i, e := range entries {
		if entryMatches(e, identity) {
			entries[i].WasLive = live
			return s.saveLocked(projectID, entries)
		}
	}
	return nil
}

// Get returns a single entry by identity, or ok=false. Identity matches
// SessionID for Claude entries and SlotID for shell entries.
func (s *Store) Get(projectID, identity string) (Entry, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := s.loadLocked(projectID)
	if err != nil {
		return Entry{}, false, err
	}
	for _, e := range entries {
		if entryMatches(e, identity) {
			return e, true, nil
		}
	}
	return Entry{}, false, nil
}

// ListOptions configure List behavior. claudeProjectsDir is the root
// where Claude Code stores per-cwd JSONL transcripts — defaults to
// ~/.claude/projects if empty. Exposed so tests can point somewhere
// under t.TempDir().
type ListOptions struct {
	ClaudeProjectsDir string
}

// List returns the project's entries newest-first (by last_active_at).
// Claude entries are filtered to ones whose JSONL still exists on disk
// (a missing JSONL means Claude Code has TTL'd the transcript —
// `--resume` would fail, so hiding the entry from the Satellite is the
// honest thing). Shell entries have no external transcript to check
// against, so they pass through unconditionally; callers doing
// restore-candidate work can layer their own filters on top.
func (s *Store) List(projectID string, opts ListOptions) ([]Entry, error) {
	s.mu.Lock()
	entries, err := s.loadLocked(projectID)
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, nil
	}
	claudeDir := opts.ClaudeProjectsDir
	if claudeDir == "" {
		var err error
		claudeDir, err = DefaultClaudeProjectsDir()
		if err != nil {
			return nil, err
		}
	}
	live := make([]Entry, 0, len(entries))
	for _, e := range entries {
		// Shell and codex panes have no Claude JSONL transcript to gate
		// on — their liveness is the slot record itself, so bypass the
		// transcript check that only makes sense for claude entries.
		if e.Kind == proto.PaneKindShell || e.Kind == proto.PaneKindCodex {
			live = append(live, e)
			continue
		}
		if transcriptExists(claudeDir, e.Cwd, e.SessionID) {
			live = append(live, e)
		}
	}
	sort.Slice(live, func(i, j int) bool {
		return live[i].LastActiveAt.After(live[j].LastActiveAt)
	})
	return live, nil
}

// TranscriptPath returns Claude Code's on-disk JSONL transcript path for
// (cwd, sessionID) under claudeProjectsDir. Shared by the liveness gate in
// List and the HTTP transcript endpoint so the formula lives in one place.
func TranscriptPath(claudeProjectsDir, cwd, sessionID string) string {
	return filepath.Join(claudeProjectsDir, EncodeCwd(cwd), sessionID+".jsonl")
}

// ResolveTranscriptCwd returns the first candidate cwd whose EncodeCwd()
// folder actually holds sessionID's transcript. It is the read-side recovery
// primitive for git-worktree sessions (issue #56): the caller passes the
// project root plus its live git worktrees, and this reports the directory
// Claude Code actually ran in — WITHOUT lossy-decoding a folder name back to a
// path (EncodeCwd collapses '/', '.', '-' all to '-', so decode is ambiguous).
//
// candidateCwds is tried in order, so put the canonical (recorded) cwd first
// to prefer it when a transcript exists under more than one candidate. Returns
// ("", false) when no candidate holds the transcript (e.g. the worktree was
// removed) — the caller must then NOT resume in the wrong cwd.
func ResolveTranscriptCwd(claudeProjectsDir, sessionID string, candidateCwds []string) (string, bool) {
	for _, cwd := range candidateCwds {
		if st, err := os.Stat(TranscriptPath(claudeProjectsDir, cwd, sessionID)); err == nil && !st.IsDir() {
			return cwd, true
		}
	}
	return "", false
}

// FindTranscript locates a session's JSONL. It prefers the canonical path
// (EncodeCwd(cwd)/<sid>.jsonl) but falls back to a glob across every project
// dir when that misses: a session that ran in a git worktree or a subdir is
// stored under the EncodeCwd() of its *actual* cwd, which differs from the
// project's registered cwd. The session id is a globally-unique UUID, so the
// glob is unambiguous. Callers MUST validate sessionID as a UUID first (the
// HTTP handler does) so it can't smuggle glob metacharacters or path parts.
func FindTranscript(claudeProjectsDir, cwd, sessionID string) (string, bool) {
	direct := TranscriptPath(claudeProjectsDir, cwd, sessionID)
	if _, err := os.Stat(direct); err == nil {
		return direct, true
	}
	matches, err := filepath.Glob(filepath.Join(claudeProjectsDir, "*", sessionID+".jsonl"))
	if err == nil && len(matches) > 0 {
		return matches[0], true
	}
	return "", false
}

// DefaultClaudeProjectsDir returns the conventional Claude Code transcript
// root (~/.claude/projects) for the current user.
func DefaultClaudeProjectsDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", "projects"), nil
}

// transcriptExists reports whether Claude Code's JSONL for (cwd, sessionID)
// is on disk under claudeProjectsDir.
//
// Failsafe for git-worktree sessions (issue #56): Claude Code keys the
// transcript folder on its *runtime* cwd, so a session run in a worktree lands
// under <EncodeCwd(cwd)>--claude-worktrees-<name>/, NOT the project-root folder
// the pane recorded as its launch cwd. Without tolerating that, Store.List's
// restore gate drops the session on every daemon restart even though its
// transcript is intact. So when the canonical path misses, also match
// worktree-suffixed sibling dirs of the encoded cwd.
//
// The match is scoped to <EncodeCwd(cwd)>* — the project's own directory
// subtree — rather than a bare *, so a mis-recorded session can't be adopted
// into an unrelated project. EncodeCwd's output is [A-Za-z0-9-]*, so the
// pattern carries no glob metacharacters.
func transcriptExists(claudeProjectsDir, cwd, sessionID string) bool {
	if st, err := os.Stat(TranscriptPath(claudeProjectsDir, cwd, sessionID)); err == nil && !st.IsDir() {
		return true
	}
	return TranscriptExistsUnderProject(claudeProjectsDir, cwd, sessionID)
}

// TranscriptExistsUnderProject reports whether sessionID's transcript is on
// disk anywhere under cwd's project subtree — the canonical <EncodeCwd(cwd)>
// folder or a worktree-suffixed sibling (<EncodeCwd(cwd)>--claude-worktrees-*).
//
// It's the "is there a transcript to protect?" test the resume path uses to
// distinguish a git-worktree session whose worktree was removed (transcript
// still present, unreachable → refuse resume, keep read-only) from a session
// with no transcript at all (nothing to orphan → legacy resume is fine). The
// match is scoped to <EncodeCwd(cwd)>* — this project's own subtree — so a
// mis-recorded session can't be adopted into an unrelated project. EncodeCwd's
// output is [A-Za-z0-9-]*, so the pattern carries no glob metacharacters;
// callers still pass UUID sessionIDs.
func TranscriptExistsUnderProject(claudeProjectsDir, cwd, sessionID string) bool {
	_, ok := FindTranscriptUnderProject(claudeProjectsDir, cwd, sessionID)
	return ok
}

// FindTranscriptUnderProject returns the on-disk path of sessionID's transcript
// when it lives anywhere under cwd's project subtree — the canonical
// <EncodeCwd(cwd)> folder or a worktree-suffixed sibling
// (<EncodeCwd(cwd)>--claude-worktrees-*). It's how the gone-worktree recovery
// locates a transcript that must be relocated into the project-root folder so
// `claude --resume` can continue it (issue #56). Same project-scoped,
// metacharacter-free glob as TranscriptExistsUnderProject; returns the first
// match (a UUID sessionID is unique, so at most one is expected).
func FindTranscriptUnderProject(claudeProjectsDir, cwd, sessionID string) (string, bool) {
	pattern := filepath.Join(claudeProjectsDir, EncodeCwd(cwd)+"*", sessionID+".jsonl")
	matches, err := filepath.Glob(pattern)
	if err != nil || len(matches) == 0 {
		return "", false
	}
	return matches[0], true
}

// EncodeCwd mirrors Claude Code's on-disk encoding: every non-alphanumeric
// byte in the absolute cwd is replaced with "-". The leading slash becomes
// a leading dash. Example:
//
//	/Users/reck-connect/projects/reck-connect
//	    → -Users-reck-connect-projects-reck-connect
var encodeRe = regexp.MustCompile(`[^A-Za-z0-9]`)

func EncodeCwd(cwd string) string {
	return encodeRe.ReplaceAllString(cwd, "-")
}

// NewUUID returns an RFC 4122 v4 UUID as a lowercase string. Claude Code
// requires a valid UUID for --session-id; a collision-resistant random
// v4 is what its own CLI would generate.
func NewUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10xx
	const hex = "0123456789abcdef"
	var out [36]byte
	hyphens := map[int]bool{8: true, 13: true, 18: true, 23: true}
	bi := 0
	for i := 0; i < 36; i++ {
		if hyphens[i] {
			out[i] = '-'
			continue
		}
		v := b[bi/2]
		if bi%2 == 0 {
			out[i] = hex[v>>4]
		} else {
			out[i] = hex[v&0x0f]
		}
		bi++
	}
	return string(out[:])
}

// DefaultDir returns the default state directory for session indexes.
// Lives next to projects.toml under ~/.config/reck/sessions/ — same
// convention the rest of the daemon uses.
func DefaultDir() string {
	home, _ := os.UserHomeDir()
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".config", "reck", "sessions")
}
