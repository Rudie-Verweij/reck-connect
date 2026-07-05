package pty

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func gitRun(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	// Keep commits self-contained so the test needs no global git identity.
	cmd.Env = append(cmd.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func TestGitWorktreePaths(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	root := t.TempDir()
	gitRun(t, root, "init", "-q")
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("hi\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	gitRun(t, root, "add", ".")
	gitRun(t, root, "commit", "-q", "-m", "init")

	wt := filepath.Join(root, ".claude-worktrees", "feat-x")
	gitRun(t, root, "worktree", "add", "-q", "-b", "feat-x", wt)

	got, ok := gitWorktreePaths(root)
	if !ok {
		t.Fatalf("gitWorktreePaths(%q) reported git failure on a real repo", root)
	}

	real := func(p string) string {
		r, err := filepath.EvalSymlinks(p)
		if err != nil {
			return p
		}
		return r
	}
	found := false
	for _, p := range got {
		if real(p) == real(wt) {
			found = true
		}
	}
	if !found {
		t.Fatalf("gitWorktreePaths(%q) = %v, want it to include the worktree %q", root, got, wt)
	}
}

func TestGitWorktreePaths_notARepo(t *testing.T) {
	got, ok := gitWorktreePaths(t.TempDir())
	if got != nil || ok {
		t.Fatalf("gitWorktreePaths on a non-repo = (%v, %v), want (nil, false)", got, ok)
	}
}
