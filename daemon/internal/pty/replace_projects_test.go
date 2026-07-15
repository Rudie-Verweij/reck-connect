package pty

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/rudie-verweij/reck-connect/daemon/internal/agent"
)

// newReplaceProjectsManager builds a Manager wired for hybrid-mode local
// daemon tests: ModeLocal + a tmp prefix the test owns. Every cwd in
// the test payloads must lie under this prefix to satisfy the
// trust-boundary check, so we return both the manager and the prefix
// for the caller's convenience.
func newReplaceProjectsManager(t *testing.T) (*Manager, string) {
	t.Helper()
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	prefix := filepath.Join(dir, "permitted")
	if err := os.MkdirAll(prefix, 0o755); err != nil {
		t.Fatal(err)
	}
	mgr := NewManagerFromConfig(ManagerConfig{
		ClaudeCmd:              []string{"/bin/echo", "claude-placeholder"},
		DefaultShell:           []string{"/bin/sh"},
		ConfigPath:             configPath,
		Mode:                   agent.ModeLocal,
		PermittedProjectPrefix: prefix,
	})
	return mgr, prefix
}

// mkPermittedDir creates a directory under prefix and returns the
// absolute path. Used to satisfy the existence check for entries that
// should land as Available=true.
func mkPermittedDir(t *testing.T, prefix, name string) string {
	t.Helper()
	p := filepath.Join(prefix, name)
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", p, err)
	}
	return p
}

func TestReplaceProjects_acceptsValidPayload(t *testing.T) {
	mgr, prefix := newReplaceProjectsManager(t)
	cwdA := mkPermittedDir(t, prefix, "alpha")
	cwdB := mkPermittedDir(t, prefix, "beta")
	if err := mgr.ReplaceProjects([]ReplaceProjectsInput{
		{ID: "alpha", Cwd: cwdA},
		{ID: "beta", Cwd: cwdB},
	}); err != nil {
		t.Fatalf("ReplaceProjects: %v", err)
	}
	got := mgr.Projects()
	if len(got) != 2 {
		t.Fatalf("want 2 projects, got %d", len(got))
	}
	for _, p := range got {
		if !p.Available {
			t.Errorf("project %q: want Available=true (cwd exists), got false", p.ID)
		}
	}
}

func TestReplaceProjects_emptyListDropsAll(t *testing.T) {
	mgr, prefix := newReplaceProjectsManager(t)
	cwdA := mkPermittedDir(t, prefix, "alpha")
	if err := mgr.ReplaceProjects([]ReplaceProjectsInput{{ID: "alpha", Cwd: cwdA}}); err != nil {
		t.Fatal(err)
	}
	if got := len(mgr.Projects()); got != 1 {
		t.Fatalf("seeding: want 1 project, got %d", got)
	}
	// User disables local mode → renderer pushes empty list.
	if err := mgr.ReplaceProjects(nil); err != nil {
		t.Fatalf("empty replace: %v", err)
	}
	if got := len(mgr.Projects()); got != 0 {
		t.Fatalf("after empty replace: want 0 projects, got %d", got)
	}
}

func TestReplaceProjects_replacesWholesale(t *testing.T) {
	mgr, prefix := newReplaceProjectsManager(t)
	a := mkPermittedDir(t, prefix, "alpha")
	b := mkPermittedDir(t, prefix, "beta")
	c := mkPermittedDir(t, prefix, "gamma")
	if err := mgr.ReplaceProjects([]ReplaceProjectsInput{
		{ID: "alpha", Cwd: a},
		{ID: "beta", Cwd: b},
	}); err != nil {
		t.Fatal(err)
	}
	// Second push drops alpha + beta and adds gamma.
	if err := mgr.ReplaceProjects([]ReplaceProjectsInput{{ID: "gamma", Cwd: c}}); err != nil {
		t.Fatal(err)
	}
	got := mgr.Projects()
	if len(got) != 1 || got[0].ID != "gamma" {
		t.Fatalf("after replace: want [gamma], got %+v", got)
	}
}

func TestReplaceProjects_missingCwdRegistersUnavailable(t *testing.T) {
	mgr, prefix := newReplaceProjectsManager(t)
	missing := filepath.Join(prefix, "never-existed")
	if err := mgr.ReplaceProjects([]ReplaceProjectsInput{
		{ID: "ghost", Cwd: missing},
	}); err != nil {
		t.Fatalf("missing cwd should not reject: %v", err)
	}
	got := mgr.Projects()
	if len(got) != 1 {
		t.Fatalf("want 1 project (registered), got %d", len(got))
	}
	if got[0].Available {
		t.Fatalf("project %q with missing cwd: want Available=false, got true", got[0].ID)
	}
}

func TestReplaceProjects_validationRejections(t *testing.T) {
	mgr, prefix := newReplaceProjectsManager(t)
	valid := mkPermittedDir(t, prefix, "valid")
	cases := []struct {
		name   string
		inputs []ReplaceProjectsInput
		// substring expected to appear in the error text — keeps the
		// assertion stable against tweaks to the surrounding wrap.
		wantErrSubstr string
	}{
		{
			name:          "empty id",
			inputs:        []ReplaceProjectsInput{{ID: "", Cwd: valid}},
			wantErrSubstr: "id is required",
		},
		{
			name:          "invalid id",
			inputs:        []ReplaceProjectsInput{{ID: "has space", Cwd: valid}},
			wantErrSubstr: "project id",
		},
		{
			name:          "empty cwd",
			inputs:        []ReplaceProjectsInput{{ID: "ok", Cwd: ""}},
			wantErrSubstr: "cwd is required",
		},
		{
			name:          "duplicate id",
			inputs:        []ReplaceProjectsInput{{ID: "dup", Cwd: valid}, {ID: "dup", Cwd: valid}},
			wantErrSubstr: "duplicate id",
		},
		{
			name:          "relative path",
			inputs:        []ReplaceProjectsInput{{ID: "ok", Cwd: "relative/path"}},
			wantErrSubstr: "absolute path",
		},
		{
			name:          "outside prefix",
			inputs:        []ReplaceProjectsInput{{ID: "ok", Cwd: "/etc"}},
			wantErrSubstr: "permitted prefix",
		},
		{
			name:          "traversal segment",
			inputs:        []ReplaceProjectsInput{{ID: "ok", Cwd: filepath.Join(prefix, "x", "..", "..", "etc")}},
			wantErrSubstr: "permitted prefix", // .. collapses out, then the resulting path falls outside the prefix
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := mgr.ReplaceProjects(tc.inputs)
			if err == nil {
				t.Fatalf("want error containing %q, got nil", tc.wantErrSubstr)
			}
			if !errors.Is(err, ErrPutProjectsRejected) {
				t.Errorf("want errors.Is(err, ErrPutProjectsRejected) = true; err = %v", err)
			}
			if !strings.Contains(err.Error(), tc.wantErrSubstr) {
				t.Errorf("want error containing %q, got %v", tc.wantErrSubstr, err)
			}
			// Whole-payload reject: the manager state must be untouched.
			if got := len(mgr.Projects()); got != 0 {
				t.Errorf("rejection should not mutate state; got %d projects", got)
			}
		})
	}
}

// TestHasTraversalSegment_unitTable pins the literal-`..` check so a
// future refactor of ReplaceProjects can't drop the belt-and-braces
// guard the prefix gate already mostly covers. ReplaceProjects only
// invokes this against an already-Cleaned path; the cases here exercise
// every branch.
func TestHasTraversalSegment_unitTable(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"/a/b/c", false},
		{"/a/../b", true},
		{"/a/..", true},
		{"../foo", true},
		{"/a/.../b", false}, // three dots is not traversal
		{"", false},
		{"/", false},
	}
	for _, c := range cases {
		if got := hasTraversalSegment(c.in); got != c.want {
			t.Errorf("hasTraversalSegment(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestReplaceProjects_escapingSymlinkRejected(t *testing.T) {
	mgr, prefix := newReplaceProjectsManager(t)
	// Target lives outside the permitted prefix.
	outsideRoot := t.TempDir()
	outsideTarget := filepath.Join(outsideRoot, "leak")
	if err := os.MkdirAll(outsideTarget, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(prefix, "linked")
	if err := os.Symlink(outsideTarget, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	err := mgr.ReplaceProjects([]ReplaceProjectsInput{{ID: "leak", Cwd: link}})
	if err == nil {
		t.Fatal("escaping symlink should be rejected")
	}
	if !errors.Is(err, ErrPutProjectsRejected) {
		t.Fatalf("want ErrPutProjectsRejected wrap; got %v", err)
	}
	if !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("want error mentioning symlink; got %v", err)
	}
	if got := len(mgr.Projects()); got != 0 {
		t.Errorf("rejection must not mutate state; got %d projects", got)
	}
}

func TestReplaceProjects_innerSymlinkAllowed(t *testing.T) {
	// Symlinks that resolve to a target also under the permitted prefix
	// are fine — they're how the Satellite presents sshfs-mounted folders.
	mgr, prefix := newReplaceProjectsManager(t)
	target := mkPermittedDir(t, prefix, "real")
	link := filepath.Join(prefix, "linked")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	if err := mgr.ReplaceProjects([]ReplaceProjectsInput{{ID: "ok", Cwd: link}}); err != nil {
		t.Fatalf("inner symlink should be accepted: %v", err)
	}
	got := mgr.Projects()
	if len(got) != 1 || !got[0].Available {
		t.Fatalf("want 1 available project; got %+v", got)
	}
}

func TestReplaceProjects_concurrentSerializes(t *testing.T) {
	// N concurrent ReplaceProjects calls must serialise on m.mu so the
	// final state equals one of the input payloads verbatim — never an
	// interleaved smear of entries from different pushes.
	mgr, prefix := newReplaceProjectsManager(t)
	const n = 8
	payloads := make([][]ReplaceProjectsInput, n)
	for i := 0; i < n; i++ {
		idA := fmt.Sprintf("payload%d-a", i)
		idB := fmt.Sprintf("payload%d-b", i)
		payloads[i] = []ReplaceProjectsInput{
			{ID: idA, Cwd: mkPermittedDir(t, prefix, idA)},
			{ID: idB, Cwd: mkPermittedDir(t, prefix, idB)},
		}
	}
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		i := i
		go func() {
			defer wg.Done()
			if err := mgr.ReplaceProjects(payloads[i]); err != nil {
				t.Errorf("payload %d: %v", i, err)
			}
		}()
	}
	wg.Wait()

	got := mgr.Projects()
	// Final state must contain exactly the two ids from one of the
	// payloads, not a mix of ids from multiple.
	if len(got) != 2 {
		t.Fatalf("want exactly 2 projects (one payload's worth), got %d: %+v", len(got), got)
	}
	gotIDs := []string{got[0].ID, got[1].ID}
	matched := false
	for i, p := range payloads {
		want := []string{p[0].ID, p[1].ID}
		if (gotIDs[0] == want[0] && gotIDs[1] == want[1]) ||
			(gotIDs[0] == want[1] && gotIDs[1] == want[0]) {
			matched = true
			t.Logf("final state matches payload %d", i)
			break
		}
	}
	if !matched {
		t.Fatalf("final state %v matches no input payload — interleaved replace?", gotIDs)
	}
}

func TestReplaceProjects_seedsDefaultShell(t *testing.T) {
	// an earlier release: pushed projects must inherit the daemon's resolved
	// default shell so shell-pane spawns don't fail at adapter
	// BuildSpawn with "project shell not configured". The wire shape
	// (PutProjectsEntry) carries no Shell field; ReplaceProjects must
	// fill it in from m.defaultShell.
	mgr, prefix := newReplaceProjectsManager(t)
	cwd := mkPermittedDir(t, prefix, "alpha")
	if err := mgr.ReplaceProjects([]ReplaceProjectsInput{{ID: "alpha", Cwd: cwd}}); err != nil {
		t.Fatalf("ReplaceProjects: %v", err)
	}
	mgr.mu.RLock()
	p, ok := mgr.projects["alpha"]
	mgr.mu.RUnlock()
	if !ok {
		t.Fatal("project not registered")
	}
	if len(p.Shell) == 0 {
		t.Fatalf("Shell empty: shell-pane spawn would fail")
	}
	if p.Shell[0] != "/bin/sh" {
		t.Errorf("Shell[0] = %q, want /bin/sh (the test manager's DefaultShell)", p.Shell[0])
	}
}
