package usage

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
)

// writeTranscript writes JSONL lines to the Claude-Code path for (cwd,
// sessionID) under root, creating the encoded-cwd subdir.
func writeTranscript(t *testing.T, root, cwd, sessionID string, lines []string) string {
	t.Helper()
	path := sessions.TranscriptPath(root, cwd, sessionID)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	body := ""
	for _, l := range lines {
		body += l + "\n"
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

const asstLine1 = `{"type":"assistant","timestamp":"2026-07-13T10:00:00Z","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":500,"cache_creation_input_tokens":200,"cache_read_input_tokens":3000}}}`
const asstLine2 = `{"type":"assistant","timestamp":"2026-07-13T10:01:00Z","message":{"id":"m2","model":"claude-opus-4-8","usage":{"input_tokens":1200,"output_tokens":600,"cache_creation_input_tokens":0,"cache_read_input_tokens":4000}}}`
const userLine = `{"type":"user","timestamp":"2026-07-13T10:00:30Z","message":{"role":"user"}}`
const junkLine = `not json at all`

func TestBackfiller_InsertsAndDedups(t *testing.T) {
	store := openTestStore(t)
	root := t.TempDir()
	cwd := "/Users/x/proj"
	sid := "sess-bf"
	writeTranscript(t, root, cwd, sid, []string{asstLine1, userLine, junkLine, asstLine2})

	b := NewBackfiller(store, root)
	ref := SessionRef{SessionID: sid, Cwd: cwd, ProjectID: "proj-1", Agent: "claude-code"}

	b.Run([]SessionRef{ref})
	tot, _ := store.SessionTotals(sid)
	if tot.Turns != 2 {
		t.Fatalf("expected 2 turns after first scan, got %d", tot.Turns)
	}
	if tot.InputTokens != 2200 || tot.CacheRead != 7000 {
		t.Fatalf("token sums wrong: %+v", tot)
	}

	// Re-run with no file change: mtime/size skip ⇒ still 2 (and dedup
	// would protect even without the skip).
	b.Run([]SessionRef{ref})
	tot, _ = store.SessionTotals(sid)
	if tot.Turns != 2 {
		t.Fatalf("re-scan changed count to %d, want 2", tot.Turns)
	}

	// Append a new assistant turn; a changed file re-scans and adds only
	// the new message_id.
	writeTranscript(t, root, cwd, sid, []string{asstLine1, asstLine2,
		`{"type":"assistant","timestamp":"2026-07-13T10:02:00Z","message":{"id":"m3","model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":50}}}`})
	b.Run([]SessionRef{ref})
	tot, _ = store.SessionTotals(sid)
	if tot.Turns != 3 {
		t.Fatalf("expected 3 turns after append, got %d", tot.Turns)
	}
}

func TestBackfiller_MissingTranscriptNoop(t *testing.T) {
	store := openTestStore(t)
	b := NewBackfiller(store, t.TempDir())
	// No file written: must not panic or error, and record nothing.
	b.Run([]SessionRef{{SessionID: "nope", Cwd: "/x", ProjectID: "p", Agent: "claude-code"}})
	tot, _ := store.SessionTotals("nope")
	if tot.Turns != 0 {
		t.Fatalf("expected 0 turns, got %d", tot.Turns)
	}
}
