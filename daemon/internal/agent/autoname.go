// Auto-derive a human-readable pane label from Claude Code's own session
// title .
//
// Claude Code maintains a session title on disk. Each session's JSONL
// transcript at ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl contains
// zero or more {"type":"custom-title","customTitle":"…","sessionId":"…"}
// records. Each record replaces the previous — latest wins. The title is a
// fallback chain on Claude's side (user-set → auto-summary → first prompt)
// and we're just surfacing whatever it currently holds.
//
// The daemon reads these records lazily off the existing ProjectDetail
// poll path (no fsnotify, no goroutine-per-pane) and populates a new
// Pane.AutoName wire field the Satellite uses as a mid-priority fallback
// in its label chain:
//
//	user DisplayName > daemon AutoName > short session id / kind default
//
// When DisplayName is set the daemon skips the read entirely — the user
// chose their label, no point paying disk I/O for a value the client will
// never show.
//
// # cwd-to-slug transform
//
// We reuse sessions.EncodeCwd, which already matches Claude Code's
// on-disk convention (every non-alphanumeric byte replaced with "-").
// Empirical check against a populated ~/.claude/projects/ matches
// one-to-one for all samples, including the "/." → "--" edge case
// (/Users/reck-connect/.local → -Users-reck-connect--local).
//
// # Caching
//
// AutoNameCache holds one row per pane ID. A row carries the resolved
// JSONL path, its last-seen modtime + size, and the cached title string.
// On each Lookup, os.Stat is consulted; when (mtime,size) match the
// cached value the cache short-circuits with zero JSONL reads. Any
// mismatch (file rewritten, size grew, file replaced) re-reads.
//
// Zero-value Entry means "not in cache yet, do a full read and populate".
// An absent title in the JSONL caches as "" — that's still an authoritative
// answer ("no title found"), and the next mtime change reopens the check.

package agent

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
)

// isSeedTitle reports whether title is the "<projectID>/<8-hex>" label the
// daemon itself seeds via `--name` when spawning fresh Claude panes (see
// daemon/internal/agent/claude.go — `name := fmt.Sprintf("%s/%s", …)`).
//
// Claude Code persists the `--name` verbatim as a custom-title record in
// the JSONL, and empirically does *not* overwrite it with a
// conversation-derived summary on its own — so without this filter
// AutoName just round-trips our own garbage seed back to the tab.
//
// projectID empty ⇒ no filtering (callers that can't supply it get the
// historical behaviour). A non-empty match means "treat as no
// auto-title yet"; the caller falls through to the client-side "Claude"
// default until the user runs /rename or Claude ships a real
// summary-writer.
func isSeedTitle(title, projectID string) bool {
	if projectID == "" {
		return false
	}
	prefix := projectID + "/"
	if !strings.HasPrefix(title, prefix) {
		return false
	}
	suffix := title[len(prefix):]
	if len(suffix) != 8 {
		return false
	}
	// Case-insensitive hex. sessions.NewUUID() currently hardcodes
	// lowercase, so in practice we only see a-f — but case-insensitive
	// is one extra comparison and removes a silent coupling to that
	// generator choice. The theoretical collision (user renames to
	// "<exact-projectID>/<exactly-8-hex-chars>") is vanishing either way.
	for i := 0; i < 8; i++ {
		c := suffix[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

// readLatestCustomTitle scans the Claude Code JSONL transcript for
// (cwd, sessionID) and returns the most recently observed customTitle,
// skipping the daemon's own seed pattern (see isSeedTitle).
// Returns empty string for any of:
//   - claudeProjectsDir empty
//   - JSONL missing or unreadable
//   - no custom-title record in the file (or every record matched the seed)
//   - malformed JSON lines are silently skipped (defensive)
//
// The file is read forward once — these transcripts are append-only and
// rarely long enough to bother with reverse-scanning. If that changes we
// can swap in a tail-first scan without touching callers.
//
// projectID, when non-empty, enables the seed filter. An empty projectID
// preserves pre-filter behaviour and is mostly there for tests.
func readLatestCustomTitle(claudeProjectsDir, projectID, cwd, sessionID string) string {
	if claudeProjectsDir == "" || cwd == "" || sessionID == "" {
		return ""
	}
	path := filepath.Join(claudeProjectsDir, sessions.EncodeCwd(cwd), sessionID+".jsonl")
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	var latest string
	sc := bufio.NewScanner(f)
	// Transcripts can include large tool-result payloads; bump the
	// per-line buffer so long lines don't cause scanner.Err to surface
	// bufio.ErrTooLong and abort the pass. 10 MiB is generous but cheap
	// — the default 64 KiB is the real problem and won't ship.
	sc.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		// Cheap prefix prefilter: the JSON object always starts with '{'
		// and the type field is the first sub-object. This isn't safe
		// to anchor on — json.Unmarshal is the source of truth — but a
		// byte check lets us skip most non-matching lines (user
		// messages, assistant messages, tool results) without paying a
		// JSON decode per line.
		if line[0] != '{' {
			continue
		}
		var rec struct {
			Type        string `json:"type"`
			CustomTitle string `json:"customTitle"`
		}
		if err := json.Unmarshal(line, &rec); err != nil {
			// Malformed lines survive: Claude could extend the schema
			// tomorrow, or a partial write could land mid-flight. We
			// already have previous good reads in `latest`, so the
			// worst case is a stale answer for one poll.
			continue
		}
		if rec.Type == "custom-title" && rec.CustomTitle != "" {
			if isSeedTitle(rec.CustomTitle, projectID) {
				// Our own "--name" seed. Skip so a later /rename still
				// wins and, if there's nothing but seeds, the client
				// falls through to the "Claude" default.
				continue
			}
			latest = rec.CustomTitle
		}
	}
	return latest
}

// autoNameEntry is one cached row in AutoNameCache.
//
// mtime/size are the (statbuf.ModTime(), statbuf.Size()) from the most
// recent successful stat. title is the result of the last full JSONL
// read. hasRead distinguishes "we've never read this file" from "we read
// it and got empty" — the first must re-read on the next Lookup, the
// second can return cached empty until the file changes.
type autoNameEntry struct {
	path     string
	mtime    int64 // UnixNano, 0 on any stat error or not-yet-read
	size     int64
	title    string
	hasRead  bool
}

// AutoNameCache resolves a Claude pane's current custom-title via a
// mtime-gated read of the session's JSONL transcript.
//
// Lifecycle from the Manager:
//   - On spawn, no explicit call is required — the first Lookup seeds
//     the entry lazily.
//   - On pane exit, call Forget(paneID) so the cache doesn't grow
//     unbounded with dead-pane entries.
//
// Thread-safety: a single sync.Mutex guards the map + every entry's
// fields. Reads do happen under the lock (the JSONL open + decode), so
// concurrent Lookups on different panes serialize. That's fine: poll
// fan-out from a single ProjectDetail call is trivial, and two panes
// rarely share a file (one file per session).
type AutoNameCache struct {
	// claudeProjectsDir is the root that holds per-cwd-slug
	// subdirectories. Defaults to ~/.claude/projects when empty (resolved
	// at Lookup time so tests that t.Setenv("HOME", …) work without
	// re-constructing the cache).
	claudeProjectsDir string

	mu      sync.Mutex
	entries map[string]*autoNameEntry
	// readCount is bumped every time Lookup does a full JSONL read
	// (i.e. when the mtime short-circuit didn't fire). Exposed via
	// ReadCountForTest so tests can assert the cache actually skips
	// work on a second poll with no file change.
	readCount int
}

// NewAutoNameCache constructs an empty cache.
//
// claudeProjectsDir is the root Claude Code writes its per-cwd-slug
// subdirectories into. Empty ⇒ resolve ~/.claude/projects at Lookup time.
// Tests pass an explicit tmp path.
func NewAutoNameCache(claudeProjectsDir string) *AutoNameCache {
	return &AutoNameCache{
		claudeProjectsDir: claudeProjectsDir,
		entries:           make(map[string]*autoNameEntry),
	}
}

// resolveDir returns the configured claudeProjectsDir, falling back to
// ~/.claude/projects when unset. Resolved per-call so an explicit dir
// passed at construction time wins, but fresh daemons can leave it empty.
func (c *AutoNameCache) resolveDir() string {
	if c.claudeProjectsDir != "" {
		return c.claudeProjectsDir
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".claude", "projects")
}

// Lookup returns the current custom-title for (cwd, sessionID) as last
// seen in its JSONL transcript, keyed on paneID so a new pane generation
// (same cwd + session resumed under a new paneID) doesn't inherit stale
// cache state.
//
// projectID enables the daemon-seed filter (see isSeedTitle). Callers
// that can't supply one may pass "".
//
// The cache path:
//
//  1. stat the JSONL. On any error (missing, dir, permission) clear the
//     cached title and return "".
//  2. if (mtime, size) match the cached values AND we've read the file
//     at least once, return the cached title without re-opening.
//  3. otherwise re-read with readLatestCustomTitle, update the entry,
//     and return the fresh title.
//
// Empty cwd or sessionID (shell panes, Claude panes without session
// persistence) short-circuit to "" — the manager should already filter
// those out, but defense in depth.
func (c *AutoNameCache) Lookup(paneID, projectID, cwd, sessionID string) string {
	if paneID == "" || cwd == "" || sessionID == "" {
		return ""
	}
	dir := c.resolveDir()
	if dir == "" {
		return ""
	}
	path := filepath.Join(dir, sessions.EncodeCwd(cwd), sessionID+".jsonl")

	c.mu.Lock()
	defer c.mu.Unlock()

	e, ok := c.entries[paneID]
	if !ok || e.path != path {
		e = &autoNameEntry{path: path}
		c.entries[paneID] = e
	}

	st, err := os.Stat(path)
	if err != nil || st.IsDir() {
		// File not there yet (fresh spawn) or gone. Leave hasRead=false
		// so the next tick re-checks; return whatever we had last (""
		// if we've never read) rather than racing to produce a value.
		e.mtime = 0
		e.size = 0
		return ""
	}
	mtime := st.ModTime().UnixNano()
	size := st.Size()
	if e.hasRead && e.mtime == mtime && e.size == size {
		return e.title
	}
	title := readLatestCustomTitle(dir, projectID, cwd, sessionID)
	c.readCount++
	e.mtime = mtime
	e.size = size
	e.title = title
	e.hasRead = true
	return title
}

// Forget drops the cached entry for paneID. Called by the manager on
// pane exit so the cache doesn't grow unbounded with dead-pane state.
// No-op when paneID is unknown.
func (c *AutoNameCache) Forget(paneID string) {
	if paneID == "" {
		return
	}
	c.mu.Lock()
	delete(c.entries, paneID)
	c.mu.Unlock()
}

// EntryCountForTest exposes the number of cached entries, for tests
// asserting the cache shrinks on Forget. Not part of the stable API.
func (c *AutoNameCache) EntryCountForTest() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

// ReadCountForTest returns the total number of full JSONL reads performed
// since cache construction. Used by tests to assert the mtime short-circuit
// actually fires — a second Lookup with no file change must not bump this.
// Not part of the stable API.
func (c *AutoNameCache) ReadCountForTest() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.readCount
}
