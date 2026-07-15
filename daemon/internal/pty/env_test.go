package pty

import (
	"os"
	"testing"
)

// TestPaneBaseEnv_dropsSecrets guards against a regression where the
// daemon's environment leaks wholesale into pane children. In
// particular DAEMON_TOKEN must never reach a pane — that was the
// root cause of the "any compromised pane = full station bearer"
// vulnerability the env allowlist fixes.
func TestPaneBaseEnv_dropsSecrets(t *testing.T) {
	t.Setenv("DAEMON_TOKEN", "super-secret")
	t.Setenv("ANTHROPIC_API_KEY", "also-secret")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "nope")
	t.Setenv("PATH", "/usr/bin:/bin")
	t.Setenv("HOME", "/tmp/pane-test-home")
	t.Setenv("LC_TIME", "C")

	env := paneBaseEnv()
	m := map[string]string{}
	for _, kv := range env {
		for i := 0; i < len(kv); i++ {
			if kv[i] == '=' {
				m[kv[:i]] = kv[i+1:]
				break
			}
		}
	}

	// Forbidden: must not appear.
	for _, k := range []string{
		"DAEMON_TOKEN",
		"ANTHROPIC_API_KEY",
		"AWS_SECRET_ACCESS_KEY",
	} {
		if _, ok := m[k]; ok {
			t.Errorf("paneBaseEnv leaked forbidden env %q", k)
		}
	}

	// Required: must flow through.
	for _, k := range []string{"PATH", "HOME"} {
		if _, ok := m[k]; !ok {
			t.Errorf("paneBaseEnv dropped required env %q", k)
		}
	}

	// LC_* prefix family.
	if _, ok := m["LC_TIME"]; !ok {
		t.Errorf("paneBaseEnv dropped LC_TIME (should flow through via LC_ prefix)")
	}
}

// TestPaneBaseEnv_forwardsClaudeCodePrefix guards the allowlist entry
// that lets experimental CLAUDE_CODE_* flags reach Claude panes. Without
// this, setting CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 in the launchd
// plist is silently stripped at spawn and the feature never turns on.
func TestPaneBaseEnv_forwardsClaudeCodePrefix(t *testing.T) {
	t.Setenv("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "1")
	t.Setenv("CLAUDE_CODE_SOMETHING_ELSE", "42")
	// Adjacent families that look like Claude env but must NOT be
	// forwarded — they're either auth material (ANTHROPIC_*) or
	// speculative non-CODE Claude vars that haven't been vetted.
	t.Setenv("ANTHROPIC_API_KEY", "secret")
	t.Setenv("CLAUDE_API_KEY", "also-secret")

	env := paneBaseEnv()
	m := map[string]string{}
	for _, kv := range env {
		for i := 0; i < len(kv); i++ {
			if kv[i] == '=' {
				m[kv[:i]] = kv[i+1:]
				break
			}
		}
	}

	for _, k := range []string{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "CLAUDE_CODE_SOMETHING_ELSE"} {
		if v, ok := m[k]; !ok {
			t.Errorf("paneBaseEnv dropped %q (should flow through via CLAUDE_CODE_ prefix)", k)
		} else if v == "" {
			t.Errorf("paneBaseEnv forwarded %q but with empty value", k)
		}
	}
	for _, k := range []string{"ANTHROPIC_API_KEY", "CLAUDE_API_KEY"} {
		if _, ok := m[k]; ok {
			t.Errorf("paneBaseEnv leaked %q (must stay out of panes even though it looks Claude-shaped)", k)
		}
	}
}

func TestPaneBaseEnv_forwardsReckDaemonURL(t *testing.T) {
	t.Setenv("RECK_DAEMON_URL", "http://127.0.0.1:7315")
	env := paneBaseEnv()
	found := false
	for _, kv := range env {
		if kv == "RECK_DAEMON_URL=http://127.0.0.1:7315" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("RECK_DAEMON_URL should be in pane base env; got %v", env)
	}
}

func TestPaneBaseEnv_emptyWhenDaemonUnset(t *testing.T) {
	// Sanity check: empty daemon env → empty allowlisted env.
	// Uses os.Environ() so we can't make it truly empty, but we can
	// confirm no unknown keys slip through.
	known := paneBaseEnv()
	for _, kv := range known {
		name := ""
		for i := 0; i < len(kv); i++ {
			if kv[i] == '=' {
				name = kv[:i]
				break
			}
		}
		if _, listed := envAllowlist[name]; listed {
			continue
		}
		// LC_* prefix?
		isPrefixed := false
		for _, p := range envAllowlistPrefixes {
			if len(name) >= len(p) && name[:len(p)] == p {
				isPrefixed = true
				break
			}
		}
		if !isPrefixed {
			t.Errorf("unexpected env key %q in paneBaseEnv (env now has: %v)", name, os.Environ())
		}
	}
}
