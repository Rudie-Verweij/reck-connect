package pty

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// gitWorktreePaths returns the absolute paths of every git worktree registered
// under projectRoot (including the main working tree), as reported by
// `git worktree list --porcelain`, plus an ok flag reporting whether git ran
// successfully. It is the enumeration half of the #56 worktree-restore fix: the
// caller feeds the paths to sessions.ResolveTranscriptCwd to recover the
// directory a Claude session actually ran in.
//
// ok distinguishes "git ran and this is the full worktree set" (ok=true, even
// if empty) from "git couldn't run" — not installed, not a repo, or timed out
// (ok=false). Callers use it to gate the destructive gone-worktree migration:
// a transcript with no matching worktree may only be treated as *permanently*
// orphaned when git actually confirmed the worktree set, never on a transient
// git failure (which would prematurely relocate a still-live worktree session).
func gitWorktreePaths(projectRoot string) ([]string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", "-C", projectRoot, "worktree", "list", "--porcelain")
	out, err := cmd.Output()
	if err != nil {
		return nil, false
	}

	var paths []string
	for _, line := range strings.Split(string(out), "\n") {
		// Porcelain blocks start with `worktree <abs-path>`; other keys
		// (HEAD, branch, bare, detached, locked, prunable) we ignore.
		if p, ok := strings.CutPrefix(line, "worktree "); ok {
			if p = strings.TrimSpace(p); p != "" {
				paths = append(paths, p)
			}
		}
	}
	return paths, true
}

// migrateTranscript relocates a Claude transcript from src to dest so that
// `claude --resume` can find it under a new cwd's encoded folder (issue #56).
// It is used when a session's git worktree was permanently removed: the
// transcript is moved into the project-root folder so the session resumes
// there instead of forking a fresh one.
//
// A rename (atomic within ~/.claude/projects, the common case) is tried first,
// falling back to copy-then-remove across devices. An already-present dest is
// left untouched (idempotent re-migration). The transcript is only ever moved,
// never truncated, so the conversation cannot be lost even if a later step fails.
func migrateTranscript(src, dest string) error {
	if src == dest {
		return nil
	}
	if _, err := os.Stat(dest); err == nil {
		return nil // already migrated — don't clobber
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	if err := os.Rename(src, dest); err == nil {
		return nil
	}
	// Cross-device or other rename failure → copy, then remove the original.
	if err := copyFile(src, dest); err != nil {
		return err
	}
	return os.Remove(src)
}

func copyFile(src, dest string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(dest)
		return err
	}
	return out.Close()
}
