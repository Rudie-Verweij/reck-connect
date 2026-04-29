package hooks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// loadHooks reads settings.json and returns the .hooks sub-map (nil if absent).
func loadHooks(t *testing.T, home string) map[string]any {
	t.Helper()
	p := PathsFor(home)
	data, err := os.ReadFile(p.SettingsPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("parse: %v\n%s", err, data)
	}
	h, _ := m["hooks"].(map[string]any)
	return h
}

// countReckEntries walks hooks[event] and returns how many inner entries
// carry MarkerV1.
func countReckEntries(hooks map[string]any, event string) int {
	n := 0
	list, _ := hooks[event].([]any)
	for _, item := range list {
		grp, _ := item.(map[string]any)
		inner, _ := grp["hooks"].([]any)
		for _, h := range inner {
			hm, _ := h.(map[string]any)
			cmd, _ := hm["command"].(string)
			if strings.Contains(cmd, MarkerV1) {
				n++
			}
		}
	}
	return n
}

func TestEnsureInstalled_freshHome(t *testing.T) {
	home := t.TempDir()
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	p := PathsFor(home)

	// Shim is present and executable.
	info, err := os.Stat(p.ShimPath)
	if err != nil {
		t.Fatalf("shim missing: %v", err)
	}
	if info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("shim not executable: %o", info.Mode().Perm())
	}

	// Every binding has exactly one Reck entry.
	hks := loadHooks(t, home)
	if hks == nil {
		t.Fatal("hooks section missing")
	}
	for _, b := range bindings {
		if n := countReckEntries(hks, b.claudeEvent); n != 1 {
			t.Errorf("%s: reck entries = %d, want 1", b.claudeEvent, n)
		}
	}
}

func TestEnsureInstalled_idempotent(t *testing.T) {
	home := t.TempDir()
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	hks := loadHooks(t, home)
	// Still exactly one Reck entry per binding — no duplication.
	for _, b := range bindings {
		if n := countReckEntries(hks, b.claudeEvent); n != 1 {
			t.Errorf("%s: reck entries = %d after 3 installs, want 1", b.claudeEvent, n)
		}
	}
}

func TestEnsureInstalled_preservesUserHooks(t *testing.T) {
	home := t.TempDir()
	p := PathsFor(home)
	_ = os.MkdirAll(p.ClaudeDir, 0o755)
	// Pre-seed settings.json with a user-owned Stop hook (no marker).
	prior := map[string]any{
		"otherKey": "keep me",
		"hooks": map[string]any{
			"Stop": []any{
				map[string]any{
					"matcher": "",
					"hooks": []any{
						map[string]any{
							"type":    "command",
							"command": "bash /opt/user/stop-notify.sh 'done'",
						},
					},
				},
			},
		},
	}
	data, _ := json.MarshalIndent(prior, "", "  ")
	if err := os.WriteFile(p.SettingsPath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}

	// Read back.
	raw, _ := os.ReadFile(p.SettingsPath)
	var after map[string]any
	_ = json.Unmarshal(raw, &after)

	if after["otherKey"] != "keep me" {
		t.Errorf("otherKey lost: %v", after["otherKey"])
	}

	hks, _ := after["hooks"].(map[string]any)
	stopList, _ := hks["Stop"].([]any)
	if len(stopList) != 2 {
		t.Fatalf("Stop entries = %d (want 2: user + reck)\n%s", len(stopList), raw)
	}

	// Find the user entry by its command content.
	found := false
	for _, item := range stopList {
		grp, _ := item.(map[string]any)
		inner, _ := grp["hooks"].([]any)
		for _, h := range inner {
			hm, _ := h.(map[string]any)
			cmd, _ := hm["command"].(string)
			if strings.Contains(cmd, "stop-notify.sh") && !strings.Contains(cmd, MarkerV1) {
				found = true
			}
		}
	}
	if !found {
		t.Errorf("user Stop hook was stripped — installer must not touch non-Reck entries")
	}
}

func TestEnsureInstalled_stripsPriorVersionOnReinstall(t *testing.T) {
	// Seed a stale Reck entry under Stop in the Older.2 format,
	// then install — should end up with exactly one entry (the fresh
	// one, with the current shim path).
	//
	// The seeded path ends with ".claude/hooks/reck-claude-hook.sh"
	// (the historical install pattern) so the tightened legacy regex
	// recognises it as Reck-owned. A path NOT matching that pattern
	// — e.g. "/opt/custom/script.sh" — would be preserved even with
	// the marker comment attached; see
	// TestEnsureInstalled_legacyRegex_rejectsUserHookWithMarker.
	home := t.TempDir()
	p := PathsFor(home)
	_ = os.MkdirAll(p.ClaudeDir, 0o755)
	prior := map[string]any{
		"hooks": map[string]any{
			"Stop": []any{
				map[string]any{
					"matcher": "",
					"hooks": []any{
						map[string]any{
							"type":    "command",
							"command": "bash /old/home/.claude/hooks/reck-claude-hook.sh stop # " + MarkerV1,
						},
					},
				},
			},
		},
	}
	data, _ := json.MarshalIndent(prior, "", "  ")
	_ = os.WriteFile(p.SettingsPath, data, 0o600)

	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}

	hks := loadHooks(t, home)
	if n := countReckEntries(hks, "Stop"); n != 1 {
		t.Errorf("Stop reck entries = %d, want 1", n)
	}
	// And the command should reference the new shim path, not /old/home.
	stopList, _ := hks["Stop"].([]any)
	for _, item := range stopList {
		grp, _ := item.(map[string]any)
		inner, _ := grp["hooks"].([]any)
		for _, h := range inner {
			hm, _ := h.(map[string]any)
			cmd, _ := hm["command"].(string)
			if strings.Contains(cmd, MarkerV1) && strings.Contains(cmd, "/old/home") {
				t.Errorf("stale reck entry survived reinstall: %s", cmd)
			}
		}
	}
}

func TestUninstall_removesReckButKeepsUser(t *testing.T) {
	home := t.TempDir()
	p := PathsFor(home)
	_ = os.MkdirAll(p.ClaudeDir, 0o755)
	prior := map[string]any{
		"hooks": map[string]any{
			"Stop": []any{
				map[string]any{
					"matcher": "",
					"hooks": []any{
						map[string]any{"type": "command", "command": "bash /user/stop.sh"},
					},
				},
			},
		},
	}
	data, _ := json.MarshalIndent(prior, "", "  ")
	_ = os.WriteFile(p.SettingsPath, data, 0o600)

	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	if err := Uninstall(home); err != nil {
		t.Fatal(err)
	}

	// Shim file gone.
	if _, err := os.Stat(p.ShimPath); !os.IsNotExist(err) {
		t.Errorf("shim should be removed, got err=%v", err)
	}
	// User Stop hook preserved, no Reck entries anywhere.
	hks := loadHooks(t, home)
	for _, b := range bindings {
		if n := countReckEntries(hks, b.claudeEvent); n != 0 {
			t.Errorf("%s: reck entries = %d after uninstall, want 0", b.claudeEvent, n)
		}
	}
	stopList, _ := hks["Stop"].([]any)
	if len(stopList) != 1 {
		t.Fatalf("user Stop hook lost: %d entries remain", len(stopList))
	}
}

// TestEnsureInstalled_concurrent — an earlier release regression: two EnsureInstalled
// goroutines racing against the same $HOME must both complete cleanly
// and the final settings.json must be valid JSON with exactly one Reck
// entry per binding (not duplicates, not corrupted). Before the flock
// and per-PID temp-name fix, concurrent callers could clobber each
// other's `.reck.tmp` file on rename and leave settings.json either
// corrupted or missing hooks.
func TestEnsureInstalled_concurrent(t *testing.T) {
	home := t.TempDir()
	const N = 8
	var wg sync.WaitGroup
	errs := make([]error, N)
	wg.Add(N)
	start := make(chan struct{})
	for i := 0; i < N; i++ {
		go func(idx int) {
			defer wg.Done()
			<-start
			errs[idx] = EnsureInstalled(home)
		}(i)
	}
	close(start)
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("caller %d: %v", i, err)
		}
	}

	p := PathsFor(home)
	raw, err := os.ReadFile(p.SettingsPath)
	if err != nil {
		t.Fatalf("settings missing after concurrent install: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("settings.json corrupted after concurrent install: %v\n%s", err, raw)
	}

	hks, _ := parsed["hooks"].(map[string]any)
	if hks == nil {
		t.Fatalf("hooks section missing after concurrent install:\n%s", raw)
	}
	// Exactly one Reck entry per binding — duplicate entries would indicate
	// the strip-then-add step raced and both callers appended without
	// seeing each other's write.
	for _, b := range bindings {
		n := countReckEntries(hks, b.claudeEvent)
		if n != 1 {
			t.Errorf("%s: reck entries = %d after concurrent install, want 1", b.claudeEvent, n)
		}
	}

	// Shim file ends up present and executable exactly once (no leftover
	// .reck.tmp.* files from interrupted renames).
	if info, err := os.Stat(p.ShimPath); err != nil {
		t.Errorf("shim missing: %v", err)
	} else if info.Mode().Perm()&0o100 == 0 {
		t.Errorf("shim not executable: %o", info.Mode().Perm())
	}
	// No orphan tmp files left behind.
	entries, _ := os.ReadDir(p.HooksDir)
	for _, e := range entries {
		if strings.Contains(e.Name(), ".reck.tmp") {
			t.Errorf("orphan tmp file in hooks dir: %s", e.Name())
		}
	}
	if entries, err := os.ReadDir(p.ClaudeDir); err == nil {
		for _, e := range entries {
			if strings.Contains(e.Name(), ".reck.tmp") {
				t.Errorf("orphan tmp file in claude dir: %s", e.Name())
			}
		}
	}
}

// TestEnsureInstalled_handlesPathsWithSpaces — an earlier release acceptance: when
// $HOME contains a space the installed hook command must single-quote
// the shim path so the shell doesn't split it into two tokens. Before
// this, the format `bash /Users/John Doe/...` would run `bash` with
// argv[1]=/Users/John and argv[2]=Doe/..., breaking every hook.
func TestEnsureInstalled_handlesPathsWithSpaces(t *testing.T) {
	base := t.TempDir()
	home := filepath.Join(base, "John Doe")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}

	hks := loadHooks(t, home)
	p := PathsFor(home)
	stopList, _ := hks["Stop"].([]any)
	if len(stopList) == 0 {
		t.Fatal("Stop hook entry missing")
	}
	grp := stopList[0].(map[string]any)
	inner := grp["hooks"].([]any)
	hm := inner[0].(map[string]any)
	cmd := hm["command"].(string)
	// The shim path contains a space; it must appear quoted so the
	// shell parses it as one token. If we fell through to raw %s
	// interpolation, the space would be a token separator for bash.
	if !strings.Contains(cmd, "'"+p.ShimPath+"'") {
		t.Errorf("shim path not quoted in command: %q", cmd)
	}
}

// TestEnsureInstalled_emitsAbsoluteBash — an audit F8: the generated
// hook command must invoke `/bin/bash` (absolute) rather than `bash`
// (PATH lookup). Relying on PATH lets anything earlier on it (e.g. a
// `~/.local/bin/bash` placed by malware) hijack every hook invocation.
// macOS guarantees /bin/bash exists, so the absolute path is safe.
func TestEnsureInstalled_emitsAbsoluteBash(t *testing.T) {
	home := t.TempDir()
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}

	hks := loadHooks(t, home)
	if hks == nil {
		t.Fatal("hooks section missing")
	}
	for _, b := range bindings {
		list, _ := hks[b.claudeEvent].([]any)
		if len(list) == 0 {
			t.Fatalf("%s: no entries", b.claudeEvent)
		}
		// Walk every Reck-owned inner hook command for this event and
		// assert it begins with `/bin/bash `. Plain `bash ` would be a
		// regression — the hook would resolve through PATH at runtime.
		found := false
		for _, item := range list {
			grp, _ := item.(map[string]any)
			inner, _ := grp["hooks"].([]any)
			for _, h := range inner {
				hm, _ := h.(map[string]any)
				cmd, _ := hm["command"].(string)
				if !strings.Contains(cmd, MarkerV1) {
					continue
				}
				found = true
				if !strings.HasPrefix(cmd, "/bin/bash ") {
					t.Errorf("%s: command does not start with /bin/bash: %q",
						b.claudeEvent, cmd)
				}
			}
		}
		if !found {
			t.Errorf("%s: no Reck entry found", b.claudeEvent)
		}
	}
}

// TestEnsureInstalled_migratesPathBashToAbsolute — an audit F8
// migration regression: a daemon that previously wrote the
// `bash '<shim>' <kind> # reck-hook-v1` form (and recorded that exact
// string in the ownership sidecar) must, on the next install, strip
// the old PATH-relative form and write the new `/bin/bash` form.
// Migration is sidecar-driven — no marker bump required, since the
// sidecar holds verbatim ownership of every command we ever emitted.
func TestEnsureInstalled_migratesPathBashToAbsolute(t *testing.T) {
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.HooksDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Synthesise an "older daemon" install: write settings.json with
	// the historical `bash '...'` form, plus a sidecar that claims
	// ownership of those exact strings. This is precisely the on-disk
	// state a post-rollout.2 / Older-fix daemon would have left.
	oldEntries := make([]string, 0, len(bindings))
	hooksMap := map[string]any{}
	for _, b := range bindings {
		oldCmd := "bash '" + p.ShimPath + "' " + b.kind + " # " + MarkerV1
		oldEntries = append(oldEntries, oldCmd)
		hooksMap[b.claudeEvent] = []any{
			map[string]any{
				"matcher": "",
				"hooks": []any{
					map[string]any{"type": "command", "command": oldCmd},
				},
			},
		}
	}
	prior := map[string]any{"hooks": hooksMap}
	data, _ := json.MarshalIndent(prior, "", "  ")
	if err := os.WriteFile(p.SettingsPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeOwnership(p.OwnershipPath, oldEntries); err != nil {
		t.Fatal(err)
	}

	// Run the upgraded installer.
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}

	// Each binding now has exactly one Reck entry, and that entry uses
	// the new /bin/bash form — no leftover `bash '<shim>'` survivors.
	hks := loadHooks(t, home)
	for _, b := range bindings {
		if n := countReckEntries(hks, b.claudeEvent); n != 1 {
			t.Errorf("%s: reck entries = %d after migration, want 1", b.claudeEvent, n)
		}
		list, _ := hks[b.claudeEvent].([]any)
		for _, item := range list {
			grp, _ := item.(map[string]any)
			inner, _ := grp["hooks"].([]any)
			for _, h := range inner {
				hm, _ := h.(map[string]any)
				cmd, _ := hm["command"].(string)
				if !strings.Contains(cmd, MarkerV1) {
					continue
				}
				if strings.HasPrefix(cmd, "bash '") {
					t.Errorf("%s: stale PATH-relative bash entry survived migration: %q",
						b.claudeEvent, cmd)
				}
				if !strings.HasPrefix(cmd, "/bin/bash '") {
					t.Errorf("%s: post-migration command not in /bin/bash form: %q",
						b.claudeEvent, cmd)
				}
			}
		}
	}

	// Sidecar should now hold the new `/bin/bash` form so future
	// installs continue to recognise our entries.
	rawSidecar, err := os.ReadFile(p.OwnershipPath)
	if err != nil {
		t.Fatalf("sidecar missing post-migration: %v", err)
	}
	var rec struct {
		Version int      `json:"version"`
		Entries []string `json:"entries"`
	}
	if err := json.Unmarshal(rawSidecar, &rec); err != nil {
		t.Fatalf("sidecar invalid: %v", err)
	}
	if len(rec.Entries) != len(bindings) {
		t.Errorf("sidecar entries = %d, want %d", len(rec.Entries), len(bindings))
	}
	for _, e := range rec.Entries {
		if !strings.HasPrefix(e, "/bin/bash '") {
			t.Errorf("sidecar entry not migrated to /bin/bash form: %q", e)
		}
	}
}

// TestEnsureInstalled_preservesUserHookContainingMarker — an earlier release regression:
// a user hook whose command string happens to contain "reck-hook-v1"
// as a substring (e.g. they named their script that, or left a comment
// in their command) must NOT be claimed/stripped by EnsureInstalled.
// Ownership is established structurally (sidecar or exact canonical
// form), not by loose substring match on the command.
func TestEnsureInstalled_preservesUserHookContainingMarker(t *testing.T) {
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.ClaudeDir, 0o755); err != nil {
		t.Fatal(err)
	}

	userCmd := "bash /opt/john/reck-hook-v1-parody.sh  # a comment mentioning reck-hook-v1"
	prior := map[string]any{
		"hooks": map[string]any{
			"Stop": []any{
				map[string]any{
					"matcher": "",
					"hooks": []any{
						map[string]any{"type": "command", "command": userCmd},
					},
				},
			},
		},
	}
	data, _ := json.MarshalIndent(prior, "", "  ")
	if err := os.WriteFile(p.SettingsPath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}

	hasUserCmd := func(hks map[string]any) bool {
		stopList, _ := hks["Stop"].([]any)
		for _, item := range stopList {
			grp, _ := item.(map[string]any)
			inner, _ := grp["hooks"].([]any)
			for _, h := range inner {
				hm, _ := h.(map[string]any)
				cmd, _ := hm["command"].(string)
				if cmd == userCmd {
					return true
				}
			}
		}
		return false
	}

	if !hasUserCmd(loadHooks(t, home)) {
		t.Fatalf("user hook containing 'reck-hook-v1' substring was stripped on first install; structured ownership broken")
	}

	// Second install should still preserve it.
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	if !hasUserCmd(loadHooks(t, home)) {
		t.Errorf("user hook stripped on reinstall")
	}

	// Sidecar file should exist now and list exactly our bindings.
	raw, err := os.ReadFile(p.OwnershipPath)
	if err != nil {
		t.Fatalf("ownership sidecar missing: %v", err)
	}
	var rec struct {
		Version int      `json:"version"`
		Entries []string `json:"entries"`
	}
	if err := json.Unmarshal(raw, &rec); err != nil {
		t.Fatalf("ownership sidecar invalid: %v", err)
	}
	if rec.Version != 1 {
		t.Errorf("ownership version = %d, want 1", rec.Version)
	}
	if len(rec.Entries) != len(bindings) {
		t.Errorf("ownership entries = %d, want %d", len(rec.Entries), len(bindings))
	}
	// And every entry must use our canonical (absolute /bin/bash + quoted) form.
	for _, e := range rec.Entries {
		if !strings.HasPrefix(e, "/bin/bash '"+p.ShimPath+"'") {
			t.Errorf("ownership entry uses non-canonical form: %q", e)
		}
	}
}

// TestUninstall_clearsSidecar — after Uninstall the sidecar is gone so
// a subsequent install starts from a clean slate.
func TestUninstall_clearsSidecar(t *testing.T) {
	home := t.TempDir()
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	p := PathsFor(home)
	if _, err := os.Stat(p.OwnershipPath); err != nil {
		t.Fatalf("ownership sidecar should exist after install: %v", err)
	}
	if err := Uninstall(home); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p.OwnershipPath); !os.IsNotExist(err) {
		t.Errorf("ownership sidecar should be removed after uninstall; got err=%v", err)
	}
}

func TestEnsureInstalled_shimContentMatchesEmbedded(t *testing.T) {
	home := t.TempDir()
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	p := PathsFor(home)
	got, err := os.ReadFile(p.ShimPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(hookShimContent) {
		t.Errorf("shim content mismatch")
	}
}

// TestLegacyReckCommandPattern_tableDriven is the a followup for
// a Codex finding: the Older.2 migration regex was too broad and
// would claim any `bash <anything> <[a-z_]+> # reck-hook-v1` command,
// including user hooks that happened to share the comment marker.
// The tightened regex requires the path to end with our exact
// historical shim filename under `.claude/hooks/` AND the <kind>
// token to be one of the known binding kinds.
func TestLegacyReckCommandPattern_tableDriven(t *testing.T) {
	cases := []struct {
		name string
		cmd  string
		want bool
	}{
		// Positive — genuinely legacy Reck command. Path ends with
		// the historical shim filename under .claude/hooks/.
		{
			name: "canonical legacy install",
			cmd:  "bash /Users/alice/.claude/hooks/reck-claude-hook.sh stop # reck-hook-v1",
			want: true,
		},
		{
			name: "legacy install on a different home",
			cmd:  "bash /home/bob/.claude/hooks/reck-claude-hook.sh session_start # reck-hook-v1",
			want: true,
		},
		{
			name: "legacy install for every known kind — post_tool_failure",
			cmd:  "bash /home/c/.claude/hooks/reck-claude-hook.sh post_tool_failure # reck-hook-v1",
			want: true,
		},
		// Negative — user-crafted hooks that carry the marker but
		// don't match the historical shim path/kind shape. None of
		// these must be claimed.
		{
			name: "user script at a non-Reck path with our marker",
			cmd:  "bash /opt/custom.sh stop # reck-hook-v1",
			want: false,
		},
		{
			name: "user script named reck-claude-hook.sh but OUTSIDE .claude/hooks",
			cmd:  "bash /opt/reck-claude-hook.sh stop # reck-hook-v1",
			want: false,
		},
		{
			name: "different shim filename, right directory",
			cmd:  "bash /Users/c/.claude/hooks/my-hook.sh stop # reck-hook-v1",
			want: false,
		},
		{
			name: "unknown kind token (future Reck would reject too)",
			cmd:  "bash /Users/c/.claude/hooks/reck-claude-hook.sh MY_KIND # reck-hook-v1",
			want: false,
		},
		{
			name: "marker embedded in a comment, not at end",
			cmd:  "bash /Users/c/.claude/hooks/reck-claude-hook.sh stop # reck-hook-v1 plus user text",
			want: false,
		},
		{
			name: "extra tokens after kind before comment",
			cmd:  "bash /Users/c/.claude/hooks/reck-claude-hook.sh stop extra # reck-hook-v1",
			want: false,
		},
		{
			name: "bash-wrapped via sh -c — not our format",
			cmd:  "sh -c 'bash /Users/c/.claude/hooks/reck-claude-hook.sh stop # reck-hook-v1'",
			want: false,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := legacyReckCommandPattern.MatchString(c.cmd)
			if got != c.want {
				t.Errorf("legacyReckCommandPattern.Match(%q) = %v, want %v", c.cmd, got, c.want)
			}
		})
	}
}

// TestEnsureInstalled_legacyRegex_rejectsUserHookWithMarker exercises
// the EnsureInstalled path end-to-end: a user hook whose command
// carries MarkerV1 at the end but points at a non-Reck shim path must
// survive EnsureInstalled. This is the Codex-spec regression — before
// the regex tightening, such a hook would be claimed and stripped on
// the first post-upgrade install.
func TestEnsureInstalled_legacyRegex_rejectsUserHookWithMarker(t *testing.T) {
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.ClaudeDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// User hook: the marker is at the end in our format, the kind
	// ("stop") matches one of ours, but the path does NOT reference
	// our shim file. Must NOT be claimed.
	userCmd := "bash /opt/custom/userhook.sh stop # " + MarkerV1
	prior := map[string]any{
		"hooks": map[string]any{
			"Stop": []any{
				map[string]any{
					"matcher": "",
					"hooks": []any{
						map[string]any{"type": "command", "command": userCmd},
					},
				},
			},
		},
	}
	data, _ := json.MarshalIndent(prior, "", "  ")
	if err := os.WriteFile(p.SettingsPath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}

	hks := loadHooks(t, home)
	stopList, _ := hks["Stop"].([]any)
	foundUser := false
	foundReck := false
	for _, item := range stopList {
		grp, _ := item.(map[string]any)
		inner, _ := grp["hooks"].([]any)
		for _, h := range inner {
			hm, _ := h.(map[string]any)
			cmd, _ := hm["command"].(string)
			if cmd == userCmd {
				foundUser = true
			}
			if strings.Contains(cmd, p.ShimPath) {
				foundReck = true
			}
		}
	}
	if !foundUser {
		t.Errorf("user hook at /opt/custom/userhook.sh was stripped by the legacy regex — the tightened path-tail check is broken. hooks: %v", hks)
	}
	if !foundReck {
		t.Errorf("reck hook was not installed alongside the preserved user hook")
	}
}
