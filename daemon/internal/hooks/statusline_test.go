package hooks

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func readStatusLine(t *testing.T, home string) (map[string]any, bool) {
	t.Helper()
	p := PathsFor(home)
	data, err := os.ReadFile(p.SettingsPath)
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("parse settings: %v", err)
	}
	sl, ok := m["statusLine"].(map[string]any)
	return sl, ok
}

func TestStatusLine_freshInstall_setsForwarderNoPrior(t *testing.T) {
	home := t.TempDir()
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	p := PathsFor(home)

	// Statusline shim is present and executable.
	info, err := os.Stat(p.StatusLineShimPath)
	if err != nil {
		t.Fatalf("statusline shim missing: %v", err)
	}
	if info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("statusline shim not executable: %o", info.Mode().Perm())
	}

	sl, ok := readStatusLine(t, home)
	if !ok {
		t.Fatal("statusLine not set")
	}
	cmd, _ := sl["command"].(string)
	if !strings.Contains(cmd, p.StatusLineShimPath) || !strings.HasSuffix(cmd, MarkerV1) {
		t.Fatalf("statusLine command not the reck forwarder: %q", cmd)
	}
	// No prior ⇒ the embedded prior arg is empty: `... '' # marker`.
	if !strings.Contains(cmd, "'' # "+MarkerV1) {
		t.Fatalf("expected empty prior arg, got: %q", cmd)
	}
}

func TestStatusLine_preservesAndChainsPrior(t *testing.T) {
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.ClaudeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	userCmd := "ccusage statusline --theme dark"
	prior := map[string]any{
		"statusLine": map[string]any{"type": "command", "command": userCmd, "padding": float64(0)},
	}
	data, _ := json.MarshalIndent(prior, "", "  ")
	if err := os.WriteFile(p.SettingsPath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}

	sl, ok := readStatusLine(t, home)
	if !ok {
		t.Fatal("statusLine missing after install")
	}
	cmd, _ := sl["command"].(string)
	// The prior command must be embedded (single-quoted) so the shim can
	// chain to it.
	if !strings.Contains(cmd, "'"+userCmd+"'") {
		t.Fatalf("prior command not embedded for chaining: %q", cmd)
	}
	// Sidecar recorded the prior for restoration.
	pr, err := loadStatusLinePrior(p.StatusLinePriorPath)
	if err != nil || pr == nil || !pr.Had {
		t.Fatalf("prior sidecar not written: %v %+v", err, pr)
	}
}

func TestStatusLine_idempotent_doesNotWrapItself(t *testing.T) {
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.ClaudeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	userCmd := "my-statusline.sh"
	prior := map[string]any{
		"statusLine": map[string]any{"type": "command", "command": userCmd},
	}
	data, _ := json.MarshalIndent(prior, "", "  ")
	_ = os.WriteFile(p.SettingsPath, data, 0o600)

	for i := 0; i < 3; i++ {
		if err := EnsureInstalled(home); err != nil {
			t.Fatalf("install %d: %v", i, err)
		}
	}
	sl, _ := readStatusLine(t, home)
	cmd, _ := sl["command"].(string)
	// The user command appears exactly once — we never wrapped our own
	// wrapper (which would embed the marker inside the prior arg).
	if strings.Count(cmd, userCmd) != 1 {
		t.Fatalf("prior command duplicated across installs: %q", cmd)
	}
	if strings.Count(cmd, MarkerV1) != 1 {
		t.Fatalf("marker appears %d times, want 1: %q", strings.Count(cmd, MarkerV1), cmd)
	}
}

func TestStatusLine_uninstallRestoresPrior(t *testing.T) {
	home := t.TempDir()
	p := PathsFor(home)
	_ = os.MkdirAll(p.ClaudeDir, 0o755)
	userCmd := "ccusage statusline"
	prior := map[string]any{
		"statusLine": map[string]any{"type": "command", "command": userCmd},
	}
	data, _ := json.MarshalIndent(prior, "", "  ")
	_ = os.WriteFile(p.SettingsPath, data, 0o600)

	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	if err := Uninstall(home); err != nil {
		t.Fatal(err)
	}
	sl, ok := readStatusLine(t, home)
	if !ok {
		t.Fatal("statusLine removed instead of restored")
	}
	if cmd, _ := sl["command"].(string); cmd != userCmd {
		t.Fatalf("prior not restored: got %q want %q", cmd, userCmd)
	}
	if _, err := os.Stat(p.StatusLinePriorPath); !os.IsNotExist(err) {
		t.Fatalf("prior sidecar not cleared on uninstall")
	}
}

func TestStatusLine_uninstallRemovesWhenNoPrior(t *testing.T) {
	home := t.TempDir()
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	if err := Uninstall(home); err != nil {
		t.Fatal(err)
	}
	if sl, ok := readStatusLine(t, home); ok {
		t.Fatalf("statusLine should be removed when there was no prior, got %+v", sl)
	}
}
