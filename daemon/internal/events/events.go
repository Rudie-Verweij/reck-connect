// Package events holds agent-lifecycle events forwarded from hook shims
// running inside each pane's child process (Claude Code, Codex, Gemini
// CLI, etc.). Every supported agent's native hooks translate to one of
// these canonical Kinds, which lets the stoplight state machine and any
// future dashboard consumer treat them uniformly.
package events

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"sync"
	"time"
)

// Kind is the canonical, agent-agnostic event name. Each supported agent's
// native hooks map to one of these — e.g. Claude Code's "UserPromptSubmit"
// becomes KindUserPrompt, its "Stop" becomes KindStop.
type Kind string

const (
	KindSessionStart      Kind = "session_start"
	KindUserPrompt        Kind = "user_prompt"
	KindPreTool           Kind = "pre_tool"
	KindPostTool          Kind = "post_tool"
	KindPostToolFailure   Kind = "post_tool_failure"
	KindPermissionRequest Kind = "permission_request"
	KindPermissionDenied  Kind = "permission_denied"
	KindElicitation       Kind = "elicitation"
	KindStop              Kind = "stop"
	KindStopFailure       Kind = "stop_failure"
	KindNotification      Kind = "notification"
	KindSessionEnd        Kind = "session_end"
	// KindUserInterrupt is synthesized by the daemon (not forwarded from
	// an agent hook) when the user sends an ESC keystroke to a pane that
	// is currently "working". Claude Code only fires PostToolUseFailure
	// on interrupt mid-tool — interrupts during the thinking/response
	// phase produce zero hook events, so we detect them at the input
	// stream instead.
	KindUserInterrupt Kind = "user_interrupt"
)

// ValidKinds enumerates every acceptable event Kind. Callers validating
// untrusted input should use KindValid. Note: KindUserInterrupt is
// synthesized internally and intentionally rejected by the HTTP endpoint.
var ValidKinds = []Kind{
	KindSessionStart,
	KindUserPrompt,
	KindPreTool,
	KindPostTool,
	KindPostToolFailure,
	KindPermissionRequest,
	KindPermissionDenied,
	KindElicitation,
	KindStop,
	KindStopFailure,
	KindNotification,
	KindSessionEnd,
}

// KindValid reports whether s is one of the known Kind values.
func KindValid(s Kind) bool {
	for _, k := range ValidKinds {
		if k == s {
			return true
		}
	}
	return false
}

// Event is one agent lifecycle event recorded against a pane. Data holds
// the raw hook payload from the source agent (shape varies per agent /
// per event), preserved verbatim so a future dashboard can surface rich
// detail (prompt text, tool name, token counts, etc.).
type Event struct {
	ID        string          `json:"id"`
	PaneID    string          `json:"pane_id"`
	ProjectID string          `json:"project_id"`
	Agent     string          `json:"agent"` // "claude-code", "codex", "gemini-cli", ...
	Kind      Kind            `json:"kind"`
	At        time.Time       `json:"at"`
	Data      json.RawMessage `json:"data,omitempty"`
}

// NewID returns a short random ID for an Event.
func NewID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return "ev_" + hex.EncodeToString(b[:])
}

// Log is a thread-safe ring buffer of Events for one pane.
type Log struct {
	mu  sync.Mutex
	cap int
	buf []Event
}

// NewLog creates a Log that keeps at most `cap` events (oldest dropped).
func NewLog(cap int) *Log {
	if cap <= 0 {
		cap = 256
	}
	return &Log{cap: cap, buf: make([]Event, 0, cap)}
}

// Append records an event. Oldest is dropped if at capacity.
func (l *Log) Append(e Event) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.buf) >= l.cap {
		// Drop the oldest: shift in place. Cheap at our tiny caps.
		copy(l.buf, l.buf[1:])
		l.buf = l.buf[:len(l.buf)-1]
	}
	l.buf = append(l.buf, e)
}

// Snapshot returns a copy of every event currently held.
func (l *Log) Snapshot() []Event {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Event, len(l.buf))
	copy(out, l.buf)
	return out
}

// Recent returns up to `n` most recent events (oldest first).
// Negative `n` is treated defensively: it returns an empty slice rather
// than panicking on `make([]Event, n)`. Callers that want "everything"
// should pass a large positive bound or use Snapshot.
func (l *Log) Recent(n int) []Event {
	l.mu.Lock()
	defer l.mu.Unlock()
	if n <= 0 {
		return []Event{}
	}
	if n >= len(l.buf) {
		out := make([]Event, len(l.buf))
		copy(out, l.buf)
		return out
	}
	out := make([]Event, n)
	copy(out, l.buf[len(l.buf)-n:])
	return out
}

// Len returns the current size of the log.
func (l *Log) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buf)
}
