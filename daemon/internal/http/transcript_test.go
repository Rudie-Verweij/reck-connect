package http

// Tests for GET /projects/{id}/sessions/{session_id}/transcript — the
// endpoint that serves a Claude Code session's JSONL transcript from a
// byte offset so the satellite can render (and tail) the full chat.
//
// Harness: newServerWithSessions + a fake $HOME, mirroring
// TestListSessions_returnsLiveEntries — the handler resolves the claude
// projects dir from $HOME on every call, so pointing HOME at a tempdir
// is the seam that isolates these tests from the real ~/.claude.

import (
	"io"
	nethttp "net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
)

const testSessionID = "aeeea9b7-d60c-4f33-9254-b834bebc2d76"

// seedTranscript writes a fake Claude JSONL under the fake home's
// ~/.claude/projects/<EncodeCwd(cwd)>/<sid>.jsonl and returns its content.
func seedTranscript(t *testing.T, home, cwd, sid, content string) {
	t.Helper()
	dir := filepath.Join(home, ".claude", "projects", sessions.EncodeCwd(cwd))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, sid+".jsonl"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// transcriptFixture stands up the server + a seeded transcript and
// returns the httptest server base URL plus the seeded content.
func transcriptFixture(t *testing.T, content string) (baseURL string) {
	t.Helper()
	fakeHome := t.TempDir()
	t.Setenv("HOME", fakeHome)
	s, _, projectCwd := newServerWithSessions(t)
	seedTranscript(t, fakeHome, projectCwd, testSessionID, content)
	srv := httptest.NewServer(newTestHandler(t, s))
	t.Cleanup(srv.Close)
	return srv.URL
}

func getTranscript(t *testing.T, base, project, sid, query string) (*nethttp.Response, string) {
	t.Helper()
	url := base + "/projects/" + project + "/sessions/" + sid + "/transcript" + query
	r, err := nethttp.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(r.Body)
	r.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	return r, string(body)
}

func TestTranscript_servesFullFileFromZero(t *testing.T) {
	content := `{"type":"custom-title","customTitle":"x"}` + "\n" +
		`{"type":"user","message":{"content":"hello"}}` + "\n"
	base := transcriptFixture(t, content)

	r, body := getTranscript(t, base, "p1", testSessionID, "")
	if r.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", r.StatusCode)
	}
	if body != content {
		t.Fatalf("body = %q, want %q", body, content)
	}
	if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/x-ndjson") {
		t.Fatalf("Content-Type = %q, want application/x-ndjson", ct)
	}
	if got := r.Header.Get(TranscriptOffsetHeader); got != strconv.Itoa(len(content)) {
		t.Fatalf("offset header = %q, want %d", got, len(content))
	}
	if more := r.Header.Get(TranscriptMoreHeader); more != "" {
		t.Fatalf("more header = %q, want unset", more)
	}
	// The satellite renderer fetches cross-origin; without an explicit
	// expose list, browsers hide the X-Reck-* headers from fetch().
	expose := r.Header.Get("Access-Control-Expose-Headers")
	if !strings.Contains(expose, TranscriptOffsetHeader) || !strings.Contains(expose, TranscriptMoreHeader) {
		t.Fatalf("Access-Control-Expose-Headers = %q, want both transcript headers", expose)
	}
}

func TestTranscript_offsetServesTail(t *testing.T) {
	content := "0123456789"
	base := transcriptFixture(t, content)

	r, body := getTranscript(t, base, "p1", testSessionID, "?offset=4")
	if r.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", r.StatusCode)
	}
	if body != "456789" {
		t.Fatalf("body = %q, want %q", body, "456789")
	}
	if got := r.Header.Get(TranscriptOffsetHeader); got != "10" {
		t.Fatalf("offset header = %q, want 10", got)
	}
}

func TestTranscript_offsetAtOrBeyondEOF(t *testing.T) {
	content := "0123456789"
	base := transcriptFixture(t, content)

	for _, offset := range []string{"10", "999"} {
		r, body := getTranscript(t, base, "p1", testSessionID, "?offset="+offset)
		if r.StatusCode != 200 {
			t.Fatalf("offset=%s: status = %d, want 200", offset, r.StatusCode)
		}
		if body != "" {
			t.Fatalf("offset=%s: body = %q, want empty", offset, body)
		}
		// Beyond-EOF resyncs to the real size so a poller can't get stuck.
		if got := r.Header.Get(TranscriptOffsetHeader); got != "10" {
			t.Fatalf("offset=%s: offset header = %q, want 10", offset, got)
		}
		if more := r.Header.Get(TranscriptMoreHeader); more != "" {
			t.Fatalf("offset=%s: more header = %q, want unset", offset, more)
		}
	}
}

func TestTranscript_chunkCapAndMoreHeader(t *testing.T) {
	content := strings.Repeat("a", transcriptMaxChunk) + "TAIL-BYTES"
	base := transcriptFixture(t, content)

	r, body := getTranscript(t, base, "p1", testSessionID, "")
	if r.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", r.StatusCode)
	}
	if len(body) != transcriptMaxChunk {
		t.Fatalf("body len = %d, want cap %d", len(body), transcriptMaxChunk)
	}
	if got := r.Header.Get(TranscriptOffsetHeader); got != strconv.Itoa(transcriptMaxChunk) {
		t.Fatalf("offset header = %q, want %d", got, transcriptMaxChunk)
	}
	if more := r.Header.Get(TranscriptMoreHeader); more != "1" {
		t.Fatalf("more header = %q, want %q", more, "1")
	}

	// Second fetch from the returned offset drains the remainder.
	r2, body2 := getTranscript(t, base, "p1", testSessionID, "?offset="+strconv.Itoa(transcriptMaxChunk))
	if body2 != "TAIL-BYTES" {
		t.Fatalf("second chunk = %q, want %q", body2, "TAIL-BYTES")
	}
	if more := r2.Header.Get(TranscriptMoreHeader); more != "" {
		t.Fatalf("second more header = %q, want unset", more)
	}
}

func TestTranscript_invalidOffset400s(t *testing.T) {
	base := transcriptFixture(t, "x")
	for _, offset := range []string{"abc", "-1", "1.5"} {
		r, _ := getTranscript(t, base, "p1", testSessionID, "?offset="+offset)
		if r.StatusCode != 400 {
			t.Fatalf("offset=%s: status = %d, want 400", offset, r.StatusCode)
		}
	}
}

func TestTranscript_invalidSessionID400s(t *testing.T) {
	base := transcriptFixture(t, "x")
	// Path traversal and malformed ids must be rejected before any
	// filesystem access — the session id becomes a path component.
	// The third case is a UUID with the dashes stripped — right bytes,
	// wrong shape (zeros keep the gitleaks pre-commit hook quiet).
	for _, sid := range []string{"not-a-uuid", "..%2F..%2Fetc%2Fpasswd", "00000000000011112222333344445555"} {
		r, _ := getTranscript(t, base, "p1", sid, "")
		if r.StatusCode != 400 {
			t.Fatalf("sid=%s: status = %d, want 400", sid, r.StatusCode)
		}
	}
}

func TestTranscript_unknownProject404s(t *testing.T) {
	base := transcriptFixture(t, "x")
	r, _ := getTranscript(t, base, "does-not-exist", testSessionID, "")
	if r.StatusCode != 404 {
		t.Fatalf("status = %d, want 404", r.StatusCode)
	}
}

func TestTranscript_missingTranscript404s(t *testing.T) {
	base := transcriptFixture(t, "x")
	// Valid UUID, but no JSONL on disk for it.
	r, _ := getTranscript(t, base, "p1", "11111111-2222-4333-8444-555555555555", "")
	if r.StatusCode != 404 {
		t.Fatalf("status = %d, want 404", r.StatusCode)
	}
}

func TestTranscript_findsSessionInWorktreeDir(t *testing.T) {
	// A session that ran in a git worktree / subdir is stored under a
	// DIFFERENT EncodeCwd() dir than the project's registered cwd, so the
	// canonical path 404s. The handler must still find it by session id —
	// the UUID is globally unique across all project dirs.
	content := `{"type":"user","message":{"content":"from a worktree"}}` + "\n"
	fakeHome := t.TempDir()
	t.Setenv("HOME", fakeHome)
	s, _, projectCwd := newServerWithSessions(t)
	worktreeCwd := filepath.Join(projectCwd, ".claude", "worktrees", "feature-x")
	seedTranscript(t, fakeHome, worktreeCwd, testSessionID, content)
	srv := httptest.NewServer(newTestHandler(t, s))
	t.Cleanup(srv.Close)

	r, body := getTranscript(t, srv.URL, "p1", testSessionID, "")
	if r.StatusCode != 200 {
		t.Fatalf("status = %d, want 200 (found via session-id glob)", r.StatusCode)
	}
	if body != content {
		t.Fatalf("body = %q, want %q", body, content)
	}
}

func TestTranscript_authRequired(t *testing.T) {
	fakeHome := t.TempDir()
	t.Setenv("HOME", fakeHome)
	s, _, projectCwd := newServerWithSessions(t)
	seedTranscript(t, fakeHome, projectCwd, testSessionID, "x")
	// Bare Router (no bearer-injecting newTestHandler): must 401.
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	r, err := nethttp.Get(srv.URL + "/projects/p1/sessions/" + testSessionID + "/transcript")
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != 401 {
		t.Fatalf("status = %d, want 401", r.StatusCode)
	}
}
