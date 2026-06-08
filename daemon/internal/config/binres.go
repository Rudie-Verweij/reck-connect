package config

import (
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
)

// ErrBareBinaryName is returned by ResolveBinary when the candidate is a
// bare command name (no path separator). Bare names would resolve via
// $PATH at exec time, which exposes the daemon to PATH-shadow attacks:
// a writable earlier-PATH directory could drop in a malicious binary
// and the daemon would execute it. We force callers to pass an absolute
// or relative path that we can resolve deterministically once at load.
var ErrBareBinaryName = errors.New("bare binary name rejected; use an absolute path")

// ResolveBinary validates and canonicalises a single binary path used
// by the daemon (claude, codex, project shell[0], etc.). The returned
// value is always absolute.
//
// Rules:
//
//   - Empty string → error; callers must provide a candidate.
//   - No path separator in the candidate → ErrBareBinaryName. This is
//     the anti-PATH-shadow rule from an earlier release: a bare name like "codex"
//     would be resolved via $PATH at exec time by os/exec, and a
//     poisoned PATH on the daemon host could swap in a malicious
//     binary. Callers should instead resolve the bare name themselves
//     (e.g. via `which`) before handing the absolute path to the
//     daemon, or ship an absolute path in config.
//   - Path separator present but not absolute → resolved via
//     exec.LookPath (which handles ./relative, ~/home, etc.) and
//     returns the absolute form.
//   - Absolute path → checked via exec.LookPath so a bad permission /
//     nonexistent file fails at load time with a clear message,
//     rather than at spawn time with a confusing "fork/exec" error.
//
// `label` is included in error messages so the operator can tell which
// config slot (e.g. "--claude", "project p1 shell[0]", "default $SHELL")
// failed.
func ResolveBinary(label, candidate string) (string, error) {
	if candidate == "" {
		return "", fmt.Errorf("%s: empty binary path", label)
	}
	if !strings.ContainsRune(candidate, '/') {
		return "", fmt.Errorf("%s: %q: %w", label, candidate, ErrBareBinaryName)
	}
	resolved, err := exec.LookPath(candidate)
	if err != nil {
		return "", fmt.Errorf("%s: resolve %q: %w", label, candidate, err)
	}
	// exec.LookPath returns a path with a slash as-is (e.g. "./myprog"
	// stays relative). Canonicalise so every stored path is absolute —
	// that's the whole point: the argv we spawn must not depend on
	// subsequent cwd changes to resolve.
	if !filepath.IsAbs(resolved) {
		abs, err := filepath.Abs(resolved)
		if err != nil {
			return "", fmt.Errorf("%s: abs %q: %w", label, resolved, err)
		}
		resolved = abs
	}
	return resolved, nil
}
