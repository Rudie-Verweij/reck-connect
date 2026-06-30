package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadTokenFromFile_missing(t *testing.T) {
	dir := t.TempDir()
	tok, err := LoadTokenFromFile(filepath.Join(dir, "nope"))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if tok != "" {
		t.Fatalf("expected empty token, got %q", tok)
	}
}

func TestLoadTokenFromFile_happyPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "token")
	if err := os.WriteFile(path, []byte("  abcdef0123456789\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tok, err := LoadTokenFromFile(path)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if tok != "abcdef0123456789" {
		t.Fatalf("tok = %q, want abcdef0123456789", tok)
	}
}

func TestLoadTokenFromFile_rejectsPermissive(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "token")
	if err := os.WriteFile(path, []byte("sekrit"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := LoadTokenFromFile(path)
	if err == nil {
		t.Fatal("expected error for 0644 token file, got nil")
	}
}

func TestLoadTokenFromFile_rejectsDirectory(t *testing.T) {
	dir := t.TempDir()
	_, err := LoadTokenFromFile(dir)
	if err == nil {
		t.Fatal("expected error for directory path, got nil")
	}
}

func TestResolveToken_filePreferredOverEnv(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "token")
	if err := os.WriteFile(path, []byte("file-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DAEMON_TOKEN", "env-token")

	tok, src, err := ResolveToken(path)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if tok != "file-token" {
		t.Fatalf("tok = %q, want file-token", tok)
	}
	if src != "file" {
		t.Fatalf("src = %q, want file", src)
	}
}

func TestResolveToken_envFallback(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DAEMON_TOKEN", "env-token")

	tok, src, err := ResolveToken(filepath.Join(dir, "absent"))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if tok != "env-token" {
		t.Fatalf("tok = %q, want env-token", tok)
	}
	if src != "env" {
		t.Fatalf("src = %q, want env", src)
	}
}

func TestResolveToken_neither(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DAEMON_TOKEN", "")

	tok, src, err := ResolveToken(filepath.Join(dir, "absent"))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if tok != "" {
		t.Fatalf("tok = %q, want empty", tok)
	}
	if src != "" {
		t.Fatalf("src = %q, want empty", src)
	}
}

func TestResolveToken_fileErrorPropagates(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "token")
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DAEMON_TOKEN", "env-token")
	// The file exists but has bad perms; we should NOT silently fall
	// back to the env var. An operator staring at a permissive file
	// deserves a boot-time error, not a quiet downgrade.
	_, _, err := ResolveToken(path)
	if err == nil {
		t.Fatal("expected error for 0644 file, got nil")
	}
}

func TestResolveTokenChain_firstHitWins(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, "first")
	second := filepath.Join(dir, "second")
	if err := os.WriteFile(first, []byte("first-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte("second-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	tok, src, err := ResolveTokenChain([]string{first, second})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if tok != "first-token" {
		t.Fatalf("tok = %q, want first-token", tok)
	}
	if src != "file:"+first {
		t.Fatalf("src = %q, want file:%s", src, first)
	}
}

func TestResolveTokenChain_skipMissingFallthroughToLater(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "absent")
	hit := filepath.Join(dir, "hit")
	if err := os.WriteFile(hit, []byte("legacy-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	tok, src, err := ResolveTokenChain([]string{missing, hit})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if tok != "legacy-token" {
		t.Fatalf("tok = %q, want legacy-token", tok)
	}
	if src != "file:"+hit {
		t.Fatalf("src = %q, want file:%s", src, hit)
	}
}

func TestResolveTokenChain_envFallback(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DAEMON_TOKEN", "env-tok")
	tok, src, err := ResolveTokenChain([]string{
		filepath.Join(dir, "a"),
		filepath.Join(dir, "b"),
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if tok != "env-tok" {
		t.Fatalf("tok = %q, want env-tok", tok)
	}
	if src != "env" {
		t.Fatalf("src = %q, want env", src)
	}
}

func TestResolveTokenChain_permErrorPropagates(t *testing.T) {
	dir := t.TempDir()
	bad := filepath.Join(dir, "bad")
	if err := os.WriteFile(bad, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Even though there's a fallback after, a permissive file MUST
	// fail loud — silently advancing to the next candidate would mask
	// the misconfig.
	_, _, err := ResolveTokenChain([]string{bad, filepath.Join(dir, "next")})
	if err == nil {
		t.Fatal("expected error for 0644 file, got nil")
	}
}

func TestDefaultTokenCandidates_orderingAndOverride(t *testing.T) {
	t.Setenv("RECK_TOKEN_FILE", "/explicit/override")
	t.Setenv("HOME", "/Users/fake")
	cands := DefaultTokenCandidates()
	if len(cands) < 2 {
		t.Fatalf("expected at least 2 candidates, got %v", cands)
	}
	if cands[0] != "/explicit/override" {
		t.Fatalf("first = %q, want /explicit/override", cands[0])
	}
	// Last must always be the legacy LaunchDaemon path (back-compat).
	if cands[len(cands)-1] != DefaultTokenFile {
		t.Fatalf("last = %q, want %s", cands[len(cands)-1], DefaultTokenFile)
	}
}

func TestPreferEnvToken(t *testing.T) {
	// The satellite mints a fresh DAEMON_TOKEN per local spawn
	// (satellite/main/daemon-spawn.ts) and the renderer authenticates
	// with exactly that value. A stale ~/.config/reck/token would
	// otherwise clobber it via the file chain and 401 every renderer
	// request. Station mode keeps file-first (plist->file migration
	// rationale in ResolveToken).
	cases := []struct {
		name string
		mode string
		env  string
		want bool
	}{
		{"local with env token", "local", "abc123", true},
		{"local with whitespace-only env", "local", "   ", false},
		{"local without env", "local", "", false},
		{"station with env token", "station", "abc123", false},
		{"station without env", "station", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := PreferEnvToken(tc.mode, tc.env); got != tc.want {
				t.Fatalf("PreferEnvToken(%q, %q) = %v, want %v", tc.mode, tc.env, got, tc.want)
			}
		})
	}
}
