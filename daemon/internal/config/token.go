// Token loading for the daemon's bearer.
//
// The token historically lived in the launchd plist's EnvironmentVariables,
// but the plist itself is world-readable (mode 0644), which leaks the bearer
// to every local user on the station. See GitHub an earlier release C1.
//
// Preferred source: a reck-connect:staff-owned file at /etc/reck-stationd/token, mode 0600.
// Fallback: the DAEMON_TOKEN environment variable, which the daemon still
// honours for dev, tests, and in-process migration from the old layout.
//
// LoadToken reads the file (if present and readable), validates permissions,
// and returns the trimmed value. A file that exists but is too permissive is
// refused on principle — silently widening back to env would mask the
// configuration mistake.

package config

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// DefaultTokenFile is the legacy canonical location of the
// daemon-readable token file. Used as the back-compat tail of the
// chain returned by DefaultTokenCandidates so existing LaunchDaemon
// installs keep working through the LaunchAgent migration window.
// Declared as var so tests can redirect it.
var DefaultTokenFile = "/etc/reck-stationd/token"

// DefaultTokenCandidates returns the Phase 1  token-file
// lookup order:
//
//  1. $RECK_TOKEN_FILE if set (test / dev override).
//  2. $HOME/.config/reck/token — canonical LaunchAgent location.
//  3. DefaultTokenFile (/etc/reck-stationd/token) — legacy LaunchDaemon
//     location. Lets a station mid-migration boot with the
//     pre-migration file in place; install-station.sh copies the
//     value into ~/.config/reck/token before swapping the launch
//     scope.
//
// $HOME is read at call-time, not init-time, so tests / `sudo -E`
// edge cases pick up the current value.
func DefaultTokenCandidates() []string {
	var out []string
	if p := strings.TrimSpace(os.Getenv("RECK_TOKEN_FILE")); p != "" {
		out = append(out, p)
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		out = append(out, filepath.Join(home, ".config", "reck", "token"))
	}
	out = append(out, DefaultTokenFile)
	return out
}

// maxTokenFileSize caps the amount of data we'll read from the file. A real
// token is 64 hex chars (32 bytes from openssl rand); 4 KiB is a generous
// ceiling that prevents a pathological file from being slurped wholesale.
const maxTokenFileSize = 4 << 10

// LoadTokenFromFile reads the token file, strips surrounding whitespace, and
// returns the contents. Returns ("", nil) when the file does not exist — the
// caller decides whether to fall back to the env var or fail outright.
//
// Permission enforcement: the file must not be group- or world-readable.
// The daemon runs as `reck-connect` per the plist's UserName, so the
// install script writes the file as `reck-connect:staff 0600` — the
// daemon can read it, no other local user can. The runtime check exists
// to catch deployments where someone hand-edited the perms back to 0644
// — better to refuse and surface the misconfig than to start with a
// world-readable secret.
func LoadTokenFromFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", fmt.Errorf("stat token file %s: %w", path, err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("token path %s is a directory", path)
	}
	// Permission check: reject anything that's group- or world-readable.
	// (We don't re-check ownership — that's the installer's job, and the
	// effective-user model on macOS is complicated enough that open()
	// returning a readable fd is the real gate.)
	if perm := info.Mode().Perm(); perm&(fs.ModePerm&0o077) != 0 {
		return "", fmt.Errorf("token file %s has permissive mode %o (want 0600)", path, perm)
	}
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open token file %s: %w", path, err)
	}
	defer f.Close()
	buf := make([]byte, maxTokenFileSize+1)
	n, err := f.Read(buf)
	if err != nil && n == 0 {
		return "", fmt.Errorf("read token file %s: %w", path, err)
	}
	if n > maxTokenFileSize {
		return "", fmt.Errorf("token file %s is larger than %d bytes", path, maxTokenFileSize)
	}
	return strings.TrimSpace(string(buf[:n])), nil
}

// ResolveToken returns the daemon's bearer token, preferring the file at
// `path` over the `DAEMON_TOKEN` env var. The returned source label is
// "file", "env", or "" — used by the caller for structured logging so ops
// can confirm which path loaded at startup without leaking the token value.
//
// Behaviour:
//   - If the file exists and loads cleanly, its contents win. A stale env var
//     is ignored in that case (so migrating from plist → file Just Works
//     after the launchd reload even if the daemon inherits the old env from
//     a cached plist).
//   - If the file is absent, fall back to the env var.
//   - If the file exists but load fails (bad perms, read error), propagate
//     the error rather than silently falling back — the operator needs to
//     see the misconfiguration.
func ResolveToken(path string) (token, source string, err error) {
	tok, err := LoadTokenFromFile(path)
	if err != nil {
		return "", "", err
	}
	if tok != "" {
		return tok, "file", nil
	}
	if env := strings.TrimSpace(os.Getenv("DAEMON_TOKEN")); env != "" {
		return env, "env", nil
	}
	return "", "", nil
}

// ResolveTokenChain walks `paths` in order and returns the first
// non-empty file-loaded token. If no file produced a value, falls
// back to $DAEMON_TOKEN. Returns ("", "", nil) iff nothing found.
//
// File-load errors propagate immediately rather than skipping the
// candidate — silently bypassing a permissive file would mask the
// misconfiguration the operator needs to see. This matches the
// single-path ResolveToken behaviour.
//
// The source label embeds the file path that won (e.g.
// "file:/Users/x/.config/reck/token") so structured logs at startup
// disambiguate which candidate produced the bearer.
func ResolveTokenChain(paths []string) (token, source string, err error) {
	for _, p := range paths {
		tok, e := LoadTokenFromFile(p)
		if e != nil {
			return "", "", e
		}
		if tok != "" {
			return tok, "file:" + p, nil
		}
	}
	if env := strings.TrimSpace(os.Getenv("DAEMON_TOKEN")); env != "" {
		return env, "env", nil
	}
	return "", "", nil
}
