package agent

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
)

// --- cwd-to-slug (delegates to sessions.EncodeCwd; sanity-check here so
// if EncodeCwd ever drifts we notice the autoname side-effect early). ---

func TestCwdToSlug_matchesClaudeCodeLayout(t *testing.T) {
	cases := []struct {
		cwd  string
		slug string
	}{
		// Empirical samples from a live station's ~/.claude/projects/:
		{"/Users/reck-connect/projects/reck-connect",
			"-Users-reck-connect-projects-reck-connect"},
		{"/Users/reck-connect/projects/reck-connect/.claude/worktrees/issue-24-claude-launch-args",
			"-Users-reck-connect-projects-reck-connect--claude-worktrees-issue-24-claude-launch-args"},
		{"/Users/reck-connect/.local/state/reck-scratch",
			"-Users-reck-connect--local-state-reck-scratch"},
		{"/Users/reck-connect/claude-code/Reck-Connect",
			"-Users-reck-connect-claude-code-Reck-Connect"},
		{"/private/tmp", "-private-tmp"},
	}
	for _, c := range cases {
		if got := sessions.EncodeCwd(c.cwd); got != c.slug {
			t.Errorf("EncodeCwd(%q) = %q, want %q", c.cwd, got, c.slug)
		}
	}
}

// --- readLatestCustomTitle ---

func TestReadLatestCustomTitle_fileMissing(t *testing.T) {
	dir := t.TempDir()
	got := readLatestCustomTitle(dir, "", "/Users/example/proj", "s1")
	if got != "" {
		t.Errorf("missing JSONL should yield empty, got %q", got)
	}
}

// writeTranscript is a tiny helper that creates the full
// claudeProjectsDir/<cwd-slug>/<sessionID>.jsonl path with the given body.
func writeTranscript(t *testing.T, claudeDir, cwd, sessionID, body string) string {
	t.Helper()
	slug := sessions.EncodeCwd(cwd)
	dir := filepath.Join(claudeDir, slug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	p := filepath.Join(dir, sessionID+".jsonl")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return p
}

func TestReadLatestCustomTitle_noCustomTitleRecord(t *testing.T) {
	dir := t.TempDir()
	cwd := "/Users/example/proj"
	sid := "deadbeef-aaaa-bbbb-cccc-111122223333"
	// Only user / assistant messages, no custom-title. Mirrors a fresh
	// transcript Claude Code hasn't yet labeled.
	body := `{"type":"user","content":"hi"}
{"type":"assistant","content":"hello"}
`
	writeTranscript(t, dir, cwd, sid, body)
	if got := readLatestCustomTitle(dir, "", cwd, sid); got != "" {
		t.Errorf("no custom-title should yield empty, got %q", got)
	}
}

func TestReadLatestCustomTitle_singleRecord(t *testing.T) {
	dir := t.TempDir()
	cwd := "/Users/example/proj"
	sid := "deadbeef-aaaa-bbbb-cccc-111122223333"
	body := `{"type":"custom-title","customTitle":"refactor broker","sessionId":"` + sid + `"}
`
	writeTranscript(t, dir, cwd, sid, body)
	if got := readLatestCustomTitle(dir, "", cwd, sid); got != "refactor broker" {
		t.Errorf("want %q, got %q", "refactor broker", got)
	}
}

func TestReadLatestCustomTitle_multipleRecordsLatestWins(t *testing.T) {
	dir := t.TempDir()
	cwd := "/Users/example/proj"
	sid := "deadbeef-aaaa-bbbb-cccc-111122223333"
	body := `{"type":"custom-title","customTitle":"first label","sessionId":"` + sid + `"}
{"type":"user","content":"hi"}
{"type":"custom-title","customTitle":"second label","sessionId":"` + sid + `"}
{"type":"assistant","content":"ok"}
{"type":"custom-title","customTitle":"third label","sessionId":"` + sid + `"}
`
	writeTranscript(t, dir, cwd, sid, body)
	if got := readLatestCustomTitle(dir, "", cwd, sid); got != "third label" {
		t.Errorf("latest should win: want %q, got %q", "third label", got)
	}
}

func TestReadLatestCustomTitle_malformedLinesSkipped(t *testing.T) {
	dir := t.TempDir()
	cwd := "/Users/example/proj"
	sid := "deadbeef-aaaa-bbbb-cccc-111122223333"
	// Intersperse garbage, partial lines, and a good record.
	body := "not json at all\n" +
		`{"type":"custom-title","customTitle":"good label","sessionId":"` + sid + `"}
` +
		`{broken json here` + "\n" +
		"\n" +
		"    \n"
	writeTranscript(t, dir, cwd, sid, body)
	if got := readLatestCustomTitle(dir, "", cwd, sid); got != "good label" {
		t.Errorf("malformed lines should be skipped: want %q, got %q", "good label", got)
	}
}

func TestReadLatestCustomTitle_ignoresEmptyTitleField(t *testing.T) {
	dir := t.TempDir()
	cwd := "/Users/example/proj"
	sid := "deadbeef-aaaa-bbbb-cccc-111122223333"
	// A record with type=custom-title but empty customTitle should NOT
	// overwrite an earlier good value — Claude Code wouldn't emit an
	// empty-string title deliberately; treat it as "no content".
	body := `{"type":"custom-title","customTitle":"real label","sessionId":"` + sid + `"}
{"type":"custom-title","customTitle":"","sessionId":"` + sid + `"}
`
	writeTranscript(t, dir, cwd, sid, body)
	if got := readLatestCustomTitle(dir, "", cwd, sid); got != "real label" {
		t.Errorf("empty customTitle should not overwrite: want %q, got %q", "real label", got)
	}
}

// --- Seed-filter coverage (isSeedTitle + readLatestCustomTitle filter) ---

func TestIsSeedTitle(t *testing.T) {
	cases := []struct {
		title, projectID string
		want             bool
	}{
		// Exact seed shape from claude.go: "<projectID>/<8-hex>".
		{"reck-connect/9e266a86", "reck-connect", true},
		{"proj-x/0123abcd", "proj-x", true},
		// Empty projectID disables the filter (historical callers).
		{"reck-connect/9e266a86", "", false},
		// Wrong project prefix.
		{"other-proj/9e266a86", "reck-connect", false},
		// Suffix too short / too long.
		{"reck-connect/9e266a8", "reck-connect", false},
		{"reck-connect/9e266a861", "reck-connect", false},
		// Non-hex in the 8-char slot.
		{"reck-connect/9e266a8z", "reck-connect", false},
		// Case-insensitive hex — the filter doesn't assume the generator
		// stays lowercase-only.
		{"reck-connect/9E266A86", "reck-connect", true},
		{"reck-connect/9e266A86", "reck-connect", true},
		// Real conversation-derived labels must pass.
		{"refactor broker startup", "reck-connect", false},
		{"reck-connect/feature-x", "reck-connect", false},
	}
	for _, c := range cases {
		if got := isSeedTitle(c.title, c.projectID); got != c.want {
			t.Errorf("isSeedTitle(%q, %q) = %v, want %v", c.title, c.projectID, got, c.want)
		}
	}
}

func TestReadLatestCustomTitle_seedIsFiltered(t *testing.T) {
	dir := t.TempDir()
	cwd := "/Users/example/proj"
	sid := "9e266a86-a63a-444e-b610-09124e0cd3c8"
	// Transcript with nothing but our own seed — matches what we see on
	// the station today. readLatestCustomTitle should skip the seed and
	// return "" so the client falls through to the "Claude" default.
	body := `{"type":"custom-title","customTitle":"reck-connect/9e266a86","sessionId":"` + sid + `"}
{"type":"custom-title","customTitle":"reck-connect/9e266a86","sessionId":"` + sid + `"}
`
	writeTranscript(t, dir, cwd, sid, body)
	if got := readLatestCustomTitle(dir, "reck-connect", cwd, sid); got != "" {
		t.Errorf("seed-only transcript should yield empty with filter: got %q", got)
	}
	// Without the projectID, the filter is disabled — we still see the seed.
	// This is the pre-fix behaviour and documents the safety valve.
	if got := readLatestCustomTitle(dir, "", cwd, sid); got != "reck-connect/9e266a86" {
		t.Errorf("no-filter mode should return the seed verbatim: got %q", got)
	}
}

func TestAutoNameCache_seedFilteredEndToEnd(t *testing.T) {
	dir := t.TempDir()
	cwd := "/Users/example/proj"
	sid := "9e266a86-a63a-444e-b610-09124e0cd3c8"
	// Seed-only transcript — what a freshly-spawned pane looks like
	// before the user has run /rename. With projectID threaded in, the
	// cache-wrapped Lookup must also return "" (belt-and-braces over the
	// readLatestCustomTitle unit test: guards the Lookup → scanner wiring
	// so a future refactor can't drop the projectID arg silently).
	body := `{"type":"custom-title","customTitle":"reck-connect/9e266a86","sessionId":"` + sid + `"}
`
	writeTranscript(t, dir, cwd, sid, body)

	c := NewAutoNameCache(dir)
	if got := c.Lookup("p_1", "reck-connect", cwd, sid); got != "" {
		t.Errorf("seed-only transcript via Lookup should yield empty, got %q", got)
	}
	if got := c.ReadCountForTest(); got != 1 {
		t.Errorf("first lookup should perform a read even though result is empty, got readCount=%d", got)
	}
}

func TestReadLatestCustomTitle_seedThenRenameWinsOverSeed(t *testing.T) {
	dir := t.TempDir()
	cwd := "/Users/example/proj"
	sid := "9e266a86-a63a-444e-b610-09124e0cd3c8"
	// Seed, then a user /rename, then the conversation continues. The
	// rename must win; the seed must not "override" on a later read just
	// because it appears twice.
	body := `{"type":"custom-title","customTitle":"reck-connect/9e266a86","sessionId":"` + sid + `"}
{"type":"user","content":"hi"}
{"type":"custom-title","customTitle":"fix mount watchdog","sessionId":"` + sid + `"}
{"type":"custom-title","customTitle":"reck-connect/9e266a86","sessionId":"` + sid + `"}
`
	writeTranscript(t, dir, cwd, sid, body)
	if got := readLatestCustomTitle(dir, "reck-connect", cwd, sid); got != "fix mount watchdog" {
		t.Errorf("rename between seeds should win: got %q", got)
	}
}

// --- AutoNameCache ---

func TestAutoNameCache_emptyWhenJSONLMissing(t *testing.T) {
	dir := t.TempDir()
	c := NewAutoNameCache(dir)
	if got := c.Lookup("p_1", "", "/Users/example/proj", "deadbeef-aaaa-bbbb-cccc-111122223333"); got != "" {
		t.Errorf("missing JSONL should return empty, got %q", got)
	}
	// A second call on a missing file must NOT bump readCount — there's
	// no file to read, and we already returned "". The cache's hasRead
	// stayed false so the next Lookup will re-stat, but still won't
	// read. readCount tracks actual file reads, not stat calls.
	_ = c.Lookup("p_1", "", "/Users/example/proj", "deadbeef-aaaa-bbbb-cccc-111122223333")
	if got := c.ReadCountForTest(); got != 0 {
		t.Errorf("readCount should be 0 when JSONL never materializes, got %d", got)
	}
}

func TestAutoNameCache_readsThenCaches(t *testing.T) {
	dir := t.TempDir()
	cwd := "/Users/example/proj"
	sid := "deadbeef-aaaa-bbbb-cccc-111122223333"
	body := `{"type":"custom-title","customTitle":"cached label","sessionId":"` + sid + `"}
`
	writeTranscript(t, dir, cwd, sid, body)

	c := NewAutoNameCache(dir)
	if got := c.Lookup("p_1", "", cwd, sid); got != "cached label" {
		t.Errorf("first lookup: want %q, got %q", "cached label", got)
	}
	if got := c.ReadCountForTest(); got != 1 {
		t.Errorf("first lookup should read once, got readCount=%d", got)
	}
	// Second call: file unchanged, mtime short-circuit must fire.
	if got := c.Lookup("p_1", "", cwd, sid); got != "cached label" {
		t.Errorf("second lookup: want %q, got %q", "cached label", got)
	}
	if got := c.ReadCountForTest(); got != 1 {
		t.Errorf("second lookup should hit cache (no read): readCount=%d, want 1", got)
	}
}

func TestAutoNameCache_rereadsOnMtimeChange(t *testing.T) {
	dir := t.TempDir()
	cwd := "/Users/example/proj"
	sid := "deadbeef-aaaa-bbbb-cccc-111122223333"
	path := writeTranscript(t, dir, cwd, sid,
		`{"type":"custom-title","customTitle":"first","sessionId":"`+sid+`"}
`)

	c := NewAutoNameCache(dir)
	if got := c.Lookup("p_1", "", cwd, sid); got != "first" {
		t.Errorf("first lookup: got %q, want %q", got, "first")
	}

	// Rewrite with a later mtime. os.WriteFile alone doesn't always
	// bump mtime detectably on fast filesystems (macOS 1 ns resolution
	// usually fine, but be robust), so we also bump mtime explicitly.
	newBody := `{"type":"custom-title","customTitle":"first","sessionId":"` + sid + `"}
{"type":"custom-title","customTitle":"second","sessionId":"` + sid + `"}
`
	if err := os.WriteFile(path, []byte(newBody), 0o600); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(path, future, future); err != nil {
		t.Fatal(err)
	}

	if got := c.Lookup("p_1", "", cwd, sid); got != "second" {
		t.Errorf("after rewrite: got %q, want %q", got, "second")
	}
	if got := c.ReadCountForTest(); got != 2 {
		t.Errorf("mtime change should re-read: readCount=%d, want 2", got)
	}
}

func TestAutoNameCache_forgetDropsEntry(t *testing.T) {
	dir := t.TempDir()
	cwd := "/Users/example/proj"
	sid := "deadbeef-aaaa-bbbb-cccc-111122223333"
	writeTranscript(t, dir, cwd, sid,
		`{"type":"custom-title","customTitle":"x","sessionId":"`+sid+`"}
`)

	c := NewAutoNameCache(dir)
	_ = c.Lookup("p_1", "", cwd, sid)
	_ = c.Lookup("p_2", "", cwd, sid)
	if got := c.EntryCountForTest(); got != 2 {
		t.Fatalf("want 2 cached entries, got %d", got)
	}
	c.Forget("p_1")
	if got := c.EntryCountForTest(); got != 1 {
		t.Errorf("after Forget(p_1): want 1, got %d", got)
	}
	c.Forget("p_1") // idempotent
	c.Forget("")    // no-op on empty id
	if got := c.EntryCountForTest(); got != 1 {
		t.Errorf("Forget should be idempotent: want 1, got %d", got)
	}
}

func TestAutoNameCache_emptyInputsShortCircuit(t *testing.T) {
	dir := t.TempDir()
	c := NewAutoNameCache(dir)
	cases := []struct {
		paneID, cwd, sessionID string
	}{
		{"", "/cwd", "sid"},
		{"p_1", "", "sid"},
		{"p_1", "/cwd", ""},
	}
	for _, tc := range cases {
		if got := c.Lookup(tc.paneID, "", tc.cwd, tc.sessionID); got != "" {
			t.Errorf("Lookup(%q,%q,%q) should short-circuit to empty, got %q",
				tc.paneID, tc.cwd, tc.sessionID, got)
		}
	}
	if got := c.ReadCountForTest(); got != 0 {
		t.Errorf("empty-input short-circuit should not read, got readCount=%d", got)
	}
}

// TestAutoNameCache_honoursHomeFallback exercises the "empty
// claudeProjectsDir ⇒ $HOME/.claude/projects" resolution. We can't rely
// on a real transcript being present, but we can verify the resolution
// doesn't panic and returns "" cleanly when the tmp HOME has no
// matching tree.
func TestAutoNameCache_honoursHomeFallback(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	c := NewAutoNameCache("")
	got := c.Lookup("p_1", "", "/Users/example/proj", "deadbeef-aaaa-bbbb-cccc-111122223333")
	if got != "" {
		t.Errorf("no transcript ⇒ empty, got %q", got)
	}
}
