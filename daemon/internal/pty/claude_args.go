package pty

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ValidateClaudeExtraArgs enforces a narrow allowlist on extra argv passed
// to a Claude pane. The goal is to prevent accidental daemon-integrity
// breaks (path escape, log exfiltration) — not to second-guess user intent.
//
// Rejects:
//   - --cwd / --cwd=<v> — would bypass the project sandbox.
//   - --resume / --session-id / --name — reserved for the daemon's
//     session-index bookkeeping. A user-supplied duplicate would collide
//     with the values the daemon injects (see internal/agent/claude.go),
//     leaving argv ambiguous and the session index out of sync.
//   - --append-system-prompt — reserved because the daemon injects its
//     own (baseline + project preamble); a user-supplied duplicate would
//     produce two `--append-system-prompt` tokens in argv (last-wins on
//     the CLI side, but log redaction only masks the first occurrence,
//     which is confusing to debug). Use the projects.toml `preamble`
//     field to add prompt content.
//   - --add-dir with paths that resolve outside projectCwd. Symlinks are
//     followed before the containment check so a symlink inside the project
//     pointing at /etc (or any ancestor of projectCwd) is rejected.
//   - --debug-file with a path outside os.TempDir(). Symlinks are followed;
//     a not-yet-created file is allowed as long as its parent (after
//     symlink resolution) lives inside TMPDIR.
//
// Everything else — including --dangerously-skip-permissions — is allowed.
func ValidateClaudeExtraArgs(args []string, projectCwd string) error {
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--cwd" || strings.HasPrefix(a, "--cwd="):
			return errors.New("--cwd is not allowed via extra args; set the project cwd when registering the project")

		case a == "--resume" || strings.HasPrefix(a, "--resume="),
			a == "--session-id" || strings.HasPrefix(a, "--session-id="),
			a == "--name" || strings.HasPrefix(a, "--name="):
			return fmt.Errorf("%s is reserved for daemon session management and cannot be set via extra args", strings.SplitN(a, "=", 2)[0])

		case a == "--append-system-prompt" || strings.HasPrefix(a, "--append-system-prompt="):
			return fmt.Errorf("%s is reserved: the daemon injects its own --append-system-prompt; set the projects.toml `preamble` field to supply prompt content", strings.SplitN(a, "=", 2)[0])

		case a == "--add-dir":
			// Variadic: consume following non-flag args until the next flag or end.
			j := i + 1
			for ; j < len(args); j++ {
				if strings.HasPrefix(args[j], "-") {
					break
				}
				if !pathUnder(projectCwd, args[j]) {
					return fmt.Errorf("--add-dir path %q is outside project cwd %q", args[j], projectCwd)
				}
			}
			if j == i+1 {
				return errors.New("--add-dir requires at least one path")
			}
			i = j - 1

		case strings.HasPrefix(a, "--add-dir="):
			p := strings.TrimPrefix(a, "--add-dir=")
			if p == "" {
				return errors.New("--add-dir= requires a path")
			}
			if !pathUnder(projectCwd, p) {
				return fmt.Errorf("--add-dir path %q is outside project cwd %q", p, projectCwd)
			}

		case a == "--debug-file":
			if i+1 >= len(args) {
				return errors.New("--debug-file requires a path")
			}
			p := args[i+1]
			if !pathUnder(os.TempDir(), p) {
				return fmt.Errorf("--debug-file path %q is outside TMPDIR %q", p, os.TempDir())
			}
			i++

		case strings.HasPrefix(a, "--debug-file="):
			p := strings.TrimPrefix(a, "--debug-file=")
			if p == "" {
				return errors.New("--debug-file= requires a path")
			}
			if !pathUnder(os.TempDir(), p) {
				return fmt.Errorf("--debug-file path %q is outside TMPDIR %q", p, os.TempDir())
			}
		}
	}
	return nil
}

// pathUnder reports whether child resolves within parent. Relative children
// are resolved against parent before comparison. Symlinks are followed on
// both sides so a symlink inside the project pointing at /etc (or anywhere
// outside parent) is rejected.
//
// The child need not exist: --debug-file legitimately names a file that
// claude will create on first write. In that case we resolve the deepest
// existing ancestor and rejoin the trailing components — this still catches
// a symlinked ancestor that escapes parent.
func pathUnder(parent, child string) bool {
	absParent, err := filepath.Abs(parent)
	if err != nil {
		return false
	}
	absParent = filepath.Clean(absParent)
	var absChild string
	if filepath.IsAbs(child) {
		absChild = filepath.Clean(child)
	} else {
		absChild = filepath.Clean(filepath.Join(absParent, child))
	}

	// Resolve symlinks on parent first. On macOS os.TempDir() is itself a
	// symlink (/var → /private/var) so without this the canonical child
	// would never look like it lives under the lexical parent.
	resolvedParent, err := filepath.EvalSymlinks(absParent)
	if err != nil {
		// Parent must exist — projectCwd and os.TempDir() always do; if not,
		// we have no safe basis for containment.
		return false
	}
	resolvedParent = filepath.Clean(resolvedParent)

	// Resolve the child. If it doesn't exist yet, walk back to the deepest
	// existing ancestor, resolve that, and rejoin the unresolved tail. This
	// supports --debug-file targeting a not-yet-created log while still
	// catching a symlinked intermediate directory.
	resolvedChild, err := evalSymlinksAllowMissing(absChild)
	if err != nil {
		return false
	}

	rel, err := filepath.Rel(resolvedParent, resolvedChild)
	if err != nil {
		return false
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	return true
}

// evalSymlinksAllowMissing resolves symlinks in p. If p doesn't exist, it
// walks up to the deepest existing ancestor, resolves that, and rejoins the
// unresolved tail. A dangling symlink (link exists, target does not) is
// followed: the resolution continues from the link's target, not from the
// link's parent — otherwise a symlink in TMPDIR pointing at a not-yet-
// existing /etc/foo would be accepted as "inside TMPDIR".
//
// Errors only on filesystem failures other than NotExist (and on symlink
// loops, which EvalSymlinks reports as ELOOP).
func evalSymlinksAllowMissing(p string) (string, error) {
	resolved, err := filepath.EvalSymlinks(p)
	if err == nil {
		return filepath.Clean(resolved), nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}

	// If p itself is a symlink (the *target* is what's missing), resolve
	// the link manually so the missing-target walk-back happens from the
	// target's location, not the link's location.
	if info, lerr := os.Lstat(p); lerr == nil && info.Mode()&os.ModeSymlink != 0 {
		target, terr := os.Readlink(p)
		if terr != nil {
			return "", terr
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(p), target)
		}
		return evalSymlinksAllowMissing(filepath.Clean(target))
	}

	// Walk up until we find an existing ancestor.
	dir, base := filepath.Split(p)
	dir = filepath.Clean(dir)
	tail := []string{base}
	for {
		if dir == "" || dir == "." {
			return filepath.Clean(p), nil
		}
		resolved, err = filepath.EvalSymlinks(dir)
		if err == nil {
			parts := append([]string{filepath.Clean(resolved)}, tail...)
			return filepath.Clean(filepath.Join(parts...)), nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent, b := filepath.Split(dir)
		parent = filepath.Clean(parent)
		if parent == dir {
			// Reached root with no resolvable ancestor — should be unreachable
			// on a sane filesystem (EvalSymlinks("/") always succeeds).
			return filepath.Clean(p), nil
		}
		tail = append([]string{b}, tail...)
		dir = parent
	}
}
